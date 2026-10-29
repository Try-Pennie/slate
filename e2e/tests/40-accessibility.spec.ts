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
  dayButtons,
  openDayWithTimes,
  timeButtons,
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
  const firstDay = dayButtons(page).first();
  await expect(firstDay).toBeVisible();
  await firstDay.evaluate((button) => {
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
    // The first day WITH times, not the first chip: late in the day the first chip
    // can hold only times outside the lead's calling hours (`openDayWithTimes`).
    await openDayWithTimes(page);
    await expect(timeButtons(page).first()).toBeVisible();
    await expectAccessible(page, `/book with a day open (${theme})`);
  });

  test(`the booker, details step (${theme})`, async ({ page }) => {
    await page.goto(`/book?xbc=${seed.bucketCode}${theme === "dark" ? "&theme=dark" : ""}`);
    await openDayWithTimes(page);
    await timeButtons(page).first().click();
    await expect(page.getByRole("textbox", { name: /email/i })).toBeVisible();
    await expectTheme(page, theme);
    await expectAccessible(page, `/book details (${theme})`);
  });

  test(`the sign in page (${theme})`, async ({ page, context }) => {
    await context.addCookies([{ name: "slate-theme", value: theme, url: E2E_APP_ORIGIN }]);
    await scan(page, "/login", theme);
  });

  // #4379: the partner page, with a refusal showing, since its link is the one control here
  // that /login does not have.
  test(`the partner sign in page (${theme})`, async ({ page, context }) => {
    await context.addCookies([{ name: "slate-theme", value: theme, url: E2E_APP_ORIGIN }]);
    await scan(page, "/partner/sign-in?error=domain_not_allowed", theme, "/partner/sign-in");
  });
}

// --- the staff pages ----------------------------------------------------------------

const ADMIN_PAGES = [
  ...adminNavHrefs(),
  "/admin/ooo",
  `/admin/agents/${seed.users.agent.id}`,
  `/admin/agents/${seed.users.manager.id}`,
];

/**
 * Scans each page and COLLECTS what is wrong rather than stopping at the first:
 * a page that redirected away, or that rendered the wrong theme, is a failure for
 * that page and the sweep goes on to the rest, so one run names every problem.
 * A redirected page is not scanned, since what loaded is some other page.
 */
async function sweep(page: Page, paths: readonly string[], theme: Theme): Promise<string[]> {
  const failures: string[] = [];
  for (const path of paths) {
    try {
      await page.goto(path);
      await page.waitForLoadState("load");
    } catch (err) {
      // A navigation that is interrupted (a redirect mid load) or fails is this
      // page's failure, recorded, and the sweep goes on to the rest.
      failures.push(`${path} (${theme}): the page did not load: ${err instanceof Error ? err.message.split("\n")[0] : String(err)}`);
      continue;
    }
    const landed = new URL(page.url()).pathname;
    if (landed !== path) {
      failures.push(`${path} (${theme}): redirected to ${landed}, so it was not scanned`);
      continue;
    }
    if ((await page.locator(`[data-theme="${theme}"]`).count()) === 0) {
      failures.push(`${path} (${theme}): did not render in the ${theme} theme, so the ${theme} pass did not scan it`);
      continue;
    }
    const findings = await seriousFindings(page);
    if (findings.length) failures.push(describeFindings(`${path} (${theme})`, findings));
  }
  return failures;
}

for (const theme of THEMES) {
  test(`every console page (${theme})`, async ({ page }) => {
    // About two dozen pages in one test, each rendered and scanned: the default
    // minute is for one page, not a sweep.
    test.setTimeout(240_000);
    await setStaffTheme(seed.users.admin.id, theme);
    await signIn(page, seed.users.admin.email);
    const failures = await sweep(page, ADMIN_PAGES, theme);
    // Every page is scanned before failing, so one run names every finding.
    expect(failures, failures.join("\n\n")).toEqual([]);
  });

  test(`an agent's own pages (${theme})`, async ({ page }) => {
    await setStaffTheme(seed.users.agent.id, theme);
    await signIn(page, seed.users.agent.email);
    const failures = await sweep(
      page,
      ME_TABS.map((t) => t.href),
      theme,
    );
    expect(failures, failures.join("\n\n")).toEqual([]);
  });
}

// --- the coordinator booking page (#4205) --------------------------------------------
// Its customer comes from Salesforce, which this run cannot reach, so the moments worth
// scanning (a customer found, the locked card and its pointer, the dialog, done) are the
// settled design's frames, drawn by the real component from the committed fixture
// (`?frame=`, behind this run's design fixture flag). Each frame carries its own theme.
const COORDINATOR_FRAMES = [
  "f-locked",
  "f-pressed",
  "f-unlocked",
  "f-other",
  "f-dialog-move",
  "f-done-move",
  "f-refusal",
  "d-locked",
  "d-other",
  "d-dialog-move",
  "d-done-move",
  // #4380: the live transfer offer (docs/design/coordinator-call-me-now.html), over Sam found.
  "f1",
];

test("the coordinator booking page, at each moment the design settled", async ({ page }) => {
  test.setTimeout(180_000);
  await signIn(page, seed.users.coordinator.email);
  for (const frame of COORDINATOR_FRAMES) {
    await scan(page, `/coordinator?frame=${frame}`, frame.startsWith("d-") ? "dark" : "light", `/coordinator ${frame}`);
  }
});
