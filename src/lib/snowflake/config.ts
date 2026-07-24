/**
 * Reads the Snowflake connection config from the environment (#1097).
 *
 * SNOWFLAKE_PRIVATE_KEY is the gating secret: while it is unset, the export lane
 * is a safe no-op (readSnowflakeConfig returns null and the lane skips). Once it
 * is set, the account identifier is required (a set key with no account is a
 * misconfiguration and throws, fail-loud, rather than silently exporting
 * nowhere); the rest default to the names provisioned by
 * docs/snowflake-setup.sql. Setting placement (secret vs wrangler.jsonc var) is
 * documented in DEPLOY.md and docs/snowflake-setup.md.
 */

import type { SnowflakeConfig } from "./client";

/**
 * Build the Snowflake config, or null when the mirror is not configured yet
 * (SNOWFLAKE_PRIVATE_KEY unset). Callers treat null as "skip this tick".
 */
export function readSnowflakeConfig(): SnowflakeConfig | null {
  const privateKeyRaw = process.env.SNOWFLAKE_PRIVATE_KEY;
  if (!privateKeyRaw) return null;

  const account = process.env.SNOWFLAKE_ACCOUNT;
  if (!account) {
    throw new Error(
      "SNOWFLAKE_PRIVATE_KEY is set but SNOWFLAKE_ACCOUNT is missing: the Snowflake mirror is half-configured.",
    );
  }

  return {
    account,
    user: process.env.SNOWFLAKE_USER || "SLATE_SERVICE",
    // Stored on one line with literal \n (like GOOGLE_SA_PRIVATE_KEY); the PEM
    // parser needs real newlines, so un-escape here.
    privateKeyPem: unescapeNewlines(privateKeyRaw),
    database: process.env.SNOWFLAKE_DATABASE || "SLATE",
    schema: process.env.SNOWFLAKE_SCHEMA || "PUBLIC",
    warehouse: process.env.SNOWFLAKE_WAREHOUSE || "SLATE_WH",
    role: process.env.SNOWFLAKE_ROLE || "SLATE_ROLE",
  };
}

/** True when the mirror is configured enough to attempt an export. */
export function isSnowflakeConfigured(): boolean {
  return Boolean(process.env.SNOWFLAKE_PRIVATE_KEY);
}

/** Turn literal backslash-n sequences into real newlines. A PEM already
 *  containing real newlines is left unchanged. */
function unescapeNewlines(pem: string): string {
  return pem.includes("\\n") ? pem.replace(/\\n/g, "\n") : pem;
}
