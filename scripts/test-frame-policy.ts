// #3137: who may frame the booker, and what Slate records about who does. Pure rules,
// driven without a network or a database.
// Run: node --experimental-strip-types --import ./scripts/register-paths.mjs scripts/test-frame-policy.ts
import { readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import {
  FRAME_ANCESTOR_ALLOW_LIST,
  FRAME_SURFACES,
  frameAncestorSources,
  frameSurface,
  framingObservation,
  FRAME_ORIGIN_MAX_LENGTH,
  isOriginAllowed,
  summarizeFrameOrigins,
} from "../src/lib/embed/frame-policy.ts";
import { PRODUCTION_ORIGINS } from "../src/lib/monitor/offsite-origin.ts";
import { assert, eq, finish } from "./lib/harness.ts";

const OWN = "https://slate.trypennie.app";

// The allow list Dan set on 2026-10-03, and nothing else.
for (const o of PRODUCTION_ORIGINS) {
  assert(FRAME_ANCESTOR_ALLOW_LIST.includes(o), `the production site ${o} may frame the booker`);
}
assert(FRAME_ANCESTOR_ALLOW_LIST.includes("https://dev.trypennie.com"), "trypennie's dev site may frame the booker");
assert(
  FRAME_ANCESTOR_ALLOW_LIST.includes("http://localhost:*") && FRAME_ANCESTOR_ALLOW_LIST.includes("https://localhost:*"),
  "localhost on any port may frame the booker",
);
eq(FRAME_ANCESTOR_ALLOW_LIST.length, PRODUCTION_ORIGINS.length + 3, "no origin beyond those (a partner is added on purpose)");
for (const o of FRAME_ANCESTOR_ALLOW_LIST) {
  assert(!/[\s;,']/.test(o) && o !== "*", `${o} is a single CSP source, not a wildcard or a smuggled directive`);
}
eq(frameAncestorSources()[0], "'self'", "Slate's own pages may frame it too");
eq(frameAncestorSources().slice(1), [...FRAME_ANCESTOR_ALLOW_LIST], "followed by the allow list, in order");

// Surfaces: every page a framed booker can reach has a name, and nothing else does.
eq(frameSurface("/book"), "book", "/book");
eq(frameSurface("/book/advisor/abc123"), "advisor-link", "an advisor link");
eq(frameSurface("/booking/0b1c"), "confirmation", "the confirmation page");
eq(frameSurface("/booking/manage/tok"), "manage", "the manage page");
eq(frameSurface("/booking/manage/tok/rebook"), "rebook", "the rebook page");
eq(frameSurface("/booking"), "other", "the booking POST route is no page");
eq(frameSurface("/admin"), null, "a staff page is no booker surface");

// Enumerated from the app tree, so a page added under /book or /booking later must be
// given a surface (and so is counted, and covered by the lock) rather than silently
// landing in "other".
{
  const root = fileURLToPath(new URL("../src/app/", import.meta.url));
  const pages: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (name === "page.tsx") pages.push("/" + relative(root, dir));
    }
  };
  walk(join(root, "book"));
  walk(join(root, "booking"));
  assert(pages.length >= 5, `found the booker's pages (${pages.length})`);
  for (const page of pages) {
    const path = page.replace(/\[[^\]]+\]/g, "x");
    const surface = frameSurface(path);
    assert(surface !== null && surface !== "other", `${page} has a surface of its own (${surface})`);
  }
}

// Observation: only a framed document load counts.
const obs = (over: Partial<Parameters<typeof framingObservation>[0]>) =>
  framingObservation({
    method: "GET",
    dest: "iframe",
    referer: "https://www.trypennie.com/my-offers/result?name=Jane&email=j%40x.com",
    declared: null,
    ownOrigin: OWN,
    pathname: "/book",
    ...over,
  });

eq(obs({}), { origin: "https://www.trypennie.com", surface: "book" }, "a framed /book records the framer's ORIGIN, never its path or query");
eq(obs({ dest: "document" }), null, "a top level visit is not framing");
eq(obs({ dest: null }), null, "a browser that names no destination is not counted as framing");
eq(obs({ dest: "empty" }), null, "a client side fetch is not a frame load");
eq(obs({ method: "POST" }), null, "a POST is not a frame load");
eq(obs({ pathname: "/admin" }), null, "a staff page is never recorded");
for (const dest of ["frame", "embed", "object"]) {
  assert(obs({ dest }) !== null, `a ${dest} load is framing too, which frame-ancestors also governs`);
}
eq(
  obs({ pathname: "/booking/manage/tok", referer: `${OWN}/booking/abc` })?.origin,
  "self",
  "a navigation inside the frame is recorded as self, not as Slate framing itself",
);
eq(obs({ referer: null })?.origin, "unstated", "no referrer and nothing declared is unstated");
eq(
  obs({ referer: null, declared: "https://partner.example/page?x=1" })?.origin,
  "https://partner.example",
  "with no referrer, the origin widget.js declared is the fallback, reduced to an origin",
);
eq(obs({ referer: "javascript:alert(1)" })?.origin, "unstated", "a referrer that is not a web origin is unstated");
eq(
  obs({ referer: `https://${"a".repeat(FRAME_ORIGIN_MAX_LENGTH)}.example/` })?.origin,
  "unstated",
  "an origin too long to be real is not stored",
);
eq(new Set(FRAME_SURFACES).size, FRAME_SURFACES.length, "surface names are distinct");

// Whether a recorded origin would still be let in once the lock is on. Judged the way
// the browser judges the CSP sources, so the admin page and the lock cannot disagree.
assert(isOriginAllowed("https://www.trypennie.com"), "the production site is allowed");
assert(isOriginAllowed("http://localhost:3000") && isOriginAllowed("https://localhost"), "localhost on any port is allowed");
assert(!isOriginAllowed("http://localhost.evil.example"), "a host that only starts with localhost is not");
assert(!isOriginAllowed("https://trypennie.com.evil.example"), "a host that only starts with an allowed one is not");
assert(!isOriginAllowed("http://trypennie.com"), "the scheme counts: http is not https");
assert(!isOriginAllowed("https://partner.example"), "a partner nobody added is not");

// The admin summary: per origin over the window, the ones the lock would refuse first.
{
  const rows = [
    { day: "2026-10-02", origin: "https://www.trypennie.com", surface: "book", loads: 900, last_seen: "2026-10-02T20:00:00Z" },
    { day: "2026-10-03", origin: "https://www.trypennie.com", surface: "confirmation", loads: 40, last_seen: "2026-10-03T10:00:00Z" },
    { day: "2026-10-03", origin: "https://partner.example", surface: "book", loads: 3, last_seen: "2026-10-03T09:00:00Z" },
    { day: "2026-10-03", origin: "https://bigger.example", surface: "book", loads: 7, last_seen: "2026-10-03T08:00:00Z" },
    { day: "2026-10-03", origin: "self", surface: "manage", loads: 12, last_seen: "2026-10-03T11:00:00Z" },
    { day: "2026-10-03", origin: "unstated", surface: "book", loads: 2, last_seen: "2026-10-03T07:00:00Z" },
  ];
  const s = summarizeFrameOrigins(rows);
  eq(
    s.map((r) => r.origin),
    ["https://bigger.example", "https://partner.example", "https://www.trypennie.com", "self", "unstated"],
    "refused origins first (busiest first), then allowed, then the two that name no site",
  );
  const tp = s.find((r) => r.origin === "https://www.trypennie.com")!;
  eq(tp.loads, 940, "loads are summed across days and pages");
  eq(tp.surfaces, { book: 900, confirmation: 40 }, "and kept per page");
  eq(tp.lastSeen, "2026-10-03T10:00:00Z", "last seen is the latest of its rows");
  eq(tp.kind, "allowed", "an allow list origin is allowed");
  eq(s[0].kind, "refused", "an origin off the list would be refused");
  eq(s.find((r) => r.origin === "self")!.kind, "self", "self is its own kind");
  eq(summarizeFrameOrigins([]), [], "no rows, no summary");
}

finish();
