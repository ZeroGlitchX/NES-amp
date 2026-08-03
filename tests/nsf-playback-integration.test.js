'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { NSF_EXPANSION_CHIPS } = require('../src/nsf-parser.js');
const { getNSFExpansionSupport } = require('../src/nsf-engine.js');
const {
    createHeadlessEngine,
    fixtureExists,
    getHistoryPeaks,
    getPCMStats,
    loadFixture,
    renderSamples,
    snapshotVRC6,
} = require('./helpers/nsf-harness.js');

const AKUMAJOU = 'NES-Gamemusic/Famicom/Konami/Akumajou_Densetsu.nsf';
const CASTLEVANIA_3_US = 'NES-Gamemusic/Nintendo/Konami_Ultra/castlevania-iii.nsf';
const NIGEL_MANSELL =
    'NES-Gamemusic/Nintendo/Gametek/nigel-mansell-s-world-championship-racing.nsf';
const ESPER_DREAM_2 = 'NES-Gamemusic/Famicom/Konami/Esper_Dream_2.nsf';
const MADARA = 'NES-Gamemusic/Famicom/Konami/Madara.nsf';

test('renders all three VRC6 channels from Akumajou Densetsu', {
    skip: !fixtureExists(AKUMAJOU),
}, () => {
    const { engine, fixture } = createHeadlessEngine(AKUMAJOU);
    const samples = renderSamples(engine, 120000); // 2.5 seconds at 48 kHz.
    const stats = getPCMStats(samples);
    const peaks = getHistoryPeaks(engine);

    assert.equal(fixture.nsf.expansionChips, NSF_EXPANSION_CHIPS.VRC6);
    assert.ok(engine.apu.vrc6);
    assert.equal(stats.finite, true);
    assert.ok(stats.min >= -0.850001 && stats.max <= 0.850001);
    assert.ok(stats.rms > 0.01);
    assert.equal(peaks.vrc6Pulse1, 15);
    assert.ok(peaks.vrc6Pulse2 >= 6);
    assert.ok(peaks.vrc6Saw >= 30);
    assert.equal(engine.getChannelOutputs().vrc6Enabled, true);
});

test('keeps standard Castlevania III on the native five-channel path', {
    skip: !fixtureExists(CASTLEVANIA_3_US),
}, () => {
    const { engine, fixture } = createHeadlessEngine(CASTLEVANIA_3_US);
    const samples = renderSamples(engine, 48000);
    const stats = getPCMStats(samples);
    const peaks = getHistoryPeaks(engine);

    assert.equal(fixture.nsf.expansionChips, 0);
    assert.equal(engine.apu.vrc6, null);
    assert.equal(stats.finite, true);
    assert.ok(stats.min >= -0.850001 && stats.max <= 0.850001);
    assert.ok(stats.rms > 0.01);
    assert.equal(peaks.vrc6Pulse1, 0);
    assert.equal(peaks.vrc6Pulse2, 0);
    assert.equal(peaks.vrc6Saw, 0);
    assert.equal(engine.getChannelOutputs().vrc6Enabled, false);
});

test('track reinitialization clears stale VRC6 state deterministically', {
    skip: !fixtureExists(AKUMAJOU),
}, () => {
    const { engine } = createHeadlessEngine(AKUMAJOU);
    const initializedState = snapshotVRC6(engine.apu.vrc6);

    renderSamples(engine, 24000);
    engine.apu.writeExpansionRegister(0x9000, 0x8F);
    engine.apu.writeExpansionRegister(0x9001, 0x00);
    engine.apu.writeExpansionRegister(0x9002, 0x80);
    engine.apu.clock(100);
    assert.notDeepEqual(snapshotVRC6(engine.apu.vrc6), initializedState);

    engine.initTrack(engine.currentSong);

    assert.equal(engine.samplesGenerated, 0);
    assert.equal(engine.cycleRemainder, 0);
    assert.deepEqual(snapshotVRC6(engine.apu.vrc6), initializedState);
});

test('mixed expansion fixture reports only its VRC6 portion as supported', {
    skip: !fixtureExists(NIGEL_MANSELL),
}, () => {
    const { nsf } = loadFixture(NIGEL_MANSELL);
    const support = getNSFExpansionSupport(nsf.expansionChips);

    assert.equal(nsf.expansionChips, 0x07);
    assert.deepEqual(support.supported.map(chip => chip.name), ['VRC6']);
    assert.deepEqual(support.unsupported.map(chip => chip.name), ['VRC7', 'FDS']);
    assert.equal(support.isFullySupported, false);
});

for (const fixturePath of [AKUMAJOU, ESPER_DREAM_2, MADARA]) {
    const fixtureName = fixturePath.split('/').pop();
    test(`${fixtureName} uses canonical VRC6 period-register ordering`, {
        skip: !fixtureExists(fixturePath),
    }, () => {
        const writes = [];
        const { engine } = createHeadlessEngine(fixturePath, {
            onExpansionWrite: (address, value) => writes.push({ address, value }),
        });
        renderSamples(engine, 120000);

        for (const base of [0x9000, 0xA000]) {
            const periodLowWrites = writes.filter(write => write.address === base + 1);
            const periodHighWrites = writes.filter(write => write.address === base + 2);

            assert.ok(periodLowWrites.length > 0);
            assert.ok(periodHighWrites.length > 0);
            assert.ok(periodLowWrites.some(write => (write.value & 0x70) !== 0));
            assert.ok(periodHighWrites.every(write => (write.value & 0x70) === 0));
        }
    });
}
