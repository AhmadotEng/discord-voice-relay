# Security policy

## Supported version

Only the latest source build is supported. The current supported Zen build is Discord Direct for Zen 0.2.4.2 on Zen/Firefox 152 or newer. Version 0.1.0 remains archived for reproducibility but is no longer supported.

## Reporting a vulnerability

Use this repository's **Security** tab to submit a private vulnerability report. Do not open a public issue before a fix or coordinated disclosure plan is available.

Useful reports include the affected extension version, Zen/Firefox version, operating system, minimal reproduction steps, observed impact, and whether **Protected route verified** appeared. Do not include Discord tokens, full `about:webrtc` dumps, IP addresses, SDP, candidate strings, call audio, or unrelated personal data.

## Security boundaries

- Version 0.2.4 is a temporary privileged extension and should be loaded only from this repository's release or reviewed source.
- Host access is limited to `https://discord.com/*`; the extension does not request all-site, proxy, cookie, download, history, web-request, or native-messaging permissions.
- The local TURN listener binds only to `127.0.0.1` and uses freshly generated short-lived credentials held in memory.
- The two configured STUN discovery services learn the public source address of small mapping probes. They do not carry Discord voice media.
- The extension-owned UDP socket communicates with the selected Discord media endpoint. Discord and network operators can observe their normal transport metadata.
- Code running in Discord's page context can inspect its own WebRTC configuration and is not treated as a security boundary.
- `media.peerconnection.ice.loopback` is browser-wide while the backend runs. The extension snapshots and restores its previous state during normal shutdown and failure handling.

The project fails closed when it cannot establish or verify its intended route, but no browser extension can defend against a compromised browser, operating system, Discord account, or network endpoint.
