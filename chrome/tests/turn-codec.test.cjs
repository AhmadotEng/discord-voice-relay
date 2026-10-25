"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const codec = require("../lib/turn-codec.js");

const bytes = (value) => new TextEncoder().encode(value);
const hex = (value) => Buffer.from(value).toString("hex");

test("codec loads into an explicit ExperimentAPI subscript target without Encoding globals", () => {
  const source = fs.readFileSync(path.join(__dirname, "../lib/turn-codec.js"), "utf8");
  const target = vm.createContext({ TextEncoder: undefined, TextDecoder: undefined });
  vm.runInContext(source, target);
  assert.equal(typeof target.TurnCodec, "object");
  assert.equal(
    hex(target.TurnCodec.longTermKey("マトリックス", "example.org", "TheMatrIX")),
    "e8ca7ad59d5eb0518e312911d2dab2a9"
  );
});

test("STUN method/class bit packing round-trips every TURN method", () => {
  for (const method of Object.values(codec.METHOD)) {
    for (const messageClass of Object.values(codec.CLASS)) {
      const type = codec.encodeType(method, messageClass);
      assert.deepEqual(codec.decodeType(type), { method, class: messageClass });
      assert.equal(type & 0xc000, 0);
    }
  }
});

test("MD5, SHA-1, and HMAC-SHA1 match Node crypto", () => {
  for (const input of ["", "abc", "discord-direct", "user:realm:password"]) {
    assert.equal(hex(codec.md5(bytes(input))), crypto.createHash("md5").update(input).digest("hex"));
    assert.equal(hex(codec.sha1(bytes(input))), crypto.createHash("sha1").update(input).digest("hex"));
  }
  assert.equal(
    hex(codec.hmacSha1(bytes("key"), bytes("payload"))),
    crypto.createHmac("sha1", "key").update("payload").digest("hex")
  );
});

test("long-term MESSAGE-INTEGRITY encoding and verification use RFC 5389 framing", () => {
  const transactionId = Uint8Array.from({ length: 12 }, (_unused, index) => index + 1);
  const key = codec.longTermKey("alice", "example.org", "secret");
  assert.equal(
    hex(key),
    crypto.createHash("md5").update("alice:example.org:secret").digest("hex")
  );

  const encoded = codec.encodeMessage({
    method: codec.METHOD.ALLOCATE,
    class: codec.CLASS.REQUEST,
    transactionId,
    attributes: [
      codec.attribute(codec.ATTR.REQUESTED_TRANSPORT, Uint8Array.of(17, 0, 0, 0)),
      codec.textAttribute(codec.ATTR.USERNAME, "alice"),
      codec.textAttribute(codec.ATTR.REALM, "example.org"),
      codec.textAttribute(codec.ATTR.NONCE, "nonce"),
    ],
    key,
  });
  const decoded = codec.decodeMessage(encoded);
  assert.equal(codec.verifyMessageIntegrity(decoded, key), true);

  const integrity = codec.getAttribute(decoded, codec.ATTR.MESSAGE_INTEGRITY);
  const hmacInput = Buffer.from(encoded.slice(0, integrity.offset));
  const adjustedLength = integrity.offset + 24 - codec.HEADER_LENGTH;
  hmacInput[2] = adjustedLength >>> 8;
  hmacInput[3] = adjustedLength & 0xff;
  const expected = crypto.createHmac("sha1", Buffer.from(key)).update(hmacInput).digest("hex");
  assert.equal(hex(integrity.value), expected);

  const tampered = encoded.slice();
  tampered[24] ^= 1;
  assert.equal(codec.verifyMessageIntegrity(codec.decodeMessage(tampered), key), false);
});

test("RFC 5769 section 2.4 long-term authentication vector verifies", () => {
  const vector = Buffer.from(`
    000100602112a44278ad3433c6ad72c029da412e
    00060012e3839ee38388e383aae38383e382afe382b90000
    0015001c662f2f3439396b39353464364f4c33346f4c39465354767936347341
    0014000b6578616d706c652e6f726700
    00080014f67024656dd64a3e02b8e0712e85c9a28ca89666
  `.replace(/\s/gu, ""), "hex");
  const message = codec.decodeMessage(vector);
  const key = codec.longTermKey("マトリックス", "example.org", "TheMatrIX");
  assert.equal(codec.verifyMessageIntegrity(message, key), true);
});

test("TURN XOR address attributes round-trip IPv4 endpoints", () => {
  const transactionId = Uint8Array.from([0xde, 0xad, 0xbe, 0xef, 1, 2, 3, 4, 5, 6, 7, 8]);
  const encoded = codec.encodeAddress("203.0.113.41", 50000, transactionId);
  assert.deepEqual(codec.decodeAddress(encoded, transactionId), {
    address: "203.0.113.41",
    port: 50000,
  });
});

test("peer policy recognizes public IPv4 and rejects local/reserved ranges", () => {
  for (const address of ["1.1.1.1", "8.8.8.8", "162.159.128.233"]) {
    assert.equal(codec.isPublicIPv4(address), true, address);
  }
  for (const address of [
    "127.0.0.1", "10.0.0.1", "100.64.0.1", "169.254.1.1",
    "172.16.0.1", "192.168.1.1", "192.0.2.1", "198.18.0.1",
    "198.51.100.1", "203.0.113.1", "224.0.0.1", "255.255.255.255",
    "not-an-ip",
  ]) {
    assert.equal(codec.isPublicIPv4(address), false, address);
  }
});

test("ChannelData framing preserves the channel and payload", () => {
  const packet = codec.encodeChannelData(0x4001, Uint8Array.of(0, 1, 2, 255));
  assert.deepEqual(codec.decodeChannelData(packet), {
    channel: 0x4001,
    data: Uint8Array.of(0, 1, 2, 255),
  });
  assert.throws(() => codec.decodeChannelData(Uint8Array.of(0x40, 0, 0, 8, 1)));
});

test("Allocate success carries authenticated relay, mapped, and lifetime attributes", () => {
  const transactionId = crypto.randomBytes(12);
  const key = codec.longTermKey("client", "realm", "credential");
  const encoded = codec.encodeMessage({
    method: codec.METHOD.ALLOCATE,
    class: codec.CLASS.SUCCESS,
    transactionId,
    attributes: [
      codec.attribute(codec.ATTR.XOR_RELAYED_ADDRESS,
        codec.encodeAddress("127.0.0.1", 55000, transactionId)),
      codec.attribute(codec.ATTR.XOR_MAPPED_ADDRESS,
        codec.encodeAddress("127.0.0.1", 54000, transactionId)),
      codec.attribute(codec.ATTR.LIFETIME, codec.uint32(600)),
    ],
    key,
  });
  const decoded = codec.decodeMessage(encoded);
  assert.equal(decoded.method, codec.METHOD.ALLOCATE);
  assert.equal(decoded.class, codec.CLASS.SUCCESS);
  assert.equal(codec.verifyMessageIntegrity(decoded, key), true);
  assert.equal(codec.read32(codec.getAttribute(decoded, codec.ATTR.LIFETIME).value, 0), 600);
});
