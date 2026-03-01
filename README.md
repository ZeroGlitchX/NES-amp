# NES-amp

A Web-based NES chiptune music player that runs entirely in the browser. Loads `.nsf` (Nintendo Sound Format) files and plays them through a cycle-accurate 6502 CPU and APU emulator — no plugins, no backend, no WebAssembly.

![HTML](https://img.shields.io/badge/HTML-single%20page-E34F26)
![JavaScript](https://img.shields.io/badge/JavaScript-vanilla-F7DF1E)
![License](https://img.shields.io/badge/license-MIT-blue)

## Features

- **Full 6502 CPU emulation** — all 151 official opcodes + common unofficial ones
- **Accurate NES APU** — 2 pulse channels, triangle, noise, DMC with proper frame counter timing
- **506-game library** — randomly rotated on each page load, lazy-loaded on click
- **Drag & drop** — load any `.nsf` file directly into the player
- **Silence detection** — automatically scans track durations by running the emulator non-realtime
- **Real-time visualizer** — per-channel spectrum bars driven by actual APU output
- **AudioWorklet pipeline** — low-latency audio with ScriptProcessor fallback
- **Bankswitch support** — handles NSF files with bank-switched PRG ROM
- **Zero dependencies** — single `index.htm` + vanilla JS modules, no build step

## Architecture

```
index.htm              UI, player logic, library browser (single-file app)
src/
  nsf-parser.js        Parses the 128-byte NSF header + PRG ROM data
  cpu6502.js           MOS 6502 CPU — registers, addressing modes, all opcodes
  apu.js               NES APU — pulse, triangle, noise, DMC, frame counter, mixer
  memory.js            NES memory bus — RAM, PRG ROM, bankswitching, APU register I/O
  nsf-engine.js        Ties CPU + APU + Memory together, drives Web Audio output
  audio-worklet.js     AudioWorklet processor — consumes sample buffers from the engine
  games-library.js     506 NSF file entries (auto-generated from NES-Gamemusic directory)
```

### How it works

1. **Parse** — `nsf-parser.js` reads the NSF header to extract init/play addresses, bank config, and metadata
2. **Load** — PRG ROM data is loaded into the memory bus with optional 4KB bank mapping
3. **Init** — The CPU calls the NSF init routine (`JSR initAddress`) with the track number in the A register
4. **Play loop** — At ~60Hz, the CPU calls the play routine (`JSR playAddress`). Between calls, the CPU steps instruction-by-instruction while the APU is clocked cycle-by-cycle
5. **Sample generation** — For each audio sample (~48kHz), the APU mixer combines all channel outputs through the NES non-linear mixing tables
6. **Output** — Samples are posted to an AudioWorklet node (or ScriptProcessor fallback) for playback

## Usage

Serve the project directory with any static HTTP server:

```bash
# Python
python3 -m http.server 8080

# Node
npx serve .

# PHP
php -S localhost:8080
```

Open `http://localhost:8080` in a browser. Click any library card to load and play, or drag & drop a `.nsf` file onto the player.

### NSF files

The player expects NSF files to be available at the paths listed in `src/games-library.js`. The default library assumes a `NES-Gamemusic/` directory structure:

```
NES-Gamemusic/
  Nintendo/          (NES region)
    Capcom/
      Mega_Man_2.nsf
    Nintendo/
      Super_Mario_Bros.nsf
    Konami_Ultra/
      Castlevania.nsf
    ...
  Famicom/           (Famicom region)
    Konami/
      Gradius_II.nsf
    Namco/
      Splatterhouse.nsf
    ...
```

NSF files are not included in this repository. You can source them from various NES music archives online, or just drag & drop individual files.

## Browser support

Requires a modern browser with:
- `AudioContext` / `AudioWorklet` (Chrome 66+, Firefox 76+, Safari 14.1+)
- `DataView`, `Float32Array`
- ES6 classes and arrow functions

Falls back to `ScriptProcessorNode` if AudioWorklet is unavailable.

## Credits

Built with [Claude Code](https://claude.ai/code) by Anthropic.

NSF format documentation: [NES Dev Wiki](https://www.nesdev.org/wiki/NSF).
