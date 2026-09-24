// Repo invariant (#2690): server code never CALLS a function exported from a
// `"use client"` module.
//
// What happened: `src/components/admin/PublicBookingSwitch.tsx` carried no
// `"use client"`, so it rendered as a server component inside
// `/admin/business-hours`, and it called `holdsAView(...)`, a plain function
// exported from the `"use client"` module `src/components/ui/SaveForm.tsx`. On the
// server every export of a client module is a client REFERENCE, so the call threw
// "Attempted to call holdsAView() from the server but holdsAView is on the
// client" and the whole page drew its error boundary. That page holds the public
// booking kill switch (#2297), so the lever for stopping bookings in an incident
// was unreachable, along with business hours and holidays.
//
// Nothing in the pipeline could see it. tsc checks the real function's types,
// vitest renders in jsdom where there is no server/client boundary, and
// `next build` does not render a dynamic admin page. The rule is only enforced
// at request time, by the runtime, in front of the person who needed the page.
//
// So this guard reads the syntax tree of every file under `src/` WITHOUT a
// leading `"use client"`, finds the bindings it imports from modules that DO
// start with one, and fails when such a binding is the callee of a call or a
// `new` (directly, or as `ns.fn()` through a namespace import). Rendering one as
// JSX (`<SaveForm />`) or passing it along as a value is the supported shape and
// is never flagged. Type-only imports are skipped.
//
// Escape hatch: `// client-boundary-ok: <reason>` on the call's line or in the
// comment block above it. A marker with no reason exempts nothing. There is no
// known legitimate use; it exists so a genuine false positive does not force
// somebody to disable the whole guard.
//
// BOUNDARY, stated so this is not read as wider coverage than it has:
//   - Test files (`*.test.ts`, `*.test.tsx`) are out of scope: they run in node or
//     jsdom, never as server components, so the boundary does not exist there.
//   - Only imports that resolve INSIDE the repo are judged (`@/...` and relative
//     paths). A call into a `"use client"` npm package is not seen.
//   - A binding reaching a server file through a barrel that re-exports a client
//     module is not seen, because the barrel itself carries no directive. The tree
//     has no such barrel today.
//   - A file with no directive that is imported ONLY by client modules runs on the
//     client and may legitimately call client functions; it would be flagged here.
//     None exists today, and the escape hatch is the answer if one appears.
// Run: node --experimental-strip-types scripts/test-client-boundary-calls.ts
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import {
  hasUseClientDirective,
  resolveLocalSpecifier,
  scanClientBoundaryCalls,
  scanFilesForClientBoundaryCalls,
} from "./lib/scan-client-boundary-calls.ts";
import { assert, eq, finish } from "./lib/harness.ts";

const ROOT = join(import.meta.dirname, "..");
const SRC = join(ROOT, "src");

// --- directive detection ------------------------------------------------------

assert(hasUseClientDirective(`"use client";\nexport const x = 1;`), "double quoted directive is read");
assert(hasUseClientDirective(`'use client'\nexport const x = 1;`), "single quoted, no semicolon");
assert(
  hasUseClientDirective(`// a header comment\n/* and a block */\n"use client";\nexport {}`),
  "comments before the directive do not hide it",
);
assert(!hasUseClientDirective(`import x from "y";\n"use client";`), "a string after code is not a directive");
assert(!hasUseClientDirective(`"use server";\nexport async function a() {}`), "use server is not use client");
assert(!hasUseClientDirective(`export const s = "use client";`), "the phrase inside code is not a directive");

// --- resolution ---------------------------------------------------------------

{
  const files = new Set(["/r/src/components/ui/SaveForm.tsx", "/r/src/lib/a/index.ts"]);
  const exists = (p: string) => files.has(p);
  eq(
    resolveLocalSpecifier("@/components/ui/SaveForm", "/r/src/app/x/page.tsx", "/r/src", exists),
    "/r/src/components/ui/SaveForm.tsx",
    "the @/ alias resolves under src with a .tsx extension",
  );
  eq(
    resolveLocalSpecifier("../../lib/a", "/r/src/app/x/page.tsx", "/r/src", exists),
    "/r/src/lib/a/index.ts",
    "a relative path resolves to a directory index",
  );
  eq(resolveLocalSpecifier("react", "/r/src/app/x/page.tsx", "/r/src", exists), null, "a package is not resolved");
}

// --- positive controls: synthetic sources --------------------------------------

const CLIENT = new Set(["@/components/ui/SaveForm", "./client-thing"]);
const isClient = (s: string) => CLIENT.has(s);
const scan = (src: string) => scanClientBoundaryCalls(src, "fixture.tsx", isClient);

interface Fixture {
  name: string;
  flagged: number;
  src: string;
}

const FIXTURES: Fixture[] = [
  {
    name: "the #2690 shape: a server component calls a named client export",
    flagged: 1,
    src: `import { SaveForm, holdsAView } from "@/components/ui/SaveForm";
export function S() { return <SaveForm unsaved={holdsAView("fixed value")} />; }`,
  },
  {
    name: "a default import called",
    flagged: 1,
    src: `import thing from "./client-thing";\nexport const v = thing();`,
  },
  {
    name: "an aliased named import called",
    flagged: 1,
    src: `import { holdsAView as hv } from "@/components/ui/SaveForm";\nconst u = hv("x");`,
  },
  {
    name: "a namespace member called",
    flagged: 1,
    src: `import * as SF from "@/components/ui/SaveForm";\nconst u = SF.holdsAView("x");`,
  },
  {
    name: "constructed with new",
    flagged: 1,
    src: `import { Thing } from "./client-thing";\nconst t = new Thing();`,
  },
  {
    name: "two calls are two findings",
    flagged: 2,
    src: `import { holdsAView } from "@/components/ui/SaveForm";\nconst a = holdsAView("a");\nconst b = holdsAView("b");`,
  },
  {
    name: "a marker with no reason exempts nothing",
    flagged: 1,
    src: `import { holdsAView } from "@/components/ui/SaveForm";\n// client-boundary-ok:\nconst a = holdsAView("a");`,
  },

  // NOT FLAGGED --------------------------------------------------------------
  {
    name: "rendered as JSX only",
    flagged: 0,
    src: `import { SaveForm } from "@/components/ui/SaveForm";\nexport const S = () => <SaveForm name="x" />;`,
  },
  {
    name: "passed as a value, not called",
    flagged: 0,
    src: `import { holdsAView } from "@/components/ui/SaveForm";\nexport const S = () => <X make={holdsAView} />;`,
  },
  {
    name: "the calling file is itself a client module",
    flagged: 0,
    src: `"use client";\nimport { holdsAView } from "@/components/ui/SaveForm";\nconst a = holdsAView("a");`,
  },
  {
    name: "a call into a module that is not a client module",
    flagged: 0,
    src: `import { format } from "@/lib/format";\nconst a = format("a");`,
  },
  {
    name: "a type-only import",
    flagged: 0,
    src: `import type { Opts } from "@/components/ui/SaveForm";\nconst a: Opts = make();`,
  },
  {
    name: "the name inside a string or comment is not a call",
    flagged: 0,
    src: `import { holdsAView } from "@/components/ui/SaveForm";\n// holdsAView("x") is not allowed here\nconst s = "holdsAView(";\nexport { holdsAView };`,
  },
  {
    name: "a reasoned escape hatch on the line above",
    flagged: 0,
    src: `import { holdsAView } from "@/components/ui/SaveForm";\n// client-boundary-ok: this module is only ever imported by client code\nconst a = holdsAView("a");`,
  },
];

for (const f of FIXTURES) {
  const found = scan(f.src);
  eq(found.length, f.flagged, `fixture: ${f.name}`);
}

{
  const [hit] = scan(
    `import { SaveForm, holdsAView } from "@/components/ui/SaveForm";\n\nconst u = holdsAView("x");`,
  );
  eq(hit?.line, 3, "a finding carries the call's own line");
  eq(hit?.callee, "holdsAView", "a finding names the callee");
  eq(hit?.from, "@/components/ui/SaveForm", "a finding names the module it came from");
}

// --- the real tree -------------------------------------------------------------

function walk(dir: string, out: string[]): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) && !name.endsWith(".d.ts")) out.push(full);
  }
  return out;
}

const files = walk(SRC, []);
const clientFiles = files.filter((f) => hasUseClientDirective(readFileSync(f, "utf8")));

// The scan must have had something to judge, or a clean result means nothing (L98).
assert(files.length > 200, `the scan walked the src tree (${files.length} files)`);
assert(clientFiles.length > 20, `the tree holds client modules to import from (${clientFiles.length})`);
assert(
  clientFiles.some((f) => f.endsWith(join("components", "ui", "SaveForm.tsx"))),
  "SaveForm.tsx, the module #2690 called into, is read as a client module",
);

const serverFiles = files.filter((f) => !clientFiles.includes(f));
const findings = scanFilesForClientBoundaryCalls(serverFiles, SRC, (f) => relative(ROOT, f));
for (const f of findings) {
  console.error(
    `  ${f.file}:${f.line} calls ${f.callee}() from "${f.from}", a "use client" module, on the server. ` +
      `Mark the calling file "use client", compute the value without the client module, or add ` +
      `// client-boundary-ok: <reason>.`,
  );
}
eq(findings.length, 0, "no server file calls a function imported from a \"use client\" module");

finish();
