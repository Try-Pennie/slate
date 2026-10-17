// Repo invariant (#3883): the packages copied into many route chunks are declared
// server externals, so the Worker carries ONE copy of each.
//
// Turbopack bundles a package into every server route chunk that imports it. Zod
// (624KB) was in eight of them, so about 4.4MB of the 26.4MB Worker script was the
// same library again. At 200 advisors about one confirm in eleven lands on a fresh
// isolate and waits roughly 900ms for Cloudflare to load that script before Slate's
// entry runs (run 39055855051), and those cold confirms are the steady p95. Declared
// in `serverExternalPackages`, Next requires the package at runtime instead, and
// OpenNext bundles it once into the handler: measured locally, the upload fell from
// 26,371 KiB to 20,566 KiB (gzip 5,590 to 4,615).
//
// It reads the RESOLVED config, the object Next itself loads, so a name in a comment
// or an unused variable cannot satisfy it. It cannot weigh the bundle: the pre-push
// gate runs this suite beside the build that writes `.open-next`, so a test reading
// it would see a half written tree (L461).
//
// Run: node --experimental-strip-types --import ./scripts/register-paths.mjs scripts/test-server-external-packages.ts
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { assert, finish } from "./lib/harness.ts";

const ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..");

/** The packages every Worker build must keep as one shared copy. */
const SHARED_ONCE = ["zod"];

// next.config.ts refuses to load without the app's public address, which a real build
// is always given. A placeholder here only lets the module evaluate; nothing is built.
process.env.NEXT_PUBLIC_APP_URL ||= "https://slate-config-test.example";
const config = (await import(join(ROOT, "next.config.ts"))).default as {
  agentRules?: unknown;
  serverExternalPackages?: unknown;
};

// Control (L1): this is the real config, read through, not an empty object that would
// make every absence below read as a finding about the setting.
assert(config.agentRules === false, "the resolved config is next.config.ts's own (agentRules is false)");

const externals = Array.isArray(config.serverExternalPackages) ? (config.serverExternalPackages as string[]) : null;
assert(externals !== null, "the resolved config carries a serverExternalPackages list");
for (const name of SHARED_ONCE) {
  assert((externals ?? []).includes(name), `${name} is a server external, so the Worker carries one copy`);
}

// An external is required at RUNTIME, so it must be a production dependency: one only
// in devDependencies is absent from the deployed handler and every route importing it
// would throw on its first request.
const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as {
  dependencies?: Record<string, string>;
};
for (const name of SHARED_ONCE) {
  assert(Boolean(pkg.dependencies?.[name]), `${name} is a production dependency, so the external resolves at runtime`);
}

finish();
