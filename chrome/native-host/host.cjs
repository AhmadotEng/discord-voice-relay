"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { createNodeSocketApi } = require("./node-sockets.cjs");

const MAX_MESSAGE_BYTES = 1_048_576;
const CONFIG_PATH = path.join(__dirname, "host-settings.json");

function runtimeFile(directory, name) {
  const installedPath = path.join(__dirname, directory, name);
  if (fs.existsSync(installedPath)) return installedPath;
  return path.join(__dirname, "..", directory, name);
}

function log(message) {
  process.stderr.write(`[Discord Direct helper] ${String(message).slice(0, 400)}\n`);
}

function failStartup(message) {
  log(message);
  process.exitCode = 1;
}

let hostSettings;
try {
  hostSettings = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
} catch (_error) {
  failStartup("Local host configuration is missing or invalid.");
}

const suppliedOrigin = process.argv[2] || "";
if (!process.exitCode && (!hostSettings ||
    !/^chrome-extension:\/\/[a-p]{32}\/$/u.test(hostSettings.allowedOrigin || "") ||
    suppliedOrigin !== hostSettings.allowedOrigin)) {
  failStartup("Caller origin does not match the installed extension.");
}
if (process.exitCode) process.exit(process.exitCode);

const sockets = createNodeSocketApi();
globalThis.TurnCodec = require(runtimeFile("lib", "turn-codec.js"));
globalThis.MappingPolicy = require(runtimeFile("lib", "mapping-policy.js"));
globalThis.chrome = {
  runtime: { id: "discord-direct-native-helper", lastError: null },
  sockets,
};
const turnServer = require(runtimeFile("src", "turn-server.js"));
sockets.udp.onReceive.addListener((info) => turnServer.handleUdpReceive(info));
sockets.udp.onReceiveError.addListener((info) => turnServer.handleUdpReceiveError(info));

let input = Buffer.alloc(0);
let commandQueue = Promise.resolve();
let shuttingDown = false;

function writeMessage(message) {
  const body = Buffer.from(JSON.stringify(message), "utf8");
  if (body.length > MAX_MESSAGE_BYTES) throw new Error("native-response-too-large");
  const header = Buffer.allocUnsafe(4);
  header.writeUInt32LE(body.length, 0);
  process.stdout.write(header);
  process.stdout.write(body);
}

function enqueueCommand(message) {
  commandQueue = commandQueue.then(async () => {
    const id = Number.isSafeInteger(message && message.id) ? message.id : null;
    try {
      if (id === null) throw new Error("invalid-request-id");
      let result;
      if (message.command === "start") {
        const candidates = Array.isArray(message.mappingProbeServers)
          ? message.mappingProbeServers.map(String)
          : [];
        if (candidates.length < 2 || candidates.length > 8) {
          throw new Error("two-to-eight-STUN-endpoints-required");
        }
        const valid = candidates.map((candidate) => globalThis.MappingPolicy.parseStunUri(candidate));
        const destinations = new Set(valid.map((entry) => entry.host));
        if (destinations.size < 2) throw new Error("independent-STUN-endpoints-required");
        result = await turnServer.start({
          mode: "remote-mapped",
          mappingProbeServers: valid.map((entry) => entry.uri),
          mappingProbeTimeoutMs: 1800,
          mappingProbeRetries: 2,
          triggerLength: 0,
          preludePackets: [[0], [1]],
          delayMs: 50,
        });
        if (!result || result.__apiError) {
          throw new Error(String(result && result.__apiError || "turn-server-start-failed"));
        }
      } else if (message.command === "status") {
        result = await turnServer.status();
      } else if (message.command === "stop") {
        await turnServer.stop();
        await sockets.closeAll();
        result = await turnServer.status();
      } else {
        throw new Error("unknown-command");
      }
      writeMessage({ id, ok: true, result });
    } catch (error) {
      writeMessage({
        id,
        ok: false,
        error: String(error && error.message || "native-host-command-failed").slice(0, 256),
      });
    }
  }).catch((error) => {
    log(error && error.message || "command-queue-failed");
  });
}

function processInput() {
  while (input.length >= 4) {
    const length = input.readUInt32LE(0);
    if (length < 2 || length > MAX_MESSAGE_BYTES) {
      log("Invalid native message length; closing the helper.");
      process.stdin.destroy();
      return;
    }
    if (input.length < length + 4) return;
    const body = input.subarray(4, 4 + length);
    input = input.subarray(4 + length);
    try {
      const message = JSON.parse(body.toString("utf8"));
      enqueueCommand(message);
    } catch (_error) {
      log("Invalid native message JSON; closing the helper.");
      process.stdin.destroy();
      return;
    }
  }
}

async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  try { await turnServer.stop(); } catch (_error) { /* process is already leaving */ }
  try { await sockets.closeAll(); } catch (_error) { /* process is already leaving */ }
}

process.stdin.on("data", (chunk) => {
  input = input.length ? Buffer.concat([input, chunk]) : chunk;
  processInput();
});
process.stdin.on("end", () => {
  void commandQueue.then(shutdown).then(() => process.exit(0));
});
process.stdin.on("error", () => {
  void commandQueue.then(shutdown).then(() => process.exit(0));
});
process.on("uncaughtException", (error) => {
  log(error && error.message || "uncaught-error");
  void shutdown().then(() => process.exit(1));
});
process.on("unhandledRejection", (error) => {
  log(error && error.message || "unhandled-rejection");
});
