(function runPopup() {
  "use strict";

  const tools = globalThis.__discordVoiceRelayTools;
  const extensionApi = typeof chrome === "object" ? chrome : browser;
  const { turnCredential: _ignoredCredential, ...PERSISTED_DEFAULTS } = tools.DEFAULT_SETTINGS;
  const elements = {
    form: document.querySelector("#settings-form"),
    enabled: document.querySelector("#enabled"),
    turnUrls: document.querySelector("#turn-urls"),
    turnUsername: document.querySelector("#turn-username"),
    turnCredential: document.querySelector("#turn-credential"),
    tcpOnly: document.querySelector("#tcp-only"),
    disclosureAccepted: document.querySelector("#disclosure-accepted"),
    validation: document.querySelector("#validation"),
    save: document.querySelector("#save"),
    statusDot: document.querySelector("#status-dot"),
    statusTitle: document.querySelector("#status-title"),
    statusDetail: document.querySelector("#status-detail")
  };

  function callApi(method, receiver, ...args) {
    return new Promise((resolve, reject) => {
      let completed = false;
      const finish = (value) => {
        if (completed) {
          return;
        }
        completed = true;
        const error = extensionApi.runtime && extensionApi.runtime.lastError;
        if (error) {
          reject(new Error(error.message));
        } else {
          resolve(value);
        }
      };
      try {
        const result = method.call(receiver, ...args, finish);
        if (result && typeof result.then === "function") {
          result.then(finish, reject);
        }
      } catch (error) {
        reject(error);
      }
    });
  }

  function formSettings() {
    return {
      enabled: elements.enabled.checked,
      turnUrls: elements.turnUrls.value,
      turnUsername: elements.turnUsername.value.trim(),
      turnCredential: elements.turnCredential.value,
      tcpOnly: elements.tcpOnly.checked
    };
  }

  function showValidation(errors) {
    elements.validation.hidden = errors.length === 0;
    elements.validation.textContent = errors.join(" ");
  }

  function currentErrors() {
    const validation = tools.validateSettings(formSettings());
    const errors = [...validation.errors];
    if (validation.settings.enabled && !elements.disclosureAccepted.checked) {
      errors.push("Acknowledge the credential and relay disclosure before enabling.");
    }
    return { validation, errors };
  }

  function setStatus(kind, title, detail) {
    elements.statusDot.className = `dot ${kind}`;
    elements.statusTitle.textContent = title;
    elements.statusDetail.textContent = detail;
  }

  function describeStatus(status, enabled) {
    if (!enabled) {
      setStatus("idle", "Relay is off", "Enable it, save, then reconnect Discord voice.");
      return;
    }
    if (!status) {
      setStatus("warn", "No Discord page detected", "Open or reload discord.com/channels/@me in this tab.");
      return;
    }
    if (status.error) {
      setStatus("bad", "Relay needs attention", status.error);
      return;
    }
    if (status.connectionState === "failed" || status.iceConnectionState === "failed") {
      setStatus("bad", "Relay connection failed", "Check the TURN address and credential, then reconnect voice.");
      return;
    }
    if (status.connectionState === "closed" || status.iceConnectionState === "closed") {
      setStatus("idle", "Voice connection closed", "Join or reconnect Discord voice to use the relay.");
      return;
    }
    if (status.connectionState === "disconnected" || status.iceConnectionState === "disconnected") {
      setStatus("warn", "Relay connection interrupted", "Wait briefly, or reconnect Discord voice if it does not recover.");
      return;
    }
    const connected = status.connectionState === "connected" ||
      status.iceConnectionState === "connected" || status.iceConnectionState === "completed";
    if (connected && status.selectedCandidate && status.selectedCandidate.type === "relay") {
      const transport = status.selectedCandidate.relayProtocol ||
        status.selectedCandidate.protocol || "relay";
      setStatus("good", "Voice is using the relay", `Selected relay candidate over ${transport.toUpperCase()}.`);
      return;
    }
    if (status.applied) {
      setStatus("warn", "Relay enforced—not connected yet", `Waiting for ICE; ${status.relayCount} TURN URL(s) active.`);
      return;
    }
    if (status.phase === "ready" || status.phase === "configured") {
      setStatus("warn", "Ready for a new voice connection", "Disconnect/reconnect the call so Discord creates a relayed connection.");
      return;
    }
    setStatus("warn", "Waiting for Discord voice", `Hook state: ${status.phase || "unknown"}.`);
  }

  async function activeDiscordStatus() {
    const tabs = await callApi(
      extensionApi.tabs.query,
      extensionApi.tabs,
      { active: true, currentWindow: true }
    );
    const tab = tabs[0];
    if (!tab || typeof tab.id !== "number") {
      return null;
    }
    try {
      return await callApi(
        extensionApi.tabs.sendMessage,
        extensionApi.tabs,
        tab.id,
        { type: "get-live-status" }
      );
    } catch (_error) {
      return null;
    }
  }

  async function load() {
    const [persisted, session] = await Promise.all([
      callApi(extensionApi.storage.local.get, extensionApi.storage.local, {
        ...PERSISTED_DEFAULTS,
        disclosureAccepted: false
      }),
      callApi(extensionApi.storage.session.get, extensionApi.storage.session, {
        turnCredential: ""
      })
    ]);
    const settings = { ...tools.DEFAULT_SETTINGS, ...persisted, ...session };
    elements.enabled.checked = Boolean(settings.enabled);
    elements.turnUrls.value = settings.turnUrls;
    elements.turnUsername.value = settings.turnUsername;
    elements.turnCredential.value = settings.turnCredential;
    elements.tcpOnly.checked = true;
    elements.disclosureAccepted.checked = Boolean(settings.disclosureAccepted);
    const status = await activeDiscordStatus();
    describeStatus(status, elements.enabled.checked);
  }

  elements.enabled.addEventListener("change", () => {
    const { errors } = currentErrors();
    showValidation(errors);
    if (!elements.enabled.checked) {
      setStatus("idle", "Relay is off", "Save to stop changing new Discord voice connections.");
    }
  });

  elements.disclosureAccepted.addEventListener("change", () => {
    const { errors } = currentErrors();
    showValidation(errors);
  });

  elements.form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const { validation, errors } = currentErrors();
    showValidation(errors);
    if (errors.length > 0) {
      return;
    }

    elements.save.disabled = true;
    elements.save.textContent = "Saving…";
    try {
      const { turnCredential, ...persistedSettings } = validation.settings;
      await Promise.all([
        callApi(extensionApi.storage.local.set, extensionApi.storage.local, {
          ...persistedSettings,
          disclosureAccepted: elements.disclosureAccepted.checked
        }),
        callApi(extensionApi.storage.local.remove, extensionApi.storage.local, "turnCredential"),
        callApi(extensionApi.storage.session.set, extensionApi.storage.session, {
          turnCredential
        })
      ]);
      try {
        const tabs = await callApi(
          extensionApi.tabs.query,
          extensionApi.tabs,
          { active: true, currentWindow: true }
        );
        if (tabs[0] && typeof tabs[0].id === "number") {
          await callApi(
            extensionApi.tabs.sendMessage,
            extensionApi.tabs,
            tabs[0].id,
            { type: "refresh-relay-settings" }
          );
        }
      } catch (_error) {
        // The user may save settings before opening a Discord channel tab.
      }
      setStatus(
        validation.settings.enabled ? "warn" : "idle",
        validation.settings.enabled ? "Saved—reconnect voice" : "Relay is off",
        validation.settings.enabled
          ? "Leave and rejoin the call, then verify that this panel says Voice is using the relay."
          : "New Discord voice connections will use their normal route."
      );
      elements.save.textContent = "Saved";
      setTimeout(() => { elements.save.textContent = "Save and reconnect voice"; }, 900);
    } finally {
      elements.save.disabled = false;
    }
  });

  load().catch((error) => {
    setStatus("bad", "Extension error", String(error && error.message || error));
  });
})();
