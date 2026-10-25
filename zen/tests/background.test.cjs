"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const { webcrypto } = require("node:crypto");

const tools = require("../src/config.js");
const backgroundSource = fs.readFileSync(path.resolve(__dirname, "../background.js"), "utf8");

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function startedTransport(overrides = {}) {
  return {
    running: true,
    mode: "remote-mapped",
    loopbackPreference: true,
    allocationCount: 0,
    allocations: [],
    stats: { peerDatagramsQueued: 0, peerDatagramsReceived: 0 },
    turnUrl: "turn:127.0.0.1:55000?transport=udp",
    username: "short-lived-user",
    credential: "short-lived-credential",
    ...overrides,
  };
}

function createHarness({ stored = {}, startResult = startedTransport() } = {}) {
  let currentStartResult = startResult;
  const storage = { ...stored };
  const removed = [];
  const setCalls = [];
  let heldStorageSet = null;
  const startCalls = [];
  let stopCalls = 0;
  let statusResult = startResult;
  const messageListeners = [];
  const notifications = [];
  const browser = {
    runtime: {
      id: "discord-voice-relay@local.invalid",
      onMessage: {
        addListener(listener) { messageListeners.push(listener); },
      },
    },
    tabs: {
      query(query) {
        assert.equal(query.url, "https://discord.com/*");
        return Promise.resolve([
          { id: 7, url: "https://discord.com/channels/@me" },
          { id: 8, url: "https://discord.com/app" },
        ]);
      },
      sendMessage(tabId, message, options) {
        notifications.push({ tabId, message, options });
        return Promise.resolve();
      },
    },
    storage: {
      local: {
        async get(key) {
          if (key === null) return { ...storage };
          return {};
        },
        async set(values) {
          setCalls.push({ ...values });
          if (heldStorageSet) {
            const pending = heldStorageSet;
            heldStorageSet = null;
            await pending.promise;
          }
          Object.assign(storage, values);
        },
        async remove(keys) {
          for (const key of keys) {
            removed.push(key);
            delete storage[key];
          }
        },
      },
    },
    experiments: {
      loopbackTurn: {
        start(options) {
          startCalls.push(options);
          return Promise.resolve(currentStartResult);
        },
        stop() {
          stopCalls += 1;
          return Promise.resolve({ running: false });
        },
        status() {
          return Promise.resolve(statusResult);
        },
      },
    },
  };
  const context = vm.createContext({
    browser,
    crypto: webcrypto,
    URL,
    setInterval() { return 1; },
    __discordDirectTools: tools,
  });
  vm.runInContext(backgroundSource, context, { filename: "background.js" });

  function sender(kind = "popup") {
    if (kind === "discord") {
      return {
        id: browser.runtime.id,
        frameId: 0,
        url: "https://discord.com/channels/@me",
        origin: "https://discord.com",
        tab: { id: 7, url: "https://discord.com/channels/@me" },
        documentId: "document-1",
      };
    }
    return {
      id: browser.runtime.id,
      url: "moz-extension://test/popup/popup.html",
    };
  }

  function send(message, kind = "popup", customSender = null) {
    assert.equal(messageListeners.length, 1);
    return messageListeners[0](message, customSender || sender(kind));
  }

  return {
    browser,
    storage,
    removed,
    setCalls,
    startCalls,
    notifications,
    send,
    sender,
    get stopCalls() { return stopCalls; },
    setStatus(value) { statusResult = value; },
    setStartResult(value) { currentStartResult = value; },
    holdNextStorageSet() {
      heldStorageSet = deferred();
      return heldStorageSet;
    },
  };
}

test("legacy external relay settings are removed and never reused", async () => {
  const harness = createHarness({
    stored: {
      enabled: true,
      turnUrls: "turns:provider.example:443?transport=tcp",
      turnUsername: "old-user",
      turnCredential: "old-secret",
      tcpOnly: true,
    },
  });
  const settings = await harness.send({ type: "discord-direct:get-settings" });
  assert.equal(settings.enabled, false);
  assert.equal(settings.migrationNotice, true);
  assert.deepEqual(harness.removed.sort(), ["enabled", "tcpOnly", "turnCredential", "turnUrls", "turnUsername"].sort());
  assert.equal(harness.startCalls.length, 0);
  assert.equal(harness.storage.turnCredential, undefined);
  assert.equal(JSON.stringify(harness.storage).includes("old-secret"), false);
});

test("concurrent top-level Discord requests share one pending backend start", async () => {
  const pending = deferred();
  const harness = createHarness({
    stored: {
      directSettingsVersion: 1,
      directEnabled: true,
      mappingProbeServers: tools.DEFAULT_SETTINGS.mappingProbeServers,
    },
    startResult: pending.promise,
  });
  const first = harness.send({ type: "discord-direct:get-route" }, "discord");
  const second = harness.send({ type: "discord-direct:get-route" }, "discord");
  for (let index = 0; index < 10; index += 1) await Promise.resolve();
  assert.equal(harness.startCalls.length, 1);
  pending.resolve(startedTransport());
  const routes = await Promise.all([first, second]);
  assert.equal(harness.startCalls.length, 1);
  assert.match(routes[0].bootId, /^[a-f0-9]{32}$/u);
  assert.equal(routes[0].generation, routes[1].generation);
  assert.equal(routes[0].routeRevision, routes[1].routeRevision);
  assert.ok(routes[0].routeRevision > 0);
  assert.equal(routes[0].bootId, routes[1].bootId);
  assert.equal(routes[0].ready, true);
  assert.equal(routes[0].endpoint.username, "short-lived-user");
});

test("credentials are restricted to matching top-level Discord documents", async () => {
  const harness = createHarness({
    stored: {
      directSettingsVersion: 1,
      directEnabled: true,
      mappingProbeServers: tools.DEFAULT_SETTINGS.mappingProbeServers,
    },
  });
  const valid = await harness.send({ type: "discord-direct:get-route" }, "discord");
  assert.equal(valid.endpoint.credential, "short-lived-credential");

  const zenPrivilegedSender = {
    id: harness.browser.runtime.id,
    url: "https://discord.com/channels/@me",
    origin: "https://discord.com",
  };
  const zenValid = await harness.send(
    { type: "discord-direct:get-route" },
    "discord",
    zenPrivilegedSender
  );
  assert.equal(zenValid.endpoint.credential, "short-lived-credential");

  const frameSender = { ...harness.sender("discord"), frameId: 2 };
  await assert.rejects(
    harness.send({ type: "discord-direct:get-route" }, "discord", frameSender),
    /top-level Discord/u
  );
  const otherHost = {
    ...harness.sender("discord"),
    url: "https://example.com/",
    tab: { id: 8, url: "https://example.com/" },
  };
  await assert.rejects(
    harness.send({ type: "discord-direct:get-route" }, "discord", otherHost),
    /top-level Discord/u
  );
  const missingOrigin = { ...harness.sender("discord") };
  delete missingOrigin.origin;
  await assert.rejects(
    harness.send({ type: "discord-direct:get-route" }, "discord", missingOrigin),
    /top-level Discord/u
  );
  const publicStatus = await harness.send({ type: "discord-direct:get-status" });
  assert.match(publicStatus.bootId, /^[a-f0-9]{32}$/u);
  assert.ok(publicStatus.routeRevision > 0);
  assert.equal(Object.hasOwn(publicStatus, "endpoint"), false);
  assert.equal(JSON.stringify(publicStatus).includes("short-lived-credential"), false);
});

test("allocation endpoints are private to the Discord route response", async () => {
  const allocationId = "7".repeat(32);
  const harness = createHarness({
    stored: {
      directSettingsVersion: 1,
      directEnabled: true,
      mappingProbeServers: tools.DEFAULT_SETTINGS.mappingProbeServers,
    },
    startResult: startedTransport({
      allocationCount: 1,
      allocations: [{
        id: allocationId,
        relayAddress: "92.97.232.243",
        relayPort: 62000,
        mappingState: "ready",
        permissions: 1,
        channels: 1,
        peerDatagramsQueued: 2,
        peerDatagramsReceived: 3,
      }],
      stats: { peerDatagramsQueued: 2, peerDatagramsReceived: 3 },
    }),
  });
  const route = await harness.send({ type: "discord-direct:get-route" }, "discord");
  assert.deepEqual(JSON.parse(JSON.stringify(route.backend.allocations)), [{
    id: allocationId,
    relayAddress: "92.97.232.243",
    relayPort: 62000,
    mappingReady: true,
    peerDatagramsQueued: 2,
    peerDatagramsReceived: 3,
  }]);

  const publicStatus = await harness.send({ type: "discord-direct:get-status" });
  assert.equal(Object.hasOwn(publicStatus.backend, "allocations"), false);
  assert.doesNotMatch(JSON.stringify(publicStatus), /92\.97\.232\.243|7777777777/u);
});

test("backend snapshot changes advance route revision without rotating credentials", async () => {
  const allocationId = "8".repeat(32);
  const withAllocation = startedTransport({
    allocationCount: 1,
    allocations: [{
      id: allocationId,
      relayAddress: "92.97.232.243",
      relayPort: 62000,
      mappingState: "ready",
      permissions: 1,
      channels: 1,
      peerDatagramsQueued: 2,
      peerDatagramsReceived: 2,
    }],
    stats: { peerDatagramsQueued: 2, peerDatagramsReceived: 2 },
  });
  const harness = createHarness({
    stored: {
      directSettingsVersion: 1,
      directEnabled: true,
      mappingProbeServers: tools.DEFAULT_SETTINGS.mappingProbeServers,
    },
    startResult: withAllocation,
  });
  const initial = await harness.send({ type: "discord-direct:get-route" }, "discord");
  assert.equal(initial.backend.allocations.length, 1);

  harness.setStatus(startedTransport());
  const refreshed = await harness.send({ type: "discord-direct:get-status" });
  assert.equal(refreshed.generation, initial.generation);
  assert.ok(refreshed.routeRevision > initial.routeRevision);
  assert.equal(refreshed.backend.allocationCount, 0);
  assert.equal(refreshed.backend.mappingReadyAllocations, 0);

  const route = await harness.send({ type: "discord-direct:get-route" }, "discord");
  assert.equal(route.generation, initial.generation);
  assert.equal(route.routeRevision, refreshed.routeRevision);
  assert.equal(route.backend.allocations.length, 0);
});

test("healthy packet counter growth does not perpetually advance the proof revision", async () => {
  const allocationId = "9".repeat(32);
  const snapshot = (queued, received) => startedTransport({
    allocationCount: 1,
    allocations: [{
      id: allocationId,
      relayAddress: "92.97.232.243",
      relayPort: 62001,
      mappingState: "ready",
      permissions: 1,
      channels: 1,
      peerDatagramsQueued: queued,
      peerDatagramsReceived: received,
    }],
    stats: { peerDatagramsQueued: queued, peerDatagramsReceived: received },
  });
  const harness = createHarness({
    stored: {
      directSettingsVersion: 1,
      directEnabled: true,
      mappingProbeServers: tools.DEFAULT_SETTINGS.mappingProbeServers,
    },
    startResult: snapshot(2, 3),
  });
  const initial = await harness.send({ type: "discord-direct:get-status" });
  for (let index = 0; index < 8; index += 1) await Promise.resolve();
  const notificationCount = harness.notifications.length;

  harness.setStatus(snapshot(20, 30));
  const advanced = await harness.send({ type: "discord-direct:get-status" });
  for (let index = 0; index < 8; index += 1) await Promise.resolve();
  assert.equal(advanced.routeRevision, initial.routeRevision);
  assert.equal(advanced.backend.peerDatagramsQueued, 20);
  assert.equal(advanced.backend.peerDatagramsReceived, 30);
  assert.equal(harness.notifications.length, notificationCount);

  harness.setStatus(snapshot(100, 200));
  const advancedAgain = await harness.send({ type: "discord-direct:get-status" });
  for (let index = 0; index < 8; index += 1) await Promise.resolve();
  assert.equal(advancedAgain.routeRevision, initial.routeRevision);
  assert.equal(harness.notifications.length, notificationCount);

  harness.setStatus(snapshot(0, 30));
  const evidenceLost = await harness.send({ type: "discord-direct:get-status" });
  assert.ok(evidenceLost.routeRevision > advancedAgain.routeRevision);
});

test("bound-allocation evidence loss advances revision even while aggregate traffic stays positive", async () => {
  const firstId = "a".repeat(32);
  const secondId = "b".repeat(32);
  const snapshot = (firstQueued) => startedTransport({
    allocationCount: 2,
    allocations: [{
      id: firstId,
      relayAddress: "92.97.232.243",
      relayPort: 62002,
      mappingState: "ready",
      permissions: 1,
      channels: 1,
      peerDatagramsQueued: firstQueued,
      peerDatagramsReceived: 5,
    }, {
      id: secondId,
      relayAddress: "92.97.232.244",
      relayPort: 62003,
      mappingState: "ready",
      permissions: 1,
      channels: 1,
      peerDatagramsQueued: 7,
      peerDatagramsReceived: 8,
    }],
    stats: {
      peerDatagramsQueued: firstQueued + 7,
      peerDatagramsReceived: 13,
    },
  });
  const harness = createHarness({
    stored: {
      directSettingsVersion: 1,
      directEnabled: true,
      mappingProbeServers: tools.DEFAULT_SETTINGS.mappingProbeServers,
    },
    startResult: snapshot(4),
  });
  const initial = await harness.send({ type: "discord-direct:get-status" });

  harness.setStatus(snapshot(0));
  const evidenceLost = await harness.send({ type: "discord-direct:get-status" });
  assert.ok(evidenceLost.backend.peerDatagramsQueued > 0);
  assert.ok(evidenceLost.backend.peerDatagramsReceived > 0);
  assert.ok(evidenceLost.routeRevision > initial.routeRevision);
});

test("settings are available to this extension in either popup or tab form", async () => {
  const harness = createHarness();
  const tabSender = {
    ...harness.sender("popup"),
    tab: { id: 12, url: "moz-extension://test/popup/popup.html" },
  };
  const settings = await harness.send(
    { type: "discord-direct:get-settings" },
    "popup",
    tabSender
  );
  assert.equal(typeof settings.mappingProbeServers, "string");

  const webTabSender = {
    id: harness.browser.runtime.id,
    url: "https://discord.com/channels/@me",
    tab: { id: 7, url: "https://discord.com/channels/@me" },
  };
  await assert.rejects(
    harness.send({ type: "discord-direct:get-settings" }, "popup", webTabSender),
    /extension pages/u
  );
});

test("route changes notify only top-level Discord frames without credentials", async () => {
  const harness = createHarness({
    stored: {
      directSettingsVersion: 1,
      directEnabled: true,
      mappingProbeServers: tools.DEFAULT_SETTINGS.mappingProbeServers,
    },
  });
  await harness.send({ type: "discord-direct:get-status" });
  for (let index = 0; index < 8; index += 1) await Promise.resolve();
  assert.ok(harness.notifications.length >= 2);
  for (const notification of harness.notifications) {
    assert.ok(notification.tabId === 7 || notification.tabId === 8);
    assert.equal(notification.options.frameId, 0);
    assert.equal(notification.message.type, "discord-direct:route-changed");
    const serialized = JSON.stringify(notification);
    assert.doesNotMatch(serialized, /short-lived-user|short-lived-credential|turn:|127\.0\.0\.1/u);
  }
});

test("saving identical settings does not restart the backend", async () => {
  const harness = createHarness({
    stored: {
      directSettingsVersion: 1,
      directEnabled: true,
      mappingProbeServers: tools.DEFAULT_SETTINGS.mappingProbeServers,
    },
  });
  await harness.send({ type: "discord-direct:get-status" });
  assert.equal(harness.startCalls.length, 1);
  const response = await harness.send({
    type: "discord-direct:save-settings",
    settings: {
      enabled: true,
      mappingProbeServers: tools.DEFAULT_SETTINGS.mappingProbeServers,
    },
  });
  assert.equal(response.ok, true);
  assert.equal(harness.startCalls.length, 1);
});

test("saving identical enabled settings retries an unhealthy backend", async () => {
  const failed = { running: false, mode: null, loopbackPreference: false };
  const harness = createHarness({
    stored: {
      directSettingsVersion: 1,
      directEnabled: true,
      mappingProbeServers: tools.DEFAULT_SETTINGS.mappingProbeServers,
    },
    startResult: failed,
  });
  const initial = await harness.send({ type: "discord-direct:get-status" });
  assert.equal(initial.phase, "error");
  assert.equal(harness.startCalls.length, 1);
  harness.setStartResult(startedTransport());
  harness.setStatus(startedTransport());
  const response = await harness.send({
    type: "discord-direct:save-settings",
    settings: {
      enabled: true,
      mappingProbeServers: tools.DEFAULT_SETTINGS.mappingProbeServers,
    },
  });
  assert.equal(response.ok, true);
  assert.equal(response.status.ready, true);
  assert.equal(harness.startCalls.length, 2);
});

test("a stopped backend invalidates the exposed generation and endpoint", async () => {
  const harness = createHarness({
    stored: {
      directSettingsVersion: 1,
      directEnabled: true,
      mappingProbeServers: tools.DEFAULT_SETTINGS.mappingProbeServers,
    },
  });
  const ready = await harness.send({ type: "discord-direct:get-route" }, "discord");
  harness.setStatus({ running: false, mode: null, loopbackPreference: false });
  const failed = await harness.send({ type: "discord-direct:get-route" }, "discord");
  assert.ok(failed.generation > ready.generation);
  assert.equal(failed.ready, false);
  assert.equal(failed.endpoint, null);
  assert.equal(failed.phase, "error");
  assert.equal(failed.reconnectRequired, true);
});

test("fresh route reads wait behind an in-progress enable mutation", async () => {
  const harness = createHarness({
    stored: {
      directSettingsVersion: 1,
      directEnabled: false,
      mappingProbeServers: tools.DEFAULT_SETTINGS.mappingProbeServers,
    },
  });
  const off = await harness.send({ type: "discord-direct:get-status" });
  assert.equal(off.phase, "off");
  const heldSet = harness.holdNextStorageSet();
  const save = harness.send({
    type: "discord-direct:save-settings",
    settings: {
      enabled: true,
      mappingProbeServers: tools.DEFAULT_SETTINGS.mappingProbeServers,
    },
  });
  for (let index = 0; index < 8; index += 1) await Promise.resolve();

  let routeSettled = false;
  const freshRoute = harness.send({ type: "discord-direct:get-route" }, "discord")
    .then((value) => {
      routeSettled = true;
      return value;
    });
  for (let index = 0; index < 8; index += 1) await Promise.resolve();
  assert.equal(routeSettled, false);

  heldSet.resolve();
  const [saved, routeAfterSave] = await Promise.all([save, freshRoute]);
  assert.equal(saved.ok, true);
  assert.equal(routeAfterSave.enabled, true);
  assert.equal(routeAfterSave.ready, true);
  assert.ok(routeAfterSave.generation > off.generation);
});
