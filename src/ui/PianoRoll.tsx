// Canvas piano-roll editor. Works on session AND arrangement clips (same data
// shape). Draw mode (B), marquee select, drag/resize/copy, velocity + chance
// lanes, scale highlighting & snap, fold-to-scale, and a Tools menu with
// chordify / arp / strum / humanize / quantize / legato / reverse / double.

import React, { useEffect, useRef, useState } from 'react'
import * as Y from 'yjs'
import { BAR, GRID_OPTIONS, DRUM_PADS, Note, clamp, CLIP_COLORS } from '../types'
import { getClipMap, notesOf, addNote, addNotes, updateNotes, deleteNotes, setClipField, meta, trackById } from '../state/doc'
import { setUI, ui, useUI, toast } from '../state/store'
import { useY } from './hooks'
import { openMenu, ColorRow } from './widgets'
import { inScale, snapToScale, midiName, getScale } from '../theory'
import * as tools from '../noteTools'
import { engine } from '../audio/engine'
import { clips, clipKey } from '../state/doc'

const KEY_W = 48
const LANE_H = 64
const MAX_P = 108
const MIN_P = 21

type Drag =
  | { type: 'move'; ids: string[]; orig: Map<string, Note>; startTick: number; startPitch: number; dTick: number; dPitch: number; copy: boolean; moved: boolean }
  | { type: 'resize'; ids: string[]; orig: Map<string, Note>; startTick: number; dTick: number }
  | { type: 'marquee'; x0: number; y0: number; x1: number; y1: number; add: boolean }
  | { type: 'paint'; lastCell: string }
  | { type: 'lane'; }
  | null

export function PianoRoll() {
  const selClip = useUI(s => s.selClip)
  const gridTicks = useUI(s => s.gridTicks)
  const drawMode = useUI(s => s.drawMode)
  const snapScale = useUI(s => s.snapScale)
  const lane = useUI(s => s.lane)
  const theme = useUI(s => s.theme)
  const [fold, setFold] = useState(false)
  const [, force] = useState(0)
  const bump = () => force(x => x + 1)

  const clipMap = getClipMap(selClip)
  useY(clipMap ?? undefined)
  useY(meta)

  const canvasRef = useRef<HTMLCanvasElement>(null)
  const boxRef = useRef<HTMLDivElement>(null)
  const view = useRef({ scrollX: 0, scrollY: 0, pxPerBar: 150 })
  const sel = useRef<Set<string>>(new Set())
  const dragRef = useRef<Drag>(null)
  const hoverRef = useRef<{ tick: number; pitch: number } | null>(null)

  // reset selection when switching clips
  const clipIdRef = useRef<string | null>(null)
  const clipId = clipMap?.get('id') ?? null
  if (clipId !== clipIdRef.current) {
    clipIdRef.current = clipId
    sel.current = new Set()
    dragRef.current = null
  }

  const trackId: string | null = selClip
    ? (selClip.kind === 'session' ? selClip.trackId : clipMap?.get('trackId') ?? null)
    : null
  const isDrum = trackId ? trackById(trackId)?.get('kind') === 'drum' : false
  const trackColor = trackId ? CLIP_COLORS[trackById(trackId)?.get('color') ?? 0] : '#888'
  const root = meta.get('root') ?? 9
  const scaleId = meta.get('scale') ?? 'minor'

  // ---- visible pitch rows (fold support) ----
  const rowH = isDrum ? 30 : 13
  const pitches: number[] = []
  if (isDrum) {
    for (let p = DRUM_PADS.length - 1; p >= 0; p--) pitches.push(p)
  } else if (fold) {
    for (let p = MAX_P; p >= MIN_P; p--) if (inScale(p, root, scaleId)) pitches.push(p)
  } else {
    for (let p = MAX_P; p >= MIN_P; p--) pitches.push(p)
  }
  const rowOf = (p: number) => pitches.indexOf(p)
  const pitchAtRow = (r: number) => pitches[clamp(r, 0, pitches.length - 1)]

  // first-open: center on content or C4
  const centeredRef = useRef<string | null>(null)
  useEffect(() => {
    if (!clipMap || centeredRef.current === clipId || isDrum) return
    centeredRef.current = clipId
    const ns = notesOf(clipMap)
    const target = ns.length ? Math.max(...ns.map(([, n]) => n.p)) : 64
    const r = rowOf(clamp(target + 4, MIN_P, MAX_P))
    view.current.scrollY = Math.max(0, r * rowH - 60)
    view.current.scrollX = 0
  })

  // ---------------- drawing ----------------
  useEffect(() => {
    let raf = 0
    const draw = () => {
      raf = requestAnimationFrame(draw)
      const canvas = canvasRef.current
      const box = boxRef.current
      if (!canvas || !box || !clipMap) return
      const dpr = window.devicePixelRatio || 1
      const W = box.clientWidth
      const H = box.clientHeight
      if (canvas.width !== W * dpr || canvas.height !== H * dpr) {
        canvas.width = W * dpr
        canvas.height = H * dpr
        canvas.style.width = `${W}px`
        canvas.style.height = `${H}px`
      }
      const ctx = canvas.getContext('2d')!
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      const css = getComputedStyle(document.documentElement)
      const C = (v: string) => css.getPropertyValue(v).trim()
      const len = clipMap.get('len') ?? BAR
      const pxPerTick = view.current.pxPerBar / BAR
      const { scrollX, scrollY } = view.current
      const gridH = H - LANE_H

      ctx.fillStyle = C('--bg0')
      ctx.fillRect(0, 0, W, H)

      // rows
      for (let r = 0; r < pitches.length; r++) {
        const y = r * rowH - scrollY
        if (y + rowH < 0 || y > gridH) continue
        const p = pitches[r]
        const inSc = isDrum || inScale(p, root, scaleId)
        const isRoot = !isDrum && ((p - root) % 12 + 12) % 12 === 0
        const black = !isDrum && [1, 3, 6, 8, 10].includes(p % 12)
        ctx.fillStyle = isRoot ? C('--rowRoot') : inSc ? C('--rowIn') : black ? C('--rowBlack') : C('--rowOut')
        ctx.fillRect(KEY_W, y, W - KEY_W, rowH - 0.5)
      }

      // vertical grid
      const ticksVisible = (W - KEY_W) / pxPerTick + scrollX / pxPerTick
      for (let t = 0; t <= Math.max(len, ticksVisible); t += gridTicks) {
        const x = KEY_W + t * pxPerTick - scrollX
        if (x < KEY_W - 1 || x > W) continue
        const isBar = t % BAR === 0
        const isBeat = t % (BAR / 4) === 0
        ctx.strokeStyle = isBar ? C('--gridBar') : isBeat ? C('--gridBeat') : C('--gridSub')
        ctx.beginPath()
        ctx.moveTo(x, 0)
        ctx.lineTo(x, gridH)
        ctx.stroke()
      }
      // beyond-loop shade
      const loopX = KEY_W + len * pxPerTick - scrollX
      if (loopX < W) {
        ctx.fillStyle = 'rgba(0,0,0,0.35)'
        ctx.fillRect(loopX, 0, W - loopX, gridH)
      }

      // notes
      const entries = notesOf(clipMap)
      const d = dragRef.current
      const noteRect = (n: Note, id: string): [number, number, number, number] => {
        let { p, s, d: dur } = n
        if (d && d.type === 'move' && sel.current.has(id) && !d.copy) {
          s = Math.max(0, n.s + d.dTick)
          p = clamp(n.p + d.dPitch, 0, 127)
        }
        if (d && d.type === 'resize' && sel.current.has(id)) {
          dur = Math.max(6, n.d + d.dTick)
        }
        const r = rowOf(isDrum ? clamp(p, 0, 7) : clamp(p, MIN_P, MAX_P))
        return [KEY_W + s * pxPerTick - scrollX, r * rowH - scrollY, Math.max(3, dur * pxPerTick - 1), rowH - 1.5]
      }
      for (const [id, n] of entries) {
        const r = rowOf(isDrum ? clamp(n.p, 0, 7) : n.p)
        if (r < 0) continue
        const [x, y, w, h] = noteRect(n, id)
        if (x + w < KEY_W || x > W || y + h < 0 || y > gridH) continue
        ctx.globalAlpha = 0.45 + 0.55 * n.v
        ctx.fillStyle = trackColor
        ctx.fillRect(x, y, w, h)
        ctx.globalAlpha = 1
        if (n.pr < 1) {
          ctx.strokeStyle = 'rgba(255,255,255,0.75)'
          ctx.setLineDash([3, 3])
          ctx.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1)
          ctx.setLineDash([])
        }
        if (sel.current.has(id)) {
          ctx.strokeStyle = C('--text')
          ctx.lineWidth = 1.5
          ctx.strokeRect(x + 0.75, y + 0.75, w - 1.5, h - 1.5)
          ctx.lineWidth = 1
        }
        // copy-drag ghost
        if (d && d.type === 'move' && d.copy && sel.current.has(id)) {
          const gx = KEY_W + Math.max(0, n.s + d.dTick) * pxPerTick - scrollX
          const gr = rowOf(clamp(n.p + d.dPitch, isDrum ? 0 : MIN_P, isDrum ? 7 : MAX_P))
          ctx.globalAlpha = 0.4
          ctx.fillRect(gx, gr * rowH - scrollY, w, h)
          ctx.globalAlpha = 1
        }
      }

      // marquee
      if (d && d.type === 'marquee') {
        ctx.strokeStyle = C('--accent')
        ctx.fillStyle = 'rgba(255,176,46,0.12)'
        const x = Math.min(d.x0, d.x1)
        const y = Math.min(d.y0, d.y1)
        ctx.fillRect(x, y, Math.abs(d.x1 - d.x0), Math.abs(d.y1 - d.y0))
        ctx.strokeRect(x, y, Math.abs(d.x1 - d.x0), Math.abs(d.y1 - d.y0))
      }

      // playhead
      let phTicks: number | null = null
      if (engine.playing && selClip) {
        if (selClip.kind === 'session' && engine.mode === 'session') {
          const st = engine.clipState(selClip.trackId, selClip.sceneId)
          if (st.playing) {
            const prog = engine.clipProgress(selClip.trackId)
            if (prog !== null) phTicks = prog * (clipMap.get('len') ?? BAR)
          }
        } else if (selClip.kind === 'arr' && engine.mode === 'arr') {
          const start = clipMap.get('start') ?? 0
          const t = engine.positionTicks()
          if (t >= start && t < start + len) phTicks = (t - start) % len
        }
      }
      if (phTicks !== null) {
        const x = KEY_W + phTicks * pxPerTick - scrollX
        ctx.strokeStyle = C('--playhead')
        ctx.lineWidth = 2
        ctx.beginPath()
        ctx.moveTo(x, 0)
        ctx.lineTo(x, gridH)
        ctx.stroke()
        ctx.lineWidth = 1
      }

      // velocity / chance lane
      ctx.fillStyle = C('--bg1')
      ctx.fillRect(0, gridH, W, LANE_H)
      ctx.strokeStyle = C('--gridBar')
      ctx.beginPath()
      ctx.moveTo(0, gridH + 0.5)
      ctx.lineTo(W, gridH + 0.5)
      ctx.stroke()
      ctx.fillStyle = C('--dim')
      ctx.font = '9px sans-serif'
      ctx.fillText(lane === 'vel' ? 'VELOCITY' : 'CHANCE', 6, gridH + 12)
      for (const [id, n] of entries) {
        const x = KEY_W + n.s * pxPerTick - scrollX
        if (x < KEY_W - 4 || x > W) continue
        const val = lane === 'vel' ? n.v : n.pr
        const bh = val * (LANE_H - 14)
        ctx.fillStyle = trackColor
        ctx.globalAlpha = sel.current.has(id) ? 1 : 0.55
        ctx.fillRect(x - 1.5, gridH + (LANE_H - bh) - 4, 3, bh)
        ctx.beginPath()
        ctx.arc(x, gridH + (LANE_H - bh) - 4, 3, 0, Math.PI * 2)
        ctx.fill()
        ctx.globalAlpha = 1
      }

      // piano keys column (over rows)
      ctx.fillStyle = C('--bg1')
      ctx.fillRect(0, 0, KEY_W, gridH)
      for (let r = 0; r < pitches.length; r++) {
        const y = r * rowH - scrollY
        if (y + rowH < 0 || y > gridH) continue
        const p = pitches[r]
        if (isDrum) {
          ctx.fillStyle = C('--bg2')
          ctx.fillRect(0, y, KEY_W - 1, rowH - 1)
          ctx.fillStyle = C('--text')
          ctx.font = '9px sans-serif'
          ctx.fillText(DRUM_PADS[p], 4, y + rowH / 2 + 3)
        } else {
          const black = [1, 3, 6, 8, 10].includes(p % 12)
          ctx.fillStyle = black ? C('--keyBlack') : C('--keyWhite')
          ctx.fillRect(0, y, KEY_W - 1, rowH - 0.5)
          if (p % 12 === 0) {
            ctx.fillStyle = black ? '#fff' : C('--keyText')
            ctx.font = '9px sans-serif'
            ctx.fillText(midiName(p), 4, y + rowH - 3)
          }
        }
      }
      ctx.strokeStyle = C('--gridBar')
      ctx.beginPath()
      ctx.moveTo(KEY_W - 0.5, 0)
      ctx.lineTo(KEY_W - 0.5, gridH)
      ctx.stroke()
    }
    raf = requestAnimationFrame(draw)
    return () => cancelAnimationFrame(raf)
  }, [clipMap, gridTicks, lane, fold, isDrum, trackColor, root, scaleId, theme, selClip])

  // ---------------- interactions ----------------

  const locate = (e: React.PointerEvent | React.MouseEvent) => {
    const rect = canvasRef.current!.getBoundingClientRect()
    const x = e.clientX - rect.left
    const y = e.clientY - rect.top
    const pxPerTick = view.current.pxPerBar / BAR
    const tick = (x - KEY_W + view.current.scrollX) / pxPerTick
    const row = Math.floor((y + view.current.scrollY) / rowH)
    return { x, y, tick, pitch: pitchAtRow(row), inLane: y > (boxRef.current!.clientHeight - LANE_H), inKeys: x < KEY_W }
  }

  const hitNote = (tick: number, pitch: number): [string, Note] | null => {
    if (!clipMap) return null
    for (const [id, n] of notesOf(clipMap)) {
      const np = isDrum ? clamp(n.p, 0, 7) : n.p
      if (np === pitch && tick >= n.s && tick < n.s + n.d) return [id, n]
    }
    return null
  }

  const snapT = (t: number) => Math.max(0, Math.round(t / gridTicks) * gridTicks)
  const floorT = (t: number) => Math.max(0, Math.floor(t / gridTicks) * gridTicks)

  const addAt = (tick: number, pitch: number) => {
    if (!clipMap) return
    let p = pitch
    if (!isDrum && snapScale) p = snapToScale(p, root, scaleId)
    const s = floorT(tick)
    const id = addNote(clipMap, { p, s, d: gridTicks, v: ui.velo, pr: 1 })
    sel.current = new Set([id])
    engine.previewOn(trackId, p, ui.velo)
    setTimeout(() => engine.previewOff(trackId, p), 180)
    return id
  }

  const onPointerDown = (e: React.PointerEvent) => {
    if (!clipMap || e.button === 2) return
    const loc = locate(e)
    try { (e.target as HTMLElement).setPointerCapture(e.pointerId) } catch { /* synthetic */ }

    if (loc.inKeys) {
      engine.previewOn(trackId, loc.pitch, 0.85)
      setTimeout(() => engine.previewOff(trackId, loc.pitch), 250)
      return
    }
    if (loc.inLane) {
      dragRef.current = { type: 'lane' }
      laneDrag(e)
      return
    }

    const hit = hitNote(loc.tick, loc.pitch)
    if (hit) {
      const [id, n] = hit
      const pxPerTick = view.current.pxPerBar / BAR
      const edgePx = (n.s + n.d) * pxPerTick - (loc.tick * pxPerTick)
      if (drawMode && edgePx > 5) {
        deleteNotes(clipMap, [id], 'Erase note')
        sel.current.delete(id)
        return
      }
      if (!sel.current.has(id)) {
        sel.current = e.shiftKey ? new Set([...sel.current, id]) : new Set([id])
      } else if (e.shiftKey) {
        sel.current.delete(id)
        bump()
        return
      }
      bump()
      const orig = new Map<string, Note>()
      notesOf(clipMap).forEach(([nid, nn]) => { if (sel.current.has(nid)) orig.set(nid, { ...nn }) })
      if (edgePx <= 5) {
        dragRef.current = { type: 'resize', ids: [...sel.current], orig, startTick: loc.tick, dTick: 0 }
      } else {
        dragRef.current = { type: 'move', ids: [...sel.current], orig, startTick: loc.tick, startPitch: loc.pitch, dTick: 0, dPitch: 0, copy: e.altKey, moved: false }
        engine.previewOn(trackId, n.p, n.v)
        setTimeout(() => engine.previewOff(trackId, n.p), 160)
      }
    } else {
      if (drawMode) {
        addAt(loc.tick, loc.pitch)
        dragRef.current = { type: 'paint', lastCell: `${floorT(loc.tick)}:${loc.pitch}` }
      } else {
        if (!e.shiftKey) { sel.current = new Set(); bump() }
        dragRef.current = { type: 'marquee', x0: loc.x, y0: loc.y, x1: loc.x, y1: loc.y, add: e.shiftKey }
      }
    }
  }

  const laneDrag = (e: React.PointerEvent) => {
    if (!clipMap) return
    const loc = locate(e)
    const H = boxRef.current!.clientHeight
    const val = clamp(1 - (loc.y - (H - LANE_H) - 4) / (LANE_H - 14), 0.02, 1)
    // nearest note start within half a grid step
    let best: [string, Note] | null = null
    let bestDist = gridTicks / 2
    for (const [id, n] of notesOf(clipMap)) {
      const dist = Math.abs(n.s - loc.tick)
      if (dist < bestDist) { best = [id, n]; bestDist = dist }
    }
    if (!best) return
    const targets = sel.current.has(best[0]) ? [...sel.current] : [best[0]]
    const patch: Partial<Note> = lane === 'vel' ? { v: val } : { pr: Math.round(val * 20) / 20 }
    updateNotes(clipMap, targets.map(id => [id, patch]), lane === 'vel' ? 'Edit velocity' : 'Edit chance')
  }

  const onPointerMove = (e: React.PointerEvent) => {
    const d = dragRef.current
    if (!d || !clipMap) {
      const loc = clipMap ? locate(e) : null
      if (loc && !loc.inLane && !loc.inKeys) hoverRef.current = { tick: loc.tick, pitch: loc.pitch }
      return
    }
    const loc = locate(e)
    if (d.type === 'move') {
      d.dTick = snapT(loc.tick - d.startTick + 10000 * gridTicks) - 10000 * gridTicks // snapped delta (allow negative)
      d.dTick = Math.round((loc.tick - d.startTick) / gridTicks) * gridTicks
      d.dPitch = (rowOf(loc.pitch) >= 0 && rowOf(d.startPitch) >= 0) ? pitchAtRow(rowOf(loc.pitch)) - d.startPitch : 0
      if (fold && !isDrum) {
        // moving across folded rows = move within scale
        d.dPitch = loc.pitch - d.startPitch
      }
      d.copy = d.copy || e.altKey
      d.moved = d.moved || Math.abs(d.dTick) > 0 || Math.abs(d.dPitch) > 0
    } else if (d.type === 'resize') {
      d.dTick = Math.round((loc.tick - d.startTick) / (e.shiftKey ? 6 : gridTicks)) * (e.shiftKey ? 6 : gridTicks)
    } else if (d.type === 'marquee') {
      d.x1 = loc.x
      d.y1 = loc.y
    } else if (d.type === 'paint') {
      const cell = `${floorT(loc.tick)}:${loc.pitch}`
      if (cell !== d.lastCell && !hitNote(loc.tick, loc.pitch) && loc.tick >= 0) {
        d.lastCell = cell
        addAt(loc.tick, loc.pitch)
      }
    } else if (d.type === 'lane') {
      laneDrag(e)
    }
  }

  const onPointerUp = (e: React.PointerEvent) => {
    const d = dragRef.current
    dragRef.current = null
    if (!d || !clipMap) return
    if (d.type === 'move' && d.moved) {
      if (d.copy) {
        const copies: Note[] = []
        d.orig.forEach(n => {
          copies.push({ ...n, s: Math.max(0, n.s + d.dTick), p: clamp(n.p + d.dPitch, 0, 127) })
        })
        const ids = addNotes(clipMap, copies, 'Copy notes')
        sel.current = new Set(ids)
      } else {
        updateNotes(clipMap, [...d.orig.entries()].map(([id, n]) => [id, {
          s: Math.max(0, n.s + d.dTick),
          p: clamp(n.p + d.dPitch, 0, 127),
        }]), 'Move notes')
      }
    } else if (d.type === 'resize') {
      updateNotes(clipMap, [...d.orig.entries()].map(([id, n]) => [id, { d: Math.max(6, n.d + d.dTick) }]), 'Resize notes')
    } else if (d.type === 'marquee') {
      const pxPerTick = view.current.pxPerBar / BAR
      const t0 = (Math.min(d.x0, d.x1) - KEY_W + view.current.scrollX) / pxPerTick
      const t1 = (Math.max(d.x0, d.x1) - KEY_W + view.current.scrollX) / pxPerTick
      const r0 = Math.floor((Math.min(d.y0, d.y1) + view.current.scrollY) / rowH)
      const r1 = Math.floor((Math.max(d.y0, d.y1) + view.current.scrollY) / rowH)
      const next = d.add ? new Set(sel.current) : new Set<string>()
      notesOf(clipMap).forEach(([id, n]) => {
        const r = rowOf(isDrum ? clamp(n.p, 0, 7) : n.p)
        if (r >= r0 && r <= r1 && n.s + n.d > t0 && n.s < t1) next.add(id)
      })
      sel.current = next
    }
    bump()
  }

  const onDoubleClick = (e: React.MouseEvent) => {
    if (!clipMap || drawMode) return
    const loc = locate(e)
    if (loc.inKeys || loc.inLane) return
    if (!hitNote(loc.tick, loc.pitch)) addAt(loc.tick, loc.pitch)
  }

  const onContextMenu = (e: React.MouseEvent) => {
    e.preventDefault()
    if (!clipMap) return
    const loc = locate(e)
    const hit = !loc.inKeys && !loc.inLane ? hitNote(loc.tick, loc.pitch) : null
    if (hit) {
      deleteNotes(clipMap, sel.current.has(hit[0]) ? [...sel.current] : [hit[0]], 'Delete notes')
      sel.current = new Set()
      bump()
    }
  }

  const onWheel = (e: React.WheelEvent) => {
    e.preventDefault()
    if (e.ctrlKey || e.metaKey) {
      view.current.pxPerBar = clamp(view.current.pxPerBar * (e.deltaY > 0 ? 0.86 : 1.16), 40, 600)
    } else if (e.shiftKey) {
      view.current.scrollX = Math.max(0, view.current.scrollX + e.deltaY)
    } else {
      view.current.scrollX = Math.max(0, view.current.scrollX + e.deltaX)
      view.current.scrollY = clamp(view.current.scrollY + e.deltaY, 0, Math.max(0, pitches.length * rowH - 200))
    }
  }

  // ---- keyboard editing (only while editor is open) ----
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement
      if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)) return
      if (!clipMap || !ui.detailOpen) return
      const mod = e.metaKey || e.ctrlKey
      if ((e.key === 'Delete' || e.key === 'Backspace') && sel.current.size) {
        deleteNotes(clipMap, [...sel.current], 'Delete notes')
        sel.current = new Set()
        bump()
        e.preventDefault()
      } else if (mod && e.key.toLowerCase() === 'a') {
        sel.current = new Set(notesOf(clipMap).map(([id]) => id))
        bump()
        e.preventDefault()
      } else if (mod && e.key.toLowerCase() === 'd') {
        const entries = notesOf(clipMap).filter(([id]) => sel.current.has(id))
        if (!entries.length) return
        const minS = Math.min(...entries.map(([, n]) => n.s))
        const maxE = Math.max(...entries.map(([, n]) => n.s + n.d))
        const span = Math.max(gridTicks, Math.ceil((maxE - minS) / gridTicks) * gridTicks)
        const ids = addNotes(clipMap, entries.map(([, n]) => ({ ...n, s: n.s + span })), 'Duplicate notes')
        sel.current = new Set(ids)
        bump()
        e.preventDefault()
      } else if (e.key.startsWith('Arrow') && sel.current.size) {
        e.preventDefault()
        const entries = notesOf(clipMap).filter(([id]) => sel.current.has(id))
        let patches: [string, Partial<Note>][] = []
        if (e.key === 'ArrowLeft') patches = entries.map(([id, n]) => [id, { s: Math.max(0, n.s - gridTicks) }])
        if (e.key === 'ArrowRight') patches = entries.map(([id, n]) => [id, { s: n.s + gridTicks }])
        if (e.key === 'ArrowUp') patches = tools.transpose(entries, e.shiftKey ? 12 : 1, snapScale && !e.shiftKey && !isDrum, root, scaleId)
        if (e.key === 'ArrowDown') patches = tools.transpose(entries, e.shiftKey ? -12 : -1, snapScale && !e.shiftKey && !isDrum, root, scaleId)
        updateNotes(clipMap, patches, 'Nudge notes')
      }
    }
    window.addEventListener('keydown', h)
    return () => window.removeEventListener('keydown', h)
  }, [clipMap, gridTicks, snapScale, isDrum, root, scaleId])

  if (!selClip || !clipMap) {
    return <div className="roll-empty">Select a clip to edit — or double-click an empty slot to create one 🎵</div>
  }

  // ---------------- toolbar ----------------
  const entriesSel = () => {
    const all = notesOf(clipMap)
    const s = all.filter(([id]) => sel.current.has(id))
    return s.length ? s : all
  }
  const applyPatches = (patches: [string, Partial<Note>][], label: string) => updateNotes(clipMap, patches, label)
  const replaceSelWith = (notes: Record<string, Note>, label: string) => {
    const target = entriesSel()
    deleteNotes(clipMap, target.map(([id]) => id), label)
    const ids = addNotes(clipMap, Object.values(notes), label)
    sel.current = new Set(ids)
    bump()
  }
  const lenBars = Math.round((clipMap.get('len') ?? BAR) / BAR * 4) / 4

  const toolsMenu = (e: React.MouseEvent) => openMenu(e, [
    { label: '🎹 Chordify (diatonic)', fn: () => replaceSelWith(tools.chordify(entriesSel(), root, scaleId), 'Chordify') },
    { label: '⬆ Arpeggiate up', fn: () => replaceSelWith(tools.arpeggiate(entriesSel(), gridTicks, 'up'), 'Arpeggiate') },
    { label: '⬇ Arpeggiate down', fn: () => replaceSelWith(tools.arpeggiate(entriesSel(), gridTicks, 'down'), 'Arpeggiate') },
    { label: '↕ Arpeggiate up-down', fn: () => replaceSelWith(tools.arpeggiate(entriesSel(), gridTicks, 'updown'), 'Arpeggiate') },
    { label: '🎸 Strum', fn: () => applyPatches(tools.strum(entriesSel()), 'Strum') },
    'sep',
    { label: '🎲 Humanize', fn: () => applyPatches(tools.humanize(entriesSel()), 'Humanize') },
    { label: '⏱ Quantize 100%', fn: () => applyPatches(tools.quantize(entriesSel(), gridTicks, 1), 'Quantize') },
    { label: '⏱ Quantize 50%', fn: () => applyPatches(tools.quantize(entriesSel(), gridTicks, 0.5), 'Quantize 50%') },
    { label: '➿ Legato', fn: () => applyPatches(tools.legato(entriesSel(), clipMap.get('len') ?? BAR), 'Legato') },
    { label: '🔁 Reverse', fn: () => applyPatches(tools.reverse(entriesSel(), clipMap.get('len') ?? BAR), 'Reverse') },
    { label: '↗ Velocity ramp up', fn: () => applyPatches(tools.velocityRamp(entriesSel(), 0.4, 1), 'Velocity ramp') },
    { label: '↘ Velocity ramp down', fn: () => applyPatches(tools.velocityRamp(entriesSel(), 1, 0.4), 'Velocity ramp') },
    'sep',
    {
      label: '✖2 Double loop (copy notes)', fn: () => {
        const len = clipMap.get('len') ?? BAR
        addNotes(clipMap, tools.shiftedCopies(notesOf(clipMap), len), 'Double loop')
        setClipField(selClip, 'len', len * 2, 'Double loop')
      },
    },
    {
      label: '÷2 Halve loop', fn: () => {
        const len = Math.max(BAR / 4, (clipMap.get('len') ?? BAR) / 2)
        setClipField(selClip, 'len', len, 'Halve loop')
      },
    },
  ])

  return (
    <div className="roll">
      <div className="roll-toolbar">
        <input
          className="roll-name"
          value={clipMap.get('name') ?? ''}
          onChange={e => setClipField(selClip, 'name', e.target.value, 'Rename clip')}
          data-info="Clip name"
        />
        <button className="color-dot" style={{ background: CLIP_COLORS[clipMap.get('color') ?? 0] }}
          data-info="Clip color"
          onClick={e => openMenu(e, [{ custom: <ColorRow colors={CLIP_COLORS} onPick={i => setClipField(selClip, 'color', i)} /> }])} />
        <label className="roll-field" data-info="Clip length in bars">
          Len
          <select value={lenBars} onChange={e => setClipField(selClip, 'len', Math.round(+e.target.value * BAR), 'Clip length')}>
            {[0.5, 1, 2, 4, 8, 16].map(b => <option key={b} value={b}>{b} bar{b !== 1 ? 's' : ''}</option>)}
          </select>
        </label>
        <label className="roll-field" data-info="Grid resolution for drawing & snapping">
          Grid
          <select value={gridTicks} onChange={e => setUI({ gridTicks: +e.target.value })}>
            {GRID_OPTIONS.map(g => <option key={g.label} value={g.ticks}>{g.label}</option>)}
          </select>
        </label>
        <button className={`tbtn ${drawMode ? 'on' : ''}`} onClick={() => setUI({ drawMode: !drawMode })}
          data-info="Draw mode (B): click to add notes, click notes to erase">✏ Draw</button>
        {!isDrum && (
          <>
            <button className={`tbtn ${snapScale ? 'on' : ''}`} onClick={() => setUI({ snapScale: !snapScale })}
              data-info={`Snap new/transposed notes to ${getScale(scaleId).label}`}>♪ Scale</button>
            <button className={`tbtn ${fold ? 'on' : ''}`} onClick={() => setFold(!fold)}
              data-info="Fold: only show in-scale rows">Fold</button>
          </>
        )}
        <div className="lane-toggle" data-info="Bottom lane: per-note velocity, or per-note play chance (Live 11 style!)">
          <button className={`tbtn ${lane === 'vel' ? 'on' : ''}`} onClick={() => setUI({ lane: 'vel' })}>Vel</button>
          <button className={`tbtn ${lane === 'prob' ? 'on' : ''}`} onClick={() => setUI({ lane: 'prob' })}>Chance</button>
        </div>
        <button className="tbtn" onClick={toolsMenu} data-info="MIDI tools: chordify, arp, strum, humanize, quantize…">🛠 Tools</button>
        <span className="roll-selcount">{sel.current.size > 0 ? `${sel.current.size} selected` : ''}</span>
        <button className="icon-btn roll-close" onClick={() => setUI({ detailOpen: false })} data-info="Close editor (Esc)">✕</button>
      </div>
      <div className="roll-canvas-box" ref={boxRef}>
        <canvas
          ref={canvasRef}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onDoubleClick={onDoubleClick}
          onContextMenu={onContextMenu}
          onWheel={onWheel}
        />
      </div>
    </div>
  )
}
