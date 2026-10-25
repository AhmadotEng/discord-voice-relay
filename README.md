# Discord Voice Relay browser extensions

This repository contains two independent browser extensions. Each has its own manifest, setup guide, privacy information, and source tree.

| Directory | Browser | Routing approach |
| --- | --- | --- |
| [`chrome/`](chrome/README.md) | Chrome and Chromium, Manifest V3 | Routes Discord Web voice through a user-provided encrypted TURN relay over TLS/TCP. |
| [`zen/`](zen/README.md) | Zen Browser / Firefox 152+ | Uses a privileged loopback TURN bridge and direct UDP transport; no external media relay. |

These are separate implementations with different browser requirements and network behavior. Follow the README in the directory for the browser you use.

## Chrome / Chromium

Open `chrome://extensions`, enable **Developer mode**, choose **Load unpacked**, and select this repository's `chrome/` directory. See the [Chrome setup guide](chrome/README.md) for TURN configuration and security details.

## Zen

See the [Zen setup and project guide](zen/README.md). The Zen build has its own test and XPI build commands.

## Development

From the repository root, Node.js 20 or newer can run the project scripts:

```sh
npm test
npm run test:zen
npm run test:chrome
npm run build:zen
```

Each extension is self-contained. Keep browser-specific changes and release assets within its directory.

## License and security

Both projects are MIT licensed; each directory includes its own license file. Report vulnerabilities privately using the repository's GitHub Security tab. See [SECURITY.md](SECURITY.md) for supported components and guidance.
