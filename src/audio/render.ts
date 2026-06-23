// Offline audio export. Rebuilds the WHOLE project graph inside Tone.Offline at
// the engine's 2x rate (88.2kHz) — mirroring the live signal path so the bounce
// matches what you hear: instrument → per-device output gains → fx chain →
// pan → volume → master, plus send/return buses, audio clips, the sampler,
// live MIDI-fx, sidechain ducking, LFOs and (scene) automation envelopes.
// Then resamples to 44.1kHz and encodes to WAV or MP3, stereo / mono / stems.
//
// Note: Auto-Tune is NOT reproduced offline (its pitch detector needs a live
// AnalyserNode, which doesn't run in an OfflineAudioContext) — use Record
// Output for an auto-tuned bounce. Macros are already baked into param values.

import * as Tone from 'tone'
import { BAR, PPQ, Note, clamp } from '../types'
import { exportProject, arrEndTicks, meta as docMeta, ProjectJSON, TrackJSON, ClipJSON } from '../state/doc'
import { makeInstrument, makeEffect, Inst, Fx } from './devices'
import { instSchema, fxSchema, mixSpec, lfoShapeValue, LFO_DIV_TICKS, valueFromSpec } from './schema'
import { applyMidiFx } from './midifx'
import { getSampleBuffer } from './samples'
import { resample, encodeAudio, download, extFor, AudioFormat, Channels, OUT_SR } from './encode'
import { toast } from '../state/store'

// Preferred offline render rate (mirrors the engine's 2x oversampled graph). The
// ACTUAL rate is taken from the live context at render time and falls back to
// 44.1kHz — older Safari/WebKit reject an OfflineAudioContext at non-44.1k
// rates, which silently broke every bounce while live playback (which has its
// own rate fallback) kept working.
const RENDER_SR = 88200

function ticksToSec(ticks: number, bpm: number) {
  return (ticks / PPQ) * (60 / bpm)
}

export type RenderScope =
  | { kind: 'arr' }
  | { kind: 'loop' }
  | { kind: 'scene'; sceneId: string }

export type ExportOptions = {
  format: AudioFormat
  channels: Channels
  kbps?: number
  stems?: boolean
}

// What slice of the project a single render pass should capture.
type RenderTarget =
  | { kind: 'mix' }
  | { kind: 'track'; idx: number }    // one track only, dry (no return tails)
  | { kind: 'return'; idx: number }   // one return bus, fed by every track's sends

type OffFx = { id: string; type: string; dev: OffDevice; out: Tone.Volume }
type OffTrack = {
  json: TrackJSON
  inst: Inst
  fx: OffFx[]
  panner: StereoPannerNode
  vol: Tone.Volume
  sendA: Tone.Gain
  sendB: Tone.Gain
  loopLen: number
  envEntries: [string, { t: number; v: number }[]][] | null
}

// Tone.PluckSynth (Karplus-Strong) throws AbortError inside an OfflineAudioContext,
// which kills the whole render. Substitute an offline-safe plucky synth so the
// bounce still completes; Record Output captures the real PluckSynth live.
function makeOffInstrument(type: string, params: Record<string, number>, buf?: AudioBuffer): Inst {
  if (type !== 'pluck') return makeInstrument(type, params, buf)
  const out = new Tone.Gain(0.9)
  const synth = new Tone.PolySynth(Tone.Synth).connect(out)
  synth.set({ oscillator: { type: 'triangle' }, envelope: { attack: 0.002, decay: 0.45, sustain: 0, release: 0.4 } })
  const hz = (pp: number) => Tone.Frequency(pp, 'midi').toFrequency()
  return {
    out,
    set: () => {},
    noteOn: (pp, vel) => synth.triggerAttack(hz(pp), undefined, vel),
    noteOff: pp => synth.triggerRelease(hz(pp)),
    trigger: (pp, dur, time, vel) => synth.triggerAttackRelease(hz(pp), Math.min(dur, 0.6), time, vel),
    dispose: () => { synth.dispose(); out.dispose() },
  }
}

// A device with explicit input/output nodes, so reverb (a composite) and normal
// single-node effects share one chain-wiring path.
type OffDevice = { in: Tone.ToneAudioNode; out: Tone.ToneAudioNode; set: (k: string, v: number) => void; tick?: Fx['tick'] }

// Tone.Reverb generates its impulse response with a NESTED Tone.Offline render,
// which aborts inside our outer offline render. Build reverb as a Convolver fed a
// synthesized decaying-noise IR + a dry/wet mix instead (no nested rendering).
function makeOffDevice(type: string, params: Record<string, number>): OffDevice {
  if (type === 'reverb') {
    const ctx = Tone.getContext().rawContext as unknown as BaseAudioContext
    const decay = Math.max(0.1, params.size ?? 2.2)
    const len = Math.max(1, Math.floor(decay * ctx.sampleRate))
    const ir = ctx.createBuffer(2, len, ctx.sampleRate)
    for (let c = 0; c < 2; c++) {
      const d = ir.getChannelData(c)
      for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 2.5)
    }
    const mix = params.mix ?? 0.3
    const input = new Tone.Gain()
    const output = new Tone.Gain()
    const conv = (ctx as unknown as BaseAudioContext).createConvolver()
    conv.normalize = true
    conv.buffer = ir
    const wet = new Tone.Gain(mix)
    const dry = new Tone.Gain(1 - mix)
    input.connect(dry); dry.connect(output)
    Tone.connect(input, conv); Tone.connect(conv, wet); wet.connect(output)
    return { in: input, out: output, set: (k, v) => { if (k === 'mix') { wet.gain.value = v; dry.gain.value = 1 - v } } }
  }
  const fx = makeEffect(type, params)
  return { in: fx.node, out: fx.node, set: fx.set, tick: fx.tick }
}

function envValueAt(pts: { t: number; v: number }[], pos: number, loop: number): number {
  if (pts.length === 1) return pts[0].v
  if (pos <= pts[0].t) return pts[0].v
  const last = pts[pts.length - 1]
  if (pos >= last.t) return last.v
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i], b = pts[i + 1]
    if (pos >= a.t && pos <= b.t) return a.v + (b.v - a.v) * ((pos - a.t) / Math.max(1, b.t - a.t))
  }
  return last.v
}

/** Build one track's full signal chain into the current (offline) context. */
function buildOffTrack(t: TrackJSON, master: Tone.Volume, returnInputs: Tone.ToneAudioNode[], toMaster: boolean): OffTrack {
  const buf = t.inst.type === 'sampler' ? getSampleBuffer(t.inst.sampleId || '') : undefined
  const inst = makeOffInstrument(t.inst.type, t.inst.params, buf)
  const fx: OffFx[] = []
  t.fx.forEach(f => {
    if (!f.on) return
    const dev = makeOffDevice(f.type, f.params)
    fx.push({ id: f.id || f.type, type: f.type, dev, out: new Tone.Volume(f.out ?? 0) })
  })
  const rawCtx = Tone.getContext().rawContext as unknown as BaseAudioContext
  const panner = rawCtx.createStereoPanner()
  panner.pan.value = t.pan
  const vol = new Tone.Volume(t.gain)
  const instOut = new Tone.Volume(t.inst.out ?? 0)
  Tone.connect(inst.out, instOut)
  let prev: Tone.ToneAudioNode = instOut
  fx.forEach(f => {
    Tone.connect(prev, f.dev.in)
    Tone.connect(f.dev.out, f.out)
    prev = f.out
  })
  Tone.connect(prev, panner)
  Tone.connect(panner, vol)
  if (toMaster) vol.connect(master)
  const sendA = new Tone.Gain(t.sendA ?? 0)
  const sendB = new Tone.Gain(t.sendB ?? 0)
  if (returnInputs.length) {
    vol.connect(sendA); vol.connect(sendB)
    if (returnInputs[0]) sendA.connect(returnInputs[0])
    if (returnInputs[1]) sendB.connect(returnInputs[1])
  }
  return { json: t, inst, fx, panner, vol, sendA, sendB, loopLen: BAR, envEntries: null }
}

/** Resolve an LFO/automation target to its spec, base value and live setter. */
function resolveTarget(ot: OffTrack, dest: string, fxId: string, pkey: string) {
  if (dest === 'inst') {
    const spec = instSchema(ot.json.inst.type).params.find(s => s.key === pkey)
    const base = ot.json.inst.params[pkey]
    if (!spec || typeof base !== 'number') return null
    return { spec, base, setter: (v: number) => ot.inst.set(pkey, v) }
  }
  if (dest === 'mix') {
    const spec = mixSpec(pkey)
    const base = pkey === 'gain' ? ot.json.gain : ot.json.pan
    if (!spec || typeof base !== 'number') return null
    return { spec, base, setter: (v: number) => { if (pkey === 'gain') ot.vol.volume.value = v; else ot.panner.pan.value = v } }
  }
  const fxJson = ot.json.fx.find(f => (f.id || f.type) === fxId)
  const bf = ot.fx.find(f => f.id === fxId)
  if (!fxJson || !bf) return null
  const spec = fxSchema(fxJson.type).params.find(s => s.key === pkey)
  const base = fxJson.params[pkey]
  if (!spec || typeof base !== 'number') return null
  return { spec, base, setter: (v: number) => bf.dev.set(pkey, v) }
}

/** Per-frame modulation (sidechain tick + LFOs + scene automation), mirrors the live loop. */
function applyMod(ot: OffTrack, posTicks: number, audioTime: number, bpm: number, withAutomation: boolean) {
  ot.fx.forEach(f => f.dev.tick?.(posTicks, true, bpm))

  const controlled = new Map<string, { dest: string; fxId: string; pkey: string }>()
  const autoNorm = new Map<string, number>()
  const lfoOff = new Map<string, number>()

  if (withAutomation && ot.envEntries) {
    const loop = ot.loopLen || BAR
    const pos = (((posTicks) % loop) + loop) % loop
    for (const [k, pts] of ot.envEntries) {
      if (!pts.length) continue
      autoNorm.set(k, envValueAt(pts, pos, loop))
      const [dest, fxId, pkey] = k.split('|')
      controlled.set(k, { dest, fxId: fxId || '', pkey })
    }
  }

  ot.json.lfos?.forEach(lfo => {
    const raw = lfoShapeValue(lfo.shape | 0,
      lfo.sync
        ? posTicks / (LFO_DIV_TICKS[lfo.rate | 0] || 384) + (lfo.phase ?? 0)
        : audioTime * (lfo.hz ?? 1) + (lfo.phase ?? 0))
    if (!lfo.on || !lfo.pkey || !lfo.dest) return
    const k = `${lfo.dest}|${lfo.fxId || ''}|${lfo.pkey}`
    lfoOff.set(k, (lfoOff.get(k) ?? 0) + raw * (lfo.depth ?? 0.5))
    controlled.set(k, { dest: lfo.dest, fxId: lfo.fxId || '', pkey: lfo.pkey })
  })

  for (const [k, tg] of controlled) {
    const r = resolveTarget(ot, tg.dest, tg.fxId, tg.pkey)
    if (!r) continue
    const base = autoNorm.has(k) ? valueFromSpec(r.spec, autoNorm.get(k)!) : r.base
    const off = (lfoOff.get(k) ?? 0) * (r.spec.max - r.spec.min) * 0.5
    r.setter(clamp(base + off, r.spec.min, r.spec.max))
  }
}

async function renderBuffer(
  project: ProjectJSON,
  scope: RenderScope,
  target: RenderTarget,
  fromTicks: number,
  lengthTicks: number,
  sceneId?: string,
): Promise<AudioBuffer> {
  const bpm = project.meta.bpm
  const root = project.meta.root ?? 9
  const scaleId = project.meta.scale ?? 'minor'
  const durSec = ticksToSec(lengthTicks, bpm) + 1.5 // reverb/release tail
  // Render at the SAME rate the live engine is actually running (read before
  // Tone.Offline swaps the context) so the bounce matches what's heard; if the
  // browser won't open an OfflineAudioContext at that rate, fall back below.
  const liveSr = Tone.getContext().sampleRate || RENDER_SR

  const build: Parameters<typeof Tone.Offline>[0] = async ({ transport }) => {
    transport.PPQ = PPQ
    transport.bpm.value = bpm
    transport.swing = project.meta.swing
    transport.swingSubdivision = '16n'

    // stereo-preserving master (Tone.Channel would downmix)
    const master = new Tone.Volume(project.meta.masterGain ?? 0)
    const limiter = new Tone.Limiter(-1)
    master.chain(limiter, Tone.getDestination())

    // return buses (none for a dry track stem; all for the mix; one for a return stem)
    const returns: { input: Tone.ToneAudioNode }[] = []
    const wantReturns = target.kind !== 'track'
    if (wantReturns) {
      ;(project.returns ?? []).forEach((r, ri) => {
        if (target.kind === 'return' && ri !== target.idx) { returns.push({ input: new Tone.Gain() }); return }
        const dev = makeOffDevice(r.fxType, r.params)
        const channel = new Tone.Volume(r.gain ?? 0)
        dev.out.connect(channel)
        channel.connect(master)
        returns.push({ input: dev.in })
      })
    }
    const returnInputs = returns.map(r => r.input)

    const offTracks: OffTrack[] = []
    project.tracks.forEach((t, idx) => {
      if (target.kind === 'track' && idx !== target.idx) return
      if (t.mute && target.kind === 'mix') return
      // tracks feed master directly except on a return stem (where we want only the wet send)
      const toMaster = target.kind !== 'return'
      const ot = buildOffTrack(t, master, returnInputs, toMaster)
      offTracks.push(ot)

      const isDrum = t.kind === 'drum'
      const midifx = (t.midifx ?? []).map(d => ({ type: d.type, on: d.on, params: d.params }))
      const tid = t.id ?? t.name

      const scheduleClip = (clip: ClipJSON, startTicks: number, lenTicks: number, loop: boolean) => {
        if (clip.audio) {
          const sbuf = getSampleBuffer(clip.audio.sampleId || '')
          if (!sbuf) return
          const player = new Tone.Player(sbuf as any)
          player.loop = !!clip.audio.loop
          player.playbackRate = Math.pow(2, (clip.audio.pitch ?? 0) / 12)
          player.reverse = !!clip.audio.rev
          try { player.fadeIn = Math.max(0, Tone.Ticks(clip.audio.fadeIn ?? 0).toSeconds()) } catch { /* ok */ }
          try { player.fadeOut = Math.max(0, Tone.Ticks(clip.audio.fadeOut ?? 0).toSeconds()) } catch { /* ok */ }
          player.volume.value = clip.audio.gainDb ?? 0
          Tone.connect(player, ot.inst.out)
          player.sync().start(`${startTicks}i`)
          if (!loop) player.stop(`${startTicks + lenTicks}i`)
          return
        }
        let notes: Note[] = Object.values(clip.notes).map(n => ({ ...n }))
        notes = applyMidiFx(midifx, notes, lenTicks, root, scaleId, isDrum)
        const events = notes.map(n => ({ time: `${n.s}i`, ...n }))
        const part = new Tone.Part((time, ev: any) => {
          if (ev.pr < 1 && Math.random() > ev.pr) return
          ot.inst.trigger(ev.p, Math.max(0.02, Tone.Ticks(ev.d).toSeconds()), time, ev.v)
        }, events as any)
        part.loop = loop
        part.loopStart = 0
        part.loopEnd = `${lenTicks}i`
        part.start(`${startTicks}i`)
        if (!loop) part.stop(`${startTicks + lenTicks}i`)
      }

      if (scope.kind === 'scene') {
        const clip = project.clips[`${tid}|${sceneId}`]
        if (clip) {
          ot.loopLen = clip.len
          if (clip.env) ot.envEntries = Object.entries(clip.env)
          scheduleClip(clip, 0, clip.len, true)
        }
      } else {
        Object.values(project.arr).forEach(a => {
          if (a.trackId !== tid) return
          scheduleClip(a, a.start, a.len, true)
        })
      }
    })

    // per-frame modulation: sidechain ducking, LFOs, and (scene) automation
    const withAutomation = scope.kind === 'scene'
    transport.scheduleRepeat(time => {
      const posTicks = transport.getTicksAtTime(time)
      for (const ot of offTracks) applyMod(ot, posTicks, time, bpm, withAutomation)
    }, '32n', 0)

    transport.start(0.02, `${fromTicks}i`)
  }

  let rendered: Tone.ToneAudioBuffer
  try {
    rendered = await Tone.Offline(build, durSec, 2, liveSr)
  } catch (e) {
    // e.g. older Safari rejecting a non-44.1k OfflineAudioContext. Retry once at
    // the universally-supported rate so the export still completes (resample()
    // already normalises everything to 44.1kHz before encoding).
    if (liveSr === OUT_SR) throw e
    console.warn(`Offline render at ${liveSr}Hz failed (${(e as Error)?.message || e}); retrying at ${OUT_SR}Hz`)
    rendered = await Tone.Offline(build, durSec, 2, OUT_SR)
  }

  return rendered.get() as AudioBuffer
}

function fileTitle(project: ProjectJSON) {
  return project.meta.title.replace(/[^\w\- ]+/g, '') || 'synthtagram'
}

function scopeBounds(project: ProjectJSON, scope: RenderScope): { from: number; ticks: number; sceneId?: string } | null {
  const loopStart = docMeta.get('loopStart') ?? 0
  const loopEnd = docMeta.get('loopEnd') ?? BAR * 4
  if (scope.kind === 'loop') return { from: loopStart, ticks: Math.max(BAR, loopEnd - loopStart) }
  if (scope.kind === 'scene') {
    let longest = BAR
    for (const [key, c] of Object.entries(project.clips)) if (key.endsWith(`|${scope.sceneId}`)) longest = Math.max(longest, c.len)
    return { from: 0, ticks: longest * 2, sceneId: scope.sceneId }
  }
  const ticks = Math.max(BAR, arrEndTicks())
  if (ticks <= BAR && Object.keys(project.arr).length === 0) return null
  return { from: 0, ticks }
}

/** Render + encode + download in the chosen format / channels, optionally as stems. */
export async function exportAudio(scope: RenderScope, opts: ExportOptions) {
  const project = exportProject()
  const title = fileTitle(project)
  const bounds = scopeBounds(project, scope)
  if (!bounds) { toast('Arrangement is empty — drag some clips in first'); return }
  const { from, ticks, sceneId } = bounds
  const ext = extFor(opts.format)
  const enc = (buf: AudioBuffer) => encodeAudio(buf, opts.format, opts.channels, opts.kbps)

  toast(opts.stems ? 'Rendering stems…' : `Rendering ${opts.format.toUpperCase()}…`)
  try {
    if (opts.stems) {
      for (let i = 0; i < project.tracks.length; i++) {
        const buf = await renderBuffer(project, scope, { kind: 'track', idx: i }, from, ticks, sceneId)
        download(enc(await resample(buf)), `${title} - ${project.tracks[i].name}.${ext}`)
        await new Promise(r => setTimeout(r, 250))
      }
      // return buses as their own stems so a stem set fully reconstructs the mix
      for (let r = 0; r < (project.returns?.length ?? 0); r++) {
        const buf = await renderBuffer(project, scope, { kind: 'return', idx: r }, from, ticks, sceneId)
        download(enc(await resample(buf)), `${title} - ${project.returns![r].name || `Return ${r + 1}`}.${ext}`)
        await new Promise(r => setTimeout(r, 250))
      }
      toast(`Exported stems ✓`)
    } else {
      const buf = await renderBuffer(project, scope, { kind: 'mix' }, from, ticks, sceneId)
      download(enc(await resample(buf)), `${title}.${ext}`)
      toast(`Exported ${opts.format.toUpperCase()} ✓`)
    }
  } catch (e) {
    console.error(e)
    const msg = (e as Error)?.message || String(e)
    toast(`Export failed: ${msg.slice(0, 120)}`)
  }
}

export function exportProjectFile() {
  const project = exportProject()
  const blob = new Blob([JSON.stringify(project, null, 2)], { type: 'application/json' })
  download(blob, `${project.meta.title.replace(/[^\w\- ]+/g, '') || 'project'}.synthtagram.json`)
  toast('Project file saved')
}
