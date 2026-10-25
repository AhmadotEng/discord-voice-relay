"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const bridgeSource = fs.readFileSync(path.join(__dirname, "../src/bridge.js"), "utf8");

async function runBridge(settings) {
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
  const browser = {
    storage: {
      local: {
        async get(defaults) {
          return { ...defaults, ...settings };
        }
      },
      onChanged: { addListener() {} }
    },
    runtime: {
      lastError: null,
      sendMessage(message, callback) {
        if (message.type === "get-relay-settings") {
          callback({ ...settings });
        }
      },
      onMessage: {
        addListener(listener) {
          runtimeListener = listener;
        }
      }
    }
  };

  vm.runInNewContext(bridgeSource, { window: fakeWindow, chrome: browser, console, Promise }, {
    filename: "bridge.js"
  });
  await new Promise((resolve) => setImmediate(resolve));
  return { fakeWindow, listeners, posted, runtimeListener };
}

test("bridge withholds stored credentials from Discord while disabled", async () => {
  const bridge = await runBridge({
    enabled: false,
    turnUrls: "turns:relay.example:443?transport=tcp",
    turnUsername: "alice",
    turnCredential: "secret"
  });
  const config = bridge.posted.find((message) => message.type === "config");
  assert.equal(config.settings.turnUsername, "");
  assert.equal(config.settings.turnCredential, "");
});

test("bridge supplies client credentials only when explicitly enabled", async () => {
  const bridge = await runBridge({
    enabled: true,
    turnUrls: "turns:relay.example:443?transport=tcp",
    turnUsername: "alice",
    turnCredential: "secret"
  });
  const config = bridge.posted.find((message) => message.type === "config");
  assert.equal(config.settings.turnUsername, "alice");
  assert.equal(config.settings.turnCredential, "secret");

  bridge.listeners.get("message")({
    source: bridge.fakeWindow,
    origin: "https://discord.com",
    data: {
      channel: "discord-voice-relay-chrome:v1",
      direction: "page-to-extension",
      type: "status",
      status: { phase: "connected", selectedCandidate: { type: "relay" } }
    }
  });
  let status;
  const keepChannelOpen = bridge.runtimeListener(
    { type: "get-live-status" },
    {},
    (response) => { status = response; }
  );
  assert.equal(keepChannelOpen, false);
  assert.equal(status.phase, "connected");
});
