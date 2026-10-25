"use strict";

// MV3 worker entry point. Native Messaging gives the extension an on-demand
// local UDP helper while keeping UDP sockets out of the extension process.
importScripts(
  "relay-config.js",
  "native-client.js",
  "background.js",
);
