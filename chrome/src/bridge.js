(function connectExtensionBridge() {
  "use strict";

  const CHANNEL = "discord-voice-relay-chrome:v1";
  const extensionApi = typeof chrome === "object" ? chrome : browser;
  const DEFAULT_SETTINGS = {
    enabled: false,
    turnUrls: "",
    turnUsername: "",
    turnCredential: "",
    tcpOnly: true
  };

  let lastStatus = {
    phase: "waiting-for-page-hook",
    targetedConnections: 0,
    applied: false,
    relayCount: 0,
    error: null
  };

  function sendToPage(type, payload = {}) {
    window.postMessage({
      channel: CHANNEL,
      direction: "extension-to-page",
      type,
      ...payload
    }, window.location.origin);
  }

  function requestSettings() {
    return new Promise((resolve, reject) => {
      extensionApi.runtime.sendMessage({ type: "get-relay-settings" }, (response) => {
        const error = extensionApi.runtime.lastError;
        if (error) {
          reject(new Error(error.message));
          return;
        }
        resolve({ ...DEFAULT_SETTINGS, ...(response || {}) });
      });
    });
  }

  async function sendSettings() {
    const settings = await requestSettings();
    sendToPage("config", {
      settings: settings.enabled ? settings : {
        ...settings,
        turnUsername: "",
        turnCredential: ""
      }
    });
  }

  window.addEventListener("message", (event) => {
    if (event.source !== window || event.origin !== window.location.origin ||
        !event.data || event.data.channel !== CHANNEL ||
        event.data.direction !== "page-to-extension" || event.data.type !== "status") {
      return;
    }
    lastStatus = event.data.status;
  });

  extensionApi.storage.onChanged.addListener((changes, areaName) => {
    if (areaName === "local") {
      sendSettings().catch(() => {});
    }
  });

  extensionApi.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (!message) {
      return undefined;
    }
    if (message.type === "get-live-status") {
      sendToPage("get-status");
      sendResponse(lastStatus);
      return false;
    }
    if (message.type === "refresh-relay-settings") {
      sendSettings().catch((error) => {
        lastStatus = {
          ...lastStatus,
          phase: "bridge-error",
          error: String(error && error.message || error)
        };
      });
      sendResponse({ ok: true });
      return false;
    }
    return undefined;
  });

  sendSettings().catch((error) => {
    lastStatus = {
      ...lastStatus,
      phase: "bridge-error",
      error: String(error && error.message || error)
    };
  });
})();
