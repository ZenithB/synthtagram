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
const DEFAULTS: AudioPrefs = { oversample: true, latency: 'interactive', sampleRate: 'auto' }

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
