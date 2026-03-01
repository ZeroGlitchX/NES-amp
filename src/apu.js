/**
 * NES APU (Audio Processing Unit) Emulator
 * 2 Pulse channels, Triangle, Noise, DMC, Frame Counter, and Mixer.
 */
'use strict';

const LENGTH_TABLE = [
    10,254,20,2,40,4,80,6,160,8,60,10,14,12,26,14,
    12,16,24,18,48,20,96,22,192,24,72,26,16,28,32,30
];

const DUTY_TABLE = [
    [0,1,0,0,0,0,0,0],  // 12.5%
    [0,1,1,0,0,0,0,0],  // 25%
    [0,1,1,1,1,0,0,0],  // 50%
    [1,0,0,1,1,1,1,1],  // 75% (inverted 25%)
];

const TRIANGLE_SEQ = [
    15,14,13,12,11,10,9,8,7,6,5,4,3,2,1,0,
    0,1,2,3,4,5,6,7,8,9,10,11,12,13,14,15
];

const NOISE_PERIOD_NTSC = [
    4,8,16,32,64,96,128,160,202,254,380,508,762,1016,2034,4068
];

const DMC_RATE_NTSC = [
    428,380,340,320,286,254,226,214,190,160,142,128,106,84,72,54
];

class APU {
    constructor() {
        this.memory = null; // Set after construction (needed for DMC reads)

        // Pre-compute mixer lookup tables
        this.pulseTable = new Float32Array(31);
        for (let n = 0; n < 31; n++) {
            this.pulseTable[n] = n === 0 ? 0 : 95.52 / (8128.0 / n + 100);
        }
        this.tndTable = new Float32Array(203);
        for (let n = 0; n < 203; n++) {
            this.tndTable[n] = n === 0 ? 0 : 163.67 / (24329.0 / n + 100);
        }

        this.reset();
    }

    reset() {
        // Frame counter
        this.fcMode = 0;         // 0 = 4-step, 1 = 5-step
        this.fcCycle = 0;        // Current cycle within frame
        this.fcIRQInhibit = false;
        this.frameIRQFlag = false;
        this.isEvenCycle = false;

        // Pulse channels
        this.pulse = [this._newPulse(), this._newPulse()];

        // Triangle
        this.tri = {
            enabled: false,
            timer: 0, period: 0,
            seqPos: 0,
            lengthCounter: 0, lengthHalt: false,
            linearCounter: 0, linearReload: 0, linearReloadFlag: false,
            output: 0
        };

        // Noise
        this.noise = {
            enabled: false,
            timer: 0, period: NOISE_PERIOD_NTSC[0],
            shiftReg: 1,
            mode: false,
            lengthCounter: 0, lengthHalt: false,
            env: this._newEnvelope(),
            output: 0
        };

        // DMC
        this.dmc = {
            enabled: false,
            timer: 0, period: DMC_RATE_NTSC[0],
            outputLevel: 0,
            sampleAddr: 0xC000,
            sampleLen: 0,
            curAddr: 0xC000,
            bytesRemaining: 0,
            sampleBuffer: 0,
            bufferEmpty: true,
            shiftReg: 0,
            bitsRemaining: 0,
            silence: true,
            loop: false,
            irqEnabled: false,
            irqFlag: false
        };
    }

    _newPulse() {
        return {
            enabled: false,
            duty: 0, dutyPos: 0,
            timer: 0, period: 0,
            lengthCounter: 0, lengthHalt: false,
            env: this._newEnvelope(),
            sweepEnabled: false, sweepPeriod: 0, sweepShift: 0,
            sweepNegate: false, sweepDivider: 0, sweepReload: false,
            output: 0
        };
    }

    _newEnvelope() {
        return {
            start: false, divider: 0, counter: 0,
            volume: 0, loop: false, constant: false
        };
    }

    // ── Register Writes ($4000-$4017) ──
    writeRegister(addr, value) {
        switch (addr) {
            // Pulse 1: $4000-$4003
            case 0x4000: {
                const p = this.pulse[0];
                p.duty = (value >> 6) & 3;
                p.lengthHalt = !!(value & 0x20);
                p.env.loop = !!(value & 0x20);
                p.env.constant = !!(value & 0x10);
                p.env.volume = value & 0x0F;
                break;
            }
            case 0x4001: {
                const p = this.pulse[0];
                p.sweepEnabled = !!(value & 0x80);
                p.sweepPeriod = (value >> 4) & 7;
                p.sweepNegate = !!(value & 0x08);
                p.sweepShift = value & 7;
                p.sweepReload = true;
                break;
            }
            case 0x4002: {
                this.pulse[0].period = (this.pulse[0].period & 0x700) | value;
                break;
            }
            case 0x4003: {
                const p = this.pulse[0];
                p.period = (p.period & 0xFF) | ((value & 7) << 8);
                if (p.enabled) p.lengthCounter = LENGTH_TABLE[value >> 3];
                p.dutyPos = 0;
                p.env.start = true;
                break;
            }

            // Pulse 2: $4004-$4007
            case 0x4004: {
                const p = this.pulse[1];
                p.duty = (value >> 6) & 3;
                p.lengthHalt = !!(value & 0x20);
                p.env.loop = !!(value & 0x20);
                p.env.constant = !!(value & 0x10);
                p.env.volume = value & 0x0F;
                break;
            }
            case 0x4005: {
                const p = this.pulse[1];
                p.sweepEnabled = !!(value & 0x80);
                p.sweepPeriod = (value >> 4) & 7;
                p.sweepNegate = !!(value & 0x08);
                p.sweepShift = value & 7;
                p.sweepReload = true;
                break;
            }
            case 0x4006: {
                this.pulse[1].period = (this.pulse[1].period & 0x700) | value;
                break;
            }
            case 0x4007: {
                const p = this.pulse[1];
                p.period = (p.period & 0xFF) | ((value & 7) << 8);
                if (p.enabled) p.lengthCounter = LENGTH_TABLE[value >> 3];
                p.dutyPos = 0;
                p.env.start = true;
                break;
            }

            // Triangle: $4008, $400A, $400B
            case 0x4008:
                this.tri.lengthHalt = !!(value & 0x80);
                this.tri.linearReload = value & 0x7F;
                break;
            case 0x4009: break; // unused
            case 0x400A:
                this.tri.period = (this.tri.period & 0x700) | value;
                break;
            case 0x400B:
                this.tri.period = (this.tri.period & 0xFF) | ((value & 7) << 8);
                if (this.tri.enabled) this.tri.lengthCounter = LENGTH_TABLE[value >> 3];
                this.tri.linearReloadFlag = true;
                break;

            // Noise: $400C, $400E, $400F
            case 0x400C:
                this.noise.lengthHalt = !!(value & 0x20);
                this.noise.env.loop = !!(value & 0x20);
                this.noise.env.constant = !!(value & 0x10);
                this.noise.env.volume = value & 0x0F;
                break;
            case 0x400D: break; // unused
            case 0x400E:
                this.noise.mode = !!(value & 0x80);
                this.noise.period = NOISE_PERIOD_NTSC[value & 0x0F];
                break;
            case 0x400F:
                if (this.noise.enabled) this.noise.lengthCounter = LENGTH_TABLE[value >> 3];
                this.noise.env.start = true;
                break;

            // DMC: $4010-$4013
            case 0x4010:
                this.dmc.irqEnabled = !!(value & 0x80);
                this.dmc.loop = !!(value & 0x40);
                this.dmc.period = DMC_RATE_NTSC[value & 0x0F];
                if (!this.dmc.irqEnabled) this.dmc.irqFlag = false;
                break;
            case 0x4011:
                this.dmc.outputLevel = value & 0x7F;
                break;
            case 0x4012:
                this.dmc.sampleAddr = 0xC000 + value * 64;
                break;
            case 0x4013:
                this.dmc.sampleLen = value * 16 + 1;
                break;

            // Status: $4015
            case 0x4015:
                this.pulse[0].enabled = !!(value & 0x01);
                this.pulse[1].enabled = !!(value & 0x02);
                this.tri.enabled      = !!(value & 0x04);
                this.noise.enabled    = !!(value & 0x08);

                if (!this.pulse[0].enabled) this.pulse[0].lengthCounter = 0;
                if (!this.pulse[1].enabled) this.pulse[1].lengthCounter = 0;
                if (!this.tri.enabled)      this.tri.lengthCounter = 0;
                if (!this.noise.enabled)    this.noise.lengthCounter = 0;

                // DMC
                this.dmc.irqFlag = false;
                if (value & 0x10) {
                    if (this.dmc.bytesRemaining === 0) {
                        this.dmc.curAddr = this.dmc.sampleAddr;
                        this.dmc.bytesRemaining = this.dmc.sampleLen;
                    }
                } else {
                    this.dmc.bytesRemaining = 0;
                }
                this.dmc.enabled = !!(value & 0x10);
                break;

            // Frame counter: $4017
            case 0x4017:
                this.fcMode = (value >> 7) & 1;
                this.fcIRQInhibit = !!(value & 0x40);
                if (this.fcIRQInhibit) this.frameIRQFlag = false;
                this.fcCycle = 0;
                // In 5-step mode, immediately clock quarter + half frame
                if (this.fcMode === 1) {
                    this._quarterFrame();
                    this._halfFrame();
                }
                break;
        }
    }

    // ── Register Reads ──
    readRegister(addr) {
        if (addr === 0x4015) {
            let status = 0;
            if (this.pulse[0].lengthCounter > 0) status |= 0x01;
            if (this.pulse[1].lengthCounter > 0) status |= 0x02;
            if (this.tri.lengthCounter > 0)      status |= 0x04;
            if (this.noise.lengthCounter > 0)    status |= 0x08;
            if (this.dmc.bytesRemaining > 0)     status |= 0x10;
            if (this.frameIRQFlag)               status |= 0x40;
            if (this.dmc.irqFlag)                status |= 0x80;
            this.frameIRQFlag = false; // reading clears frame IRQ
            return status;
        }
        return 0;
    }

    // ── Clock the APU by N CPU cycles ──
    clock(cpuCycles) {
        for (let i = 0; i < cpuCycles; i++) {
            this.fcCycle++;

            // Frame counter
            this._clockFrameCounter();

            // Triangle timer (CPU rate)
            this._clockTriangle();

            // DMC timer (CPU rate)
            this._clockDMC();

            // Pulse and noise (CPU/2 rate — every other cycle)
            this.isEvenCycle = !this.isEvenCycle;
            if (this.isEvenCycle) {
                this._clockPulse(0);
                this._clockPulse(1);
                this._clockNoise();
            }
        }
    }

    // ── Frame Counter ──
    _clockFrameCounter() {
        // Note: fcCycle increments at CPU rate (1.789 MHz).
        // Frame counter thresholds are in CPU cycles (APU cycle values × 2).
        if (this.fcMode === 0) {
            // 4-step mode (~60 Hz full cycle)
            switch (this.fcCycle) {
                case 7458:  this._quarterFrame(); break;
                case 14914: this._quarterFrame(); this._halfFrame(); break;
                case 22372: this._quarterFrame(); break;
                case 29830:
                    this._quarterFrame(); this._halfFrame();
                    if (!this.fcIRQInhibit) this.frameIRQFlag = true;
                    this.fcCycle = 0;
                    break;
            }
        } else {
            // 5-step mode (~48 Hz full cycle)
            switch (this.fcCycle) {
                case 7458:  this._quarterFrame(); break;
                case 14914: this._quarterFrame(); this._halfFrame(); break;
                case 22371: this._quarterFrame(); break;
                case 29830: break; // nothing
                case 37281:
                    this._quarterFrame(); this._halfFrame();
                    this.fcCycle = 0;
                    break;
            }
        }
    }

    // ── Quarter Frame: envelopes + triangle linear counter ──
    _quarterFrame() {
        this._clockEnvelope(this.pulse[0].env);
        this._clockEnvelope(this.pulse[1].env);
        this._clockEnvelope(this.noise.env);
        this._clockTriangleLinear();
    }

    // ── Half Frame: length counters + sweep units ──
    _halfFrame() {
        this._clockLengthCounter(this.pulse[0]);
        this._clockLengthCounter(this.pulse[1]);
        this._clockLengthCounter(this.tri);
        this._clockLengthCounter(this.noise);
        this._clockSweep(0);
        this._clockSweep(1);
    }

    // ── Envelope Generator ──
    _clockEnvelope(env) {
        if (env.start) {
            env.start = false;
            env.counter = 15;
            env.divider = env.volume;
        } else {
            if (env.divider === 0) {
                env.divider = env.volume;
                if (env.counter > 0) {
                    env.counter--;
                } else if (env.loop) {
                    env.counter = 15;
                }
            } else {
                env.divider--;
            }
        }
    }

    _envelopeOutput(env) {
        return env.constant ? env.volume : env.counter;
    }

    // ── Length Counter ──
    _clockLengthCounter(ch) {
        if (!ch.lengthHalt && ch.lengthCounter > 0) {
            ch.lengthCounter--;
        }
    }

    // ── Sweep Unit ──
    _clockSweep(chIdx) {
        const p = this.pulse[chIdx];

        // Compute target period
        let change = p.period >> p.sweepShift;
        if (p.sweepNegate) {
            change = -change;
            if (chIdx === 0) change--; // Pulse 1: one's complement
        }
        const target = p.period + change;

        // Mute conditions (checked regardless of sweep enable)
        const muted = p.period < 8 || target > 0x7FF;

        // Clock divider
        if (p.sweepDivider === 0 && p.sweepEnabled && p.sweepShift > 0 && !muted) {
            p.period = Math.max(0, target);
        }
        if (p.sweepDivider === 0 || p.sweepReload) {
            p.sweepDivider = p.sweepPeriod;
            p.sweepReload = false;
        } else {
            p.sweepDivider--;
        }
    }

    // ── Pulse Channel Timer ──
    _clockPulse(chIdx) {
        const p = this.pulse[chIdx];
        if (p.timer === 0) {
            p.timer = p.period;
            p.dutyPos = (p.dutyPos + 1) & 7;
        } else {
            p.timer--;
        }

        // Compute output
        // Mute if: duty is 0, length counter is 0, period < 8, or sweep target > $7FF
        let change = p.period >> p.sweepShift;
        if (p.sweepNegate) { change = -change; if (chIdx === 0) change--; }
        const target = p.period + change;
        const muted = p.period < 8 || target > 0x7FF;

        if (DUTY_TABLE[p.duty][p.dutyPos] && p.lengthCounter > 0 && !muted) {
            p.output = this._envelopeOutput(p.env);
        } else {
            p.output = 0;
        }
    }

    // ── Triangle Channel ──
    _clockTriangle() {
        if (this.tri.timer === 0) {
            this.tri.timer = this.tri.period;
            // Only advance sequence if both counters are active
            if (this.tri.linearCounter > 0 && this.tri.lengthCounter > 0) {
                this.tri.seqPos = (this.tri.seqPos + 1) & 31;
            }
        } else {
            this.tri.timer--;
        }
        this.tri.output = TRIANGLE_SEQ[this.tri.seqPos];
    }

    _clockTriangleLinear() {
        if (this.tri.linearReloadFlag) {
            this.tri.linearCounter = this.tri.linearReload;
        } else if (this.tri.linearCounter > 0) {
            this.tri.linearCounter--;
        }
        if (!this.tri.lengthHalt) {
            this.tri.linearReloadFlag = false;
        }
    }

    // ── Noise Channel ──
    _clockNoise() {
        if (this.noise.timer === 0) {
            this.noise.timer = this.noise.period;

            // LFSR feedback
            const bit0 = this.noise.shiftReg & 1;
            const otherBit = this.noise.mode
                ? (this.noise.shiftReg >> 6) & 1  // mode 1: bit 6
                : (this.noise.shiftReg >> 1) & 1; // mode 0: bit 1
            const feedback = bit0 ^ otherBit;
            this.noise.shiftReg = ((this.noise.shiftReg >> 1) | (feedback << 14)) & 0x7FFF;
        } else {
            this.noise.timer--;
        }

        // Output: when bit 0 is 1, silent; when 0, envelope volume
        if ((this.noise.shiftReg & 1) === 0 && this.noise.lengthCounter > 0) {
            this.noise.output = this._envelopeOutput(this.noise.env);
        } else {
            this.noise.output = 0;
        }
    }

    // ── DMC Channel ──
    _clockDMC() {
        // Try to fill buffer if empty
        if (this.dmc.bufferEmpty && this.dmc.bytesRemaining > 0) {
            this.dmc.sampleBuffer = this.memory ? this.memory.read(this.dmc.curAddr) : 0;
            this.dmc.bufferEmpty = false;
            this.dmc.curAddr = ((this.dmc.curAddr + 1) & 0xFFFF) | 0x8000;
            if (this.dmc.curAddr > 0xFFFF) this.dmc.curAddr = 0x8000;
            this.dmc.bytesRemaining--;

            if (this.dmc.bytesRemaining === 0) {
                if (this.dmc.loop) {
                    this.dmc.curAddr = this.dmc.sampleAddr;
                    this.dmc.bytesRemaining = this.dmc.sampleLen;
                } else if (this.dmc.irqEnabled) {
                    this.dmc.irqFlag = true;
                }
            }
        }

        // Timer
        if (this.dmc.timer === 0) {
            this.dmc.timer = this.dmc.period;

            if (!this.dmc.silence) {
                if (this.dmc.shiftReg & 1) {
                    if (this.dmc.outputLevel <= 125) this.dmc.outputLevel += 2;
                } else {
                    if (this.dmc.outputLevel >= 2) this.dmc.outputLevel -= 2;
                }
            }
            this.dmc.shiftReg >>= 1;
            this.dmc.bitsRemaining--;

            if (this.dmc.bitsRemaining <= 0) {
                this.dmc.bitsRemaining = 8;
                if (this.dmc.bufferEmpty) {
                    this.dmc.silence = true;
                } else {
                    this.dmc.silence = false;
                    this.dmc.shiftReg = this.dmc.sampleBuffer;
                    this.dmc.bufferEmpty = true;
                }
            }
        } else {
            this.dmc.timer--;
        }
    }

    // ── Mixer Output ──
    getOutput() {
        const p = this.pulseTable[this.pulse[0].output + this.pulse[1].output];
        const tndIdx = 3 * this.tri.output + 2 * this.noise.output + this.dmc.outputLevel;
        const t = this.tndTable[Math.min(tndIdx, 202)];
        return (p + t) * 2 - 1; // Scale from [0,~1] to [-1, 1]
    }

    // ── Fast-forward APU by N CPU cycles (frame counter events only) ──
    // Used by silence detection scanner — skips channel timer clocking
    fastForward(cpuCycles) {
        const T4 = [7458, 14914, 22372, 29830];
        const T5 = [7458, 14914, 22371, 29830, 37281];
        let remaining = cpuCycles;

        while (remaining > 0) {
            const thresholds = this.fcMode === 0 ? T4 : T5;

            // Find next frame counter event after current fcCycle
            let next = -1;
            for (let i = 0; i < thresholds.length; i++) {
                if (thresholds[i] > this.fcCycle) { next = thresholds[i]; break; }
            }

            if (next === -1) {
                // Past all thresholds — wrap frame counter
                this.fcCycle = 0;
                continue;
            }

            const gap = next - this.fcCycle;
            if (gap <= remaining) {
                remaining -= gap;
                this.fcCycle = next;
                this._clockFrameCounter(); // may reset fcCycle to 0
            } else {
                this.fcCycle += remaining;
                remaining = 0;
            }
        }
    }

    // ── Check if any channel is currently producing audible output ──
    isChannelActive() {
        // Pulse channels
        for (let i = 0; i < 2; i++) {
            const p = this.pulse[i];
            if (p.enabled && p.lengthCounter > 0 && p.period >= 8) {
                const vol = p.env.constant ? p.env.volume : p.env.counter;
                if (vol > 0) return true;
            }
        }
        // Triangle
        if (this.tri.enabled && this.tri.lengthCounter > 0 &&
            this.tri.linearCounter > 0 && this.tri.period >= 2) {
            return true;
        }
        // Noise
        if (this.noise.enabled && this.noise.lengthCounter > 0) {
            const vol = this.noise.env.constant ? this.noise.env.volume : this.noise.env.counter;
            if (vol > 0) return true;
        }
        // DMC
        if (this.dmc.bytesRemaining > 0 || !this.dmc.bufferEmpty) {
            return true;
        }
        return false;
    }

    // ── Channel outputs for visualizer ──
    getChannelOutputs() {
        return {
            pulse1:   this.pulse[0].output,
            pulse2:   this.pulse[1].output,
            triangle: this.tri.output,
            noise:    this.noise.output,
            dmc:      this.dmc.outputLevel
        };
    }
}
