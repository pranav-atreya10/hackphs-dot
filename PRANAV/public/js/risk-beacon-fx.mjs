// Risk shockwave & software beacon risk-state synchronizer for the Tower HUD.
// Observes #risk[data-risk] transitions and drives:
//   1. One-shot 650 ms data-risk-pulse="yellow|red|green" shockwave when operational risk escalates or clears.
//   2. Immediate data-beacon-risk="<level>" synchronization on #beaconView (inline + :fullscreen spare-monitor mode).

export const RISK_LEVELS = Object.freeze(['green', 'yellow', 'red', 'degraded', 'unavailable']);
export const PULSE_DURATION_MS = 650;

const RISK_LEVEL_SET = new Set(RISK_LEVELS);
const ELEVATED_RISK = new Set(['yellow', 'red']);

export function normalizeRiskLevel(value) {
  if (typeof value !== 'string') return 'unavailable';
  const normalized = value.trim().toLowerCase();
  return RISK_LEVEL_SET.has(normalized) ? normalized : 'unavailable';
}

// Determines whether a data-risk state transition represents an operational risk escalation or clear.
export function classifyRiskTransition(prevLevel, nextLevel) {
  const prev = normalizeRiskLevel(prevLevel);
  const next = normalizeRiskLevel(nextLevel);
  if (prev === next) return null;

  if (next === 'red' && prev !== 'red') {
    return { pulse: 'red', kind: 'escalate' };
  }
  if (next === 'yellow' && prev !== 'yellow' && prev !== 'red') {
    return { pulse: 'yellow', kind: 'escalate' };
  }
  if (next === 'green' && ELEVATED_RISK.has(prev)) {
    return { pulse: 'green', kind: 'clear' };
  }
  return null;
}

function defaultReducedMotion() {
  if (typeof globalThis.matchMedia !== 'function') return false;
  try {
    return Boolean(globalThis.matchMedia('(prefers-reduced-motion: reduce)')?.matches);
  } catch {
    return false;
  }
}

function readRiskLevel(el) {
  const attr = typeof el?.getAttribute === 'function' ? el.getAttribute('data-risk') : undefined;
  return normalizeRiskLevel(attr ?? el?.dataset?.risk);
}

function dataProp(attrName) {
  return attrName.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
}

function setAttr(el, name, value) {
  if (!el) return;
  const str = String(value);
  if (typeof el.setAttribute === 'function') {
    el.setAttribute(name, str);
  }
  if (el.dataset && typeof el.dataset === 'object' && name.startsWith('data-')) {
    const prop = dataProp(name);
    if (el.dataset[prop] !== str) el.dataset[prop] = str;
  }
}

function removeAttr(el, name) {
  if (!el) return;
  if (typeof el.removeAttribute === 'function') {
    el.removeAttribute(name);
  }
  if (el.dataset && typeof el.dataset === 'object' && name.startsWith('data-')) {
    const prop = dataProp(name);
    if (prop in el.dataset) delete el.dataset[prop];
  }
}

export function watchRiskTransitions(
  riskEl,
  {
    beaconEl = null,
    reducedMotion = defaultReducedMotion,
    pulseDurationMs = PULSE_DURATION_MS,
    MutationObserver: ObserverOverride,
  } = {},
) {
  if (!riskEl || typeof riskEl !== 'object') {
    return { disconnect() {} };
  }

  const isReducedMotion = () =>
    typeof reducedMotion === 'function' ? Boolean(reducedMotion()) : Boolean(reducedMotion);

  let disconnected = false;
  let pulseTimer = null;
  let currentLevel = readRiskLevel(riskEl);

  const clearPulse = () => {
    if (pulseTimer !== null) {
      clearTimeout(pulseTimer);
      pulseTimer = null;
    }
    removeAttr(riskEl, 'data-risk-pulse');
    riskEl.classList?.remove?.('risk-pulse');
  };

  const syncBeacon = level => {
    setAttr(beaconEl, 'data-beacon-risk', level);
  };

  const triggerPulse = pulse => {
    clearPulse();
    if (isReducedMotion()) return;
    // Force style recalc in real browsers so back-to-back escalations cleanly restart CSS keyframes.
    if (typeof riskEl.offsetWidth === 'number') void riskEl.offsetWidth;
    setAttr(riskEl, 'data-risk-pulse', pulse);
    riskEl.classList?.add?.('risk-pulse');
    pulseTimer = setTimeout(() => {
      pulseTimer = null;
      if (disconnected) return;
      removeAttr(riskEl, 'data-risk-pulse');
      riskEl.classList?.remove?.('risk-pulse');
    }, pulseDurationMs);
  };

  const handleRiskMutation = () => {
    if (disconnected) return;
    const nextLevel = readRiskLevel(riskEl);
    if (nextLevel === currentLevel) {
      if (isReducedMotion()) clearPulse();
      return;
    }
    const prevLevel = currentLevel;
    currentLevel = nextLevel;
    syncBeacon(nextLevel);

    const transition = classifyRiskTransition(prevLevel, nextLevel);
    if (transition) {
      triggerPulse(transition.pulse);
    } else {
      clearPulse();
    }
  };

  // Synchronize beacon ambient state immediately upon attachment without firing an initial load pulse.
  syncBeacon(currentLevel);

  const ObserverCls =
    ObserverOverride ??
    riskEl.ownerDocument?.defaultView?.MutationObserver ??
    globalThis.MutationObserver;

  let teardownObserver = null;

  if (typeof ObserverCls === 'function') {
    const observer = new ObserverCls(records => {
      if (!Array.isArray(records) || records.length === 0) {
        handleRiskMutation();
        return;
      }
      for (const rec of records) {
        if (!rec.attributeName || rec.attributeName === 'data-risk') {
          handleRiskMutation();
          break;
        }
      }
    });
    observer.observe(riskEl, { attributes: true, attributeFilter: ['data-risk'] });
    teardownObserver = () => observer.disconnect();
  } else {
    // Fallback for lightweight non-DOM test objects when no MutationObserver implementation is present.
    const restores = [];
    let syncingFallback = false;
    const origSet = typeof riskEl.setAttribute === 'function' ? riskEl.setAttribute : null;
    const origRemove = typeof riskEl.removeAttribute === 'function' ? riskEl.removeAttribute : null;
    let datasetRisk = riskEl.dataset && typeof riskEl.dataset === 'object' ? riskEl.dataset.risk : undefined;

    if (origSet) {
      riskEl.setAttribute = function patchedSetAttribute(name, value) {
        const result = origSet.call(this, name, value);
        if (name === 'data-risk' && !syncingFallback) {
          datasetRisk = String(value);
          handleRiskMutation();
        }
        return result;
      };
      restores.push(() => { riskEl.setAttribute = origSet; });
    }
    if (origRemove) {
      riskEl.removeAttribute = function patchedRemoveAttribute(name) {
        const result = origRemove.call(this, name);
        if (name === 'data-risk' && !syncingFallback) {
          datasetRisk = undefined;
          handleRiskMutation();
        }
        return result;
      };
      restores.push(() => { riskEl.removeAttribute = origRemove; });
    }
    if (riskEl.dataset && typeof riskEl.dataset === 'object') {
      const desc = Object.getOwnPropertyDescriptor(riskEl.dataset, 'risk');
      if (!desc || desc.configurable) {
        Object.defineProperty(riskEl.dataset, 'risk', {
          configurable: true,
          enumerable: true,
          get() { return datasetRisk; },
          set(val) {
            datasetRisk = val === undefined ? undefined : String(val);
            if (origSet) {
              syncingFallback = true;
              try {
                if (datasetRisk === undefined) origRemove?.call(riskEl, 'data-risk');
                else origSet.call(riskEl, 'data-risk', datasetRisk);
              } finally {
                syncingFallback = false;
              }
            }
            handleRiskMutation();
          },
        });
        restores.push(() => {
          if (desc) Object.defineProperty(riskEl.dataset, 'risk', desc);
          else {
            delete riskEl.dataset.risk;
            if (datasetRisk !== undefined) riskEl.dataset.risk = datasetRisk;
          }
        });
      }
    }
    teardownObserver = () => {
      for (let i = restores.length - 1; i >= 0; i--) restores[i]();
    };
  }

  return {
    disconnect() {
      if (disconnected) return;
      disconnected = true;
      teardownObserver?.();
      teardownObserver = null;
      clearPulse();
    },
  };
}
