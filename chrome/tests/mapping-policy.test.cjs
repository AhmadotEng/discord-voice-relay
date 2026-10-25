"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const policy = require("../lib/mapping-policy.js");
const codec = require("../lib/turn-codec.js");

test("STUN URI parser accepts the narrow UDP discovery syntax", () => {
  assert.deepEqual(policy.parseStunUri("stun:stun-one.example"), {
    uri: "stun:stun-one.example",
    host: "stun-one.example",
    port: 3478,
    isIpv4Literal: false,
  });
  assert.equal(policy.parseStunUri("stun:198.51.101.7:5349").port, 5349);
  assert.throws(() => policy.parseStunUri("turn:example.test"), /stun:hostname/u);
  assert.throws(() => policy.parseStunUri("stun:127.0.0.1:99999"), /port/u);
  assert.throws(() => policy.parseStunUri("stun:[2001:db8::1]"), /stun:hostname/u);
});

test("matching mappings from two public server addresses pass", () => {
  const result = policy.evaluateMappings([
    { serverAddress: "93.184.216.34", serverPort: 3478, mappedAddress: "8.8.8.8", mappedPort: 49152 },
    { serverAddress: "1.1.1.1", serverPort: 3478, mappedAddress: "8.8.8.8", mappedPort: 49152 },
  ], codec.isPublicIPv4);
  assert.deepEqual(result, {
    ok: true,
    mapping: { address: "8.8.8.8", port: 49152 },
  });
});

test("different mapped addresses or ports fail closed", () => {
  for (const second of [
    { mappedAddress: "9.9.9.9", mappedPort: 49152 },
    { mappedAddress: "8.8.8.8", mappedPort: 49153 },
  ]) {
    const result = policy.evaluateMappings([
      { serverAddress: "93.184.216.34", serverPort: 3478, mappedAddress: "8.8.8.8", mappedPort: 49152 },
      { serverAddress: "1.1.1.1", serverPort: 3478, ...second },
    ], codec.isPublicIPv4);
    assert.deepEqual(result, { ok: false, reason: "endpoint-dependent-mapping" });
  }
});

test("two ports on one STUN address are not an independence test", () => {
  const result = policy.evaluateMappings([
    { serverAddress: "93.184.216.34", serverPort: 3478, mappedAddress: "8.8.8.8", mappedPort: 49152 },
    { serverAddress: "93.184.216.34", serverPort: 3479, mappedAddress: "8.8.8.8", mappedPort: 49152 },
  ], codec.isPublicIPv4);
  assert.deepEqual(result, { ok: false, reason: "not-independent" });
});

test("private probe or mapped addresses are rejected", () => {
  for (const observations of [
    [
      { serverAddress: "192.168.1.2", serverPort: 3478, mappedAddress: "8.8.8.8", mappedPort: 49152 },
      { serverAddress: "1.1.1.1", serverPort: 3478, mappedAddress: "8.8.8.8", mappedPort: 49152 },
    ],
    [
      { serverAddress: "93.184.216.34", serverPort: 3478, mappedAddress: "10.0.0.2", mappedPort: 49152 },
      { serverAddress: "1.1.1.1", serverPort: 3478, mappedAddress: "10.0.0.2", mappedPort: 49152 },
    ],
  ]) {
    assert.deepEqual(policy.evaluateMappings(observations, codec.isPublicIPv4), {
      ok: false,
      reason: "invalid-public-endpoint",
    });
  }
});
