# Discord Voice Relay for Zen — legacy v0.1.0

This document is preserved from the original v0.1.0 release. Version 0.1.0 remains available from its [tag](https://github.com/AhmadotEng/discord-voice-relay-zen/tree/v0.1.0) and [GitHub release](https://github.com/AhmadotEng/discord-voice-relay-zen/releases/tag/v0.1.0); it is no longer the supported build on `main`.

A clean-room Zen/Firefox WebExtension that forces **Discord Web voice media** through an authenticated TURN relay over TCP or TLS. It is a browser-oriented alternative inspired by [Discord Drover](https://github.com/hdrover/discord-drover), but it does not reproduce Drover's Windows UDP packet trick.

> [!IMPORTANT]
> Only the extension is installed locally, but this project still requires an external TURN service. It does not provide a relay server or zero-infrastructure "Direct mode."

## Tested platform and status

- macOS 15.6.1 on Apple silicon
- Zen Browser 1.18.10b / Gecko 147.0.4
- Tested on September 15, 2026
- 16/16 unit tests pass, `web-ext lint` reports no errors or warnings, XPI integrity passes, and temporary loading in Zen succeeds
- Current Discord Web peer-connection configuration markers are recognized by the extension

A complete authenticated Discord voice call through a real TURN server has **not** yet been validated. Windows, Linux, other Zen releases, and later Discord Web changes remain untested.

## Requirements

- Zen/Firefox 142 or newer
- A TURN service reachable through TCP or TLS, preferably `turns:...:443?transport=tcp`
- A short-lived or dedicated TURN username and credential

A normal HTTP, HTTPS, or SOCKS proxy is not a TURN server. Use a managed provider you trust or deploy the archived [Coturn example](https://github.com/AhmadotEng/discord-voice-relay-zen/blob/v0.1.0/deploy/coturn/README.md) on a remote server that can reach Discord media endpoints.

## Install in Zen on macOS

1. Obtain working TURN-over-TCP/TLS client credentials. See the archived [Managed TURN setup](https://github.com/AhmadotEng/discord-voice-relay-zen/blob/v0.1.0/docs/managed-turn.md) or [Coturn setup](https://github.com/AhmadotEng/discord-voice-relay-zen/blob/v0.1.0/deploy/coturn/README.md).
2. Download `discord-voice-relay-zen-0.1.0.xpi` and its `.sha256` file from the [0.1.0 preview release](https://github.com/AhmadotEng/discord-voice-relay-zen/releases/tag/v0.1.0).
3. Optionally verify the XPI in Terminal from the folder containing both files:

   ```sh
   shasum -a 256 -c discord-voice-relay-zen-0.1.0.xpi.sha256
   ```

4. Open `about:debugging#/runtime/this-firefox` in Zen.
5. Select **Load Temporary Add-on…** and choose `discord-voice-relay-zen-0.1.0.xpi`.
6. Open or reload `https://discord.com/app`.
7. Open **Discord Voice Relay** from the extensions toolbar. Enter the TURN URL, username, and client credential, enable the relay, and save.
8. Leave and rejoin the Discord voice call so a new peer connection uses the setting.
9. Reopen the extension panel. It should report **Voice is using the relay**.
10. Independently verify the selected connection in `about:webrtc`: candidate type should be `relay`, and `relayProtocol` should be `tls` or `tcp`.

Do not share screenshots of `about:webrtc` publicly because they can contain IP addresses. This extension does **not** need `extensions.experiments.enabled`.

The unsigned XPI is a temporary development installation and disappears when Zen exits. Load it again after each restart. Because this is an ordinary WebExtension, a future Mozilla-signed unlisted build could support persistent installation, but none is provided yet.

To test unpacked source, check out the `v0.1.0` tag and select that checkout's `manifest.json` instead of the XPI in step 5.

## Recommended TURN URL

Prefer TURN over TLS on port 443:

```text
turns:relay.example.com:443?transport=tcp
```

Plain TURN over TCP is also accepted when necessary:

```text
turn:relay.example.com:3478?transport=tcp
```

If the call remains at ICE checking:

1. Confirm TCP/443 reaches the TURN host.
2. Confirm the client credential is current.
3. Confirm the TURN server can relay UDP from itself to Discord's media servers.
4. Inspect `about:webrtc` for failed candidate checks.

## How it works

Discord Web creates browser-managed `RTCPeerConnection` objects. At document start, the extension wraps that constructor in Discord's main JavaScript world. For external Discord-like configurations, it replaces the ICE server list with the configured TURN service and sets `iceTransportPolicy: "relay"`. Discord's no-argument internal audio loopback connections are deliberately left alone.

The extension also wraps `setConfiguration()` on targeted connections so later Discord configuration changes cannot silently remove the relay. Diagnostics retain only connection state, candidate type, and transport—never IP addresses, SDP, audio, messages, tokens, guilds, or channel IDs.

```text
Discord Web RTCPeerConnection
              │
              ▼
Extension supplies TURN and relay-only policy
              │
              ▼
       TURN over TCP/TLS
              │
              ▼
       Discord media endpoint
```

Discord/WebRTC still encrypts media end to end at the transport layer. The TURN operator can observe network metadata such as endpoints, timing, and traffic volume, so use an operator you trust.

## Relationship to Discord Drover

The original Discord Drover is Windows desktop software loaded beside `Discord.exe`. It hooks WinSock and changes the packet sequence around Discord Desktop's native UDP discovery traffic. Zen WebExtensions cannot access raw UDP datagrams, and Discord Web uses browser-managed ICE/DTLS/SRTP.

This project therefore solves the browser problem by selecting a standards-based TURN relay, not by porting Drover's Direct mode. It contains no Drover source code or `drover-packet.bin`. The upstream repository does not declare a top-level license, so it is linked only for attribution and technical context.

## Security and account-policy notes

- TURN credentials are stored in Zen's local extension storage, not an encrypted vault. Prefer short-lived credentials or a dedicated low-quota account.
- Discord page code can inspect a credential after it is supplied to the page's WebRTC configuration. Never enter a provider API token, Cloudflare TURN-key token, or Coturn shared secret.
- Turning the extension off stops supplying credentials to new connections; disconnect or reload Discord to discard an existing call's configuration.
- Never operate an unauthenticated public TURN server. Use authentication, quotas, and firewall rules.
- The extension requests only storage and access to `https://discord.com/*`. It has no analytics, remote code, Discord API calls, or token access.
- The panel status is a convenience diagnostic, not a tamper-proof security signal. Use `about:webrtc` for independent verification.
- Modifying Discord Web behavior may carry account-policy risk. Confirm that your use complies with Discord's terms and applicable network or local rules.

See the archived [v0.1.0 security policy](https://github.com/AhmadotEng/discord-voice-relay-zen/blob/v0.1.0/SECURITY.md) and [privacy disclosure](https://github.com/AhmadotEng/discord-voice-relay-zen/blob/v0.1.0/PRIVACY.md) for that build's reporting and data-handling details.

## Development

Run from a checkout of the `v0.1.0` tag:

```sh
node --test tests/*.test.js
npx --yes web-ext@8.10.0 lint --source-dir . --ignore-files 'tests/**' 'deploy/**' 'dist/**' 'scripts/**'
```

Build a new XPI with:

```sh
./scripts/build-xpi.sh
```

See the archived [v0.1.0 testing guide](https://github.com/AhmadotEng/discord-voice-relay-zen/blob/v0.1.0/TESTING.md) and [validation results](https://github.com/AhmadotEng/discord-voice-relay-zen/blob/v0.1.0/TEST-RESULTS.md) for that build's detailed verification and limitations.

## License and project status

Released under the [MIT License](LICENSE). This independent project is not affiliated with Discord, Discord Drover or its author, Zen Browser, Mozilla, Cloudflare, or any TURN provider.
