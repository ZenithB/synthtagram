// Cross-cutting UI actions shared by SessionView, Browser, the command
// palette and keyboard shortcuts.

import { ClipRef, CLIP_COLORS } from '../types'
import {
  addTrack, addScene, clipKey, clips, duplicateClipTo, getClipMap, clipToJSON,
  jsonToClipMap, loadProject, mutate, scenes, setInstrument, trackById, ClipJSON, TrackJSON,
} from '../state/doc'
import { setUI, toast, ui } from '../state/store'
import { setPresence } from '../state/net'
import { engine } from '../audio/engine'
import { meta } from '../state/doc'
import { DEFAULT_PROJECT, demoProject, DRUM_KITS, InstPreset, MidiLoop, Progression, progressionClip } from '../packs'

export function selectTrack(trackId: string | null) {
  setUI({ selTrackId: trackId })
  setPresence({ sel: trackId ? { trackId } : null })
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
  mutate(`Loop: ${loop.name}`, () => {
    clips.set(clipKey(trackId!, sceneId!), jsonToClipMap(loop.clip))
  })
  selectClip({ kind: 'session', trackId: trackId!, sceneId }, true)
  toast(`"${loop.name}" → ${trackById(trackId!)?.get('name')}`)
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
