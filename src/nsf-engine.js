/**
 * NSF Player Engine
 * Ties CPU, APU, and Memory together. Manages the NSF lifecycle,
 * generates audio samples, and interfaces with the Web Audio API.
 */
'use strict';

const CPU_FREQ_NTSC = 1789773;

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

        this.sampleRate = 48000;
        this.cyclesPerSample = CPU_FREQ_NTSC / this.sampleRate;
        this.cycleRemainder = 0;
        this.cyclesPerPlayCall = 29781; // default NTSC ~60Hz

        this.currentSong = 0;
        this.samplesGenerated = 0;
        this.playing = false;
        this.fillTimer = null;
        this.workletQueueSize = 0;

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
            this.cyclesPerPlayCall = Math.round(CPU_FREQ_NTSC * this.nsf.ntscSpeed / 1000000);
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
        this.cyclesPerSample = CPU_FREQ_NTSC / this.sampleRate;

        this.gainNode = this.audioCtx.createGain();
        this.gainNode.connect(this.audioCtx.destination);

        // Try AudioWorklet first
        try {
            await this.audioCtx.audioWorklet.addModule('src/audio-worklet.js');
            this.workletNode = new AudioWorkletNode(this.audioCtx, 'nsf-processor');
            this.workletNode.connect(this.gainNode);
            this.workletNode.port.onmessage = (e) => {
                if (e.data.type === 'status') {
                    this.workletQueueSize = e.data.queueSize;
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
    }

    // ── Generate audio samples ──
    _generateSamples(output, count) {
        for (let i = 0; i < count; i++) {
            this.cycleRemainder += this.cyclesPerSample;
            const wholeCycles = Math.floor(this.cycleRemainder);
            this.cycleRemainder -= wholeCycles;

            const targetCycles = this.cpu.cycles + wholeCycles;

            while (this.cpu.cycles < targetCycles) {
                // Call play routine at the correct rate (inline JSR so
                // the play routine executes step-by-step with APU clocking)
                if (this.cpu.cycles >= this._nextPlayCycle) {
                    this._nextPlayCycle += this.cyclesPerPlayCall;
                    this.cpu.jsr(this.nsf.playAddress);
                }

                const prevCycles = this.cpu.cycles;
                this.cpu.step();
                const elapsed = this.cpu.cycles - prevCycles;
                this.apu.clock(elapsed);
            }

            output[i] = this.apu.getOutput();
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
        this.initTrack(songNumber);
        if (wasPlaying) this.play();
    }

    setVolume(level) {
        if (this.gainNode) {
            this.gainNode.gain.value = Math.max(0, Math.min(1, level));
        }
    }

    getElapsedTime() {
        return this.samplesGenerated / this.sampleRate;
    }

    getChannelOutputs() {
        if (!this.apu) return { pulse1: 0, pulse2: 0, triangle: 0, noise: 0, dmc: 0 };
        return this.apu.getChannelOutputs();
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
        const BATCH = 2048;
        const TARGET_QUEUE = 4;

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
        this.scriptNode.connect(this.gainNode);
    }

    _stopScriptProcessor() {
        if (this.scriptNode) {
            this.scriptNode.disconnect();
            this.scriptNode = null;
        }
    }
}
