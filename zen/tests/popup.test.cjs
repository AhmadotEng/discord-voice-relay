"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const popupSource = fs.readFileSync(path.resolve(__dirname, "../popup/popup.js"), "utf8");

async function flush() {
  for (let index = 0; index < 20; index += 1) await Promise.resolve();
}

function createNode() {
  return {
    textContent: "",
    value: "",
    checked: false,
    disabled: false,
    className: "",
    classList: {
      toggle() {},
      add() {},
    },
    addEventListener() {},
  };
}

async function runPopup({ activeTab, discordTabs, statuses }) {
  const nodes = new Map();
  const sentTabs = [];
  const statusById = new Map(statuses);
  const document = {
    querySelector(selector) {
      if (!nodes.has(selector)) nodes.set(selector, createNode());
      return nodes.get(selector);
    },
  };
  const browser = {
    runtime: {
      async sendMessage(message) {
        if (message.type === "discord-direct:get-settings") {
          return { enabled: true, mappingProbeServers: "stun:a.example\nstun:b.example" };
        }
        if (message.type === "discord-direct:get-status") {
          return {
            enabled: true,
            ready: true,
            phase: "ready",
            bootId: "a".repeat(32),
            generation: 1,
          };
        }
        return { ok: true };
      },
    },
    tabs: {
      async query(query) {
        return query.active ? [activeTab] : discordTabs;
      },
      async sendMessage(tabId) {
        sentTabs.push(tabId);
        const value = statusById.get(tabId);
        if (value instanceof Error) throw value;
        return value;
      },
    },
  };
  const context = vm.createContext({
    browser,
    document,
    setInterval() {},
    __discordDirectTools: {
      DEFAULT_SETTINGS: { mappingProbeServers: "stun:a.example\nstun:b.example" },
      validateSettings(value) { return { errors: [], settings: value }; },
    },
    __discordDirectPopupStatus: {
      presentation(_transport, page) {
        return { title: page ? page.phase : "none", detail: "", tone: "" };
      },
    },
  });
  vm.runInContext(popupSource, context, { filename: "popup.js" });
  await flush();
  return {
    sentTabs,
    title: nodes.get("#status-title").textContent,
  };
}

test("the active Discord tab is authoritative over a hidden connected tab", async () => {
  const result = await runPopup({
    activeTab: { id: 1, url: "https://discord.com/channels/@me" },
    discordTabs: [
      { id: 1, url: "https://discord.com/channels/@me", lastAccessed: 1 },
      { id: 2, url: "https://discord.com/channels/hidden", lastAccessed: 2 },
    ],
    statuses: [
      [1, { phase: "hook-ready", targetedConnections: 0 }],
      [2, { phase: "verified", targetedConnections: 1 }],
    ],
  });
  assert.deepEqual(result.sentTabs, [1]);
  assert.equal(result.title, "hook-ready");
});

test("a failed active Discord bridge cannot fall through to a hidden green tab", async () => {
  const result = await runPopup({
    activeTab: { id: 1, url: "https://discord.com/channels/@me" },
    discordTabs: [
      { id: 1, url: "https://discord.com/channels/@me" },
      { id: 2, url: "https://discord.com/channels/hidden" },
    ],
    statuses: [
      [1, new Error("no receiver")],
      [2, { phase: "verified", targetedConnections: 1 }],
    ],
  });
  assert.deepEqual(result.sentTabs, [1]);
  assert.equal(result.title, "bridge-unavailable");
});

test("a tab-form options page may use the most recent connected Discord tab", async () => {
  const result = await runPopup({
    activeTab: { id: 9, url: "moz-extension://test/popup/popup.html" },
    discordTabs: [
      { id: 1, url: "https://discord.com/channels/old", lastAccessed: 1 },
      { id: 2, url: "https://discord.com/channels/recent", lastAccessed: 2 },
    ],
    statuses: [
      [1, { phase: "hook-ready", targetedConnections: 0 }],
      [2, { phase: "verified", targetedConnections: 1 }],
    ],
  });
  assert.deepEqual(result.sentTabs, [2]);
  assert.equal(result.title, "verified");
});
