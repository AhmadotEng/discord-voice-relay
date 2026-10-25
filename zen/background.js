(function runDiscordDirectBackground() {
  "use strict";

  const tools = globalThis.__discordDirectTools;
  const LEGACY_KEYS = ["enabled", "turnUrls", "turnUsername", "turnCredential", "tcpOnly"];
  const SETTINGS_VERSION = 1;
  const MONITOR_INTERVAL_MS = 2500;
  const bootId = createBootId();

  let settings = { ...tools.DEFAULT_SETTINGS };
  let generation = 0;
  let routeRevision = 0;
  let privateEndpoint = null;
  let lifecycleQueue = Promise.resolve();
  let settingsMutationQueue = Promise.resolve();
  let refreshPromise = null;
  let initializationPromise = null;
  let migrationNotice = false;
  let routeState = {
    bootId,
    enabled: true,
    ready: false,
    phase: "starting",
    generation: 0,
    routeRevision: 0,
    userDisabled: false,
    reconnectRequired: false,
    errorCode: null,
    backend: emptyBackendSnapshot(),
  };

  function createBootId() {
    const bytes = new Uint8Array(16);
    globalThis.crypto.getRandomValues(bytes);
    return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  }

  function emptyBackendSnapshot() {
    return {
      running: false,
      loopbackPreference: false,
      mode: null,
      allocationCount: 0,
      allocations: [],
      mappingReadyAllocations: 0,
      permissionCount: 0,
      channelCount: 0,
      allocationsCreated: 0,
      permissionsCreated: 0,
      channelsBound: 0,
      peerDatagramsQueued: 0,
      peerDatagramsReceived: 0,
      clientDatagramsQueued: 0,
      preludeActivations: 0,
      mappingProbeResponses: 0,
      mappingProbeSuccesses: 0,
      mappingProbeFailures: 0,
      peerPolicyRejections: 0,
    };
  }

  function sanitizeBackendSnapshot(value) {
    const input = value && typeof value === "object" ? value : {};
    const allocations = Array.isArray(input.allocations) ? input.allocations.slice(0, 8) : [];
    const stats = input.stats && typeof input.stats === "object" ? input.stats : {};
    const safeCount = (candidate, maximum = Number.MAX_SAFE_INTEGER) =>
      Number.isSafeInteger(candidate) && candidate >= 0 ? Math.min(candidate, maximum) : 0;
    const safeIpv4 = (candidate) => {
      if (typeof candidate !== "string") return null;
      const parts = candidate.split(".");
      if (parts.length !== 4 || parts.some((part) => !/^\d{1,3}$/u.test(part) || Number(part) > 255)) {
        return null;
      }
      return parts.map((part) => String(Number(part))).join(".");
    };
    const allocationSnapshots = allocations.map((entry) => {
      const id = entry && typeof entry.id === "string" && /^[a-f0-9]{32}$/u.test(entry.id)
        ? entry.id
        : null;
      const relayAddress = safeIpv4(entry && entry.relayAddress);
      const relayPort = safeCount(entry && entry.relayPort, 65535);
      if (!id || !relayAddress || relayPort < 1) return null;
      return {
        id,
        relayAddress,
        relayPort,
        mappingReady: entry.mappingState === "ready",
        peerDatagramsQueued: safeCount(entry.peerDatagramsQueued),
        peerDatagramsReceived: safeCount(entry.peerDatagramsReceived),
      };
    }).filter(Boolean);
    return {
      running: input.running === true,
      loopbackPreference: input.loopbackPreference === true,
      mode: input.mode === "remote-mapped" ? "remote-mapped" : null,
      allocationCount: safeCount(input.allocationCount, 8),
      allocations: allocationSnapshots,
      mappingReadyAllocations: allocations.filter((entry) =>
        entry && entry.mappingState === "ready"
      ).length,
      permissionCount: allocations.reduce((total, entry) =>
        total + safeCount(entry && entry.permissions, 4), 0),
      channelCount: allocations.reduce((total, entry) =>
        total + safeCount(entry && entry.channels, 4), 0),
      allocationsCreated: safeCount(stats.allocationsCreated),
      permissionsCreated: safeCount(stats.permissionsCreated),
      channelsBound: safeCount(stats.channelsBound),
      peerDatagramsQueued: safeCount(stats.peerDatagramsQueued),
      peerDatagramsReceived: safeCount(stats.peerDatagramsReceived),
      clientDatagramsQueued: safeCount(stats.clientDatagramsQueued),
      preludeActivations: safeCount(stats.preludeActivations),
      mappingProbeResponses: safeCount(stats.mappingProbeResponses),
      mappingProbeSuccesses: safeCount(stats.mappingProbeSuccesses),
      mappingProbeFailures: safeCount(stats.mappingProbeFailures),
      peerPolicyRejections: safeCount(stats.peerPolicyRejections),
    };
  }

  function backendCanServe(snapshot) {
    return Boolean(snapshot && snapshot.running && snapshot.loopbackPreference &&
      snapshot.mode === "remote-mapped");
  }

  function backendProofFingerprint(snapshot) {
    const backend = snapshot && typeof snapshot === "object"
      ? snapshot
      : emptyBackendSnapshot();
    const allocations = Array.isArray(backend.allocations)
      ? backend.allocations.map((entry) => ({
          id: entry.id,
          relayAddress: entry.relayAddress,
          relayPort: entry.relayPort,
          mappingReady: entry.mappingReady === true,
          hasQueuedTraffic: entry.peerDatagramsQueued > 0,
          hasReceivedTraffic: entry.peerDatagramsReceived > 0,
        })).sort((left, right) => String(left.id).localeCompare(String(right.id)))
      : [];
    return JSON.stringify({
      running: backend.running === true,
      loopbackPreference: backend.loopbackPreference === true,
      mode: backend.mode,
      allocationCount: backend.allocationCount,
      mappingReadyAllocations: backend.mappingReadyAllocations,
      hasQueuedTraffic: backend.peerDatagramsQueued > 0,
      hasReceivedTraffic: backend.peerDatagramsReceived > 0,
      allocations,
    });
  }

  function notifyRouteChanged() {
    const notification = {
      type: "discord-direct:route-changed",
      bootId,
      generation: routeState.generation,
      routeRevision: routeState.routeRevision,
    };
    browser.tabs.query({ url: "https://discord.com/*" })
      .then((tabs) => Promise.allSettled(tabs.map((tab) =>
        Number.isInteger(tab.id)
          ? browser.tabs.sendMessage(tab.id, notification, { frameId: 0 })
          : Promise.resolve()
      )))
      .catch(() => {});
  }

  function replaceRouteState(next) {
    routeRevision = routeRevision === Number.MAX_SAFE_INTEGER ? 1 : routeRevision + 1;
    routeState = {
      ...routeState,
      ...next,
      bootId,
      generation,
      routeRevision,
    };
    notifyRouteChanged();
  }

  function queueLifecycle(task) {
    const queued = lifecycleQueue.then(task, task);
    lifecycleQueue = queued.catch(() => {});
    return queued;
  }

  function queueSettingsMutation(task) {
    const queued = settingsMutationQueue.then(task, task);
    settingsMutationQueue = queued.catch(() => {});
    return queued;
  }

  function publicStatus() {
    const { allocations: _privateAllocations, ...publicBackend } = routeState.backend || {};
    return {
      bootId,
      enabled: routeState.enabled,
      ready: routeState.ready,
      phase: routeState.phase,
      generation: routeState.generation,
      routeRevision: routeState.routeRevision,
      reconnectRequired: routeState.reconnectRequired,
      errorCode: routeState.errorCode,
      backend: publicBackend,
      migrationNotice,
    };
  }

  function routeResponse() {
    return {
      bootId,
      enabled: routeState.enabled,
      ready: routeState.ready,
      phase: routeState.phase,
      generation: routeState.generation,
      routeRevision: routeState.routeRevision,
      userDisabled: routeState.userDisabled,
      reconnectRequired: routeState.reconnectRequired,
      errorCode: routeState.errorCode,
      backend: {
        ...routeState.backend,
        allocations: Array.isArray(routeState.backend && routeState.backend.allocations)
          ? routeState.backend.allocations.map((entry) => ({ ...entry }))
          : [],
      },
      endpoint: routeState.ready && privateEndpoint ? { ...privateEndpoint } : null,
    };
  }

  function isDiscordTopLevelSender(sender) {
    if (!sender || sender.id !== browser.runtime.id) {
      return false;
    }
    try {
      const documentUrl = new URL(sender.url || "");
      const senderOrigin = new URL(sender.origin || "");
      if (documentUrl.origin !== "https://discord.com" ||
          senderOrigin.origin !== "https://discord.com") {
        return false;
      }
      // Zen 147 omits tab and frameId for messages from privileged isolated
      // content scripts. When present, still verify them. The manifest and the
      // bridge's window.top check independently restrict execution to top level.
      if (sender.frameId !== undefined && sender.frameId !== 0) return false;
      if (sender.tab) {
        const tabUrl = new URL(sender.tab.url || "");
        if (tabUrl.origin !== "https://discord.com") return false;
      }
      return true;
    } catch (_error) {
      return false;
    }
  }

  function isExtensionPageSender(sender) {
    if (!sender || sender.id !== browser.runtime.id) return false;
    try {
      return new URL(sender.url || "").protocol === "moz-extension:";
    } catch (_error) {
      return false;
    }
  }

  async function safeStopTransport() {
    try {
      await browser.experiments.loopbackTurn.stop();
    } catch (_error) {
      // ExperimentAPI shutdown independently performs the same socket sweep.
    }
  }

  function transportStartOptions(validated) {
    return {
      mode: "remote-mapped",
      mappingProbeServers: validated.servers,
      mappingProbeTimeoutMs: 1800,
      mappingProbeRetries: 2,
      triggerLength: 0,
      preludePackets: [[0], [1]],
      delayMs: 50,
    };
  }

  async function reconcile(nextSettings, reason) {
    const validation = tools.validateSettings(nextSettings);
    const priorHadRoute = Boolean(privateEndpoint) || routeState.ready;
    const operationGeneration = ++generation;
    settings = validation.settings;

    if (validation.errors.length > 0) {
      privateEndpoint = null;
      replaceRouteState({
        enabled: true,
        ready: false,
        phase: "error",
        userDisabled: false,
        reconnectRequired: priorHadRoute,
        errorCode: "invalid-stun-settings",
        backend: emptyBackendSnapshot(),
      });
      await safeStopTransport();
      return publicStatus();
    }

    if (!settings.enabled) {
      privateEndpoint = null;
      replaceRouteState({
        enabled: true,
        ready: false,
        phase: "stopping",
        userDisabled: false,
        reconnectRequired: priorHadRoute,
        errorCode: null,
        backend: emptyBackendSnapshot(),
      });
      await safeStopTransport();
      if (operationGeneration !== generation) return publicStatus();
      replaceRouteState({
        enabled: false,
        ready: false,
        phase: "off",
        userDisabled: true,
        reconnectRequired: priorHadRoute,
        errorCode: null,
        backend: emptyBackendSnapshot(),
      });
      return publicStatus();
    }

    privateEndpoint = null;
    replaceRouteState({
      enabled: true,
      ready: false,
      phase: "starting",
      userDisabled: false,
      reconnectRequired: priorHadRoute,
      errorCode: null,
      backend: emptyBackendSnapshot(),
    });

    let result;
    try {
      result = await browser.experiments.loopbackTurn.start(transportStartOptions(validation));
    } catch (_error) {
      result = null;
    }
    if (operationGeneration !== generation) return publicStatus();

    const backend = sanitizeBackendSnapshot(result);
    const endpointValid = result && !result.__apiError &&
      tools.validLoopbackTurnUrl(result.turnUrl) &&
      typeof result.username === "string" && result.username.length > 0 &&
      typeof result.credential === "string" && result.credential.length > 0;
    if (!backendCanServe(backend) || !endpointValid) {
      privateEndpoint = null;
      replaceRouteState({
        enabled: true,
        ready: false,
        phase: "error",
        userDisabled: false,
        reconnectRequired: priorHadRoute,
        errorCode: "transport-start-failed",
        backend,
      });
      await safeStopTransport();
      return publicStatus();
    }

    privateEndpoint = {
      turnUrl: result.turnUrl,
      username: result.username,
      credential: result.credential,
    };
    replaceRouteState({
      enabled: true,
      ready: true,
      phase: "ready",
      userDisabled: false,
      reconnectRequired: priorHadRoute,
      errorCode: null,
      backend,
    });
    return publicStatus();
  }

  function scheduleReconcile(nextSettings, reason) {
    return queueLifecycle(() => reconcile(nextSettings, reason));
  }

  async function refreshBackendStatus() {
    if (!routeState.ready || !privateEndpoint) return publicStatus();
    if (refreshPromise) return refreshPromise;
    const expectedGeneration = generation;
    refreshPromise = Promise.resolve()
      .then(() => browser.experiments.loopbackTurn.status())
      .then((result) => {
        if (expectedGeneration !== generation || !routeState.ready) return publicStatus();
        const backend = sanitizeBackendSnapshot(result);
        if (!backendCanServe(backend)) {
          privateEndpoint = null;
          generation += 1;
          replaceRouteState({
            enabled: true,
            ready: false,
            phase: "error",
            userDisabled: false,
            reconnectRequired: true,
            errorCode: "transport-stopped",
            backend,
          });
          queueLifecycle(safeStopTransport);
          return publicStatus();
        }

        const oldBackend = routeState.backend;
        if (JSON.stringify(oldBackend) !== JSON.stringify(backend)) {
          if (backendProofFingerprint(oldBackend) !== backendProofFingerprint(backend)) {
            replaceRouteState({ backend });
          } else {
            // Monotonic packet counters are useful status data, but advancing
            // the proof revision for every packet can make the popup chase a
            // perpetually moving snapshot. Only proof-relevant transitions
            // notify the page and require selected-pair revalidation.
            routeState = { ...routeState, backend };
          }
        }
        return publicStatus();
      })
      .catch(() => {
        if (expectedGeneration === generation && routeState.ready) {
          privateEndpoint = null;
          generation += 1;
          replaceRouteState({
            enabled: true,
            ready: false,
            phase: "error",
            userDisabled: false,
            reconnectRequired: true,
            errorCode: "transport-status-failed",
            backend: emptyBackendSnapshot(),
          });
          queueLifecycle(safeStopTransport);
        }
        return publicStatus();
      })
      .finally(() => {
        refreshPromise = null;
      });
    return refreshPromise;
  }

  async function loadSettings() {
    const stored = await browser.storage.local.get(null);
    const hasLegacyData = LEGACY_KEYS.some((key) => Object.prototype.hasOwnProperty.call(stored, key));
    if (stored.directSettingsVersion !== SETTINGS_VERSION && hasLegacyData) {
      migrationNotice = true;
      await browser.storage.local.remove(LEGACY_KEYS);
      settings = { ...tools.DEFAULT_SETTINGS, enabled: false };
      await browser.storage.local.set({
        directSettingsVersion: SETTINGS_VERSION,
        directEnabled: false,
        mappingProbeServers: settings.mappingProbeServers,
        migrationNotice: true,
      });
      return settings;
    }

    migrationNotice = stored.migrationNotice === true;
    const loaded = {
      enabled: stored.directEnabled === true,
      mappingProbeServers: stored.mappingProbeServers === undefined
        ? tools.DEFAULT_SETTINGS.mappingProbeServers
        : stored.mappingProbeServers,
    };
    const validation = tools.validateSettings(loaded);
    settings = validation.settings;
    await browser.storage.local.set({
      directSettingsVersion: SETTINGS_VERSION,
      directEnabled: settings.enabled,
      mappingProbeServers: settings.mappingProbeServers,
    });
    return settings;
  }

  function initialize() {
    if (!initializationPromise) {
      initializationPromise = loadSettings()
        .then((loaded) => scheduleReconcile(loaded, "startup"))
        .catch(async () => {
          generation += 1;
          privateEndpoint = null;
          replaceRouteState({
            enabled: true,
            ready: false,
            phase: "error",
            userDisabled: false,
            reconnectRequired: false,
            errorCode: "storage-initialization-failed",
            backend: emptyBackendSnapshot(),
          });
          await safeStopTransport();
          return publicStatus();
        });
    }
    return initializationPromise;
  }

  browser.runtime.onMessage.addListener((message, sender) => {
    if (!message || typeof message !== "object") return undefined;

    if (message.type === "discord-direct:get-route") {
      if (!isDiscordTopLevelSender(sender)) {
        return Promise.reject(new Error("Route access is restricted to top-level Discord documents"));
      }
      const precedingMutations = settingsMutationQueue;
      return precedingMutations
        .then(() => initialize())
        .then(() => refreshBackendStatus())
        .then(() => routeResponse());
    }

    if (message.type === "discord-direct:get-status") {
      if (!isExtensionPageSender(sender)) {
        return Promise.reject(new Error("Status access is restricted to extension pages"));
      }
      return initialize()
        .then(() => refreshBackendStatus())
        .then(() => publicStatus());
    }

    if (message.type === "discord-direct:get-settings") {
      if (!isExtensionPageSender(sender)) {
        return Promise.reject(new Error("Settings access is restricted to extension pages"));
      }
      return initialize().then(() => ({ ...settings, migrationNotice }));
    }

    if (message.type === "discord-direct:save-settings") {
      if (!isExtensionPageSender(sender)) {
        return Promise.reject(new Error("Settings access is restricted to extension pages"));
      }
      return queueSettingsMutation(() => initialize().then(async () => {
        const validation = tools.validateSettings(message.settings);
        if (validation.errors.length > 0) {
          return { ok: false, errors: validation.errors.slice(0, 8), status: publicStatus() };
        }
        const settingsUnchanged = validation.settings.enabled === settings.enabled &&
          validation.settings.mappingProbeServers === settings.mappingProbeServers;
        if (settingsUnchanged && !settings.enabled && routeState.phase === "off") {
          return { ok: true, errors: [], status: publicStatus() };
        }
        if (settingsUnchanged && settings.enabled && routeState.ready &&
            routeState.phase === "ready") {
          await refreshBackendStatus();
          if (routeState.ready && routeState.phase === "ready") {
            return { ok: true, errors: [], status: publicStatus() };
          }
        }
        await browser.storage.local.set({
          directSettingsVersion: SETTINGS_VERSION,
          directEnabled: validation.settings.enabled,
          mappingProbeServers: validation.settings.mappingProbeServers,
        });
        const status = await scheduleReconcile(validation.settings, "settings-changed");
        return { ok: true, errors: [], status };
      }));
    }

    if (message.type === "discord-direct:dismiss-migration") {
      if (!isExtensionPageSender(sender)) return undefined;
      migrationNotice = false;
      return browser.storage.local.set({ migrationNotice: false }).then(() => ({ ok: true }));
    }

    return undefined;
  });

  initialize();
  setInterval(() => {
    refreshBackendStatus().catch(() => {});
  }, MONITOR_INTERVAL_MS);
})();
