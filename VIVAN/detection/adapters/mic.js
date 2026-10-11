// Browser microphone -> trained drone-sound model -> engine.
//
//   const stop = await startModelMic(stream, engine, model);   // returns a stop() function
//
// Keeps the last 1 s of audio at 16 kHz (the rate the model was trained on) and asks the model
// every 0.5 s. The browser resamples for us when the AudioContext runs at 16 kHz; if a browser
// refuses that, we fall back to the device rate and average every few samples down to ~16 kHz.

export async function startModelMic(stream, engine, model, { everyMs = 500, onResult } = {}) {
  let ctx;
  try { ctx = new AudioContext({ sampleRate: model.sr }); } catch { ctx = new AudioContext(); }
  let src;
  try { src = ctx.createMediaStreamSource(stream); } catch {
    await ctx.close();
    ctx = new AudioContext();
    src = ctx.createMediaStreamSource(stream);
  }
  const ratio = Math.max(1, Math.round(ctx.sampleRate / model.sr));
  const need = model.windowSamples;
  const ring = new Float32Array(need);
  let filled = 0, write = 0;

  // ScriptProcessor is old but works in every browser and needs no extra worklet file.
  const proc = ctx.createScriptProcessor(4096, 1, 1);
  proc.onaudioprocess = (e) => {
    const x = e.inputBuffer.getChannelData(0);
    for (let i = 0; i + ratio <= x.length; i += ratio) {
      let s = 0;
      for (let k = 0; k < ratio; k++) s += x[i + k];
      ring[write] = s / ratio;
      write = (write + 1) % need;
      if (filled < need) filled++;
    }
  };
  const mute = ctx.createGain();
  mute.gain.value = 0;
  src.connect(proc);
  proc.connect(mute);
  mute.connect(ctx.destination);

  const buf = new Float32Array(need);
  const timer = setInterval(() => {
    if (filled < need) return;
    for (let i = 0; i < need; i++) buf[i] = ring[(write + i) % need];
    const r = model.predict(buf);
    engine?.setAudioProbability(r.prob, 'model');
    onResult?.(r);
  }, everyMs);

  return () => {
    clearInterval(timer);
    proc.disconnect();
    src.disconnect();
    ctx.close();
  };
}
