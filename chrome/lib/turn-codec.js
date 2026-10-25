(function exposeTurnCodec(root, factory) {
  "use strict";

  const api = factory();
  if (typeof module === "object" && module && module.exports) {
    module.exports = api;
  } else {
    Object.defineProperty(root, "TurnCodec", {
      configurable: true,
      value: api,
    });
  }
})(this, function buildTurnCodec() {
  "use strict";

  const MAGIC_COOKIE = 0x2112a442;
  const HEADER_LENGTH = 20;

  const CLASS = Object.freeze({ REQUEST: 0, INDICATION: 1, SUCCESS: 2, ERROR: 3 });
  const METHOD = Object.freeze({
    BINDING: 0x001,
    ALLOCATE: 0x003,
    REFRESH: 0x004,
    SEND: 0x006,
    DATA: 0x007,
    CREATE_PERMISSION: 0x008,
    CHANNEL_BIND: 0x009,
  });
  const ATTR = Object.freeze({
    USERNAME: 0x0006,
    MESSAGE_INTEGRITY: 0x0008,
    ERROR_CODE: 0x0009,
    CHANNEL_NUMBER: 0x000c,
    LIFETIME: 0x000d,
    XOR_PEER_ADDRESS: 0x0012,
    DATA: 0x0013,
    REALM: 0x0014,
    NONCE: 0x0015,
    XOR_RELAYED_ADDRESS: 0x0016,
    REQUESTED_TRANSPORT: 0x0019,
    XOR_MAPPED_ADDRESS: 0x0020,
    SOFTWARE: 0x8022,
    FINGERPRINT: 0x8028,
  });

  // ExperimentAPI globals in Gecko 147 do not expose the Encoding API. Keep
  // this tiny codec self-contained so loading it never depends on DOM globals.
  const encoder = {
    encode(value) {
      const bytes = [];
      for (const symbol of String(value)) {
        const point = symbol.codePointAt(0);
        if (point <= 0x7f) {
          bytes.push(point);
        } else if (point <= 0x7ff) {
          bytes.push(0xc0 | (point >>> 6), 0x80 | (point & 0x3f));
        } else if (point <= 0xffff) {
          bytes.push(
            0xe0 | (point >>> 12),
            0x80 | ((point >>> 6) & 0x3f),
            0x80 | (point & 0x3f)
          );
        } else {
          bytes.push(
            0xf0 | (point >>> 18),
            0x80 | ((point >>> 12) & 0x3f),
            0x80 | ((point >>> 6) & 0x3f),
            0x80 | (point & 0x3f)
          );
        }
      }
      return Uint8Array.from(bytes);
    },
  };

  const decoder = {
    decode(value) {
      const bytes = asBytes(value);
      let output = "";
      for (let index = 0; index < bytes.length;) {
        const first = bytes[index++];
        let point;
        let remaining;
        if (first <= 0x7f) {
          point = first;
          remaining = 0;
        } else if (first >= 0xc2 && first <= 0xdf) {
          point = first & 0x1f;
          remaining = 1;
        } else if (first >= 0xe0 && first <= 0xef) {
          point = first & 0x0f;
          remaining = 2;
        } else if (first >= 0xf0 && first <= 0xf4) {
          point = first & 0x07;
          remaining = 3;
        } else {
          output += "\ufffd";
          continue;
        }
        if (index + remaining > bytes.length) {
          output += "\ufffd";
          break;
        }
        let valid = true;
        for (let offset = 0; offset < remaining; offset += 1) {
          const next = bytes[index + offset];
          if ((next & 0xc0) !== 0x80) {
            valid = false;
            break;
          }
          point = (point << 6) | (next & 0x3f);
        }
        if (!valid ||
            (remaining === 1 && point < 0x80) ||
            (remaining === 2 && point < 0x800) ||
            (remaining === 3 && point < 0x10000) ||
            point > 0x10ffff ||
            (point >= 0xd800 && point <= 0xdfff)) {
          output += "\ufffd";
          continue;
        }
        index += remaining;
        output += String.fromCodePoint(point);
      }
      return output;
    },
  };

  function asBytes(value) {
    if (value instanceof Uint8Array) return value;
    if (value instanceof ArrayBuffer) return new Uint8Array(value);
    if (ArrayBuffer.isView(value)) {
      return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    }
    if (Array.isArray(value)) return Uint8Array.from(value);
    throw new TypeError("Expected byte data");
  }

  function concat(parts) {
    const arrays = parts.map(asBytes);
    const total = arrays.reduce((sum, part) => sum + part.length, 0);
    const result = new Uint8Array(total);
    let offset = 0;
    for (const part of arrays) {
      result.set(part, offset);
      offset += part.length;
    }
    return result;
  }

  function uint16(value) {
    return Uint8Array.of((value >>> 8) & 0xff, value & 0xff);
  }

  function uint32(value) {
    return Uint8Array.of(
      (value >>> 24) & 0xff,
      (value >>> 16) & 0xff,
      (value >>> 8) & 0xff,
      value & 0xff
    );
  }

  function read16(bytes, offset) {
    return (bytes[offset] << 8) | bytes[offset + 1];
  }

  function read32(bytes, offset) {
    return (
      bytes[offset] * 0x1000000 +
      (bytes[offset + 1] << 16) +
      (bytes[offset + 2] << 8) +
      bytes[offset + 3]
    ) >>> 0;
  }

  function encodeType(method, messageClass) {
    return (
      (method & 0x000f) |
      ((method & 0x0070) << 1) |
      ((method & 0x0f80) << 2) |
      ((messageClass & 0x01) << 4) |
      ((messageClass & 0x02) << 7)
    );
  }

  function decodeType(type) {
    return {
      method: (type & 0x000f) | ((type & 0x00e0) >>> 1) | ((type & 0x3e00) >>> 2),
      class: ((type >>> 4) & 0x01) | ((type >>> 7) & 0x02),
    };
  }

  function attribute(type, value) {
    return { type, value: asBytes(value) };
  }

  function textAttribute(type, value) {
    return attribute(type, encoder.encode(String(value)));
  }

  function encodeAttribute(entry) {
    const value = asBytes(entry.value);
    const padding = (4 - (value.length % 4)) % 4;
    return concat([
      uint16(entry.type),
      uint16(value.length),
      value,
      new Uint8Array(padding),
    ]);
  }

  function encodeAttributes(attributes) {
    return concat(attributes.map(encodeAttribute));
  }

  function makeHeader(type, bodyLength, transactionId) {
    const transaction = asBytes(transactionId);
    if (transaction.length !== 12) throw new Error("STUN transaction ID must be 12 bytes");
    return concat([uint16(type), uint16(bodyLength), uint32(MAGIC_COOKIE), transaction]);
  }

  function encodeMessage({ method, class: messageClass, transactionId, attributes = [], key = null }) {
    const type = encodeType(method, messageClass);
    const body = encodeAttributes(attributes);
    if (!key) return concat([makeHeader(type, body.length, transactionId), body]);

    // RFC 5389 section 15.4: the HMAC excludes the MESSAGE-INTEGRITY
    // attribute itself, while the header length is adjusted to include it.
    const header = makeHeader(type, body.length + 24, transactionId);
    const digest = hmacSha1(asBytes(key), concat([header, body]));
    return concat([header, body, encodeAttribute(attribute(ATTR.MESSAGE_INTEGRITY, digest))]);
  }

  function decodeMessage(input) {
    const bytes = asBytes(input);
    if (bytes.length < HEADER_LENGTH || (bytes[0] & 0xc0) !== 0) {
      throw new Error("Not a STUN message");
    }
    const type = read16(bytes, 0);
    const length = read16(bytes, 2);
    if (read32(bytes, 4) !== MAGIC_COOKIE) throw new Error("Invalid STUN magic cookie");
    if (length % 4 !== 0 || HEADER_LENGTH + length > bytes.length) {
      throw new Error("Invalid STUN message length");
    }
    const attributes = [];
    const end = HEADER_LENGTH + length;
    let offset = HEADER_LENGTH;
    while (offset < end) {
      if (offset + 4 > end) throw new Error("Truncated STUN attribute");
      const attrType = read16(bytes, offset);
      const attrLength = read16(bytes, offset + 2);
      const valueOffset = offset + 4;
      const valueEnd = valueOffset + attrLength;
      if (valueEnd > end) throw new Error("Truncated STUN attribute value");
      attributes.push({
        type: attrType,
        value: bytes.slice(valueOffset, valueEnd),
        offset,
      });
      offset = valueEnd + ((4 - (attrLength % 4)) % 4);
    }
    return {
      ...decodeType(type),
      type,
      transactionId: bytes.slice(8, 20),
      attributes,
      bytes: bytes.slice(0, end),
    };
  }

  function getAttribute(message, type) {
    return message.attributes.find((entry) => entry.type === type) || null;
  }

  function getAttributes(message, type) {
    return message.attributes.filter((entry) => entry.type === type);
  }

  function attributeText(message, type) {
    const entry = getAttribute(message, type);
    return entry ? decoder.decode(entry.value) : null;
  }

  function encodeError(code, reason) {
    const value = new Uint8Array(4 + encoder.encode(reason).length);
    value[2] = Math.floor(code / 100);
    value[3] = code % 100;
    value.set(encoder.encode(reason), 4);
    return value;
  }

  function encodeAddress(address, port, transactionId) {
    const transaction = asBytes(transactionId);
    const pieces = String(address).split(".");
    if (pieces.length !== 4 || pieces.some((part) => !/^\d{1,3}$/u.test(part) || Number(part) > 255)) {
      throw new Error("The PoC currently supports IPv4 XOR addresses only");
    }
    const cookie = uint32(MAGIC_COOKIE);
    const result = new Uint8Array(8);
    result[1] = 0x01;
    const xPort = Number(port) ^ (MAGIC_COOKIE >>> 16);
    result[2] = (xPort >>> 8) & 0xff;
    result[3] = xPort & 0xff;
    for (let index = 0; index < 4; index += 1) {
      result[4 + index] = Number(pieces[index]) ^ cookie[index];
    }
    if (transaction.length !== 12) throw new Error("STUN transaction ID must be 12 bytes");
    return result;
  }

  function decodeAddress(value, transactionId) {
    const bytes = asBytes(value);
    const transaction = asBytes(transactionId);
    if (bytes.length < 8 || bytes[1] !== 0x01) {
      throw new Error("The PoC currently supports IPv4 XOR addresses only");
    }
    const cookie = uint32(MAGIC_COOKIE);
    const port = read16(bytes, 2) ^ (MAGIC_COOKIE >>> 16);
    const address = Array.from(bytes.slice(4, 8), (byte, index) => byte ^ cookie[index]).join(".");
    if (transaction.length !== 12) throw new Error("STUN transaction ID must be 12 bytes");
    return { address, port };
  }

  function isPublicIPv4(address) {
    const parts = String(address).split(".");
    if (parts.length !== 4 || parts.some((part) => !/^\d{1,3}$/u.test(part) || Number(part) > 255)) {
      return false;
    }
    const [a, b, c] = parts.map(Number);
    if (a === 0 || a === 10 || a === 127 || a >= 224) return false;
    if (a === 100 && b >= 64 && b <= 127) return false;
    if (a === 169 && b === 254) return false;
    if (a === 172 && b >= 16 && b <= 31) return false;
    if (a === 192 && b === 168) return false;
    if (a === 192 && b === 0 && c === 0) return false;
    if (a === 192 && b === 0 && c === 2) return false;
    if (a === 192 && b === 88 && c === 99) return false;
    if (a === 198 && (b === 18 || b === 19)) return false;
    if (a === 198 && b === 51 && c === 100) return false;
    if (a === 203 && b === 0 && c === 113) return false;
    return true;
  }

  function encodeChannelData(channel, data) {
    if (channel < 0x4000 || channel > 0x7fff) throw new Error("Invalid TURN channel number");
    const payload = asBytes(data);
    return concat([uint16(channel), uint16(payload.length), payload]);
  }

  function decodeChannelData(input) {
    const bytes = asBytes(input);
    if (bytes.length < 4) throw new Error("Truncated TURN ChannelData");
    const channel = read16(bytes, 0);
    const length = read16(bytes, 2);
    if (channel < 0x4000 || channel > 0x7fff || 4 + length > bytes.length) {
      throw new Error("Invalid TURN ChannelData");
    }
    return { channel, data: bytes.slice(4, 4 + length) };
  }

  function rotateLeft(value, count) {
    return ((value << count) | (value >>> (32 - count))) >>> 0;
  }

  function md5(input) {
    const source = asBytes(input);
    const bitLength = source.length * 8;
    const paddedLength = Math.ceil((source.length + 9) / 64) * 64;
    const bytes = new Uint8Array(paddedLength);
    bytes.set(source);
    bytes[source.length] = 0x80;
    const view = new DataView(bytes.buffer);
    view.setUint32(paddedLength - 8, bitLength >>> 0, true);
    view.setUint32(paddedLength - 4, Math.floor(bitLength / 0x100000000), true);

    let a0 = 0x67452301;
    let b0 = 0xefcdab89;
    let c0 = 0x98badcfe;
    let d0 = 0x10325476;
    const shifts = [7, 12, 17, 22, 5, 9, 14, 20, 4, 11, 16, 23, 6, 10, 15, 21];
    const constants = Array.from({ length: 64 }, (_unused, index) =>
      Math.floor(Math.abs(Math.sin(index + 1)) * 0x100000000) >>> 0
    );

    for (let block = 0; block < bytes.length; block += 64) {
      const words = Array.from({ length: 16 }, (_unused, index) => view.getUint32(block + index * 4, true));
      let a = a0;
      let b = b0;
      let c = c0;
      let d = d0;
      for (let index = 0; index < 64; index += 1) {
        let f;
        let g;
        if (index < 16) {
          f = (b & c) | (~b & d);
          g = index;
        } else if (index < 32) {
          f = (d & b) | (~d & c);
          g = (5 * index + 1) % 16;
        } else if (index < 48) {
          f = b ^ c ^ d;
          g = (3 * index + 5) % 16;
        } else {
          f = c ^ (b | ~d);
          g = (7 * index) % 16;
        }
        const nextD = c;
        c = b;
        b = (b + rotateLeft((a + f + constants[index] + words[g]) >>> 0, shifts[Math.floor(index / 16) * 4 + (index % 4)])) >>> 0;
        a = d;
        d = nextD;
      }
      a0 = (a0 + a) >>> 0;
      b0 = (b0 + b) >>> 0;
      c0 = (c0 + c) >>> 0;
      d0 = (d0 + d) >>> 0;
    }

    const output = new Uint8Array(16);
    const outputView = new DataView(output.buffer);
    outputView.setUint32(0, a0, true);
    outputView.setUint32(4, b0, true);
    outputView.setUint32(8, c0, true);
    outputView.setUint32(12, d0, true);
    return output;
  }

  function sha1(input) {
    const source = asBytes(input);
    const bitLength = source.length * 8;
    const paddedLength = Math.ceil((source.length + 9) / 64) * 64;
    const bytes = new Uint8Array(paddedLength);
    bytes.set(source);
    bytes[source.length] = 0x80;
    const view = new DataView(bytes.buffer);
    view.setUint32(paddedLength - 8, Math.floor(bitLength / 0x100000000), false);
    view.setUint32(paddedLength - 4, bitLength >>> 0, false);

    let h0 = 0x67452301;
    let h1 = 0xefcdab89;
    let h2 = 0x98badcfe;
    let h3 = 0x10325476;
    let h4 = 0xc3d2e1f0;
    for (let block = 0; block < bytes.length; block += 64) {
      const words = new Uint32Array(80);
      for (let index = 0; index < 16; index += 1) words[index] = view.getUint32(block + index * 4, false);
      for (let index = 16; index < 80; index += 1) {
        words[index] = rotateLeft(words[index - 3] ^ words[index - 8] ^ words[index - 14] ^ words[index - 16], 1);
      }
      let a = h0;
      let b = h1;
      let c = h2;
      let d = h3;
      let e = h4;
      for (let index = 0; index < 80; index += 1) {
        let f;
        let k;
        if (index < 20) {
          f = (b & c) | (~b & d);
          k = 0x5a827999;
        } else if (index < 40) {
          f = b ^ c ^ d;
          k = 0x6ed9eba1;
        } else if (index < 60) {
          f = (b & c) | (b & d) | (c & d);
          k = 0x8f1bbcdc;
        } else {
          f = b ^ c ^ d;
          k = 0xca62c1d6;
        }
        const temp = (rotateLeft(a, 5) + f + e + k + words[index]) >>> 0;
        e = d;
        d = c;
        c = rotateLeft(b, 30);
        b = a;
        a = temp;
      }
      h0 = (h0 + a) >>> 0;
      h1 = (h1 + b) >>> 0;
      h2 = (h2 + c) >>> 0;
      h3 = (h3 + d) >>> 0;
      h4 = (h4 + e) >>> 0;
    }
    return concat([uint32(h0), uint32(h1), uint32(h2), uint32(h3), uint32(h4)]);
  }

  function hmacSha1(keyInput, messageInput) {
    let key = asBytes(keyInput);
    const message = asBytes(messageInput);
    if (key.length > 64) key = sha1(key);
    const block = new Uint8Array(64);
    block.set(key);
    const inner = new Uint8Array(64);
    const outer = new Uint8Array(64);
    for (let index = 0; index < 64; index += 1) {
      inner[index] = block[index] ^ 0x36;
      outer[index] = block[index] ^ 0x5c;
    }
    return sha1(concat([outer, sha1(concat([inner, message]))]));
  }

  function longTermKey(username, realm, password) {
    return md5(encoder.encode(`${username}:${realm}:${password}`));
  }

  function constantTimeEqual(leftInput, rightInput) {
    const left = asBytes(leftInput);
    const right = asBytes(rightInput);
    if (left.length !== right.length) return false;
    let difference = 0;
    for (let index = 0; index < left.length; index += 1) difference |= left[index] ^ right[index];
    return difference === 0;
  }

  function verifyMessageIntegrity(message, key) {
    const integrity = getAttribute(message, ATTR.MESSAGE_INTEGRITY);
    if (!integrity || integrity.value.length !== 20) return false;
    const prefix = message.bytes.slice(0, integrity.offset);
    const adjusted = prefix.slice();
    const adjustedBodyLength = integrity.offset + 24 - HEADER_LENGTH;
    adjusted[2] = (adjustedBodyLength >>> 8) & 0xff;
    adjusted[3] = adjustedBodyLength & 0xff;
    return constantTimeEqual(hmacSha1(asBytes(key), adjusted), integrity.value);
  }

  return Object.freeze({
    MAGIC_COOKIE,
    HEADER_LENGTH,
    CLASS,
    METHOD,
    ATTR,
    asBytes,
    concat,
    uint16,
    uint32,
    read16,
    read32,
    encodeType,
    decodeType,
    attribute,
    textAttribute,
    encodeMessage,
    decodeMessage,
    getAttribute,
    getAttributes,
    attributeText,
    encodeError,
    encodeAddress,
    decodeAddress,
    isPublicIPv4,
    encodeChannelData,
    decodeChannelData,
    md5,
    sha1,
    hmacSha1,
    longTermKey,
    verifyMessageIntegrity,
  });
});
