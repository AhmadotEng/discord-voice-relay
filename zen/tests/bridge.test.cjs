"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const { webcrypto } = require("node:crypto");

const bridgeSource = fs.readFileSync(path.resolve(__dirname, "../src/bridge.js"), "utf8");

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

function createHarness(routePromises = []) {
  const windowListeners = [];
  const runtimeListeners = [];
  const posted = [];
  const routeRequests = [];
  const browser = {
    runtime: {
      sendMessage(message) {
        routeRequests.push(message);
        const next = routePromises.shift();
        return next ? next.promise : Promise.reject(new Error("no route response"));
      },
      onMessage: {
        addListener(listener) { runtimeListeners.push(listener); },
      },
    },
  };
  const pageWindow = {
    location: { origin: "https://discord.com" },
    postMessage(message, origin) { posted.push({ message, origin }); },
    addEventListener(type, listener) {
      if (type === "message") windowListeners.push(listener);
    },
  };
  pageWindow.top = pageWindow;
  pageWindow.self = pageWindow;
  const context = vm.createContext({
    browser,
    crypto: webcrypto,
    window: pageWindow,
    setTimeout,
    clearTimeout,
    __windowListeners: windowListeners,
  });
  vm.runInContext(`
    globalThis.__deliver = function (data, origin = window.location.origin) {
      for (const listener of globalThis.__windowListeners) {
        listener({ source: window, origin, data });
      }
    };
  `, context);
  vm.runInContext(bridgeSource, context, { filename: "bridge.js" });
  return { context, browser, posted, routeRequests, runtimeListeners };
}

test("bridge installs in Firefox's isolated sandbox where globalThis differs from window", () => {
  const harness = createHarness([]);
  assert.equal(vm.runInContext("globalThis === window", harness.context), false);
  assert.equal(vm.runInContext("window.top === window", harness.context), true);
  assert.equal(harness.runtimeListeners.length, 1);
  assert.equal(harness.posted[0].message.type, "bridge-ready");
  assert.match(harness.posted[0].message.bridgeInstanceId, /^[a-f0-9]{32}$/u);
});

async function flush() {
  for (let index = 0; index < 8; index += 1) await Promise.resolve();
}

test("page status starts unconfirmed when no MAIN-world hook has supplied a token", async () => {
  const harness = createHarness([]);
  const status = await harness.runtimeListeners[0]({ type: "discord-direct:get-page-status" });
  assert.equal(status.phase, "hook-unconfirmed");
  assert.equal(status.targetedConnections, 0);
});

test("the first page-status read waits briefly for the MAIN-world hook roundtrip", async () => {
  const response = deferred();
  const harness = createHarness([response]);
  const token = "f".repeat(32);
  harness.context.__deliver({
    channel: "discord-direct-zen:v1",
    direction: "page-to-extension",
    token,
    type: "route-request",
  });
  response.resolve(route(1));
  await flush();

  const pending = harness.runtimeListeners[0]({ type: "discord-direct:get-page-status" });
  assert.equal(harness.posted.at(-1).message.type, "get-status");
  const statusRequestId = harness.posted.at(-1).message.statusRequestId;
  assert.ok(Number.isSafeInteger(statusRequestId));
  harness.context.__deliver({
    channel: "discord-direct-zen:v1",
    direction: "page-to-extension",
    token,
    type: "status",
    bridgeInstanceId: harness.posted[0].message.bridgeInstanceId,
    statusRequestId,
    status: { phase: "hook-ready", generation: 1 },
  });
  assert.equal((await pending).phase, "hook-ready");
});

function route(generation) {
  return {
    bootId: "b".repeat(32),
    enabled: true,
    ready: true,
    phase: "ready",
    generation,
    endpoint: {
      turnUrl: `turn:127.0.0.1:${50000 + generation}?transport=udp`,
      username: `user-${generation}`,
      credential: `credential-${generation}`,
    },
    backend: {
      running: true,
      loopbackPreference: true,
      mode: "remote-mapped",
    },
  };
}

test("bridge-ready contains no credentials and route-change notifications trigger a direct fetch", async () => {
  const oldResponse = deferred();
  const newResponse = deferred();
  const harness = createHarness([oldResponse, newResponse]);
  assert.equal(harness.posted[0].message.channel, "discord-direct-zen:v1");
  assert.equal(harness.posted[0].message.direction, "extension-to-page");
  assert.equal(harness.posted[0].message.type, "bridge-ready");
  assert.equal(JSON.stringify(harness.posted[0]).includes("credential"), false);

  const token = "a".repeat(32);
  harness.context.__deliver({
    channel: "discord-direct-zen:v1",
    direction: "page-to-extension",
    token,
    type: "route-request",
    requestId: 7,
  });
  assert.equal(harness.routeRequests.length, 1);
  harness.runtimeListeners[0]({ type: "discord-direct:route-changed", generation: 2 });
  assert.equal(harness.routeRequests.length, 2);
  assert.equal(JSON.stringify({ type: "discord-direct:route-changed", generation: 2 }).includes("credential"), false);

  newResponse.resolve(route(2));
  await flush();
  oldResponse.resolve(route(1));
  await flush();
  const deliveredRoutes = harness.posted.filter((entry) => entry.message.type === "route");
  assert.equal(deliveredRoutes.length, 2);
  const notificationRoute = deliveredRoutes.find((entry) => entry.message.requestId === undefined);
  const freshResponse = deliveredRoutes.find((entry) => entry.message.requestId === 7);
  assert.equal(notificationRoute.message.route.generation, 2);
  assert.equal(freshResponse.message.route.generation, 1);
  assert.equal(freshResponse.message.token, token);
  assert.equal(freshResponse.message.bridgeInstanceId,
    harness.posted[0].message.bridgeInstanceId);
});

test("page status is schema-limited before popup retrieval", async () => {
  const response = deferred();
  const harness = createHarness([response]);
  const token = "b".repeat(32);
  harness.context.__deliver({
    channel: "discord-direct-zen:v1",
    direction: "page-to-extension",
    token,
    type: "route-request",
  });
  response.resolve(route(1));
  await flush();

  harness.context.__deliver({
    channel: "discord-direct-zen:v1",
    direction: "page-to-extension",
    token,
    type: "status",
    bridgeInstanceId: harness.posted[0].message.bridgeInstanceId,
    status: {
      phase: "verified",
      targetedConnections: 1,
      currentConnectionId: 1,
      generation: 1,
      routeRevision: 7,
      applied: true,
      verified: true,
      selectedCandidate: {
        type: "relay",
        protocol: "udp",
        relayProtocol: "udp",
        candidate: "candidate:secret 127.0.0.1",
      },
      credential: "must-not-cross",
      sdp: "must-not-cross",
    },
  });
  const pending = harness.runtimeListeners[0]({ type: "discord-direct:get-page-status" });
  const statusRequestId = harness.posted.at(-1).message.statusRequestId;
  harness.context.__deliver({
    channel: "discord-direct-zen:v1",
    direction: "page-to-extension",
    token,
    type: "status",
    bridgeInstanceId: harness.posted[0].message.bridgeInstanceId,
    statusRequestId,
    status: {
      phase: "verified",
      targetedConnections: 1,
      currentConnectionId: 1,
      generation: 1,
      routeRevision: 7,
      applied: true,
      verified: true,
      selectedCandidate: {
        type: "relay",
        protocol: "udp",
        relayProtocol: "udp",
        candidate: "candidate:secret 127.0.0.1",
      },
      credential: "must-not-cross",
      sdp: "must-not-cross",
    },
  });
  const status = await pending;
  assert.equal(status.verified, true);
  assert.equal(status.routeRevision, 7);
  assert.equal(status.selectedCandidate.type, "relay");
  assert.equal(status.selectedCandidate.protocol, "udp");
  assert.equal(status.selectedCandidate.relayProtocol, "udp");
  const serialized = JSON.stringify(status);
  assert.doesNotMatch(serialized, /must-not-cross|candidate:|127\.0\.0\.1/u);
});

test("wrong origin, direction, and token cannot update the isolated status", async () => {
  const response = deferred();
  const harness = createHarness([response]);
  const token = "c".repeat(32);
  harness.context.__deliver({
    channel: "discord-direct-zen:v1",
    direction: "page-to-extension",
    token,
    type: "route-request",
  });
  response.resolve(route(1));
  await flush();
  harness.context.__deliver({
    channel: "discord-direct-zen:v1",
    direction: "page-to-extension",
    token: "d".repeat(32),
    type: "status",
    bridgeInstanceId: harness.posted[0].message.bridgeInstanceId,
    status: { phase: "verified", verified: true },
  });
  const pending = harness.runtimeListeners[0]({ type: "discord-direct:get-page-status" });
  const statusRequestId = harness.posted.at(-1).message.statusRequestId;
  harness.context.__deliver({
    channel: "discord-direct-zen:v1",
    direction: "page-to-extension",
    token,
    type: "status",
    bridgeInstanceId: harness.posted[0].message.bridgeInstanceId,
    statusRequestId,
    status: { phase: "hook-ready", verified: false },
  });
  const status = await pending;
  assert.equal(status.verified, false);
});

test("page-status reads settle only from their matching correlated response", async () => {
  const response = deferred();
  const harness = createHarness([response]);
  const token = "1".repeat(32);
  harness.context.__deliver({
    channel: "discord-direct-zen:v1",
    direction: "page-to-extension",
    token,
    type: "route-request",
  });
  response.resolve(route(1));
  await flush();
  harness.context.__deliver({
    channel: "discord-direct-zen:v1",
    direction: "page-to-extension",
    token,
    type: "status",
    bridgeInstanceId: harness.posted[0].message.bridgeInstanceId,
    status: { phase: "verified", verified: true },
  });

  let settled = false;
  const pending = harness.runtimeListeners[0]({ type: "discord-direct:get-page-status" });
  pending.then(() => { settled = true; });
  const statusRequestId = harness.posted.at(-1).message.statusRequestId;
  harness.context.__deliver({
    channel: "discord-direct-zen:v1",
    direction: "page-to-extension",
    token,
    type: "status",
    bridgeInstanceId: harness.posted[0].message.bridgeInstanceId,
    status: { phase: "verified", verified: true },
  });
  harness.context.__deliver({
    channel: "discord-direct-zen:v1",
    direction: "page-to-extension",
    token,
    type: "status",
    bridgeInstanceId: harness.posted[0].message.bridgeInstanceId,
    statusRequestId: statusRequestId + 1,
    status: { phase: "verified", verified: true },
  });
  harness.context.__deliver({
    channel: "discord-direct-zen:v1",
    direction: "page-to-extension",
    token,
    type: "status",
    bridgeInstanceId: "0".repeat(32),
    statusRequestId,
    status: { phase: "verified", verified: true },
  });
  await flush();
  assert.equal(settled, false);

  harness.context.__deliver({
    channel: "discord-direct-zen:v1",
    direction: "page-to-extension",
    token,
    type: "status",
    bridgeInstanceId: harness.posted[0].message.bridgeInstanceId,
    statusRequestId,
    status: { phase: "connection-state", verified: false },
  });
  const status = await pending;
  assert.equal(status.phase, "connection-state");
  assert.equal(status.verified, false);
});

test("a missing correlated page response times out fail-closed instead of returning cached green", async () => {
  const response = deferred();
  const harness = createHarness([response]);
  const token = "2".repeat(32);
  harness.context.__deliver({
    channel: "discord-direct-zen:v1",
    direction: "page-to-extension",
    token,
    type: "route-request",
  });
  response.resolve(route(1));
  await flush();
  harness.context.__deliver({
    channel: "discord-direct-zen:v1",
    direction: "page-to-extension",
    token,
    type: "status",
    bridgeInstanceId: harness.posted[0].message.bridgeInstanceId,
    status: {
      phase: "verified",
      currentConnectionId: 1,
      applied: true,
      verified: true,
      selectedCandidate: { type: "relay", protocol: "udp" },
    },
  });

  const status = await harness.runtimeListeners[0]({ type: "discord-direct:get-page-status" });
  assert.equal(status.phase, "bridge-unavailable");
  assert.equal(status.verified, false);
  assert.equal(status.applied, false);
  assert.equal(status.selectedCandidate, null);
  assert.equal(status.reconnectRequired, true);
  assert.equal(status.errorCode, "bridge-unavailable");
});

test("an explicit background fetch error is marked fail-closed", async () => {
  const harness = createHarness([]);
  const token = "e".repeat(32);
  harness.context.__deliver({
    channel: "discord-direct-zen:v1",
    direction: "page-to-extension",
    token,
    type: "route-request",
    requestId: 11,
  });
  await flush();
  const response = harness.posted.find((entry) =>
    entry.message.type === "route" && entry.message.requestId === 11
  );
  assert.ok(response);
  assert.equal(response.message.responseOk, false);
  assert.equal(response.message.route.enabled, true);
  assert.equal(response.message.route.phase, "error");
});
