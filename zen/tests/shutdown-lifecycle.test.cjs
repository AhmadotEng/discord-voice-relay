"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const sourcePath = path.resolve(__dirname,
  "../api/implementation-gecko147.js");
const source = fs.readFileSync(sourcePath, "utf8");
const preference = "media.peerconnection.ice.loopback";
const snapshotPreference = "extensions.discord-direct.loopback-pref-snapshot";

// Exercise the real ExperimentAPI shutdown code; only Gecko services and the
// asynchronous UDP close notification are simulated. No browser or network I/O.
function loadBackend(initialUserValue, { persistedValues, failSaving = false } = {}) {
  const diskValues = persistedValues || new Map();
  if (!persistedValues && initialUserValue !== undefined) {
    diskValues.set(preference, initialUserValue);
  }
  const userValues = new Map(diskValues);
  let failSave = failSaving;
  const saveCurrentPrefs = () => {
    if (failSave) throw new Error("Simulated preference save failure");
    diskValues.clear();
    for (const [key, value] of userValues) diskValues.set(key, value);
  };
  const timers = new Map();
  let timerId = 0;
  const context = vm.createContext({
    ExtensionAPI: class {},
    ChromeUtils: {
      importESModule(url) {
        assert.equal(url, "resource://gre/modules/Timer.sys.mjs");
        return {
          setTimeout(callback) { timers.set(++timerId, callback); return timerId; },
          clearTimeout(id) { timers.delete(id); },
        };
      },
    },
    Services: {
      prefs: {
        prefHasUserValue(key) { return userValues.has(key); },
        getBoolPref(key, fallback) { return userValues.has(key) ? userValues.get(key) : fallback; },
        setBoolPref(key, value) { userValues.set(key, value); },
        getStringPref(key, fallback) { return userValues.has(key) ? userValues.get(key) : fallback; },
        setStringPref(key, value) { userValues.set(key, value); },
        clearUserPref(key) { userValues.delete(key); },
        savePrefFile(file) { assert.equal(file, null); saveCurrentPrefs(); },
      },
    },
  });
  vm.runInContext(source, context, { filename: sourcePath });
  const addon = new context.loopbackTurnCompat147();
  return {
    addon,
    context,
    diskValues,
    userValues,
    saveCurrentPrefs,
    setFailSaving(value) { failSave = value; },
    activate() {
      vm.runInContext("captureAndEnableLoopbackPreference()", context);
      assert.equal(userValues.get(preference), true, "activation arms WebRTC loopback");
    },
    assertRestored({ journalRetained = false, durable = false } = {}) {
      assert.equal(userValues.has(preference), initialUserValue !== undefined,
        "shutdown must preserve whether a user override existed");
      assert.equal(userValues.get(preference), initialUserValue,
        "shutdown must restore the original user preference value");
      assert.equal(userValues.has(snapshotPreference), journalRetained,
        "only application shutdown retains the baseline journal");
      if (durable) {
        assert.equal(diskValues.has(preference), initialUserValue !== undefined);
        assert.equal(diskValues.get(preference), initialUserValue);
        assert.equal(diskValues.has(snapshotPreference), journalRetained);
      }
    },
    acknowledgeSocketClose() {
      vm.runInContext("noteSocketStopped(testSocket)", context);
      for (const [id, callback] of [...timers]) {
        timers.delete(id);
        callback();
      }
    },
  };
}

for (const original of [undefined, false, true]) {
  const label = original === undefined ? "no user override" : `user value ${original}`;
  test(`normal shutdown restores ${label}`, async () => {
    const backend = loadBackend(original);
    backend.activate();
    backend.addon.onShutdown();
    backend.assertRestored();
    await vm.runInContext("stopPromise", backend.context);
  });

  test(`shutdown during asynchronous transport stop restores ${label}`, async () => {
    const backend = loadBackend(original);
    backend.activate();
    let closes = 0;
    backend.context.testSocket = { port: 49152, close() { closes += 1; } };
    vm.runInContext("trackSocket(testSocket, 'control'); controlSocket = testSocket;",
      backend.context);
    const transportStop = vm.runInContext("stopServer({ restorePreference: false })",
      backend.context);
    assert.ok(closes > 0, "transport stop has requested the native socket close");
    try {
      backend.addon.onShutdown();
      backend.assertRestored();
      assert.equal(vm.runInContext("stopPromise", backend.context), transportStop,
        "shutdown reuses the pending socket cleanup instead of starting another one");
    } finally {
      backend.acknowledgeSocketClose();
      assert.equal(await transportStop, true);
    }
  });

  test(`restart after early preference serialization preserves ${label}`, async () => {
    const backend = loadBackend(original);
    backend.activate();
    backend.saveCurrentPrefs(); // Gecko may save preferences before API shutdown.
    backend.addon.onShutdown(true);
    backend.assertRestored({ journalRetained: true });
    await vm.runInContext("stopPromise", backend.context);

    const restarted = loadBackend(original, { persistedValues: backend.diskValues });
    restarted.activate();
    restarted.addon.onShutdown(false);
    restarted.assertRestored({ durable: true });
    await vm.runInContext("stopPromise", restarted.context);
  });

  test(`restart without an API shutdown callback preserves ${label}`, async () => {
    const backend = loadBackend(original);
    backend.activate();
    backend.saveCurrentPrefs(); // Simulate a saved active state followed by a crash.
    const restarted = loadBackend(original, { persistedValues: backend.diskValues });
    restarted.activate();
    restarted.addon.onShutdown(false);
    restarted.assertRestored({ durable: true });
    await vm.runInContext("stopPromise", restarted.context);
  });

  test(`disable before starting a restarted transport restores ${label}`, async () => {
    const backend = loadBackend(original);
    backend.activate();
    backend.saveCurrentPrefs();

    const restarted = loadBackend(original, { persistedValues: backend.diskValues });
    restarted.addon.getAPI();
    assert.equal(vm.runInContext("preferenceSnapshot", restarted.context), null);
    restarted.addon.onShutdown(false);
    restarted.assertRestored({ durable: true });
    await vm.runInContext("stopPromise", restarted.context);
  });

  test(`public stop before starting a restarted transport restores ${label}`, async () => {
    const backend = loadBackend(original);
    backend.activate();
    backend.saveCurrentPrefs();

    const restarted = loadBackend(original, { persistedValues: backend.diskValues });
    const api = restarted.addon.getAPI().experiments.loopbackTurn;
    await api.stop();
    restarted.assertRestored({ durable: true });
  });

  test(`application shutdown before starting a restarted transport retains ${label}`, async () => {
    const backend = loadBackend(original);
    backend.activate();
    backend.saveCurrentPrefs();

    const restarted = loadBackend(original, { persistedValues: backend.diskValues });
    restarted.addon.getAPI();
    restarted.addon.onShutdown(true);
    restarted.assertRestored({ journalRetained: true });
    await vm.runInContext("stopPromise", restarted.context);

    const nextSession = loadBackend(original, { persistedValues: restarted.diskValues });
    await nextSession.addon.getAPI().experiments.loopbackTurn.stop();
    nextSession.assertRestored({ durable: true });
  });
}

test("obtaining the API does not enable loopback before transport startup", () => {
  const backend = loadBackend(undefined);
  backend.addon.getAPI();
  assert.equal(backend.userValues.has(preference), false);
  assert.equal(backend.userValues.has(snapshotPreference), false);
});

test("activation requests saving the original state before arming loopback", () => {
  const backend = loadBackend(undefined);
  backend.activate();
  assert.deepEqual(JSON.parse(backend.diskValues.get(snapshotPreference)), {
    version: 1, hadUserValue: false, value: false,
  });
  assert.equal(backend.diskValues.has(preference), false,
    "the first forced true value must not precede the saved baseline");
});

for (const invalid of ["not JSON", "null", '{"version":1,"hadUserValue":false}',
  '{"version":2,"hadUserValue":false,"value":false}']) {
  test(`invalid baseline is preserved and never arms loopback: ${invalid}`, () => {
    const diskValues = new Map([[snapshotPreference, invalid]]);
    const backend = loadBackend(undefined, { persistedValues: diskValues });
    assert.throws(() => backend.activate());
    assert.equal(backend.userValues.has(preference), false);
    assert.equal(backend.userValues.get(snapshotPreference), invalid);
    assert.equal(diskValues.get(snapshotPreference), invalid);
    assert.throws(() => backend.addon.onShutdown(false));
    assert.equal(backend.userValues.has(preference), false);
    assert.equal(backend.userValues.get(snapshotPreference), invalid);
    assert.equal(diskValues.get(snapshotPreference), invalid);
  });
}

test("failed baseline persistence does not arm loopback, including a retry", () => {
  const backend = loadBackend(undefined, { failSaving: true });
  assert.throws(() => backend.activate(), /preference save failure/);
  assert.equal(backend.userValues.has(preference), false);
  assert.throws(() => backend.activate(), /preference save failure/);
  assert.equal(backend.userValues.has(preference), false);
  backend.setFailSaving(false);
  backend.activate();
  assert.equal(backend.diskValues.has(snapshotPreference), true);
});
