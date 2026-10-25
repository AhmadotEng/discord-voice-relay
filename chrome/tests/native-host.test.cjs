"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const dgram = require("node:dgram");
const crypto = require("node:crypto");
const { spawn } = require("node:child_process");
const codec = require("../lib/turn-codec.js");

const extensionRoot = path.resolve(__dirname, "..");
const validOrigin = `chrome-extension://${"a".repeat(32)}/`;

function removeTempHost(root) {
  const resolved = path.resolve(root);
  const tempRoot = path.resolve(os.tmpdir());
  if (path.dirname(resolved).toLowerCase() !== tempRoot.toLowerCase() ||
      !path.basename(resolved).startsWith("discord-direct-host-")) {
    throw new Error(`Refusing to remove an unexpected temporary path: ${resolved}`);
  }
  fs.rmSync(resolved, { recursive: true, force: true });
}

function createTempHost(installedLayout = false) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "discord-direct-host-"));
  const files = [
    ["native-host/host.cjs", installedLayout ? "host.cjs" : "native-host/host.cjs"],
    ["native-host/node-sockets.cjs", installedLayout ? "node-sockets.cjs" : "native-host/node-sockets.cjs"],
    ["src/turn-server.js", "src/turn-server.js"],
    ["lib/turn-codec.js", "lib/turn-codec.js"],
    ["lib/mapping-policy.js", "lib/mapping-policy.js"],
  ];
  for (const [source, destination] of files) {
    const target = path.join(root, destination);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(path.join(extensionRoot, source), target);
  }
  const hostRoot = installedLayout ? root : path.join(root, "native-host");
  fs.writeFileSync(path.join(hostRoot, "host-settings.json"), JSON.stringify({
    allowedOrigin: validOrigin,
    nodeExecutable: process.execPath,
  }));
  return { root, hostRoot };
}

function frame(value) {
  const body = Buffer.from(JSON.stringify(value), "utf8");
  const header = Buffer.alloc(4);
  header.writeUInt32LE(body.length);
  return Buffer.concat([header, body]);
}

function startHost(hostRoot, origin = validOrigin) {
  const host = spawn(process.execPath, [path.join(hostRoot, "host.cjs"), origin], {
    stdio: ["pipe", "pipe", "pipe"],
  });
  let buffer = Buffer.alloc(0);
  const received = [];
  const waiters = [];
  const stderr = [];
  host.stdout.on("data", (chunk) => {
    buffer = buffer.length ? Buffer.concat([buffer, chunk]) : chunk;
    while (buffer.length >= 4) {
      const length = buffer.readUInt32LE(0);
      if (buffer.length < length + 4) break;
      const message = JSON.parse(buffer.subarray(4, length + 4).toString("utf8"));
      buffer = buffer.subarray(length + 4);
      const waiterIndex = waiters.findIndex((waiter) => waiter.id === message.id);
      if (waiterIndex >= 0) waiters.splice(waiterIndex, 1)[0].resolve(message);
      else received.push(message);
    }
  });
  host.stderr.on("data", (chunk) => stderr.push(chunk.toString("utf8")));
  return {
    host,
    stderr,
    send(message) {
      const promise = new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error(`host response timeout: ${message.id}`)), 5000);
        const waiter = {
          id: message.id,
          resolve(value) { clearTimeout(timeout); resolve(value); },
        };
        const earlier = received.findIndex((value) => value.id === message.id);
        if (earlier >= 0) waiter.resolve(received.splice(earlier, 1)[0]);
        else waiters.push(waiter);
      });
      host.stdin.write(frame(message));
      return promise;
    },
  };
}

test("Native Messaging host starts a loopback TURN listener and stops on command", async (t) => {
  const { root, hostRoot } = createTempHost();
  t.after(() => removeTempHost(root));
  const helper = startHost(hostRoot);
  t.after(() => { if (!helper.host.killed) helper.host.kill(); });

  const started = await helper.send({
    id: 1,
    command: "start",
    mappingProbeServers: ["stun:a.example:3478", "stun:b.example:3478"],
  });
  assert.equal(started.ok, true);
  assert.equal(started.result.running, true);
  assert.equal(started.result.controlSocketBound, true);
  assert.equal(started.result.mode, "remote-mapped");
  assert.ok(started.result.port >= 1 && started.result.port <= 65535);

  const stopped = await helper.send({ id: 2, command: "stop" });
  assert.equal(stopped.ok, true);
  assert.equal(stopped.result.running, false);
  helper.host.stdin.end();
  await new Promise((resolve, reject) => {
    helper.host.once("exit", resolve);
    helper.host.once("error", reject);
  });
});

test("Native Messaging host starts from the installed flat directory layout", async (t) => {
  const { root, hostRoot } = createTempHost(true);
  t.after(() => removeTempHost(root));
  const helper = startHost(hostRoot);
  t.after(() => { if (!helper.host.killed) helper.host.kill(); });

  const started = await helper.send({
    id: 1,
    command: "start",
    mappingProbeServers: ["stun:a.example:3478", "stun:b.example:3478"],
  });
  assert.equal(started.ok, true, helper.stderr.join(""));
  assert.equal(started.result.running, true);
  assert.equal(started.result.controlSocketBound, true);

  const stopped = await helper.send({ id: 2, command: "stop" });
  assert.equal(stopped.ok, true);
  helper.host.stdin.end();
  const exitCode = await new Promise((resolve, reject) => {
    helper.host.once("exit", resolve);
    helper.host.once("error", reject);
  });
  assert.equal(exitCode, 0);
});

test("Native Messaging host dispatches UDP packets into the TURN server", async (t) => {
  const { root, hostRoot } = createTempHost(true);
  t.after(() => removeTempHost(root));
  const helper = startHost(hostRoot);
  t.after(() => { if (!helper.host.killed) helper.host.kill(); });

  const started = await helper.send({
    id: 1,
    command: "start",
    mappingProbeServers: ["stun:a.example:3478", "stun:b.example:3478"],
  });
  assert.equal(started.ok, true, helper.stderr.join(""));

  const transactionId = crypto.randomBytes(12);
  const request = Buffer.from(codec.encodeMessage({
    method: codec.METHOD.BINDING,
    class: codec.CLASS.REQUEST,
    transactionId,
  }));
  const responseBytes = await new Promise((resolve, reject) => {
    const client = dgram.createSocket("udp4");
    const timer = setTimeout(() => {
      client.close();
      reject(new Error("TURN listener did not answer a Binding request"));
    }, 1500);
    client.once("error", (error) => {
      clearTimeout(timer);
      client.close();
      reject(error);
    });
    client.once("message", (message) => {
      clearTimeout(timer);
      client.close();
      resolve(Buffer.from(message));
    });
    client.send(request, started.result.port, "127.0.0.1", (error) => {
      if (error) {
        clearTimeout(timer);
        client.close();
        reject(error);
      }
    });
  });
  const response = codec.decodeMessage(responseBytes);
  assert.equal(response.method, codec.METHOD.BINDING);
  assert.equal(response.class, codec.CLASS.SUCCESS);
  assert.ok(Buffer.from(response.transactionId).equals(transactionId));

  const status = await helper.send({ id: 2, command: "status" });
  assert.equal(status.ok, true);
  assert.equal(status.result.stats.requests, 1);

  const stopped = await helper.send({ id: 3, command: "stop" });
  assert.equal(stopped.ok, true);
  helper.host.stdin.end();
  const exitCode = await new Promise((resolve, reject) => {
    helper.host.once("exit", resolve);
    helper.host.once("error", reject);
  });
  assert.equal(exitCode, 0);
});

test("Native Messaging pipe closure stops an active helper", async (t) => {
  const { root, hostRoot } = createTempHost();
  t.after(() => removeTempHost(root));
  const helper = startHost(hostRoot);
  t.after(() => { if (!helper.host.killed) helper.host.kill(); });

  const started = await helper.send({
    id: 1,
    command: "start",
    mappingProbeServers: ["stun:a.example:3478", "stun:b.example:3478"],
  });
  assert.equal(started.ok, true);
  assert.equal(started.result.running, true);

  const exit = new Promise((resolve, reject) => {
    helper.host.once("exit", resolve);
    helper.host.once("error", reject);
  });
  helper.host.stdin.end();
  const exitCode = await exit;
  assert.equal(exitCode, 0);
});

test("Native Messaging host rejects invalid mapping probes and unknown commands", async (t) => {
  const { root, hostRoot } = createTempHost();
  t.after(() => removeTempHost(root));
  const helper = startHost(hostRoot);
  t.after(() => { if (!helper.host.killed) helper.host.kill(); });

  const badStun = await helper.send({
    id: 1,
    command: "start",
    mappingProbeServers: ["stun:a.example:3478"],
  });
  assert.equal(badStun.ok, false);
  assert.match(badStun.error, /two-to-eight-STUN/iu);

  const badCommand = await helper.send({ id: 2, command: "run-arbitrary-command" });
  assert.equal(badCommand.ok, false);
  assert.equal(badCommand.error, "unknown-command");
  helper.host.stdin.end();
  await new Promise((resolve) => helper.host.once("exit", resolve));
});

test("Native Messaging host refuses a caller whose origin is not allowlisted", async (t) => {
  const { root, hostRoot } = createTempHost();
  t.after(() => removeTempHost(root));
  const helper = startHost(hostRoot, `chrome-extension://${"b".repeat(32)}/`);
  const exitCode = await new Promise((resolve, reject) => {
    helper.host.once("exit", resolve);
    helper.host.once("error", reject);
  });
  assert.equal(exitCode, 1);
  assert.match(helper.stderr.join(""), /caller origin does not match/iu);
});
