// Procedurally-synthesized genre drum packs. These are generated in-app (no
// external/licensed audio to redistribute) and addressed by a virtual sample id
// `dp:<kit>:<role>` that getSampleBuffer renders on demand — so they play live,
// bounce in the offline export, and reproduce for collaborators with nothing to
// download. House/techno/trance/dubstep are 909/808-style by nature; rock/metal
// are synthesized acoustic-ish kits. Swap in real CC0 samples any time via the
// normal sample-import path.

import * as Tone from 'tone'

const SR = 44100
export type RoleName = 'kick' | 'snare' | 'clap' | 'chat' | 'ohat' | 'tom' | 'perc' | 'crash'
export const ROLE_LABEL: Record<RoleName, string> = {
  kick: 'Kick', snare: 'Snare', clap: 'Clap', chat: 'Closed Hat', ohat: 'Open Hat', tom: 'Tom', perc: 'Perc', crash: 'Crash',
}
type Voice =
  | { t: 'kick'; dur: number; f0: number; f1: number; pdec: number; dec: number; click: number }
  | { t: 'snare'; dur: number; tone: number; tdec: number; ndec: number; namt: number }
  | { t: 'clap'; dur: number; dec: number }
  | { t: 'hat'; dur: number; dec: number; bright: number }
  | { t: 'tom'; dur: number; f0: number; f1: number; pdec: number; dec: number }
  | { t: 'perc'; dur: number; freq: number; dec: number }
  | { t: 'crash'; dur: number; dec: number; bright: number }

export type DrumPack = { id: string; name: string; tag: string; roles: Partial<Record<RoleName, Voice>> }

// genre kits — order = browser order
export const DRUM_PACKS: DrumPack[] = [
  { id: 'rock', name: 'Rock Kit', tag: 'Acoustic, punchy', roles: {
    kick: { t: 'kick', dur: 0.36, f0: 130, f1: 55, pdec: 0.04, dec: 0.34, click: 0.25 },
    snare: { t: 'snare', dur: 0.28, tone: 190, tdec: 0.12, ndec: 0.18, namt: 0.6 },
    chat: { t: 'hat', dur: 0.06, dec: 0.04, bright: 0.9 },
    ohat: { t: 'hat', dur: 0.34, dec: 0.32, bright: 0.9 },
    tom: { t: 'tom', dur: 0.42, f0: 160, f1: 90, pdec: 0.06, dec: 0.4 },
    crash: { t: 'crash', dur: 1.3, dec: 1.3, bright: 0.92 },
  } },
  { id: 'metal', name: 'Metal Kit', tag: 'Tight, clicky', roles: {
    kick: { t: 'kick', dur: 0.24, f0: 180, f1: 50, pdec: 0.018, dec: 0.22, click: 0.6 },
    snare: { t: 'snare', dur: 0.22, tone: 230, tdec: 0.06, ndec: 0.14, namt: 0.78 },
    chat: { t: 'hat', dur: 0.05, dec: 0.03, bright: 0.95 },
    ohat: { t: 'hat', dur: 0.24, dec: 0.22, bright: 0.95 },
    tom: { t: 'tom', dur: 0.32, f0: 200, f1: 110, pdec: 0.04, dec: 0.3 },
    crash: { t: 'crash', dur: 1.1, dec: 1.1, bright: 0.95 },
  } },
  { id: 'house', name: 'House 909', tag: '909-style four-on-floor', roles: {
    kick: { t: 'kick', dur: 0.32, f0: 120, f1: 48, pdec: 0.03, dec: 0.3, click: 0.2 },
    snare: { t: 'snare', dur: 0.2, tone: 180, tdec: 0.08, ndec: 0.16, namt: 0.55 },
    clap: { t: 'clap', dur: 0.24, dec: 0.18 },
    chat: { t: 'hat', dur: 0.06, dec: 0.045, bright: 0.9 },
    ohat: { t: 'hat', dur: 0.36, dec: 0.34, bright: 0.9 },
    tom: { t: 'tom', dur: 0.36, f0: 150, f1: 85, pdec: 0.05, dec: 0.34 },
    perc: { t: 'perc', dur: 0.1, freq: 440, dec: 0.09 },
    crash: { t: 'crash', dur: 1.2, dec: 1.2, bright: 0.9 },
  } },
  { id: 'trance', name: 'Trance Kit', tag: 'Bright, energetic', roles: {
    kick: { t: 'kick', dur: 0.28, f0: 140, f1: 50, pdec: 0.025, dec: 0.26, click: 0.25 },
    snare: { t: 'snare', dur: 0.2, tone: 200, tdec: 0.07, ndec: 0.16, namt: 0.6 },
    clap: { t: 'clap', dur: 0.26, dec: 0.2 },
    chat: { t: 'hat', dur: 0.055, dec: 0.04, bright: 0.92 },
    ohat: { t: 'hat', dur: 0.44, dec: 0.4, bright: 0.92 },
    tom: { t: 'tom', dur: 0.36, f0: 170, f1: 95, pdec: 0.05, dec: 0.34 },
    perc: { t: 'perc', dur: 0.09, freq: 520, dec: 0.08 },
    crash: { t: 'crash', dur: 1.4, dec: 1.4, bright: 0.92 },
  } },
  { id: 'dubstep', name: 'Dubstep Kit', tag: 'Deep, heavy', roles: {
    kick: { t: 'kick', dur: 0.55, f0: 150, f1: 40, pdec: 0.05, dec: 0.5, click: 0.3 },
    snare: { t: 'snare', dur: 0.34, tone: 170, tdec: 0.14, ndec: 0.3, namt: 0.65 },
    clap: { t: 'clap', dur: 0.32, dec: 0.26 },
    chat: { t: 'hat', dur: 0.06, dec: 0.05, bright: 0.88 },
    ohat: { t: 'hat', dur: 0.48, dec: 0.45, bright: 0.88 },
    tom: { t: 'tom', dur: 0.48, f0: 140, f1: 70, pdec: 0.07, dec: 0.45 },
    crash: { t: 'crash', dur: 1.5, dec: 1.5, bright: 0.9 },
  } },
  { id: 'techno', name: 'Techno 808/909', tag: 'Driving, hypnotic', roles: {
    kick: { t: 'kick', dur: 0.34, f0: 125, f1: 45, pdec: 0.028, dec: 0.32, click: 0.22 },
    snare: { t: 'snare', dur: 0.2, tone: 185, tdec: 0.07, ndec: 0.15, namt: 0.6 },
    clap: { t: 'clap', dur: 0.22, dec: 0.16 },
    chat: { t: 'hat', dur: 0.05, dec: 0.038, bright: 0.93 },
    ohat: { t: 'hat', dur: 0.32, dec: 0.3, bright: 0.93 },
    tom: { t: 'tom', dur: 0.34, f0: 155, f1: 85, pdec: 0.05, dec: 0.32 },
    perc: { t: 'perc', dur: 0.08, freq: 600, dec: 0.07 },
    crash: { t: 'crash', dur: 1.1, dec: 1.1, bright: 0.92 },
  } },
]

// Seeded PRNG so a kit:role always synthesizes the SAME sample — identical live,
// in exports and across collaborators (the dp: ids are meant to be deterministic).
function hashStr(s: string): number {
  let h = 2166136261
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) }
  return h >>> 0
}
function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6D2B79F5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function render(v: Voice, rnd: () => number): Float32Array {
  const n = Math.max(1, Math.floor(v.dur * SR))
  const out = new Float32Array(n)
  if (v.t === 'kick') {
    let ph = 0
    for (let i = 0; i < n; i++) {
      const t = i / SR
      const f = v.f1 + (v.f0 - v.f1) * Math.exp(-t / v.pdec)
      ph += (2 * Math.PI * f) / SR
      let s = Math.sin(ph)
      if (i < SR * 0.006) s += rnd() * v.click * Math.exp(-t / 0.0015)
      out[i] = Math.tanh(s * 1.3) * Math.exp(-t / v.dec)
    }
  } else if (v.t === 'snare') {
    let hp = 0, prev = 0
    for (let i = 0; i < n; i++) {
      const t = i / SR
      const x = rnd(); hp = 0.85 * (hp + x - prev); prev = x
      const tone = Math.sin(2 * Math.PI * v.tone * t) * Math.exp(-t / v.tdec) * (1 - v.namt)
      out[i] = tone + hp * v.namt * Math.exp(-t / v.ndec)
    }
  } else if (v.t === 'clap') {
    const offs = [0, 0.009, 0.018, 0.027]
    let hp = 0, prev = 0
    for (let i = 0; i < n; i++) {
      const t = i / SR
      const x = rnd(); hp = 0.8 * (hp + x - prev); prev = x
      let amp = Math.exp(-t / v.dec) * 0.5
      for (const o of offs) { const dt = t - o; if (dt >= 0) amp += Math.exp(-dt / 0.012) }
      out[i] = hp * amp * 0.4
    }
  } else if (v.t === 'hat') {
    let hp = 0, prev = 0
    for (let i = 0; i < n; i++) {
      const t = i / SR
      const x = rnd(); hp = v.bright * (hp + x - prev); prev = x
      out[i] = hp * Math.exp(-t / v.dec)
    }
  } else if (v.t === 'tom') {
    let ph = 0
    for (let i = 0; i < n; i++) {
      const t = i / SR
      const f = v.f1 + (v.f0 - v.f1) * Math.exp(-t / v.pdec)
      ph += (2 * Math.PI * f) / SR
      out[i] = Math.sin(ph) * Math.exp(-t / v.dec)
    }
  } else if (v.t === 'perc') {
    for (let i = 0; i < n; i++) {
      const t = i / SR
      const s = Math.sin(2 * Math.PI * v.freq * t)
      out[i] = (s + 0.3 * Math.sin(2 * Math.PI * v.freq * 2.7 * t)) * Math.exp(-t / v.dec)
    }
  } else { // crash
    let hp = 0, prev = 0
    for (let i = 0; i < n; i++) {
      const t = i / SR
      const x = rnd(); hp = v.bright * (hp + x - prev); prev = x
      out[i] = hp * Math.exp(-t / v.dec) * 0.7
    }
  }
  // short fade-out tail to avoid an end click
  const fade = Math.min(256, n)
  for (let i = 0; i < fade; i++) out[n - 1 - i] *= i / fade
  return out
}

const cache = new Map<string, AudioBuffer>()

/** Render (and cache) a pack role as an AudioBuffer, or undefined if unknown. */
export function synthDrumSample(kitId: string, role: RoleName): AudioBuffer | undefined {
  const key = `${kitId}:${role}`
  const hit = cache.get(key)
  if (hit) return hit
  const v = DRUM_PACKS.find(p => p.id === kitId)?.roles[role]
  if (!v) return undefined
  const rng = mulberry32(hashStr(key))
  const data = render(v, () => rng() * 2 - 1)
  const ctx = Tone.getContext().rawContext as unknown as BaseAudioContext
  const buf = ctx.createBuffer(1, data.length, SR)
  buf.getChannelData(0).set(data)
  cache.set(key, buf)
  return buf
}

export const packSampleId = (kitId: string, role: RoleName) => `dp:${kitId}:${role}`
export const packName = (kitId: string) => DRUM_PACKS.find(p => p.id === kitId)?.name ?? kitId

/** Resolve a `dp:kit:role` id (used by getSampleBuffer to render on demand). */
export function parsePackId(sampleId: string): { kitId: string; role: RoleName } | null {
  if (!sampleId.startsWith('dp:')) return null
  const parts = sampleId.split(':')
  return parts.length === 3 ? { kitId: parts[1], role: parts[2] as RoleName } : null
}

/** A friendly display name for a `dp:` sample id. */
export function packSampleName(sampleId: string): string {
  const p = parsePackId(sampleId)
  return p ? `${packName(p.kitId)} ${ROLE_LABEL[p.role] ?? p.role}` : sampleId
}
