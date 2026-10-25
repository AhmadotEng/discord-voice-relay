# Privacy disclosure

Discord Direct for Chrome has no developer-operated service, analytics,
advertising, or telemetry. It does not read Discord tokens, chat messages,
guilds, contacts, or decoded call audio.

## What runs locally

- The extension injects its WebRTC hook only on `https://discord.com/channels/*`
  and uses Chrome storage for the enabled toggle and STUN discovery host list.
- When enabled with a Discord tab open, Chrome launches a Native Messaging
  helper as a child process. The helper runs the local TURN server and opens
  UDP sockets. It is not installed as a Windows service, startup program,
  scheduled task, or Run-key application.
- The TURN listener is bound to `127.0.0.1` on an ephemeral port and uses
  fresh credentials for each start. The helper stops when the extension turns
  routing off, the last Discord tab closes or leaves `discord.com`, or Chrome
  closes the Native Messaging connection.
- The helper sends small STUN mapping probes to the two configured discovery
  hosts. Those hosts see the computer's public IP address and probe timing.
  They do not relay Discord voice or screen-share media.
- Discord sees the helper's outbound UDP socket as the peer. The helper
  forwards encrypted WebRTC datagrams but does not decrypt DTLS/SRTP media.

## Data in extension and helper memory

The helper receives only validated STUN hostnames from the extension. For each
active TURN allocation it temporarily holds the local client endpoint, a
peer endpoint, ephemeral TURN credentials, and packet-routing state in memory.
Those values are needed to forward packets and are discarded when the helper
stops. The implementation does not write SDP, candidate addresses, Discord
IDs, messages, tokens, or media to disk or diagnostic logs.

The page hook reports bounded status data such as connection state, candidate
type/protocol, and aggregate packet counters. Candidate IP addresses are not
included in page status. The live TURN credential is passed to Discord's
WebRTC configuration while the route is enabled; scripts in the Discord page
can inspect their own WebRTC configuration. The credential is generated for
the loopback listener and is valid only for that helper run.

## Your controls

Click the toolbar icon to turn routing off. This closes the extension's
Native Messaging port and stops the helper. An already-connected peer
connection may keep its old TURN configuration until the call is reconnected;
the helper itself stops immediately. Remove the extension and run
`native-host/Uninstall-NativeHost.ps1` with its extension ID to unregister the
host. The installer does not create any Windows startup entry.

The badge and page status are convenience diagnostics, not a security
boundary. Discord's main JavaScript world owns the WebRTC context. For an
independent transport check, inspect `chrome://webrtc-internals` and verify
that the selected local candidate is `relay`.
