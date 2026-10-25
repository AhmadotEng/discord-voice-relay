(function exposeTurnServer(root, factory) {
  "use strict";

  const api = factory();
  if (typeof module === "object" && module && module.exports) {
    module.exports = api;
  } else {
    Object.defineProperty(root, "TurnServer", {
      configurable: true,
      value: api,
    });
  }
})(this, function buildTurnServer() {
  "use strict";

  const codec = globalThis.TurnCodec ||
    (typeof require === "function" ? require("../lib/turn-codec.js") : null);
  const mappingPolicy = globalThis.MappingPolicy ||
    (typeof require === "function" ? require("../lib/mapping-policy.js") : null);
  if (!codec || !mappingPolicy) throw new Error("turn-support-libraries-unavailable");

  const LOOPBACK_ADDRESS = "127.0.0.1";
  const RELAY_BIND_ADDRESS = "0.0.0.0";
  const CONTROL_SOCKET_NAME = "discord-direct/v1/control";
  const RELAY_SOCKET_PREFIX = "discord-direct/v1/relay/";
  const DEFAULT_REALM = "discord-direct.local";
  const DEFAULT_LIFETIME = 600;
  const PERMISSION_LIFETIME_MS = 300_000;
  const CHANNEL_LIFETIME_MS = 600_000;
  const MAX_ALLOCATIONS = 8;
  const MAX_PEER_IPS = 4;
  const MAPPING_FAILURE_COOLDOWN_MS = 5_000;
  const MAX_MAPPING_FAILURE_COOLDOWNS = 32;
  const SOFTWARE = "Discord Direct for Chromium loopback TURN";
  const UDP_BUFFER_SIZE = 64 * 1024;

  let controlSocket = null;
  let configuration = null;
  const allocations = new Map();
  // Allocations are keyed by the client endpoint in `allocations`, but the
  // relay sockets are tracked by allocation id. Keep a second index so an
  // inbound relay datagram can be routed to the right allocation.
  const allocationsById = new Map();
  const failedMappingClients = new Map();
  // Every native socket is tracked independently of the allocation bookkeeping
  // so a shutdown can never lose the only usable reference to a socket.
  const socketRecords = new Map();
  let stopping = false;
  let stopPromise = null;
  let lifecycleGeneration = 0;
  let lifecycleQueue = Promise.resolve();

  const stats = {
    requests: 0,
    authChallenges: 0,
    allocationsCreated: 0,
    permissionsCreated: 0,
    channelsBound: 0,
    allocationQuotaRejections: 0,
    peerPolicyRejections: 0,
    peerDatagramsQueued: 0,
    peerDatagramsReceived: 0,
    clientDatagramsQueued: 0,
    preludePacketsQueued: 0,
    preludeActivations: 0,
    socketCloseRequests: 0,
    socketCloseErrors: 0,
    cleanupTimeouts: 0,
    stalePacketsIgnored: 0,
    mappingProbeRequestsQueued: 0,
    mappingProbeResponses: 0,
    mappingProbeSuccesses: 0,
    mappingProbeFailures: 0,
    lastMappingFailure: null,
    lastError: null,
  };

  function resetStats() {
    for (const key of Object.keys(stats)) {
      stats[key] = key === "lastError" || key === "lastMappingFailure" ? null : 0;
    }
  }

  // ---------------------------------------------------------------- chrome api

  function chromeApi() {
    const api = globalThis.chrome;
    if (!api || !api.sockets || !api.sockets.udp) {
      throw new Error("sockets-udp-unavailable");
    }
    return api;
  }

  function readLastError() {
    const api = globalThis.chrome;
    return api && api.runtime && api.runtime.lastError ? api.runtime.lastError : null;
  }

  function withCallback(invoke) {
    return new Promise((resolve, reject) => {
      try {
        invoke((result) => {
          const lastError = readLastError();
          if (lastError) {
            reject(new Error(lastError.message || "chrome-api-error"));
            return;
          }
          resolve(result);
        });
      } catch (error) {
        reject(error);
      }
    });
  }

  // Chromium exposes most socket members as promises and the datagram
  // members as callbacks. Prefer the promise form and fall back to the
  // callback form so both shapes keep working.
  async function invokeApi(invoke, args) {
    try {
      const result = invoke(...args);
      if (result && typeof result.then === "function") return await result;
      return result;
    } catch (error) {
      return withCallback((callback) => invoke(...args, callback));
    }
  }

  function exactArrayBuffer(bytes) {
    const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    if (view.byteOffset === 0 && view.byteLength === view.buffer.byteLength) {
      return view.buffer;
    }
    return view.slice().buffer;
  }

  async function createSocket(name) {
    const info = await invokeApi(
      (...args) => chromeApi().sockets.udp.create(...args),
      [{ persistent: true, name, bufferSize: UDP_BUFFER_SIZE }],
    );
    const socketId = info && typeof info === "object" ? info.socketId : info;
    if (!Number.isInteger(socketId) || socketId < 0) {
      throw new Error("udp-create-failed");
    }
    return socketId;
  }

  async function bindSocket(socketId, address, port) {
    const result = await withCallback((callback) =>
      chromeApi().sockets.udp.bind(socketId, address, port, callback));
    if (result !== 0) throw new Error(`udp-bind-failed:${result}`);
  }

  async function sendDatagram(socketId, address, port, bytes) {
    const info = await withCallback((callback) =>
      chromeApi().sockets.udp.send(
        socketId, exactArrayBuffer(bytes), address, port, "ipv4", callback));
    if (!info || info.resultCode < 0) {
      throw new Error(`udp-send-failed:${info && info.resultCode}`);
    }
    return info.bytesSent;
  }

  async function closeSocket(socketId) {
    try {
      await invokeApi((...args) => chromeApi().sockets.udp.close(...args), [socketId]);
    } catch (error) {
      stats.socketCloseErrors += 1;
    }
  }

  async function getSocketInfo(socketId) {
    return invokeApi((...args) => chromeApi().sockets.udp.getInfo(...args), [socketId]);
  }

  async function listSockets() {
    const sockets = await invokeApi((...args) => chromeApi().sockets.udp.getSockets(...args), []);
    return Array.isArray(sockets) ? sockets : [];
  }

  function trackSocket(socketId, role, allocationId) {
    socketRecords.set(socketId, { role, allocationId: allocationId || null, port: null });
    return socketId;
  }

  async function refreshSocketPort(socketId) {
    const record = socketRecords.get(socketId);
    if (!record) return null;
    try {
      const info = await getSocketInfo(socketId);
      if (info && Number.isInteger(info.localPort)) record.port = info.localPort;
    } catch (error) {
      // The socket may already be gone.
    }
    return record.port;
  }

  // ------------------------------------------------------------------ helpers

  function randomNonce() {
    const bytes = new Uint8Array(18);
    crypto.getRandomValues(bytes);
    return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  }

  function randomTransactionId() {
    const bytes = new Uint8Array(12);
    crypto.getRandomValues(bytes);
    return bytes;
  }

  function byteKey(value) {
    return Array.from(codec.asBytes(value), (byte) =>
      byte.toString(16).padStart(2, "0")).join("");
  }

  function endpointKey(endpoint) {
    return `${endpoint.address}:${endpoint.port}`;
  }

  function sameEndpoint(left, right) {
    return Boolean(left && right && left.address === right.address && left.port === right.port);
  }

  function enqueueLifecycle(task) {
    const result = lifecycleQueue.then(task, task);
    lifecycleQueue = result.catch(() => {});
    return result;
  }

  function assertLifecycleGeneration(generation) {
    if (generation !== lifecycleGeneration) {
      throw new Error("Lifecycle operation was superseded");
    }
  }

  // --------------------------------------------------------- configuration

  function normalizeConfiguration(input) {
    const options = input && typeof input === "object" ? input : {};
    const mode = options.mode === undefined ? "remote-mapped" : String(options.mode);
    if (mode !== "remote-mapped" && mode !== "local-test") {
      throw new Error("mode must be remote-mapped or local-test");
    }
    const port = Number.isInteger(options.port) ? options.port : 0;
    if (port < 0 || port > 65535) throw new Error("port must be between 0 and 65535");

    // Per-start credentials prevent an unrelated local process from reusing a
    // well-known password while the loopback listener is active.
    const username = options.username == null
      ? `u-${randomNonce()}`
      : String(options.username);
    const credential = options.credential == null
      ? `${randomNonce()}${randomNonce()}`
      : String(options.credential);
    const realm = String(options.realm || DEFAULT_REALM);
    if (!username || username.length > 128) throw new Error("username must contain 1-128 characters");
    if (!credential || credential.length > 256) throw new Error("credential must contain 1-256 characters");
    if (!realm || realm.length > 128) throw new Error("realm must contain 1-128 characters");

    const rawServers = options.mappingProbeServers === undefined
      ? []
      : options.mappingProbeServers;
    if (!Array.isArray(rawServers) || rawServers.length > 8) {
      throw new Error("mappingProbeServers must contain at most eight STUN URIs");
    }
    const mappingProbeDefinitions = rawServers.map((value) =>
      mappingPolicy.parseStunUri(value));
    if (mode === "remote-mapped" && mappingProbeDefinitions.length < 2) {
      throw new Error("remote-mapped mode requires at least two STUN probe servers");
    }

    // Zero means "the first peer datagram". Setting this to 74 reproduces
    // Drover's desktop heuristic, but browser WebRTC normally starts with STUN
    // and therefore needs the transport-agnostic default.
    const triggerLength = Number.isInteger(options.triggerLength) ? options.triggerLength : 0;
    const delayMs = Number.isInteger(options.delayMs) ? options.delayMs : 50;
    if (triggerLength < 0 || triggerLength > 65507) throw new Error("triggerLength is invalid");
    if (delayMs < 0 || delayMs > 5000) throw new Error("delayMs must be between 0 and 5000");

    const rawPackets = options.preludePackets === undefined
      ? [[0], [1]]
      : options.preludePackets;
    if (!Array.isArray(rawPackets) || rawPackets.length > 8) {
      throw new Error("preludePackets must contain at most eight packets");
    }
    const preludePackets = rawPackets.map((packet) => {
      if (!Array.isArray(packet) || packet.length > 2048 ||
          packet.some((byte) => !Number.isInteger(byte) || byte < 0 || byte > 255)) {
        throw new Error("Each prelude packet must be an array of at most 2048 bytes");
      }
      return Uint8Array.from(packet);
    });

    return {
      mode,
      port,
      username,
      credential,
      realm,
      mappingProbeDefinitions,
      mappingProbeTimeoutMs: Number.isInteger(options.mappingProbeTimeoutMs)
        ? options.mappingProbeTimeoutMs
        : 1800,
      mappingProbeRetries: Number.isInteger(options.mappingProbeRetries)
        ? options.mappingProbeRetries
        : 2,
      triggerLength,
      delayMs,
      preludePackets,
      nonce: randomNonce(),
      key: codec.longTermKey(username, realm, credential),
    };
  }

  // ------------------------------------------------------------- TURN server

  function sendStun(endpoint, method, messageClass, transactionId, attributes, key = null) {
    if (!controlSocket) return Promise.resolve();
    const bytes = codec.encodeMessage({
      method,
      class: messageClass,
      transactionId,
      attributes: attributes || [],
      key,
    });
    return sendDatagram(controlSocket, endpoint.address, endpoint.port, bytes)
      .then(() => { stats.clientDatagramsQueued += 1; })
      .catch((error) => { stats.lastError = String(error && error.message || error); });
  }

  function sendError(endpoint, request, code, reason, { challenge = false, key = null } = {}) {
    const attributes = [codec.attribute(codec.ATTR.ERROR_CODE, codec.encodeError(code, reason))];
    if (challenge) {
      attributes.push(codec.textAttribute(codec.ATTR.REALM, configuration.realm));
      attributes.push(codec.textAttribute(codec.ATTR.NONCE, configuration.nonce));
      stats.authChallenges += 1;
    }
    return sendStun(endpoint, request.method, codec.CLASS.ERROR, request.transactionId, attributes, key);
  }

  function authenticate(endpoint, request) {
    const username = codec.attributeText(request, codec.ATTR.USERNAME);
    const realm = codec.attributeText(request, codec.ATTR.REALM);
    const nonce = codec.attributeText(request, codec.ATTR.NONCE);
    const integrity = codec.getAttribute(request, codec.ATTR.MESSAGE_INTEGRITY);

    if (!username || !realm || !nonce || !integrity) {
      sendError(endpoint, request, 401, "Unauthorized", { challenge: true });
      return null;
    }
    if (nonce !== configuration.nonce) {
      sendError(endpoint, request, 438, "Stale Nonce", { challenge: true });
      return null;
    }
    if (username !== configuration.username || realm !== configuration.realm ||
        !codec.verifyMessageIntegrity(request, configuration.key)) {
      sendError(endpoint, request, 401, "Unauthorized", { challenge: true });
      return null;
    }
    // Attributes after MESSAGE-INTEGRITY are not authenticated (normally only
    // FINGERPRINT follows). Do not expose them to TURN request handlers.
    const integrityIndex = request.attributes.indexOf(integrity);
    request.attributes = request.attributes.slice(0, integrityIndex);
    return configuration.key;
  }

  function allocationFor(endpoint, request, key) {
    const target = allocations.get(endpointKey(endpoint));
    if (!target) {
      sendError(endpoint, request, 437, "Allocation Mismatch", { key });
      return null;
    }
    if (target.expiresAt <= Date.now()) {
      closeAllocation(target);
      sendError(endpoint, request, 437, "Allocation Mismatch", { key });
      return null;
    }
    return target;
  }

  function scheduleAllocationExpiry(target) {
    clearTimeout(target.expiryTimer);
    const remaining = Math.max(0, target.expiresAt - Date.now());
    target.expiryTimer = setTimeout(() => {
      if (allocations.get(endpointKey(target.client)) === target && target.expiresAt <= Date.now()) {
        closeAllocation(target);
      }
    }, remaining + 10);
  }

  function closeAllocation(target) {
    if (!target || target.closed) return;
    target.closed = true;
    if (allocations.get(endpointKey(target.client)) === target) {
      allocations.delete(endpointKey(target.client));
    }
    allocationsById.delete(target.id);
    if (target.expiryTimer !== null) clearTimeout(target.expiryTimer);
    if (target.delayTimer !== null) clearTimeout(target.delayTimer);
    if (target.mapping) {
      for (const timer of target.mapping.timers) clearTimeout(timer);
      target.mapping.timers.length = 0;
      target.mapping.transactions.clear();
      target.mapping.pendingAllocates.clear();
    }
    target.expiryTimer = null;
    target.delayTimer = null;
    target.delaying = false;
    target.queue.length = 0;
    const upstream = target.upstream;
    target.upstream = null;
    if (Number.isInteger(upstream)) {
      stats.socketCloseRequests += 1;
      socketRecords.delete(upstream);
      void closeSocket(upstream);
    }
  }

  function permissionAllowed(target, address) {
    const expiry = target.permissions.get(address) || 0;
    if (expiry <= Date.now()) {
      target.permissions.delete(address);
      return false;
    }
    return true;
  }

  function peerAddressAllowed(address) {
    return codec.isPublicIPv4(address);
  }

  function canAddPeerAddresses(target, peers) {
    const now = Date.now();
    for (const [address, expiry] of target.permissions) {
      if (expiry <= now) target.permissions.delete(address);
    }
    const addresses = new Set(target.permissions.keys());
    for (const peer of peers) addresses.add(peer.address);
    return addresses.size <= MAX_PEER_IPS;
  }

  function sendPeerNow(target, peer, data) {
    if (stopping || target.closed || !Number.isInteger(target.upstream) ||
        allocations.get(endpointKey(target.client)) !== target) {
      return Promise.resolve();
    }
    return sendDatagram(target.upstream, peer.address, peer.port, data)
      .then(() => {
        target.peerDatagramsQueued += 1;
        stats.peerDatagramsQueued += 1;
      })
      .catch((error) => {
        stats.lastError = String(error && error.message || error);
        closeAllocation(target);
      });
  }

  function drainPeerQueue(target) {
    if (allocations.get(endpointKey(target.client)) !== target || target.delaying ||
        target.queue.length === 0) {
      return Promise.resolve();
    }
    const item = target.queue[0];
    if (!item.ready) return Promise.resolve();
    // The item leaves the queue before it is sent, so a second datagram can
    // never be sent twice.
    const pending = target.queue.shift();
    if (!target.upstreamHasSent) {
      target.upstreamHasSent = true;
      if (configuration.triggerLength === 0 || pending.data.length === configuration.triggerLength) {
        target.delaying = true;
        const prelude = configuration.preludePackets
          .map((packet) => sendPeerNow(target, pending.peer, packet))
          .reduce((chain, promise) => chain.then(() => promise), Promise.resolve());
        return prelude.then(() => {
          stats.preludePacketsQueued += configuration.preludePackets.length;
          stats.preludeActivations += 1;
          target.delayTimer = setTimeout(() => {
            target.delaying = false;
            target.delayTimer = null;
            sendPeerNow(target, pending.peer, pending.data)
              .then(() => drainPeerQueue(target))
              .catch((error) => {
                stats.lastError = String(error && error.message || error);
                closeAllocation(target);
              });
          }, configuration.delayMs);
        });
      }
    }
    return sendPeerNow(target, pending.peer, pending.data).then(() => drainPeerQueue(target));
  }

  function queuePeerDatagram(target, peer, data) {
    if (target.queue.length >= 256) throw new Error("TURN upstream queue limit reached");
    const item = { peer, data: codec.asBytes(data).slice(), ready: true };
    target.queue.push(item);
    return drainPeerQueue(target);
  }

  function sendDataIndication(target, peer, data) {
    const transactionId = randomTransactionId();
    return sendStun(target.client, codec.METHOD.DATA, codec.CLASS.INDICATION, transactionId, [
      codec.attribute(codec.ATTR.XOR_PEER_ADDRESS,
        codec.encodeAddress(peer.address, peer.port, transactionId)),
      codec.attribute(codec.ATTR.DATA, data),
    ]);
  }

  function clearMappingTimers(target) {
    for (const timer of target.mapping.timers) clearTimeout(timer);
    target.mapping.timers.length = 0;
    target.mapping.transactions.clear();
  }

  function sendAllocateSuccess(target, endpoint, request, key) {
    if (!target.advertisedRelay) {
      throw new Error("Refusing Allocate success without a verified relay address");
    }
    return sendStun(endpoint, request.method, codec.CLASS.SUCCESS, request.transactionId, [
      codec.attribute(codec.ATTR.XOR_RELAYED_ADDRESS,
        codec.encodeAddress(
          target.advertisedRelay.address,
          target.advertisedRelay.port,
          request.transactionId
        )),
      codec.attribute(codec.ATTR.XOR_MAPPED_ADDRESS,
        codec.encodeAddress(endpoint.address, endpoint.port, request.transactionId)),
      codec.attribute(codec.ATTR.LIFETIME, codec.uint32(DEFAULT_LIFETIME)),
      codec.textAttribute(codec.ATTR.SOFTWARE, SOFTWARE),
    ], key);
  }

  function failMappingProbe(target, reason) {
    if (!target.mapping || target.mapping.state !== "probing" || target.closed) return;
    target.mapping.state = "failed";
    clearMappingTimers(target);
    stats.mappingProbeFailures += 1;
    stats.lastMappingFailure = String(reason || "mapping-check-failed");
    const now = Date.now();
    for (const [clientKey, failure] of failedMappingClients) {
      if (failure.until <= now) failedMappingClients.delete(clientKey);
    }
    while (failedMappingClients.size >= MAX_MAPPING_FAILURE_COOLDOWNS) {
      failedMappingClients.delete(failedMappingClients.keys().next().value);
    }
    failedMappingClients.set(endpointKey(target.client), {
      until: now + MAPPING_FAILURE_COOLDOWN_MS,
      reason: stats.lastMappingFailure,
    });
    for (const pending of target.mapping.pendingAllocates.values()) {
      sendError(pending.endpoint, pending.request, 508, "Mapping Check Failed", { key: pending.key })
        .catch(() => {});
    }
    target.mapping.pendingAllocates.clear();
    closeAllocation(target);
  }

  function completeMappingProbe(target, mapping) {
    if (!target.mapping || target.mapping.state !== "probing" || target.closed) return;
    target.mapping.state = "ready";
    clearMappingTimers(target);
    target.advertisedRelay = { address: mapping.address, port: mapping.port };
    stats.mappingProbeSuccesses += 1;
    for (const pending of target.mapping.pendingAllocates.values()) {
      sendAllocateSuccess(target, pending.endpoint, pending.request, pending.key).catch(() => {});
    }
    target.mapping.pendingAllocates.clear();
  }

  function evaluateMappingProbe(target) {
    const observations = Array.from(target.mapping.observations.values());
    const verdict = mappingPolicy.evaluateMappings(observations, codec.isPublicIPv4);
    if (verdict.ok) {
      // Consider every timely observation instead of succeeding on the first
      // agreeing pair: a later answer from another destination could still
      // disagree, which would mean an endpoint-dependent NAT.
      if (observations.length >= target.mapping.expectedObservations) {
        completeMappingProbe(target, verdict.mapping);
      }
      return;
    }
    if (observations.length >= 2 &&
        (verdict.reason === "endpoint-dependent-mapping" ||
         verdict.reason === "invalid-public-endpoint" ||
         verdict.reason === "not-independent")) {
      failMappingProbe(target, verdict.reason);
    }
  }

  function sendMappingProbeRound(target) {
    if (!target.mapping || target.mapping.state !== "probing" || target.closed ||
        !Number.isInteger(target.upstream)) {
      return Promise.resolve();
    }
    const chain = configuration.mappingProbeDefinitions.reduce((previous, definition, index) => {
      return previous.then(() => {
        if (target.mapping.state !== "probing" || target.closed) return undefined;
        if (target.mapping.answered.has(index)) return undefined;
        const transactionId = randomTransactionId();
        target.mapping.transactions.set(byteKey(transactionId), { definition, index });
        const request = codec.encodeMessage({
          method: codec.METHOD.BINDING,
          class: codec.CLASS.REQUEST,
          transactionId,
          attributes: [],
        });
        stats.mappingProbeRequestsQueued += 1;
        return sendDatagram(target.upstream, definition.host, definition.port, request)
          .catch((error) => {
            stats.lastError = String(error && error.message || error);
            target.mapping.transactions.delete(byteKey(transactionId));
          });
      });
    }, Promise.resolve());
    return chain;
  }

  function startMappingProbe(target, initialPending) {
    target.mapping = {
      state: "probing",
      observations: new Map(),
      transactions: new Map(),
      answered: new Set(),
      expectedObservations: configuration.mappingProbeDefinitions.length,
      pendingAllocates: new Map([[
        byteKey(initialPending.request.transactionId),
        initialPending,
      ]]),
      timers: [],
    };
    const rounds = configuration.mappingProbeRetries + 1;
    for (let retry = 1; retry <= configuration.mappingProbeRetries; retry += 1) {
      target.mapping.timers.push(setTimeout(
        () => { void sendMappingProbeRound(target); },
        Math.floor(configuration.mappingProbeTimeoutMs * retry / rounds),
      ));
    }
    target.mapping.timers.push(setTimeout(() => {
      if (!target.mapping || target.mapping.state !== "probing") return;
      const verdict = mappingPolicy.evaluateMappings(
        Array.from(target.mapping.observations.values()),
        codec.isPublicIPv4
      );
      if (verdict.ok) {
        completeMappingProbe(target, verdict.mapping);
      } else {
        failMappingProbe(target, verdict.reason || "mapping-probe-timeout");
      }
    }, configuration.mappingProbeTimeoutMs));
    return sendMappingProbeRound(target);
  }

  function handleMappingProbePacket(target, peer, data) {
    if (!target.mapping || target.mapping.state !== "probing" || data.length < 20 ||
        (data[0] & 0xc0) !== 0) {
      return false;
    }
    let response;
    try {
      response = codec.decodeMessage(data);
    } catch (error) {
      return false;
    }
    const pending = target.mapping.transactions.get(byteKey(response.transactionId));
    if (!pending) return false;
    // A transaction ID alone is not authority: the answer must come from the
    // port the probe was sent to.
    if (peer.port !== pending.definition.port) return true;
    if (response.method !== codec.METHOD.BINDING || response.class !== codec.CLASS.SUCCESS) {
      failMappingProbe(target, "probe-error-response");
      return true;
    }
    const mappedAttribute = codec.getAttribute(response, codec.ATTR.XOR_MAPPED_ADDRESS);
    if (!mappedAttribute) {
      failMappingProbe(target, "missing-xor-mapped-address");
      return true;
    }
    let mapped;
    try {
      mapped = codec.decodeAddress(mappedAttribute.value, response.transactionId);
    } catch (error) {
      failMappingProbe(target, "invalid-xor-mapped-address");
      return true;
    }
    if (!codec.isPublicIPv4(mapped.address) || mapped.port < 1 || mapped.port > 65535) {
      failMappingProbe(target, "invalid-public-endpoint");
      return true;
    }
    if (!codec.isPublicIPv4(peer.address)) {
      // A discovery answer that does not come from a public address cannot
      // prove anything about the public mapping.
      failMappingProbe(target, "invalid-public-endpoint");
      return true;
    }
    const serverKey = endpointKey(peer);
    const existing = target.mapping.observations.get(serverKey);
    if (!existing) {
      target.mapping.observations.set(serverKey, {
        serverAddress: peer.address,
        serverPort: peer.port,
        mappedAddress: mapped.address,
        mappedPort: mapped.port,
      });
      stats.mappingProbeResponses += 1;
    } else if (existing.mappedAddress !== mapped.address || existing.mappedPort !== mapped.port) {
      // The same destination reported two different mappings. That is an
      // endpoint-dependent mapping, not a race.
      failMappingProbe(target, "endpoint-dependent-mapping");
      return true;
    }
    target.mapping.answered.add(pending.index);
    evaluateMappingProbe(target);
    return true;
  }

  async function createUpstreamSocket(target) {
    const socketId = await createSocket(`${RELAY_SOCKET_PREFIX}${target.id}`);
    trackSocket(socketId, "relay", target.id);
    try {
      await bindSocket(socketId, RELAY_BIND_ADDRESS, 0);
    } catch (error) {
      socketRecords.delete(socketId);
      await closeSocket(socketId);
      throw error;
    }
    await refreshSocketPort(socketId);
    return socketId;
  }

  function handleBinding(endpoint, request) {
    return sendStun(endpoint, request.method, codec.CLASS.SUCCESS, request.transactionId, [
      codec.attribute(codec.ATTR.XOR_MAPPED_ADDRESS,
        codec.encodeAddress(endpoint.address, endpoint.port, request.transactionId)),
      codec.textAttribute(codec.ATTR.SOFTWARE, SOFTWARE),
    ]);
  }

  async function handleAllocate(endpoint, request, key) {
    const transport = codec.getAttribute(request, codec.ATTR.REQUESTED_TRANSPORT);
    if (!transport || transport.value.length !== 4 || transport.value[0] !== 17) {
      return sendError(endpoint, request, 442, "Unsupported Transport Protocol", { key });
    }
    const clientKey = endpointKey(endpoint);
    const recentFailure = failedMappingClients.get(clientKey);
    if (recentFailure) {
      if (recentFailure.until > Date.now()) {
        return sendError(endpoint, request, 508, "Mapping Check Failed", { key });
      }
      failedMappingClients.delete(clientKey);
    }
    let target = allocations.get(clientKey);
    if (!target && allocations.size >= MAX_ALLOCATIONS) {
      stats.allocationQuotaRejections += 1;
      return sendError(endpoint, request, 486, "Allocation Quota Reached", { key });
    }
    if (!target) {
      target = {
        id: randomNonce().slice(0, 32),
        client: endpoint,
        upstream: null,
        expiresAt: Date.now() + DEFAULT_LIFETIME * 1000,
        expiryTimer: null,
        delayTimer: null,
        delaying: false,
        upstreamHasSent: false,
        queue: [],
        permissions: new Map(),
        channels: new Map(),
        peerChannels: new Map(),
        peerDatagramsQueued: 0,
        peerDatagramsReceived: 0,
        closed: false,
        advertisedRelay: null,
        mapping: null,
      };
      try {
        target.upstream = await createUpstreamSocket(target);
      } catch (error) {
        stats.lastError = String(error && error.message || error);
        return sendError(endpoint, request, 508, "Mapping Check Failed", { key });
      }
      allocations.set(clientKey, target);
      allocationsById.set(target.id, target);
      scheduleAllocationExpiry(target);
      stats.allocationsCreated += 1;
      if (configuration.mode === "remote-mapped") {
        try {
          await startMappingProbe(target, { endpoint, request, key });
        } catch (error) {
          stats.lastError = String(error && error.message || error);
          if (!target.mapping) {
            target.mapping = {
              state: "probing",
              observations: new Map(),
              transactions: new Map(),
              answered: new Set(),
              expectedObservations: configuration.mappingProbeDefinitions.length,
              pendingAllocates: new Map([[
                byteKey(request.transactionId),
                { endpoint, request, key },
              ]]),
              timers: [],
            };
          }
          failMappingProbe(target, "probe-send-failed");
        }
        return undefined;
      }
      target.advertisedRelay = {
        address: LOOPBACK_ADDRESS,
        port: target.upstream ? socketRecords.get(target.upstream)?.port : 0,
      };
    } else if (target.mapping && target.mapping.state === "probing") {
      target.mapping.pendingAllocates.set(byteKey(request.transactionId), {
        endpoint, request, key,
      });
      return undefined;
    }
    return sendAllocateSuccess(target, endpoint, request, key);
  }

  function requestedLifetime(request) {
    const lifetime = codec.getAttribute(request, codec.ATTR.LIFETIME);
    return lifetime && lifetime.value.length === 4
      ? Math.min(DEFAULT_LIFETIME, codec.read32(lifetime.value, 0))
      : DEFAULT_LIFETIME;
  }

  function handleRefresh(endpoint, request, key) {
    const target = allocationFor(endpoint, request, key);
    if (!target) return undefined;
    const lifetime = requestedLifetime(request);
    if (lifetime === 0) {
      sendStun(endpoint, request.method, codec.CLASS.SUCCESS, request.transactionId, [
        codec.attribute(codec.ATTR.LIFETIME, codec.uint32(0)),
      ], key);
      closeAllocation(target);
      return undefined;
    }
    target.expiresAt = Date.now() + lifetime * 1000;
    scheduleAllocationExpiry(target);
    return sendStun(endpoint, request.method, codec.CLASS.SUCCESS, request.transactionId, [
      codec.attribute(codec.ATTR.LIFETIME, codec.uint32(lifetime)),
    ], key);
  }

  function decodePeerAttributes(request) {
    return codec.getAttributes(request, codec.ATTR.XOR_PEER_ADDRESS)
      .map((entry) => codec.decodeAddress(entry.value, request.transactionId));
  }

  function handleCreatePermission(endpoint, request, key) {
    const target = allocationFor(endpoint, request, key);
    if (!target) return undefined;
    let peers;
    try {
      peers = decodePeerAttributes(request);
    } catch (error) {
      return sendError(endpoint, request, 400, "Bad Request", { key });
    }
    if (peers.length === 0) {
      return sendError(endpoint, request, 400, "Bad Request", { key });
    }
    if (peers.some((peer) => !peerAddressAllowed(peer.address))) {
      stats.peerPolicyRejections += 1;
      return sendError(endpoint, request, 403, "Forbidden", { key });
    }
    if (!canAddPeerAddresses(target, peers)) {
      stats.peerPolicyRejections += 1;
      return sendError(endpoint, request, 508, "Insufficient Capacity", { key });
    }
    for (const peer of peers) {
      target.permissions.set(peer.address, Date.now() + PERMISSION_LIFETIME_MS);
    }
    stats.permissionsCreated += peers.length;
    return sendStun(endpoint, request.method, codec.CLASS.SUCCESS, request.transactionId, [], key);
  }

  function handleChannelBind(endpoint, request, key) {
    const target = allocationFor(endpoint, request, key);
    if (!target) return undefined;
    const channelAttribute = codec.getAttribute(request, codec.ATTR.CHANNEL_NUMBER);
    const peerAttribute = codec.getAttribute(request, codec.ATTR.XOR_PEER_ADDRESS);
    if (!channelAttribute || channelAttribute.value.length < 2 || !peerAttribute) {
      return sendError(endpoint, request, 400, "Bad Request", { key });
    }
    const channel = codec.read16(channelAttribute.value, 0);
    let peer;
    try {
      peer = codec.decodeAddress(peerAttribute.value, request.transactionId);
    } catch (error) {
      return sendError(endpoint, request, 400, "Bad Request", { key });
    }
    if (channel < 0x4000 || channel > 0x7fff) {
      return sendError(endpoint, request, 400, "Bad Request", { key });
    }
    if (!peerAddressAllowed(peer.address)) {
      stats.peerPolicyRejections += 1;
      return sendError(endpoint, request, 403, "Forbidden", { key });
    }
    if (!canAddPeerAddresses(target, [peer])) {
      stats.peerPolicyRejections += 1;
      return sendError(endpoint, request, 508, "Insufficient Capacity", { key });
    }
    const previousChannel = target.channels.get(channel);
    const previousPeer = target.peerChannels.get(endpointKey(peer));
    if ((previousChannel && endpointKey(previousChannel.peer) !== endpointKey(peer)) ||
        (previousPeer && previousPeer.channel !== channel)) {
      return sendError(endpoint, request, 400, "Bad Request", { key });
    }
    const expiresAt = Date.now() + CHANNEL_LIFETIME_MS;
    target.permissions.set(peer.address, Date.now() + PERMISSION_LIFETIME_MS);
    target.channels.set(channel, { peer, expiresAt });
    target.peerChannels.set(endpointKey(peer), { channel, expiresAt });
    stats.channelsBound += 1;
    return sendStun(endpoint, request.method, codec.CLASS.SUCCESS, request.transactionId, [], key);
  }

  function handleSendIndication(endpoint, request) {
    const target = allocations.get(endpointKey(endpoint));
    if (!target) return undefined;
    const peerAttribute = codec.getAttribute(request, codec.ATTR.XOR_PEER_ADDRESS);
    const dataAttribute = codec.getAttribute(request, codec.ATTR.DATA);
    if (!peerAttribute || !dataAttribute) return undefined;
    try {
      const peer = codec.decodeAddress(peerAttribute.value, request.transactionId);
      if (!permissionAllowed(target, peer.address)) return undefined;
      return queuePeerDatagram(target, peer, dataAttribute.value);
    } catch (error) {
      stats.lastError = String(error && error.message || error);
      return undefined;
    }
  }

  function handleChannelData(endpoint, bytes) {
    const target = allocations.get(endpointKey(endpoint));
    if (!target) return undefined;
    const frame = codec.decodeChannelData(bytes);
    const channelEntry = target.channels.get(frame.channel);
    if (!channelEntry || channelEntry.expiresAt <= Date.now() ||
        !permissionAllowed(target, channelEntry.peer.address)) {
      return undefined;
    }
    return queuePeerDatagram(target, channelEntry.peer, frame.data);
  }

  function handleStun(endpoint, bytes) {
    const request = codec.decodeMessage(bytes);
    stats.requests += 1;
    if (request.class === codec.CLASS.INDICATION && request.method === codec.METHOD.SEND) {
      return handleSendIndication(endpoint, request);
    }
    if (request.class !== codec.CLASS.REQUEST) return undefined;
    if (request.method === codec.METHOD.BINDING) {
      return handleBinding(endpoint, request);
    }
    const key = authenticate(endpoint, request);
    if (!key) return undefined;
    switch (request.method) {
      case codec.METHOD.ALLOCATE:
        return handleAllocate(endpoint, request, key);
      case codec.METHOD.REFRESH:
        return handleRefresh(endpoint, request, key);
      case codec.METHOD.CREATE_PERMISSION:
        return handleCreatePermission(endpoint, request, key);
      case codec.METHOD.CHANNEL_BIND:
        return handleChannelBind(endpoint, request, key);
      default:
        return sendError(endpoint, request, 400, "Bad Request", { key });
    }
  }

  function handleClientPacket(socketId, endpoint, bytes) {
    if (stopping || controlSocket !== socketId || !configuration) {
      stats.stalePacketsIgnored += 1;
      return undefined;
    }
    try {
      if ((bytes[0] & 0xc0) === 0x40) {
        return handleChannelData(endpoint, bytes);
      }
      return handleStun(endpoint, bytes);
    } catch (error) {
      stats.lastError = String(error && error.message || error);
      return undefined;
    }
  }

  function handleRelayPacket(target, endpoint, bytes) {
    if (stopping || !target || target.closed || !Number.isInteger(target.upstream) ||
        allocations.get(endpointKey(target.client)) !== target) {
      stats.stalePacketsIgnored += 1;
      return undefined;
    }
    try {
      if (handleMappingProbePacket(target, endpoint, bytes)) return undefined;
      if (!permissionAllowed(target, endpoint.address)) return undefined;
      target.peerDatagramsReceived += 1;
      stats.peerDatagramsReceived += 1;
      const channelEntry = target.peerChannels.get(endpointKey(endpoint));
      if (channelEntry && channelEntry.expiresAt > Date.now()) {
        sendStun(target.client, codec.METHOD.DATA, codec.CLASS.INDICATION, randomTransactionId(), [
          codec.attribute(codec.ATTR.XOR_PEER_ADDRESS,
            codec.encodeAddress(endpoint.address, endpoint.port, randomTransactionId())),
          codec.attribute(codec.ATTR.DATA, bytes),
        ]);
        stats.clientDatagramsQueued += 1;
      } else {
        if (channelEntry) target.peerChannels.delete(endpointKey(endpoint));
        sendDataIndication(target, endpoint, bytes);
      }
      return undefined;
    } catch (error) {
      stats.lastError = String(error && error.message || error);
      return undefined;
    }
  }

  function handleUdpReceive(info) {
    const record = socketRecords.get(info.socketId);
    if (!record) {
      stats.stalePacketsIgnored += 1;
      return;
    }
    const endpoint = { address: info.remoteAddress, port: info.remotePort };
    const bytes = new Uint8Array(info.data);
    if (record.role === "control") {
      void handleClientPacket(info.socketId, endpoint, bytes);
      return;
    }
    const target = allocationsById.get(record.allocationId);
    if (!target) {
      stats.stalePacketsIgnored += 1;
      return;
    }
    void handleRelayPacket(target, endpoint, bytes);
  }

  function handleUdpReceiveError(info) {
    const record = socketRecords.get(info.socketId);
    if (!record) return;
    if (record.role === "control") {
      stats.lastError = `TURN listener stopped: ${info.resultCode}`;
      lifecycleGeneration += 1;
      void enqueueLifecycle(() => stopServer());
      return;
    }
    const target = allocationsById.get(record.allocationId);
    if (target && !target.closed) {
      stats.lastError = `Upstream UDP listener stopped: ${info.resultCode}`;
      closeAllocation(target);
    }
  }

  // ------------------------------------------------------------- lifecycle

  async function stopServer() {
    if (stopPromise) return stopPromise;
    stopping = true;
    const activeControlSocket = controlSocket;
    controlSocket = null;
    if (Number.isInteger(activeControlSocket)) {
      stats.socketCloseRequests += 1;
      socketRecords.delete(activeControlSocket);
      void closeSocket(activeControlSocket);
    }
    for (const target of Array.from(allocations.values())) closeAllocation(target);
    allocations.clear();
    allocationsById.clear();
    failedMappingClients.clear();
    for (const socketId of Array.from(socketRecords.keys())) {
      stats.socketCloseRequests += 1;
      socketRecords.delete(socketId);
      void closeSocket(socketId);
    }
    configuration = null;
    stopPromise = Promise.resolve().then(() => {
      configuration = null;
      stopping = false;
      stopPromise = null;
    });
    return stopPromise;
  }

  function statusSnapshot() {
    return {
      running: Boolean(controlSocket),
      mode: configuration ? configuration.mode : null,
      address: controlSocket ? LOOPBACK_ADDRESS : null,
      port: controlSocket && socketRecords.get(controlSocket)
        ? socketRecords.get(controlSocket).port
        : null,
      controlSocketBound: Boolean(controlSocket),
      allocationCount: allocations.size,
      openSocketCount: socketRecords.size,
      allocations: Array.from(allocations.values(), (target) => ({
        id: target.id,
        relayAddress: target.advertisedRelay ? target.advertisedRelay.address : null,
        relayPort: target.advertisedRelay ? target.advertisedRelay.port : null,
        permissions: target.permissions.size,
        channels: target.channels.size,
        mappingState: target.mapping ? target.mapping.state : "local",
        mappingResponses: target.mapping ? target.mapping.observations.size : 0,
        expiresInSeconds: Math.max(0, Math.ceil((target.expiresAt - Date.now()) / 1000)),
        upstreamHasSent: target.upstreamHasSent,
        peerDatagramsQueued: target.peerDatagramsQueued,
        peerDatagramsReceived: target.peerDatagramsReceived,
      })),
      stats: { ...stats },
    };
  }

  // ------------------------------------------------------- state export

  function exportState() {
    if (!configuration || !Number.isInteger(controlSocket)) return null;
    return {
      version: 1,
      configuration: {
        mode: configuration.mode,
        port: configuration.port,
        username: configuration.username,
        credential: configuration.credential,
        realm: configuration.realm,
        nonce: configuration.nonce,
        key: byteKey(configuration.key),
        mappingProbeServers: configuration.mappingProbeDefinitions.map((entry) => entry.uri),
        mappingProbeTimeoutMs: configuration.mappingProbeTimeoutMs,
        mappingProbeRetries: configuration.mappingProbeRetries,
        triggerLength: configuration.triggerLength,
        delayMs: configuration.delayMs,
        preludePackets: configuration.preludePackets.map((packet) => Array.from(packet)),
      },
      controlPort: socketRecords.get(controlSocket)?.port ?? null,
      allocations: Array.from(allocations.values(), (target) => ({
        id: target.id,
        client: { address: target.client.address, port: target.client.port },
        relaySocketId: target.upstream,
        relayAddress: target.advertisedRelay ? target.advertisedRelay.address : null,
        relayPort: target.advertisedRelay ? target.advertisedRelay.port : null,
        permissions: Array.from(target.permissions.entries()),
        channels: Array.from(target.channels.entries(), ([channel, entry]) => [
          channel, entry.peer.address, entry.peer.port, entry.expiresAt,
        ]),
        peerChannels: Array.from(target.peerChannels.entries(), ([key, entry]) => [
          key, entry.channel, entry.expiresAt,
        ]),
        upstreamHasSent: target.upstreamHasSent,
        peerDatagramsQueued: target.peerDatagramsQueued,
        peerDatagramsReceived: target.peerDatagramsReceived,
        expiresAt: target.expiresAt,
      })),
    };
  }

  function importState(snapshot) {
    if (!snapshot || snapshot.version !== 1 || !snapshot.configuration) {
      throw new Error("route-state-invalid");
    }
    const source = snapshot.configuration;
    if (!Array.isArray(snapshot.allocations) || snapshot.allocations.length > MAX_ALLOCATIONS) {
      throw new Error("route-state-invalid");
    }
    const keyBytes = Uint8Array.from(
      String(source.key || "").match(/.{1,2}/gu) || [],
      (pair) => Number.parseInt(pair, 16),
    );
    if (keyBytes.length !== 16) throw new Error("route-state-invalid");
    configuration = {
      mode: source.mode === "remote-mapped" ? "remote-mapped" : "local-test",
      port: Number.isInteger(source.port) ? source.port : 0,
      username: String(source.username || ""),
      credential: String(source.credential || ""),
      realm: String(source.realm || DEFAULT_REALM),
      nonce: String(source.nonce || ""),
      key: keyBytes,
      mappingProbeDefinitions: (Array.isArray(source.mappingProbeServers)
        ? source.mappingProbeServers
        : []).map((value) => mappingPolicy.parseStunUri(value)),
      mappingProbeTimeoutMs: Number.isInteger(source.mappingProbeTimeoutMs)
        ? source.mappingProbeTimeoutMs
        : 1800,
      mappingProbeRetries: Number.isInteger(source.mappingProbeRetries)
        ? source.mappingProbeRetries
        : 2,
      triggerLength: Number.isInteger(source.triggerLength) ? source.triggerLength : 0,
      delayMs: Number.isInteger(source.delayMs) ? source.delayMs : 50,
      preludePackets: (Array.isArray(source.preludePackets) ? source.preludePackets : [[0], [1]])
        .map((packet) => Uint8Array.from(packet)),
    };
    for (const entry of snapshot.allocations) {
      if (!entry || typeof entry.id !== "string" || !entry.client) {
        throw new Error("route-state-invalid");
      }
      const target = {
        id: entry.id,
        client: { address: entry.client.address, port: entry.client.port },
        upstream: null,
        expiresAt: Number.isInteger(entry.expiresAt) ? entry.expiresAt : Date.now() + 60000,
        expiryTimer: null,
        delayTimer: null,
        delaying: false,
        upstreamHasSent: entry.upstreamHasSent === true,
        queue: [],
        permissions: new Map(Array.isArray(entry.permissions) ? entry.permissions : []),
        channels: new Map(),
        peerChannels: new Map(Array.isArray(entry.peerChannels) ? entry.peerChannels : []),
        peerDatagramsQueued: Number.isInteger(entry.peerDatagramsQueued)
          ? entry.peerDatagramsQueued
          : 0,
        peerDatagramsReceived: Number.isInteger(entry.peerDatagramsReceived)
          ? entry.peerDatagramsReceived
          : 0,
        closed: false,
        advertisedRelay: entry.relayAddress && Number.isInteger(entry.relayPort)
          ? { address: entry.relayAddress, port: entry.relayPort }
          : null,
        mapping: {
          state: entry.relayAddress ? "ready" : "probing",
          observations: new Map(),
          transactions: new Map(),
          answered: new Set(),
          expectedObservations: configuration.mappingProbeDefinitions.length,
          pendingAllocates: new Map(),
          timers: [],
        },
      };
      for (const [channel, address, port, expiresAt] of (entry.channels || [])) {
        target.channels.set(channel, { peer: { address, port }, expiresAt });
      }
      allocations.set(endpointKey(target.client), target);
      allocationsById.set(target.id, target);
      scheduleAllocationExpiry(target);
    }
    return true;
  }

  // ----------------------------------------------------------------- public

  async function start(options = {}) {
    const generation = ++lifecycleGeneration;
    return enqueueLifecycle(async () => {
      try {
        assertLifecycleGeneration(generation);
        await stopServer();
        assertLifecycleGeneration(generation);
        resetStats();
        configuration = normalizeConfiguration(options);
        const socketId = await createSocket(CONTROL_SOCKET_NAME);
        trackSocket(socketId, "control", null);
        try {
          await bindSocket(socketId, LOOPBACK_ADDRESS, configuration.port === 0 ? 0 : configuration.port);
        } catch (error) {
          socketRecords.delete(socketId);
          await closeSocket(socketId);
          throw error;
        }
        const port = await refreshSocketPort(socketId);
        if (!Number.isInteger(port) || port < 1) {
          socketRecords.delete(socketId);
          await closeSocket(socketId);
          throw new Error("listener-address-invalid");
        }
        controlSocket = socketId;
      } catch (error) {
        const name = String(error && error.name || "Error");
        const message = String(error && error.message || error);
        stats.lastError = `${name}: ${message}`;
        await stopServer();
        return { ...statusSnapshot(), __apiError: stats.lastError };
      }
      return {
        ...statusSnapshot(),
        turnUrl: `turn:${LOOPBACK_ADDRESS}:${socketRecords.get(controlSocket).port}?transport=udp`,
        username: configuration.username,
        credential: configuration.credential,
      };
    });
  }

  async function restore(snapshot) {
    const generation = ++lifecycleGeneration;
    return enqueueLifecycle(async () => {
      try {
        assertLifecycleGeneration(generation);
        await stopServer();
        resetStats();
        const sockets = await listSockets();
        const byName = new Map(sockets.map((socket) => [socket.name, socket]));
        const control = byName.get(CONTROL_SOCKET_NAME);
        if (!control) throw new Error("control-socket-missing");
        importState(snapshot);
        trackSocket(control.socketId, "control", null);
        controlSocket = control.socketId;
        const port = await refreshSocketPort(control.socketId);
        if (!Number.isInteger(port) || port < 1) {
          throw new Error("listener-address-invalid");
        }
        // Relay sockets are matched by name so a new socket id after a
        // browser restart cannot attach the wrong socket to an allocation.
        for (const target of Array.from(allocations.values())) {
          const relay = byName.get(`${RELAY_SOCKET_PREFIX}${target.id}`);
          if (!relay) {
            closeAllocation(target);
            continue;
          }
          target.upstream = relay.socketId;
          trackSocket(relay.socketId, "relay", target.id);
          await refreshSocketPort(relay.socketId);
        }
        return { restored: true, ...statusSnapshot() };
      } catch (error) {
        stats.lastError = String(error && error.message || error);
        await stopServer();
        return { restored: false, reason: stats.lastError, ...statusSnapshot() };
      }
    });
  }

  function status() {
    return Promise.resolve(statusSnapshot());
  }

  function stop() {
    lifecycleGeneration += 1;
    return enqueueLifecycle(() => stopServer());
  }

  function isRunning() {
    return Boolean(controlSocket);
  }

  return Object.freeze({
    start,
    status,
    stop,
    restore,
    exportState,
    importState,
    isRunning,
    handleUdpReceive,
    handleUdpReceiveError,
    CONTROL_SOCKET_NAME,
    RELAY_SOCKET_PREFIX,
  });
});
