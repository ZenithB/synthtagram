// MIDI clip transforms — the "wish my DAW had these one click away" set:
// chordify, arpeggiate, strum, humanize, quantize, double/halve, reverse, legato.
// All pure: take [id, Note][] and clip length, return new note records.

import { Note, STEP16, clamp } from './types'
import { diatonicTriad, snapToScale } from './theory'

export type NoteEntry = [string, Note]

let seq = 0
const nid = () => `t${Date.now().toString(36)}${(seq++).toString(36)}`

export function chordify(entries: NoteEntry[], root: number, scale: string): Record<string, Note> {
  const out: Record<string, Note> = {}
  for (const [, n] of entries) {
    const triad = diatonicTriad(n.p, root, scale)
    triad.forEach((p, i) => {
      out[nid()] = { ...n, p, v: i === 0 ? n.v : n.v * 0.82 }
    })
  }
  return out
}

export function arpeggiate(entries: NoteEntry[], grid: number, mode: 'up' | 'down' | 'updown'): Record<string, Note> {
  if (!entries.length) return {}
  const start = Math.min(...entries.map(([, n]) => n.s))
  const end = Math.max(...entries.map(([, n]) => n.s + n.d))
  let pitches = [...new Set(entries.map(([, n]) => n.p))].sort((a, b) => a - b)
  if (mode === 'down') pitches = pitches.reverse()
  if (mode === 'updown' && pitches.length > 2) pitches = [...pitches, ...pitches.slice(1, -1).reverse()]
  const vel = entries[0][1].v
  const out: Record<string, Note> = {}
  let i = 0
  for (let t = start; t < end; t += grid) {
    out[nid()] = { p: pitches[i % pitches.length], s: t, d: Math.max(6, grid - 2), v: vel * (0.85 + 0.15 * ((i % 4 === 0) ? 1 : 0.6)), pr: 1 }
    i++
  }
  return out
}

export function strum(entries: NoteEntry[], amount = 6): [string, Partial<Note>][] {
  // group notes sharing a start time, stagger them bottom-up
  const groups = new Map<number, NoteEntry[]>()
  entries.forEach(e => {
    const g = groups.get(e[1].s) ?? []
    g.push(e)
    groups.set(e[1].s, g)
  })
  const patches: [string, Partial<Note>][] = []
  groups.forEach(g => {
    g.sort((a, b) => a[1].p - b[1].p)
    g.forEach(([id, n], i) => patches.push([id, { s: n.s + i * amount }]))
  })
  return patches
}

export function humanize(entries: NoteEntry[], timeAmt = 4, velAmt = 0.08): [string, Partial<Note>][] {
  return entries.map(([id, n]) => [id, {
    s: Math.max(0, n.s + Math.round((Math.random() * 2 - 1) * timeAmt)),
    v: clamp(n.v + (Math.random() * 2 - 1) * velAmt, 0.05, 1),
  }])
}

export function quantize(entries: NoteEntry[], grid: number, strength = 1): [string, Partial<Note>][] {
  return entries.map(([id, n]) => {
    const target = Math.round(n.s / grid) * grid
    return [id, { s: Math.round(n.s + (target - n.s) * strength) }]
  })
}

export function legato(entries: NoteEntry[], clipLen: number): [string, Partial<Note>][] {
  const sorted = [...entries].sort((a, b) => a[1].s - b[1].s)
  const patches: [string, Partial<Note>][] = []
  for (let i = 0; i < sorted.length; i++) {
    const [id, n] = sorted[i]
    let next = clipLen
    for (let j = i + 1; j < sorted.length; j++) {
      if (sorted[j][1].s > n.s) { next = sorted[j][1].s; break }
    }
    patches.push([id, { d: Math.max(6, next - n.s) }])
  }
  return patches
}

export function reverse(entries: NoteEntry[], clipLen: number): [string, Partial<Note>][] {
  return entries.map(([id, n]) => [id, { s: Math.max(0, clipLen - n.s - n.d) }])
}

export function transpose(entries: NoteEntry[], semis: number, snap: boolean, root: number, scale: string): [string, Partial<Note>][] {
  return entries.map(([id, n]) => {
    let p = clamp(n.p + semis, 0, 127)
    if (snap) p = snapToScale(p, root, scale)
    return [id, { p }]
  })
}

export function velocityRamp(entries: NoteEntry[], from: number, to: number): [string, Partial<Note>][] {
  if (!entries.length) return []
  const min = Math.min(...entries.map(([, n]) => n.s))
  const max = Math.max(...entries.map(([, n]) => n.s))
  const span = Math.max(1, max - min)
  return entries.map(([id, n]) => [id, { v: clamp(from + (to - from) * ((n.s - min) / span), 0.05, 1) }])
}

/** duplicate the notes one loop-length later (for loop doubling) */
export function shiftedCopies(entries: NoteEntry[], offset: number): Note[] {
  return entries.map(([, n]) => ({ ...n, s: n.s + offset }))
}
