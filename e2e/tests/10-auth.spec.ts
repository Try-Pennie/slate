/**
 * Sign in and impersonation, clicked through (#3100). Until this suite they had
 * jsdom tests only, which mock the session and so never exercise the callback's
 * code exchange, the cookie it sets, or what the next request does with it.
 */
import { test, expect, signIn, seed, db, latestAudit } from "../fixtures.ts";
import { E2E_APP_ORIGIN, E2E_EMAIL_DOMAIN } from "../env.ts";

test("the sign in button sends the browser to Google through Supabase, asking for the Pennie domain", async ({
  page,
}) => {
  await page.goto("/login");
  // The provider is disabled on the local stack and Google is another machine, so
  // the navigation is caught at the local auth server and read rather than followed.
  const authorize = page.waitForRequest((r) => r.url().includes("/auth/v1/authorize"));
  await page.getByRole("button", { name: /continue with google/i }).click();
  const url = new URL((await authorize).url());
  expect(url.searchParams.get("provider")).toBe("google");
  expect(url.searchParams.get("redirect_to")).toBe(`${E2E_APP_ORIGIN}/api/auth/callback`);
  expect(url.searchParams.get("hd")).toBe(E2E_EMAIL_DOMAIN);
  expect(url.searchParams.get("code_challenge"), "the flow is PKCE").toBeTruthy();
});

test("the partner sign in button sends the browser to Microsoft through Supabase, asking for the address alone (#4379)", async ({
  page,
}) => {
  await page.goto("/partner/sign-in");
  // One way in, and it is not Google (docs/design/partner-sign-in.html, D1).
  await expect(page.getByRole("button")).toHaveCount(1);
  const authorize = page.waitForRequest((r) => r.url().includes("/auth/v1/authorize"));
  await page.getByRole("button", { name: /continue with microsoft/i }).click();
  const url = new URL((await authorize).url());
  expect(url.searchParams.get("provider")).toBe("azure");
  expect(url.searchParams.get("scopes")).toBe("email");
  expect(url.searchParams.get("redirect_to")).toBe(`${E2E_APP_ORIGIN}/api/auth/callback`);
  expect(url.searchParams.get("hd"), "the Google domain hint is Google's alone").toBeNull();
  expect(url.searchParams.get("code_challenge"), "the flow is PKCE").toBeTruthy();
  // The mark that brings a hand off with no code back to this page, not to /login.
  const cookies = await page.context().cookies();
  expect(cookies.find((c) => c.name === "slate_sign_in_from")?.value).toBe("partner");
});

test("a hand off that comes back with no code lands on the page it started from (#4379)", async ({ page }) => {
  await page.context().addCookies([{ name: "slate_sign_in_from", value: "partner", url: E2E_APP_ORIGIN }]);
  await page.goto("/api/auth/callback?error=access_denied");
  await expect(page).toHaveURL(/\/partner\/sign-in\?error=missing_code$/);
  // Inside main: Next's route announcer is an alert too.
  await expect(page.getByRole("main").getByRole("alert")).toHaveText("That sign-in didn't complete. Please try again.");
  await page.context().clearCookies();
  await page.goto("/api/auth/callback?error=access_denied");
  await expect(page).toHaveURL(/\/login\?error=missing_code$/);
});

test("a signed out visit goes to the sign in page this browser last signed in on (#4398)", async ({ page }) => {
  // The record a coordinator's Microsoft sign in leaves (written by the callback, which the
  // local stack cannot reach through Microsoft, so it is set here as the callback sets it).
  await page.context().addCookies([{ name: "slate_last_sign_in_page", value: "partner", url: E2E_APP_ORIGIN, httpOnly: true }]);
  await page.goto("/coordinator");
  await expect(page).toHaveURL(/\/partner\/sign-in$/);
  await expect(page.getByRole("button", { name: /continue with microsoft/i })).toBeVisible();
  await page.goto("/");
  await expect(page).toHaveURL(/\/partner\/sign-in$/);

  // Anything but exactly partner, and no record at all, is /login as it always was.
  await page.context().clearCookies();
  await page.context().addCookies([{ name: "slate_last_sign_in_page", value: "elsewhere", url: E2E_APP_ORIGIN }]);
  await page.goto("/coordinator");
  await expect(page).toHaveURL(/\/login$/);
  await page.context().clearCookies();
  await page.goto("/coordinator");
  await expect(page).toHaveURL(/\/login$/);
  await expect(page.getByRole("button", { name: /continue with google/i })).toBeVisible();
});

test("a Google sign in clears the record, so staff are sent to /login when signed out (#4398)", async ({ page }) => {
  await page.context().addCookies([{ name: "slate_last_sign_in_page", value: "partner", url: E2E_APP_ORIGIN, httpOnly: true }]);
  const landed = await signIn(page, seed.users.admin.email);
  expect(landed.pathname).toBe("/admin");
  const cookies = await page.context().cookies();
  expect(cookies.some((c) => c.name === "slate_last_sign_in_page"), "the Google sign in cleared the record").toBe(false);
});

test("an admin signs in through the callback and lands on the console, linked to their row", async ({ page }) => {
  const landed = await signIn(page, seed.users.admin.email);
  expect(landed.pathname).toBe("/admin");
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  const { data, error } = await db.from("users").select("auth_user_id").eq("id", seed.users.admin.id).single();
  expect(error).toBeNull();
  expect(data?.auth_user_id, "the callback linked the auth user to the seeded row by email").toBeTruthy();

  // The session survives a fresh request: a reload is the middleware's refresh path.
  await page.reload();
  await expect(page).toHaveURL(/\/admin$/);
});

test("an agent lands on their own page, not the console", async ({ page }) => {
  const landed = await signIn(page, seed.users.agent.email);
  expect(landed.pathname).toBe("/me/my-availability");
  await page.goto("/admin/business-hours");
  await expect(page).not.toHaveURL(/\/admin\/business-hours/);
});

test("an address outside the Workspace domain is refused and gets no account", async ({ page }) => {
  const outsider = "someone@example.com";
  const landed = await signIn(page, outsider);
  expect(landed.pathname).toBe("/login");
  expect(landed.searchParams.get("error")).toBe("domain_not_allowed");
  await expect(page.getByText("Please sign in with your Pennie Google account.")).toBeVisible();
  const { count, error } = await db.from("users").select("id", { count: "exact", head: true }).eq("email", outsider);
  expect(error).toBeNull();
  expect(count, "no users row was provisioned for the outsider").toBe(0);
  await page.goto("/admin");
  await expect(page).toHaveURL(/\/login/);
});

test("an admin impersonates an agent, sees their page, and stops", async ({ page }) => {
  await signIn(page, seed.users.admin.email);
  await page.goto(`/admin/agents/${seed.users.agent.id}`);
  await page.getByRole("button", { name: `View as ${seed.users.agent.name}` }).click();
  await expect(page).toHaveURL(/\/me\/my-availability/);
  const stop = page.getByRole("button", { name: "Stop viewing as them" });
  await expect(stop).toBeVisible();
  await expect(page.getByText(seed.users.agent.name).first()).toBeVisible();

  const started = await latestAudit("impersonate.start");
  expect(started?.actor_id).toBe(seed.users.admin.id);
  const cookies = await page.context().cookies();
  expect(cookies.some((c) => c.name === "slate_impersonate"), "the impersonation cookie is set").toBe(true);

  await stop.click();
  await expect(page).toHaveURL(/\/admin$/);
  await expect(page.getByRole("button", { name: "Stop viewing as them" })).toHaveCount(0);
  const stopped = await latestAudit("impersonate.stop");
  expect(stopped?.actor_id).toBe(seed.users.admin.id);
  const after = await page.context().cookies();
  expect(after.some((c) => c.name === "slate_impersonate"), "stopping clears the cookie").toBe(false);
});
