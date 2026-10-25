"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const extensionRoot = path.join(__dirname, "..");
const manifest = JSON.parse(fs.readFileSync(path.join(extensionRoot, "manifest.json"), "utf8"));

test("Chrome manifest uses Native Messaging and asks for only Discord access", () => {
  assert.equal(manifest.manifest_version, 3);
  assert.equal(manifest.minimum_chrome_version, "111");
  assert.equal(manifest.name, "Discord Direct for Chrome");
  assert.equal(manifest.background.service_worker, "src/service-worker.js");
  assert.deepEqual(manifest.permissions, ["storage", "nativeMessaging"]);
  assert.deepEqual(manifest.host_permissions, ["https://discord.com/*"]);
  assert.equal("key" in manifest, false);
  assert.equal("sockets" in manifest, false);
  assert.equal("default_popup" in manifest.action, false);
  assert.equal("proxy" in manifest.permissions, false);
  assert.deepEqual(
    manifest.content_scripts.map((script) => script.matches),
    [["https://discord.com/channels/*"], ["https://discord.com/channels/*"]]
  );
  assert.deepEqual(
    manifest.content_scripts.map((script) => script.world),
    ["MAIN", "ISOLATED"]
  );
  assert.deepEqual(
    manifest.content_scripts.map((script) => script.js),
    [["src/relay-config.js", "src/page-hook.js"], ["src/bridge.js"]]
  );
});

test("every manifest icon is a present PNG", () => {
  const iconPaths = new Set([
    ...Object.values(manifest.icons),
    ...Object.values(manifest.action.default_icon),
  ]);
  for (const iconPath of iconPaths) {
    assert.match(iconPath, /\.png$/u);
    assert.equal(fs.existsSync(path.join(extensionRoot, iconPath)), true, iconPath);
  }
});

test("the Native Messaging host source and Windows setup are included", () => {
  for (const relative of [
    "src/native-client.js",
    "native-host/host.cjs",
    "native-host/node-sockets.cjs",
    "native-host/Install-NativeHost.ps1",
    "native-host/Uninstall-NativeHost.ps1",
    "native-host/launcher/Program.cs",
    "native-host/launcher/DiscordDirectNativeHost.csproj",
  ]) {
    assert.equal(fs.existsSync(path.join(extensionRoot, relative)), true, relative);
  }
});
