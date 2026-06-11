import { useEffect, useReducer, useRef } from 'react'
import * as Y from 'yjs'

/** Re-render whenever a Y type (deeply) changes. */
export function useY(target: Y.AbstractType<any> | null | undefined) {
  const [, bump] = useReducer((x: number) => x + 1, 0)
  useEffect(() => {
    if (!target) return
    const h = () => bump()
    target.observeDeep(h)
    return () => target.unobserveDeep(h)
  }, [target])
}

/** Run a callback every animation frame while `active`. */
export function useRaf(cb: () => void, active = true) {
  const ref = useRef(cb)
  ref.current = cb
  useEffect(() => {
    if (!active) return
    let id = 0
    const loop = () => {
      ref.current()
      id = requestAnimationFrame(loop)
    }
    id = requestAnimationFrame(loop)
    return () => cancelAnimationFrame(id)
  }, [active])
}

/** Latest-value ref helper for stable event handlers. */
export function useLatest<T>(v: T) {
  const r = useRef(v)
  r.current = v
  return r
}
