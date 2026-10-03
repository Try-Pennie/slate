/**
 * What the daily dependency audit says, and to whom (#3092, #3093).
 *
 * `pnpm audit` ran only on a push or a pull request, so an advisory published
 * against an unchanged tree went unseen until somebody next pushed, and the build
 * and deploy toolchain (wrangler, @opennextjs/cloudflare and everything they pull
 * in, which run with the Cloudflare deploy token) was outside every audit because
 * the gate is scoped `--prod`. `.github/workflows/dependency-audit.yml` runs both
 * audits every day and this decides the message from their step outcomes.
 *
 * Pure and dependency free: the workflow runs it on bare node with no install, and
 * `scripts/test-dependency-audit-report.ts` drives every outcome.
 */

/**
 * The patch target for a finding (#3092), decided by Dan on 2026-10-03 and written
 * down in docs/alerts-runbook.md ("A dependency advisory was found"). Said in every
 * finding's message so the deadline arrives with the page rather than living only
 * in a document nobody opens mid incident.
 */
export const PATCH_TARGET =
  "High or critical advisories are patched by the next working day after this audit flags them.";

/** A GitHub step outcome, or empty when the step never got that far. */
export type StepOutcome = "success" | "failure" | "cancelled" | "skipped" | "";

export interface AuditOutcomes {
  /** `pnpm audit --prod --audit-level=high`: what ships to the Worker. */
  prod: string;
  /** `pnpm audit --audit-level=critical` over the whole tree: the build and deploy chain too. */
  full: string;
  runUrl: string;
}

export interface AuditDecision {
  /** The Slack text, or null when there is nothing to say. */
  alert: string | null;
  /** One line for the run log, always present. */
  detail: string;
}

function norm(v: string): StepOutcome {
  return v === "success" || v === "failure" || v === "cancelled" || v === "skipped" ? v : "";
}

export function decideAuditAlert(o: AuditOutcomes): AuditDecision {
  const prod = norm(o.prod.trim());
  const full = norm(o.full.trim());
  const link = o.runUrl.trim() || "(no run link)";

  if (prod === "success" && full === "success") {
    return { alert: null, detail: "both audits passed" };
  }

  const lines: string[] = [];
  if (prod === "failure") {
    lines.push(
      "The daily dependency audit found a high or critical advisory in a production dependency of Slate, the code that ships to the Worker.",
    );
  }
  if (full === "failure") {
    lines.push(
      "The daily dependency audit found a critical advisory in the build and deploy toolchain (development dependencies such as wrangler and the OpenNext adapter, which run with the Cloudflare deploy token).",
    );
  }
  // An audit that never reached a verdict is not a pass, and saying "found
  // something" about it would be false: it is its own message (L11, L98).
  const unrun = [
    prod !== "success" && prod !== "failure" ? "the production audit" : null,
    full !== "success" && full !== "failure" ? "the full tree audit" : null,
  ].filter((x): x is string => x !== null);
  if (unrun.length > 0) {
    lines.push(
      `The daily dependency audit could not finish ${unrun.join(" or ")}, so nothing was checked there today.`,
    );
  }

  const found = prod === "failure" || full === "failure";
  lines.push(
    found
      ? `${PATCH_TARGET} Open the run to see the advisory and the package path, then bump or replace the package: ${link}`
      : `Re-run it to get today's reading: ${link}`,
  );
  return {
    alert: lines.join("\n"),
    detail: `production audit ${prod || "did not run"}, full tree audit ${full || "did not run"}`,
  };
}
