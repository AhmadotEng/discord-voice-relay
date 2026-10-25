"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const configSource = fs.readFileSync(path.join(__dirname, "../src/relay-config.js"), "utf8");
const popupSource = fs.readFileSync(path.join(__dirname, "../popup/popup.js"), "utf8");

async function renderStatus(status) {
  const elements = new Map();
  for (const id of [
    "#settings-form", "#enabled", "#turn-urls", "#turn-username", "#turn-credential",
    "#tcp-only", "#disclosure-accepted", "#validation", "#save", "#status-dot",
    "#status-title", "#status-detail"
  ]) {
    elements.set(id, {
      addEventListener() {},
      checked: false,
      value: "",
      hidden: true,
      disabled: false,
      className: "",
      textContent: ""
    });
  }

  const browser = {
    storage: {
      local: {
        async get(defaults) {
          return {
            ...defaults,
            enabled: true,
            turnUrls: "turns:relay.example:443?transport=tcp",
            turnUsername: "alice",
            turnCredential: "secret"
          };
        },
        async set() {},
        async remove() {}
      },
      session: {
        async get(defaults) {
          return { ...defaults, turnCredential: "secret" };
        },
        async set() {}
      }
    },
    tabs: {
      async query() {
        return [{ id: 1, url: "https://discord.com/channels/@me" }];
      },
      async sendMessage() {
        return status;
      }
    },
    runtime: { lastError: null }
  };
  const context = vm.createContext({
    URL,
    URLSearchParams,
    document: { querySelector(selector) { return elements.get(selector); } },
    chrome: browser,
    console,
    setTimeout
  });
  vm.runInContext(configSource, context, { filename: "relay-config.js" });
  vm.runInContext(popupSource, context, { filename: "popup.js" });
  await new Promise((resolve) => setImmediate(resolve));
  return elements;
}

test("popup reports success only for a connected selected relay candidate", async () => {
  const gatheredOnly = await renderStatus({
    phase: "candidate",
    applied: true,
    relayCount: 1,
    iceConnectionState: "checking",
    connectionState: "connecting",
    gatheredCandidate: { type: "relay", protocol: "udp" },
    selectedCandidate: null,
    error: null
  });
  assert.equal(gatheredOnly.get("#status-title").textContent, "Relay enforced—not connected yet");

  const selected = await renderStatus({
    phase: "connected",
    applied: true,
    relayCount: 1,
    iceConnectionState: "connected",
    connectionState: "connected",
    selectedCandidate: { type: "relay", protocol: "udp", relayProtocol: "tls" },
    error: null
  });
  assert.equal(selected.get("#status-title").textContent, "Voice is using the relay");
});

test("popup lets a failed state override stale selected-candidate data", async () => {
  const failed = await renderStatus({
    phase: "ice-state",
    applied: true,
    relayCount: 1,
    iceConnectionState: "failed",
    connectionState: "connected",
    selectedCandidate: { type: "relay", protocol: "udp", relayProtocol: "tls" },
    error: null
  });
  assert.equal(failed.get("#status-title").textContent, "Relay connection failed");
});
