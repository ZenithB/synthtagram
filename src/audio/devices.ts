// Tone.js implementations of every instrument & effect module.
// Factories build into whatever Tone context is current, so the same code
// powers live playback AND offline WAV rendering (engine swaps the context).
// The app runs its context at 2x sample rate (88.2kHz) so FM/waveshaping
// stay clean; Drive additionally oversamples its waveshaper 4x.

import * as Tone from 'tone'
import { WAVES, DELAY_FRACTIONS, DUCK_DIV_TICKS } from './schema'
import { snapToScale } from '../theory'
import { meta } from '../state/doc'

// Monophonic pitch detector (YIN cumulative-mean-normalized difference) used by
// Auto-Tune. Returns the fundamental in Hz, or 0 if no clear pitch.
function detectPitchHz(buf: Float32Array, sr: number): number {
  const n = buf.length
  const maxTau = Math.min(n - 256, Math.floor(sr / 70))   // down to ~70 Hz
  const minTau = Math.max(2, Math.floor(sr / 1100))        // up to ~1100 Hz
  if (maxTau <= minTau + 2) return 0
  const cmnd = new Float32Array(maxTau)
  let running = 0
  for (let tau = minTau; tau < maxTau; tau++) {
    let sum = 0
    for (let i = 0; i < n - maxTau; i++) { const d = buf[i] - buf[i + tau]; sum += d * d }
    running += sum
    cmnd[tau] = running > 0 ? (sum * (tau - minTau + 1)) / running : 1
  }
  const thr = 0.15
  let tau = -1
  for (let t = minTau + 1; t < maxTau - 1; t++) {
    if (cmnd[t] < thr) { while (t + 1 < maxTau && cmnd[t + 1] < cmnd[t]) t++; tau = t; break }
  }
  if (tau < 0) {
    let best = 1, bt = -1
    for (let t = minTau; t < maxTau; t++) if (cmnd[t] < best) { best = cmnd[t]; bt = t }
    if (best > 0.4) return 0
    tau = bt
  }
  return tau > 0 ? sr / tau : 0
}

export type Inst = {
  out: Tone.ToneAudioNode
  set: (key: string, v: number) => void
  noteOn: (p: number, vel: number) => void
  noteOff: (p: number) => void
  trigger: (p: number, durSec: number, time: number, vel: number) => void
  dispose: () => void
}

export type Fx = {
  node: Tone.ToneAudioNode
  set: (key: string, v: number) => void
  tick?: (posTicks: number, playing: boolean, bpm: number) => void
  // Effects that need to analyse their *input* (e.g. Auto-Tune pitch detection)
  // expose a raw AnalyserNode; the engine taps the pre-effect signal into it.
  detect?: AnalyserNode
  // Live gain reduction in dB (≤0) for a GR meter — single value (comp/opto) or
  // per-band (multiband). Read each frame by the UI; absent on non-dynamics fx.
  gr?: () => number
  grBands?: () => number[]
  dispose: () => void
}

const midiHz = (p: number) => Tone.Frequency(p, 'midi').toFrequency()

// Timestamp for notes the player triggers LIVE (MIDI/keyboard), right now.
// Tone's default ~100ms context `lookAhead` keeps *sequenced* clips jitter-free,
// but for a live keypress it's pure latency — there's no sequence to stay in sync
// with. So we schedule live notes a hair (5ms) ahead of the raw audio clock via
// `immediate()` (which excludes lookAhead) instead of `now()` (which adds it),
// taking key→sound from ~100ms down to roughly buffer-bound. The small 5ms margin
// avoids the "scheduled in the past" edge case while staying imperceptible.
// The scheduled `trigger()` path (clip playback) keeps its exact time untouched.
const liveTime = () => Tone.immediate() + 0.005

// ---------------- instruments ----------------

function makePoly(p: Record<string, number>): Inst {
  let wave = p.wave | 0
  let spread = p.spread ?? 18
  const oscOpts = () => {
    const type = WAVES[wave] as any
    return type.startsWith('fat') ? { type, spread, count: 3 } : { type }
  }
  const synth = new Tone.PolySynth(Tone.Synth, {
    maxPolyphony: 16,
    oscillator: oscOpts(),
    envelope: { attack: p.attack, decay: p.decay, sustain: p.sustain, release: p.release },
  } as any)
  const filt = new Tone.Filter(p.cutoff, 'lowpass')
  filt.Q.value = p.res
  synth.connect(filt)
  return {
    out: filt,
    set: (k, v) => {
      if (k === 'wave') { wave = v | 0; synth.set({ oscillator: oscOpts() } as any) }
      else if (k === 'spread') { spread = v; if (WAVES[wave].startsWith('fat')) synth.set({ oscillator: { spread: v } } as any) }
      else if (k === 'cutoff') filt.frequency.rampTo(v, 0.03)
      else if (k === 'res') filt.Q.value = v
      else synth.set({ envelope: { [k]: v } } as any)
    },
    noteOn: (pp, vel) => synth.triggerAttack(midiHz(pp), liveTime(), vel),
    noteOff: pp => synth.triggerRelease(midiHz(pp), liveTime()),
    trigger: (pp, dur, time, vel) => synth.triggerAttackRelease(midiHz(pp), dur, time, vel),
    dispose: () => { synth.dispose(); filt.dispose() },
  }
}

function makeDuo(p: Record<string, number>): Inst {
  const synth = new Tone.PolySynth(Tone.DuoSynth as any, {
    maxPolyphony: 6,
    harmonicity: p.harm,
    vibratoAmount: p.vibAmt,
    vibratoRate: p.vibRate,
    voice0: { envelope: { attack: p.attack, decay: p.decay, sustain: p.sustain, release: p.release } },
    voice1: { envelope: { attack: p.attack, decay: p.decay, sustain: p.sustain, release: p.release } },
  } as any)
  return {
    out: synth as any,
    set: (k, v) => {
      if (k === 'harm') synth.set({ harmonicity: v } as any)
      else if (k === 'vibAmt') synth.set({ vibratoAmount: v } as any)
      else if (k === 'vibRate') synth.set({ vibratoRate: v } as any)
      else synth.set({ voice0: { envelope: { [k]: v } }, voice1: { envelope: { [k]: v } } } as any)
    },
    noteOn: (pp, vel) => (synth as any).triggerAttack(midiHz(pp), liveTime(), vel),
    noteOff: pp => (synth as any).triggerRelease(midiHz(pp), liveTime()),
    trigger: (pp, dur, time, vel) => (synth as any).triggerAttackRelease(midiHz(pp), dur, time, vel),
    dispose: () => synth.dispose(),
  }
}

function makeFm(p: Record<string, number>): Inst {
  const synth = new Tone.PolySynth(Tone.FMSynth, {
    maxPolyphony: 12,
    harmonicity: p.harm,
    modulationIndex: p.modIdx,
    envelope: { attack: p.attack, decay: p.decay, sustain: p.sustain, release: p.release },
    modulationEnvelope: { attack: 0.005, decay: 0.4, sustain: 0.6, release: 0.4 },
  } as any)
  return {
    out: synth,
    set: (k, v) => {
      if (k === 'harm') synth.set({ harmonicity: v } as any)
      else if (k === 'modIdx') synth.set({ modulationIndex: v } as any)
      else synth.set({ envelope: { [k]: v } } as any)
    },
    noteOn: (pp, vel) => synth.triggerAttack(midiHz(pp), liveTime(), vel),
    noteOff: pp => synth.triggerRelease(midiHz(pp), liveTime()),
    trigger: (pp, dur, time, vel) => synth.triggerAttackRelease(midiHz(pp), dur, time, vel),
    dispose: () => synth.dispose(),
  }
}

function makeMono(p: Record<string, number>): Inst {
  const synth = new Tone.MonoSynth({
    oscillator: { type: WAVES[p.wave | 0] as any },
    filter: { Q: p.res, type: 'lowpass', rolloff: -24 },
    filterEnvelope: { attack: 0.004, decay: 0.18, sustain: 0.4, release: 0.3, baseFrequency: p.cutoff, octaves: p.envAmt },
    envelope: { attack: p.attack, decay: p.decay, sustain: p.sustain, release: p.release },
    portamento: p.glide,
  } as any)
  return {
    out: synth,
    set: (k, v) => {
      if (k === 'wave') synth.set({ oscillator: { type: WAVES[v | 0] as any } } as any)
      else if (k === 'cutoff') synth.set({ filterEnvelope: { baseFrequency: v } } as any)
      else if (k === 'res') synth.set({ filter: { Q: v } } as any)
      else if (k === 'envAmt') synth.set({ filterEnvelope: { octaves: v } } as any)
      else if (k === 'glide') synth.portamento = v
      else synth.set({ envelope: { [k]: v } } as any)
    },
    noteOn: (pp, vel) => synth.triggerAttack(midiHz(pp), liveTime(), vel),
    noteOff: () => synth.triggerRelease(liveTime()),
    trigger: (pp, dur, time, vel) => synth.triggerAttackRelease(midiHz(pp), dur, time, vel),
    dispose: () => synth.dispose(),
  }
}

function makePluck(p: Record<string, number>): Inst {
  const out = new Tone.Gain(0.9)
  const pool = Array.from({ length: 4 }, () =>
    new Tone.PluckSynth({ dampening: p.dampen, resonance: p.res, attackNoise: 1 }).connect(out))
  let i = 0
  const next = () => pool[i++ % pool.length]
  return {
    out,
    set: (k, v) => pool.forEach(s => {
      if (k === 'dampen') (s as any).dampening = v
      else if (k === 'res') s.resonance = v as any
    }),
    noteOn: (pp, vel) => next().triggerAttack(midiHz(pp), liveTime()),
    noteOff: () => {},
    trigger: (pp, _dur, time, _vel) => next().triggerAttack(midiHz(pp), time),
    dispose: () => { pool.forEach(s => s.dispose()); out.dispose() },
  }
}

function makeKeys(p: Record<string, number>): Inst {
  const synth = new Tone.PolySynth(Tone.AMSynth, {
    maxPolyphony: 12,
    harmonicity: p.harm,
    envelope: { attack: p.attack, decay: p.decay, sustain: p.sustain, release: p.release },
    modulation: { type: 'sine' },
  } as any)
  return {
    out: synth,
    set: (k, v) => {
      if (k === 'harm') synth.set({ harmonicity: v } as any)
      else synth.set({ envelope: { [k]: v } } as any)
    },
    noteOn: (pp, vel) => synth.triggerAttack(midiHz(pp), liveTime(), vel),
    noteOff: pp => synth.triggerRelease(midiHz(pp), liveTime()),
    trigger: (pp, dur, time, vel) => synth.triggerAttackRelease(midiHz(pp), dur, time, vel),
    dispose: () => synth.dispose(),
  }
}

// ---- drum kit: 8 synthesized pads ----

type Pad = {
  trig: (time: number, vel: number) => void
  set: (which: 'tune' | 'decay' | 'level', v: number) => void
  dispose: () => void
}

function noisePad(mix: Tone.Gain, kind: 'snare' | 'clap' | 'clhat' | 'ophat' | 'crash', decay0: number): Pad {
  const centers: Record<string, number> = { snare: 1800, clap: 1100, clhat: 9000, ophat: 8000, crash: 6500 }
  const types: Record<string, BiquadFilterType> = { snare: 'bandpass', clap: 'bandpass', clhat: 'highpass', ophat: 'highpass', crash: 'highpass' }
  let tune = 0
  let decay = decay0
  const level = new Tone.Gain(1).connect(mix)
  const filt = new Tone.Filter(centers[kind], types[kind]).connect(level)
  if (kind === 'snare') filt.Q.value = 0.8
  const noise = new Tone.NoiseSynth({
    noise: { type: kind === 'crash' ? 'pink' : 'white' },
    envelope: { attack: 0.001, decay: decay0, sustain: 0, release: 0.03 },
  }).connect(filt)
  const retune = () => filt.frequency.setValueAtTime(centers[kind] * Math.pow(2, tune / 12), Tone.now())
  return {
    trig: (time, vel) => {
      if (kind === 'clap') {
        // three quick bursts ≈ a clap
        noise.triggerAttackRelease(decay, time, vel * 0.7)
        noise.triggerAttackRelease(decay, time + 0.012, vel * 0.85)
        noise.triggerAttackRelease(decay, time + 0.026, vel)
      } else {
        noise.triggerAttackRelease(decay, time, vel)
      }
    },
    set: (which, v) => {
      if (which === 'tune') { tune = v; retune() }
      else if (which === 'decay') { decay = v; noise.set({ envelope: { decay: v } } as any) }
      else level.gain.value = Tone.dbToGain(v)
    },
    dispose: () => { noise.dispose(); filt.dispose(); level.dispose() },
  }
}

function membranePad(mix: Tone.Gain, baseMidi: number, decay0: number, pitchDecay: number): Pad {
  let tune = 0
  let decay = decay0
  const level = new Tone.Gain(1).connect(mix)
  const synth = new Tone.MembraneSynth({
    pitchDecay,
    octaves: 6,
    envelope: { attack: 0.001, decay: decay0, sustain: 0, release: 0.05 },
  }).connect(level)
  return {
    trig: (time, vel) => synth.triggerAttackRelease(midiHz(baseMidi + tune), Math.max(0.05, decay), time, vel),
    set: (which, v) => {
      if (which === 'tune') tune = v
      else if (which === 'decay') { decay = v; synth.set({ envelope: { decay: v } } as any) }
      else level.gain.value = Tone.dbToGain(v)
    },
    dispose: () => { synth.dispose(); level.dispose() },
  }
}

function blipPad(mix: Tone.Gain, baseHz: number, decay0: number): Pad {
  let tune = 0
  let decay = decay0
  const level = new Tone.Gain(1).connect(mix)
  const synth = new Tone.Synth({
    oscillator: { type: 'triangle' },
    envelope: { attack: 0.001, decay: decay0, sustain: 0, release: 0.03 },
  }).connect(level)
  return {
    trig: (time, vel) => synth.triggerAttackRelease(baseHz * Math.pow(2, tune / 12), Math.max(0.04, decay), time, vel),
    set: (which, v) => {
      if (which === 'tune') tune = v
      else if (which === 'decay') { decay = v; synth.set({ envelope: { decay: v } } as any) }
      else level.gain.value = Tone.dbToGain(v)
    },
    dispose: () => { synth.dispose(); level.dispose() },
  }
}

// A drum pad backed by an audio sample (one-shot). Polyphonic + velocity via
// Tone.Sampler (same engine the Sampler instrument uses); `tune` repitches in
// semitones, `level` is the pad gain. The full sample always plays (decay is a
// no-op here). Drops into the same Pad slot as the synth voices.
function samplePad(mix: Tone.Gain, buffer: AudioBuffer, level0: number, tune0: number): Pad {
  let tune = tune0
  const level = new Tone.Gain(Tone.dbToGain(level0)).connect(mix)
  const sampler = new Tone.Sampler({
    urls: { C3: new Tone.ToneAudioBuffer(buffer) },
    attack: 0.001, release: 0.06,
  }).connect(level)
  const note = () => Tone.Frequency(48 + tune, 'midi').toFrequency() // C3 = midi 48 → natural pitch
  return {
    trig: (time, vel) => { try { sampler.triggerAttack(note(), time, vel) } catch { /* overlapping retrigger */ } },
    set: (which, v) => {
      if (which === 'tune') tune = v
      else if (which === 'level') level.gain.value = Tone.dbToGain(v)
      // 'decay' has no effect on a sampled pad (the whole sample plays)
    },
    dispose: () => { sampler.dispose(); level.dispose() },
  }
}

function makeDrum(p: Record<string, number>, padBuffers?: Map<number, AudioBuffer>): Inst {
  const mix = new Tone.Gain(1)
  // Each pad is synthesized unless a sample has been dropped on it, in which
  // case that one pad plays the sample while the rest stay synths.
  const padOr = (i: number, synth: () => Pad): Pad => {
    const buf = padBuffers?.get(i)
    return buf ? samplePad(mix, buf, p[`p${i}_level`] ?? 0, p[`p${i}_tune`] ?? 0) : synth()
  }
  const pads: Pad[] = [
    padOr(0, () => membranePad(mix, 36, p.p0_decay, 0.05)),  // kick
    padOr(1, () => noisePad(mix, 'snare', p.p1_decay)),      // snare
    padOr(2, () => noisePad(mix, 'clap', p.p2_decay)),       // clap
    padOr(3, () => noisePad(mix, 'clhat', p.p3_decay)),      // closed hat
    padOr(4, () => noisePad(mix, 'ophat', p.p4_decay)),      // open hat
    padOr(5, () => membranePad(mix, 48, p.p5_decay, 0.03)),  // lo tom
    padOr(6, () => blipPad(mix, 1100, p.p6_decay)),          // perc
    padOr(7, () => noisePad(mix, 'crash', p.p7_decay)),      // crash
  ]
  pads.forEach((pad, i) => {
    pad.set('tune', p[`p${i}_tune`] ?? 0)
    pad.set('level', p[`p${i}_level`] ?? 0)
  })
  return {
    out: mix,
    set: (k, v) => {
      const m = k.match(/^p(\d)_(tune|decay|level)$/)
      if (m) pads[+m[1]]?.set(m[2] as any, v)
    },
    noteOn: (pp, vel) => pads[pp % pads.length]?.trig(liveTime(), vel),
    noteOff: () => {},
    trigger: (pp, _dur, time, vel) => pads[pp % pads.length]?.trig(time, vel),
    dispose: () => { pads.forEach(pad => pad.dispose()); mix.dispose() },
  }
}

function makeSampler(p: Record<string, number>, buffer?: AudioBuffer): Inst {
  const out = new Tone.Gain(0.9)
  let tune = p.tune ?? 0
  if (!buffer) {
    // no sample loaded (or not transferred to this peer yet) → silent but valid
    return { out, set: () => {}, noteOn: () => {}, noteOff: () => {}, trigger: () => {}, dispose: () => out.dispose() }
  }
  const sampler = new Tone.Sampler({
    urls: { C3: new Tone.ToneAudioBuffer(buffer) },
    attack: p.attack ?? 0.005,
    release: p.release ?? 0.4,
  }).connect(out)
  const hz = (pp: number) => Tone.Frequency(pp + tune, 'midi').toFrequency()
  return {
    out,
    set: (k, v) => {
      if (k === 'tune') tune = v
      else if (k === 'attack') sampler.attack = v
      else if (k === 'release') sampler.release = v
    },
    noteOn: (pp, vel) => sampler.triggerAttack(hz(pp), liveTime(), vel),
    noteOff: pp => sampler.triggerRelease(hz(pp), liveTime()),
    trigger: (pp, dur, time, vel) => sampler.triggerAttackRelease(hz(pp), dur, time, vel),
    dispose: () => { sampler.dispose(); out.dispose() },
  }
}

// Musical single-sample keyboard instrument: ONE buffer played chromatically,
// pitched up/down across the keyboard (Tone.Sampler handles polyphony + velocity
// + sample-accurate repitch). `root` (0..11 = C..B) is the note the sample sounds
// at unpitched, folded into the pitch math so it changes live with no rebuild.
function makeKSampler(p: Record<string, number>, buffer?: AudioBuffer): Inst {
  const out = new Tone.Gain(0.9)
  let tune = p.tune ?? 0
  let root = (p.root ?? 0) | 0
  if (!buffer) {
    return { out, set: () => {}, noteOn: () => {}, noteOff: () => {}, trigger: () => {}, dispose: () => out.dispose() }
  }
  const sampler = new Tone.Sampler({
    urls: { C3: new Tone.ToneAudioBuffer(buffer) },   // sample rooted at C3 (midi 48)
    attack: p.attack ?? 0.004,
    release: p.release ?? 0.4,
  }).connect(out)
  // Feed the C3-keyed sampler `note - root`, so playing the chosen root pitch
  // class (in octave 3) plays the sample at its natural pitch.
  const hz = (pp: number) => Tone.Frequency(pp - root + tune, 'midi').toFrequency()
  return {
    out,
    set: (k, v) => {
      if (k === 'tune') tune = v
      else if (k === 'root') root = v | 0
      else if (k === 'attack') sampler.attack = v
      else if (k === 'release') sampler.release = v
    },
    noteOn: (pp, vel) => sampler.triggerAttack(hz(pp), liveTime(), vel),
    noteOff: pp => sampler.triggerRelease(hz(pp), liveTime()),
    trigger: (pp, dur, time, vel) => sampler.triggerAttackRelease(hz(pp), dur, time, vel),
    dispose: () => { sampler.dispose(); out.dispose() },
  }
}

/** Audio tracks have no synth — just a stereo passthrough bus that audio-clip
 *  players connect into, so the signal runs through the track's fx + mixer. */
function makeAudioBus(): Inst {
  const bus = new Tone.Gain(1)
  return { out: bus, set: () => {}, noteOn: () => {}, noteOff: () => {}, trigger: () => {}, dispose: () => bus.dispose() }
}

export function makeInstrument(type: string, params: Record<string, number>, buffer?: AudioBuffer, padBuffers?: Map<number, AudioBuffer>): Inst {
  switch (type) {
    case 'fm': return makeFm(params)
    case 'mono': return makeMono(params)
    case 'pluck': return makePluck(params)
    case 'keys': return makeKeys(params)
    case 'duo': return makeDuo(params)
    case 'sampler': return makeSampler(params, buffer)
    case 'ksampler': return makeKSampler(params, buffer)
    case 'audiobus': return makeAudioBus()
    case 'drum': return makeDrum(params, padBuffers)
    default: return makePoly(params)
  }
}

// ---------------- effects ----------------

function delaySeconds(idx: number) {
  const bpm = Tone.getTransport().bpm.value
  const whole = (60 / bpm) * 4
  return whole * DELAY_FRACTIONS[Math.max(0, Math.min(DELAY_FRACTIONS.length - 1, idx | 0))]
}

// LA-2A-style optical compressor. The opto "cell" gives soft-knee, gentle,
// program-dependent levelling — modelled here on the native DynamicsCompressor
// with a wide knee, low ratio and slow release (Comp), or a tighter/harder
// curve (Limit). Composite (compressor → makeup gain) so it wires as one
// in=out effect node; exposes live gain reduction for the GR meter.
class OptoComp extends Tone.ToneAudioNode {
  readonly name = 'OptoComp'
  readonly input: Tone.Compressor
  readonly output: Tone.Gain
  private mode = 0
  constructor() {
    super()
    this.input = new Tone.Compressor({ ratio: 3, knee: 30, attack: 0.01, release: 0.45, threshold: -16 })
    this.output = new Tone.Gain(1)
    this.input.connect(this.output)
  }
  get reduction(): number { return (this.input as any).reduction ?? 0 }
  private applyMode() {
    this.input.ratio.value = this.mode ? 10 : 3
    this.input.knee.value = this.mode ? 12 : 30
    this.input.attack.value = this.mode ? 0.005 : 0.01
    this.input.release.value = this.mode ? 0.3 : 0.45
  }
  // Peak Reduction (0..1) lowers the threshold (0 → -40 dB), like the hardware.
  setReduction(v: number) { this.input.threshold.value = -40 * Math.max(0, Math.min(1, v)) }
  setGain(db: number) { this.output.gain.value = Tone.dbToGain(db) }
  setMode(m: number) { this.mode = m | 0; this.applyMode() }
  configure(mode: number, reduction: number, gainDb: number) {
    this.mode = mode | 0; this.applyMode(); this.setReduction(reduction); this.setGain(gainDb)
  }
  dispose() { super.dispose(); this.input.dispose(); this.output.dispose(); return this }
}

export function makeEffect(type: string, p: Record<string, number>): Fx {
  switch (type) {
    case 'eq': {
      const node = new Tone.EQ3({ low: p.low, mid: p.mid, high: p.high })
      return {
        node,
        set: (k, v) => { (node as any)[k].value = v },
        dispose: () => node.dispose(),
      }
    }
    case 'filter': {
      const types: BiquadFilterType[] = ['lowpass', 'highpass', 'bandpass']
      const node = new Tone.Filter(p.freq, types[p.ftype | 0])
      node.Q.value = p.q
      return {
        node,
        set: (k, v) => {
          if (k === 'ftype') node.type = types[v | 0]
          else if (k === 'freq') node.frequency.rampTo(v, 0.03)
          else node.Q.value = v
        },
        dispose: () => node.dispose(),
      }
    }
    case 'delay': {
      const node = new Tone.FeedbackDelay({ delayTime: delaySeconds(p.time), feedback: p.fb, wet: p.mix, maxDelay: 4 })
      return {
        node,
        set: (k, v) => {
          if (k === 'time') node.delayTime.rampTo(delaySeconds(v), 0.05)
          else if (k === 'fb') node.feedback.value = Math.min(0.9, v)
          else node.wet.value = v
        },
        dispose: () => node.dispose(),
      }
    }
    case 'reverb': {
      const node = new Tone.Reverb({ decay: p.size, preDelay: 0.02, wet: p.mix })
      node.generate().catch(() => {})
      let regen: ReturnType<typeof setTimeout> | null = null
      return {
        node,
        set: (k, v) => {
          if (k === 'size') {
            node.decay = v
            if (regen) clearTimeout(regen)
            regen = setTimeout(() => node.generate().catch(() => {}), 150)
          } else node.wet.value = v
        },
        dispose: () => node.dispose(),
      }
    }
    case 'chorus': {
      const node = new Tone.Chorus({ frequency: p.rate, delayTime: 3, depth: p.depth, wet: p.mix }).start()
      return {
        node,
        set: (k, v) => {
          if (k === 'rate') node.frequency.value = v
          else if (k === 'depth') node.depth = v
          else node.wet.value = v
        },
        dispose: () => node.dispose(),
      }
    }
    case 'dist': {
      const node = new Tone.Distortion({ distortion: p.amt, oversample: '4x', wet: p.mix })
      return {
        node,
        set: (k, v) => {
          if (k === 'amt') node.distortion = v
          else node.wet.value = v
        },
        dispose: () => node.dispose(),
      }
    }
    case 'crush': {
      const node = new Tone.BitCrusher(p.bits | 0)
      node.wet.value = p.mix
      return {
        node,
        set: (k, v) => {
          if (k === 'bits') node.bits.value = Math.max(1, v | 0)
          else node.wet.value = v
        },
        dispose: () => node.dispose(),
      }
    }
    case 'comp': {
      const node = new Tone.Compressor({ threshold: p.thresh, ratio: p.ratio, attack: p.attack, release: p.release })
      return {
        node,
        set: (k, v) => {
          if (k === 'thresh') node.threshold.value = v
          else if (k === 'ratio') node.ratio.value = v
          else if (k === 'attack') node.attack.value = v
          else node.release.value = v
        },
        gr: () => (node as any).reduction ?? 0,   // DynamicsCompressor live GR (dB, ≤0)
        dispose: () => node.dispose(),
      }
    }
    case 'opto': {
      const opto = new OptoComp()
      opto.configure((p.mode ?? 0) | 0, p.reduction ?? 0.4, p.gain ?? 0)
      return {
        node: opto,
        set: (k, v) => {
          if (k === 'reduction') opto.setReduction(v)
          else if (k === 'gain') opto.setGain(v)
          else if (k === 'mode') opto.setMode(v | 0)
        },
        gr: () => opto.reduction,
        dispose: () => opto.dispose(),
      }
    }
    case 'mbcomp': {
      // Single AudioWorklet node (sf-mbdyn): 3-band crossover + per-band comp or
      // expander + sum. Module is preloaded at engine start; if it isn't ready
      // yet (or in a context without it), degrade to a clean passthrough.
      const ctx = Tone.getContext().rawContext as AudioContext
      let grLast = [0, 0, 0]
      try {
        const node = new AudioWorkletNode(ctx, 'sf-mbdyn', {
          numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2],
          channelCount: 2, channelCountMode: 'explicit', channelInterpretation: 'speakers',
        })
        node.port.postMessage({ init: p })
        node.port.onmessage = e => { if (e.data?.gr) grLast = e.data.gr as number[] }
        return {
          // a raw AudioWorkletNode IS an AudioNode; Tone.connect handles it at
          // runtime (it only follows .input/.output on real ToneAudioNodes).
          node: node as unknown as Tone.ToneAudioNode,
          set: (k, v) => node.port.postMessage({ k, v }),
          grBands: () => grLast.map(g => -g),   // worklet posts positive dB of reduction
          dispose: () => { try { node.port.onmessage = null; node.disconnect() } catch { /* ok */ } },
        }
      } catch {
        const node = new Tone.Gain(1)
        return { node, set: () => {}, grBands: () => [0, 0, 0], dispose: () => node.dispose() }
      }
    }
    case 'phaser': {
      const node = new Tone.Phaser({ frequency: p.rate, octaves: p.octaves | 0, baseFrequency: 350, wet: p.mix })
      return {
        node,
        set: (k, v) => {
          if (k === 'rate') node.frequency.value = v
          else if (k === 'octaves') node.octaves = v | 0
          else node.wet.value = v
        },
        dispose: () => node.dispose(),
      }
    }
    case 'pingpong': {
      const node = new Tone.PingPongDelay({ delayTime: delaySeconds(p.time), feedback: p.fb, wet: p.mix, maxDelay: 4 })
      return {
        node,
        set: (k, v) => {
          if (k === 'time') node.delayTime.rampTo(delaySeconds(v), 0.05)
          else if (k === 'fb') node.feedback.value = Math.min(0.9, v)
          else node.wet.value = v
        },
        dispose: () => node.dispose(),
      }
    }
    case 'autofilt': {
      const node = new Tone.AutoFilter({ frequency: p.rate, depth: p.depth, baseFrequency: p.base, wet: p.mix, octaves: 3.5 }).start()
      return {
        node,
        set: (k, v) => {
          if (k === 'rate') node.frequency.value = v
          else if (k === 'depth') node.depth.value = v
          else if (k === 'base') node.baseFrequency = v
          else node.wet.value = v
        },
        dispose: () => node.dispose(),
      }
    }
    case 'trem': {
      const node = new Tone.Tremolo({ frequency: p.rate, depth: p.depth, wet: p.mix, spread: 60 }).start()
      return {
        node,
        set: (k, v) => {
          if (k === 'rate') node.frequency.value = v
          else if (k === 'depth') node.depth.value = v
          else node.wet.value = v
        },
        dispose: () => node.dispose(),
      }
    }
    case 'autopan': {
      const node = new Tone.AutoPanner({ frequency: p.rate, depth: p.depth }).start()
      return {
        node,
        set: (k, v) => {
          if (k === 'rate') node.frequency.value = v
          else node.depth.value = v
        },
        dispose: () => node.dispose(),
      }
    }
    case 'vib': {
      const node = new Tone.Vibrato({ frequency: p.rate, depth: p.depth, wet: p.mix })
      return {
        node,
        set: (k, v) => {
          if (k === 'rate') node.frequency.value = v
          else if (k === 'depth') node.depth.value = v
          else node.wet.value = v
        },
        dispose: () => node.dispose(),
      }
    }
    case 'cheby': {
      const node = new Tone.Chebyshev({ order: Math.max(1, p.order | 0), wet: p.mix })
      try { (node as any).oversample = '4x' } catch { /* optional */ }
      return {
        node,
        set: (k, v) => {
          if (k === 'order') node.order = Math.max(1, v | 0)
          else node.wet.value = v
        },
        dispose: () => node.dispose(),
      }
    }
    case 'widen': {
      const node = new Tone.StereoWidener(p.width)
      return {
        node,
        set: (_k, v) => { node.width.value = v },
        dispose: () => node.dispose(),
      }
    }
    case 'shift': {
      const node = new Tone.FrequencyShifter({ frequency: p.amt, wet: p.mix })
      return {
        node,
        set: (k, v) => {
          if (k === 'amt') node.frequency.value = v
          else node.wet.value = v
        },
        dispose: () => node.dispose(),
      }
    }
    case 'duck': {
      // tempo-synced volume ducking ("sidechain pump"): gain dips on each beat
      // boundary and recovers over the cycle. Driven by the engine frame tick
      // so it stays locked to the transport with no clock drift.
      const node = new Tone.Gain(1)
      let amount = p.amount, curve = p.curve, rate = p.rate | 0
      return {
        node,
        set: (k, v) => {
          if (k === 'amount') amount = v
          else if (k === 'curve') curve = v
          else if (k === 'rate') rate = v | 0
        },
        tick: posTicks => {
          const cyc = DUCK_DIV_TICKS[Math.max(0, Math.min(DUCK_DIV_TICKS.length - 1, rate))] || 96
          const phase = (((posTicks % cyc) + cyc) % cyc) / cyc
          const rec = Math.pow(phase, 0.35 + curve * 1.6) // recovery shape
          const g = (1 - amount) + amount * rec
          node.gain.setTargetAtTime(Math.max(0, g), Tone.now(), 0.004)
        },
        dispose: () => node.dispose(),
      }
    }
    case 'autotune': {
      // Monophonic auto-tune: detect the input pitch every frame, snap it to the
      // project key/scale (or chromatic), and drive a granular pitch-shifter by
      // the difference. The analyser taps the DRY input (engine wires prev→detect).
      const ctx = Tone.getContext().rawContext as AudioContext
      const node = new Tone.PitchShift({ windowSize: 0.06, delayTime: 0, feedback: 0 })
      node.wet.value = p.mix ?? 1
      const detect = ctx.createAnalyser()
      detect.fftSize = 2048
      const buf = new Float32Array(detect.fftSize)
      const sr = ctx.sampleRate
      let amount = p.amount ?? 1, speedMs = p.speed ?? 20, mode = (p.mode ?? 0) | 0
      let cur = 0 // current shift (semitones), smoothed toward the target
      return {
        node,
        detect,
        set: (k, v) => {
          if (k === 'amount') amount = v
          else if (k === 'speed') speedMs = v
          else if (k === 'mix') node.wet.value = v
          else if (k === 'mode') mode = v | 0
        },
        tick: () => {
          detect.getFloatTimeDomainData(buf)
          let rms = 0
          for (let i = 0; i < buf.length; i++) rms += buf[i] * buf[i]
          rms = Math.sqrt(rms / buf.length)
          let desired = cur
          if (rms > 0.004) {
            const f = detectPitchHz(buf, sr)
            if (f > 0) {
              const midi = 69 + 12 * Math.log2(f / 440)
              let target: number
              if (mode === 1) target = Math.round(midi)
              else target = snapToScale(Math.round(midi), (meta.get('root') ?? 9) as number, (meta.get('scale') ?? 'minor') as string)
              desired = Math.max(-12, Math.min(12, (target - midi) * amount))
            }
          }
          // exponential glide toward target; ~speedMs time constant at 60fps
          const coeff = 1 - Math.exp(-1 / Math.max(1, (speedMs / 1000) * 60))
          cur += (desired - cur) * coeff
          node.pitch = cur
        },
        dispose: () => { node.dispose(); try { detect.disconnect() } catch { /* ok */ } },
      }
    }
    default: {
      const node = new Tone.Gain(1)
      return { node, set: () => {}, dispose: () => node.dispose() }
    }
  }
}
