// Arrangement View: the linear timeline. Clips drag/resize/duplicate with bar
// snapping, the ruler seeks, the loop brace sets the loop region, and you can
// see your collaborators' playheads drift by as ghosts.

import React, { useRef, useState, useSyncExternalStore } from 'react'
import * as Y from 'yjs'
import { BAR, CLIP_COLORS, clamp, ticksToBBS } from '../types'
import {
  tracks, arr, meta, addArrClip, moveArrClip, resizeArrClip, deleteArrClip,
  duplicateArrClip, setClipField, setLoopRegion, arrEndTicks, setTrackMix, clipToJSON,
  clips, clipKey,
} from '../state/doc'
import { engine } from '../audio/engine'
import { setUI, ui, useUI, toast } from '../state/store'
import { useY, useRaf } from './hooks'
import { openMenu, ColorRow, MenuItem, capturePointer } from './widgets'
import { selectClip } from './actions'
import { peersList, subscribeAwareness, awarenessVersion } from '../state/net'
import { MIDI_LOOPS } from '../packs'
import { loadLoop } from './actions'

const LANE_H = 56
const HEAD_W = 148

function usePresence() {
  return useSyncExternalStore(subscribeAwareness, awarenessVersion)
}

function Playhead({ pxPerTick }: { pxPerTick: number }) {
  const ref = useRef<HTMLDivElement>(null)
  useRaf(() => {
    if (!ref.current) return
    const t = engine.mode === 'arr' && engine.playing ? engine.positionTicks() : engine.arrSeekTicks
    ref.current.style.transform = `translateX(${t * pxPerTick}px)`
  })
  return <div ref={ref} className="playhead" />
}

function GhostPlayheads({ pxPerTick }: { pxPerTick: number }) {
  usePresence()
  const peers = peersList().filter(p => !p.me && p.state.ph && p.state.ph.mode === 'arr')
  return (
    <>
      {peers.map(p => (
        <div key={p.id} className="playhead ghost" style={{ transform: `translateX(${(p.state.ph!.ticks) * pxPerTick}px)`, background: p.state.color }} title={p.state.name} />
      ))}
    </>
  )
}

type DragState =
  | { type: 'move'; id: string; startX: number; startY: number; origStart: number; origLane: number; dx: number; dLane: number; copy: boolean }
  | { type: 'resize'; id: string; startX: number; origLen: number; dLen: number }
  | { type: 'loop'; edge: 'start' | 'end' | 'mid'; startX: number; origStart: number; origEnd: number; cur: [number, number] }
  | null

export function ArrangementView() {
  useY(tracks)
  useY(arr)
  useY(meta)
  const zoom = useUI(s => s.zoomPxPerBar)
  const pxPerTick = zoom / BAR
  const [drag, setDrag] = useState<DragState>(null)
  const scrollRef = useRef<HTMLDivElement>(null)

  const trackArr = tracks.toArray()
  const laneOf = (tid: string) => trackArr.findIndex(t => t.get('id') === tid)
  const totalBars = Math.max(33, Math.ceil(arrEndTicks() / BAR) + 9)
  const width = totalBars * zoom

  const loopOn = !!meta.get('loopOn')
  const loopStart = meta.get('loopStart') ?? 0
  const loopEnd = meta.get('loopEnd') ?? BAR * 4

  const snap = (t: number, fine: boolean) => {
    const g = fine ? ui.gridTicks : BAR
    return Math.round(t / g) * g
  }

  const seekFromEvent = (e: React.MouseEvent, el: HTMLElement) => {
    const rect = el.getBoundingClientRect()
    const t = Math.max(0, (e.clientX - rect.left) / pxPerTick)
    engine.seekArr(snap(t, e.shiftKey))
  }

  const onWheel = (e: React.WheelEvent) => {
    if (e.ctrlKey || e.metaKey) {
      e.preventDefault()
      setUI({ zoomPxPerBar: clamp(zoom * (e.deltaY > 0 ? 0.85 : 1.18), 24, 480) })
    }
  }

  // ----- clip drag handlers -----
  const beginMove = (e: React.PointerEvent, id: string) => {
    e.stopPropagation()
    const m = arr.get(id) as Y.Map<any>
    if (!m) return
    selectClip({ kind: 'arr', id })
    const lane = laneOf(m.get('trackId'))
    setDrag({ type: 'move', id, startX: e.clientX, startY: e.clientY, origStart: m.get('start'), origLane: lane, dx: 0, dLane: 0, copy: e.altKey })
    capturePointer(e)
  }
  const beginResize = (e: React.PointerEvent, id: string) => {
    e.stopPropagation()
    const m = arr.get(id) as Y.Map<any>
    if (!m) return
    setDrag({ type: 'resize', id, startX: e.clientX, origLen: m.get('len'), dLen: 0 })
    capturePointer(e)
  }
  const onPointerMove = (e: React.PointerEvent) => {
    if (!drag) return
    if (drag.type === 'move') {
      setDrag({ ...drag, dx: (e.clientX - drag.startX) / pxPerTick, dLane: Math.round((e.clientY - drag.startY) / LANE_H), copy: e.altKey || drag.copy })
    } else if (drag.type === 'resize') {
      setDrag({ ...drag, dLen: (e.clientX - drag.startX) / pxPerTick })
    } else if (drag.type === 'loop') {
      const dt = (e.clientX - drag.startX) / pxPerTick
      let s = drag.origStart
      let en = drag.origEnd
      if (drag.edge === 'start') s = clamp(snap(drag.origStart + dt, e.shiftKey), 0, en - BAR)
      else if (drag.edge === 'end') en = Math.max(s + BAR, snap(drag.origEnd + dt, e.shiftKey))
      else { const d = snap(dt, e.shiftKey); s = Math.max(0, drag.origStart + d); en = drag.origEnd + (s - drag.origStart) }
      setDrag({ ...drag, cur: [s, en] })
    }
  }
  const onPointerUp = (e: React.PointerEvent) => {
    if (!drag) return
    if (drag.type === 'move') {
      const m = arr.get(drag.id) as Y.Map<any>
      if (m) {
        const newStart = Math.max(0, snap(drag.origStart + drag.dx, e.shiftKey))
        const newLane = clamp(drag.origLane + drag.dLane, 0, trackArr.length - 1)
        const newTrack = trackArr[newLane]?.get('id') ?? m.get('trackId')
        if (drag.copy) {
          addArrClip(newTrack, newStart, clipToJSON(m), 'Duplicate clip')
        } else {
          moveArrClip(drag.id, { start: newStart, trackId: newTrack })
        }
      }
    } else if (drag.type === 'resize') {
      const newLen = Math.max(BAR / 4, snap(drag.origLen + drag.dLen, e.shiftKey))
      resizeArrClip(drag.id, newLen)
    } else if (drag.type === 'loop') {
      setLoopRegion(drag.cur[0], drag.cur[1], true)
    }
    setDrag(null)
  }

  // ----- render clips -----
  const clipEls: React.ReactNode[] = []
  arr.forEach((m: Y.Map<any>, id: string) => {
    const lane = laneOf(m.get('trackId'))
    if (lane < 0) return
    let start = m.get('start') ?? 0
    let len = m.get('len') ?? BAR
    let laneIdx = lane
    let ghost = false
    if (drag?.type === 'move' && drag.id === id && !drag.copy) {
      start = Math.max(0, snap(drag.origStart + drag.dx, false))
      laneIdx = clamp(drag.origLane + drag.dLane, 0, trackArr.length - 1)
      ghost = true
    }
    if (drag?.type === 'resize' && drag.id === id) {
      len = Math.max(BAR / 4, snap(drag.origLen + drag.dLen, false))
      ghost = true
    }
    const color = CLIP_COLORS[m.get('color') ?? 0]
    const isSel = ui.selClip?.kind === 'arr' && ui.selClip.id === id
    const menu: MenuItem[] = [
      { label: '✏ Edit notes', fn: () => selectClip({ kind: 'arr', id }, true) },
      { label: 'Duplicate after', fn: () => duplicateArrClip(id) },
      { custom: <ColorRow colors={CLIP_COLORS} onPick={i => setClipField({ kind: 'arr', id }, 'color', i)} /> },
      'sep',
      { label: 'Delete', fn: () => deleteArrClip(id), danger: true },
    ]
    clipEls.push(
      <div
        key={id}
        className={`arr-clip ${isSel ? 'selected' : ''} ${ghost ? 'ghost-drag' : ''}`}
        style={{
          left: start * pxPerTick,
          top: laneIdx * LANE_H + 2,
          width: Math.max(8, len * pxPerTick - 2),
          height: LANE_H - 5,
          background: `color-mix(in srgb, ${color} 26%, var(--bg2))`,
          borderColor: color,
        }}
        onPointerDown={e => { if (e.button === 0) beginMove(e, id) }}
        onDoubleClick={() => selectClip({ kind: 'arr', id }, true)}
        onContextMenu={e => openMenu(e, menu)}
        data-info="Drag to move (Alt = copy, Shift = fine). Drag right edge to resize. Double-click to edit."
      >
        <span className="arr-clip-name">{m.get('name')}</span>
        <div className="arr-clip-resize" onPointerDown={e => beginResize(e, id)} />
      </div>,
    )
  })

  const loopCur: [number, number] = drag?.type === 'loop' ? drag.cur : [loopStart, loopEnd]

  return (
    <div className="arrange" onWheel={onWheel}>
      <div className="arr-heads">
        <div className="arr-corner">
          <button
            className={`tbtn ${loopOn ? 'on' : ''}`}
            data-info="Toggle loop region (playback loops between the braces)"
            onClick={() => setLoopRegion(loopStart, loopEnd, !loopOn)}
          >LOOP</button>
          <span className="arr-pos">{ticksToBBS(Math.round(engine.arrSeekTicks))}</span>
        </div>
        {trackArr.map(t => (
          <div key={t.get('id')} className="arr-head" style={{ height: LANE_H, borderLeftColor: CLIP_COLORS[t.get('color') ?? 0] }}
            onClick={() => { setUI({ selTrackId: t.get('id'), detailOpen: true, detailTab: 'devices' }) }}>
            <span className="arr-head-name">{t.get('name')}</span>
            <button className={`tbtn mute ${t.get('mute') ? 'on' : ''}`} onClick={e => { e.stopPropagation(); setTrackMix(t.get('id'), { mute: !t.get('mute') }) }}>M</button>
          </div>
        ))}
      </div>

      <div className="arr-scroll" ref={scrollRef}>
        <div className="arr-inner" style={{ width }} onPointerMove={onPointerMove} onPointerUp={onPointerUp}>
          <div
            className="arr-ruler"
            onClick={e => seekFromEvent(e, e.currentTarget)}
            data-info="Click to set the playhead. Drag the loop brace to set the loop region."
          >
            {Array.from({ length: totalBars }, (_, i) => (
              <div key={i} className="ruler-bar" style={{ left: i * zoom, width: zoom }}>
                <span>{i + 1}</span>
              </div>
            ))}
            <div
              className={`loop-brace ${loopOn ? 'on' : ''}`}
              style={{ left: loopCur[0] * pxPerTick, width: (loopCur[1] - loopCur[0]) * pxPerTick }}
              onPointerDown={e => {
                e.stopPropagation()
                const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
                const rel = (e.clientX - rect.left) / rect.width
                const edge = rel < 0.18 ? 'start' : rel > 0.82 ? 'end' : 'mid'
                setDrag({ type: 'loop', edge, startX: e.clientX, origStart: loopStart, origEnd: loopEnd, cur: [loopStart, loopEnd] })
                capturePointer(e)
              }}
            />
          </div>

          <div
            className="arr-lanes"
            style={{ height: trackArr.length * LANE_H }}
            onDoubleClick={e => {
              const rect = e.currentTarget.getBoundingClientRect()
              const t = snap((e.clientX - rect.left) / pxPerTick, false)
              const lane = Math.floor((e.clientY - rect.top) / LANE_H)
              const tid = trackArr[lane]?.get('id')
              if (!tid) return
              const id = addArrClip(tid, Math.max(0, t), { name: 'Clip', color: trackArr[lane].get('color') ?? 0, len: BAR * 4, notes: {} })
              selectClip({ kind: 'arr', id }, true)
            }}
            onClick={e => { if ((e.target as HTMLElement).classList.contains('arr-lanes')) seekFromEvent(e, e.currentTarget) }}
            onDragOver={e => e.preventDefault()}
            onDrop={e => {
              const loopName = e.dataTransfer.getData('stg/loop')
              const clipSrc = e.dataTransfer.getData('stg/clip')
              const rect = e.currentTarget.getBoundingClientRect()
              const t = Math.max(0, snap((e.clientX - rect.left) / pxPerTick, false))
              const lane = Math.floor((e.clientY - rect.top) / LANE_H)
              const tid = trackArr[lane]?.get('id')
              if (loopName) {
                const loop = MIDI_LOOPS.find(l => l.name === loopName)
                if (loop && tid) {
                  addArrClip(tid, t, loop.clip, `Loop: ${loop.name}`)
                  toast(`"${loop.name}" → arrangement`)
                }
              } else if (clipSrc) {
                const [srcT, srcS] = clipSrc.split('|')
                const cm = clips.get(clipKey(srcT, srcS))
                if (cm && tid) {
                  addArrClip(tid, t, clipToJSON(cm as any), 'Send to arrangement')
                  toast('Clip placed in arrangement')
                }
              }
            }}
          >
            {trackArr.map((_t, i) => <div key={i} className="lane-bg" style={{ top: i * LANE_H, height: LANE_H }} />)}
            {Array.from({ length: totalBars }, (_, i) => (
              <div key={i} className="lane-grid" style={{ left: i * zoom }} />
            ))}
            {clipEls}
            <Playhead pxPerTick={pxPerTick} />
            <GhostPlayheads pxPerTick={pxPerTick} />
          </div>
        </div>
      </div>

      <div className="arr-zoom">
        <button className="icon-btn" onClick={() => setUI({ zoomPxPerBar: clamp(zoom * 0.8, 24, 480) })} data-info="Zoom out (or Ctrl+scroll)">−</button>
        <button className="icon-btn" onClick={() => setUI({ zoomPxPerBar: clamp(zoom * 1.25, 24, 480) })} data-info="Zoom in (or Ctrl+scroll)">＋</button>
      </div>
    </div>
  )
}
