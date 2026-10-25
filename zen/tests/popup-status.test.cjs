"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const popupStatus = require("../src/popup-status.js");
const bootId = "c".repeat(32);
const liveBackend = {
  running: true,
  loopbackPreference: true,
  mode: "remote-mapped",
  allocationCount: 1,
  mappingReadyAllocations: 1,
  peerDatagramsQueued: 2,
  peerDatagramsReceived: 2,
};

const staleVerifiedPage = {
  phase: "verified",
  bootId,
  targetedConnections: 1,
  generation: 1,
  routeRevision: 1,
  applied: true,
  verified: true,
  reconnectRequired: false,
};

test("stale page success cannot override stopped, error, reconnect, or newer transport state", () => {
  assert.equal(popupStatus.presentation({
    enabled: false,
    ready: false,
    phase: "off",
    bootId,
    generation: 2,
  }, staleVerifiedPage).title, "Reconnect Discord voice");

  assert.equal(popupStatus.presentation({
    enabled: true,
    ready: false,
    phase: "error",
    bootId,
    generation: 2,
  }, staleVerifiedPage).title, "Route unavailable");

  assert.equal(popupStatus.presentation({
    enabled: true,
    ready: true,
    phase: "ready",
    bootId,
    generation: 2,
    reconnectRequired: true,
  }, staleVerifiedPage).title, "Reconnect Discord voice");

  assert.equal(popupStatus.presentation({
    enabled: true,
    ready: true,
    phase: "ready",
    bootId,
    generation: 2,
    reconnectRequired: false,
  }, staleVerifiedPage).title, "Reconnect Discord voice");
});

test("off is neutral only when no active applied page route remains", () => {
  const transport = {
    enabled: false,
    ready: false,
    phase: "off",
    bootId,
    generation: 2,
  };
  assert.equal(popupStatus.presentation(transport, {
    phase: "hook-ready",
    bootId,
    targetedConnections: 0,
    generation: 2,
    applied: false,
  }).title, "Direct mode is off");
  const active = popupStatus.presentation(transport, staleVerifiedPage);
  assert.equal(active.title, "Reconnect Discord voice");
  assert.match(active.detail, /route-disabled-during-call/u);
});

test("a new background boot cannot render green for an old applied call", () => {
  const result = popupStatus.presentation({
    enabled: true,
    ready: true,
    phase: "ready",
    bootId: "d".repeat(32),
    generation: 1,
    reconnectRequired: false,
  }, staleVerifiedPage);
  assert.equal(result.title, "Reconnect Discord voice");
  assert.match(result.detail, /backend-session-changed/u);
});

test("verified UI requires a ready current-generation backend", () => {
  const transport = {
    enabled: true,
    ready: true,
    phase: "ready",
    bootId,
    generation: 3,
    routeRevision: 3,
    reconnectRequired: false,
    backend: liveBackend,
  };
  assert.equal(popupStatus.presentation(transport, {
    ...staleVerifiedPage,
    generation: 3,
    routeRevision: 3,
  }).title, "Protected route verified");
  assert.notEqual(popupStatus.presentation({ ...transport, ready: false }, {
    ...staleVerifiedPage,
    generation: 3,
    routeRevision: 3,
  }).title, "Protected route verified");
});

test("verified UI requires the exact backend snapshot and live allocation evidence", () => {
  const transport = {
    enabled: true,
    ready: true,
    phase: "ready",
    bootId,
    generation: 5,
    routeRevision: 8,
    reconnectRequired: false,
    backend: liveBackend,
  };
  const page = {
    ...staleVerifiedPage,
    generation: 5,
    routeRevision: 8,
  };
  assert.equal(popupStatus.presentation(transport, page).title, "Protected route verified");
  assert.equal(popupStatus.presentation({
    ...transport,
    backend: {
      ...liveBackend,
      allocationCount: 0,
      mappingReadyAllocations: 0,
      peerDatagramsQueued: 0,
      peerDatagramsReceived: 0,
    },
  }, page).title, "Rechecking protected route…");
  assert.equal(popupStatus.presentation({
    ...transport,
    routeRevision: 9,
  }, page).title, "Rechecking protected route…");
});

test("a current-generation rejoin satisfies the backend reconnect warning", () => {
  const restarted = {
    enabled: true,
    ready: true,
    phase: "ready",
    bootId,
    generation: 2,
    routeRevision: 6,
    reconnectRequired: true,
    backend: liveBackend,
  };
  assert.equal(popupStatus.presentation(restarted, {
    phase: "route-applied",
    bootId,
    generation: 2,
    routeRevision: 6,
    applied: true,
    verified: false,
    reconnectRequired: false,
  }).title, "Protected route applied");
  assert.equal(popupStatus.presentation(restarted, {
    phase: "verified",
    bootId,
    generation: 2,
    routeRevision: 6,
    applied: true,
    verified: true,
    reconnectRequired: false,
  }).title, "Protected route verified");
  assert.equal(popupStatus.presentation(restarted, {
    phase: "verified",
    bootId,
    generation: 1,
    routeRevision: 5,
    applied: true,
    verified: true,
    reconnectRequired: false,
  }).title, "Reconnect Discord voice");
});

test("failed, disconnected, and closed page events produce bounded user guidance", () => {
  const transport = {
    enabled: true,
    ready: true,
    phase: "ready",
    bootId,
    generation: 4,
    reconnectRequired: false,
  };
  for (const errorCode of ["ice-connection-failed", "peer-connection-failed"]) {
    assert.equal(popupStatus.presentation(transport, {
      phase: "reconnect-required",
      bootId,
      generation: 4,
      applied: true,
      verified: false,
      reconnectRequired: true,
      errorCode,
    }).title, "Reconnect Discord voice");
  }
  assert.equal(popupStatus.presentation(transport, {
    phase: "connection-state",
    bootId,
    generation: 4,
    applied: true,
    verified: false,
    reconnectRequired: false,
    connectionState: "disconnected",
  }).title, "Protected route applied");
  assert.equal(popupStatus.presentation(transport, {
    phase: "hook-ready",
    bootId,
    generation: 4,
    applied: false,
    verified: false,
    reconnectRequired: false,
    connectionState: "closed",
  }).title, "Discord hook ready");
});

test("live hook and negotiation phases remain distinguishable", () => {
  const transport = {
    enabled: true,
    ready: true,
    phase: "ready",
    bootId,
    generation: 4,
    reconnectRequired: false,
  };
  const base = {
    bootId,
    generation: 4,
    applied: false,
    verified: false,
    reconnectRequired: false,
  };
  assert.equal(popupStatus.presentation(transport, {
    ...base,
    phase: "hook-unconfirmed",
  }).title, "Checking Discord hook…");
  assert.equal(popupStatus.presentation(transport, {
    ...base,
    phase: "hook-ready",
  }).title, "Discord hook ready");
  assert.equal(popupStatus.presentation(transport, {
    ...base,
    phase: "waiting-for-route",
  }).title, "Discord route requested…");
  assert.equal(popupStatus.presentation(transport, {
    ...base,
    phase: "route-applied",
    applied: true,
  }).title, "Protected route applied");
  assert.equal(popupStatus.presentation(transport, {
    ...base,
    phase: "candidate",
    applied: true,
  }).title, "Relay candidate gathered");
  assert.equal(popupStatus.presentation(transport, {
    ...base,
    phase: "waiting-for-backend",
    applied: true,
  }).title, "Relay selected");
});

test("page failures can never collapse into generic Ready", () => {
  const transport = {
    enabled: true,
    ready: true,
    phase: "ready",
    bootId,
    generation: 8,
    reconnectRequired: false,
  };
  for (const [phase, errorCode] of [
    ["route-blocked", "ice-candidate-error"],
    ["configuration-error", "configuration-error"],
    ["diagnostic-error", "stats-unavailable"],
    ["unsafe-direct", "selected-pair-not-relay-udp"],
  ]) {
    const result = popupStatus.presentation(transport, {
      phase,
      bootId,
      errorCode,
      generation: 8,
      applied: true,
      verified: false,
      reconnectRequired: false,
    });
    assert.equal(result.title, "Discord route failed");
    assert.equal(result.tone, "error");
  }
  assert.equal(popupStatus.presentation(transport, {
    phase: "direct",
    bootId,
    generation: 8,
    applied: false,
    verified: false,
    reconnectRequired: false,
  }).title, "Discord route not applied");
});

test("a missing Discord page receiver asks for a reload instead of claiming Ready", () => {
  const result = popupStatus.presentation({
    enabled: true,
    ready: true,
    phase: "ready",
    bootId,
    generation: 9,
    reconnectRequired: false,
  }, {
    phase: "bridge-unavailable",
  });
  assert.equal(result.title, "Reload Discord");
  assert.equal(result.tone, "warning");
});

test("every reconnect lifecycle code has explicit non-generic guidance", () => {
  const transport = {
    enabled: true,
    ready: true,
    phase: "ready",
    bootId,
    generation: 10,
    reconnectRequired: false,
  };
  for (const errorCode of [
    "route-too-late",
    "backend-session-changed",
    "backend-generation-changed",
    "route-enabled-after-offer",
    "backend-not-ready",
  ]) {
    const result = popupStatus.presentation(transport, {
      phase: "reconnect-required",
      bootId,
      generation: 10,
      applied: false,
      verified: false,
      reconnectRequired: true,
      errorCode,
    });
    assert.equal(result.title, "Reconnect Discord voice");
    assert.match(result.detail, new RegExp(errorCode, "u"));
    assert.doesNotMatch(result.detail, /route changed or arrived too late/iu);
  }
});
