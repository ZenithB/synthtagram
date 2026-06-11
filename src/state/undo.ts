// Per-user undo (Google-Docs style: you only undo YOUR edits) + a labeled
// history list for the Undo History panel — a long-standing DAW wishlist item.

import * as Y from 'yjs'
import { doc, tracks, scenes, clips, arr, meta, LOCAL, takePendingLabel } from './doc'

export const undoMgr = new Y.UndoManager([tracks as any, scenes as any, clips as any, arr as any, meta as any], {
  trackedOrigins: new Set([LOCAL]),
  captureTimeout: 400, // groups rapid knob drags into one step
  doc,
})

export type HistoryEntry = { label: string; t: number }

const listeners = new Set<() => void>()
let version = 0
function bump() {
  version++
  listeners.forEach(l => l())
}

undoMgr.on('stack-item-added', (ev: any) => {
  if (ev.type === 'undo' && !ev.stackItem.meta.get('label')) {
    ev.stackItem.meta.set('label', takePendingLabel() ?? 'Edit')
    ev.stackItem.meta.set('t', Date.now())
  }
  bump()
})
undoMgr.on('stack-item-popped', bump)
undoMgr.on('stack-cleared', bump)
undoMgr.on('stack-item-updated', bump)

export function undoHistory(): HistoryEntry[] {
  return undoMgr.undoStack.map((it: any) => ({
    label: it.meta.get('label') ?? 'Edit',
    t: it.meta.get('t') ?? 0,
  }))
}

export function redoCount() {
  return undoMgr.redoStack.length
}

export function undoTo(index: number) {
  // undo every stack item above (and including) the clicked one
  const n = undoMgr.undoStack.length - index
  for (let i = 0; i < n; i++) undoMgr.undo()
}

export function subscribeHistory(fn: () => void) {
  listeners.add(fn)
  return () => { listeners.delete(fn) }
}
export function historyVersion() {
  return version
}
