# Optional Coturn relay

Use this only on a public Linux server you control. The server needs a public IPv4 address, Docker with Compose, and firewall access for:

- `443/tcp` for TURN over TLS
- `49160-49200/udp` for relayed media

Copy `.env.example` to `.env` and replace every placeholder. Generate a shell-safe credential such as `openssl rand -hex 32`; avoid colons, whitespace, quotes, `$`, backticks, and other shell metacharacters. Protect the file with `chmod 600 .env`.

Provide dedicated copies of a publicly trusted certificate chain and unencrypted private key for the TURN hostname. The official container runs as UID/GID `65534`, so make the certificate readable and the private key owned/readable by that account (for example, certificate mode `0644`, key mode `0600` and owner `65534:65534`). Do not mount a root-only Let's Encrypt `live` path directly. Refresh the copies and recreate the container after renewal.

Validate and start the service:

```sh
docker compose config
docker compose up -d
docker compose logs -f coturn
```

From another machine, verify the public certificate and TCP/443 listener:

```sh
openssl s_client -connect relay.example.com:443 \
  -servername relay.example.com -verify_return_error </dev/null
```

The extension URL will be:

```text
turns:YOUR_TURN_HOST:443?transport=tcp
```

Do not expose an open relay. Rotate credentials, keep the relay-port range narrow, apply a cloud firewall, monitor bandwidth, and set provider billing alerts.

The example deliberately accepts only authenticated TURN-over-TLS clients on TCP/443. Coturn still relays UDP from the server to Discord, which is required. TCP/443 must be free on the host; an HTTP reverse proxy, ordinary CDN proxy, or Cloudflare orange-cloud DNS record cannot sit in front of TURN.

For a server with its public address directly on an interface, `TURN_EXTERNAL_IP` can be that address. For a VM behind 1:1 NAT/EIP, add `--listening-ip=PRIVATE_IP`, `--relay-ip=PRIVATE_IP`, and use `--external-ip=PUBLIC_IP/PRIVATE_IP`; forward TCP/443 and UDP 49160–49200 without port translation. CGNAT without inbound forwarding cannot host this relay. Allow outbound UDP to public Discord media endpoints and stateful replies. Do not publish an AAAA record unless IPv6 listening, relay routing, and firewall rules are configured too.

The included quotas allow up to four allocations for the one static user and 16 total allocations. Increase them only if needed, and add provider-level bandwidth limits. The private/loopback peer denials reduce the damage if the credential is leaked.
