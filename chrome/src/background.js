(function runDiscordDirectBackground() {
  "use strict";

  const tools = globalThis.__discordVoiceRelayTools;
  const turnServer = globalThis.TurnServer;
  const MONITOR_INTERVAL_MS = 5_000;
  const SETTINGS_VERSION = 3;
  const bootId = createBootId();

  let settings = { ...tools.DEFAULT_SETTINGS };
  let generation = 0;
  let routeRevision = 0;
  let privateEndpoint = null;
  let helperRunning = false;
  let lifecycleQueue = Promise.resolve();
  let settingsQueue = Promise.resolve();
  let initializationPromise = null;
  let monitorTimer = null;
  let discordTabIds = new Set();
  let routeState = {
    bootId,
    enabled: false,
    ready: false,
    phase: "off",
    mode: "local",
    generation: 0,
    routeRevision: 0,
    userDisabled: true,
    reconnectRequired: false,
    errorCode: null,
    errorDetail: null,
    backend: emptyBackendSnapshot(),
  };

  function safeErrorDetail(value) {
    const detail = String(value === undefined || value === null ? "" : value)
      .replace(/[\u0000-\u001f\u007f]+/gu, " ")
      .trim();
    return detail.slice(0, 200) || "Unknown native helper startup error";
  }

  function createBootId() {
    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  }

  function emptyBackendSnapshot() {
    return {
      running: false,
      controlSocketBound: false,
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

  function safeCount(value, maximum = Number.MAX_SAFE_INTEGER) {
    return Number.isSafeInteger(value) && value >= 0 ? Math.min(value, maximum) : 0;
  }

  function sanitizeBackendSnapshot(value) {
    const input = value && typeof value === "object" ? value : {};
    const allocations = Array.isArray(input.allocations) ? input.allocations.slice(0, 8) : [];
    const stats = input.stats && typeof input.stats === "object" ? input.stats : {};
    const allocationsWithMapping = allocations.map((entry) => {
      const id = entry && typeof entry.id === "string" && /^[a-f0-9]{32}$/u.test(entry.id)
        ? entry.id
        : null;
      const parts = entry && typeof entry.relayAddress === "string"
        ? entry.relayAddress.split(".")
        : [];
      const validIp = parts.length === 4 && parts.every((part) =>
        /^\d{1,3}$/u.test(part) && Number(part) <= 255
      );
      const relayAddress = validIp ? parts.map((part) => String(Number(part))).join(".") : null;
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
      controlSocketBound: input.controlSocketBound === true,
      mode: input.mode === "remote-mapped" ? "remote-mapped" : null,
      allocationCount: safeCount(input.allocationCount, 8),
      allocations: allocationsWithMapping,
      mappingReadyAllocations: allocations.filter((entry) => entry && entry.mappingState === "ready").length,
      permissionCount: allocations.reduce((total, entry) => total + safeCount(entry && entry.permissions, 4), 0),
      channelCount: allocations.reduce((total, entry) => total + safeCount(entry && entry.channels, 4), 0),
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

  function localBackendCanServe(snapshot) {
    return Boolean(snapshot && snapshot.running && snapshot.controlSocketBound &&
      snapshot.mode === "remote-mapped");
  }

  function backendProofFingerprint(snapshot) {
    const backend = snapshot && typeof snapshot === "object" ? snapshot : emptyBackendSnapshot();
    const allocations = Array.isArray(backend.allocations) ? backend.allocations.map((entry) => ({
      id: entry.id,
      relayAddress: entry.relayAddress,
      relayPort: entry.relayPort,
      mappingReady: entry.mappingReady === true,
      hasQueuedTraffic: entry.peerDatagramsQueued > 0,
      hasReceivedTraffic: entry.peerDatagramsReceived > 0,
    })).sort((left, right) => String(left.id).localeCompare(String(right.id))) : [];
    return JSON.stringify({
      running: backend.running === true,
      controlSocketBound: backend.controlSocketBound === true,
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
      type: "discord-voice-relay:route-changed",
      bootId,
      generation: routeState.generation,
      routeRevision: routeState.routeRevision,
    };
    chrome.tabs.query({ url: ["https://discord.com/*"] }).then((tabs) =>
      Promise.allSettled(tabs.filter((tab) => Number.isInteger(tab.id)).map((tab) =>
        chrome.tabs.sendMessage(tab.id, notification, { frameId: 0 })
      ))
    ).catch(() => {});
  }

  function replaceRouteState(next) {
    routeRevision = routeRevision === Number.MAX_SAFE_INTEGER ? 1 : routeRevision + 1;
    routeState = { ...routeState, ...next, bootId, generation, routeRevision };
    if (next.errorCode === null) routeState.errorDetail = null;
    setBadge();
    notifyRouteChanged();
  }

  function setBadge() {
    if (!chrome.action) return;
    let text = "OFF";
    let color = "#566176";
    let title = "Discord Direct: Off — click to enable";
    if (routeState.phase === "error") {
      text = "!";
      color = "#b83b47";
      const errorCode = routeState.errorCode ? ` (${routeState.errorCode})` : "";
      const errorDetail = routeState.errorDetail ? ` — ${routeState.errorDetail}` : "";
      title = `Discord Direct: error${errorCode}${errorDetail}`;
    } else if (routeState.ready) {
      text = "ON";
      color = "#14865d";
      title = "Discord Direct: On — local helper running; click to stop";
    } else if (routeState.enabled && routeState.phase === "waiting") {
      text = "…";
      color = "#526fde";
      title = "Discord Direct: On — waiting for a Discord tab";
    } else if (routeState.enabled) {
      text = "…";
      color = "#526fde";
      title = "Discord Direct: On — starting local helper";
    }
    chrome.action.setBadgeBackgroundColor({ color });
    chrome.action.setBadgeText({ text });
    chrome.action.setTitle({ title });
  }

  function queueLifecycle(task) {
    const queued = lifecycleQueue.then(task, task);
    lifecycleQueue = queued.catch(() => {});
    return queued;
  }

  function queueSettings(task) {
    const queued = settingsQueue.then(task, task);
    settingsQueue = queued.catch(() => {});
    return queued;
  }

  function publicStatus() {
    const { allocations: _privateAllocations, ...publicBackend } = routeState.backend || {};
    return {
      bootId,
      enabled: routeState.enabled,
      ready: routeState.ready,
      phase: routeState.phase,
      mode: "local",
      generation: routeState.generation,
      routeRevision: routeState.routeRevision,
      reconnectRequired: routeState.reconnectRequired,
      errorCode: routeState.errorCode,
      errorDetail: routeState.errorDetail,
      helperRunning,
      discordTabsOpen: discordTabIds.size,
      backend: publicBackend,
    };
  }

  function routeResponse() {
    return {
      bootId,
      enabled: routeState.enabled,
      ready: routeState.ready,
      phase: routeState.phase,
      mode: "local",
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
    if (!sender || sender.id !== chrome.runtime.id) return false;
    try {
      return new URL(sender.url || "").origin === "https://discord.com" &&
        (sender.frameId === undefined || sender.frameId === 0);
    } catch (_error) {
      return false;
    }
  }

  function isExtensionPageSender(sender) {
    if (!sender || sender.id !== chrome.runtime.id) return false;
    try { return new URL(sender.url || "").protocol === "chrome-extension:"; }
    catch (_error) { return false; }
  }

  async function safeStopTransport() {
    stopMonitor();
    try { await turnServer.stop(); } catch (_error) { /* host may already be gone */ }
    helperRunning = false;
    privateEndpoint = null;
  }

  function transportStartOptions(validation) {
    return {
      mappingProbeServers: validation.stunUris,
      mappingProbeTimeoutMs: 1800,
      mappingProbeRetries: 2,
      triggerLength: 0,
      preludePackets: [[0], [1]],
      delayMs: 50,
    };
  }

  function isDiscordTab(tab) {
    try { return new URL(tab && tab.url || "").origin === "https://discord.com"; }
    catch (_error) { return false; }
  }

  async function refreshDiscordTabs() {
    const tabs = await chrome.tabs.query({ url: ["https://discord.com/*"] });
    discordTabIds = new Set((tabs || []).filter((tab) =>
      Number.isInteger(tab.id) && isDiscordTab(tab)
    ).map((tab) => tab.id));
    return discordTabIds.size;
  }

  async function reconcile(nextSettings, force = true) {
    const validation = tools.validateSettings(nextSettings);
    settings = validation.settings;
    const tabCount = await refreshDiscordTabs();
    if (settings.enabled && validation.errors.length === 0 && tabCount > 0 && !force &&
        routeState.ready && helperRunning) {
      return publicStatus();
    }
    const previousHadRoute = Boolean(privateEndpoint) || routeState.ready;
    const operationGeneration = ++generation;

    if (!settings.enabled) {
      if (routeState.phase !== "off" || helperRunning) {
        replaceRouteState({
          enabled: false,
          ready: false,
          phase: "stopping",
          userDisabled: false,
          reconnectRequired: previousHadRoute,
          errorCode: null,
          backend: emptyBackendSnapshot(),
        });
        await safeStopTransport();
      }
      if (operationGeneration !== generation) return publicStatus();
      replaceRouteState({
        enabled: false,
        ready: false,
        phase: "off",
        userDisabled: true,
        reconnectRequired: previousHadRoute,
        errorCode: null,
        backend: emptyBackendSnapshot(),
      });
      return publicStatus();
    }

    if (validation.errors.length > 0) {
      replaceRouteState({
        enabled: true,
        ready: false,
        phase: "error",
        userDisabled: false,
        reconnectRequired: previousHadRoute,
        errorCode: "invalid-stun-settings",
        backend: emptyBackendSnapshot(),
      });
      await safeStopTransport();
      return publicStatus();
    }

    if (tabCount === 0) {
      if (routeState.ready || helperRunning || force) {
        replaceRouteState({
          enabled: true,
          ready: false,
          phase: "waiting",
          userDisabled: false,
          reconnectRequired: previousHadRoute,
          errorCode: null,
          backend: emptyBackendSnapshot(),
        });
        await safeStopTransport();
      } else if (routeState.phase !== "waiting") {
        replaceRouteState({
          enabled: true,
          ready: false,
          phase: "waiting",
          userDisabled: false,
          reconnectRequired: previousHadRoute,
          errorCode: null,
          backend: emptyBackendSnapshot(),
        });
      }
      return publicStatus();
    }

    privateEndpoint = null;
    replaceRouteState({
      enabled: true,
      ready: false,
      phase: "starting",
      userDisabled: false,
      reconnectRequired: previousHadRoute,
      errorCode: null,
      backend: emptyBackendSnapshot(),
    });

    let result;
    let startErrorDetail = null;
    try {
      result = await turnServer.start(transportStartOptions(validation));
    } catch (error) {
      startErrorDetail = safeErrorDetail(error && error.message || error);
      console.error("[Discord Direct] native helper start request failed:", startErrorDetail);
      result = null;
    }
    if (operationGeneration !== generation) return publicStatus();

    const backend = sanitizeBackendSnapshot(result);
    const endpointValid = result && !result.__apiError &&
      tools.validLoopbackTurnUrl(`turn:127.0.0.1:${result.port}?transport=udp`) &&
      typeof result.username === "string" && result.username.length > 0 &&
      typeof result.credential === "string" && result.credential.length > 0;
    if (!localBackendCanServe(backend) || !endpointValid) {
      const errorDetail = startErrorDetail || safeErrorDetail(
        result && result.__apiError ||
        (!result
          ? "Native helper returned no start response"
          : !localBackendCanServe(backend)
            ? `Native helper backend not ready (running=${backend.running}, controlSocketBound=${backend.controlSocketBound}, mode=${backend.mode || "unknown"})`
            : "Native helper returned an invalid loopback TURN endpoint")
      );
      console.error("[Discord Direct] native helper start failed:", errorDetail);
      helperRunning = Boolean(turnServer.isConnected && turnServer.isConnected());
      privateEndpoint = null;
      replaceRouteState({
        enabled: true,
        ready: false,
        phase: "error",
        userDisabled: false,
        reconnectRequired: previousHadRoute,
        errorCode: "native-helper-start-failed",
        errorDetail,
        backend,
      });
      await safeStopTransport();
      return publicStatus();
    }

    helperRunning = true;
    privateEndpoint = {
      urls: [`turn:127.0.0.1:${result.port}?transport=udp`],
      username: result.username,
      credential: result.credential,
    };
    replaceRouteState({
      enabled: true,
      ready: true,
      phase: "ready",
      userDisabled: false,
      reconnectRequired: previousHadRoute,
      errorCode: null,
      backend,
    });
    startMonitor();
    return publicStatus();
  }

  function scheduleReconcile(nextSettings = settings, force = true) {
    return queueLifecycle(() => reconcile(nextSettings, force));
  }

  async function refreshBackendStatus() {
    if (!routeState.ready || !privateEndpoint || !helperRunning) return publicStatus();
    const expectedGeneration = generation;
    try {
      const result = await turnServer.status();
      if (expectedGeneration !== generation || !routeState.ready) return publicStatus();
      const backend = sanitizeBackendSnapshot(result);
      if (!localBackendCanServe(backend)) throw new Error("native-helper-not-running");
      const previous = routeState.backend;
      if (JSON.stringify(previous) !== JSON.stringify(backend)) {
        if (backendProofFingerprint(previous) !== backendProofFingerprint(backend)) {
          replaceRouteState({ backend });
        } else {
          routeState = { ...routeState, backend };
        }
      }
    } catch (_error) {
      if (expectedGeneration === generation && routeState.ready) {
        generation += 1;
        replaceRouteState({
          enabled: true,
          ready: false,
          phase: "error",
          userDisabled: false,
          reconnectRequired: true,
          errorCode: "native-helper-disconnected",
          backend: emptyBackendSnapshot(),
        });
        await safeStopTransport();
      }
    }
    return publicStatus();
  }

  async function loadSettings() {
    const persisted = await chrome.storage.local.get(null);
    const loaded = {
      enabled: persisted.directEnabled === true,
      stunServers: persisted.stunServers === undefined
        ? tools.DEFAULT_SETTINGS.stunServers
        : persisted.stunServers,
    };
    settings = tools.validateSettings(loaded).settings;
    return settings;
  }

  function startMonitor() {
    if (monitorTimer !== null) return;
    monitorTimer = setInterval(() => { void refreshBackendStatus(); }, MONITOR_INTERVAL_MS);
  }

  function stopMonitor() {
    if (monitorTimer !== null) {
      clearInterval(monitorTimer);
      monitorTimer = null;
    }
  }

  function initialize() {
    if (!initializationPromise) {
      initializationPromise = loadSettings()
        .then((loaded) => scheduleReconcile(loaded, true))
        .catch(async () => {
          generation += 1;
          privateEndpoint = null;
          await safeStopTransport();
          replaceRouteState({
            enabled: true,
            ready: false,
            phase: "error",
            userDisabled: false,
            reconnectRequired: false,
            errorCode: "storage-initialization-failed",
            backend: emptyBackendSnapshot(),
          });
          return publicStatus();
        });
    }
    return initializationPromise;
  }

  function reply(sendResponse, promise) {
    promise.then(
      (value) => sendResponse(value),
      () => sendResponse({ ok: false, status: publicStatus() })
    );
    return true;
  }

  async function syncTabLifecycle() {
    await initialize();
    const count = await refreshDiscordTabs();
    if (!settings.enabled) return publicStatus();
    if (count > 0 && routeState.ready && helperRunning) return publicStatus();
    if (count === 0 && routeState.phase === "waiting" && !helperRunning) return publicStatus();
    return scheduleReconcile(settings, false);
  }

  function toggleEnabled() {
    return initialize().then(() => queueSettings(async () => {
      const next = { ...settings, enabled: !settings.enabled };
      await chrome.storage.local.set({
        directSettingsVersion: SETTINGS_VERSION,
        directEnabled: next.enabled,
        stunServers: next.stunServers,
      });
      const status = await scheduleReconcile(next, true);
      return { ok: true, status };
    }));
  }

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!message || typeof message !== "object") return false;
    if (message.type === "discord-voice-relay:get-route") {
      if (!isDiscordTopLevelSender(sender)) {
        sendResponse({ ok: false, error: "Route access is restricted to top-level Discord documents" });
        return true;
      }
      return reply(sendResponse, initialize()
        .then(() => refreshBackendStatus())
        .then(() => routeResponse()));
    }
    if (message.type === "discord-voice-relay:get-status") {
      if (!isExtensionPageSender(sender)) {
        sendResponse({ ok: false, error: "Status access is restricted to extension pages" });
        return true;
      }
      return reply(sendResponse, initialize()
        .then(() => refreshBackendStatus())
        .then(() => publicStatus()));
    }
    if (message.type === "discord-voice-relay:toggle") {
      if (!isExtensionPageSender(sender)) {
        sendResponse({ ok: false, error: "Toggle access is restricted to extension pages" });
        return true;
      }
      return reply(sendResponse, toggleEnabled());
    }
    return false;
  });

  chrome.action.onClicked.addListener(() => { void toggleEnabled(); });

  chrome.tabs.onCreated.addListener(() => { void syncTabLifecycle(); });
  chrome.tabs.onUpdated.addListener((_tabId, changeInfo, tab) => {
    if (changeInfo && changeInfo.url || isDiscordTab(tab)) void syncTabLifecycle();
  });
  chrome.tabs.onRemoved.addListener(() => { void syncTabLifecycle(); });
  chrome.runtime.onInstalled.addListener(() => { void initialize(); });
  chrome.runtime.onStartup.addListener(() => { void initialize(); });

  if (typeof turnServer.onDisconnected === "function") {
    turnServer.onDisconnected(() => {
      if (!routeState.ready) return;
      generation += 1;
      helperRunning = false;
      privateEndpoint = null;
      replaceRouteState({
        enabled: settings.enabled,
        ready: false,
        phase: settings.enabled ? "error" : "off",
        userDisabled: !settings.enabled,
        reconnectRequired: true,
        errorCode: "native-helper-disconnected",
        backend: emptyBackendSnapshot(),
      });
      stopMonitor();
    });
  }

  setBadge();
  void initialize();
})();
