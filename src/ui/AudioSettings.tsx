// Audio Settings: the CPU/latency tradeoff in the user's hands. Bigger buffer =
// fewer glitches when many tracks play; Native (no 2x oversampling) ~halves CPU.
// Changing the AudioContext means a rebuild, so Apply reloads the page (project
// is autosaved). Mirrors ExportDialog's markup so it looks native.

import React, { useEffect, useState } from 'react'
import { getAudioPrefs, setAudioPrefs, AudioPrefs, LatencyMode } from '../audio/prefs'
import { engine } from '../audio/engine'
import { setUI, useUI } from '../state/store'
import { Icon } from './icons'

const TIERS: { id: LatencyMode; label: string; hint: string }[] = [
  { id: 'interactive', label: 'Low',      hint: 'Smallest buffer — tightest timing for playing in live.' },
  { id: 'balanced',    label: 'Balanced', hint: 'Medium buffer — a sensible middle ground.' },
  { id: 'playback',    label: 'Stable',   hint: 'Largest buffer — most headroom, best for many tracks/effects. Adds a little latency.' },
]
const RATES: { id: AudioPrefs['sampleRate']; label: string }[] = [
  { id: 'auto', label: 'Auto' }, { id: 44100, label: '44.1k' }, { id: 48000, label: '48k' },
]

export function AudioSettings() {
  const open = useUI(s => s.audioSettingsOpen)
  const [p, setP] = useState<AudioPrefs>(getAudioPrefs)
  // re-sync pending state from disk each time the dialog is opened
  useEffect(() => { if (open) setP(getAudioPrefs()) }, [open])
  if (!open) return null

  const saved = getAudioPrefs()
  const changed = JSON.stringify(p) !== JSON.stringify(saved)
  const close = () => setUI({ audioSettingsOpen: false })
  const apply = () => { setAudioPrefs(p); location.reload() }
  const optimize = () => setP({ ...p, oversample: false, latency: 'playback' })

  const liveRate = engine.sampleRate ? `${Math.round(engine.sampleRate / 100) / 10} kHz` : '—'
  const lat = engine.outputLatencyMs()
  const liveLat = lat ? `~${lat} ms` : '—'

  return (
    <div className="modal-backdrop" onClick={close}>
      <div className="modal export-dialog" onClick={e => e.stopPropagation()}>
        <div className="modal-head">
          <span className="modal-title"><Icon name="tools" size={15} /> Audio settings</span>
          <button className="icon-btn" onClick={close} data-info="Close"><Icon name="close" size={13} /></button>
        </div>

        <div className="export-row">
          <span className="export-label">Buffer size</span>
          <div className="seg">
            {TIERS.map(t => (
              <button key={t.id} className={p.latency === t.id ? 'on' : ''} onClick={() => setP({ ...p, latency: t.id })}>{t.label}</button>
            ))}
          </div>
        </div>
        <div className="export-hint">{TIERS.find(t => t.id === p.latency)?.hint} A bigger buffer is the fix for audio dropping out when track count climbs.</div>

        <div className="export-divider" />

        <div className="export-row">
          <span className="export-label">Quality</span>
          <div className="seg">
            <button className={p.oversample ? 'on' : ''} onClick={() => setP({ ...p, oversample: true })}>2× oversample</button>
            <button className={!p.oversample ? 'on' : ''} onClick={() => setP({ ...p, oversample: false })}>Native</button>
          </div>
        </div>
        <div className="export-hint">2× oversampling keeps FM &amp; distortion alias-free but roughly doubles CPU. <b>Native</b> frees up the most processing for more tracks and effects.</div>

        {!p.oversample && (
          <div className="export-row">
            <span className="export-label">Sample rate</span>
            <div className="seg">
              {RATES.map(r => (
                <button key={String(r.id)} className={p.sampleRate === r.id ? 'on' : ''} onClick={() => setP({ ...p, sampleRate: r.id })}>{r.label}</button>
              ))}
            </div>
          </div>
        )}

        <div className="export-divider" />

        <div className="export-row">
          <span className="export-label">Now running</span>
          <span className="export-unit">{liveRate} · {liveLat} output latency</span>
        </div>

        <div className="export-actions">
          <button className="export-btn" onClick={optimize}><Icon name="bolt" size={13} /> Optimize for fewer glitches</button>
        </div>

        <div className="export-divider" />

        <div className="export-actions">
          <button className="export-btn record" disabled={!changed} onClick={apply}><Icon name="power" size={13} /> Apply &amp; restart audio</button>
          <button className="export-btn ghost" onClick={close}>Cancel</button>
        </div>
        <div className="export-hint">Applying reloads the page to rebuild the audio engine — your project is saved automatically.</div>
      </div>
    </div>
  )
}
