/**
 * NSF (Nintendo Sound Format) File Parser
 * Parses the 128-byte NSF header and extracts PRG ROM data.
 */
'use strict';

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
        expansionChips:  bytes[0x7B],
        prgData:         prgData,
    };
}
