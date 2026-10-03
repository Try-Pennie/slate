// Every `pnpm/action-setup` step can resolve a pnpm version (#2261).
//
// Slate's package.json carries no `packageManager` key, so a step with no
// `version:` fails immediately with "No pnpm version is specified" and takes its
// whole job with it, before anything the job was written to do.
//
// `loadtest.yml` shipped with TEN of them. Nothing could see it: the workflow is
// dispatch-only, so its first execution was the first time any of those jobs had
// started, and every one died in setup having measured nothing.
//
// Run: node --experimental-strip-types scripts/test-pnpm-setup-pin.ts
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { unpinnedPnpmSetups, packageManagerPinned } from "./lib/scan-pnpm-setup-pin.ts";
import { assert, eq, fail, finish } from "./lib/harness.ts";

const ROOT = join(import.meta.dirname, "..");
const DIR = join(ROOT, ".github/workflows");

const files = readdirSync(DIR)
  .filter((f) => f.endsWith(".yml") || f.endsWith(".yaml"))
  .map((f) => ({ name: f, yaml: readFileSync(join(DIR, f), "utf8") }));

const pkg = readFileSync(join(ROOT, "package.json"), "utf8");
const pinnedGlobally = packageManagerPinned(pkg);

// --- the real tree ------------------------------------------------------------

{
  assert(files.length > 3, `the scan really read the workflows (${files.length} files)`);
  const uses = files.filter((f) => /uses:\s*pnpm\/action-setup@/.test(f.yaml));
  assert(uses.length > 0, "and at least one workflow really uses the action");
}

{
  const found = unpinnedPnpmSetups(files, pinnedGlobally);
  if (found.length === 0) {
    assert(true, "every pnpm/action-setup step can resolve a version");
  } else {
    for (const u of found) {
      fail(
        `${u.file}:${u.line} uses pnpm/action-setup with no version. package.json carries no ` +
          `packageManager key, so this step fails with "No pnpm version is specified" and takes ` +
          `its whole job with it. Add "with: { version: 10 }", as ci.yml does.`,
      );
    }
  }
}

{
  // The premise. If somebody adds a `packageManager` key, this guard correctly goes
  // quiet, and stating it here means the reason is visible rather than the guard
  // silently covering nothing (L98).
  eq(
    pinnedGlobally,
    false,
    "package.json pins no packageManager, which is WHY each step must carry its own version",
  );
}

// --- positive controls --------------------------------------------------------

{
  // The exact shape loadtest.yml shipped with, ten times over.
  const bad = [
    {
      name: "fake.yml",
      yaml: [
        "    steps:",
        "      - uses: actions/checkout@abc # v6",
        "      - uses: pnpm/action-setup@0977fd99 # v6",
        "      - uses: actions/setup-node@def # v6",
        "        with:",
        "          node-version: 24",
        "          cache: pnpm",
      ].join("\n"),
    },
  ];
  const found = unpinnedPnpmSetups(bad, false);
  eq(found.length, 1, "a control catches the shape loadtest.yml shipped with");
  eq(found[0]!.line, 3, "and points at the step, not at the node-version below it");
}

{
  // The trap that made a first attempt at this miss: `node-version:` on the NEXT
  // step contains the word "version", so a naive scan reads it as the pin.
  const found = unpinnedPnpmSetups(
    [
      {
        name: "f.yml",
        yaml: [
          "      - uses: pnpm/action-setup@abc # v6",
          "      - uses: actions/setup-node@def # v6",
          "        with:",
          "          node-version: 24",
        ].join("\n"),
      },
    ],
    false,
  );
  eq(found.length, 1, "a later step's node-version does not count as this step's pin");
}

{
  // Both directions (L159): a properly pinned step is silent, so the control above
  // is about the missing pin rather than about the action being present at all.
  const good = [
    {
      name: "f.yml",
      yaml: [
        "      - uses: pnpm/action-setup@abc # v6",
        "        with:",
        "          version: 10",
        "      - uses: actions/setup-node@def # v6",
      ].join("\n"),
    },
  ];
  eq(unpinnedPnpmSetups(good, false).length, 0, "a pinned step is not reported");
}

{
  // Prose is not a step. Two workflows explain in comments why they deliberately
  // carry no install, and naming the action is how they explain it.
  const commented = [
    {
      name: "f.yml",
      yaml: "      # to carry pnpm/action-setup, setup-node with the pnpm cache and an install",
    },
  ];
  eq(unpinnedPnpmSetups(commented, false).length, 0, "a comment naming the action is not a step");
}

{
  // A packageManager key resolves every step at once, so the guard goes quiet.
  const bad = [{ name: "f.yml", yaml: "      - uses: pnpm/action-setup@abc # v6" }];
  eq(unpinnedPnpmSetups(bad, true).length, 0, "a packageManager key silences it");
  assert(packageManagerPinned('{"packageManager":"pnpm@10.0.0"}'), "and that key is recognised");
  assert(
    packageManagerPinned('{"devEngines":{"packageManager":{"name":"pnpm"}}}'),
    "as is the devEngines form",
  );
  assert(!packageManagerPinned('{"name":"slate"}'), "a package.json with neither is not pinned");
  assert(!packageManagerPinned("not json"), "and an unreadable one reports rather than goes quiet");
}

{
  // An overlay of the REAL tree, which is what keeps this from rotting into a
  // check on a fixture nobody maintains. The pins are stripped out of the actual
  // loadtest.yml in memory (nothing is written), and every one of them must be
  // caught: a guard proved only against a hand written three line fixture can
  // drift away from the file it exists to protect.
  const real = files.find((f) => f.name === "loadtest.yml");
  assert(real !== undefined, "loadtest.yml is there to overlay");
  const pinned = (real!.yaml.match(/pnpm\/action-setup@/g) ?? []).length;
  assert(pinned >= 5, `and it really uses the action a lot (${pinned} steps)`);
  // The step line is matched whatever follows the ref, so the overlay does not
  // depend on the SHA or on the version comment Dependabot rewrites beside it. It
  // used to match a literal "# v6", and the first bump to "# v6.1.0" (#2492)
  // turned the overlay into a no-op that failed for a reason unrelated to pins.
  let removed = 0;
  const stripped = real!.yaml.replace(
    /( +- uses: pnpm\/action-setup@[^\n]*\n)( +with:\n +version: [^\n]+\n)/g,
    (_m, step: string) => {
      removed++;
      return step;
    },
  );
  assert(stripped !== real!.yaml, "the overlay really removed something");
  eq(removed, pinned, "and it stripped the pin from every step, not only some of them");
  const found = unpinnedPnpmSetups([{ name: "loadtest.yml", yaml: stripped }], false);
  eq(found.length, pinned, "every unpinned step in the real file is caught");
}

finish();
