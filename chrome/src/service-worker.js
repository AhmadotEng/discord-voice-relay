"use strict";

const DEFAULT_PERSISTED_SETTINGS = {
  enabled: false,
  turnUrls: "",
  turnUsername: "",
  tcpOnly: true,
  disclosureAccepted: false
};

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || message.type !== "get-relay-settings") {
    return false;
  }

  chrome.storage.local.get(DEFAULT_PERSISTED_SETTINGS, (persisted) => {
    if (chrome.runtime.lastError) {
      sendResponse({
        ...DEFAULT_PERSISTED_SETTINGS,
        turnCredential: "",
        enabled: false,
        settingsError: chrome.runtime.lastError.message
      });
      return;
    }

    chrome.storage.session.get({ turnCredential: "" }, (session) => {
      if (chrome.runtime.lastError) {
        sendResponse({
          ...persisted,
          turnCredential: "",
          enabled: false,
          settingsError: chrome.runtime.lastError.message
        });
        return;
      }

      sendResponse({
        enabled: Boolean(persisted.enabled && persisted.disclosureAccepted),
        turnUrls: String(persisted.turnUrls || ""),
        turnUsername: String(persisted.turnUsername || ""),
        turnCredential: String(session.turnCredential || ""),
        tcpOnly: true
      });
    });
  });

  return true;
});
