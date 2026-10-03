/**
 * Rendered page accessibility, in both themes (#3079).
 *
 * The static guards (contrast tokens, focus ring, skip link, select, destructive
 * confirm) read source files, so they cannot see what only exists once a page is
 * composed: a control with no name, an id used twice, a contrast pair produced by
 * two components that are each fine alone. axe reads the rendered DOM, and any
 * finding it rates serious or critical fails the run.
 *
 * The staff pages are enumerated from the console's own navigation
 * (`adminNavHrefs`, `ME_TABS`) rather than listed here, so a page added to the
 * navigation is scanned by construction (L619).
 */
import type { Page } from "@playwright/test";
import {
  test,
  expect,
  seed,
  signIn,
  setStaffTheme,
  expectAccessible,
  expectTheme,
  seriousFindings,
  describeFindings,
} from "../fixtures.ts";
import { adminNavHrefs } from "@/lib/admin/nav";
import { ME_TABS } from "@/lib/me/nav";
import { E2E_APP_ORIGIN } from "../env.ts";

const THEMES = ["light", "dark"] as const;
type Theme = (typeof THEMES)[number];

async function scan(page: Page, path: string, theme: Theme, label = path): Promise<void> {
  await page.goto(path);
  await page.waitForLoadState("load");
  await expectTheme(page, theme);
  await expectAccessible(page, `${label} (${theme})`);
}

// --- the positive controls: the judge must be seen to fail (L1) ---------------------

test("control: a page with an unnamed button and an image with no alt fails the judge", async ({ page }) => {
  await page.setContent(
    `<!doctype html><html lang="en"><head><title>control</title></head><body><main>
       <h1>Control</h1><button></button>
       <img src="data:image/gif;base64,R0lGODlhAQABAAAAACw=">
     </main></body></html>`,
  );
  const findings = await seriousFindings(page);
  const ids = findings.map((f) => f.id);
  expect(ids).toContain("button-name");
  expect(ids).toContain("image-alt");
  let failed = false;
  try {
    await expectAccessible(page, "control");
  } catch (err) {
    failed = String(err).includes("button-name");
  }
  expect(failed, "expectAccessible fails, naming the finding, on a page with serious findings").toBe(true);
});

test("control: a violation planted in the real booker is caught, so the scan reads the app's DOM", async ({
  page,
}) => {
  await page.goto(`/book?xbc=${seed.bucketCode}`);
  await page.waitForLoadState("load");
  const before = await seriousFindings(page);
  // A visible control the lead uses: the first day button.
  await expect(page.getByRole("group", { name: "Available days" }).getByRole("button").first()).toBeVisible();
  await page.evaluate(() => {
    const button = document.querySelector('[role="group"][aria-label="Available days"] button, fieldset button');
    if (!button) throw new Error("the booker rendered no day button to plant on");
    button.textContent = "";
    button.removeAttribute("aria-label");
    button.removeAttribute("aria-labelledby");
    button.removeAttribute("title");
  });
  const after = await seriousFindings(page);
  expect(
    after.filter((f) => f.id === "button-name").length,
    describeFindings("after planting", after),
  ).toBeGreaterThan(before.filter((f) => f.id === "button-name").length);
});

// --- the lead's pages ---------------------------------------------------------------

for (const theme of THEMES) {
  test(`the booker, day and time step (${theme})`, async ({ page }) => {
    await scan(page, `/book?xbc=${seed.bucketCode}${theme === "dark" ? "&theme=dark" : ""}`, theme, "/book");
    // And once a day is open, which is the state most of the page's controls live in.
    await page.getByRole("group", { name: "Available days" }).getByRole("button").first().click();
    await expect(page.getByRole("button", { name: /^\d{1,2}:\d{2}\s?(am|pm)/i }).first()).toBeVisible();
    await expectAccessible(page, `/book with a day open (${theme})`);
  });

  test(`the booker, details step (${theme})`, async ({ page }) => {
    await page.goto(`/book?xbc=${seed.bucketCode}${theme === "dark" ? "&theme=dark" : ""}`);
    await page.getByRole("group", { name: "Available days" }).getByRole("button").first().click();
    await page.getByRole("button", { name: /^\d{1,2}:\d{2}\s?(am|pm)/i }).first().click();
    await expect(page.getByRole("textbox", { name: /email/i })).toBeVisible();
    await expectTheme(page, theme);
    await expectAccessible(page, `/book details (${theme})`);
  });

  test(`the sign in page (${theme})`, async ({ page, context }) => {
    await context.addCookies([{ name: "slate-theme", value: theme, url: E2E_APP_ORIGIN }]);
    await scan(page, "/login", theme);
  });
}

// --- the staff pages ----------------------------------------------------------------

const ADMIN_PAGES = [
  ...adminNavHrefs(),
  "/admin/ooo",
  `/admin/agents/${seed.users.agent.id}`,
  `/admin/agents/${seed.users.manager.id}`,
];

for (const theme of THEMES) {
  test(`every console page (${theme})`, async ({ page }) => {
    // About two dozen pages in one test, each rendered and scanned: the default
    // minute is for one page, not a sweep.
    test.setTimeout(240_000);
    await setStaffTheme(seed.users.admin.id, theme);
    await signIn(page, seed.users.admin.email);
    const failures: string[] = [];
    for (const path of ADMIN_PAGES) {
      await page.goto(path);
      await page.waitForLoadState("load");
      await expectTheme(page, theme);
      expect(new URL(page.url()).pathname, `${path} did not redirect the admin away`).toBe(path);
      const findings = await seriousFindings(page);
      if (findings.length) failures.push(describeFindings(`${path} (${theme})`, findings));
    }
    // Every page is scanned before failing, so one run names every finding.
    expect(failures, failures.join("\n\n")).toEqual([]);
  });

  test(`an agent's own pages (${theme})`, async ({ page }) => {
    await setStaffTheme(seed.users.agent.id, theme);
    await signIn(page, seed.users.agent.email);
    const failures: string[] = [];
    for (const { href } of ME_TABS) {
      await page.goto(href);
      await page.waitForLoadState("load");
      await expectTheme(page, theme);
      const findings = await seriousFindings(page);
      if (findings.length) failures.push(describeFindings(`${href} (${theme})`, findings));
    }
    expect(failures, failures.join("\n\n")).toEqual([]);
  });
}
