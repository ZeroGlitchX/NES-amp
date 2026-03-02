/**
 * NSF Player Engine
 * Ties CPU, APU, and Memory together. Manages the NSF lifecycle,
 * generates audio samples, and interfaces with the Web Audio API.
 */
'use strict';

const CPU_FREQ_NTSC = 1789773;
const CPU_CLOCK_TRIM = 0.995;
const NES_MIX_CENTER = 0.5;
const OUTPUT_HEADROOM = 0.85;

class NSFEngine {
    constructor() {
        this.nsf = null;
        this.cpu = null;
        this.apu = null;
        this.memory = null;

        this.audioCtx = null;
        this.workletNode = null;
        this.scriptNode = null; // fallback
        this.gainNode = null;
        this.volume = 0.5;
        this.cpuClockHz = CPU_FREQ_NTSC * CPU_CLOCK_TRIM;

        this.sampleRate = 48000;
        this.cyclesPerSample = this.cpuClockHz / this.sampleRate;
        this.cycleRemainder = 0;
        this.cyclesPerPlayCall = 29781; // default NTSC ~60Hz

        this.currentSong = 0;
        this.samplesGenerated = 0;
        this.playing = false;
        this.fillTimer = null;
        this.workletQueueSize = 0;
        this.workletQueuedSamples = 0;

        // Channel history ring buffer (for latency-compensated visualizer sync)
        this.channelHistorySize = 131072;
        this.channelHistoryMask = this.channelHistorySize - 1;
        this.chPulse1 = new Uint8Array(this.channelHistorySize);
        this.chPulse2 = new Uint8Array(this.channelHistorySize);
        this.chTriangle = new Uint8Array(this.channelHistorySize);
        this.chNoise = new Uint8Array(this.channelHistorySize);
        this.chDmc = new Uint8Array(this.channelHistorySize);

        // Callbacks
        this.onStateChange = null;
        this.onMetadataReady = null;
    }

    // ── Load an NSF file from an ArrayBuffer ──
    async loadFile(arrayBuffer) {
        this.stop();

        this.nsf = parseNSF(arrayBuffer);

        // Create emulator components
        this.apu = new APU();
        this.memory = new Memory();
        this.memory.apu = this.apu;
        this.apu.memory = this.memory;
        this.cpu = new CPU6502(this.memory);

        // Load PRG data into memory
        this.memory.loadNSF(this.nsf);

        // Calculate play call rate from header
        if (this.nsf.ntscSpeed > 0) {
            this.cyclesPerPlayCall = Math.round(this.cpuClockHz * this.nsf.ntscSpeed / 1000000);
        }

        // Init audio if not already done
        if (!this.audioCtx) {
            await this._initAudio();
        }

        // Select starting song
        this.initTrack(this.nsf.startingSong - 1);

        return {
            title: this.nsf.title,
            artist: this.nsf.artist,
            copyright: this.nsf.copyright,
            totalSongs: this.nsf.totalSongs,
            startingSong: this.nsf.startingSong,
        };
    }

    // ── Initialize Web Audio ──
    async _initAudio() {
        this.audioCtx = new (window.AudioContext || window.webkitAudioContext)();
        this.sampleRate = this.audioCtx.sampleRate;
        this.cyclesPerSample = this.cpuClockHz / this.sampleRate;

        // NES-inspired output chain:
        //   source → highpass 37Hz → highpass 120Hz → lowpass 15kHz → gain → dest
        const hp1 = this.audioCtx.createBiquadFilter();
        hp1.type = 'highpass';
        hp1.frequency.value = 37;
        hp1.Q.value = 0.707;

        const hp2 = this.audioCtx.createBiquadFilter();
        hp2.type = 'highpass';
        hp2.frequency.value = 120;
        hp2.Q.value = 0.707;

        const lp = this.audioCtx.createBiquadFilter();
        lp.type = 'lowpass';
        lp.frequency.value = 15000;
        lp.Q.value = 0.707;

        this.gainNode = this.audioCtx.createGain();
        this.gainNode.gain.value = this.volume;

        // Wire chain: source → hp1 → hp2 → lp → gain → destination
        hp1.connect(hp2);
        hp2.connect(lp);
        lp.connect(this.gainNode);
        this.gainNode.connect(this.audioCtx.destination);
        this._filterInput = hp1; // audio source connects here

        // Try AudioWorklet first
        try {
            await this.audioCtx.audioWorklet.addModule('src/audio-worklet.js');
            this.workletNode = new AudioWorkletNode(this.audioCtx, 'nsf-processor');
            this.workletNode.connect(this._filterInput);
            this.workletNode.port.onmessage = (e) => {
                if (e.data.type === 'status') {
                    this.workletQueueSize = e.data.queueSize;
                    this.workletQueuedSamples = e.data.queuedSamples || 0;
                }
            };
        } catch (err) {
            console.warn('AudioWorklet unavailable, using ScriptProcessor fallback:', err);
            this.workletNode = null;
            // ScriptProcessorNode fallback is created on play()
        }
    }

    // ── Initialize a track for playback ──
    initTrack(songNumber) {
        this.currentSong = songNumber;
        this.samplesGenerated = 0;
        this.cycleRemainder = 0;
        this.workletQueuedSamples = 0;

        // Reset memory (clear RAM)
        this.memory.reset();

        // Re-load bankswitch configuration
        this.memory.loadNSF(this.nsf);

        // Reset APU
        this.apu.reset();

        // Init APU registers: $00 to $4000-$4013
        for (let addr = 0x4000; addr <= 0x4013; addr++) {
            this.apu.writeRegister(addr, 0x00);
        }
        // Enable channels
        this.apu.writeRegister(0x4015, 0x00);
        this.apu.writeRegister(0x4015, 0x0F);
        // Frame counter: 4-step, IRQ inhibit
        this.apu.writeRegister(0x4017, 0x40);

        // Setup bankswitching
        if (this.nsf.hasBankswitching) {
            for (let i = 0; i < 8; i++) {
                this.memory.write(0x5FF8 + i, this.nsf.bankswitch[i]);
            }
        }

        // Reset CPU and run init routine
        this.cpu.reset();
        this.cpu.a = songNumber;  // 0-based song number
        this.cpu.x = 0;           // 0 = NTSC
        this.cpu.sp = 0xFF;

        this.cpu.jsr(this.nsf.initAddress);
        this.cpu.runUntilReturn(2000000); // ~1 second max for init

        // Reset cycle tracking for play routine
        this._nextPlayCycle = this.cpu.cycles + this.cyclesPerPlayCall;
        this._sampleTarget = this.cpu.cycles; // absolute cycle target
    }

    // ── Generate audio samples ──
    _generateSamples(output, count) {
        for (let i = 0; i < count; i++) {
            this.cycleRemainder += this.cyclesPerSample;
            const wholeCycles = Math.floor(this.cycleRemainder);
            this.cycleRemainder -= wholeCycles;

            // Absolute target — CPU overshoot from previous sample is
            // automatically compensated instead of accumulating (~2.7% drift)
            this._sampleTarget += wholeCycles;
            let mixedCycleSum = 0;
            let mixedCycleCount = 0;

            while (this.cpu.cycles < this._sampleTarget) {
                // Call play routine at the correct rate (inline JSR so
                // the play routine executes step-by-step with APU clocking)
                if (this.cpu.cycles >= this._nextPlayCycle) {
                    this._nextPlayCycle += this.cyclesPerPlayCall;
                    this.cpu.jsr(this.nsf.playAddress);
                }

                const prevCycles = this.cpu.cycles;
                this.cpu.step();
                const elapsed = this.cpu.cycles - prevCycles;
                mixedCycleSum += this.apu.clock(elapsed, true);
                mixedCycleCount += elapsed;
            }

            const mix = mixedCycleCount > 0
                ? (mixedCycleSum / mixedCycleCount)
                : this.apu.getOutput();
            const centered = (mix - NES_MIX_CENTER) * 2;
            output[i] = Math.max(-1, Math.min(1, centered * OUTPUT_HEADROOM));

            const ch = this.apu.getChannelOutputs();
            const idx = this.samplesGenerated & this.channelHistoryMask;
            this.chPulse1[idx] = ch.pulse1;
            this.chPulse2[idx] = ch.pulse2;
            this.chTriangle[idx] = ch.triangle;
            this.chNoise[idx] = ch.noise;
            this.chDmc[idx] = ch.dmc;
            this.samplesGenerated++;
        }
    }

    // ── Playback Controls ──
    async play() {
        if (!this.nsf || !this.audioCtx) return;

        if (this.audioCtx.state === 'suspended') {
            await this.audioCtx.resume();
        }

        this.playing = true;

        if (this.workletNode) {
            this._startFillLoop();
        } else {
            this.workletQueuedSamples = 0;
            this._startScriptProcessor();
        }

        if (this.onStateChange) this.onStateChange('playing');
    }

    pause() {
        this.playing = false;
        this._stopFillLoop();
        this._stopScriptProcessor();
        if (this.onStateChange) this.onStateChange('paused');
    }

    stop() {
        this.playing = false;
        this._stopFillLoop();
        this._stopScriptProcessor();
        if (this.workletNode) {
            this.workletNode.port.postMessage({ type: 'stop' });
        }
        this.workletQueuedSamples = 0;
        if (this.nsf) {
            this.initTrack(this.currentSong);
        }
        if (this.onStateChange) this.onStateChange('stopped');
    }

    selectTrack(songNumber) {
        const wasPlaying = this.playing;
        this.pause();
        if (this.workletNode) {
            this.workletNode.port.postMessage({ type: 'stop' });
        }
        this.workletQueuedSamples = 0;
        this.initTrack(songNumber);
        if (wasPlaying) this.play();
    }

    setVolume(level) {
        this.volume = Math.max(0, Math.min(1, level));
        if (this.gainNode) {
            this.gainNode.gain.value = this.volume;
        }
    }

    getElapsedTime() {
        return this.samplesGenerated / this.sampleRate;
    }

    // ── Seek to a specific time (seconds) ──
    // Re-inits the track and fast-forwards the emulator to the target frame.
    seekTo(seconds) {
        if (!this.nsf) return;
        const wasPlaying = this.playing;
        this.pause();
        if (this.workletNode) {
            this.workletNode.port.postMessage({ type: 'stop' });
        }
        this.workletQueuedSamples = 0;

        // Re-init from scratch
        this.initTrack(this.currentSong);

        // Run play routine at ~60Hz to fast-forward
        const targetFrames = Math.floor(seconds * this.cpuClockHz / this.cyclesPerPlayCall);
        for (let f = 0; f < targetFrames; f++) {
            this.cpu.jsr(this.nsf.playAddress);
            const playStart = this.cpu.cycles;
            while (this.cpu.pc !== 0x5FFC && (this.cpu.cycles - playStart) < 200000) {
                const prev = this.cpu.cycles;
                this.cpu.step();
                this.apu.clock(this.cpu.cycles - prev);
            }
            const playCycles = this.cpu.cycles - playStart;
            const remaining = this.cyclesPerPlayCall - playCycles;
            if (remaining > 0) this.apu.fastForward(remaining);
        }

        // Sync sample tracking to match the target time
        this.samplesGenerated = Math.floor(seconds * this.sampleRate);
        this._sampleTarget = this.cpu.cycles;
        this._nextPlayCycle = this.cpu.cycles + this.cyclesPerPlayCall;

        if (wasPlaying) this.play();
    }

    getChannelOutputs() {
        if (!this.apu || this.samplesGenerated === 0) {
            return { pulse1: 0, pulse2: 0, triangle: 0, noise: 0, dmc: 0 };
        }

        // Visuals should follow audible output, not the most recently emulated state.
        const deviceLatencySamples = Math.floor(
            (((this.audioCtx && this.audioCtx.baseLatency) || 0) * this.sampleRate)
        );
        let delayedSample = this.samplesGenerated - 1 - this.workletQueuedSamples - deviceLatencySamples;
        if (delayedSample < 0) delayedSample = 0;

        const idx = delayedSample & this.channelHistoryMask;
        return {
            pulse1: this.chPulse1[idx],
            pulse2: this.chPulse2[idx],
            triangle: this.chTriangle[idx],
            noise: this.chNoise[idx],
            dmc: this.chDmc[idx]
        };
    }

    isActive() { return this.playing; }

    getMetadata() {
        if (!this.nsf) return null;
        return {
            title: this.nsf.title,
            artist: this.nsf.artist,
            copyright: this.nsf.copyright,
            totalSongs: this.nsf.totalSongs,
            currentSong: this.currentSong,
        };
    }

    // ── AudioWorklet Fill Loop ──
    _startFillLoop() {
        this._stopFillLoop();
        const BATCH = 1024;
        const TARGET_QUEUE = 2;

        this.fillTimer = setInterval(() => {
            if (!this.playing) return;

            // Keep the worklet fed
            let filled = 0;
            while (this.workletQueueSize + filled < TARGET_QUEUE) {
                const samples = new Float32Array(BATCH);
                this._generateSamples(samples, BATCH);
                this.workletNode.port.postMessage(
                    { type: 'samples', samples: samples },
                    [samples.buffer] // transferable
                );
                filled++;
            }
        }, 8); // check every 8ms
    }

    _stopFillLoop() {
        if (this.fillTimer) {
            clearInterval(this.fillTimer);
            this.fillTimer = null;
        }
    }

    // ── ScriptProcessorNode Fallback ──
    _startScriptProcessor() {
        if (this.scriptNode) return;
        this.scriptNode = this.audioCtx.createScriptProcessor(2048, 0, 1);
        this.scriptNode.onaudioprocess = (e) => {
            if (!this.playing) {
                e.outputBuffer.getChannelData(0).fill(0);
                return;
            }
            const output = e.outputBuffer.getChannelData(0);
            this._generateSamples(output, output.length);
        };
        this.scriptNode.connect(this._filterInput || this.gainNode);
    }

    _stopScriptProcessor() {
        if (this.scriptNode) {
            this.scriptNode.disconnect();
            this.scriptNode = null;
        }
    }
}
