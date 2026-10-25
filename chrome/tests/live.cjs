"use strict";

// Cross-version launcher for the live tests. Node 20 needs the
// --experimental-websocket flag for the global WebSocket, Node 22+ has it
// enabled by default.

const { spawnSync } = require("node:child_process");
const path = require("node:path");

const target = path.join(__dirname, process.argv[2] || "live-smoke.cjs");

if (typeof globalThis.WebSocket === "function") {
  process.argv[1] = target;
  require(target);
} else {
  const result = spawnSync(
    process.execPath,
    ["--experimental-websocket", target, ...process.argv.slice(3)],
    { stdio: "inherit" },
  );
  process.exit(result.status === null ? 1 : result.status);
}
