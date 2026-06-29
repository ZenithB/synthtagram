// Multiband dynamics processor — one AudioWorklet so the whole device is a
// single in=out effect node and the Comp/Expand switch flips live (a native
// DynamicsCompressorNode can compress but can't expand, and swapping nodes
// mid-chain would need a graph rebuild).
//
// Signal: 3-band Linkwitz-Riley (LR4) crossover → per-band compressor OR
// downward-expander → makeup → sum. LR4 = two cascaded Butterworth (Q=1/√2)
// biquads per slope; adjacent LR4 bands sum flat. Per-band gain reduction (dB)
// is posted to the main thread for the UI meters.

// Direct-Form-I biquad with its own state (one per channel per filter slot).
class Biquad {
  constructor() { this.x1 = 0; this.x2 = 0; this.y1 = 0; this.y2 = 0; this.c = [1, 0, 0, 0, 0] }
  set(c) { this.c = c }
  proc(x) {
    const c = this.c
    const y = c[0] * x + c[1] * this.x1 + c[2] * this.x2 - c[3] * this.y1 - c[4] * this.y2
    this.x2 = this.x1; this.x1 = x; this.y2 = this.y1; this.y1 = y
    return y
  }
}

// RBJ cookbook coefficients, normalized by a0, Butterworth Q (LR4 building block).
function lpCoeffs(f) {
  const w0 = (2 * Math.PI * Math.min(f, sampleRate * 0.49)) / sampleRate
  const cw = Math.cos(w0), sw = Math.sin(w0)
  const alpha = sw / (2 * Math.SQRT1_2)
  const a0 = 1 + alpha
  return [((1 - cw) / 2) / a0, (1 - cw) / a0, ((1 - cw) / 2) / a0, (-2 * cw) / a0, (1 - alpha) / a0]
}
function hpCoeffs(f) {
  const w0 = (2 * Math.PI * Math.min(f, sampleRate * 0.49)) / sampleRate
  const cw = Math.cos(w0), sw = Math.sin(w0)
  const alpha = sw / (2 * Math.SQRT1_2)
  const a0 = 1 + alpha
  return [((1 + cw) / 2) / a0, (-(1 + cw)) / a0, ((1 + cw) / 2) / a0, (-2 * cw) / a0, (1 - alpha) / a0]
}

class MultibandDynamics extends AudioWorkletProcessor {
  constructor() {
    super()
    this.p = {
      mode: 0, xlo: 250, xhi: 2500, attack: 0.02, release: 0.18,
      th: [-24, -24, -24], ra: [2, 2, 2], mk: [0, 0, 0],
    }
    // bq[ch] = [LPa,LPb (xlo low), HPa,HPb (xlo high), LPc,LPd (xhi mid), HPc,HPd (xhi high)]
    this.bq = [[], []]
    for (let ch = 0; ch < 2; ch++) for (let i = 0; i < 8; i++) this.bq[ch].push(new Biquad())
    this.env = [0, 0, 0]
    this.grMax = [0, 0, 0]
    this.mkLin = [1, 1, 1]
    this.attC = 0; this.relC = 0
    this.rep = 0
    this.repEvery = Math.max(256, Math.floor(sampleRate * 0.03))
    this.dirty = true
    this.port.onmessage = e => {
      const d = e.data
      if (d.init) for (const k in d.init) this.setParam(k, d.init[k])
      else this.setParam(d.k, d.v)
      this.dirty = true
    }
  }

  setParam(k, v) {
    const p = this.p
    const m = /^b(\d)_(thresh|ratio|gain)$/.exec(k)
    if (m) {
      const i = +m[1]
      if (m[2] === 'thresh') p.th[i] = v
      else if (m[2] === 'ratio') p.ra[i] = v
      else p.mk[i] = v
      return
    }
    if (k === 'mode') p.mode = v | 0
    else if (k === 'xlo') p.xlo = v
    else if (k === 'xhi') p.xhi = v
    else if (k === 'attack') p.attack = v
    else if (k === 'release') p.release = v
  }

  recompute() {
    this.dirty = false
    const p = this.p
    const lo = Math.min(p.xlo, p.xhi - 20)            // keep crossovers ordered
    const hi = Math.max(p.xhi, p.xlo + 20)
    const lp = lpCoeffs(lo), hp = hpCoeffs(lo), lp2 = lpCoeffs(hi), hp2 = hpCoeffs(hi)
    for (let ch = 0; ch < 2; ch++) {
      this.bq[ch][0].set(lp); this.bq[ch][1].set(lp)
      this.bq[ch][2].set(hp); this.bq[ch][3].set(hp)
      this.bq[ch][4].set(lp2); this.bq[ch][5].set(lp2)
      this.bq[ch][6].set(hp2); this.bq[ch][7].set(hp2)
    }
    this.attC = Math.exp(-1 / (Math.max(0.0005, p.attack) * sampleRate))
    this.relC = Math.exp(-1 / (Math.max(0.005, p.release) * sampleRate))
    this.mkLin = [Math.pow(10, p.mk[0] / 20), Math.pow(10, p.mk[1] / 20), Math.pow(10, p.mk[2] / 20)]
  }

  process(inputs, outputs) {
    const input = inputs[0], output = outputs[0]
    if (!output) return true
    const outL = output[0], outR = output[1] || output[0]
    const n = outL.length
    if (!input || input.length === 0) { outL.fill(0); if (outR !== outL) outR.fill(0); return true }
    const inL = input[0], inR = input[1] || input[0]
    if (this.dirty) this.recompute()
    const p = this.p, env = this.env, bq = this.bq
    const comp = p.mode === 0
    for (let i = 0; i < n; i++) {
      const xl = inL[i], xr = inR[i]
      const lL = bq[0][1].proc(bq[0][0].proc(xl)), lR = bq[1][1].proc(bq[1][0].proc(xr))
      const hL = bq[0][3].proc(bq[0][2].proc(xl)), hR = bq[1][3].proc(bq[1][2].proc(xr))
      const mL = bq[0][5].proc(bq[0][4].proc(hL)), mR = bq[1][5].proc(bq[1][4].proc(hR))
      const tL = bq[0][7].proc(bq[0][6].proc(hL)), tR = bq[1][7].proc(bq[1][6].proc(hR))
      let sL = 0, sR = 0
      // unrolled 3 bands
      // band 0 = low, 1 = mid, 2 = high
      const L0 = lL, R0 = lR, L1 = mL, R1 = mR, L2 = tL, R2 = tR
      for (let b = 0; b < 3; b++) {
        const L = b === 0 ? L0 : b === 1 ? L1 : L2
        const R = b === 0 ? R0 : b === 1 ? R1 : R2
        const rect = Math.abs(L) > Math.abs(R) ? Math.abs(L) : Math.abs(R)
        const c = rect > env[b] ? this.attC : this.relC
        env[b] = rect + (env[b] - rect) * c
        const lvlDb = 20 * Math.log10(env[b] + 1e-9)
        let grDb = 0
        const ratio = p.ra[b] < 1 ? 1 : p.ra[b]
        if (comp) { const over = lvlDb - p.th[b]; if (over > 0) grDb = over * (1 - 1 / ratio) }
        else { const under = p.th[b] - lvlDb; if (under > 0) grDb = Math.min(48, under * (ratio - 1)) }
        if (grDb > this.grMax[b]) this.grMax[b] = grDb
        const gain = Math.exp(-grDb * 0.11512925) * this.mkLin[b]   // 10^(-grDb/20)·makeup
        sL += L * gain; sR += R * gain
      }
      outL[i] = sL
      if (outR !== outL) outR[i] = sR
    }
    this.rep += n
    if (this.rep >= this.repEvery) {
      this.rep = 0
      this.port.postMessage({ gr: [this.grMax[0], this.grMax[1], this.grMax[2]] })
      this.grMax[0] = this.grMax[1] = this.grMax[2] = 0
    }
    return true
  }
}

registerProcessor('sf-mbdyn', MultibandDynamics)
