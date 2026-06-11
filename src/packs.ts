// Sound packs: instrument presets, drum kits, MIDI loops, the default project
// and the demo song. Pure data — built on the schema defaults so presets only
// list what they override.

import { Note, BAR, STEP16, CLIP_COLORS } from './types'
import { defaultsFor, instSchema } from './audio/schema'
import { ClipJSON, ProjectJSON } from './state/doc'

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

// ---------- instrument presets ----------
export type InstPreset = { name: string; cat: string; type: string; params: Record<string, number> }

export const INST_PRESETS: InstPreset[] = [
  { name: 'Neon Saw Lead', cat: 'Lead', ...preset('poly', { wave: 0, cutoff: 9000, res: 1.5, attack: 0.005, decay: 0.18, sustain: 0.5, release: 0.3 }) },
  { name: 'Soft Square', cat: 'Lead', ...preset('poly', { wave: 1, cutoff: 3200, res: 0.5, attack: 0.02, release: 0.5 }) },
  { name: 'Glass Bell', cat: 'Lead', ...preset('fm', { harm: 3.5, modIdx: 18, attack: 0.003, decay: 0.8, sustain: 0.1, release: 1.2 }) },
  { name: 'Warm Pad', cat: 'Pad', ...preset('poly', { wave: 2, cutoff: 3800, res: 0.3, attack: 0.6, decay: 0.4, sustain: 0.85, release: 1.8 }) },
  { name: 'Strings-ish', cat: 'Pad', ...preset('poly', { wave: 0, cutoff: 2600, res: 0.4, attack: 0.4, sustain: 0.8, release: 1.2 }) },
  { name: 'Dream Keys', cat: 'Keys', ...preset('keys', { harm: 2, attack: 0.01, decay: 0.5, sustain: 0.45, release: 0.9 }) },
  { name: 'EP Glow', cat: 'Keys', ...preset('keys', { harm: 1, attack: 0.005, decay: 0.7, sustain: 0.3, release: 0.6 }) },
  { name: 'FM Keys', cat: 'Keys', ...preset('fm', { harm: 1, modIdx: 6, attack: 0.004, decay: 0.5, sustain: 0.35, release: 0.5 }) },
  { name: 'Sub Bass', cat: 'Bass', ...preset('mono', { wave: 3, cutoff: 520, res: 0.5, envAmt: 1.2, glide: 0.01, attack: 0.004, decay: 0.25, sustain: 0.7, release: 0.2 }) },
  { name: 'Acid 303', cat: 'Bass', ...preset('mono', { wave: 0, cutoff: 700, res: 7.5, envAmt: 3.6, glide: 0.06, attack: 0.003, decay: 0.18, sustain: 0.2, release: 0.15 }) },
  { name: 'Square Hollow', cat: 'Bass', ...preset('mono', { wave: 1, cutoff: 1000, res: 1.5, envAmt: 2, attack: 0.004, decay: 0.3, sustain: 0.5, release: 0.2 }) },
  { name: 'Classic Pluck', cat: 'Pluck', ...preset('pluck', {}) },
  { name: 'Koto-ish', cat: 'Pluck', ...preset('pluck', { dampen: 7000, res: 0.9 }) },
]

// ---------- drum kits ----------
export type DrumKit = { name: string; params: Record<string, number> }
const kit = (over: Record<string, number>) => ({ ...def('drum'), ...over })

export const DRUM_KITS: DrumKit[] = [
  { name: '808 Boom', params: kit({ p0_decay: 0.8, p0_tune: -2, p3_decay: 0.05, p4_decay: 0.35, p1_decay: 0.2 }) },
  { name: 'Tight 909', params: kit({ p0_decay: 0.3, p0_tune: 1, p1_decay: 0.15, p1_tune: 2, p3_decay: 0.06, p4_decay: 0.5 }) },
  { name: 'Lo-Fi Dust', params: kit({ p0_decay: 0.35, p0_tune: -4, p3_decay: 0.04, p4_decay: 0.25, p1_decay: 0.14, p7_level: -8, p2_tune: -3 }) },
  { name: 'Pop Punch', params: kit({ p0_decay: 0.45, p1_decay: 0.22, p1_tune: 2, p2_decay: 0.3, p3_decay: 0.07 }) },
]

// ---------- MIDI loops ----------
export type MidiLoop = { name: string; cat: 'Drums' | 'Bass' | 'Chords' | 'Melody'; forDrums?: boolean; clip: ClipJSON }

// A minor pitch shorthand
const A1 = 33, C2 = 36, D2 = 38, E2 = 40, F1 = 29, G1 = 31, A2 = 45
const A3 = 57, C4 = 60, D4 = 62, E4 = 64, F3 = 53, G3 = 55, B3 = 59, G4 = 67, A4 = 69, C5 = 72, E5 = 76, D5 = 74

export const MIDI_LOOPS: MidiLoop[] = [
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
    name: 'Octave Pump', cat: 'Bass',
    clip: clip('Octave Pump', 6, 4, [
      ...seq(0, [A1, A2, A1, A2, A1, A2, A1, A2], 2, 2, 0.85),
      ...seq(16, [F1, F1 + 12, F1, F1 + 12, F1, F1 + 12, F1, F1 + 12], 2, 2, 0.85),
      ...seq(32, [C2, C2 + 12, C2, C2 + 12, C2, C2 + 12, C2, C2 + 12], 2, 2, 0.85),
      ...seq(48, [G1, G1 + 12, G1, G1 + 12, G1, G1 + 12, G1, G1 + 12], 2, 2, 0.85),
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
      ...chord(16, [D4, F3 + 12, A4 - 12 + 3, C5], 14, 0.55),
      ...chord(32, [F3, A3, C4, E4], 14, 0.6),
      ...chord(48, [E4 - 12, G3, B3, D4], 14, 0.55),
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
    name: 'Penta Riff', cat: 'Melody',
    clip: clip('Penta Riff', 3, 2, seq(0, [A4, null, C5, A4, G4, null, E4, G4, A4, null, C5, D5, C5, null, A4, null], 2, 2, 0.8)),
  },
  {
    name: 'Arp Up', cat: 'Melody',
    clip: clip('Arp Up', 2, 1, seq(0, [A3, C4, E4, A4, C5, E5, C5, A4, E4, A3, C4, E4, A4, E5, C5, A4], 1, 1, 0.7)),
  },
  {
    name: 'Counter Line', cat: 'Melody',
    clip: clip('Counter Line', 11, 2, [
      ...seq(0, [E4, null, null, D4, null, C4, null, null], 2, 3, 0.65),
      ...seq(16, [A3, null, C4, null, D4, null, E4, G4], 2, 3, 0.65),
    ]),
  },
]

// ---------- default + demo projects ----------

export const DEFAULT_PROJECT: ProjectJSON = {
  meta: { title: 'Untitled Jam', bpm: 120, swing: 0, root: 9, scale: 'minor', launchQ: 1 },
  tracks: [
    { id: 'tDrums', name: 'Drums', color: 0, kind: 'drum', inst: { type: 'drum', params: DRUM_KITS[0].params }, fx: [{ type: 'comp', on: true, params: { thresh: -18, ratio: 4, attack: 0.01, release: 0.18 } }], gain: 0, pan: 0, mute: false, solo: false },
    { id: 'tBass', name: 'Bass', color: 6, kind: 'synth', inst: { type: 'mono', params: INST_PRESETS.find(p => p.name === 'Sub Bass')!.params }, fx: [], gain: -2, pan: 0, mute: false, solo: false },
    { id: 'tChords', name: 'Chords', color: 8, kind: 'synth', inst: { type: 'poly', params: INST_PRESETS.find(p => p.name === 'Warm Pad')!.params }, fx: [{ type: 'reverb', on: true, params: { size: 2.8, mix: 0.3 } }], gain: -4, pan: 0, mute: false, solo: false },
    { id: 'tLead', name: 'Lead', color: 3, kind: 'synth', inst: { type: 'poly', params: INST_PRESETS.find(p => p.name === 'Neon Saw Lead')!.params }, fx: [{ type: 'delay', on: true, params: { time: 2, fb: 0.35, mix: 0.25 } }], gain: -5, pan: 0, mute: false, solo: false },
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
    ...seq(16, [F1, F1, F1 + 12, F1, F1, F1 + 12, F1, F1 + 12, F1, F1, F1 + 12, F1, F1, C2, D2, E2], 1, 1, 0.85),
    ...seq(32, [C2, C2, C2 + 12, C2, C2, C2 + 12, C2, C2 + 12, C2, C2, C2 + 12, C2, C2, C2 + 12, G1, A1], 1, 1, 0.85),
    ...seq(48, [G1, G1, G1 + 12, G1, G1, G1 + 12, G1, G1 + 12, G1, G1, G1 + 12, G1, D2, D2, E2, E2], 1, 1, 0.85),
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
  // intro → groove → full → break → full out
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
      { id: 'tChords', name: 'Chords', color: 8, kind: 'synth', inst: { type: 'poly', params: INST_PRESETS.find(p => p.name === 'Warm Pad')!.params }, fx: [{ type: 'chorus', on: true, params: { rate: 0.8, depth: 0.5, mix: 0.4 } }, { type: 'reverb', on: true, params: { size: 3.2, mix: 0.32 } }], gain: -5, pan: -0.1, mute: false, solo: false },
      { id: 'tLead', name: 'Lead', color: 3, kind: 'synth', inst: { type: 'pluck', params: INST_PRESETS.find(p => p.name === 'Classic Pluck')!.params }, fx: [{ type: 'delay', on: true, params: { time: 3, fb: 0.45, mix: 0.35 } }, { type: 'reverb', on: true, params: { size: 2.2, mix: 0.25 } }], gain: -3, pan: 0.12, mute: false, solo: false },
    ],
    scenes: [
      { id: 's1', name: 'Intro' }, { id: 's2', name: 'Beat In' }, { id: 's3', name: 'Groove' },
      { id: 's4', name: 'Full On' }, { id: 's5', name: 'Break' }, { id: 's6', name: 'Outro' },
    ],
    clips: clipsMap,
    arr: arrOut,
  }
}
