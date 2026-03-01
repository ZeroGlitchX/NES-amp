# NSF Player Engine — Implementation Plan

## Context
We have a working frontend UI (NESamp) in `index.htm` with mock data. We need to build the actual NSF playback engine — a 6502 CPU emulator, NES APU sound synthesizer, memory bus with bankswitch support, and NSF file parser — all in pure JavaScript, wired to the UI and outputting real audio via Web Audio API.

## Architecture

```
index.htm (UI)  ←→  nsf-engine.js (orchestrator)
                         ├── nsf-parser.js   (parse .nsf header + PRG data)
                         ├── cpu6502.js      (MOS 6502 CPU emulator)
                         ├── apu.js          (5-channel APU + mixer)
                         └── memory.js       (memory bus + bankswitch)
                              ↓
                    audio-worklet.js (AudioWorklet thread, plays sample buffers)
```

**Audio pipeline**: Engine runs on main thread, generates sample buffers (~2048 samples at a time), posts them via `postMessage` (transferable) to an AudioWorklet that queues and plays them. Falls back to ScriptProcessorNode if AudioWorklet unavailable. No SharedArrayBuffer needed (avoids CORS header requirements).

## Files to Create (all in `src/`)

### 1. `nsf-parser.js` — NSF Header Parser
- Parse 128-byte header: magic (`NESM\x1A`), version, song count, starting song, load/init/play addresses, title/artist/copyright (32-byte strings), NTSC/PAL speed, 8-byte bankswitch init, expansion chip flags
- Extract PRG data from offset `0x80` onward
- Detect bankswitching (any bankswitch init byte non-zero)
- Returns plain object with all metadata + `Uint8Array` PRG data

### 2. `memory.js` — Memory Bus
- 2KB RAM (`$0000-$07FF`, mirrored to `$1FFF`)
- APU register forwarding (`$4000-$4017`)
- Bankswitch registers (`$5FF8-$5FFF` → swap 4KB windows in `$8000-$FFFF`)
- 8KB extra RAM (`$6000-$7FFF`)
- PRG ROM at `$8000-$FFFF` (flat or bankswitched)
- Sentinel self-loop at `$5FFC` (`JMP $5FFC`) for NSF routine return detection

### 3. `cpu6502.js` — MOS 6502 CPU Emulator
- All 151 official opcodes across 13 addressing modes
- Common unofficial opcodes: LAX, SAX, DCP, ISB, SLO, RLA, SRE, RRA, NOP variants
- JMP indirect page-boundary bug
- ADC/SBC with correct overflow/carry (no BCD — NES ignores decimal mode)
- `step()` → execute one instruction, return cycle count
- `jsr(addr)` + `runUntilReturn(maxCycles)` for NSF init/play calls
- Opcode dispatch via 256-entry function table for maintainability

### 4. `apu.js` — NES APU Emulator
**5 channels:**
- **2 Pulse** — duty cycle sequencer (4 waveforms), sweep unit (pulse1: one's complement, pulse2: two's complement), envelope generator, length counter. Mute when period < 8 or sweep target > `$7FF`
- **Triangle** — 32-step sequence, linear counter, timer at CPU rate (not CPU/2)
- **Noise** — 15-bit LFSR (mode 0: 32767-step, mode 1: 93-step), envelope, period lookup table
- **DMC** — 7-bit delta modulation, sample fetch from memory, direct load via `$4011`

**Frame counter:** 4-step (29830 cycles, IRQ) and 5-step (37282 cycles, no IRQ) modes. Quarter-frame → envelopes + triangle linear counter. Half-frame → length counters + sweep units.

**Mixer:** Pre-computed nonlinear lookup tables — `pulseTable[31]` and `tndTable[203]`. Output = `pulseTable[p1+p2] + tndTable[3*tri + 2*noise + dmc]`

### 5. `nsf-engine.js` — NSF Player Controller
**Init sequence per track:** clear RAM → init APU registers → set bankswitch → load song# in A, 0 in X → JSR to init address

**Sample generation:** Fractional cycle accumulator (`1789773 / sampleRate` ≈ 40.585 cycles/sample). Step CPU instruction-by-instruction, clock APU by elapsed cycles, call PLAY routine every `~29781` CPU cycles (from header's ntscSpeed field).

**Public API:** `loadFile(arrayBuffer)`, `play()`, `pause()`, `stop()`, `selectTrack(n)`, `setVolume(v)`, `getElapsedTime()`, `getChannelOutputs()` (for visualizer)

### 6. `audio-worklet.js` — AudioWorklet Processor
- Thin buffer consumer: receives `Float32Array` sample buffers via `postMessage`
- Queues buffers, outputs 128 samples per `process()` call
- Reports queue size for flow control
- Main thread targets keeping 3 buffers queued

## UI Integration (`index.htm` modifications)
- Add `<script>` tags for engine files
- Wire file input + drag-drop to `engine.loadFile()`
- Replace mock `GAMES` array entries with parsed NSF metadata on load
- NSF tracks show as "Track 01", "Track 02", etc. (NSF format has no track names)
- Connect `play/pause/stop/next/prev` to engine methods
- Replace mock timer with `engine.getElapsedTime()`
- Replace random visualizer data with `engine.getChannelOutputs()` (real APU amplitudes)
- Connect volume slider to `engine.setVolume()`
- Default track duration: 2:00 (NSF has no duration info; silence detection optional for v2)

## Implementation Order
1. **nsf-parser.js** — standalone, test with real NSF files
2. **memory.js** — depends on APU stub for register forwarding
3. **cpu6502.js** — largest component; test with known instruction sequences
4. **apu.js** — all 5 channels + frame counter + mixer
5. **nsf-engine.js** + **audio-worklet.js** — wire everything together
6. **index.htm integration** — replace mock data, connect controls

## Scope
- **V1 (this plan):** Standard APU only (no expansion chips), NTSC only
- **Future:** VRC6, VRC7, FDS, MMC5, N163, Sunsoft 5B expansion audio; PAL support; silence detection; NSFE metadata

## Verification
1. Load Super Mario Bros. NSF → verify metadata display (title, artist, 18 tracks)
2. Play track 2 (Overworld) → verify recognizable audio output through speakers
3. Test transport controls: pause/resume, stop, next/prev track, volume
4. Test with several NSFs: Mega Man 2, Castlevania, Zelda (some use bankswitching)
5. Verify visualizer responds to real APU channel amplitudes
6. Test drag-and-drop file loading
