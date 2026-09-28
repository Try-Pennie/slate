// Shared .env loader for the manual smoke scripts. They read keys
// (BOOKING_API_KEY_CANARY, REASSIGN_API_KEY, the Supabase vars) straight from
// process.env; this loads them from .env.local / .dev.vars line-by-line. A
// line-by-line parse is deliberate: shell `source ./.env.local` dies on an
// unmatched quote anywhere in the file, but a smoke run only needs a few keys —
// the parser must tolerate unrelated weird lines rather than abort the whole run.
import { readFileSync } from "node:fs";

/** Parse KEY=VALUE lines into a map. Ignores blanks/comments, tolerates an
 *  `export ` prefix, strips matched surrounding quotes, and never throws on a
 *  malformed (e.g. unmatched-quote) line — it just skips/keeps it verbatim. */
export function parseEnvFile(content: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of content.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const m = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!m) continue;
    let val = m[2].trim();
    if (
      val.length >= 2 &&
      ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'")))
    ) {
      val = val.slice(1, -1);
    }
    out[m[1]] = val;
  }
  return out;
}

/**
 * Read an env value with a fallback, treating an EMPTY or whitespace-only value
 * as absent.
 *
 * #1494: a workflow wiring `FOO: ${{ vars.FOO }}` for a repo variable that is not
 * set does not leave FOO undefined, it sets it to the EMPTY STRING. `??` only
 * catches null/undefined, so `process.env.SLATE_BASE_URL ?? "https://…"` would
 * take the empty string and every request in the run would go to a base URL of
 * "". Shell already handles this with `${VAR:-default}`; this is the same rule for
 * the scripts, so wiring a var can never blank a working default.
 *
 * Pass the VALUE, not the name (`envOr(process.env.FOO, "x")`), so the
 * `process.env.FOO` read stays visible to scripts/test-workflow-env-coverage.ts.
 */
export function envOr(value: string | undefined, fallback: string): string {
  const trimmed = value?.trim();
  return trimmed ? trimmed : fallback;
}

/** Load each file into process.env WITHOUT overriding vars already set (so an
 *  explicit `FOO=bar node …` still wins). Missing files are skipped. */
export function loadEnvFiles(files: string[]): void {
  for (const file of files) {
    let content: string;
    try {
      content = readFileSync(file, "utf8");
    } catch {
      continue; // absent — rely on the ambient environment
    }
    for (const [key, val] of Object.entries(parseEnvFile(content))) {
      if (process.env[key] === undefined) process.env[key] = val;
    }
  }
}
