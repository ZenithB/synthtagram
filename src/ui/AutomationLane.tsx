// Arrangement automation lane: an SVG breakpoint editor along the timeline for
// ONE track parameter. Points store value normalized [0,1] (the engine maps to
// the param's real range); t is absolute song ticks. No points = a flat line at
// the parameter's current manual value (the first edit lifts it into an envelope).
//   • click empty space → add a breakpoint (and drag it)
//   • drag a breakpoint  → move it (t snapped to grid, v free)
//   • click a breakpoint → delete it

import React, { useRef, useState } from 'react'
import { trackAutoPoints, setTrackAutoPoints } from '../state/doc'
import { paramSpecAndValue, normOf } from '../audio/params'
import { beginVDrag } from './widgets'

export function AutomationLane({ trackId, paramKey, width, pxPerTick, height, snapTicks }: {
  trackId: string; paramKey: string; width: number; pxPerTick: number; height: number; snapTicks: number
}) {
  const svgRef = useRef<SVGSVGElement>(null)
  const [, force] = useState(0)
  const bump = () => force(n => n + 1)

  const pts = trackAutoPoints(trackId, paramKey)
  const sv = paramSpecAndValue(trackId, paramKey)
  const baseNorm = sv ? normOf(sv.spec, sv.value) : 0.75

  const xOf = (t: number) => t * pxPerTick
  const yOf = (v: number) => (1 - v) * height
  // map a pointer event to lane coords, accounting for any visual (uiZoom) scaling
  const loc = (e: PointerEvent | React.PointerEvent) => {
    const r = svgRef.current!.getBoundingClientRect()
    return { x: (e.clientX - r.left) * (width / r.width), y: (e.clientY - r.top) * (height / r.height) }
  }
  const tFromX = (x: number) => Math.max(0, Math.round((x / pxPerTick) / snapTicks) * snapTicks)
  const vFromY = (y: number) => Math.max(0, Math.min(1, 1 - y / height))

  const onDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return
    e.stopPropagation()
    const { x, y } = loc(e)
    let work = trackAutoPoints(trackId, paramKey)
    let idx = work.findIndex(p => Math.abs(xOf(p.t) - x) <= 6 && Math.abs(yOf(p.v) - y) <= 6)
    const isNew = idx < 0
    if (isNew) {
      const np = { t: tFromX(x), v: vFromY(y) }
      work = [...work.filter(p => p.t !== np.t), np].sort((a, b) => a.t - b.t)
      idx = work.findIndex(p => p === np)
      setTrackAutoPoints(trackId, paramKey, work); bump()
    }
    let moved = false
    // keep our own `work` array + idx stable during the drag; commit sorted copies.
    beginVDrag(
      ev => {
        moved = true
        const m = loc(ev)
        work[idx] = { t: tFromX(m.x), v: vFromY(m.y) }
        setTrackAutoPoints(trackId, paramKey, work.slice()); bump()
      },
      () => {
        if (!moved && !isNew) {   // a click on an existing point = delete it
          setTrackAutoPoints(trackId, paramKey, work.filter((_, i) => i !== idx)); bump()
        }
      },
    )
  }

  const line = pts.length
    ? [`0,${yOf(pts[0].v)}`, ...pts.map(p => `${xOf(p.t)},${yOf(p.v)}`), `${width},${yOf(pts[pts.length - 1].v)}`].join(' ')
    : ''

  return (
    <svg ref={svgRef} className="auto-svg" width={width} height={height} onPointerDown={onDown}
      data-info="Automation: click to add a point, drag to move, click a point to delete">
      {pts.length === 0
        ? <line className="auto-flat" x1={0} y1={yOf(baseNorm)} x2={width} y2={yOf(baseNorm)} />
        : <>
            <polyline className="auto-line" points={line} />
            {pts.map((p, i) => <circle key={i} className="auto-pt" cx={xOf(p.t)} cy={yOf(p.v)} r={3.2} />)}
          </>}
    </svg>
  )
}
