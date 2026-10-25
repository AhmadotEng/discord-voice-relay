"use strict";

// Live test for the MAIN-world page hook.
//
// A disposable Chrome profile loads a temporary copy of the extension and a
// temporary Native Messaging registration. The local test page creates a
// Discord-shaped voice connection plus a video transceiver representing
// screen share. Chromium must gather a relay candidate through the helper.
//
// Set HELIUM_BIN or CHROME_BIN to the browser executable.

const { spawn, spawnSync } = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const DEFAULT_BROWSER_CANDIDATES = [
  process.env.LOCALAPPDATA && path.join(
    process.env.LOCALAPPDATA, "imput", "Helium", "Application", "chrome.exe"
  ),
  process.env.ProgramFiles && path.join(
    process.env.ProgramFiles, "Google", "Chrome", "Application", "chrome.exe"
  ),
  process.env["ProgramFiles(x86)"] && path.join(
    process.env["ProgramFiles(x86)"], "Google", "Chrome", "Application", "chrome.exe"
  ),
].filter(Boolean);
const BROWSER = process.env.HELIUM_BIN || process.env.CHROME_BIN ||
  DEFAULT_BROWSER_CANDIDATES.find((candidate) => fs.existsSync(candidate)) ||
  DEFAULT_BROWSER_CANDIDATES[0];
const CDP_PORT = Number(process.env.CDP_PORT || 9361);
const HTTP_PORT = Number(process.env.HTTP_PORT || 9362);
const ORIGIN = `http://127.0.0.1:${HTTP_PORT}`;
const TEST_HOST_NAME = `com.ahmadoteng.discord_direct.test${process.pid}`;

function createTestExtensionIdentity() {
  const pair = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
  const key = pair.publicKey.export({ type: "spki", format: "der" });
  const digest = crypto.createHash("sha256").update(key).digest();
  const id = Array.from(digest.subarray(0, 16), (byte) =>
    String.fromCharCode(97 + (byte >> 4)) + String.fromCharCode(97 + (byte & 0x0f))
  ).join("");
  return { id, key: key.toString("base64") };
}

function runPowerShell(script, args) {
  const executable = process.env.POWERSHELL_EXE || "powershell.exe";
  const result = spawnSync(executable, [
    "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script, ...args,
  ], { encoding: "utf8" });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.error || result.status !== 0) {
    throw result.error || new Error(`PowerShell failed: ${script}`);
  }
}

function removeTempDirectory(directory) {
  const resolved = path.resolve(directory);
  const tempRoot = path.resolve(os.tmpdir());
  if (path.dirname(resolved).toLowerCase() !== tempRoot.toLowerCase() ||
      !path.basename(resolved).startsWith("discord-direct-live-")) {
    throw new Error(`Refusing to remove an unexpected temporary path: ${resolved}`);
  }
  fs.rmSync(resolved, { recursive: true, force: true });
}

const PAGE = `<!doctype html>
<html><head><meta charset="utf-8"><title>hook test</title></head>
<body>
<script>
window.__statuses = [];
window.__routes = [];
window.__results = null;
window.addEventListener("message", (event) => {
  const data = event.data;
  if (!data || data.channel !== "discord-voice-relay-chrome:v1") return;
  if (data.direction === "page-to-extension" && data.type === "status") {
    window.__statuses.push(data.status);
  }
  if (data.direction === "extension-to-page" && data.type === "route") {
    const route = data.route || {};
    const backend = route.backend || {};
    window.__routes.push({
      phase: route.phase,
      ready: route.ready === true,
      generation: route.generation,
      routeRevision: route.routeRevision,
      errorCode: route.errorCode || null,
      backend: {
        running: backend.running === true,
        controlSocketBound: backend.controlSocketBound === true,
        allocationCount: backend.allocationCount || 0,
        mappingReadyAllocations: backend.mappingReadyAllocations || 0,
        allocationsCreated: backend.allocationsCreated || 0,
        mappingProbeResponses: backend.mappingProbeResponses || 0,
        mappingProbeSuccesses: backend.mappingProbeSuccesses || 0,
        mappingProbeFailures: backend.mappingProbeFailures || 0,
        peerDatagramsQueued: backend.peerDatagramsQueued || 0,
        peerDatagramsReceived: backend.peerDatagramsReceived || 0,
      },
    });
  }
});
window.__run = async () => {
  const results = { steps: [] };
  const pc = new RTCPeerConnection({ bundlePolicy: "max-bundle", sdpSemantics: "unified-plan" });
  const initial = pc.getConfiguration();
  results.steps.push({ step: "constructed", iceTransportPolicy: initial.iceTransportPolicy,
    iceServers: (initial.iceServers || []).length });
  try {
    pc.addTransceiver("audio", { direction: "sendrecv" });
    // Discord screen sharing uses an outgoing WebRTC video track; this
    // transceiver models that media section without opening the camera.
    pc.addTransceiver("video", { direction: "sendonly" });
  } catch (error) { results.transceiverError = String(error); }
  const candidates = [];
  const candidateErrors = [];
  pc.addEventListener("icecandidate", (event) => {
    if (event.candidate) candidates.push(event.candidate.candidate);
  });
  pc.addEventListener("icecandidateerror", (event) => {
    candidateErrors.push({ url: event.url, errorCode: event.errorCode, errorText: event.errorText });
  });
  let offer = null;
  try {
    offer = await pc.createOffer();
    results.offerCreated = true;
    results.mediaSections = {
      audio: /(?:^|\\r?\\n)m=audio /u.test(offer.sdp || ""),
      screenShareVideo: /(?:^|\\r?\\n)m=video /u.test(offer.sdp || ""),
    };
  } catch (error) {
    results.offerCreated = false;
    results.offerError = String(error && error.message || error);
  }
  const after = pc.getConfiguration();
  results.configured = {
    iceTransportPolicy: after.iceTransportPolicy,
    iceServers: (after.iceServers || []).map((server) => ({
      urls: server.urls, username: server.username, hasCredential: Boolean(server.credential),
    })),
  };
  if (offer) {
    try { await pc.setLocalDescription(offer); } catch (error) { results.sdpError = String(error && error.message || error); }
    await new Promise((resolve) => setTimeout(resolve, 9000));
  }
  results.candidates = candidates;
  results.relayCandidates = candidates.filter((line) => / typ relay/u.test(line));
  results.iceGatheringState = pc.iceGatheringState;
  results.iceConnectionState = pc.iceConnectionState;
  results.connectionState = pc.connectionState;
  results.candidateErrors = candidateErrors;
  results.statuses = window.__statuses;
  results.routes = window.__routes;
  window.__results = results;
  return results;
};
</script>
</body></html>`;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function connect(wsUrl) {
  const ws = new WebSocket(wsUrl);
  let id = 0;
  const pending = new Map();
  ws.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    if (message.id && pending.has(message.id)) {
      const { resolve, reject } = pending.get(message.id);
      pending.delete(message.id);
      message.error ? reject(new Error(JSON.stringify(message.error))) : resolve(message.result);
    }
  });
  const ready = new Promise((resolve, reject) => {
    ws.addEventListener("open", resolve);
    ws.addEventListener("error", (error) => reject(new Error(`websocket: ${error.message}`)));
  });
  return {
    ready,
    send(method, params) {
      const messageId = ++id;
      return new Promise((resolve, reject) => {
        pending.set(messageId, { resolve, reject });
        ws.send(JSON.stringify({ id: messageId, method, params }));
        setTimeout(() => {
          if (pending.has(messageId)) {
            pending.delete(messageId);
            reject(new Error(`timeout: ${method}`));
          }
        }, 30000);
      });
    },
    close: () => ws.close(),
  };
}

(async () => {
  if (process.platform !== "win32") throw new Error("The Native Messaging live test currently targets Windows.");
  if (!BROWSER || !fs.existsSync(BROWSER)) {
    throw new Error(
      `Chrome/Chromium browser not found. Set HELIUM_BIN or CHROME_BIN. Checked: ${DEFAULT_BROWSER_CANDIDATES.join(", ")}`
    );
  }

  const identity = createTestExtensionIdentity();
  const ext = fs.mkdtempSync(path.join(os.tmpdir(), "discord-direct-live-extension-"));
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "discord-direct-live-profile-"));
  const hostInstallRoot = fs.mkdtempSync(path.join(os.tmpdir(), "discord-direct-live-host-"));
  const installScript = path.join(ext, "native-host", "Install-NativeHost.ps1");
  const uninstallScript = path.join(ext, "native-host", "Uninstall-NativeHost.ps1");
  let hostRegistered = false;
  let server = null;
  let browser = null;
  let cdp = null;
  let failures = 0;
  const check = (label, condition, detail) => {
    console.log(`${condition ? "ok  " : "FAIL"} ${label}${detail ? ` -> ${detail}` : ""}`);
    if (!condition) failures += 1;
  };

  try {
    fs.cpSync(ROOT, ext, { recursive: true });
    for (const [sourceName, destination] of [
      ["Install-NativeHost.ps1", installScript],
      ["Uninstall-NativeHost.ps1", uninstallScript],
    ]) {
      const sourcePath = path.join(ROOT, "native-host", sourceName);
      const source = fs.readFileSync(sourcePath, "utf8");
      const updated = source.replace(
        "$HostName = 'com.ahmadoteng.discord_direct'",
        `$HostName = '${TEST_HOST_NAME}'`
      );
      if (updated === source) throw new Error(`could not isolate the temporary host in ${sourceName}`);
      fs.writeFileSync(destination, updated);
    }

    const nativeClientPath = path.join(ext, "src", "native-client.js");
    const nativeClient = fs.readFileSync(nativeClientPath, "utf8");
    const testNativeClient = nativeClient.replace(
      'const HOST_NAME = "com.ahmadoteng.discord_direct";',
      `const HOST_NAME = "${TEST_HOST_NAME}";`
    );
    if (testNativeClient === nativeClient) throw new Error("could not isolate the temporary Native Messaging host name");
    fs.writeFileSync(nativeClientPath, testNativeClient);

    const manifest = JSON.parse(fs.readFileSync(path.join(ext, "manifest.json"), "utf8"));
    manifest.key = identity.key;
    manifest.host_permissions.push(`${ORIGIN}/*`);
    for (const entry of manifest.content_scripts) entry.matches = [`${ORIGIN}/*`];
    fs.writeFileSync(path.join(ext, "manifest.json"), JSON.stringify(manifest, null, 2));

    // Restrict the temporary test extension's page checks to the local fixture.
    const backgroundPath = path.join(ext, "src", "background.js");
    const background = fs.readFileSync(backgroundPath, "utf8")
      .replaceAll('"https://discord.com/*"', `"${ORIGIN}/*"`)
      .replaceAll('"https://discord.com"', `"${ORIGIN}"`);
    fs.writeFileSync(backgroundPath, background);

    runPowerShell(installScript, [
      "-ExtensionId", identity.id,
      "-InstallRoot", path.join(hostInstallRoot, "install"),
    ]);
    hostRegistered = true;

    server = http.createServer((_request, response) => {
      response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      response.end(PAGE);
    });
    await new Promise((resolve) => server.listen(HTTP_PORT, "127.0.0.1", resolve));

    browser = spawn(BROWSER, [
      `--user-data-dir=${profile}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-sync",
      "--disable-component-update",
      `--disable-extensions-except=${ext}`,
      `--load-extension=${ext}`,
      `--remote-debugging-port=${CDP_PORT}`,
      "about:blank",
    ], { stdio: ["ignore", "pipe", "pipe"] });

    let targets = [];
    for (let attempt = 0; attempt < 40; attempt += 1) {
      await sleep(500);
      try {
        targets = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json();
      } catch (error) {
        continue;
      }
      if (targets.some((target) => target.type === "service_worker")) break;
    }
    const page = targets.find((target) => target.type === "page");
    if (!page) throw new Error("no page target");
    cdp = connect(page.webSocketDebuggerUrl);
    await cdp.ready;
    await cdp.send("Page.enable");
    await cdp.send("Runtime.enable");
    const evaluate = async (expression) => {
      const result = await cdp.send("Runtime.evaluate", {
        expression, awaitPromise: true, returnByValue: true,
      });
      if (result.exceptionDetails) {
        throw new Error(result.exceptionDetails.exception?.description || "evaluation failed");
      }
      return result.result.value;
    };

    await cdp.send("Page.navigate", {
      url: `chrome-extension://${identity.id}/test-fixtures/toggle.html`,
    });
    await sleep(2500);
    const toggled = await evaluate("window.__toggleDiscordDirect() ");
    check("the toolbar toggle can arm routing without a popup",
      Boolean(toggled && toggled.ok && toggled.status && toggled.status.enabled));

    await cdp.send("Page.navigate", { url: `${ORIGIN}/hook-test.html` });
    await sleep(2500);
    const results = await evaluate("window.__run()");
    console.log(JSON.stringify(results, null, 2));

    check("the first offer was created", results.offerCreated === true, results.offerError || "");
    check("the peer connection is forced to relay-only ICE",
      results.configured && results.configured.iceTransportPolicy === "relay",
      results.configured ? results.configured.iceTransportPolicy : "none");
    check("the local TURN server was installed",
      Boolean(results.configured && results.configured.iceServers.length &&
        String(results.configured.iceServers[0].urls).includes("turn:127.0.0.1:")),
      results.configured && results.configured.iceServers.length
        ? String(results.configured.iceServers[0].urls) : "none");
    check("the TURN credentials were handed to the page",
      Boolean(results.configured && results.configured.iceServers.length &&
        results.configured.iceServers[0].hasCredential &&
        results.configured.iceServers[0].username));
    check("the offer includes voice audio", Boolean(results.mediaSections && results.mediaSections.audio));
    check("the offer includes Discord screen-share video",
      Boolean(results.mediaSections && results.mediaSections.screenShareVideo));
    check("Chromium gathered a relay candidate", (results.relayCandidates || []).length > 0,
      (results.relayCandidates || [])[0] || "none");
    check("the page hook published a status", (results.statuses || []).length > 0,
      (results.statuses || []).map((status) =>
        `${status.phase}${status.errorCode ? `:${status.errorCode}` : ""}`
      ).join(", "));
    const routeGenerationFailure = (results.statuses || []).find((status) =>
      status.errorCode === "backend-generation-changed"
    );
    check("TURN allocation keeps the active route generation stable",
      !routeGenerationFailure,
      routeGenerationFailure ? routeGenerationFailure.errorCode : "stable");

    await cdp.send("Page.navigate", {
      url: `chrome-extension://${identity.id}/test-fixtures/toggle.html`,
    });
    await sleep(1500);
    const stopped = await evaluate("window.__discordDirectStatus()");
    check("navigating the last Discord tab away stops the helper",
      Boolean(stopped && stopped.enabled && !stopped.helperRunning &&
        stopped.discordTabsOpen === 0 && stopped.phase === "waiting"),
      stopped ? `${stopped.phase}, helper=${stopped.helperRunning}, tabs=${stopped.discordTabsOpen}` : "no status");

    const disabled = await evaluate("window.__toggleDiscordDirect()");
    check("the toolbar toggle can disable routing without a popup",
      Boolean(disabled && disabled.ok && disabled.status &&
        !disabled.status.enabled && !disabled.status.helperRunning),
      disabled && disabled.status ? disabled.status.phase : "no status");

  } finally {
    if (cdp) cdp.close();
    if (browser && browser.exitCode === null) {
      spawnSync("taskkill.exe", ["/PID", String(browser.pid), "/T", "/F"], { stdio: "ignore" });
      await Promise.race([
        new Promise((resolve) => browser.once("exit", resolve)),
        sleep(3000),
      ]);
    }
    if (server && server.listening) {
      await new Promise((resolve) => server.close(resolve));
    }
    if (hostRegistered) {
      try { runPowerShell(uninstallScript, ["-ExtensionId", identity.id]); }
      catch (error) { process.stderr.write(`Native host cleanup failed: ${error.message}\n`); }
    }
    for (const temporaryDirectory of [ext, profile, hostInstallRoot]) {
      if (fs.existsSync(temporaryDirectory)) removeTempDirectory(temporaryDirectory);
    }
  }

  console.log(failures === 0 ? "\nHOOK TEST PASSED" : `\nHOOK TEST FAILED (${failures})`);
  process.exit(failures === 0 ? 0 : 1);
})().catch((error) => {
  console.error("hook test error:", error);
  process.exit(1);
});
