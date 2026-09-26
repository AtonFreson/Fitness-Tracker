const BUILD = 'tanita-scan-debug-v1';
const startedAt = new Date();
const startedPerf = performance.now();
const entries = [];
let initialized = false;
let heartbeatTimer = null;
let lastHeartbeatPerf = performance.now();

function scrubString(value) {
  return String(value)
    .replace(/AIza[0-9A-Za-z_-]{20,}/g, '[redacted-google-api-key]')
    .replace(/([?&](?:key|api_key)=)[^&\s]+/gi, '$1[redacted]')
    .replace(/github_pat_[0-9A-Za-z_]+/g, '[redacted-github-token]');
}

function serialize(value, depth = 0) {
  if (depth > 5) return '[max-depth]';
  if (value == null || typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'string') return scrubString(value);
  if (value instanceof Error) {
    return {
      name: value.name,
      message: scrubString(value.message || ''),
      stack: scrubString(value.stack || ''),
    };
  }
  if (Array.isArray(value)) return value.map((item) => serialize(item, depth + 1));
  if (typeof value === 'object') {
    const output = {};
    for (const [key, item] of Object.entries(value)) {
      if (/token|api.?key|authorization/i.test(key)) {
        output[key] = '[redacted]';
      } else {
        output[key] = serialize(item, depth + 1);
      }
    }
    return output;
  }
  return scrubString(value);
}

function cvState() {
  const cv = globalThis.cv;
  return {
    type: typeof cv,
    present: Boolean(cv),
    thenable: Boolean(cv && typeof cv.then === 'function'),
    hasMat: Boolean(cv?.Mat),
    hasImread: Boolean(cv?.imread),
    hasRuntimeInitializedFlag: cv?.runtimeInitialized ?? null,
  };
}

function environmentSnapshot() {
  const connection = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
  const memory = performance.memory;
  return {
    build: BUILD,
    page: location.origin + location.pathname,
    userAgent: navigator.userAgent,
    platform: navigator.platform || '',
    vendor: navigator.vendor || '',
    language: navigator.language || '',
    languages: Array.from(navigator.languages || []),
    online: navigator.onLine,
    visibility: document.visibilityState,
    secureContext: window.isSecureContext,
    crossOriginIsolated: window.crossOriginIsolated,
    viewport: {
      innerWidth: window.innerWidth,
      innerHeight: window.innerHeight,
      devicePixelRatio: window.devicePixelRatio,
    },
    screen: {
      width: window.screen?.width ?? null,
      height: window.screen?.height ?? null,
      availWidth: window.screen?.availWidth ?? null,
      availHeight: window.screen?.availHeight ?? null,
    },
    hardware: {
      hardwareConcurrency: navigator.hardwareConcurrency ?? null,
      deviceMemory: navigator.deviceMemory ?? null,
      maxTouchPoints: navigator.maxTouchPoints ?? null,
    },
    connection: connection ? {
      effectiveType: connection.effectiveType ?? null,
      downlink: connection.downlink ?? null,
      rtt: connection.rtt ?? null,
      saveData: connection.saveData ?? null,
    } : null,
    performanceMemory: memory ? {
      jsHeapSizeLimit: memory.jsHeapSizeLimit,
      totalJSHeapSize: memory.totalJSHeapSize,
      usedJSHeapSize: memory.usedJSHeapSize,
    } : null,
    cv: cvState(),
  };
}

function emit(entry) {
  try {
    window.dispatchEvent(new CustomEvent('tanita-scan-debug-entry', { detail: entry }));
  } catch {}
}

function debugLog(event, data = null) {
  const entry = {
    iso: new Date().toISOString(),
    elapsedMs: Math.round(performance.now() - startedPerf),
    event: scrubString(event),
    data: serialize(data),
  };
  entries.push(entry);
  if (entries.length > 1000) entries.splice(0, entries.length - 1000);
  emit(entry);
  return entry;
}

function debugError(event, error, data = null) {
  return debugLog(event, {
    ...(data && typeof data === 'object' ? data : { data }),
    error: serialize(error),
  });
}

function resourceTimings() {
  return performance.getEntriesByType('resource')
    .filter((entry) => /opencv|tanita-scan|jspdf/i.test(entry.name))
    .map((entry) => ({
      name: scrubString(entry.name),
      initiatorType: entry.initiatorType,
      startTime: Math.round(entry.startTime),
      duration: Math.round(entry.duration),
      transferSize: entry.transferSize ?? null,
      encodedBodySize: entry.encodedBodySize ?? null,
      decodedBodySize: entry.decodedBodySize ?? null,
      nextHopProtocol: entry.nextHopProtocol || null,
    }));
}

function debugText() {
  const header = [
    'TANITA batch scanner diagnostic log',
    'Generated: ' + new Date().toISOString(),
    'Session started: ' + startedAt.toISOString(),
    '',
    '=== Environment ===',
    JSON.stringify(environmentSnapshot(), null, 2),
    '',
    '=== Relevant resource timings ===',
    JSON.stringify(resourceTimings(), null, 2),
    '',
    '=== Event log ===',
  ];

  const lines = entries.map((entry) => {
    const data = entry.data == null ? '' : ' ' + JSON.stringify(entry.data);
    return '[' + entry.iso + ' +' + entry.elapsedMs + 'ms] ' + entry.event + data;
  });
  return [...header, ...lines, ''].join('\n');
}

function downloadDebugLog() {
  debugLog('debug-log-download-requested', { entryCount: entries.length });
  const blob = new Blob([debugText()], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  anchor.href = url;
  anchor.download = 'tanita-scanner-debug-' + stamp + '.txt';
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}

function initDebugCapture() {
  if (initialized) return;
  initialized = true;

  debugLog('debug-session-start', environmentSnapshot());

  window.addEventListener('error', (event) => {
    debugError('window-error', event.error || new Error(event.message || 'Unknown window error'), {
      filename: event.filename || '',
      lineno: event.lineno || null,
      colno: event.colno || null,
    });
  });

  window.addEventListener('unhandledrejection', (event) => {
    const reason = event.reason instanceof Error
      ? event.reason
      : new Error(typeof event.reason === 'string' ? event.reason : 'Unhandled promise rejection');
    debugError('unhandled-rejection', reason);
  });

  window.addEventListener('online', () => debugLog('browser-online'));
  window.addEventListener('offline', () => debugLog('browser-offline'));
  document.addEventListener('visibilitychange', () => {
    debugLog('visibility-change', { visibility: document.visibilityState });
  });
  window.addEventListener('pageshow', (event) => {
    debugLog('page-show', { persisted: event.persisted });
  });
  window.addEventListener('pagehide', (event) => {
    debugLog('page-hide', { persisted: event.persisted });
  });

  lastHeartbeatPerf = performance.now();
  heartbeatTimer = setInterval(() => {
    const now = performance.now();
    const gapMs = Math.round(now - lastHeartbeatPerf);
    lastHeartbeatPerf = now;
    debugLog('heartbeat', {
      gapMs,
      visibility: document.visibilityState,
      online: navigator.onLine,
      cv: cvState(),
    });
  }, 5000);
}

function stopDebugHeartbeat() {
  if (heartbeatTimer) clearInterval(heartbeatTimer);
  heartbeatTimer = null;
}

export {
  BUILD,
  debugLog,
  debugError,
  debugText,
  downloadDebugLog,
  initDebugCapture,
  stopDebugHeartbeat,
  cvState,
};
