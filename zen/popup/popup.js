(function runPopup() {
  "use strict";

  const tools = globalThis.__discordDirectTools;
  const popupStatus = globalThis.__discordDirectPopupStatus;
  const enabledInput = document.querySelector("#enabled");
  const serversInput = document.querySelector("#stun-servers");
  const saveButton = document.querySelector("#save");
  const errorNode = document.querySelector("#form-error");
  const statusTitle = document.querySelector("#status-title");
  const statusDetail = document.querySelector("#status-detail");
  const statusDot = document.querySelector("#status-dot");
  const migrationNode = document.querySelector("#migration");
  const dismissMigration = document.querySelector("#dismiss-migration");
  let saving = false;

  function showError(message) {
    errorNode.textContent = message || "";
    errorNode.classList.toggle("hidden", !message);
  }

  function setStatus(title, detail, tone = "") {
    statusTitle.textContent = title;
    statusDetail.textContent = detail;
    statusDot.className = `dot${tone ? ` ${tone}` : ""}`;
  }

  async function pageStatus() {
    try {
      const [activeTab] = await browser.tabs.query({ active: true, currentWindow: true });
      const discordTabs = await browser.tabs.query({
        url: "https://discord.com/*",
      });
      const activeDiscord = activeTab && /^https:\/\/discord\.com(?:\/|$)/u.test(activeTab.url || "")
        ? activeTab
        : null;
      if (activeDiscord && activeDiscord.id) {
        try {
          return await browser.tabs.sendMessage(activeDiscord.id, {
            type: "discord-direct:get-page-status",
          });
        } catch (_error) {
          return { phase: "bridge-unavailable" };
        }
      }
      const candidates = [...discordTabs].sort((left, right) => {
        return Number(right.lastAccessed || 0) - Number(left.lastAccessed || 0);
      });
      let fallback = null;
      let hasDiscordTab = false;
      for (const tab of candidates) {
        if (!tab || !tab.id) continue;
        hasDiscordTab = true;
        try {
          const status = await browser.tabs.sendMessage(tab.id, {
            type: "discord-direct:get-page-status",
          });
          if (!fallback) fallback = status;
          if (status && (status.currentConnectionId > 0 || status.targetedConnections > 0)) {
            return status;
          }
        } catch (_error) {
          // A stale or still-loading Discord tab is not authoritative.
        }
      }
      return fallback || (hasDiscordTab ? { phase: "bridge-unavailable" } : null);
    } catch (_error) {
      return null;
    }
  }

  function renderStatus(transport, page) {
    const result = popupStatus.presentation(transport, page);
    setStatus(result.title, result.detail, result.tone);
  }

  async function refresh() {
    try {
      const [transport, page] = await Promise.all([
        browser.runtime.sendMessage({ type: "discord-direct:get-status" }),
        pageStatus(),
      ]);
      renderStatus(transport, page);
      migrationNode.classList.toggle("hidden", transport.migrationNotice !== true);
    } catch (_error) {
      setStatus("Status unavailable", "Reload the temporary add-on and try again.", "error");
    }
  }

  async function load() {
    try {
      const current = await browser.runtime.sendMessage({ type: "discord-direct:get-settings" });
      enabledInput.checked = current.enabled === true;
      serversInput.value = current.mappingProbeServers || tools.DEFAULT_SETTINGS.mappingProbeServers;
      migrationNode.classList.toggle("hidden", current.migrationNotice !== true);
      await refresh();
    } catch (_error) {
      showError("Could not read extension settings.");
      setStatus("Status unavailable", "Reload the temporary add-on and try again.", "error");
    }
  }

  saveButton.addEventListener("click", async () => {
    if (saving) return;
    const validation = tools.validateSettings({
      enabled: enabledInput.checked,
      mappingProbeServers: serversInput.value,
    });
    if (validation.errors.length > 0) {
      showError(validation.errors.join(" "));
      return;
    }
    showError("");
    saving = true;
    saveButton.disabled = true;
    saveButton.textContent = "Saving…";
    try {
      const response = await browser.runtime.sendMessage({
        type: "discord-direct:save-settings",
        settings: validation.settings,
      });
      if (!response || !response.ok) {
        showError(response && response.errors ? response.errors.join(" ") : "Settings were not saved.");
      }
      await refresh();
    } catch (_error) {
      showError("Could not save the settings.");
    } finally {
      saving = false;
      saveButton.disabled = false;
      saveButton.textContent = "Save settings";
    }
  });

  dismissMigration.addEventListener("click", async () => {
    await browser.runtime.sendMessage({ type: "discord-direct:dismiss-migration" }).catch(() => {});
    migrationNode.classList.add("hidden");
  });

  load();
  globalThis.setInterval(() => {
    if (!saving) refresh();
  }, 1200);
})();
