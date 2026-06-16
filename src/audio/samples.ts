// Local sample store for the Sampler. Audio bytes live in IndexedDB (per
// browser) keyed by id; the doc only stores the id + name. Decoded AudioBuffers
// are cached in memory. v1 is local-first: a collaborator who lacks a sample
// hears silence on that track until they load their own (P2P transfer = future).

import { nanoid } from 'nanoid'
import * as Tone from 'tone'

const mem = new Map<string, AudioBuffer>()
const pending = new Set<string>()
let onReadyCb: ((id: string) => void) | null = null
export function onSampleReady(cb: (id: string) => void) { onReadyCb = cb }

let dbp: Promise<IDBDatabase> | null = null
function db(): Promise<IDBDatabase> {
  if (!dbp) {
    dbp = new Promise((res, rej) => {
      const req = indexedDB.open('synthtagram-samples', 1)
      req.onupgradeneeded = () => req.result.createObjectStore('samples')
      req.onsuccess = () => res(req.result)
      req.onerror = () => rej(req.error)
    })
  }
  return dbp
}

async function idbPut(id: string, rec: { name: string; bytes: ArrayBuffer }) {
  const d = await db()
  await new Promise<void>((res, rej) => {
    const tx = d.transaction('samples', 'readwrite')
    tx.objectStore('samples').put(rec, id)
    tx.oncomplete = () => res()
    tx.onerror = () => rej(tx.error)
  })
}
async function idbGet(id: string): Promise<{ name: string; bytes: ArrayBuffer } | undefined> {
  const d = await db()
  return new Promise((res, rej) => {
    const tx = d.transaction('samples', 'readonly')
    const r = tx.objectStore('samples').get(id)
    r.onsuccess = () => res(r.result)
    r.onerror = () => rej(r.error)
  })
}

function decode(bytes: ArrayBuffer): Promise<AudioBuffer> {
  // slice() so the persisted copy isn't detached by decodeAudioData
  const ctx = (Tone.getContext().rawContext as unknown as AudioContext)
  return ctx.decodeAudioData(bytes.slice(0))
}

/** Synchronous lookup; if missing, kicks off a background restore from IndexedDB. */
export function getSampleBuffer(id: string): AudioBuffer | undefined {
  if (!id) return undefined
  const b = mem.get(id)
  if (b) return b
  if (!pending.has(id)) {
    pending.add(id)
    idbGet(id).then(async rec => {
      if (rec) {
        try {
          const buf = await decode(rec.bytes)
          mem.set(id, buf)
          onReadyCb?.(id)
        } catch { /* undecodable */ }
      }
      pending.delete(id)
    }).catch(() => pending.delete(id))
  }
  return undefined
}

export function sampleName(id: string) { return id }

async function store(name: string, bytes: ArrayBuffer): Promise<{ id: string; name: string }> {
  const id = nanoid(10)
  const buf = await decode(bytes)
  mem.set(id, buf)
  await idbPut(id, { name, bytes }).catch(() => {})
  onReadyCb?.(id)
  return { id, name }
}

export async function importSampleFile(file: File): Promise<{ id: string; name: string }> {
  const bytes = await file.arrayBuffer()
  const name = file.name.replace(/\.[^.]+$/, '').slice(0, 24)
  return store(name, bytes)
}

// ---------------- mic recording ----------------
let rec: MediaRecorder | null = null
let chunks: Blob[] = []
let stream: MediaStream | null = null

export function isRecordingSample() { return !!rec }

export async function startSampleRecording() {
  if (rec) return
  stream = await navigator.mediaDevices.getUserMedia({ audio: true })
  chunks = []
  rec = new MediaRecorder(stream)
  rec.ondataavailable = e => { if (e.data.size) chunks.push(e.data) }
  rec.start()
}

export async function stopSampleRecording(): Promise<{ id: string; name: string } | null> {
  if (!rec) return null
  const r = rec
  return new Promise(resolve => {
    r.onstop = async () => {
      const blob = new Blob(chunks, { type: r.mimeType || 'audio/webm' })
      stream?.getTracks().forEach(t => t.stop())
      rec = null; stream = null; chunks = []
      try {
        const bytes = await blob.arrayBuffer()
        const stamp = new Date().toISOString().slice(11, 19)
        resolve(await store(`Rec ${stamp}`, bytes))
      } catch { resolve(null) }
    }
    r.stop()
  })
}
