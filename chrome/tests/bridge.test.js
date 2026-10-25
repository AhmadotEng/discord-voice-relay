"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const bridgeSource = fs.readFileSync(path.join(__dirname, "../src/bridge.js"), "utf8");

function route(overrides = {}) {
  return {
    bootId: "a".repeat(32),
    enabled: true,
    ready: true,
    phase: "ready",
    mode: "local",
    generation: 1,
    routeRevision: 1,
    userDisabled: false,
    reconnectRequired: false,
    errorCode: null,
    backend: { running: true, controlSocketBound: true, mode: "remote-mapped" },
    endpoint: {
      urls: ["turn:127.0.0.1:49152?transport=udp"],
      username: "ephemeral-user",
      credential: "ephemeral-credential"
    },
    ...overrides
  };
}

async function runBridge(options = {}) {
  const listeners = new Map();
  const posted = [];
  let runtimeListener;
  const fakeWindow = {
    location: { origin: "https://discord.com" },
    postMessage(message) {
      posted.push(message);
    },
    addEventListener(type, listener) {
      listeners.set(type, listener);
    }
  };
  fakeWindow.top = fakeWindow;
  const browser = {
    runtime: {
      id: "test-extension",
      lastError: null,
      sendMessage(message) {
        if (options.routeError) {
          return Promise.reject(new Error("route unavailable"));
        }
        if (message.type === "discord-voice-relay:get-route") {
          return Promise.resolve(options.route || route());
        }
        return Promise.resolve({});
      },
      onMessage: {
        addListener(listener) {
          runtimeListener = listener;
        }
      }
    }
  };

  const context = vm.createContext({
    window: fakeWindow,
    chrome: browser,
    console,
    Promise,
    Uint8Array,
    crypto: require("node:crypto").webcrypto,
    setTimeout,
    clearTimeout
  });
  vm.runInContext(bridgeSource, context, { filename: "bridge.js" });
  await new Promise((resolve) => setImmediate(resolve));
  return { fakeWindow, listeners, posted, runtimeListener, context };
}

test("bridge announces itself to the page on load", async () => {
  const bridge = await runBridge();
  const ready = bridge.posted.find((message) => message.type === "bridge-ready");
  assert.ok(ready);
  assert.equal(ready.direction, "extension-to-page");
  assert.equal(ready.channel, "discord-voice-relay-chrome:v1");
});

test("bridge answers a page route request with the background route", async () => {
  const bridge = await runBridge();
  const token = "c".repeat(32);

  bridge.listeners.get("message")({
    source: bridge.fakeWindow,
    origin: "https://discord.com",
    data: {
      channel: "discord-voice-relay-chrome:v1",
      direction: "page-to-extension",
      type: "route-request",
      token
    }
  });
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));

  const response = bridge.posted.find((message) => message.type === "route");
  assert.ok(response, "the bridge must answer with a route");
  assert.equal(response.responseOk, true);
  assert.equal(response.route.ready, true);
  assert.deepEqual(response.route.endpoint.urls, ["turn:127.0.0.1:49152?transport=udp"]);
  assert.equal(response.token, token);
});

test("bridge reports an unavailable route instead of hanging", async () => {
  const bridge = await runBridge({ routeError: true });
  const token = "d".repeat(32);
  bridge.listeners.get("message")({
    source: bridge.fakeWindow,
    origin: "https://discord.com",
    data: {
      channel: "discord-voice-relay-chrome:v1",
      direction: "page-to-extension",
      type: "route-request",
      token
    }
  });
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));

  const response = bridge.posted.find((message) => message.type === "route");
  assert.ok(response);
  assert.equal(response.responseOk, false);
  assert.equal(response.route.ready, false);
  assert.equal(response.route.endpoint, null);
});

test("bridge returns the sanitized page status to the extension", async () => {
  const bridge = await runBridge();
  const token = "e".repeat(32);
  const ready = bridge.posted.find((message) => message.type === "bridge-ready");
  // The page hook claims the bridge with a route request first.
  bridge.listeners.get("message")({
    source: bridge.fakeWindow,
    origin: "https://discord.com",
    data: {
      channel: "discord-voice-relay-chrome:v1",
      direction: "page-to-extension",
      type: "route-request",
      token
    }
  });
  bridge.listeners.get("message")({
    source: bridge.fakeWindow,
    origin: "https://discord.com",
    data: {
      channel: "discord-voice-relay-chrome:v1",
      direction: "page-to-extension",
      type: "status",
      token,
      bridgeInstanceId: ready.bridgeInstanceId,
      status: {
        phase: "verified",
        selectedCandidate: { type: "relay", protocol: "udp", relayProtocol: "udp" },
        applied: true,
        verified: true,
        relayCount: 1
      }
    }
  });

  let status;
  const keepChannelOpen = bridge.runtimeListener(
    { type: "discord-voice-relay:get-page-status" },
    {},
    (response) => { status = response; }
  );
  assert.equal(keepChannelOpen, true);
  await new Promise((resolve) => setImmediate(resolve));
  // The bridge asks the page for a fresh status and waits for the answer.
  const ask = bridge.posted.filter((message) => message.type === "get-status").at(-1);
  assert.ok(ask, "the bridge must ask the page for a status");
  bridge.listeners.get("message")({
    source: bridge.fakeWindow,
    origin: "https://discord.com",
    data: {
      channel: "discord-voice-relay-chrome:v1",
      direction: "page-to-extension",
      type: "status",
      token,
      bridgeInstanceId: ready.bridgeInstanceId,
      statusRequestId: ask.statusRequestId,
      status: {
        phase: "verified",
        selectedCandidate: { type: "relay", protocol: "udp", relayProtocol: "udp" },
        applied: true,
        verified: true,
        relayCount: 1
      }
    }
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(status.phase, "verified");
  assert.equal(status.verified, true);
  assert.equal(status.selectedCandidate.type, "relay");
  assert.equal(status.relayCount, 1);
});

test("bridge ignores status messages from another document", async () => {
  const bridge = await runBridge();
  const token = "f".repeat(32);
  bridge.listeners.get("message")({
    source: bridge.fakeWindow,
    origin: "https://discord.com",
    data: {
      channel: "discord-voice-relay-chrome:v1",
      direction: "page-to-extension",
      type: "status",
      token,
      bridgeInstanceId: "f".repeat(32),
      status: { phase: "verified", verified: true }
    }
  });
  let status;
  bridge.runtimeListener(
    { type: "discord-voice-relay:get-page-status" },
    {},
    (response) => { status = response; }
  );
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(status.phase, "hook-unconfirmed");
});
