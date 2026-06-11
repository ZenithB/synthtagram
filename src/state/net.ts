// Collaboration transport. Two layers, both optional and additive:
//  1. BroadcastChannel — instant sync between tabs of the same browser (also
//     our offline/demo path, zero network needed).
//  2. Trystero — serverless WebRTC mesh; peers discover each other via public
//     nostr relays, then talk directly. No backend to run or pay for.
// Yjs guarantees convergence regardless of delivery order/duplication.

import * as Y from 'yjs'
import { Awareness, encodeAwarenessUpdate, applyAwarenessUpdate, removeAwarenessStates } from 'y-protocols/awareness'
import { doc, docName, roomId } from './doc'
import { setUI, toast, ui } from './store'

export const REMOTE = { remote: true }

export const awareness = new Awareness(doc)

export type PresenceState = {
  name: string
  color: string
  view: string
  sel: { trackId?: string; clipKey?: string } | null
  ph: { mode: string; ticks: number } | null
}

export function setPresence(patch: Partial<PresenceState>) {
  const cur = (awareness.getLocalState() as PresenceState) ?? {
    name: ui.userName, color: ui.userColor, view: ui.view, sel: null, ph: null,
  }
  awareness.setLocalState({ ...cur, ...patch })
}

export function peersList(): { id: number; me: boolean; state: PresenceState }[] {
  const out: { id: number; me: boolean; state: PresenceState }[] = []
  awareness.getStates().forEach((state, id) => {
    if (state && (state as any).name) out.push({ id, me: id === doc.clientID, state: state as PresenceState })
  })
  out.sort((a, b) => (a.me ? -1 : b.me ? 1 : a.id - b.id))
  return out
}

function refreshPeerCount() {
  setUI({ peerCount: peersList().length })
}

// version counter so React components can follow presence changes
let awVersion = 0
const awListeners = new Set<() => void>()
awareness.on('change', () => {
  awVersion++
  refreshPeerCount()
  awListeners.forEach(l => l())
})
export function subscribeAwareness(fn: () => void) {
  awListeners.add(fn)
  return () => { awListeners.delete(fn) }
}
export const awarenessVersion = () => awVersion

// ---------- BroadcastChannel (same browser, instant) ----------
const bc = new BroadcastChannel(`stg-${docName}`)

doc.on('update', (update: Uint8Array, origin: any) => {
  if (origin !== REMOTE) bc.postMessage({ kind: 'u', u: update })
})

awareness.on('update', ({ added, updated, removed }: any, origin: any) => {
  const ids = added.concat(updated).concat(removed)
  const u = encodeAwarenessUpdate(awareness, ids)
  if (origin !== REMOTE) bc.postMessage({ kind: 'a', u })
  if (origin !== REMOTE && trysteroSendAware) trysteroSendAware(u)
})

bc.onmessage = ev => {
  const m = ev.data
  if (m.kind === 'u') Y.applyUpdate(doc, new Uint8Array(m.u), REMOTE)
  else if (m.kind === 'a') applyAwarenessUpdate(awareness, new Uint8Array(m.u), REMOTE)
  else if (m.kind === 'hi') {
    bc.postMessage({ kind: 'u', u: Y.encodeStateAsUpdate(doc) })
    bc.postMessage({ kind: 'a', u: encodeAwarenessUpdate(awareness, [doc.clientID]) })
  }
}
bc.postMessage({ kind: 'hi' })

// ---------- Trystero (cross-device P2P) ----------
let trysteroSendAware: ((u: Uint8Array) => void) | null = null

export async function startP2P() {
  if (!roomId) {
    setUI({ netStatus: 'local' })
    return
  }
  setUI({ netStatus: 'connecting' })
  try {
    const { joinRoom } = await import('trystero')
    const room = joinRoom({ appId: 'synthtagram-v1' }, roomId)
    const [sendU, onU] = room.makeAction<Uint8Array>('yu')
    const [sendS, onS] = room.makeAction<Uint8Array>('ys')
    const [sendA, onA] = room.makeAction<Uint8Array>('aw')
    trysteroSendAware = u => { sendA(u).catch(() => {}) }

    doc.on('update', (update: Uint8Array, origin: any) => {
      if (origin !== REMOTE) sendU(update).catch(() => {})
    })
    onU((u, _peer) => Y.applyUpdate(doc, new Uint8Array(u as any), REMOTE))
    onS((u, _peer) => Y.applyUpdate(doc, new Uint8Array(u as any), REMOTE))
    onA((u, _peer) => applyAwarenessUpdate(awareness, new Uint8Array(u as any), REMOTE))

    room.onPeerJoin(peer => {
      // hand the newcomer the full project + everyone they should know about
      sendS(Y.encodeStateAsUpdate(doc), peer).catch(() => {})
      sendA(encodeAwarenessUpdate(awareness, [...awareness.getStates().keys()]), peer).catch(() => {})
      setUI({ netStatus: 'online' })
      toast('A friend connected 🎶')
    })
    room.onPeerLeave(() => {
      if (Object.keys(room.getPeers()).length === 0) setUI({ netStatus: 'connecting' })
    })

    // re-broadcast presence periodically so awareness never times out (30s ttl)
    setInterval(() => {
      const u = encodeAwarenessUpdate(awareness, [doc.clientID])
      sendA(u).catch(() => {})
      bc.postMessage({ kind: 'a', u })
    }, 15000)

    setUI({ netStatus: 'connecting' })
  } catch (e) {
    console.warn('P2P unavailable, staying local/tab-sync only', e)
    setUI({ netStatus: 'local' })
    toast('Online sync unavailable — sharing works between tabs only')
  }
}

window.addEventListener('beforeunload', () => {
  removeAwarenessStates(awareness, [doc.clientID], 'unload')
  const u = encodeAwarenessUpdate(awareness, [doc.clientID])
  bc.postMessage({ kind: 'a', u })
})
