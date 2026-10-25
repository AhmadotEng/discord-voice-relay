(function installDiscordDirectBridge() {
  "use strict";

  // Firefox content scripts run in a sandbox whose globalThis is distinct
  // from the page WindowProxy. The manifest already limits this script to the
  // top frame; use window identity for DOM messages and frame checks.
  if (window.top !== window) return;

  const CHANNEL = "discord-direct-zen:v1";
  const ORIGIN = window.location.origin;
  const bridgeTokenBytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bridgeTokenBytes);
  const bridgeInstanceId = Array.from(bridgeTokenBytes, (byte) =>
    byte.toString(16).padStart(2, "0")
  ).join("");
  const PHASES = new Set([
    "hook-unconfirmed",
    "hook-ready",
    "waiting-for-route",
    "direct",
    "route-applied",
    "candidate",
    "ice-state",
    "connection-state",
    "waiting-for-backend",
    "verified",
    "unsafe-direct",
    "route-blocked",
    "reconnect-required",
    "configuration-error",
    "diagnostic-error",
    "reload-required",
  ]);
  let documentToken = null;
  let requestSequence = 0;
  let statusRequestSequence = 0;
  let latestUntaggedSequence = 0;
  const statusWaiters = new Map();
  let lastStatus = {
    phase: "hook-unconfirmed",
    bootId: null,
    targetedConnections: 0,
    currentConnectionId: 0,
    observedConnections: 0,
    targetedAttempts: 0,
    ignoredNoArgumentConnections: 0,
    promotableConnections: 0,
    unmatchedConfiguredConnections: 0,
    closedUnverifiedConnections: 0,
    generation: 0,
    routeRevision: 0,
    applied: false,
    verified: false,
    reconnectRequired: false,
    iceConnectionState: "new",
    connectionState: "new",
    selectedCandidate: null,
    errorCode: null,
  };

  function boundedInteger(value, maximum) {
    return Number.isSafeInteger(value) && value >= 0 ? Math.min(value, maximum) : 0;
  }

  function safeState(value, allowed, fallback) {
    return typeof value === "string" && allowed.has(value) ? value : fallback;
  }

  function sanitizeCandidate(value) {
    if (!value || typeof value !== "object") return null;
    const types = new Set(["host", "srflx", "prflx", "relay", "unknown"]);
    const protocols = new Set(["udp", "tcp", "unknown"]);
    return {
      type: safeState(value.type, types, "unknown"),
      protocol: safeState(value.protocol, protocols, "unknown"),
      relayProtocol: value.relayProtocol === "udp" || value.relayProtocol === "tcp"
        ? value.relayProtocol
        : null,
    };
  }

  function sanitizeStatus(value) {
    const input = value && typeof value === "object" ? value : {};
    const iceStates = new Set(["new", "checking", "connected", "completed", "failed", "disconnected", "closed"]);
    const connectionStates = new Set(["new", "connecting", "connected", "disconnected", "failed", "closed"]);
    return {
      phase: safeState(input.phase, PHASES, "diagnostic-error"),
      bootId: typeof input.bootId === "string" && /^[a-f0-9]{32}$/u.test(input.bootId)
        ? input.bootId
        : null,
      targetedConnections: boundedInteger(input.targetedConnections, 32),
      currentConnectionId: boundedInteger(input.currentConnectionId, 32),
      observedConnections: boundedInteger(input.observedConnections, Number.MAX_SAFE_INTEGER),
      targetedAttempts: boundedInteger(input.targetedAttempts, Number.MAX_SAFE_INTEGER),
      ignoredNoArgumentConnections: boundedInteger(
        input.ignoredNoArgumentConnections,
        Number.MAX_SAFE_INTEGER
      ),
      promotableConnections: boundedInteger(input.promotableConnections, Number.MAX_SAFE_INTEGER),
      unmatchedConfiguredConnections: boundedInteger(
        input.unmatchedConfiguredConnections,
        Number.MAX_SAFE_INTEGER
      ),
      closedUnverifiedConnections: boundedInteger(
        input.closedUnverifiedConnections,
        Number.MAX_SAFE_INTEGER
      ),
      generation: boundedInteger(input.generation, Number.MAX_SAFE_INTEGER),
      routeRevision: boundedInteger(input.routeRevision, Number.MAX_SAFE_INTEGER),
      applied: input.applied === true,
      verified: input.verified === true,
      reconnectRequired: input.reconnectRequired === true,
      iceConnectionState: safeState(input.iceConnectionState, iceStates, "new"),
      connectionState: safeState(input.connectionState, connectionStates, "new"),
      selectedCandidate: sanitizeCandidate(input.selectedCandidate),
      errorCode: typeof input.errorCode === "string" && /^[a-z0-9-]{1,64}$/u.test(input.errorCode)
        ? input.errorCode
        : null,
    };
  }

  function currentPageStatus() {
    if (!documentToken) return Promise.resolve({ ...lastStatus });
    statusRequestSequence = statusRequestSequence === Number.MAX_SAFE_INTEGER
      ? 1
      : statusRequestSequence + 1;
    const statusRequestId = statusRequestSequence;
    return new Promise((resolve) => {
      const waiter = { resolve, timer: null };
      waiter.timer = globalThis.setTimeout(() => {
        statusWaiters.delete(statusRequestId);
        resolve({
          ...lastStatus,
          phase: "bridge-unavailable",
          applied: false,
          verified: false,
          reconnectRequired: true,
          selectedCandidate: null,
          errorCode: "bridge-unavailable",
        });
      }, 250);
      statusWaiters.set(statusRequestId, waiter);
      sendToPage("get-status", { statusRequestId });
    });
  }

  function sendToPage(type, payload = {}) {
    if (!documentToken) return;
    window.postMessage({
      channel: CHANNEL,
      direction: "extension-to-page",
      token: documentToken,
      bridgeInstanceId,
      type,
      ...payload,
    }, ORIGIN);
  }

  async function requestRoute(requestId = null) {
    if (!documentToken) return;
    const sequence = ++requestSequence;
    const explicitRequestId = Number.isSafeInteger(requestId) && requestId > 0
      ? requestId
      : null;
    if (explicitRequestId === null) latestUntaggedSequence = sequence;
    try {
      const route = await browser.runtime.sendMessage({ type: "discord-direct:get-route" });
      if (explicitRequestId === null && sequence !== latestUntaggedSequence) return;
      sendToPage("route", {
        route,
        responseOk: true,
        responseSequence: sequence,
        ...(explicitRequestId === null ? {} : { requestId: explicitRequestId }),
      });
    } catch (_error) {
      if (explicitRequestId === null && sequence !== latestUntaggedSequence) return;
      sendToPage("route", {
        route: {
          enabled: true,
          ready: false,
          phase: "error",
          generation: 0,
          userDisabled: false,
          reconnectRequired: false,
          errorCode: "bridge-unavailable",
          backend: null,
          endpoint: null,
        },
        responseOk: false,
        responseSequence: sequence,
        ...(explicitRequestId === null ? {} : { requestId: explicitRequestId }),
      });
    }
  }

  window.addEventListener("message", (event) => {
    if (event.source !== window || event.origin !== ORIGIN || !event.data ||
        event.data.channel !== CHANNEL || event.data.direction !== "page-to-extension") {
      return;
    }

    if (event.data.type === "route-request") {
      if (typeof event.data.token !== "string" || !/^[a-f0-9]{32}$/u.test(event.data.token)) return;
      if (documentToken && event.data.token !== documentToken) return;
      documentToken = event.data.token;
      const requestId = Number.isSafeInteger(event.data.requestId) && event.data.requestId > 0
        ? event.data.requestId
        : null;
      requestRoute(requestId).catch(() => {});
      return;
    }

    if (event.data.type === "status" && event.data.token === documentToken &&
        event.data.bridgeInstanceId === bridgeInstanceId) {
      lastStatus = sanitizeStatus(event.data.status);
      const statusRequestId = Number.isSafeInteger(event.data.statusRequestId) &&
        event.data.statusRequestId > 0
        ? event.data.statusRequestId
        : null;
      const waiter = statusRequestId === null ? null : statusWaiters.get(statusRequestId);
      if (waiter) {
        statusWaiters.delete(statusRequestId);
        globalThis.clearTimeout(waiter.timer);
        waiter.resolve({ ...lastStatus });
      }
    }
  });

  browser.runtime.onMessage.addListener((message) => {
    if (!message || typeof message !== "object") return undefined;
    if (message.type === "discord-direct:route-changed") {
      requestRoute().catch(() => {});
      return undefined;
    }
    if (message.type === "discord-direct:get-page-status") {
      return currentPageStatus();
    }
    return undefined;
  });

  window.postMessage({
    channel: CHANNEL,
    direction: "extension-to-page",
    bridgeInstanceId,
    type: "bridge-ready",
  }, ORIGIN);
})();
