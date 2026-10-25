# Managed TURN setup

A managed TURN service is the quickest way to obtain a relay without maintaining a public server. The extension accepts ordinary WebRTC `RTCIceServer` client credentials from a provider that offers encrypted TURNS over TLS/TCP.

## Cloudflare Realtime TURN example

Cloudflare currently offers TURN over TLS on TCP port 443 and returns short-lived WebRTC credentials. Follow Cloudflare's official guides:

- [TURN service and ports](https://developers.cloudflare.com/realtime/turn/)
- [Generate short-lived credentials](https://developers.cloudflare.com/realtime/turn/generate-credentials/)

Create a TURN key in Cloudflare, then generate a short-lived credential using Cloudflare's API. For a one-person local setup, this command can be run in your terminal; for a shared extension deployment, keep it on a server:

```sh
curl --request POST \
  "https://rtc.live.cloudflare.com/v1/turn/keys/$TURN_KEY_ID/credentials/generate-ice-servers" \
  --header "Authorization: Bearer $TURN_KEY_API_TOKEN" \
  --header "Content-Type: application/json" \
  --data '{"ttl": 86400}'
```

Use a TTL up to `172800` seconds (48 hours). From the returned `iceServers` JSON, enter only:

- URL: `turns:turn.cloudflare.com:443?transport=tcp`
- Username: the generated long username
- Credential: the generated short-lived credential

Never put the Cloudflare API token or long-term TURN-key token into this extension. The extension should receive only the generated, expiring client username and credential. Keep Cloudflare's official hostname in the URL; custom TURN hostnames do not support TLS there.

Cloudflare credentials currently expire after at most 48 hours. Before expiry, generate and paste a fresh pair, save, then leave and rejoin Discord voice. The extension does not automatically mint credentials or restart an already-open call.

The extension intentionally does not call a provider's credential API directly. That prevents a provider API token capable of minting unlimited relay credentials from being stored inside the browser add-on.
