// Live performance monitor: audio render-thread load (the real glitch metric),
// main-thread FPS, JS heap, and P2P traffic. Browsers don't expose true CPU %,
// so we show the honest proxies — audio-thread load and frame rate — clearly
// labelled. Samples once a second while open; tears everything down on close.

import React, { useEffect, useRef, useState } from 'react'
import { engine } from '../audio/engine'
import { getNetStats } from '../state/net'
import { getAudioPrefs, setAudioPrefs, LatencyMode } from '../audio/prefs'
import { setUI, useUI } from '../state/store'
import { Icon } from './icons'

function fmtBytes(n: number) {
  if (n < 1024) return `${Math.round(n)} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1024 / 1024).toFixed(2)} MB`
}

type Tone3 = 'ok' | 'warn' | 'danger'
const tone = (v: number, warn: number, danger: number): Tone3 => (v >= danger ? 'danger' : v >= warn ? 'warn' : 'ok')

function Bar({ pct, t }: { pct: number; t: Tone3 }) {
  return <div className="perf-bar"><div className={`perf-bar-fill ${t}`} style={{ width: `${Math.max(0, Math.min(100, pct))}%` }} /></div>
}

function Row({ k, v, t, info }: { k: string; v: React.ReactNode; t?: Tone3; info?: string }) {
  return (
    <div className="perf-row" data-info={info}>
      <span className="perf-k">{k}</span>
      <span className={`perf-v ${t ?? ''}`}>{v}</span>
    </div>
  )
}

export function PerfMonitor() {
  const open = useUI(s => s.perfMonitorOpen)
  const [s, setS] = useState<any>(null)
  const prev = useRef<{ t: number; sent: number; recv: number } | null>(null)
  const fpsRef = useRef(60)

  useEffect(() => {
    if (!open) return
    // FPS via rAF (main-thread responsiveness)
    let raf = 0, last = performance.now(), acc = 0, frames = 0
    const loop = (t: number) => {
      raf = requestAnimationFrame(loop)
      frames++; acc += t - last; last = t
      if (acc >= 500) { fpsRef.current = Math.round((frames * 1000) / acc); frames = 0; acc = 0 }
    }
    raf = requestAnimationFrame(loop)

    const sample = () => {
      const now = performance.now()
      const net = getNetStats()
      let sendRate = 0, recvRate = 0
      if (prev.current) {
        const dt = (now - prev.current.t) / 1000 || 1
        sendRate = Math.max(0, (net.sent - prev.current.sent) / dt)
        recvRate = Math.max(0, (net.recv - prev.current.recv) / dt)
      }
      prev.current = { t: now, sent: net.sent, recv: net.recv }
      const mem = (performance as any).memory
      const c = (navigator as any).connection
      setS({
        fps: fpsRef.current,
        audio: engine.perfStats(),
        mem: mem ? { used: mem.usedJSHeapSize, total: mem.totalJSHeapSize, limit: mem.jsHeapSizeLimit } : null,
        net, sendRate, recvRate,
        conn: c ? { type: c.effectiveType || '?', downlink: c.downlink || 0, rtt: c.rtt || 0, save: !!c.saveData } : null,
      })
    }
    sample()
    const iv = setInterval(sample, 1000)
    return () => { cancelAnimationFrame(raf); clearInterval(iv) }
  }, [open])

  if (!open) return null
  const close = () => setUI({ perfMonitorOpen: false })

  const a = s?.audio
  const load = a?.audioLoad
  const avgPct = Math.round((load?.avg ?? 0) * 100)
  const peakPct = Math.round((load?.peak ?? 0) * 100)
  const underPct = +(((load?.underrun ?? 0) * 100).toFixed(2))
  // Cross-browser render-thread health (the metric that catches the crackle).
  const probe = a?.probe
  const keepPct = probe ? Math.min(100, Math.round((probe.minRtf ?? 1) * 100)) : 100
  const keepTone: Tone3 = keepPct >= 99 ? 'ok' : keepPct >= 97 ? 'warn' : 'danger'
  const glitches = probe?.glitches ?? 0
  const struggling = glitches > 0 || keepPct < 99
  // One-click mitigation: bump the output buffer a tier (most headroom first),
  // and if already at the largest buffer, drop 2× oversampling (~halves CPU).
  const fixBuffer = () => {
    const p = getAudioPrefs()
    if (p.latency !== 'playback') {
      const next: LatencyMode = p.latency === 'interactive' ? 'balanced' : 'playback'
      setAudioPrefs({ latency: next })
    } else {
      setAudioPrefs({ oversample: false })
    }
    engine.resetGlitchCount()
    location.reload()
  }
  const fixLabel = (() => {
    const p = getAudioPrefs()
    if (p.latency !== 'playback') return 'Add buffer headroom & restart'
    if (p.oversample) return 'Switch to Native (½ CPU) & restart'
    return null // already maxed out on the easy wins
  })()
  const fps = s?.fps ?? 0
  const fpsTone: Tone3 = fps >= 50 ? 'ok' : fps >= 35 ? 'warn' : 'danger'
  const memPct = s?.mem && s.mem.limit ? Math.round((s.mem.used / s.mem.limit) * 100) : 0

  return (
    <div className="modal-backdrop" onClick={close}>
      <div className="modal export-dialog perf-dialog" onClick={e => e.stopPropagation()}>
        <div className="modal-head">
          <span className="modal-title"><Icon name="spectrum" size={15} /> Performance monitor</span>
          <button className="icon-btn" onClick={close} data-info="Close"><Icon name="close" size={13} /></button>
        </div>

        {/* AUDIO ENGINE — the render-thread health that actually causes glitches */}
        <div className="perf-section">Audio engine</div>
        {/* Cross-browser render-thread health — the metric that catches popping/
            crackling on EVERY browser (FPS above is the wrong thread). */}
        {probe?.supported ? (
          <>
            <div className="perf-row wide" data-info="How well the audio render thread keeps up with real time. Below 100% means it can't render fast enough and the output buffer underruns — that's the popping/crackling. Works on every browser.">
              <span className="perf-k">Keeping up{probe.hasClock === false ? ' (approx)' : ''}</span>
              <span className={`perf-v ${keepTone}`}>{keepPct}%</span>
            </div>
            <Bar pct={keepPct} t={keepTone} />
            <Row k="Glitch events" v={glitches} t={glitches > 0 ? 'danger' : 'ok'} info="Audible dropouts the render thread has dropped since audio started. Should be 0 — anything above means you heard crackles." />
            {probe.hasClock && <Row k="Worst callback gap" v={`${probe.maxGapMs ?? 0} ms`} info="Longest pause between audio render callbacks (diagnostic). Large is normal with a big buffer; a sudden spike means the thread stalled." />}
          </>
        ) : (
          <div className="perf-hint">Starting the render-thread probe… play something to begin measuring.</div>
        )}

        {struggling && (
          <div className="perf-fix">
            <div className="perf-hint danger" style={{ marginTop: 6 }}>
              <b>The audio thread is struggling.</b> That's the crackling — it can't render fast enough for the current buffer. {fixLabel ? 'One click below trades a little latency for headroom (reloads to rebuild the engine; your project is saved).' : 'You\'re already on the largest buffer and Native rate — reduce track/effect count, or freeze busy tracks.'}
            </div>
            {fixLabel && (
              <button className="export-btn record" onClick={fixBuffer} style={{ marginTop: 6 }}>
                <Icon name="bolt" size={13} /> {fixLabel}
              </button>
            )}
          </div>
        )}

        {load?.supported && (
          <>
            <div className="perf-row wide" data-info="Chromium-only: how full the audio thread's per-callback CPU budget is, averaged over 1s. Sustained high = dropouts. The Keeping-up metric above catches shorter stalls and works everywhere.">
              <span className="perf-k">Audio-thread load <span className="perf-sub">· Chromium</span></span>
              <span className={`perf-v ${tone(avgPct, 70, 90)}`}>{avgPct}%</span>
            </div>
            <Bar pct={avgPct} t={tone(avgPct, 70, 90)} />
            <Row k="Peak load" v={`${peakPct}%`} t={tone(peakPct, 80, 95)} info="Worst single render quantum in the last second (Chromium)." />
            <Row k="Dropouts (underruns)" v={`${underPct}%`} t={underPct > 0 ? 'danger' : 'ok'} info="Fraction of the last second the audio thread missed its deadline (Chromium). Should be 0." />
          </>
        )}
        <Row k="Sample rate" v={a ? `${Math.round((a.sampleRate || 0) / 100) / 10} kHz${a.oversampling ? ' · 2×' : ''}` : '—'} />
        <Row k="Output latency" v={a?.latencyMs ? `~${a.latencyMs} ms` : '—'} info="Output buffer + device latency. A bigger buffer (Audio settings) raises this but stops crackling." />
        <Row k="Tracks · effects · returns" v={a ? `${a.tracks} · ${a.effects} · ${a.returns}` : '—'} info="Live node count — more tracks/effects = more audio-thread work." />

        {/* MAIN THREAD (CPU proxy) */}
        <div className="perf-section">Main thread (CPU)</div>
        <div className="perf-row wide" data-info="Browsers don't expose true CPU%. Frame rate is the proxy: a sustained drop below 60 means the main thread (UI, modulation, your edits) is saturated.">
          <span className="perf-k">Frame rate</span>
          <span className={`perf-v ${fpsTone}`}>{fps} fps</span>
        </div>
        <Bar pct={(fps / 60) * 100} t={fpsTone} />
        <Row k="Frame time" v={`${fps ? (1000 / fps).toFixed(1) : '—'} ms`} info="Time per frame. 16.7ms = a smooth 60fps." />

        {/* MEMORY */}
        <div className="perf-section">Memory</div>
        {s?.mem ? (
          <>
            <div className="perf-row wide">
              <span className="perf-k">JS heap</span>
              <span className={`perf-v ${tone(memPct, 70, 90)}`}>{fmtBytes(s.mem.used)} / {fmtBytes(s.mem.limit)} · {memPct}%</span>
            </div>
            <Bar pct={memPct} t={tone(memPct, 70, 90)} />
            <div className="perf-hint">JavaScript heap only (sample audio &amp; buffers live outside it). A steadily climbing number across a long session can mean a leak.</div>
          </>
        ) : (
          <div className="perf-hint">Heap size isn't exposed by this browser (Chrome/Edge only).</div>
        )}

        {/* NETWORK */}
        <div className="perf-section">Network (peer-to-peer)</div>
        <Row k="Status" v={s?.net.status === 'online' ? `Online · ${s.net.peers} peer${s.net.peers === 1 ? '' : 's'}` : s?.net.status === 'connecting' ? 'Connecting…' : 'Local (no room)'} t={s?.net.status === 'online' ? 'ok' : undefined} />
        <Row k="Signaling" v={s?.net.strategies?.length ? s.net.strategies.join(' + ') : '—'} info="Which WebRTC signaling networks are wired (peers found via these, then talk directly)." />
        <Row k="Sent" v={`${fmtBytes(s?.net.sent ?? 0)} · ${fmtBytes(s?.sendRate ?? 0)}/s`} info="Project-sync data sent over P2P (Yjs updates). Tiny — audio never crosses the wire." />
        <Row k="Received" v={`${fmtBytes(s?.net.recv ?? 0)} · ${fmtBytes(s?.recvRate ?? 0)}/s`} />
        {s?.conn && <Row k="Connection" v={`${s.conn.type} · ${s.conn.downlink} Mbps · ${s.conn.rtt} ms rtt${s.conn.save ? ' · data-saver' : ''}`} info="Browser's estimate of your network link." />}

        <div className="export-divider" />
        <div className="perf-hint"><b>Keeping up</b> dipping below 100% or <b>Glitch events</b> climbing is the crackling. The buffer (Audio settings) is the fix: bigger buffer = more headroom; <b>Native</b> rate ~halves CPU. Frame rate below is the UI thread — unrelated to audio dropouts.</div>
      </div>
    </div>
  )
}
