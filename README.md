# NES-Amp

A web-based NES chiptune music player that runs entirely in the browser. Loads `.nsf` (Nintendo Sound Format) files and plays them through a cycle-accurate 6502 CPU and APU emulator — no plugins, no backend, no WebAssembly.

![HTML](https://img.shields.io/badge/HTML-single%20page-E34F26)
![JavaScript](https://img.shields.io/badge/JavaScript-vanilla-F7DF1E)
![License](https://img.shields.io/badge/license-MIT-blue)

## Features

- **Full 6502 CPU emulation** — all 151 official opcodes + common unofficial ones
- **Accurate NES APU** — 2 pulse channels, triangle, noise, DMC with proper frame counter timing
- **Complete 506-game discovery library** — searchable by game, publisher, system, or NSF filename and lazy-loaded on click
- **Personalized discovery** — persistent favorites, play counts, recents, Most Played, and randomized “Expand Your Horizons” picks
- **Mobile-first player** — single-screen playback with a slide-in Discover/Favorites/Most Played/Up Next library
- **Portable listening data** — browser-local versioned JSON with one-tap export
- **Drag & drop** — load any `.nsf` file directly into the player
- **Silence detection** — automatically scans track durations by running the emulator non-realtime
- **Improved output tone** — cycle-averaged sample generation + NES-inspired filter chain (HP 37Hz, HP 120Hz, LP 15kHz)
- **Pitch tuning** — slight NTSC clock trim for better playback pitch/speed match
- **Per-channel visualizer** — dedicated color lanes for Pulse 1, Pulse 2, Triangle, Noise, and DPCM
- **A/V sync-compensated visualizer** — channel display is delayed by queued audio + device latency to align with audible output
- **AudioWorklet pipeline** — low-latency audio with ScriptProcessor fallback
- **Bankswitch support** — handles NSF files with bank-switched PRG ROM
- **Zero dependencies** — single `index.htm` + vanilla JS modules, no build step

## Architecture

```
index.htm              UI, player logic, library browser (single-file app)
src/
  cover-art.js         Maps soundtrack titles to confirmed local WebP cover art
  nsf-parser.js        Parses the 128-byte NSF header + PRG ROM data
  cpu6502.js           MOS 6502 CPU — registers, addressing modes, all opcodes
  apu.js               NES APU — pulse, triangle, noise, DMC, frame counter, mixer
  memory.js            NES memory bus — RAM, PRG ROM, bankswitching, APU register I/O
  nsf-engine.js        Ties CPU + APU + Memory together, drives Web Audio output
  audio-worklet.js     AudioWorklet processor — consumes sample buffers from the engine
  games-library.js     506 NSF file entries (auto-generated from NES-Gamemusic directory)
images/nes_box_art/    Optional WebP game covers with generated-art fallback
audits/                Lists unmatched soundtracks and cover-art files
```

### Cover-art naming

Matched NSF and WebP files use the same lowercase kebab-case stem, even though
they live in different directories. For example, `mega-man.nsf` pairs with
`mega-man.webp`. Confirmed pairs are recorded in `src/cover-art.js`.

The unmatched pools are listed in:

- `audits/unmatched-soundtracks.txt`
- `audits/unmatched-cover-art.txt`

### How it works

1. **Parse** — `nsf-parser.js` reads the NSF header to extract init/play addresses, bank config, and metadata
2. **Load** — PRG ROM data is loaded into the memory bus with optional 4KB bank mapping
3. **Init** — The CPU calls the NSF init routine (`JSR initAddress`) with the track number in the A register
4. **Play loop** — At ~60Hz, the CPU calls the play routine (`JSR playAddress`). Between calls, the CPU steps instruction-by-instruction while the APU is clocked cycle-by-cycle
5. **Sample generation** — For each audio sample (~48kHz), the engine averages mixer output across CPU cycles and applies NES non-linear mixing tables
6. **Output** — Samples are posted to an AudioWorklet node (or ScriptProcessor fallback), then passed through the output filter chain
7. **Visualizer sync** — Per-sample channel snapshots are stored and read back with latency compensation for tighter audio/visual alignment

### Current defaults

- **Startup volume:** `50%`
- **Default track time:** `2:30` (used until/during duration scan)

## Usage

Serve the project directory with any static HTTP server:

```bash
# No Need To Run a Framework

Just place the directory in your HTML server root
```

Open `http://localhost/nes-amp/` in a browser. Search or browse Discover to load an album, or drag & drop a `.nsf` file onto the player. On mobile, use **Browse** to open the slide-in library and track queue.

### Listening data

Favorites, play counts, recent albums, and the last selected album are saved as
versioned JSON in browser `localStorage` under `nesamp-listening-v1`. Use
**Export JSON** in the mobile Browse menu to download a portable copy.

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
