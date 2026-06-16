// Audio-clip editor: waveform + gain / pitch / reverse / loop / fades.
// Shown in the Clip detail tab when the selected clip is an audio clip.

import React, { useEffect, useRef } from 'react'
import * as Y from 'yjs'
import { BAR } from '../types'
import { getClipMap, setAudioField, setClipField } from '../state/doc'
import { useUI, setUI } from '../state/store'
import { useY } from './hooks'
import { Knob } from './widgets'
import { Icon } from './icons'
import { getSampleBuffer } from '../audio/samples'
import { engine } from '../audio/engine'
import { ParamSpec, fmtDb, fmtSemi } from '../audio/schema'

const GAIN_SPEC: ParamSpec = { key: 'gainDb', label: 'Gain', min: -24, max: 6, def: 0, fmt: fmtDb }
const PITCH_SPEC: ParamSpec = { key: 'pitch', label: 'Pitch', min: -24, max: 24, def: 0, int: true, fmt: fmtSemi }
const FADE_IN_SPEC: ParamSpec = { key: 'fadeIn', label: 'Fade In', min: 0, max: BAR, def: 0, fmt: v => `${Math.round(v)}t` }
const FADE_OUT_SPEC: ParamSpec = { key: 'fadeOut', label: 'Fade Out', min: 0, max: BAR, def: 0, fmt: v => `${Math.round(v)}t` }

function Waveform({ sampleId, color, rev }: { sampleId: string; color: string; rev: boolean }) {
  const ref = useRef<HTMLCanvasElement>(null)
  const boxRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const draw = () => {
      const canvas = ref.current, box = boxRef.current
      if (!canvas || !box) return
      const buf = getSampleBuffer(sampleId)
      const dpr = window.devicePixelRatio || 1
      const W = box.clientWidth, H = box.clientHeight
      canvas.width = W * dpr; canvas.height = H * dpr
      canvas.style.width = `${W}px`; canvas.style.height = `${H}px`
      const ctx = canvas.getContext('2d')!
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      const css = getComputedStyle(document.documentElement)
      ctx.fillStyle = css.getPropertyValue('--bg0').trim()
      ctx.fillRect(0, 0, W, H)
      if (!buf) {
        ctx.fillStyle = css.getPropertyValue('--dim').trim()
        ctx.font = '12px sans-serif'
        ctx.fillText('loading waveform…', 10, H / 2)
        return
      }
      const data = buf.getChannelData(0)
      const step = Math.max(1, Math.floor(data.length / W))
      const mid = H / 2
      ctx.strokeStyle = color
      ctx.globalAlpha = 0.9
      ctx.beginPath()
      for (let x = 0; x < W; x++) {
        const srcX = rev ? (W - 1 - x) : x
        let min = 1, max = -1
        for (let j = 0; j < step; j++) { const v = data[srcX * step + j] || 0; if (v < min) min = v; if (v > max) max = v }
        ctx.moveTo(x + 0.5, mid + min * mid * 0.92)
        ctx.lineTo(x + 0.5, mid + max * mid * 0.92)
      }
      ctx.stroke()
      ctx.globalAlpha = 1
    }
    draw()
    const id = setInterval(draw, 600) // re-draw until the buffer loads
    return () => clearInterval(id)
  }, [sampleId, color, rev])
  return <div className="wave-box" ref={boxRef}><canvas ref={ref} /></div>
}

export function AudioEditor() {
  const selClip = useUI(s => s.selClip)
  const clipMap = getClipMap(selClip) as Y.Map<any> | null
  useY(clipMap ?? undefined)
  if (!selClip || !clipMap || !clipMap.get('audio')) {
    return <div className="roll-empty">Select an audio clip to edit it</div>
  }
  const rev = !!clipMap.get('rev')
  const loop = !!clipMap.get('loop')
  const color = `var(--accent2)`
  const sampleId = clipMap.get('sampleId') || ''

  return (
    <div className="audio-editor">
      <div className="roll-toolbar">
        <span className="device-title"><Icon name="sampler" size={13} /> {clipMap.get('sampleName') || 'Audio'}</span>
        <button className={`tbtn ${loop ? 'on' : ''}`} data-info="Loop the sample for the clip's length"
          onClick={() => setAudioField(selClip, 'loop', loop ? 0 : 1)}><Icon name="loop" size={12} /> Loop</button>
        <button className={`tbtn ${rev ? 'on' : ''}`} data-info="Play the sample backwards"
          onClick={() => setAudioField(selClip, 'rev', rev ? 0 : 1)}><Icon name="reverse" size={12} /> Reverse</button>
        <label className="roll-field" data-info="Clip length (loop region) in bars">
          Len
          <select value={Math.max(0.25, Math.round((clipMap.get('len') ?? BAR) / BAR * 4) / 4)} onChange={e => setClipField(selClip, 'len', Math.round(+e.target.value * BAR), 'Clip length')}>
            {[0.25, 0.5, 1, 2, 4, 8, 16].map(b => <option key={b} value={b}>{b} bar{b !== 1 ? 's' : ''}</option>)}
          </select>
        </label>
        <button className="icon-btn" style={{ marginLeft: 'auto' }} onClick={() => setUI({ detailOpen: false })} data-info="Close editor (Esc)"><Icon name="close" size={12} /></button>
      </div>
      <div className="audio-body">
        <Waveform sampleId={sampleId} color={getComputedStyle(document.documentElement).getPropertyValue('--accent2').trim() || '#559DA0'} rev={rev} />
        <div className="audio-knobs">
          <Knob spec={GAIN_SPEC} value={clipMap.get('gainDb') ?? 0} onChange={v => setAudioField(selClip, 'gainDb', v)} size={40} />
          <Knob spec={PITCH_SPEC} value={clipMap.get('pitch') ?? 0} onChange={v => setAudioField(selClip, 'pitch', v)} size={40} />
          <Knob spec={FADE_IN_SPEC} value={clipMap.get('fadeIn') ?? 0} onChange={v => setAudioField(selClip, 'fadeIn', v)} size={40} />
          <Knob spec={FADE_OUT_SPEC} value={clipMap.get('fadeOut') ?? 0} onChange={v => setAudioField(selClip, 'fadeOut', v)} size={40} />
        </div>
      </div>
    </div>
  )
}
