import { describe, it, expect, vi } from "vitest";

const env = vi.hoisted(() => ({ cronSecret: vi.fn(() => "s3cr3t") }));
vi.mock("@/lib/env", () => env);

import { isAuthorizedCron } from "./cron";
import type { NextRequest } from "next/server";

// isAuthorizedCron only reads the Authorization header and the ?secret= query
// param, so a minimal stand-in for NextRequest is enough here.
function req(opts: { auth?: string; querySecret?: string }): NextRequest {
  return {
    headers: { get: (k: string) => (k === "authorization" ? (opts.auth ?? null) : null) },
    nextUrl: { searchParams: new URLSearchParams(opts.querySecret ? { secret: opts.querySecret } : {}) },
  } as unknown as NextRequest;
}

describe("isAuthorizedCron", () => {
  it("accepts a matching Bearer token", () => {
    expect(isAuthorizedCron(req({ auth: "Bearer s3cr3t" }))).toBe(true);
  });

  it("rejects a wrong Bearer token", () => {
    expect(isAuthorizedCron(req({ auth: "Bearer nope" }))).toBe(false);
  });

  it("rejects the secret passed as a ?secret= query param", () => {
    expect(isAuthorizedCron(req({ querySecret: "s3cr3t" }))).toBe(false);
  });

  it("rejects a request with neither header nor query secret", () => {
    expect(isAuthorizedCron(req({}))).toBe(false);
  });
});
