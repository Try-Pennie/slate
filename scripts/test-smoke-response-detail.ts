// A failed canary check prints the response's code (#3663).
// Run: node --experimental-strip-types --import ./scripts/register-paths.mjs scripts/test-smoke-response-detail.ts
//
// At 03:37 UTC on 2026-10-13 the canary's dry run failed with `got 503/undefined`:
// a timeout, the kill switch and an unconfigured key all answer 503, and only the
// body's `code` tells them apart.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { MAX_ERROR_CHARS, responseDetail } from "./lib/smoke-response-detail.ts";
import { scanSmokeCheckDetail } from "./lib/scan-smoke-check-detail.ts";
import { createAsserter } from "./lib/booking-fakes.ts";

const { assert, finish } = createAsserter();

// --- the words -------------------------------------------------------------------
{
  const timeout = responseDetail({ status: 503, body: { code: "VERIFY_UNAVAILABLE", error: "Booking failed" } });
  assert(timeout === 'HTTP 503, code VERIFY_UNAVAILABLE, error "Booking failed"', `the 03:37 response, as printed (got ${timeout})`);
  assert(
    responseDetail({ status: 503, body: {} }) === "HTTP 503, no code in the body",
    "a body with no code says so rather than printing undefined",
  );
  assert(responseDetail({ status: 502, body: undefined }) === "HTTP 502, no code in the body", "an unparsed body is no code too");
  const long = responseDetail({ status: 500, body: { code: "INTERNAL", error: "x".repeat(MAX_ERROR_CHARS + 1) } });
  assert(
    long === `HTTP 500, code INTERNAL, an error of ${MAX_ERROR_CHARS + 1} characters, not shown`,
    `a long error is named, never pasted (got ${long})`,
  );
  assert(
    responseDetail({ status: 400, body: { code: "VALIDATION", error: "bad\n  start" } }) === 'HTTP 400, code VALIDATION, error "bad start"',
    "an error is said on one line",
  );
  assert(
    !/undefined|\[object/.test(responseDetail({ status: 503, body: { code: 7, error: { a: 1 } } })),
    "a non string code or error is never printed raw",
  );
}

// --- the guard: every check that judges a response hands it over -------------------
{
  const bad = "check(res.status === 200, `x (got ${res.status})`);\ncheck(a.body.outcome === b.body.outcome, 'y', b);";
  const findings = scanSmokeCheckDetail(bad);
  assert(
    findings.length === 1 && findings[0]!.line === 1,
    `a check reading a response without handing it over is found (got ${JSON.stringify(findings)})`,
  );
  assert(scanSmokeCheckDetail("check(res.status === 200, 'x', other);").length === 1, "handing over a response the condition does not read is found");
  assert(scanSmokeCheckDetail("check(level === 'ok', message);").length === 0, "a check that reads no response is left alone");
  assert(scanSmokeCheckDetail("const s = 'check(res.status === 1, x)';").length === 0, "a shape inside a string is not a check");

  const real = readFileSync(fileURLToPath(new URL("./smoke-booking-api.ts", import.meta.url)), "utf8");
  const realFindings = scanSmokeCheckDetail(real, "smoke-booking-api.ts");
  assert(
    realFindings.length === 0,
    `every canary check that judges a response prints it on failure (missing: ${realFindings.map((f) => `${f.line}: ${f.text}`).join(" | ")})`,
  );
  // The scan must have had checks to read, or a clean result means nothing (L98).
  const checks = (real.match(/\bcheck\(/g) ?? []).length;
  assert(checks > 20, `the scan read the canary's checks (found ${checks})`);
  // Positive control on the real file: take the response away from one check.
  const stripped = real.replace(/,\s*res\s*\);/, ");");
  assert(stripped !== real && scanSmokeCheckDetail(stripped).length === 1, "removing one check's response from the real file is caught");
}

finish();
