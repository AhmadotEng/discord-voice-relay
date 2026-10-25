"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const workerSource = fs.readFileSync(path.join(__dirname, "../src/service-worker.js"), "utf8");

test("service worker combines nonsecret local settings with a session-only credential", () => {
  let listener;
  const chrome = {
    runtime: {
      lastError: null,
      onMessage: { addListener(value) { listener = value; } }
    },
    storage: {
      local: {
        get(defaults, callback) {
          callback({
            ...defaults,
            enabled: true,
            turnUrls: "turns:relay.example:443?transport=tcp",
            turnUsername: "alice",
            disclosureAccepted: true,
            turnCredential: "must-not-come-from-local"
          });
        }
      },
      session: {
        get(defaults, callback) {
          callback({ ...defaults, turnCredential: "session-secret" });
        }
      }
    }
  };
  vm.runInNewContext(workerSource, { chrome }, { filename: "service-worker.js" });

  let response;
  const asyncResponse = listener(
    { type: "get-relay-settings" },
    {},
    (value) => { response = value; }
  );
  assert.equal(asyncResponse, true);
  assert.equal(response.enabled, true);
  assert.equal(response.turnUsername, "alice");
  assert.equal(response.turnCredential, "session-secret");
  assert.equal("disclosureAccepted" in response, false);
});

test("service worker will not enable relay before disclosure is acknowledged", () => {
  let listener;
  const chrome = {
    runtime: {
      lastError: null,
      onMessage: { addListener(value) { listener = value; } }
    },
    storage: {
      local: {
        get(defaults, callback) {
          callback({
            ...defaults,
            enabled: true,
            turnUrls: "turns:relay.example:443?transport=tcp",
            turnUsername: "alice",
            disclosureAccepted: false
          });
        }
      },
      session: {
        get(defaults, callback) {
          callback({ ...defaults, turnCredential: "session-secret" });
        }
      }
    }
  };
  vm.runInNewContext(workerSource, { chrome }, { filename: "service-worker.js" });

  let response;
  listener({ type: "get-relay-settings" }, {}, (value) => { response = value; });
  assert.equal(response.enabled, false);
});
