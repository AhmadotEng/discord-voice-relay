(function exposeMappingPolicy(root, factory) {
  "use strict";
  const api = factory();
  if (typeof module === "object" && module && module.exports) {
    module.exports = api;
  } else {
    Object.defineProperty(root, "MappingPolicy", {
      configurable: true,
      value: api,
    });
  }
})(this, function buildMappingPolicy() {
  "use strict";

  function parseStunUri(value) {
    const source = String(value || "").trim();
    const match = /^stun:([^/?#:\s]+)(?::(\d{1,5}))?$/iu.exec(source);
    if (!match) throw new Error("Mapping probes must use stun:hostname[:port]");
    const host = match[1].toLowerCase().replace(/\.$/u, "");
    const port = match[2] ? Number(match[2]) : 3478;
    if (port < 1 || port > 65535) throw new Error("Invalid STUN probe port");
    const ipv4 = /^\d{1,3}(?:\.\d{1,3}){3}$/u.test(host);
    if (ipv4) {
      if (host.split(".").some((part) => Number(part) > 255)) {
        throw new Error("Invalid STUN probe IPv4 address");
      }
    } else if (
      host.length > 253 ||
      !host.split(".").every((label) =>
        /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/iu.test(label)
      )
    ) {
      throw new Error("Invalid STUN probe hostname");
    }
    return { uri: source, host, port, isIpv4Literal: ipv4 };
  }

  function endpointKey(address, port) {
    return `${address}:${port}`;
  }

  function evaluateMappings(observations, isPublicIPv4) {
    if (!Array.isArray(observations) || observations.length < 2) {
      return { ok: false, reason: "not-enough-responses" };
    }
    if (typeof isPublicIPv4 !== "function") {
      throw new TypeError("isPublicIPv4 policy is required");
    }
    const responderAddresses = new Set();
    for (const observation of observations) {
      if (!isPublicIPv4(observation.serverAddress) ||
          !isPublicIPv4(observation.mappedAddress) ||
          !Number.isInteger(observation.serverPort) || observation.serverPort < 1 || observation.serverPort > 65535 ||
          !Number.isInteger(observation.mappedPort) || observation.mappedPort < 1 || observation.mappedPort > 65535) {
        return { ok: false, reason: "invalid-public-endpoint" };
      }
      responderAddresses.add(observation.serverAddress);
    }
    // Two ports on one server IP do not detect address-dependent NAT.  The
    // preflight therefore requires two distinct destination addresses, not
    // merely two different UDP endpoint tuples.
    if (responderAddresses.size < 2) {
      return { ok: false, reason: "not-independent" };
    }
    const first = observations[0];
    if (observations.some((item) =>
      item.mappedAddress !== first.mappedAddress || item.mappedPort !== first.mappedPort
    )) {
      return { ok: false, reason: "endpoint-dependent-mapping" };
    }
    return {
      ok: true,
      mapping: { address: first.mappedAddress, port: first.mappedPort },
    };
  }

  return Object.freeze({ parseStunUri, evaluateMappings });
});
