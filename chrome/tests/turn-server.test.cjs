"use strict";

// Hermetic regression test for the Chromium TURN bridge. The privileged
// socket API is replaced by a node:dgram backed mock, so the whole
// Allocate / permission / channel / relay flow runs without a browser and
// without touching the network.

const assert = require("node:assert/strict");
const dgram = require("node:dgram");
const crypto = require("node:crypto");
const test = require("node:test");

const codec = require("../lib/turn-codec.js");

function createMockChrome() {
  const sockets = new Map();
  const receiveListeners = [];
  const receiveErrorListeners = [];
  const outbound = [];
  let nextId = 1;

  function deliver(socketId, data, remoteAddress, remotePort) {
    const copy = Uint8Array.from(data);
    for (const listener of receiveListeners) {
      listener({
        socketId,
        data: copy.buffer,
        remoteAddress,
        remotePort,
      });
    }
  }

  const api = {
    runtime: { id: "test-extension", lastError: undefined },
    sockets: {
      udp: {
        async create(properties = {}) {
          const socketId = nextId++;
          const socket = dgram.createSocket("udp4");
          const record = {
            socketId,
            name: properties.name || "",
            persistent: properties.persistent === true,
            bufferSize: properties.bufferSize || 4096,
            paused: false,
            localAddress: null,
            localPort: null,
            socket,
            closed: false,
          };
          socket.on("message", (message, rinfo) => {
            if (record.paused) return;
            deliver(socketId, new Uint8Array(message), rinfo.address, rinfo.port);
          });
          socket.on("error", () => {});
          sockets.set(socketId, record);
          return { socketId };
        },
        bind(socketId, address, port, callback) {
          const record = sockets.get(socketId);
          if (!record) {
            api.runtime.lastError = { message: "invalid socket" };
            callback(-1);
            return;
          }
          record.socket.bind(port, address, () => {
            const info = record.socket.address();
            record.localAddress = info.address;
            record.localPort = info.port;
            callback(0);
          });
        },
        send(socketId, data, address, port, dnsQueryType, callback) {
          const record = sockets.get(socketId);
          if (!record) {
            api.runtime.lastError = { message: "invalid socket" };
            callback({ resultCode: -1 });
            return;
          }
          const bytes = new Uint8Array(data);
          outbound.push({
            socketId,
            address,
            port,
            bytes: Array.from(bytes),
            dnsQueryType,
          });
          if (address === "127.0.0.1" || address === "localhost") {
            record.socket.send(bytes, port, "127.0.0.1", (error) => {
              callback(error ? { resultCode: -1 } : { resultCode: 0, bytesSent: bytes.length });
            });
            return;
          }
          // Off-host destinations are recorded but never actually sent, so the
          // test stays hermetic.
          callback({ resultCode: 0, bytesSent: bytes.length });
        },
        async close(socketId) {
          const record = sockets.get(socketId);
          if (!record) return undefined;
          record.closed = true;
          sockets.delete(socketId);
          try {
            record.socket.close();
          } catch (error) {
            // already closed
          }
          return undefined;
        },
        async getInfo(socketId) {
          const record = sockets.get(socketId);
          if (!record) throw new Error("invalid socket");
          return {
            socketId,
            persistent: record.persistent,
            name: record.name,
            bufferSize: record.bufferSize,
            paused: record.paused,
            localAddress: record.localAddress,
            localPort: record.localPort,
          };
        },
        async getSockets() {
          return Array.from(sockets.values()).map((record) => ({
            socketId: record.socketId,
            persistent: record.persistent,
            name: record.name,
            bufferSize: record.bufferSize,
            paused: record.paused,
            localAddress: record.localAddress,
            localPort: record.localPort,
          }));
        },
        async setPaused(socketId, paused) {
          const record = sockets.get(socketId);
          if (record) record.paused = paused === true;
          return undefined;
        },
        onReceive: {
          addListener(listener) { receiveListeners.push(listener); },
          removeListener() {},
        },
        onReceiveError: {
          addListener(listener) { receiveErrorListeners.push(listener); },
          removeListener() {},
        },
      },
    },
  };

  return { api, sockets, outbound, receiveErrorListeners, deliver };
}

const mock = createMockChrome();
globalThis.chrome = mock.api;
const turnServer = require("../src/turn-server.js");

// In the browser the service worker wires the socket events to the bridge.
mock.api.sockets.udp.onReceive.addListener((info) => turnServer.handleUdpReceive(info));
mock.api.sockets.udp.onReceiveError.addListener((info) => turnServer.handleUdpReceiveError(info));

function build(method, attributes, key, messageClass = codec.CLASS.REQUEST) {
  const transactionId = new Uint8Array(12);
  crypto.randomFillSync(transactionId);
  return codec.encodeMessage({
    method, class: messageClass, transactionId, attributes, key: key || null,
  });
}

function exchange(socket, port, bytes, timeoutMs = 4000) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      socket.off("message", onMessage);
      resolve(null);
    }, timeoutMs);
    const onMessage = (message) => {
      clearTimeout(timer);
      socket.off("message", onMessage);
      resolve(new Uint8Array(message));
    };
    socket.on("message", onMessage);
    socket.send(bytes, port, "127.0.0.1");
  });
}

let route = null;
let client = null;
let key = null;
let realm = null;
let nonce = null;
let clientPort = null;

function errorCode(message) {
  const attribute = codec.getAttribute(message, codec.ATTR.ERROR_CODE);
  if (!attribute || attribute.value.length < 4) return null;
  return attribute.value[2] * 100 + attribute.value[3];
}

test("the loopback TURN bridge starts and binds a control socket", async () => {
  const result = await turnServer.start({
    mode: "local-test",
    mappingProbeServers: [],
  });
  assert.equal(result.__apiError, undefined);
  assert.equal(result.running, true);
  assert.equal(result.controlSocketBound, true);
  assert.equal(result.address, "127.0.0.1");
  assert.match(result.turnUrl, /^turn:127\.0\.0\.1:\d+\?transport=udp$/u);
  route = result;
  key = codec.longTermKey(result.username, "discord-direct.local", result.credential);
  realm = "discord-direct.local";
  client = dgram.createSocket("udp4");
  await new Promise((resolve) => client.bind(0, "127.0.0.1", resolve));
  clientPort = client.address().port;
});

test("an unauthenticated Allocate is answered with a 401 challenge", async () => {
  const reply = await exchange(client, route.port, build(codec.METHOD.ALLOCATE, [
    codec.attribute(codec.ATTR.REQUESTED_TRANSPORT, Uint8Array.of(17, 0, 0, 0)),
    codec.textAttribute(codec.ATTR.USERNAME, route.username),
    codec.textAttribute(codec.ATTR.REALM, realm),
  ]));
  assert.ok(reply, "expected a challenge");
  const message = codec.decodeMessage(reply);
  assert.equal(message.class, codec.CLASS.ERROR);
  assert.equal(errorCode(message), 401);
  nonce = codec.attributeText(message, codec.ATTR.NONCE);
  assert.equal(typeof nonce, "string");
  assert.ok(nonce.length > 0);
});

test("an authenticated Allocate succeeds and advertises the relay address", async () => {
  const reply = await exchange(client, route.port, build(codec.METHOD.ALLOCATE, [
    codec.attribute(codec.ATTR.REQUESTED_TRANSPORT, Uint8Array.of(17, 0, 0, 0)),
    codec.textAttribute(codec.ATTR.USERNAME, route.username),
    codec.textAttribute(codec.ATTR.REALM, realm),
    codec.textAttribute(codec.ATTR.NONCE, nonce),
  ], key));
  assert.ok(reply);
  const message = codec.decodeMessage(reply);
  assert.equal(message.class, codec.CLASS.SUCCESS);
  const relayed = codec.getAttribute(message, codec.ATTR.XOR_RELAYED_ADDRESS);
  assert.ok(relayed, "the Allocate success must carry a relay address");
  const relay = codec.decodeAddress(relayed.value, message.transactionId);
  assert.equal(relay.address, "127.0.0.1");
  assert.ok(relay.port > 0);
});

test("permissions for private peers are refused", async () => {
  const reply = await exchange(client, route.port, build(codec.METHOD.CREATE_PERMISSION, [
    codec.textAttribute(codec.ATTR.USERNAME, route.username),
    codec.textAttribute(codec.ATTR.REALM, realm),
    codec.textAttribute(codec.ATTR.NONCE, nonce),
    codec.attribute(codec.ATTR.XOR_PEER_ADDRESS, codec.encodeAddress("127.0.0.1", 5000, new Uint8Array(12))),
  ], key));
  const message = codec.decodeMessage(reply);
  assert.equal(message.class, codec.CLASS.ERROR);
  assert.equal(errorCode(message), 403);
});

test("a public peer is permitted and a channel can be bound", async () => {
  const peer = { address: "1.1.1.1", port: 5000 };
  const permission = await exchange(client, route.port, build(codec.METHOD.CREATE_PERMISSION, [
    codec.textAttribute(codec.ATTR.USERNAME, route.username),
    codec.textAttribute(codec.ATTR.REALM, realm),
    codec.textAttribute(codec.ATTR.NONCE, nonce),
    codec.attribute(codec.ATTR.XOR_PEER_ADDRESS, codec.encodeAddress(peer.address, peer.port, new Uint8Array(12))),
  ], key));
  assert.equal(codec.decodeMessage(permission).class, codec.CLASS.SUCCESS);

  const channel = await exchange(client, route.port, build(codec.METHOD.CHANNEL_BIND, [
    codec.textAttribute(codec.ATTR.USERNAME, route.username),
    codec.textAttribute(codec.ATTR.REALM, realm),
    codec.textAttribute(codec.ATTR.NONCE, nonce),
    codec.attribute(codec.ATTR.CHANNEL_NUMBER, codec.uint16(0x4000)),
    codec.attribute(codec.ATTR.XOR_PEER_ADDRESS, codec.encodeAddress(peer.address, peer.port, new Uint8Array(12))),
  ], key));
  assert.equal(codec.decodeMessage(channel).class, codec.CLASS.SUCCESS);
});

test("a Send indication is relayed once, behind the two prelude packets", async () => {
  mock.outbound.length = 0;
  const peer = { address: "1.1.1.1", port: 5000 };
  await exchange(client, route.port, build(codec.METHOD.SEND, [
    codec.attribute(codec.ATTR.XOR_PEER_ADDRESS, codec.encodeAddress(peer.address, peer.port, new Uint8Array(12))),
    codec.attribute(codec.ATTR.DATA, Uint8Array.of(0xde, 0xad, 0xbe, 0xef)),
  ], null, codec.CLASS.INDICATION), 400);

  const relayed = mock.outbound.filter((entry) => entry.address === peer.address);
  const payloads = relayed.map((entry) => entry.bytes);
  assert.deepEqual(payloads[0], [0]);
  assert.deepEqual(payloads[1], [1]);
  assert.deepEqual(payloads[2], [0xde, 0xad, 0xbe, 0xef]);
  assert.equal(payloads.length, 3, "the payload must be sent exactly once");
});

test("peer traffic is relayed back to the client as a data indication", async () => {
  const relaySocket = mock.outbound.find((entry) => entry.address === "1.1.1.1");
  assert.ok(relaySocket, "the relay socket must exist");
  const pending = exchange(client, route.port, new Uint8Array(0), 3000);
  // Deliver a datagram as if it came from the permitted peer.
  mock.deliver(relaySocket.socketId, Uint8Array.of(1, 2, 3, 4), "1.1.1.1", 5000);
  const reply = await pending;
  assert.ok(reply, "expected a data indication");
  const message = codec.decodeMessage(reply);
  assert.equal(message.class, codec.CLASS.INDICATION);
  assert.equal(message.method, codec.METHOD.DATA);
  const data = codec.getAttribute(message, codec.ATTR.DATA);
  assert.deepEqual(Array.from(data.value), [1, 2, 3, 4]);
  const peer = codec.getAttribute(message, codec.ATTR.XOR_PEER_ADDRESS);
  assert.deepEqual(codec.decodeAddress(peer.value, message.transactionId), {
    address: "1.1.1.1",
    port: 5000,
  });
});

test("stopping the bridge closes every owned socket", async () => {
  await turnServer.stop();
  const remaining = await mock.api.sockets.udp.getSockets();
  assert.equal(remaining.length, 0);
  const status = await turnServer.status();
  assert.equal(status.running, false);
  assert.equal(status.controlSocketBound, false);
  client.close();
});
