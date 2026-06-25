// Cross-cutting UI actions shared by SessionView, Browser, the command
// palette and keyboard shortcuts.

import { ClipRef, CLIP_COLORS, BAR } from '../types'
import {
  addTrack, addScene, clipKey, clips, duplicateClipTo, getClipMap, clipToJSON,
  jsonToClipMap, loadProject, mutate, scenes, setInstrument, trackById, ClipJSON, TrackJSON,
  addAudioTrack, createAudioClip, addBusTrack, tracks, busCanReach, setTrackOutput, setBusSend,
  setTrackColor, duplicateTrack, moveTrack, removeTrack,
} from '../state/doc'
import { ColorRow, MenuItem } from './widgets'
import { setUI, toast, ui } from '../state/store'
import { setPresence } from '../state/net'
import { engine } from '../audio/engine'
import { meta } from '../state/doc'
import { importSampleFile, getSampleBuffer } from '../audio/samples'
import { DEFAULT_PROJECT, demoProject, DRUM_KITS, InstPreset, MidiLoop, Progression, progressionClip, clipInKey } from '../packs'

// Shared track-header right-click menu, so Session and Arrangement headers offer
// the same options. `onRename` lets each view drive its own inline editor;
// `vertical` flips the reorder labels (Session = columns, Arrangement = rows).
export function trackHeaderMenu(trackId: string, onRename: () => void, vertical = false): MenuItem[] {
  const t = trackById(trackId)
  return [
    { label: 'Rename', fn: onRename },
    { custom: <ColorRow colors={CLIP_COLORS} onPick={i => setTrackColor(trackId, i)} /> },
    { label: 'Duplicate track', fn: () => duplicateTrack(trackId) },
    { label: vertical ? '↑ Move up' : '← Move left', fn: () => moveTrack(trackId, -1) },
    { label: vertical ? '↓ Move down' : '→ Move right', fn: () => moveTrack(trackId, 1) },
    'sep',
    { label: 'Delete track', fn: () => { if (confirm(`Delete "${t?.get('name')}"?`)) removeTrack(trackId) }, danger: true },
  ]
}

export function selectTrack(trackId: string | null) {
  setUI({ selTrackId: trackId })
  setPresence({ sel: trackId ? { trackId } : null })
}

// ---------------- audio import ----------------
let audioColor = 5
export async function importAudioFile(file: File, targetTrackId?: string, targetSceneId?: string) {
  try {
    const { id, name } = await importSampleFile(file)
    const buf = getSampleBuffer(id)
    const bpm = meta.get('bpm') ?? 120
    const durTicks = buf ? Math.max(BAR / 4, Math.round(buf.duration * (bpm / 60) * 96)) : BAR * 2
    const color = (audioColor = (audioColor + 4) % CLIP_COLORS.length)
    let trackId: string = (targetTrackId && trackById(targetTrackId)?.get('kind') === 'audio') ? targetTrackId : addAudioTrack(name, color)
    let sceneId: string | undefined = targetSceneId
    if (!sceneId) {
      for (let i = 0; i < scenes.length; i++) { const sid = scenes.get(i).get('id'); if (!clips.get(clipKey(trackId, sid))) { sceneId = sid; break } }
      sceneId = sceneId ?? (scenes.length ? scenes.get(0).get('id') : addScene())
    }
    const ref = createAudioClip(trackId, sceneId as string, id, name, durTicks, color)
    selectClip(ref, true)
    toast(`Imported "${name}"`)
  } catch (e) {
    console.error(e)
    toast('Could not import that audio file')
  }
}

export function pickAudioFile() {
  const input = document.createElement('input')
  input.type = 'file'
  input.accept = 'audio/*'
  input.onchange = () => { const f = input.files?.[0]; if (f) importAudioFile(f) }
  input.click()
}

export function selectClip(ref: ClipRef | null, openDetail = false) {
  const trackId = ref ? (ref.kind === 'session' ? ref.trackId : (getClipMap(ref)?.get('trackId') ?? null)) : null
  setUI({
    selClip: ref,
    selTrackId: trackId ?? ui.selTrackId,
    ...(openDetail ? { detailOpen: true, detailTab: 'clip' as const } : {}),
  })
  setPresence({
    sel: ref
      ? { trackId: trackId ?? undefined, clipKey: ref.kind === 'session' ? clipKey(ref.trackId, ref.sceneId) : ref.id }
      : trackId ? { trackId } : null,
  })
}

// ---------------- clipboard ----------------
let clipboard: ClipJSON | null = null

export function copyClipRef(ref: ClipRef) {
  const m = getClipMap(ref)
  if (!m) return
  clipboard = clipToJSON(m)
  toast(`Copied "${clipboard.name}"`)
}

export function pasteClipTo(trackId: string, sceneId: string) {
  if (!clipboard) { toast('Clipboard is empty'); return }
  mutate('Paste clip', () => {
    clips.set(clipKey(trackId, sceneId), jsonToClipMap(clipboard!))
  })
  selectClip({ kind: 'session', trackId, sceneId })
}

export function hasClipboard() {
  return clipboard !== null
}

// ---------------- track creation ----------------
let colorCycle = 0
const nextColor = () => (colorCycle = (colorCycle + 5) % CLIP_COLORS.length)

export function addSynthTrack(preset?: InstPreset): string {
  const t: TrackJSON = {
    name: preset?.name ?? 'Synth',
    color: nextColor(),
    kind: 'synth',
    inst: preset ? { type: preset.type, params: { ...preset.params } } : { type: 'poly', params: { ...DEFAULT_PROJECT.tracks[3].inst.params } },
    fx: [], gain: -3, pan: 0, mute: false, solo: false,
  }
  const id = addTrack(t)
  selectTrack(id)
  return id
}

export function addDrumTrack(kitName?: string): string {
  const kit = DRUM_KITS.find(k => k.name === kitName) ?? DRUM_KITS[0]
  const id = addTrack({
    name: kitName ?? 'Drums',
    color: nextColor(),
    kind: 'drum',
    inst: { type: 'drum', params: { ...kit.params } },
    fx: [], gain: 0, pan: 0, mute: false, solo: false,
  })
  selectTrack(id)
  return id
}

export function addAudio(): string {
  const n = tracks.toArray().filter(t => t.get('kind') === 'audio').length + 1
  const id = addAudioTrack(`Audio ${n}`, nextColor())
  selectTrack(id)
  return id
}

export function addBus(): string {
  const n = tracks.toArray().filter(t => t.get('kind') === 'bus').length + 1
  const id = addBusTrack(`Bus ${n}`, nextColor())
  selectTrack(id)
  return id
}

/**
 * Set a bus output, popping the themed feedback-loop warning first if the route
 * would create an audio cycle. On Continue we apply anyway (Web Audio drops a
 * delay-less cycle, so it's harmless); on Undo we leave the route unchanged.
 */
export function attemptSetOutput(trackId: string, target: string) {
  const name = trackById(trackId)?.get('name') ?? 'bus'
  if (target !== 'master' && (target === trackId || busCanReach(target, trackId))) {
    const to = trackById(target)?.get('name') ?? 'that bus'
    setUI({ feedbackPrompt: { msg: `Routing “${name}” → “${to}” creates a feedback loop.`, apply: () => setTrackOutput(trackId, target) } })
  } else setTrackOutput(trackId, target)
}

/** Set a bus-send level; only a send FROM a bus can loop, so guard those. */
export function attemptBusSend(trackId: string, busId: string, level: number) {
  const src = trackById(trackId)
  const isBusSource = src?.get('kind') === 'bus'
  if (level > 0 && isBusSource && (busId === trackId || busCanReach(busId, trackId))) {
    const name = src?.get('name') ?? 'bus'
    const to = trackById(busId)?.get('name') ?? 'that bus'
    setUI({ feedbackPrompt: { msg: `“${name}” sending to “${to}” creates a feedback loop.`, apply: () => setBusSend(trackId, busId, level) } })
  } else setBusSend(trackId, busId, level)
}

// ---------------- browser items → project ----------------

export function applyPreset(preset: InstPreset) {
  const t = ui.selTrackId ? trackById(ui.selTrackId) : undefined
  if (t && t.get('kind') === 'synth' && ui.selTrackId) {
    setInstrument(ui.selTrackId, preset.type, { ...preset.params }, `Preset: ${preset.name}`)
    toast(`Loaded "${preset.name}"`)
  } else {
    addSynthTrack(preset)
    toast(`New track with "${preset.name}"`)
  }
}

export function applyDrumKit(kitName: string) {
  const kit = DRUM_KITS.find(k => k.name === kitName)
  if (!kit) return
  const t = ui.selTrackId ? trackById(ui.selTrackId) : undefined
  if (t && t.get('kind') === 'drum' && ui.selTrackId) {
    setInstrument(ui.selTrackId, 'drum', { ...kit.params }, `Kit: ${kitName}`)
    toast(`Loaded kit "${kitName}"`)
  } else {
    addDrumTrack(kitName)
    toast(`New drum track with "${kitName}"`)
  }
}

export function loadLoop(loop: MidiLoop, targetTrackId?: string, targetSceneId?: string) {
  let trackId = targetTrackId ?? ui.selTrackId
  const t = trackId ? trackById(trackId) : undefined
  const needDrums = !!loop.forDrums
  const isDrum = t?.get('kind') === 'drum'
  if (!t || needDrums !== isDrum) {
    trackId = needDrums ? addDrumTrack() : addSynthTrack()
  }
  // find target slot: given scene, else selected, else first free, else scene 0
  let sceneId = targetSceneId ?? (ui.selClip?.kind === 'session' ? ui.selClip.sceneId : undefined)
  if (!sceneId) {
    for (let i = 0; i < scenes.length; i++) {
      const sid = scenes.get(i).get('id')
      if (!clips.get(clipKey(trackId!, sid))) { sceneId = sid; break }
    }
    sceneId = sceneId ?? scenes.get(0)?.get('id')
  }
  if (!sceneId) return
  // melodic loops follow the global key; drum loops are pitch-free
  const built = loop.forDrums ? loop.clip : clipInKey(loop.clip, meta.get('root') ?? 9)
  mutate(`Loop: ${loop.name}`, () => {
    clips.set(clipKey(trackId!, sceneId!), jsonToClipMap(built))
  })
  selectClip({ kind: 'session', trackId: trackId!, sceneId }, true)
  toast(`"${built.name}" → ${trackById(trackId!)?.get('name')}`)
}

/** Render a chord progression into the current project key and drop it in. */
export function loadProgression(prog: Progression, targetTrackId?: string, targetSceneId?: string) {
  const rootPc = meta.get('root') ?? 9
  const built = progressionClip(prog, rootPc)
  loadLoop({ name: built.name, cat: 'Chords', clip: built }, targetTrackId, targetSceneId)
}

// ---------------- project-level ----------------

export function loadDemo() {
  loadProject(demoProject(), 'Load demo song')
  selectTrack(null)
  setUI({ selClip: null })
  toast('Demo song loaded — press a scene number to jam')
}

export function newProject() {
  if (!confirm('Start a new empty project? (You can undo this)')) return
  engine.stopAll()
  loadProject({ ...DEFAULT_PROJECT, meta: { ...DEFAULT_PROJECT.meta } }, 'New project')
  setUI({ selClip: null })
  toast('Fresh project')
}

export function importProjectFile() {
  const input = document.createElement('input')
  input.type = 'file'
  input.accept = '.json,application/json'
  input.onchange = async () => {
    const f = input.files?.[0]
    if (!f) return
    try {
      const json = JSON.parse(await f.text())
      if (!json.meta || !json.tracks) throw new Error('bad file')
      engine.stopAll()
      loadProject(json, 'Import project')
      toast(`Imported "${json.meta.title}"`)
    } catch {
      toast('Could not read that file')
    }
  }
  input.click()
}

export function duplicateClipToNextScene(ref: ClipRef & { kind: 'session' }) {
  const idx = (() => {
    for (let i = 0; i < scenes.length; i++) if (scenes.get(i).get('id') === ref.sceneId) return i
    return -1
  })()
  if (idx < 0) return
  let nextScene = idx + 1 < scenes.length ? scenes.get(idx + 1).get('id') : null
  if (!nextScene) nextScene = addScene()
  duplicateClipTo(ref, ref.trackId, nextScene!)
  selectClip({ kind: 'session', trackId: ref.trackId, sceneId: nextScene! })
}
