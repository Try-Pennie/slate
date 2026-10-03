/**
 * First, prove the server under test is the one this run built, pointed where
 * this run pointed it. Everything after this file is only meaningful if it is.
 */
import { test, expect, stack } from "../fixtures.ts";
import { PRODUCTION_SUPABASE_REF } from "@/lib/loadtest-guard";
import { E2E_APP_ORIGIN } from "../env.ts";

test("the server talks to the local Supabase and nothing else", async ({ request }) => {
  // The staff pages publish the Supabase origin in their script policy, because
  // the sign in page's browser client has to reach it. That is the address the
  // BUILD inlined, read from the running server rather than from our own config.
  const res = await request.get("/login");
  expect(res.status()).toBe(200);
  const csp = res.headers()["content-security-policy"] ?? "";
  const connect = csp.split(";").find((d) => d.trim().startsWith("connect-src")) ?? "";
  expect(connect, "the policy names the local API").toContain(new URL(stack.apiUrl).origin);
  expect(connect).not.toContain("supabase.co");
  expect(csp).not.toContain(PRODUCTION_SUPABASE_REF);
});

test("the dev preview sign in is inert in a production build", async ({ page, context }) => {
  // /dev/preview lets a developer act as anybody without signing in. A production
  // build must not honour it, and the staff pages must still demand a session.
  await context.addCookies([
    { name: "slate_dev_user", value: "ada.admin@slate-e2e.test", url: E2E_APP_ORIGIN },
  ]);
  const preview = await page.goto("/dev/preview?email=ada.admin%40slate-e2e.test");
  expect(preview?.status(), "the preview route does not serve in production").toBeGreaterThanOrEqual(400);
  await page.goto("/admin");
  await expect(page).toHaveURL(/\/login/);
});
