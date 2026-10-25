(function installRelayConfigTools(root) {
  "use strict";

  const DEFAULT_PROBE_SERVERS = Object.freeze([
    "stun:stun.cloudflare.com:3478",
    "stun:global.stun.twilio.com:3478",
  ]);
  const DEFAULT_SETTINGS = Object.freeze({
    enabled: false,
    stunServers: DEFAULT_PROBE_SERVERS.join("\n"),
  });
  const TERMINAL_ROUTE_PHASES = new Set(["off", "error"]);

  function splitUrls(value) {
    const source = Array.isArray(value) ? value : String(value || "").split(/[\s,]+/u);
    return [...new Set(source.map((item) => String(item).trim()).filter(Boolean))];
  }

  function parseStunUri(value) {
    const source = String(value || "").trim();
    const match = /^stun:([^/?#:\s]+)(?::(\d{1,5}))?$/iu.exec(source);
    if (!match) return { valid: false, uri: source, reason: "Use stun:hostname:port." };

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
    const supplied = input && typeof input === "object" ? input : {};
    const settings = {
      enabled: supplied.enabled === true,
      stunServers: splitUrls(supplied.stunServers === undefined
        ? DEFAULT_SETTINGS.stunServers
        : supplied.stunServers).join("\n"),
    };
    const parsed = splitUrls(settings.stunServers).map(parseStunUri);
    const errors = [];
    if (settings.enabled && parsed.length < 2) {
      errors.push("Add at least two independent STUN discovery endpoints.");
    }
    if (settings.enabled) {
      errors.push(...parsed.filter((entry) => !entry.valid).map((entry) =>
        `${entry.uri || "Empty value"}: ${entry.reason}`));
      const distinctHosts = new Set(parsed.filter((entry) => entry.valid).map((entry) => entry.host));
      if (distinctHosts.size < 2) errors.push("Use at least two independent STUN hosts.");
    }
    return {
      settings,
      stunUris: parsed.filter((entry) => entry.valid).map((entry) => entry.uri),
      errors,
    };
  }

  function isDiscordNetworkConfiguration(configuration) {
    if (!configuration || typeof configuration !== "object") return false;
    return configuration.sdpSemantics === "plan-b" ||
      configuration.sdpSemantics === "unified-plan" ||
      configuration.bundlePolicy === "max-bundle";
  }

  const isDiscordVoiceConfiguration = isDiscordNetworkConfiguration;

  function candidateSummary(candidate) {
    const text = typeof candidate === "string" ? candidate : candidate && candidate.candidate;
    if (!text) return null;
    const typeMatch = /\btyp\s+(host|srflx|prflx|relay)\b/iu.exec(text);
    const protocolMatch = /^candidate:\S+\s+\d+\s+(udp|tcp)\s/iu.exec(text);
    const tcpTypeMatch = /\btcptype\s+(active|passive|so)\b/iu.exec(text);
    return {
      type: typeMatch ? typeMatch[1].toLowerCase() : "unknown",
      protocol: protocolMatch ? protocolMatch[1].toLowerCase() : "unknown",
      tcpType: tcpTypeMatch ? tcpTypeMatch[1].toLowerCase() : null,
    };
  }

  function blockedConfiguration(configuration) {
    const original = configuration && typeof configuration === "object" ? configuration : {};
    return { ...original, iceServers: [], iceTransportPolicy: "relay" };
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

  function safeCount(value, maximum = Number.MAX_SAFE_INTEGER) {
    return Number.isSafeInteger(value) && value >= 0 ? Math.min(value, maximum) : 0;
  }

  function normalizeBackendAllocation(value) {
    if (!value || typeof value !== "object") return null;
    const id = typeof value.id === "string" && /^[a-f0-9]{32}$/u.test(value.id) ? value.id : null;
    const relayAddress = normalizeIpv4Address(value.relayAddress);
    const relayPort = safeCount(value.relayPort, 65535);
    if (!id || !relayAddress || relayPort < 1) return null;
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
    const generation = safeCount(suppliedGeneration);
    const routeRevision = safeCount(value.routeRevision);
    const allowedPhases = new Set(["off", "waiting", "starting", "ready", "stopping", "error"]);
    const phase = allowedPhases.has(value.phase) ? value.phase : enabled ? "error" : "off";
    const sourceBackend = value.backend && typeof value.backend === "object" ? value.backend : null;
    const allocations = Array.isArray(sourceBackend && sourceBackend.allocations)
      ? sourceBackend.allocations.slice(0, 8).map(normalizeBackendAllocation).filter(Boolean)
      : [];
    const backend = sourceBackend ? {
      running: sourceBackend.running === true,
      controlSocketBound: sourceBackend.controlSocketBound === true,
      mode: sourceBackend.mode === "remote-mapped" ? "remote-mapped" : null,
      allocationCount: safeCount(sourceBackend.allocationCount, 8),
      allocations,
      mappingReadyAllocations: safeCount(sourceBackend.mappingReadyAllocations, 8),
      permissionCount: safeCount(sourceBackend.permissionCount, 32),
      channelCount: safeCount(sourceBackend.channelCount, 32),
      allocationsCreated: safeCount(sourceBackend.allocationsCreated),
      permissionsCreated: safeCount(sourceBackend.permissionsCreated),
      channelsBound: safeCount(sourceBackend.channelsBound),
      peerDatagramsQueued: safeCount(sourceBackend.peerDatagramsQueued),
      peerDatagramsReceived: safeCount(sourceBackend.peerDatagramsReceived),
      clientDatagramsQueued: safeCount(sourceBackend.clientDatagramsQueued),
      preludeActivations: safeCount(sourceBackend.preludeActivations),
      mappingProbeResponses: safeCount(sourceBackend.mappingProbeResponses),
      mappingProbeSuccesses: safeCount(sourceBackend.mappingProbeSuccesses),
      mappingProbeFailures: safeCount(sourceBackend.mappingProbeFailures),
      peerPolicyRejections: safeCount(sourceBackend.peerPolicyRejections),
    } : null;
    const endpoint = value.endpoint && typeof value.endpoint === "object" ? value.endpoint : null;
    const endpointUrls = Array.isArray(endpoint && endpoint.urls)
      ? endpoint.urls
      : (endpoint && typeof endpoint.turnUrl === "string" ? [endpoint.turnUrl] : []);
    const endpointValid = endpointUrls.length === 1 && validLoopbackTurnUrl(endpointUrls[0]) &&
      typeof endpoint.username === "string" && endpoint.username.length >= 1 &&
      endpoint.username.length <= 128 && typeof endpoint.credential === "string" &&
      endpoint.credential.length >= 1 && endpoint.credential.length <= 256;
    const backendReady = Boolean(backend && backend.running && backend.controlSocketBound &&
      backend.mode === "remote-mapped");
    const ready = Boolean(bootId && enabled && phase === "ready" && value.ready === true &&
      endpointValid && backendReady);
    return {
      bootId,
      enabled,
      ready,
      mode: "local",
      phase: enabled && phase === "ready" && !ready ? "error" : phase,
      generation,
      routeRevision,
      userDisabled: !enabled && value.userDisabled === true,
      reconnectRequired: value.reconnectRequired === true,
      errorCode: typeof value.errorCode === "string" ? value.errorCode.slice(0, 64) : null,
      backend,
      endpoint: ready ? {
        urls: endpointUrls,
        username: endpoint.username,
        credential: endpoint.credential,
      } : null,
    };
  }

  function routeConfiguration(current, route) {
    const normalized = normalizeRouteState(route);
    if (!normalized.ready || !normalized.endpoint) throw new Error("A ready local route is required");
    const base = current && typeof current === "object" ? current : {};
    return {
      ...base,
      iceServers: [{
        urls: normalized.endpoint.urls,
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

  function routeVerificationMode() { return "allocation"; }

  function backendTrafficEvidence(route, candidate, boundAllocationId = null) {
    const normalized = normalizeRouteState(route);
    const backend = normalized.backend;
    if (!normalized.ready || !backend || !candidate || typeof candidate !== "object") return null;
    const relayAddress = normalizeIpv4Address(candidate.address || candidate.ip);
    const suppliedPort = candidate.port === undefined ? candidate.portNumber : candidate.port;
    const relayPort = Number.isSafeInteger(suppliedPort) && suppliedPort >= 1 && suppliedPort <= 65535
      ? suppliedPort
      : null;
    const allocationId = typeof boundAllocationId === "string" && /^[a-f0-9]{32}$/u.test(boundAllocationId)
      ? boundAllocationId
      : null;
    if (!relayAddress || relayPort === null) return null;
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
    const matches = backend.allocations.filter((entry) => entry.id === allocationId && entry.mappingReady);
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

  const api = Object.freeze({
    DEFAULT_SETTINGS,
    DEFAULT_PROBE_SERVERS,
    splitUrls,
    parseStunUri,
    validateSettings,
    isDiscordNetworkConfiguration,
    isDiscordVoiceConfiguration,
    candidateSummary,
    blockedConfiguration,
    directConfiguration,
    normalizeRouteState,
    routeConfiguration,
    routeDecisionIsTerminal,
    routeVerificationMode,
    backendTrafficEvidence,
    boundBackendTrafficEvidence,
    backendConfirmsTraffic,
    validLoopbackTurnUrl,
  });

  if (root) Object.defineProperty(root, "__discordVoiceRelayTools", { value: api, configurable: true });
  if (typeof module === "object" && module && module.exports) module.exports = api;
})(typeof globalThis === "object" ? globalThis : this);
