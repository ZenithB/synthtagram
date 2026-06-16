// Offline WAV export. Rebuilds the whole project graph inside Tone.Offline at
// the engine's 2x rate (88.2kHz), renders, then resamples to 44.1kHz with the
// browser's resampler and encodes 16-bit PCM. Master mix or per-track stems.

import * as Tone from 'tone'
import { BAR, PPQ, Note } from '../types'
import { exportProject, arrEndTicks, meta as docMeta, ProjectJSON } from '../state/doc'
import { makeInstrument, makeEffect } from './devices'
import { toast } from '../state/store'

const RENDER_SR = 88200
const OUT_SR = 44100

function ticksToSec(ticks: number, bpm: number) {
  return (ticks / PPQ) * (60 / bpm)
}

type RenderScope =
  | { kind: 'arr' }
  | { kind: 'loop' }
  | { kind: 'scene'; sceneId: string }

async function renderBuffer(
  project: ProjectJSON,
  scope: RenderScope,
  onlyTrackIdx: number | null,
  fromTicks: number,
  lengthTicks: number,
  sceneId?: string,
): Promise<AudioBuffer> {
  const bpm = project.meta.bpm
  const durSec = ticksToSec(lengthTicks, bpm) + 1.2 // reverb/release tail

  const rendered = await Tone.Offline(async ({ transport }) => {
    transport.PPQ = PPQ
    transport.bpm.value = bpm
    transport.swing = project.meta.swing
    transport.swingSubdivision = '16n'

    // stereo-preserving master (Tone.Channel downmixes stereo input to mono)
    const master = new Tone.Volume(0)
    const limiter = new Tone.Limiter(-1)
    master.chain(limiter, Tone.getDestination())

    const reverbReady: Promise<any>[] = []

    project.tracks.forEach((t, idx) => {
      if (onlyTrackIdx !== null && idx !== onlyTrackIdx) return
      if (t.mute && onlyTrackIdx === null) return
      const inst = makeInstrument(t.inst.type, t.inst.params)
      const fxNodes: Tone.ToneAudioNode[] = []
      t.fx.forEach(f => {
        if (!f.on) return
        const fx = makeEffect(f.type, f.params)
        if (f.type === 'reverb') reverbReady.push((fx.node as Tone.Reverb).ready.catch(() => {}))
        fxNodes.push(fx.node)
      })
      // raw StereoPanner preserves stereo (Tone.Panner downmixes stereo input)
      const rawCtx = Tone.getContext().rawContext as unknown as BaseAudioContext
      const panner = rawCtx.createStereoPanner()
      panner.pan.value = t.pan
      const vol = new Tone.Volume(t.gain)
      const chainNodes: any[] = [inst.out, ...fxNodes]
      for (let i = 0; i < chainNodes.length - 1; i++) Tone.connect(chainNodes[i], chainNodes[i + 1])
      Tone.connect(chainNodes[chainNodes.length - 1], panner)
      Tone.connect(panner, vol)
      vol.connect(master)

      const schedule = (notes: Record<string, Note>, startTicks: number, lenTicks: number, loop: boolean) => {
        const events = Object.values(notes).map(n => ({ time: `${n.s}i`, ...n }))
        const part = new Tone.Part((time, ev: any) => {
          if (ev.pr < 1 && Math.random() > ev.pr) return
          inst.trigger(ev.p, Math.max(0.02, Tone.Ticks(ev.d).toSeconds()), time, ev.v)
        }, events as any)
        part.loop = loop
        part.loopStart = 0
        part.loopEnd = `${lenTicks}i`
        part.start(`${startTicks}i`)
        if (!loop) part.stop(`${startTicks + lenTicks}i`)
      }

      if (scope.kind === 'scene') {
        const tid = t.id ?? t.name
        const clip = project.clips[`${tid}|${sceneId}`]
        if (clip) schedule(clip.notes, 0, clip.len, true)
      } else {
        Object.values(project.arr).forEach(a => {
          if (a.trackId !== (t.id ?? t.name)) return
          // parts loop the clip content natively across its arranged length
          const events = Object.values(a.notes).map(n => ({ time: `${n.s}i`, ...n }))
          const part = new Tone.Part((time, ev: any) => {
            if (ev.pr < 1 && Math.random() > ev.pr) return
            inst.trigger(ev.p, Math.max(0.02, Tone.Ticks(ev.d).toSeconds()), time, ev.v)
          }, events as any)
          part.loop = true
          part.loopStart = 0
          part.loopEnd = `${a.len}i`
          part.start(`${a.start}i`)
          part.stop(`${a.start + a.len}i`)
        })
      }
    })

    await Promise.all(reverbReady)
    transport.start(0.05, `${fromTicks}i`)
  }, durSec, 2, RENDER_SR)

  return rendered.get() as AudioBuffer
}

async function resample(buf: AudioBuffer): Promise<AudioBuffer> {
  const len = Math.ceil(buf.duration * OUT_SR)
  const ctx = new OfflineAudioContext(2, len, OUT_SR)
  const src = ctx.createBufferSource()
  src.buffer = buf
  src.connect(ctx.destination)
  src.start()
  return ctx.startRendering()
}

function encodeWav(buf: AudioBuffer): Blob {
  const numCh = 2
  const len = buf.length
  const bytesPerSample = 2
  const blockAlign = numCh * bytesPerSample
  const dataSize = len * blockAlign
  const ab = new ArrayBuffer(44 + dataSize)
  const dv = new DataView(ab)
  const writeStr = (off: number, s: string) => { for (let i = 0; i < s.length; i++) dv.setUint8(off + i, s.charCodeAt(i)) }
  writeStr(0, 'RIFF')
  dv.setUint32(4, 36 + dataSize, true)
  writeStr(8, 'WAVE')
  writeStr(12, 'fmt ')
  dv.setUint32(16, 16, true)
  dv.setUint16(20, 1, true)
  dv.setUint16(22, numCh, true)
  dv.setUint32(24, OUT_SR, true)
  dv.setUint32(28, OUT_SR * blockAlign, true)
  dv.setUint16(32, blockAlign, true)
  dv.setUint16(34, 16, true)
  writeStr(36, 'data')
  dv.setUint32(40, dataSize, true)
  const chL = buf.getChannelData(0)
  const chR = buf.numberOfChannels > 1 ? buf.getChannelData(1) : chL
  let off = 44
  for (let i = 0; i < len; i++) {
    for (const ch of [chL, chR]) {
      const s = Math.max(-1, Math.min(1, ch[i]))
      dv.setInt16(off, s < 0 ? s * 0x8000 : s * 0x7fff, true)
      off += 2
    }
  }
  return new Blob([ab], { type: 'audio/wav' })
}

function download(blob: Blob, name: string) {
  const a = document.createElement('a')
  a.href = URL.createObjectURL(blob)
  a.download = name
  a.click()
  setTimeout(() => URL.revokeObjectURL(a.href), 10000)
}

export async function exportWav(scope: RenderScope, stems = false) {
  const project = exportProject()
  const title = project.meta.title.replace(/[^\w\- ]+/g, '') || 'synthtagram'
  const loopStart = docMeta.get('loopStart') ?? 0
  const loopEnd = docMeta.get('loopEnd') ?? BAR * 4

  let from = 0
  let ticks = Math.max(BAR, arrEndTicks())
  let sceneId: string | undefined
  if (scope.kind === 'loop') { from = loopStart; ticks = Math.max(BAR, loopEnd - loopStart) }
  if (scope.kind === 'scene') {
    sceneId = scope.sceneId
    let longest = BAR
    for (const [key, c] of Object.entries(project.clips)) if (key.endsWith(`|${sceneId}`)) longest = Math.max(longest, c.len)
    ticks = longest * 2
  }
  if (scope.kind === 'arr' && ticks <= BAR && Object.keys(project.arr).length === 0) {
    toast('Arrangement is empty — drag some clips in first')
    return
  }

  toast(stems ? 'Rendering stems…' : 'Rendering WAV…')
  try {
    if (stems) {
      for (let i = 0; i < project.tracks.length; i++) {
        const buf = await renderBuffer(project, scope, i, from, ticks, sceneId)
        const out = await resample(buf)
        download(encodeWav(out), `${title} - ${project.tracks[i].name}.wav`)
        await new Promise(r => setTimeout(r, 400))
      }
      toast(`Exported ${project.tracks.length} stems ✓`)
    } else {
      const buf = await renderBuffer(project, scope, null, from, ticks, sceneId)
      const out = await resample(buf)
      download(encodeWav(out), `${title}.wav`)
      toast('Exported WAV ✓')
    }
  } catch (e) {
    console.error(e)
    toast('Export failed — see console')
  }
}

export function exportProjectFile() {
  const project = exportProject()
  const blob = new Blob([JSON.stringify(project, null, 2)], { type: 'application/json' })
  download(blob, `${project.meta.title.replace(/[^\w\- ]+/g, '') || 'project'}.synthtagram.json`)
  toast('Project file saved')
}
