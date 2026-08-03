'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { VRC6 } = require('../src/vrc6.js');

function enablePulse(vrc6, baseAddress, control, period = 0) {
    vrc6.writeRegister(baseAddress, control);
    vrc6.writeRegister(baseAddress + 1, period & 0xFF);
    vrc6.writeRegister(baseAddress + 2, 0x80 | ((period >> 8) & 0x0F));
}

function enableSaw(vrc6, rate, period = 0) {
    vrc6.writeRegister(0xB000, rate);
    vrc6.writeRegister(0xB001, period & 0xFF);
    vrc6.writeRegister(0xB002, 0x80 | ((period >> 8) & 0x0F));
}

test('reset starts with silent, inactive channels', () => {
    const vrc6 = new VRC6();

    assert.deepEqual(vrc6.getChannelOutputs(), { pulse1: 0, pulse2: 0, saw: 0 });
    assert.equal(vrc6.getOutput(), 0);
    assert.equal(vrc6.isChannelActive(), false);
    assert.equal(vrc6.halted, false);
    assert.equal(vrc6.frequencyShift, 0);
});

test('recognizes only canonical NSF VRC6 audio registers', () => {
    const registers = [
        0x9000, 0x9001, 0x9002, 0x9003,
        0xA000, 0xA001, 0xA002,
        0xB000, 0xB001, 0xB002,
    ];

    for (const address of registers) {
        assert.equal(VRC6.isRegisterAddress(address), true);
    }
    assert.equal(VRC6.isRegisterAddress(0x8FFF), false);
    assert.equal(VRC6.isRegisterAddress(0x9004), false);
    assert.equal(VRC6.isRegisterAddress(0xB003), false);
    assert.equal(new VRC6().writeRegister(0xC000, 0xFF), false);
});

test('pulse constant mode ignores the duty sequencer', () => {
    const vrc6 = new VRC6();
    enablePulse(vrc6, 0x9000, 0x8A);

    assert.equal(vrc6.getChannelOutputs().pulse1, 10);
    vrc6.clock(64);
    assert.equal(vrc6.getChannelOutputs().pulse1, 10);
    assert.equal(vrc6.isChannelActive(), true);

    vrc6.writeRegister(0x9002, 0x00);
    assert.equal(vrc6.getChannelOutputs().pulse1, 0);
    assert.equal(vrc6.pulse[0].step, 0);
});

test('pulse duty zero is high for one of sixteen steps', () => {
    const vrc6 = new VRC6();
    enablePulse(vrc6, 0x9000, 0x0F);

    const output = [vrc6.getChannelOutputs().pulse1];
    for (let i = 0; i < 16; i++) {
        vrc6.clock();
        output.push(vrc6.getChannelOutputs().pulse1);
    }

    assert.deepEqual(output, [15, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 15]);
});

test('pulse duty seven is high for eight of sixteen steps', () => {
    const vrc6 = new VRC6();
    enablePulse(vrc6, 0x9000, 0x7C);

    const output = [vrc6.getChannelOutputs().pulse1];
    for (let i = 0; i < 15; i++) {
        vrc6.clock();
        output.push(vrc6.getChannelOutputs().pulse1);
    }

    assert.deepEqual(output, [12, 12, 12, 12, 12, 12, 12, 12, 0, 0, 0, 0, 0, 0, 0, 0]);
});

test('pulse divider advances once per period plus one CPU cycles', () => {
    const vrc6 = new VRC6();
    enablePulse(vrc6, 0x9000, 0x0F, 2);

    vrc6.clock();
    assert.equal(vrc6.pulse[0].step, 1);
    assert.equal(vrc6.pulse[0].timer, 3);

    vrc6.clock(2);
    assert.equal(vrc6.pulse[0].step, 1);
    vrc6.clock();
    assert.equal(vrc6.pulse[0].step, 2);
});

test('frequency control applies halt and scaling to all channels', () => {
    const vrc6 = new VRC6();
    enablePulse(vrc6, 0x9000, 0x0F, 0x123);
    enablePulse(vrc6, 0xA000, 0x0F, 0x123);
    enableSaw(vrc6, 8, 0x123);

    vrc6.writeRegister(0x9003, 0x02);
    vrc6.clock();
    assert.equal(vrc6.frequencyShift, 4);
    assert.equal(vrc6.pulse[0].timer, 0x13);
    assert.equal(vrc6.pulse[1].timer, 0x13);
    assert.equal(vrc6.saw.timer, 0x13);

    vrc6.writeRegister(0x9003, 0x04);
    assert.equal(vrc6.frequencyShift, 8);

    const steps = [vrc6.pulse[0].step, vrc6.pulse[1].step, vrc6.saw.step];
    vrc6.writeRegister(0x9003, 0x05);
    vrc6.clock(100);
    assert.equal(vrc6.halted, true);
    assert.deepEqual(
        [vrc6.pulse[0].step, vrc6.pulse[1].step, vrc6.saw.step],
        steps
    );
    assert.equal(vrc6.isChannelActive(), false);
});

test('saw adds its rate every second step and resets on step fourteen', () => {
    const vrc6 = new VRC6();
    enableSaw(vrc6, 8);

    const output = [];
    for (let i = 0; i < 14; i++) {
        vrc6.clock();
        output.push(vrc6.getChannelOutputs().saw);
    }

    assert.deepEqual(output, [0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 0]);
    assert.equal(vrc6.saw.accumulator, 0);
    assert.equal(vrc6.saw.step, 0);
});

test('saw accumulator wraps to eight bits', () => {
    const vrc6 = new VRC6();
    enableSaw(vrc6, 63);
    vrc6.clock(12);

    assert.equal(vrc6.saw.accumulator, (63 * 6) & 0xFF);
    assert.equal(vrc6.getChannelOutputs().saw, ((63 * 6) & 0xFF) >> 3);
});

test('disabling saw resets phase and accumulation without resetting its timer', () => {
    const vrc6 = new VRC6();
    enableSaw(vrc6, 8, 3);
    vrc6.clock(2);
    const timerBeforeDisable = vrc6.saw.timer;

    vrc6.writeRegister(0xB002, 0x00);

    assert.equal(vrc6.saw.accumulator, 0);
    assert.equal(vrc6.saw.step, 0);
    assert.equal(vrc6.saw.timer, timerBeforeDisable);
    assert.equal(vrc6.getChannelOutputs().saw, 0);
});

test('optional compatibility mode swaps x001 and x002 register meanings', () => {
    const vrc6 = new VRC6({ swapAddressLines: true });
    vrc6.writeRegister(0x9000, 0x8F);
    vrc6.writeRegister(0x9002, 0x34); // Swapped low period register.
    vrc6.writeRegister(0x9001, 0x82); // Swapped high period and enable register.

    assert.equal(vrc6.pulse[0].period, 0x234);
    assert.equal(vrc6.pulse[0].enabled, true);
    assert.equal(vrc6.getChannelOutputs().pulse1, 15);
});

test('combined raw DAC reaches its documented six-bit maximum', () => {
    const vrc6 = new VRC6();
    enablePulse(vrc6, 0x9000, 0x8F);
    enablePulse(vrc6, 0xA000, 0x8F);
    enableSaw(vrc6, 42);
    vrc6.clock(12);

    assert.deepEqual(vrc6.getChannelOutputs(), { pulse1: 15, pulse2: 15, saw: 31 });
    assert.equal(vrc6.getOutput(), 61);
});

test('reset clears programmed state but preserves address compatibility mode', () => {
    const vrc6 = new VRC6({ swapAddressLines: true });
    vrc6.writeRegister(0x9000, 0x8F);
    vrc6.writeRegister(0x9002, 0x00);
    vrc6.writeRegister(0x9001, 0x80);
    vrc6.writeRegister(0x9003, 0x05);

    vrc6.reset();

    assert.equal(vrc6.swapAddressLines, true);
    assert.equal(vrc6.getOutput(), 0);
    assert.equal(vrc6.halted, false);
    assert.equal(vrc6.frequencyShift, 0);
    assert.equal(vrc6.isChannelActive(), false);
});
