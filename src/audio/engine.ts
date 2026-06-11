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
  createClip, trackById,
} from '../state/doc'
import { makeInstrument, makeEffect, Inst, Fx } from './devices'
import { setUI, toast, ui } from '../state/store'

const STOP = '__stop__'

type BuiltFx = { id: string; type: string; fx: Fx }
type BuiltTrack = {
  id: string
  kind: string
  inst: Inst
  fx: BuiltFx[]
  channel: Tone.Channel
  meter: Tone.Meter
  part: Tone.Part | null
  partKey: string | null
  partStartTicks: number
  partLoopTicks: number
  queuedKey: string | null
  queuedPart: Tone.Part | null
  unobserve: (() => void) | null
}

class Engine {
  started = false
  mode: 'session' | 'arr' = 'session'
  built = new Map<string, BuiltTrack>()
  master!: Tone.Channel
  masterMeter!: Tone.Meter
  arrParts: Tone.Part[] = []
  arrSeekTicks = 0
  sampleRate = 0
  private metro!: Tone.Synth
  private rebuildTimers = new Map<string, ReturnType<typeof setTimeout>>()
  private partTimers = new Map<string, ReturnType<typeof setTimeout>>()
  private arrTimer: ReturnType<typeof setTimeout> | null = null
  private pendingRec = new Map<number, { clipMap: Y.Map<any>; startInClip: number; vel: number }>()

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

    this.master = new Tone.Channel({ volume: meta.get('masterGain') ?? 0 })
    const limiter = new Tone.Limiter(-1)
    this.masterMeter = new Tone.Meter({ smoothing: 0.85 })
    this.master.chain(limiter, Tone.getDestination())
    this.master.connect(this.masterMeter)

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
    setUI({ audioReady: true })
    this.emit()
  }

  // ---------------- graph building ----------------

  private buildTrack(t: Y.Map<any>) {
    const tid = t.get('id') as string
    const inst = makeInstrument(t.get('inst').get('type'), (t.get('inst').get('params') as Y.Map<number>).toJSON())
    const fx: BuiltFx[] = []
    ;(t.get('fx') as Y.Array<Y.Map<any>>).forEach(f => {
      if (f.get('on')) fx.push({ id: f.get('id'), type: f.get('type'), fx: makeEffect(f.get('type'), (f.get('params') as Y.Map<number>).toJSON()) })
    })
    const channel = new Tone.Channel({ volume: t.get('gain') ?? 0, pan: t.get('pan') ?? 0, mute: !!t.get('mute') })
    channel.solo = !!t.get('solo')
    const meter = new Tone.Meter({ smoothing: 0.8 })
    const nodes = [...fx.map(f => f.fx.node), channel]
    inst.out.chain(...(nodes as [Tone.ToneAudioNode]))
    channel.connect(this.master)
    channel.connect(meter)
    const rec: BuiltTrack = {
      id: tid, kind: t.get('kind'), inst, fx, channel, meter,
      part: null, partKey: null, partStartTicks: 0, partLoopTicks: BAR,
      queuedKey: null, queuedPart: null, unobserve: null,
    }
    this.built.set(tid, rec)
    return rec
  }

  private disposeTrack(rec: BuiltTrack) {
    this.stopTrackNow(rec)
    try {
      rec.inst.dispose()
      rec.fx.forEach(f => f.fx.dispose())
      rec.channel.dispose()
      rec.meter.dispose()
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
          if (key === 'gain') rec.channel.volume.rampTo(t.get('gain'), 0.05)
          else if (key === 'pan') rec.channel.pan.rampTo(t.get('pan'), 0.05)
          else if (key === 'mute') rec.channel.mute = !!t.get('mute')
          else if (key === 'solo') rec.channel.solo = !!t.get('solo')
          else if (key === 'inst' || key === 'fx') structural.add(tid)
        })
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

  private makePart(rec: BuiltTrack, clipMap: Y.Map<any>): Tone.Part {
    const events = notesOf(clipMap).map(([nid, n]) => ({ time: `${n.s}i`, nid, ...n }))
    const part = new Tone.Part((time, ev: any) => {
      if (ev.pr < 1 && Math.random() > ev.pr) return
      rec.inst.trigger(ev.p, Math.max(0.02, Tone.Ticks(ev.d).toSeconds()), time, ev.v)
    }, events as any)
    part.loop = true
    part.loopStart = 0
    part.loopEnd = `${clipMap.get('len') ?? BAR}i`
    return part
  }

  private observeClipForPart(rec: BuiltTrack, key: string, clipMap: Y.Map<any>) {
    const h = () => {
      const prev = this.partTimers.get(rec.id)
      if (prev) clearTimeout(prev)
      this.partTimers.set(rec.id, setTimeout(() => {
        this.partTimers.delete(rec.id)
        if (rec.partKey !== key || !rec.part) return
        rec.part.clear()
        notesOf(clipMap).forEach(([nid, n]) => rec.part!.add({ time: `${n.s}i`, nid, ...n } as any))
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
    this.cancelQueued(rec)
    rec.unobserve?.()
    rec.unobserve = null
    rec.part = null
    rec.partKey = null
    rec.queuedKey = null
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
    if (rec.partKey === key && !rec.queuedKey && !rec.queuedPart) return

    if (this.transport.state !== 'started') {
      this.transport.ticks = 0 as any
      this.transport.start('+0.05')
      this.startPartNow(trackId, key)
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
      if (old) setTimeout(() => { try { old.dispose() } catch { /* ok */ } }, 500)
      this.emit()
    }, atT)
    this.emit()
  }

  async stopClip(trackId: string) {
    const rec = this.built.get(trackId)
    if (!rec || (!rec.part && !rec.queuedKey && !rec.queuedPart)) return
    if (this.transport.state !== 'started') {
      this.stopTrackNow(rec)
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
      const part = this.makePart(rec, clipMap)
      const start = clipMap.get('start') ?? 0
      const len = clipMap.get('len') ?? BAR
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
