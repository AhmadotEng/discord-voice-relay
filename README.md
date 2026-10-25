# Discord Voice Relay browser extensions

This repository contains two independent browser extensions. Each has its own manifest, setup guide, privacy information, and source tree.

| Directory | Browser | Routing approach |
| --- | --- | --- |
| [`chrome/`](chrome/README.md) | Chrome and Chromium, Manifest V3 | Uses an on-demand local TURN helper and direct UDP transport for Discord Web voice and screen share; no external media relay. |
| [`zen/`](zen/README.md) | Zen Browser / Firefox 152+ | Uses a privileged loopback TURN bridge and direct UDP transport; no external media relay. |

These are separate implementations with different browser requirements and network behavior. Follow the README in the directory for the browser you use.

## Chrome / Chromium

Load this repository's `chrome/` directory from `chrome://extensions` with **Developer mode** enabled. The Chrome build also needs its Native Messaging helper registered once; the helper runs only while routing is enabled and a Discord tab is open. See the [Chrome setup guide](chrome/README.md) for installation, network behavior, and security details.

## Zen

See the [Zen setup and project guide](zen/README.md). The Zen build has its own test and XPI build commands.

## Development

From the repository root, Node.js 20 or newer can run the project scripts:

```sh
npm test
npm run test:zen
npm run test:chrome
npm run test:chrome:live-hook
npm run build:zen
```

Each extension is self-contained. Keep browser-specific changes and release assets within its directory. The Chrome helper source and installer live under `chrome/native-host/`.

## License and security

Both projects are MIT licensed; each directory includes its own license file. Report vulnerabilities privately using the repository's GitHub Security tab. See [SECURITY.md](SECURITY.md) for supported components and guidance.
