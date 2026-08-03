/**
 * Konami VRC6 Expansion Audio
 * Two 16-step pulse channels and one 14-step sawtooth channel.
 *
 * Timing and register behavior follow:
 * https://www.nesdev.org/wiki/VRC6_audio
 */
'use strict';

class VRC6 {
    constructor(options = {}) {
        this.swapAddressLines = !!options.swapAddressLines;
        this.reset();
    }

    reset() {
        this.halted = false;
        this.frequencyShift = 0;
        this.pulse = [this._newPulse(), this._newPulse()];
        this.saw = this._newSaw();
    }

    _newPulse() {
        return {
            volume: 0,
            duty: 0,
            constantMode: false,
            period: 0,
            timer: 1,
            enabled: false,
            step: 0,
        };
    }

    _newSaw() {
        return {
            accumulatorRate: 0,
            accumulator: 0,
            period: 0,
            timer: 1,
            enabled: false,
            step: 0,
        };
    }

    static isRegisterAddress(address) {
        switch (address & 0xFFFF) {
            case 0x9000:
            case 0x9001:
            case 0x9002:
            case 0x9003:
            case 0xA000:
            case 0xA001:
            case 0xA002:
            case 0xB000:
            case 0xB001:
            case 0xB002:
                return true;
            default:
                return false;
        }
    }

    _normalizeAddress(address) {
        address &= 0xFFFF;
        if (!this.swapAddressLines) return address;

        const register = address & 0x0003;
        if (register === 1) return address + 1;
        if (register === 2) return address - 1;
        return address;
    }

    writeRegister(address, value) {
        address &= 0xFFFF;
        value &= 0xFF;
        if (!VRC6.isRegisterAddress(address)) return false;

        address = this._normalizeAddress(address);
        switch (address) {
            case 0x9000:
                this._writePulseControl(this.pulse[0], value);
                break;
            case 0x9001:
                this._writePeriodLow(this.pulse[0], value);
                break;
            case 0x9002:
                this._writePulsePeriodHigh(this.pulse[0], value);
                break;
            case 0x9003:
                this.halted = !!(value & 0x01);
                this.frequencyShift = (value & 0x04) ? 8 : ((value & 0x02) ? 4 : 0);
                break;
            case 0xA000:
                this._writePulseControl(this.pulse[1], value);
                break;
            case 0xA001:
                this._writePeriodLow(this.pulse[1], value);
                break;
            case 0xA002:
                this._writePulsePeriodHigh(this.pulse[1], value);
                break;
            case 0xB000:
                this.saw.accumulatorRate = value & 0x3F;
                break;
            case 0xB001:
                this._writePeriodLow(this.saw, value);
                break;
            case 0xB002:
                this.saw.period = (this.saw.period & 0x00FF) | ((value & 0x0F) << 8);
                this.saw.enabled = !!(value & 0x80);
                if (!this.saw.enabled) {
                    // Disabling resets saw phase and accumulation, but not its divider.
                    this.saw.accumulator = 0;
                    this.saw.step = 0;
                }
                break;
        }

        return true;
    }

    _writePulseControl(pulse, value) {
        pulse.volume = value & 0x0F;
        pulse.duty = (value >> 4) & 0x07;
        pulse.constantMode = !!(value & 0x80);
    }

    _writePeriodLow(channel, value) {
        channel.period = (channel.period & 0x0F00) | value;
    }

    _writePulsePeriodHigh(pulse, value) {
        pulse.period = (pulse.period & 0x00FF) | ((value & 0x0F) << 8);
        pulse.enabled = !!(value & 0x80);
        if (!pulse.enabled) pulse.step = 0;
    }

    clock(cpuCycles = 1) {
        if (cpuCycles === 1) {
            if (!this.halted) {
                this._clockPulse(this.pulse[0]);
                this._clockPulse(this.pulse[1]);
                this._clockSaw();
            }
            return this.getOutput();
        }

        cpuCycles = Number.isFinite(cpuCycles) ? Math.max(0, Math.floor(cpuCycles)) : 0;

        if (!this.halted) {
            for (let i = 0; i < cpuCycles; i++) {
                this._clockPulse(this.pulse[0]);
                this._clockPulse(this.pulse[1]);
                this._clockSaw();
            }
        }

        return this.getOutput();
    }

    _clockPulse(pulse) {
        if (!pulse.enabled) return;

        pulse.timer--;
        if (pulse.timer <= 0) {
            pulse.step = (pulse.step + 1) & 0x0F;
            pulse.timer = (pulse.period >> this.frequencyShift) + 1;
        }
    }

    _clockSaw() {
        if (!this.saw.enabled) return;

        this.saw.timer--;
        if (this.saw.timer <= 0) {
            this.saw.step = (this.saw.step + 1) % 14;
            this.saw.timer = (this.saw.period >> this.frequencyShift) + 1;

            if (this.saw.step === 0) {
                this.saw.accumulator = 0;
            } else if ((this.saw.step & 1) === 0) {
                this.saw.accumulator = (
                    this.saw.accumulator + this.saw.accumulatorRate
                ) & 0xFF;
            }
        }
    }

    _getPulseOutput(pulse) {
        if (!pulse.enabled) return 0;
        if (pulse.constantMode || pulse.step <= pulse.duty) return pulse.volume;
        return 0;
    }

    _getSawOutput() {
        return this.saw.enabled ? (this.saw.accumulator >> 3) : 0;
    }

    getOutput() {
        return this._getPulseOutput(this.pulse[0])
            + this._getPulseOutput(this.pulse[1])
            + this._getSawOutput();
    }

    getChannelOutputs() {
        return {
            pulse1: this._getPulseOutput(this.pulse[0]),
            pulse2: this._getPulseOutput(this.pulse[1]),
            saw: this._getSawOutput(),
        };
    }

    isChannelActive() {
        if (this.halted) return false;
        if (this.pulse.some(pulse => pulse.enabled && pulse.volume > 0)) return true;
        return this.saw.enabled && this.saw.accumulatorRate > 0;
    }
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = { VRC6 };
}
