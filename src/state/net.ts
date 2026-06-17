// Collaboration transport. Two layers, both optional and additive:
//  1. BroadcastChannel — instant sync between tabs of the same browser (also
//     our offline/demo path, zero network needed).
//  2. Trystero — serverless WebRTC mesh. The only thing that ever fails here is
//     *signaling* (the public relay that introduces two strangers); once peers
//     find each other they talk directly. Any single public relay network can
//     be down, gatekept, or firewalled on a given network, so we join the SAME
//     room over SEVERAL strategies at once (BitTorrent trackers + Nostr relays,
//     both on :443) and bridge them all to one Yjs doc. Whichever network
//     introduces the peers wins; the other is harmless redundancy.
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

type Sender = (u: Uint8Array, target?: string) => void
type WiredRoom = { label: string; room: any; sendS: Sender }
const wiredRooms: WiredRoom[] = []
const sendUFns: Sender[] = []
const sendAFns: Sender[] = []
let announcedOnline = false

function anyPeers() {
  return wiredRooms.some(r => Object.keys(r.room.getPeers()).length > 0)
}

export async function startP2P() {
  if (!roomId) {
    setUI({ netStatus: 'local' })
    return
  }
  setUI({ netStatus: 'connecting' })

  // Shared config for every strategy. TURN goes in `turnConfig` (NOT
  // rtcConfig.iceServers) — Trystero concats it onto its default Google/
  // Cloudflare STUN. Overriding rtcConfig.iceServers would DROP that STUN.
  // STUN alone got phone↔laptop working originally; TURN is a bonus for
  // symmetric-NAT cases and is purely additive (dead TURN just falls back).
  const config = {
    appId: 'synthtagram-v1',
    relayRedundancy: 5,
    turnConfig: [
      { urls: 'turn:openrelay.metered.ca:80', username: 'openrelayproject', credential: 'openrelayproject' },
      { urls: 'turn:openrelay.metered.ca:443', username: 'openrelayproject', credential: 'openrelayproject' },
      { urls: 'turn:openrelay.metered.ca:443?transport=tcp', username: 'openrelayproject', credential: 'openrelayproject' },
    ],
  }

  const applyDoc = (u: any) => Y.applyUpdate(doc, new Uint8Array(u), REMOTE)
  const applyAware = (u: any) => applyAwarenessUpdate(awareness, new Uint8Array(u), REMOTE)

  // Bridge one Trystero room (one signaling strategy) onto the shared doc.
  const wire = (joinRoom: any, label: string) => {
    let room: any
    try {
      room = joinRoom(config, roomId)
    } catch (e) {
      console.warn('[sf-p2p] join failed via', label, e)
      return
    }
    const [sendU, onU] = room.makeAction('yu')
    const [sendS, onS] = room.makeAction('ys')
    const [sendA, onA] = room.makeAction('aw')
    onU((u: any) => applyDoc(u))
    onS((u: any) => applyDoc(u))
    onA((u: any) => applyAware(u))
    sendUFns.push((u, t) => { try { sendU(u, t)?.catch?.(() => {}) } catch { /* ok */ } })
    sendAFns.push((u, t) => { try { sendA(u, t)?.catch?.(() => {}) } catch { /* ok */ } })

    room.onPeerJoin((peer: string) => {
      console.info('[sf-p2p] peer joined via', label, peer)
      // Hand the newcomer the full project + presence. Resend a few times —
      // the data channel may have just opened and an immediate send can race
      // it, which would otherwise leave the joiner stuck blank.
      const pushState = () => {
        try { sendS(Y.encodeStateAsUpdate(doc), peer)?.catch?.(() => {}) } catch { /* ok */ }
        try { sendA(encodeAwarenessUpdate(awareness, [...awareness.getStates().keys()]), peer)?.catch?.(() => {}) } catch { /* ok */ }
      }
      pushState()
      setTimeout(pushState, 600)
      setTimeout(pushState, 2000)
      announcedOnline = true
      setUI({ netStatus: 'online' })
      toast('A friend connected')
    })
    room.onPeerLeave((peer: string) => {
      console.info('[sf-p2p] peer left', label, peer)
      if (!anyPeers()) setUI({ netStatus: 'connecting' })
    })

    wiredRooms.push({ label, room, sendS })
  }

  // Fan a local change out across every connected strategy. Duplicate
  // deliveries (a peer reachable via two strategies) are idempotent in Yjs.
  trysteroSendAware = u => { for (const f of sendAFns) f(u) }
  doc.on('update', (update: Uint8Array, origin: any) => {
    if (origin !== REMOTE) for (const f of sendUFns) f(update)
  })

  // Load + wire each strategy independently so one failing import/relay set
  // never blocks the others. Both run on :443 (rarely firewalled): WebTorrent
  // trackers are purpose-built for browser WebRTC signaling and stay quietly
  // reliable; Nostr is the secondary path (some relays now gatekeep, but
  // redundancy across the pool means several still accept us). MQTT is omitted
  // deliberately — its brokers sit on odd ports (the first thing locked-down
  // networks block), it's the flakiest in practice, and its bundle is ~40x the
  // others, so it was all cost and little coverage.
  const strategies: [string, () => Promise<any>][] = [
    ['torrent', () => import('trystero/torrent')],
    ['nostr', () => import('trystero/nostr')],
  ]
  await Promise.all(strategies.map(async ([label, imp]) => {
    try {
      const mod = await imp()
      wire(mod.joinRoom, label)
    } catch (e) {
      console.warn('[sf-p2p] strategy unavailable:', label, e)
    }
  }))

  // expose for diagnosing connectivity from the console
  ;(window as any).__p2p = {
    rooms: wiredRooms,
    peers: () => wiredRooms.flatMap(r => Object.keys(r.room.getPeers()).map(p => `${r.label}:${p}`)),
  }

  if (wiredRooms.length === 0) {
    setUI({ netStatus: 'local' })
    toast('Online sync unavailable — sharing works between tabs only')
    return
  }

  // re-broadcast presence periodically so awareness never times out (30s ttl)
  setInterval(() => {
    const u = encodeAwarenessUpdate(awareness, [doc.clientID])
    for (const f of sendAFns) f(u)
    bc.postMessage({ kind: 'a', u })
  }, 15000)

  if (!announcedOnline) setUI({ netStatus: 'connecting' })
}

window.addEventListener('beforeunload', () => {
  removeAwarenessStates(awareness, [doc.clientID], 'unload')
  const u = encodeAwarenessUpdate(awareness, [doc.clientID])
  bc.postMessage({ kind: 'a', u })
})
