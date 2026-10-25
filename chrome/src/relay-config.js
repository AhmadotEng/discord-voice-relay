(function installRelayConfigTools(root) {
  "use strict";

  const DEFAULT_SETTINGS = Object.freeze({
    enabled: false,
    turnUrls: "",
    turnUsername: "",
    turnCredential: "",
    tcpOnly: true
  });

  function splitUrls(value) {
    const source = Array.isArray(value) ? value : String(value || "").split(/[\s,]+/u);
    return [...new Set(source.map((item) => String(item).trim()).filter(Boolean))];
  }

  function parseTurnUrl(value) {
    const url = String(value || "").trim();
    const match = /^(turns):([^/?#\s]+)(?:\?([^#\s]*))?$/iu.exec(url);
    if (!match) {
      return { valid: false, url, reason: "Only encrypted turns: URLs are accepted." };
    }

    const scheme = match[1].toLowerCase();
    const authority = match[2];
    let parsedAuthority;
    try {
      parsedAuthority = new URL(`http://${authority}`);
    } catch (_error) {
      return { valid: false, url, reason: "The TURN host or port is invalid." };
    }

    const hostname = parsedAuthority.hostname;
    const isIpv6 = hostname.startsWith("[") && hostname.endsWith("]");
    const validHostname = isIpv6 || (
      hostname.length <= 253 &&
      !hostname.includes("_") &&
      hostname.split(".").every((label) =>
        /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/iu.test(label)
      )
    );
    const port = parsedAuthority.port ? Number(parsedAuthority.port) : null;
    if (parsedAuthority.username || parsedAuthority.password || parsedAuthority.pathname !== "/" ||
        !hostname || !validHostname || port === 0 || (port !== null && port > 65535)) {
      return { valid: false, url, reason: "The TURN host or port is invalid." };
    }

    const query = new URLSearchParams(match[3] || "");
    const transport = (query.get("transport") || "").toLowerCase();
    const queryKeys = [...query.keys()];

    if (transport && transport !== "tcp") {
      return { valid: false, url, reason: `Unsupported TURN transport: ${transport}` };
    }
    if (queryKeys.some((key) => key !== "transport") || query.getAll("transport").length > 1) {
      return { valid: false, url, reason: "Only one transport query parameter is supported." };
    }

    return {
      valid: true,
      url,
      scheme,
      transport,
      tcpCapable: true
    };
  }

  function validateSettings(input) {
    const settings = { ...DEFAULT_SETTINGS, ...(input || {}) };
    const parsed = splitUrls(settings.turnUrls).map(parseTurnUrl);
    const rejected = parsed.filter((entry) => !entry.valid);
    const accepted = parsed
      .filter((entry) => entry.valid)
      .filter((entry) => !settings.tcpOnly || entry.tcpCapable);

    const errors = [];
    if (settings.enabled && parsed.length === 0) {
      errors.push("Add at least one TURN URL.");
    }
    if (settings.enabled && rejected.length > 0) {
      errors.push(...rejected.map((entry) => `${entry.url || "Empty URL"}: ${entry.reason}`));
    }
    if (settings.enabled && settings.tcpOnly && accepted.length === 0) {
      errors.push("Relay mode needs an encrypted turns: URL over TLS/TCP.");
    }
    if (settings.enabled && !String(settings.turnUsername || "").trim()) {
      errors.push("Add the TURN username.");
    }
    if (settings.enabled && !String(settings.turnCredential || "")) {
      errors.push("Add the TURN credential.");
    }

    return {
      settings: {
        enabled: Boolean(settings.enabled),
        turnUrls: splitUrls(settings.turnUrls).join("\n"),
        turnUsername: String(settings.turnUsername || "").trim(),
        turnCredential: String(settings.turnCredential || ""),
        tcpOnly: Boolean(settings.tcpOnly)
      },
      urls: accepted.map((entry) => entry.url),
      errors
    };
  }

  function isDiscordNetworkConfiguration(configuration) {
    if (!configuration || typeof configuration !== "object") {
      return false;
    }

    return configuration.sdpSemantics === "plan-b" ||
      configuration.sdpSemantics === "unified-plan" ||
      configuration.bundlePolicy === "max-bundle";
  }

  function buildRelayConfiguration(configuration, inputSettings) {
    const validation = validateSettings(inputSettings);
    const original = configuration && typeof configuration === "object" ? configuration : {};

    if (!validation.settings.enabled || validation.errors.length > 0 || validation.urls.length === 0) {
      return {
        applied: false,
        configuration,
        errors: validation.errors,
        relayCount: 0
      };
    }

    const relayServer = { urls: validation.urls };
    if (validation.settings.turnUsername) {
      relayServer.username = validation.settings.turnUsername;
    }
    if (validation.settings.turnCredential) {
      relayServer.credential = validation.settings.turnCredential;
    }

    return {
      applied: true,
      configuration: {
        ...original,
        iceServers: [relayServer],
        iceTransportPolicy: "relay"
      },
      errors: [],
      relayCount: validation.urls.length
    };
  }

  function candidateSummary(candidate) {
    const text = typeof candidate === "string" ? candidate : candidate && candidate.candidate;
    if (!text) {
      return null;
    }

    const typeMatch = /\btyp\s+(host|srflx|prflx|relay)\b/iu.exec(text);
    const protocolMatch = /^candidate:\S+\s+\d+\s+(udp|tcp)\s/iu.exec(text);
    const tcpTypeMatch = /\btcptype\s+(active|passive|so)\b/iu.exec(text);

    return {
      type: typeMatch ? typeMatch[1].toLowerCase() : "unknown",
      protocol: protocolMatch ? protocolMatch[1].toLowerCase() : "unknown",
      tcpType: tcpTypeMatch ? tcpTypeMatch[1].toLowerCase() : null
    };
  }

  const api = Object.freeze({
    DEFAULT_SETTINGS,
    splitUrls,
    parseTurnUrl,
    validateSettings,
    isDiscordNetworkConfiguration,
    buildRelayConfiguration,
    candidateSummary
  });

  if (root) {
    Object.defineProperty(root, "__discordVoiceRelayTools", {
      value: api,
      configurable: true
    });
  }

  if (typeof module === "object" && module && module.exports) {
    module.exports = api;
  }
})(typeof globalThis === "object" ? globalThis : this);
