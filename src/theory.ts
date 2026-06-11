// Music theory helpers: scales, snapping, diatonic chords.

export const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B']

export const SCALES: { id: string; label: string; ivs: number[] }[] = [
  { id: 'major', label: 'Major', ivs: [0, 2, 4, 5, 7, 9, 11] },
  { id: 'minor', label: 'Minor', ivs: [0, 2, 3, 5, 7, 8, 10] },
  { id: 'dorian', label: 'Dorian', ivs: [0, 2, 3, 5, 7, 9, 10] },
  { id: 'mixo', label: 'Mixolydian', ivs: [0, 2, 4, 5, 7, 9, 10] },
  { id: 'pentMaj', label: 'Pent. Major', ivs: [0, 2, 4, 7, 9] },
  { id: 'pentMin', label: 'Pent. Minor', ivs: [0, 3, 5, 7, 10] },
  { id: 'harmMin', label: 'Harm. Minor', ivs: [0, 2, 3, 5, 7, 8, 11] },
  { id: 'blues', label: 'Blues', ivs: [0, 3, 5, 6, 7, 10] },
]

export function getScale(id: string) {
  return SCALES.find(s => s.id === id) ?? SCALES[0]
}

export function inScale(pitch: number, root: number, scaleId: string) {
  const ivs = getScale(scaleId).ivs
  return ivs.includes((((pitch - root) % 12) + 12) % 12)
}

/** Snap a pitch to the nearest scale tone (ties resolve downward). */
export function snapToScale(pitch: number, root: number, scaleId: string) {
  if (inScale(pitch, root, scaleId)) return pitch
  for (let off = 1; off <= 6; off++) {
    if (inScale(pitch - off, root, scaleId)) return pitch - off
    if (inScale(pitch + off, root, scaleId)) return pitch + off
  }
  return pitch
}

/** Diatonic triad built on the scale degree nearest to `pitch`. Returns pitches incl. the root note. */
export function diatonicTriad(pitch: number, root: number, scaleId: string): number[] {
  const ivs = getScale(scaleId).ivs
  const base = snapToScale(pitch, root, scaleId)
  const rel = (((base - root) % 12) + 12) % 12
  let deg = ivs.indexOf(rel)
  if (deg < 0) deg = 0
  const third = base + ((ivs[(deg + 2) % ivs.length] - rel + 12) % 12 || 12) * (ivs.length >= 5 ? 1 : 1)
  const fifth = base + ((ivs[(deg + 4) % ivs.length] - rel + 12) % 12 || 12)
  // Ensure ascending stacking even when wrapping the octave
  const t = third <= base ? third + 12 : third
  const f0 = fifth <= base ? fifth + 12 : fifth
  const f = f0 <= t ? f0 + 12 : f0
  return [base, t, f]
}

export function midiName(p: number) {
  return `${NOTE_NAMES[((p % 12) + 12) % 12]}${Math.floor(p / 12) - 1}`
}
