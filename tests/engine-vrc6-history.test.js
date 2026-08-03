'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { NSFEngine } = require('../src/nsf-engine.js');

test('allocates latency-compensated history for all three VRC6 channels', () => {
    const engine = new NSFEngine();

    assert.equal(engine.chVrc6Pulse1.length, engine.channelHistorySize);
    assert.equal(engine.chVrc6Pulse2.length, engine.channelHistorySize);
    assert.equal(engine.chVrc6Saw.length, engine.channelHistorySize);
    assert.deepEqual(engine.getChannelOutputs(), {
        pulse1: 0,
        pulse2: 0,
        triangle: 0,
        noise: 0,
        dmc: 0,
        vrc6Pulse1: 0,
        vrc6Pulse2: 0,
        vrc6Saw: 0,
        vrc6Enabled: false,
    });
});

test('stores VRC6 snapshots alongside native channels during sample generation', () => {
    const engine = new NSFEngine();
    engine.cyclesPerSample = 1;
    engine.cycleRemainder = 0;
    engine._sampleTarget = 0;
    engine._nextPlayCycle = Number.POSITIVE_INFINITY;
    engine.nsf = { playAddress: 0 };
    engine.cpu = {
        cycles: 0,
        step() { this.cycles++; },
    };
    engine.apu = {
        vrc6: {},
        clock(elapsed, accumulateMix) {
            return accumulateMix ? 0.5 * elapsed : 0;
        },
        getOutput() { return 0.5; },
        getChannelOutputs() {
            return {
                pulse1: 1,
                pulse2: 2,
                triangle: 3,
                noise: 4,
                dmc: 5,
                vrc6Pulse1: 6,
                vrc6Pulse2: 7,
                vrc6Saw: 8,
            };
        },
    };

    const output = new Float32Array(1);
    engine._generateSamples(output, 1);

    assert.equal(output[0], 0);
    assert.equal(engine.chVrc6Pulse1[0], 6);
    assert.equal(engine.chVrc6Pulse2[0], 7);
    assert.equal(engine.chVrc6Saw[0], 8);
    assert.deepEqual(engine.getChannelOutputs(), {
        pulse1: 1,
        pulse2: 2,
        triangle: 3,
        noise: 4,
        dmc: 5,
        vrc6Pulse1: 6,
        vrc6Pulse2: 7,
        vrc6Saw: 8,
        vrc6Enabled: true,
    });
});

test('reads VRC6 history with the same queue-latency compensation as native channels', () => {
    const engine = new NSFEngine();
    engine.apu = { vrc6: {} };
    engine.samplesGenerated = 4;
    engine.workletQueuedSamples = 2;
    engine.chPulse1[1] = 9;
    engine.chVrc6Pulse1[1] = 10;
    engine.chVrc6Pulse2[1] = 11;
    engine.chVrc6Saw[1] = 12;

    const output = engine.getChannelOutputs();

    assert.equal(output.pulse1, 9);
    assert.equal(output.vrc6Pulse1, 10);
    assert.equal(output.vrc6Pulse2, 11);
    assert.equal(output.vrc6Saw, 12);
    assert.equal(output.vrc6Enabled, true);
});

test('keeps the five-channel visualizer mode when VRC6 is absent', () => {
    const engine = new NSFEngine();
    engine.apu = { vrc6: null };
    engine.samplesGenerated = 1;
    engine.chVrc6Pulse1[0] = 15;
    engine.chVrc6Pulse2[0] = 15;
    engine.chVrc6Saw[0] = 31;

    const output = engine.getChannelOutputs();

    assert.equal(output.vrc6Enabled, false);
});
