"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { webcrypto } = require("node:crypto");

const extensionRoot = path.join(__dirname, "..");
const workerSource = fs.readFileSync(path.join(extensionRoot, "src/service-worker.js"), "utf8");

function event() {
  const listeners = [];
  return {
    addListener(listener) { listeners.push(listener); },
    fire(...args) { for (const listener of [...listeners]) listener(...args); },
    get listeners() { return listeners; },
  };
}

function createNativePort(state) {
  const messages = event();
  const disconnects = event();
  let connected = true;
  const port = {
    onMessage: messages,
    onDisconnect: disconnects,
    postMessage(request) {
      state.commands.push(request.command);
      let result;
      if (request.command === "start") {
        state.active = true;
        result = {
          running: true,
          controlSocketBound: true,
          mode: "remote-mapped",
          port: 49152,
          username: "u-test",
          credential: "test-credential",
          allocationCount: 0,
          allocations: [],
          stats: {},
        };
      } else if (request.command === "status") {
        result = state.backendStatus || {
          running: state.active,
          controlSocketBound: state.active,
          mode: state.active ? "remote-mapped" : null,
          allocationCount: 0,
          allocations: [],
          stats: {},
        };
      } else if (request.command === "stop") {
        state.active = false;
        result = { running: false, controlSocketBound: false, mode: null, stats: {} };
      }
      const respond = () => messages.fire({ id: request.id, ok: true, result });
      if (request.command === "start" && state.startDelayMs > 0) {
        setTimeout(respond, state.startDelayMs);
      } else {
        respond();
      }
    },
    disconnect() {
      if (!connected) return;
      connected = false;
      state.disconnects += 1;
      disconnects.fire();
    },
  };
  return port;
}

function createChrome(initial = {}) {
  const local = { ...(initial.local || {}) };
  let tabs = (initial.tabs || []).map((tab) => ({ ...tab }));
  const messages = event();
  const actionClicks = event();
  const tabCreated = event();
  const tabUpdated = event();
  const tabRemoved = event();
  const installed = event();
  const startup = event();
  const state = {
    local,
    commands: [],
    connects: 0,
    disconnects: 0,
    active: false,
    startDelayMs: 0,
    backendStatus: null,
    actionClicks,
    tabs: {
      onCreated: tabCreated,
      onUpdated: tabUpdated,
      onRemoved: tabRemoved,
      query(query, callback) {
        const result = query && query.url
          ? tabs.filter((tab) => tab.url && tab.url.startsWith("https://discord.com/"))
          : tabs;
        if (typeof callback === "function") { callback(result); return undefined; }
        return Promise.resolve(result);
      },
      sendMessage(_tabId, _message, _options, callback) {
        const done = typeof _options === "function" ? _options : callback;
        if (typeof done === "function") { done(); return undefined; }
        return Promise.resolve();
      },
      replace(values) { tabs = values.map((tab) => ({ ...tab })); },
    },
    messageListeners: messages,
  };
  const chrome = {
    runtime: {
      id: "test-extension",
      lastError: null,
      onMessage: messages,
      onInstalled: installed,
      onStartup: startup,
      connectNative(name) {
        assert.equal(name, "com.ahmadoteng.discord_direct");
        state.connects += 1;
        return createNativePort(state);
      },
    },
    action: {
      onClicked: actionClicks,
      setBadgeBackgroundColor() {},
      setBadgeText() {},
      setTitle() {},
    },
    storage: {
      local: {
        async get() { return { ...local }; },
        async set(values) { Object.assign(local, values); },
      },
    },
    tabs: state.tabs,
  };
  state.chrome = chrome;
  state.setTabs = (values) => { tabs = values.map((tab) => ({ ...tab })); };
  state.fireTabUpdated = (tabId, changeInfo = {}, tab = {}) => tabUpdated.fire(tabId, changeInfo, tab);
  state.fireTabCreated = (tab = {}) => tabCreated.fire(tab);
  state.fireTabRemoved = (tabId) => tabRemoved.fire(tabId, {});
  return state;
}

function loadWorker(initial = {}) {
  const state = createChrome(initial);
  let context;
  context = vm.createContext({
    chrome: state.chrome,
    console,
    URL,
    Promise,
    Uint8Array,
    crypto: webcrypto,
    setTimeout,
    clearTimeout,
    setInterval() { return 1; },
    clearInterval() {},
    importScripts(...scripts) {
      for (const script of scripts) {
        const file = path.join(extensionRoot, "src", script);
        vm.runInContext(fs.readFileSync(file, "utf8"), context, { filename: script });
      }
    },
  });
  vm.runInContext(workerSource, context, { filename: "service-worker.js" });
  state.context = context;
  return state;
}

async function settle() {
  for (let i = 0; i < 10; i += 1) await new Promise((resolve) => setImmediate(resolve));
}

async function getRoute(state) {
  let response;
  state.messageListeners.fire({ type: "discord-voice-relay:get-route" }, {
    id: "test-extension",
    url: "https://discord.com/channels/@me",
    frameId: 0,
  }, (value) => { response = value; });
  await settle();
  return response;
}

test("an enabled preference does not launch the helper until a Discord tab exists", async () => {
  const state = loadWorker({ local: { directEnabled: true } });
  await settle();
  assert.equal(state.connects, 0);
  assert.equal(state.active, false);

  state.setTabs([{ id: 17, url: "https://discord.com/channels/@me" }]);
  state.fireTabUpdated(17, { url: "https://discord.com/channels/@me" }, {
    id: 17,
    url: "https://discord.com/channels/@me",
  });
  await settle();
  assert.equal(state.connects, 1);
  assert.equal(state.commands.includes("start"), true);
  assert.equal(state.active, true);
});

test("the toolbar click toggles the route without opening a popup", async () => {
  const state = loadWorker({ tabs: [{ id: 1, url: "https://discord.com/channels/@me" }] });
  await settle();
  assert.equal(state.connects, 0);
  assert.equal(state.local.directEnabled, undefined);

  state.actionClicks.fire({ id: 1 });
  await settle();
  assert.equal(state.local.directEnabled, true);
  assert.equal(state.active, true);

  state.actionClicks.fire({ id: 1 });
  await settle();
  assert.equal(state.local.directEnabled, false);
  assert.equal(state.active, false);
  assert.equal(state.commands.filter((command) => command === "start").length, 1);
  assert.equal(state.commands.includes("stop"), true);
});

test("enabling with no Discord tab arms the extension but leaves the helper stopped", async () => {
  const state = loadWorker();
  await settle();
  state.actionClicks.fire({});
  await settle();
  assert.equal(state.local.directEnabled, true);
  assert.equal(state.connects, 0);

  state.setTabs([{ id: 2, url: "https://discord.com/app" }]);
  state.fireTabCreated({ id: 2, url: "https://discord.com/app" });
  await settle();
  assert.equal(state.connects, 1);
  assert.equal(state.active, true);
});

test("closing one Discord tab keeps the helper until the last Discord tab closes", async () => {
  const state = loadWorker({
    local: { directEnabled: true },
    tabs: [
      { id: 1, url: "https://discord.com/channels/@me" },
      { id: 2, url: "https://discord.com/app" },
    ],
  });
  await settle();
  assert.equal(state.active, true);
  assert.equal(state.connects, 1);

  state.setTabs([{ id: 2, url: "https://discord.com/app" }]);
  state.fireTabRemoved(1);
  await settle();
  assert.equal(state.active, true);
  assert.equal(state.commands.includes("stop"), false);

  state.setTabs([]);
  state.fireTabRemoved(2);
  await settle();
  assert.equal(state.active, false);
  assert.equal(state.commands.includes("stop"), true);
  assert.equal(state.disconnects, 1);
});

test("redundant tab updates during helper start do not rotate the active route generation", async () => {
  const state = loadWorker({ local: { directEnabled: true } });
  await settle();
  state.startDelayMs = 25;
  const discordTab = { id: 31, url: "https://discord.com/channels/@me" };
  state.setTabs([discordTab]);
  state.fireTabUpdated(31, { url: discordTab.url }, discordTab);
  state.fireTabUpdated(31, { status: "loading" }, discordTab);
  state.fireTabUpdated(31, { status: "complete" }, discordTab);
  await new Promise((resolve) => setTimeout(resolve, 60));
  await settle();

  const beforeAllocation = await getRoute(state);
  assert.equal(beforeAllocation.ready, true);
  assert.equal(state.connects, 1);

  state.backendStatus = {
    running: true,
    controlSocketBound: true,
    mode: "remote-mapped",
    allocationCount: 1,
    allocations: [{
      id: "a".repeat(32),
      relayAddress: "203.0.113.10",
      relayPort: 50000,
      mappingState: "ready",
      permissions: 0,
      channels: 0,
      peerDatagramsQueued: 0,
      peerDatagramsReceived: 0,
    }],
    stats: { allocationsCreated: 1 },
  };
  const afterAllocation = await getRoute(state);
  assert.equal(afterAllocation.ready, true);
  assert.equal(afterAllocation.generation, beforeAllocation.generation);
  assert.ok(afterAllocation.routeRevision > beforeAllocation.routeRevision);
});

test("a non-Discord tab never starts the helper", async () => {
  const state = loadWorker({
    local: { directEnabled: true },
    tabs: [{ id: 4, url: "https://example.com/" }],
  });
  await settle();
  assert.equal(state.connects, 0);
  assert.equal(state.active, false);
});

test("route access is limited to a top-level Discord document", async () => {
  const state = loadWorker({
    local: { directEnabled: true },
    tabs: [{ id: 1, url: "https://discord.com/channels/@me" }],
  });
  await settle();
  let response;
  state.messageListeners.fire({ type: "discord-voice-relay:get-route" }, {
    id: "test-extension",
    url: "https://example.com/",
    frameId: 0,
  }, (value) => { response = value; });
  await settle();
  assert.equal(response.ok, false);

  state.messageListeners.fire({ type: "discord-voice-relay:get-route" }, {
    id: "test-extension",
    url: "https://discord.com/channels/@me",
    frameId: 0,
  }, (value) => { response = value; });
  await settle();
  assert.equal(response.ready, true);
  assert.equal(response.mode, "local");
  assert.match(response.endpoint.urls[0], /^turn:127\.0\.0\.1:/u);
});
