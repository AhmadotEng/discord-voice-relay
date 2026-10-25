(function installDiscordDirectPageHook() {
  "use strict";

  const CHANNEL = "discord-direct-zen:v1";
  const GATE_TIMEOUT_MS = 5000;
  const MAX_TRACKED_CONNECTIONS = 32;
  const tools = globalThis.__discordDirectTools;
  const NativePeerConnection = globalThis.RTCPeerConnection;

  if (!tools || typeof NativePeerConnection !== "function" || globalThis.__discordDirectInstalled) {
    return;
  }

  const nativeSetConfiguration = NativePeerConnection.prototype.setConfiguration;
  const nativeGetConfiguration = NativePeerConnection.prototype.getConfiguration;
  const nativeCreateOffer = NativePeerConnection.prototype.createOffer;
  const nativeCreateAnswer = NativePeerConnection.prototype.createAnswer;
  const nativeSetLocalDescription = NativePeerConnection.prototype.setLocalDescription;
  const nativeSetRemoteDescription = NativePeerConnection.prototype.setRemoteDescription;
  const nativeClose = NativePeerConnection.prototype.close;
  const connections = new Map();
  const connectionByPeer = new WeakMap();
  const routeWaiters = new Set();
  const hookBrand = Symbol("discord-direct-hook");
  const hookToken = Object.freeze({});
  const tokenBytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(tokenBytes);
  const documentToken = Array.from(tokenBytes, (byte) =>
    byte.toString(16).padStart(2, "0")
  ).join("");
  const pageOrigin = globalThis.location.origin;
  let routeState = null;
  let currentBridgeInstanceId = null;
  let highestGeneration = -1;
  let highestRouteResponseSequence = 0;
  let nextRouteRequestId = 0;
  let nextConnectionId = 0;
  let currentConnectionId = 0;
  let WrappedPeerConnection = null;
  const observations = {
    observedConnections: 0,
    targetedAttempts: 0,
    ignoredNoArgumentConnections: 0,
    promotableConnections: 0,
    unmatchedConfiguredConnections: 0,
    closedUnverifiedConnections: 0,
  };
  let lastStatus = {
    phase: "hook-ready",
    bootId: null,
    targetedConnections: 0,
    currentConnectionId: 0,
    generation: 0,
    routeRevision: 0,
    applied: false,
    verified: false,
    reconnectRequired: false,
    iceConnectionState: "new",
    connectionState: "new",
    selectedCandidate: null,
    errorCode: null,
    ...observations,
  };

  function extensionError(code, name = "InvalidStateError") {
    const messages = {
      "route-timeout": "Discord Direct was not ready before voice negotiation.",
      "route-unavailable": "Discord Direct could not establish its protected route.",
      "route-too-late": "Discord voice must reconnect before the protected route can be applied.",
      "hook-replaced": "Discord changed the voice hook. Reload Discord before reconnecting voice.",
      "reload-required": "Reload Discord to finish replacing the previous voice extension.",
      "connection-limit": "Too many Discord voice connections are already being tracked.",
    };
    const error = new DOMException(messages[code] || messages["route-unavailable"], name);
    Object.defineProperty(error, "__discordDirectCode", { value: code });
    return error;
  }

  function publish(patch = {}, statusRequestId = null) {
    lastStatus = {
      ...lastStatus,
      ...patch,
      targetedConnections: connections.size,
      currentConnectionId,
      ...observations,
    };
    globalThis.postMessage({
      channel: CHANNEL,
      direction: "page-to-extension",
      token: documentToken,
      type: "status",
      status: lastStatus,
      ...(currentBridgeInstanceId ? { bridgeInstanceId: currentBridgeInstanceId } : {}),
      ...(Number.isSafeInteger(statusRequestId) && statusRequestId > 0
        ? { statusRequestId }
        : {}),
    }, pageOrigin);
  }

  function publishFor(connection, patch = {}) {
    if (!connection || connection.closed) return;
    connection.lastStatus = { ...(connection.lastStatus || {}), ...patch };
    if (connection.id === currentConnectionId) publish(connection.lastStatus);
  }

  function requestRoute(requestId = null) {
    const message = {
      channel: CHANNEL,
      direction: "page-to-extension",
      token: documentToken,
      type: "route-request",
    };
    if (Number.isSafeInteger(requestId) && requestId > 0) message.requestId = requestId;
    globalThis.postMessage(message, pageOrigin);
  }

  function canInstallRoute(peerConnection) {
    if (peerConnection.localDescription != null || peerConnection.iceGatheringState !== "new") {
      return false;
    }
    const offererState = peerConnection.remoteDescription == null &&
      peerConnection.signalingState === "stable";
    const answererState = peerConnection.remoteDescription != null &&
      peerConnection.remoteDescription.type === "offer" &&
      peerConnection.signalingState === "have-remote-offer";
    return offererState || answererState;
  }

  function hookStillProtectsNewConnections() {
    try {
      return Boolean(globalThis.RTCPeerConnection &&
        globalThis.RTCPeerConnection[hookBrand] === hookToken);
    } catch (_error) {
      return false;
    }
  }

  function currentConfiguration(peerConnection) {
    const value = nativeGetConfiguration.call(peerConnection);
    return value && typeof value === "object" ? value : {};
  }

  function connectionIsCurrentlyConnected(peerConnection) {
    return peerConnection.connectionState === "connected" &&
      (peerConnection.iceConnectionState === "connected" ||
       peerConnection.iceConnectionState === "completed");
  }

  function connectionHasTerminalFailure(connection) {
    return Boolean(connection && (connection.blocked || connection.failureTerminal ||
      connection.terminalErrorCode));
  }

  function reconcileCurrentNativeState() {
    const connection = connections.get(currentConnectionId);
    if (!connection || connection.closed) return false;
    const peerConnection = connection.peerConnection;
    const connectionState = peerConnection.connectionState;
    const iceConnectionState = peerConnection.iceConnectionState;

    if (connectionState === "closed" || iceConnectionState === "closed") {
      // The native close event may still be queued. Retire the connection now
      // so a popup status poll cannot expose its cached green result.
      unregisterConnection(connection);
      return true;
    }

    const nativeFailed = connectionState === "failed" || iceConnectionState === "failed";
    if (nativeFailed && !connectionHasTerminalFailure(connection)) {
      connection.diagnosticSequence += 1;
      connection.failureTerminal = true;
      connection.terminalErrorCode = connectionState === "failed"
        ? "peer-connection-failed"
        : "ice-connection-failed";
      connection.verified = false;
      connection.selectedCandidate = null;
      publishFor(connection, {
        phase: "reconnect-required",
        iceConnectionState,
        connectionState,
        verified: false,
        reconnectRequired: true,
        selectedCandidate: null,
        errorCode: connection.terminalErrorCode,
      });
      return true;
    }

    if (!connectionHasTerminalFailure(connection) &&
        !connectionIsCurrentlyConnected(peerConnection) &&
        (connection.verified || connection.selectedCandidate ||
         (connection.lastStatus && connection.lastStatus.verified))) {
      connection.diagnosticSequence += 1;
      connection.verified = false;
      connection.selectedCandidate = null;
      publishFor(connection, {
        phase: iceConnectionState === "disconnected" ? "ice-state" : "connection-state",
        iceConnectionState,
        connectionState,
        verified: false,
        reconnectRequired: false,
        selectedCandidate: null,
        errorCode: null,
      });
      return true;
    }
    return false;
  }

  function waitForFreshRouteDecision(connection) {
    const requestId = ++nextRouteRequestId;
    return new Promise((resolve, reject) => {
      let settled = false;
      const waiter = {
        connection,
        requestId,
        freshSeen: false,
        bootId: null,
        minimumGeneration: 0,
        directAuthorizedGeneration: null,
        fail(error) {
          if (settled) return;
          settled = true;
          globalThis.clearTimeout(timer);
          routeWaiters.delete(waiter);
          reject(error || extensionError("route-unavailable"));
        },
        observe(nextRoute, responseRequestId, responseRoute, responseAccepted, responseOk) {
          if (settled) return;
          if (responseRequestId === requestId) {
            if (!responseOk || !responseAccepted || !responseRoute || !responseRoute.bootId) {
              waiter.fail(extensionError("route-unavailable"));
              return;
            }
            waiter.freshSeen = true;
            waiter.bootId = responseRoute.bootId;
            waiter.minimumGeneration = responseRoute.generation;
            if (responseAccepted && responseRoute && !responseRoute.enabled &&
                responseRoute.userDisabled && responseRoute.phase === "off") {
              waiter.directAuthorizedGeneration = responseRoute.generation;
            }
          }
          if (!waiter.freshSeen || !nextRoute) return;
          if (nextRoute.bootId !== waiter.bootId) {
            waiter.fail(extensionError("route-unavailable"));
            return;
          }
          if (nextRoute.generation < waiter.minimumGeneration) return;
          const directDecision = !nextRoute.enabled && nextRoute.userDisabled &&
            nextRoute.phase === "off" &&
            waiter.directAuthorizedGeneration === nextRoute.generation;
          const decision = nextRoute.ready || directDecision ||
            nextRoute.phase === "error" ||
            (nextRoute.phase === "off" && nextRoute.enabled);
          if (!decision) return;
          settled = true;
          globalThis.clearTimeout(timer);
          routeWaiters.delete(waiter);
          resolve(nextRoute);
        },
      };
      const timer = globalThis.setTimeout(() => {
        if (settled) return;
        settled = true;
        routeWaiters.delete(waiter);
        reject(extensionError("route-timeout"));
      }, GATE_TIMEOUT_MS);
      routeWaiters.add(waiter);
      requestRoute(requestId);
    });
  }

  function mergeCallerConfiguration(peerConnection, requested) {
    const base = currentConfiguration(peerConnection);
    if (requested === undefined) return base;
    if (!requested || typeof requested !== "object") {
      // Let object spread and the native call follow normal WebIDL failure behavior.
      return { ...base, ...requested };
    }
    return { ...base, ...requested };
  }

  function blockConnection(connection, code, error) {
    connection.diagnosticSequence += 1;
    connection.blocked = true;
    connection.terminalErrorCode = code;
    connection.verified = false;
    publishFor(connection, {
      phase: code === "reload-required"
        ? "reload-required"
        : code === "route-too-late" ? "reconnect-required" : "route-blocked",
      bootId: connection.bootId || (routeState ? routeState.bootId : null),
      generation: connection.generation || (routeState ? routeState.generation : 0),
      routeRevision: connection.routeRevision || (routeState ? routeState.routeRevision : 0),
      applied: false,
      verified: false,
      reconnectRequired: true,
      selectedCandidate: null,
      errorCode: code,
    });
    return error || extensionError(code);
  }

  function invalidateForHookReplacement() {
    const error = extensionError("hook-replaced");
    for (const connection of connections.values()) {
      if (connection.closed) continue;
      connection.diagnosticSequence += 1;
      connection.blocked = true;
      connection.terminalErrorCode = "hook-replaced";
      connection.verified = false;
      connection.selectedCandidate = null;
      connection.lastStatus = {
        ...(connection.lastStatus || {}),
        phase: "reload-required",
        applied: false,
        verified: false,
        reconnectRequired: true,
        selectedCandidate: null,
        errorCode: "hook-replaced",
      };
    }
    for (const waiter of [...routeWaiters]) waiter.fail(error);
    publish({
      phase: "reload-required",
      applied: false,
      verified: false,
      reconnectRequired: true,
      selectedCandidate: null,
      errorCode: "hook-replaced",
    });
    return error;
  }

  function prepareNegotiation(connection) {
    if (connection.commitPromise) return connection.commitPromise;
    connection.commitPromise = Promise.resolve()
      .then(() => {
        if (connectionHasTerminalFailure(connection)) {
          throw extensionError(connection.terminalErrorCode || "route-unavailable");
        }
        if (connection.closed || connectionByPeer.get(connection.peerConnection) !== connection) {
          throw extensionError("route-unavailable");
        }
        if (!hookStillProtectsNewConnections()) throw invalidateForHookReplacement();
        if (!canInstallRoute(connection.peerConnection)) throw extensionError("route-too-late");
        return waitForFreshRouteDecision(connection);
      })
      .then((decision) => {
        if (connectionHasTerminalFailure(connection)) {
          throw extensionError(connection.terminalErrorCode || "route-unavailable");
        }
        if (connection.closed || connectionByPeer.get(connection.peerConnection) !== connection) {
          throw extensionError("route-unavailable");
        }
        if (!hookStillProtectsNewConnections()) throw invalidateForHookReplacement();
        if (!canInstallRoute(connection.peerConnection)) throw extensionError("route-too-late");
        if (!decision.enabled) {
          if (!decision.userDisabled) throw extensionError("route-unavailable");
          const direct = tools.directConfiguration(
            currentConfiguration(connection.peerConnection),
            connection.desiredConfiguration
          );
          nativeSetConfiguration.call(connection.peerConnection, direct);
          connection.gateFinalized = true;
          connection.directReleased = true;
          connection.bootId = decision.bootId;
          connection.generation = decision.generation;
          connection.routeRevision = decision.routeRevision;
          publishFor(connection, {
            phase: "direct",
            bootId: decision.bootId,
            generation: decision.generation,
            routeRevision: decision.routeRevision,
            applied: false,
            verified: false,
            reconnectRequired: false,
            selectedCandidate: null,
            errorCode: null,
          });
          return;
        }
        if (!decision.ready) throw extensionError("route-unavailable");
        const enforced = tools.routeConfiguration(
          currentConfiguration(connection.peerConnection),
          decision
        );
        nativeSetConfiguration.call(connection.peerConnection, enforced);
        connection.gateFinalized = true;
        connection.applied = true;
        connection.bootId = decision.bootId;
        connection.generation = decision.generation;
        connection.routeRevision = decision.routeRevision;
        publishFor(connection, {
          phase: "route-applied",
          bootId: decision.bootId,
          generation: decision.generation,
          routeRevision: decision.routeRevision,
          applied: true,
          verified: false,
          reconnectRequired: false,
          selectedCandidate: null,
          errorCode: null,
        });
      })
      .catch((error) => {
        if (connectionHasTerminalFailure(connection)) {
          throw error;
        }
        const code = error && typeof error.__discordDirectCode === "string"
          ? error.__discordDirectCode
          : "route-unavailable";
        throw blockConnection(connection, code, error);
      });
    return connection.commitPromise;
  }

  function selectedCandidateFromReport(report) {
    const transportPairIds = new Set();
    const legacySelectedPairs = [];
    report.forEach((entry) => {
      if (entry.type === "transport" && entry.selectedCandidatePairId) {
        transportPairIds.add(entry.selectedCandidatePairId);
      }
      if (entry.type === "candidate-pair" && entry.selected === true) {
        legacySelectedPairs.push(entry);
      }
    });

    let selectedPair = null;
    if (transportPairIds.size > 0) {
      // The transport field is authoritative whenever Gecko supplies it. Any
      // ambiguity or dangling reference must fail closed rather than reviving
      // a stale legacy selected:true pair.
      if (transportPairIds.size !== 1) return null;
      selectedPair = report.get([...transportPairIds][0]);
      if (!selectedPair || selectedPair.type !== "candidate-pair") return null;
    } else if (legacySelectedPairs.length === 1) {
      // Older Gecko reports may omit transport.selectedCandidatePairId. The
      // legacy selected flag is usable only when it is unambiguous.
      selectedPair = legacySelectedPairs[0];
    }
    if (!selectedPair) return null;
    return report.get(selectedPair.localCandidateId) || null;
  }

  async function reportSelectedCandidate(connection) {
    if (!connection || connection.closed || connectionHasTerminalFailure(connection)) return;
    const peerConnection = connection.peerConnection;
    const expectedBootId = connection.bootId;
    const expectedGeneration = connection.generation;
    const expectedRouteRevision = routeState ? routeState.routeRevision : connection.routeRevision;
    const diagnosticSequence = ++connection.diagnosticSequence;
    try {
      const report = await peerConnection.getStats();
      if (connection.closed || connectionHasTerminalFailure(connection) ||
          diagnosticSequence !== connection.diagnosticSequence ||
          !routeState || !routeState.ready ||
          routeState.bootId !== expectedBootId ||
          routeState.generation !== expectedGeneration ||
          routeState.routeRevision !== expectedRouteRevision ||
          connection.generation !== expectedGeneration ||
          !connectionIsCurrentlyConnected(peerConnection)) return;
      const local = selectedCandidateFromReport(report);
      if (!local) {
        connection.verified = false;
        connection.selectedCandidate = null;
        publishFor(connection, {
          phase: "diagnostic-error",
          verified: false,
          selectedCandidate: null,
          errorCode: "selected-pair-missing",
        });
        return;
      }

      const candidate = {
        type: ["host", "srflx", "prflx", "relay"].includes(local.candidateType)
          ? local.candidateType
          : "unknown",
        protocol: local.protocol === "udp" || local.protocol === "tcp" ? local.protocol : "unknown",
        relayProtocol: local.relayProtocol === "udp" || local.relayProtocol === "tcp"
          ? local.relayProtocol
          : null,
      };
      connection.selectedCandidate = candidate;
      // Firefox versions that predate complete relayProtocol stats may omit
      // that field. The extension configures exactly one UDP-only TURN URL, so
      // a relay candidate whose own protocol is UDP is equivalent evidence.
      const selectedRelayUdp = candidate.type === "relay" &&
        (candidate.relayProtocol === "udp" ||
         (candidate.relayProtocol === null && candidate.protocol === "udp"));
      const backendEvidence = routeState && connection.applied &&
        routeState.bootId === connection.bootId &&
        routeState.generation === connection.generation
        ? tools.backendTrafficEvidence(routeState, local, connection.allocationId)
        : null;
      if (backendEvidence && !connection.allocationId) {
        connection.allocationId = backendEvidence.allocationId;
      }
      const backendCurrent = Boolean(backendEvidence && backendEvidence.confirmed);
      connection.verified = Boolean(selectedRelayUdp && backendCurrent);
      if (connection.verified) connection.everVerified = true;
      connection.routeRevision = expectedRouteRevision;
      if (!selectedRelayUdp) {
        // A selected direct/TCP path is a terminal failure for this negotiated
        // call. It cannot become safe without creating a fresh PeerConnection.
        connection.failureTerminal = true;
        connection.terminalErrorCode = "selected-pair-not-relay-udp";
      }

      publishFor(connection, {
        phase: connection.verified
          ? "verified"
          : selectedRelayUdp ? "waiting-for-backend" : "unsafe-direct",
        generation: connection.generation,
        routeRevision: expectedRouteRevision,
        applied: connection.applied,
        verified: connection.verified,
        reconnectRequired: !selectedRelayUdp,
        selectedCandidate: candidate,
        errorCode: selectedRelayUdp ? null : "selected-pair-not-relay-udp",
      });
    } catch (_error) {
      if (connection.closed || connectionHasTerminalFailure(connection) ||
          diagnosticSequence !== connection.diagnosticSequence ||
          !routeState || !routeState.ready ||
          routeState.bootId !== expectedBootId ||
          routeState.generation !== expectedGeneration ||
          routeState.routeRevision !== expectedRouteRevision ||
          connection.generation !== expectedGeneration ||
          !connectionIsCurrentlyConnected(peerConnection)) return;
      connection.verified = false;
      connection.selectedCandidate = null;
      publishFor(connection, {
        phase: "diagnostic-error",
        verified: false,
        selectedCandidate: null,
        errorCode: "stats-unavailable",
      });
    }
  }

  function observeConnection(connection) {
    function finalizeCandidateGathering() {
      if (connection.closed || connectionHasTerminalFailure(connection) ||
          connection.relayCandidateObserved ||
          !connection.candidateErrorObserved ||
          connection.peerConnection.iceGatheringState !== "complete") return;
      connection.diagnosticSequence += 1;
      connection.failureTerminal = true;
      connection.terminalErrorCode = "ice-candidate-error";
      connection.verified = false;
      publishFor(connection, {
        phase: "route-blocked",
        verified: false,
        reconnectRequired: true,
        selectedCandidate: null,
        errorCode: "ice-candidate-error",
      });
    }

    const peerConnection = connection.peerConnection;
    peerConnection.addEventListener("icecandidate", (event) => {
      if (connection.closed || !event.candidate) return;
      const summary = tools.candidateSummary(event.candidate);
      if (summary) {
        const validRelay = summary.type === "relay" && summary.protocol === "udp";
        const recoversCandidateFailure = validRelay && !connection.blocked &&
          connection.failureTerminal && connection.terminalErrorCode === "ice-candidate-error";
        if (connectionHasTerminalFailure(connection) && !recoversCandidateFailure) return;
        connection.candidateObserved = true;
        if (validRelay) {
          connection.relayCandidateObserved = true;
          connection.candidateErrorObserved = false;
          if (recoversCandidateFailure) {
            connection.terminalErrorCode = null;
            connection.failureTerminal = false;
          }
        }
        publishFor(connection, {
          phase: "candidate",
          verified: false,
          reconnectRequired: false,
          selectedCandidate: null,
          errorCode: null,
        });
      }
    });
    peerConnection.addEventListener("icecandidateerror", () => {
      if (connection.closed || connectionHasTerminalFailure(connection)) return;
      connection.candidateErrorObserved = true;
      finalizeCandidateGathering();
    });
    peerConnection.addEventListener("icegatheringstatechange", () => {
      if (connection.closed || connectionHasTerminalFailure(connection)) return;
      finalizeCandidateGathering();
    });
    peerConnection.addEventListener("iceconnectionstatechange", () => {
      const state = peerConnection.iceConnectionState;
      if (state === "closed") {
        unregisterConnection(connection);
        return;
      }
      if (connectionHasTerminalFailure(connection)) return;
      if (state === "failed") {
        connection.diagnosticSequence += 1;
        connection.failureTerminal = true;
        connection.terminalErrorCode = "ice-connection-failed";
        connection.verified = false;
        connection.selectedCandidate = null;
        publishFor(connection, {
          phase: "reconnect-required",
          iceConnectionState: state,
          verified: false,
          reconnectRequired: true,
          selectedCandidate: null,
          errorCode: "ice-connection-failed",
        });
        return;
      }
      const connected = state === "connected" || state === "completed";
      // Every native state notification starts a fresh diagnostic epoch.
      // Never republish cached green while a new getStats() call is pending:
      // Firefox may deliver a duplicate connected/completed event and that
      // stats read can stall indefinitely.
      connection.diagnosticSequence += 1;
      connection.verified = false;
      connection.selectedCandidate = null;
      publishFor(connection, {
        phase: "ice-state",
        iceConnectionState: state,
        verified: false,
        reconnectRequired: false,
        selectedCandidate: null,
        errorCode: null,
      });
      if (connected) reportSelectedCandidate(connection);
      if (["failed", "disconnected", "closed"].includes(state)) {
        publishFor(connection, { verified: false, selectedCandidate: null });
      }
    });
    peerConnection.addEventListener("connectionstatechange", () => {
      const state = peerConnection.connectionState;
      if (state === "closed") {
        unregisterConnection(connection);
        return;
      }
      if (connectionHasTerminalFailure(connection)) return;
      if (state === "failed") {
        connection.diagnosticSequence += 1;
        connection.failureTerminal = true;
        connection.terminalErrorCode = "peer-connection-failed";
        connection.verified = false;
        connection.selectedCandidate = null;
        publishFor(connection, {
          phase: "reconnect-required",
          connectionState: state,
          verified: false,
          reconnectRequired: true,
          selectedCandidate: null,
          errorCode: "peer-connection-failed",
        });
        return;
      }
      const connected = state === "connected";
      // Clear cached proof synchronously before the asynchronous selected-pair
      // check. A duplicate connected event must not leave stale green visible
      // forever if getStats() never settles.
      connection.diagnosticSequence += 1;
      connection.verified = false;
      connection.selectedCandidate = null;
      publishFor(connection, {
        phase: "connection-state",
        connectionState: state,
        verified: false,
        reconnectRequired: false,
        selectedCandidate: null,
        errorCode: null,
      });
      if (connected) reportSelectedCandidate(connection);
    });
  }

  function unregisterConnection(connection) {
    if (!connection || connection.closed) return;
    const wasCurrent = currentConnectionId === connection.id;
    connection.closed = true;
    connection.diagnosticSequence += 1;
    for (const waiter of [...routeWaiters]) {
      if (waiter.connection === connection) {
        waiter.fail(extensionError("route-unavailable"));
      }
    }
    connections.delete(connection.id);
    connectionByPeer.delete(connection.peerConnection);

    const terminalFailure = connection.failureTerminal || connection.blocked ||
      Boolean(connection.terminalErrorCode);
    const cleanClose = !terminalFailure && (connection.everVerified || connection.directReleased);
    const closedBeforeVerification = connection.targeted && !connection.directReleased &&
      !connection.verified && !cleanClose;
    if (wasCurrent && (closedBeforeVerification || terminalFailure)) {
      observations.closedUnverifiedConnections += 1;
      let errorCode = connection.applied
        ? "closed-after-route-applied"
        : "closed-before-route-applied";
      if (connection.candidateObserved) errorCode = "closed-after-candidate";
      if (connection.selectedCandidate && connection.selectedCandidate.type === "relay") {
        errorCode = "closed-after-relay-selected";
      }
      if (connection.terminalErrorCode) errorCode = connection.terminalErrorCode;
      // Preserve the newest failed attempt instead of reviving an older
      // connection's green status. A later new connection becomes current.
      currentConnectionId = 0;
      publish({
        phase: errorCode === "reload-required" ? "reload-required" : "reconnect-required",
        bootId: connection.bootId || (routeState ? routeState.bootId : null),
        generation: connection.generation || (routeState ? routeState.generation : 0),
        applied: connection.applied,
        verified: false,
        reconnectRequired: true,
        selectedCandidate: connection.selectedCandidate,
        errorCode,
      });
      return;
    }

    if (!wasCurrent) {
      const current = connections.get(currentConnectionId);
      if (current) {
        publish(current.lastStatus || {});
      } else if (currentConnectionId === 0) {
        // Keep a sticky newest-failure result, but refresh its live count as
        // older fallback connections disappear.
        publish({});
      }
      return;
    }

    let fallback = null;
    while (!fallback) {
      const remaining = [...connections.values()].filter((entry) => !entry.closed);
      const candidate = remaining.length ? remaining.at(-1) : null;
      if (!candidate) break;
      const nativeClosed = candidate.peerConnection.connectionState === "closed" ||
        candidate.peerConnection.iceConnectionState === "closed";
      if (nativeClosed) {
        // A queued close event must not let a dead cached connection become
        // authoritative. Remove it silently while the prior current ID is
        // still unavailable, then examine the next fallback.
        unregisterConnection(candidate);
        continue;
      }
      fallback = candidate;
    }
    currentConnectionId = fallback ? fallback.id : 0;
    if (fallback) {
      const peerConnection = fallback.peerConnection;
      const nativeFailed = peerConnection.connectionState === "failed" ||
        peerConnection.iceConnectionState === "failed";
      if (nativeFailed && !connectionHasTerminalFailure(fallback)) {
        fallback.diagnosticSequence += 1;
        fallback.failureTerminal = true;
        fallback.terminalErrorCode = peerConnection.connectionState === "failed"
          ? "peer-connection-failed"
          : "ice-connection-failed";
        fallback.verified = false;
        fallback.selectedCandidate = null;
      }
      if (connectionHasTerminalFailure(fallback)) {
        publishFor(fallback, {
          phase: "reconnect-required",
          iceConnectionState: peerConnection.iceConnectionState,
          connectionState: peerConnection.connectionState,
          verified: false,
          reconnectRequired: true,
          selectedCandidate: null,
          errorCode: fallback.terminalErrorCode || "route-unavailable",
        });
        return;
      }
      if (!connectionIsCurrentlyConnected(peerConnection)) {
        fallback.diagnosticSequence += 1;
        fallback.verified = false;
        fallback.selectedCandidate = null;
        const phase = fallback.directReleased
          ? "direct"
          : peerConnection.iceConnectionState === "disconnected"
            ? "ice-state"
            : fallback.applied ? "connection-state" : "waiting-for-route";
        publishFor(fallback, {
          phase,
          iceConnectionState: peerConnection.iceConnectionState,
          connectionState: peerConnection.connectionState,
          verified: false,
          reconnectRequired: false,
          selectedCandidate: null,
          errorCode: null,
        });
        return;
      }
      // Becoming authoritative again requires a fresh selected-pair proof.
      // Never expose this connection's cached green while getStats() is
      // pending; the call may have changed paths while it was noncurrent.
      let boundBackendConfirmed = true;
      if (fallback.allocationId && routeState) {
        const boundEvidence = tools.boundBackendTrafficEvidence(
          routeState,
          fallback.allocationId
        );
        boundBackendConfirmed = Boolean(boundEvidence && boundEvidence.confirmed);
      }
      fallback.diagnosticSequence += 1;
      fallback.verified = false;
      fallback.selectedCandidate = null;
      publishFor(fallback, {
        phase: boundBackendConfirmed ? "connection-state" : "waiting-for-backend",
        bootId: fallback.bootId || (routeState ? routeState.bootId : null),
        generation: fallback.generation || (routeState ? routeState.generation : 0),
        routeRevision: routeState ? routeState.routeRevision : fallback.routeRevision,
        applied: fallback.applied,
        verified: false,
        reconnectRequired: false,
        selectedCandidate: null,
        errorCode: null,
      });
      reportSelectedCandidate(fallback);
      return;
    }

    publish({
      phase: "hook-ready",
      bootId: routeState ? routeState.bootId : null,
      generation: routeState ? routeState.generation : 0,
      routeRevision: routeState ? routeState.routeRevision : 0,
      applied: false,
      verified: false,
      reconnectRequired: false,
      selectedCandidate: null,
      errorCode: null,
    });
  }

  function promoteConnection(connection, signatureConfiguration) {
    if (connection.targeted) return;
    if (connection.negotiationObserved || !canInstallRoute(connection.peerConnection)) {
      throw extensionError("route-too-late");
    }
    if (connections.size >= MAX_TRACKED_CONNECTIONS) throw extensionError("connection-limit");
    connection.targeted = true;
    observations.targetedAttempts += 1;
    connection.id = ++nextConnectionId;
    connection.originalConfiguration = signatureConfiguration;
    connection.desiredConfiguration = signatureConfiguration;
    connections.set(connection.id, connection);
    currentConnectionId = connection.id;
    observeConnection(connection);
    publishFor(connection, {
      phase: "waiting-for-route",
      bootId: routeState ? routeState.bootId : null,
      generation: routeState ? routeState.generation : 0,
      routeRevision: routeState ? routeState.routeRevision : 0,
      applied: false,
      verified: false,
      reconnectRequired: false,
      selectedCandidate: null,
      errorCode: null,
    });
  }

  function terminalizePromotionFailure(connection, signatureConfiguration, code) {
    connection.targeted = true;
    connection.originalConfiguration = signatureConfiguration;
    connection.desiredConfiguration = signatureConfiguration;
    connection.diagnosticSequence += 1;
    connection.blocked = true;
    connection.terminalErrorCode = code;
    connection.verified = false;
    connection.selectedCandidate = null;
    observations.targetedAttempts += 1;

    if (connections.size < MAX_TRACKED_CONNECTIONS) {
      connection.id = ++nextConnectionId;
      connections.set(connection.id, connection);
      currentConnectionId = connection.id;
      observeConnection(connection);
      publishFor(connection, {
        phase: "reconnect-required",
        bootId: routeState ? routeState.bootId : null,
        generation: routeState ? routeState.generation : 0,
        routeRevision: routeState ? routeState.routeRevision : 0,
        applied: false,
        verified: false,
        reconnectRequired: true,
        selectedCandidate: null,
        errorCode: code,
      });
      return;
    }

    // Even when the tracking bound is full, keep the newest failure sticky so
    // an older verified connection cannot hide this direct/too-late attempt.
    currentConnectionId = 0;
    publish({
      phase: "reconnect-required",
      bootId: routeState ? routeState.bootId : null,
      generation: routeState ? routeState.generation : 0,
      applied: false,
      verified: false,
      reconnectRequired: true,
      selectedCandidate: null,
      errorCode: code,
    });
  }

  function patchConnection(peerConnection, originalConfiguration, targeted, promotable) {
    const originalCreateOffer = peerConnection.createOffer || nativeCreateOffer;
    const originalCreateAnswer = peerConnection.createAnswer || nativeCreateAnswer;
    const originalSetLocalDescription = peerConnection.setLocalDescription || nativeSetLocalDescription;
    const originalSetRemoteDescription = peerConnection.setRemoteDescription || nativeSetRemoteDescription;
    const originalSetConfiguration = peerConnection.setConfiguration || nativeSetConfiguration;
    const originalClose = peerConnection.close || nativeClose;
    const connection = {
      id: 0,
      peerConnection,
      originalConfiguration,
      desiredConfiguration: originalConfiguration,
      targeted: false,
      promotable,
      negotiationObserved: false,
      commitPromise: null,
      gateFinalized: false,
      directReleased: false,
      applied: false,
      blocked: false,
      closed: false,
      explicitlyClosed: false,
      bootId: null,
      generation: 0,
      routeRevision: 0,
      diagnosticSequence: 0,
      selectedCandidate: null,
      candidateObserved: false,
      relayCandidateObserved: false,
      candidateErrorObserved: false,
      verified: false,
      everVerified: false,
      failureTerminal: false,
      terminalErrorCode: null,
      lastStatus: null,
    };
    connectionByPeer.set(peerConnection, connection);
    if (targeted) promoteConnection(connection, originalConfiguration);

    Object.defineProperty(peerConnection, "createOffer", {
      configurable: true,
      writable: true,
      value(...argumentsList) {
        if (!connection.targeted) {
          connection.negotiationObserved = true;
          return Reflect.apply(originalCreateOffer, this, argumentsList);
        }
        if (connectionHasTerminalFailure(connection)) {
          return Promise.reject(extensionError(connection.terminalErrorCode || "route-unavailable"));
        }
        return prepareNegotiation(connection)
          .then(() => {
            if (connectionHasTerminalFailure(connection)) {
              throw extensionError(connection.terminalErrorCode || "route-unavailable");
            }
            if (connection.closed || connectionByPeer.get(connection.peerConnection) !== connection) {
              throw extensionError("route-unavailable");
            }
            return Reflect.apply(originalCreateOffer, this, argumentsList);
          });
      },
    });

    if (typeof originalCreateAnswer === "function") {
      Object.defineProperty(peerConnection, "createAnswer", {
        configurable: true,
        writable: true,
        value(...argumentsList) {
          if (!connection.targeted) {
            connection.negotiationObserved = true;
            return Reflect.apply(originalCreateAnswer, this, argumentsList);
          }
          if (connectionHasTerminalFailure(connection)) {
            return Promise.reject(extensionError(connection.terminalErrorCode || "route-unavailable"));
          }
          return prepareNegotiation(connection)
            .then(() => {
              if (connectionHasTerminalFailure(connection)) {
                throw extensionError(connection.terminalErrorCode || "route-unavailable");
              }
              if (connection.closed || connectionByPeer.get(connection.peerConnection) !== connection) {
                throw extensionError("route-unavailable");
              }
              return Reflect.apply(originalCreateAnswer, this, argumentsList);
            });
        },
      });
    }

    if (typeof originalSetLocalDescription === "function") {
      Object.defineProperty(peerConnection, "setLocalDescription", {
        configurable: true,
        writable: true,
        value(...argumentsList) {
          if (!connection.targeted) {
            connection.negotiationObserved = true;
            return Reflect.apply(originalSetLocalDescription, this, argumentsList);
          }
          if (connectionHasTerminalFailure(connection)) {
            return Promise.reject(extensionError(connection.terminalErrorCode || "route-unavailable"));
          }
          return prepareNegotiation(connection)
            .then(() => {
              if (connectionHasTerminalFailure(connection)) {
                throw extensionError(connection.terminalErrorCode || "route-unavailable");
              }
              if (connection.closed || connectionByPeer.get(connection.peerConnection) !== connection) {
                throw extensionError("route-unavailable");
              }
              return Reflect.apply(originalSetLocalDescription, this, argumentsList);
            });
        },
      });
    }

    if (typeof originalSetRemoteDescription === "function") {
      Object.defineProperty(peerConnection, "setRemoteDescription", {
        configurable: true,
        writable: true,
        value(...argumentsList) {
          if (!connection.targeted) {
            connection.negotiationObserved = true;
            return Reflect.apply(originalSetRemoteDescription, this, argumentsList);
          }
          if (connectionHasTerminalFailure(connection)) {
            return Promise.reject(extensionError(connection.terminalErrorCode || "route-unavailable"));
          }
          return prepareNegotiation(connection)
            .then(() => {
              if (connectionHasTerminalFailure(connection)) {
                throw extensionError(connection.terminalErrorCode || "route-unavailable");
              }
              if (connection.closed || connectionByPeer.get(connection.peerConnection) !== connection) {
                throw extensionError("route-unavailable");
              }
              return Reflect.apply(originalSetRemoteDescription, this, argumentsList);
            });
        },
      });
    }

    Object.defineProperty(peerConnection, "setConfiguration", {
      configurable: true,
      writable: true,
      value(nextConfiguration) {
        let voiceSignature;
        try {
          voiceSignature = tools.isDiscordVoiceConfiguration(nextConfiguration);
        } catch (error) {
          throw error;
        }
        if (!connection.targeted && connection.promotable && voiceSignature) {
          try {
            promoteConnection(connection, nextConfiguration);
          } catch (error) {
            const code = error && error.__discordDirectCode || "route-too-late";
            terminalizePromotionFailure(connection, nextConfiguration, code);
            throw error;
          }
        }
        if (!connection.targeted) {
          return Reflect.apply(originalSetConfiguration, this, [nextConfiguration]);
        }
        if (connectionHasTerminalFailure(connection)) {
          throw extensionError(connection.terminalErrorCode || "route-unavailable");
        }

        let merged;
        try {
          if (nextConfiguration && typeof nextConfiguration === "object") {
            connection.desiredConfiguration = {
              ...(connection.desiredConfiguration || {}),
              ...nextConfiguration,
            };
          }
          merged = mergeCallerConfiguration(peerConnection, nextConfiguration);
          if (connection.applied && routeState && routeState.ready &&
              routeState.bootId === connection.bootId &&
              routeState.generation === connection.generation) {
            merged = tools.routeConfiguration(merged, routeState);
          } else if (!connection.directReleased) {
            merged = tools.blockedConfiguration(merged);
          }
          const result = Reflect.apply(originalSetConfiguration, this, [merged]);
          publishFor(connection, {
            phase: connection.applied ? "route-applied" : "waiting-for-route",
            applied: connection.applied,
            verified: false,
            selectedCandidate: null,
            errorCode: null,
          });
          return result;
        } catch (error) {
          connection.diagnosticSequence += 1;
          connection.failureTerminal = true;
          connection.terminalErrorCode = "configuration-error";
          connection.verified = false;
          publishFor(connection, {
            phase: "configuration-error",
            verified: false,
            selectedCandidate: null,
            errorCode: "configuration-error",
          });
          throw error;
        }
      },
    });

    if (typeof originalClose === "function") {
      Object.defineProperty(peerConnection, "close", {
        configurable: true,
        writable: true,
        value(...argumentsList) {
          connection.explicitlyClosed = true;
          try {
            return Reflect.apply(originalClose, this, argumentsList);
          } finally {
            unregisterConnection(connection);
          }
        },
      });
    }
  }

  function acceptRoute(
    value,
    responseRequestId = null,
    responseOk = true,
    responseSequence = null
  ) {
    if (!value || typeof value !== "object" || !Number.isSafeInteger(value.generation) ||
        value.generation < 0) return;
    if (!Number.isSafeInteger(responseSequence) || responseSequence <= 0) return;
    const sequenceIsCurrent = responseSequence > highestRouteResponseSequence;
    if (sequenceIsCurrent) highestRouteResponseSequence = responseSequence;
    const normalized = tools.normalizeRouteState(value);
    const requestId = Number.isSafeInteger(responseRequestId) && responseRequestId > 0
      ? responseRequestId
      : null;
    const previousRoute = routeState;
    const sameBoot = Boolean(previousRoute && normalized.bootId &&
      normalized.bootId === previousRoute.bootId);
    const bootChanged = Boolean(previousRoute && normalized.bootId &&
      normalized.bootId !== previousRoute.bootId);
    let accepted = sequenceIsCurrent && Boolean(normalized.bootId) && (
      !previousRoute ||
      (sameBoot && (
        normalized.generation > highestGeneration ||
        (normalized.generation === highestGeneration &&
         normalized.routeRevision >= previousRoute.routeRevision)
      )) ||
      bootChanged
    );
    if (accepted && sameBoot && normalized.generation === highestGeneration && previousRoute) {
      if (routeState.ready && !normalized.ready) accepted = false;
      if (routeState.phase === "error" && normalized.phase !== "error") accepted = false;
    }
    if (accepted) {
      if (bootChanged) highestGeneration = -1;
      highestGeneration = normalized.generation;
      routeState = normalized;
    }

    const responseUsable = accepted || Boolean(
      responseOk !== false && routeState && normalized.bootId &&
      normalized.bootId === routeState.bootId &&
      normalized.generation <= routeState.generation
    );
    for (const waiter of [...routeWaiters]) {
      waiter.observe(
        routeState,
        requestId,
        responseUsable ? routeState : normalized,
        responseUsable,
        responseOk !== false
      );
    }
    if (!accepted) return;
    for (const connection of connections.values()) {
      if (connection.closed || connectionHasTerminalFailure(connection)) continue;
      const routeIdentityChanged = connection.applied && (
        connection.bootId !== routeState.bootId ||
        connection.generation !== routeState.generation
      );
      if (routeIdentityChanged) {
        connection.diagnosticSequence += 1;
        connection.blocked = true;
        connection.terminalErrorCode = connection.bootId !== routeState.bootId
          ? "backend-session-changed"
          : "backend-generation-changed";
        connection.verified = false;
        connection.selectedCandidate = null;
        publishFor(connection, {
          phase: "reconnect-required",
          bootId: connection.bootId,
          generation: connection.generation,
          routeRevision: connection.routeRevision,
          verified: false,
          reconnectRequired: true,
          selectedCandidate: null,
          errorCode: connection.terminalErrorCode,
        });
        continue;
      }
      if (connection.directReleased && routeState.enabled) {
        connection.diagnosticSequence += 1;
        connection.blocked = true;
        connection.terminalErrorCode = "route-enabled-after-offer";
        publishFor(connection, {
          phase: "reconnect-required",
          bootId: connection.bootId,
          generation: connection.generation,
          routeRevision: connection.routeRevision,
          verified: false,
          reconnectRequired: true,
          selectedCandidate: null,
          errorCode: "route-enabled-after-offer",
        });
        continue;
      }
      if (connection.applied && routeState.bootId === connection.bootId &&
          routeState.generation === connection.generation) {
        const connected = connectionIsCurrentlyConnected(connection.peerConnection);
        if (!routeState.ready) {
          connection.diagnosticSequence += 1;
          connection.blocked = true;
          connection.terminalErrorCode = "backend-not-ready";
          connection.verified = false;
          connection.selectedCandidate = null;
          publishFor(connection, {
            phase: "reconnect-required",
            verified: false,
            reconnectRequired: true,
            selectedCandidate: null,
            errorCode: "backend-not-ready",
          });
        } else if (connected) {
          let boundBackendConfirmed = true;
          if (connection.allocationId) {
            const boundEvidence = tools.boundBackendTrafficEvidence(
              routeState,
              connection.allocationId
            );
            boundBackendConfirmed = Boolean(boundEvidence && boundEvidence.confirmed);
          }
          // An accepted backend refresh starts a fresh end-to-end proof. Do
          // not leave cached green visible if the selected-pair stats request
          // stalls or if its bound allocation disappeared.
          connection.diagnosticSequence += 1;
          connection.verified = false;
          connection.selectedCandidate = null;
          connection.routeRevision = routeState.routeRevision;
          publishFor(connection, {
            phase: boundBackendConfirmed ? "connection-state" : "waiting-for-backend",
            routeRevision: routeState.routeRevision,
            verified: false,
            reconnectRequired: false,
            selectedCandidate: null,
            errorCode: null,
          });
          reportSelectedCandidate(connection);
        }
      }
    }
  }

  function installConflictBlocker() {
    const PreviousPeerConnection = globalThis.RTCPeerConnection;
    const blocker = new Proxy(PreviousPeerConnection, {
      construct(target, argumentsList, newTarget) {
        const configuration = argumentsList[0];
        if (tools.isDiscordVoiceConfiguration(configuration)) {
          throw extensionError("reload-required");
        }
        const actualNewTarget = newTarget === blocker ? target : newTarget;
        return Reflect.construct(target, argumentsList, actualNewTarget);
      },
    });
    WrappedPeerConnection = blocker;
    Object.defineProperty(globalThis, "RTCPeerConnection", {
      configurable: true,
      writable: true,
      value: blocker,
    });
    if (globalThis.webkitRTCPeerConnection === PreviousPeerConnection) {
      Object.defineProperty(globalThis, "webkitRTCPeerConnection", {
        configurable: true,
        writable: true,
        value: blocker,
      });
    }
    publish({
      phase: "reload-required",
      reconnectRequired: true,
      errorCode: "old-hook-detected",
    });
  }

  globalThis.addEventListener("message", (event) => {
    if (event.source !== globalThis || event.origin !== pageOrigin || !event.data ||
        event.data.channel !== CHANNEL || event.data.direction !== "extension-to-page") {
      return;
    }
    if (event.data.type === "bridge-ready") {
      const nextBridgeInstanceId = typeof event.data.bridgeInstanceId === "string" &&
        /^[a-f0-9]{32}$/u.test(event.data.bridgeInstanceId)
        ? event.data.bridgeInstanceId
        : null;
      if (!nextBridgeInstanceId) return;
      if (nextBridgeInstanceId !== currentBridgeInstanceId) {
        currentBridgeInstanceId = nextBridgeInstanceId;
        highestRouteResponseSequence = 0;
      }
      requestRoute();
      for (const waiter of routeWaiters) {
        if (!waiter.freshSeen) requestRoute(waiter.requestId);
      }
      return;
    }
    if (event.data.bridgeInstanceId !== currentBridgeInstanceId) return;
    if (event.data.token !== documentToken) return;
    if (event.data.type === "route") {
      acceptRoute(
        event.data.route,
        event.data.requestId,
        event.data.responseOk !== false,
        event.data.responseSequence
      );
    }
    if (event.data.type === "get-status") {
      const statusRequestId = Number.isSafeInteger(event.data.statusRequestId) &&
        event.data.statusRequestId > 0
        ? event.data.statusRequestId
        : null;
      if (lastStatus.phase !== "reload-required" && !hookStillProtectsNewConnections()) {
        invalidateForHookReplacement();
        publish({}, statusRequestId);
      } else {
        reconcileCurrentNativeState();
        // Reconciliation may publish an unsolicited lifecycle update. Always
        // follow it with the response correlated to this exact popup request.
        publish({}, statusRequestId);
      }
    }
  });

  if (globalThis.__discordVoiceRelayInstalled) {
    installConflictBlocker();
  } else {
    WrappedPeerConnection = new Proxy(NativePeerConnection, {
      get(target, property, receiver) {
        if (property === hookBrand) return hookToken;
        return Reflect.get(target, property, receiver);
      },
      construct(target, argumentsList, newTarget) {
        const suppliedConfiguration = argumentsList[0];
        let isTarget;
        try {
          isTarget = tools.isDiscordVoiceConfiguration(suppliedConfiguration);
        } catch (error) {
          throw error;
        }
        const promotable = argumentsList.length === 0 || Boolean(
          suppliedConfiguration && typeof suppliedConfiguration === "object" &&
          Reflect.ownKeys(suppliedConfiguration).length === 0
        );
        observations.observedConnections += 1;
        if (argumentsList.length === 0) {
          observations.ignoredNoArgumentConnections += 1;
        } else if (promotable) {
          observations.promotableConnections += 1;
        } else if (!isTarget) {
          observations.unmatchedConfiguredConnections += 1;
        }
        if (isTarget && connections.size >= MAX_TRACKED_CONNECTIONS) {
          observations.targetedAttempts += 1;
          currentConnectionId = 0;
          publish({
            phase: "route-blocked",
            bootId: routeState ? routeState.bootId : null,
            generation: routeState ? routeState.generation : 0,
            applied: false,
            verified: false,
            reconnectRequired: true,
            selectedCandidate: null,
            errorCode: "connection-limit",
          });
          throw extensionError("connection-limit");
        }
        const nextArguments = [...argumentsList];
        if (isTarget) nextArguments[0] = tools.blockedConfiguration(suppliedConfiguration);
        const actualNewTarget = newTarget === WrappedPeerConnection ? target : newTarget;
        let peerConnection;
        try {
          peerConnection = Reflect.construct(target, nextArguments, actualNewTarget);
        } catch (error) {
          if (isTarget) {
            observations.targetedAttempts += 1;
            // No PeerConnection object exists to track, so reserve ID zero as
            // a sticky newest-failure epoch until a newer targeted attempt.
            currentConnectionId = 0;
            publish({
              phase: "configuration-error",
              applied: false,
              verified: false,
              reconnectRequired: true,
              selectedCandidate: null,
              errorCode: "constructor-configuration-error",
            });
          }
          throw error;
        }
        if (isTarget || promotable) {
          patchConnection(peerConnection, suppliedConfiguration, isTarget, promotable);
        } else {
          publish({});
        }
        return peerConnection;
      },
    });

    const descriptor = Object.getOwnPropertyDescriptor(globalThis, "RTCPeerConnection");
    Object.defineProperty(globalThis, "RTCPeerConnection", {
      configurable: descriptor ? descriptor.configurable : true,
      enumerable: descriptor ? descriptor.enumerable : false,
      writable: descriptor ? descriptor.writable : true,
      value: WrappedPeerConnection,
    });
    if (globalThis.webkitRTCPeerConnection === NativePeerConnection) {
      Object.defineProperty(globalThis, "webkitRTCPeerConnection", {
        configurable: true,
        writable: true,
        value: WrappedPeerConnection,
      });
    }
    publish({ phase: "hook-ready" });
  }

  Object.defineProperty(globalThis, "__discordDirectInstalled", {
    configurable: true,
    value: true,
  });
  requestRoute();
})();
