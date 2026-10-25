"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const tools = require("../src/relay-config.js");

test("recognizes only the explicit Discord network peer configurations", () => {
  assert.equal(tools.isDiscordNetworkConfiguration(undefined), false);
  assert.equal(tools.isDiscordNetworkConfiguration({}), false);
  assert.equal(tools.isDiscordNetworkConfiguration({ sdpSemantics: "unified-plan" }), true);
  assert.equal(tools.isDiscordNetworkConfiguration({ sdpSemantics: "plan-b" }), true);
  assert.equal(tools.isDiscordNetworkConfiguration({ bundlePolicy: "max-bundle" }), true);
});

test("leaves disabled configurations unchanged", () => {
  const original = { sdpSemantics: "unified-plan" };
  const result = tools.buildRelayConfiguration(original, {
    enabled: false,
    turnUrls: "turns:relay.example:443?transport=tcp"
  });
  assert.equal(result.applied, false);
  assert.equal(result.configuration, original);
});

test("always allows the relay to be turned off even if a saved URL is invalid", () => {
  const validation = tools.validateSettings({
    enabled: false,
    turnUrls: "not-a-turn-url",
    tcpOnly: true
  });
  assert.deepEqual(validation.errors, []);
});

test("forces a valid TCP/TLS TURN server and does not mutate input", () => {
  const original = { sdpSemantics: "unified-plan", iceServers: [{ urls: "stun:old.example" }] };
  const result = tools.buildRelayConfiguration(original, {
    enabled: true,
    turnUrls: "turns:relay.example:443?transport=tcp",
    turnUsername: "alice",
    turnCredential: "secret",
    tcpOnly: true
  });

  assert.equal(result.applied, true);
  assert.equal(result.configuration.iceTransportPolicy, "relay");
  assert.deepEqual(result.configuration.iceServers, [{
    urls: ["turns:relay.example:443?transport=tcp"],
    username: "alice",
    credential: "secret"
  }]);
  assert.deepEqual(original.iceServers, [{ urls: "stun:old.example" }]);
});

test("rejects non-TURN, unencrypted TURN, and UDP-only input", () => {
  const invalid = tools.validateSettings({
    enabled: true,
    turnUrls: [
      "stun:stun.example:3478",
      "turn:relay.example:3478?transport=tcp",
      "turns:relay.example:443?transport=udp"
    ].join("\n"),
    turnUsername: "alice",
    turnCredential: "secret",
    tcpOnly: true
  });
  assert.ok(invalid.errors.length >= 3);
  assert.deepEqual(invalid.urls, []);
});

test("requires TURN authentication when relay mode is enabled", () => {
  const missingUsername = tools.validateSettings({
    enabled: true,
    turnUrls: "turns:relay.example:443?transport=tcp",
    turnCredential: "secret",
    tcpOnly: true
  });
  const missingCredential = tools.validateSettings({
    enabled: true,
    turnUrls: "turns:relay.example:443?transport=tcp",
    turnUsername: "alice",
    tcpOnly: true
  });
  assert.match(missingUsername.errors.join(" "), /username/iu);
  assert.match(missingCredential.errors.join(" "), /credential/iu);
});

test("rejects malformed TURN authorities and out-of-range ports", () => {
  for (const turnUrl of [
    "turns:relay.example:99999?transport=tcp",
    "turns:relay.example:0?transport=tcp",
    "turns:YOUR_TURN_HOST:443?transport=tcp",
    "turns:user@relay.example:443?transport=tcp"
  ]) {
    assert.equal(tools.parseTurnUrl(turnUrl).valid, false, turnUrl);
  }
  assert.equal(tools.parseTurnUrl("turns:relay.example:1?transport=tcp").valid, true);
  assert.equal(tools.parseTurnUrl("turns:relay.example:65535?transport=tcp").valid, true);
  assert.equal(tools.parseTurnUrl("turns:[2001:db8::1]:443?transport=tcp").valid, true);
});

test("summarizes candidates without retaining addresses", () => {
  const summary = tools.candidateSummary("candidate:1 1 TCP 123 203.0.113.9 443 typ relay tcptype passive");
  assert.deepEqual(summary, { type: "relay", protocol: "tcp", tcpType: "passive" });
  assert.equal(JSON.stringify(summary).includes("203.0.113.9"), false);
});
