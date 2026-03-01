/**
 * MOS 6502 CPU Emulator for NSF Playback
 * Implements all 151 official opcodes + common unofficial opcodes.
 */
'use strict';

class CPU6502 {
    constructor(memory) {
        this.mem = memory;

        // Registers
        this.a = 0;      // Accumulator
        this.x = 0;      // Index X
        this.y = 0;      // Index Y
        this.sp = 0xFD;  // Stack pointer
        this.pc = 0;     // Program counter (16-bit)
        this.cycles = 0; // Total cycles elapsed

        // Status flags (individual booleans for speed)
        this.fC = false; // Carry
        this.fZ = false; // Zero
        this.fI = true;  // Interrupt disable
        this.fD = false; // Decimal (no BCD on NES, but flag still sets/clears)
        this.fV = false; // Overflow
        this.fN = false; // Negative

        // IRQ/NMI
        this.irqPending = false;
        this.nmiPending = false;

        // Build opcode dispatch table
        this._buildOpcodeTable();
    }

    reset() {
        this.a = 0;
        this.x = 0;
        this.y = 0;
        this.sp = 0xFD;
        this.fC = false;
        this.fZ = false;
        this.fI = true;
        this.fD = false;
        this.fV = false;
        this.fN = false;
        this.irqPending = false;
        this.nmiPending = false;
        this.cycles = 0;
        // PC is set by the caller for NSF (not from reset vector)
    }

    // Pack status register into byte
    getP() {
        return (this.fC ? 0x01 : 0) | (this.fZ ? 0x02 : 0) | (this.fI ? 0x04 : 0) |
               (this.fD ? 0x08 : 0) | 0x20 | (this.fV ? 0x40 : 0) | (this.fN ? 0x80 : 0);
    }

    // Unpack byte into status flags
    setP(v) {
        this.fC = !!(v & 0x01);
        this.fZ = !!(v & 0x02);
        this.fI = !!(v & 0x04);
        this.fD = !!(v & 0x08);
        this.fV = !!(v & 0x40);
        this.fN = !!(v & 0x80);
    }

    // Set N and Z flags from a result
    _nz(v) {
        this.fN = (v & 0x80) !== 0;
        this.fZ = (v & 0xFF) === 0;
        return v & 0xFF;
    }

    // Memory read/write shortcuts
    _rd(a) { return this.mem.read(a & 0xFFFF); }
    _wr(a, v) { this.mem.write(a & 0xFFFF, v & 0xFF); }

    // Read 16-bit little-endian from memory
    _rd16(a) { return this._rd(a) | (this._rd(a + 1) << 8); }

    // Read 16-bit with page-wrap bug (for JMP indirect)
    _rd16bug(a) {
        const lo = this._rd(a);
        const hi = this._rd((a & 0xFF00) | ((a + 1) & 0x00FF));
        return lo | (hi << 8);
    }

    // Stack operations
    _push(v) { this._wr(0x0100 | this.sp, v); this.sp = (this.sp - 1) & 0xFF; }
    _pull() { this.sp = (this.sp + 1) & 0xFF; return this._rd(0x0100 | this.sp); }

    // Check if adding offset crosses a page boundary
    _pageCross(base, offset) {
        return ((base & 0xFF) + offset) > 0xFF;
    }

    // ── NSF-specific: JSR to address with sentinel return ──
    jsr(address) {
        // Push sentinel return address ($5FFB so RTS goes to $5FFC)
        this._push((0x5FFB >> 8) & 0xFF); // high byte
        this._push(0x5FFB & 0xFF);         // low byte
        this.pc = address;
    }

    // Run until PC reaches sentinel ($5FFC) or max cycles exceeded
    runUntilReturn(maxCycles) {
        const start = this.cycles;
        while (this.pc !== 0x5FFC && (this.cycles - start) < maxCycles) {
            this.step();
        }
    }

    // Execute one instruction, return cycles consumed
    step() {
        // Handle NMI
        if (this.nmiPending) {
            this.nmiPending = false;
            this._push(this.pc >> 8);
            this._push(this.pc & 0xFF);
            this._push(this.getP() & ~0x10); // B flag clear for NMI
            this.fI = true;
            this.pc = this._rd16(0xFFFA);
            this.cycles += 7;
            return 7;
        }

        // Handle IRQ
        if (this.irqPending && !this.fI) {
            this.irqPending = false;
            this._push(this.pc >> 8);
            this._push(this.pc & 0xFF);
            this._push(this.getP() & ~0x10); // B flag clear for IRQ
            this.fI = true;
            this.pc = this._rd16(0xFFFE);
            this.cycles += 7;
            return 7;
        }

        const opcode = this._rd(this.pc++);
        const prevCycles = this.cycles;
        this.opcodes[opcode]();
        return this.cycles - prevCycles;
    }

    // ── Opcode Table Builder ──
    _buildOpcodeTable() {
        this.opcodes = new Array(256);

        // Fill with NOP for undefined opcodes
        for (let i = 0; i < 256; i++) {
            this.opcodes[i] = () => { this.cycles += 2; };
        }

        const cpu = this;

        // ── Addressing mode helpers (return effective address) ──
        function imm() { return cpu.pc++; }
        function zpg() { return cpu._rd(cpu.pc++); }
        function zpx() { return (cpu._rd(cpu.pc++) + cpu.x) & 0xFF; }
        function zpy() { return (cpu._rd(cpu.pc++) + cpu.y) & 0xFF; }
        function abs() { const a = cpu._rd16(cpu.pc); cpu.pc += 2; return a; }
        function abx() { const base = cpu._rd16(cpu.pc); cpu.pc += 2; return (base + cpu.x) & 0xFFFF; }
        function aby() { const base = cpu._rd16(cpu.pc); cpu.pc += 2; return (base + cpu.y) & 0xFFFF; }
        function abxR() { // Absolute,X with page-cross penalty for reads
            const base = cpu._rd16(cpu.pc); cpu.pc += 2;
            if (cpu._pageCross(base, cpu.x)) cpu.cycles++;
            return (base + cpu.x) & 0xFFFF;
        }
        function abyR() { // Absolute,Y with page-cross penalty for reads
            const base = cpu._rd16(cpu.pc); cpu.pc += 2;
            if (cpu._pageCross(base, cpu.y)) cpu.cycles++;
            return (base + cpu.y) & 0xFFFF;
        }
        function izx() {
            const ptr = (cpu._rd(cpu.pc++) + cpu.x) & 0xFF;
            return cpu._rd(ptr) | (cpu._rd((ptr + 1) & 0xFF) << 8);
        }
        function izy() {
            const ptr = cpu._rd(cpu.pc++);
            const base = cpu._rd(ptr) | (cpu._rd((ptr + 1) & 0xFF) << 8);
            return (base + cpu.y) & 0xFFFF;
        }
        function izyR() { // (Indirect),Y with page-cross penalty for reads
            const ptr = cpu._rd(cpu.pc++);
            const base = cpu._rd(ptr) | (cpu._rd((ptr + 1) & 0xFF) << 8);
            if (cpu._pageCross(base, cpu.y)) cpu.cycles++;
            return (base + cpu.y) & 0xFFFF;
        }

        // ── Operations ──

        // -- LDA --
        function LDA(v) { cpu.a = cpu._nz(v); }
        cpu.opcodes[0xA9] = () => { cpu.cycles += 2; LDA(cpu._rd(imm())); };
        cpu.opcodes[0xA5] = () => { cpu.cycles += 3; LDA(cpu._rd(zpg())); };
        cpu.opcodes[0xB5] = () => { cpu.cycles += 4; LDA(cpu._rd(zpx())); };
        cpu.opcodes[0xAD] = () => { cpu.cycles += 4; LDA(cpu._rd(abs())); };
        cpu.opcodes[0xBD] = () => { cpu.cycles += 4; LDA(cpu._rd(abxR())); };
        cpu.opcodes[0xB9] = () => { cpu.cycles += 4; LDA(cpu._rd(abyR())); };
        cpu.opcodes[0xA1] = () => { cpu.cycles += 6; LDA(cpu._rd(izx())); };
        cpu.opcodes[0xB1] = () => { cpu.cycles += 5; LDA(cpu._rd(izyR())); };

        // -- LDX --
        function LDX(v) { cpu.x = cpu._nz(v); }
        cpu.opcodes[0xA2] = () => { cpu.cycles += 2; LDX(cpu._rd(imm())); };
        cpu.opcodes[0xA6] = () => { cpu.cycles += 3; LDX(cpu._rd(zpg())); };
        cpu.opcodes[0xB6] = () => { cpu.cycles += 4; LDX(cpu._rd(zpy())); };
        cpu.opcodes[0xAE] = () => { cpu.cycles += 4; LDX(cpu._rd(abs())); };
        cpu.opcodes[0xBE] = () => { cpu.cycles += 4; LDX(cpu._rd(abyR())); };

        // -- LDY --
        function LDY(v) { cpu.y = cpu._nz(v); }
        cpu.opcodes[0xA0] = () => { cpu.cycles += 2; LDY(cpu._rd(imm())); };
        cpu.opcodes[0xA4] = () => { cpu.cycles += 3; LDY(cpu._rd(zpg())); };
        cpu.opcodes[0xB4] = () => { cpu.cycles += 4; LDY(cpu._rd(zpx())); };
        cpu.opcodes[0xAC] = () => { cpu.cycles += 4; LDY(cpu._rd(abs())); };
        cpu.opcodes[0xBC] = () => { cpu.cycles += 4; LDY(cpu._rd(abxR())); };

        // -- STA --
        cpu.opcodes[0x85] = () => { cpu.cycles += 3; cpu._wr(zpg(), cpu.a); };
        cpu.opcodes[0x95] = () => { cpu.cycles += 4; cpu._wr(zpx(), cpu.a); };
        cpu.opcodes[0x8D] = () => { cpu.cycles += 4; cpu._wr(abs(), cpu.a); };
        cpu.opcodes[0x9D] = () => { cpu.cycles += 5; cpu._wr(abx(), cpu.a); };
        cpu.opcodes[0x99] = () => { cpu.cycles += 5; cpu._wr(aby(), cpu.a); };
        cpu.opcodes[0x81] = () => { cpu.cycles += 6; cpu._wr(izx(), cpu.a); };
        cpu.opcodes[0x91] = () => { cpu.cycles += 6; cpu._wr(izy(), cpu.a); };

        // -- STX --
        cpu.opcodes[0x86] = () => { cpu.cycles += 3; cpu._wr(zpg(), cpu.x); };
        cpu.opcodes[0x96] = () => { cpu.cycles += 4; cpu._wr(zpy(), cpu.x); };
        cpu.opcodes[0x8E] = () => { cpu.cycles += 4; cpu._wr(abs(), cpu.x); };

        // -- STY --
        cpu.opcodes[0x84] = () => { cpu.cycles += 3; cpu._wr(zpg(), cpu.y); };
        cpu.opcodes[0x94] = () => { cpu.cycles += 4; cpu._wr(zpx(), cpu.y); };
        cpu.opcodes[0x8C] = () => { cpu.cycles += 4; cpu._wr(abs(), cpu.y); };

        // -- Transfers --
        cpu.opcodes[0xAA] = () => { cpu.cycles += 2; cpu.x = cpu._nz(cpu.a); };   // TAX
        cpu.opcodes[0xA8] = () => { cpu.cycles += 2; cpu.y = cpu._nz(cpu.a); };   // TAY
        cpu.opcodes[0x8A] = () => { cpu.cycles += 2; cpu.a = cpu._nz(cpu.x); };   // TXA
        cpu.opcodes[0x98] = () => { cpu.cycles += 2; cpu.a = cpu._nz(cpu.y); };   // TYA
        cpu.opcodes[0xBA] = () => { cpu.cycles += 2; cpu.x = cpu._nz(cpu.sp); };  // TSX
        cpu.opcodes[0x9A] = () => { cpu.cycles += 2; cpu.sp = cpu.x; };           // TXS

        // -- ADC --
        function ADC(v) {
            const sum = cpu.a + v + (cpu.fC ? 1 : 0);
            cpu.fC = sum > 0xFF;
            cpu.fV = (~(cpu.a ^ v) & (cpu.a ^ sum) & 0x80) !== 0;
            cpu.a = cpu._nz(sum & 0xFF);
        }
        cpu.opcodes[0x69] = () => { cpu.cycles += 2; ADC(cpu._rd(imm())); };
        cpu.opcodes[0x65] = () => { cpu.cycles += 3; ADC(cpu._rd(zpg())); };
        cpu.opcodes[0x75] = () => { cpu.cycles += 4; ADC(cpu._rd(zpx())); };
        cpu.opcodes[0x6D] = () => { cpu.cycles += 4; ADC(cpu._rd(abs())); };
        cpu.opcodes[0x7D] = () => { cpu.cycles += 4; ADC(cpu._rd(abxR())); };
        cpu.opcodes[0x79] = () => { cpu.cycles += 4; ADC(cpu._rd(abyR())); };
        cpu.opcodes[0x61] = () => { cpu.cycles += 6; ADC(cpu._rd(izx())); };
        cpu.opcodes[0x71] = () => { cpu.cycles += 5; ADC(cpu._rd(izyR())); };

        // -- SBC --
        function SBC(v) { ADC(v ^ 0xFF); }
        cpu.opcodes[0xE9] = () => { cpu.cycles += 2; SBC(cpu._rd(imm())); };
        cpu.opcodes[0xE5] = () => { cpu.cycles += 3; SBC(cpu._rd(zpg())); };
        cpu.opcodes[0xF5] = () => { cpu.cycles += 4; SBC(cpu._rd(zpx())); };
        cpu.opcodes[0xED] = () => { cpu.cycles += 4; SBC(cpu._rd(abs())); };
        cpu.opcodes[0xFD] = () => { cpu.cycles += 4; SBC(cpu._rd(abxR())); };
        cpu.opcodes[0xF9] = () => { cpu.cycles += 4; SBC(cpu._rd(abyR())); };
        cpu.opcodes[0xE1] = () => { cpu.cycles += 6; SBC(cpu._rd(izx())); };
        cpu.opcodes[0xF1] = () => { cpu.cycles += 5; SBC(cpu._rd(izyR())); };

        // -- AND --
        function AND(v) { cpu.a = cpu._nz(cpu.a & v); }
        cpu.opcodes[0x29] = () => { cpu.cycles += 2; AND(cpu._rd(imm())); };
        cpu.opcodes[0x25] = () => { cpu.cycles += 3; AND(cpu._rd(zpg())); };
        cpu.opcodes[0x35] = () => { cpu.cycles += 4; AND(cpu._rd(zpx())); };
        cpu.opcodes[0x2D] = () => { cpu.cycles += 4; AND(cpu._rd(abs())); };
        cpu.opcodes[0x3D] = () => { cpu.cycles += 4; AND(cpu._rd(abxR())); };
        cpu.opcodes[0x39] = () => { cpu.cycles += 4; AND(cpu._rd(abyR())); };
        cpu.opcodes[0x21] = () => { cpu.cycles += 6; AND(cpu._rd(izx())); };
        cpu.opcodes[0x31] = () => { cpu.cycles += 5; AND(cpu._rd(izyR())); };

        // -- ORA --
        function ORA(v) { cpu.a = cpu._nz(cpu.a | v); }
        cpu.opcodes[0x09] = () => { cpu.cycles += 2; ORA(cpu._rd(imm())); };
        cpu.opcodes[0x05] = () => { cpu.cycles += 3; ORA(cpu._rd(zpg())); };
        cpu.opcodes[0x15] = () => { cpu.cycles += 4; ORA(cpu._rd(zpx())); };
        cpu.opcodes[0x0D] = () => { cpu.cycles += 4; ORA(cpu._rd(abs())); };
        cpu.opcodes[0x1D] = () => { cpu.cycles += 4; ORA(cpu._rd(abxR())); };
        cpu.opcodes[0x19] = () => { cpu.cycles += 4; ORA(cpu._rd(abyR())); };
        cpu.opcodes[0x01] = () => { cpu.cycles += 6; ORA(cpu._rd(izx())); };
        cpu.opcodes[0x11] = () => { cpu.cycles += 5; ORA(cpu._rd(izyR())); };

        // -- EOR --
        function EOR(v) { cpu.a = cpu._nz(cpu.a ^ v); }
        cpu.opcodes[0x49] = () => { cpu.cycles += 2; EOR(cpu._rd(imm())); };
        cpu.opcodes[0x45] = () => { cpu.cycles += 3; EOR(cpu._rd(zpg())); };
        cpu.opcodes[0x55] = () => { cpu.cycles += 4; EOR(cpu._rd(zpx())); };
        cpu.opcodes[0x4D] = () => { cpu.cycles += 4; EOR(cpu._rd(abs())); };
        cpu.opcodes[0x5D] = () => { cpu.cycles += 4; EOR(cpu._rd(abxR())); };
        cpu.opcodes[0x59] = () => { cpu.cycles += 4; EOR(cpu._rd(abyR())); };
        cpu.opcodes[0x41] = () => { cpu.cycles += 6; EOR(cpu._rd(izx())); };
        cpu.opcodes[0x51] = () => { cpu.cycles += 5; EOR(cpu._rd(izyR())); };

        // -- BIT --
        function BIT(v) {
            cpu.fN = (v & 0x80) !== 0;
            cpu.fV = (v & 0x40) !== 0;
            cpu.fZ = (cpu.a & v) === 0;
        }
        cpu.opcodes[0x24] = () => { cpu.cycles += 3; BIT(cpu._rd(zpg())); };
        cpu.opcodes[0x2C] = () => { cpu.cycles += 4; BIT(cpu._rd(abs())); };

        // -- CMP --
        function CMP(reg, v) {
            const diff = reg - v;
            cpu.fC = reg >= v;
            cpu._nz(diff & 0xFF);
        }
        cpu.opcodes[0xC9] = () => { cpu.cycles += 2; CMP(cpu.a, cpu._rd(imm())); };
        cpu.opcodes[0xC5] = () => { cpu.cycles += 3; CMP(cpu.a, cpu._rd(zpg())); };
        cpu.opcodes[0xD5] = () => { cpu.cycles += 4; CMP(cpu.a, cpu._rd(zpx())); };
        cpu.opcodes[0xCD] = () => { cpu.cycles += 4; CMP(cpu.a, cpu._rd(abs())); };
        cpu.opcodes[0xDD] = () => { cpu.cycles += 4; CMP(cpu.a, cpu._rd(abxR())); };
        cpu.opcodes[0xD9] = () => { cpu.cycles += 4; CMP(cpu.a, cpu._rd(abyR())); };
        cpu.opcodes[0xC1] = () => { cpu.cycles += 6; CMP(cpu.a, cpu._rd(izx())); };
        cpu.opcodes[0xD1] = () => { cpu.cycles += 5; CMP(cpu.a, cpu._rd(izyR())); };

        // -- CPX --
        cpu.opcodes[0xE0] = () => { cpu.cycles += 2; CMP(cpu.x, cpu._rd(imm())); };
        cpu.opcodes[0xE4] = () => { cpu.cycles += 3; CMP(cpu.x, cpu._rd(zpg())); };
        cpu.opcodes[0xEC] = () => { cpu.cycles += 4; CMP(cpu.x, cpu._rd(abs())); };

        // -- CPY --
        cpu.opcodes[0xC0] = () => { cpu.cycles += 2; CMP(cpu.y, cpu._rd(imm())); };
        cpu.opcodes[0xC4] = () => { cpu.cycles += 3; CMP(cpu.y, cpu._rd(zpg())); };
        cpu.opcodes[0xCC] = () => { cpu.cycles += 4; CMP(cpu.y, cpu._rd(abs())); };

        // -- ASL --
        function ASL_A() { cpu.fC = (cpu.a & 0x80) !== 0; cpu.a = cpu._nz((cpu.a << 1) & 0xFF); }
        function ASL_M(addr) { let v = cpu._rd(addr); cpu.fC = (v & 0x80) !== 0; v = (v << 1) & 0xFF; cpu._nz(v); cpu._wr(addr, v); return v; }
        cpu.opcodes[0x0A] = () => { cpu.cycles += 2; ASL_A(); };
        cpu.opcodes[0x06] = () => { cpu.cycles += 5; ASL_M(zpg()); };
        cpu.opcodes[0x16] = () => { cpu.cycles += 6; ASL_M(zpx()); };
        cpu.opcodes[0x0E] = () => { cpu.cycles += 6; ASL_M(abs()); };
        cpu.opcodes[0x1E] = () => { cpu.cycles += 7; ASL_M(abx()); };

        // -- LSR --
        function LSR_A() { cpu.fC = (cpu.a & 0x01) !== 0; cpu.a = cpu._nz(cpu.a >> 1); }
        function LSR_M(addr) { let v = cpu._rd(addr); cpu.fC = (v & 0x01) !== 0; v = v >> 1; cpu._nz(v); cpu._wr(addr, v); return v; }
        cpu.opcodes[0x4A] = () => { cpu.cycles += 2; LSR_A(); };
        cpu.opcodes[0x46] = () => { cpu.cycles += 5; LSR_M(zpg()); };
        cpu.opcodes[0x56] = () => { cpu.cycles += 6; LSR_M(zpx()); };
        cpu.opcodes[0x4E] = () => { cpu.cycles += 6; LSR_M(abs()); };
        cpu.opcodes[0x5E] = () => { cpu.cycles += 7; LSR_M(abx()); };

        // -- ROL --
        function ROL_A() {
            const c = cpu.fC ? 1 : 0;
            cpu.fC = (cpu.a & 0x80) !== 0;
            cpu.a = cpu._nz(((cpu.a << 1) | c) & 0xFF);
        }
        function ROL_M(addr) {
            let v = cpu._rd(addr);
            const c = cpu.fC ? 1 : 0;
            cpu.fC = (v & 0x80) !== 0;
            v = ((v << 1) | c) & 0xFF;
            cpu._nz(v);
            cpu._wr(addr, v);
            return v;
        }
        cpu.opcodes[0x2A] = () => { cpu.cycles += 2; ROL_A(); };
        cpu.opcodes[0x26] = () => { cpu.cycles += 5; ROL_M(zpg()); };
        cpu.opcodes[0x36] = () => { cpu.cycles += 6; ROL_M(zpx()); };
        cpu.opcodes[0x2E] = () => { cpu.cycles += 6; ROL_M(abs()); };
        cpu.opcodes[0x3E] = () => { cpu.cycles += 7; ROL_M(abx()); };

        // -- ROR --
        function ROR_A() {
            const c = cpu.fC ? 0x80 : 0;
            cpu.fC = (cpu.a & 0x01) !== 0;
            cpu.a = cpu._nz((cpu.a >> 1) | c);
        }
        function ROR_M(addr) {
            let v = cpu._rd(addr);
            const c = cpu.fC ? 0x80 : 0;
            cpu.fC = (v & 0x01) !== 0;
            v = (v >> 1) | c;
            cpu._nz(v);
            cpu._wr(addr, v);
            return v;
        }
        cpu.opcodes[0x6A] = () => { cpu.cycles += 2; ROR_A(); };
        cpu.opcodes[0x66] = () => { cpu.cycles += 5; ROR_M(zpg()); };
        cpu.opcodes[0x76] = () => { cpu.cycles += 6; ROR_M(zpx()); };
        cpu.opcodes[0x6E] = () => { cpu.cycles += 6; ROR_M(abs()); };
        cpu.opcodes[0x7E] = () => { cpu.cycles += 7; ROR_M(abx()); };

        // -- INC --
        function INC(addr) { const v = (cpu._rd(addr) + 1) & 0xFF; cpu._nz(v); cpu._wr(addr, v); }
        cpu.opcodes[0xE6] = () => { cpu.cycles += 5; INC(zpg()); };
        cpu.opcodes[0xF6] = () => { cpu.cycles += 6; INC(zpx()); };
        cpu.opcodes[0xEE] = () => { cpu.cycles += 6; INC(abs()); };
        cpu.opcodes[0xFE] = () => { cpu.cycles += 7; INC(abx()); };

        // -- DEC --
        function DEC(addr) { const v = (cpu._rd(addr) - 1) & 0xFF; cpu._nz(v); cpu._wr(addr, v); }
        cpu.opcodes[0xC6] = () => { cpu.cycles += 5; DEC(zpg()); };
        cpu.opcodes[0xD6] = () => { cpu.cycles += 6; DEC(zpx()); };
        cpu.opcodes[0xCE] = () => { cpu.cycles += 6; DEC(abs()); };
        cpu.opcodes[0xDE] = () => { cpu.cycles += 7; DEC(abx()); };

        // -- INX, INY, DEX, DEY --
        cpu.opcodes[0xE8] = () => { cpu.cycles += 2; cpu.x = cpu._nz((cpu.x + 1) & 0xFF); };
        cpu.opcodes[0xC8] = () => { cpu.cycles += 2; cpu.y = cpu._nz((cpu.y + 1) & 0xFF); };
        cpu.opcodes[0xCA] = () => { cpu.cycles += 2; cpu.x = cpu._nz((cpu.x - 1) & 0xFF); };
        cpu.opcodes[0x88] = () => { cpu.cycles += 2; cpu.y = cpu._nz((cpu.y - 1) & 0xFF); };

        // -- Branches --
        function branch(cond) {
            const offset = cpu._rd(cpu.pc++);
            if (cond) {
                cpu.cycles++;
                const oldPC = cpu.pc;
                cpu.pc = (cpu.pc + ((offset & 0x80) ? offset - 256 : offset)) & 0xFFFF;
                if ((oldPC ^ cpu.pc) & 0xFF00) cpu.cycles++; // page cross
            }
        }
        cpu.opcodes[0x10] = () => { cpu.cycles += 2; branch(!cpu.fN); };  // BPL
        cpu.opcodes[0x30] = () => { cpu.cycles += 2; branch(cpu.fN); };   // BMI
        cpu.opcodes[0x50] = () => { cpu.cycles += 2; branch(!cpu.fV); };  // BVC
        cpu.opcodes[0x70] = () => { cpu.cycles += 2; branch(cpu.fV); };   // BVS
        cpu.opcodes[0x90] = () => { cpu.cycles += 2; branch(!cpu.fC); };  // BCC
        cpu.opcodes[0xB0] = () => { cpu.cycles += 2; branch(cpu.fC); };   // BCS
        cpu.opcodes[0xD0] = () => { cpu.cycles += 2; branch(!cpu.fZ); };  // BNE
        cpu.opcodes[0xF0] = () => { cpu.cycles += 2; branch(cpu.fZ); };   // BEQ

        // -- JMP --
        cpu.opcodes[0x4C] = () => { cpu.cycles += 3; cpu.pc = abs(); };
        cpu.opcodes[0x6C] = () => { // JMP indirect (with page-boundary bug)
            cpu.cycles += 5;
            const ptr = cpu._rd16(cpu.pc); cpu.pc += 2;
            cpu.pc = cpu._rd16bug(ptr);
        };

        // -- JSR --
        cpu.opcodes[0x20] = () => {
            cpu.cycles += 6;
            const target = cpu._rd16(cpu.pc); cpu.pc += 2;
            const ret = (cpu.pc - 1) & 0xFFFF;
            cpu._push(ret >> 8);
            cpu._push(ret & 0xFF);
            cpu.pc = target;
        };

        // -- RTS --
        cpu.opcodes[0x60] = () => {
            cpu.cycles += 6;
            const lo = cpu._pull();
            const hi = cpu._pull();
            cpu.pc = ((hi << 8) | lo) + 1;
        };

        // -- RTI --
        cpu.opcodes[0x40] = () => {
            cpu.cycles += 6;
            cpu.setP(cpu._pull());
            const lo = cpu._pull();
            const hi = cpu._pull();
            cpu.pc = (hi << 8) | lo;
        };

        // -- BRK --
        cpu.opcodes[0x00] = () => {
            cpu.cycles += 7;
            cpu.pc++;
            cpu._push(cpu.pc >> 8);
            cpu._push(cpu.pc & 0xFF);
            cpu._push(cpu.getP() | 0x10); // B flag set
            cpu.fI = true;
            cpu.pc = cpu._rd16(0xFFFE);
        };

        // -- Stack --
        cpu.opcodes[0x48] = () => { cpu.cycles += 3; cpu._push(cpu.a); };          // PHA
        cpu.opcodes[0x08] = () => { cpu.cycles += 3; cpu._push(cpu.getP() | 0x10); }; // PHP (B flag set)
        cpu.opcodes[0x68] = () => { cpu.cycles += 4; cpu.a = cpu._nz(cpu._pull()); }; // PLA
        cpu.opcodes[0x28] = () => { cpu.cycles += 4; cpu.setP(cpu._pull()); };      // PLP

        // -- Flags --
        cpu.opcodes[0x18] = () => { cpu.cycles += 2; cpu.fC = false; }; // CLC
        cpu.opcodes[0x38] = () => { cpu.cycles += 2; cpu.fC = true; };  // SEC
        cpu.opcodes[0x58] = () => { cpu.cycles += 2; cpu.fI = false; }; // CLI
        cpu.opcodes[0x78] = () => { cpu.cycles += 2; cpu.fI = true; };  // SEI
        cpu.opcodes[0xD8] = () => { cpu.cycles += 2; cpu.fD = false; }; // CLD
        cpu.opcodes[0xF8] = () => { cpu.cycles += 2; cpu.fD = true; };  // SED
        cpu.opcodes[0xB8] = () => { cpu.cycles += 2; cpu.fV = false; }; // CLV

        // -- NOP --
        cpu.opcodes[0xEA] = () => { cpu.cycles += 2; };

        // ════════════════════════════════════════════════════════════
        // UNOFFICIAL OPCODES (commonly used by NSF files)
        // ════════════════════════════════════════════════════════════

        // -- LAX: LDA + LDX simultaneously --
        function LAX(v) { cpu.a = cpu.x = cpu._nz(v); }
        cpu.opcodes[0xA7] = () => { cpu.cycles += 3; LAX(cpu._rd(zpg())); };
        cpu.opcodes[0xB7] = () => { cpu.cycles += 4; LAX(cpu._rd(zpy())); };
        cpu.opcodes[0xAF] = () => { cpu.cycles += 4; LAX(cpu._rd(abs())); };
        cpu.opcodes[0xBF] = () => { cpu.cycles += 4; LAX(cpu._rd(abyR())); };
        cpu.opcodes[0xA3] = () => { cpu.cycles += 6; LAX(cpu._rd(izx())); };
        cpu.opcodes[0xB3] = () => { cpu.cycles += 5; LAX(cpu._rd(izyR())); };

        // -- SAX: Store A & X --
        function SAX(addr) { cpu._wr(addr, cpu.a & cpu.x); }
        cpu.opcodes[0x87] = () => { cpu.cycles += 3; SAX(zpg()); };
        cpu.opcodes[0x97] = () => { cpu.cycles += 4; SAX(zpy()); };
        cpu.opcodes[0x8F] = () => { cpu.cycles += 4; SAX(abs()); };
        cpu.opcodes[0x83] = () => { cpu.cycles += 6; SAX(izx()); };

        // -- DCP: DEC + CMP --
        function DCP(addr) {
            const v = (cpu._rd(addr) - 1) & 0xFF;
            cpu._wr(addr, v);
            CMP(cpu.a, v);
        }
        cpu.opcodes[0xC7] = () => { cpu.cycles += 5; DCP(zpg()); };
        cpu.opcodes[0xD7] = () => { cpu.cycles += 6; DCP(zpx()); };
        cpu.opcodes[0xCF] = () => { cpu.cycles += 6; DCP(abs()); };
        cpu.opcodes[0xDF] = () => { cpu.cycles += 7; DCP(abx()); };
        cpu.opcodes[0xDB] = () => { cpu.cycles += 7; DCP(aby()); };
        cpu.opcodes[0xC3] = () => { cpu.cycles += 8; DCP(izx()); };
        cpu.opcodes[0xD3] = () => { cpu.cycles += 8; DCP(izy()); };

        // -- ISB (ISC): INC + SBC --
        function ISB(addr) {
            const v = (cpu._rd(addr) + 1) & 0xFF;
            cpu._wr(addr, v);
            SBC(v);
        }
        cpu.opcodes[0xE7] = () => { cpu.cycles += 5; ISB(zpg()); };
        cpu.opcodes[0xF7] = () => { cpu.cycles += 6; ISB(zpx()); };
        cpu.opcodes[0xEF] = () => { cpu.cycles += 6; ISB(abs()); };
        cpu.opcodes[0xFF] = () => { cpu.cycles += 7; ISB(abx()); };
        cpu.opcodes[0xFB] = () => { cpu.cycles += 7; ISB(aby()); };
        cpu.opcodes[0xE3] = () => { cpu.cycles += 8; ISB(izx()); };
        cpu.opcodes[0xF3] = () => { cpu.cycles += 8; ISB(izy()); };

        // -- SLO: ASL + ORA --
        function SLO(addr) {
            const v = ASL_M(addr);
            cpu.a = cpu._nz(cpu.a | v);
        }
        cpu.opcodes[0x07] = () => { cpu.cycles += 5; SLO(zpg()); };
        cpu.opcodes[0x17] = () => { cpu.cycles += 6; SLO(zpx()); };
        cpu.opcodes[0x0F] = () => { cpu.cycles += 6; SLO(abs()); };
        cpu.opcodes[0x1F] = () => { cpu.cycles += 7; SLO(abx()); };
        cpu.opcodes[0x1B] = () => { cpu.cycles += 7; SLO(aby()); };
        cpu.opcodes[0x03] = () => { cpu.cycles += 8; SLO(izx()); };
        cpu.opcodes[0x13] = () => { cpu.cycles += 8; SLO(izy()); };

        // -- RLA: ROL + AND --
        function RLA(addr) {
            const v = ROL_M(addr);
            cpu.a = cpu._nz(cpu.a & v);
        }
        cpu.opcodes[0x27] = () => { cpu.cycles += 5; RLA(zpg()); };
        cpu.opcodes[0x37] = () => { cpu.cycles += 6; RLA(zpx()); };
        cpu.opcodes[0x2F] = () => { cpu.cycles += 6; RLA(abs()); };
        cpu.opcodes[0x3F] = () => { cpu.cycles += 7; RLA(abx()); };
        cpu.opcodes[0x3B] = () => { cpu.cycles += 7; RLA(aby()); };
        cpu.opcodes[0x23] = () => { cpu.cycles += 8; RLA(izx()); };
        cpu.opcodes[0x33] = () => { cpu.cycles += 8; RLA(izy()); };

        // -- SRE: LSR + EOR --
        function SRE(addr) {
            const v = LSR_M(addr);
            cpu.a = cpu._nz(cpu.a ^ v);
        }
        cpu.opcodes[0x47] = () => { cpu.cycles += 5; SRE(zpg()); };
        cpu.opcodes[0x57] = () => { cpu.cycles += 6; SRE(zpx()); };
        cpu.opcodes[0x4F] = () => { cpu.cycles += 6; SRE(abs()); };
        cpu.opcodes[0x5F] = () => { cpu.cycles += 7; SRE(abx()); };
        cpu.opcodes[0x5B] = () => { cpu.cycles += 7; SRE(aby()); };
        cpu.opcodes[0x43] = () => { cpu.cycles += 8; SRE(izx()); };
        cpu.opcodes[0x53] = () => { cpu.cycles += 8; SRE(izy()); };

        // -- RRA: ROR + ADC --
        function RRA(addr) {
            const v = ROR_M(addr);
            ADC(v);
        }
        cpu.opcodes[0x67] = () => { cpu.cycles += 5; RRA(zpg()); };
        cpu.opcodes[0x77] = () => { cpu.cycles += 6; RRA(zpx()); };
        cpu.opcodes[0x6F] = () => { cpu.cycles += 6; RRA(abs()); };
        cpu.opcodes[0x7F] = () => { cpu.cycles += 7; RRA(abx()); };
        cpu.opcodes[0x7B] = () => { cpu.cycles += 7; RRA(aby()); };
        cpu.opcodes[0x63] = () => { cpu.cycles += 8; RRA(izx()); };
        cpu.opcodes[0x73] = () => { cpu.cycles += 8; RRA(izy()); };

        // -- Unofficial NOPs (various sizes/timings) --
        // 1-byte NOPs
        cpu.opcodes[0x1A] = () => { cpu.cycles += 2; };
        cpu.opcodes[0x3A] = () => { cpu.cycles += 2; };
        cpu.opcodes[0x5A] = () => { cpu.cycles += 2; };
        cpu.opcodes[0x7A] = () => { cpu.cycles += 2; };
        cpu.opcodes[0xDA] = () => { cpu.cycles += 2; };
        cpu.opcodes[0xFA] = () => { cpu.cycles += 2; };
        // 2-byte NOPs (skip one byte)
        cpu.opcodes[0x80] = () => { cpu.cycles += 2; cpu.pc++; };
        cpu.opcodes[0x82] = () => { cpu.cycles += 2; cpu.pc++; };
        cpu.opcodes[0x89] = () => { cpu.cycles += 2; cpu.pc++; };
        cpu.opcodes[0xC2] = () => { cpu.cycles += 2; cpu.pc++; };
        cpu.opcodes[0xE2] = () => { cpu.cycles += 2; cpu.pc++; };
        cpu.opcodes[0x04] = () => { cpu.cycles += 3; cpu.pc++; };
        cpu.opcodes[0x44] = () => { cpu.cycles += 3; cpu.pc++; };
        cpu.opcodes[0x64] = () => { cpu.cycles += 3; cpu.pc++; };
        cpu.opcodes[0x14] = () => { cpu.cycles += 4; cpu.pc++; };
        cpu.opcodes[0x34] = () => { cpu.cycles += 4; cpu.pc++; };
        cpu.opcodes[0x54] = () => { cpu.cycles += 4; cpu.pc++; };
        cpu.opcodes[0x74] = () => { cpu.cycles += 4; cpu.pc++; };
        cpu.opcodes[0xD4] = () => { cpu.cycles += 4; cpu.pc++; };
        cpu.opcodes[0xF4] = () => { cpu.cycles += 4; cpu.pc++; };
        // 3-byte NOPs (skip two bytes)
        cpu.opcodes[0x0C] = () => { cpu.cycles += 4; cpu.pc += 2; };
        cpu.opcodes[0x1C] = () => { cpu.cycles += 4; cpu.pc += 2; };
        cpu.opcodes[0x3C] = () => { cpu.cycles += 4; cpu.pc += 2; };
        cpu.opcodes[0x5C] = () => { cpu.cycles += 4; cpu.pc += 2; };
        cpu.opcodes[0x7C] = () => { cpu.cycles += 4; cpu.pc += 2; };
        cpu.opcodes[0xDC] = () => { cpu.cycles += 4; cpu.pc += 2; };
        cpu.opcodes[0xFC] = () => { cpu.cycles += 4; cpu.pc += 2; };

        // -- Unofficial SBC (duplicate of $E9) --
        cpu.opcodes[0xEB] = () => { cpu.cycles += 2; SBC(cpu._rd(imm())); };
    }
}
