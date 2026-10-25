"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const { webcrypto } = require("node:crypto");

const tools = require("../src/config.js");
const hookSource = fs.readFileSync(path.resolve(__dirname, "../src/page-hook.js"), "utf8");

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

function route(generation = 1, overrides = {}) {
  return {
    bootId: "a".repeat(32),
    enabled: true,
    ready: true,
    phase: "ready",
    generation,
    routeRevision: generation,
    userDisabled: false,
    reconnectRequired: false,
    errorCode: null,
    endpoint: {
      turnUrl: "turn:127.0.0.1:49152?transport=udp",
      username: "ephemeral-user",
      credential: "ephemeral-credential",
    },
    backend: {
      running: true,
      loopbackPreference: true,
      mode: "remote-mapped",
      allocationCount: 0,
      mappingReadyAllocations: 0,
      peerDatagramsQueued: 0,
      peerDatagramsReceived: 0,
    },
    ...overrides,
  };
}

function createClock() {
  let now = 0;
  let id = 0;
  const tasks = new Map();
  return {
    setTimeout(callback, delay) {
      const taskId = ++id;
      tasks.set(taskId, { at: now + Number(delay), callback });
      return taskId;
    },
    clearTimeout(taskId) {
      tasks.delete(taskId);
    },
    advance(milliseconds) {
      now += milliseconds;
      const due = [...tasks.entries()]
        .filter(([, task]) => task.at <= now)
        .sort((left, right) => left[1].at - right[1].at);
      for (const [taskId, task] of due) {
        tasks.delete(taskId);
        task.callback();
      }
    },
  };
}

function createHarness({ oldHook = false } = {}) {
  const clock = createClock();
  const posted = [];
  const windowListeners = [];
  const constructorCalls = [];
  let responseSequence = 0;
  let bridgeInstanceId = "b".repeat(32);

  class FakePeerConnection {
    static marker = "native-static";
    static throwOnConstruct = false;

    constructor(...argumentsList) {
      if (FakePeerConnection.throwOnConstruct) {
        throw new DOMException("constructor rejected configuration", "InvalidModificationError");
      }
      constructorCalls.push(argumentsList);
      this.configuration = argumentsList.length ? { ...(argumentsList[0] || {}) } : {};
      this.calls = [];
      this.listeners = new Map();
      this.localDescription = null;
      this.remoteDescription = null;
      this.iceGatheringState = "new";
      this.signalingState = "stable";
      this.iceConnectionState = "new";
      this.connectionState = "new";
      this.stats = new Map();
      this.offerCount = 0;
    }

    addEventListener(type, listener) {
      if (!this.listeners.has(type)) this.listeners.set(type, []);
      this.listeners.get(type).push(listener);
    }

    emit(type, event = {}) {
      for (const listener of this.listeners.get(type) || []) listener.call(this, event);
    }

    getConfiguration() {
      return { ...this.configuration };
    }

    setConfiguration(next) {
      const immutable = ["bundlePolicy", "rtcpMuxPolicy", "certificates"];
      for (const key of immutable) {
        if (this.configuration[key] !== undefined && next[key] !== undefined &&
            next[key] !== this.configuration[key]) {
          throw new DOMException(`${key} changed`, "InvalidModificationError");
        }
      }
      if ((this.localDescription || this.remoteDescription) &&
          next.iceCandidatePoolSize !== undefined &&
          next.iceCandidatePoolSize !== this.configuration.iceCandidatePoolSize) {
        throw new DOMException("candidate pool changed", "InvalidModificationError");
      }
      this.calls.push({ type: "setConfiguration", value: next });
      this.configuration = { ...this.configuration, ...next };
    }

    createOffer(...argumentsList) {
      this.offerCount += 1;
      this.calls.push({ type: "createOffer", value: argumentsList });
      return Promise.resolve(`offer-${this.offerCount}`);
    }

    createAnswer(...argumentsList) {
      this.calls.push({ type: "createAnswer", value: argumentsList });
      return Promise.resolve("answer");
    }

    setLocalDescription(description) {
      this.calls.push({ type: "setLocalDescription", value: description });
      this.localDescription = description === undefined
        ? { type: this.remoteDescription ? "answer" : "offer" }
        : description;
      this.signalingState = this.localDescription.type === "offer"
        ? "have-local-offer"
        : "stable";
      return Promise.resolve();
    }

    setRemoteDescription(description) {
      this.calls.push({ type: "setRemoteDescription", value: description });
      this.remoteDescription = description;
      this.signalingState = description && description.type === "offer"
        ? "have-remote-offer"
        : "stable";
      return Promise.resolve();
    }

    getStats() {
      return this.statsPromise || Promise.resolve(this.stats);
    }

    close() {
      this.calls.push({ type: "close" });
      this.connectionState = "closed";
    }
  }

  const context = vm.createContext({
    __discordDirectTools: tools,
    __discordVoiceRelayInstalled: oldHook,
    RTCPeerConnection: FakePeerConnection,
    webkitRTCPeerConnection: FakePeerConnection,
    DOMException,
    Uint8Array,
    crypto: webcrypto,
    location: { origin: "https://discord.com" },
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    __windowListeners: windowListeners,
    addEventListener(type, listener) {
      if (type === "message") windowListeners.push(listener);
    },
    postMessage(message, origin) {
      posted.push({ message, origin });
    },
  });
  vm.runInContext(`
    globalThis.__deliver = function (data, origin = location.origin) {
      for (const listener of globalThis.__windowListeners) {
        listener({ source: globalThis, origin, data });
      }
    };
  `, context);
  vm.runInContext(hookSource, context, { filename: "page-hook.js" });
  context.__deliver({
    channel: "discord-direct-zen:v1",
    direction: "extension-to-page",
    bridgeInstanceId,
    type: "bridge-ready",
  });

  const routeRequest = posted.find((entry) => entry.message.type === "route-request");
  const token = routeRequest && routeRequest.message.token;
  function deliverRoute(value, overrides = {}) {
    responseSequence += 1;
    context.__deliver({
      channel: "discord-direct-zen:v1",
      direction: "extension-to-page",
      token,
      bridgeInstanceId,
      type: "route",
      route: { bootId: "a".repeat(32), ...value },
      responseSequence,
      ...overrides,
    });
  }
  function latestFreshRequestId() {
    const requests = posted
      .filter((entry) => entry.message.type === "route-request" &&
        Number.isSafeInteger(entry.message.requestId));
    return requests.length ? requests.at(-1).message.requestId : null;
  }
  function deliverFreshRoute(value) {
    const requestId = latestFreshRequestId();
    assert.ok(requestId, "the first offer must request a fresh route decision");
    deliverRoute(value, { requestId });
  }
  function statuses() {
    return posted
      .filter((entry) => entry.message.type === "status")
      .map((entry) => entry.message.status);
  }
  return {
    context,
    clock,
    posted,
    statuses,
    token,
    deliverRoute,
    deliverFreshRoute,
    requestPageStatus(statusRequestId = null) {
      context.__deliver({
        channel: "discord-direct-zen:v1",
        direction: "extension-to-page",
        token,
        bridgeInstanceId,
        type: "get-status",
        ...(Number.isSafeInteger(statusRequestId) && statusRequestId > 0
          ? { statusRequestId }
          : {}),
      });
    },
    activateBridge(nextBridgeInstanceId) {
      bridgeInstanceId = nextBridgeInstanceId;
      responseSequence = 0;
      context.__deliver({
        channel: "discord-direct-zen:v1",
        direction: "extension-to-page",
        bridgeInstanceId,
        type: "bridge-ready",
      });
    },
    latestFreshRequestId,
    FakePeerConnection,
    constructorCalls,
  };
}

async function flush() {
  for (let index = 0; index < 8; index += 1) await Promise.resolve();
}

test("installation is idempotent and preserves native/no-argument/subclass behavior", async () => {
  const harness = createHarness();
  const Wrapped = harness.context.RTCPeerConnection;
  vm.runInContext(hookSource, harness.context, { filename: "page-hook-second-load.js" });
  assert.equal(harness.context.RTCPeerConnection, Wrapped);
  assert.equal(harness.context.RTCPeerConnection.marker, "native-static");

  const ignored = new harness.context.RTCPeerConnection();
  assert.equal(harness.constructorCalls[0].length, 0);
  assert.equal(Object.hasOwn(ignored, "createOffer"), true);
  assert.equal(await ignored.createOffer(), "offer-1");

  class Child extends harness.context.RTCPeerConnection {}
  const child = new Child({ bundlePolicy: "max-bundle" });
  assert.ok(child instanceof Child);
  assert.ok(child instanceof harness.FakePeerConnection);
  assert.ok(child instanceof harness.context.RTCPeerConnection);
});

test("first offer waits, applies the loopback route exactly once, then calls native offer", async () => {
  const harness = createHarness();
  const certificate = { id: "cert" };
  const pc = new harness.context.RTCPeerConnection({
    bundlePolicy: "max-bundle",
    rtcpMuxPolicy: "require",
    certificates: certificate,
    iceCandidatePoolSize: 2,
  });
  const offer = pc.createOffer({ offerToReceiveAudio: true });
  await flush();
  assert.equal(pc.offerCount, 0);
  harness.deliverFreshRoute(route());
  assert.equal(await offer, "offer-1");
  assert.deepEqual(pc.calls.map((entry) => entry.type), ["setConfiguration", "createOffer"]);
  const applied = pc.calls[0].value;
  assert.equal(applied.bundlePolicy, "max-bundle");
  assert.equal(applied.rtcpMuxPolicy, "require");
  assert.equal(applied.certificates, certificate);
  assert.equal(applied.iceCandidatePoolSize, 2);
  assert.equal(applied.iceTransportPolicy, "relay");
  assert.deepEqual(applied.iceServers, [{
    urls: "turn:127.0.0.1:49152?transport=udp",
    username: "ephemeral-user",
    credential: "ephemeral-credential",
  }]);
});

test("concurrent offers share one route commit and delegate in order", async () => {
  const harness = createHarness();
  const pc = new harness.context.RTCPeerConnection({ sdpSemantics: "unified-plan" });
  const first = pc.createOffer({ id: 1 });
  const second = pc.createOffer({ id: 2 });
  await flush();
  assert.equal(pc.offerCount, 0);
  harness.deliverFreshRoute(route());
  assert.deepEqual(await Promise.all([first, second]), ["offer-1", "offer-2"]);
  assert.equal(pc.calls.filter((entry) => entry.type === "setConfiguration").length, 1);
  assert.deepEqual(pc.calls.map((entry) => entry.type), ["setConfiguration", "createOffer", "createOffer"]);
});

test("implicit local descriptions and answerer negotiation share the protected route gate", async () => {
  const implicitHarness = createHarness();
  const implicitPc = new implicitHarness.context.RTCPeerConnection({ bundlePolicy: "max-bundle" });
  const implicit = implicitPc.setLocalDescription();
  await flush();
  assert.equal(implicitPc.calls.some((entry) => entry.type === "setLocalDescription"), false);
  implicitHarness.deliverFreshRoute(route());
  await implicit;
  assert.deepEqual(implicitPc.calls.map((entry) => entry.type), [
    "setConfiguration",
    "setLocalDescription",
  ]);
  assert.equal(implicitPc.configuration.iceTransportPolicy, "relay");
  assert.equal(implicitPc.configuration.iceServers.length, 1);

  const answerHarness = createHarness();
  const answerPc = new answerHarness.context.RTCPeerConnection({ sdpSemantics: "plan-b" });
  const remote = answerPc.setRemoteDescription({ type: "offer", sdp: "v=0" });
  await flush();
  assert.equal(answerPc.remoteDescription, null);
  answerHarness.deliverFreshRoute(route());
  await remote;
  const answer = await answerPc.createAnswer();
  await answerPc.setLocalDescription({ type: "answer", sdp: answer });
  assert.deepEqual(answerPc.calls.map((entry) => entry.type), [
    "setConfiguration",
    "setRemoteDescription",
    "createAnswer",
    "setLocalDescription",
  ]);
  assert.equal(answerPc.configuration.iceTransportPolicy, "relay");
});

test("a transparent outer constructor proxy keeps protected instances valid", async () => {
  const harness = createHarness();
  const Installed = harness.context.RTCPeerConnection;
  harness.context.RTCPeerConnection = new Proxy(Installed, {});
  const pc = new harness.context.RTCPeerConnection({ bundlePolicy: "max-bundle" });
  const offer = pc.createOffer();
  await flush();
  harness.deliverFreshRoute(route());
  assert.equal(await offer, "offer-1");
  assert.equal(pc.configuration.iceTransportPolicy, "relay");
  harness.requestPageStatus();
  assert.notEqual(harness.statuses().at(-1).errorCode, "hook-replaced");
});

test("status polling detects constructor replacement before a protected PC exists", () => {
  const harness = createHarness();
  harness.context.RTCPeerConnection = function Replacement() {};
  harness.requestPageStatus();
  const status = harness.statuses().at(-1);
  assert.equal(status.phase, "reload-required");
  assert.equal(status.reconnectRequired, true);
  assert.equal(status.verified, false);
  assert.equal(status.errorCode, "hook-replaced");
});

test("detected constructor replacement terminalizes existing protected connections", async () => {
  const harness = createHarness();
  const allocation = {
    id: "e".repeat(32),
    relayAddress: "92.97.232.243",
    relayPort: 62000,
    mappingReady: true,
    peerDatagramsQueued: 2,
    peerDatagramsReceived: 2,
  };
  const activeRoute = route(1, {
    backend: {
      running: true,
      loopbackPreference: true,
      mode: "remote-mapped",
      allocationCount: 1,
      mappingReadyAllocations: 1,
      allocations: [allocation],
      peerDatagramsQueued: 2,
      peerDatagramsReceived: 2,
    },
  });
  const pc = new harness.context.RTCPeerConnection({ bundlePolicy: "max-bundle" });
  const firstOffer = pc.createOffer();
  await flush();
  harness.deliverFreshRoute(activeRoute);
  await firstOffer;
  pc.stats = new Map([
    ["transport", { type: "transport", selectedCandidatePairId: "pair" }],
    ["pair", { type: "candidate-pair", localCandidateId: "local" }],
    ["local", {
      type: "local-candidate",
      candidateType: "relay",
      protocol: "udp",
      address: allocation.relayAddress,
      port: allocation.relayPort,
    }],
  ]);
  pc.connectionState = "connected";
  pc.iceConnectionState = "connected";
  pc.emit("connectionstatechange");
  await flush();
  assert.equal(harness.statuses().at(-1).phase, "verified");

  harness.context.RTCPeerConnection = function Replacement() {};
  harness.requestPageStatus(23);
  assert.equal(harness.statuses().at(-1).phase, "reload-required");
  assert.equal(harness.statuses().at(-1).errorCode, "hook-replaced");

  pc.emit("connectionstatechange");
  harness.deliverRoute(activeRoute);
  await flush();
  const sticky = harness.statuses().at(-1);
  assert.equal(sticky.phase, "reload-required");
  assert.equal(sticky.verified, false);
  assert.equal(sticky.selectedCandidate, null);
  assert.equal(sticky.errorCode, "hook-replaced");
  await assert.rejects(pc.createOffer(), { name: "InvalidStateError" });
  assert.equal(pc.offerCount, 1);
});

test("a correlated fresh boot supersedes a higher old generation without reusing stale credentials", async () => {
  const harness = createHarness();
  const oldBoot = "a".repeat(32);
  const newBoot = "b".repeat(32);
  harness.deliverRoute(route(7, { bootId: oldBoot }));

  const pc = new harness.context.RTCPeerConnection({ bundlePolicy: "max-bundle" });
  const offer = pc.createOffer();
  await flush();
  const requestId = harness.latestFreshRequestId();

  harness.deliverRoute(route(1, {
    bootId: newBoot,
    endpoint: {
      turnUrl: "turn:127.0.0.1:52001?transport=udp",
      username: "new-user",
      credential: "new-credential",
    },
  }));
  await flush();
  assert.equal(pc.offerCount, 0, "an uncorrelated boot change must not win");

  harness.deliverRoute(route(1, {
    bootId: newBoot,
    endpoint: {
      turnUrl: "turn:127.0.0.1:52001?transport=udp",
      username: "new-user",
      credential: "new-credential",
    },
  }), { requestId });
  assert.equal(await offer, "offer-1");
  assert.equal(pc.configuration.iceServers[0].urls, "turn:127.0.0.1:52001?transport=udp");
  assert.equal(pc.configuration.iceServers[0].username, "new-user");

  harness.deliverRoute(route(8, { bootId: oldBoot }), { requestId, responseSequence: 1 });
  await flush();
  assert.equal(harness.statuses().at(-1).bootId, newBoot);
});

test("a recreated isolated bridge starts a fresh response-sequence namespace", async () => {
  const harness = createHarness();
  harness.deliverRoute(route(7), { responseSequence: 10 });
  harness.activateBridge("c".repeat(32));

  const pc = new harness.context.RTCPeerConnection({ bundlePolicy: "max-bundle" });
  const offer = pc.createOffer();
  await flush();
  harness.deliverFreshRoute(route(1, {
    bootId: "d".repeat(32),
    endpoint: {
      turnUrl: "turn:127.0.0.1:52001?transport=udp",
      username: "new-bridge-user",
      credential: "new-bridge-credential",
    },
  }));
  assert.equal(await offer, "offer-1");
  assert.equal(pc.configuration.iceServers[0].username, "new-bridge-user");
});

test("an uncorrelated new background boot invalidates an applied connection", async () => {
  const harness = createHarness();
  const pc = new harness.context.RTCPeerConnection({ bundlePolicy: "max-bundle" });
  const offer = pc.createOffer();
  await flush();
  harness.deliverFreshRoute(route(5, { bootId: "a".repeat(32) }));
  await offer;

  harness.deliverRoute(route(1, { bootId: "e".repeat(32) }));
  await flush();
  const status = harness.statuses().at(-1);
  assert.equal(status.phase, "reconnect-required");
  assert.equal(status.errorCode, "backend-session-changed");
  assert.equal(status.verified, false);
});

test("an overtaking same-route notification cannot make a fresh negotiation fail", async () => {
  const harness = createHarness();
  harness.deliverRoute(route(3));
  const pc = new harness.context.RTCPeerConnection({ bundlePolicy: "max-bundle" });
  const offer = pc.createOffer();
  await flush();
  const requestId = harness.latestFreshRequestId();

  harness.deliverRoute(route(3));
  harness.deliverRoute(route(3), { requestId, responseSequence: 1 });
  assert.equal(await offer, "offer-1");
  assert.equal(pc.configuration.iceTransportPolicy, "relay");
});

test("backend failure and gate timeout never call native offer", async () => {
  const failed = createHarness();
  const failedPc = new failed.context.RTCPeerConnection({ bundlePolicy: "max-bundle" });
  const failedOffer = failedPc.createOffer();
  await flush();
  failed.deliverFreshRoute({
    enabled: true,
    ready: false,
    phase: "error",
    generation: 1,
    userDisabled: false,
    errorCode: "transport-start-failed",
    endpoint: null,
    backend: { running: false, loopbackPreference: false, mode: null },
  });
  await assert.rejects(failedOffer, { name: "InvalidStateError" });
  assert.equal(failedPc.offerCount, 0);

  const timed = createHarness();
  const timedPc = new timed.context.RTCPeerConnection({ sdpSemantics: "plan-b" });
  const timedOffer = timedPc.createOffer();
  await flush();
  timed.clock.advance(4999);
  await flush();
  assert.equal(timedPc.offerCount, 0);
  timed.clock.advance(1);
  await assert.rejects(timedOffer, { name: "InvalidStateError" });
  timed.deliverFreshRoute(route());
  await flush();
  assert.equal(timedPc.offerCount, 0);
});

test("explicit user disable releases an unused PC but stale generations cannot win", async () => {
  const harness = createHarness();
  harness.deliverRoute(route(2));
  harness.deliverRoute({
    enabled: false,
    ready: false,
    phase: "off",
    generation: 1,
    userDisabled: true,
    endpoint: null,
    backend: null,
  });
  const protectedPc = new harness.context.RTCPeerConnection({ bundlePolicy: "max-bundle" });
  const protectedOffer = protectedPc.createOffer();
  await flush();
  harness.deliverFreshRoute(route(2));
  await protectedOffer;
  assert.equal(protectedPc.configuration.iceTransportPolicy, "relay");

  const directHarness = createHarness();
  const directPc = new directHarness.context.RTCPeerConnection({
    bundlePolicy: "max-bundle",
    iceTransportPolicy: "all",
    iceServers: [],
  });
  directPc.setConfiguration({ iceServers: [{ urls: "stun:discord.example:3478" }] });
  const directOffer = directPc.createOffer();
  await flush();
  directHarness.deliverFreshRoute({
    enabled: false,
    ready: false,
    phase: "off",
    generation: 1,
    userDisabled: true,
    endpoint: null,
    backend: null,
  });
  assert.equal(await directOffer, "offer-1");
  assert.equal(directPc.configuration.iceTransportPolicy, "all");
  assert.equal(directPc.configuration.iceServers[0].urls, "stun:discord.example:3478");

  directHarness.deliverRoute(route(2));
  await flush();
  assert.equal(directHarness.statuses().at(-1).errorCode, "route-enabled-after-offer");
  directPc.connectionState = "connected";
  directPc.iceConnectionState = "connected";
  directPc.emit("connectionstatechange");
  directPc.emit("iceconnectionstatechange");
  assert.equal(directHarness.statuses().at(-1).errorCode, "route-enabled-after-offer");
  assert.equal(directHarness.statuses().at(-1).reconnectRequired, true);
  await assert.rejects(directPc.createOffer(), { name: "InvalidStateError" });
  assert.throws(() => directPc.setConfiguration({ iceServers: [] }), { name: "InvalidStateError" });
});

test("cached off cannot release direct while a fresh enable decision is pending", async () => {
  const harness = createHarness();
  harness.deliverRoute({
    enabled: false,
    ready: false,
    phase: "off",
    generation: 1,
    userDisabled: true,
    endpoint: null,
    backend: null,
  });
  const pc = new harness.context.RTCPeerConnection({
    bundlePolicy: "max-bundle",
    iceTransportPolicy: "all",
    iceServers: [],
  });
  const offer = pc.createOffer();
  await flush();
  assert.ok(harness.latestFreshRequestId());
  assert.equal(pc.offerCount, 0);

  harness.deliverFreshRoute({
    enabled: true,
    ready: false,
    phase: "starting",
    generation: 2,
    userDisabled: false,
    endpoint: null,
    backend: null,
  });
  await flush();
  assert.equal(pc.offerCount, 0);
  assert.equal(pc.configuration.iceTransportPolicy, "relay");

  harness.deliverRoute(route(2));
  assert.equal(await offer, "offer-1");
  assert.equal(pc.configuration.iceTransportPolicy, "relay");
  assert.equal(pc.configuration.iceServers[0].urls, "turn:127.0.0.1:49152?transport=udp");
});

test("a failed fresh route fetch cannot authorize cached direct state", async () => {
  const harness = createHarness();
  harness.deliverRoute({
    enabled: false,
    ready: false,
    phase: "off",
    generation: 5,
    userDisabled: true,
    endpoint: null,
    backend: null,
  });
  const pc = new harness.context.RTCPeerConnection({ bundlePolicy: "max-bundle" });
  const offer = pc.createOffer();
  await flush();
  harness.deliverRoute({
    enabled: true,
    ready: false,
    phase: "error",
    generation: 0,
    userDisabled: false,
    endpoint: null,
    backend: null,
  }, {
    requestId: harness.latestFreshRequestId(),
    responseOk: false,
  });
  await assert.rejects(offer, { name: "InvalidStateError" });
  assert.equal(pc.offerCount, 0);
  assert.equal(pc.configuration.iceTransportPolicy, "relay");
});

test("too-late route application and a replaced global hook fail closed", async () => {
  for (const mutate of [
    (pc) => { pc.localDescription = {}; },
    (pc) => { pc.remoteDescription = {}; },
    (pc) => { pc.iceGatheringState = "gathering"; },
    (pc) => { pc.signalingState = "have-local-offer"; },
  ]) {
    const harness = createHarness();
    const pc = new harness.context.RTCPeerConnection({ bundlePolicy: "max-bundle" });
    const offer = pc.createOffer();
    await flush();
    mutate(pc);
    harness.deliverFreshRoute(route());
    await assert.rejects(offer, { name: "InvalidStateError" });
    assert.equal(pc.offerCount, 0);
  }

  const replaced = createHarness();
  const pc = new replaced.context.RTCPeerConnection({ bundlePolicy: "max-bundle" });
  const offer = pc.createOffer();
  await flush();
  replaced.context.RTCPeerConnection = function Replacement() {};
  replaced.deliverFreshRoute(route());
  await assert.rejects(offer, { name: "InvalidStateError" });
  assert.equal(pc.offerCount, 0);
});

test("setConfiguration merges current immutable fields and Discord cannot remove the route", async () => {
  const harness = createHarness();
  const certificates = [{ id: "cert" }];
  const pc = new harness.context.RTCPeerConnection({
    bundlePolicy: "max-bundle",
    rtcpMuxPolicy: "require",
    certificates,
    iceCandidatePoolSize: 3,
  });
  const offer = pc.createOffer();
  await flush();
  harness.deliverFreshRoute(route());
  await offer;
  pc.setConfiguration({
    iceServers: [{ urls: "turn:external.example:3478" }],
    iceTransportPolicy: "all",
  });
  const applied = pc.calls.at(-1).value;
  assert.equal(applied.bundlePolicy, "max-bundle");
  assert.equal(applied.rtcpMuxPolicy, "require");
  assert.equal(applied.certificates, certificates);
  assert.equal(applied.iceCandidatePoolSize, 3);
  assert.equal(applied.iceTransportPolicy, "relay");
  assert.equal(applied.iceServers[0].urls, "turn:127.0.0.1:49152?transport=udp");
});

test("a terminal configuration failure aborts every pending negotiation delegate", async () => {
  const operations = [
    {
      name: "createOffer",
      prepare() {},
      start(pc) { return pc.createOffer(); },
      nativeType: "createOffer",
    },
    {
      name: "createAnswer",
      prepare(pc) {
        pc.remoteDescription = { type: "offer" };
        pc.signalingState = "have-remote-offer";
      },
      start(pc) { return pc.createAnswer(); },
      nativeType: "createAnswer",
    },
    {
      name: "setLocalDescription",
      prepare() {},
      start(pc) { return pc.setLocalDescription(); },
      nativeType: "setLocalDescription",
    },
    {
      name: "setRemoteDescription",
      prepare() {},
      start(pc) { return pc.setRemoteDescription({ type: "offer" }); },
      nativeType: "setRemoteDescription",
    },
  ];

  for (const operation of operations) {
    const harness = createHarness();
    const pc = new harness.context.RTCPeerConnection({ bundlePolicy: "max-bundle" });
    operation.prepare(pc);
    const pending = operation.start(pc);
    await flush();
    assert.throws(
      () => pc.setConfiguration({ bundlePolicy: "balanced" }),
      { name: "InvalidModificationError" },
      operation.name
    );
    assert.equal(harness.statuses().at(-1).phase, "configuration-error", operation.name);

    harness.deliverFreshRoute(route());
    await assert.rejects(pending, { name: "InvalidStateError" }, operation.name);
    assert.equal(
      pc.calls.filter((entry) => entry.type === operation.nativeType).length,
      0,
      operation.name
    );
    const status = harness.statuses().at(-1);
    assert.equal(status.phase, "configuration-error", operation.name);
    assert.equal(status.verified, false, operation.name);
    assert.equal(status.errorCode, "configuration-error", operation.name);
  }
});

test("an empty PC may be promoted before its first offer but not afterward", async () => {
  const harness = createHarness();
  const promoted = new harness.context.RTCPeerConnection({});
  promoted.setConfiguration({ bundlePolicy: "max-bundle" });
  const promotedOffer = promoted.createOffer();
  await flush();
  harness.deliverFreshRoute(route());
  await promotedOffer;
  assert.equal(promoted.configuration.iceTransportPolicy, "relay");

  const late = new harness.context.RTCPeerConnection({});
  await late.createOffer();
  assert.throws(() => late.setConfiguration({ bundlePolicy: "max-bundle" }), { name: "InvalidStateError" });
});

test("a too-late promotable voice connection stays terminal and cannot be hidden by older green", async () => {
  const harness = createHarness();
  const allocation = {
    id: "f".repeat(32),
    relayAddress: "92.97.232.243",
    relayPort: 62000,
    mappingReady: true,
    peerDatagramsQueued: 2,
    peerDatagramsReceived: 2,
  };
  const activeRoute = route(1, {
    backend: {
      running: true,
      loopbackPreference: true,
      mode: "remote-mapped",
      allocationCount: 1,
      mappingReadyAllocations: 1,
      allocations: [allocation],
      peerDatagramsQueued: 2,
      peerDatagramsReceived: 2,
    },
  });
  const first = new harness.context.RTCPeerConnection({ bundlePolicy: "max-bundle" });
  const firstOffer = first.createOffer();
  await flush();
  harness.deliverFreshRoute(activeRoute);
  await firstOffer;
  first.stats = new Map([
    ["transport", { type: "transport", selectedCandidatePairId: "pair" }],
    ["pair", { type: "candidate-pair", localCandidateId: "local" }],
    ["local", {
      type: "local-candidate",
      candidateType: "relay",
      protocol: "udp",
      address: allocation.relayAddress,
      port: allocation.relayPort,
    }],
  ]);
  first.connectionState = "connected";
  first.iceConnectionState = "connected";
  first.emit("connectionstatechange");
  await flush();
  assert.equal(harness.statuses().at(-1).phase, "verified");

  const late = new harness.context.RTCPeerConnection({});
  await late.createOffer();
  assert.equal(late.offerCount, 1);
  assert.throws(
    () => late.setConfiguration({ bundlePolicy: "max-bundle" }),
    { name: "InvalidStateError" }
  );
  let status = harness.statuses().at(-1);
  assert.equal(status.currentConnectionId, 2);
  assert.equal(status.phase, "reconnect-required");
  assert.equal(status.verified, false);
  assert.equal(status.errorCode, "route-too-late");

  first.emit("connectionstatechange");
  await flush();
  status = harness.statuses().at(-1);
  assert.equal(status.currentConnectionId, 2);
  assert.equal(status.phase, "reconnect-required");
  assert.equal(status.verified, false);
  assert.equal(status.errorCode, "route-too-late");
  await assert.rejects(late.createOffer(), { name: "InvalidStateError" });
  assert.equal(late.offerCount, 1);
});

test("a targeted constructor failure remains newer than an older verified connection", async () => {
  const harness = createHarness();
  const allocation = {
    id: "0".repeat(32),
    relayAddress: "92.97.232.243",
    relayPort: 62000,
    mappingReady: true,
    peerDatagramsQueued: 2,
    peerDatagramsReceived: 2,
  };
  const first = new harness.context.RTCPeerConnection({ bundlePolicy: "max-bundle" });
  const firstOffer = first.createOffer();
  await flush();
  harness.deliverFreshRoute(route(1, {
    backend: {
      running: true,
      loopbackPreference: true,
      mode: "remote-mapped",
      allocationCount: 1,
      mappingReadyAllocations: 1,
      allocations: [allocation],
      peerDatagramsQueued: 2,
      peerDatagramsReceived: 2,
    },
  }));
  await firstOffer;
  first.stats = new Map([
    ["transport", { type: "transport", selectedCandidatePairId: "pair" }],
    ["pair", { type: "candidate-pair", localCandidateId: "local" }],
    ["local", {
      type: "local-candidate",
      candidateType: "relay",
      protocol: "udp",
      address: allocation.relayAddress,
      port: allocation.relayPort,
    }],
  ]);
  first.connectionState = "connected";
  first.iceConnectionState = "connected";
  first.emit("connectionstatechange");
  await flush();
  assert.equal(harness.statuses().at(-1).phase, "verified");

  harness.FakePeerConnection.throwOnConstruct = true;
  assert.throws(
    () => new harness.context.RTCPeerConnection({ bundlePolicy: "max-bundle" }),
    { name: "InvalidModificationError" }
  );
  harness.FakePeerConnection.throwOnConstruct = false;
  let status = harness.statuses().at(-1);
  assert.equal(status.currentConnectionId, 0);
  assert.equal(status.phase, "configuration-error");
  assert.equal(status.errorCode, "constructor-configuration-error");

  first.emit("connectionstatechange");
  await flush();
  status = harness.statuses().at(-1);
  assert.equal(status.currentConnectionId, 0);
  assert.equal(status.phase, "configuration-error");
  assert.equal(status.verified, false);
  assert.equal(status.errorCode, "constructor-configuration-error");
});

test("a blocked thirty-third targeted construction creates a sticky failure epoch", async () => {
  const harness = createHarness();
  const peers = [];
  for (let index = 0; index < 32; index += 1) {
    peers.push(new harness.context.RTCPeerConnection({ bundlePolicy: "max-bundle" }));
  }
  const current = peers.at(-1);
  const allocation = {
    id: "1".repeat(32),
    relayAddress: "92.97.232.243",
    relayPort: 62000,
    mappingReady: true,
    peerDatagramsQueued: 2,
    peerDatagramsReceived: 2,
  };
  const offer = current.createOffer();
  await flush();
  harness.deliverFreshRoute(route(1, {
    backend: {
      running: true,
      loopbackPreference: true,
      mode: "remote-mapped",
      allocationCount: 1,
      mappingReadyAllocations: 1,
      allocations: [allocation],
      peerDatagramsQueued: 2,
      peerDatagramsReceived: 2,
    },
  }));
  await offer;
  current.stats = new Map([
    ["transport", { type: "transport", selectedCandidatePairId: "pair" }],
    ["pair", { type: "candidate-pair", localCandidateId: "local" }],
    ["local", {
      type: "local-candidate",
      candidateType: "relay",
      protocol: "udp",
      address: allocation.relayAddress,
      port: allocation.relayPort,
    }],
  ]);
  current.connectionState = "connected";
  current.iceConnectionState = "connected";
  current.emit("connectionstatechange");
  await flush();
  assert.equal(harness.statuses().at(-1).phase, "verified");

  assert.throws(
    () => new harness.context.RTCPeerConnection({ bundlePolicy: "max-bundle" }),
    { name: "InvalidStateError" }
  );
  let status = harness.statuses().at(-1);
  assert.equal(status.currentConnectionId, 0);
  assert.equal(status.phase, "route-blocked");
  assert.equal(status.verified, false);
  assert.equal(status.errorCode, "connection-limit");

  current.emit("connectionstatechange");
  await flush();
  status = harness.statuses().at(-1);
  assert.equal(status.currentConnectionId, 0);
  assert.equal(status.phase, "route-blocked");
  assert.equal(status.verified, false);
  assert.equal(status.errorCode, "connection-limit");
});

test("success requires selected relay/UDP plus the current active backend", async () => {
  const harness = createHarness();
  const pc = new harness.context.RTCPeerConnection({ bundlePolicy: "max-bundle" });
  const offer = pc.createOffer();
  await flush();
  harness.deliverFreshRoute(route());
  await offer;
  pc.connectionState = "connected";
  pc.iceConnectionState = "connected";
  pc.stats = new Map([
    ["transport", { type: "transport", selectedCandidatePairId: "pair" }],
    ["pair", { type: "candidate-pair", localCandidateId: "local" }],
    // Gecko variants may omit relayProtocol. Because the configured TURN URL
    // is UDP-only, relay + protocol udp remains sufficient evidence.
    ["local", {
      type: "local-candidate",
      candidateType: "relay",
      protocol: "udp",
      address: "92.97.232.243",
      port: 62000,
    }],
  ]);
  pc.emit("connectionstatechange");
  await flush();
  assert.equal(harness.statuses().at(-1).phase, "waiting-for-backend");
  assert.equal(harness.statuses().at(-1).verified, false);

  harness.deliverRoute(route(1, {
    backend: {
      running: true,
      loopbackPreference: true,
      mode: "remote-mapped",
      allocationCount: 1,
      mappingReadyAllocations: 1,
      allocations: [{
        id: "9".repeat(32),
        relayAddress: "92.97.232.244",
        relayPort: 62001,
        mappingReady: true,
        peerDatagramsQueued: 40,
        peerDatagramsReceived: 50,
      }],
      peerDatagramsQueued: 40,
      peerDatagramsReceived: 50,
    },
  }));
  await flush();
  assert.equal(harness.statuses().at(-1).phase, "waiting-for-backend");
  assert.equal(harness.statuses().at(-1).verified, false);

  harness.deliverRoute(route(1, {
    backend: {
      running: true,
      loopbackPreference: true,
      mode: "remote-mapped",
      allocationCount: 1,
      mappingReadyAllocations: 1,
      allocations: [{
        id: "1".repeat(32),
        relayAddress: "92.97.232.243",
        relayPort: 62000,
        mappingReady: true,
        peerDatagramsQueued: 0,
        peerDatagramsReceived: 0,
      }],
      peerDatagramsQueued: 40,
      peerDatagramsReceived: 50,
    },
  }));
  await flush();
  assert.equal(harness.statuses().at(-1).phase, "waiting-for-backend");
  assert.equal(harness.statuses().at(-1).verified, false);

  harness.deliverRoute(route(1, {
    backend: {
      running: true,
      loopbackPreference: true,
      mode: "remote-mapped",
      allocationCount: 1,
      mappingReadyAllocations: 1,
      allocations: [{
        id: "1".repeat(32),
        relayAddress: "92.97.232.243",
        relayPort: 62000,
        mappingReady: true,
        peerDatagramsQueued: 4,
        peerDatagramsReceived: 5,
      }],
      peerDatagramsQueued: 4,
      peerDatagramsReceived: 5,
    },
  }));
  await flush();
  const status = harness.statuses().at(-1);
  assert.equal(status.phase, "verified");
  assert.equal(status.verified, true);
  assert.equal(status.routeRevision, 1);
  const serialized = JSON.stringify(status);
  assert.doesNotMatch(serialized, /127\.0\.0\.1|ephemeral-user|ephemeral-credential|candidate:/u);
});

test("transport-selected stats are authoritative and ambiguous legacy pairs fail closed", async () => {
  async function evaluateReport(stats) {
    const harness = createHarness();
    const pc = new harness.context.RTCPeerConnection({ bundlePolicy: "max-bundle" });
    const offer = pc.createOffer();
    await flush();
    harness.deliverFreshRoute(route(1, {
      backend: {
        running: true,
        loopbackPreference: true,
        mode: "remote-mapped",
        allocationCount: 1,
        mappingReadyAllocations: 1,
        allocations: [{
          id: "2".repeat(32),
          relayAddress: "92.97.232.243",
          relayPort: 62000,
          mappingReady: true,
          peerDatagramsQueued: 2,
          peerDatagramsReceived: 2,
        }],
        peerDatagramsQueued: 2,
        peerDatagramsReceived: 2,
      },
    }));
    await offer;
    pc.stats = stats;
    pc.connectionState = "connected";
    pc.iceConnectionState = "connected";
    pc.emit("connectionstatechange");
    await flush();
    return harness.statuses().at(-1);
  }

  const contradictory = await evaluateReport(new Map([
    ["transport", { type: "transport", selectedCandidatePairId: "current-pair" }],
    ["current-pair", { type: "candidate-pair", localCandidateId: "host-local" }],
    ["stale-pair", {
      type: "candidate-pair",
      selected: true,
      localCandidateId: "relay-local",
    }],
    ["host-local", {
      type: "local-candidate",
      candidateType: "host",
      protocol: "udp",
      address: "192.0.2.10",
      port: 50000,
    }],
    ["relay-local", {
      type: "local-candidate",
      candidateType: "relay",
      protocol: "udp",
      address: "92.97.232.243",
      port: 62000,
    }],
  ]));
  assert.equal(contradictory.phase, "unsafe-direct");
  assert.equal(contradictory.verified, false);
  assert.equal(contradictory.errorCode, "selected-pair-not-relay-udp");

  const ambiguousLegacy = await evaluateReport(new Map([
    ["first-pair", {
      type: "candidate-pair",
      selected: true,
      localCandidateId: "relay-local",
    }],
    ["second-pair", {
      type: "candidate-pair",
      selected: true,
      localCandidateId: "host-local",
    }],
    ["relay-local", {
      type: "local-candidate",
      candidateType: "relay",
      protocol: "udp",
      address: "92.97.232.243",
      port: 62000,
    }],
    ["host-local", {
      type: "local-candidate",
      candidateType: "host",
      protocol: "udp",
      address: "192.0.2.10",
      port: 50000,
    }],
  ]));
  assert.equal(ambiguousLegacy.phase, "diagnostic-error");
  assert.equal(ambiguousLegacy.verified, false);
  assert.equal(ambiguousLegacy.errorCode, "selected-pair-missing");

  const danglingAuthoritative = await evaluateReport(new Map([
    ["transport", { type: "transport", selectedCandidatePairId: "missing-pair" }],
    ["stale-pair", {
      type: "candidate-pair",
      selected: true,
      localCandidateId: "relay-local",
    }],
    ["relay-local", {
      type: "local-candidate",
      candidateType: "relay",
      protocol: "udp",
      address: "92.97.232.243",
      port: 62000,
    }],
  ]));
  assert.equal(danglingAuthoritative.phase, "diagnostic-error");
  assert.equal(danglingAuthoritative.verified, false);
  assert.equal(danglingAuthoritative.errorCode, "selected-pair-missing");

  const multipleAuthoritative = await evaluateReport(new Map([
    ["audio-transport", { type: "transport", selectedCandidatePairId: "relay-pair" }],
    ["video-transport", { type: "transport", selectedCandidatePairId: "missing-pair" }],
    ["relay-pair", { type: "candidate-pair", localCandidateId: "relay-local" }],
    ["relay-local", {
      type: "local-candidate",
      candidateType: "relay",
      protocol: "udp",
      address: "92.97.232.243",
      port: 62000,
    }],
  ]));
  assert.equal(multipleAuthoritative.phase, "diagnostic-error");
  assert.equal(multipleAuthoritative.verified, false);
  assert.equal(multipleAuthoritative.errorCode, "selected-pair-missing");
});

test("a selected unsafe path stays terminal when a previously verified connection closes", async () => {
  const harness = createHarness();
  const allocation = {
    id: "2".repeat(32),
    relayAddress: "92.97.232.243",
    relayPort: 62000,
    mappingReady: true,
    peerDatagramsQueued: 2,
    peerDatagramsReceived: 2,
  };
  const pc = new harness.context.RTCPeerConnection({ bundlePolicy: "max-bundle" });
  const offer = pc.createOffer();
  await flush();
  harness.deliverFreshRoute(route(1, {
    backend: {
      running: true,
      loopbackPreference: true,
      mode: "remote-mapped",
      allocationCount: 1,
      mappingReadyAllocations: 1,
      allocations: [allocation],
      peerDatagramsQueued: 2,
      peerDatagramsReceived: 2,
    },
  }));
  await offer;
  pc.stats = new Map([
    ["transport", { type: "transport", selectedCandidatePairId: "relay-pair" }],
    ["relay-pair", { type: "candidate-pair", localCandidateId: "relay-local" }],
    ["relay-local", {
      type: "local-candidate",
      candidateType: "relay",
      protocol: "udp",
      address: allocation.relayAddress,
      port: allocation.relayPort,
    }],
  ]);
  pc.connectionState = "connected";
  pc.iceConnectionState = "connected";
  pc.emit("connectionstatechange");
  await flush();
  assert.equal(harness.statuses().at(-1).phase, "verified");

  pc.stats = new Map([
    ["transport", { type: "transport", selectedCandidatePairId: "host-pair" }],
    ["host-pair", { type: "candidate-pair", localCandidateId: "host-local" }],
    ["host-local", {
      type: "local-candidate",
      candidateType: "host",
      protocol: "udp",
      address: "192.0.2.10",
      port: 50000,
    }],
  ]);
  pc.emit("connectionstatechange");
  await flush();
  let status = harness.statuses().at(-1);
  assert.equal(status.phase, "unsafe-direct");
  assert.equal(status.verified, false);
  assert.equal(status.errorCode, "selected-pair-not-relay-udp");

  pc.close();
  status = harness.statuses().at(-1);
  assert.equal(status.currentConnectionId, 0);
  assert.equal(status.phase, "reconnect-required");
  assert.equal(status.verified, false);
  assert.equal(status.errorCode, "selected-pair-not-relay-udp");
});

test("a provisional candidate error is cleared by a valid relay candidate", async () => {
  const harness = createHarness();
  const pc = new harness.context.RTCPeerConnection({ bundlePolicy: "max-bundle" });
  const protectedRoute = route(1, {
    backend: {
      running: true,
      loopbackPreference: true,
      mode: "remote-mapped",
      allocationCount: 1,
      mappingReadyAllocations: 1,
      allocations: [{
        id: "3".repeat(32),
        relayAddress: "92.97.232.243",
        relayPort: 62000,
        mappingReady: true,
        peerDatagramsQueued: 2,
        peerDatagramsReceived: 2,
      }],
      peerDatagramsQueued: 2,
      peerDatagramsReceived: 2,
    },
  });
  const offer = pc.createOffer();
  await flush();
  harness.deliverFreshRoute(protectedRoute);
  await offer;

  pc.emit("icecandidateerror", { errorCode: 701 });
  pc.emit("icecandidate", {
    candidate: {
      candidate: "candidate:1 1 udp 1 92.97.232.243 62000 typ relay",
    },
  });
  pc.iceGatheringState = "complete";
  pc.emit("icegatheringstatechange");
  pc.stats = new Map([
    ["transport", { type: "transport", selectedCandidatePairId: "pair" }],
    ["pair", { type: "candidate-pair", localCandidateId: "local" }],
    ["local", {
      type: "local-candidate",
      candidateType: "relay",
      protocol: "udp",
      address: "92.97.232.243",
      port: 62000,
    }],
  ]);
  pc.connectionState = "connected";
  pc.iceConnectionState = "connected";
  pc.emit("connectionstatechange");
  await flush();
  assert.equal(harness.statuses().at(-1).phase, "verified");

  pc.close();
  const closed = harness.statuses().at(-1);
  assert.equal(closed.phase, "hook-ready");
  assert.notEqual(closed.errorCode, "ice-candidate-error");
});

test("a terminal candidate failure cannot be resurrected by a route refresh", async () => {
  const harness = createHarness();
  const backend = {
    running: true,
    loopbackPreference: true,
    mode: "remote-mapped",
    allocationCount: 1,
    mappingReadyAllocations: 1,
    allocations: [{
      id: "a".repeat(32),
      relayAddress: "92.97.232.243",
      relayPort: 62000,
      mappingReady: true,
      peerDatagramsQueued: 2,
      peerDatagramsReceived: 2,
    }],
    peerDatagramsQueued: 2,
    peerDatagramsReceived: 2,
  };
  const pc = new harness.context.RTCPeerConnection({ bundlePolicy: "max-bundle" });
  const offer = pc.createOffer();
  await flush();
  harness.deliverFreshRoute(route(1, { backend }));
  await offer;
  const selectedStats = new Map([
    ["transport", { type: "transport", selectedCandidatePairId: "pair" }],
    ["pair", { type: "candidate-pair", localCandidateId: "local" }],
    ["local", {
      type: "local-candidate",
      candidateType: "relay",
      protocol: "udp",
      address: "92.97.232.243",
      port: 62000,
    }],
  ]);
  const pendingStats = deferred();
  pc.statsPromise = pendingStats.promise;
  pc.connectionState = "connected";
  pc.iceConnectionState = "connected";
  pc.emit("connectionstatechange");
  await flush();
  pc.iceGatheringState = "complete";
  pc.emit("icecandidateerror", { errorCode: 701 });
  assert.equal(harness.statuses().at(-1).errorCode, "ice-candidate-error");

  harness.deliverRoute(route(1, {
    backend: {
      ...backend,
      allocations: [{
        ...backend.allocations[0],
        peerDatagramsQueued: 3,
        peerDatagramsReceived: 3,
      }],
      peerDatagramsQueued: 3,
      peerDatagramsReceived: 3,
    },
  }));
  pendingStats.resolve(selectedStats);
  await flush();
  const status = harness.statuses().at(-1);
  assert.equal(status.phase, "route-blocked");
  assert.equal(status.verified, false);
  assert.equal(status.errorCode, "ice-candidate-error");
});

test("delayed stats from an old backend generation cannot restore success", async () => {
  const harness = createHarness();
  const pc = new harness.context.RTCPeerConnection({ bundlePolicy: "max-bundle" });
  const offer = pc.createOffer();
  await flush();
  harness.deliverFreshRoute(route(1));
  await offer;
  pc.connectionState = "connected";
  pc.iceConnectionState = "connected";
  const pendingStats = deferred();
  pc.statsPromise = pendingStats.promise;
  pc.emit("connectionstatechange");
  await flush();

  harness.deliverRoute(route(2));
  await flush();
  assert.equal(harness.statuses().at(-1).phase, "reconnect-required");
  pendingStats.resolve(new Map([
    ["transport", { type: "transport", selectedCandidatePairId: "pair" }],
    ["pair", { type: "candidate-pair", localCandidateId: "local" }],
    ["local", { type: "local-candidate", candidateType: "relay", protocol: "udp" }],
  ]));
  await flush();
  assert.equal(harness.statuses().at(-1).phase, "reconnect-required");
  assert.equal(harness.statuses().at(-1).verified, false);
});

test("delayed stats cannot restore verification after disconnect or ICE failure", async () => {
  for (const transition of [
    {
      event: "connectionstatechange",
      apply(pc) { pc.connectionState = "disconnected"; },
    },
    {
      event: "iceconnectionstatechange",
      apply(pc) { pc.iceConnectionState = "failed"; },
    },
  ]) {
    const harness = createHarness();
    const pc = new harness.context.RTCPeerConnection({ bundlePolicy: "max-bundle" });
    const offer = pc.createOffer();
    await flush();
    harness.deliverFreshRoute(route(1, {
      backend: {
        running: true,
        loopbackPreference: true,
        mode: "remote-mapped",
        allocationCount: 1,
        mappingReadyAllocations: 1,
        peerDatagramsQueued: 2,
        peerDatagramsReceived: 2,
      },
    }));
    await offer;
    pc.connectionState = "connected";
    pc.iceConnectionState = "connected";
    const pendingStats = deferred();
    pc.statsPromise = pendingStats.promise;
    pc.emit("connectionstatechange");
    await flush();

    transition.apply(pc);
    pc.emit(transition.event);
    await flush();
    assert.equal(harness.statuses().at(-1).verified, false);
    pendingStats.resolve(new Map([
      ["transport", { type: "transport", selectedCandidatePairId: "pair" }],
      ["pair", { type: "candidate-pair", localCandidateId: "local" }],
      ["local", { type: "local-candidate", candidateType: "relay", protocol: "udp" }],
    ]));
    await flush();
    assert.equal(harness.statuses().at(-1).verified, false);
    assert.notEqual(harness.statuses().at(-1).phase, "verified");
  }
});

test("failed and unverified closed states request reconnect while disconnected is transient", async () => {
  for (const failure of [
    {
      event: "iceconnectionstatechange",
      apply(pc) { pc.iceConnectionState = "failed"; },
      errorCode: "ice-connection-failed",
    },
    {
      event: "connectionstatechange",
      apply(pc) { pc.connectionState = "failed"; },
      errorCode: "peer-connection-failed",
    },
  ]) {
    const harness = createHarness();
    const pc = new harness.context.RTCPeerConnection({ bundlePolicy: "max-bundle" });
    const offer = pc.createOffer();
    await flush();
    harness.deliverFreshRoute(route(1));
    await offer;
    pc.connectionState = "connected";
    pc.iceConnectionState = "connected";
    failure.apply(pc);
    pc.emit(failure.event);
    const status = harness.statuses().at(-1);
    assert.equal(status.phase, "reconnect-required");
    assert.equal(status.reconnectRequired, true);
    assert.equal(status.errorCode, failure.errorCode);
    assert.equal(status.verified, false);
  }

  for (const transient of [
    {
      event: "iceconnectionstatechange",
      apply(pc) { pc.iceConnectionState = "disconnected"; },
      phase: "ice-state",
    },
    {
      event: "connectionstatechange",
      apply(pc) { pc.connectionState = "disconnected"; },
      phase: "connection-state",
    },
  ]) {
    const harness = createHarness();
    const pc = new harness.context.RTCPeerConnection({ bundlePolicy: "max-bundle" });
    const offer = pc.createOffer();
    await flush();
    harness.deliverFreshRoute(route(1));
    await offer;
    pc.connectionState = "connected";
    pc.iceConnectionState = "connected";
    transient.apply(pc);
    pc.emit(transient.event);
    const status = harness.statuses().at(-1);
    assert.equal(status.phase, transient.phase);
    assert.equal(status.reconnectRequired, false);
    assert.equal(status.verified, false);
    assert.equal(status.errorCode, null);
  }

  const closedHarness = createHarness();
  const closedPc = new closedHarness.context.RTCPeerConnection({ bundlePolicy: "max-bundle" });
  const closedOffer = closedPc.createOffer();
  await flush();
  closedHarness.deliverFreshRoute(route(1));
  await closedOffer;
  closedPc.connectionState = "closed";
  closedPc.emit("connectionstatechange");
  const closedStatus = closedHarness.statuses().at(-1);
  assert.equal(closedStatus.phase, "reconnect-required");
  assert.equal(closedStatus.reconnectRequired, true);
  assert.equal(closedStatus.verified, false);
  assert.equal(closedStatus.errorCode, "closed-after-route-applied");
  assert.equal(closedStatus.closedUnverifiedConnections, 1);
});

test("cleanly closing the newest connection restores a non-green inactive fallback", async () => {
  const harness = createHarness();
  const first = new harness.context.RTCPeerConnection({ bundlePolicy: "max-bundle" });
  const firstOffer = first.createOffer();
  await flush();
  harness.deliverFreshRoute(route());
  await firstOffer;

  const second = new harness.context.RTCPeerConnection({ sdpSemantics: "plan-b" });
  const secondOffer = second.createOffer();
  await flush();
  harness.deliverFreshRoute(route());
  await secondOffer;
  assert.equal(harness.statuses().at(-1).currentConnectionId, 2);
  second.stats = new Map([
    ["transport", { type: "transport", selectedCandidatePairId: "pair" }],
    ["pair", { type: "candidate-pair", localCandidateId: "local" }],
    ["local", {
      type: "local-candidate",
      candidateType: "relay",
      protocol: "udp",
      address: "92.97.232.243",
      port: 62000,
    }],
  ]);
  harness.deliverRoute(route(1, {
    backend: {
      running: true,
      loopbackPreference: true,
      mode: "remote-mapped",
      allocationCount: 1,
      mappingReadyAllocations: 1,
      allocations: [{
        id: "4".repeat(32),
        relayAddress: "92.97.232.243",
        relayPort: 62000,
        mappingReady: true,
        peerDatagramsQueued: 2,
        peerDatagramsReceived: 2,
      }],
      peerDatagramsQueued: 2,
      peerDatagramsReceived: 2,
    },
  }));
  second.connectionState = "connected";
  second.iceConnectionState = "connected";
  second.emit("connectionstatechange");
  await flush();
  assert.equal(harness.statuses().at(-1).phase, "verified");

  second.close();
  const restored = harness.statuses().at(-1);
  assert.equal(restored.currentConnectionId, 1);
  assert.equal(restored.targetedConnections, 1);
  assert.equal(restored.phase, "connection-state");
  assert.equal(restored.applied, true);
  assert.equal(restored.verified, false);
  assert.equal(restored.selectedCandidate, null);
});

test("a connected fallback clears cached green until fresh stats complete", async () => {
  const harness = createHarness();
  const first = new harness.context.RTCPeerConnection({ bundlePolicy: "max-bundle" });
  const firstOffer = first.createOffer();
  await flush();
  harness.deliverFreshRoute(route());
  await firstOffer;
  const firstStats = deferred();
  first.statsPromise = firstStats.promise;
  first.connectionState = "connected";
  first.iceConnectionState = "connected";
  first.emit("connectionstatechange");
  await flush();

  const allocations = [{
    id: "5".repeat(32),
    relayAddress: "92.97.232.243",
    relayPort: 62000,
    mappingReady: true,
    peerDatagramsQueued: 2,
    peerDatagramsReceived: 2,
  }, {
    id: "6".repeat(32),
    relayAddress: "92.97.232.244",
    relayPort: 62001,
    mappingReady: true,
    peerDatagramsQueued: 2,
    peerDatagramsReceived: 2,
  }];
  const activeRoute = route(1, {
    backend: {
      running: true,
      loopbackPreference: true,
      mode: "remote-mapped",
      allocationCount: 2,
      mappingReadyAllocations: 2,
      allocations,
      peerDatagramsQueued: 4,
      peerDatagramsReceived: 4,
    },
  });
  const second = new harness.context.RTCPeerConnection({ sdpSemantics: "plan-b" });
  const secondOffer = second.createOffer();
  await flush();
  harness.deliverFreshRoute(activeRoute);
  await secondOffer;

  const firstSelectedStats = new Map([
    ["transport", { type: "transport", selectedCandidatePairId: "pair" }],
    ["pair", { type: "candidate-pair", localCandidateId: "local" }],
    ["local", {
      type: "local-candidate",
      candidateType: "relay",
      protocol: "udp",
      address: "92.97.232.243",
      port: 62000,
    }],
  ]);
  firstStats.resolve(firstSelectedStats);
  await flush();

  second.stats = new Map([
    ["transport", { type: "transport", selectedCandidatePairId: "pair" }],
    ["pair", { type: "candidate-pair", localCandidateId: "local" }],
    ["local", {
      type: "local-candidate",
      candidateType: "relay",
      protocol: "udp",
      address: "92.97.232.244",
      port: 62001,
    }],
  ]);
  second.connectionState = "connected";
  second.iceConnectionState = "connected";
  second.emit("connectionstatechange");
  await flush();
  assert.equal(harness.statuses().at(-1).phase, "verified");

  const fallbackStats = deferred();
  first.statsPromise = fallbackStats.promise;
  second.close();
  const pending = harness.statuses().at(-1);
  assert.equal(pending.currentConnectionId, 1);
  assert.equal(pending.phase, "connection-state");
  assert.equal(pending.verified, false);
  assert.equal(pending.selectedCandidate, null);

  fallbackStats.resolve(firstSelectedStats);
  await flush();
  const restored = harness.statuses().at(-1);
  assert.equal(restored.currentConnectionId, 1);
  assert.equal(restored.phase, "verified");
  assert.equal(restored.verified, true);
});

test("queued fallback lifecycle state cannot revive cached verification", async () => {
  const scenarios = [
    {
      name: "disconnected",
      apply(pc) { pc.connectionState = "disconnected"; },
      phase: "connection-state",
      currentConnectionId: 1,
      errorCode: null,
    },
    {
      name: "failed",
      apply(pc) { pc.connectionState = "failed"; },
      phase: "reconnect-required",
      currentConnectionId: 1,
      errorCode: "peer-connection-failed",
    },
    {
      name: "closed",
      apply(pc) { pc.connectionState = "closed"; },
      phase: "hook-ready",
      currentConnectionId: 0,
      errorCode: null,
    },
  ];

  for (const scenario of scenarios) {
    const harness = createHarness();
    const allocations = [{
      id: "9".repeat(32),
      relayAddress: "92.97.232.243",
      relayPort: 62000,
      mappingReady: true,
      peerDatagramsQueued: 2,
      peerDatagramsReceived: 2,
    }, {
      id: "a".repeat(32),
      relayAddress: "92.97.232.244",
      relayPort: 62001,
      mappingReady: true,
      peerDatagramsQueued: 2,
      peerDatagramsReceived: 2,
    }];
    const activeRoute = route(1, {
      backend: {
        running: true,
        loopbackPreference: true,
        mode: "remote-mapped",
        allocationCount: 2,
        mappingReadyAllocations: 2,
        allocations,
        peerDatagramsQueued: 4,
        peerDatagramsReceived: 4,
      },
    });

    const first = new harness.context.RTCPeerConnection({ bundlePolicy: "max-bundle" });
    const firstOffer = first.createOffer();
    await flush();
    harness.deliverFreshRoute(activeRoute);
    await firstOffer;
    first.stats = new Map([
      ["transport", { type: "transport", selectedCandidatePairId: "pair" }],
      ["pair", { type: "candidate-pair", localCandidateId: "local" }],
      ["local", {
        type: "local-candidate",
        candidateType: "relay",
        protocol: "udp",
        address: allocations[0].relayAddress,
        port: allocations[0].relayPort,
      }],
    ]);
    first.connectionState = "connected";
    first.iceConnectionState = "connected";
    first.emit("connectionstatechange");
    await flush();
    assert.equal(harness.statuses().at(-1).phase, "verified", scenario.name);

    const second = new harness.context.RTCPeerConnection({ sdpSemantics: "plan-b" });
    const secondOffer = second.createOffer();
    await flush();
    harness.deliverFreshRoute(activeRoute);
    await secondOffer;
    second.stats = new Map([
      ["transport", { type: "transport", selectedCandidatePairId: "pair" }],
      ["pair", { type: "candidate-pair", localCandidateId: "local" }],
      ["local", {
        type: "local-candidate",
        candidateType: "relay",
        protocol: "udp",
        address: allocations[1].relayAddress,
        port: allocations[1].relayPort,
      }],
    ]);
    second.connectionState = "connected";
    second.iceConnectionState = "connected";
    second.emit("connectionstatechange");
    await flush();
    assert.equal(harness.statuses().at(-1).phase, "verified", scenario.name);

    // Simulate a native lifecycle transition whose queued event has not yet
    // reached the hook when the newer call closes.
    scenario.apply(first);
    second.close();
    const restored = harness.statuses().at(-1);
    assert.equal(restored.phase, scenario.phase, scenario.name);
    assert.equal(restored.currentConnectionId, scenario.currentConnectionId, scenario.name);
    assert.equal(restored.verified, false, scenario.name);
    assert.equal(restored.selectedCandidate, null, scenario.name);
    assert.equal(restored.errorCode, scenario.errorCode, scenario.name);
  }
});

test("a duplicate connected event clears cached green while stats revalidation stalls", async () => {
  for (const eventName of ["connectionstatechange", "iceconnectionstatechange"]) {
    const harness = createHarness();
    const allocation = {
      id: "c".repeat(32),
      relayAddress: "92.97.232.243",
      relayPort: 62000,
      mappingReady: true,
      peerDatagramsQueued: 2,
      peerDatagramsReceived: 2,
    };
    const pc = new harness.context.RTCPeerConnection({ bundlePolicy: "max-bundle" });
    const offer = pc.createOffer();
    await flush();
    harness.deliverFreshRoute(route(1, {
      backend: {
        running: true,
        loopbackPreference: true,
        mode: "remote-mapped",
        allocationCount: 1,
        mappingReadyAllocations: 1,
        allocations: [allocation],
        peerDatagramsQueued: 2,
        peerDatagramsReceived: 2,
      },
    }));
    await offer;
    const selectedStats = new Map([
      ["transport", { type: "transport", selectedCandidatePairId: "pair" }],
      ["pair", { type: "candidate-pair", localCandidateId: "local" }],
      ["local", {
        type: "local-candidate",
        candidateType: "relay",
        protocol: "udp",
        address: allocation.relayAddress,
        port: allocation.relayPort,
      }],
    ]);
    pc.stats = selectedStats;
    pc.connectionState = "connected";
    pc.iceConnectionState = "connected";
    pc.emit("connectionstatechange");
    await flush();
    assert.equal(harness.statuses().at(-1).phase, "verified", eventName);

    const stalled = deferred();
    pc.statsPromise = stalled.promise;
    pc.emit(eventName);
    await flush();
    const pending = harness.statuses().at(-1);
    assert.equal(pending.verified, false, eventName);
    assert.equal(pending.selectedCandidate, null, eventName);
    assert.notEqual(pending.phase, "verified", eventName);

    stalled.resolve(selectedStats);
    await flush();
    assert.equal(harness.statuses().at(-1).phase, "verified", eventName);
  }
});

test("an accepted route refresh clears cached green while stats revalidation stalls", async () => {
  const harness = createHarness();
  const allocation = {
    id: "3".repeat(32),
    relayAddress: "92.97.232.243",
    relayPort: 62000,
    mappingReady: true,
    peerDatagramsQueued: 2,
    peerDatagramsReceived: 2,
  };
  const backend = (queued, received) => ({
    running: true,
    loopbackPreference: true,
    mode: "remote-mapped",
    allocationCount: 1,
    mappingReadyAllocations: 1,
    allocations: [{ ...allocation, peerDatagramsQueued: queued, peerDatagramsReceived: received }],
    peerDatagramsQueued: queued,
    peerDatagramsReceived: received,
  });
  const pc = new harness.context.RTCPeerConnection({ bundlePolicy: "max-bundle" });
  const offer = pc.createOffer();
  await flush();
  harness.deliverFreshRoute(route(1, { backend: backend(2, 2) }));
  await offer;
  const selectedStats = new Map([
    ["transport", { type: "transport", selectedCandidatePairId: "pair" }],
    ["pair", { type: "candidate-pair", localCandidateId: "local" }],
    ["local", {
      type: "local-candidate",
      candidateType: "relay",
      protocol: "udp",
      address: allocation.relayAddress,
      port: allocation.relayPort,
    }],
  ]);
  pc.stats = selectedStats;
  pc.connectionState = "connected";
  pc.iceConnectionState = "connected";
  pc.emit("connectionstatechange");
  await flush();
  assert.equal(harness.statuses().at(-1).phase, "verified");

  const stalled = deferred();
  pc.statsPromise = stalled.promise;
  harness.deliverRoute(route(1, { routeRevision: 2, backend: backend(3, 3) }));
  await flush();
  const pending = harness.statuses().at(-1);
  assert.equal(pending.phase, "connection-state");
  assert.equal(pending.verified, false);
  assert.equal(pending.selectedCandidate, null);

  stalled.resolve(selectedStats);
  await flush();
  assert.equal(harness.statuses().at(-1).phase, "verified");
});

test("a status poll reconciles queued native lifecycle state before cached green", async () => {
  const scenarios = [
    {
      name: "peer disconnected",
      apply(pc) { pc.connectionState = "disconnected"; },
      phase: "connection-state",
      currentConnectionId: 1,
      reconnectRequired: false,
      errorCode: null,
    },
    {
      name: "ICE disconnected",
      apply(pc) { pc.iceConnectionState = "disconnected"; },
      phase: "ice-state",
      currentConnectionId: 1,
      reconnectRequired: false,
      errorCode: null,
    },
    {
      name: "peer failed",
      apply(pc) { pc.connectionState = "failed"; },
      phase: "reconnect-required",
      currentConnectionId: 1,
      reconnectRequired: true,
      errorCode: "peer-connection-failed",
    },
    {
      name: "ICE failed",
      apply(pc) { pc.iceConnectionState = "failed"; },
      phase: "reconnect-required",
      currentConnectionId: 1,
      reconnectRequired: true,
      errorCode: "ice-connection-failed",
    },
    {
      name: "peer closed",
      apply(pc) { pc.connectionState = "closed"; },
      phase: "hook-ready",
      currentConnectionId: 0,
      reconnectRequired: false,
      errorCode: null,
    },
  ];

  for (const scenario of scenarios) {
    const harness = createHarness();
    const allocation = {
      id: "d".repeat(32),
      relayAddress: "92.97.232.243",
      relayPort: 62000,
      mappingReady: true,
      peerDatagramsQueued: 2,
      peerDatagramsReceived: 2,
    };
    const pc = new harness.context.RTCPeerConnection({ bundlePolicy: "max-bundle" });
    const offer = pc.createOffer();
    await flush();
    harness.deliverFreshRoute(route(1, {
      backend: {
        running: true,
        loopbackPreference: true,
        mode: "remote-mapped",
        allocationCount: 1,
        mappingReadyAllocations: 1,
        allocations: [allocation],
        peerDatagramsQueued: 2,
        peerDatagramsReceived: 2,
      },
    }));
    await offer;
    pc.stats = new Map([
      ["transport", { type: "transport", selectedCandidatePairId: "pair" }],
      ["pair", { type: "candidate-pair", localCandidateId: "local" }],
      ["local", {
        type: "local-candidate",
        candidateType: "relay",
        protocol: "udp",
        address: allocation.relayAddress,
        port: allocation.relayPort,
      }],
    ]);
    pc.connectionState = "connected";
    pc.iceConnectionState = "connected";
    pc.emit("connectionstatechange");
    await flush();
    assert.equal(harness.statuses().at(-1).phase, "verified", scenario.name);

    // Change only the native state. Its event has not reached the page hook
    // when the popup asks for a fresh status snapshot.
    scenario.apply(pc);
    harness.requestPageStatus(17);
    const status = harness.statuses().at(-1);
    assert.equal(harness.posted.at(-1).message.statusRequestId, 17, scenario.name);
    assert.equal(status.phase, scenario.phase, scenario.name);
    assert.equal(status.currentConnectionId, scenario.currentConnectionId, scenario.name);
    assert.equal(status.verified, false, scenario.name);
    assert.equal(status.selectedCandidate, null, scenario.name);
    assert.equal(status.reconnectRequired, scenario.reconnectRequired, scenario.name);
    assert.equal(status.errorCode, scenario.errorCode, scenario.name);
  }
});

test("missing selected-pair stats clear internal verification before a later stats read stalls", async () => {
  const harness = createHarness();
  const allocation = {
    id: "b".repeat(32),
    relayAddress: "92.97.232.243",
    relayPort: 62000,
    mappingReady: true,
    peerDatagramsQueued: 2,
    peerDatagramsReceived: 2,
  };
  const pc = new harness.context.RTCPeerConnection({ bundlePolicy: "max-bundle" });
  const offer = pc.createOffer();
  await flush();
  harness.deliverFreshRoute(route(1, {
    backend: {
      running: true,
      loopbackPreference: true,
      mode: "remote-mapped",
      allocationCount: 1,
      mappingReadyAllocations: 1,
      allocations: [allocation],
      peerDatagramsQueued: 2,
      peerDatagramsReceived: 2,
    },
  }));
  await offer;
  pc.stats = new Map([
    ["transport", { type: "transport", selectedCandidatePairId: "pair" }],
    ["pair", { type: "candidate-pair", localCandidateId: "local" }],
    ["local", {
      type: "local-candidate",
      candidateType: "relay",
      protocol: "udp",
      address: allocation.relayAddress,
      port: allocation.relayPort,
    }],
  ]);
  pc.connectionState = "connected";
  pc.iceConnectionState = "connected";
  pc.emit("connectionstatechange");
  await flush();
  assert.equal(harness.statuses().at(-1).phase, "verified");

  pc.stats = new Map();
  pc.emit("connectionstatechange");
  await flush();
  const missing = harness.statuses().at(-1);
  assert.equal(missing.phase, "diagnostic-error");
  assert.equal(missing.errorCode, "selected-pair-missing");
  assert.equal(missing.verified, false);
  assert.equal(missing.selectedCandidate, null);

  const stalled = deferred();
  pc.statsPromise = stalled.promise;
  pc.emit("connectionstatechange");
  await flush();
  const waiting = harness.statuses().at(-1);
  assert.equal(waiting.phase, "connection-state");
  assert.equal(waiting.verified, false);
  assert.equal(waiting.selectedCandidate, null);
  stalled.resolve(new Map());
  await flush();
  assert.equal(harness.statuses().at(-1).verified, false);
});

test("a removed bound allocation revokes cached green fallback synchronously", async () => {
  const harness = createHarness();
  const allocationA = {
    id: "7".repeat(32),
    relayAddress: "92.97.232.243",
    relayPort: 62000,
    mappingReady: true,
    peerDatagramsQueued: 2,
    peerDatagramsReceived: 2,
  };
  const allocationB = {
    id: "8".repeat(32),
    relayAddress: "92.97.232.244",
    relayPort: 62001,
    mappingReady: true,
    peerDatagramsQueued: 2,
    peerDatagramsReceived: 2,
  };
  const backendWith = (allocations) => ({
    running: true,
    loopbackPreference: true,
    mode: "remote-mapped",
    allocationCount: allocations.length,
    mappingReadyAllocations: allocations.length,
    allocations,
    peerDatagramsQueued: 4,
    peerDatagramsReceived: 4,
  });
  const bothRoute = route(1, { backend: backendWith([allocationA, allocationB]) });

  const first = new harness.context.RTCPeerConnection({ bundlePolicy: "max-bundle" });
  const firstOffer = first.createOffer();
  await flush();
  harness.deliverFreshRoute(bothRoute);
  await firstOffer;
  first.stats = new Map([
    ["transport", { type: "transport", selectedCandidatePairId: "pair" }],
    ["pair", { type: "candidate-pair", localCandidateId: "local" }],
    ["local", {
      type: "local-candidate",
      candidateType: "relay",
      protocol: "udp",
      address: allocationA.relayAddress,
      port: allocationA.relayPort,
    }],
  ]);
  first.connectionState = "connected";
  first.iceConnectionState = "connected";
  first.emit("connectionstatechange");
  await flush();
  assert.equal(harness.statuses().at(-1).phase, "verified");

  const second = new harness.context.RTCPeerConnection({ sdpSemantics: "plan-b" });
  const secondOffer = second.createOffer();
  await flush();
  harness.deliverFreshRoute(bothRoute);
  await secondOffer;
  second.stats = new Map([
    ["transport", { type: "transport", selectedCandidatePairId: "pair" }],
    ["pair", { type: "candidate-pair", localCandidateId: "local" }],
    ["local", {
      type: "local-candidate",
      candidateType: "relay",
      protocol: "udp",
      address: allocationB.relayAddress,
      port: allocationB.relayPort,
    }],
  ]);
  second.connectionState = "connected";
  second.iceConnectionState = "connected";
  second.emit("connectionstatechange");
  await flush();
  assert.equal(harness.statuses().at(-1).phase, "verified");

  const stalledStats = deferred();
  first.statsPromise = stalledStats.promise;
  harness.deliverRoute(route(1, { backend: backendWith([allocationB]) }));
  await flush();
  assert.equal(harness.statuses().at(-1).phase, "verified");

  second.close();
  const restored = harness.statuses().at(-1);
  assert.equal(restored.currentConnectionId, 1);
  assert.equal(restored.phase, "waiting-for-backend");
  assert.equal(restored.verified, false);
});

test("a failed newest connection is not hidden by an older protected connection", async () => {
  const harness = createHarness();
  const first = new harness.context.RTCPeerConnection({ bundlePolicy: "max-bundle" });
  const firstOffer = first.createOffer();
  await flush();
  harness.deliverFreshRoute(route());
  await firstOffer;

  const second = new harness.context.RTCPeerConnection({ sdpSemantics: "plan-b" });
  const secondOffer = second.createOffer();
  await flush();
  harness.deliverFreshRoute(route());
  await secondOffer;
  second.close();

  const failure = harness.statuses().at(-1);
  assert.equal(failure.currentConnectionId, 0);
  assert.equal(failure.targetedConnections, 1);
  assert.equal(failure.phase, "reconnect-required");
  assert.equal(failure.errorCode, "closed-after-route-applied");
  assert.equal(failure.closedUnverifiedConnections, 1);

  first.close();
  const afterFallbackClose = harness.statuses().at(-1);
  assert.equal(afterFallbackClose.phase, "reconnect-required");
  assert.equal(afterFallbackClose.targetedConnections, 0);
});

test("old injected hook is blocked and requires a page reload", () => {
  const harness = createHarness({ oldHook: true });
  assert.throws(
    () => new harness.context.RTCPeerConnection({ bundlePolicy: "max-bundle" }),
    { name: "InvalidStateError" }
  );
  assert.equal(harness.constructorCalls.length, 0);
  assert.equal(harness.statuses().some((status) => status.phase === "reload-required"), true);
});

test("a hostile configuration getter fails only that construction", () => {
  const harness = createHarness();
  const hostile = Object.defineProperty({}, "sdpSemantics", {
    get() { throw new Error("getter failed"); },
  });
  assert.throws(() => new harness.context.RTCPeerConnection(hostile), /getter failed/u);
  const later = new harness.context.RTCPeerConnection({ bundlePolicy: "max-bundle" });
  assert.ok(later instanceof harness.FakePeerConnection);
});
