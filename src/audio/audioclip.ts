// Shared audio-clip playback helpers, used identically by the live engine and
// the offline export so a clip sounds the same played or bounced. The clip's
// crop (offset/dur) and seamless loop crossfade are baked into a derived
// AudioBuffer (cached); pitch (+ fine cents), reverse, fades and gain are set
// live on the Tone.Player. See AudioEditor for the editing UI.

import * as Tone from 'tone'

export type AudioClipFields = {
  sampleId?: string
  offset?: number   // crop start, seconds into the sample
  dur?: number      // cropped region length, seconds (0 = to end of sample)
  pitch?: number    // coarse transpose, semitones (±48)
  cents?: number    // fine transpose, cents (±100)
  rev?: number
  loop?: number
  fadeIn?: number   // ticks
  fadeOut?: number  // ticks
  gainDb?: number
  xfade?: number    // loop crossfade, seconds (smooths the loop seam)
}

/** Playback rate from coarse semitones + fine cents. */
export function audioRate(pitch = 0, cents = 0): number {
  return Math.pow(2, (pitch + (cents || 0) / 100) / 12)
}

// Derived-buffer cache so re-launching / re-bouncing the same crop is free.
const cache = new Map<string, AudioBuffer>()

/**
 * The buffer a clip actually plays: the cropped region [offset, offset+dur].
 * When looping with a crossfade, the region's tail is equal-power-blended into
 * its head so the loop seam is click-free (the player then loops the whole
 * derived buffer). The full, uncropped, non-crossfaded case returns the raw
 * buffer untouched (no copy, no behaviour change for existing clips).
 */
export function clipAudioBuffer(sampleId: string, raw: AudioBuffer, offset = 0, dur = 0, loop = false, xfade = 0): AudioBuffer {
  const sr = raw.sampleRate
  const s0 = Math.max(0, Math.min(raw.length - 1, Math.floor((offset || 0) * sr)))
  const maxN = raw.length - s0
  const n = dur && dur > 0 ? Math.max(1, Math.min(maxN, Math.floor(dur * sr))) : maxN
  const xf = loop && xfade > 0 ? Math.min(Math.floor(xfade * sr), Math.floor(n / 2)) : 0
  if (s0 === 0 && n === raw.length && xf === 0) return raw // untouched → no copy

  const key = `${sampleId}|${s0}|${n}|${loop ? 1 : 0}|${xf}`
  const hit = cache.get(key)
  if (hit) return hit

  const outLen = Math.max(1, xf > 0 ? n - xf : n)
  const ctx = Tone.getContext().rawContext as unknown as BaseAudioContext
  const out = ctx.createBuffer(raw.numberOfChannels, outLen, sr)
  for (let c = 0; c < raw.numberOfChannels; c++) {
    const src = raw.getChannelData(c)
    const dst = out.getChannelData(c)
    for (let i = 0; i < outLen; i++) {
      if (xf > 0 && i < xf) {
        // crossfade the region tail (fading out) into its head (fading in)
        const t = i / xf
        const fin = Math.sin((t * Math.PI) / 2)        // equal-power
        const fout = Math.cos((t * Math.PI) / 2)
        dst[i] = src[s0 + i] * fin + src[s0 + (n - xf) + i] * fout
      } else {
        dst[i] = src[s0 + i] ?? 0
      }
    }
  }
  cache.set(key, out)
  return out
}

/** Apply the live-settable params (rate, reverse, fades, gain, loop) to a player. */
export function configureAudioPlayer(player: Tone.Player, c: AudioClipFields): void {
  player.loop = !!c.loop
  player.playbackRate = audioRate(c.pitch ?? 0, c.cents ?? 0)
  player.reverse = !!c.rev
  try { player.fadeIn = Math.max(0, Tone.Ticks(c.fadeIn ?? 0).toSeconds()) } catch { /* ok */ }
  try { player.fadeOut = Math.max(0, Tone.Ticks(c.fadeOut ?? 0).toSeconds()) } catch { /* ok */ }
  player.volume.value = c.gainDb ?? 0
}

/** Read audio-clip fields off a Yjs clip map (fields live at the top level). */
export function audioFieldsFromMap(m: { get: (k: string) => any }): AudioClipFields {
  return {
    sampleId: m.get('sampleId') || '',
    offset: m.get('offset') ?? 0,
    dur: m.get('dur') ?? 0,
    pitch: m.get('pitch') ?? 0,
    cents: m.get('cents') ?? 0,
    rev: m.get('rev') ?? 0,
    loop: m.get('loop') ?? 0,
    fadeIn: m.get('fadeIn') ?? 0,
    fadeOut: m.get('fadeOut') ?? 0,
    gainDb: m.get('gainDb') ?? 0,
    xfade: m.get('xfade') ?? 0,
  }
}
