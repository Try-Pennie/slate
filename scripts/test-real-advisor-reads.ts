// Repo invariant (#4201): every LIST read of `users` declares whether the
// placeholder advisor and the test advisors belong in it.
// Run: node --experimental-strip-types scripts/test-real-advisor-reads.ts
//
// The placeholder advisor (#4200) is a real `users` row that holds the calls a
// coordinator stacks when nobody is free. Its bookings are real and keep showing
// wherever bookings are listed; the ADVISOR must not appear on any advisor screen,
// picker, pool, default schedule, sync or monitor. Each of those kept the test
// advisors out with its own `.eq("is_test", false)`, which the placeholder walks
// straight past, so the rule moved into one module and this guard makes every new
// list read either use it or say why not.
//
// The scan lives in scripts/lib/scan-real-advisor-reads.ts. This file is the
// positive control, a real file mutation control, and the invariant.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { scanRealAdvisorReads, EXTRA_SCOPE, REAL_ADVISOR_MODULE } from "./lib/scan-real-advisor-reads.ts";
import { assert, eq, finish } from "./lib/harness.ts";

const ROOT = join(import.meta.dirname, "..");

// --- positive control ---------------------------------------------------------

interface Fixture {
  name: string;
  flagged: boolean;
  code: string;
}

const FIXTURES: Fixture[] = [
  {
    name: "a roster read with no declaration",
    flagged: true,
    code: `const rows = unwrap(await db.from("users").select("id, name").eq("org_id", orgId), "roster");`,
  },
  {
    name: "the old test only exclusion, which the placeholder walks past",
    flagged: true,
    code: `
      const { data } = await db
        .from("users")
        .select("*")
        .eq("org_id", orgId)
        .eq("is_test", false);
    `,
  },
  {
    name: "a test only exclusion is refused even inside the helper",
    flagged: true,
    code: `realAdvisorsOnly(db.from("users").select("*").eq("is_test", false));`,
  },
  {
    name: "a long select cannot push the chain out of view",
    flagged: true,
    code: `
      const rows = await db
        .from("users")
        .select(
          [
            "id",
            "name",
            "email",
            "role",
            "bookable",
            "deactivated_at",
            "timezone",
            "attributes",
            "salesforce_user_id",
            "manager_id",
          ].join(", "),
        )
        .eq("org_id", orgId);
    `,
  },
  {
    name: "a bare opt out says nothing, so it excuses nothing",
    flagged: true,
    code: `
      // any-advisor-ok:
      const rows = await db.from("users").select("id").eq("org_id", orgId);
    `,
  },
  {
    name: "a comment naming the helper cannot satisfy the guard",
    flagged: true,
    code: `
      // was realAdvisorsOnly(db.from("users")) before
      const rows = await db.from("users").select("id").eq("org_id", orgId);
    `,
  },
  {
    name: "the query helper",
    flagged: false,
    code: `const rows = unwrap(await realAdvisorsOnly(db.from("users").select("id").eq("org_id", orgId)), "r");`,
  },
  {
    name: "the query helper wrapping a multi line chain",
    flagged: false,
    code: `
      const rows = await realAdvisorsOnly(
        db
          .from("users")
          .select("id, name")
          .eq("org_id", orgId),
      );
    `,
  },
  {
    name: "the predicate's columns, for rows judged in code",
    flagged: false,
    code: "const rows = await db.from(\"users\").select(`id, name, ${REAL_ADVISOR_COLUMNS}`);",
  },
  {
    name: "a primary key lookup names its subject",
    flagged: false,
    code: `const row = await db.from("users").select("name").eq("id", userId).maybeSingle();`,
  },
  {
    name: "a key set lookup names its subjects",
    flagged: false,
    code: `const rows = await db.from("users").select("name").in("id", ids);`,
  },
  {
    name: "a sign in lookup by email names its subject",
    flagged: false,
    code: `const row = await db.from("users").select("*").eq("email", email).maybeSingle();`,
  },
  {
    name: "a write is not a read",
    flagged: false,
    code: `await db.from("users").update({ bookable: false }).eq("org_id", orgId);`,
  },
  {
    name: "the opt out above the statement, with a reason",
    flagged: false,
    code: `
      // any-advisor-ok: the name map labels every advisor a booking can name,
      // the placeholder and the test advisors included.
      const { data } = await db
        .from("users")
        .select("id, name");
    `,
  },
  {
    name: "the opt out above the from line, with a reason",
    flagged: false,
    code: `
      const { data } = await db
        // any-advisor-ok: every advisor a booking can name.
        .from("users")
        .select("id, name");
    `,
  },
];

for (const f of FIXTURES) {
  const found = scanRealAdvisorReads(f.code, f.name).length > 0;
  eq(found, f.flagged, `${f.flagged ? "FLAGS" : "allows"}: ${f.name}`);
}

// The shared module is the one place allowed to spell the filters.
eq(
  scanRealAdvisorReads(readFileSync(join(ROOT, REAL_ADVISOR_MODULE), "utf8"), REAL_ADVISOR_MODULE),
  [],
  "the shared module itself is exempt",
);

// --- the invariant ------------------------------------------------------------

function tsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...tsFiles(full));
    else if (/\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry)) out.push(full);
  }
  return out;
}

const scoped = [...tsFiles(join(ROOT, "src")).map((f) => relative(ROOT, f)), ...EXTRA_SCOPE];
const withUsers = scoped.filter((f) => readFileSync(join(ROOT, f), "utf8").includes('.from("users")'));
assert(withUsers.length > 40, `the sweep found the files that read users (${withUsers.length})`);

const offenders = scoped.flatMap((file) => scanRealAdvisorReads(readFileSync(join(ROOT, file), "utf8"), file));
eq(
  offenders.map((o) => `${o.file}:${o.line} [${o.kind}] ${o.snippet}`),
  [],
  "every list read of users applies the real advisor rule or says why it does not",
);

// --- real file mutation controls ---------------------------------------------
{
  // An empty sweep reads exactly like a clean tree whether or not the detector
  // still matches anything (L1), so unwrap a real converted read and require it
  // to be caught, then put the old test only filter back and require that too.
  const file = "src/lib/monitor/tier-staffing-load.ts";
  const real = readFileSync(join(ROOT, file), "utf8");
  assert(real.includes("realAdvisorsOnly("), "sanity: the file this control mutates uses the helper");
  eq(scanRealAdvisorReads(real, file), [], "sanity: and is clean as it stands");

  const unwrapped = real.replaceAll("realAdvisorsOnly(", "(");
  assert(
    scanRealAdvisorReads(unwrapped, file).some((f) => f.kind === "undeclared"),
    "removing the helper from a real read IS caught",
  );

  // `realAdvisorsOnly(<chain>)` back to `<chain>.eq("is_test", false)`, the shape
  // every one of these reads had before #4201.
  const at = real.indexOf("realAdvisorsOnly(");
  const open = at + "realAdvisorsOnly(".length - 1;
  let depth = 0;
  let close = open;
  for (let i = open; i < real.length; i++) {
    if (real[i] === "(") depth++;
    else if (real[i] === ")" && --depth === 0) {
      close = i;
      break;
    }
  }
  const reverted =
    real.slice(0, at) + real.slice(open + 1, close).trimEnd().replace(/,$/, "") + '.eq("is_test", false)' + real.slice(close + 1);
  assert(reverted.includes('.eq("is_test", false)'), "sanity: the mutation put the old filter back");
  assert(
    scanRealAdvisorReads(reverted, file).some((f) => f.kind === "test-only"),
    "putting back a test only exclusion IS caught",
  );
}

finish();
