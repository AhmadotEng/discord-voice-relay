(function exposeDiscordDirectTools(root, factory) {
  "use strict";

  const api = factory();
  if (typeof module === "object" && module && module.exports) {
    module.exports = api;
  } else if (root) {
    Object.defineProperty(root, "__discordDirectTools", {
      configurable: true,
      value: api,
    });
  }
})(typeof globalThis === "object" ? globalThis : this, function buildTools() {
  "use strict";

  const DEFAULT_PROBE_SERVERS = Object.freeze([
    "stun:stun.cloudflare.com:3478",
    "stun:global.stun.twilio.com:3478",
  ]);

  const DEFAULT_SETTINGS = Object.freeze({
    enabled: false,
    mappingProbeServers: DEFAULT_PROBE_SERVERS.join("\n"),
  });

  const TERMINAL_ROUTE_PHASES = new Set(["off", "ready", "error"]);

  function splitProbeServers(value) {
    const source = Array.isArray(value)
      ? value
      : String(value || "").split(/[\s,]+/u);
    return [...new Set(source.map((entry) => String(entry).trim()).filter(Boolean))];
  }

  function parseStunUri(value) {
    const source = String(value || "").trim();
    const match = /^stun:([^/?#:\s]+)(?::(\d{1,5}))?$/iu.exec(source);
    if (!match) {
      return { valid: false, uri: source, reason: "Use stun:hostname:port." };
    }

    const host = match[1].toLowerCase().replace(/\.$/u, "");
    const port = match[2] ? Number(match[2]) : 3478;
    const isIpv4 = /^\d{1,3}(?:\.\d{1,3}){3}$/u.test(host);
    const validIpv4 = isIpv4 && host.split(".").every((part) => Number(part) <= 255);
    const validHostname = !isIpv4 && host.length <= 253 && host.split(".").every((label) =>
      /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/iu.test(label)
    );

    if ((!validIpv4 && !validHostname) || port < 1 || port > 65535) {
      return { valid: false, uri: source, reason: "The STUN hostname or port is invalid." };
    }

    return { valid: true, uri: source, host, port };
  }

  function validateSettings(input) {
    const candidate = { ...DEFAULT_SETTINGS, ...(input || {}) };
    const servers = splitProbeServers(candidate.mappingProbeServers);
    const parsed = servers.map(parseStunUri);
    const errors = parsed
      .filter((entry) => !entry.valid)
      .map((entry) => `${entry.uri || "Empty value"}: ${entry.reason}`);

    if (servers.length < 2) {
      errors.push("Add at least two independent STUN discovery endpoints.");
    }
    if (servers.length > 8) {
      errors.push("Use no more than eight STUN discovery endpoints.");
    }

    return {
      settings: {
        enabled: Boolean(candidate.enabled),
        mappingProbeServers: servers.join("\n"),
      },
      servers,
      errors,
    };
  }

  function isDiscordVoiceConfiguration(configuration) {
    if (!configuration || typeof configuration !== "object") return false;
    return configuration.sdpSemantics === "plan-b" ||
      configuration.sdpSemantics === "unified-plan" ||
      configuration.bundlePolicy === "max-bundle";
  }

  function blockedConfiguration(configuration) {
    const original = configuration && typeof configuration === "object" ? configuration : {};
    return {
      ...original,
      // Gecko rejects restricted port 9 synchronously during construction.
      // Relay-only with no ICE servers is still fail-closed, while allowing
      // the real ephemeral loopback TURN route to be installed before offer.
      iceServers: [],
      iceTransportPolicy: "relay",
    };
  }

  function directConfiguration(current, original) {
    const base = current && typeof current === "object" ? current : {};
    const initial = original && typeof original === "object" ? original : {};
    return {
      ...base,
      iceServers: Array.isArray(initial.iceServers) ? initial.iceServers : [],
      iceTransportPolicy: initial.iceTransportPolicy || "all",
    };
  }

  function validLoopbackTurnUrl(value) {
    const match = /^turn:127\.0\.0\.1:(\d{1,5})\?transport=udp$/u.exec(String(value || ""));
    return Boolean(match && Number(match[1]) >= 1 && Number(match[1]) <= 65535);
  }

  function normalizeIpv4Address(value) {
    if (typeof value !== "string") return null;
    const parts = value.split(".");
    if (parts.length !== 4 || parts.some((part) =>
      !/^\d{1,3}$/u.test(part) || Number(part) > 255
    )) return null;
    return parts.map((part) => String(Number(part))).join(".");
  }

  function normalizeBackendAllocation(value) {
    if (!value || typeof value !== "object") return null;
    const id = typeof value.id === "string" && /^[a-f0-9]{32}$/u.test(value.id)
      ? value.id
      : null;
    const relayAddress = normalizeIpv4Address(value.relayAddress);
    const relayPort = Number.isSafeInteger(value.relayPort) &&
      value.relayPort >= 1 && value.relayPort <= 65535
      ? value.relayPort
      : null;
    if (!id || !relayAddress || relayPort === null) return null;
    const safeCount = (candidate) => Number.isSafeInteger(candidate) && candidate >= 0
      ? Math.min(candidate, Number.MAX_SAFE_INTEGER)
      : 0;
    return {
      id,
      relayAddress,
      relayPort,
      mappingReady: value.mappingReady === true,
      peerDatagramsQueued: safeCount(value.peerDatagramsQueued),
      peerDatagramsReceived: safeCount(value.peerDatagramsReceived),
    };
  }

  function normalizeRouteState(input) {
    const value = input && typeof input === "object" ? input : {};
    const bootId = typeof value.bootId === "string" && /^[a-f0-9]{32}$/u.test(value.bootId)
      ? value.bootId
      : null;
    const enabled = value.enabled === true;
    const suppliedGeneration = value.generation === undefined ? value.revision : value.generation;
    const revision = Number.isSafeInteger(suppliedGeneration) && suppliedGeneration >= 0
      ? suppliedGeneration
      : 0;
    const routeRevision = Number.isSafeInteger(value.routeRevision) && value.routeRevision >= 0
      ? value.routeRevision
      : 0;
    const phase = ["off", "starting", "ready", "stopping", "error"].includes(value.phase)
      ? value.phase
      : enabled ? "error" : "off";
    const endpoint = value.endpoint && typeof value.endpoint === "object"
      ? value.endpoint
      : null;
    const backend = value.backend && typeof value.backend === "object"
      ? {
          running: value.backend.running === true,
          loopbackPreference: value.backend.loopbackPreference === true,
          mode: value.backend.mode === "remote-mapped" ? "remote-mapped" : null,
          allocationCount: Number.isSafeInteger(value.backend.allocationCount) && value.backend.allocationCount >= 0
            ? Math.min(value.backend.allocationCount, 8)
            : 0,
          allocations: Array.isArray(value.backend.allocations)
            ? value.backend.allocations.slice(0, 8).map(normalizeBackendAllocation).filter(Boolean)
            : [],
          mappingReadyAllocations: Number.isSafeInteger(value.backend.mappingReadyAllocations) && value.backend.mappingReadyAllocations >= 0
            ? Math.min(value.backend.mappingReadyAllocations, 8)
            : 0,
          permissionCount: Number.isSafeInteger(value.backend.permissionCount) && value.backend.permissionCount >= 0
            ? Math.min(value.backend.permissionCount, 32)
            : 0,
          channelCount: Number.isSafeInteger(value.backend.channelCount) && value.backend.channelCount >= 0
            ? Math.min(value.backend.channelCount, 32)
            : 0,
          allocationsCreated: Number.isSafeInteger(value.backend.allocationsCreated) && value.backend.allocationsCreated >= 0
            ? Math.min(value.backend.allocationsCreated, Number.MAX_SAFE_INTEGER)
            : 0,
          permissionsCreated: Number.isSafeInteger(value.backend.permissionsCreated) && value.backend.permissionsCreated >= 0
            ? Math.min(value.backend.permissionsCreated, Number.MAX_SAFE_INTEGER)
            : 0,
          channelsBound: Number.isSafeInteger(value.backend.channelsBound) && value.backend.channelsBound >= 0
            ? Math.min(value.backend.channelsBound, Number.MAX_SAFE_INTEGER)
            : 0,
          peerDatagramsQueued: Number.isSafeInteger(value.backend.peerDatagramsQueued) && value.backend.peerDatagramsQueued >= 0
            ? Math.min(value.backend.peerDatagramsQueued, Number.MAX_SAFE_INTEGER)
            : 0,
          peerDatagramsReceived: Number.isSafeInteger(value.backend.peerDatagramsReceived) && value.backend.peerDatagramsReceived >= 0
            ? Math.min(value.backend.peerDatagramsReceived, Number.MAX_SAFE_INTEGER)
            : 0,
          clientDatagramsQueued: Number.isSafeInteger(value.backend.clientDatagramsQueued) && value.backend.clientDatagramsQueued >= 0
            ? Math.min(value.backend.clientDatagramsQueued, Number.MAX_SAFE_INTEGER)
            : 0,
          preludeActivations: Number.isSafeInteger(value.backend.preludeActivations) && value.backend.preludeActivations >= 0
            ? Math.min(value.backend.preludeActivations, Number.MAX_SAFE_INTEGER)
            : 0,
          mappingProbeResponses: Number.isSafeInteger(value.backend.mappingProbeResponses) && value.backend.mappingProbeResponses >= 0
            ? Math.min(value.backend.mappingProbeResponses, Number.MAX_SAFE_INTEGER)
            : 0,
          mappingProbeSuccesses: Number.isSafeInteger(value.backend.mappingProbeSuccesses) && value.backend.mappingProbeSuccesses >= 0
            ? Math.min(value.backend.mappingProbeSuccesses, Number.MAX_SAFE_INTEGER)
            : 0,
          mappingProbeFailures: Number.isSafeInteger(value.backend.mappingProbeFailures) && value.backend.mappingProbeFailures >= 0
            ? Math.min(value.backend.mappingProbeFailures, Number.MAX_SAFE_INTEGER)
            : 0,
          peerPolicyRejections: Number.isSafeInteger(value.backend.peerPolicyRejections) && value.backend.peerPolicyRejections >= 0
            ? Math.min(value.backend.peerPolicyRejections, Number.MAX_SAFE_INTEGER)
            : 0,
        }
      : null;
    const endpointValid = endpoint && validLoopbackTurnUrl(endpoint.turnUrl) &&
      typeof endpoint.username === "string" && endpoint.username.length >= 1 && endpoint.username.length <= 128 &&
      typeof endpoint.credential === "string" && endpoint.credential.length >= 1 && endpoint.credential.length <= 256;
    const backendReady = backend && backend.running && backend.loopbackPreference &&
      backend.mode === "remote-mapped";
    const ready = Boolean(bootId) && enabled && phase === "ready" && value.ready === true &&
      Boolean(endpointValid) && Boolean(backendReady);

    return {
      bootId,
      enabled,
      ready,
      phase: enabled && phase === "ready" && !ready ? "error" : phase,
      revision,
      generation: revision,
      routeRevision,
      userDisabled: !enabled && value.userDisabled === true,
      reconnectRequired: value.reconnectRequired === true,
      errorCode: typeof value.errorCode === "string" ? value.errorCode.slice(0, 64) : null,
      backend,
      endpoint: ready ? {
        turnUrl: endpoint.turnUrl,
        username: endpoint.username,
        credential: endpoint.credential,
      } : null,
    };
  }

  function routeConfiguration(current, route) {
    const normalized = normalizeRouteState(route);
    if (!normalized.ready || !normalized.endpoint) {
      throw new Error("A ready loopback route is required");
    }
    const base = current && typeof current === "object" ? current : {};
    return {
      ...base,
      iceServers: [{
        urls: normalized.endpoint.turnUrl,
        username: normalized.endpoint.username,
        credential: normalized.endpoint.credential,
      }],
      iceTransportPolicy: "relay",
    };
  }

  function routeDecisionIsTerminal(route) {
    const normalized = normalizeRouteState(route);
    return !normalized.enabled || normalized.ready || TERMINAL_ROUTE_PHASES.has(normalized.phase);
  }

  function backendTrafficEvidence(route, candidate, boundAllocationId = null) {
    const normalized = normalizeRouteState(route);
    const backend = normalized.backend;
    if (!normalized.ready || !backend || !candidate || typeof candidate !== "object") return null;
    const relayAddress = normalizeIpv4Address(candidate.address || candidate.ip);
    const suppliedPort = candidate.port === undefined ? candidate.portNumber : candidate.port;
    const relayPort = Number.isSafeInteger(suppliedPort) && suppliedPort >= 1 && suppliedPort <= 65535
      ? suppliedPort
      : null;
    if (!relayAddress || relayPort === null) return null;
    const allocationId = typeof boundAllocationId === "string" && /^[a-f0-9]{32}$/u.test(boundAllocationId)
      ? boundAllocationId
      : null;
    const matches = backend.allocations.filter((entry) =>
      entry.mappingReady && entry.relayAddress === relayAddress && entry.relayPort === relayPort &&
      (!allocationId || entry.id === allocationId)
    );
    if (matches.length !== 1) return null;
    const allocation = matches[0];
    return {
      allocationId: allocation.id,
      confirmed: allocation.peerDatagramsQueued > 0 && allocation.peerDatagramsReceived > 0,
    };
  }

  function boundBackendTrafficEvidence(route, allocationId) {
    const normalized = normalizeRouteState(route);
    const backend = normalized.backend;
    if (!normalized.ready || !backend || typeof allocationId !== "string" ||
        !/^[a-f0-9]{32}$/u.test(allocationId)) return null;
    const matches = backend.allocations.filter((entry) =>
      entry.id === allocationId && entry.mappingReady
    );
    if (matches.length !== 1) return null;
    const allocation = matches[0];
    return {
      allocationId: allocation.id,
      confirmed: allocation.peerDatagramsQueued > 0 && allocation.peerDatagramsReceived > 0,
    };
  }

  function backendConfirmsTraffic(route, candidate, boundAllocationId = null) {
    const evidence = backendTrafficEvidence(route, candidate, boundAllocationId);
    return Boolean(evidence && evidence.confirmed);
  }

  function candidateSummary(candidate) {
    const text = typeof candidate === "string" ? candidate : candidate && candidate.candidate;
    if (!text) return null;
    const typeMatch = /\btyp\s+(host|srflx|prflx|relay)\b/iu.exec(text);
    const protocolMatch = /^candidate:\S+\s+\d+\s+(udp|tcp)\s/iu.exec(text);
    return {
      type: typeMatch ? typeMatch[1].toLowerCase() : "unknown",
      protocol: protocolMatch ? protocolMatch[1].toLowerCase() : "unknown",
    };
  }

  return Object.freeze({
    DEFAULT_PROBE_SERVERS,
    DEFAULT_SETTINGS,
    splitProbeServers,
    parseStunUri,
    validateSettings,
    isDiscordVoiceConfiguration,
    blockedConfiguration,
    directConfiguration,
    normalizeRouteState,
    routeConfiguration,
    routeDecisionIsTerminal,
    backendTrafficEvidence,
    boundBackendTrafficEvidence,
    backendConfirmsTraffic,
    candidateSummary,
    validLoopbackTurnUrl,
  });
});
