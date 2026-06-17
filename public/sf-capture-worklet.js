// PCM tap for "Record Output": forwards each input block (copied) to the main
// thread. Registered on the engine's AudioContext by src/audio/recorder.ts.
class SFCapture extends AudioWorkletProcessor {
  process(inputs) {
    const inp = inputs[0]
    if (inp && inp.length) this.port.postMessage(inp.map(c => c.slice()))
    return true
  }
}
registerProcessor('sf-capture', SFCapture)
