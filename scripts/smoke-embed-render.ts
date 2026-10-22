// The canary's browser check: does the EMBEDDED booker actually draw (#1006)?
//
// Run: SLATE_BASE_URL=... node --experimental-strip-types --import ./scripts/register-paths.mjs \
//   scripts/smoke-embed-render.ts
// (the alias hook is required: its crash record imports the app's error text, #4062)
//
// The uptime canary proves the server responds; nothing proved the front end
// draws. cal.com is watched by a Checkly browser check that loads the embedded
// scheduler and confirms the modal appears; Slate's embed had no equivalent, so a
// front end or embed regression leaving the booker blank would go unnoticed.
//
// ## Why this stays in the canary beside the pre merge browser leg
//
// When this was written, AGENTS.md recorded a decision not to add a browser layer
// to CI (#611, audit AUD-037), because `next dev` screenshots never settle. Dan
// reversed that on 2026-10-03 (ADR 0011, #3079, #3100): a pre merge browser run
// now drives a production build on a local stack. That run cannot see the
// DEPLOYED Worker or the real embed host, so this check keeps its own job.
//
// It runs POST DEPLOY, against the real deployment, on the canary's own schedule,
// and it drives the DEPLOYED widget.js on its real host. That is the half the pre
// merge run cannot reach, so the two are complements: the browser leg proves a
// change before it merges, and this proves what is actually live.
//
// ## What it asserts, and the one thing it deliberately does not
//
// It does NOT demand that slots are offered. Before cutover the roster is
// deliberately dark (#1272), so a real bucket legitimately offers nothing and a
// check that demanded times would be red every run from the day it shipped. An
// alert that cries wolf gets ignored (L36), and this one has to still be believed
// on the day the embed actually breaks.
//
// It asserts the booker SAYS SOMETHING: a working embed either offers times or
// states in its own words why it has none, and a broken one shows a blank panel,
// a stuck loader, or the embed's own load-failed message. The rules are in
// scripts/lib/embed-render-check.ts and are pinned offline by
// scripts/test-embed-render-check.ts, so they are tested where no browser exists.
//
// #1869: once the booker has mounted it also opens ONE floating panel, the booker's
// timezone list, from the keyboard, and asserts it is on screen, uncovered, holds
// focus, walks with the arrow keys and shuts on Escape (`booker-panel-probe.ts`).
// All four popups share one component (#1843), and the defects that component has
// shipped are invisible to jsdom. It rides this 6 hourly full pass rather than the
// 30 minute tick, for the billing reason #1006 gives. It commits nothing.
//
// Failures are recorded through the SAME failure log the booking smoke uses, so
// the existing Slack alerter names this check alongside the others rather than
// needing a second alerting path, which would be a second thing to keep working
// on the surface whose whole job is to still work when something else has broken.
import { appendFileSync } from "node:fs";
import { chromium, type Browser } from "playwright";
import {
  embedHostPage,
  isCspRefusal,
  judgeEmbedRender,
  type EmbedObservation,
  type PanelObservation,
} from "./lib/embed-render-check.ts";
import { probeTimezonePanel } from "./lib/booker-panel-probe.ts";
import { failureLogPath, recordFailure, recordPass } from "./lib/smoke-failure-log.ts";
import { recordSmokeCrash } from "./lib/smoke-crash.ts";

const base = (process.env.SLATE_BASE_URL || "https://slate.trypennie.app").replace(/\/$/, "");
// A REAL bucket, deliberately NOT the hidden SMOKE one the other canary steps use.
// That bucket is gated on a bearer token (#396) which a BROWSER cannot send, so the
// booker correctly answers "This booking link is not available" and the check would
// have false-paged every full pass. Measured against the real deployment on
// 2026-09-02, which is the only way this was ever going to be found.
//
// A bucket that is missing or refused now reports `link-refused` by name rather
// than as a blank booker, so pointing this at the wrong code is a clear failure
// instead of a misleading one.
// env-ok: SMOKE_EMBED_BUCKET (a local override for driving another bucket by hand)
const bucket = process.env.SMOKE_EMBED_BUCKET || "120";

/** How long to give the modal and the frame. Generous: this is a real browser
 *  against a real deployment over the public internet, and a check that failed on
 *  a slow morning would be the flapping alert this is meant not to become. */
const MODAL_TIMEOUT_MS = 20_000;

/**
 * The booker's own chrome: its timezone control and its heading. Both live in the
 * event panel and are NOT conditional on there being any slots, so the empty-week
 * state this check is built to tolerate still counts as mounted. Measured against
 * the real deployment: a working booker has both, and each of the booker's refusal
 * screens has neither.
 */
const BOOKER_CHROME = "#booker-tz, h1";
const FRAME_TIMEOUT_MS = 30_000;

const io = { append: (path: string, line: string) => appendFileSync(path, line), read: () => null };
const failureLog = failureLogPath(process.env);

/** Drive the embed and report what was seen. Never throws: a driver fault is
 *  itself an observation the judge has to be able to act on, and a crash here
 *  would leave the canary reporting nothing at all rather than a failure. */
async function observe(browser: Browser): Promise<EmbedObservation | { driverError: string }> {
  const consoleErrors: string[] = [];
  // #2565: a CSP refusal reaches the console of whichever frame it happened in,
  // and playwright reports every frame's console on the page, which is the only
  // way to see one inside the cross origin booker iframe.
  const cspViolations: string[] = [];
  const context = await browser.newContext();
  const page = await context.newPage();
  // Both channels: a thrown exception never reaches console.error, and a logged
  // error never becomes a page error, so listening to one discards half of what
  // the browser is telling us (L219).
  page.on("console", (msg) => {
    if (msg.type() !== "error") return;
    const text = msg.text();
    if (isCspRefusal(text)) cspViolations.push(text);
    else consoleErrors.push(text);
  });
  page.on("pageerror", (err) => consoleErrors.push(String(err)));

  try {
    // A data URL rather than a local server: the page is three lines and starting
    // a server is a second thing that can fail on the surface whose job is to
    // still work when something else has.
    await page.setContent(embedHostPage(base, bucket), { waitUntil: "load" });
    await page.click("#book");

    const modal = page.locator('[role="dialog"]');
    let modalPresent = true;
    try {
      await modal.waitFor({ state: "visible", timeout: MODAL_TIMEOUT_MS });
    } catch {
      modalPresent = false;
    }
    if (!modalPresent) {
      return {
        modalPresent: false,
        loadFailedShown: false,
        bookerMounted: false,
        frameText: "",
        consoleErrors,
        cspViolations,
        panel: null,
      };
    }

    // The embed's own failure panel, asked for by its copy rather than by a class,
    // so a restyle cannot silently stop this check noticing it. The wording lives
    // in widget.js's COPY block, which the embed preview reads.
    const loadFailedShown = await page
      .getByText(/couldn't load the booking form/i)
      .first()
      .isVisible()
      .catch(() => false);

    // Whether the BOOKER's own chrome mounted, plus the text as evidence. Read
    // through the frame rather than off the modal, because the modal's own chrome
    // (the close button, the loading text) would otherwise count as content and a
    // blank booker inside a present modal would read as healthy.
    let frameText = "";
    let bookerMounted = false;
    let panel: PanelObservation | null = null;
    try {
      const frame = page.frameLocator('iframe[title]');
      const body = frame.locator("body");
      await body.waitFor({ state: "attached", timeout: FRAME_TIMEOUT_MS });
      // Wait for the booker's own heading rather than a fixed sleep, so a fast
      // deployment is not paid for and a slow one is not failed early (L290).
      // Wait on the booker's own chrome rather than a fixed sleep, so a fast
      // deployment is not paid for and a slow one is not failed early (L290).
      await frame
        .locator(BOOKER_CHROME)
        .first()
        .waitFor({ state: "visible", timeout: FRAME_TIMEOUT_MS })
        .catch(() => {});
      bookerMounted = (await frame.locator(BOOKER_CHROME).count().catch(() => 0)) > 0;
      frameText = (await body.innerText().catch(() => "")) ?? "";
      // #1869: only a mounted booker has the control; an unmounted one is judged
      // on its own outcome, and a mounted one with no reading fails.
      if (bookerMounted) panel = await probeTimezonePanel(frame);
    } catch {
      frameText = "";
    }

    return { modalPresent, loadFailedShown, bookerMounted, frameText, consoleErrors, cspViolations, panel };
  } catch (err) {
    return { driverError: String(err) };
  } finally {
    await context.close().catch(() => {});
  }
}

async function main(): Promise<number> {
  let browser: Browser;
  try {
    browser = await chromium.launch();
  } catch (err) {
    // The browser itself is missing or would not start. That is a fault in the
    // CHECK, not in the embed, and it must say so: reporting it as a render
    // failure would send somebody to look at a booker that is fine (L11).
    const line = `embed render: the browser could not be launched, so the embed was NOT checked: ${String(err)}`;
    console.error(line);
    if (failureLog) recordFailure(io, failureLog, line);
    return 1;
  }

  try {
    const seen = await observe(browser);
    if ("driverError" in seen) {
      const line = `embed render: the check could not drive the page, so the embed was NOT checked: ${seen.driverError}`;
      console.error(line);
      if (failureLog) recordFailure(io, failureLog, line);
      return 1;
    }
    const verdict = judgeEmbedRender(seen);
    if (verdict.outcome === "rendered") {
      recordPass(io, failureLog); // #4062: a pass is part of the record too
      console.log(
        `embed render: ok (booker chrome mounted, ${seen.frameText.trim().length} characters drawn, timezone list opened, focused and walked)`,
      );
      return 0;
    }
    const line = `embed render (${verdict.outcome}): ${verdict.reason}`;
    console.error(line);
    if (failureLog) {
      recordFailure(io, failureLog, line);
    } else {
      console.error(
        "embed render: the failure could not be recorded for the alerter (no SMOKE_FAILURE_FILE), so it is printed here only",
      );
    }
    return 1;
  } finally {
    await browser.close().catch(() => {});
  }
}

// #4062: a throw main did not catch is recorded as a crash, with a short reason,
// rather than dying on an unhandled rejection with nothing in the failure log.
process.exit(
  await main().catch((e: unknown) => {
    console.error("embed render crashed:", e);
    recordSmokeCrash("The embed render check", e);
    return 1;
  }),
);
