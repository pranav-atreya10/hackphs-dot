// One audible announcement per incident, even if ElevenLabs arrives after the local fallback.
export function createAlertPlayer({ enabled, alarm, playAudio, speakText, showText, waitMs = 5000, setTimer = setTimeout, clearTimer = clearTimeout }) {
  const alerts = new Map();
  async function finish(state, audio) {
    if (state.started) return;
    state.started = true;
    clearTimer(state.timer);
    await state.ready;
    if (!enabled()) return;
    if (audio) {
      try { await playAudio(audio); return; } catch {}
    }
    if (enabled()) speakText(state.text);
  }
  function receive(data) {
    const id = data.incident_id || data.id || `${data.time}:${data.type}:${data.text}`;
    showText(data.text);
    if (alerts.has(id)) return;
    const state = { text: data.text, started: false, ready: Promise.resolve(), timer: null };
    alerts.set(id, state);
    if (alerts.size > 100) { const first = alerts.keys().next().value; clearTimer(alerts.get(first).timer); alerts.delete(first); }
    if (!enabled()) { state.started = true; return; }
    state.ready = Promise.resolve(alarm()).catch(() => {});
    if (data.audio || !data.voice_pending) void finish(state, data.audio);
    else state.timer = setTimer(() => { void finish(state, null); }, waitMs);
  }
  function update(data) {
    const state = alerts.get(data.incident_id || data.id);
    if (!state || state.started) return;
    if (data.audio) void finish(state, data.audio);
    else if (data.audio_failed) void finish(state, null);
  }
  return { receive, update, clear() { for (const state of alerts.values()) clearTimer(state.timer); alerts.clear(); } };
}
