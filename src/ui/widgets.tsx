// Shared controls: Knob, Fader, Meter, draggable number, modal, context menu.

import React, { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { ParamSpec } from '../audio/schema'
import { clamp } from '../types'
import { useRaf } from './hooks'
import { Icon } from './icons'

export function capturePointer(e: React.PointerEvent) {
  try { (e.target as HTMLElement).setPointerCapture(e.pointerId) } catch { /* synthetic events */ }
}

// ---------------- Knob ----------------

function toNorm(v: number, s: ParamSpec) {
  if (s.exp) return (Math.log(v) - Math.log(s.min)) / (Math.log(s.max) - Math.log(s.min))
  return (v - s.min) / (s.max - s.min)
}
function fromNorm(n: number, s: ParamSpec) {
  n = clamp(n, 0, 1)
  let v = s.exp ? Math.exp(Math.log(s.min) + n * (Math.log(s.max) - Math.log(s.min))) : s.min + n * (s.max - s.min)
  if (s.int || s.steps) v = Math.round(v)
  return clamp(v, s.min, s.max)
}

export function Knob({ spec, value, onChange, size = 36, accent }: {
  spec: ParamSpec
  value: number
  onChange: (v: number) => void
  size?: number
  accent?: string
}) {
  const [drag, setDrag] = useState(false)
  const ref = useRef({ startY: 0, startNorm: 0 })
  const norm = toNorm(clamp(value ?? spec.def, spec.min, spec.max), spec)

  const onPointerDown = (e: React.PointerEvent) => {
    e.preventDefault()
    capturePointer(e)
    ref.current = { startY: e.clientY, startNorm: norm }
    setDrag(true)
  }
  const onPointerMove = (e: React.PointerEvent) => {
    if (!drag) return
    const range = e.shiftKey ? 900 : 180
    const n = ref.current.startNorm + (ref.current.startY - e.clientY) / range
    onChange(fromNorm(n, spec))
  }
  const onPointerUp = () => setDrag(false)

  const a0 = -135
  const a1 = a0 + norm * 270
  const r = size / 2
  const arc = (deg: number) => {
    const rad = ((deg - 90) * Math.PI) / 180
    return [r + (r - 3) * Math.cos(rad), r + (r - 3) * Math.sin(rad)]
  }
  const [x1, y1] = arc(a0)
  const [x2, y2] = arc(a1)
  const large = a1 - a0 > 180 ? 1 : 0
  const display = spec.steps ? spec.steps[clamp(Math.round(value), 0, spec.steps.length - 1)] : (spec.fmt ? spec.fmt(value) : value.toFixed(2))

  return (
    <div className={`knob ${drag ? 'dragging' : ''}`} style={{ width: size + 12 }}
      data-info={`${spec.label}: drag to change, Shift = fine, double-click = reset`}
      onDoubleClick={() => onChange(spec.def)}>
      <svg width={size} height={size} onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp}>
        <circle cx={r} cy={r} r={r - 3} className="knob-track" />
        {norm > 0.004 && <path d={`M ${x1} ${y1} A ${r - 3} ${r - 3} 0 ${large} 1 ${x2} ${y2}`} className="knob-arc" style={accent ? { stroke: accent } : undefined} />}
        <line x1={r} y1={r} x2={r + (r - 7) * Math.cos(((a1 - 90) * Math.PI) / 180)} y2={r + (r - 7) * Math.sin(((a1 - 90) * Math.PI) / 180)} className="knob-needle" />
      </svg>
      <div className="knob-value">{drag ? display : spec.label}</div>
      {drag && <div className="knob-tip">{display}</div>}
    </div>
  )
}

// ---------------- Fader + Meter ----------------

export function Fader({ value, min = -48, max = 6, onChange, height = 76 }: {
  value: number; min?: number; max?: number; onChange: (v: number) => void; height?: number
}) {
  const norm = clamp((value - min) / (max - min), 0, 1)
  const ref = useRef<HTMLDivElement>(null)
  const drag = (e: React.PointerEvent) => {
    const el = ref.current!
    const rect = el.getBoundingClientRect()
    const move = (ev: PointerEvent) => {
      const n = clamp(1 - (ev.clientY - rect.top) / rect.height, 0, 1)
      onChange(Math.round((min + n * (max - min)) * 10) / 10)
    }
    move(e.nativeEvent)
    const up = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }
  return (
    <div ref={ref} className="fader" style={{ height }} onPointerDown={drag}
      onDoubleClick={() => onChange(0)} data-info="Track volume (dB). Double-click resets to 0">
      <div className="fader-fill" style={{ height: `${norm * 100}%` }} />
      <div className="fader-handle" style={{ bottom: `calc(${norm * 100}% - 4px)` }} />
    </div>
  )
}

export function MeterBar({ getDb, height = 76 }: { getDb: () => number; height?: number }) {
  const ref = useRef<HTMLDivElement>(null)
  useRaf(() => {
    const db = getDb()
    const norm = clamp((db + 60) / 66, 0, 1)
    if (ref.current) {
      ref.current.style.height = `${norm * 100}%`
      ref.current.style.background = db > -3 ? 'var(--danger)' : db > -10 ? 'var(--warn)' : 'var(--ok)'
    }
  })
  return (
    <div className="meter" style={{ height }}>
      <div ref={ref} className="meter-fill" />
    </div>
  )
}

// ---------------- Draggable number (BPM etc.) ----------------

export function NumberDrag({ value, onChange, min, max, step = 1, suffix = '', info }: {
  value: number; onChange: (v: number) => void; min: number; max: number; step?: number; suffix?: string; info?: string
}) {
  const ref = useRef({ y: 0, v: 0 })
  const [drag, setDrag] = useState(false)
  return (
    <span
      className={`numdrag ${drag ? 'dragging' : ''}`}
      data-info={info ?? 'Drag vertically to change'}
      onPointerDown={e => {
        capturePointer(e)
        ref.current = { y: e.clientY, v: value }
        setDrag(true)
      }}
      onPointerMove={e => {
        if (!drag) return
        const dv = ((ref.current.y - e.clientY) / 3) * step
        onChange(clamp(Math.round((ref.current.v + dv) / step) * step, min, max))
      }}
      onPointerUp={() => setDrag(false)}
      onDoubleClick={() => {
        const v = prompt('Value', String(value))
        if (v && !isNaN(+v)) onChange(clamp(+v, min, max))
      }}
    >
      {Number.isInteger(step) ? Math.round(value) : value.toFixed(1)}{suffix}
    </span>
  )
}

// ---------------- Modal ----------------

export function Modal({ title, onClose, children, width = 440 }: {
  title: string; onClose: () => void; children: React.ReactNode; width?: number
}) {
  useEffect(() => {
    const h = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', h)
    return () => window.removeEventListener('keydown', h)
  }, [onClose])
  return createPortal(
    <div className="modal-backdrop" onPointerDown={e => { if (e.target === e.currentTarget) onClose() }}>
      <div className="modal" style={{ width }}>
        <div className="modal-head">
          <span>{title}</span>
          <button className="icon-btn" onClick={onClose}><Icon name="close" /></button>
        </div>
        <div className="modal-body">{children}</div>
      </div>
    </div>,
    document.body,
  )
}

// ---------------- Context menu ----------------

export type MenuItem =
  | { label: React.ReactNode; fn: () => void; danger?: boolean; disabled?: boolean }
  | { custom: React.ReactNode }
  | 'sep'

type MenuState = { x: number; y: number; items: MenuItem[] } | null
let setMenuGlobal: ((m: MenuState) => void) | null = null

export function openMenu(e: { clientX: number; clientY: number; preventDefault?: () => void }, items: MenuItem[]) {
  ;(e as any).preventDefault?.()
  setMenuGlobal?.({ x: e.clientX, y: e.clientY, items })
}

export function ContextMenuHost() {
  const [menu, setMenu] = useState<MenuState>(null)
  setMenuGlobal = setMenu
  useEffect(() => {
    if (!menu) return
    const close = () => setMenu(null)
    window.addEventListener('pointerdown', close)
    window.addEventListener('blur', close)
    return () => {
      window.removeEventListener('pointerdown', close)
      window.removeEventListener('blur', close)
    }
  }, [menu])
  if (!menu) return null
  const x = Math.min(menu.x, window.innerWidth - 230)
  const y = Math.min(menu.y, window.innerHeight - menu.items.length * 30 - 20)
  return createPortal(
    <div className="ctx-menu" style={{ left: x, top: y }} onPointerDown={e => e.stopPropagation()}>
      {menu.items.map((it, i) => {
        if (it === 'sep') return <div key={i} className="ctx-sep" />
        if ('custom' in it) return <div key={i} className="ctx-custom" onPointerDown={e => e.stopPropagation()}>{it.custom}</div>
        return (
          <button key={i} className={`ctx-item ${it.danger ? 'danger' : ''}`} disabled={it.disabled}
            onClick={() => { setMenu(null); it.fn() }}>
            {it.label}
          </button>
        )
      })}
    </div>,
    document.body,
  )
}

// ---------------- Color swatch row ----------------

export function ColorRow({ colors, onPick }: { colors: string[]; onPick: (idx: number) => void }) {
  return (
    <div className="color-row">
      {colors.map((c, i) => (
        <button key={i} className="color-swatch" style={{ background: c }} onClick={() => onPick(i)} />
      ))}
    </div>
  )
}
