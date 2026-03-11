import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import {
  encrypt,
  decrypt,
  encryptJson,
  decryptJson,
  generateKey,
} from "../src/services/encrypt.ts";

// ── Test key setup ────────────────────────────────────────────────────────────

const TEST_KEY = generateKey(); // fresh 32-byte key for every test run

beforeEach(() => {
  process.env.ENCRYPTION_KEY = TEST_KEY;
});

afterEach(() => {
  delete process.env.ENCRYPTION_KEY;
});

// ── encrypt / decrypt ─────────────────────────────────────────────────────────

describe("encrypt / decrypt", () => {
  test("round-trips a plaintext string", () => {
    const plaintext = "hello, world";
    expect(decrypt(encrypt(plaintext))).toBe(plaintext);
  });

  test("round-trips an empty string", () => {
    expect(decrypt(encrypt(""))).toBe("");
  });

  test("round-trips a long string", () => {
    const long = "x".repeat(10_000);
    expect(decrypt(encrypt(long))).toBe(long);
  });

  test("round-trips a JSON payload", () => {
    const payload = JSON.stringify({
      access_token: "ya29.abc",
      refresh_token: "1//xyz",
      expiry_date: 1_700_000_000_000,
      client_id: "xxx.apps.googleusercontent.com",
      client_secret: "GOCSPX-secret",
    });
    expect(decrypt(encrypt(payload))).toBe(payload);
  });

  test("returns base64 output", () => {
    const result = encrypt("test");
    expect(() => Buffer.from(result, "base64")).not.toThrow();
  });

  test("each call produces a different ciphertext (random IV)", () => {
    const plaintext = "same plaintext";
    const a = encrypt(plaintext);
    const b = encrypt(plaintext);
    expect(a).not.toBe(b);
  });

  test("both ciphertexts decrypt to the same value", () => {
    const plaintext = "same plaintext";
    const a = encrypt(plaintext);
    const b = encrypt(plaintext);
    expect(decrypt(a)).toBe(plaintext);
    expect(decrypt(b)).toBe(plaintext);
  });

  test("output is at least IV + authTag bytes long", () => {
    const encoded = encrypt("x");
    const buf = Buffer.from(encoded, "base64");
    expect(buf.length).toBeGreaterThan(12 + 16); // IV + authTag + at least some ciphertext
  });
});

// ── tamper detection ──────────────────────────────────────────────────────────

describe("tamper detection", () => {
  test("throws on bit-flipped ciphertext", () => {
    const encoded = encrypt("sensitive data");
    const buf = Buffer.from(encoded, "base64");
    // Flip a bit in the ciphertext (after IV + authTag)
    buf[buf.length - 1] ^= 0xff;
    expect(() => decrypt(buf.toString("base64"))).toThrow();
  });

  test("throws on truncated payload", () => {
    const encoded = encrypt("data");
    const buf = Buffer.from(encoded, "base64");
    expect(() => decrypt(buf.subarray(0, 10).toString("base64"))).toThrow();
  });

  test("throws on empty string input", () => {
    expect(() => decrypt("")).toThrow();
  });

  test("throws on garbage input", () => {
    expect(() => decrypt("not-valid-base64!!!")).toThrow();
  });
});

// ── wrong key ─────────────────────────────────────────────────────────────────

describe("wrong key", () => {
  test("throws when decrypting with a different key", () => {
    const ciphertext = encrypt("secret");
    // Switch to a different key
    process.env.ENCRYPTION_KEY = generateKey();
    expect(() => decrypt(ciphertext)).toThrow();
  });

  test("throws when ENCRYPTION_KEY is not set", () => {
    delete process.env.ENCRYPTION_KEY;
    expect(() => encrypt("test")).toThrow("ENCRYPTION_KEY is not set");
  });

  test("throws when ENCRYPTION_KEY is wrong length", () => {
    process.env.ENCRYPTION_KEY = Buffer.from("tooshort").toString("base64");
    expect(() => encrypt("test")).toThrow("32 bytes");
  });
});

// ── encryptJson / decryptJson ─────────────────────────────────────────────────

describe("encryptJson / decryptJson", () => {
  test("round-trips a plain object", () => {
    const obj = { token: "secret_abc", databases: { tasks: { id: "db1" } } };
    expect(decryptJson(encryptJson(obj))).toEqual(obj);
  });

  test("round-trips an array", () => {
    const arr = [1, "two", { three: true }];
    expect(decryptJson(encryptJson(arr))).toEqual(arr);
  });

  test("round-trips null", () => {
    expect(decryptJson(encryptJson(null))).toBeNull();
  });

  test("decryptJson throws on non-JSON payload", () => {
    // Encrypt a non-JSON string, then try to decryptJson it
    const encoded = encrypt("not json {{{");
    expect(() => decryptJson(encoded)).toThrow();
  });
});

// ── generateKey ───────────────────────────────────────────────────────────────

describe("generateKey", () => {
  test("returns a 32-byte base64 string", () => {
    const key = generateKey();
    const buf = Buffer.from(key, "base64");
    expect(buf.length).toBe(32);
  });

  test("each call returns a different key", () => {
    expect(generateKey()).not.toBe(generateKey());
  });
});
