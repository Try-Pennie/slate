// Repo invariant (#3172): no `"use client"` module reaches the secret key Supabase
// client, directly or through any chain of imports.
//
// What happened: `BookingLookup` (/admin/bookings) imported `SEARCH_LIMIT` from
// `src/lib/booking/search.ts`, and `ReasonOptionsEditor` (/admin/booking-reasons)
// imported `REASON_LABEL_MAX`, `slugifyCode` and `REASON_USAGE_WINDOW_DAYS` from
// `reason-options.ts` and `reason-usage.ts`. Each of those modules also imports
// `@/lib/supabase/admin`, and a bundler follows the whole module, so the admin
// client and its `SUPABASE_SECRET_KEY` read shipped in a browser chunk; the shared
// env chunk carrying the read was loaded by /login too. Measured from a real
// `next build` on 2026-10-03. The secret's value was never in it, because the read
// only runs server side, so every page worked and nothing could notice.
//
// tsc cannot see it (the import is legal), vitest cannot (jsdom has no bundle), and
// the client asset scan in `cf:build` matches deployment setting NAMES, which did not
// include this one. So this guard walks the runtime import graph of every
// `"use client"` module under `src/` and fails on any chain ending at a module in
// `SERVER_ONLY_MODULES`, naming every hop so the fix (move the constant into a pure
// module) is obvious from the message.
//
// There is no escape hatch: a client component has no legitimate reason to carry
// the secret key client.
//
// BOUNDARY, stated so this is not read as wider coverage than it has:
//   - Only imports that resolve INSIDE the repo are followed (`@/...` and relative).
//     A package is never walked into.
//   - The walk stops at a `"use server"` module: its exports reach a client as action
//     references, never as code.
//   - Test files are out of scope; they are never bundled for a browser.
// Run: node --experimental-strip-types scripts/test-client-admin-reach.ts
import { readdirSync, readFileSync, statSync, existsSync } from "node:fs";
import { join } from "node:path";
import {
  SERVER_ONLY_MODULES,
  describeClientAdminReach,
  hasUseServerDirective,
  runtimeImportSpecifiers,
  scanClientAdminReach,
  type ReachIo,
} from "./lib/scan-client-admin-reach.ts";
import { hasUseClientDirective } from "./lib/scan-client-boundary-calls.ts";
import { assert, eq, finish } from "./lib/harness.ts";

const ROOT = join(import.meta.dirname, "..");
const SRC = join(ROOT, "src");
const FORBIDDEN = SERVER_ONLY_MODULES.map((m) => join(SRC, m));

// --- what counts as a runtime import ------------------------------------------

eq(runtimeImportSpecifiers(`import { a } from "./a";`), ["./a"], "a value import is followed");
eq(runtimeImportSpecifiers(`import type { A } from "./a";`), [], "import type is erased");
eq(runtimeImportSpecifiers(`import { type A, type B } from "./a";`), [], "an all type named import is erased");
eq(runtimeImportSpecifiers(`import { type A, b } from "./a";`), ["./a"], "a mixed import still pulls the module");
eq(runtimeImportSpecifiers(`import "./side";`), ["./side"], "a side effect import is followed");
eq(runtimeImportSpecifiers(`import * as ns from "./ns";`), ["./ns"], "a namespace import is followed");
eq(runtimeImportSpecifiers(`export { x } from "./x";`), ["./x"], "a value re-export is followed");
eq(runtimeImportSpecifiers(`export type { X } from "./x";`), [], "a type re-export is erased");
eq(runtimeImportSpecifiers(`export * from "./all";`), ["./all"], "a star re-export is followed");
eq(runtimeImportSpecifiers(`const m = await import("./lazy");`), ["./lazy"], "a dynamic import is followed");
eq(
  runtimeImportSpecifiers(`// import { a } from "./commented";\nconst s = 'import x from "./str"';`),
  [],
  "a comment or a string that looks like an import is not one",
);
assert(hasUseServerDirective(`"use server";\nexport async function a() {}`), "use server is read");
assert(!hasUseServerDirective(`"use client";\nexport const a = 1;`), "use client is not use server");

// --- synthetic graphs ---------------------------------------------------------

function memIo(files: Record<string, string>): ReachIo {
  return {
    readFile: (p) => {
      if (!(p in files)) throw new Error(`ENOENT ${p}`);
      return files[p];
    },
    exists: (p) => p in files,
  };
}

const R = "/r/src";
const ADMIN = `${R}/lib/supabase/admin.ts`;
const base: Record<string, string> = {
  [ADMIN]: `import { createClient } from "@supabase/supabase-js";\nexport const supabaseAdmin = () => createClient();`,
  [`${R}/lib/search.ts`]: `import { supabaseAdmin } from "../lib/supabase/admin.ts";\nexport const SEARCH_LIMIT = 20;`,
  [`${R}/lib/pure.ts`]: `export const LIMIT = 20;`,
  [`${R}/lib/middle.ts`]: `export { SEARCH_LIMIT } from "@/lib/search";`,
  [`${R}/app/actions.ts`]: `"use server";\nimport { supabaseAdmin } from "@/lib/supabase/admin";\nexport async function save() {}`,
};
const scanFixture = (entry: string, src: string) =>
  scanClientAdminReach({
    entries: [`${R}/components/${entry}.tsx`],
    srcRoot: R,
    forbidden: [ADMIN],
    io: memIo({ ...base, [`${R}/components/${entry}.tsx`]: src }),
  });

{
  const f = scanFixture("Lookup", `"use client";\nimport { SEARCH_LIMIT } from "@/lib/search";`);
  eq(f.length, 1, "the #3172 shape: a constant imported from a module that imports admin is caught");
  eq(
    f[0]?.chain,
    [`${R}/components/Lookup.tsx`, `${R}/lib/search.ts`, ADMIN],
    "the finding names every hop of the chain",
  );
}
eq(
  scanFixture("Deep", `"use client";\nimport { SEARCH_LIMIT } from "@/lib/middle";`).length,
  1,
  "a chain through a re-exporting module is caught",
);
eq(
  scanFixture("Direct", `"use client";\nimport { supabaseAdmin } from "@/lib/supabase/admin";`).length,
  1,
  "a direct import of the admin module is caught",
);
eq(
  scanFixture("Lazy", `"use client";\nconst m = () => import("@/lib/search");`).length,
  1,
  "a dynamic import is caught",
);
eq(
  scanFixture("Pure", `"use client";\nimport { LIMIT } from "@/lib/pure";`).length,
  0,
  "the fix: a constant from a pure module reaches nothing",
);
eq(
  scanFixture("Typed", `"use client";\nimport type { Row } from "@/lib/search";`).length,
  0,
  "a type only import reaches nothing",
);
eq(
  scanFixture("Form", `"use client";\nimport { save } from "@/app/actions";`).length,
  0,
  "a server action module is a boundary, not a path",
);
eq(
  scanClientAdminReach({
    entries: [`${R}/lib/search.ts`],
    srcRoot: R,
    forbidden: [ADMIN],
    io: memIo(base),
  }).length,
  0,
  "a server module is not an entry",
);

// --- the real tree --------------------------------------------------------------

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...sourceFiles(p));
    else if (/\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(p);
  }
  return out;
}

for (const f of FORBIDDEN) assert(existsSync(f), `${f.slice(ROOT.length + 1)} exists, so the guard is aimed at a real module`);

const files = sourceFiles(SRC);
const clientEntries = files.filter((f) => hasUseClientDirective(readFileSync(f, "utf8")));
assert(clientEntries.length > 20, `the walk starts from the tree's client modules (${clientEntries.length} found)`);

const findings = scanClientAdminReach({ entries: clientEntries, srcRoot: SRC, forbidden: FORBIDDEN });
assert(
  findings.length === 0,
  findings.length === 0
    ? "no client module reaches the secret key Supabase client"
    : `client modules reach the secret key Supabase client, so it ships in a browser chunk. ` +
        `Move what the client needs into a module that imports no server code:\n` +
        describeClientAdminReach(findings, ROOT),
);

// --- positive control on the real tree -------------------------------------------
// Put back the import #3172 removed, in memory, and require the guard to catch it
// and blame the right chain. Without this, a walk that silently resolved nothing
// would pass the clean tree above for the wrong reason.
{
  const lookup = join(SRC, "components/BookingLookup.tsx");
  const real = readFileSync(lookup, "utf8");
  const reverted = real.replace(
    /import \{ SEARCH_LIMIT \} from "[^"]+";/,
    `import { SEARCH_LIMIT } from "@/lib/booking/search";`,
  );
  assert(reverted !== real, "the control found the SEARCH_LIMIT import to revert");
  const overlay: ReachIo = {
    readFile: (p) => (p === lookup ? reverted : readFileSync(p, "utf8")),
    exists: (p) => existsSync(p),
  };
  const caught = scanClientAdminReach({ entries: [lookup], srcRoot: SRC, forbidden: FORBIDDEN, io: overlay });
  eq(
    caught[0]?.chain.map((p) => p.slice(SRC.length + 1)),
    ["components/BookingLookup.tsx", "lib/booking/search.ts", "lib/supabase/admin.ts"],
    "control: reverting BookingLookup to import from search.ts is caught through the real chain",
  );
}

finish();
