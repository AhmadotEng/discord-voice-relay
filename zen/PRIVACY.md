# Privacy disclosure

Discord Direct for Zen has no developer-operated service, analytics, advertising, telemetry, or remote code. It does not read Discord tokens, messages, guilds, contacts, cookies, browsing history, or decoded call audio.

## Data stored locally

Zen's extension storage keeps only the enabled state and the user-configured STUN discovery URLs. Version 0.2.4 removes the external TURN URL, username, credential, and TCP-only values saved by legacy version 0.1.0.

The loopback TURN username and credential used by version 0.2.4 are generated for the current backend instance, kept in background memory, and never written to extension storage or logs.

Starting with version 0.2.4.2, the browser preference `extensions.discord-direct.loopback-pref-snapshot` stores a small restoration journal: a schema version, whether `media.peerconnection.ice.loopback` originally had a user value, and its original Boolean value. It contains no credentials, addresses, or call data. Ordinary stop/disable restores the baseline and clears the journal. Browser shutdown retains the journal for recovery by a later extension instance; if a temporary add-on is not loaded again, the journal can remain in the profile. Preference-file saves are asynchronous and are not a guarantee against power loss.

## Network data

- The configured STUN discovery endpoints receive small mapping probes and can observe the public IP address and UDP port from which each probe arrives.
- When a protected Discord voice connection starts, encrypted WebRTC traffic travels from an extension-owned UDP socket to Discord's selected media endpoint. It does not pass through Cloudflare, Twilio, a project-operated service, or an external TURN relay.
- Discord and ordinary network operators can observe the transport metadata they would normally see, including endpoint addresses, timing, and traffic volume.

The defaults are `stun.cloudflare.com:3478` and `global.stun.twilio.com:3478`. They are discovery services only. Users may replace them with compatible STUN services, but mapping must agree across two distinct destinations before the route becomes ready.

## Diagnostics

User-visible status contains bounded counters, state names, candidate type/protocol, an opaque boot identifier, and monotonic generation/revision values. It does not retain URLs, SDP, candidate strings, IP addresses, allocation identifiers, Discord IDs, tokens, credentials, messages, or media.

The internal live route-verification exchange transiently compares the selected relay endpoint and an opaque allocation identifier with the current backend allocation. Those values are not stored, logged, or displayed.

## Your controls

Turn the extension off and reconnect Discord voice to stop applying it to new calls. Removing or disabling the add-on closes its sockets and restores the prior loopback preference. Because version 0.2.4 is loaded as a temporary add-on, Zen removes it when the browser fully exits.
