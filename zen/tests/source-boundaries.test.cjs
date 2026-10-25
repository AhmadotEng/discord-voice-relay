"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.resolve(__dirname, "..");
const manifest = JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf8"));
const background = fs.readFileSync(path.join(root, "background.js"), "utf8");
const pageHook = fs.readFileSync(path.join(root, "src/page-hook.js"), "utf8");
const bridge = fs.readFileSync(path.join(root, "src/bridge.js"), "utf8");
const popupStatus = fs.readFileSync(path.join(root, "src/popup-status.js"), "utf8");

test("manifest is privileged MV2, replaces the old add-on identity, and injects MAIN at document_start", () => {
  assert.equal(manifest.manifest_version, 2);
  assert.equal(manifest.browser_specific_settings.gecko.id, "discord-voice-relay@local.invalid");
  assert.deepEqual(manifest.permissions.sort(), ["https://discord.com/*", "storage"]);
  assert.equal(manifest.permissions.includes("<all_urls>"), false);
  for (const forbidden of ["proxy", "webRequest", "nativeMessaging", "downloads", "cookies", "history"]) {
    assert.equal(manifest.permissions.includes(forbidden), false, forbidden);
  }
  const main = manifest.content_scripts.find((entry) => entry.world === "MAIN");
  const bridgeEntry = manifest.content_scripts.find((entry) =>
    entry.js && entry.js.includes("src/bridge.js")
  );
  assert.ok(main);
  assert.ok(bridgeEntry);
  assert.deepEqual(main.matches, ["https://discord.com/*"]);
  assert.equal(main.run_at, "document_start");
  assert.notEqual(main.all_frames, true);
  assert.equal(bridgeEntry.world, "ISOLATED");
  assert.equal(bridgeEntry.run_at, "document_start");
  assert.equal(manifest.background.persistent, true);
});

test("replacement keeps the old identity but has a strictly newer version", () => {
  const legacy = {
    version: "0.1.0",
    browser_specific_settings: { gecko: { id: "discord-voice-relay@local.invalid" } },
  };
  const compare = (left, right) => {
    const a = left.split(".").map(Number);
    const b = right.split(".").map(Number);
    for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
      const difference = (a[index] || 0) - (b[index] || 0);
      if (difference !== 0) return difference;
    }
    return 0;
  };
  assert.equal(
    manifest.browser_specific_settings.gecko.id,
    legacy.browser_specific_settings.gecko.id
  );
  assert.ok(compare(manifest.version, legacy.version) > 0);
  assert.equal(manifest.version, "0.2.4.2");
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).version, manifest.version);
});

test("manifest requires the Firefox ICE relay validation fix", () => {
  assert.equal(manifest.browser_specific_settings.gecko.strict_min_version, "152.0");
});

test("integrated transport retains its reviewed libraries and lifecycle-fixed backend", () => {
  // Git may check text out with CRLF on Windows; fingerprint canonical LF text.
  const sha256 = (value) => crypto.createHash("sha256")
    .update(String(value).replace(/\r\n/gu, "\n")).digest("hex");
  const reviewedHashes = new Map([
    ["api/schema.json", "2249edf7ccba0f76d22bae3b70868997a8d552c210b8d09410440c5b47bfc2b6"],
    ["lib/turn-codec.js", "c61fabc2595b0e9c8018a1b8f1af6a797e003e97cac373a8acccbc3966c6f771"],
    ["lib/mapping-policy.js", "45eb71a199b3ad63c2bbbbf31c7b32eb811dffdd383b8abdc1ff087ce8eaccbd"],
  ]);
  for (const [relative, expectedHash] of reviewedHashes) {
    assert.equal(sha256(fs.readFileSync(path.join(root, relative))), expectedHash, relative);
  }

  const hardenedLoader = (library) => `Services.scriptloader.loadSubScriptWithOptions(
      extension.rootURI.resolve("lib/${library}.js"),
      {
        target: scope,
        allowUnsafeURL: true,
      }
    );`;
  const legacyLoader = (library) => `Services.scriptloader.loadSubScript(
      extension.rootURI.resolve("lib/${library}.js"),
      scope,
      "UTF-8"
    );`;
  let integrated = fs.readFileSync(
    path.join(root, "api/implementation-gecko147.js"),
    "utf8"
  ).replace(/\r\n/gu, "\n");
  for (const library of ["turn-codec", "mapping-policy"]) {
    assert.equal(integrated.includes(hardenedLoader(library)), true, library);
    integrated = integrated.replace(hardenedLoader(library), legacyLoader(library));
  }
  assert.equal(
    sha256(integrated),
    "aa98c356eecb490938c5f9a7cf44393dbaeb9507390cac13166212309d8faa53"
  );
});

test("Firefox 155 packaged scripts require an explicit, narrowly scoped loader opt-in", () => {
  const implementation = fs.readFileSync(
    path.join(root, "api/implementation-gecko147.js"),
    "utf8"
  );
  assert.equal(
    (implementation.match(/Services\.scriptloader\.loadSubScriptWithOptions\(/gu) || []).length,
    2
  );
  assert.equal((implementation.match(/allowUnsafeURL: true/gu) || []).length, 2);
  assert.equal((implementation.match(/target: scope/gu) || []).length, 2);
  assert.equal((implementation.match(/extension\.rootURI\.resolve\("lib\//gu) || []).length, 2);
  assert.doesNotMatch(implementation, /Services\.scriptloader\.loadSubScript\(/u);
});

test("Experiment API null defaults cannot disable remote mode or become credentials", () => {
  const implementation = fs.readFileSync(
    path.join(root, "api/implementation-gecko147.js"),
    "utf8"
  );
  assert.match(implementation, /options\.username == null/u);
  assert.match(implementation, /options\.credential == null/u);
  assert.match(implementation, /const hasAdvertisedRelayAddress = options\.advertisedRelayAddress != null;/u);
  assert.match(implementation, /mode === "remote-mapped" && hasAdvertisedRelayAddress/u);
  assert.doesNotMatch(implementation, /options\.advertisedRelayAddress !== undefined/u);
});

test("background removes legacy provider secrets and never stores generated route credentials", () => {
  assert.match(background, /const LEGACY_KEYS = \["enabled", "turnUrls", "turnUsername", "turnCredential", "tcpOnly"\]/u);
  assert.match(background, /storage\.local\.remove\(LEGACY_KEYS\)/u);
  assert.match(background, /privateEndpoint = \{/u);
  assert.doesNotMatch(background, /storage\.local\.set\([^;]*(?:turnUrl|username|credential)/su);
  assert.match(background, /isDiscordTopLevelSender\(sender\)/u);
  assert.match(background, /sender\.frameId !== 0/u);
  assert.match(background, /senderOrigin\.origin !== "https:\/\/discord\.com"/u);
  assert.match(background, /tabs\.query\(\{ url: "https:\/\/discord\.com\/\*" \}\)/u);
  assert.match(background, /tabs\.sendMessage\(tab\.id, notification, \{ frameId: 0 \}\)/u);
  assert.doesNotMatch(background, /tabs\.slice\(/u);
  assert.doesNotMatch(background, /runtime\.sendMessage\(\{\s*type: "discord-direct:route-changed"/su);
  assert.match(background, /let settingsMutationQueue = Promise\.resolve\(\)/u);
  assert.match(background, /const precedingMutations = settingsMutationQueue/u);
});

test("page boundary receives no privileged callable and status never serializes route secrets", () => {
  assert.doesNotMatch(pageHook, /browser\./u);
  assert.doesNotMatch(bridge, /experiments\.loopbackTurn/u);
  assert.match(pageHook, /selectedCandidate: candidate/u);
  assert.doesNotMatch(pageHook, /candidate:\s*(?:event\.candidate|local\.candidate)/u);
  assert.doesNotMatch(pageHook, /console\./u);
  assert.doesNotMatch(background, /console\./u);
});

test("the popup trusts an active Discord tab before scanning recent tabs", () => {
  const source = fs.readFileSync(path.join(root, "popup/popup.js"), "utf8");
  assert.match(source, /url:\s*"https:\/\/discord\.com\/\*"/u);
  assert.match(source, /return await browser\.tabs\.sendMessage\(activeDiscord\.id/u);
  assert.match(source, /lastAccessed/u);
  assert.match(source, /tabs\.sendMessage\(tab\.id/u);
  assert.match(source, /phase: "bridge-unavailable"/u);
});

test("route is fail-closed, bounded, and old-hook aware", () => {
  assert.match(pageHook, /const GATE_TIMEOUT_MS = 5000/u);
  assert.match(pageHook, /const MAX_TRACKED_CONNECTIONS = 32/u);
  const config = fs.readFileSync(path.join(root, "src/config.js"), "utf8");
  assert.match(config, /iceTransportPolicy: "relay"/u);
  assert.match(pageHook, /globalThis\.__discordVoiceRelayInstalled/u);
  assert.match(pageHook, /hookStillProtectsNewConnections\(\)/u);
  assert.match(pageHook, /if \(property === hookBrand\) return hookToken/u);
  assert.match(pageHook, /throw extensionError\("reload-required"\)/u);
  assert.match(pageHook, /nativeSetConfiguration\.call\(connection\.peerConnection, enforced\)/u);
  assert.match(pageHook, /constructor-configuration-error/u);
});

test("verified popup state is bound to the exact live backend snapshot", () => {
  assert.match(background, /routeRevision = routeRevision === Number\.MAX_SAFE_INTEGER \? 1 : routeRevision \+ 1/u);
  assert.match(background, /routeRevision: routeState\.routeRevision/u);
  assert.match(pageHook, /routeState\.routeRevision !== expectedRouteRevision/u);
  assert.match(bridge, /routeRevision: boundedInteger\(input\.routeRevision, Number\.MAX_SAFE_INTEGER\)/u);
  assert.match(popupStatus, /const pageMatchesCurrentRevision = pageMatchesCurrentGeneration/u);
  assert.match(popupStatus, /const backendHasLiveEvidence = Boolean/u);
  assert.match(popupStatus, /pageMatchesCurrentRevision &&\s*backendHasLiveEvidence && page\.verified/u);
});

test("source has no dynamic code, remote script loading, telemetry, or native helper", () => {
  const files = fs.readdirSync(root, { recursive: true })
    .map(String)
    .filter((file) => /\.(?:js|json|html)$/u.test(file));
  const source = files.map((file) => fs.readFileSync(path.join(root, file), "utf8")).join("\n");
  assert.doesNotMatch(source, /\beval\s*\(/u);
  assert.doesNotMatch(source, /new\s+Function\s*\(/u);
  assert.doesNotMatch(source, /https?:\/\/[^\s"']+\.js/iu);
  assert.doesNotMatch(source, /analytics|telemetry|nativeMessaging/iu);
});
