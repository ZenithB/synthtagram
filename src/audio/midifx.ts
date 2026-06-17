// MIDI-effect note processing, shared by the live engine and the offline
// renderer so they can't drift. Operates on plain note/params data (no Yjs),
// expanding a clip's notes through the track's Scale/Chord/Arp/Velocity/Random
// device chain before the instrument is triggered.

import { Note, clamp } from '../types'
import { snapToScale } from '../theory'
import { ARP_DIV_TICKS } from './schema'

export type MidiFxData = { type: string; on: boolean; params: Record<string, number> }

const BAR = 384

export function arpExpand(notes: Note[], p: Record<string, number>, _loopLen: number): Note[] {
  if (notes.length === 0) return notes
  const step = ARP_DIV_TICKS[Math.max(0, Math.min(ARP_DIV_TICKS.length - 1, (p.rate ?? 0) | 0))] || 48
  const mode = (p.mode ?? 0) | 0
  const oct = Math.max(1, p.oct ?? 1)
  const gate = p.gate ?? 0.8
  const groups = new Map<number, Note[]>()
  notes.forEach(n => { const g = groups.get(n.s) ?? []; g.push(n); groups.set(n.s, g) })
  const out: Note[] = []
  groups.forEach(g => {
    const end = Math.max(...g.map(n => n.s + n.d))
    let seq = [...new Set(g.map(n => n.p))].sort((a, b) => a - b)
    const ext: number[] = []
    for (let o = 0; o < oct; o++) seq.forEach(pp => ext.push(pp + o * 12))
    seq = ext
    if (mode === 1) seq = seq.reverse()
    else if (mode === 2 && seq.length > 2) seq = [...seq, ...seq.slice(1, -1).reverse()]
    let i = 0
    for (let t = g[0].s; t < end; t += step) {
      const pitch = mode === 3 ? seq[Math.floor(Math.random() * seq.length)] : seq[i % seq.length]
      out.push({ p: clamp(pitch, 0, 127), s: t, d: Math.max(6, step * gate), v: g[0].v, pr: g[0].pr })
      i++
    }
  })
  return out
}

/** Run a clip's notes through the track's MIDI-fx chain. */
export function applyMidiFx(
  chain: MidiFxData[] | undefined,
  notes: Note[],
  loopLen: number,
  root: number,
  scaleId: string,
  isDrum: boolean,
): Note[] {
  if (!chain || chain.length === 0) return notes
  let out = notes
  chain.forEach(d => {
    if (!d.on) return
    const p = d.params || {}
    if (d.type === 'scale' && !isDrum) {
      out = out.map(n => ({ ...n, p: snapToScale(n.p, root, scaleId) }))
    } else if (d.type === 'chord' && !isDrum) {
      const ivs = [0, p.i1 ?? 0, p.i2 ?? 0, p.i3 ?? 0].filter((v, i) => i === 0 || v !== 0)
      const next: Note[] = []
      out.forEach(n => ivs.forEach(iv => next.push({ ...n, p: clamp(n.p + iv, 0, 127), v: iv === 0 ? n.v : n.v * 0.85 })))
      out = next
    } else if (d.type === 'velo') {
      const s = p.scale ?? 1, r = p.rand ?? 0
      out = out.map(n => ({ ...n, v: clamp(n.v * s + (Math.random() * 2 - 1) * r, 0.05, 1) }))
    } else if (d.type === 'rand') {
      const ch = p.chance ?? 1, oc = p.octave ?? 0
      out = out.flatMap(n => {
        if (ch < 1 && Math.random() > ch) return []
        let pitch = n.p
        if (oc > 0 && Math.random() < oc) pitch = clamp(pitch + (Math.random() < 0.5 ? 12 : -12), 0, 127)
        return [{ ...n, p: pitch }]
      })
    } else if (d.type === 'arp' && !isDrum) {
      out = arpExpand(out, p, loopLen || BAR)
    }
  })
  return out
}
