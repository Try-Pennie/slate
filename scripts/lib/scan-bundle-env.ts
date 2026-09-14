// Whether a built Worker bundle is carrying settings that belong to a deployment
// rather than to a build (#2335).
//
// `@opennextjs/cloudflare`'s `compileEnvFiles` reads `.env`, `.env.<mode>`,
// `.env.local` and `.env.<mode>.local` from the build tree and writes their values
// into `.open-next/cloudflare/next-env.mjs` as three exported objects, one per mode.
// That file ships INSIDE the bundle, and at runtime `populateProcessEnv` applies the
// Worker's own bindings first and then fills in every name they did not set from it
// (`process.env[key] ??= ...`). So a build run in a tree holding `.env.local` deploys
// whatever that file holds, to whatever environment it is deployed to, silently.
//
// The rule is about the BUNDLE's contents rather than about which `.env*` files
// exist, and that is deliberate. A tree can legitimately hold a `.env` of public
// defaults, and refusing on the file's presence would fail a build that bakes
// nothing dangerous while still passing one where somebody had put a secret
// somewhere else. The env file list is carried through only so the message can name
// where the values came from, which is what a reader actually removes.
//
// `NEXT_PUBLIC_*` is the whole allowlist. Next inlines those at build time by
// design, they are readable in the browser bundle either way, and nothing else has a
// reason to travel with the code.

export const BUNDLE_ENV_PATH = ".open-next/cloudflare/next-env.mjs";

/** Every `.env*` file the adapter reads, in the order it merges them. */
export const ADAPTER_ENV_FILES = [
  ".env",
  ".env.production",
  ".env.development",
  ".env.local",
  ".env.production.local",
  ".env.development.local",
  ".env.test.local",
];

export type BundleEnvReason = "clean" | "carries-values" | "missing" | "unreadable";

export interface BundleEnvVerdict {
  ok: boolean;
  reason: BundleEnvReason;
  /** The offending NAMES. Never a value: this message is printed in build output. */
  offenders: string[];
  message: string;
}

export function isBuildTimePublic(name: string): boolean {
  return name.startsWith("NEXT_PUBLIC_");
}

/**
 * The names each exported mode carries, or null when the file cannot be read as the
 * adapter's own output. Null is a refusal upstream, never an empty environment: an
 * adapter that changed shape and a build that baked nothing look identical otherwise
 * (L98).
 */
export function bundleEnvNamesByMode(
  source: string,
): Record<string, string[]> | null {
  const byMode: Record<string, string[]> = {};
  for (const line of source.split("\n")) {
    const m = /^export const (\w+)\s*=\s*(\{.*\});?\s*$/.exec(line.trim());
    if (!m) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(m[2]);
    } catch {
      return null;
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
    // Keys only, and the values are never read out of here again.
    byMode[m[1]] = Object.keys(parsed as Record<string, unknown>);
  }
  return Object.keys(byMode).length === 0 ? null : byMode;
}

export function judgeBundleEnv(args: {
  /** The file's contents, or null when it is not there at all. */
  source: string | null;
  /** Which `.env*` files the build tree holds, for the message. */
  envFiles: readonly string[];
}): BundleEnvVerdict {
  if (args.source === null) {
    return {
      ok: false,
      reason: "missing",
      offenders: [],
      message:
        `${BUNDLE_ENV_PATH} is not there, so what this bundle carries could not be established. ` +
        `The Cloudflare adapter writes it on every build, so either the build did not run or it ` +
        `wrote somewhere else. Refused rather than passed: a check that found nothing to read ` +
        `must not read as a check that found nothing wrong.`,
    };
  }
  const byMode = bundleEnvNamesByMode(args.source);
  if (byMode === null) {
    return {
      ok: false,
      reason: "unreadable",
      offenders: [],
      message:
        `${BUNDLE_ENV_PATH} could not be read as the adapter's own output (three ` +
        `\`export const <mode> = {...}\` lines). The adapter's format has changed, so this check ` +
        `no longer knows what the bundle carries and is refusing rather than guessing.`,
    };
  }

  const offenders: string[] = [];
  const modesByName = new Map<string, string[]>();
  for (const [mode, names] of Object.entries(byMode)) {
    for (const name of names) {
      if (isBuildTimePublic(name)) continue;
      if (!offenders.includes(name)) offenders.push(name);
      modesByName.set(name, [...(modesByName.get(name) ?? []), mode]);
    }
  }
  if (offenders.length === 0) {
    return {
      ok: true,
      reason: "clean",
      offenders: [],
      message: `${BUNDLE_ENV_PATH} carries only build-time public values.`,
    };
  }

  const named = offenders
    .map((n) => `${n} (${(modesByName.get(n) ?? []).join(", ")})`)
    .join("\n  ");
  const from =
    args.envFiles.length > 0
      ? `They came from ${args.envFiles.join(", ")} in the build tree.`
      : `No .env file was found in the build tree, so they were put there by something else: ` +
        `check for one in a parent directory, or for a build step writing this file.`;
  return {
    ok: false,
    reason: "carries-values",
    offenders,
    message:
      `${BUNDLE_ENV_PATH} carries ${offenders.length} setting(s) that are not build-time public ` +
      `values, so deploying this bundle would ship them inside the Worker:\n  ${named}\n` +
      `${from} Build in a tree with no .env files. The runtime fills in every name the Worker's ` +
      `own bindings did not set, so these reach any environment this is deployed to, which is ` +
      `how a load test deployment came to hold a live Slack token (#2335).`,
  };
}

/**
 * Where the Worker's client-side assets are written. These are served to anybody
 * who opens the booker, so anything readable in them is public.
 */
export const CLIENT_ASSET_DIR = ".open-next/assets";

export interface AssetHit {
  name: string;
  file: string;
}

/**
 * Which of the given names appear in the client assets (#2335).
 *
 * This exists because the first version of the credential refusal put the whole
 * production secret inventory into `publicSupabaseUrl()`, which the BROWSER Supabase
 * client also calls, and every one of the twenty three names shipped in a public
 * `_next/static` chunk. A guard against leaking credentials that publishes the list
 * of them is worse than no guard, and nothing in the repo could have noticed: the
 * names are in the source either way, and only the BUILD says which bundle they
 * landed in (L3).
 *
 * It matches the name as text. A client chunk has no reason to contain the literal
 * `SLACK_BOT_TOKEN`, so a hit is either this mistake or a deliberate decision
 * somebody should have to make out loud.
 */
export function secretNamesInAssets(
  files: readonly { path: string; text: string }[],
  names: readonly string[],
): AssetHit[] {
  const hits: AssetHit[] = [];
  for (const file of files) {
    for (const name of names) {
      if (file.text.includes(name)) hits.push({ name, file: file.path });
    }
  }
  return hits;
}

export function judgeClientAssets(args: {
  files: readonly { path: string; text: string }[];
  names: readonly string[];
}): BundleEnvVerdict {
  if (args.files.length === 0) {
    return {
      ok: false,
      reason: "missing",
      offenders: [],
      message:
        `No client assets were found under ${CLIENT_ASSET_DIR}, so whether the browser bundle ` +
        `names any deployment setting could not be established. Every build writes client ` +
        `chunks, so this is a build that did not finish or wrote somewhere else. Refused rather ` +
        `than passed: scanning nothing must not read as finding nothing.`,
    };
  }
  const hits = secretNamesInAssets(args.files, args.names);
  if (hits.length === 0) {
    return {
      ok: true,
      reason: "clean",
      offenders: [],
      message: `${args.files.length} client asset(s) name none of the deployment's settings.`,
    };
  }
  const offenders = [...new Set(hits.map((h) => h.name))];
  return {
    ok: false,
    reason: "carries-values",
    offenders,
    message:
      `The client bundle NAMES ${offenders.length} of the deployment's settings, so they are ` +
      `readable by anybody who opens the booker:\n  ` +
      hits.map((h) => `${h.name} in ${h.file}`).join("\n  ") +
      `\nThese are names, not values, so nothing is compromised; what leaks is the inventory of ` +
      `what Slate integrates with. Something server side became reachable from a client ` +
      `component. Move it behind a server only module (#2335).`,
  };
}
