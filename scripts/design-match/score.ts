// Scores a built page against its settled design (claude-config#1364, first tried on #3934).
//
//   node --experimental-strip-types scripts/design-match/score.ts --design docs/design/team-capacity.html --build <url>
//   node --experimental-strip-types scripts/design-match/score.ts --design docs/design/team-capacity.html --build design
//
// Two halves, and the design is matched only when BOTH are 100%:
//   decisions  each decision in the design's map has a check (docs/design/<name>.checks.js) run
//              against the built page's frames; the score is decisions met over decisions checked,
//              a decision being met only when it passes on every frame it is checked on. A decision
//              with no on screen form is listed, not scored.
//   pictures   each frame of the design is screenshotted beside the built page rendering the same
//              fixture, and a pixel matches when no colour channel differs by more than TOLERANCE.
//
// `--build <url>` loads `<url>?frame=<id>` for every frame (the fixture preview the build adds).
// `--build design` is the positive control: both sides render from the design by the same path, so
// it proves the checks pass on the design itself and that rendering is repeatable, which is what
// lets 100% be reached at all. It cannot prove the scorer notices a difference: `--perturb <css>`
// does, by changing the built side on purpose (L1). `--build design:<file>` scores this design
// against another revision of it.
//
// Exit codes: 0 matched (both 100%), 1 not matched yet, 2 could not score: bad arguments, no
// frames, a check that threw, a built page that could not be loaded, or a design failing its own
// checks. So "not built yet" and "the scorer or the build could not be read" never read alike (L11).
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve, dirname, basename } from "node:path";
import { chromium, type Frame, type Page } from "playwright";
import { frameFixture as buildFrameFixture, verdict, type FrameResult } from "../lib/design-match.ts";


// Out of 255 per channel. Both sides render in the same Chrome, so font smoothing is identical and the
// tolerance only has to absorb rounding. 24 was tried first and let a blank white page match Slate's
// beige page (15 apart) at 97%.
const TOLERANCE = 8;
const WIDTH = 1280;

// Anything unexpected (a malformed --build, an unreadable checks or fixture file, Chrome failing
// to start) is no score, exit 2: left to Node it exits 1, which reads as "not matched yet" (L11).
const noScore = (e: unknown) => { console.error(`design-match: could not score: ${String(e)}`); process.exit(2); };
process.on("uncaughtException", noScore);
process.on("unhandledRejection", noScore);

function arg(name: string): string | null {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] ?? null : null;
}
function die(message: string): never {
  console.error(`design-match: ${message}`);
  process.exit(2);
}

const designPath = arg("--design");
// --perturb <css>: a deliberate difference on the built side, in any mode; the negative control.
const perturb = arg("--perturb");
if (process.argv.includes("--perturb") && (!perturb || perturb.startsWith("--"))) die("--perturb needs a CSS value");
const build = arg("--build");
if (!designPath || !build) die("usage: score.ts --design <design.html> --build <url | design>");
const designFile = resolve(designPath);
const stem = designFile.replace(/\.html$/, "");
const checksSrc = readFileSync(`${stem}.checks.js`, "utf8");
const fixture = JSON.parse(readFileSync(resolve(dirname(designFile), "fixtures", `${basename(stem)}.json`), "utf8"));
const frameIds = Object.keys(fixture.frames);
if (frameIds.length === 0) die("the fixture names no frames, so there is nothing to score");
const outDir = resolve(dirname(designFile), "..", "..", ".design-match", basename(stem));
mkdirSync(outDir, { recursive: true });

const frameFixture = (id: string) => buildFrameFixture(fixture, id);

async function runChecks(target: Frame | Page, id: string) {
  try {
    await target.addScriptTag({ content: checksSrc });
    return await evaluateChecks(target, id);
  } catch (e) {
    // The checks could not be loaded or run on this page at all: recorded against the frame as a
    // throw, which the verdict reads as no score.
    return [{ id: "checks", ok: false, detail: `could not run the checks: ${String(e).split("\n")[0]}`, threw: true }];
  }
}

function evaluateChecks(target: Frame | Page, id: string) {
  return target.evaluate(({ id, ctx }) => {
    const w = window as unknown as { TC_CHECKS: { id: string; frames: string[]; offScreen?: string; check?: (d: Document, c: unknown) => { ok: boolean; detail: string } }[] };
    return w.TC_CHECKS.filter((c) => c.frames.includes(id)).map((c) => {
      try { return { id: c.id, ...c.check!(document, ctx) }; }
      catch (e) { return { id: c.id, ok: false, detail: `threw: ${String(e)}`, threw: true }; }
    });
  }, { id, ctx: frameFixture(id) });
}

/**
 * Share of pixels within TOLERANCE, over the larger of the two images. Area only one side has
 * (a built page taller or wider than the design frame) counts as different, never as matching.
 */
async function pictureMatch(page: Page, a: Buffer, b: Buffer): Promise<number> {
  return page.evaluate(async ({ a, b, tol }) => {
    const load = (src: string) => new Promise<HTMLImageElement>((ok) => { const i = new Image(); i.onload = () => ok(i); i.src = src; });
    const [ia, ib] = await Promise.all([load(`data:image/png;base64,${a}`), load(`data:image/png;base64,${b}`)]);
    const w = Math.max(ia.width, ib.width), h = Math.max(ia.height, ib.height);
    const read = (img: HTMLImageElement) => { const c = document.createElement("canvas"); c.width = w; c.height = h; const x = c.getContext("2d")!; x.drawImage(img, 0, 0); return x.getImageData(0, 0, w, h).data; };
    const da = read(ia), db = read(ib);
    let same = 0;
    const box = [Infinity, Infinity, -1, -1];
    const inA = (px: number) => (px % w) < ia.width && Math.floor(px / w) < ia.height;
    const inB = (px: number) => (px % w) < ib.width && Math.floor(px / w) < ib.height;
    for (let px = 0; px < w * h; px++) {
      if (!inA(px) || !inB(px)) continue;
      const k = px * 4;
      if (Math.abs(da[k] - db[k]) <= tol && Math.abs(da[k + 1] - db[k + 1]) <= tol && Math.abs(da[k + 2] - db[k + 2]) <= tol) same++;
      else { const x = px % w, y = Math.floor(px / w); box[0] = Math.min(box[0], x); box[1] = Math.min(box[1], y); box[2] = Math.max(box[2], x); box[3] = Math.max(box[3], y); }
    }
    (window as unknown as { lastBox: number[] }).lastBox = box;
    return same / (w * h);
  }, { a: a.toString("base64"), b: b.toString("base64"), tol: TOLERANCE });
}

// Deterministic rasterisation: on the GPU the striped gradients came out a few levels different
// between two renders of one frame on some runs (#3934's control read 99.9% one run in three).
const browser = await chromium.launch({
  channel: "chrome",
  args: ["--disable-gpu", "--force-color-profile=srgb", "--disable-partial-raster", "--disable-lcd-text", "--font-render-hinting=none"],
});
const design = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
await design.goto(`file://${designFile}`);
await design.waitForFunction(() => typeof (window as unknown as { frameHtml?: unknown }).frameHtml === "function");

const rows: FrameResult[] = [];
/**
 * Waits on the conditions a picture depends on rather than on the clock (L290): every font
 * decoded, two frames painted, and the pointer parked off the page so no hover state is captured.
 * A fixed 500ms wait made two renders of one frame differ on some runs (99.9% against 100%).
 */
async function settle(page: Page): Promise<void> {
  await page.mouse.move(WIDTH - 1, 1);
  await page.evaluate(async () => {
    await document.fonts.ready;
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  });
}
const SHOT = { fullPage: true, animations: "disabled" as const, caret: "hide" as const };

/**
 * One frame of a design file on its own page, at the canonical capture size (WIDTH by 900, the
 * full page). The design file's iframes are for reading; a picture taken inside one has the
 * iframe's height as its viewport, which moves the sticky sidebar, so both sides are captured so.
 */
async function renderFrom(source: Page, id: string): Promise<Page> {
  const parts = await source.evaluate(() => ({ data: (window as unknown as { DATA_TEXT: string }).DATA_TEXT, cal: (window as unknown as { CALENDAR_HTML: string }).CALENDAR_HTML }));
  const html = await source.evaluate((v) => (window as unknown as { frameHtml: (v: unknown) => string }).frameHtml(v), fixture.frames[id]);
  const page = await browser.newPage({ viewport: { width: WIDTH, height: 900 } });
  // A replacer function, not a string: a string replacement reads $& and $' in the data as patterns.
  const inject = "<head><script>window.DATA_TEXT=" + JSON.stringify(parts.data) + ";window.CALENDAR_HTML=" + JSON.stringify(parts.cal) + ";</script>";
  await page.setContent(html.replace("<head>", () => inject));
  await settle(page);
  return page;
}
const renderDesignFrame = (id: string) => renderFrom(design, id);

// `--build design:<file>` scores this design against another revision of it, frame by frame,
// which is how a change meant to alter nothing on screen (a smaller file) is proven to.
let other: Page | null = null;
if (build.startsWith("design:")) {
  other = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
  await other.goto(`file://${resolve(build.slice("design:".length))}`);
  await other.waitForFunction(() => typeof (window as unknown as { frameHtml?: unknown }).frameHtml === "function");
}

for (const id of frameIds) {
  const dpage = await renderDesignFrame(id);
  const designShot = await dpage.screenshot(SHOT);
  const designChecks = await runChecks(dpage, id);
  await dpage.close();

  let page: Page;
  let loadError: string | undefined;
  if (other) {
    page = await renderFrom(other, id);
  } else if (build === "design") {
    page = await renderDesignFrame(id);
  } else {
    page = await browser.newPage({ viewport: { width: WIDTH, height: 900 } });
    const url = new URL(build); url.searchParams.set("frame", id);
    // A page that could not be loaded at all is no score; a page the server answered, a 404
    // included, is a page that does not match yet (L11).
    loadError = await page.goto(url.toString()).then(() => undefined, (e: unknown) => String(e).split("\n")[0]);
    if (!loadError) await settle(page);
  }
  if (loadError) {
    // Nothing was loaded, so there is nothing to check or picture; the verdict names it no score.
    rows.push({ frame: id, checks: [], picture: 0, designChecks, loadError });
    await page.close();
    continue;
  }
  if (perturb) { await page.addStyleTag({ content: perturb }); await settle(page); }
  const builtShot = await page.screenshot(SHOT);
  const checks = await runChecks(page, id);
  const picture = await pictureMatch(design, designShot, builtShot);
  if (picture < 1 && process.env.DESIGN_MATCH_DEBUG) console.log(`    ${id} differs inside`, await design.evaluate(() => (window as unknown as { lastBox: number[] }).lastBox), "sizes", designShot.length, builtShot.length);
  writeFileSync(`${outDir}/${id}-design.png`, designShot);
  writeFileSync(`${outDir}/${id}-built.png`, builtShot);
  rows.push({ frame: id, checks, picture, designChecks, loadError });
  await page.close();
}
await design.addScriptTag({ content: checksSrc });
const offScreen = await design.evaluate(() => (window as unknown as { TC_CHECKS: { offScreen?: string }[] }).TC_CHECKS.filter((c) => c.offScreen).length);
await browser.close();

const v = verdict(rows);
const pct = (x: number) => `${(Math.floor(x * 1000) / 10).toFixed(1)}%`;
console.log(`design-match: ${basename(designFile)} against ${build}`);
if (v.exitCode !== 2) {
  console.log(`  decisions  ${v.met} of ${v.of} met (${pct(v.decisionScore)}); ${offScreen} proven off screen, not scored`);
  console.log(`  pictures   ${pct(v.pictureScore)} of pixels match, averaged over ${rows.length} frames`);
}
for (const r of rows) {
  const failed = r.checks.filter((c) => !c.ok);
  console.log(`    ${r.frame.padEnd(4)} picture ${pct(r.picture).padStart(6)}  checks ${r.checks.length - failed.length}/${r.checks.length}${failed.length ? "  missing: " + failed.map((c) => c.id).join(" ") : ""}`);
}
writeFileSync(`${outDir}/score.json`, JSON.stringify({ build, ...v, frames: rows.map((r) => ({ frame: r.frame, picture: r.picture, failed: r.checks.filter((c) => !c.ok) })) }, null, 1));
for (const reason of v.reasons) console.log(`  NO SCORE: ${reason}`);
console.log(v.exitCode === 0 ? "  MATCHED: both halves are 100%" : v.exitCode === 1 ? "  not matched yet" : "  could not score");
process.exit(v.exitCode);
