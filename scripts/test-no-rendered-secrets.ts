// #600: a webhook credential must never be rendered back into the page.
//
// The admin form used to bind the live Regal API key as an input's `defaultValue`, so the
// secret was embedded in the server-rendered HTML and shown on screen in plain text to
// anyone who opened /admin, screen-shared, or took a screenshot. The key is the only thing
// authenticating Slate's booking events to Regal.
//
// The fix is write-only: blank keeps the saved key, a typed value replaces it. That is easy
// to undo by accident, because re-adding `defaultValue={webhook?.auth_header}` looks like a
// convenience ("show the admin what's saved") rather than a leak. This guard makes that
// regression fail the build.
//
// #2093: for months it did not. The surface list was one hand typed path,
// `src/app/admin/page.tsx`, which contains neither `auth_header` nor `secret`, while the
// form lives at `src/app/admin/webhooks/page.tsx`. Every regex matched nothing, the loop
// passed, and the guard reported green over a file holding none of the content it exists to
// check. Nothing was leaking; the tripwire was simply pointed at an empty room.
//
// Three things came out of that, and each can genuinely fail:
//   1. the surfaces are DERIVED from the pages that render a form bound to
//      `webhook_endpoints`, rather than maintained by hand, because a hand kept registry is
//      what failed here (L96);
//   2. a DECLARED surface must exist, must still be selected by the derivation, and must
//      contain at least one of the fields checked, so a page that moves again fails loudly
//      rather than passing silently (L320, L98);
//   3. a POSITIVE CONTROL plants the real regression into the real file in memory and
//      requires the guard to catch it and blame the right file, because a guard is only real
//      once it has been seen to fail (L1).
//
// Run: node --experimental-strip-types scripts/test-no-rendered-secrets.ts
import { readFileSync, existsSync, statSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve, join, relative, sep } from "node:path";
import { assert, eq, finish } from "./lib/harness.ts";
import {
  SECRET_FIELDS,
  auditRenderedSecrets,
  deriveSurfaces,
  describeFindings,
  isSurfaceCandidate,
  scanRenderedSecrets,
  secretFieldsMentioned,
  type SurfaceIo,
} from "./lib/scan-rendered-secrets.ts";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// The page whose whole job is the key field. Named out loud as a floor under the
// derivation: if this file moves or stops holding the field, the derivation could quietly
// select nothing and there would be no difference between that and a clean tree.
const DECLARED_SURFACES = ["src/app/admin/webhooks/page.tsx"];
const ROOTS = ["src"];

const realIo: SurfaceIo = {
  listFiles(root) {
    const out: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
        const abs = join(dir, entry.name);
        if (entry.isDirectory()) walk(abs);
        else out.push(relative(repoRoot, abs).split(sep).join("/"));
      }
    };
    const abs = resolve(repoRoot, root);
    if (existsSync(abs) && statSync(abs).isDirectory()) walk(abs);
    return out;
  },
  readFile: (p) => readFileSync(resolve(repoRoot, p), "utf8"),
  exists: (p) => {
    const abs = resolve(repoRoot, p);
    return existsSync(abs) && statSync(abs).isFile();
  },
};

function overlayIo(overrides: Record<string, string>): SurfaceIo {
  return {
    listFiles: (root) => realIo.listFiles(root),
    readFile: (p) => (Object.hasOwn(overrides, p) ? (overrides[p] as string) : realIo.readFile(p)),
    exists: (p) => Object.hasOwn(overrides, p) || realIo.exists(p),
  };
}

// ---------------------------------------------------------------------------
// The real tree
// ---------------------------------------------------------------------------

const audit = auditRenderedSecrets(realIo, { roots: ROOTS, declared: DECLARED_SURFACES });

assert(
  audit.refusals.length === 0,
  "the guard can find its subject" +
    (audit.refusals.length > 0 ? `\n  ${audit.refusals.join("\n  ")}` : ""),
);

assert(
  audit.findings.length === 0,
  "no surface binds or renders a webhook credential (#600)" +
    (audit.findings.length > 0 ? `\n${describeFindings(audit.findings)}` : ""),
);

for (const declared of DECLARED_SURFACES) {
  assert(audit.surfaces.includes(declared), `${declared} is one of the surfaces actually scanned`);
}

// A count, so "nothing found" can never be read as "nothing was read" (L98).
assert(
  audit.surfaces.length > 0,
  `at least one surface was scanned (scanned ${audit.surfaces.length}: ${audit.surfaces.join(", ")})`,
);

// ---------------------------------------------------------------------------
// Positive control: plant the real regression into the REAL file, in memory
// ---------------------------------------------------------------------------
//
// The overlay technique scripts/test-dependency-free-scripts.ts uses: the file's content is
// replaced for this one read, so nothing is written to the repo. This is the assertion that
// makes every green above mean something, because a scanner that read the wrong file and a
// clean tree report the same empty list.

// #3091: the page no longer has a key field at all (both credentials are Worker
// secrets), so the plant goes beside the Save button, which every version of the
// form keeps, and reads the field the old regression read.
const ANCHOR = "<SubmitButton className={btnCls}";

for (const declared of DECLARED_SURFACES) {
  const real = realIo.readFile(declared);
  const planted = real.replace(ANCHOR, `<input defaultValue={webhook?.auth_header} />\n          ${ANCHOR}`);
  assert(
    planted !== real,
    `positive control: the Save button anchor is still in ${declared} to plant beside`,
  );

  const caught = auditRenderedSecrets(overlayIo({ [declared]: planted }), {
    roots: ROOTS,
    declared: DECLARED_SURFACES,
  });

  assert(
    caught.refusals.length === 0,
    `positive control: the planted file is still a findable subject (${caught.refusals.join("; ")})`,
  );
  const blamed = caught.findings.filter(
    (f) => f.file === declared && f.field === "auth_header" && f.kind === "bound",
  );
  assert(
    blamed.length === 1,
    `positive control: re-adding \`defaultValue={webhook?.auth_header}\` to ${declared} is caught, ` +
      `and blamed on that file (caught ${caught.findings.length} finding(s): ` +
      `${caught.findings.map((f) => `${f.file}:${f.line}`).join(", ") || "none"})`,
  );

  // And the text render shape, which is the other way #600 shipped.
  const printed = real.replace(ANCHOR, `{webhook?.auth_header}\n          ${ANCHOR}`);
  assert(printed !== real, `positive control: the text render plant landed in ${declared}`);
  const caughtPrinted = auditRenderedSecrets(overlayIo({ [declared]: printed }), {
    roots: ROOTS,
    declared: DECLARED_SURFACES,
  });
  assert(
    caughtPrinted.findings.some(
      (f) => f.file === declared && f.field === "auth_header" && f.kind === "rendered",
    ),
    `positive control: printing \`{webhook?.auth_header}\` as text in ${declared} is caught`,
  );
}

// ---------------------------------------------------------------------------
// The refusals, driven over fixtures: each one has to be reachable
// ---------------------------------------------------------------------------

function fixtureIo(files: Record<string, string>): SurfaceIo {
  return {
    listFiles: () => Object.keys(files),
    readFile: (p) => {
      if (!Object.hasOwn(files, p)) throw new Error(`no such fixture file: ${p}`);
      return files[p] as string;
    },
    exists: (p) => Object.hasOwn(files, p),
  };
}

const GOOD_PAGE = `
  const { data } = await db.from("webhook_endpoints").select("*");
  return <input name="auth_header" type="password" defaultValue="" />;
`;

{
  // The shape the real tree is in: one derived surface, no findings, no refusals.
  const io = fixtureIo({ "src/app/admin/webhooks/page.tsx": GOOD_PAGE });
  const a = auditRenderedSecrets(io, {
    roots: ["src"],
    declared: ["src/app/admin/webhooks/page.tsx"],
  });
  eq(a.refusals.length, 0, "fixture: a healthy surface refuses nothing");
  eq(a.findings.length, 0, "fixture: a healthy surface leaks nothing");
  eq(a.surfaces.join(","), "src/app/admin/webhooks/page.tsx", "fixture: it derived the page");
}

{
  // #2093 itself: the declared surface holds none of the fields, which is what main's
  // hand typed registry did. This is the check that would have caught the defect.
  const io = fixtureIo({
    "src/app/admin/page.tsx": `return <input name="url" defaultValue="" />;`,
    "src/app/admin/webhooks/page.tsx": GOOD_PAGE,
  });
  const a = auditRenderedSecrets(io, { roots: ["src"], declared: ["src/app/admin/page.tsx"] });
  assert(
    a.refusals.some((r) => r.includes("contains none of")),
    "fixture: a declared surface holding none of the guarded fields is REFUSED, not passed",
  );
}

{
  // A page that moved.
  const io = fixtureIo({ "src/app/admin/webhooks/page.tsx": GOOD_PAGE });
  const a = auditRenderedSecrets(io, {
    roots: ["src"],
    declared: ["src/app/admin/hooks/page.tsx"],
  });
  assert(
    a.refusals.some((r) => r.includes("does not exist")),
    "fixture: a declared surface that does not exist is REFUSED",
  );
}

{
  // The derivation stopped matching: the page is there and still holds the field, but no
  // longer reads the endpoint table, so nothing selects it any more.
  const io = fixtureIo({
    "src/app/admin/webhooks/page.tsx": `return <input name="auth_header" defaultValue="" />;`,
  });
  const a = auditRenderedSecrets(io, {
    roots: ["src"],
    declared: ["src/app/admin/webhooks/page.tsx"],
  });
  assert(
    a.refusals.some((r) => r.includes("not selected by the derivation")),
    "fixture: a declared surface the derivation no longer selects is REFUSED",
  );
}

{
  // A candidate the scan cannot OPEN. Skipping it would make an unreadable file
  // indistinguishable from one holding nothing, which is this guard's own defect.
  const io: SurfaceIo = {
    listFiles: () => ["src/app/admin/webhooks/page.tsx", "src/app/admin/locked/page.tsx"],
    readFile: (p) => {
      if (p === "src/app/admin/locked/page.tsx") throw new Error("EACCES");
      return GOOD_PAGE;
    },
    exists: () => true,
  };
  const a = auditRenderedSecrets(io, {
    roots: ["src"],
    declared: ["src/app/admin/webhooks/page.tsx"],
  });
  assert(
    a.refusals.some((r) => r.includes("could not be read")),
    "fixture: a candidate that cannot be opened is REFUSED, not skipped",
  );
}

{
  // Nothing at all renders a webhook form: an empty scan must never read as a clean one.
  const io = fixtureIo({ "src/lib/webhooks/emit.ts": `db.from("webhook_endpoints")` });
  const a = auditRenderedSecrets(io, { roots: ["src"], declared: [] });
  assert(
    a.refusals.some((r) => r.includes("selected no surface at all")),
    "fixture: deriving nothing is REFUSED, not reported as nothing to find",
  );
}

{
  // Both leak shapes, on a derived surface nobody declared, so the derivation is doing
  // real work rather than being a decorative wrapper around the declared list.
  const io = fixtureIo({
    "src/app/admin/webhooks/page.tsx": `
      const { data: webhook } = await db.from("webhook_endpoints").select("*");
      return (
        <>
          <input name="auth_header" defaultValue={webhook?.auth_header} />
          <span>{webhook.secret}</span>
        </>
      );
    `,
  });
  const a = auditRenderedSecrets(io, { roots: ["src"], declared: [] });
  assert(
    a.findings.some((f) => f.field === "auth_header" && f.kind === "bound"),
    "fixture: a bound credential on a derived surface is caught",
  );
  assert(
    a.findings.some((f) => f.field === "secret" && f.kind === "rendered"),
    "fixture: a printed credential on a derived surface is caught",
  );
}

{
  // A binding a formatter broke across lines: the shape a line at a time scan would miss.
  const wrapped = `
      value={
        webhook?.auth_header
      }
  `;
  const findings = scanRenderedSecrets("f.tsx", wrapped);
  assert(
    findings.some((f) => f.kind === "bound" && f.field === "auth_header"),
    "a binding wrapped across lines is still caught",
  );
}

{
  // What must NOT be flagged, or the guard goes red on the correct page and stops being
  // read: a boolean use of the field, and the placeholder that names it.
  const legitimate = `
      {webhook?.auth_header ? <Pill>Key saved</Pill> : null}
      <input defaultValue="" placeholder={webhook?.auth_header ? "Leave blank" : "Regal API key"} />
  `;
  eq(
    scanRenderedSecrets("f.tsx", legitimate).length,
    0,
    "a boolean use and a placeholder that only tests the field are not flagged",
  );
}

// The candidate filter: a test file is not a surface, and neither is a server module.
assert(isSurfaceCandidate("src/app/admin/webhooks/page.tsx"), "a page is a surface candidate");
assert(!isSurfaceCandidate("src/app/admin/page-unreadable.test.tsx"), "a test file is not a surface");
assert(!isSurfaceCandidate("src/lib/webhooks/emit.ts"), "a server module is not a surface");

eq(
  secretFieldsMentioned("nothing here").length,
  0,
  "a file mentioning neither field reports neither",
);
eq(
  secretFieldsMentioned("auth_header and secret").join(","),
  SECRET_FIELDS.join(","),
  "both guarded fields are reported when both are present",
);

assert(
  deriveSurfaces(realIo, ROOTS).length > 0,
  "the derivation finds at least one surface in the real tree",
);

// ---------------------------------------------------------------------------
// The write-only contract the page's silence rests on
// ---------------------------------------------------------------------------
//
// #600 needed a blank key field to mean "keep the current key". Since #3091 both
// credentials are Worker secrets and the endpoint action writes NEITHER column at all, so
// the rule is stronger and simpler: `setWebhookEndpoint` names neither field as a key in
// anything it writes. Scoped to that function's body, because the test send beside it
// legitimately builds a throwaway endpoint carrying placeholder values.
const actions = readFileSync(resolve(repoRoot, "src/app/admin/actions.ts"), "utf8");
const setStart = actions.indexOf("export async function setWebhookEndpoint(");
const setEnd = actions.indexOf("\nexport ", setStart + 1);
assert(setStart >= 0 && setEnd > setStart, "setWebhookEndpoint is found in actions.ts to check");
const setBody = actions.slice(setStart, setEnd);
assert(
  !/\bauth_header\s*:/.test(setBody),
  "setWebhookEndpoint writes no auth_header: the Regal key is a Worker secret (#3091)",
);
assert(
  !/\bsecret\s*:/.test(setBody),
  "setWebhookEndpoint writes no signing secret: it is a Worker secret (#3091)",
);
// The positive control for the two assertions above, over the function as it used to be.
assert(
  /\bauth_header\s*:/.test('update(authHeader ? { url, format, auth_header: authHeader } : { url, format })'),
  "positive control: the old write shape is caught by the auth_header pattern",
);
assert(/\bsecret\s*:/.test("secret: nanoid(32),"), "positive control: a minted secret is caught");

finish();
