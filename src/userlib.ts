// Personal, per-browser library: saved instrument presets + favorited items.
// Stored in localStorage (not synced — these are your own shelf).

import { useSyncExternalStore } from 'react'

export type UserPreset = { name: string; type: string; params: Record<string, number> }

const PKEY = 'sf-user-presets'
const FKEY = 'sf-favorites'

const listeners = new Set<() => void>()
let version = 0
function bump() { version++; listeners.forEach(l => l()) }
function read<T>(k: string, def: T): T { try { return JSON.parse(localStorage.getItem(k) || '') ?? def } catch { return def } }
function write(k: string, v: any) { localStorage.setItem(k, JSON.stringify(v)) }

export function listUserPresets(): UserPreset[] { return read<UserPreset[]>(PKEY, []) }
export function saveUserPreset(p: UserPreset) {
  const all = listUserPresets().filter(x => x.name !== p.name)
  all.unshift(p)
  write(PKEY, all.slice(0, 60))
  bump()
}
export function removeUserPreset(name: string) {
  write(PKEY, listUserPresets().filter(p => p.name !== name))
  bump()
}

export function listFavorites(): string[] { return read<string[]>(FKEY, []) }
export function isFavorite(id: string) { return listFavorites().includes(id) }
export function toggleFavorite(id: string) {
  const f = listFavorites()
  write(FKEY, f.includes(id) ? f.filter(x => x !== id) : [...f, id])
  bump()
}

export function subscribeLib(fn: () => void) { listeners.add(fn); return () => { listeners.delete(fn) } }
export function useLib() { return useSyncExternalStore(subscribeLib, () => version) }
