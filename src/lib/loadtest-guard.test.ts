// The load test refusal WIRED, not just written (L3).
//
// `scripts/test-loadtest-guard.ts` drives the pure judge with injected arguments.
// That cannot say whether anything calls it, and the whole value of this guard is
// its placement: `publicSupabaseUrl()` is the one function every Supabase client
// in the app takes its address from, so a refusal there reaches every request and
// every cron tick. A guard written and not reached is the commonest way one of
// these ships inert.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { publicSupabaseUrl } from "@/lib/env";
import { PRODUCTION_SUPABASE_REF } from "@/lib/loadtest-guard";

const PROD_URL = `https://${PRODUCTION_SUPABASE_REF}.supabase.co`;
const BRANCH_URL = "https://abcdefghijklmnopqrst.supabase.co";

describe("publicSupabaseUrl under SLATE_LOADTEST", () => {
  const saved = {
    loadtest: process.env.SLATE_LOADTEST,
    url: process.env.NEXT_PUBLIC_SUPABASE_URL,
  };

  beforeEach(() => {
    delete process.env.SLATE_LOADTEST;
    process.env.NEXT_PUBLIC_SUPABASE_URL = BRANCH_URL;
  });

  afterEach(() => {
    if (saved.loadtest === undefined) delete process.env.SLATE_LOADTEST;
    else process.env.SLATE_LOADTEST = saved.loadtest;
    if (saved.url === undefined) delete process.env.NEXT_PUBLIC_SUPABASE_URL;
    else process.env.NEXT_PUBLIC_SUPABASE_URL = saved.url;
  });

  // The quiet direction FIRST, because it is production: every real request calls
  // this, and a guard that refused here would be an outage rather than a safeguard.
  it("returns production's own address when the flag is off", () => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = PROD_URL;
    expect(publicSupabaseUrl()).toBe(PROD_URL);
  });

  it("returns a branch address under the flag", () => {
    process.env.SLATE_LOADTEST = "true";
    expect(publicSupabaseUrl()).toBe(BRANCH_URL);
  });

  it("throws on production under the flag, naming the project ref", () => {
    process.env.SLATE_LOADTEST = "true";
    process.env.NEXT_PUBLIC_SUPABASE_URL = PROD_URL;
    expect(() => publicSupabaseUrl()).toThrow(PRODUCTION_SUPABASE_REF);
  });

  it("throws on an address it cannot read under the flag, without claiming it saw production", () => {
    process.env.SLATE_LOADTEST = "true";
    delete process.env.NEXT_PUBLIC_SUPABASE_URL;
    // Two different messages, because the two send different people to different
    // places (L11). The absent case must not quote a ref it never read.
    expect(() => publicSupabaseUrl()).toThrow(/cannot be established/);
    expect(() => publicSupabaseUrl()).not.toThrow(new RegExp(PRODUCTION_SUPABASE_REF));
  });

  it("still refuses an absent address with the flag off, by its ordinary name", () => {
    // The pre-existing behaviour is unchanged: the load test guard added a reason,
    // it did not take over the required-variable check.
    delete process.env.NEXT_PUBLIC_SUPABASE_URL;
    expect(() => publicSupabaseUrl()).toThrow(/NEXT_PUBLIC_SUPABASE_URL/);
  });
});
