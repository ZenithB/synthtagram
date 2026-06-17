// "Record Output": captures the live post-limiter master — exactly what you
// hear, including live knob tweaks and performance — via an AudioWorklet PCM
// tap, then resamples to 44.1kHz and encodes (WAV/MP3) on stop.

import * as Tone from 'tone'
import { engine } from './engine'
import { meta } from '../state/doc'
import { resample, encodeAudio, download, extFor, Channels, AudioFormat } from './encode'
import { toast } from '../state/store'

// The PCM-tap worklet is served as a static file (more reliable than a Blob URL
// for audioWorklet.addModule across browsers). A 0-gain sink keeps it pulled.
const WORKLET_URL = '/sf-capture-worklet.js'

let recording = false
let node: AudioWorkletNode | null = null
let sink: GainNode | null = null
let chunksL: Float32Array[] = []
let chunksR: Float32Array[] = []
let captureSr = 44100
let startedAt = 0
let workletReady: Promise<void> | null = null

function ensureWorklet(ctx: AudioContext): Promise<void> {
  if (!workletReady) workletReady = ctx.audioWorklet.addModule(WORKLET_URL)
  return workletReady
}

export function isRecording() { return recording }
export function recordingSeconds() { return recording ? Math.max(0, Tone.now() - startedAt) : 0 }

export async function startRecording() {
  if (recording) return
  await engine.ensureStarted()
  const tap = engine.captureTap
  if (!tap) { toast('Audio not started'); return }
  const ctx = Tone.getContext().rawContext as AudioContext
  await ensureWorklet(ctx)
  captureSr = ctx.sampleRate
  chunksL = []; chunksR = []
  node = new AudioWorkletNode(ctx, 'sf-capture', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2] })
  node.port.onmessage = e => {
    const ch = e.data as Float32Array[]
    chunksL.push(ch[0])
    chunksR.push(ch[1] || ch[0])
  }
  // keep the node pulled by the graph without adding audible signal
  sink = ctx.createGain(); sink.gain.value = 0
  node.connect(sink); sink.connect(ctx.destination)
  Tone.connect(tap, node)
  recording = true
  startedAt = Tone.now()
  toast('● Recording output…')
}

function concat(chunks: Float32Array[]): Float32Array {
  let len = 0
  for (const c of chunks) len += c.length
  const out = new Float32Array(len)
  let o = 0
  for (const c of chunks) { out.set(c, o); o += c.length }
  return out
}

/** Stop and encode/download. Returns false if nothing was captured. */
export async function stopRecording(format: AudioFormat, channels: Channels, kbps = 256): Promise<boolean> {
  if (!recording) return false
  recording = false
  try { if (node) Tone.disconnect(engine.captureTap, node) } catch { /* ok */ }
  if (node) { node.port.onmessage = null; try { node.disconnect() } catch { /* ok */ } node = null }
  if (sink) { try { sink.disconnect() } catch { /* ok */ } sink = null }

  const L = concat(chunksL)
  const R = concat(chunksR)
  chunksL = []; chunksR = []
  if (L.length === 0) { toast('Nothing captured'); return false }

  const ctx = Tone.getContext().rawContext as AudioContext
  const cap = ctx.createBuffer(2, L.length, captureSr)
  cap.copyToChannel(L as any, 0)
  cap.copyToChannel(R as any, 1)
  toast('Encoding recording…')
  try {
    const out = await resample(cap)
    const title = (meta.get('title') as string || 'synthtagram').replace(/[^\w\- ]+/g, '') || 'synthtagram'
    download(encodeAudio(out, format, channels, kbps), `${title} (live).${extFor(format)}`)
    toast('Saved recording ✓')
    return true
  } catch (e) {
    console.error(e)
    toast('Recording export failed — see console')
    return false
  }
}
