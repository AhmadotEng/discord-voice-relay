"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const tools = require("../src/config.js");

function readyRoute(overrides = {}) {
  return {
    bootId: "1".repeat(32),
    enabled: true,
    ready: true,
    phase: "ready",
    generation: 4,
    routeRevision: 9,
    endpoint: {
      turnUrl: "turn:127.0.0.1:49152?transport=udp",
      username: "temporary-user",
      credential: "temporary-credential",
    },
    backend: {
      running: true,
      loopbackPreference: true,
      mode: "remote-mapped",
      allocationCount: 1,
      mappingReadyAllocations: 1,
      allocations: [{
        id: "2".repeat(32),
        relayAddress: "203.0.113.25",
        relayPort: 62000,
        mappingReady: true,
        peerDatagramsQueued: 2,
        peerDatagramsReceived: 3,
      }],
      peerDatagramsQueued: 2,
      peerDatagramsReceived: 3,
    },
    ...overrides,
  };
}

test("ships the documented Cloudflare and Twilio STUN discovery defaults", () => {
  assert.deepEqual(tools.DEFAULT_PROBE_SERVERS, [
    "stun:stun.cloudflare.com:3478",
    "stun:global.stun.twilio.com:3478",
  ]);
  const validation = tools.validateSettings({
    enabled: true,
    mappingProbeServers: tools.DEFAULT_SETTINGS.mappingProbeServers,
  });
  assert.deepEqual(validation.errors, []);
  assert.equal(validation.servers.length, 2);
});

test("STUN settings require two bounded, syntactically valid discovery endpoints", () => {
  assert.match(tools.validateSettings({ enabled: true, mappingProbeServers: "stun:one.example:3478" }).errors[0], /two/iu);
  assert.ok(tools.validateSettings({ enabled: true, mappingProbeServers: "https://one.example\nstun:two.example:3478" }).errors.length > 0);
  assert.equal(tools.parseStunUri("stun:127.0.0.1:3478").valid, true);
  assert.equal(tools.parseStunUri("stun:user@host:3478").valid, false);
});

test("targets only explicit Discord voice configuration signatures", () => {
  assert.equal(tools.isDiscordVoiceConfiguration({ sdpSemantics: "plan-b" }), true);
  assert.equal(tools.isDiscordVoiceConfiguration({ sdpSemantics: "unified-plan" }), true);
  assert.equal(tools.isDiscordVoiceConfiguration({ bundlePolicy: "max-bundle" }), true);
  assert.equal(tools.isDiscordVoiceConfiguration(), false);
  assert.equal(tools.isDiscordVoiceConfiguration({}), false);
  assert.equal(tools.isDiscordVoiceConfiguration({ bundlePolicy: "balanced" }), false);
  assert.equal(tools.isDiscordVoiceConfiguration({ nested: { bundlePolicy: "max-bundle" } }), false);
});

test("pending voice construction is fail-closed without Gecko's restricted port 9", () => {
  const blocked = tools.blockedConfiguration({
    bundlePolicy: "max-bundle",
    iceServers: [{ urls: "stun:original.example" }],
  });
  assert.equal(blocked.bundlePolicy, "max-bundle");
  assert.equal(blocked.iceTransportPolicy, "relay");
  assert.deepEqual(blocked.iceServers, []);
  assert.equal(JSON.stringify(blocked).includes("127.0.0.1:9"), false);
});

test("accepts only literal loopback UDP TURN URLs", () => {
  assert.equal(tools.validLoopbackTurnUrl("turn:127.0.0.1:1?transport=udp"), true);
  assert.equal(tools.validLoopbackTurnUrl("turn:127.0.0.1:65535?transport=udp"), true);
  for (const rejected of [
    "turn:localhost:3478?transport=udp",
    "turn:127.0.0.2:3478?transport=udp",
    "turn:user@127.0.0.1:3478?transport=udp",
    "turn:127.0.0.1:0?transport=udp",
    "turn:127.0.0.1:65536?transport=udp",
    "turn:127.0.0.1:3478?transport=tcp",
    "turn:127.0.0.1:3478?transport=udp&x=1",
    "turn:127.0.0.1:3478?transport=udp#x",
    "turn:%31%32%37.0.0.1:3478?transport=udp",
  ]) {
    assert.equal(tools.validLoopbackTurnUrl(rejected), false, rejected);
  }
});

test("route readiness requires a live remote-mapped backend and valid ephemeral endpoint", () => {
  assert.equal(tools.normalizeRouteState(readyRoute()).ready, true);
  assert.equal(tools.normalizeRouteState(readyRoute()).routeRevision, 9);
  assert.equal(tools.normalizeRouteState(readyRoute({ backend: { ...readyRoute().backend, running: false } })).ready, false);
  assert.equal(tools.normalizeRouteState(readyRoute({ backend: { ...readyRoute().backend, loopbackPreference: false } })).ready, false);
  assert.equal(tools.normalizeRouteState(readyRoute({ backend: { ...readyRoute().backend, mode: "local-test" } })).ready, false);
  assert.equal(tools.normalizeRouteState(readyRoute({ endpoint: null })).ready, false);
  assert.equal(tools.normalizeRouteState(readyRoute({ endpoint: { turnUrl: "turn:127.0.0.1:9?transport=udp", username: "", credential: "x" } })).ready, false);
});

test("success additionally requires a ready allocation and bidirectional backend traffic", () => {
  const selected = { address: "203.0.113.25", port: 62000 };
  assert.equal(tools.backendConfirmsTraffic(readyRoute(), selected), true);
  assert.equal(tools.boundBackendTrafficEvidence(readyRoute(), "2".repeat(32)).confirmed, true);
  assert.equal(tools.boundBackendTrafficEvidence(readyRoute(), "3".repeat(32)), null);
  assert.equal(tools.backendConfirmsTraffic(readyRoute({
    backend: {
      ...readyRoute().backend,
      allocations: [{ ...readyRoute().backend.allocations[0], mappingReady: false }],
    },
  }), selected), false);
  assert.equal(tools.backendConfirmsTraffic(readyRoute({
    backend: {
      ...readyRoute().backend,
      allocations: [{ ...readyRoute().backend.allocations[0], peerDatagramsReceived: 0 }],
    },
  }), selected), false);
  assert.equal(tools.backendConfirmsTraffic(readyRoute({
    backend: {
      ...readyRoute().backend,
      peerDatagramsQueued: 99,
      peerDatagramsReceived: 99,
      allocations: [{
        ...readyRoute().backend.allocations[0],
        relayAddress: "203.0.113.26",
      }],
    },
  }), selected), false);
});

test("route configuration merges current immutable fields and replaces only ICE routing", () => {
  const certificates = [{ id: "certificate" }];
  const current = {
    bundlePolicy: "max-bundle",
    rtcpMuxPolicy: "require",
    iceCandidatePoolSize: 2,
    certificates,
    iceServers: [{ urls: "stun:old.example" }],
    iceTransportPolicy: "all",
  };
  const configured = tools.routeConfiguration(current, readyRoute());
  assert.equal(configured.bundlePolicy, "max-bundle");
  assert.equal(configured.rtcpMuxPolicy, "require");
  assert.equal(configured.iceCandidatePoolSize, 2);
  assert.equal(configured.certificates, certificates);
  assert.equal(configured.iceTransportPolicy, "relay");
  assert.deepEqual(configured.iceServers, [{
    urls: "turn:127.0.0.1:49152?transport=udp",
    username: "temporary-user",
    credential: "temporary-credential",
  }]);
});
