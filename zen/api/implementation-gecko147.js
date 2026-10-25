"use strict";

const {
  setTimeout: scheduleTimeout,
  clearTimeout: cancelTimeout,
} = ChromeUtils.importESModule("resource://gre/modules/Timer.sys.mjs");

const LOOPBACK_PREF = "media.peerconnection.ice.loopback";
const LOOPBACK_SNAPSHOT_PREF = "extensions.discord-direct.loopback-pref-snapshot";
const SOFTWARE = "Zen Discord direct loopback TURN PoC";
const DEFAULT_REALM = "discord-direct.local";
const DEFAULT_LIFETIME = 600;
const PERMISSION_LIFETIME_MS = 300_000;
const CHANNEL_LIFETIME_MS = 600_000;
const MAX_ALLOCATIONS = 8;
const MAX_PEER_IPS = 4;
const MAX_PEER_ENDPOINTS = 32;
const SOCKET_CLOSE_RETRY_MS = 100;
const SOCKET_CLOSE_TIMEOUT_MS = 2_000;
const MAPPING_FAILURE_COOLDOWN_MS = 5_000;
const MAX_MAPPING_FAILURE_COOLDOWNS = 32;
const DNS_LOOKUP_TIMEOUT_MS = 5_000;

let codec = null;
let mappingPolicy = null;
let controlSocket = null;
const allocations = new Map();
const failedMappingClients = new Map();
// Keep every native socket independently reachable until Gecko confirms that
// its asynchronous close completed.  Allocation bookkeeping is deliberately
// not the owner of a socket: shutdown can otherwise lose the only usable
// reference after deleting an allocation but before the socket thread handles
// nsIUDPSocket.close().
const socketRecords = new Map();
let configuration = null;
let preferenceSnapshot = null;
let stopping = false;
let stopPromise = null;
let lifecycleGeneration = 0;
let lifecycleQueue = Promise.resolve();
const dnsOperations = new Set();

function systemPrincipal() {
  // Resolve this lazily so an API-initialization failure can be reported to
  // the extension instead of being hidden by the ExperimentAPI bridge.
  return Services.scriptSecurityManager.getSystemPrincipal();
}

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
  socketStopNotifications: 0,
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

function ensureLibraries(extension) {
  if (codec && mappingPolicy) return;
  const scope = {};
  if (!codec) {
    Services.scriptloader.loadSubScriptWithOptions(
      extension.rootURI.resolve("lib/turn-codec.js"),
      {
        target: scope,
        allowUnsafeURL: true,
      }
    );
    codec = scope.TurnCodec;
  }
  if (!mappingPolicy) {
    Services.scriptloader.loadSubScriptWithOptions(
      extension.rootURI.resolve("lib/mapping-policy.js"),
      {
        target: scope,
        allowUnsafeURL: true,
      }
    );
    mappingPolicy = scope.MappingPolicy;
  }
  if (!codec || !mappingPolicy) throw new Error("TURN support libraries did not load");
}

function randomNonce() {
  try {
    const bytes = new Uint8Array(18);
    crypto.getRandomValues(bytes);
    return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  } catch (_error) {
    return Services.uuid.generateUUID().toString().replace(/[{}-]/gu, "");
  }
}

function normalizeConfiguration(input) {
  const options = input && typeof input === "object" ? input : {};
  const mode = options.mode === undefined ? "local-test" : String(options.mode);
  if (mode !== "local-test" && mode !== "remote-mapped") {
    throw new Error("mode must be local-test or remote-mapped");
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

  const hasAdvertisedRelayAddress = options.advertisedRelayAddress != null;
  const advertisedRelayAddress = String(
    hasAdvertisedRelayAddress ? options.advertisedRelayAddress : "127.0.0.1"
  );
  if (!/^\d{1,3}(?:\.\d{1,3}){3}$/u.test(advertisedRelayAddress) ||
      advertisedRelayAddress.split(".").some((part) => Number(part) > 255)) {
    throw new Error("advertisedRelayAddress must be an IPv4 literal");
  }
  if (mode === "remote-mapped" && hasAdvertisedRelayAddress) {
    throw new Error("remote-mapped mode discovers the relay address; do not set advertisedRelayAddress");
  }

  const mappingProbeTimeoutMs = Number.isInteger(options.mappingProbeTimeoutMs)
    ? options.mappingProbeTimeoutMs
    : 1_800;
  const mappingProbeRetries = Number.isInteger(options.mappingProbeRetries)
    ? options.mappingProbeRetries
    : 2;
  if (mappingProbeTimeoutMs < 500 || mappingProbeTimeoutMs > 10_000) {
    throw new Error("mappingProbeTimeoutMs must be between 500 and 10000");
  }
  if (mappingProbeRetries < 0 || mappingProbeRetries > 4) {
    throw new Error("mappingProbeRetries must be between 0 and 4");
  }
  const rawProbeServers = options.mappingProbeServers === undefined
    ? []
    : options.mappingProbeServers;
  if (!Array.isArray(rawProbeServers) || rawProbeServers.length > 8) {
    throw new Error("mappingProbeServers must contain at most eight STUN URIs");
  }
  const mappingProbeDefinitions = rawProbeServers.map((value) =>
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

  const allowPrivatePeers = options.allowPrivatePeers === true;
  if (mode === "remote-mapped" && allowPrivatePeers) {
    throw new Error("remote-mapped mode cannot allow private peer addresses");
  }

  return {
    mode,
    port,
    username,
    credential,
    realm,
    advertisedRelayAddress,
    mappingProbeDefinitions,
    mappingProbeEndpoints: [],
    mappingProbeTimeoutMs,
    mappingProbeRetries,
    triggerLength,
    delayMs,
    preludePackets,
    allowPrivatePeers,
    nonce: randomNonce(),
    key: codec.longTermKey(username, realm, credential),
  };
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

function cancelDnsOperations() {
  for (const operation of Array.from(dnsOperations)) operation.cancel();
}

function beginIPv4Lookup(host, port, generation = lifecycleGeneration, allowPrivate = false) {
  const dns = Cc["@mozilla.org/network/dns-service;1"]
    .getService(Ci.nsIDNSService);
  const flags = Ci.nsIDNSService.RESOLVE_DISABLE_IPV6 |
    Ci.nsIDNSService.RESOLVE_BYPASS_CACHE;
  let request = null;
  let timer = null;
  let settled = false;
  let resolvePromise;
  let rejectPromise;
  const operation = {
    cancel() {
      if (settled) return;
      try {
        if (request) request.cancel(Cr.NS_BINDING_ABORTED);
      } catch (_error) {}
      finish(false, new Error("DNS lookup cancelled"));
    },
  };
  const finish = (ok, value) => {
    if (settled) return;
    settled = true;
    if (timer !== null) cancelTimeout(timer);
    dnsOperations.delete(operation);
    if (ok) resolvePromise(value);
    else rejectPromise(value);
  };
  dnsOperations.add(operation);
  const promise = new Promise((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
    const listener = {
      QueryInterface: ChromeUtils.generateQI(["nsIDNSListener"]),
      onLookupComplete(_request, record, status) {
        try {
          assertLifecycleGeneration(generation);
          if (!Components.isSuccessCode(status) || !record) {
            throw new Error("IPv4 endpoint did not resolve");
          }
          const endpoints = [];
          const addressRecord = record.QueryInterface(Ci.nsIDNSAddrRecord);
          while (addressRecord.hasMore()) {
            const netAddr = addressRecord.getScriptableNextAddr(port);
            const address = netAddr.address;
            if ((allowPrivate || codec.isPublicIPv4(address)) &&
                !endpoints.some((endpoint) => endpoint.address === address)) {
              endpoints.push({ address, port, netAddr });
            }
          }
          if (endpoints.length === 0) {
            throw new Error("Endpoint has no public IPv4 address");
          }
          finish(true, endpoints);
        } catch (error) {
          finish(false, error);
        }
      },
    };
    try {
      request = dns.asyncResolve(
        host,
        Ci.nsIDNSService.RESOLVE_TYPE_DEFAULT,
        flags,
        null,
        listener,
        Services.tm.currentThread,
        {}
      );
    } catch (error) {
      finish(false, error);
    }
  });
  if (!settled) {
    timer = scheduleTimeout(() => {
      try {
        if (request) request.cancel(Cr.NS_ERROR_NET_TIMEOUT);
      } catch (_error) {}
      finish(false, new Error("DNS lookup timed out"));
    }, DNS_LOOKUP_TIMEOUT_MS);
  }
  return { promise, cancel: operation.cancel };
}

async function resolveProbeDefinition(definition, generation) {
  if (definition.isIpv4Literal && !codec.isPublicIPv4(definition.host)) {
    throw new Error("STUN probe addresses must be public IPv4");
  }
  const lookup = beginIPv4Lookup(definition.host, definition.port, generation);
  const endpoints = await lookup.promise;
  if (!definition.isIpv4Literal) return endpoints;
  const exact = endpoints.filter((endpoint) => endpoint.address === definition.host);
  if (exact.length === 0) throw new Error("STUN probe literal did not resolve exactly");
  return exact;
}

async function resolveMappingProbeEndpoints(definitions, generation) {
  const addressSets = await Promise.all(definitions.map((definition) =>
    resolveProbeDefinition(definition, generation)));

  // Seed the selection with a pair from different configured servers and
  // different public IP addresses. This avoids mistaking two UDP ports on one
  // NAT destination for evidence of endpoint-independent mapping.
  let seed = null;
  for (let left = 0; left < addressSets.length && !seed; left += 1) {
    for (let right = left + 1; right < addressSets.length && !seed; right += 1) {
      for (const leftEndpoint of addressSets[left]) {
        const rightEndpoint = addressSets[right].find((endpoint) =>
          endpoint.address !== leftEndpoint.address);
        if (rightEndpoint) {
          seed = [
            { definitionIndex: left, endpoint: leftEndpoint },
            { definitionIndex: right, endpoint: rightEndpoint },
          ];
          break;
        }
      }
    }
  }
  if (!seed) {
    throw new Error("STUN probes must resolve to at least two distinct public IPv4 addresses");
  }

  const selectedIndexes = new Set(seed.map((item) => item.definitionIndex));
  const selectedAddresses = new Set(seed.map((item) => item.endpoint.address));
  const endpoints = seed.map((item) => item.endpoint);
  for (let index = 0; index < definitions.length; index += 1) {
    if (selectedIndexes.has(index)) continue;
    const endpoint = addressSets[index].find((candidate) =>
      !selectedAddresses.has(candidate.address));
    if (!endpoint) continue;
    selectedAddresses.add(endpoint.address);
    endpoints.push(endpoint);
  }
  return endpoints;
}

function readLoopbackPreferenceSnapshot() {
  if (!Services.prefs.prefHasUserValue(LOOPBACK_SNAPSHOT_PREF)) return null;
  const snapshot = JSON.parse(Services.prefs.getStringPref(LOOPBACK_SNAPSHOT_PREF));
  if (!snapshot || snapshot.version !== 1 ||
      typeof snapshot.hadUserValue !== "boolean" || typeof snapshot.value !== "boolean") {
    throw new Error("Discord Direct loopback preference baseline is invalid");
  }
  return snapshot;
}

function captureAndEnableLoopbackPreference() {
  if (!preferenceSnapshot) {
    const snapshot = readLoopbackPreferenceSnapshot() || {
      version: 1,
      hadUserValue: Services.prefs.prefHasUserValue(LOOPBACK_PREF),
      value: Services.prefs.getBoolPref(LOOPBACK_PREF, false),
    };
    Services.prefs.setStringPref(LOOPBACK_SNAPSHOT_PREF, JSON.stringify(snapshot));
    // Retain the original baseline alongside any later save of the forced value.
    Services.prefs.savePrefFile(null);
    preferenceSnapshot = snapshot;
  }
  Services.prefs.setBoolPref(LOOPBACK_PREF, true);
}

function restoreLoopbackPreference(preserveSnapshot = false) {
  // A restarted add-on may be disabled before start() captures the baseline.
  if (!preferenceSnapshot) preferenceSnapshot = readLoopbackPreferenceSnapshot();
  if (!preferenceSnapshot) return;
  if (preferenceSnapshot.hadUserValue) {
    Services.prefs.setBoolPref(LOOPBACK_PREF, preferenceSnapshot.value);
  } else if (Services.prefs.prefHasUserValue(LOOPBACK_PREF)) {
    Services.prefs.clearUserPref(LOOPBACK_PREF);
  }
  if (!preserveSnapshot) {
    Services.prefs.clearUserPref(LOOPBACK_SNAPSHOT_PREF);
    Services.prefs.savePrefFile(null);
  }
  preferenceSnapshot = null;
}

function endpointFromMessage(message) {
  return {
    address: message.fromAddr.address,
    port: message.fromAddr.port,
    netAddr: message.fromAddr,
  };
}

function endpointKey(endpoint) {
  return `${endpoint.address}:${endpoint.port}`;
}

function sameEndpoint(left, right) {
  return Boolean(left && right && left.address === right.address && left.port === right.port);
}

function rawMessageBytes(message) {
  return codec.asBytes(message.rawData).slice();
}

function sendDatagram(socket, endpoint, bytes) {
  if (!endpoint || !endpoint.netAddr) {
    throw new Error("UDP destination was not pre-resolved");
  }
  const data = Array.from(codec.asBytes(bytes));
  // sendWithAddr avoids nsIUDPSocket.send()'s independent asynchronous DNS
  // job for every datagram. Gecko dispatches these writes to one serial STS
  // queue, preserving prelude/original order for this socket.
  const written = socket.sendWithAddr(endpoint.netAddr, data);
  if (written !== data.length) throw new Error("UDP datagram was not accepted in full");
  return written;
}

function trackSocket(socket, role) {
  const record = {
    socket,
    role,
    port: null,
    closeRequested: false,
    closeAttempts: 0,
  };
  try {
    record.port = socket.port;
  } catch (_error) {}
  socketRecords.set(socket, record);
  return socket;
}

function noteSocketStopped(socket) {
  if (!socketRecords.has(socket)) return;
  socketRecords.delete(socket);
  stats.socketStopNotifications += 1;
}

function requestSocketClose(socket) {
  if (!socket) return;
  const record = socketRecords.get(socket);
  if (record) {
    if (!record.closeRequested) stats.socketCloseRequests += 1;
    record.closeRequested = true;
    record.closeAttempts += 1;
  }
  try {
    // nsIUDPSocket.close() is asynchronous once asyncListen() is active.
    // Reissuing it while waiting is harmless and protects against a close
    // event being dropped during add-on reload.
    socket.close();
  } catch (error) {
    if (record) {
      stats.lastError = `UDP ${record.role} close failed: ${String(error && error.stack || error)}`;
    }
  }
}

function requestAllSocketCloses() {
  for (const { socket } of Array.from(socketRecords.values())) {
    requestSocketClose(socket);
  }
}

function waitForSocketCloses(timeoutMs = SOCKET_CLOSE_TIMEOUT_MS) {
  if (socketRecords.size === 0) return Promise.resolve(true);
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve) => {
    const check = () => {
      if (socketRecords.size === 0) {
        resolve(true);
        return;
      }
      requestAllSocketCloses();
      if (Date.now() >= deadline) {
        stats.cleanupTimeouts += 1;
        const pending = Array.from(socketRecords.values(), (record) =>
          `${record.role}:${record.port === null ? "unknown" : record.port}`);
        stats.lastError = `Timed out closing UDP sockets: ${pending.join(", ")}`;
        resolve(false);
        return;
      }
      scheduleTimeout(check, SOCKET_CLOSE_RETRY_MS);
    };
    check();
  });
}

function responseAttributes(message, attributes) {
  return attributes || [];
}

function sendStun(endpoint, method, messageClass, transactionId, attributes, key = null) {
  if (!controlSocket) return;
  const bytes = codec.encodeMessage({
    method,
    class: messageClass,
    transactionId,
    attributes: responseAttributes(null, attributes),
    key,
  });
  sendDatagram(controlSocket, endpoint, bytes);
  stats.clientDatagramsQueued += 1;
}

function sendError(endpoint, request, code, reason, { challenge = false, key = null } = {}) {
  const attributes = [codec.attribute(codec.ATTR.ERROR_CODE, codec.encodeError(code, reason))];
  if (challenge) {
    attributes.push(codec.textAttribute(codec.ATTR.REALM, configuration.realm));
    attributes.push(codec.textAttribute(codec.ATTR.NONCE, configuration.nonce));
    stats.authChallenges += 1;
  }
  sendStun(endpoint, request.method, codec.CLASS.ERROR, request.transactionId, attributes, key);
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
  cancelTimeout(target.expiryTimer);
  const remaining = Math.max(0, target.expiresAt - Date.now());
  target.expiryTimer = scheduleTimeout(() => {
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
  if (target.expiryTimer !== null) cancelTimeout(target.expiryTimer);
  if (target.delayTimer !== null) cancelTimeout(target.delayTimer);
  if (target.mapping) {
    for (const timer of target.mapping.timers) cancelTimeout(timer);
    target.mapping.timers.length = 0;
    target.mapping.transactions.clear();
    target.mapping.pendingAllocates.clear();
  }
  for (const resolution of target.endpointResolutions.values()) resolution.cancel();
  target.endpointResolutions.clear();
  target.expiryTimer = null;
  target.delayTimer = null;
  target.delaying = false;
  target.queue.length = 0;
  const upstream = target.upstream;
  target.upstream = null;
  requestSocketClose(upstream);
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
  return configuration.allowPrivatePeers || codec.isPublicIPv4(address);
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
  if (stopping || target.closed || !target.upstream ||
      allocations.get(endpointKey(target.client)) !== target) return;
  sendDatagram(target.upstream, peer, data);
  target.peerDatagramsQueued += 1;
  stats.peerDatagramsQueued += 1;
}

function drainPeerQueue(target) {
  if (allocations.get(endpointKey(target.client)) !== target || target.delaying || target.queue.length === 0) return;
  if (!target.queue[0].ready) return;
  const item = target.queue.shift();
  if (!target.upstreamHasSent) {
    target.upstreamHasSent = true;
    if (configuration.triggerLength === 0 || item.data.length === configuration.triggerLength) {
      for (const packet of configuration.preludePackets) {
        sendPeerNow(target, item.peer, packet);
        stats.preludePacketsQueued += 1;
      }
      stats.preludeActivations += 1;
      target.delaying = true;
      target.delayTimer = scheduleTimeout(() => {
        target.delaying = false;
        target.delayTimer = null;
        try {
          sendPeerNow(target, item.peer, item.data);
          drainPeerQueue(target);
        } catch (error) {
          stats.lastError = String(error && error.stack || error);
          closeAllocation(target);
        }
      }, configuration.delayMs);
      return;
    }
  }
  sendPeerNow(target, item.peer, item.data);
  drainPeerQueue(target);
}

function resolvePeerEndpoint(target, peer) {
  if (peer.netAddr) return Promise.resolve(peer);
  const key = endpointKey(peer);
  const existing = target.endpointResolutions.get(key);
  if (existing) return existing.promise;
  if (target.endpointResolutions.size >= MAX_PEER_ENDPOINTS) {
    return Promise.reject(new Error("Peer endpoint resolution limit reached"));
  }
  const lookup = beginIPv4Lookup(
    peer.address,
    peer.port,
    lifecycleGeneration,
    configuration.allowPrivatePeers
  );
  const entry = {
    cancel: lookup.cancel,
    promise: lookup.promise.then((endpoints) => {
      const exact = endpoints.find((endpoint) => endpoint.address === peer.address);
      if (!exact) throw new Error("Peer endpoint did not resolve exactly");
      return exact;
    }),
  };
  target.endpointResolutions.set(key, entry);
  return entry.promise;
}

function queuePeerDatagram(target, peer, data) {
  if (target.queue.length >= 256) throw new Error("TURN upstream queue limit reached");
  const item = {
    peer,
    data: codec.asBytes(data).slice(),
    ready: Boolean(peer.netAddr),
  };
  target.queue.push(item);
  if (!item.ready) {
    resolvePeerEndpoint(target, peer).then((resolved) => {
      if (target.closed) return;
      item.peer = resolved;
      item.ready = true;
      drainPeerQueue(target);
    }).catch((error) => {
      if (target.closed) return;
      stats.lastError = String(error && error.stack || error);
      closeAllocation(target);
    });
  }
  drainPeerQueue(target);
}

// encodeAddress needs the same transaction ID as the Data indication. Keep the
// creation in one helper so it cannot accidentally use a different XOR mask.
function sendDataIndication(target, peer, data) {
  const transactionId = randomTransactionId();
  sendStun(target.client, codec.METHOD.DATA, codec.CLASS.INDICATION, transactionId, [
    codec.attribute(codec.ATTR.XOR_PEER_ADDRESS,
      codec.encodeAddress(peer.address, peer.port, transactionId)),
    codec.attribute(codec.ATTR.DATA, data),
  ]);
}

function randomTransactionId() {
  const value = new Uint8Array(12);
  try {
    crypto.getRandomValues(value);
  } catch (_error) {
    const fallback = randomNonce();
    for (let index = 0; index < value.length; index += 1) {
      value[index] = Number.parseInt(fallback.slice(index * 2, index * 2 + 2), 16);
    }
  }
  return value;
}

function byteKey(value) {
  return Array.from(codec.asBytes(value), (byte) =>
    byte.toString(16).padStart(2, "0")).join("");
}

function clearMappingTimers(target) {
  if (!target.mapping) return;
  for (const timer of target.mapping.timers) cancelTimeout(timer);
  target.mapping.timers.length = 0;
  target.mapping.transactions.clear();
}

function sendAllocateSuccess(target, endpoint, request, key) {
  if (!target.advertisedRelay) {
    throw new Error("Refusing Allocate success without a verified relay address");
  }
  sendStun(endpoint, request.method, codec.CLASS.SUCCESS, request.transactionId, [
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
    try {
      sendError(pending.endpoint, pending.request, 508, "Mapping Check Failed", {
        key: pending.key,
      });
    } catch (error) {
      stats.lastError = String(error && error.stack || error);
    }
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
    try {
      sendAllocateSuccess(target, pending.endpoint, pending.request, pending.key);
    } catch (error) {
      stats.lastError = String(error && error.stack || error);
    }
  }
  target.mapping.pendingAllocates.clear();
}

function evaluateMappingProbe(target) {
  const observations = Array.from(target.mapping.observations.values());
  const verdict = mappingPolicy.evaluateMappings(observations, codec.isPublicIPv4);
  if (verdict.ok) {
    // If the caller supplied extra independent probes, consider all of their
    // timely evidence instead of succeeding on the first agreeing pair.
    if (observations.length === configuration.mappingProbeEndpoints.length) {
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
  if (!target.mapping || target.mapping.state !== "probing" || target.closed || !target.upstream) {
    return;
  }
  for (const server of configuration.mappingProbeEndpoints) {
    if (target.mapping.observations.has(endpointKey(server))) continue;
    const transactionId = randomTransactionId();
    target.mapping.transactions.set(byteKey(transactionId), server);
    const request = codec.encodeMessage({
      method: codec.METHOD.BINDING,
      class: codec.CLASS.REQUEST,
      transactionId,
      attributes: [],
    });
    sendDatagram(target.upstream, server, request);
    stats.mappingProbeRequestsQueued += 1;
  }
}

function startMappingProbe(target, initialPending) {
  target.mapping = {
    state: "probing",
    observations: new Map(),
    transactions: new Map(),
    pendingAllocates: new Map([[
      byteKey(initialPending.request.transactionId),
      initialPending,
    ]]),
    timers: [],
  };
  sendMappingProbeRound(target);
  const rounds = configuration.mappingProbeRetries + 1;
  for (let retry = 1; retry <= configuration.mappingProbeRetries; retry += 1) {
    target.mapping.timers.push(scheduleTimeout(
      () => sendMappingProbeRound(target),
      Math.floor(configuration.mappingProbeTimeoutMs * retry / rounds)
    ));
  }
  target.mapping.timers.push(scheduleTimeout(() => {
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
}

function handleMappingProbePacket(target, peer, data) {
  if (!target.mapping || target.mapping.state !== "probing" || data.length < 20 ||
      (data[0] & 0xc0) !== 0) {
    return false;
  }
  let response;
  try {
    response = codec.decodeMessage(data);
  } catch (_error) {
    return false;
  }
  const server = target.mapping.transactions.get(byteKey(response.transactionId));
  if (!server) return false;
  // A transaction ID alone is not authority: responses must come from the
  // exact public address and port that received the probe.
  if (!sameEndpoint(server, peer)) return true;
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
  } catch (_error) {
    failMappingProbe(target, "invalid-xor-mapped-address");
    return true;
  }
  if (!codec.isPublicIPv4(mapped.address) || mapped.port < 1 || mapped.port > 65535) {
    failMappingProbe(target, "invalid-public-endpoint");
    return true;
  }
  const serverKey = endpointKey(server);
  if (!target.mapping.observations.has(serverKey)) {
    target.mapping.observations.set(serverKey, {
      serverAddress: server.address,
      serverPort: server.port,
      mappedAddress: mapped.address,
      mappedPort: mapped.port,
    });
    stats.mappingProbeResponses += 1;
  }
  evaluateMappingProbe(target);
  return true;
}

function createUpstreamSocket(target) {
  const socket = Cc["@mozilla.org/network/udp-socket;1"].createInstance(Ci.nsIUDPSocket);
  try {
    // Keep the relay socket IPv4 so the address family used for mapping
    // discovery is exactly the one later used for Discord peer traffic.
    socket.init2("0.0.0.0", -1, systemPrincipal(), false);
    trackSocket(socket, "relay");
    socket.asyncListen({
      QueryInterface: ChromeUtils.generateQI(["nsIUDPSocketListener"]),
      onPacketReceived(_socket, message) {
        if (stopping || target.closed || target.upstream !== _socket ||
            allocations.get(endpointKey(target.client)) !== target) {
          stats.stalePacketsIgnored += 1;
          return;
        }
        try {
          const peer = endpointFromMessage(message);
          const data = rawMessageBytes(message);
          if (handleMappingProbePacket(target, peer, data)) return;
          if (!permissionAllowed(target, peer.address)) return;
          target.peerDatagramsReceived += 1;
          stats.peerDatagramsReceived += 1;
          const channelEntry = target.peerChannels.get(endpointKey(peer));
          if (channelEntry && channelEntry.expiresAt > Date.now()) {
            sendDatagram(controlSocket, target.client, codec.encodeChannelData(channelEntry.channel, data));
            stats.clientDatagramsQueued += 1;
          } else {
            if (channelEntry) target.peerChannels.delete(endpointKey(peer));
            sendDataIndication(target, peer, data);
          }
        } catch (error) {
          stats.lastError = String(error && error.stack || error);
        }
      },
      onStopListening(_socket, status) {
        noteSocketStopped(_socket);
        if (!target.closed && allocations.get(endpointKey(target.client)) === target &&
            status !== Cr.NS_BINDING_ABORTED) {
          stats.lastError = `Upstream UDP listener stopped: 0x${(Number(status) >>> 0).toString(16)}`;
          closeAllocation(target);
        }
      },
    });
    return socket;
  } catch (error) {
    requestSocketClose(socket);
    noteSocketStopped(socket);
    throw error;
  }
}

function handleBinding(endpoint, request) {
  sendStun(endpoint, request.method, codec.CLASS.SUCCESS, request.transactionId, [
    codec.attribute(codec.ATTR.XOR_MAPPED_ADDRESS,
      codec.encodeAddress(endpoint.address, endpoint.port, request.transactionId)),
    codec.textAttribute(codec.ATTR.SOFTWARE, SOFTWARE),
  ]);
}

function handleAllocate(endpoint, request, key) {
  const transport = codec.getAttribute(request, codec.ATTR.REQUESTED_TRANSPORT);
  if (!transport || transport.value.length !== 4 || transport.value[0] !== 17) {
    sendError(endpoint, request, 442, "Unsupported Transport Protocol", { key });
    return;
  }
  const clientKey = endpointKey(endpoint);
  const recentFailure = failedMappingClients.get(clientKey);
  if (recentFailure) {
    if (recentFailure.until > Date.now()) {
      sendError(endpoint, request, 508, "Mapping Check Failed", { key });
      return;
    }
    failedMappingClients.delete(clientKey);
  }
  let target = allocations.get(clientKey);
  if (!target && allocations.size >= MAX_ALLOCATIONS) {
    stats.allocationQuotaRejections += 1;
    sendError(endpoint, request, 486, "Allocation Quota Reached", { key });
    return;
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
      endpointResolutions: new Map(),
      permissions: new Map(),
      channels: new Map(),
      peerChannels: new Map(),
      peerDatagramsQueued: 0,
      peerDatagramsReceived: 0,
      closed: false,
      advertisedRelay: null,
      mapping: null,
    };
    target.upstream = createUpstreamSocket(target);
    allocations.set(clientKey, target);
    scheduleAllocationExpiry(target);
    stats.allocationsCreated += 1;
    if (configuration.mode === "remote-mapped") {
      try {
        startMappingProbe(target, { endpoint, request, key });
      } catch (error) {
        stats.lastError = String(error && error.stack || error);
        if (!target.mapping) {
          target.mapping = {
            state: "probing",
            observations: new Map(),
            transactions: new Map(),
            pendingAllocates: new Map([[
              byteKey(request.transactionId),
              { endpoint, request, key },
            ]]),
            timers: [],
          };
        }
        failMappingProbe(target, "probe-send-failed");
      }
      return;
    }
    target.advertisedRelay = {
      address: configuration.advertisedRelayAddress,
      port: target.upstream.port,
    };
  } else if (target.mapping && target.mapping.state === "probing") {
    target.mapping.pendingAllocates.set(byteKey(request.transactionId), {
      endpoint,
      request,
      key,
    });
    return;
  }
  sendAllocateSuccess(target, endpoint, request, key);
}

function requestedLifetime(request) {
  const lifetime = codec.getAttribute(request, codec.ATTR.LIFETIME);
  return lifetime && lifetime.value.length === 4
    ? Math.min(DEFAULT_LIFETIME, codec.read32(lifetime.value, 0))
    : DEFAULT_LIFETIME;
}

function handleRefresh(endpoint, request, key) {
  const target = allocationFor(endpoint, request, key);
  if (!target) return;
  const lifetime = requestedLifetime(request);
  if (lifetime === 0) {
    sendStun(endpoint, request.method, codec.CLASS.SUCCESS, request.transactionId, [
      codec.attribute(codec.ATTR.LIFETIME, codec.uint32(0)),
    ], key);
    closeAllocation(target);
    return;
  }
  target.expiresAt = Date.now() + lifetime * 1000;
  scheduleAllocationExpiry(target);
  sendStun(endpoint, request.method, codec.CLASS.SUCCESS, request.transactionId, [
    codec.attribute(codec.ATTR.LIFETIME, codec.uint32(lifetime)),
  ], key);
}

function decodePeerAttributes(request) {
  return codec.getAttributes(request, codec.ATTR.XOR_PEER_ADDRESS)
    .map((entry) => codec.decodeAddress(entry.value, request.transactionId));
}

function handleCreatePermission(endpoint, request, key) {
  const target = allocationFor(endpoint, request, key);
  if (!target) return;
  let peers;
  try {
    peers = decodePeerAttributes(request);
  } catch (_error) {
    sendError(endpoint, request, 400, "Bad Request", { key });
    return;
  }
  if (peers.length === 0) {
    sendError(endpoint, request, 400, "Bad Request", { key });
    return;
  }
  if (peers.some((peer) => !peerAddressAllowed(peer.address))) {
    stats.peerPolicyRejections += 1;
    sendError(endpoint, request, 403, "Forbidden", { key });
    return;
  }
  if (!canAddPeerAddresses(target, peers)) {
    stats.peerPolicyRejections += 1;
    sendError(endpoint, request, 508, "Insufficient Capacity", { key });
    return;
  }
  for (const peer of peers) target.permissions.set(peer.address, Date.now() + PERMISSION_LIFETIME_MS);
  stats.permissionsCreated += peers.length;
  sendStun(endpoint, request.method, codec.CLASS.SUCCESS, request.transactionId, [], key);
}

function handleChannelBind(endpoint, request, key) {
  const target = allocationFor(endpoint, request, key);
  if (!target) return;
  const channelAttribute = codec.getAttribute(request, codec.ATTR.CHANNEL_NUMBER);
  const peerAttribute = codec.getAttribute(request, codec.ATTR.XOR_PEER_ADDRESS);
  if (!channelAttribute || channelAttribute.value.length < 2 || !peerAttribute) {
    sendError(endpoint, request, 400, "Bad Request", { key });
    return;
  }
  const channel = codec.read16(channelAttribute.value, 0);
  let peer;
  try {
    peer = codec.decodeAddress(peerAttribute.value, request.transactionId);
  } catch (_error) {
    sendError(endpoint, request, 400, "Bad Request", { key });
    return;
  }
  if (channel < 0x4000 || channel > 0x7fff) {
    sendError(endpoint, request, 400, "Bad Request", { key });
    return;
  }
  if (!peerAddressAllowed(peer.address)) {
    stats.peerPolicyRejections += 1;
    sendError(endpoint, request, 403, "Forbidden", { key });
    return;
  }
  if (!canAddPeerAddresses(target, [peer])) {
    stats.peerPolicyRejections += 1;
    sendError(endpoint, request, 508, "Insufficient Capacity", { key });
    return;
  }
  const previousChannel = target.channels.get(channel);
  const previousPeer = target.peerChannels.get(endpointKey(peer));
  if ((previousChannel && endpointKey(previousChannel.peer) !== endpointKey(peer)) ||
      (previousPeer && previousPeer.channel !== channel)) {
    sendError(endpoint, request, 400, "Bad Request", { key });
    return;
  }
  const expiresAt = Date.now() + CHANNEL_LIFETIME_MS;
  target.permissions.set(peer.address, Date.now() + PERMISSION_LIFETIME_MS);
  target.channels.set(channel, { peer, expiresAt });
  target.peerChannels.set(endpointKey(peer), { channel, expiresAt });
  stats.channelsBound += 1;
  sendStun(endpoint, request.method, codec.CLASS.SUCCESS, request.transactionId, [], key);
}

function handleSendIndication(endpoint, request) {
  const target = allocations.get(endpointKey(endpoint));
  if (!target) return;
  const peerAttribute = codec.getAttribute(request, codec.ATTR.XOR_PEER_ADDRESS);
  const dataAttribute = codec.getAttribute(request, codec.ATTR.DATA);
  if (!peerAttribute || !dataAttribute) return;
  try {
    const peer = codec.decodeAddress(peerAttribute.value, request.transactionId);
    if (!permissionAllowed(target, peer.address)) return;
    queuePeerDatagram(target, peer, dataAttribute.value);
  } catch (error) {
    stats.lastError = String(error && error.stack || error);
  }
}

function handleChannelData(endpoint, bytes) {
  const target = allocations.get(endpointKey(endpoint));
  if (!target) return;
  const frame = codec.decodeChannelData(bytes);
  const channelEntry = target.channels.get(frame.channel);
  if (!channelEntry || channelEntry.expiresAt <= Date.now() ||
      !permissionAllowed(target, channelEntry.peer.address)) {
    return;
  }
  queuePeerDatagram(target, channelEntry.peer, frame.data);
}

function handleStun(endpoint, bytes) {
  const request = codec.decodeMessage(bytes);
  stats.requests += 1;
  if (request.class === codec.CLASS.INDICATION && request.method === codec.METHOD.SEND) {
    handleSendIndication(endpoint, request);
    return;
  }
  if (request.class !== codec.CLASS.REQUEST) return;
  if (request.method === codec.METHOD.BINDING) {
    handleBinding(endpoint, request);
    return;
  }
  const key = authenticate(endpoint, request);
  if (!key) return;
  switch (request.method) {
    case codec.METHOD.ALLOCATE:
      handleAllocate(endpoint, request, key);
      break;
    case codec.METHOD.REFRESH:
      handleRefresh(endpoint, request, key);
      break;
    case codec.METHOD.CREATE_PERMISSION:
      handleCreatePermission(endpoint, request, key);
      break;
    case codec.METHOD.CHANNEL_BIND:
      handleChannelBind(endpoint, request, key);
      break;
    default:
      sendError(endpoint, request, 400, "Bad Request", { key });
      break;
  }
}

function handleClientPacket(socket, message) {
  if (stopping || controlSocket !== socket || !configuration) {
    stats.stalePacketsIgnored += 1;
    return;
  }
  const endpoint = endpointFromMessage(message);
  const bytes = rawMessageBytes(message);
  try {
    if ((bytes[0] & 0xc0) === 0x40) {
      handleChannelData(endpoint, bytes);
    } else {
      handleStun(endpoint, bytes);
    }
  } catch (error) {
    stats.lastError = String(error && error.stack || error);
  }
}

function stopServer({ restorePreference = true, preservePreferenceSnapshot = false } = {}) {
  if (stopPromise) {
    // Shutdown still owns preference cleanup when socket cleanup is in flight.
    if (restorePreference) restoreLoopbackPreference(preservePreferenceSnapshot);
    return stopPromise;
  }
  stopping = true;
  cancelDnsOperations();
  // Detach the control socket first so queued packets cannot create a fresh
  // allocation after the allocation sweep starts.
  const activeControlSocket = controlSocket;
  controlSocket = null;
  requestSocketClose(activeControlSocket);
  for (const target of Array.from(allocations.values())) closeAllocation(target);
  allocations.clear();
  failedMappingClients.clear();
  requestAllSocketCloses();
  configuration = null;
  if (restorePreference) restoreLoopbackPreference(preservePreferenceSnapshot);

  stopPromise = waitForSocketCloses().finally(() => {
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
    address: controlSocket ? "127.0.0.1" : null,
    port: controlSocket ? controlSocket.port : null,
    allocationCount: allocations.size,
    openSocketCount: socketRecords.size,
    pendingSocketClosures: Array.from(socketRecords.values(), (record) => ({
      role: record.role,
      port: record.port,
      closeRequested: record.closeRequested,
      closeAttempts: record.closeAttempts,
    })),
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
    loopbackPreference: Services.prefs.getBoolPref(LOOPBACK_PREF, false),
    stats: { ...stats },
  };
}

// Firefox matches this exported class name to the key under
// manifest.json's `experiment_apis`, not to the public API namespace from
// schema.json. Keep it in sync with `loopbackTurnCompat147` in the manifest.
this.loopbackTurnCompat147 = class extends ExtensionAPI {
  getAPI() {
    const extension = this.extension;
    return {
      experiments: {
        loopbackTurn: {
          async start(options = {}) {
            const generation = ++lifecycleGeneration;
            cancelDnsOperations();
            return enqueueLifecycle(async () => {
              try {
                assertLifecycleGeneration(generation);
                if (!await stopServer()) {
                  throw new Error("Previous UDP sockets did not close; refusing to start another listener");
                }
                assertLifecycleGeneration(generation);
                resetStats();
                ensureLibraries(extension);
                configuration = normalizeConfiguration(options);
                if (configuration.mode === "remote-mapped") {
                  configuration.mappingProbeEndpoints = await resolveMappingProbeEndpoints(
                    configuration.mappingProbeDefinitions,
                    generation
                  );
                  assertLifecycleGeneration(generation);
                }
                captureAndEnableLoopbackPreference();
                const socket = Cc["@mozilla.org/network/udp-socket;1"]
                  .createInstance(Ci.nsIUDPSocket);
                socket.init2(
                  "127.0.0.1",
                  configuration.port === 0 ? -1 : configuration.port,
                  systemPrincipal(),
                  false
                );
                trackSocket(socket, "control");
                controlSocket = socket;
                socket.asyncListen({
                  QueryInterface: ChromeUtils.generateQI(["nsIUDPSocketListener"]),
                  onPacketReceived(_socket, message) {
                    handleClientPacket(_socket, message);
                  },
                  onStopListening(_socket, status) {
                    noteSocketStopped(_socket);
                    if (controlSocket === _socket) controlSocket = null;
                    if (!stopping && status !== Cr.NS_BINDING_ABORTED) {
                      stats.lastError = `TURN listener stopped: 0x${(Number(status) >>> 0).toString(16)}`;
                      // Do not leave the testing-only global preference enabled
                      // after an unexpected listener failure.
                      lifecycleGeneration += 1;
                      cancelDnsOperations();
                      enqueueLifecycle(() => stopServer());
                    }
                  },
                });
              } catch (error) {
                const name = String(error && error.name || "Error");
                const message = String(error && error.message || error);
                const stack = String(error && error.stack || "");
                stats.lastError = `${name}: ${message}${stack ? `\n${stack}` : ""}`;
                await stopServer();
                return {
                  ...statusSnapshot(),
                  __apiError: stats.lastError,
                };
              }
              return {
                ...statusSnapshot(),
                turnUrl: `turn:127.0.0.1:${controlSocket.port}?transport=udp`,
                username: configuration.username,
                credential: configuration.credential,
              };
            });
          },
          async status() {
            return statusSnapshot();
          },
          async stop() {
            lifecycleGeneration += 1;
            cancelDnsOperations();
            return enqueueLifecycle(async () => {
              await stopServer();
              return statusSnapshot();
            });
          },
        },
      },
    };
  }

  onShutdown(isAppShutdown) {
    // stopServer initiates every native close synchronously before its first
    // await, so this remains effective even though ExperimentAPI shutdown does
    // not await returned promises.
    lifecycleGeneration += 1;
    cancelDnsOperations();
    // prefs.js may have been saved already. Retain the journal for next startup;
    // normal stop, disable, and uninstall restore and clear it.
    stopServer({ preservePreferenceSnapshot: Boolean(isAppShutdown) });
  }
};
