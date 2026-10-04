/**
 * The vocabulary of the post confirm recompute switch (#3258), with no imports, so
 * the load run's preflight can judge a workflow input and a deployment's report
 * with the same list the Worker reads, on bare node (L41). The switch itself, and
 * why it exists, is in `post-confirm-recompute.ts`.
 */
export const POST_CONFIRM_RECOMPUTE_VAR = "SLATE_LOADTEST_POST_CONFIRM_RECOMPUTE";

export const POST_CONFIRM_RECOMPUTE_MODES = ["on", "off", "reads-only"] as const;
export type PostConfirmRecomputeMode = (typeof POST_CONFIRM_RECOMPUTE_MODES)[number];

/** The mode in force, and the raw value when it named no mode (null otherwise). */
export interface PostConfirmRecomputeSetting {
  mode: PostConfirmRecomputeMode;
  unknown: string | null;
}

/** A raw value as a mode. Unset or blank is `on`; anything else that is not a mode
 *  is `on` and returned in `unknown`. Case is not forgiven: `OFF` is reported rather
 *  than guessed at, so the value the run reports is the value somebody typed. */
export function parsePostConfirmRecompute(raw: string | undefined): PostConfirmRecomputeSetting {
  const value = (raw ?? "").trim();
  if (value === "") return { mode: "on", unknown: null };
  const mode = POST_CONFIRM_RECOMPUTE_MODES.find((m) => m === value);
  return mode ? { mode, unknown: null } : { mode: "on", unknown: value };
}

/** The load run report's line naming the arm a run was dispatched for (#3258). */
export function recomputeArmLine(raw: string | undefined): string {
  const arm = parsePostConfirmRecompute(raw);
  return arm.unknown === null
    ? `Post confirm recompute arm: **${arm.mode}** (#3258).`
    : `Post confirm recompute arm: dispatched as "${arm.unknown}", which is no arm (#3258).`;
}
