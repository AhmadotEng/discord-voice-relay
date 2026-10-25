window.__toggleDiscordDirect = () => chrome.runtime.sendMessage({
  type: "discord-voice-relay:toggle"
});
window.__discordDirectStatus = () => chrome.runtime.sendMessage({
  type: "discord-voice-relay:get-status"
});
