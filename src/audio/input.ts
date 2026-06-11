// Live note input: computer-keyboard piano (Ableton's awsedftg... layout),
// Web MIDI (if a controller is plugged in), monitoring through the selected
// track, recording into playing clips, and Capture — the beloved "I wasn't
// recording but play it anyway" buffer.

import { BAR, STEP16, clamp } from '../types'
import { engine } from './engine'
import { ui, setUI, toast } from '../state/store'
import { clips, clipKey, createClip, getClipMap, addNotes, scenes, addScene, trackById, meta } from '../state/doc'

// Live's mapping: a=C w=C# s=D e=D# d=E f=F t=F# g=G y=G# h=A u=A# j=B k=C+1 ...
const KEY_SEMI: Record<string, number> = {
  a: 0, w: 1, s: 2, e: 3, d: 4, f: 5, t: 6, g: 7, y: 8, h: 9, u: 10, j: 11,
  k: 12, o: 13, l: 14, p: 15, ';': 16,
}
const DRUM_KEYS: Record<string, number> = { a: 0, s: 1, d: 2, f: 3, g: 4, h: 5, j: 6, k: 7 }

let kbdEnabled = true
export function setKbdEnabled(v: boolean) { kbdEnabled = v }
export function isKbdEnabled() { return kbdEnabled }

const held = new Map<string, { trackId: string; p: number }>()

type CapturedNote = { p: number; v: number; tOn: number; tOff: number | null }
const captureBuf: CapturedNote[] = []
const CAPTURE_WINDOW_MS = 30000

function targetTrackId(): string | null {
  return ui.armTrackId ?? ui.selTrackId
}

function isDrumTrack(trackId: string) {
  return trackById(trackId)?.get('kind') === 'drum'
}

export function noteOn(p: number, vel: number, viaKey?: string) {
  const tid = targetTrackId()
  if (!tid) return
  engine.previewOn(tid, p, vel)
  engine.recordNoteOn(tid, p, vel)
  captureBuf.push({ p, v: vel, tOn: performance.now(), tOff: null })
  while (captureBuf.length && captureBuf[0].tOn < performance.now() - CAPTURE_WINDOW_MS) captureBuf.shift()
  if (viaKey) held.set(viaKey, { trackId: tid, p })
}

export function noteOff(p: number, viaKey?: string) {
  const tid = viaKey ? held.get(viaKey)?.trackId ?? targetTrackId() : targetTrackId()
  if (viaKey) held.delete(viaKey)
  if (!tid) return
  engine.previewOff(tid, p)
  engine.recordNoteOff(tid, p)
  for (let i = captureBuf.length - 1; i >= 0; i--) {
    if (captureBuf[i].p === p && captureBuf[i].tOff === null) { captureBuf[i].tOff = performance.now(); break }
  }
}

function inTextField(e: KeyboardEvent) {
  const el = e.target as HTMLElement
  return el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)
}

export function initKeyboardPiano() {
  window.addEventListener('keydown', e => {
    if (!kbdEnabled || e.repeat || e.metaKey || e.ctrlKey || e.altKey || inTextField(e)) return
    const key = e.key.toLowerCase()
    const tid = targetTrackId()
    if (key === 'z') { setUI({ octave: clamp(ui.octave - 1, 0, 8) }); return }
    if (key === 'x') { setUI({ octave: clamp(ui.octave + 1, 0, 8) }); return }
    if (key === 'c') { setUI({ velo: clamp(ui.velo - 0.1, 0.1, 1) }); return }
    if (key === 'v') { setUI({ velo: clamp(ui.velo + 0.1, 0.1, 1) }); return }
    if (held.has(key)) return
    if (tid && isDrumTrack(tid)) {
      const pad = DRUM_KEYS[key]
      if (pad !== undefined) { noteOn(pad, ui.velo, key); e.preventDefault() }
      return
    }
    const semi = KEY_SEMI[key]
    if (semi !== undefined) {
      noteOn(12 * (ui.octave + 1) + semi, ui.velo, key)
      e.preventDefault()
    }
  })
  window.addEventListener('keyup', e => {
    const key = e.key.toLowerCase()
    const h = held.get(key)
    if (h) noteOff(h.p, key)
  })
  window.addEventListener('blur', () => {
    held.forEach(h => noteOff(h.p))
    held.clear()
  })
}

export function initWebMidi() {
  const nav = navigator as any
  if (!nav.requestMIDIAccess) return
  nav.requestMIDIAccess().then((access: any) => {
    const hook = (input: any) => {
      input.onmidimessage = (msg: any) => {
        const [status, d1, d2] = msg.data
        const cmd = status & 0xf0
        const tid = targetTrackId()
        const pitch = tid && isDrumTrack(tid) ? clamp(d1 - 36, 0, 7) : d1
        if (cmd === 0x90 && d2 > 0) noteOn(pitch, d2 / 127)
        else if (cmd === 0x80 || (cmd === 0x90 && d2 === 0)) noteOff(pitch)
      }
    }
    access.inputs.forEach(hook)
    access.onstatechange = (e: any) => {
      if (e.port.type === 'input' && e.port.state === 'connected') hook(e.port)
    }
    if (access.inputs.size > 0) toast('MIDI controller connected')
  }).catch(() => { /* midi optional */ })
}

/**
 * Capture: turn the last ~30s of played notes into a clip even though you
 * never hit record. Infers loop length, quantizes lightly, drops it into the
 * selected slot (or the first free one on the track).
 */
export function captureToClip() {
  const tid = targetTrackId()
  if (!tid) { toast('Select a track first'); return }
  const now = performance.now()
  const notes = captureBuf.filter(n => n.tOn > now - CAPTURE_WINDOW_MS)
  if (notes.length === 0) { toast('Nothing to capture — play some notes!'); return }

  const bpm = meta.get('bpm') ?? 120
  const msPerTick = 60000 / bpm / 96
  const t0 = notes[0].tOn
  const raw = notes.map(n => ({
    p: n.p,
    s: Math.round((n.tOn - t0) / msPerTick),
    d: Math.max(12, Math.round(((n.tOff ?? n.tOn + 250) - n.tOn) / msPerTick)),
    v: n.v,
    pr: 1,
  }))
  // light 16th quantize on starts
  raw.forEach(n => { n.s = Math.round(n.s / STEP16) * STEP16 })
  const span = Math.max(...raw.map(n => n.s + n.d))
  const lenBars = Math.min(8, Math.max(1, Math.pow(2, Math.ceil(Math.log2(Math.max(1, span / BAR))))))
  const len = lenBars * BAR
  raw.forEach(n => { n.s = n.s % len })

  // find a slot: selected scene if empty, else first free scene, else new scene
  let sceneId = ui.selClip?.kind === 'session' ? ui.selClip.sceneId : (scenes.length ? scenes.get(0).get('id') : addScene())
  if (clips.get(clipKey(tid, sceneId))) {
    let free: string | null = null
    for (let i = 0; i < scenes.length; i++) {
      const sid = scenes.get(i).get('id')
      if (!clips.get(clipKey(tid, sid))) { free = sid; break }
    }
    sceneId = free ?? addScene()
  }
  const ref = createClip(tid, sceneId)
  const cm = getClipMap(ref)!
  cm.set('len', len)
  cm.set('name', 'Captured')
  addNotes(cm, raw, 'Capture')
  setUI({ selClip: ref, selTrackId: tid, detailOpen: true, detailTab: 'clip' })
  toast(`Captured ${raw.length} notes into a ${lenBars}-bar clip`)
  captureBuf.length = 0
}
