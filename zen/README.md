# Discord Direct for Zen

Discord Direct for Zen is an experimental, privileged Zen/Firefox extension that applies the Discord Drover transport idea to **new Discord Web voice connections** without installing WARP, a native helper, a local daemon, a system proxy, or an external media relay.

This source build is version **0.2.4.2**, adding preference restoration across restarts and overlapping shutdowns to version 0.2.4. It replaces the earlier `Discord Voice Relay for Zen` version **0.1.0**, intentionally uses the same Gecko extension ID, clears that build's saved external TURN URL and credentials, and refuses to stack its page hook over an already-injected old hook. The original [v0.1.0 release](https://github.com/AhmadotEng/discord-voice-relay-zen/releases/tag/v0.1.0), tag, assets, and [setup document](LEGACY-V0.1.0.md) remain available.

## Browser requirement

Discord Direct requires **Zen/Firefox 152 or newer**. Firefox 147 rejects a successful ICE Binding response when `XOR-MAPPED-ADDRESS` differs from the advertised relay candidate, so the call can remain at **Checking Route** even though the extension is sending and receiving the protected UDP traffic. Mozilla fixed that ICE relay validation behavior in [bug 2034159](https://bugzilla.mozilla.org/show_bug.cgi?id=2034159).

Zen **1.22.2b**, based on Firefox 156, includes the fix and is a supported current version. Older Zen builds based on Firefox 147 are intentionally rejected by the add-on manifest instead of failing later with an opaque voice-connection error.

## What it does

1. The privileged background API opens a TURN listener on an ephemeral `127.0.0.1` UDP port.
2. Firefox sends its TURN traffic to that local listener.
3. The extension unwraps TURN and sends Discord's peer UDP traffic from an extension-owned UDP socket.
4. Before advertising that socket, it asks two independent public STUN discovery services what public IP/port they see. It proceeds only when both observations match.
5. A `document_start` hook holds Discord's first offer, answer, or implicit local-description operation, requests a fresh background decision so cached state cannot win an enable race, installs the local TURN server, and forces `iceTransportPolicy: "relay"`.
6. The first peer datagram triggers the two one-byte `0x00` and `0x01` prelude packets, followed by a 50 ms dispatch delay, on the same upstream socket.

The default discovery endpoints are:

- `stun:stun.cloudflare.com:3478`
- `stun:global.stun.twilio.com:3478`

These are **STUN discovery endpoints only**. They receive small mapping probes. They are not Cloudflare WARP, proxies, TURN relays, or media carriers. Discord voice media does not pass through Cloudflare or Twilio in this design.

## Important limitation

This design works only when the network gives the extension-owned UDP socket a stable, endpoint-independent public mapping. It fails closed on a symmetric/address-dependent NAT, many carrier-grade NATs, blocked UDP, conflicting STUN observations, listener failure, late setup, or an unsupported Firefox ICE path. There is no extension-only correction for those network cases; a reachable relay or native/system transport would be required.

Discord page code can replace the global `RTCPeerConnection` constructor after the extension's `document_start` hook. Popup status polling detects a missing hook brand and requires a full reload, but a connection created during the replacement gap cannot be retroactively intercepted.

On September 19, 2026, version 0.2.4 passed a fresh live Discord call on macOS 15.6.1 on Apple silicon with Zen 1.22.2b / Firefox 156. The popup reached **Protected route verified**, Discord reported **Voice Connected**, the backend recorded bidirectional transport packets, and the user confirmed incoming voice audio. This validates that tested environment and network; it is not a guarantee for every NAT or provider. Do not treat “Ready” or a gathered relay candidate alone as proof. The popup reports success only after all of these agree:

- Discord's selected local candidate is `relay`;
- its relay protocol is UDP (or, on Firefox builds that omit `relayProtocol`, it is a relay candidate whose protocol is UDP; the configured local TURN URL is UDP-only);
- the selected candidate belongs to the current background boot and backend generation;
- the page proof matches the current proof-relevant backend route revision;
- the local TURN allocation still exists and mapping discovery completed; and
- upstream and downstream backend packet counters advanced.

## macOS Zen setup

This is a temporary privileged extension, not an ordinary signed Firefox add-on.

The download instructions below refer to the historical **v0.2.4** release. For the **0.2.4.2** fixes, use this checkout's `manifest.json` or build an XPI from this checkout; no new release asset is implied by the source version.

1. Confirm Zen is version **1.22.2b or newer** (Firefox 152+ is required). Update Zen before loading this build if necessary.
2. If the old **Discord Voice Relay for Zen** add-on is loaded, remove or replace it. This build uses the same extension ID so both cannot be loaded normally at the same time.
3. Download `discord-direct-zen-0.2.4-unsigned.xpi` and its `.sha256` file from the [v0.2.4 release](https://github.com/AhmadotEng/discord-voice-relay-zen/releases/tag/v0.2.4).
4. Optionally verify the download from the folder containing both files:

   ```sh
   shasum -a 256 -c discord-direct-zen-0.2.4-unsigned.xpi.sha256
   ```

5. Open Zen and go to `about:debugging#/runtime/this-firefox`.
6. Choose **Load Temporary Add-on…**.
7. Select `discord-direct-zen-0.2.4-unsigned.xpi`, or select this checkout's `manifest.json` when developing from source.
8. Open the **Discord Direct** toolbar button. You can also open its Preferences page from Zen's Add-ons Manager; both views use the same controls.
9. Leave the two default STUN discovery endpoints in place, turn the extension on, and choose **Save settings**.
10. Wait until the popup says **Ready**.
11. Reload any Discord tab that was already open. This is mandatory when replacing the old add-on because JavaScript already injected into a page cannot be removed in place.
12. Open `https://discord.com/app`. If you were already in voice, manually leave and rejoin once after the route is ready.

The extension does not click Discord controls and never joins, leaves, disconnects, or reconnects a call automatically.

Temporary add-ons are removed when Zen exits. Repeat the loading steps after restarting Zen. Removing or disabling the add-on invokes the transport shutdown path, closes its UDP sockets, and restores the previous value of Firefox's `media.peerconnection.ice.loopback` preference.

## Popup states

- **Off** — Discord voice is untouched.
- **Preparing route** — first offers are held; they cannot silently fall back to direct ICE.
- **Ready** — the listener and loopback preference are active for the next voice connection. This is not yet an end-to-end success.
- **Waiting for backend** — Discord selected a relay/UDP candidate, but the current allocation and packet flow are not fully confirmed yet.
- **Protected route verified** — selected-pair proof matches the current proof-relevant backend revision, which still contains a live allocation with bidirectional packet evidence.
- **Reconnect Discord voice** — the route changed, arrived too late, or stopped. The popup includes the exact bounded reason code; manually leave and rejoin once.
- **Reload Discord** — the old page hook is still in the document or another hook replaced this one. Reload the page before reconnecting voice.
- **Route unavailable** — the route failed closed; no normal direct offer was released while protection was enabled.

## Replacement and legacy settings

Version `0.1.0` of Discord Voice Relay stored these keys: `enabled`, `turnUrls`, `turnUsername`, `turnCredential`, and `tcpOnly`. On first startup this build removes all five. It does not send an old provider URL or credential to Discord, the local backend, STUN, or storage under a new name. Direct mode starts disabled after that migration and shows a neutral migration notice.

## Security and privacy boundaries

- Host access is limited to `https://discord.com/*`; there is no `<all_urls>` permission.
- The extension has no proxy, `webRequest`, cookies, downloads, history, native messaging, or system-install permission.
- The TURN listener binds only to `127.0.0.1` and uses new random credentials each time it starts.
- Credentials remain in background memory and are returned only to the isolated bridge in a matching top-level Discord document. They are never stored, logged, or shown in the popup.
- User-visible/page status retains only bounded counters, state names, an opaque background-boot ID, the backend generation, a monotonic proof-relevant route revision, and candidate type/protocol. It does not retain URLs, SDP, candidate strings, IP addresses, Discord IDs, tokens, or media.
- The private route response transiently supplies each live allocation's public mapped address/port, opaque allocation ID, and per-allocation packet counters to the Discord MAIN-world hook. The hook exact-matches those fields against Firefox's selected relay candidate so traffic from one call cannot verify another. These endpoint fields are not stored, logged, or emitted to the popup/page status; Discord can already inspect its own WebRTC candidate endpoints.
- Public/private/reserved peer addresses are rejected in remote mode. Allocations, peer addresses, pending datagrams, connections, retries, and lifecycle waits are bounded.
- Code in Discord's MAIN world is trusted application code, not a security boundary. A compromised page can inspect its own `RTCPeerConnection` configuration. The exposed credentials are therefore short-lived and valid only for a tightly constrained loopback TURN server; there is no reusable provider secret.
- `media.peerconnection.ice.loopback` is a browser-wide testing preference while the backend runs. The privileged API snapshots and restores its exact prior user/default state on stop, failure, extension shutdown, and Zen shutdown.

Version 0.2.4.2 keeps that original baseline in `extensions.discord-direct.loopback-pref-snapshot`, containing only a schema version and two Boolean fields. Stop/disable restores and clears it, including when transport has not started in the new extension instance. Browser shutdown restores the in-memory preference while retaining the journal for the next instance; a temporary add-on that is never reloaded can leave the journal behind. A malformed journal is rejected rather than overwritten. Preference-file saves are asynchronous, so this is not a power-loss guarantee.

## Why a voice reconnect is required

Changing ICE servers on an already-connected `RTCPeerConnection` does not change its selected path. An ICE restart and a new offer/answer exchange would be required, but current Discord Web does not expose a safe client-initiated restart path. The extension therefore configures only a pristine new voice connection. If setup is late, it rejects the offer and asks for one manual reconnect instead of attempting to mutate a live call.

## Relationship to Discord Drover

[Discord Drover](https://github.com/hdrover/discord-drover) is Windows desktop software that hooks Winsock around Discord Desktop's native UDP traffic. A Zen extension cannot use that Windows mechanism. This project independently implements the browser path with a privileged Firefox API, a loopback TURN bridge, and an extension-owned UDP socket.

Version 0.2.4 sends the two one-byte `0x00` and `0x01` prelude datagrams before the first real peer datagram. It does not include Drover source code or `drover-packet.bin`; the upstream repository declares no top-level license and is linked only for attribution and technical context.

## Testing and validation

Run the dependency-free test suite with Node.js:

```sh
node --test tests/*.test.cjs
```

The suite covers the TURN codec and mapping policy, exact manifest boundaries, old-extension migration, loopback URL parsing, constructor targeting and subclass behavior, hook idempotency, offer/answer/implicit negotiation gates, background-boot and bridge-instance rollover, response races, multi-connection failure priority, the bounded readiness timeout, stale backend generations and proof revisions, stable revisions during ordinary counter growth, provisional ICE candidate errors, fail-closed errors, partial `setConfiguration()` merging with immutable fields, old-hook conflicts, and per-allocation selected-pair/backend success.

The current suite passes **139/139** tests, including 28 additional shutdown/preference regression cases covering absent/false/true baselines, restart recovery before transport starts, overlapping stops, and malformed saved state. The recorded **v0.2.4** live test covered temporary installation, route preparation, a fresh Discord voice connection, a selected relay/UDP pair, **Protected route verified**, continued connection, and incoming audio. See [TEST-RESULTS.md](TEST-RESULTS.md) for the separate validation status of this source update.

Additional environments and longer-lived behavior still need validation before treating this as production-ready:

1. Confirm microphone audio with another participant, mute/unmute, participant changes, a channel change, TURN refresh, and a call lasting at least ten minutes.
2. Stop the backend during a call and confirm voice fails rather than switching to a direct pair.
3. Repeat on additional endpoint-independent NATs and on a deliberately destination-dependent NAT; the second case must fail closed.
4. Repeat on Windows and Linux with a supported Zen/Firefox base.

See [TESTING.md](TESTING.md) and [TEST-RESULTS.md](TEST-RESULTS.md) for the full procedure and recorded evidence.

## Project layout

- `api/implementation-gecko147.js` — privileged loopback TURN and upstream UDP transport based on the reviewed PoC, with packaged-script loading and preference-lifecycle fixes.
- `lib/turn-codec.js` and `lib/mapping-policy.js` — TURN framing, authentication, address policy, and two-destination mapping decision.
- `background.js` — settings migration, listener lifecycle, generation control, sender checks, and sanitized status.
- `src/page-hook.js` — MAIN-world constructor hook, first-offer gate, route enforcement, and selected-pair verification.
- `src/bridge.js` — isolated, top-level Discord bridge; no privileged callable crosses into the page.
- `popup/` — enable state, STUN discovery settings, and non-automatic reconnect guidance.

## Dependencies and development

The extension has no npm packages, native helper, service, external relay, or runtime download. Runtime imports come only from Zen/Firefox's built-in privileged modules. The tests use Node.js built-ins only; do not commit `node_modules`.

```sh
npm test
npm run build
```

The macOS build script uses the system `zip` and `shasum` commands, writes the unsigned XPI and checksum to `dist/`, and packages every runtime file using the version from `manifest.json`.

## License and project status

Released under the [MIT License](LICENSE). This independent experimental project is not affiliated with Discord, Discord Drover or its author, Zen Browser, Mozilla, Cloudflare, or Twilio.

## Not supported

- Chrome or Chromium for this privileged direct build. This repository contains a separate [Chrome relay build](../chrome/README.md).
- Ordinary Firefox/Zen extension signing.
- Discord's desktop client.
- Existing calls without one manual reconnect.
- TCP-only networks.
- Symmetric/address-dependent NAT correction.
- External TURN credentials or an external media relay.
- Cloudflare WARP or any generic “free proxy” behavior.
