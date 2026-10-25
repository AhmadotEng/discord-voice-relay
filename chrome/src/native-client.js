(function installNativeTurnClient(root) {
  "use strict";

  const HOST_NAME = "com.ahmadoteng.discord_direct";
  const REQUEST_TIMEOUT_MS = 30_000;
  let port = null;
  let nextRequestId = 0;
  const pending = new Map();
  const intentionalDisconnects = new WeakSet();
  const disconnectListeners = new Set();

  function rejectPending(error) {
    for (const request of pending.values()) {
      clearTimeout(request.timer);
      request.reject(error);
    }
    pending.clear();
  }

  function connect() {
    if (port) return port;
    if (!root.chrome || !root.chrome.runtime || typeof root.chrome.runtime.connectNative !== "function") {
      throw new Error("native-messaging-unavailable");
    }

    const connected = root.chrome.runtime.connectNative(HOST_NAME);
    port = connected;
    connected.onMessage.addListener((message) => {
      if (!message || !Number.isSafeInteger(message.id)) return;
      const request = pending.get(message.id);
      if (!request) return;
      pending.delete(message.id);
      clearTimeout(request.timer);
      if (message.ok === true) request.resolve(message.result);
      else request.reject(new Error(String(message.error || "native-host-request-failed")));
    });
    connected.onDisconnect.addListener(() => {
      const lastError = root.chrome.runtime.lastError;
      const error = new Error(lastError && lastError.message || "native-host-disconnected");
      if (port === connected) port = null;
      rejectPending(error);
      if (!intentionalDisconnects.has(connected)) {
        for (const listener of disconnectListeners) {
          try { listener(error); } catch (_ignored) { /* isolated observer */ }
        }
      }
    });
    return connected;
  }

  function request(command, payload = {}) {
    let connected;
    try {
      connected = connect();
    } catch (error) {
      return Promise.reject(error);
    }
    nextRequestId = nextRequestId === Number.MAX_SAFE_INTEGER ? 1 : nextRequestId + 1;
    const id = nextRequestId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error("native-host-timeout"));
      }, REQUEST_TIMEOUT_MS);
      pending.set(id, { resolve, reject, timer });
      try {
        connected.postMessage({ id, command, ...payload });
      } catch (error) {
        pending.delete(id);
        clearTimeout(timer);
        reject(error);
      }
    });
  }

  async function start(options = {}) {
    const mappingProbeServers = Array.isArray(options.mappingProbeServers)
      ? options.mappingProbeServers.map((value) => String(value))
      : [];
    return request("start", { mappingProbeServers });
  }

  function status() { return request("status"); }

  async function stop() {
    const connected = port;
    if (!connected) return { running: false };
    let result = { running: false };
    try {
      result = await request("stop");
    } finally {
      if (port === connected) {
        intentionalDisconnects.add(connected);
        port = null;
        try { connected.disconnect(); } catch (_ignored) { /* already disconnected */ }
      }
    }
    return result;
  }

  function onDisconnected(listener) {
    if (typeof listener !== "function") throw new TypeError("listener must be a function");
    disconnectListeners.add(listener);
    return () => disconnectListeners.delete(listener);
  }

  const api = Object.freeze({ start, status, stop, onDisconnected, isConnected: () => Boolean(port) });
  Object.defineProperty(root, "TurnServer", { configurable: true, value: api });
  if (typeof module === "object" && module && module.exports) module.exports = api;
})(typeof globalThis === "object" ? globalThis : this);
