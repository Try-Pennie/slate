import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isSnowflakeConfigured, readSnowflakeConfig } from "./config";

const SNOWFLAKE_KEYS = [
  "SNOWFLAKE_PRIVATE_KEY",
  "SNOWFLAKE_ACCOUNT",
  "SNOWFLAKE_USER",
  "SNOWFLAKE_DATABASE",
  "SNOWFLAKE_SCHEMA",
  "SNOWFLAKE_WAREHOUSE",
  "SNOWFLAKE_ROLE",
] as const;

let saved: Record<string, string | undefined>;

beforeEach(() => {
  saved = {};
  for (const k of SNOWFLAKE_KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
});

afterEach(() => {
  for (const k of SNOWFLAKE_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe("readSnowflakeConfig", () => {
  it("returns null when the gating secret is unset, so the lane is a no-op", () => {
    expect(readSnowflakeConfig()).toBeNull();
    expect(isSnowflakeConfigured()).toBe(false);
  });

  it("fails loud when the key is set but the account is missing (half-configured)", () => {
    process.env.SNOWFLAKE_PRIVATE_KEY = "-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----";
    expect(() => readSnowflakeConfig()).toThrow(/half-configured/);
    expect(isSnowflakeConfigured()).toBe(true);
  });

  it("fills the provisioned defaults when only the key and account are set", () => {
    process.env.SNOWFLAKE_PRIVATE_KEY = "-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----";
    process.env.SNOWFLAKE_ACCOUNT = "ab12345.us-east-1";
    const cfg = readSnowflakeConfig();
    expect(cfg).toMatchObject({
      account: "ab12345.us-east-1",
      user: "SLATE_SERVICE",
      database: "SLATE",
      schema: "PUBLIC",
      warehouse: "SLATE_WH",
      role: "SLATE_ROLE",
    });
  });

  it("un-escapes a one-line private key with literal backslash-n into real newlines", () => {
    process.env.SNOWFLAKE_ACCOUNT = "ab12345.us-east-1";
    process.env.SNOWFLAKE_PRIVATE_KEY = "-----BEGIN PRIVATE KEY-----\\nabc\\n-----END PRIVATE KEY-----";
    const cfg = readSnowflakeConfig();
    expect(cfg?.privateKeyPem).toBe("-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----");
    expect(cfg?.privateKeyPem).not.toContain("\\n");
  });

  it("leaves a key that already has real newlines unchanged", () => {
    process.env.SNOWFLAKE_ACCOUNT = "ab12345.us-east-1";
    const realNewlines = "-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----";
    process.env.SNOWFLAKE_PRIVATE_KEY = realNewlines;
    expect(readSnowflakeConfig()?.privateKeyPem).toBe(realNewlines);
  });
});
