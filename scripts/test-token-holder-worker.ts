// The shared Google token holder (#3512) is served by its own small Worker, as the confirm
// line (#3500) and the burst limiter (#3555) are, judged as wrangler RESOLVES the configs.
//
// What this pins, each a way the holder could ship wrong while every unit test passed:
//
// - Slate binds TOKEN_HOLDER by script name, production to production's Worker and the
//   load test to the load test's, so a load run never shares tokens with production.
// - Slate declares NO migration for the class. It was never Slate's, and a migration in
//   Slate's config is exactly what the gradual deploy cannot upload (#3352): this binding
//   must ship through the ordinary pipeline, not a hand deploy.
// - The holder's Worker has no address, so only Slate's binding reaches the tokens.
// - Its entry loads nothing but the holder's own rules.
// - The shell keeps tokens in MEMORY: driven with a context whose storage throws on any
//   touch, a put and a get still work, so nothing was ever written at rest.
//
// Run: node --experimental-strip-types --import ./scripts/register-paths.mjs scripts/test-token-holder-worker.ts
import { unstable_readConfig } from "wrangler";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { TOKEN_HOLDER_BINDING, TOKEN_HOLDER_CLASS, TOKEN_HOLDER_PROTOCOL } from "../src/lib/google/token-holder-object.ts";
import { TokenHolder } from "../worker/token-holder.ts";
import { OBJECT_WORKER_CONFIGS } from "./lib/gradual-deploy.ts";
import { assert, eq, finish } from "./lib/harness.ts";
import { walkWorkerImports } from "./lib/scan-local-import-graph.ts";

interface Resolved {
  name?: string;
  main?: string;
  workers_dev?: boolean;
  preview_urls?: boolean;
  routes?: unknown[];
  durable_objects?: { bindings?: { name?: string; class_name?: string; script_name?: string }[] } | null;
  migrations?: { tag?: string; new_sqlite_classes?: string[]; new_classes?: string[] }[] | null;
}

const ROOT = join(import.meta.dirname, "..");
const SCRIPT = { production: "slate-token-holder", loadtest: "slate-token-holder-loadtest" } as const;
const declares = (r: Resolved) =>
  (r.migrations ?? []).some((m) => [...(m.new_sqlite_classes ?? []), ...(m.new_classes ?? [])].includes(TOKEN_HOLDER_CLASS));

for (const env of [undefined, "loadtest"] as const) {
  const label = env ?? "production";
  const slate = unstable_readConfig({ config: "wrangler.jsonc", env }) as unknown as Resolved;
  const binding = (slate.durable_objects?.bindings ?? []).find((b) => b.name === TOKEN_HOLDER_BINDING);
  eq(binding?.class_name, TOKEN_HOLDER_CLASS, `${label}: ${TOKEN_HOLDER_BINDING} is bound to ${TOKEN_HOLDER_CLASS}`);
  eq(binding?.script_name, SCRIPT[label], `${label}: ${TOKEN_HOLDER_BINDING} is served by the small token holder Worker, by script name`);
  assert(!declares(slate), `${label}: Slate declares no migration for ${TOKEN_HOLDER_CLASS}, so the gradual deploy can upload it (#3352)`);

  const own = unstable_readConfig({ config: "wrangler.token-holder.jsonc", env }) as unknown as Resolved;
  eq(own.name, SCRIPT[label], `${label}: the token holder Worker is named for its environment`);
  eq(own.main?.replace(/^.*?(worker\/)/, "$1"), "worker/token-holder/index.ts", `${label}: its entry is its own small module`);
  const hosted = (own.durable_objects?.bindings ?? []).find((b) => b.name === TOKEN_HOLDER_BINDING);
  assert(hosted?.class_name === TOKEN_HOLDER_CLASS && hosted.script_name === undefined, `${label}: it hosts ${TOKEN_HOLDER_CLASS} itself (got ${JSON.stringify(hosted ?? null)})`);
  assert(declares(own), `${label}: its own migration creates ${TOKEN_HOLDER_CLASS}`);
  assert(own.workers_dev === false && own.preview_urls === false && (own.routes ?? []).length === 0, `${label}: it has no address; only Slate's binding reaches it`);
}

// The control for the migration check above: the same test over a Slate config that DID
// declare the class must see it, or "declares no migration" was never measuring anything.
assert(declares({ migrations: [{ tag: "v3", new_sqlite_classes: [TOKEN_HOLDER_CLASS] }] }), "control: a Slate config declaring the class would be caught");

// Deployed before Slate on every path, from the one list.
assert((OBJECT_WORKER_CONFIGS as readonly string[]).includes("wrangler.token-holder.jsonc"), "the token holder Worker is in OBJECT_WORKER_CONFIGS, so every deploy path ships it before Slate");

// The Worker holds no secret: nothing in its config or source reads one.
{
  const config = readFileSync(join(ROOT, "wrangler.token-holder.jsonc"), "utf8").replace(/\/\/.*$/gm, "");
  assert(!/"vars"|"secrets"/.test(config), "its config carries no vars and no secrets");
}

// Loads nothing but the holder's own rules, so a wake costs what the object needs and the
// app (with its service account key reader) can never creep into this Worker.
{
  const allowed = new Set(["worker/token-holder/index.ts", "worker/token-holder.ts", "src/lib/google/token-holder-object.ts"]);
  const { seen, foreign } = walkWorkerImports(ROOT, "worker/token-holder/index.ts", allowed);
  assert(foreign.length === 0, `the token holder Worker reaches only its own files (got ${foreign.join(", ")})`);
  assert(seen.has("src/lib/google/token-holder-object.ts"), "the walk did reach the holder's rules (positive control)");
}

// The shell, driven as the runtime drives it, with a storage that refuses every touch.
{
  let storageTouched = 0;
  const storage = new Proxy(
    {},
    {
      get() {
        storageTouched += 1;
        throw new Error("storage must never be touched");
      },
    },
  );
  const shell = new TokenHolder({ storage } as never);
  const call = async (body: unknown) =>
    (await (await shell.fetch(new Request("https://token-holder/", { method: "POST", body: JSON.stringify(body) }))).json()) as Record<string, unknown>;
  const exp = Date.now() + 3_600_000;
  eq(await call({ v: TOKEN_HOLDER_PROTOCOL, op: "put", key: "calendar\na@trypennie.com", token: "tok", expMs: exp }), { kind: "stored" }, "the shell stores a put");
  eq(await call({ v: TOKEN_HOLDER_PROTOCOL, op: "get", key: "calendar\na@trypennie.com" }), { kind: "hit", token: "tok", expMs: exp, refresh: false }, "and answers it to a get");
  eq(storageTouched, 0, "without touching storage: tokens are held in memory only");
  const unreadable = await (await shell.fetch(new Request("https://token-holder/", { method: "POST", body: "{not json" }))).json();
  eq((unreadable as { kind?: string }).kind, "bad", "an unreadable body is refused as a malformed message");
}

finish();
