// Tone.js implementations of every instrument & effect module.
// Factories build into whatever Tone context is current, so the same code
// powers live playback AND offline WAV rendering (engine swaps the context).
// The app runs its context at 2x sample rate (88.2kHz) so FM/waveshaping
// stay clean; Drive additionally oversamples its waveshaper 4x.

import * as Tone from 'tone'
import { WAVES, DELAY_FRACTIONS, DUCK_DIV_TICKS } from './schema'

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
  dispose: () => void
}

const midiHz = (p: number) => Tone.Frequency(p, 'midi').toFrequency()

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
    noteOn: (pp, vel) => synth.triggerAttack(midiHz(pp), undefined, vel),
    noteOff: pp => synth.triggerRelease(midiHz(pp)),
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
    noteOn: (pp, vel) => (synth as any).triggerAttack(midiHz(pp), undefined, vel),
    noteOff: pp => (synth as any).triggerRelease(midiHz(pp)),
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
    noteOn: (pp, vel) => synth.triggerAttack(midiHz(pp), undefined, vel),
    noteOff: pp => synth.triggerRelease(midiHz(pp)),
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
    noteOn: (pp, vel) => synth.triggerAttack(midiHz(pp), undefined, vel),
    noteOff: () => synth.triggerRelease(),
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
    noteOn: (pp, vel) => next().triggerAttack(midiHz(pp), undefined as any),
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
    noteOn: (pp, vel) => synth.triggerAttack(midiHz(pp), undefined, vel),
    noteOff: pp => synth.triggerRelease(midiHz(pp)),
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

function makeDrum(p: Record<string, number>): Inst {
  const mix = new Tone.Gain(1)
  const pads: Pad[] = [
    membranePad(mix, 36, p.p0_decay, 0.05),  // kick
    noisePad(mix, 'snare', p.p1_decay),      // snare
    noisePad(mix, 'clap', p.p2_decay),       // clap
    noisePad(mix, 'clhat', p.p3_decay),      // closed hat
    noisePad(mix, 'ophat', p.p4_decay),      // open hat
    membranePad(mix, 48, p.p5_decay, 0.03),  // lo tom
    blipPad(mix, 1100, p.p6_decay),          // perc
    noisePad(mix, 'crash', p.p7_decay),      // crash
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
    noteOn: (pp, vel) => pads[pp % pads.length]?.trig(Tone.now(), vel),
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
    noteOn: (pp, vel) => sampler.triggerAttack(hz(pp), undefined, vel),
    noteOff: pp => sampler.triggerRelease(hz(pp)),
    trigger: (pp, dur, time, vel) => sampler.triggerAttackRelease(hz(pp), dur, time, vel),
    dispose: () => { sampler.dispose(); out.dispose() },
  }
}

export function makeInstrument(type: string, params: Record<string, number>, buffer?: AudioBuffer): Inst {
  switch (type) {
    case 'fm': return makeFm(params)
    case 'mono': return makeMono(params)
    case 'pluck': return makePluck(params)
    case 'keys': return makeKeys(params)
    case 'duo': return makeDuo(params)
    case 'sampler': return makeSampler(params, buffer)
    case 'drum': return makeDrum(params)
    default: return makePoly(params)
  }
}

// ---------------- effects ----------------

function delaySeconds(idx: number) {
  const bpm = Tone.getTransport().bpm.value
  const whole = (60 / bpm) * 4
  return whole * DELAY_FRACTIONS[Math.max(0, Math.min(DELAY_FRACTIONS.length - 1, idx | 0))]
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
        dispose: () => node.dispose(),
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
    default: {
      const node = new Tone.Gain(1)
      return { node, set: () => {}, dispose: () => node.dispose() }
    }
  }
}
