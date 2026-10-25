"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const configSource = fs.readFileSync(path.join(__dirname, "../src/relay-config.js"), "utf8");
const hookSource = fs.readFileSync(path.join(__dirname, "../src/page-hook.js"), "utf8");

function makePage() {
  const pageListeners = new Map();
  const posted = [];

  class FakePeerConnection extends EventTarget {
    constructor(configuration) {
      super();
      this.constructorArgumentCount = arguments.length;
      this.configuration = configuration;
      this.iceConnectionState = "new";
      this.connectionState = "new";
      this.localDescription = null;
      this.remoteDescription = null;
    }

    setConfiguration(configuration) {
      this.configuration = configuration;
    }

    getConfiguration() {
      return this.configuration;
    }

    async getStats() {
      return new Map();
    }
  }

  const context = vm.createContext({
    URL,
    URLSearchParams,
    EventTarget,
    RTCPeerConnection: FakePeerConnection,
    location: { origin: "https://discord.com" },
    postMessage(message) {
      posted.push(message);
    },
    addEventListener(type, listener) {
      pageListeners.set(type, listener);
    },
    setTimeout,
    console
  });

  vm.runInContext(configSource, context, { filename: "relay-config.js" });
  vm.runInContext(hookSource, context, { filename: "page-hook.js" });
  const pageGlobal = vm.runInContext("globalThis", context);

  return {
    context,
    posted,
    configure(settings) {
      pageListeners.get("message")({
        source: pageGlobal,
        origin: "https://discord.com",
        data: {
          channel: "discord-voice-relay-chrome:v1",
          direction: "extension-to-page",
          type: "config",
          settings
        }
      });
    }
  };
}

test("page hook relays Discord network PCs but leaves no-argument loopback PCs alone", () => {
  const page = makePage();
  page.configure({
    enabled: true,
    turnUrls: "turns:relay.example:443?transport=tcp",
    turnUsername: "user",
    turnCredential: "credential",
    tcpOnly: true
  });

  const loopback = new page.context.RTCPeerConnection();
  assert.equal(loopback.configuration, undefined);
  assert.equal(loopback.constructorArgumentCount, 0);

  const network = new page.context.RTCPeerConnection({
    bundlePolicy: "max-bundle",
    sdpSemantics: "unified-plan"
  });
  assert.equal(network.configuration.iceTransportPolicy, "relay");
  assert.deepEqual(Array.from(network.configuration.iceServers[0].urls), [
    "turns:relay.example:443?transport=tcp"
  ]);

  network.setConfiguration({ sdpSemantics: "plan-b" });
  assert.equal(network.configuration.iceTransportPolicy, "relay");
  assert.equal(network.configuration.iceServers[0].username, "user");

  const applied = page.posted.find((item) => item.status && item.status.phase === "relay-applied");
  assert.ok(applied);
  assert.equal(applied.status.targetedConnections, 1);
});

test("applies saved settings to a network PC created before storage responds", () => {
  const page = makePage();
  const network = new page.context.RTCPeerConnection({ sdpSemantics: "unified-plan" });
  assert.equal(network.configuration.iceTransportPolicy, undefined);

  page.configure({
    enabled: true,
    turnUrls: "turns:relay.example:443?transport=tcp",
    turnUsername: "user",
    turnCredential: "credential",
    tcpOnly: true
  });

  assert.equal(network.configuration.iceTransportPolicy, "relay");
});

test("targets an initially empty PC when Discord later supplies its network configuration", () => {
  const page = makePage();
  page.configure({
    enabled: true,
    turnUrls: "turns:relay.example:443?transport=tcp",
    turnUsername: "user",
    turnCredential: "credential",
    tcpOnly: true
  });

  const network = new page.context.RTCPeerConnection({});
  network.setConfiguration({ bundlePolicy: "max-bundle" });
  assert.equal(network.configuration.iceTransportPolicy, "relay");
});

test("distinguishes gathered candidates from the selected relay and clears stale success", async () => {
  const page = makePage();
  page.configure({
    enabled: true,
    turnUrls: "turns:relay.example:443?transport=tcp",
    turnUsername: "user",
    turnCredential: "credential",
    tcpOnly: true
  });
  const network = new page.context.RTCPeerConnection({ bundlePolicy: "max-bundle" });

  const candidateEvent = new Event("icecandidate");
  Object.defineProperty(candidateEvent, "candidate", {
    value: { candidate: "candidate:1 1 UDP 1 203.0.113.5 50000 typ relay" }
  });
  network.dispatchEvent(candidateEvent);
  let status = page.posted.at(-1).status;
  assert.equal(status.gatheredCandidate.type, "relay");
  assert.equal(status.selectedCandidate, null);

  network.getStats = async () => new Map([
    ["transport", { type: "transport", selectedCandidatePairId: "pair" }],
    ["pair", { type: "candidate-pair", localCandidateId: "local" }],
    ["local", { type: "local-candidate", candidateType: "relay", protocol: "udp", relayProtocol: "tls" }]
  ]);
  network.iceConnectionState = "connected";
  network.dispatchEvent(new Event("iceconnectionstatechange"));
  await new Promise((resolve) => setImmediate(resolve));
  status = page.posted.at(-1).status;
  assert.equal(status.selectedCandidate.type, "relay");
  assert.equal(status.selectedCandidate.relayProtocol, "tls");

  network.iceConnectionState = "failed";
  network.dispatchEvent(new Event("iceconnectionstatechange"));
  status = page.posted.at(-1).status;
  assert.equal(status.selectedCandidate, null);
});

test("retries selected-candidate diagnostics while Chrome finishes its stats report", async () => {
  const page = makePage();
  page.configure({
    enabled: true,
    turnUrls: "turns:relay.example:443?transport=tcp",
    turnUsername: "user",
    turnCredential: "credential",
    tcpOnly: true
  });
  const network = new page.context.RTCPeerConnection({ bundlePolicy: "max-bundle" });
  let calls = 0;
  network.getStats = async () => {
    calls += 1;
    if (calls === 1) {
      return new Map();
    }
    return new Map([
      ["transport", { type: "transport", selectedCandidatePairId: "pair" }],
      ["pair", { type: "candidate-pair", localCandidateId: "local" }],
      ["local", { type: "local-candidate", candidateType: "relay", protocol: "tcp", relayProtocol: "tls" }]
    ]);
  };
  network.connectionState = "connected";
  network.dispatchEvent(new Event("connectionstatechange"));
  await new Promise((resolve) => setTimeout(resolve, 260));

  const status = page.posted.at(-1).status;
  assert.ok(calls >= 2);
  assert.equal(status.phase, "connected");
  assert.equal(status.selectedCandidate.type, "relay");
});
