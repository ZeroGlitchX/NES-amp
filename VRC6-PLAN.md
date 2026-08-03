# VRC6 Expansion Audio Implementation Plan

## Goal

Add NSF VRC6 expansion-audio playback without changing native APU output for
files that do not request VRC6. Full support includes two VRC6 pulse channels,
the sawtooth channel, playback lifecycle integration, silence scanning, and
visualizer data.

VRC6 cartridge mapper, IRQ, PRG, and CHR behavior are out of scope. NSF
playback only needs the expansion chip's write-only audio registers.

## Progress

- [x] Slice 1: Expansion capabilities
- [x] Slice 2: Standalone VRC6 synthesizer and unit tests
- [x] Slice 3: Register routing
- [x] Slice 4: Timing and mixing integration
- [x] Slice 5: Playback lifecycle
- [x] Slice 6: Visualizer
- [x] Slice 7: Integration tests
- [x] Slice 8: Compatibility validation and documentation

## Architecture

Implement VRC6 as a standalone synthesizer owned by `APU`. Keeping it separate
avoids incorrectly reusing the native pulse implementation, while ownership by
`APU` lets native and expansion channels participate in the existing
cycle-averaged mixer.

```text
Memory writes
   |-- $4000-$4017 ----> Native APU registers
   `-- VRC6 addresses -> APU.writeExpansionRegister()
                               |
                               `--> VRC6 instance

Every CPU cycle:
  Native APU clock + VRC6 clock -> combined mixer -> sample averaging
```

## File-Level Changes

| File | Change |
| --- | --- |
| `src/vrc6.js` | Add the two-pulse/one-saw synthesizer. |
| `src/nsf-parser.js` | Name expansion flags and expose requested chips. |
| `src/memory.js` | Forward exact VRC6 write addresses without changing PRG-ROM reads. |
| `src/apu.js` | Own, reset, clock, mix, and inspect the optional VRC6. |
| `src/nsf-engine.js` | Configure expansion audio and retain three additional channel histories. |
| `index.htm` | Load the new script and update scanning and visualization. |
| `tests/` | Add zero-dependency Node unit and integration tests. |
| `README.md` | Document VRC6 support and remaining expansion limitations. |

## Implementation Slices

### 1. Expansion Capabilities

- Add named masks for VRC6, VRC7, FDS, MMC5, N163, Sunsoft 5B, and VT02+.
- Preserve the raw NSF expansion byte.
- Expose requested, supported, and unsupported expansion chips from the engine.
- Do not claim VRC6 support until the synthesizer is connected.
- Identify mixed-chip files as partially supported when any requested chip is
  unavailable.

### 2. VRC6 Synthesizer

Add a standalone `VRC6` class with this public surface:

```js
class VRC6 {
    reset()
    writeRegister(address, value)
    clock()
    getOutput()
    getChannelOutputs()
    isChannelActive()
}
```

Implement:

- Pulse 1 at `$9000-$9002`.
- Global frequency control at `$9003`.
- Pulse 2 at `$A000-$A002`.
- Saw at `$B000-$B002`.
- Two 16-step pulse sequencers with eight duty settings and constant mode.
- 12-bit periods, channel enable behavior, and pulse phase reset.
- Saw accumulation every second step and reset after its 14-step sequence.
- `$9003` halt, 16x, and 256x frequency controls.
- Linear raw DAC output from two 4-bit pulses and one 5-bit saw.

### 3. Register Routing

- Add a write-only expansion hook before ROM-area writes are discarded.
- Intercept only exact NSF VRC6 addresses and only when VRC6 is enabled.
- Keep reads at those addresses mapped to PRG ROM.
- Return whether a write was handled so future expansion chips can share the
  hook.

### 4. Timing and Mixing

- Clock VRC6 once per CPU cycle inside `APU.clock()`.
- Combine it before the existing per-cycle sample averaging.
- Leave the native nonlinear pulse and TND lookup tables unchanged.
- Give VRC6 a separate, documented mix-gain constant because its DAC is linear.
- Normalize the combined result before the engine clamp to avoid pre-filter
  clipping.
- Preserve the existing output path exactly when VRC6 is absent.

### 5. Playback Lifecycle

- Reset VRC6 for every track initialization and change.
- Preserve expansion configuration across `APU.reset()`.
- Include expansion channels in `isChannelActive()` for duration scanning.
- Return zero-valued VRC6 channels when the chip is absent.
- Retain the current seek fast-forward behavior initially; it already skips
  native oscillator phase advancement.

### 6. Visualizer

Add latency-compensated history for:

- `vrc6Pulse1`
- `vrc6Pulse2`
- `vrc6Saw`

Use eight visualizer channel levels when VRC6 is present and retain the current
five-channel layout for standard APU files.

### 7. Tests

Unit coverage:

- Register decoding.
- Pulse duty sequences and constant mode.
- Timer periods and enable/disable phase behavior.
- Saw accumulator sequence and wrap.
- `$9003` halt and frequency scaling.
- Reset state and output bounds.

Integration coverage:

- Expansion writes reach VRC6 while reads still return PRG ROM.
- Files without expansion bit 0 cannot trigger VRC6.
- Native APU output is unchanged when VRC6 is absent.
- Akumajou Densetsu produces nonzero VRC6 output.
- Esper Dream 2 and Madara initialize and produce plausible channel activity.
- Track changes and duration scanning reset expansion state.
- Mixed-expansion files report partial support.

### 8. Compatibility and Documentation

- Begin with canonical NSF register addresses.
- Keep an internal `swapAddressLines` option available for legacy VRC6 rips.
- Enable address swapping only if fixture validation demonstrates the need; do
  not infer it from a title.
- Tune and document expansion mix gain against known VRC6 playback.
- Update README feature and architecture descriptions.
- Bump browser script cache versions for changed files.

## Definition of Done

- Standard APU files have no audio regression.
- All three VRC6 channels are audible and visible.
- VRC6 register writes do not disturb PRG-ROM reads.
- Combined output remains bounded without obvious clipping.
- Silence scanning and track switching recognize VRC6 activity.
- The bundled pure-VRC6 soundtracks play correctly.
- Other expansion-chip files are reported as unsupported or partially
  supported.

## Validation Result

- Akumajou Densetsu, Esper Dream 2, and Madara use canonical NSF `x001`/`x002`
  register ordering; no per-file address swap is required for the bundled rips.
- One maximum VRC6 pulse is mapped to the same pre-normalization level as one
  maximum native pulse. Worst-case combined native and VRC6 output is
  normalized before the engine's existing 85% output headroom.
- Headless renders verify finite, bounded PCM, deterministic track reset, and
  three populated VRC6 visualizer histories.
