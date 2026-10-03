// pnpm's version is pinned exactly, in one place (#2261, #3128).
//
// #2261: `loadtest.yml` shipped ten `pnpm/action-setup` steps that could not resolve
// a version, and nothing saw it because the workflow is dispatch only. The fix then
// was `version: 10` on every step, which resolves to the newest 10.x on the day a job
// runs, while a laptop keeps whatever pnpm it was installed with, so the minor that
// resolves the lockfile drifted between CI and the machines writing it (#3128).
//
// Now package.json carries an exact `packageManager: pnpm@X.Y.Z`, the action reads
// it, and no step names a version of its own: a second place is a second thing to
// keep in step, and the action refuses a step whose version disagrees with the key.
//
// Run: node --experimental-strip-types scripts/test-pnpm-setup-pin.ts
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  allPnpmSetups,
  exactPnpmPin,
  pnpmSetupsNamingAVersion,
} from "./lib/scan-pnpm-setup-pin.ts";
import { assert, eq, fail, finish } from "./lib/harness.ts";

const ROOT = join(import.meta.dirname, "..");
const DIR = join(ROOT, ".github/workflows");

const files = readdirSync(DIR)
  .filter((f) => f.endsWith(".yml") || f.endsWith(".yaml"))
  .map((f) => ({ name: f, yaml: readFileSync(join(DIR, f), "utf8") }));

const pkg = readFileSync(join(ROOT, "package.json"), "utf8");

// --- the real tree ------------------------------------------------------------

{
  assert(files.length > 3, `the scan really read the workflows (${files.length} files)`);
  // Counted by the scanner itself, so a scanner that matched nothing would fail
  // here rather than report every workflow clean (L98).
  const steps = allPnpmSetups(files);
  assert(steps.length >= 10, `and found the action-setup steps they use (${steps.length})`);
}

{
  const pin = exactPnpmPin(pkg);
  if (pin.ok) {
    assert(/^\d+\.\d+\.\d+$/.test(pin.version), `package.json pins pnpm exactly (${pin.version})`);
  } else {
    fail(
      `package.json must carry "packageManager": "pnpm@X.Y.Z" with one exact release ` +
        `(${pin.reason}${pin.got ? `: ${pin.got}` : ""}). Without it CI resolves the newest pnpm ` +
        `of a major while laptops keep their own, and the lockfile drifts between them.`,
    );
  }
}

{
  const found = pnpmSetupsNamingAVersion(files);
  if (found.length === 0) {
    assert(true, "no pnpm/action-setup step names a version of its own");
  } else {
    for (const s of found) {
      fail(
        `${s.file}:${s.line} gives pnpm/action-setup its own version. The version lives in ` +
          `package.json's packageManager key; delete this step's \`with: version:\` so there is ` +
          `one place to change it, and so the action cannot refuse the step over a mismatch.`,
      );
    }
  }
}

// --- positive controls --------------------------------------------------------

{
  // Both directions of the pin (L159).
  eq(exactPnpmPin('{"packageManager":"pnpm@10.33.0"}').ok, true, "an exact release is a pin");
  eq(
    exactPnpmPin('{"packageManager":"pnpm@10.33.0+sha512.abc123"}').ok,
    true,
    "and so is one carrying corepack's integrity suffix",
  );
  const major = exactPnpmPin('{"packageManager":"pnpm@10"}');
  eq(major.ok ? "pinned" : major.reason, "not-exact", "a bare major is the drift itself");
  const range = exactPnpmPin('{"packageManager":"pnpm@^10.33.0"}');
  eq(range.ok ? "pinned" : range.reason, "not-exact", "as is a range");
  const yarn = exactPnpmPin('{"packageManager":"yarn@4.1.0"}');
  eq(yarn.ok ? "pinned" : yarn.reason, "not-pnpm", "another package manager is not a pnpm pin");
  const none = exactPnpmPin('{"name":"slate"}');
  eq(none.ok ? "pinned" : none.reason, "absent", "a package.json with no key is not pinned");
  const bad = exactPnpmPin("not json");
  eq(bad.ok ? "pinned" : bad.reason, "unreadable", "and an unreadable one says so on its own reason");
}

{
  // The shape every workflow carried before #3128.
  const withVersion = [
    {
      name: "fake.yml",
      yaml: [
        "    steps:",
        "      - uses: actions/checkout@abc # v6",
        "      - uses: pnpm/action-setup@0977fd99 # v6",
        "        with:",
        "          version: 10",
        "      - uses: actions/setup-node@def # v6",
      ].join("\n"),
    },
  ];
  const found = pnpmSetupsNamingAVersion(withVersion);
  eq(found.length, 1, "a step naming its own version is caught");
  eq(found[0]!.line, 3, "and the report points at the step");
}

{
  // The trap: `node-version:` on the NEXT step contains the word "version", so a
  // naive scan would read it as this step's input.
  const found = pnpmSetupsNamingAVersion([
    {
      name: "f.yml",
      yaml: [
        "      - uses: pnpm/action-setup@abc # v6",
        "      - uses: actions/setup-node@def # v6",
        "        with:",
        "          node-version: 24",
      ].join("\n"),
    },
  ]);
  eq(found.length, 0, "a later step's node-version is not this step's version");
}

{
  // Prose is not a step.
  const commented = [
    { name: "f.yml", yaml: "      # to carry pnpm/action-setup, setup-node with the pnpm cache" },
  ];
  eq(allPnpmSetups(commented).length, 0, "a comment naming the action is not a step");
}

{
  // An overlay of the REAL tree, so the scanner is proved against the files it
  // protects and not only a fixture nobody maintains. A `version: 10` is put back
  // under every action-setup step of the actual loadtest.yml in memory (nothing is
  // written), and every one must be caught. The step line is matched whatever
  // follows the ref, so a Dependabot rewrite of the SHA or its comment cannot turn
  // the overlay into a no-op (#2492).
  const real = files.find((f) => f.name === "loadtest.yml");
  assert(real !== undefined, "loadtest.yml is there to overlay");
  const steps = (real!.yaml.match(/pnpm\/action-setup@/g) ?? []).length;
  assert(steps >= 5, `and it really uses the action a lot (${steps} steps)`);
  let added = 0;
  const planted = real!.yaml.replace(
    /^( +)(- uses: pnpm\/action-setup@[^\n]*\n)/gm,
    (_m, indent: string, step: string) => {
      added++;
      return `${indent}${step}${indent}  with:\n${indent}    version: 10\n`;
    },
  );
  eq(added, steps, "the overlay planted a version under every step");
  eq(
    pnpmSetupsNamingAVersion([{ name: "loadtest.yml", yaml: planted }]).length,
    steps,
    "and every planted version in the real file is caught",
  );
}

finish();
