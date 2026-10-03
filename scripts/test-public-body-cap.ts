// #3135: a public route reads its body through `readJsonCapped` (src/lib/http/read-json-capped.ts),
// never a bare `req.json()` or `req.text()`, which buffer whatever arrives before anything
// looks at the size. The reader itself is pinned by scripts/test-read-json-capped.ts; this
// pins that the public routes USE it.
//
// "Public" is decided the safe way round. A route file is in scope unless it calls one of the
// authentication gates below, so a NEW route with a gate this list does not know is flagged
// rather than exempt, and the fix is either the capped reader or naming the gate here. What
// that does not prove, said so it is not assumed: that a gated route reads its body AFTER the
// gate. Every gate listed refuses before its route reads a body today.
//
// The escape hatch is `// body-cap-ok: <reason>` in the file, for a route that cannot use the
// reader (Slack signs the raw text, so it must be read before the signature can be checked).
// Run: node --experimental-strip-types --import ./scripts/register-paths.mjs scripts/test-public-body-cap.ts
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { assert, eq, finish } from "./lib/harness.ts";
import { textHasOptOut } from "./lib/opt-out.ts";
import { blankComments } from "./lib/strip-comments.ts";

const ROOT = join(import.meta.dirname, "..");
const BARE_READ = /\b(?:req|request)\.(?:json|text|formData|arrayBuffer)\(\)/;
const AUTH_GATES =
  /\b(?:bearerTokenMatches|authenticateBearer|authorizeBookingApi|respondToDirectCancel|isAuthorizedCron|requireBookingActor|timingSafeEqual)\(/;
const HATCH = "body-cap-ok:";

/** Whether a route file reads a body uncapped while nothing authenticates the caller. */
export function uncappedPublicRead(src: string): boolean {
  const code = blankComments(src);
  return BARE_READ.test(code) && !AUTH_GATES.test(code) && !textHasOptOut(src, HATCH);
}

function routes(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...routes(p));
    else if (/^route\.tsx?$/.test(name)) out.push(p);
  }
  return out;
}

const all = routes(join(ROOT, "src", "app"));
assert(all.length > 20, `found the route files (${all.length})`);
const capped = all.filter((f) => /\breadJsonCapped\(/.test(readFileSync(f, "utf8")));
assert(capped.length >= 7, `the public JSON routes read through the capped reader (${capped.length})`);
for (const f of all) {
  eq(
    uncappedPublicRead(readFileSync(f, "utf8")),
    false,
    `${relative(ROOT, f)} reads no uncapped body without authenticating first`,
  );
}

// Positive controls: the bare read is caught, a commented one is not a read, a gate exempts,
// and a hatch needs a reason.
{
  assert(uncappedPublicRead("const b = await req.json().catch(() => null);"), "a bare public read is caught");
  assert(uncappedPublicRead("const t = await request.text();"), "the text form is caught too");
  assert(!uncappedPublicRead("// const b = await req.json();\nconst r = await readJsonCapped(req, 1);"), "prose about a read is not a read");
  assert(!uncappedPublicRead("if (!bearerTokenMatches(h, k)) return x;\nconst b = await req.json();"), "an authenticated route is out of scope");
  assert(uncappedPublicRead("// body-cap-ok:\nconst t = await req.text();"), "a hatch with no reason exempts nothing");
  assert(
    uncappedPublicRead('const u = "https://slate.test"; const b = await req.json();'),
    "the // inside a URL literal is not a comment, so the read after it is still seen",
  );
  assert(
    !uncappedPublicRead("const r = await readJsonCapped(req, 1); // was: await req.json()"),
    "a trailing comment after code is still a comment",
  );
}

finish();
