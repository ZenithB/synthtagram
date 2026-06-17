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
import { doc, docName, roomId, isDocEmpty } from './doc'
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
const sendRqFns: Sender[] = []          // "send me the full project" requests
const servedPeers = new Set<string>()   // peerIds we've already pushed full state to (deduped across strategies)
let leaveTimer: ReturnType<typeof setTimeout> | null = null
let announcedOnline = false

function anyPeers() {
  return wiredRooms.some(r => Object.keys(r.room.getPeers()).length > 0)
}

// PULL-based sync: a freshly-joined peer calls this to ask everyone for the
// full document, instead of only hoping the host's unsolicited push lands.
// On a slow/flaky cellular link the host's fire-and-forget push can be dropped;
// re-requesting until our doc is non-empty is what makes the join reliable.
export function requestState() {
  for (const f of sendRqFns) f(new Uint8Array(0))
}

export async function startP2P() {
  if (!roomId) {
    setUI({ netStatus: 'local' })
    return
  }
  setUI({ netStatus: 'connecting' })

  // CRITICAL: pin our OWN relay lists. Trystero's built-in defaults have rotted
  // — its default Nostr relays now whitelist anonymous keys ("not on white-list")
  // and its default trackers 403/time out. Worse, with no explicit list each peer
  // connects to a RANDOM subset of the default pool, so two devices can land on
  // disjoint relays and never share a meeting point even when both "connect".
  // By pinning an explicit list AND setting redundancy = list length, every peer
  // joins the SAME relays → guaranteed overlap. Lists are best-effort current;
  // dead/gatekeeping entries are harmless as long as one shared one survives.

  // Open, anonymous-friendly Nostr relays on :443 (the path that worked originally).
  // Verified live against Trystero's anonymous announces — relays that hard-reject
  // us are removed so we don't waste connection slots on guaranteed failures:
  //   nostr-pub.wellorder.net → "blocked: spam not permitted"
  //   nostr.mom               → "pow: 28 bits needed" (requires proof-of-work)
  // (damus rate-limits under load but usually accepts, so it stays as backup.)
  const NOSTR_RELAYS = [
    'wss://nos.lol',
    'wss://relay.primal.net',
    'wss://relay.nostr.band',
    'wss://relay.nostr.bg',
    'wss://relay.snort.social',
    'wss://relay.nostr.net',
    'wss://relay.damus.io',
  ]
  // Public WebTorrent signaling trackers (browser WebRTC), all on :443.
  const TORRENT_TRACKERS = [
    'wss://tracker.openwebtorrent.com',
    'wss://tracker.btorrent.xyz',
    'wss://tracker.webtorrent.dev',
  ]

  // Shared base. TURN goes in `turnConfig` (verified in Trystero peer.js:
  // `iceServers: defaultIceServers.concat(turnConfig)`), so it ADDS to Trystero's
  // default Google/Cloudflare STUN rather than replacing it. We must NOT also set
  // rtcConfig.iceServers — that key, if present, overwrites the whole list and
  // would silently drop both the STUN defaults and this TURN. So rtcConfig below
  // carries ONLY non-iceServers tuning.
  //
  // Why TURN matters: same-wifi peers connect on STUN/host candidates alone, but
  // cellular puts a device behind carrier-grade (symmetric) NAT, which STUN
  // cannot traverse — only a TURN *relay* can. We include a `turns:` (TLS) entry
  // on :443 so a relay candidate survives networks that block plaintext TURN but
  // allow outbound HTTPS. (The free openrelay creds are best-effort; a credentialed
  // TURN would be needed for guaranteed symmetric↔symmetric cellular.)
  const baseConfig = {
    appId: 'synthtagram-v1',
    turnConfig: [
      { urls: 'turn:openrelay.metered.ca:80', username: 'openrelayproject', credential: 'openrelayproject' },
      { urls: 'turn:openrelay.metered.ca:443', username: 'openrelayproject', credential: 'openrelayproject' },
      { urls: 'turn:openrelay.metered.ca:443?transport=tcp', username: 'openrelayproject', credential: 'openrelayproject' },
      { urls: 'turns:openrelay.metered.ca:443?transport=tcp', username: 'openrelayproject', credential: 'openrelayproject' },
    ],
    // NOTE: no `iceServers` here on purpose (see above). These widen cross-NAT
    // success without a relay: prefetch candidates (faster, sturdier handshake on
    // flaky radios) and funnel everything onto one transport so ICE only has to
    // win a single 5-tuple. IPv6 candidates are gathered by default — left on, as
    // a public-IPv6 path connects cellular↔home with no NAT traversal at all.
    rtcConfig: { iceCandidatePoolSize: 4, bundlePolicy: 'max-bundle', rtcpMuxPolicy: 'require' },
  }

  const applyDoc = (u: any) => Y.applyUpdate(doc, new Uint8Array(u), REMOTE)
  const applyAware = (u: any) => applyAwarenessUpdate(awareness, new Uint8Array(u), REMOTE)

  // Bridge one Trystero room (one signaling strategy) onto the shared doc.
  // redundancy = relayUrls.length so EVERY peer joins ALL the pinned relays
  // (guaranteed overlap), not a random subset.
  const wire = (joinRoom: any, label: string, relayUrls: string[]) => {
    const config = { ...baseConfig, relayUrls, relayRedundancy: relayUrls.length }
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
    const [sendRq, onRq] = room.makeAction('rq')
    onU((u: any) => applyDoc(u))
    onS((u: any) => applyDoc(u))
    onA((u: any) => applyAware(u))
    sendUFns.push((u, t) => { try { sendU(u, t)?.catch?.(() => {}) } catch { /* ok */ } })
    sendAFns.push((u, t) => { try { sendA(u, t)?.catch?.(() => {}) } catch { /* ok */ } })
    sendRqFns.push((_u, t) => { try { sendRq(new Uint8Array(0), t)?.catch?.(() => {}) } catch { /* ok */ } })

    // Hand a peer the full project + presence (idempotent in Yjs).
    const pushTo = (peer: string) => {
      try { sendS(Y.encodeStateAsUpdate(doc), peer)?.catch?.(() => {}) } catch { /* ok */ }
      try { sendA(encodeAwarenessUpdate(awareness, [...awareness.getStates().keys()]), peer)?.catch?.(() => {}) } catch { /* ok */ }
    }

    // A peer explicitly asked for state — always answer if we actually have a
    // project, even if we already pushed once (their first push may have dropped).
    onRq((_u: any, peer: string) => { if (!isDocEmpty()) pushTo(peer) })

    room.onPeerJoin((peer: string) => {
      console.info('[sf-p2p] peer joined via', label, peer)
      if (leaveTimer) { clearTimeout(leaveTimer); leaveTimer = null }
      // PULL: ask them for the project in case they're the one who has it and we
      // don't. Cheap, and the answer (onRq) only fires if they have content.
      try { sendRq(new Uint8Array(0), peer)?.catch?.(() => {}) } catch { /* ok */ }
      // PUSH: if we have the project, hand it over — but only ONCE per peerId.
      // The same peer connects via BOTH torrent and nostr (shared selfId), so
      // without this guard we'd send the full document 2 strategies × 3 retries
      // = 6 times, congesting the fragile cellular relay path.
      if (!isDocEmpty() && !servedPeers.has(peer)) {
        servedPeers.add(peer)
        pushTo(peer)
        setTimeout(() => pushTo(peer), 700)
        setTimeout(() => pushTo(peer), 2200)
      }
      announcedOnline = true
      setUI({ netStatus: 'online' })
      toast('A friend connected')
    })
    room.onPeerLeave((peer: string) => {
      console.info('[sf-p2p] peer left', label, peer)
      servedPeers.delete(peer)  // a rejoin should get a fresh push
      // Debounce: a single strategy's channel dropping on cellular shouldn't flap
      // the badge to "connecting" while the other strategy still has the peer.
      if (!anyPeers() && !leaveTimer) {
        leaveTimer = setTimeout(() => {
          leaveTimer = null
          if (!anyPeers()) setUI({ netStatus: 'connecting' })
        }, 2500)
      }
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
  const strategies: [string, () => Promise<any>, string[]][] = [
    ['torrent', () => import('trystero/torrent'), TORRENT_TRACKERS],
    ['nostr', () => import('trystero/nostr'), NOSTR_RELAYS],
  ]
  await Promise.all(strategies.map(async ([label, imp, relayUrls]) => {
    try {
      const mod = await imp()
      wire(mod.joinRoom, label, relayUrls)
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
