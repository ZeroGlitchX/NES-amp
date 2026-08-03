'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { parseNSF } = require('../../src/nsf-parser.js');
const { CPU6502 } = require('../../src/cpu6502.js');
const { APU } = require('../../src/apu.js');
const { Memory } = require('../../src/memory.js');
const { NSFEngine } = require('../../src/nsf-engine.js');

const REPO_ROOT = path.resolve(__dirname, '..', '..');

function fixtureExists(relativePath) {
    return fs.existsSync(path.join(REPO_ROOT, relativePath));
}

function loadFixture(relativePath) {
    const absolutePath = path.join(REPO_ROOT, relativePath);
    const data = fs.readFileSync(absolutePath);
    const buffer = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
    return { absolutePath, buffer, nsf: parseNSF(buffer) };
}

function createHeadlessEngine(relativePath, options = {}) {
    if (typeof options === 'number') options = { songNumber: options };

    const fixture = loadFixture(relativePath);
    const engine = new NSFEngine();
    engine.nsf = fixture.nsf;
    engine.apu = new APU({
        expansionChips: fixture.nsf.expansionChips,
        ...(options.apuOptions || {}),
    });
    if (typeof options.onExpansionWrite === 'function') {
        const writeExpansionRegister = engine.apu.writeExpansionRegister.bind(engine.apu);
        engine.apu.writeExpansionRegister = (address, value) => {
            const handled = writeExpansionRegister(address, value);
            if (handled) options.onExpansionWrite(address & 0xFFFF, value & 0xFF);
            return handled;
        };
    }
    engine.memory = new Memory();
    engine.memory.apu = engine.apu;
    engine.apu.memory = engine.memory;
    engine.cpu = new CPU6502(engine.memory);
    engine.memory.loadNSF(fixture.nsf);
    engine.cyclesPerPlayCall = fixture.nsf.ntscSpeed > 0
        ? Math.round(engine.cpuClockHz * fixture.nsf.ntscSpeed / 1000000)
        : 29781;
    const songNumber = options.songNumber === undefined
        ? fixture.nsf.startingSong - 1
        : options.songNumber;
    engine.initTrack(songNumber);
    return { engine, fixture };
}

function renderSamples(engine, count) {
    const output = new Float32Array(count);
    engine._generateSamples(output, count);
    return output;
}

function getPCMStats(samples) {
    let min = Number.POSITIVE_INFINITY;
    let max = Number.NEGATIVE_INFINITY;
    let squareSum = 0;

    for (const sample of samples) {
        if (!Number.isFinite(sample)) {
            return { finite: false, min: NaN, max: NaN, peak: NaN, rms: NaN };
        }
        min = Math.min(min, sample);
        max = Math.max(max, sample);
        squareSum += sample * sample;
    }

    return {
        finite: true,
        min: min,
        max: max,
        peak: Math.max(Math.abs(min), Math.abs(max)),
        rms: Math.sqrt(squareSum / samples.length),
    };
}

function getHistoryPeaks(engine) {
    const peaks = {
        pulse1: 0,
        pulse2: 0,
        triangle: 0,
        noise: 0,
        dmc: 0,
        vrc6Pulse1: 0,
        vrc6Pulse2: 0,
        vrc6Saw: 0,
    };
    const histories = {
        pulse1: engine.chPulse1,
        pulse2: engine.chPulse2,
        triangle: engine.chTriangle,
        noise: engine.chNoise,
        dmc: engine.chDmc,
        vrc6Pulse1: engine.chVrc6Pulse1,
        vrc6Pulse2: engine.chVrc6Pulse2,
        vrc6Saw: engine.chVrc6Saw,
    };
    const count = Math.min(engine.samplesGenerated, engine.channelHistorySize);
    const firstSample = engine.samplesGenerated - count;

    for (let offset = 0; offset < count; offset++) {
        const index = (firstSample + offset) & engine.channelHistoryMask;
        for (const channel of Object.keys(peaks)) {
            peaks[channel] = Math.max(peaks[channel], histories[channel][index]);
        }
    }

    return peaks;
}

function snapshotVRC6(vrc6) {
    if (!vrc6) return null;
    return JSON.parse(JSON.stringify({
        halted: vrc6.halted,
        frequencyShift: vrc6.frequencyShift,
        pulse: vrc6.pulse,
        saw: vrc6.saw,
    }));
}

module.exports = {
    createHeadlessEngine,
    fixtureExists,
    getHistoryPeaks,
    getPCMStats,
    loadFixture,
    renderSamples,
    snapshotVRC6,
};
