const BUILD = 'tanita-scan-debug-v2';
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
    capabilities: {
      worker: typeof Worker !== 'undefined',
      createImageBitmap: typeof createImageBitmap === 'function',
      offscreenCanvasMainThread: typeof OffscreenCanvas !== 'undefined',
      imageData: typeof ImageData !== 'undefined',
    },
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
  initDebugCapture,
  stopDebugHeartbeat,
};
