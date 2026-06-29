// Persisted audio-engine preferences. Read at boot by engine.doStart (before
// React mounts), edited via the Audio Settings dialog. Changing them requires
// rebuilding the AudioContext, so the dialog applies by reloading the page —
// the project itself is safe in IndexedDB.

export type LatencyMode = 'interactive' | 'balanced' | 'playback'
export type AudioPrefs = {
  oversample: boolean                       // 2x (88.2kHz) internal graph vs native rate
  latency: LatencyMode                      // AudioContext latencyHint → output buffer size
  sampleRate: 'auto' | 44100 | 48000        // native context rate (ignored when oversample on)
}

const KEY = 'sf-audio-prefs'
// Default to the NATIVE sample rate (not 2x/88.2kHz). Most of the graph is
// linear and gains nothing from oversampling, so native rate roughly HALVES
// audio-thread CPU — more tracks/effects before glitching. The nonlinear nodes
// that actually alias (Drive, Heat) self-oversample 4x per-node regardless, and
// users who want pristine FM/waveshaping can flip the 2x toggle in Audio
// settings. Existing users keep whatever they already saved.
const DEFAULTS: AudioPrefs = { oversample: false, latency: 'interactive', sampleRate: 'auto' }

export function getAudioPrefs(): AudioPrefs {
  try {
    const raw = localStorage.getItem(KEY)
    if (raw) return { ...DEFAULTS, ...JSON.parse(raw) }
  } catch { /* corrupt/blocked storage → defaults */ }
  return { ...DEFAULTS }
}

export function setAudioPrefs(patch: Partial<AudioPrefs>): AudioPrefs {
  const next = { ...getAudioPrefs(), ...patch }
  try { localStorage.setItem(KEY, JSON.stringify(next)) } catch { /* ignore */ }
  return next
}
