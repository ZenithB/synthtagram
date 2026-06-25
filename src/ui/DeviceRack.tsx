// Bottom-panel device chain for the selected track: instrument module with
// schema-driven knobs (drum kits get a pad selector), then the effect chain
// with bypass / reorder / remove, then an add-effect menu.

import React, { useRef, useState } from 'react'
import * as Y from 'yjs'
import { DRUM_PADS } from '../types'
import {
  trackById, setInstParam, setInstrument, addFx, removeFx, moveFx, setFxParam, setFxOn,
  setInstOut, setFxOut,
  addLfo, removeLfo, setLfoField, setLfoTarget, setSend,
  addMidiFx, removeMidiFx, setMidiFxParam, setMidiFxOn, midifxOf,
  ensureMacros, macrosOf, setMacroValue, addMacroTarget, clearMacroTargets, setMacroName,
  returns, setReturnGain, setReturnParam, setReturnFxType, setSamplerSample, setDrumPadSample, busList,
} from '../state/doc'
import { attemptBusSend } from './actions'
import { useUI, toast } from '../state/store'
import { useY, useRaf } from './hooks'
import { Knob, openMenu } from './widgets'
import {
  INSTRUMENTS, EFFECTS, instSchema, fxSchema, defaultsFor,
  LFO_SHAPES, LFO_DIVS, LFO_PARAMS, MIDI_FX, midiFxSchema, mixSpec, fmtPct, fmtDb, ParamSpec,
} from '../audio/schema'
import { INST_PRESETS, DRUM_KITS } from '../packs'
import { engine } from '../audio/engine'
import { saveUserPreset } from '../userlib'
import { importSampleFile, startSampleRecording, stopSampleRecording, isRecordingSample } from '../audio/samples'
import { Icon } from './icons'

const SEND_A_SPEC: ParamSpec = { key: 'sendA', label: '→ A', min: 0, max: 1, def: 0, fmt: fmtPct }
const SEND_B_SPEC: ParamSpec = { key: 'sendB', label: '→ B', min: 0, max: 1, def: 0, fmt: fmtPct }
const MACRO_SPEC: ParamSpec = { key: 'm', label: '', min: 0, max: 1, def: 0, fmt: fmtPct }
const OUT_SPEC: ParamSpec = { key: 'out', label: 'Out', min: -30, max: 30, def: 0, fmt: fmtDb }

// Per-device output meter (level shown AFTER the output knob), styled like the
// LFO scope. Polls only while its device rack is mounted (selected track).
function DevMeter({ trackId, deviceId }: { trackId: string; deviceId: string }) {
  const ref = useRef<HTMLDivElement>(null)
  useRaf(() => {
    if (!ref.current) return
    const db = engine.deviceMeterDb(trackId, deviceId)
    const norm = Math.max(0, Math.min(1, (db + 60) / 66))
    const col = db > -3 ? 'var(--danger)' : db > -10 ? 'var(--warn)' : 'var(--ok)'
    ref.current.style.width = `${norm * 100}%`
    ref.current.style.background = col
    ref.current.style.boxShadow = norm > 0.02 ? `0 0 5px ${col}` : 'none'
  })
  return <div className="dev-meter"><div ref={ref} className="dev-meter-fill" /></div>
}

// Meter + pre-meter output knob footer shared by every device card.
function DeviceOut({ trackId, deviceId, out, onChange }: { trackId: string; deviceId: string; out: number; onChange: (v: number) => void }) {
  return (
    <div className="device-out" data-info="Output level (pre-meter) — trim this device before the next">
      <DevMeter trackId={trackId} deviceId={deviceId} />
      <Knob spec={OUT_SPEC} value={out} onChange={onChange} size={30} />
    </div>
  )
}

function targetRange(track: Y.Map<any>, dest: string, fxId: string, pkey: string): [number, number] {
  let spec
  if (dest === 'inst') spec = instSchema(track.get('inst').get('type')).params.find(s => s.key === pkey)
  else if (dest === 'mix') spec = mixSpec(pkey)
  else {
    const fxArr = track.get('fx') as Y.Array<Y.Map<any>>
    for (let i = 0; i < fxArr.length; i++) if (fxArr.get(i).get('id') === fxId) { spec = fxSchema(fxArr.get(i).get('type')).params.find(s => s.key === pkey); break }
  }
  return spec ? [spec.min, spec.max] : [0, 1]
}

// All continuous (non-enum) parameters on a track that an LFO can modulate.
type ModTarget = { dest: 'inst' | 'fx'; fxId: string; pkey: string; label: string }
function modTargets(track: Y.Map<any>): ModTarget[] {
  const out: ModTarget[] = []
  const instSch = instSchema(track.get('inst').get('type'))
  instSch.params.filter(p => !p.steps).forEach(p =>
    out.push({ dest: 'inst', fxId: '', pkey: p.key, label: `${instSch.label} · ${p.label}` }))
  ;(track.get('fx') as Y.Array<Y.Map<any>>).forEach(f => {
    const sch = fxSchema(f.get('type'))
    sch.params.filter(p => !p.steps).forEach(p =>
      out.push({ dest: 'fx', fxId: f.get('id'), pkey: p.key, label: `${sch.label} · ${p.label}` }))
  })
  return out
}
const targetVal = (t: ModTarget) => `${t.dest}|${t.fxId}|${t.pkey}`

function LfoScope({ lfoId }: { lfoId: string }) {
  const ref = useRef<HTMLDivElement>(null)
  useRaf(() => {
    if (ref.current) ref.current.style.left = `${((engine.lfoValue(lfoId) + 1) / 2) * 100}%`
  })
  return <div className="lfo-scope"><span className="lfo-scope-mid" /><div ref={ref} className="lfo-scope-dot" /></div>
}

function LfoCard({ trackId, track, lfo }: { trackId: string; track: Y.Map<any>; lfo: Y.Map<any> }) {
  const id = lfo.get('id') as string
  const on = !!lfo.get('on')
  const sync = !!lfo.get('sync')
  const dest = lfo.get('dest') as string
  const pkey = lfo.get('pkey') as string
  const curVal = dest && pkey ? `${dest}|${lfo.get('fxId') || ''}|${pkey}` : ''
  const targets = modTargets(track)

  return (
    <div className={`device lfo-device ${on ? '' : 'bypassed'}`}>
      <div className="device-head">
        <button className={`power ${on ? 'on' : ''}`} data-info="Enable / disable this LFO" onClick={() => setLfoField(trackId, id, 'on', on ? 0 : 1, on ? 'Disable LFO' : 'Enable LFO')}><Icon name="power" size={13} /></button>
        <span className="device-title"><Icon name="lfo" size={13} /> LFO</span>
        <LfoScope lfoId={id} />
        <span className="device-actions">
          <button className="icon-btn" data-info="Remove this LFO" onClick={() => removeLfo(trackId, id)}><Icon name="close" size={11} /></button>
        </span>
      </div>
      <div className="lfo-row">
        <select className="device-select" value={lfo.get('shape') | 0} data-info="LFO waveform shape"
          onChange={e => setLfoField(trackId, id, 'shape', +e.target.value)}>
          {LFO_SHAPES.map((s, i) => <option key={s} value={i}>{s}</option>)}
        </select>
        <button className={`tbtn ${sync ? 'on' : ''}`} data-info="Sync rate to song tempo (off = free-running Hz)"
          onClick={() => setLfoField(trackId, id, 'sync', sync ? 0 : 1)}>Sync</button>
        {sync
          ? <select className="device-select" value={lfo.get('rate') | 0} data-info="Tempo-synced rate"
              onChange={e => setLfoField(trackId, id, 'rate', +e.target.value)}>
              {LFO_DIVS.map((d, i) => <option key={d} value={i}>{d}</option>)}
            </select>
          : <Knob spec={LFO_PARAMS[2]} value={lfo.get('hz') ?? 1} onChange={v => setLfoField(trackId, id, 'hz', v)} size={34} />}
      </div>
      <div className="lfo-row">
        <Knob spec={LFO_PARAMS[0]} value={lfo.get('depth') ?? 0.5} onChange={v => setLfoField(trackId, id, 'depth', v)} size={36} />
        <Knob spec={LFO_PARAMS[1]} value={lfo.get('phase') ?? 0} onChange={v => setLfoField(trackId, id, 'phase', v)} size={36} />
        <select className="device-select lfo-target" value={curVal} data-info="Parameter this LFO modulates (around its manual value)"
          onChange={e => {
            if (!e.target.value) { setLfoTarget(trackId, id, '', '', ''); return }
            const [d, fxId, k] = e.target.value.split('|')
            setLfoTarget(trackId, id, d, fxId, k)
          }}>
          <option value="">— map to… —</option>
          {targets.map(t => <option key={targetVal(t)} value={targetVal(t)}>{t.label}</option>)}
        </select>
      </div>
    </div>
  )
}

function InstrumentPanel({ trackId, track }: { trackId: string; track: Y.Map<any> }) {
  const inst = track.get('inst') as Y.Map<any>
  const type = inst.get('type') as string
  const params = inst.get('params') as Y.Map<number>
  const schema = instSchema(type)
  const kind = track.get('kind')
  const [pad, setPad] = useState(0)
  const padSamples = inst.get('padSamples') as Y.Map<string> | undefined
  const padNames = inst.get('padNames') as Y.Map<string> | undefined

  // Right-click a drum pad → drop an audio clip on it (that pad becomes a
  // sampler; the rest of the kit stays synthesized).
  const pickPadSample = (i: number) => {
    const input = document.createElement('input')
    input.type = 'file'; input.accept = 'audio/*'
    input.onchange = async () => {
      const f = input.files?.[0]; if (!f) return
      try { const ref = await importSampleFile(f); setDrumPadSample(trackId, i, ref.id, ref.name); toast(`${DRUM_PADS[i]} → “${ref.name}”`) }
      catch { toast('Could not decode that audio file') }
    }
    input.click()
  }

  const presetMatches = (kind === 'drum' ? [] : INST_PRESETS).map(p => p.name)
  const kitNames = DRUM_KITS.map(k => k.name)

  const onPreset = (name: string) => {
    if (kind === 'drum') {
      const kit = DRUM_KITS.find(k => k.name === name)
      if (kit) setInstrument(trackId, 'drum', { ...kit.params }, `Kit: ${name}`)
    } else {
      const p = INST_PRESETS.find(x => x.name === name)
      if (p) setInstrument(trackId, p.type, { ...p.params }, `Preset: ${name}`)
    }
  }

  return (
    <div className="device inst-device">
      <div className="device-head">
        <span className="device-title"><Icon name={schema.icon} size={13} /> {kind === 'audio' ? 'Audio Track' : schema.label}</span>
        {kind === 'synth' && (
          <select
            className="device-select"
            value={type}
            data-info="Swap the instrument module (resets its knobs)"
            onChange={e => setInstrument(trackId, e.target.value, defaultsFor(instSchema(e.target.value).params), `Instrument: ${e.target.value}`)}
          >
            {INSTRUMENTS.filter(i => i.type !== 'drum' && i.type !== 'audiobus').map(i => <option key={i.type} value={i.type}>{i.label}</option>)}
          </select>
        )}
        {kind !== 'audio' && (
          <select
            className="device-select"
            value=""
            data-info={kind === 'drum' ? 'Load a drum kit preset' : 'Load an instrument preset'}
            onChange={e => { if (e.target.value) onPreset(e.target.value) }}
          >
            <option value="">{kind === 'drum' ? 'Kits…' : 'Presets…'}</option>
            {(kind === 'drum' ? kitNames : presetMatches).map(n => <option key={n} value={n}>{n}</option>)}
          </select>
        )}
        {kind === 'audio' && <span className="device-audio-hint">audio clips · stereo · fx + sends apply</span>}
        {kind === 'synth' && type !== 'sampler' && (
          <button className="icon-btn" data-info="Save these settings as your own preset"
            onClick={() => {
              const name = prompt('Save preset as…', `My ${schema.label}`)
              if (name) { saveUserPreset({ name, type, params: Object.fromEntries(params.entries()) }); toast(`Saved “${name}” to My Sounds`) }
            }}><Icon name="star" size={13} /></button>
        )}
      </div>

      {type === 'sampler' && <SamplerControls trackId={trackId} inst={inst} />}

      {kind === 'drum' ? (
        <div className="drum-panel">
          <div className="pad-grid">
            {DRUM_PADS.map((name, i) => {
              const sampled = !!padSamples?.get(String(i))
              return (
                <button
                  key={i}
                  className={`pad ${pad === i ? 'on' : ''} ${sampled ? 'sampled' : ''}`}
                  data-info={sampled
                    ? `${name} → sample “${padNames?.get(String(i)) || 'audio'}”. Right-click to replace or clear.`
                    : `${name} — click to audition. Right-click to drop an audio clip on this pad.`}
                  onClick={() => { setPad(i); engine.previewOn(trackId, i, 0.9) }}
                  onContextMenu={e => openMenu(e, [
                    { label: <><Icon name="sampler" size={12} /> {sampled ? 'Replace sample…' : 'Load audio clip…'}</>, fn: () => pickPadSample(i) },
                    ...(sampled ? [{ label: <><Icon name="close" size={12} /> Clear sample (back to synth)</>, fn: () => setDrumPadSample(trackId, i, null), danger: true }] : []),
                  ])}
                >
                  {name}
                  {sampled && <span className="pad-sample-dot" />}
                </button>
              )
            })}
          </div>
          <div className="knob-row">
            {['tune', 'decay', 'level'].map(suffix => {
              const spec = schema.params.find(p => p.key === `p${pad}_${suffix}`)!
              return (
                <Knob
                  key={spec.key}
                  spec={{ ...spec, label: suffix[0].toUpperCase() + suffix.slice(1) }}
                  value={params.get(spec.key) ?? spec.def}
                  onChange={v => setInstParam(trackId, spec.key, v)}
                  size={40}
                />
              )
            })}
          </div>
        </div>
      ) : (
        <div className="knob-row">
          {schema.params.map(spec => (
            <Knob key={spec.key} spec={spec} value={params.get(spec.key) ?? spec.def} onChange={v => setInstParam(trackId, spec.key, v)} size={38} />
          ))}
        </div>
      )}
      <DeviceOut trackId={trackId} deviceId="inst" out={inst.get('out') ?? 0} onChange={v => setInstOut(trackId, v)} />
    </div>
  )
}

function FxCard({ trackId, fx }: { trackId: string; fx: Y.Map<any> }) {
  const type = fx.get('type') as string
  const fxId = fx.get('id') as string
  const on = !!fx.get('on')
  const params = fx.get('params') as Y.Map<number>
  const schema = fxSchema(type)
  return (
    <div className={`device fx-device ${on ? '' : 'bypassed'}`}>
      <div className="device-head">
        <button className={`power ${on ? 'on' : ''}`} data-info="Bypass effect" onClick={() => setFxOn(trackId, fxId, !on)}><Icon name="power" size={13} /></button>
        <span className="device-title"><Icon name={schema.icon} size={13} /> {schema.label}</span>
        <span className="device-actions">
          <button className="icon-btn" data-info="Move effect earlier in the chain" onClick={() => moveFx(trackId, fxId, -1)}><Icon name="chevL" size={11} /></button>
          <button className="icon-btn" data-info="Move effect later in the chain" onClick={() => moveFx(trackId, fxId, 1)}><Icon name="chevR" size={11} /></button>
          <button className="icon-btn" data-info="Remove effect" onClick={() => removeFx(trackId, fxId)}><Icon name="close" size={11} /></button>
        </span>
      </div>
      <div className="knob-row">
        {schema.params.map(spec => (
          <Knob key={spec.key} spec={spec} value={params.get(spec.key) ?? spec.def} onChange={v => setFxParam(trackId, fxId, spec.key, v)} size={38} />
        ))}
      </div>
      <DeviceOut trackId={trackId} deviceId={fxId} out={fx.get('out') ?? 0} onChange={v => setFxOut(trackId, fxId, v)} />
    </div>
  )
}

function SamplerControls({ trackId, inst }: { trackId: string; inst: Y.Map<any> }) {
  const [recording, setRecording] = useState(isRecordingSample())
  const name = inst.get('sampleName') as string | undefined
  const pickFile = () => {
    const input = document.createElement('input')
    input.type = 'file'; input.accept = 'audio/*'
    input.onchange = async () => {
      const f = input.files?.[0]; if (!f) return
      try { const ref = await importSampleFile(f); setSamplerSample(trackId, ref.id, ref.name); toast(`Loaded “${ref.name}”`) }
      catch { toast('Could not decode that audio file') }
    }
    input.click()
  }
  const toggleRec = async () => {
    if (isRecordingSample()) {
      const ref = await stopSampleRecording(); setRecording(false)
      if (ref) { setSamplerSample(trackId, ref.id, ref.name); toast('Recorded a sample') }
    } else {
      try { await startSampleRecording(); setRecording(true); toast('Recording… click again to stop') }
      catch { toast('Microphone permission denied') }
    }
  }
  return (
    <div className="sampler-controls">
      <span className="sampler-name" data-info="Loaded sample (plays pitched by the notes you play)">{name || 'No sample'}</span>
      <button className="tbtn" onClick={pickFile} data-info="Import an audio file as the sample"><Icon name="folder" size={12} /> Load</button>
      <button className={`tbtn ${recording ? 'on' : ''}`} onClick={toggleRec} data-info="Record from your microphone"><Icon name="mic" size={12} /> {recording ? 'Stop' : 'Rec'}</button>
    </div>
  )
}

function MidiFxCard({ trackId, fx }: { trackId: string; fx: Y.Map<any> }) {
  const type = fx.get('type') as string
  const id = fx.get('id') as string
  const on = !!fx.get('on')
  const params = fx.get('params') as Y.Map<number>
  const schema = midiFxSchema(type)
  return (
    <div className={`device midifx-device ${on ? '' : 'bypassed'}`}>
      <div className="device-head">
        <button className={`power ${on ? 'on' : ''}`} data-info="Bypass" onClick={() => setMidiFxOn(trackId, id, !on)}><Icon name="power" size={13} /></button>
        <span className="device-title"><Icon name={schema.icon} size={13} /> {schema.label}</span>
        <span className="device-actions">
          <button className="icon-btn" data-info="Remove" onClick={() => removeMidiFx(trackId, id)}><Icon name="close" size={11} /></button>
        </span>
      </div>
      {schema.params.length === 0
        ? <div className="midifx-note">Forces notes into the project scale</div>
        : <div className="knob-row">
            {schema.params.map(spec => (
              <Knob key={spec.key} spec={spec} value={params.get(spec.key) ?? spec.def} onChange={v => setMidiFxParam(trackId, id, spec.key, v)} size={34} />
            ))}
          </div>}
    </div>
  )
}

function SendsCard({ trackId, track }: { trackId: string; track: Y.Map<any> }) {
  const sends = track.get('sends') as Y.Map<number> | undefined
  const buses = busList().filter(b => b.get('id') !== trackId)   // a bus can't send to itself
  return (
    <div className="device sends-device">
      <div className="device-head"><span className="device-title"><Icon name="send" size={13} /> Sends</span></div>
      <div className="knob-row">
        <Knob spec={SEND_A_SPEC} value={track.get('sendA') ?? 0} onChange={v => setSend(trackId, 'sendA', v)} size={36} />
        <Knob spec={SEND_B_SPEC} value={track.get('sendB') ?? 0} onChange={v => setSend(trackId, 'sendB', v)} size={36} />
        {buses.map(b => {
          const bid = b.get('id') as string
          const spec: ParamSpec = { key: `bus-${bid}`, label: `→ ${b.get('name')}`, min: 0, max: 1, def: 0, fmt: fmtPct }
          return <Knob key={bid} spec={spec} value={(sends?.get(bid) as number) ?? 0} onChange={v => attemptBusSend(trackId, bid, v)} size={36} />
        })}
      </div>
    </div>
  )
}

function MacroPanel({ trackId, track }: { trackId: string; track: Y.Map<any> }) {
  const macros = macrosOf(track)
  if (!macros) {
    return <button className="add-fx add-macro" data-info="Add 8 macro knobs — one knob morphs many parameters"
      onClick={() => ensureMacros(trackId)}><Icon name="macro" size={12} /> Macros</button>
  }
  const ranges = (_k: string, dest: string, fxId: string, pkey: string) => targetRange(track, dest, fxId, pkey)
  const targets = modTargets(track)
  return (
    <div className="device macro-device">
      <div className="device-head">
        <span className="device-title"><Icon name="macro" size={13} /> Macros</span>
        <span className="device-actions">
          <button className="icon-btn" data-info="Randomize all macros (happy accidents)"
            onClick={() => macros.toArray().forEach((m, i) => { if ((m.get('targets') as Y.Array<any>).length) setMacroValue(trackId, i, Math.random(), ranges) })}><Icon name="dice" size={12} /></button>
        </span>
      </div>
      <div className="macro-grid">
        {macros.toArray().map((m, i) => {
          const nTargets = (m.get('targets') as Y.Array<any>).length
          return (
            <div key={i} className="macro-cell">
              <Knob spec={MACRO_SPEC} value={m.get('value') ?? 0} onChange={v => setMacroValue(trackId, i, v, ranges)} size={34}
                accent={nTargets ? 'var(--accent2)' : undefined} />
              <button className={`macro-label ${nTargets ? 'mapped' : ''}`}
                data-info={nTargets ? `${nTargets} mapped — click to remap` : 'Click to map this macro to a parameter'}
                onClick={e => openMenu(e, [
                  ...(nTargets ? [{ label: <><Icon name="close" size={11} /> Clear {nTargets} mapping{nTargets > 1 ? 's' : ''}</>, fn: () => clearMacroTargets(trackId, i) } as const, 'sep' as const] : []),
                  ...targets.map(t => ({ label: t.label, fn: () => addMacroTarget(trackId, i, t.dest, t.fxId, t.pkey) })),
                ])}>{m.get('name') || `M${i + 1}`}</button>
            </div>
          )
        })}
      </div>
    </div>
  )
}

function ReturnCard({ idx, ret }: { idx: number; ret: Y.Map<any> }) {
  const type = ret.get('fxType') as string
  const params = ret.get('params') as Y.Map<number>
  const schema = fxSchema(type)
  const gainSpec: ParamSpec = { key: 'g', label: 'Vol', min: -48, max: 6, def: 0, fmt: v => `${v > 0 ? '+' : ''}${v.toFixed(0)}dB` }
  return (
    <div className="device return-device">
      <div className="device-head">
        <span className="device-title"><Icon name="reverb" size={13} /> {ret.get('name')}</span>
        <select className="device-select" value={type}
          data-info="Effect on this return bus"
          onChange={e => setReturnFxType(idx, e.target.value, defaultsFor(fxSchema(e.target.value).params))}>
          {EFFECTS.filter(f => f.type !== 'duck').map(f => <option key={f.type} value={f.type}>{f.label}</option>)}
        </select>
      </div>
      <div className="knob-row">
        {schema.params.map(spec => (
          <Knob key={spec.key} spec={spec} value={params.get(spec.key) ?? spec.def} onChange={v => setReturnParam(idx, spec.key, v)} size={34} />
        ))}
        <Knob spec={gainSpec} value={ret.get('gain') ?? 0} onChange={v => setReturnGain(idx, v)} size={34} />
      </div>
    </div>
  )
}

export function DeviceRack() {
  const selTrackId = useUI(s => s.selTrackId)
  const track = selTrackId ? trackById(selTrackId) : undefined
  useY(track)
  useY(returns)
  if (!selTrackId || !track) {
    return <div className="roll-empty">Select a track to see its instrument & effects</div>
  }
  const fxArr = track.get('fx') as Y.Array<Y.Map<any>>
  const lfoArr = track.get('lfos') as Y.Array<Y.Map<any>> | undefined
  const midiArr = midifxOf(track)
  const kind = track.get('kind')
  return (
    <div className="rack">
      {kind !== 'drum' && kind !== 'bus' && (
        <>
          {midiArr?.toArray().map(m => <MidiFxCard key={m.get('id')} trackId={selTrackId} fx={m} />)}
          <button className="add-fx add-midi" data-info="Add a live MIDI effect (processes notes before the instrument)"
            onClick={e => openMenu(e, MIDI_FX.map(mf => ({
              label: <><Icon name={mf.icon} size={12} /> {mf.label}</>,
              fn: () => addMidiFx(selTrackId, mf.type, defaultsFor(mf.params)),
            })))}>
            <Icon name="plus" size={12} /> MIDI
          </button>
          <div className="chain-arrow">→</div>
        </>
      )}
      {kind === 'bus'
        ? <div className="bus-input-label" data-info="Audio arriving from sends enters here"><Icon name="send" size={13} /> Bus input</div>
        : <InstrumentPanel trackId={selTrackId} track={track} />}
      <div className="chain-arrow">→</div>
      {fxArr.toArray().map(f => <FxCard key={f.get('id')} trackId={selTrackId} fx={f} />)}
      <button
        className="add-fx"
        data-info="Add an effect to this track's chain"
        onClick={e => openMenu(e, EFFECTS.map(ef => ({
          label: <><Icon name={ef.icon} size={12} /> {ef.label}</>,
          fn: () => addFx(selTrackId, ef.type, defaultsFor(ef.params)),
        })))}
      >
        <Icon name="plus" size={12} /> Effect
      </button>
      {lfoArr?.toArray().map(l => <LfoCard key={l.get('id')} trackId={selTrackId} track={track} lfo={l} />)}
      <button className="add-fx add-lfo" data-info="Add an LFO — modulate any knob on this track around its set value"
        onClick={() => addLfo(selTrackId)}>
        <Icon name="lfo" size={12} /> LFO
      </button>
      <MacroPanel trackId={selTrackId} track={track} />
      <SendsCard trackId={selTrackId} track={track} />
      <div className="rack-divider" data-info="Shared return buses — every track sends here" />
      {returns.toArray().map((r, i) => <ReturnCard key={r.get('id')} idx={i} ret={r} />)}
    </div>
  )
}
