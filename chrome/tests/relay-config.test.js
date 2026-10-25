"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const tools = require("../src/relay-config.js");

const bootId = "a".repeat(32);
const allocationId = "b".repeat(32);

function readyRoute(overrides = {}) {
  return {
    bootId,
    enabled: true,
    ready: true,
    phase: "ready",
    generation: 1,
    routeRevision: 1,
    userDisabled: false,
    reconnectRequired: false,
    endpoint: {
      urls: ["turn:127.0.0.1:49152?transport=udp"],
      username: "ephemeral-user",
      credential: "ephemeral-credential",
    },
    backend: {
      running: true,
      controlSocketBound: true,
      mode: "remote-mapped",
      allocationCount: 1,
      allocations: [{
        id: allocationId,
        relayAddress: "203.0.113.10",
        relayPort: 50000,
        mappingReady: true,
        peerDatagramsQueued: 2,
        peerDatagramsReceived: 2,
      }],
    },
    ...overrides,
  };
}

test("recognizes Discord's explicit peer-connection configurations independent of media kind", () => {
  assert.equal(tools.isDiscordNetworkConfiguration(undefined), false);
  assert.equal(tools.isDiscordNetworkConfiguration({}), false);
  assert.equal(tools.isDiscordNetworkConfiguration({ sdpSemantics: "unified-plan" }), true);
  assert.equal(tools.isDiscordNetworkConfiguration({ sdpSemantics: "plan-b" }), true);
  assert.equal(tools.isDiscordNetworkConfiguration({ bundlePolicy: "max-bundle" }), true);
  assert.equal(tools.isDiscordVoiceConfiguration({ bundlePolicy: "max-bundle" }), true);
});

test("the local mode requires two valid, independent STUN discovery hosts only when enabled", () => {
  const defaults = tools.validateSettings({ enabled: true });
  assert.deepEqual(defaults.errors, []);
  assert.deepEqual(defaults.stunUris, [...tools.DEFAULT_PROBE_SERVERS]);

  assert.match(tools.validateSettings({ enabled: true, stunServers: "stun:a.example:3478" })
    .errors.join(" "), /two independent STUN/iu);
  assert.match(tools.validateSettings({
    enabled: true,
    stunServers: "stun:a.example:3478\nstun:a.example:3479",
  }).errors.join(" "), /independent STUN hosts/iu);
  assert.ok(tools.validateSettings({
    enabled: true,
    stunServers: "stun:a.example:3478\nnot-a-stun-uri",
  }).errors.length > 0);

  const disabled = tools.validateSettings({ enabled: false, stunServers: "invalid" });
  assert.deepEqual(disabled.errors, []);
});

test("STUN URI parser rejects malformed hosts, ports and schemes", () => {
  for (const value of [
    "turn:stun.example:3478",
    "stun:example:0",
    "stun:example:65536",
    "stun:under_score.example:3478",
    "stun:999.1.1.1:3478",
    "stun:host.example/path",
  ]) {
    assert.equal(tools.parseStunUri(value).valid, false, value);
  }
  assert.deepEqual(tools.parseStunUri("stun:stun.example:3478"), {
    valid: true,
    uri: "stun:stun.example:3478",
    host: "stun.example",
    port: 3478,
  });
});

test("summarizes ICE candidates without retaining addresses", () => {
  const summary = tools.candidateSummary(
    "candidate:1 1 TCP 123 203.0.113.9 443 typ relay tcptype passive"
  );
  assert.deepEqual(summary, { type: "relay", protocol: "tcp", tcpType: "passive" });
  assert.equal(JSON.stringify(summary).includes("203.0.113.9"), false);
});

test("relay route is valid only while the local Native Messaging helper is active", () => {
  assert.equal(tools.normalizeRouteState(readyRoute()).ready, true);
  for (const change of [
    { backend: { running: true, controlSocketBound: false, mode: "remote-mapped" } },
    { backend: { running: false, controlSocketBound: true, mode: "remote-mapped" } },
    { endpoint: { urls: ["turns:relay.example:443"], username: "u", credential: "c" } },
  ]) {
    assert.equal(tools.normalizeRouteState(readyRoute(change)).ready, false);
  }
  assert.equal(tools.routeVerificationMode(readyRoute()), "allocation");
});

test("route configuration installs the loopback relay and forces relay-only ICE", () => {
  const configured = tools.routeConfiguration({ bundlePolicy: "max-bundle" }, readyRoute());
  assert.equal(configured.iceTransportPolicy, "relay");
  assert.equal(configured.bundlePolicy, "max-bundle");
  assert.deepEqual(configured.iceServers, [{
    urls: ["turn:127.0.0.1:49152?transport=udp"],
    username: "ephemeral-user",
    credential: "ephemeral-credential",
  }]);
  assert.throws(() => tools.routeConfiguration({}, readyRoute({ phase: "waiting", ready: false })));
});

test("waiting stays nonterminal until the helper is ready, while disabled authorizes direct ICE", () => {
  const waiting = tools.normalizeRouteState({ bootId, enabled: true, ready: false, phase: "waiting" });
  assert.equal(tools.routeDecisionIsTerminal(waiting), false);
  assert.equal(tools.routeDecisionIsTerminal({ bootId, enabled: false, phase: "off", userDisabled: true }), true);
});

test("blocked and direct configurations preserve the fail-closed and explicit-off behavior", () => {
  const blocked = tools.blockedConfiguration({ sdpSemantics: "unified-plan" });
  assert.deepEqual(blocked.iceServers, []);
  assert.equal(blocked.iceTransportPolicy, "relay");
  assert.equal(blocked.sdpSemantics, "unified-plan");

  const direct = tools.directConfiguration(
    { iceServers: [], iceTransportPolicy: "relay" },
    { iceServers: [{ urls: "stun:original.example" }], iceTransportPolicy: "all" }
  );
  assert.deepEqual(direct.iceServers, [{ urls: "stun:original.example" }]);
  assert.equal(direct.iceTransportPolicy, "all");
});

test("the selected relay candidate must match this live allocation and bidirectional traffic", () => {
  const route = readyRoute();
  const candidate = { address: "203.0.113.10", port: 50000 };
  assert.deepEqual(tools.backendTrafficEvidence(route, candidate, allocationId), {
    allocationId,
    confirmed: true,
  });
  assert.equal(tools.backendConfirmsTraffic(route, candidate, allocationId), true);
  assert.equal(tools.backendTrafficEvidence(route, { address: "203.0.113.10", port: 50001 }), null);
  assert.equal(tools.backendTrafficEvidence(route, candidate, "c".repeat(32)), null);
});
