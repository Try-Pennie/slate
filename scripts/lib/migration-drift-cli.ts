/**
 * Getting `supabase migration list --linked` to answer, for the CI drift gate
 * (#1437).
 *
 * The IO half of the gate used to be two lines of YAML. On 2026-08-12 both of
 * them failed on the Supabase side, not on the change under test: `link` returned
 * "error code: 502" and, separately, the CLI download hung up its socket. Because
 * `deploy` needs `migration-drift`, each failure skipped the deploy for a good
 * commit, and one of them paged "Slate deploy failed on main" for a fault nobody
 * could act on. That is how a gate teaches people to re-run it reflexively, which
 * is how a real failure gets re-run too (L36).
 *
 * The distinction this module exists to hold, and the reason it is not a bash
 * loop: **the CLI failing to answer is retryable, the CLI's answer is not.** An
 * exit-0 `migration list` that prints a blank remote column is the finding the
 * gate is for, and an exit-0 run that printed nothing is #1433's finding. Neither
 * is retried, so no amount of retrying can turn either into a pass. Only a
 * non-zero exit or an unspawnable binary gets a second look, and running out of
 * attempts is still a hard failure that names what the CLI said.
 *
 * The parse stays in scripts/lib/migration-drift.ts. This module never judges the
 * output, it only obtains it.
 */
import { retryTransient } from "./retry.ts";

/** What one `supabase ...` invocation did. */
export type CliResult = { code: number; stdout: string; stderr: string };

/** Injected so every branch is provable without the CLI or the network. */
export type CliRunner = (args: string[]) => Promise<CliResult>;

export type MigrationListRead =
  | { ok: true; output: string; attempts: number }
  | { ok: false; reason: string; attempts: number };

/** The first non-empty line of what a failing command said, for a one line reason. */
function firstLine(result: CliResult): string {
  const text = `${result.stderr}\n${result.stdout}`;
  const line = text
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l.length > 0);
  return line ?? "(no output)";
}

/**
 * Link the project and read the migration table, retrying only a CLI that could
 * not answer.
 *
 * The pair is redone together on a retry rather than just the failing half: a
 * failing `migration list` is often a link that half worked, so relinking is part
 * of the second look.
 */
export async function readMigrationListWithRetry(opts: {
  projectRef: string;
  run: CliRunner;
  attempts?: number;
  delaysMs?: readonly number[];
  sleep?: (ms: number) => Promise<void>;
  onRetry?: (info: { attempt: number; reason: string; waitMs: number }) => void;
}): Promise<MigrationListRead> {
  const result = await retryTransient<string>({
    attempts: opts.attempts,
    delaysMs: opts.delaysMs,
    sleep: opts.sleep,
    onRetry: opts.onRetry,
    run: async () => {
      // A throw (the binary missing because setup-cli failed) is the same class of
      // "could not tell" as a non-zero exit, and must not surface as an unhandled
      // rejection whose stack says nothing about the gate.
      let link: CliResult;
      try {
        link = await opts.run(["link", "--project-ref", opts.projectRef]);
      } catch (e) {
        return { ok: false, reason: `supabase link could not run: ${String(e)}` };
      }
      if (link.code !== 0) {
        return { ok: false, reason: `supabase link exited ${link.code}: ${firstLine(link)}` };
      }

      let list: CliResult;
      try {
        list = await opts.run(["migration", "list", "--linked"]);
      } catch (e) {
        return { ok: false, reason: `supabase migration list could not run: ${String(e)}` };
      }
      if (list.code !== 0) {
        return {
          ok: false,
          reason: `supabase migration list exited ${list.code}: ${firstLine(list)}`,
        };
      }
      // Whatever it printed, including nothing, is an ANSWER. The parse judges it.
      return { ok: true, value: list.stdout };
    },
  });

  return result.ok
    ? { ok: true, output: result.value, attempts: result.attempts }
    : { ok: false, reason: result.reason, attempts: result.attempts };
}
