// Sound packs: instrument presets, drum kits, MIDI loops, chord progressions,
// the default project and the demo song. Pure data — presets only list what
// they override on top of the schema defaults.

import { Note, BAR, STEP16 } from './types'
import { NOTE_NAMES } from './theory'
import { defaultsFor, instSchema } from './audio/schema'
import { ClipJSON, ProjectJSON, DEFAULT_BUSES } from './state/doc'

// ---------- note builders ----------
let nid = 0
const rec = (notes: Note[]): Record<string, Note> => {
  const out: Record<string, Note> = {}
  notes.forEach(n => { out[`n${nid++}`] = n })
  return out
}

/** Drum pattern: 16 chars per bar. x=hit o=soft ?=hit with `prob` chance */
function D(pad: number, pattern: string, vel = 0.9, prob = 0.6): Note[] {
  const out: Note[] = []
  ;[...pattern].forEach((ch, i) => {
    if (ch === '.') return
    out.push({
      p: pad,
      s: i * STEP16,
      d: STEP16,
      v: ch === 'o' ? vel * 0.55 : vel,
      pr: ch === '?' ? prob : 1,
    })
  })
  return out
}

function chord(startStep: number, pitches: number[], durSteps: number, vel = 0.7): Note[] {
  return pitches.map(p => ({ p, s: startStep * STEP16, d: durSteps * STEP16, v: vel, pr: 1 }))
}

function seq(startStep: number, pitches: (number | null)[], stepLen: number, durSteps: number, vel = 0.8): Note[] {
  const out: Note[] = []
  pitches.forEach((p, i) => {
    if (p === null) return
    out.push({ p, s: (startStep + i * stepLen) * STEP16, d: durSteps * STEP16, v: vel, pr: 1 })
  })
  return out
}

const clip = (name: string, color: number, lenBars: number, notes: Note[]): ClipJSON => ({
  name, color, len: lenBars * BAR, notes: rec(notes),
})

const def = (type: string) => defaultsFor(instSchema(type).params)
const preset = (type: string, over: Record<string, number>) => ({ type, params: { ...def(type), ...over } })

// =====================================================================
// INSTRUMENT PRESETS (~50)
// =====================================================================
export type InstPreset = { name: string; cat: string; type: string; params: Record<string, number> }

export const INST_PRESETS: InstPreset[] = [
  // ---- Leads ----
  { name: 'Neon Saw Lead', cat: 'Lead', ...preset('poly', { wave: 0, cutoff: 9000, res: 1.5, attack: 0.005, decay: 0.18, sustain: 0.5, release: 0.3 }) },
  { name: 'Supersaw Anthem', cat: 'Lead', ...preset('poly', { wave: 4, spread: 32, cutoff: 10500, res: 0.8, attack: 0.01, decay: 0.25, sustain: 0.7, release: 0.5 }) },
  { name: 'Soft Square', cat: 'Lead', ...preset('poly', { wave: 1, cutoff: 3200, res: 0.5, attack: 0.02, release: 0.5 }) },
  { name: 'Chip Tune', cat: 'Lead', ...preset('poly', { wave: 1, cutoff: 12000, res: 0, attack: 0.001, decay: 0.06, sustain: 0.35, release: 0.05 }) },
  { name: 'Whistle Sine', cat: 'Lead', ...preset('poly', { wave: 3, cutoff: 14000, attack: 0.03, decay: 0.1, sustain: 0.8, release: 0.25 }) },
  { name: 'Screamer FM', cat: 'Lead', ...preset('fm', { harm: 2, modIdx: 28, attack: 0.004, decay: 0.3, sustain: 0.55, release: 0.3 }) },
  { name: 'Brass Stab', cat: 'Lead', ...preset('poly', { wave: 0, cutoff: 5200, res: 1.2, attack: 0.04, decay: 0.25, sustain: 0.45, release: 0.18 }) },
  { name: 'Acid Lead', cat: 'Lead', ...preset('mono', { wave: 0, cutoff: 1400, res: 8.5, envAmt: 3.2, glide: 0.04, attack: 0.002, decay: 0.14, sustain: 0.3, release: 0.12 }) },
  { name: 'Thick Duo Lead', cat: 'Lead', ...preset('duo', { harm: 1.01, vibAmt: 0.18, vibRate: 5.5, attack: 0.01, decay: 0.2, sustain: 0.65, release: 0.4 }) },
  { name: 'Fat Tri Flute', cat: 'Lead', ...preset('poly', { wave: 6, spread: 14, cutoff: 6000, attack: 0.05, decay: 0.2, sustain: 0.75, release: 0.3 }) },

  // ---- Pads ----
  { name: 'Warm Pad', cat: 'Pad', ...preset('poly', { wave: 2, cutoff: 3800, res: 0.3, attack: 0.6, decay: 0.4, sustain: 0.85, release: 1.8 }) },
  { name: 'Supersaw Wash', cat: 'Pad', ...preset('poly', { wave: 4, spread: 45, cutoff: 2900, res: 0.4, attack: 1.2, decay: 0.5, sustain: 0.9, release: 2.6 }) },
  { name: 'Strings-ish', cat: 'Pad', ...preset('poly', { wave: 0, cutoff: 2600, res: 0.4, attack: 0.4, sustain: 0.8, release: 1.2 }) },
  { name: 'Dark Cellar', cat: 'Pad', ...preset('poly', { wave: 0, cutoff: 900, res: 1.8, attack: 0.9, decay: 0.6, sustain: 0.8, release: 2 }) },
  { name: 'Glass Pad', cat: 'Pad', ...preset('fm', { harm: 2, modIdx: 3.5, attack: 0.8, decay: 0.6, sustain: 0.75, release: 2.2 }) },
  { name: 'Hollow Choir', cat: 'Pad', ...preset('poly', { wave: 5, spread: 22, cutoff: 1800, res: 0.6, attack: 0.7, decay: 0.5, sustain: 0.85, release: 1.6 }) },
  { name: 'Duo Drift', cat: 'Pad', ...preset('duo', { harm: 1.5, vibAmt: 0.25, vibRate: 0.9, attack: 0.9, decay: 0.5, sustain: 0.8, release: 2.4 }) },
  { name: 'Drone Floor', cat: 'Pad', ...preset('poly', { wave: 2, cutoff: 600, res: 2.5, attack: 1.6, decay: 1, sustain: 1, release: 3.5 }) },

  // ---- Keys ----
  { name: 'Dream Keys', cat: 'Keys', ...preset('keys', { harm: 2, attack: 0.01, decay: 0.5, sustain: 0.45, release: 0.9 }) },
  { name: 'EP Glow', cat: 'Keys', ...preset('keys', { harm: 1, attack: 0.005, decay: 0.7, sustain: 0.3, release: 0.6 }) },
  { name: 'FM Keys', cat: 'Keys', ...preset('fm', { harm: 1, modIdx: 6, attack: 0.004, decay: 0.5, sustain: 0.35, release: 0.5 }) },
  { name: 'Soft Piano', cat: 'Keys', ...preset('poly', { wave: 0, cutoff: 4200, res: 0.4, attack: 0.002, decay: 1.1, sustain: 0.18, release: 0.35 }) },
  { name: 'House Stab Piano', cat: 'Keys', ...preset('poly', { wave: 0, cutoff: 4800, res: 0.9, attack: 0.002, decay: 0.4, sustain: 0.15, release: 0.25 }) },
  { name: 'Clav Funk', cat: 'Keys', ...preset('poly', { wave: 1, cutoff: 3000, res: 2.2, attack: 0.001, decay: 0.2, sustain: 0.1, release: 0.1 }) },
  { name: 'Organ Duo', cat: 'Keys', ...preset('duo', { harm: 2, vibAmt: 0.08, vibRate: 6.5, attack: 0.004, decay: 0.1, sustain: 0.95, release: 0.12 }) },
  { name: 'Toy Celesta', cat: 'Keys', ...preset('fm', { harm: 4, modIdx: 9, attack: 0.001, decay: 0.5, sustain: 0.05, release: 0.7 }) },
  { name: 'Lo-fi Tape Keys', cat: 'Keys', ...preset('keys', { harm: 2.5, attack: 0.02, decay: 0.6, sustain: 0.25, release: 0.5 }) },

  // ---- Bass ----
  { name: 'Sub Bass', cat: 'Bass', ...preset('mono', { wave: 3, cutoff: 520, res: 0.5, envAmt: 1.2, glide: 0.01, attack: 0.004, decay: 0.25, sustain: 0.7, release: 0.2 }) },
  { name: '808 Slide Sub', cat: 'Bass', ...preset('mono', { wave: 3, cutoff: 400, res: 0.3, envAmt: 0.8, glide: 0.09, attack: 0.003, decay: 0.4, sustain: 0.85, release: 0.45 }) },
  { name: 'Acid 303', cat: 'Bass', ...preset('mono', { wave: 0, cutoff: 700, res: 7.5, envAmt: 3.6, glide: 0.06, attack: 0.003, decay: 0.18, sustain: 0.2, release: 0.15 }) },
  { name: 'Square Hollow', cat: 'Bass', ...preset('mono', { wave: 1, cutoff: 1000, res: 1.5, envAmt: 2, attack: 0.004, decay: 0.3, sustain: 0.5, release: 0.2 }) },
  { name: 'Moog-ish Punch', cat: 'Bass', ...preset('mono', { wave: 2, cutoff: 850, res: 2.8, envAmt: 2.6, glide: 0, attack: 0.002, decay: 0.22, sustain: 0.4, release: 0.18 }) },
  { name: 'Reese Duo', cat: 'Bass', ...preset('duo', { harm: 0.5, vibAmt: 0.05, vibRate: 1.2, attack: 0.01, decay: 0.3, sustain: 0.85, release: 0.3 }) },
  { name: 'FM Growl', cat: 'Bass', ...preset('fm', { harm: 0.5, modIdx: 14, attack: 0.004, decay: 0.25, sustain: 0.5, release: 0.2 }) },
  { name: 'Donk', cat: 'Bass', ...preset('fm', { harm: 1, modIdx: 22, attack: 0.001, decay: 0.16, sustain: 0, release: 0.12 }) },
  { name: 'Picked Bass', cat: 'Bass', ...preset('pluck', { dampen: 1900, res: 0.96 }) },
  { name: 'Knock Bass', cat: 'Bass', ...preset('mono', { wave: 0, cutoff: 450, res: 4, envAmt: 3, attack: 0.001, decay: 0.12, sustain: 0.25, release: 0.1 }) },

  // ---- Plucks & Bells ----
  { name: 'Classic Pluck', cat: 'Pluck', ...preset('pluck', {}) },
  { name: 'Koto-ish', cat: 'Pluck', ...preset('pluck', { dampen: 7000, res: 0.9 }) },
  { name: 'Kalimba', cat: 'Pluck', ...preset('pluck', { dampen: 9500, res: 0.82 }) },
  { name: 'Nylon Ghost', cat: 'Pluck', ...preset('pluck', { dampen: 3000, res: 0.95 }) },
  { name: 'Glass Bell', cat: 'Bell', ...preset('fm', { harm: 3.5, modIdx: 18, attack: 0.003, decay: 0.8, sustain: 0.1, release: 1.2 }) },
  { name: 'Marimba', cat: 'Bell', ...preset('fm', { harm: 1, modIdx: 4, attack: 0.001, decay: 0.3, sustain: 0, release: 0.4 }) },
  { name: 'Steel Pan', cat: 'Bell', ...preset('fm', { harm: 2.5, modIdx: 8, attack: 0.002, decay: 0.45, sustain: 0.05, release: 0.6 }) },
  { name: 'Gamelan', cat: 'Bell', ...preset('fm', { harm: 5.1, modIdx: 12, attack: 0.001, decay: 1.1, sustain: 0, release: 1.6 }) },
  { name: 'Music Box', cat: 'Bell', ...preset('fm', { harm: 4, modIdx: 6, attack: 0.001, decay: 0.7, sustain: 0, release: 1 }) },
  { name: 'Tubular Hit', cat: 'Bell', ...preset('fm', { harm: 3, modIdx: 15, attack: 0.002, decay: 1.6, sustain: 0, release: 2 }) },
]

// =====================================================================
// DRUM KITS (12)
// =====================================================================
export type DrumKit = { name: string; params: Record<string, number> }
const kit = (over: Record<string, number>) => ({ ...def('drum'), ...over })

export const DRUM_KITS: DrumKit[] = [
  { name: '808 Boom', params: kit({ p0_decay: 0.8, p0_tune: -2, p3_decay: 0.05, p4_decay: 0.35, p1_decay: 0.2 }) },
  { name: 'Trap 808 Long', params: kit({ p0_decay: 1.4, p0_tune: -4, p1_decay: 0.16, p1_tune: 3, p2_decay: 0.22, p3_decay: 0.035, p4_decay: 0.3, p6_decay: 0.08, p6_tune: 7 }) },
  { name: 'Tight 909', params: kit({ p0_decay: 0.3, p0_tune: 1, p1_decay: 0.15, p1_tune: 2, p3_decay: 0.06, p4_decay: 0.5 }) },
  { name: 'Techno Bunker', params: kit({ p0_decay: 0.26, p0_tune: 2, p1_decay: 0.12, p1_tune: -1, p3_decay: 0.04, p4_decay: 0.22, p6_decay: 0.1, p6_tune: 5, p7_decay: 0.9, p7_level: -6 }) },
  { name: 'Lo-Fi Dust', params: kit({ p0_decay: 0.35, p0_tune: -4, p3_decay: 0.04, p4_decay: 0.25, p1_decay: 0.14, p7_level: -8, p2_tune: -3 }) },
  { name: 'Pop Punch', params: kit({ p0_decay: 0.45, p1_decay: 0.22, p1_tune: 2, p2_decay: 0.3, p3_decay: 0.07 }) },
  { name: 'Breaks Funk', params: kit({ p0_decay: 0.3, p0_tune: 1, p1_decay: 0.24, p1_tune: -2, p3_decay: 0.05, p4_decay: 0.4, p5_decay: 0.25, p5_tune: 3 }) },
  { name: 'Garage 2-Step', params: kit({ p0_decay: 0.28, p1_decay: 0.15, p1_tune: 4, p2_decay: 0.25, p2_tune: 2, p3_decay: 0.045, p4_decay: 0.3 }) },
  { name: 'Disco Heat', params: kit({ p0_decay: 0.4, p1_decay: 0.2, p2_decay: 0.34, p3_decay: 0.06, p4_decay: 0.55, p4_level: 2, p7_decay: 1.6 }) },
  { name: 'Dub Foundation', params: kit({ p0_decay: 0.6, p0_tune: -5, p1_decay: 0.3, p1_tune: -3, p3_decay: 0.05, p4_decay: 0.3, p6_decay: 0.2, p6_tune: -2 }) },
  { name: 'Ambient Glass', params: kit({ p0_decay: 0.5, p0_tune: -1, p0_level: -6, p1_decay: 0.4, p1_level: -8, p2_decay: 0.5, p2_level: -6, p3_decay: 0.08, p3_level: -8, p4_decay: 0.8, p4_level: -8, p6_decay: 0.4, p6_tune: 9, p7_decay: 2, p7_level: -10 }) },
  { name: 'Minimal Tick', params: kit({ p0_decay: 0.22, p0_tune: 3, p1_decay: 0.08, p1_tune: 5, p2_decay: 0.1, p3_decay: 0.025, p4_decay: 0.12, p6_decay: 0.05, p6_tune: 12, p7_level: -14 }) },
]

// =====================================================================
// MIDI LOOPS (~40)
// =====================================================================
export type MidiLoop = { name: string; cat: 'Drums' | 'Bass' | 'Chords' | 'Melody' | 'Arps'; forDrums?: boolean; clip: ClipJSON }

// pitch shorthand (A minor-friendly palette around A)
const E1 = 28, F1 = 29, G1 = 31, A1 = 33, B1 = 35, C2 = 36, D2 = 38, E2 = 40, F2 = 41, G2 = 43, A2 = 45
const A3 = 57, B3 = 59, C4 = 60, D4 = 62, E4 = 64, F4 = 65, G4 = 67, A4 = 69, C5 = 72, D5 = 74, E5 = 76, G5 = 79, A5 = 81
const F3 = 53, G3 = 55, E3 = 52

export const MIDI_LOOPS: MidiLoop[] = [
  // ---------------- Drums (12) ----------------
  {
    name: 'Four on the Floor', cat: 'Drums', forDrums: true,
    clip: clip('Four Floor', 0, 1, [
      ...D(0, 'x...x...x...x...'),
      ...D(2, '....x.......x...', 0.85),
      ...D(3, 'x.o.x.o.x.o.x.o.', 0.7),
      ...D(4, '..x...x...x...x.', 0.5),
    ]),
  },
  {
    name: 'Boom Bap', cat: 'Drums', forDrums: true,
    clip: clip('Boom Bap', 1, 1, [
      ...D(0, 'x.....x...x.....'),
      ...D(1, '....x.......x...', 0.9),
      ...D(3, 'x.x.x.x.x.x.x.x.', 0.6),
      ...D(6, '.......x.......o', 0.5),
    ]),
  },
  {
    name: 'Trap Roll', cat: 'Drums', forDrums: true,
    clip: clip('Trap Roll', 2, 2, [
      ...D(0, 'x......x..x.....x.....x...x.....'),
      ...D(2, '....x.......x.......x.......x...', 0.9),
      ...D(3, 'x.x.x.x.x.x.xxxxx.x.x.x.??????xx', 0.65, 0.55),
      ...D(4, '......x...............x........', 0.45),
    ]),
  },
  {
    name: 'House Shuffle', cat: 'Drums', forDrums: true,
    clip: clip('House Shuffle', 5, 1, [
      ...D(0, 'x...x...x...x...'),
      ...D(2, '....x.......x...', 0.8),
      ...D(3, '..x...x...x...x.', 0.75),
      ...D(4, '..x.......x.....', 0.5),
      ...D(6, '.......?.....?..', 0.5, 0.5),
    ]),
  },
  {
    name: 'Halftime', cat: 'Drums', forDrums: true,
    clip: clip('Halftime', 8, 2, [
      ...D(0, 'x.........x.....x.......x.x.....'),
      ...D(1, '........x...............x.......', 0.95),
      ...D(3, 'x...x...x...x...x...x...x...x.x.', 0.55),
      ...D(7, 'x...............................', 0.4),
    ]),
  },
  {
    name: 'Techno Drive', cat: 'Drums', forDrums: true,
    clip: clip('Techno Drive', 9, 1, [
      ...D(0, 'x...x...x...x...', 0.95),
      ...D(4, '..x...x...x...x.', 0.6),
      ...D(3, 'x.xxx.xxx.xxx.xx', 0.4),
      ...D(6, '......x.......?.', 0.55, 0.5),
      ...D(2, '............x...', 0.5),
    ]),
  },
  {
    name: 'Dembow', cat: 'Drums', forDrums: true,
    clip: clip('Dembow', 3, 1, [
      ...D(0, 'x...x...x...x...'),
      ...D(1, '...x..x....x..x.', 0.85),
      ...D(3, 'x.x.x.x.x.x.x.x.', 0.5),
      ...D(6, '...x..x....x..x.', 0.4),
    ]),
  },
  {
    name: 'Breakbeat Chop', cat: 'Drums', forDrums: true,
    clip: clip('Breakbeat', 4, 2, [
      ...D(0, 'x.........x..x..x.........x.....'),
      ...D(1, '....x..o.....o......x..o..o.x...', 0.9),
      ...D(3, 'x.x.x.x.x.x.x.x.x.x.x.x.x.x.x.x.', 0.5),
      ...D(4, '..............x.................', 0.5),
    ]),
  },
  {
    name: 'DnB Roller', cat: 'Drums', forDrums: true,
    clip: clip('DnB Roller', 6, 2, [
      ...D(0, 'x.........x.....x.........x..x..'),
      ...D(1, '....x.......x.......x.....o.x...', 0.9),
      ...D(3, 'x.x.x.x.x.x.x.x.x.x.x.x.x.x.x.x.', 0.45),
      ...D(6, '.......x...............x.......', 0.35),
    ]),
  },
  {
    name: 'Dilla Lean', cat: 'Drums', forDrums: true,
    clip: clip('Dilla Lean', 10, 2, [
      ...D(0, 'x......x..x.....x......x..x...x.'),
      ...D(1, '....x.......x?......x.......x...', 0.85, 0.5),
      ...D(3, 'x..xx..xx..xx..xx..xx..xx..xx..x', 0.5),
      ...D(2, '.............................?..', 0.6, 0.4),
    ]),
  },
  {
    name: 'Disco Hustle', cat: 'Drums', forDrums: true,
    clip: clip('Disco Hustle', 7, 1, [
      ...D(0, 'x...x...x...x...'),
      ...D(1, '....x.......x...', 0.8),
      ...D(4, '..x...x...x...x.', 0.75),
      ...D(3, 'x.o.x.o.x.o.x.o.', 0.55),
      ...D(2, '....x.......x...', 0.45),
    ]),
  },
  {
    name: 'Downtempo Heads', cat: 'Drums', forDrums: true,
    clip: clip('Downtempo', 11, 2, [
      ...D(0, 'x.....x.....x...x......x..x.....', 0.85),
      ...D(1, '........x...............x.......', 0.8),
      ...D(3, '..x...x...x...x...x...x...x...x.', 0.45),
      ...D(7, '................x...............', 0.3),
      ...D(6, '..........?...........?........', 0.5, 0.4),
    ]),
  },

  // ---------------- Bass (10) ----------------
  {
    name: 'Octave Pump', cat: 'Bass',
    clip: clip('Octave Pump', 6, 4, [
      ...seq(0, [A1, A2, A1, A2, A1, A2, A1, A2], 2, 2, 0.85),
      ...seq(16, [F1, F2, F1, F2, F1, F2, F1, F2], 2, 2, 0.85),
      ...seq(32, [C2, C2 + 12, C2, C2 + 12, C2, C2 + 12, C2, C2 + 12], 2, 2, 0.85),
      ...seq(48, [G1, G2, G1, G2, G1, G2, G1, G2], 2, 2, 0.85),
    ]),
  },
  {
    name: 'Walking 8ths', cat: 'Bass',
    clip: clip('Walking 8ths', 6, 2, [
      ...seq(0, [A1, A1, E2, A1, G1, A1, C2, D2], 2, 2, 0.8),
      ...seq(16, [F1, F1, C2, F1, G1, G1, D2, G1], 2, 2, 0.8),
    ]),
  },
  {
    name: 'Acid Line', cat: 'Bass',
    clip: clip('Acid Line', 9, 1, seq(0, [A1, null, A1, A2, null, A1, G1, null, A1, A1, C2, null, A2, null, G1, E2], 1, 1, 0.85)),
  },
  {
    name: 'Synthwave Drive', cat: 'Bass',
    clip: clip('Synthwave Drive', 8, 2, [
      ...seq(0, [A1, A1, A1, A2, A1, A1, G1, A1], 2, 2, 0.85),
      ...seq(16, [F1, F1, F1, F2, F1, F1, E1, F1], 2, 2, 0.85),
    ]),
  },
  {
    name: 'House Offbeat', cat: 'Bass',
    clip: clip('House Offbeat', 5, 1, seq(2, [A1, null, A1, null, A1, null, A1, G1], 2, 1, 0.85)),
  },
  {
    name: 'Funk Pocket', cat: 'Bass',
    clip: clip('Funk Pocket', 7, 2, [
      ...seq(0, [A1, null, null, A1, null, A2, null, A1, null, G1, null, null, A1, null, C2, D2], 1, 1, 0.85),
      ...seq(16, [F1, null, null, F1, null, F2, null, E2, null, D2, null, null, C2, null, B1, G1], 1, 1, 0.85),
    ]),
  },
  {
    name: 'Dub Sub', cat: 'Bass',
    clip: clip('Dub Sub', 11, 2, [
      ...seq(0, [A1, null, null, null, null, null, G1, null], 2, 3, 0.9),
      ...seq(16, [F1, null, null, E1, null, null, G1, null], 2, 3, 0.9),
    ]),
  },
  {
    name: '808 Slides', cat: 'Bass',
    clip: clip('808 Slides', 2, 2, [
      { p: A1, s: 0, d: 7 * STEP16, v: 0.95, pr: 1 },
      { p: C2, s: 7 * STEP16, d: 2 * STEP16, v: 0.85, pr: 1 },
      { p: G1, s: 10 * STEP16, d: 6 * STEP16, v: 0.9, pr: 1 },
      { p: A1, s: 16 * STEP16, d: 10 * STEP16, v: 0.95, pr: 1 },
      { p: E2, s: 26 * STEP16, d: 2 * STEP16, v: 0.8, pr: 1 },
      { p: D2, s: 28 * STEP16, d: 4 * STEP16, v: 0.9, pr: 1 },
    ]),
  },
  {
    name: 'Disco Octaves', cat: 'Bass',
    clip: clip('Disco Octaves', 7, 1, seq(0, [A1, A2, G1, G2, A1, A2, C2, C2 + 12, A1, A2, G1, G2, A1, A2, D2, E2], 1, 1, 0.85)),
  },
  {
    name: 'Reese Hold', cat: 'Bass',
    clip: clip('Reese Hold', 10, 2, [
      { p: A1, s: 0, d: 14 * STEP16, v: 0.9, pr: 1 },
      { p: F1, s: 16 * STEP16, d: 10 * STEP16, v: 0.9, pr: 1 },
      { p: G1, s: 27 * STEP16, d: 5 * STEP16, v: 0.85, pr: 1 },
    ]),
  },

  // ---------------- Chords (rhythm patterns) (5) ----------------
  {
    name: 'Pop Cycle (Am F C G)', cat: 'Chords',
    clip: clip('Pop Cycle', 7, 4, [
      ...chord(0, [A3, C4, E4], 16, 0.65),
      ...chord(16, [F3, A3, C4], 16, 0.65),
      ...chord(32, [G3, C4, E4], 16, 0.65),
      ...chord(48, [G3, B3, D4], 16, 0.65),
    ]),
  },
  {
    name: 'RnB 7ths', cat: 'Chords',
    clip: clip('RnB 7ths', 10, 4, [
      ...chord(0, [A3, C4, E4, G4], 14, 0.6),
      ...chord(16, [D4, F4, A4, C5], 14, 0.55),
      ...chord(32, [F3, A3, C4, E4], 14, 0.6),
      ...chord(48, [E3 + 12, G3, B3, D4], 14, 0.55),
    ]),
  },
  {
    name: 'Stab Offbeats', cat: 'Chords',
    clip: clip('Stabs', 4, 1, [
      ...chord(2, [A3, C4, E4], 2, 0.8),
      ...chord(6, [A3, C4, E4], 2, 0.7),
      ...chord(10, [G3, C4, E4], 2, 0.8),
      ...chord(14, [G3, B3, D4], 2, 0.7),
    ]),
  },
  {
    name: 'Neo Soul Drift', cat: 'Chords',
    clip: clip('Neo Soul', 9, 2, [
      ...chord(0, [A3, C4, E4, G4, B3 + 12], 13, 0.55),
      ...chord(14, [G3, B3, D4], 2, 0.45),
      ...chord(16, [D4 - 12, F3, A3, C4, E4], 14, 0.55),
    ]),
  },
  {
    name: 'Trance Pluck 16ths', cat: 'Chords',
    clip: clip('Trance Pluck', 2, 1, [
      ...seq(0, [A3, A3, A3, A3, A3, A3, A3, A3, A3, A3, A3, A3, A3, A3, A3, A3], 1, 1, 0.55),
      ...seq(0, [C4, null, C4, null, C4, null, C4, null, C4, null, C4, null, C4, null, C4, null], 1, 1, 0.5),
      ...seq(0, [E4, null, null, null, E4, null, null, null, E4, null, null, null, E4, null, null, null], 1, 1, 0.55),
    ]),
  },

  // ---------------- Melody (9) ----------------
  {
    name: 'Penta Riff', cat: 'Melody',
    clip: clip('Penta Riff', 3, 2, seq(0, [A4, null, C5, A4, G4, null, E4, G4, A4, null, C5, D5, C5, null, A4, null], 2, 2, 0.8)),
  },
  {
    name: 'Counter Line', cat: 'Melody',
    clip: clip('Counter Line', 11, 2, [
      ...seq(0, [E4, null, null, D4, null, C4, null, null], 2, 3, 0.65),
      ...seq(16, [A3, null, C4, null, D4, null, E4, G4], 2, 3, 0.65),
    ]),
  },
  {
    name: 'Trance Anthem', cat: 'Melody',
    clip: clip('Trance Anthem', 2, 4, [
      ...seq(0, [A4, null, E5, null, D5, C5, D5, null, C5, null, A4, null, G4, null, A4, null], 2, 2, 0.85),
      ...seq(32, [A4, null, E5, null, D5, C5, D5, null, E5, null, G5, null, E5, D5, C5, D5], 2, 2, 0.85),
    ]),
  },
  {
    name: 'Lofi Noodle', cat: 'Melody',
    clip: clip('Lofi Noodle', 10, 2, [
      ...seq(0, [E4, null, G4, null, A4, null, null, G4, null, E4, null, null, D4, null, C4, null], 1, 2, 0.6),
      ...seq(18, [A3, null, C4, D4, null, E4, null, null, G4, null, E4, null, D4, null], 1, 2, 0.55),
      { p: C5, s: 30 * STEP16, d: 2 * STEP16, v: 0.45, pr: 0.6 },
    ]),
  },
  {
    name: 'Blues Lick', cat: 'Melody',
    clip: clip('Blues Lick', 0, 1, seq(0, [A4, C5, D5, 63, E5, null, D5, C5, A4, null, G4, A4, null, null, E4, G4], 1, 1, 0.75)),
  },
  {
    name: 'Eastern Riff', cat: 'Melody',
    clip: clip('Eastern Riff', 1, 2, [
      ...seq(0, [A4, B3 + 13, C5, E5, null, D5, C5, B3 + 13], 2, 2, 0.75),
      ...seq(16, [C5, null, B3 + 13, A4, 68, A4, null, null], 2, 2, 0.7),
    ]),
  },
  {
    name: 'Music Box Air', cat: 'Melody',
    clip: clip('Music Box', 5, 2, [
      ...seq(0, [E5, null, null, C5, null, null, A4, null], 2, 3, 0.55),
      ...seq(16, [D5, null, null, E5, null, G5, null, null], 2, 3, 0.5),
    ]),
  },
  {
    name: 'Acid Squiggle', cat: 'Melody',
    clip: clip('Acid Squiggle', 9, 1, [
      ...seq(0, [A3, A4, G3 + 12, A3, C4, A3, A4, null, A3, D4, A3, A4, C4, null, G3, A3], 1, 1, 0.8),
      { p: A4, s: 7 * STEP16, d: STEP16, v: 0.7, pr: 0.5 },
      { p: E4, s: 13 * STEP16, d: STEP16, v: 0.7, pr: 0.5 },
    ]),
  },
  {
    name: 'Hook 145', cat: 'Melody',
    clip: clip('Hook 145', 6, 2, [
      ...seq(0, [A4, G4, E4, null, G4, A4, null, null], 2, 2, 0.8),
      ...seq(16, [C5, A4, G4, null, E4, D4, E4, null], 2, 2, 0.78),
    ]),
  },

  // ---------------- Arps (4) ----------------
  {
    name: 'Arp Up', cat: 'Arps',
    clip: clip('Arp Up', 2, 1, seq(0, [A3, C4, E4, A4, C5, E5, C5, A4, E4, A3, C4, E4, A4, E5, C5, A4], 1, 1, 0.7)),
  },
  {
    name: 'Minor Cascade', cat: 'Arps',
    clip: clip('Minor Cascade', 8, 1, seq(0, [E5, C5, A4, E4, D5, B3 + 24 - 12, G4, D4, C5, A4, E4, C4, E5, C5, A4, E4], 1, 1, 0.65)),
  },
  {
    name: 'Updown Dream', cat: 'Arps',
    clip: clip('Updown Dream', 5, 2, [
      ...seq(0, [A3, E4, A4, C5, E5, C5, A4, E4, A3, E4, A4, C5, E5, C5, A4, E4], 1, 1, 0.6),
      ...seq(16, [F3, C4, F4, A4, C5, A4, F4, C4, G3, D4, G4, B3 + 12, D5, B3 + 12, G4, D4], 1, 1, 0.6),
    ]),
  },
  {
    name: 'Broken Ninth', cat: 'Arps',
    clip: clip('Broken Ninth', 10, 2, [
      ...seq(0, [A3, C4, E4, G4, B3 + 12, G4, E4, C4], 2, 2, 0.65),
      ...seq(16, [F3, A3, C4, E4, G4, E4, C4, A3], 2, 2, 0.65),
    ]),
  },
]

// =====================================================================
// KEY-AWARE LOADING — melodic loops are authored in A; when loaded they
// transpose to the project key by the smallest interval (±6 semitones max,
// so basslines stay basslines instead of jumping an octave).
// =====================================================================
const AUTHORED_ROOT = 9 // A

export function keyDelta(rootPc: number) {
  return ((rootPc - AUTHORED_ROOT) % 12 + 18) % 12 - 6
}

export function clipInKey(c: ClipJSON, rootPc: number): ClipJSON {
  const d = keyDelta(rootPc)
  if (d === 0) return c
  const notes: Record<string, Note> = {}
  for (const [id, n] of Object.entries(c.notes)) {
    notes[id] = { ...n, p: Math.min(127, Math.max(0, n.p + d)) }
  }
  return { ...c, name: `${c.name} (${NOTE_NAMES[rootPc]})`, notes }
}

// =====================================================================
// CHORD PROGRESSIONS — generated into the project's key at load time
// =====================================================================
const CHORD_TYPES: Record<string, number[]> = {
  maj: [0, 4, 7], min: [0, 3, 7], dim: [0, 3, 6],
  sus2: [0, 2, 7], sus4: [0, 5, 7],
  maj7: [0, 4, 7, 11], min7: [0, 3, 7, 10], dom7: [0, 4, 7, 10],
  maj9: [0, 4, 7, 11, 14], min9: [0, 3, 7, 10, 14], dom9: [0, 4, 7, 10, 14],
  m7b5: [0, 3, 6, 10], add9: [0, 4, 7, 14], six: [0, 4, 7, 9], m6: [0, 3, 7, 9],
}

export type ProgChord = { off: number; type: keyof typeof CHORD_TYPES; bars?: number }
export type Progression = { name: string; numerals: string; mode: 'major' | 'minor'; color: number; chords: ProgChord[] }

export const PROGRESSIONS: Progression[] = [
  { name: 'Axis Pop', numerals: 'I–V–vi–IV', mode: 'major', color: 4, chords: [{ off: 0, type: 'maj' }, { off: 7, type: 'maj' }, { off: 9, type: 'min' }, { off: 5, type: 'maj' }] },
  { name: 'Doo-Wop', numerals: 'I–vi–IV–V', mode: 'major', color: 11, chords: [{ off: 0, type: 'maj' }, { off: 9, type: 'min' }, { off: 5, type: 'maj' }, { off: 7, type: 'maj' }] },
  { name: 'Royal Road', numerals: 'IV–V–iii–vi', mode: 'major', color: 10, chords: [{ off: 5, type: 'maj7' }, { off: 7, type: 'dom7' }, { off: 4, type: 'min7' }, { off: 9, type: 'min7' }] },
  { name: 'Jazz Turnaround', numerals: 'ii–V–I–vi', mode: 'major', color: 9, chords: [{ off: 2, type: 'min7' }, { off: 7, type: 'dom7' }, { off: 0, type: 'maj7' }, { off: 9, type: 'min7' }] },
  { name: 'Canon (8 bars)', numerals: 'I–V–vi–iii–IV–I–IV–V', mode: 'major', color: 3, chords: [{ off: 0, type: 'maj' }, { off: 7, type: 'maj' }, { off: 9, type: 'min' }, { off: 4, type: 'min' }, { off: 5, type: 'maj' }, { off: 0, type: 'maj' }, { off: 5, type: 'maj' }, { off: 7, type: 'maj' }] },
  { name: '12-Bar Blues', numerals: 'I7×4 IV7×2 I7×2 V7–IV7–I7–V7', mode: 'major', color: 1, chords: [{ off: 0, type: 'dom7', bars: 4 }, { off: 5, type: 'dom7', bars: 2 }, { off: 0, type: 'dom7', bars: 2 }, { off: 7, type: 'dom7' }, { off: 5, type: 'dom7' }, { off: 0, type: 'dom7' }, { off: 7, type: 'dom7' }] },
  { name: 'Gospel Glow', numerals: 'I–IV–ii–V (7ths)', mode: 'major', color: 2, chords: [{ off: 0, type: 'maj7' }, { off: 5, type: 'maj7' }, { off: 2, type: 'min7' }, { off: 7, type: 'dom9' }] },
  { name: 'Folk Porch', numerals: 'I–IV–I–V', mode: 'major', color: 6, chords: [{ off: 0, type: 'maj' }, { off: 5, type: 'maj' }, { off: 0, type: 'maj' }, { off: 7, type: 'maj' }] },
  { name: 'Dreamy Lift', numerals: 'I–iii–IV–iv', mode: 'major', color: 8, chords: [{ off: 0, type: 'maj7' }, { off: 4, type: 'min7' }, { off: 5, type: 'maj7' }, { off: 5, type: 'm6' }] },
  { name: 'Minor Axis', numerals: 'i–VI–III–VII', mode: 'minor', color: 0, chords: [{ off: 0, type: 'min' }, { off: 8, type: 'maj' }, { off: 3, type: 'maj' }, { off: 10, type: 'maj' }] },
  { name: 'Andalusian', numerals: 'i–VII–VI–V', mode: 'minor', color: 1, chords: [{ off: 0, type: 'min' }, { off: 10, type: 'maj' }, { off: 8, type: 'maj' }, { off: 7, type: 'maj' }] },
  { name: 'Epic Rise', numerals: 'i–VII–VI–VII', mode: 'minor', color: 5, chords: [{ off: 0, type: 'min' }, { off: 10, type: 'maj' }, { off: 8, type: 'maj' }, { off: 10, type: 'maj' }] },
  { name: 'Harmonic Drama', numerals: 'i–iv–V7–i', mode: 'minor', color: 7, chords: [{ off: 0, type: 'min' }, { off: 5, type: 'min' }, { off: 7, type: 'dom7' }, { off: 0, type: 'min' }] },
  { name: 'Soul Vamp', numerals: 'i9–IV7 ×2', mode: 'minor', color: 9, chords: [{ off: 0, type: 'min9' }, { off: 5, type: 'dom7' }, { off: 0, type: 'min9' }, { off: 5, type: 'dom9' }] },
  { name: 'Dark Wave', numerals: 'i–v–VI–iv', mode: 'minor', color: 10, chords: [{ off: 0, type: 'min' }, { off: 7, type: 'min' }, { off: 8, type: 'maj' }, { off: 5, type: 'min' }] },
  { name: 'Sad Ballad', numerals: 'i–VI–III–iv', mode: 'minor', color: 11, chords: [{ off: 0, type: 'min7' }, { off: 8, type: 'maj7' }, { off: 3, type: 'maj7' }, { off: 5, type: 'min7' }] },
]

/** Voice a chord around middle C: root in the octave above C3, plus a bass note. */
export function progressionPitches(rootPc: number, c: ProgChord): number[] {
  let base = 48 + ((rootPc + c.off) % 12)
  while (base < 53) base += 12
  const tones = CHORD_TYPES[c.type].map(iv => base + iv)
  return [base - 12, ...tones]
}

/** Render a progression to a clip in the given key. */
export function progressionClip(prog: Progression, rootPc: number): ClipJSON {
  const notes: Note[] = []
  let bar = 0
  for (const c of prog.chords) {
    const bars = c.bars ?? 1
    const [bass, ...tones] = progressionPitches(rootPc, c)
    notes.push({ p: bass, s: bar * BAR, d: bars * BAR - STEP16 / 2, v: 0.55, pr: 1 })
    tones.forEach(p => notes.push({ p, s: bar * BAR, d: bars * BAR - STEP16 / 2, v: 0.62, pr: 1 }))
    bar += bars
  }
  return clip(`${prog.name} (${NOTE_NAMES[rootPc]})`, prog.color, bar, notes)
}

// =====================================================================
// DEFAULT + DEMO PROJECTS
// =====================================================================

export const DEFAULT_PROJECT: ProjectJSON = {
  meta: { title: 'Untitled Jam', bpm: 120, swing: 0, swingSubdivision: '16n', humanize: 0, root: 9, scale: 'minor', launchQ: 1 },
  tracks: [
    { id: 'tDrums', name: 'Drums', color: 0, kind: 'drum', inst: { type: 'drum', params: DRUM_KITS[0].params }, fx: [{ type: 'comp', on: true, params: { thresh: -18, ratio: 4, attack: 0.01, release: 0.18 } }], gain: 0, pan: 0, mute: false, solo: false },
    { id: 'tBass', name: 'Bass', color: 6, kind: 'synth', inst: { type: 'mono', params: INST_PRESETS.find(p => p.name === 'Sub Bass')!.params }, fx: [], gain: -2, pan: 0, mute: false, solo: false },
    { id: 'tChords', name: 'Chords', color: 8, kind: 'synth', inst: { type: 'poly', params: INST_PRESETS.find(p => p.name === 'Soft Piano')!.params }, fx: [{ type: 'reverb', on: true, params: { size: 2.8, mix: 0.3 } }], gain: -4, pan: 0, mute: false, solo: false },
    { id: 'tLead', name: 'Lead', color: 3, kind: 'synth', inst: { type: 'poly', params: INST_PRESETS.find(p => p.name === 'Neon Saw Lead')!.params }, fx: [{ type: 'delay', on: true, params: { time: 2, fb: 0.35, mix: 0.25 } }], gain: -5, pan: 0, mute: false, solo: false },
    ...DEFAULT_BUSES,
  ],
  scenes: [
    { id: 's1', name: 'Scene 1' }, { id: 's2', name: 'Scene 2' }, { id: 's3', name: 'Scene 3' },
    { id: 's4', name: 'Scene 4' }, { id: 's5', name: 'Scene 5' }, { id: 's6', name: 'Scene 6' },
  ],
  clips: {},
  arr: {},
}

function demoClips(): Record<string, ClipJSON> {
  const drumsA = clip('Groove', 0, 1, [
    ...D(0, 'x...x...x...x...'),
    ...D(2, '....x.......x...', 0.85),
    ...D(3, 'x.o.x.o.x.o.x.o.', 0.7),
    ...D(4, '..........x.....', 0.5),
  ])
  const drumsB = clip('Groove+', 0, 2, [
    ...D(0, 'x...x...x...x...x...x...x..xx...'),
    ...D(2, '....x.......x.......x.......x...', 0.85),
    ...D(3, 'x.??x.??x.??x.??x.??x.??x.??x.??', 0.7, 0.6),
    ...D(4, '..x.......x.......x.......x.....', 0.5),
    ...D(6, '.............?.x.............?.x', 0.5, 0.5),
  ])
  const drumsBreak = clip('Sparse', 8, 2, [
    ...D(0, 'x.........x.....x.......x.......'),
    ...D(2, '........x...............x.......', 0.8),
    ...D(7, 'x...............................', 0.35),
  ])
  const bassA = MIDI_LOOPS.find(l => l.name === 'Octave Pump')!.clip
  const bassB = clip('Bass Drive', 6, 4, [
    ...seq(0, [A1, A1, A2, A1, A1, A2, A1, A2, A1, A1, A2, A1, A1, A2, C2, D2], 1, 1, 0.85),
    ...seq(16, [F1, F1, F2, F1, F1, F2, F1, F2, F1, F1, F2, F1, F1, C2, D2, E2], 1, 1, 0.85),
    ...seq(32, [C2, C2, C2 + 12, C2, C2, C2 + 12, C2, C2 + 12, C2, C2, C2 + 12, C2, C2, C2 + 12, G1, A1], 1, 1, 0.85),
    ...seq(48, [G1, G1, G2, G1, G1, G2, G1, G2, G1, G1, G2, G1, D2, D2, E2, E2], 1, 1, 0.85),
  ])
  const chordsA = MIDI_LOOPS.find(l => l.name === 'Pop Cycle (Am F C G)')!.clip
  const chordsStabs = MIDI_LOOPS.find(l => l.name === 'Stab Offbeats')!.clip
  const leadRiff = MIDI_LOOPS.find(l => l.name === 'Penta Riff')!.clip
  const leadArp = MIDI_LOOPS.find(l => l.name === 'Arp Up')!.clip

  return {
    'tDrums|s2': drumsA,
    'tDrums|s3': { ...drumsB, name: 'Groove+' },
    'tDrums|s4': drumsB,
    'tDrums|s5': drumsBreak,
    'tBass|s2': bassA,
    'tBass|s3': bassA,
    'tBass|s4': bassB,
    'tBass|s6': bassA,
    'tChords|s1': chordsA,
    'tChords|s3': chordsA,
    'tChords|s4': chordsStabs,
    'tChords|s5': chordsA,
    'tChords|s6': chordsA,
    'tLead|s4': leadRiff,
    'tLead|s5': leadArp,
    'tLead|s6': leadArp,
  }
}

export function demoProject(): ProjectJSON {
  const clipsMap = demoClips()
  const arrOut: ProjectJSON['arr'] = {}
  let i = 0
  const place = (key: string, startBar: number, lenBars: number) => {
    const c = clipsMap[key]
    if (!c) return
    arrOut[`a${i++}`] = { ...c, notes: { ...c.notes }, trackId: key.split('|')[0], start: startBar * BAR, len: lenBars * BAR }
  }
  place('tChords|s1', 0, 4)
  place('tDrums|s2', 4, 8)
  place('tBass|s2', 4, 8)
  place('tChords|s3', 8, 4)
  place('tDrums|s4', 12, 8)
  place('tBass|s4', 12, 8)
  place('tChords|s3', 12, 8)
  place('tLead|s4', 14, 6)
  place('tDrums|s5', 20, 4)
  place('tChords|s5', 20, 4)
  place('tLead|s5', 20, 4)
  place('tDrums|s4', 24, 8)
  place('tBass|s4', 24, 8)
  place('tChords|s4', 24, 8)
  place('tLead|s5', 24, 8)

  return {
    meta: { title: 'Neon Alley (demo)', bpm: 112, swing: 0.08, root: 9, scale: 'pentMin', launchQ: 1 },
    tracks: [
      { id: 'tDrums', name: 'Drums', color: 0, kind: 'drum', inst: { type: 'drum', params: DRUM_KITS[0].params }, fx: [{ type: 'comp', on: true, params: { thresh: -18, ratio: 4, attack: 0.01, release: 0.18 } }], gain: 0, pan: 0, mute: false, solo: false },
      { id: 'tBass', name: 'Bass', color: 6, kind: 'synth', inst: { type: 'mono', params: INST_PRESETS.find(p => p.name === 'Sub Bass')!.params }, fx: [{ type: 'dist', on: true, params: { amt: 0.15, mix: 0.5 } }], gain: -2, pan: 0, mute: false, solo: false },
      { id: 'tChords', name: 'Chords', color: 8, kind: 'synth', inst: { type: 'poly', params: INST_PRESETS.find(p => p.name === 'Soft Piano')!.params }, fx: [{ type: 'chorus', on: true, params: { rate: 0.8, depth: 0.5, mix: 0.2 } }, { type: 'reverb', on: true, params: { size: 3.2, mix: 0.32 } }], gain: -5, pan: -0.1, mute: false, solo: false },
      { id: 'tLead', name: 'Lead', color: 3, kind: 'synth', inst: { type: 'pluck', params: INST_PRESETS.find(p => p.name === 'Classic Pluck')!.params }, fx: [{ type: 'delay', on: true, params: { time: 3, fb: 0.45, mix: 0.35 } }, { type: 'reverb', on: true, params: { size: 2.2, mix: 0.25 } }], gain: -3, pan: 0.12, mute: false, solo: false },
      ...DEFAULT_BUSES,
    ],
    scenes: [
      { id: 's1', name: 'Intro' }, { id: 's2', name: 'Beat In' }, { id: 's3', name: 'Groove' },
      { id: 's4', name: 'Full On' }, { id: 's5', name: 'Break' }, { id: 's6', name: 'Outro' },
    ],
    clips: clipsMap,
    arr: arrOut,
  }
}
