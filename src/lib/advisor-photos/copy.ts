/**
 * Every sentence the advisor photo refresh says (#3027): its two Slack alerts,
 * their all clears, and the outcome a button press shows an admin. Pure, so
 * `pnpm preview:alerts` renders the real wording rather than a copy of it.
 */
import { FLIP_TO_NONE_LIMIT, type RefreshPlan } from "@/lib/advisor-photos/core";
import { needsAttention, type RefreshOutcome, type RefusedWhy } from "@/lib/advisor-photos/refresh";

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** Names, at most this many, then a count of the rest, so a phone shows a line not a wall. */
function names(list: string[], max = 6): string {
  if (list.length <= max) return list.join(", ");
  return `${list.slice(0, max).join(", ")} and ${list.length - max} more`;
}

/** What each refusal means and who acts on it, one sentence per cause (L11). */
const REFUSED: Record<Exclude<RefusedWhy, "unknown-user">, string> = {
  "no-subject":
    "DIRECTORY_ADMIN_SUBJECT is not set on the deployment, so there is no Google account to read the directory as. Set it in wrangler.jsonc to the admin mailbox the photos are read through and deploy.",
  "subject-refused":
    "Google refused the account the directory is read as. Either it lost its admin role in Google Admin, or the service account's domain wide delegation for the directory scope was removed. Restore whichever changed.",
  "directory-unreadable":
    "Google's directory listing did not answer usefully (a server error, a rate limit or a timeout). This usually clears on its own; the run retries later today.",
  "nothing-read":
    "Every photo read failed, though the directory listing worked. That is usually a Google rate limit or outage and clears on its own; the run retries later today.",
  "slate-unreadable":
    "Slate could not read its own roster or photo table, so it did not ask Google anything. Check that the advisor_photos migration is applied and the database is answering.",
};

/** The page when a daily run measured nothing. */
export function photosUnreadAlert(why: Exclude<RefusedWhy, "unknown-user"> | "write-failed", detail: string): string {
  const head = "Advisor photos were not refreshed from Google today, so leads and the roster keep yesterday's photos.";
  if (why === "write-failed") {
    return `${head} Google was read, and saving the result to Slate failed: ${detail}. Nothing was half written to a row, and the next run retries.`;
  }
  return `${head} ${REFUSED[why]}`;
}

export function photosUnreadRecovery(): string {
  return "Advisor photos are being refreshed from Google again, so the earlier page is cleared. No action is needed.";
}

/**
 * The page when a run measured and something needs a person: a wave of losses
 * the guard refused, an image too many people share, a person failing for days,
 * or Slate people the directory does not hold.
 */
export function photosHeldAlert(plan: RefreshPlan): string {
  const parts: string[] = ["The advisor photo refresh from Google found something that needs a person."];
  if (plan.flipGuardTripped) {
    parts.push(
      `${plural(plan.heldNone.length, "advisor")} who had a photo would have lost it in one run (${names(plan.heldNone)}), more than the ${FLIP_TO_NONE_LIMIT} one run may remove, so no photo was removed. If those photos really were deleted in Google, refresh each one from their page in Slate.`,
    );
  }
  for (const r of plan.repeated) {
    parts.push(
      `One identical image is held by ${plural(r.holders.length, "person", "people")} (${names(r.holders)}). A repeated image may be a Google placeholder, so it was not stored for ${r.held.length ? names(r.held) : "anybody new"}. If it is a real shared picture such as a logo, nothing is wrong.`,
    );
  }
  if (plan.streaks.length) {
    parts.push(
      `${plural(plan.streaks.length, "advisor")} could not be read for three days in a row and still show the last photo Slate had: ${names(plan.streaks.map((s) => `${s.email} (${s.reason})`))}.`,
    );
  }
  if (plan.failedNeverRead.length) {
    parts.push(
      `${plural(plan.failedNeverRead.length, "person", "people")} Slate has never had a photo for could not be read from Google, so they show only their sign in photo or initials: ${names(plan.failedNeverRead.map((f) => `${f.email} (${f.reason})`))}.`,
    );
  }
  if (plan.notInDirectory.length) {
    parts.push(
      `${plural(plan.notInDirectory.length, "active Slate person", "active Slate people")} could not be found in the Google directory: ${names(plan.notInDirectory)}. Their Google account may have been renamed or removed while Slate still treats them as active.`,
    );
  }
  return parts.join(" ");
}

export function photosHeldRecovery(): string {
  return "The advisor photo refresh ran with nothing left for a person to look at, so the earlier page is cleared. No action is needed.";
}

/**
 * The sentence an admin sees after pressing a refresh button. `scope` decides how
 * much it may say: a whole roster run names nobody (the result travels in the
 * page address, which is browser history), while one person's run is about the
 * person whose page it is.
 */
export function refreshOutcomeText(
  outcome: RefreshOutcome | { status: "failed"; detail: string },
  scope: "all" | "one",
): { ok: boolean; text: string } {
  if (outcome.status === "failed") {
    return { ok: false, text: `Google was read, and saving to Slate failed: ${outcome.detail}` };
  }
  if (outcome.status === "refused") {
    if (outcome.why === "unknown-user") return { ok: false, text: "That person is not an active Slate user, so there is no photo to refresh." };
    return { ok: false, text: REFUSED[outcome.why] };
  }
  const plan = outcome.plan;
  const c = plan.counts;
  if (scope === "one") {
    if (plan.notInDirectory.length) return { ok: false, text: "Google's directory does not hold this address, so no photo was read." };
    if (plan.repeated.length) {
      const r = plan.repeated[0]!;
      return {
        ok: false,
        text: `Google's photo for this person is the same image ${r.holders.length} people hold, so it may be a placeholder and was not stored.`,
      };
    }
    if (c.failed) return { ok: false, text: `Google could not be read for this person: ${plan.failed[0]?.last_error ?? plan.failedNeverRead[0]?.reason ?? "no reason given"}.` };
    if (c.gained || c.changed) return { ok: true, text: "Photo updated from Google." };
    if (c.lost) return { ok: true, text: "Google holds no photo for this person any more, so Slate now shows their initials." };
    if (c.none) return { ok: true, text: "Google holds no photo for this person, so Slate shows their initials." };
    return { ok: true, text: "The photo already matches Google." };
  }
  const parts = [
    `Read ${plural(c.attempted, "person", "people")} from Google`,
    c.gained ? `${c.gained} gained a photo` : null,
    c.changed ? `${c.changed} changed` : null,
    c.lost ? `${c.lost} no longer have one` : null,
    c.unchanged ? `${c.unchanged} unchanged` : null,
    c.failed ? `${c.failed} could not be read` : null,
    c.notInDirectory ? `${c.notInDirectory} not in the directory` : null,
    c.deleted ? `${plural(c.deleted, "departed person's photo", "departed people's photos")} removed` : null,
  ].filter(Boolean);
  const held = needsAttention(plan);
  return {
    ok: c.failed === 0 && !held,
    text: `${parts.join(", ")}.` + (held ? " Some photos were held back for a person to check, and the alerts channel names them." : ""),
  };
}

/**
 * The line under a person's name on their agent page (#3027), or null when the
 * face already says it. Domain words: where the photo comes from and how a
 * missing one gets fixed.
 */
export function agentPhotoStateText(kind: "photo" | "none" | "never-read" | "unreadable"): string | null {
  switch (kind) {
    case "photo":
      return null;
    case "none":
      return "Google holds no photo for them. One added in Google shows here after the next morning's refresh.";
    case "never-read":
      return "Their photo has not been read from Google yet.";
    case "unreadable":
      return "Photos could not be read just now, so this is the photo from their own sign in, if any.";
  }
}
