// Tests for the Slack request signature verification (#77).
// Run: node --experimental-strip-types scripts/test-slack-verify.ts
import { createHmac } from "node:crypto";
import { verifySlackSignature } from "../src/lib/slack/verify.ts";
import { assert, finish } from "./lib/harness.ts";

const secret = "shhh-signing-secret";
const body = "payload=%7B%22type%22%3A%22block_actions%22%7D";
const nowMs = 1_750_000_000_000;
const ts = String(Math.floor(nowMs / 1000));
const sign = (t: string, b: string) =>
  "v0=" + createHmac("sha256", secret).update(`v0:${t}:${b}`).digest("hex");

assert(
  verifySlackSignature({
    signingSecret: secret,
    timestamp: ts,
    signature: sign(ts, body),
    rawBody: body,
    nowMs,
  }),
  "valid signature passes",
);

assert(
  !verifySlackSignature({
    signingSecret: secret,
    timestamp: ts,
    signature: "v0=deadbeef",
    rawBody: body,
    nowMs,
  }),
  "wrong signature fails",
);

assert(
  !verifySlackSignature({
    signingSecret: secret,
    timestamp: ts,
    signature: sign(ts, body),
    rawBody: body + "tampered",
    nowMs,
  }),
  "tampered body fails (signature no longer matches)",
);

assert(
  !verifySlackSignature({
    signingSecret: secret,
    timestamp: ts,
    signature: sign(ts, body),
    rawBody: body,
    // 10 minutes later — outside the 5-minute replay window.
    nowMs: nowMs + 10 * 60 * 1000,
  }),
  "stale timestamp fails",
);

assert(
  !verifySlackSignature({
    signingSecret: "",
    timestamp: ts,
    signature: sign(ts, body),
    rawBody: body,
    nowMs,
  }),
  "missing signing secret fails",
);

assert(
  !verifySlackSignature({
    signingSecret: secret,
    timestamp: null,
    signature: null,
    rawBody: body,
    nowMs,
  }),
  "missing headers fail",
);

finish();
