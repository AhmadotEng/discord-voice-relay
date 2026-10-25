# Security policy

## Supported components

- **Zen:** current source build is Discord Direct for Zen 0.2.4.2, for Zen/Firefox 152 or newer. See [Zen security details](zen/SECURITY.md).
- **Chrome:** current source build is Discord Direct for Chrome 0.3.0, including its on-demand Windows Native Messaging helper. See the [Chrome privacy and security notes](chrome/PRIVACY.md) and its [setup guide](chrome/README.md).

Both extensions are experimental and modify Discord Web's WebRTC behavior. Use only reviewed source and understand the component-specific network route before enabling it.

## Reporting a vulnerability

Use this repository's **Security** tab to submit a private vulnerability report. Do not open a public issue before a fix or coordinated disclosure plan is available. Include the affected directory and version, browser version, operating system, minimal reproduction steps, observed impact, and relevant redacted diagnostics. Do not include Discord tokens, IP addresses, candidate strings, SDP, call audio, or unrelated personal data.
