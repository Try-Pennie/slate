import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  escapeSqlLiteral,
  executeStatement,
  isTransientSnowflakeError,
  pollStatement,
  postStatementWithRetry,
  resolveStatementResult,
  snowflakeHost,
  type SnowflakeConfig,
} from "./client";

// A fake fetch Response with just the surface the client touches.
function fakeRes(status: number, body: string) {
  return { ok: status >= 200 && status < 300, status, text: async () => body };
}

const noSleep = async () => {};

function decodeJwtPart(part: string): Record<string, unknown> {
  const b64 = part.replace(/-/g, "+").replace(/_/g, "/");
  const padded = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
  return JSON.parse(atob(padded));
}

// A real 2048-bit RSA key, generated once, exported to PKCS#8 PEM so the client's
// PEM parser + JWT signer run for real (not mocked).
async function makePemConfig(): Promise<SnowflakeConfig> {
  const kp = await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"],
  );
  const der = new Uint8Array((await crypto.subtle.exportKey("pkcs8", kp.privateKey)) as ArrayBuffer);
  let b64 = "";
  for (let i = 0; i < der.length; i++) b64 += String.fromCharCode(der[i]);
  b64 = btoa(b64);
  const lines = b64.match(/.{1,64}/g)!.join("\n");
  const pem = `-----BEGIN PRIVATE KEY-----\n${lines}\n-----END PRIVATE KEY-----\n`;
  return {
    account: "ab12345.us-east-1",
    user: "SLATE_SERVICE",
    privateKeyPem: pem,
    database: "SLATE",
    schema: "PUBLIC",
    warehouse: "SLATE_WH",
    role: "SLATE_ROLE",
  };
}

afterEach(() => vi.unstubAllGlobals());

describe("escapeSqlLiteral", () => {
  it("doubles single quotes so a value cannot close the literal early", () => {
    expect(escapeSqlLiteral("O'Brien")).toBe("O''Brien");
  });

  it("doubles backslashes before quotes so a trailing backslash cannot escape the closing quote", () => {
    // A lone trailing backslash would otherwise escape Snowflake's closing quote.
    expect(escapeSqlLiteral("ends with\\")).toBe("ends with\\\\");
    expect(escapeSqlLiteral("a\\'b")).toBe("a\\\\''b");
  });

  it("leaves an ordinary string untouched", () => {
    expect(escapeSqlLiteral("plain text 123")).toBe("plain text 123");
  });
});

describe("snowflakeHost", () => {
  it("appends the Snowflake domain and lowercases", () => {
    expect(snowflakeHost("AB12345.us-east-1")).toBe("ab12345.us-east-1.snowflakecomputing.com");
  });
});

describe("isTransientSnowflakeError", () => {
  it("treats 429/502/503/504 as transient and 500 as fatal", () => {
    expect([429, 502, 503, 504].every(isTransientSnowflakeError)).toBe(true);
    expect(isTransientSnowflakeError(500)).toBe(false);
    expect(isTransientSnowflakeError(200)).toBe(false);
  });
});

describe("executeStatement JWT", () => {
  it("signs a KEYPAIR_JWT with the Snowflake iss/sub shape and 1h expiry", async () => {
    const config = await makePemConfig();
    const calls: Array<{ url: string; init: { headers: Record<string, string> } }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: { headers: Record<string, string> }) => {
        calls.push({ url, init });
        return fakeRes(200, JSON.stringify({ message: "ok" }));
      }),
    );

    await executeStatement(config, "SELECT 1");

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toContain("/api/v2/statements?requestId=");
    const headers = calls[0].init.headers;
    expect(headers["X-Snowflake-Authorization-Token-Type"]).toBe("KEYPAIR_JWT");

    const token = headers.Authorization.replace(/^Bearer /, "");
    const [h, p] = token.split(".");
    expect(token.split(".")).toHaveLength(3);
    expect(decodeJwtPart(h)).toMatchObject({ alg: "RS256", typ: "JWT" });
    const payload = decodeJwtPart(p) as { iss: string; sub: string; iat: number; exp: number };
    // Locator uppercased, region dropped; user uppercased.
    expect(payload.sub).toBe("AB12345.SLATE_SERVICE");
    expect(payload.iss).toMatch(/^AB12345\.SLATE_SERVICE\.SHA256:.+/);
    expect(payload.exp - payload.iat).toBe(3600);
  });
});

// #1200: the key the OPERATOR is told to make, not one we fabricated.
//
// `makePemConfig` above generates its key with WebCrypto, so every JWT test
// here answers about a key this file created. Nothing proved that the key
// produced by the openssl invocation in docs/snowflake-setup.md is one the
// client can read: an invented fixture standing in for the real artifact, which
// is how a runbook command stays broken while its tests stay green (L48, L52).
//
// The commands are READ OUT OF THE RUNBOOK rather than copied here, so this
// cannot pass against a stale duplicate of a command the doc no longer gives
// (L41). Editing the doc's openssl line re-points this test at the new line.
describe("the Snowflake setup runbook's key-pair commands (docs/snowflake-setup.md)", () => {
  /** Every bash line in the runbook that invokes openssl, in document order. */
  function runbookOpensslCommands(): string[] {
    const doc = readFileSync(
      join(import.meta.dirname, "..", "..", "..", "docs", "snowflake-setup.md"),
      "utf8",
    );
    return [...doc.matchAll(/```bash\n([\s\S]*?)```/g)]
      .flatMap((m) => m[1].split("\n"))
      .map((l) => l.trim())
      .filter((l) => l.startsWith("openssl "));
  }

  it("produce a key the client can sign a Snowflake JWT with", async () => {
    const commands = runbookOpensslCommands();
    // Sanity check on the parse: a regex that stopped matching would leave this
    // test running zero commands and passing vacuously.
    expect(commands).toHaveLength(2);
    expect(commands[0]).toContain("genpkey");
    expect(commands[1]).toContain("-pubout");

    const dir = mkdtempSync(join(tmpdir(), "slate-snowflake-key-"));
    try {
      for (const command of commands) {
        // Step 1 cd's into the scratch directory first, so the later commands
        // use bare filenames; run them all with that directory as the cwd.
        execFileSync("/bin/sh", ["-c", command], { cwd: dir, stdio: "pipe" });
      }

      const pem = readFileSync(join(dir, "slate_snowflake_key.p8"), "utf8");
      // Unencrypted PKCS#8 is the one format the client's PEM parser and
      // Snowflake both accept. An encrypted key ("BEGIN ENCRYPTED PRIVATE KEY")
      // would import nowhere, and openssl emits one if the command ever grows a
      // cipher flag.
      expect(pem).toContain("-----BEGIN PRIVATE KEY-----");
      expect(pem).not.toContain("ENCRYPTED");

      const config: SnowflakeConfig = {
        account: "vrkfjso-rwc54963",
        user: "SLATE_SERVICE",
        privateKeyPem: pem,
        database: "SLATE",
        schema: "PUBLIC",
        warehouse: "SLATE_WH",
        role: "SLATE_ROLE",
      };

      const calls: Array<{ init: { headers: Record<string, string> } }> = [];
      vi.stubGlobal(
        "fetch",
        vi.fn(async (_url: string, init: { headers: Record<string, string> }) => {
          calls.push({ init });
          return fakeRes(200, JSON.stringify({ message: "ok" }));
        }),
      );

      await executeStatement(config, "SELECT 1");

      const token = calls[0].init.headers.Authorization.replace(/^Bearer /, "");
      const payload = decodeJwtPart(token.split(".")[1]) as { iss: string };

      // The halves of the runbook have to agree, and nothing checked that they
      // did. Step 3 registers a public key body on the Snowflake user; the
      // client derives a fingerprint from the private key and puts it in `iss`.
      // Snowflake authenticates by comparing them, so if they disagree the login
      // fails at runtime with credentials that look perfectly well-formed. This
      // recomputes the fingerprint the way Snowflake does (SHA-256 over the DER
      // of the registered public key) and requires the match.
      const registeredBody = readFileSync(join(dir, "slate_snowflake_key.pub"), "utf8")
        .split("\n")
        .filter((l) => !l.includes("PUBLIC KEY"))
        .join("");
      const der = Uint8Array.from(atob(registeredBody), (c) => c.charCodeAt(0));
      const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", der));
      const expected = btoa(String.fromCharCode(...digest));

      expect(payload.iss).toBe(`VRKFJSO-RWC54963.SLATE_SERVICE.SHA256:${expected}`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("postStatementWithRetry", () => {
  it("retries a no-response failure with the SAME requestId and retry=true", async () => {
    const targets: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockImplementationOnce((url: string) => {
          targets.push(url);
          throw new Error("connection reset before headers");
        })
        .mockImplementationOnce(async (url: string) => {
          targets.push(url);
          return fakeRes(200, "{}");
        }),
    );

    const res = await postStatementWithRetry("https://x/api/v2/statements", {}, "body", "req-abc", { sleep: noSleep });

    expect(res.status).toBe(200);
    expect(targets[0]).toContain("requestId=req-abc");
    expect(targets[0]).not.toContain("retry=true");
    expect(targets[1]).toContain("requestId=req-abc");
    expect(targets[1]).toContain("retry=true");
  });

  it("retries a transient 503 then succeeds", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockImplementationOnce(async () => fakeRes(503, "upstream reset"))
        .mockImplementationOnce(async () => fakeRes(200, "{}")),
    );
    const res = await postStatementWithRetry("https://x/s", {}, "b", "r", { sleep: noSleep });
    expect(res.status).toBe(200);
  });

  it("does NOT retry a 500 (could be a real server-side statement failure)", async () => {
    const fetchMock = vi.fn(async () => fakeRes(500, "boom"));
    vi.stubGlobal("fetch", fetchMock);
    await expect(postStatementWithRetry("https://x/s", {}, "b", "r", { sleep: noSleep })).rejects.toThrow(
      /Snowflake 500/,
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("gives up after maxAttempts of sustained transient failures", async () => {
    const fetchMock = vi.fn(async () => fakeRes(503, "still down"));
    vi.stubGlobal("fetch", fetchMock);
    await expect(postStatementWithRetry("https://x/s", {}, "b", "r", { sleep: noSleep })).rejects.toThrow(
      /Snowflake 503/,
    );
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});

describe("resolveStatementResult 202 handling", () => {
  const config = {
    account: "ab12345.us-east-1",
    user: "u",
    privateKeyPem: "",
    database: "d",
    schema: "s",
    warehouse: "w",
    role: "r",
  };

  it("never treats 202 as success: polls the handle to a terminal 200", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockImplementationOnce(async () => fakeRes(202, "{}")) // still running
        .mockImplementationOnce(async () => fakeRes(200, JSON.stringify({ message: "done" }))), // terminal
    );

    const out = await resolveStatementResult(config, {}, 202, JSON.stringify({ statementHandle: "H1" }), {
      sleep: noSleep,
      intervalMs: 0,
    });
    expect(out.message).toBe("done");
  });

  it("throws on a 202 with no statementHandle rather than silently proceeding", async () => {
    await expect(resolveStatementResult(config, {}, 202, "{}", { sleep: noSleep })).rejects.toThrow(
      /202 without a statementHandle/,
    );
  });

  it("returns a 200 body directly without polling", async () => {
    const out = await resolveStatementResult(config, {}, 200, JSON.stringify({ message: "immediate" }));
    expect(out.message).toBe("immediate");
  });
});

describe("pollStatement", () => {
  const config = {
    account: "ab12345.us-east-1",
    user: "u",
    privateKeyPem: "",
    database: "d",
    schema: "s",
    warehouse: "w",
    role: "r",
  };

  it("throws when a poll returns a non-2xx status", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => fakeRes(500, "poll failed")));
    await expect(pollStatement(config, {}, "H1", { sleep: noSleep, intervalMs: 0 })).rejects.toThrow(
      /Snowflake poll 500/,
    );
  });

  it("throws when the statement never completes within maxAttempts", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => fakeRes(202, "{}")));
    await expect(
      pollStatement(config, {}, "H1", { sleep: noSleep, intervalMs: 0, maxAttempts: 3 }),
    ).rejects.toThrow(/did not complete after 3 polls/);
  });
});
