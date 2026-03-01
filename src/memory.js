/**
 * NES Memory Bus for NSF Playback
 * Handles RAM, PRG ROM, bankswitch registers, and APU register forwarding.
 */
'use strict';

class Memory {
    constructor() {
        this.ram = new Uint8Array(0x0800);       // $0000-$07FF (2KB, mirrored to $1FFF)
        this.extraRam = new Uint8Array(0x2000);  // $6000-$7FFF (8KB)
        this.prgData = null;                     // Raw PRG ROM from NSF file
        this.bankOffsets = new Int32Array(8);     // Byte offsets into prgData for 8x 4KB banks
        this.hasBankswitching = false;
        this.loadAddress = 0;
        this.apu = null;                         // Set after construction
    }

    loadNSF(nsf) {
        this.prgData = nsf.prgData;
        this.loadAddress = nsf.loadAddress;
        this.hasBankswitching = nsf.hasBankswitching;

        if (this.hasBankswitching) {
            for (let i = 0; i < 8; i++) {
                this.bankOffsets[i] = nsf.bankswitch[i] * 0x1000;
            }
        }
    }

    reset() {
        this.ram.fill(0);
        this.extraRam.fill(0);

        // Place sentinel self-loop at $5FFC: JMP $5FFC
        // This lives in extraRam at offset $5FFC - $6000... wait, $5FFC < $6000
        // We need special handling — store the sentinel in a dedicated area
        this._sentinel = true;
    }

    read(addr) {
        addr &= 0xFFFF;

        // $0000-$1FFF: RAM (2KB mirrored)
        if (addr < 0x2000) {
            return this.ram[addr & 0x07FF];
        }

        // $2000-$3FFF: PPU registers (not used in NSF, return 0)
        if (addr < 0x4000) {
            return 0;
        }

        // $4000-$4017: APU / IO registers
        if (addr < 0x4018) {
            if (this.apu) return this.apu.readRegister(addr);
            return 0;
        }

        // $4018-$5FFF: Expansion area
        if (addr < 0x6000) {
            // Sentinel self-loop at $5FFC-$5FFE
            if (addr === 0x5FFC) return 0x4C; // JMP opcode
            if (addr === 0x5FFD) return 0xFC; // low byte
            if (addr === 0x5FFE) return 0x5F; // high byte -> $5FFC
            return 0;
        }

        // $6000-$7FFF: Extra RAM
        if (addr < 0x8000) {
            return this.extraRam[addr - 0x6000];
        }

        // $8000-$FFFF: PRG ROM
        if (!this.prgData) return 0;

        if (this.hasBankswitching) {
            const bankIndex = (addr - 0x8000) >> 12; // 0-7
            const offset = this.bankOffsets[bankIndex] + (addr & 0x0FFF);
            if (offset >= 0 && offset < this.prgData.length) {
                return this.prgData[offset];
            }
            return 0;
        } else {
            const offset = addr - this.loadAddress;
            if (offset >= 0 && offset < this.prgData.length) {
                return this.prgData[offset];
            }
            return 0;
        }
    }

    write(addr, value) {
        addr &= 0xFFFF;
        value &= 0xFF;

        // $0000-$1FFF: RAM
        if (addr < 0x2000) {
            this.ram[addr & 0x07FF] = value;
            return;
        }

        // $2000-$3FFF: PPU registers (ignored)
        if (addr < 0x4000) return;

        // $4000-$4017: APU / IO registers
        if (addr < 0x4018) {
            if (this.apu) this.apu.writeRegister(addr, value);
            return;
        }

        // $5FF8-$5FFF: Bankswitch registers
        if (addr >= 0x5FF8 && addr <= 0x5FFF) {
            if (this.hasBankswitching) {
                const bankIndex = addr - 0x5FF8;
                this.bankOffsets[bankIndex] = value * 0x1000;
            }
            return;
        }

        // $6000-$7FFF: Extra RAM
        if (addr >= 0x6000 && addr < 0x8000) {
            this.extraRam[addr - 0x6000] = value;
            return;
        }

        // $8000-$FFFF: ROM writes ignored (unless FDS expansion — future)
    }
}
