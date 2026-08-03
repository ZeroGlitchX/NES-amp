/**
 * NSF (Nintendo Sound Format) File Parser
 * Parses the 128-byte NSF header and extracts PRG ROM data.
 */
'use strict';

const NSF_EXPANSION_CHIPS = Object.freeze({
    VRC6:       0x01,
    VRC7:       0x02,
    FDS:        0x04,
    MMC5:       0x08,
    N163:       0x10,
    SUNSOFT_5B: 0x20,
    VT02_PLUS:  0x40,
});

const NSF_EXPANSION_CHIP_DEFINITIONS = Object.freeze([
    Object.freeze({ id: 'vrc6',      name: 'VRC6',       mask: NSF_EXPANSION_CHIPS.VRC6 }),
    Object.freeze({ id: 'vrc7',      name: 'VRC7',       mask: NSF_EXPANSION_CHIPS.VRC7 }),
    Object.freeze({ id: 'fds',       name: 'FDS',        mask: NSF_EXPANSION_CHIPS.FDS }),
    Object.freeze({ id: 'mmc5',      name: 'MMC5',       mask: NSF_EXPANSION_CHIPS.MMC5 }),
    Object.freeze({ id: 'n163',      name: 'N163',       mask: NSF_EXPANSION_CHIPS.N163 }),
    Object.freeze({ id: 'sunsoft5b', name: 'Sunsoft 5B', mask: NSF_EXPANSION_CHIPS.SUNSOFT_5B }),
    Object.freeze({ id: 'vt02plus',  name: 'VT02+',      mask: NSF_EXPANSION_CHIPS.VT02_PLUS }),
]);

const NSF_KNOWN_EXPANSION_CHIP_MASK = NSF_EXPANSION_CHIP_DEFINITIONS.reduce(
    (mask, chip) => mask | chip.mask,
    0
);

function getNSFExpansionChips(flags) {
    flags &= 0xFF;
    const chips = NSF_EXPANSION_CHIP_DEFINITIONS
        .filter(chip => (flags & chip.mask) !== 0)
        .map(chip => ({ id: chip.id, name: chip.name, mask: chip.mask }));
    const unknownMask = flags & ~NSF_KNOWN_EXPANSION_CHIP_MASK;

    if (unknownMask !== 0) {
        chips.push({
            id: 'unknown',
            name: `Unknown (0x${unknownMask.toString(16).padStart(2, '0').toUpperCase()})`,
            mask: unknownMask,
        });
    }

    return chips;
}

function parseNSF(arrayBuffer) {
    if (arrayBuffer.byteLength < 0x80) {
        throw new Error('File too small to be a valid NSF');
    }

    const view = new DataView(arrayBuffer);
    const bytes = new Uint8Array(arrayBuffer);

    // Validate magic: "NESM\x1A"
    if (bytes[0] !== 0x4E || bytes[1] !== 0x45 || bytes[2] !== 0x53 ||
        bytes[3] !== 0x4D || bytes[4] !== 0x1A) {
        throw new Error('Invalid NSF file: bad magic number');
    }

    function readString(offset, length) {
        let str = '';
        for (let i = 0; i < length; i++) {
            const ch = bytes[offset + i];
            if (ch === 0) break;
            str += String.fromCharCode(ch);
        }
        return str;
    }

    const bankswitch = new Uint8Array(8);
    for (let i = 0; i < 8; i++) {
        bankswitch[i] = bytes[0x70 + i];
    }

    const hasBankswitching = bankswitch.some(b => b !== 0);
    const loadAddress = view.getUint16(0x08, true);
    const prgData = new Uint8Array(arrayBuffer, 0x80);
    const expansionChips = bytes[0x7B];

    return {
        version:         bytes[0x05],
        totalSongs:      bytes[0x06],
        startingSong:    bytes[0x07],
        loadAddress:     loadAddress,
        initAddress:     view.getUint16(0x0A, true),
        playAddress:     view.getUint16(0x0C, true),
        title:           readString(0x0E, 32),
        artist:          readString(0x2E, 32),
        copyright:       readString(0x4E, 32),
        ntscSpeed:       view.getUint16(0x6E, true),
        palSpeed:        view.getUint16(0x78, true),
        bankswitch:      bankswitch,
        hasBankswitching: hasBankswitching,
        ntscPalFlags:    bytes[0x7A],
        expansionChips:  expansionChips,
        requestedExpansionChips: getNSFExpansionChips(expansionChips),
        prgData:         prgData,
    };
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        NSF_EXPANSION_CHIPS,
        NSF_EXPANSION_CHIP_DEFINITIONS,
        getNSFExpansionChips,
        parseNSF,
    };
}
