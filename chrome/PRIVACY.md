# Privacy disclosure

Discord Voice Relay for Chrome has no developer-operated service, analytics, advertising, or telemetry. It does not read Discord tokens, text messages, guilds, contacts, or decoded call audio.

When you explicitly enable the relay, the extension supplies the TURN URL, username, and credential you entered to `discord.com`'s WebRTC context. Chrome then transmits that authentication information to your chosen TURN server and routes encrypted Discord call traffic through that server. A Chrome Web Store listing should disclose this handling of authentication information and personal communications in its Privacy practices form.

## Where data goes

- The TURN credential is kept only in Chrome's in-memory extension session storage and clears when Chrome exits. The URL, username, toggle state, and disclosure acknowledgment remain in local extension storage until you change them or remove the extension.
- While enabled, page scripts on `https://discord.com` can technically inspect the TURN client credential through the page's WebRTC configuration. Use a short-lived client credential or a dedicated, tightly limited Coturn account—never a provider API token or shared credential-minting secret.
- The chosen TURN operator can observe network metadata such as your IP address, Discord's media endpoint, timing, and traffic volume. Discord/WebRTC media remains encrypted in transit, but use a relay operator you trust.
- When the toggle is off, the bridge does not send the stored username or credential into the page. An already-open relayed peer connection can retain its earlier WebRTC configuration until you disconnect or reload Discord.

## Your controls

Disable the toggle and reconnect Discord voice to stop using the relay. Clear the saved fields to remove the credential from extension storage, or remove the extension in `chrome://extensions` to delete its local storage.

The popup's status is a convenience diagnostic, not a security boundary: code running on the Discord page shares the main-world WebRTC context. For an independent check, inspect the selected candidate in `chrome://webrtc-internals` and look for candidate type `relay` with a TLS/TCP client-to-relay connection.
