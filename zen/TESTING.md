# Testing Discord Direct for Zen

## Automated checks

From the repository root, use Node.js 20 or newer:

```sh
npm test
```

The project has no npm dependencies. The suite uses only Node.js built-ins and currently contains 139 tests covering manifest permissions, migration from version 0.1.0, TURN framing/authentication, address policy, mapping consensus, backend lifecycle, bounded resources, page/bridge isolation, negotiation races, fail-closed behavior, popup evidence, and Firefox 156 loader compatibility. The 28 preference-lifecycle cases include original absent/false/true values, browser restart recovery, disable before transport starts, overlapping stops, repeated cleanup, and malformed journals.

Build the unsigned XPI and checksum on macOS with:

```sh
npm run build
unzip -t dist/discord-direct-zen-0.2.4.2-unsigned.xpi
(cd dist && shasum -a 256 -c discord-direct-zen-0.2.4.2-unsigned.xpi.sha256)
```

## Temporary loading on macOS

1. Use Zen 1.22.2b or newer, backed by Firefox 152 or newer.
2. Open `about:debugging#/runtime/this-firefox`.
3. Remove the old **Discord Voice Relay for Zen** temporary add-on if it is present.
4. Choose **Load Temporary Add-on…** and select the XPI built from this checkout or this repository's `manifest.json`. The historical v0.2.4 release download does not include the 0.2.4.2 fixes.
5. Open the **Discord Direct** popup, enable it, keep two distinct STUN discovery endpoints, and save.
6. Wait for **Ready**, then reload any Discord tab that was already open.

Temporary add-ons disappear after Zen fully exits. No manual `about:config` change or native/system installation is required; the privileged backend temporarily manages and restores the loopback preference itself.

## Live Discord test

1. Open a freshly reloaded `https://discord.com/app` tab.
2. Confirm the popup says **Discord hook ready** or **Ready** before joining voice.
3. Join a voice channel or call once. Do not keep retrying while the route is preparing.
4. Confirm Discord reports **Voice Connected**.
5. Reopen the popup and require **Protected route verified**. **Ready** by itself is not an end-to-end result.
6. Confirm incoming audio and ask another participant to confirm microphone audio.
7. Exercise mute/unmute, a participant change, a channel change, and a call lasting at least ten minutes.
8. Inspect `about:webrtc` only if needed. The selected local candidate should be relay/UDP. Do not publish the page because it can contain IP addresses and SDP.

## Failure and isolation cases

- Block either discovery endpoint and confirm setup fails closed.
- Test on a destination-dependent/symmetric NAT and confirm no direct candidate is released while protection is enabled.
- Replace the page hook or load an already-hooked Discord document and confirm the popup requests a reload.
- Disable or remove the extension and confirm sockets close and the previous loopback preference is restored.
- Test with the original loopback user value absent, false, and true. After an enabled browser restart, stop/disable the extension both before and after transport starts; verify the original value and user/default status are restored and the restoration journal is cleared. Reload temporary add-ons explicitly after a full browser exit.
- Stop the backend during a call and confirm the status loses verification instead of claiming stale success.
- Confirm unrelated tabs and non-Discord WebRTC pages are untouched.

Record the Zen version, Firefox base, operating system, extension checksum, route state, and redacted outcome for every live validation run.
