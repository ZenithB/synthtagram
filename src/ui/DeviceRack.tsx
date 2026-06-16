// Bottom-panel device chain for the selected track: instrument module with
// schema-driven knobs (drum kits get a pad selector), then the effect chain
// with bypass / reorder / remove, then an add-effect menu.

import React, { useRef, useState } from 'react'
import * as Y from 'yjs'
import { DRUM_PADS } from '../types'
import {
  trackById, setInstParam, setInstrument, addFx, removeFx, moveFx, setFxParam, setFxOn,
  addLfo, removeLfo, setLfoField, setLfoTarget,
} from '../state/doc'
import { useUI } from '../state/store'
import { useY, useRaf } from './hooks'
import { Knob, openMenu } from './widgets'
import {
  INSTRUMENTS, EFFECTS, instSchema, fxSchema, defaultsFor,
  LFO_SHAPES, LFO_DIVS, LFO_PARAMS,
} from '../audio/schema'
import { INST_PRESETS, DRUM_KITS } from '../packs'
import { engine } from '../audio/engine'
import { Icon } from './icons'

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
        <span className="device-title"><Icon name={schema.icon} size={13} /> {schema.label}</span>
        {kind !== 'drum' && (
          <select
            className="device-select"
            value={type}
            data-info="Swap the instrument module (resets its knobs)"
            onChange={e => setInstrument(trackId, e.target.value, defaultsFor(instSchema(e.target.value).params), `Instrument: ${e.target.value}`)}
          >
            {INSTRUMENTS.filter(i => i.type !== 'drum').map(i => <option key={i.type} value={i.type}>{i.label}</option>)}
          </select>
        )}
        <select
          className="device-select"
          value=""
          data-info={kind === 'drum' ? 'Load a drum kit preset' : 'Load an instrument preset'}
          onChange={e => { if (e.target.value) onPreset(e.target.value) }}
        >
          <option value="">{kind === 'drum' ? 'Kits…' : 'Presets…'}</option>
          {(kind === 'drum' ? kitNames : presetMatches).map(n => <option key={n} value={n}>{n}</option>)}
        </select>
      </div>

      {kind === 'drum' ? (
        <div className="drum-panel">
          <div className="pad-grid">
            {DRUM_PADS.map((name, i) => (
              <button
                key={i}
                className={`pad ${pad === i ? 'on' : ''}`}
                data-info={`${name} — click to audition & edit (keys A–K play pads)`}
                onClick={() => { setPad(i); engine.previewOn(trackId, i, 0.9) }}
              >
                {name}
              </button>
            ))}
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
    </div>
  )
}

export function DeviceRack() {
  const selTrackId = useUI(s => s.selTrackId)
  const track = selTrackId ? trackById(selTrackId) : undefined
  useY(track)
  if (!selTrackId || !track) {
    return <div className="roll-empty">Select a track to see its instrument & effects</div>
  }
  const fxArr = track.get('fx') as Y.Array<Y.Map<any>>
  const lfoArr = track.get('lfos') as Y.Array<Y.Map<any>> | undefined
  return (
    <div className="rack">
      <InstrumentPanel trackId={selTrackId} track={track} />
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
    </div>
  )
}
