#!/usr/bin/env node
// capture-web.mjs: the web adapter of the design match score (claude-config#1364).
//
//   node capture-web.mjs --design <settled.html> --build <fixture route URL> --out <capture folder>
//        [--fixture <fixture.json>] [--checks <checks.js>] [--storage <state.json>]
//        [--channel chrome|bundled] [--repo <app checkout>] [--perturb <css>] [--ready <selector>]
//        [--design-only]
//
// Draws every frame the settled design declares twice, in one browser at the frame's own width:
// the design's own frame (the whole document the settled file gives for it from
// designFrameDocument(<id>), drawn as a page of its own) and the built page's fixture route
// (<build>?frame=<id>, which the app renders from the same committed fixture, in development only).
// The design side is a page of its own rather than the frame inside the settled file, since a
// picture taken inside an iframe has the iframe's height as its viewport, which moved a sticky
// sidebar in Slate's trial. It runs the design's decision
// checks on both, writes the capture design_score.py reads, and then scores it, exiting with the
// score's own code: 0 matched, 1 not matched yet, 2 no score.
//
// Learned in Slate's first trial (Try-Pennie/slate#3934, #3946) and kept here:
//   - both sides drawn by the same browser with deterministic rasterisation, since the GPU drew
//     striped gradients a few levels differently between two renders of one frame (99.9% one run
//     in three);
//   - a picture taken when fonts are decoded, two frames painted and the pointer parked off the page,
//     never after a fixed wait (L290), which made two renders of one frame differ;
//   - one signed in context for the run, closed with the browser, when the page needs a session;
//   - the design's own checks run on the design's frame as the positive control, so a check that
//     fails on the design is reported as a wrong check, not a wrong build;
//   - --perturb <css> changes the built side on purpose, the negative control (L1);
//   - --ready <selector> waits for the built page to show its content before the picture: a streamed
//     page fired load before its content arrived on a slow runner, and CI pictured the loading
//     placeholder at 12.9% where every other run read 100% (Try-Pennie/slate#3947). A page that never
//     shows it within READY_TIMEOUT_MS is recorded as not loaded, which the score reads as no score.
//
// THE CHECKS are <design stem>.checks.js beside the design unless --checks names another: a script
// that sets window.DESIGN_CHECKS = [{id: "D1", frames: ["f1"], check(doc, ctx) -> {ok, detail}}],
// one entry per decision the map says is verified by a check. ctx is {frame, fixture}: the frame's
// id and the committed fixture's data, so both sides are checked against the same numbers. A check
// reads only what both sides share (text, roles, data attributes, computed colours), never a styling
// class, since the build draws with its own stylesheet.
//
// PLAYWRIGHT, in this order (claude-config#1385), and which one drew is recorded in the capture:
//   1. the app's own, resolved from the app checkout (--repo, default the current folder), as Slate has;
//   2. DESIGN_SCORE_PLAYWRIGHT, a path to a playwright package; one naming nothing is refused, never
//      passed over for another;
//   3. the one shared install on this Mac, where install-playwright.sh puts it (shared-playwright.json
//      names the version and the folder under HOME, outside ~/.claude), with its Chromium beside it.
// With none of them it exits 2 naming the install command, so the design side is never skipped and
// an unmeasured score never reads as matched. Nothing is installed here.
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync, existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const SCORE = join(HERE, "design_score.py");
const PIN_FILE = join(HERE, "shared-playwright.json");
const INSTALLER = join(HERE, "install-playwright.sh");
const DEFAULT_HEIGHT = 900;
const DEFAULT_WIDTH = 1280;
// How long a built page may take to show its --ready content: the bound Slate's trial used (#3947).
const READY_TIMEOUT_MS = 30_000;
// Deterministic rasterisation, measured in Slate's trial (see above).
export const LAUNCH_ARGS = ["--disable-gpu", "--force-color-profile=srgb", "--disable-partial-raster",
  "--disable-lcd-text", "--font-render-hinting=none"];

export function parseArgs(argv) {
  const want = { "--design": "design", "--build": "build", "--out": "out", "--fixture": "fixture",
    "--checks": "checks", "--storage": "storage", "--channel": "channel", "--repo": "repo", "--perturb": "perturb", "--ready": "ready" };
  const o = { channel: "chrome", designOnly: false };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--design-only") { o.designOnly = true; continue; }
    if (!(a in want)) throw new Error(`unknown argument ${a}`);
    const v = argv[i + 1];
    if (v === undefined || v.startsWith("--")) throw new Error(`${a} needs a value`);
    o[want[a]] = v; i++;
  }
  if (!o.design || !o.out || (!o.build && !o.designOnly)) {
    throw new Error("usage: capture-web.mjs --design <settled.html> --build <fixture route URL> --out <capture folder> [--fixture <json>] [--checks <checks.js>] [--storage <state.json>] [--channel chrome|bundled] [--repo <checkout>] [--perturb <css>] [--ready <selector>] [--design-only]");
  }
  if (o.channel !== "chrome" && o.channel !== "bundled") throw new Error("--channel is chrome or bundled");
  return o;
}

/** The frames the settled design declares, read by the score's own reader so the two never differ. */
export function designFrames(design, run = spawnSync) {
  const p = run("python3", [SCORE, "frames", design], { encoding: "utf8" });
  if (p.status !== 0) throw new Error(`the design's frames could not be read: ${(p.stdout || "") + (p.stderr || "")}`.trim());
  return JSON.parse(p.stdout).frames;
}

/** The frame's URL on either side: the same id, as ?frame=<id>, kept beside any query it had. */
export function frameUrl(base, id) {
  const url = new URL(base);
  url.searchParams.set("frame", id);
  return url.toString();
}

/** Runs the checks for one frame in the page, each in its own try, so one throwing is reported by
 * name and the rest still run. A page the checks could not be loaded into is one result that threw. */
export async function runChecks(page, checksSrc, frame, fixture) {
  if (checksSrc === null) return [];
  try {
    await page.addScriptTag({ content: checksSrc });
    return await page.evaluate(({ frame, fixture }) => {
      const all = window.DESIGN_CHECKS;
      if (!Array.isArray(all)) return [{ id: "checks", ok: false, detail: "the checks file sets no window.DESIGN_CHECKS list", threw: true }];
      return all.filter((c) => Array.isArray(c.frames) && c.frames.includes(frame)).map((c) => {
        try {
          const r = c.check(document, { frame, fixture });
          // A check that answers nothing measured nothing: it is reported as having thrown, which
          // the score reads as no score, rather than as a failure or a malformed entry.
          if (!r || typeof r.ok !== "boolean") {
            return { id: c.id, ok: false, detail: "the check answered no {ok, detail}", threw: true };
          }
          return { id: c.id, ok: r.ok, detail: String(r.detail || "") };
        } catch (e) {
          return { id: c.id, ok: false, detail: String(e && e.message ? e.message : e), threw: true };
        }
      });
    }, { frame, fixture });
  } catch (e) {
    return [{ id: "checks", ok: false, detail: `the checks could not be run: ${String(e).split("\n")[0]}`, threw: true }];
  }
}

/** Waits on what the picture depends on, never on the clock (L290). */
export async function settle(page, width) {
  await page.mouse.move(width - 1, 1);
  await page.evaluate(async () => {
    await document.fonts.ready;
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  });
}

function gitState(dir, run = spawnSync) {
  const head = run("git", ["-C", dir, "rev-parse", "HEAD"], { encoding: "utf8" });
  const status = run("git", ["-C", dir, "status", "--porcelain"], { encoding: "utf8" });
  return {
    commit: head.status === 0 ? head.stdout.trim() : null,
    dirty: status.status === 0 ? status.stdout.trim() !== "" : null,
  };
}

/**
 * Draws every frame and writes the capture. `browser` is a Playwright browser (or a stand in with
 * the same few calls), so this can be exercised without one.
 */
export async function capture(o, browser, frames, deps = {}) {
  const design = resolve(o.design);
  const out = resolve(o.out);
  mkdirSync(out, { recursive: true });
  const checksPath = o.checks ? resolve(o.checks) : design.replace(/\.html?$/, "") + ".checks.js";
  const checksSrc = existsSync(checksPath) ? readFileSync(checksPath, "utf8") : null;
  const fixture = o.fixture ? JSON.parse(readFileSync(resolve(o.fixture), "utf8")) : null;
  const notes = [];
  if (checksSrc === null) notes.push(`no checks file at ${checksPath}, so no decision was checked`);
  // The settled file itself, open once, asked for each frame's whole document.
  const source = await browser.newPage({ viewport: { width: DEFAULT_WIDTH, height: DEFAULT_HEIGHT } });
  await source.goto(pathToFileURL(design).toString());
  if (!(await source.evaluate(() => typeof window.designFrameDocument === "function"))) {
    await source.close();
    throw new Error(`the settled design ${design} gives no designFrameDocument(id), so its frames cannot be drawn on their own; make it with the design rounds skill's make-settled.py`);
  }
  const ctxBuilt = o.storage && !o.designOnly ? await browser.newContext({ storageState: resolve(o.storage) }) : null;
  const rows = [];
  for (const f of frames) {
    const viewport = { width: f.width, height: f.height || DEFAULT_HEIGHT };
    const shot = { fullPage: !f.height, animations: "disabled", caret: "hide" };
    const row = { id: f.id, designImage: `${f.id}-design.png`, builtImage: `${f.id}-built.png` };

    const doc = await source.evaluate((id) => window.designFrameDocument(id), f.id);
    const dpage = await browser.newPage({ viewport });
    try {
      await dpage.setContent(doc, { waitUntil: "load" });
      await settle(dpage, f.width);
      writeFileSync(join(out, row.designImage), await dpage.screenshot(shot));
      row.designChecks = await runChecks(dpage, checksSrc, f.id, fixture);
    } finally {
      await dpage.close();
    }
    if (o.designOnly) { rows.push(row); continue; }

    const bpage = ctxBuilt ? await ctxBuilt.newPage() : await browser.newPage({ viewport });
    try {
      if (ctxBuilt) await bpage.setViewportSize(viewport);
      // A page that could not be loaded at all is no score; a page the server answered, an error
      // page included, is a page that does not match yet (L11).
      let err = await bpage.goto(frameUrl(o.build, f.id)).then(() => null, (e) => String(e).split("\n")[0]);
      // Its content, never its loading placeholder: waited on as a condition, not a time (L290).
      if (!err && o.ready) {
        err = await bpage.waitForSelector(o.ready, { timeout: READY_TIMEOUT_MS }).then(() => null,
          (e) => e && e.name === "TimeoutError"
            ? `the page never showed ${o.ready} within ${Math.round(READY_TIMEOUT_MS / 1000)}s`
            // A bad selector or a page that crashed is said as itself, never as a slow page (L11).
            : `waiting for ${o.ready} failed: ${String(e).split("\n")[0]}`);
      }
      if (err) {
        row.builtError = err;
        row.checks = [];
      } else {
        await settle(bpage, f.width);
        if (o.perturb) { await bpage.addStyleTag({ content: o.perturb }); await settle(bpage, f.width); }
        writeFileSync(join(out, row.builtImage), await bpage.screenshot(shot));
        row.checks = await runChecks(bpage, checksSrc, f.id, fixture);
      }
    } finally {
      await bpage.close();
    }
    rows.push(row);
  }
  await source.close();
  if (ctxBuilt) await ctxBuilt.close();
  const git = (deps.gitState || gitState)(resolve(o.repo || process.cwd()));
  const cap = {
    format: "design-capture", version: 1, platform: "web", designFile: design,
    build: o.designOnly ? null : o.build, commit: git.commit, dirty: git.dirty, playwright: o.playwright || null,
    capturedAt: new Date().toISOString().replace(/\.\d+Z$/, "Z"), frames: rows, notes,
  };
  writeFileSync(join(out, "capture.json"), JSON.stringify(cap, null, 1));
  return cap;
}

function realOrSame(p) { try { return realpathSync(p); } catch { return resolve(p); } }

function packageVersion(dir) {
  try { return JSON.parse(readFileSync(join(dir, "package.json"), "utf8")).version || null; } catch { return null; }
}

/**
 * Which Playwright draws the design: the app's own, then DESIGN_SCORE_PLAYWRIGHT, then the shared
 * install. Returns {from, path, version, browsersPath}; browsersPath is set only for the shared
 * install, whose Chromium sits beside it rather than in Playwright's default cache. Throws, naming
 * the install command, when there is none.
 */
export function findPlaywright({ repo, env = process.env, home = homedir() }) {
  let pin;
  try { pin = JSON.parse(readFileSync(PIN_FILE, "utf8")); } catch (e) {
    throw new Error(`the shared Playwright's settings could not be read from ${PIN_FILE} (${String(e).split("\n")[0]})`);
  }
  const sharedRoot = join(home, pin.root);
  const sharedPkg = join(sharedRoot, "node_modules", "playwright");
  // Compared as real paths: node resolves a package through symlinks (macOS's /var is /private/var).
  const found = (from, path) => ({ from, path, version: packageVersion(path),
    browsersPath: realOrSame(path) === realOrSame(sharedPkg) ? join(sharedRoot, "browsers") : null });

  let own = null;
  try { own = dirname(createRequire(join(resolve(repo), "package.json")).resolve("playwright")); } catch { own = null; }
  if (own) return found("app", own);

  const named = env.DESIGN_SCORE_PLAYWRIGHT;
  if (named) {
    if (!existsSync(join(resolve(named), "package.json"))) {
      throw new Error(`DESIGN_SCORE_PLAYWRIGHT names ${named}, which holds no Playwright package; point it at one, or unset it to use the shared install`);
    }
    return found("env", resolve(named));
  }
  if (existsSync(join(sharedPkg, "package.json"))) return found("shared", sharedPkg);

  const installer = existsSync(INSTALLER) ? INSTALLER : "~/.claude/skills/design-rounds/score/install-playwright.sh";
  throw new Error(`no Playwright to draw the design with: the app at ${resolve(repo)} has none, DESIGN_SCORE_PLAYWRIGHT is not set, and the shared install is not at ${sharedPkg}. Install it with: bash ${installer}`);
}

function loadPlaywright(found) {
  // Read by Playwright when it loads, so it is set before the require.
  if (found.browsersPath && !process.env.PLAYWRIGHT_BROWSERS_PATH) process.env.PLAYWRIGHT_BROWSERS_PATH = found.browsersPath;
  return createRequire(join(found.path, "package.json"))(found.path);
}

async function main() {
  let o;
  try { o = parseArgs(process.argv); } catch (e) { console.error(`capture-web: ${e.message}`); return 2; }
  let pw;
  try {
    const found = findPlaywright({ repo: o.repo || process.cwd() });
    pw = loadPlaywright(found);
    o.playwright = { from: found.from, path: found.path, version: found.version };
    console.error(`capture-web: drawing with Playwright ${found.version || "(version unknown)"}, the ${{ app: "app's own", env: "one DESIGN_SCORE_PLAYWRIGHT names", shared: "shared install" }[found.from]}, at ${found.path}`);
  } catch (e) {
    console.error(`capture-web: could not score: ${String(e.message || e).split("\n")[0]}`);
    return 2;
  }
  const frames = designFrames(o.design);
  const browser = await pw.chromium.launch({ ...(o.channel === "chrome" ? { channel: "chrome" } : {}), args: LAUNCH_ARGS });
  try {
    await capture(o, browser, frames);
  } finally {
    await browser.close();
  }
  if (o.designOnly) {
    console.log(`capture-web: drew the design's ${frames.length} frame(s) into ${o.out}; the platform's own test draws the build side`);
    return 0;
  }
  const s = spawnSync("python3", [SCORE, "score", o.out], { stdio: "inherit" });
  return s.status === null ? 2 : s.status;
}

// Run directly, as opposed to imported by the tests. Compared as real paths: node gives
// import.meta.url the script's real path but argv[1] the path as typed, so through a symlink (macOS's
// /var is /private/var) a plain comparison never matched and the adapter exited 0 having drawn nothing.
if (process.argv[1] && realOrSame(resolve(process.argv[1])) === realOrSame(fileURLToPath(import.meta.url))) {
  // Anything unexpected is no score, exit 2: left to node it exits 1, which reads as "not matched yet".
  main().then((code) => process.exit(code), (e) => { console.error(`capture-web: could not score: ${String(e)}`); process.exit(2); });
}
