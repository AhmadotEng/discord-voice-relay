(function exposePopupStatus(root, factory) {
  "use strict";
  const api = factory();
  if (typeof module === "object" && module && module.exports) {
    module.exports = api;
  } else if (root) {
    Object.defineProperty(root, "__discordDirectPopupStatus", {
      configurable: true,
      value: api,
    });
  }
})(typeof globalThis === "object" ? globalThis : this, function buildPopupStatus() {
  "use strict";

  function presentation(transportInput, pageInput) {
    const transport = transportInput && typeof transportInput === "object" ? transportInput : {};
    const page = pageInput && typeof pageInput === "object" ? pageInput : null;
    const activeAppliedPageRoute = Boolean(page && page.applied === true &&
      Number.isSafeInteger(page.targetedConnections) && page.targetedConnections > 0);
    const pageBootMismatch = Boolean(activeAppliedPageRoute && page.bootId && transport.bootId &&
      page.bootId !== transport.bootId);
    const pageGenerationMismatch = Boolean(activeAppliedPageRoute && !pageBootMismatch &&
      page.bootId && page.bootId === transport.bootId &&
      Number.isSafeInteger(page.generation) && Number.isSafeInteger(transport.generation) &&
      page.generation !== transport.generation);

    if (!transport.enabled || transport.phase === "off") {
      if (activeAppliedPageRoute) {
        return {
          title: "Reconnect Discord voice",
          detail: "Direct mode stopped while this call still used its local route. Leave and rejoin once (route-disabled-during-call).",
          tone: "warning",
        };
      }
      return {
        title: "Direct mode is off",
        detail: "Discord voice is untouched while the extension is disabled.",
        tone: "",
      };
    }
    if (transport.phase === "starting" || transport.phase === "stopping") {
      return {
        title: "Preparing route…",
        detail: "New Discord voice offers stay blocked until the local route is ready.",
        tone: "warning",
      };
    }
    if (transport.phase === "error") {
      const details = {
        "invalid-stun-settings": "The STUN discovery settings are invalid.",
        "transport-start-failed": "Zen could not start the local UDP route.",
        "transport-stopped": "The local UDP route stopped unexpectedly.",
        "transport-status-failed": "Zen could not confirm that the local UDP route was still running.",
        "storage-initialization-failed": "The extension could not load its saved settings.",
      };
      return {
        title: "Route unavailable",
        detail: details[transport.errorCode] ||
          `The extension failed closed${transport.errorCode ? ` (${transport.errorCode})` : ""}.`,
        tone: "error",
      };
    }
    if (page && page.phase === "bridge-unavailable") {
      return {
        title: "Reload Discord",
        detail: "The Discord page bridge did not answer. Fully reload the Discord tab before reconnecting voice.",
        tone: "warning",
      };
    }
    if (page && page.phase === "reload-required") {
      return {
        title: "Reload Discord",
        detail: "The previous voice hook is still in this tab. Reload the Discord page, then reconnect voice once.",
        tone: "warning",
      };
    }
    if (page && page.errorCode === "hook-replaced") {
      return {
        title: "Reload Discord",
        detail: "Another page script replaced the voice constructor. Reload the Discord tab before joining voice again (hook-replaced).",
        tone: "warning",
      };
    }
    if (page && [
      "route-blocked",
      "configuration-error",
      "diagnostic-error",
      "unsafe-direct",
    ].includes(page.phase)) {
      const details = {
        "ice-candidate-error": "Firefox could not gather the protected TURN candidate.",
        "configuration-error": "Discord's peer connection rejected the protected ICE configuration.",
        "constructor-configuration-error": "Zen rejected the protected configuration before Discord voice could start.",
        "selected-pair-not-relay-udp": "Discord selected a path other than the protected UDP relay.",
        "selected-pair-missing": "Firefox connected, but did not report the selected ICE path.",
        "stats-unavailable": "Firefox connected, but relay verification statistics were unavailable.",
        "route-timeout": "The local route was not ready before Discord began negotiation (route-timeout).",
        "route-unavailable": "The background route could not be confirmed for this connection (route-unavailable).",
        "connection-limit": "Too many Discord peer connections were open at once (connection-limit).",
      };
      return {
        title: "Discord route failed",
        detail: details[page.errorCode] ||
          `The protected route failed closed${page.errorCode ? ` (${page.errorCode})` : " (reason unavailable)"}.`,
        tone: "error",
      };
    }
    if (page && page.reconnectRequired) {
      const details = {
        "closed-before-route-applied": "Discord closed the voice connection before the protected route was installed.",
        "closed-after-route-applied": "Discord closed the voice connection before a relay candidate was gathered.",
        "closed-after-candidate": "A relay candidate was gathered, but Discord closed before ICE connected.",
        "closed-after-relay-selected": "The relay was selected, but Discord closed before traffic verification completed.",
        "ice-connection-failed": "The protected ICE connection failed.",
        "peer-connection-failed": "Discord's protected peer connection failed.",
        "route-too-late": "Discord began negotiation before the protected route was installed. Leave and rejoin once (route-too-late).",
        "backend-session-changed": "The extension background restarted, so this connection has old local route credentials. Leave and rejoin once (backend-session-changed).",
        "backend-generation-changed": "The local route restarted after this connection began. Leave and rejoin once (backend-generation-changed).",
        "route-enabled-after-offer": "This connection began while Direct mode was off. Leave and rejoin once now that it is enabled (route-enabled-after-offer).",
        "backend-not-ready": "The local route stopped serving this connection. Save settings if needed, then leave and rejoin once (backend-not-ready).",
      };
      return {
        title: "Reconnect Discord voice",
        detail: details[page.errorCode] ||
          `A new protected connection is required${page.errorCode ? ` (${page.errorCode})` : " (reason unavailable)"}. Leave and rejoin once.`,
        tone: "warning",
      };
    }
    if (pageBootMismatch || pageGenerationMismatch) {
      const errorCode = pageBootMismatch
        ? "backend-session-changed"
        : "backend-generation-changed";
      return {
        title: "Reconnect Discord voice",
        detail: pageBootMismatch
          ? `The extension background restarted, so this call has old route credentials. Leave and rejoin once (${errorCode}).`
          : `The local route restarted after this call began. Leave and rejoin once (${errorCode}).`,
        tone: "warning",
      };
    }

    const pageMatchesCurrentGeneration = page && typeof page.bootId === "string" &&
      page.bootId === transport.bootId && Number.isSafeInteger(page.generation) &&
      Number.isSafeInteger(transport.generation) &&
      page.generation === transport.generation;
    const pageMatchesCurrentRevision = pageMatchesCurrentGeneration &&
      Number.isSafeInteger(page.routeRevision) && page.routeRevision >= 0 &&
      Number.isSafeInteger(transport.routeRevision) && transport.routeRevision >= 0 &&
      page.routeRevision === transport.routeRevision;
    const backend = transport.backend && typeof transport.backend === "object"
      ? transport.backend
      : null;
    const backendHasLiveEvidence = Boolean(backend && backend.running === true &&
      backend.loopbackPreference === true && backend.mode === "remote-mapped" &&
      Number.isSafeInteger(backend.allocationCount) && backend.allocationCount > 0 &&
      Number.isSafeInteger(backend.mappingReadyAllocations) &&
      backend.mappingReadyAllocations > 0 &&
      Number.isSafeInteger(backend.peerDatagramsQueued) && backend.peerDatagramsQueued > 0 &&
      Number.isSafeInteger(backend.peerDatagramsReceived) && backend.peerDatagramsReceived > 0);
    const currentRouteApplied = pageMatchesCurrentGeneration && page.applied === true;
    if (transport.reconnectRequired && !currentRouteApplied) {
      return {
        title: "Reconnect Discord voice",
        detail: "The backend route changed. Leave and rejoin once; the extension will not do it automatically.",
        tone: "warning",
      };
    }
    if (transport.ready && transport.phase === "ready" && pageMatchesCurrentGeneration &&
        page.verified && (!pageMatchesCurrentRevision || !backendHasLiveEvidence)) {
      return {
        title: "Rechecking protected route…",
        detail: pageMatchesCurrentRevision
          ? "The current backend snapshot no longer contains complete live relay evidence."
          : "The backend changed after the last page verification. Waiting for a matching fresh proof.",
        tone: "warning",
      };
    }
    if (transport.ready && transport.phase === "ready" && pageMatchesCurrentRevision &&
        backendHasLiveEvidence && page.verified) {
      return {
        title: "Protected route verified",
        detail: "Discord selected the current local relay over UDP and the backend transport is active.",
        tone: "ready",
      };
    }
    if (transport.ready && transport.phase === "ready" && page) {
      if (page.phase === "hook-unconfirmed") {
        return {
          title: "Checking Discord hook…",
          detail: "Waiting for the Discord page hook to answer. Reload Discord if this does not change.",
          tone: "warning",
        };
      }
      if (page.phase === "waiting-for-route") {
        return {
          title: "Discord route requested…",
          detail: "The first voice offer is being held while the protected route is checked.",
          tone: "warning",
        };
      }
      if (currentRouteApplied && page.phase === "waiting-for-backend") {
        return {
          title: "Relay selected",
          detail: "Discord selected the UDP relay. Waiting for bidirectional backend traffic to verify it.",
          tone: "warning",
        };
      }
      if (currentRouteApplied && page.phase === "candidate") {
        return {
          title: "Relay candidate gathered",
          detail: "Discord found the protected candidate and is completing ICE negotiation.",
          tone: "warning",
        };
      }
      if (currentRouteApplied && ["route-applied", "ice-state", "connection-state"].includes(page.phase)) {
        return {
          title: "Protected route applied",
          detail: "Discord is connecting through the local UDP relay; verification is still pending.",
          tone: "warning",
        };
      }
      if (page.phase === "hook-ready") {
        return {
          title: "Discord hook ready",
          detail: "The Discord page is protected and waiting for a new voice connection.",
          tone: "ready",
        };
      }
      if (page.phase === "direct") {
        return {
          title: "Discord route not applied",
          detail: "This Discord connection was released without the protected route. Reload Discord and reconnect voice.",
          tone: "error",
        };
      }
    }
    if (transport.ready && transport.phase === "ready") {
      return {
        title: "Ready",
        detail: currentRouteApplied
          ? "Route applied. Waiting for Discord to select and verify the relay path."
          : "Ready for the next Discord voice connection. Reconnect voice once if a call is already open.",
        tone: "ready",
      };
    }
    return {
      title: "Waiting",
      detail: "The extension has not finished preparing the route.",
      tone: "warning",
    };
  }

  return Object.freeze({ presentation });
});
