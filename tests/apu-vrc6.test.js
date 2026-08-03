'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { APU } = require('../src/apu.js');

function enableMaximumVRC6Output(apu) {
    apu.writeExpansionRegister(0x9000, 0x8F);
    apu.writeExpansionRegister(0x9001, 0x00);
    apu.writeExpansionRegister(0x9002, 0x80);
    apu.writeExpansionRegister(0xA000, 0x8F);
    apu.writeExpansionRegister(0xA001, 0x00);
    apu.writeExpansionRegister(0xA002, 0x80);
    apu.writeExpansionRegister(0xB000, 42);
    apu.writeExpansionRegister(0xB001, 0x00);
    apu.writeExpansionRegister(0xB002, 0x80);
    apu.clock(12);
}

test('constructs VRC6 only when NSF expansion bit zero is set', () => {
    const nativeApu = new APU();
    const unrelatedExpansionApu = new APU({ expansionChips: 0x04 });
    const vrc6Apu = new APU({ expansionChips: 0x01 });

    assert.equal(nativeApu.vrc6, null);
    assert.equal(unrelatedExpansionApu.vrc6, null);
    assert.ok(vrc6Apu.vrc6);
    assert.equal(nativeApu.writeExpansionRegister(0x9000, 0x8F), false);
});

test('expansion write hook claims only VRC6 registers when enabled', () => {
    const apu = new APU({ expansionChips: 0x01 });

    assert.equal(apu.writeExpansionRegister(0x9000, 0x8F), true);
    assert.equal(apu.writeExpansionRegister(0x9004, 0xFF), false);
    assert.equal(apu.vrc6.pulse[0].constantMode, true);
    assert.equal(apu.vrc6.pulse[0].volume, 15);
});

test('clocks VRC6 at the full CPU rate', () => {
    const apu = new APU({ expansionChips: 0x01 });
    apu.writeExpansionRegister(0x9000, 0x0F);
    apu.writeExpansionRegister(0x9001, 0x00);
    apu.writeExpansionRegister(0x9002, 0x80);

    assert.equal(apu.vrc6.pulse[0].step, 0);
    apu.clock(1);
    assert.equal(apu.vrc6.pulse[0].step, 1);
    apu.clock(1);
    assert.equal(apu.vrc6.pulse[0].step, 2);
});

test('mixes linear VRC6 output through bounded headroom', () => {
    const apu = new APU({ expansionChips: 0x01 });
    enableMaximumVRC6Output(apu);

    const nativePulse = apu.pulseTable[apu.pulse[0].output + apu.pulse[1].output];
    const tndIndex = 3 * apu.tri.output + 2 * apu.noise.output + apu.dmc.outputLevel;
    const nativeOutput = nativePulse + apu.tndTable[Math.min(tndIndex, 202)];
    const expected = (nativeOutput + 61 * apu.vrc6LinearGain) * apu.vrc6MixScale;

    assert.equal(apu.vrc6.getOutput(), 61);
    assert.ok(Math.abs(apu.getOutput() - expected) < 1e-12);
    assert.ok(apu.getOutput() >= 0 && apu.getOutput() <= 1);
});

test('maps one maximum VRC6 pulse to one maximum native pulse level', () => {
    const apu = new APU({ expansionChips: 0x01 });

    assert.ok(Math.abs(15 * apu.vrc6LinearGain - apu.pulseTable[15]) < 1e-12);
    assert.ok((1 + 61 * apu.vrc6LinearGain) * apu.vrc6MixScale <= 1);
});

test('keeps the native mixer path unchanged without VRC6', () => {
    const nativeApu = new APU();
    const unsupportedExpansionApu = new APU({ expansionChips: 0x04 });

    nativeApu.writeRegister(0x4000, 0x9F);
    nativeApu.writeRegister(0x4002, 0x20);
    nativeApu.writeRegister(0x4003, 0x08);
    nativeApu.writeRegister(0x4015, 0x01);

    unsupportedExpansionApu.writeRegister(0x4000, 0x9F);
    unsupportedExpansionApu.writeRegister(0x4002, 0x20);
    unsupportedExpansionApu.writeRegister(0x4003, 0x08);
    unsupportedExpansionApu.writeRegister(0x4015, 0x01);

    nativeApu.clock(256);
    unsupportedExpansionApu.clock(256);

    assert.equal(nativeApu.getOutput(), unsupportedExpansionApu.getOutput());
});

test('reset clears VRC6 state while retaining expansion configuration', () => {
    const apu = new APU({ expansionChips: 0x01, vrc6SwapAddressLines: true });
    const vrc6 = apu.vrc6;
    apu.writeExpansionRegister(0x9000, 0x8F);
    apu.writeExpansionRegister(0x9002, 0x00);
    apu.writeExpansionRegister(0x9001, 0x80);
    assert.equal(apu.vrc6.getChannelOutputs().pulse1, 15);

    apu.reset();

    assert.equal(apu.vrc6, vrc6);
    assert.equal(apu.vrc6.swapAddressLines, true);
    assert.equal(apu.vrc6.getOutput(), 0);
    assert.equal(apu.writeExpansionRegister(0x9000, 0x8F), true);
});

test('reports VRC6 activity to lifecycle scanners', () => {
    const apu = new APU({ expansionChips: 0x01 });
    assert.equal(apu.isChannelActive(), false);

    apu.writeExpansionRegister(0x9000, 0x8F);
    apu.writeExpansionRegister(0x9001, 0x20);
    apu.writeExpansionRegister(0x9002, 0x80);
    assert.equal(apu.isChannelActive(), true);

    apu.writeExpansionRegister(0x9003, 0x01);
    assert.equal(apu.isChannelActive(), false);

    apu.writeExpansionRegister(0x9003, 0x00);
    apu.writeExpansionRegister(0x9002, 0x00);
    assert.equal(apu.isChannelActive(), false);
});

test('returns stable zero expansion outputs when VRC6 is absent', () => {
    const nativeApu = new APU();
    assert.deepEqual(nativeApu.getChannelOutputs(), {
        pulse1: 0,
        pulse2: 0,
        triangle: 0,
        noise: 0,
        dmc: 0,
        vrc6Pulse1: 0,
        vrc6Pulse2: 0,
        vrc6Saw: 0,
    });

    const vrc6Apu = new APU({ expansionChips: 0x01 });
    vrc6Apu.writeExpansionRegister(0x9000, 0x8C);
    vrc6Apu.writeExpansionRegister(0x9001, 0x00);
    vrc6Apu.writeExpansionRegister(0x9002, 0x80);
    assert.equal(vrc6Apu.getChannelOutputs().vrc6Pulse1, 12);
});

test('fast-forward retains the existing oscillator-phase skipping behavior', () => {
    const apu = new APU({ expansionChips: 0x01 });
    apu.writeExpansionRegister(0x9000, 0x0F);
    apu.writeExpansionRegister(0x9001, 0x00);
    apu.writeExpansionRegister(0x9002, 0x80);
    apu.clock();
    const stepBeforeFastForward = apu.vrc6.pulse[0].step;

    apu.fastForward(10000);

    assert.equal(apu.vrc6.pulse[0].step, stepBeforeFastForward);
});
