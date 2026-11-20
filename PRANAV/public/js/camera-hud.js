// Non-invasive viewfinder HUD & corridor editor state observer for camera.html.
// Reads DOM state managed by camera.js without altering camera provenance, sockets, or controls.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    const api = factory();
    root.SkySentryCameraHud = api;
    if (typeof document !== 'undefined') {
      if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => api.mountCameraHud(document, root), { once: true });
      } else {
        api.mountCameraHud(document, root);
      }
    }
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const DISCONNECTED_STATUS_RE = /\b(?:not connected|reconnecting|reauthorize|cannot reach|rejected|offline)\b/i;

  function hasLiveVideoTrack(video) {
    const stream = video && video.srcObject;
    if (!stream || typeof stream.getVideoTracks !== 'function') return true;
    const tracks = stream.getVideoTracks();
    if (!Array.isArray(tracks) || tracks.length === 0) return false;
    return tracks.some(track => track && track.readyState === 'live' && !track.muted && track.enabled !== false);
  }

  function formatTelemetry({ heading, fov, pitch, corridorEditing = false, draftPoints = 0 } = {}) {
    const hNum = Number(heading);
    const fNum = Number(fov);
    const pNum = Number(pitch);
    const hdgText = Number.isFinite(hNum) && String(heading ?? '').trim() !== ''
      ? `HDG ${String(((Math.round(hNum) % 360) + 360) % 360).padStart(3, '0')}°`
      : 'HDG ---°';
    const fovText = Number.isFinite(fNum) && String(fov ?? '').trim() !== ''
      ? `FOV ${Math.round(fNum)}°`
      : 'FOV --°';
    const roundedPitch = Math.round(pNum);
    const pitchText = Number.isFinite(pNum) && String(pitch ?? '').trim() !== ''
      ? `${roundedPitch >= 0 ? '+' : ''}${roundedPitch}°`
      : '--°';

    if (corridorEditing) {
      const count = Math.max(0, Math.trunc(Number(draftPoints) || 0));
      return `DRAFT MASK · ${count} ${count === 1 ? 'PT' : 'PTS'} · ${hdgText}`;
    }
    return `${hdgText} · ${fovText} · ${pitchText}`;
  }

  function deriveHudState({
    startText = 'Start',
    emptyHidden = false,
    source = 'webcam',
    mode = 'stream',
    connOk,
    statusText = '',
    trackLive = true,
    corridorEditing = false,
    draftPoints = 0,
    heading = 90,
    fov = 65,
    pitch = 20,
    reducedMotion = false,
  } = {}) {
    const stopShown = String(startText || '').trim() === 'Stop';
    const running = Boolean(emptyHidden) && stopShown;
    const starting = !emptyHidden && stopShown;
    const effectiveMode = source === 'webcam' ? mode : 'local';
    const isLiveStreamConfig = source === 'webcam' && effectiveMode === 'stream';
    const disconnected = connOk === '0' || DISCONNECTED_STATUS_RE.test(String(statusText || ''));

    let hudState = 'idle';
    let badgeMode = 'idle';
    let badgeText = '';
    let badgeHidden = true;
    let pulseActive = false;

    if (starting) {
      hudState = 'starting';
    } else if (running) {
      if (!isLiveStreamConfig) {
        hudState = 'preview';
        badgeMode = 'preview';
        badgeText = 'PREVIEW / DEMO';
        badgeHidden = false;
      } else if (!trackLive || disconnected) {
        hudState = 'standby';
        badgeMode = 'standby';
        badgeText = 'STREAM STANDBY';
        badgeHidden = false;
      } else {
        hudState = 'live';
        badgeMode = 'live';
        badgeText = 'LIVE STREAM';
        badgeHidden = false;
        pulseActive = true;
      }
    }

    return {
      hudState,
      badgeMode,
      badgeText,
      badgeHidden,
      pulseActive,
      corridorEditing: Boolean(corridorEditing),
      draftPoints: corridorEditing ? Math.max(0, Math.trunc(Number(draftPoints) || 0)) : 0,
      telemetryText: formatTelemetry({ heading, fov, pitch, corridorEditing, draftPoints }),
      reducedMotion: Boolean(reducedMotion),
    };
  }

  function mountCameraHud(doc, win) {
    const rootDoc = doc || (typeof document !== 'undefined' ? document : null);
    const rootWin = win || (typeof window !== 'undefined' ? window : null);
    if (!rootDoc) return null;

    const view = rootDoc.querySelector ? rootDoc.querySelector('.view') : null;
    if (!view || (view.dataset && view.dataset.hudMounted === '1')) return null;

    const byId = id => (rootDoc.getElementById ? rootDoc.getElementById(id) : null);
    const startBtn = byId('start');
    const empty = byId('empty');
    const source = byId('source');
    const mode = byId('mode');
    const conn = byId('conn');
    const statusLine = byId('statusLine');
    const overlay = byId('overlay');
    const video = byId('video');
    const heading = byId('heading');
    const fov = byId('fov');
    const pitch = byId('pitch');
    const drawCorridor = byId('drawCorridor');
    const corridorEditor = byId('corridorEditor');
    const hudBadge = byId('hudBadge');
    const hudPulse = byId('hudPulse');
    const hudBadgeText = byId('hudBadgeText');
    const hudTelemetry = byId('hudTelemetry');

    if (view.dataset) view.dataset.hudMounted = '1';

    let draftPoints = 0;
    let wasEditing = Boolean(overlay?.classList?.contains('drawing'));
    let lastSnapshot = null;

    const motionQuery = typeof rootWin?.matchMedia === 'function'
      ? rootWin.matchMedia('(prefers-reduced-motion: reduce)')
      : null;

    function sync() {
      const corridorEditing = Boolean(overlay?.classList?.contains('drawing'));
      if (corridorEditing && !wasEditing) draftPoints = 0;
      if (!corridorEditing) draftPoints = 0;
      wasEditing = corridorEditing;

      const snapshot = deriveHudState({
        startText: startBtn?.textContent,
        emptyHidden: Boolean(empty?.hidden),
        source: source?.value || 'webcam',
        mode: mode?.value || 'stream',
        connOk: conn?.dataset?.ok,
        statusText: statusLine?.textContent || '',
        trackLive: hasLiveVideoTrack(video),
        corridorEditing,
        draftPoints,
        heading: heading?.value,
        fov: fov?.value,
        pitch: pitch?.value,
        reducedMotion: Boolean(motionQuery?.matches),
      });

      if (view.dataset) {
        view.dataset.hudState = snapshot.hudState;
        view.dataset.corridorEditing = String(snapshot.corridorEditing);
        view.dataset.reducedMotion = String(snapshot.reducedMotion);
      }
      if (hudBadge) {
        hudBadge.hidden = snapshot.badgeHidden;
        if (hudBadge.dataset) hudBadge.dataset.hudMode = snapshot.badgeMode;
      }
      if (hudPulse && hudPulse.dataset) {
        hudPulse.dataset.active = String(snapshot.pulseActive);
      }
      if (hudBadgeText) {
        hudBadgeText.textContent = snapshot.badgeText;
      }
      if (hudTelemetry) {
        hudTelemetry.textContent = snapshot.telemetryText;
      }
      if (corridorEditor && corridorEditor.dataset) {
        corridorEditor.dataset.editing = String(snapshot.corridorEditing);
        corridorEditor.dataset.points = String(snapshot.draftPoints);
      }

      lastSnapshot = snapshot;
      return snapshot;
    }

    const cleanups = [];
    const observedTracks = new WeakSet();
    function listen(target, eventName, handler) {
      if (!target || typeof target.addEventListener !== 'function') return;
      target.addEventListener(eventName, handler);
      cleanups.push(() => {
        if (typeof target.removeEventListener === 'function') {
          target.removeEventListener(eventName, handler);
        }
      });
    }

    function bindVideoTracks() {
      const tracks = video?.srcObject?.getVideoTracks?.();
      if (!Array.isArray(tracks)) return;
      for (const track of tracks) {
        if (track && typeof track === 'object' && !observedTracks.has(track)) {
          observedTracks.add(track);
          for (const ev of ['ended', 'mute', 'unmute']) {
            listen(track, ev, onSync);
          }
        }
      }
    }

    const onSync = () => {
      bindVideoTracks();
      sync();
    };
    for (const el of [source, mode, heading, fov, pitch]) {
      listen(el, 'change', onSync);
      listen(el, 'input', onSync);
    }
    listen(startBtn, 'click', onSync);
    listen(drawCorridor, 'click', onSync);
    listen(overlay, 'click', () => {
      if (overlay?.classList?.contains('drawing')) {
        draftPoints += 1;
        sync();
      }
    });
    listen(overlay, 'dblclick', onSync);
    for (const ev of ['play', 'pause', 'ended', 'emptied', 'loadeddata']) {
      listen(video, ev, onSync);
    }
    if (motionQuery) {
      listen(motionQuery, 'change', onSync);
    }
    listen(rootWin, 'load', onSync);

    const Observer = rootWin?.MutationObserver || (typeof MutationObserver !== 'undefined' ? MutationObserver : null);
    let observer = null;
    if (Observer) {
      observer = new Observer(onSync);
      for (const target of [startBtn, empty, conn, statusLine, overlay]) {
        if (target) {
          observer.observe(target, { attributes: true, childList: true, characterData: true, subtree: true });
        }
      }
    }

    onSync();

    return {
      sync,
      getState: () => lastSnapshot,
      destroy() {
        if (observer) {
          observer.disconnect();
          observer = null;
        }
        while (cleanups.length) cleanups.pop()();
        if (view.dataset) delete view.dataset.hudMounted;
      },
    };
  }

  return {
    deriveHudState,
    formatTelemetry,
    hasLiveVideoTrack,
    mountCameraHud,
  };
});
