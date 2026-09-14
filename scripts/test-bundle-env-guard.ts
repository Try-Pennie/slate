// The build refuses to ship production's settings inside the Worker bundle (#2335).
//
// `@opennextjs/cloudflare`'s build step reads every `.env*` file in the build tree
// and writes their values into `.open-next/cloudflare/next-env.mjs`, which ships
// inside the bundle; at runtime `populateProcessEnv` applies the Worker's own
// bindings first and then fills in every name they did NOT set from that file. So a
// build run in a tree holding a copy of `.env.local` deploys production's
// credentials, whatever environment it is deployed to. On 2026-09-14 that put a live
// Slack token on the load test Worker and paged the real alerts channel for six
// minutes about a roster that did not exist.
//
// This drives the DECISION with fixtures only. It deliberately does not read the
// real `.open-next`: the pre-push gate runs the suite CONCURRENTLY with the build
// that writes it, so a check reading that tree would have one verdict before the
// build and another after, and CI would only ever see one of them (L461). The real
// file is read by `scripts/check-bundle-env.ts`, which runs AFTER the build as part
// of `pnpm cf:build`.
//
// Run: node --experimental-strip-types scripts/test-bundle-env-guard.ts
import { readFileSync } from "node:fs";
import { judgeBundleEnv, judgeClientAssets, secretNamesInAssets } from "./lib/scan-bundle-env.ts";
import { assert, eq, finish } from "./lib/harness.ts";

const SECRET = "xoxb-a-value-that-must-never-be-printed";

function file(modes: Record<string, Record<string, string>>): string {
  return Object.entries(modes)
    .map(([mode, vars]) => `export const ${mode} = ${JSON.stringify(vars)};`)
    .join("\n");
}

const EMPTY = file({ production: {}, development: {}, test: {} });

// --- what a clean build looks like --------------------------------------------

{
  // The quiet direction, and it is every CI build and every pre-push gate: a tree
  // with no `.env*` files produces three empty objects. If this ever refused, the
  // gate and the deploy would both be down.
  const v = judgeBundleEnv({ source: EMPTY, envFiles: [] });
  assert(v.ok, `an empty bundle env is clean, got ${v.message}`);
  eq(v.offenders.length, 0, "and names no offenders");
}

{
  // `NEXT_PUBLIC_*` is the one thing that legitimately travels in a bundle: Next
  // inlines those at build time by design and they are public by definition.
  const v = judgeBundleEnv({
    source: file({
      production: {
        NEXT_PUBLIC_APP_URL: "https://slate.trypennie.app",
        NEXT_PUBLIC_SUPABASE_URL: "https://ref.supabase.co",
      },
      development: {},
      test: {},
    }),
    envFiles: [".env"],
  });
  assert(v.ok, `public build-time values are allowed, got ${v.message}`);
}

// --- the incident, reproduced --------------------------------------------------

{
  const v = judgeBundleEnv({
    source: file({
      production: { SLACK_BOT_TOKEN: SECRET, NEXT_PUBLIC_APP_URL: "https://x" },
      development: {},
      test: {},
    }),
    envFiles: [".env.local"],
  });
  assert(!v.ok, "a bundle carrying a Slack token is refused");
  eq(v.offenders.join(","), "SLACK_BOT_TOKEN", "and the offender is named");
  assert(
    !v.message.includes(SECRET),
    "and the VALUE is never printed, which would put the credential in the build log it is read from",
  );
  assert(
    v.message.includes(".env.local"),
    "and the message names the file the values came from, which is what somebody removes",
  );
  assert(
    !v.message.includes("NEXT_PUBLIC_APP_URL"),
    "and a public value beside it is not accused",
  );
}

{
  // Every mode, not just production. `development` and `test` ship in the same file
  // and `NEXTJS_ENV` decides which one the runtime applies, so a secret in either is
  // a secret in the bundle.
  const v = judgeBundleEnv({
    source: file({ production: {}, development: { SF_CLIENT_SECRET: SECRET }, test: {} }),
    envFiles: [],
  });
  assert(!v.ok, "a secret in the development mode is refused too");
  eq(v.offenders.join(","), "SF_CLIENT_SECRET", "and named");
  assert(v.message.includes("development"), "and the mode it travels in is named");
}

{
  // Every offender, not the first. The real case carries two dozen at once and a
  // message naming one reads as a stray setting somebody can unset.
  const v = judgeBundleEnv({
    source: file({
      production: { SLACK_BOT_TOKEN: SECRET, GOOGLE_SA_PRIVATE_KEY: SECRET, CRON_SECRET: SECRET },
      development: {},
      test: {},
    }),
    envFiles: [],
  });
  eq(v.offenders.length, 3, "all three offenders are named");
}

// --- learning nothing is never a pass (L98) ------------------------------------

{
  // The adapter writes this file on every build, so its absence means the build did
  // not run or wrote somewhere else. Passing here would make "nothing was checked"
  // and "nothing was wrong" the same outcome.
  const v = judgeBundleEnv({ source: null, envFiles: [] });
  assert(!v.ok, "a missing bundle env file is refused rather than passed");
  eq(v.reason, "missing", "on its own reason");
}

{
  const v = judgeBundleEnv({ source: "export const production = not json;", envFiles: [] });
  assert(!v.ok, "a file this cannot read is refused");
  eq(v.reason, "unreadable", "on a reason of its own, distinct from an absent file (L11)");
}

{
  // A file that exists and declares no mode at all is not an empty environment, it
  // is a file whose shape changed under us.
  const v = judgeBundleEnv({ source: "// nothing here\n", envFiles: [] });
  assert(!v.ok, "a file declaring no mode is refused");
  eq(v.reason, "unreadable", "as unreadable, since an adapter change reads exactly like this");
}

// --- the guard is WIRED, not merely written (L3) -------------------------------

{
  const pkg = JSON.parse(readFileSync("package.json", "utf8")) as {
    scripts: Record<string, string>;
  };
  assert(
    pkg.scripts["cf:build"].includes("check-bundle-env"),
    `cf:build must run the check, or every deploy path is unguarded; got ${pkg.scripts["cf:build"]}`,
  );
  // AFTER the build, not before: the file it reads is one the build writes.
  const [before, after] = pkg.scripts["cf:build"].split("&&");
  assert(
    before.includes("opennextjs-cloudflare build") && after.includes("check-bundle-env"),
    "and it must run AFTER the build, whose output is the file it reads",
  );
}

// --- the second question: does the CLIENT bundle NAME any of them? -------------
//
// Not the same fault, and it needs saying: a VALUE in the bundle is a credential,
// a NAME in a browser chunk is the inventory of what Slate integrates with. Only a
// real build can answer it, because the names are in the source either way and
// nothing but the build says which bundle a module landed in (L3).
//
// It exists because the first version of the #2335 runtime refusal put the whole
// list into `publicSupabaseUrl()`, which the browser Supabase client also calls,
// and all twenty three names shipped in a public `_next/static` chunk.

const NAMES = ["SLACK_BOT_TOKEN", "TWILIO_API_KEY_SECRET"];

{
  // The quiet direction, and it is every build: ordinary client chunks name none of
  // them. A guard that fired here would block every push.
  const v = judgeClientAssets({
    files: [
      { path: "chunks/a.js", text: 'const x="NEXT_PUBLIC_APP_URL";' },
      { path: "chunks/b.js", text: "export function Booker(){}" },
    ],
    names: NAMES,
  });
  assert(v.ok, `clean client chunks pass, got ${v.message}`);
  assert(v.message.includes("2 client asset"), "and the count scanned is reported");
}

{
  const v = judgeClientAssets({
    files: [
      { path: "chunks/ok.js", text: "nothing to see" },
      { path: "chunks/leaky.js", text: '["SLACK_BOT_TOKEN","TWILIO_API_KEY_SECRET"]' },
    ],
    names: NAMES,
  });
  assert(!v.ok, "a chunk naming a deployment setting is refused");
  eq(v.offenders.sort().join(","), "SLACK_BOT_TOKEN,TWILIO_API_KEY_SECRET", "every name is reported");
  assert(v.message.includes("chunks/leaky.js"), "and the file, which is what somebody opens");
  assert(!v.message.includes("chunks/ok.js"), "and not the file that was clean");
}

{
  // The same name in two chunks is two places to look, so both are named rather
  // than deduplicated into one line about a name.
  const hits = secretNamesInAssets(
    [
      { path: "a.js", text: "SLACK_BOT_TOKEN" },
      { path: "b.js", text: "SLACK_BOT_TOKEN" },
    ],
    NAMES,
  );
  eq(hits.length, 2, "a name in two chunks is two hits");
  eq(hits.map((h) => h.file).join(","), "a.js,b.js", "each naming its own file");
}

{
  // Learning nothing is never a pass (L98). Every build writes client chunks, so an
  // empty scan is a build that did not finish or one that wrote somewhere else, and
  // passing would make "scanned nothing" and "found nothing" the same outcome.
  const v = judgeClientAssets({ files: [], names: NAMES });
  assert(!v.ok, "scanning no assets at all is refused");
  eq(v.reason, "missing", "on the reason that says so");
}

{
  // An empty NAME list would match everything or nothing depending on the matcher,
  // and here it means there is nothing to look for: that must not read as a clean
  // bundle either, but it is the caller's constant rather than the tree's state, so
  // it is asserted here rather than left to a reader of the message.
  eq(
    secretNamesInAssets([{ path: "a.js", text: "SLACK_BOT_TOKEN" }], []).length,
    0,
    "no names to look for finds nothing",
  );
}

finish();
