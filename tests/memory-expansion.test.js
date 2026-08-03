'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Memory } = require('../src/memory.js');
const { VRC6 } = require('../src/vrc6.js');

function createMemory() {
    const memory = new Memory();
    const prgData = new Uint8Array(0x2000);
    prgData[0x1000] = 0x5A; // CPU address $9000.
    prgData[0x1004] = 0x6B; // CPU address $9004.
    memory.loadNSF({
        prgData: prgData,
        loadAddress: 0x8000,
        hasBankswitching: false,
        bankswitch: new Uint8Array(8),
    });
    return memory;
}

test('routes canonical VRC6 writes through the expansion-audio contract', () => {
    const memory = createMemory();
    const vrc6 = new VRC6();
    const handledWrites = [];
    memory.apu = {
        writeExpansionRegister(address, value) {
            const handled = vrc6.writeRegister(address, value);
            if (handled) handledWrites.push({ address, value });
            return handled;
        },
    };

    memory.write(0x9000, 0x18F);
    memory.write(0x9001, 0x234);
    memory.write(0x9002, 0x180);

    assert.deepEqual(handledWrites, [
        { address: 0x9000, value: 0x8F },
        { address: 0x9001, value: 0x34 },
        { address: 0x9002, value: 0x80 },
    ]);
    assert.equal(vrc6.pulse[0].constantMode, true);
    assert.equal(vrc6.pulse[0].volume, 15);
    assert.equal(vrc6.pulse[0].period, 0x034);
    assert.equal(vrc6.pulse[0].enabled, true);
});

test('VRC6 writes do not replace PRG-ROM reads at the same address', () => {
    const memory = createMemory();
    const vrc6 = new VRC6();
    memory.apu = {
        writeExpansionRegister: (address, value) => vrc6.writeRegister(address, value),
    };

    assert.equal(memory.read(0x9000), 0x5A);
    memory.write(0x9000, 0x8F);
    assert.equal(memory.read(0x9000), 0x5A);
    assert.equal(vrc6.getChannelOutputs().pulse1, 0);
});

test('unclaimed ROM-area writes remain ignored', () => {
    const memory = createMemory();
    const vrc6 = new VRC6();
    let claimedWrites = 0;
    memory.apu = {
        writeExpansionRegister(address, value) {
            const handled = vrc6.writeRegister(address, value);
            if (handled) claimedWrites++;
            return handled;
        },
    };

    memory.write(0x9004, 0xFF);

    assert.equal(claimedWrites, 0);
    assert.equal(memory.read(0x9004), 0x6B);
    assert.equal(vrc6.getOutput(), 0);
});

test('native APU writes and extra RAM bypass the expansion hook', () => {
    const memory = createMemory();
    const nativeWrites = [];
    const expansionWrites = [];
    memory.apu = {
        writeRegister: (address, value) => nativeWrites.push({ address, value }),
        writeExpansionRegister: (address, value) => {
            expansionWrites.push({ address, value });
            return false;
        },
    };

    memory.write(0x4000, 0x91);
    memory.write(0x6000, 0x42);

    assert.deepEqual(nativeWrites, [{ address: 0x4000, value: 0x91 }]);
    assert.deepEqual(expansionWrites, []);
    assert.equal(memory.read(0x6000), 0x42);
});

test('ROM writes remain safe when no expansion handler is configured', () => {
    const memory = createMemory();

    assert.doesNotThrow(() => memory.write(0x9000, 0xFF));
    assert.equal(memory.read(0x9000), 0x5A);
});
