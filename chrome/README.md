# Discord Voice Relay for Chrome

This is a clean-room Chrome/Chromium Manifest V3 extension that routes **Discord Web voice media** through a user-provided encrypted TURN relay using TLS/TCP. It is the practical browser equivalent of the goal behind Discord Drover; it does not contain or redistribute Drover code or `drover-packet.bin`.

## What you need

- Chrome or a Chromium-based browser version 111 or newer.
- A TURN server reachable over TLS/TCP, ideally `turns:...:443?transport=tcp`.
- A TURN client username and credential. A normal HTTP/SOCKS proxy is not a TURN server.

The extension cannot create a relay by itself. Use a TURN service you trust, or deploy the included Coturn example on a small public server outside the network that blocks Discord voice.

For the quickest managed setup, see [Managed TURN setup](docs/managed-turn.md). For a self-hosted relay, see [Coturn setup](deploy/coturn/README.md).

## Install unpacked in Chrome

1. Keep this entire `chrome` folder in a permanent location. Its `manifest.json` is at the folder root, as Chrome expects for **Load unpacked**.
2. Open `chrome://extensions`.
3. Turn on **Developer mode**.
4. Select **Load unpacked** and choose this folder.
5. Open or reload `https://discord.com/channels/@me`.
6. Open the extension panel, enter the TURN client details, enable it, and save.
7. Leave and rejoin the voice call. Reopen the panel; success is shown only after Chrome reports **Voice is using the relay**.

Chrome keeps an unpacked extension installed while the source folder remains available. For distribution through the Chrome Web Store, package and submit this source through the Chrome Web Store developer dashboard; a ZIP is not directly installable from `chrome://extensions`.

## Recommended TURN URL

Use TLS on port 443 where possible:

```text
turns:relay.example.com:443?transport=tcp
```

If the status stays at ICE checking:

1. Confirm TCP/443 reaches the TURN host.
2. Confirm the TURN credential is current.
3. Confirm the TURN server can relay UDP from itself to Discord's media servers.
4. Open `chrome://webrtc-internals` before reconnecting, then verify that the selected local candidate type is `relay` and the client-to-relay protocol is TLS/TCP. The peer-facing candidate protocol can still be UDP; that is expected. Avoid sharing that page publicly because it can contain IP addresses and session details.

## How it works

Discord Web uses the browser's standard `RTCPeerConnection`. At document start, the extension wraps that constructor in the page's main JavaScript world. It targets only Discord's explicit external network configurations (`plan-b`, `unified-plan`, or `max-bundle`), replaces their ICE server list with your TURN server, and sets `iceTransportPolicy: "relay"`. Discord's no-argument internal audio loopback peer connections are deliberately left alone.

It also wraps `setConfiguration()` on targeted connections so a later Discord reconfiguration cannot silently remove the relay. Diagnostic status records only connection state, candidate type, and transport—never IPs, SDP, audio, messages, tokens, guilds, or channel IDs.

## Security and account-policy notes

- The TURN credential is stored only in Chrome's in-memory extension session storage and clears when Chrome exits. The nonsecret URL, username, and toggle settings persist locally. Prefer short-lived credentials or a dedicated low-quota TURN account.
- While enabled, the credential is sent into the `discord.com` main JavaScript world and handed to `RTCPeerConnection`; Discord page code can inspect it. Never enter a provider API token, Cloudflare TURN-key token, or Coturn shared secret. Turning the toggle off stops sending the stored secret to the page, but an existing call can retain its earlier configuration until you disconnect or reload.
- The relay can see connection metadata such as your IP, Discord's media endpoint, timing, and traffic volume. WebRTC media remains encrypted in transit, but use a relay operator you trust.
- Do not run an unauthenticated/open TURN server. Apply quotas and firewall rules.
- The extension injects only on `https://discord.com/channels/*` and requests extension storage. It contains no analytics, remote code, proxy CA, Discord API calls, or token access. See [Privacy disclosure](PRIVACY.md).
- The panel's success status is a convenience diagnostic, not a tamper-proof security signal, because it shares Discord's page context. Use `chrome://webrtc-internals` for an independent check.
- This changes Discord Web's WebRTC configuration. Discord's terms restrict unauthorized client modifications, so use it at your own account-policy risk.
- If local law or network policy restricts VoIP or circumvention, verify that this use is permitted before enabling it.

## Development checks

Run:

```sh
node --test tests/*.test.js
```

The clean-room extension code is available under the MIT License. The upstream Discord Drover repository has no top-level license, so none of its source or packet data is copied here.

## Why Drover itself cannot be loaded

Discord Drover is a Windows `version.dll` that is loaded beside `Discord.exe`; it hooks WinSock and prepends special datagrams to Discord Desktop's native 74-byte UDP discovery packet. Chrome extensions cannot access raw UDP packets, and Discord Web uses browser-managed ICE/DTLS/SRTP instead of that desktop discovery protocol. Reproducing Drover's exact packet trick would require an OS-level packet filter or modified browser, not an extension.
