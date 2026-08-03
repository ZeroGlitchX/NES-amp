'use strict';

const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');
const {
    NSF_EXPANSION_CHIPS,
    parseNSF,
} = require('../src/nsf-parser.js');
const { getNSFExpansionSupport } = require('../src/nsf-engine.js');

function createNSF(expansionChips) {
    const buffer = new ArrayBuffer(0x81);
    const bytes = new Uint8Array(buffer);
    bytes.set([0x4E, 0x45, 0x53, 0x4D, 0x1A]);
    bytes[0x7B] = expansionChips;
    return parseNSF(buffer);
}

test('reports pure VRC6 files as fully supported', () => {
    const nsf = createNSF(NSF_EXPANSION_CHIPS.VRC6);
    const support = getNSFExpansionSupport(nsf.expansionChips);

    assert.deepEqual(nsf.requestedExpansionChips.map(chip => chip.name), ['VRC6']);
    assert.deepEqual(support.supported.map(chip => chip.name), ['VRC6']);
    assert.deepEqual(support.unsupported, []);
    assert.equal(support.isFullySupported, true);
});

test('reports mixed VRC6, VRC7, and FDS files as partially supported', () => {
    const flags = NSF_EXPANSION_CHIPS.VRC6
        | NSF_EXPANSION_CHIPS.VRC7
        | NSF_EXPANSION_CHIPS.FDS;
    const support = getNSFExpansionSupport(flags);

    assert.deepEqual(support.supported.map(chip => chip.name), ['VRC6']);
    assert.deepEqual(support.unsupported.map(chip => chip.name), ['VRC7', 'FDS']);
    assert.equal(support.isFullySupported, false);
});

test('reports native APU files as fully supported without expansion audio', () => {
    const support = getNSFExpansionSupport(0);

    assert.deepEqual(support.requested, []);
    assert.equal(support.hasExpansionAudio, false);
    assert.equal(support.isFullySupported, true);
});

const akumajouFixture = path.join(
    __dirname,
    '..',
    'NES-Gamemusic',
    'Famicom',
    'Konami',
    'Akumajou_Densetsu.nsf'
);

test('bundled Akumajou Densetsu fixture requests VRC6', {
    skip: !fs.existsSync(akumajouFixture),
}, () => {
    const data = fs.readFileSync(akumajouFixture);
    const buffer = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
    const nsf = parseNSF(buffer);

    assert.equal(nsf.title, 'Akumajou Densetsu');
    assert.equal(nsf.expansionChips, NSF_EXPANSION_CHIPS.VRC6);
    assert.equal(getNSFExpansionSupport(nsf.expansionChips).isFullySupported, true);
});
