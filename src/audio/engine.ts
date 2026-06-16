// The conductor: owns the Tone.js context/transport, builds each track's
// instrument→fx→channel chain from the shared doc, and reacts to remote edits
// live (a friend's knob tweak retunes your audio within one frame).
//
// Playback is intentionally LOCAL per user (like every collaborative DAW):
// the *project* is shared in real time, the *transport* is yours.

import * as Tone from 'tone'
import * as Y from 'yjs'
import { BAR, STEP16, Note, clamp } from '../types'
import {
  meta, tracks, clips, arr, clipKey, notesOf, addNote, updateNotes,
  createClip, trackById, returns, ensureReturns, midifxOf, envKeys, envPoints, followOf, scenes, sceneIndex,
  isAudioClip,
} from '../state/doc'
import { makeInstrument, makeEffect, Inst, Fx } from './devices'
import { instSchema, fxSchema, lfoShapeValue, LFO_DIV_TICKS, mixSpec, midiFxSchema, ARP_DIV_TICKS } from './schema'
import { getSampleBuffer, onSampleReady } from './samples'
import { snapToScale } from '../theory'
import { setUI, toast, ui } from '../state/store'

const STOP = '__stop__'

type BuiltFx = { id: string; type: string; fx: Fx }
type BuiltTrack = {
  id: string
  kind: string
  inst: Inst
  fx: BuiltFx[]
  panner: StereoPannerNode
  vol: Tone.Volume
  meter: Tone.Meter
  sendA: Tone.Gain
  sendB: Tone.Gain
  part: Tone.Part | null
  player: Tone.Player | null
  partKey: string | null
  partStartTicks: number
  partLoopTicks: number
  queuedKey: string | null
  queuedPart: Tone.Part | null
  unobserve: (() => void) | null
}

type BuiltReturn = { id: string; fx: Fx; channel: Tone.Volume }

class Engine {
  started = false
  mode: 'session' | 'arr' = 'session'
  built = new Map<string, BuiltTrack>()
  master!: Tone.Volume
  masterMeter!: Tone.Meter
  arrParts: Array<Tone.Part | Tone.Player> = []
  arrSeekTicks = 0
  sampleRate = 0
  private metro!: Tone.Synth
  private rebuildTimers = new Map<string, ReturnType<typeof setTimeout>>()
  private partTimers = new Map<string, ReturnType<typeof setTimeout>>()
  private arrTimer: ReturnType<typeof setTimeout> | null = null
  private pendingRec = new Map<number, { clipMap: Y.Map<any>; startInClip: number; vel: number }>()

  // ---- LFO / automation modulation (local per client; runs at frame rate) ----
  private modRAF = 0
  private lfoVals = new Map<string, number>()  // lfoId -> current raw value [-1,1]
  private activeMod = new Map<string, { tid: string; dest: string; fxId: string; pkey: string }>()

  // ---- send/return buses + master analysers ----
  private builtReturns: BuiltReturn[] = []
  private masterFFT!: Tone.Analyser
  private masterWave!: Tone.Analyser
  private followTimers = new Map<string, number>()

  // ---- tiny emitter so React can follow launch-state changes ----
  version = 0
  private listeners = new Set<() => void>()
  subscribe = (fn: () => void) => {
    this.listeners.add(fn)
    return () => { this.listeners.delete(fn) }
  }
  private emit() {
    this.version++
    this.listeners.forEach(l => l())
  }

  get transport() {
    return Tone.getTransport()
  }

  async ensureStarted() {
    if (this.started) return
    this.started = true
    // 2x-oversampled engine: run the whole graph at 88.2kHz, the browser
    // resamples to the hardware rate on output. FM & nonlinear fx stay clean.
    try {
      const ctx = new AudioContext({ sampleRate: 88200, latencyHint: 'interactive' })
      Tone.setContext(ctx)
    } catch {
      // fall back to default-rate context (older Safari)
    }
    await Tone.start()
    this.sampleRate = Tone.getContext().sampleRate

    const t = this.transport
    t.PPQ = 96
    t.bpm.value = meta.get('bpm') ?? 120
    t.swing = meta.get('swing') ?? 0
    t.swingSubdivision = '16n'

    // Tone.Channel downmixes stereo input to mono (its PanVol has a 1-channel
    // input); use a plain stereo-preserving Volume for the master & returns.
    this.master = new Tone.Volume(meta.get('masterGain') ?? 0)
    const limiter = new Tone.Limiter(-1)
    this.masterMeter = new Tone.Meter({ smoothing: 0.85 })
    this.masterFFT = new Tone.Analyser('fft', 1024)
    this.masterWave = new Tone.Analyser('waveform', 1024)
    this.master.chain(limiter, Tone.getDestination())
    this.master.connect(this.masterMeter)
    this.master.connect(this.masterFFT)
    this.master.connect(this.masterWave)

    ensureReturns()
    this.buildReturns()
    returns.observeDeep(this.onReturnsDeep)
    onSampleReady(id => {
      // a sample finished loading/decoding → rebuild any sampler using it
      tracks.forEach(t => {
        if (t.get('inst')?.get('type') === 'sampler' && t.get('inst')?.get('sampleId') === id) {
          this.scheduleRebuildTrack(t.get('id'))
        }
      })
    })

    this.metro = new Tone.Synth({
      oscillator: { type: 'sine' },
      envelope: { attack: 0.001, decay: 0.05, sustain: 0, release: 0.01 },
    }).connect(this.master)
    t.scheduleRepeat(time => {
      if (!ui.metronome) return
      const ticks = t.getTicksAtTime(time)
      const accent = ticks % BAR === 0
      this.metro.triggerAttackRelease(accent ? 1760 : 1175, 0.03, time, accent ? 0.5 : 0.25)
    }, '4n')

    this.buildAll()
    tracks.observeDeep(this.onTracksDeep)
    clips.observe(this.onClipsShallow)
    arr.observeDeep(this.onArrDeep)
    meta.observe(this.onMeta)
    this.startModLoop()
    setUI({ audioReady: true })
    this.emit()
  }

  // ---------------- LFO modulation loop ----------------
  // Each client locally oscillates mapped parameters around their doc base
  // value. The LFO *config* is shared (Yjs), the per-frame modulation is local
  // — same model as playback. Restores the base value when a mapping is removed.

  private startModLoop() {
    const tick = () => {
      this.modRAF = requestAnimationFrame(tick)
      try { this.applyModulation() } catch { /* never kill the loop */ }
    }
    this.modRAF = requestAnimationFrame(tick)
  }

  /** Free-running tick position so synced LFOs animate even when stopped. */
  private freeTicks() {
    return Tone.now() * (this.transport.bpm.value / 60) * 96
  }

  private findFxMap(t: Y.Map<any>, fxId: string): Y.Map<any> | undefined {
    const a = t.get('fx') as Y.Array<Y.Map<any>>
    for (let i = 0; i < a.length; i++) if (a.get(i).get('id') === fxId) return a.get(i)
    return undefined
  }

  /** Resolve a modulation/automation target to its spec, base value and live setter. */
  private resolveTarget(t: Y.Map<any>, rec: BuiltTrack, dest: string, fxId: string, pkey: string) {
    if (dest === 'inst') {
      const spec = instSchema(t.get('inst').get('type')).params.find(s => s.key === pkey)
      const base = (t.get('inst').get('params') as Y.Map<number>).get(pkey)
      if (!spec || typeof base !== 'number') return null
      return { spec, base, setter: (v: number) => rec.inst.set(pkey, v) }
    }
    if (dest === 'mix') {
      const spec = mixSpec(pkey)
      const base = t.get(pkey)
      if (!spec || typeof base !== 'number') return null
      const setter = (v: number) => { if (pkey === 'gain') rec.vol.volume.rampTo(v, 0.02); else rec.panner.pan.setTargetAtTime(v, Tone.now(), 0.02) }
      return { spec, base, setter }
    }
    const fxMap = this.findFxMap(t, fxId)
    const bf = rec.fx.find(f => f.id === fxId)
    if (!fxMap || !bf) return null
    const spec = fxSchema(fxMap.get('type')).params.find(s => s.key === pkey)
    const base = (fxMap.get('params') as Y.Map<number>).get(pkey)
    if (!spec || typeof base !== 'number') return null
    return { spec, base, setter: (v: number) => bf.fx.set(pkey, v) }
  }

  private applyModulation() {
    const newActive = new Map<string, { tid: string; dest: string; fxId: string; pkey: string }>()
    const playing = this.transport.state === 'started'
    const syncedPos = playing ? this.transport.ticks : this.freeTicks()
    const audioTime = Tone.now()

    for (const t of tracks.toArray()) {
      const tid = t.get('id') as string
      const rec = this.built.get(tid)
      if (!rec) continue

      // tempo-synced effect ticks (sidechain ducker, etc.)
      const bpm = this.transport.bpm.value
      rec.fx.forEach(bf => bf.fx.tick?.(syncedPos, playing, bpm))

      const controlled = new Map<string, { dest: string; fxId: string; pkey: string }>()
      const autoNorm = new Map<string, number>()
      const lfoOff = new Map<string, number>()

      // ---- automation: the playing session clip's envelopes ----
      if (this.mode === 'session' && rec.partKey && playing) {
        const clipMap = clips.get(rec.partKey) as Y.Map<any> | undefined
        if (clipMap) {
          const loop = rec.partLoopTicks || BAR
          const pos = (((this.transport.ticks - rec.partStartTicks) % loop) + loop) % loop
          for (const k of envKeys(clipMap)) {
            const pts = envPoints(clipMap, k)
            if (!pts.length) continue
            autoNorm.set(k, this.envValueAt(pts, pos, loop))
            const [dest, fxId, pkey] = k.split('|')
            controlled.set(k, { dest, fxId: fxId || '', pkey })
          }
        }
      }

      // ---- LFOs: add a bipolar offset on top ----
      const lfos = t.get('lfos') as Y.Array<Y.Map<any>> | undefined
      lfos?.forEach(lfo => {
        const raw = lfoShapeValue(lfo.get('shape') | 0,
          lfo.get('sync')
            ? syncedPos / (LFO_DIV_TICKS[lfo.get('rate') | 0] || 384) + (lfo.get('phase') ?? 0)
            : audioTime * (lfo.get('hz') ?? 1) + (lfo.get('phase') ?? 0))
        this.lfoVals.set(lfo.get('id'), raw)
        const pkey = lfo.get('pkey') as string
        const dest = lfo.get('dest') as string
        if (!lfo.get('on') || !pkey || !dest) return
        const fxId = (lfo.get('fxId') as string) || ''
        const k = `${dest}|${fxId}|${pkey}`
        lfoOff.set(k, (lfoOff.get(k) ?? 0) + raw * (lfo.get('depth') ?? 0.5))
        controlled.set(k, { dest, fxId, pkey })
      })

      // ---- combine automation base + LFO offset, apply once per param ----
      for (const [k, tg] of controlled) {
        const r = this.resolveTarget(t, rec, tg.dest, tg.fxId, tg.pkey)
        if (!r) continue
        const base = autoNorm.has(k) ? r.spec.min + autoNorm.get(k)! * (r.spec.max - r.spec.min) : r.base
        const off = (lfoOff.get(k) ?? 0) * (r.spec.max - r.spec.min) * 0.5
        r.setter(clamp(base + off, r.spec.min, r.spec.max))
        newActive.set(`${tid}|${k}`, { tid, dest: tg.dest, fxId: tg.fxId, pkey: tg.pkey })
      }
    }

    // params modulated last frame but not now → snap back to their base value
    for (const [k, m] of this.activeMod) {
      if (!newActive.has(k)) this.restoreParam(m)
    }
    this.activeMod = newActive
  }

  private envValueAt(pts: { t: number; v: number }[], pos: number, loop: number): number {
    if (pts.length === 1) return pts[0].v
    if (pos <= pts[0].t) return pts[0].v
    const last = pts[pts.length - 1]
    if (pos >= last.t) return last.v
    for (let i = 0; i < pts.length - 1; i++) {
      const a = pts[i], b = pts[i + 1]
      if (pos >= a.t && pos <= b.t) {
        const f = (pos - a.t) / Math.max(1, b.t - a.t)
        return a.v + (b.v - a.v) * f
      }
    }
    return last.v
  }

  private restoreParam(m: { tid: string; dest: string; fxId: string; pkey: string }) {
    const t = trackById(m.tid)
    const rec = this.built.get(m.tid)
    if (!t || !rec) return
    const r = this.resolveTarget(t, rec, m.dest, m.fxId, m.pkey)
    if (r) r.setter(r.base)
  }

  /** Live LFO output [-1,1] for the UI indicator. */
  lfoValue(lfoId: string) {
    return this.lfoVals.get(lfoId) ?? 0
  }

  // ---------------- master analysers ----------------
  getSpectrum(): Float32Array {
    return (this.masterFFT?.getValue() as Float32Array) ?? new Float32Array(0)
  }
  getWaveform(): Float32Array {
    return (this.masterWave?.getValue() as Float32Array) ?? new Float32Array(0)
  }
  /** Rough fundamental-frequency estimate (autocorrelation) for the tuner. */
  getPitchHz(): number {
    const buf = this.getWaveform()
    if (!buf.length) return 0
    const sr = this.sampleRate || 44100
    let rms = 0
    for (let i = 0; i < buf.length; i++) rms += buf[i] * buf[i]
    if (Math.sqrt(rms / buf.length) < 0.01) return 0
    let bestLag = -1, bestCorr = 0
    for (let lag = 8; lag < buf.length / 2; lag++) {
      let c = 0
      for (let i = 0; i < buf.length / 2; i++) c += buf[i] * buf[i + lag]
      if (c > bestCorr) { bestCorr = c; bestLag = lag }
    }
    return bestLag > 0 ? sr / bestLag : 0
  }

  // ---------------- graph building ----------------

  private buildTrack(t: Y.Map<any>) {
    const tid = t.get('id') as string
    const it = t.get('inst') as Y.Map<any>
    const buf = it.get('type') === 'sampler' ? getSampleBuffer(it.get('sampleId') || '') : undefined
    const inst = makeInstrument(it.get('type'), (it.get('params') as Y.Map<number>).toJSON(), buf)
    const fx: BuiltFx[] = []
    ;(t.get('fx') as Y.Array<Y.Map<any>>).forEach(f => {
      if (f.get('on')) fx.push({ id: f.get('id'), type: f.get('type'), fx: makeEffect(f.get('type'), (f.get('params') as Y.Map<number>).toJSON()) })
    })
    // Stereo-preserving strip: pan → volume. We use a RAW StereoPannerNode
    // because Tone.Panner (like Tone.Channel) downmixes stereo input to mono —
    // which would flatten stereo samples and stereo effects.
    const ctx = Tone.getContext().rawContext as AudioContext
    const panner = ctx.createStereoPanner()
    panner.pan.value = t.get('pan') ?? 0
    const vol = new Tone.Volume(t.get('gain') ?? 0)
    const meter = new Tone.Meter({ smoothing: 0.8 })
    const chainNodes: any[] = [inst.out, ...fx.map(f => f.fx.node)]
    for (let i = 0; i < chainNodes.length - 1; i++) Tone.connect(chainNodes[i], chainNodes[i + 1])
    Tone.connect(chainNodes[chainNodes.length - 1], panner)
    Tone.connect(panner, vol)
    vol.connect(this.master)
    vol.connect(meter)
    // post-fader sends feed the return buses
    const sendA = new Tone.Gain(t.get('sendA') ?? 0)
    const sendB = new Tone.Gain(t.get('sendB') ?? 0)
    vol.connect(sendA)
    vol.connect(sendB)
    const rec: BuiltTrack = {
      id: tid, kind: t.get('kind'), inst, fx, panner, vol, meter, sendA, sendB,
      part: null, player: null, partKey: null, partStartTicks: 0, partLoopTicks: BAR,
      queuedKey: null, queuedPart: null, unobserve: null,
    }
    this.built.set(tid, rec)
    this.wireSends(rec)
    this.applyMuteSolo()
    return rec
  }

  /** Mute = own mute OR (some track soloed AND this one isn't). Engine-coordinated. */
  private applyMuteSolo() {
    const soloAny = tracks.toArray().some(t => t.get('solo'))
    for (const t of tracks.toArray()) {
      const rec = this.built.get(t.get('id'))
      if (rec) rec.vol.mute = !!t.get('mute') || (soloAny && !t.get('solo'))
    }
  }

  private wireSends(rec: BuiltTrack) {
    try { rec.sendA.disconnect() } catch { /* ok */ }
    try { rec.sendB.disconnect() } catch { /* ok */ }
    if (this.builtReturns[0]) rec.sendA.connect(this.builtReturns[0].fx.node)
    if (this.builtReturns[1]) rec.sendB.connect(this.builtReturns[1].fx.node)
  }

  // ---------------- return buses ----------------
  private buildReturns() {
    this.builtReturns.forEach(r => { try { r.fx.dispose(); r.channel.dispose() } catch { /* ok */ } })
    this.builtReturns = []
    returns.forEach(r => {
      const fx = makeEffect(r.get('fxType'), (r.get('params') as Y.Map<number>).toJSON())
      const channel = new Tone.Volume(r.get('gain') ?? 0)
      fx.node.connect(channel)
      channel.connect(this.master)
      this.builtReturns.push({ id: r.get('id'), fx, channel })
    })
    this.built.forEach(rec => this.wireSends(rec))
  }

  private onReturnsDeep = (events: Y.YEvent<any>[]) => {
    if (!this.started) return
    let structural = false
    for (const ev of events) {
      const path = ev.path
      if (path.length === 0) { structural = true; continue }
      const idx = path[0] as number
      const br = this.builtReturns[idx]
      const rm = returns.get(idx)
      if (!br || !rm) { structural = true; continue }
      if (path.length === 1) {
        ev.changes.keys.forEach((_c, key) => {
          if (key === 'gain') br.channel.volume.rampTo(rm.get('gain') ?? 0, 0.05)
          else if (key === 'fxType') structural = true
        })
      } else if (path[path.length - 1] === 'params' || path[1] === 'params') {
        ev.changes.keys.forEach((_c, key) => {
          const v = (ev.target as Y.Map<number>).get(key)
          if (typeof v === 'number') br.fx.set(key, v)
        })
      }
    }
    if (structural) this.buildReturns()
  }

  private disposeTrack(rec: BuiltTrack) {
    this.stopTrackNow(rec)
    try {
      rec.inst.dispose()
      rec.fx.forEach(f => f.fx.dispose())
      rec.panner.disconnect()
      rec.vol.dispose()
      rec.meter.dispose()
      rec.sendA.dispose()
      rec.sendB.dispose()
    } catch { /* dispose races are harmless */ }
    this.built.delete(rec.id)
  }

  buildAll() {
    const ids = new Set<string>()
    tracks.forEach(t => ids.add(t.get('id')))
    ;[...this.built.values()].filter(r => !ids.has(r.id)).forEach(r => this.disposeTrack(r))
    tracks.forEach(t => {
      if (!this.built.has(t.get('id'))) this.buildTrack(t)
    })
    this.emit()
  }

  private rebuildTrack(tid: string) {
    if (!this.started) return
    const t = trackById(tid)
    const old = this.built.get(tid)
    const wasPlaying = old?.partKey ?? null
    if (old) this.disposeTrack(old)
    if (!t) { this.emit(); return }
    this.buildTrack(t)
    // resume the session clip that was playing, in phase with the transport
    if (wasPlaying && this.transport.state === 'started' && this.mode === 'session') {
      this.startPartNow(tid, wasPlaying)
    }
    this.emit()
  }

  private scheduleRebuildTrack(tid: string) {
    const prev = this.rebuildTimers.get(tid)
    if (prev) clearTimeout(prev)
    this.rebuildTimers.set(tid, setTimeout(() => {
      this.rebuildTimers.delete(tid)
      this.rebuildTrack(tid)
    }, 60))
  }

  // ---------------- doc observers ----------------

  private onTracksDeep = (events: Y.YEvent<any>[]) => {
    if (!this.started) return
    let membership = false
    const structural = new Set<string>()
    for (const ev of events) {
      const path = ev.path
      if (path.length === 0) { membership = true; continue }
      const t = tracks.get(path[0] as number)
      if (!t) { membership = true; continue }
      const tid = t.get('id') as string
      const rec = this.built.get(tid)
      if (!rec) { structural.add(tid); continue }
      if (path.length === 1) {
        ev.changes.keys.forEach((_c, key) => {
          if (key === 'gain') rec.vol.volume.rampTo(t.get('gain'), 0.05)
          else if (key === 'pan') rec.panner.pan.setTargetAtTime(t.get('pan'), Tone.now(), 0.03)
          else if (key === 'mute') this.applyMuteSolo()
          else if (key === 'solo') this.applyMuteSolo()
          else if (key === 'sendA') rec.sendA.gain.rampTo(t.get('sendA') ?? 0, 0.03)
          else if (key === 'sendB') rec.sendB.gain.rampTo(t.get('sendB') ?? 0, 0.03)
          else if (key === 'inst' || key === 'fx') structural.add(tid)
          else if (key === 'midifx') this.refreshPart(rec)
        })
      } else if (path[1] === 'midifx') {
        this.refreshPart(rec)
      } else if (path[1] === 'inst') {
        if (path[path.length - 1] === 'params') {
          ev.changes.keys.forEach((_c, key) => {
            const v = (ev.target as Y.Map<number>).get(key)
            if (typeof v === 'number') rec.inst.set(key, v)
          })
        } else structural.add(tid)
      } else if (path[1] === 'fx') {
        if (path.length >= 4 && path[3] === 'params') {
          const fxMap = (t.get('fx') as Y.Array<Y.Map<any>>).get(path[2] as number)
          const bf = fxMap && rec.fx.find(f => f.id === fxMap.get('id'))
          if (bf) {
            ev.changes.keys.forEach((_c, key) => {
              const v = (ev.target as Y.Map<number>).get(key)
              if (typeof v === 'number') bf.fx.set(key, v)
            })
          } else structural.add(tid)
        } else structural.add(tid)
      }
    }
    if (membership) this.buildAll()
    structural.forEach(tid => this.scheduleRebuildTrack(tid))
  }

  private onClipsShallow = (ev: Y.YMapEvent<any>) => {
    ev.changes.keys.forEach((change, key) => {
      if (change.action === 'delete') {
        for (const rec of this.built.values()) {
          if (rec.partKey === key) this.stopTrackNow(rec)
          if (rec.queuedKey === key) {
            this.cancelQueued(rec)
            rec.queuedKey = null
          }
        }
        this.emit()
      }
    })
  }

  private onArrDeep = () => {
    if (!this.started || this.mode !== 'arr') return
    if (this.arrTimer) clearTimeout(this.arrTimer)
    this.arrTimer = setTimeout(() => {
      this.arrTimer = null
      if (this.mode === 'arr' && this.transport.state === 'started') {
        this.clearArrParts()
        this.buildArrParts()
      }
    }, 150)
  }

  private onMeta = (ev: Y.YMapEvent<any>) => {
    if (!this.started) return
    const t = this.transport
    ev.changes.keys.forEach((_c, key) => {
      if (key === 'bpm') {
        t.bpm.rampTo(meta.get('bpm'), 0.1)
        // tempo-synced delays follow the new tempo
        setTimeout(() => this.refreshDelays(), 150)
      } else if (key === 'swing') t.swing = meta.get('swing') ?? 0
      else if (key === 'masterGain') this.master.volume.rampTo(meta.get('masterGain') ?? 0, 0.05)
      else if (key === 'loopOn' || key === 'loopStart' || key === 'loopEnd') this.applyLoopRegion()
    })
  }

  private refreshDelays() {
    for (const t of tracks.toArray()) {
      const rec = this.built.get(t.get('id'))
      if (!rec) continue
      ;(t.get('fx') as Y.Array<Y.Map<any>>).forEach(f => {
        if (f.get('type') === 'delay') {
          const bf = rec.fx.find(x => x.id === f.get('id'))
          bf?.fx.set('time', (f.get('params') as Y.Map<number>).get('time') ?? 2)
        }
      })
    }
  }

  private applyLoopRegion() {
    const t = this.transport
    if (this.mode === 'arr' && meta.get('loopOn')) {
      t.setLoopPoints(`${meta.get('loopStart') ?? 0}i`, `${Math.max((meta.get('loopStart') ?? 0) + BAR, meta.get('loopEnd') ?? BAR * 4)}i`)
      t.loop = true
    } else {
      t.loop = false
    }
  }

  // ---------------- session playback ----------------

  /** Build the scheduled note events for a clip, applying the track's live MIDI fx. */
  private buildEvents(t: Y.Map<any> | undefined, clipMap: Y.Map<any>) {
    let notes = notesOf(clipMap).map(([, n]) => ({ ...n }))
    if (t) notes = this.applyMidiFx(t, notes, clipMap.get('len') ?? BAR)
    return notes.map(n => ({ time: `${n.s}i`, ...n }))
  }

  /** Transform a clip's note list through the track's MIDI-fx chain (offline expansion). */
  private applyMidiFx(t: Y.Map<any>, notes: Note[], loopLen: number): Note[] {
    const chain = midifxOf(t)
    if (!chain || chain.length === 0) return notes
    const isDrum = t.get('kind') === 'drum'
    const root = meta.get('root') ?? 9
    const scaleId = meta.get('scale') ?? 'minor'
    let out = notes
    chain.forEach(d => {
      if (!d.get('on')) return
      const type = d.get('type')
      const p = (d.get('params') as Y.Map<number>)
      if (type === 'scale' && !isDrum) {
        out = out.map(n => ({ ...n, p: snapToScale(n.p, root, scaleId) }))
      } else if (type === 'chord' && !isDrum) {
        const ivs = [0, p.get('i1') ?? 0, p.get('i2') ?? 0, p.get('i3') ?? 0].filter((v, i) => i === 0 || v !== 0)
        const next: Note[] = []
        out.forEach(n => ivs.forEach(iv => next.push({ ...n, p: clamp(n.p + iv, 0, 127), v: iv === 0 ? n.v : n.v * 0.85 })))
        out = next
      } else if (type === 'velo') {
        const s = p.get('scale') ?? 1, r = p.get('rand') ?? 0
        out = out.map(n => ({ ...n, v: clamp(n.v * s + (Math.random() * 2 - 1) * r, 0.05, 1) }))
      } else if (type === 'rand') {
        const ch = p.get('chance') ?? 1, oc = p.get('octave') ?? 0
        out = out.flatMap(n => {
          if (ch < 1 && Math.random() > ch) return []
          let pitch = n.p
          if (oc > 0 && Math.random() < oc) pitch = clamp(pitch + (Math.random() < 0.5 ? 12 : -12), 0, 127)
          return [{ ...n, p: pitch }]
        })
      } else if (type === 'arp' && !isDrum) {
        out = this.arpExpand(out, p, loopLen)
      }
    })
    return out
  }

  private arpExpand(notes: Note[], p: Y.Map<number>, loopLen: number): Note[] {
    if (notes.length === 0) return notes
    const step = ARP_DIV_TICKS[Math.max(0, Math.min(ARP_DIV_TICKS.length - 1, (p.get('rate') ?? 0) | 0))] || 48
    const mode = (p.get('mode') ?? 0) | 0
    const oct = Math.max(1, p.get('oct') ?? 1)
    const gate = p.get('gate') ?? 0.8
    // group notes that start together (a chord)
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

  private makePart(rec: BuiltTrack, clipMap: Y.Map<any>): Tone.Part {
    const events = this.buildEvents(trackById(rec.id), clipMap)
    const part = new Tone.Part((time, ev: any) => {
      if (ev.pr < 1 && Math.random() > ev.pr) return
      rec.inst.trigger(ev.p, Math.max(0.02, Tone.Ticks(ev.d).toSeconds()), time, ev.v)
    }, events as any)
    part.loop = true
    part.loopStart = 0
    part.loopEnd = `${clipMap.get('len') ?? BAR}i`
    return part
  }

  /** Re-derive a playing part's events (after a MIDI-fx change). */
  private refreshPart(rec: BuiltTrack) {
    if (!rec.part || !rec.partKey) return
    const clipMap = clips.get(rec.partKey) as Y.Map<any> | undefined
    if (!clipMap) return
    rec.part.clear()
    this.buildEvents(trackById(rec.id), clipMap).forEach(ev => rec.part!.add(ev as any))
  }

  private observeClipForPart(rec: BuiltTrack, key: string, clipMap: Y.Map<any>) {
    const h = () => {
      const prev = this.partTimers.get(rec.id)
      if (prev) clearTimeout(prev)
      this.partTimers.set(rec.id, setTimeout(() => {
        this.partTimers.delete(rec.id)
        if (rec.partKey !== key || !rec.part) return
        rec.part.clear()
        this.buildEvents(trackById(rec.id), clipMap).forEach(ev => rec.part!.add(ev as any))
        rec.part.loopEnd = `${clipMap.get('len') ?? BAR}i`
        rec.partLoopTicks = clipMap.get('len') ?? BAR
      }, 120))
    }
    clipMap.observeDeep(h)
    rec.unobserve = () => clipMap.unobserveDeep(h)
  }

  private stopTrackNow(rec: BuiltTrack) {
    if (rec.part) {
      try { rec.part.stop(); rec.part.dispose() } catch { /* ok */ }
    }
    if (rec.player) {
      try { rec.player.stop(); rec.player.unsync(); rec.player.dispose() } catch { /* ok */ }
      rec.player = null
    }
    this.cancelQueued(rec)
    this.clearFollow(rec.id)
    rec.unobserve?.()
    rec.unobserve = null
    rec.part = null
    rec.partKey = null
    rec.queuedKey = null
  }

  // ---------------- audio-clip playback ----------------
  private makePlayer(rec: BuiltTrack, clipMap: Y.Map<any>): Tone.Player {
    const buf = getSampleBuffer(clipMap.get('sampleId') || '')
    const player = new Tone.Player(buf as any)
    player.loop = !!clipMap.get('loop')
    player.playbackRate = Math.pow(2, (clipMap.get('pitch') ?? 0) / 12)
    player.reverse = !!clipMap.get('rev')
    try { player.fadeIn = Math.max(0, Tone.Ticks(clipMap.get('fadeIn') ?? 0).toSeconds()) } catch { /* ok */ }
    try { player.fadeOut = Math.max(0, Tone.Ticks(clipMap.get('fadeOut') ?? 0).toSeconds()) } catch { /* ok */ }
    player.volume.value = clipMap.get('gainDb') ?? 0
    player.connect(rec.inst.out)
    return player
  }

  private observeAudioClip(rec: BuiltTrack, key: string, clipMap: Y.Map<any>) {
    const h = () => {
      if (rec.partKey !== key || !rec.player) return
      const p = rec.player
      try {
        p.volume.rampTo(clipMap.get('gainDb') ?? 0, 0.03)
        p.playbackRate = Math.pow(2, (clipMap.get('pitch') ?? 0) / 12)
        p.loop = !!clipMap.get('loop')
      } catch { /* ok */ }
    }
    clipMap.observeDeep(h)
    rec.unobserve = () => clipMap.unobserveDeep(h)
  }

  private launchAudioClip(trackId: string, sceneId: string, key: string) {
    const rec = this.built.get(trackId)
    const clipMap = clips.get(key) as Y.Map<any> | undefined
    if (!rec || !clipMap) return
    const started = this.transport.state === 'started'
    const atTicks = started ? this.nextBoundaryTicks() : 0
    const atT = `${atTicks}i`
    this.cancelQueued(rec)
    if (rec.part) { try { rec.part.stop(); rec.part.dispose() } catch { /* ok */ } rec.part = null }
    rec.unobserve?.(); rec.unobserve = null
    const oldPlayer = rec.player
    if (!started) { this.transport.ticks = 0 as any; this.transport.start('+0.05') }
    const player = this.makePlayer(rec, clipMap)
    try { player.sync().start(atT) } catch { try { player.start() } catch { /* ok */ } }
    if (oldPlayer) { try { oldPlayer.stop(atT) } catch { /* ok */ } setTimeout(() => { try { oldPlayer.unsync(); oldPlayer.dispose() } catch { /* ok */ } }, 900) }
    rec.player = player
    rec.partKey = key
    rec.partStartTicks = atTicks
    rec.partLoopTicks = clipMap.get('len') ?? BAR
    this.observeAudioClip(rec, key, clipMap)
    this.armFollow(trackId, sceneId, atTicks)
    this.emit()
  }

  private clearFollow(trackId: string) {
    const ft = this.followTimers.get(trackId)
    if (ft !== undefined) { this.transport.clear(ft); this.followTimers.delete(trackId) }
  }

  /** Arm a clip's follow action: after N bars, jump/stop per its config. */
  private armFollow(trackId: string, sceneId: string, startTicks: number) {
    this.clearFollow(trackId)
    const clipMap = clips.get(clipKey(trackId, sceneId)) as Y.Map<any> | undefined
    if (!clipMap) return
    const f = followOf(clipMap)
    if (!f || !f.on) return
    const at = startTicks + Math.max(1, f.bars) * BAR
    const id = this.transport.scheduleOnce(() => {
      this.followTimers.delete(trackId)
      const rec = this.built.get(trackId)
      if (!rec || rec.partKey !== clipKey(trackId, sceneId)) return
      if (f.chance < 1 && Math.random() > f.chance) { this.armFollow(trackId, sceneId, this.transport.ticks); return }
      this.performFollow(trackId, sceneId, f.action)
    }, `${at}i`)
    this.followTimers.set(trackId, id)
  }

  private performFollow(trackId: string, sceneId: string, action: number) {
    if (action === 5) { this.stopClip(trackId); return } // Stop
    const withClip: { sid: string }[] = []
    for (let i = 0; i < scenes.length; i++) {
      const sid = scenes.get(i).get('id')
      if (clips.get(clipKey(trackId, sid))) withClip.push({ sid })
    }
    if (!withClip.length) return
    const pos = withClip.findIndex(w => w.sid === sceneId)
    let target: { sid: string } | undefined
    if (action === 0) target = withClip[(pos + 1) % withClip.length]                       // Next
    else if (action === 1) target = withClip[(pos - 1 + withClip.length) % withClip.length] // Prev
    else if (action === 2) target = withClip[0]                                              // First
    else if (action === 3) target = withClip[Math.floor(Math.random() * withClip.length)]   // Any
    else if (action === 4) {                                                                 // Random (other)
      const others = withClip.filter(w => w.sid !== sceneId)
      const pool = others.length ? others : withClip
      target = pool[Math.floor(Math.random() * pool.length)]
    }
    if (target) this.launchClip(trackId, target.sid)
  }

  private cancelQueued(rec: BuiltTrack) {
    if (rec.queuedPart) {
      try { rec.queuedPart.stop(); rec.queuedPart.dispose() } catch { /* ok */ }
      rec.queuedPart = null
    }
  }

  private startPartNow(tid: string, key: string) {
    const rec = this.built.get(tid)
    const clipMap = clips.get(key) as Y.Map<any> | undefined
    if (!rec || !clipMap) return
    this.stopTrackNow(rec)
    const part = this.makePart(rec, clipMap)
    const loopLen = clipMap.get('len') ?? BAR
    const nowTicks = this.transport.ticks
    part.start(0, `${nowTicks % loopLen}i`)
    rec.part = part
    rec.partKey = key
    rec.partStartTicks = nowTicks - (nowTicks % loopLen)
    rec.partLoopTicks = loopLen
    this.observeClipForPart(rec, key, clipMap)
  }

  /**
   * Next launch boundary as a TRANSPORT TICK position. Everything is scheduled
   * in ticks ("Ni" notation) — never wall-clock seconds — because the audio
   * context clock and the transport timeline drift apart over a session, and
   * mixing the two delays launches by exactly that drift.
   */
  private nextBoundaryTicks(): number {
    const q = meta.get('launchQ') ?? 1
    const cur = Math.round(this.transport.ticks)
    if (q === 0) return cur + 4 // tiny lookahead ≈ immediate
    const qTicks = q * BAR
    return Math.ceil((cur + 1) / qTicks) * qTicks
  }

  ensureSessionMode() {
    if (this.mode === 'arr') {
      this.clearArrParts()
      this.mode = 'session'
      this.transport.loop = false
    }
  }

  async launchClip(trackId: string, sceneId: string) {
    await this.ensureStarted()
    this.ensureSessionMode()
    const key = clipKey(trackId, sceneId)
    const rec = this.built.get(trackId)
    const clipMap = clips.get(key) as Y.Map<any> | undefined
    if (!rec || !clipMap) return
    if (isAudioClip(clipMap)) { this.launchAudioClip(trackId, sceneId, key); return }
    if (rec.partKey === key && !rec.queuedKey && !rec.queuedPart) return

    if (this.transport.state !== 'started') {
      this.transport.ticks = 0 as any
      this.transport.start('+0.05')
      this.startPartNow(trackId, key)
      this.armFollow(trackId, sceneId, 0)
      this.emit()
      return
    }

    // replace any pending launch on this track
    this.cancelQueued(rec)
    const atTicks = this.nextBoundaryTicks()
    const atT = `${atTicks}i`
    const newPart = this.makePart(rec, clipMap)
    newPart.start(atT)
    rec.queuedPart = newPart
    rec.queuedKey = key
    const old = rec.part
    if (old) old.stop(atT)
    this.transport.scheduleOnce(() => {
      if (rec.queuedKey !== key || rec.queuedPart !== newPart) return
      rec.unobserve?.()
      rec.unobserve = null
      rec.part = newPart
      rec.queuedPart = null
      rec.partKey = key
      rec.queuedKey = null
      rec.partStartTicks = atTicks
      rec.partLoopTicks = clipMap.get('len') ?? BAR
      this.observeClipForPart(rec, key, clipMap)
      this.armFollow(trackId, sceneId, atTicks)
      if (old) setTimeout(() => { try { old.dispose() } catch { /* ok */ } }, 500)
      this.emit()
    }, atT)
    this.emit()
  }

  async stopClip(trackId: string) {
    const rec = this.built.get(trackId)
    if (!rec || (!rec.part && !rec.player && !rec.queuedKey && !rec.queuedPart)) return
    if (this.transport.state !== 'started') {
      this.stopTrackNow(rec)
      this.emit()
      return
    }
    // audio clip: stop the player at the next boundary
    if (rec.player && !rec.part) {
      const atT = `${this.nextBoundaryTicks()}i`
      const p = rec.player
      rec.player = null; rec.partKey = null
      rec.unobserve?.(); rec.unobserve = null
      this.clearFollow(trackId)
      try { p.stop(atT) } catch { try { p.stop() } catch { /* ok */ } }
      setTimeout(() => { try { p.unsync(); p.dispose() } catch { /* ok */ } }, 900)
      this.emit()
      return
    }
    this.cancelQueued(rec)
    const atT = `${this.nextBoundaryTicks()}i`
    rec.queuedKey = STOP
    const old = rec.part
    if (old) old.stop(atT)
    this.transport.scheduleOnce(() => {
      if (rec.queuedKey !== STOP) return
      rec.unobserve?.()
      rec.unobserve = null
      rec.part = null
      rec.partKey = null
      rec.queuedKey = null
      if (old) setTimeout(() => { try { old.dispose() } catch { /* ok */ } }, 500)
      this.emit()
    }, atT)
    this.emit()
  }

  async launchScene(sceneId: string) {
    await this.ensureStarted()
    for (const t of tracks.toArray()) {
      const tid = t.get('id')
      if (clips.get(clipKey(tid, sceneId))) this.launchClip(tid, sceneId)
      else this.stopClip(tid)
    }
  }

  stopAllClips() {
    tracks.forEach(t => this.stopClip(t.get('id')))
  }

  // ---------------- arrangement playback ----------------

  private clearArrParts() {
    this.arrParts.forEach(p => { try { p.stop(); p.dispose() } catch { /* ok */ } })
    this.arrParts = []
  }

  private buildArrParts() {
    arr.forEach(clipMap => {
      const rec = this.built.get(clipMap.get('trackId'))
      if (!rec) return
      const start = clipMap.get('start') ?? 0
      const len = clipMap.get('len') ?? BAR
      if (isAudioClip(clipMap)) {
        if (!getSampleBuffer(clipMap.get('sampleId') || '')) return
        const player = this.makePlayer(rec, clipMap)
        try { player.sync().start(`${start}i`).stop(`${start + len}i`) } catch { /* ok */ }
        this.arrParts.push(player)
        return
      }
      const part = this.makePart(rec, clipMap)
      part.start(`${start}i`)
      part.stop(`${start + len}i`)
      this.arrParts.push(part)
    })
  }

  async playArrangement(fromTicks?: number) {
    await this.ensureStarted()
    const t = this.transport
    // stop session clips immediately — the timeline takes over
    this.built.forEach(rec => this.stopTrackNow(rec))
    if (t.state === 'started') t.stop()
    this.mode = 'arr'
    this.clearArrParts()
    this.buildArrParts()
    this.applyLoopRegion()
    const from = fromTicks ?? this.arrSeekTicks
    this.arrSeekTicks = from
    t.start('+0.05', `${from}i`)
    this.emit()
  }

  seekArr(ticks: number) {
    this.arrSeekTicks = Math.max(0, ticks)
    if (this.mode === 'arr' && this.transport.state === 'started') {
      this.transport.ticks = this.arrSeekTicks as any
    }
    this.emit()
  }

  async togglePlay() {
    await this.ensureStarted()
    if (this.transport.state === 'started') this.stopAll()
    else if (ui.view === 'arr') this.playArrangement()
    else {
      this.ensureSessionMode()
      this.transport.ticks = 0 as any
      this.transport.start('+0.05')
      this.emit()
    }
  }

  stopAll() {
    this.built.forEach(rec => this.stopTrackNow(rec))
    this.clearArrParts()
    const t = this.transport
    t.stop()
    t.loop = false
    t.ticks = 0 as any
    this.pendingRec.clear()
    this.emit()
  }

  get playing() {
    return this.started && this.transport.state === 'started'
  }

  positionTicks() {
    if (!this.started) return 0
    return this.mode === 'arr' || this.transport.state === 'started' ? this.transport.ticks : 0
  }

  clipState(trackId: string, sceneId: string) {
    const rec = this.built.get(trackId)
    const key = clipKey(trackId, sceneId)
    return {
      playing: rec?.partKey === key,
      queued: rec?.queuedKey === key,
      stopQueued: rec?.partKey === key && rec?.queuedKey === STOP,
    }
  }

  clipProgress(trackId: string): number | null {
    const rec = this.built.get(trackId)
    if (!rec || !rec.partKey || this.transport.state !== 'started') return null
    const t = this.transport.ticks
    return ((t - rec.partStartTicks) % rec.partLoopTicks + rec.partLoopTicks) % rec.partLoopTicks / rec.partLoopTicks
  }

  meterDb(trackId: string): number {
    const rec = this.built.get(trackId)
    if (!rec) return -100
    const v = rec.meter.getValue()
    return typeof v === 'number' ? v : Math.max(...(v as number[]))
  }

  masterDb(): number {
    if (!this.masterMeter) return -100
    const v = this.masterMeter.getValue()
    return typeof v === 'number' ? v : Math.max(...(v as number[]))
  }

  // ---------------- live input: monitor / record / audition ----------------

  previewOn(trackId: string | null, p: number, vel: number) {
    if (!this.started || !trackId) return
    this.built.get(trackId)?.inst.noteOn(p, vel)
  }

  previewOff(trackId: string | null, p: number) {
    if (!this.started || !trackId) return
    this.built.get(trackId)?.inst.noteOff(p)
  }

  /** Returns true if the note was captured into a clip (recording path). */
  recordNoteOn(trackId: string, p: number, vel: number): boolean {
    if (!ui.recording || !this.started) return false
    const rec = this.built.get(trackId)
    if (!rec) return false
    if (!rec.partKey || this.transport.state !== 'started') return false
    const clipMap = clips.get(rec.partKey) as Y.Map<any> | undefined
    if (!clipMap) return false
    let pos = ((this.transport.ticks - rec.partStartTicks) % rec.partLoopTicks + rec.partLoopTicks) % rec.partLoopTicks
    if (ui.recQuantize) pos = Math.round(pos / ui.gridTicks) * ui.gridTicks % rec.partLoopTicks
    this.pendingRec.set(p, { clipMap, startInClip: pos, vel })
    return true
  }

  recordNoteOff(trackId: string, p: number) {
    const pending = this.pendingRec.get(p)
    if (!pending) return
    this.pendingRec.delete(p)
    const rec = this.built.get(trackId)
    let dur = STEP16
    if (rec && rec.partKey) {
      const pos = ((this.transport.ticks - rec.partStartTicks) % rec.partLoopTicks + rec.partLoopTicks) % rec.partLoopTicks
      dur = pos - pending.startInClip
      if (dur <= 0) dur += rec.partLoopTicks
      dur = clamp(Math.round(dur), 6, rec.partLoopTicks)
      if (ui.recQuantize) dur = Math.max(STEP16 / 2, Math.round(dur / (ui.gridTicks / 2)) * (ui.gridTicks / 2))
    }
    addNote(pending.clipMap, { p, s: pending.startInClip, d: dur, v: pending.vel, pr: 1 }, 'Record note')
  }

  /** Audition arbitrary pitches (e.g. a chord progression preview). */
  async auditionPitches(type: string, params: Record<string, number>, chords: number[][], chordDur = 0.55) {
    await this.ensureStarted()
    const inst = makeInstrument(type, params)
    inst.out.connect(this.master)
    const now = Tone.now()
    chords.forEach((chord, i) => {
      chord.forEach(p => inst.trigger(p, chordDur * 0.92, now + i * chordDur, 0.75))
    })
    setTimeout(() => { try { inst.dispose() } catch { /* ok */ } }, (chords.length * chordDur + 2) * 1000)
  }

  /** Quick preset audition from the browser, without touching any track. */
  async audition(type: string, params: Record<string, number>) {
    await this.ensureStarted()
    const inst = makeInstrument(type, params)
    inst.out.connect(this.master)
    const now = Tone.now()
    if (type === 'drum') {
      inst.trigger(0, 0.3, now, 0.9)
      inst.trigger(3, 0.2, now + 0.18, 0.7)
      inst.trigger(1, 0.25, now + 0.36, 0.85)
      inst.trigger(3, 0.2, now + 0.54, 0.7)
    } else {
      inst.trigger(60, 0.45, now, 0.85)
      inst.trigger(67, 0.4, now + 0.22, 0.8)
      inst.trigger(72, 0.6, now + 0.44, 0.85)
    }
    setTimeout(() => { try { inst.dispose() } catch { /* ok */ } }, 2500)
  }
}

export const engine = new Engine()
;(window as any).__engine = engine
