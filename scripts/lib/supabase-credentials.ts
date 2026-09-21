// The one refusal a verify script gives when it has no Supabase credentials (#2572).
//
// Three `verify-*.ts` scripts loaded `.env.local` / `.dev.vars`, checked for the two
// variables, and printed the same "FAILED (not-configured)" sentence, and the global
// duplication guard named the second copy. The judgement and the wording live here so
// the refusal reads the same from every script that reads production, and a change to
// which variables are needed is one edit. `scripts/test-supabase-credentials.ts` drives it.
import { loadEnvFiles } from "../smoke-env.ts";

/** The files every verify script reads its credentials from, in precedence order. */
export const ENV_FILES = [".env.local", ".dev.vars"];

/**
 * Says what is missing and that nothing happened. "nothing was read" is load bearing:
 * exit 1 is decided before anything is read, so it can never be confused with a finding.
 */
export const SUPABASE_NOT_CONFIGURED =
  "FAILED (not-configured): SUPABASE_SECRET_KEY and NEXT_PUBLIC_SUPABASE_URL are needed here; nothing was read";

export type SupabaseCredentials = { url: string; key: string };

/** Pure: an env to either the trimmed pair or the refusal. A blank value is absent. */
export function judgeSupabaseCredentials(
  env: Record<string, string | undefined>,
): ({ ok: true } & SupabaseCredentials) | { ok: false; message: string } {
  const url = env.NEXT_PUBLIC_SUPABASE_URL?.trim() ?? "";
  const key = env.SUPABASE_SECRET_KEY?.trim() ?? "";
  if (!url || !key) return { ok: false, message: SUPABASE_NOT_CONFIGURED };
  return { ok: true, url, key };
}

/**
 * Load the env files, then either return the pair or print the refusal and exit 1.
 * Returns null only when `exit` was injected and did not end the process, which is
 * how the test observes the refusal.
 */
export function requireSupabaseCredentials(
  io: {
    env?: Record<string, string | undefined>;
    loadEnv?: (files: string[]) => void;
    error?: (line: string) => void;
    exit?: (code: number) => void;
  } = {},
): SupabaseCredentials | null {
  (io.loadEnv ?? loadEnvFiles)(ENV_FILES);
  const judged = judgeSupabaseCredentials(io.env ?? process.env);
  if (judged.ok) return { url: judged.url, key: judged.key };
  (io.error ?? ((line: string) => console.error(line)))(judged.message);
  (io.exit ?? ((code: number) => process.exit(code)))(1);
  return null;
}
