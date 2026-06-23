// Shared enumeration of a track's automatable parameters, used by both the
// per-clip automation lane (piano roll) and the arrangement automation lanes.
// paramId format "dest|fxId|pkey" matches the engine's resolveTarget addressing.

import { trackById } from '../state/doc'
import { instSchema, fxSchema, mixSpec, ParamSpec, normFromSpec } from './schema'

export type AutoTarget = { key: string; label: string }

const SEND_SPEC = (label: string): ParamSpec => ({ key: 'send', label, min: 0, max: 1, def: 0, fmt: (v: number) => `${Math.round(v * 100)}%` })

export function autoTargets(trackId: string | null): AutoTarget[] {
  if (!trackId) return []
  const t = trackById(trackId); if (!t) return []
  const out: AutoTarget[] = []
  out.push({ key: 'mix||gain', label: 'Volume' }, { key: 'mix||pan', label: 'Pan' })
  out.push({ key: 'send||A', label: 'Send A' }, { key: 'send||B', label: 'Send B' })
  if (t.get('kind') !== 'drum' && t.get('kind') !== 'bus' && t.get('kind') !== 'audio') {
    instSchema(t.get('inst').get('type')).params.filter(p => !p.steps).forEach(p =>
      out.push({ key: `inst||${p.key}`, label: `Inst · ${p.label}` }))
  }
  ;(t.get('fx') as any).forEach((f: any) => {
    fxSchema(f.get('type')).params.filter((p: any) => !p.steps).forEach((p: any) =>
      out.push({ key: `fx|${f.get('id')}|${p.key}`, label: `${fxSchema(f.get('type')).label} · ${p.label}` }))
  })
  return out
}

/** Resolve a paramId to its ParamSpec + current (manual) value, for value mapping. */
export function paramSpecAndValue(trackId: string, key: string): { spec: ParamSpec; value: number } | null {
  const t = trackById(trackId); if (!t) return null
  const [dest, fxId, pkey] = key.split('|')
  if (dest === 'mix') {
    const spec = mixSpec(pkey); if (!spec) return null
    return { spec, value: (t.get(pkey) as number) ?? spec.def }
  }
  if (dest === 'send') {
    return { spec: SEND_SPEC(pkey === 'B' ? 'Send B' : 'Send A'), value: (t.get(pkey === 'B' ? 'sendB' : 'sendA') as number) ?? 0 }
  }
  if (dest === 'inst') {
    const spec = instSchema(t.get('inst').get('type')).params.find(p => p.key === pkey); if (!spec) return null
    return { spec, value: ((t.get('inst').get('params') as any).get(pkey) as number) ?? spec.def }
  }
  // fx
  const fx = (t.get('fx') as any).toArray().find((f: any) => f.get('id') === fxId)
  if (!fx) return null
  const spec = fxSchema(fx.get('type')).params.find((p: any) => p.key === pkey); if (!spec) return null
  return { spec, value: ((fx.get('params') as any).get(pkey) as number) ?? spec.def }
}

/** Normalize a raw param value into [0,1] along its spec curve (log for freq/exp). */
export function normOf(spec: ParamSpec, value: number): number {
  return normFromSpec(spec, value)
}
