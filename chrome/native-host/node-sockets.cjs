"use strict";

const dgram = require("node:dgram");

function createEvent() {
  const listeners = new Set();
  return Object.freeze({
    addListener(listener) { listeners.add(listener); },
    removeListener(listener) { listeners.delete(listener); },
    dispatch(value) {
      for (const listener of listeners) {
        try { listener(value); } catch (_ignored) { /* isolate socket observers */ }
      }
    },
  });
}

function createNodeSocketApi() {
  const sockets = new Map();
  const onReceive = createEvent();
  const onReceiveError = createEvent();
  let nextSocketId = 1;

  function requireRecord(socketId) {
    const record = sockets.get(socketId);
    if (!record || record.closed) throw new Error("invalid-socket");
    return record;
  }

  function socketInfo(record) {
    let localAddress = null;
    let localPort = null;
    try {
      const address = record.socket.address();
      localAddress = address.address;
      localPort = address.port;
    } catch (_error) {
      // The socket has not bound or is already closed.
    }
    return {
      socketId: record.socketId,
      persistent: true,
      name: record.name,
      bufferSize: record.bufferSize,
      paused: false,
      localAddress,
      localPort,
    };
  }

  function closeRecord(record) {
    if (!record || record.closed) return Promise.resolve();
    record.closed = true;
    sockets.delete(record.socketId);
    if (!record.bound) {
      try { record.socket.close(); } catch (_error) { /* not bound */ }
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      try { record.socket.close(resolve); }
      catch (_error) { resolve(); }
    });
  }

  const udp = {
    async create(properties = {}) {
      const socket = dgram.createSocket("udp4");
      const record = {
        socketId: nextSocketId++,
        name: String(properties.name || ""),
        bufferSize: Number.isInteger(properties.bufferSize) ? properties.bufferSize : 4096,
        socket,
        bound: false,
        closed: false,
      };
      socket.on("message", (data, remote) => {
        if (record.closed) return;
        const bytes = Uint8Array.from(data);
        onReceive.dispatch({
          socketId: record.socketId,
          data: bytes.buffer,
          remoteAddress: remote.address,
          remotePort: remote.port,
        });
      });
      socket.on("error", (error) => {
        if (!record.closed) onReceiveError.dispatch({
          socketId: record.socketId,
          resultCode: -1,
          errorMessage: String(error && error.message || "udp-socket-error").slice(0, 256),
        });
      });
      sockets.set(record.socketId, record);
      return { socketId: record.socketId };
    },

    bind(socketId, address, port, callback) {
      let record;
      try { record = requireRecord(socketId); }
      catch (_error) { callback(-1); return; }
      const finish = (code) => {
        record.socket.off("listening", onListening);
        record.socket.off("error", onError);
        callback(code);
      };
      const onListening = () => {
        record.bound = true;
        finish(0);
      };
      const onError = () => finish(-1);
      record.socket.once("listening", onListening);
      record.socket.once("error", onError);
      try { record.socket.bind(port, address); }
      catch (_error) { finish(-1); }
    },

    send(socketId, data, address, port, _dnsQueryType, callback) {
      let record;
      try { record = requireRecord(socketId); }
      catch (_error) { callback({ resultCode: -1, bytesSent: 0 }); return; }
      const bytes = Buffer.from(data instanceof ArrayBuffer ? new Uint8Array(data) : data);
      record.socket.send(bytes, port, address, (error, bytesSent) => {
        callback({ resultCode: error ? -1 : 0, bytesSent: error ? 0 : bytesSent });
      });
    },

    async close(socketId) { await closeRecord(sockets.get(socketId)); },
    async getInfo(socketId) { return socketInfo(requireRecord(socketId)); },
    async getSockets() { return Array.from(sockets.values(), socketInfo); },
    onReceive,
    onReceiveError,
  };

  return Object.freeze({
    udp,
    async closeAll() { await Promise.all(Array.from(sockets.values(), closeRecord)); },
    get size() { return sockets.size; },
  });
}

module.exports = { createNodeSocketApi };
