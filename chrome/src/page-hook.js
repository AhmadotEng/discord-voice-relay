(function installDiscordVoiceRelayHook() {
  "use strict";

  const CHANNEL = "discord-voice-relay-chrome:v1";
  const tools = globalThis.__discordVoiceRelayTools;
  const NativePeerConnection = globalThis.RTCPeerConnection;

  if (!tools || typeof NativePeerConnection !== "function") {
    return;
  }

  if (globalThis.__discordVoiceRelayInstalled) {
    return;
  }

  let settings = { ...tools.DEFAULT_SETTINGS };
  let initialConfigReceived = false;
  let targetedConnections = 0;
  let currentConnectionId = 0;
  let lastStatus = {
    phase: "ready",
    targetedConnections: 0,
    applied: false,
    relayCount: 0,
    iceConnectionState: "new",
    connectionState: "new",
    gatheredCandidate: null,
    selectedCandidate: null,
    error: null
  };

  const targeted = new WeakMap();
  const pendingInitialConfig = new Set();
  const nativeSetConfiguration = NativePeerConnection.prototype.setConfiguration;

  function publish(patch) {
    lastStatus = {
      ...lastStatus,
      ...patch,
      targetedConnections
    };
    globalThis.postMessage({
      channel: CHANNEL,
      direction: "page-to-extension",
      type: "status",
      status: lastStatus
    }, globalThis.location.origin);
  }

  function applyRelay(configuration) {
    return tools.buildRelayConfiguration(configuration, settings);
  }

  function publishFor(connection, patch) {
    if (connection.id === currentConnectionId) {
      publish(patch);
    }
  }

  async function reportSelectedCandidate(peerConnection, connection, retriesRemaining = 4) {
    try {
      const report = await peerConnection.getStats();
      if (connection.id !== currentConnectionId) {
        return;
      }
      const stopped = ["failed", "disconnected", "closed"].includes(peerConnection.iceConnectionState) ||
        ["failed", "disconnected", "closed"].includes(peerConnection.connectionState);
      const connected = peerConnection.connectionState === "connected" ||
        peerConnection.iceConnectionState === "connected" ||
        peerConnection.iceConnectionState === "completed";
      if (stopped || !connected) {
        return;
      }
      let transport = null;
      let legacySelectedPair = null;

      report.forEach((entry) => {
        if (entry.type === "transport" && entry.selectedCandidatePairId) {
          transport = entry;
        }
        if (entry.type === "candidate-pair" && entry.selected) {
          legacySelectedPair = entry;
        }
      });

      const selectedPair = transport
        ? report.get(transport.selectedCandidatePairId) || legacySelectedPair
        : legacySelectedPair;
      if (!selectedPair) {
        if (retriesRemaining > 0) {
          globalThis.setTimeout(() => {
            reportSelectedCandidate(peerConnection, connection, retriesRemaining - 1);
          }, 200);
        }
        return;
      }

      const local = report.get(selectedPair.localCandidateId);
      if (!local) {
        if (retriesRemaining > 0) {
          globalThis.setTimeout(() => {
            reportSelectedCandidate(peerConnection, connection, retriesRemaining - 1);
          }, 200);
        }
        return;
      }

      publishFor(connection, {
        phase: "connected",
        selectedCandidate: {
          type: local.candidateType || "unknown",
          protocol: local.protocol || "unknown",
          relayProtocol: local.relayProtocol || null
        },
        error: null
      });
    } catch (error) {
      publishFor(connection, {
        phase: "diagnostic-error",
        error: String(error && error.message || error)
      });
    }
  }

  function observe(peerConnection, connection) {
    peerConnection.addEventListener("icecandidate", (event) => {
      const summary = tools.candidateSummary(event.candidate);
      if (summary) {
        publishFor(connection, { phase: "candidate", gatheredCandidate: summary });
      }
    });

    peerConnection.addEventListener("icecandidateerror", (event) => {
      publishFor(connection, {
        phase: "candidate-error",
        selectedCandidate: null,
        error: event && event.errorCode
          ? `TURN candidate failed (WebRTC error ${event.errorCode}).`
          : "TURN candidate failed."
      });
    });

    peerConnection.addEventListener("iceconnectionstatechange", () => {
      const connected = peerConnection.iceConnectionState === "connected" ||
        peerConnection.iceConnectionState === "completed";
      publishFor(connection, {
        phase: "ice-state",
        iceConnectionState: peerConnection.iceConnectionState,
        ...(connected ? {} : { selectedCandidate: null })
      });
      if (connected) {
        reportSelectedCandidate(peerConnection, connection);
      }
    });

    peerConnection.addEventListener("connectionstatechange", () => {
      const connected = peerConnection.connectionState === "connected";
      publishFor(connection, {
        phase: "connection-state",
        connectionState: peerConnection.connectionState,
        ...(connected ? {} : { selectedCandidate: null })
      });
      if (connected) {
        reportSelectedCandidate(peerConnection, connection);
      }
    });
  }

  function registerTarget(peerConnection, configuration) {
    const existing = targeted.get(peerConnection);
    if (existing) {
      return existing;
    }

    targetedConnections += 1;
    const connection = {
      id: targetedConnections,
      peerConnection,
      configuration
    };
    currentConnectionId = connection.id;
    targeted.set(peerConnection, connection);
    observe(peerConnection, connection);
    if (!initialConfigReceived) {
      pendingInitialConfig.add(connection);
    }
    return connection;
  }

  function patchSetConfiguration(peerConnection) {
    if (typeof nativeSetConfiguration !== "function") {
      return;
    }

    Object.defineProperty(peerConnection, "setConfiguration", {
      configurable: true,
      writable: true,
      value(nextConfiguration) {
        let connection = targeted.get(this);
        if (!connection && tools.isDiscordNetworkConfiguration(nextConfiguration)) {
          connection = registerTarget(this, nextConfiguration);
        }
        if (!connection) {
          return nativeSetConfiguration.call(this, nextConfiguration);
        }

        const result = applyRelay(nextConfiguration);
        connection.configuration = result.configuration;
        publishFor(connection, {
          phase: result.applied ? "reconfigured" : "configuration-skipped",
          applied: result.applied,
          relayCount: result.relayCount,
          selectedCandidate: null,
          error: result.errors[0] || null
        });
        try {
          return nativeSetConfiguration.call(this, result.configuration);
        } catch (error) {
          publishFor(connection, {
            phase: "configuration-error",
            applied: false,
            error: String(error && error.message || error)
          });
          throw error;
        }
      }
    });
  }

  function applyPendingInitialSettings() {
    for (const connection of pendingInitialConfig) {
      const peerConnection = connection.peerConnection;
      const negotiationStarted = Boolean(peerConnection.localDescription || peerConnection.remoteDescription);
      const currentConfiguration = typeof peerConnection.getConfiguration === "function"
        ? peerConnection.getConfiguration()
        : connection.configuration;
      const result = applyRelay(currentConfiguration);

      if (!result.applied) {
        continue;
      }
      if (negotiationStarted) {
        publishFor(connection, {
          phase: "reconnect-required",
          applied: false,
          selectedCandidate: null,
          error: "Relay settings arrived after voice negotiation began. Reconnect Discord voice."
        });
        continue;
      }

      try {
        nativeSetConfiguration.call(peerConnection, result.configuration);
        connection.configuration = result.configuration;
        publishFor(connection, {
          phase: "relay-applied",
          applied: true,
          relayCount: result.relayCount,
          selectedCandidate: null,
          error: null
        });
      } catch (error) {
        publishFor(connection, {
          phase: "reconnect-required",
          applied: false,
          selectedCandidate: null,
          error: "Could not apply the saved relay before voice negotiation. Reconnect Discord voice."
        });
      }
    }
    pendingInitialConfig.clear();
  }

  let WrappedPeerConnection;
  WrappedPeerConnection = new Proxy(NativePeerConnection, {
    construct(target, argumentsList, newTarget) {
      const suppliedConfiguration = argumentsList[0];
      const isTarget = tools.isDiscordNetworkConfiguration(suppliedConfiguration);
      const result = isTarget ? applyRelay(suppliedConfiguration) : {
        applied: false,
        configuration: suppliedConfiguration,
        errors: [],
        relayCount: 0
      };
      const nextArguments = [...argumentsList];
      if (nextArguments.length > 0) {
        nextArguments[0] = result.configuration;
      }

      const actualNewTarget = newTarget === WrappedPeerConnection ? target : newTarget;
      let peerConnection;
      try {
        peerConnection = Reflect.construct(target, nextArguments, actualNewTarget);
      } catch (error) {
        if (isTarget) {
          publish({
            phase: "configuration-error",
            applied: false,
            relayCount: result.relayCount,
            error: String(error && error.message || error)
          });
        }
        throw error;
      }

      patchSetConfiguration(peerConnection);

      if (isTarget) {
        const connection = registerTarget(peerConnection, result.configuration);
        publishFor(connection, {
          phase: result.applied ? "relay-applied" : "configuration-skipped",
          applied: result.applied,
          relayCount: result.relayCount,
          iceConnectionState: peerConnection.iceConnectionState,
          connectionState: peerConnection.connectionState,
          gatheredCandidate: null,
          selectedCandidate: null,
          error: result.errors[0] || null
        });
      }

      return peerConnection;
    }
  });

  Object.defineProperty(globalThis, "RTCPeerConnection", {
    configurable: true,
    writable: true,
    value: WrappedPeerConnection
  });

  if (globalThis.webkitRTCPeerConnection === NativePeerConnection) {
    Object.defineProperty(globalThis, "webkitRTCPeerConnection", {
      configurable: true,
      writable: true,
      value: WrappedPeerConnection
    });
  }

  globalThis.addEventListener("message", (event) => {
    if (event.source !== globalThis || event.origin !== globalThis.location.origin ||
        !event.data || event.data.channel !== CHANNEL ||
        event.data.direction !== "extension-to-page") {
      return;
    }

    if (event.data.type === "config") {
      const validation = tools.validateSettings(event.data.settings);
      settings = validation.settings;
      const isInitialConfig = !initialConfigReceived;
      initialConfigReceived = true;
      publish({
        phase: validation.errors.length > 0 ? "invalid-config" : "configured",
        applied: false,
        relayCount: validation.urls.length,
        error: validation.errors[0] || null
      });
      if (isInitialConfig) {
        applyPendingInitialSettings();
      }
    }

    if (event.data.type === "get-status") {
      publish({});
    }
  });

  Object.defineProperty(globalThis, "__discordVoiceRelayInstalled", {
    value: true,
    configurable: true
  });

  publish({ phase: "ready" });
})();
