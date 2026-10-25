"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const extensionRoot = path.join(__dirname, "..");
const manifest = JSON.parse(fs.readFileSync(path.join(extensionRoot, "manifest.json"), "utf8"));

test("Chrome manifest is MV3, narrowly scoped, and free of Gecko-only keys", () => {
  assert.equal(manifest.manifest_version, 3);
  assert.equal(manifest.minimum_chrome_version, "111");
  assert.equal(manifest.background.service_worker, "src/service-worker.js");
  assert.equal(manifest.short_name.length <= 12, true);
  assert.equal("browser_specific_settings" in manifest, false);
  assert.equal("host_permissions" in manifest, false);
  assert.deepEqual(manifest.permissions, ["storage"]);
  assert.deepEqual(
    manifest.content_scripts.map((script) => script.matches),
    [["https://discord.com/channels/*"], ["https://discord.com/channels/*"]]
  );
  assert.deepEqual(
    manifest.content_scripts.map((script) => script.world),
    ["MAIN", "ISOLATED"]
  );
});

test("every manifest icon is a present PNG", () => {
  const iconPaths = new Set([
    ...Object.values(manifest.icons),
    ...Object.values(manifest.action.default_icon)
  ]);
  for (const iconPath of iconPaths) {
    assert.match(iconPath, /\.png$/u);
    assert.equal(fs.existsSync(path.join(extensionRoot, iconPath)), true, iconPath);
  }
});
