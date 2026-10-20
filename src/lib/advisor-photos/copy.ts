/**
 * Every sentence the advisor photo refresh says (#3027): its two Slack alerts,
 * their all clears, and the outcome a button press shows an admin. Pure, so
 * `pnpm preview:alerts` renders the real wording rather than a copy of it.
 */
import { FLIP_TO_NONE_LIMIT, isPhotoHash, type RefreshPlan } from "@/lib/advisor-photos/core";
import { needsAttention, type RefreshOutcome, type RefusedWhy } from "@/lib/advisor-photos/refresh";
import { awaitingFirstRead, type AdvisorPhoto } from "@/lib/advisor-photos/resolve";

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

/**
 * What to do about a repeated image that is really a shared picture, said the same
 * way on the nightly page and on an agent's page after "Refresh from Google" (#3959).
 */
const SHARED_IMAGE_REMEDY =
  "If it is a real shared picture such as a logo, add its hash to the known shared images list in src/lib/advisor-photos/core.ts, and the next run stores it for everybody.";

/** The page when a daily run measured nothing. */
export function photosUnreadAlert(
  why: Exclude<RefusedWhy, "unknown-user"> | "write-failed",
  detail: string,
  notReached = 0,
): string {
  const head = "Advisor photos were not refreshed from Google today, so leads and the roster keep yesterday's photos.";
  if (why === "write-failed") {
    return `${head} Google was read, and saving the result to Slate failed: ${detail}. Nothing was half written to a row, and the next run retries.`;
  }
  // A run whose reads all failed AND that hit its time limit: both facts, because
  // a slow Google is the likelier cause of the pair than a broken one.
  const cut = why === "nothing-read" && notReached > 0
    ? ` The run also reached its time limit, so ${plural(notReached, "person was", "people were")} never asked at all.`
    : "";
  return `${head} ${REFUSED[why]}${cut}`;
}

/** The page when a run stopped at its own deadline before reaching everybody. */
export function photosDeadlineAlert(read: number, notReached: number): string {
  return `Advisor photos were only partly refreshed from Google today: the run reached its time limit after ${plural(read, "person", "people")}, and ${plural(notReached, "person", "people")} keep yesterday's photo. Google answering slowly is the usual cause and clears on its own; the run retries later today.`;
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
    // The image page serves only a hash somebody's row holds, so it is offered
    // only when this run left it stored for at least one holder (L111).
    const look = r.holders.length > r.held.length
      ? `Open /advisor-photo/${r.sha256} on Slate to see it.`
      : `Slate has not stored it for anybody, so look at one of their photos in Google Admin. Its hash is ${r.sha256}.`;
    parts.push(
      `One identical image is held by ${plural(r.holders.length, "person", "people")} (${names(r.holders)}). It may be a Google placeholder, so it was not stored for ${r.held.length ? names(r.held) : "anybody new"}. ${look} ${SHARED_IMAGE_REMEDY}`,
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
 * What a refresh button reports back to the page it was pressed on (#3027).
 *
 * It travels in the page address, so it is a CODE plus counts as numbers, never a
 * sentence: a crafted link can then only ever produce one of the sentences below,
 * never words of its own choosing. The one exception is a repeated image's hash
 * (#3959), which is refused unless it is exactly 64 lower case hex characters. The page looks the copy up from this file.
 * Nothing in it names a person either, since an address is browser history.
 */
export const PHOTO_OUTCOME_CODES = [
  // A whole roster run that measured.
  "done",
  // A whole roster run that measured some people and stopped at its deadline.
  "cut-short",
  // One person's run that measured.
  "updated",
  "now-none",
  "none",
  "unchanged",
  "not-in-directory",
  "repeated",
  "read-failed",
  // Either run.
  "no-subject",
  "subject-refused",
  "directory-unreadable",
  "nothing-read",
  "slate-unreadable",
  "unknown-user",
  "save-failed",
  "run-failed",
  "busy",
] as const;
export type PhotoOutcomeCode = (typeof PHOTO_OUTCOME_CODES)[number];

/** The counts a roster run reports, by their one letter query names. */
const COUNT_PARAMS = {
  attempted: "pa",
  gained: "pg",
  changed: "pc",
  lost: "pl",
  unchanged: "pu",
  failed: "pf",
  notInDirectory: "pm",
  deleted: "pd",
} as const;
type CountName = keyof typeof COUNT_PARAMS;



export interface PhotoOutcome {
  code: PhotoOutcomeCode;
  counts?: Record<CountName, number>;
  /** A roster run that left something for a person; the alert names who. */
  held?: boolean;
  /** For "repeated": how many people hold the image. */
  holders?: number;
  /**
   * For "repeated": the image's hash, so the page can say where to see it. A hash
   * names no person, and anything that is not exactly one is refused on the way in.
   */
  sha256?: string;
  /** For "cut-short", and "nothing-read" that also hit the deadline: how many people the run never reached. */
  notReached?: number;
}

/** Decide the outcome of a run, as a code and numbers. */
export function photoOutcome(
  outcome: RefreshOutcome | { status: "failed"; detail: string } | { status: "skipped"; why: string },
  scope: "all" | "one",
): PhotoOutcome {
  if (outcome.status === "skipped") return { code: "busy" };
  if (outcome.status === "failed") return { code: "save-failed" };
  if (outcome.status === "refused") {
    // A refusal keeps its own outcome and reason. The time limit rides on it only
    // for nothing read, where a slow Google is plausibly the cause; never on a
    // permission refusal. `cut-short` is for a run that measured.
    if (outcome.why === "nothing-read" && outcome.deadlineReached) {
      return { code: "nothing-read", notReached: outcome.notReached ?? 0 };
    }
    return { code: outcome.why };
  }
  const plan = outcome.plan;
  const c = plan.counts;
  if (scope === "one") {
    if (plan.notInDirectory.length) return { code: "not-in-directory" };
    if (plan.repeated.length) {
      return { code: "repeated", holders: plan.repeated[0]!.holders.length, sha256: plan.repeated[0]!.sha256 };
    }
    if (c.failed) return { code: "read-failed" };
    if (c.gained || c.changed) return { code: "updated" };
    if (c.lost) return { code: "now-none" };
    if (c.none && c.unchanged === 0) return { code: "none" };
    return { code: "unchanged" };
  }
  const counts = Object.fromEntries(
    (Object.keys(COUNT_PARAMS) as CountName[]).map((k) => [k, c[k]]),
  ) as Record<CountName, number>;
  if (outcome.deadlineReached) {
    return { code: "cut-short", counts, held: needsAttention(plan), notReached: outcome.notReached };
  }
  return { code: "done", counts, held: needsAttention(plan) };
}

/** The query string for an outcome, on the parameter `param` ("photos" or "photo"). */
export function photoOutcomeQuery(o: PhotoOutcome, param: "photos" | "photo"): string {
  const q = new URLSearchParams({ [param]: o.code });
  if (o.counts) for (const k of Object.keys(COUNT_PARAMS) as CountName[]) q.set(COUNT_PARAMS[k], String(o.counts[k]));
  if (o.held) q.set("ph", "1");
  if (o.holders !== undefined) q.set("pn", String(o.holders));
  if (o.sha256 !== undefined) q.set("px", o.sha256);
  if (o.notReached !== undefined) q.set("pr", String(o.notReached));
  return q.toString();
}

const count = (raw: string | undefined): number | null => (raw !== undefined && /^\d{1,6}$/.test(raw) ? Number(raw) : null);

/**
 * Read an outcome back from a page's search params. Null for anything that is not
 * exactly an outcome this file writes, so a crafted link draws no banner at all.
 */
export function photoOutcomeFromParams(
  sp: Record<string, string | string[] | undefined>,
  param: "photos" | "photo",
): PhotoOutcome | null {
  const one = (k: string) => (typeof sp[k] === "string" ? (sp[k] as string) : undefined);
  const code = one(param);
  if (!code || !(PHOTO_OUTCOME_CODES as readonly string[]).includes(code)) return null;
  // A whole roster run's outcomes belong to the roster's parameter only.
  if ((code === "done" || code === "cut-short") && param !== "photos") return null;
  // The not reached count belongs to cut-short and nothing-read alone.
  if (one("pr") !== undefined && code !== "cut-short" && code !== "nothing-read") return null;
  // The image hash belongs to repeated alone, and must be exactly a hash.
  const px = one("px");
  if (px !== undefined && (code !== "repeated" || !isPhotoHash(px))) return null;
  const out: PhotoOutcome = { code: code as PhotoOutcomeCode };
  if (code === "done" || code === "cut-short") {
    const counts = {} as Record<CountName, number>;
    for (const k of Object.keys(COUNT_PARAMS) as CountName[]) {
      const n = count(one(COUNT_PARAMS[k]));
      if (n === null) return null;
      counts[k] = n;
    }
    out.counts = counts;
    out.held = one("ph") === "1";
  }
  if (code === "cut-short" || (code === "nothing-read" && one("pr") !== undefined)) {
    const n = count(one("pr"));
    if (n === null) return null;
    out.notReached = n;
  }
  if (code === "repeated") {
    const n = count(one("pn"));
    if (n === null) return null;
    out.holders = n;
    if (px !== undefined) out.sha256 = px;
  }
  return out;
}

const ONE_TEXT: Record<Exclude<PhotoOutcomeCode, "done" | "cut-short" | "repeated">, { ok: boolean; text: string }> = {
  updated: { ok: true, text: "Photo updated from Google." },
  "now-none": { ok: true, text: "Google holds no photo for this person any more, so Slate now shows their initials." },
  none: { ok: true, text: "Google holds no photo for this person, so Slate shows their initials." },
  unchanged: { ok: true, text: "The photo already matches Google." },
  "not-in-directory": { ok: false, text: "Google's directory does not hold this address, so no photo was read." },
  "read-failed": { ok: false, text: "Google could not be read for this person just now. Try again in a few minutes." },
  "no-subject": { ok: false, text: REFUSED["no-subject"] },
  "subject-refused": { ok: false, text: REFUSED["subject-refused"] },
  "directory-unreadable": { ok: false, text: REFUSED["directory-unreadable"] },
  "nothing-read": { ok: false, text: REFUSED["nothing-read"] },
  "slate-unreadable": { ok: false, text: REFUSED["slate-unreadable"] },
  "unknown-user": { ok: false, text: "That person is not an active Slate user, so there is no photo to refresh." },
  "save-failed": { ok: false, text: "Google was read, and saving the photos to Slate failed. The logs under tag=advisor-photos have the reason." },
  "run-failed": { ok: false, text: "The photo refresh failed before it finished. The logs under tag=advisor-photos have the reason." },
  busy: { ok: false, text: "A photo refresh is already running. Try again in a minute." },
};

/** The sentence for an outcome, and whether it is good news. */
export function photoOutcomeText(o: PhotoOutcome): { ok: boolean; text: string } {
  if (o.code === "repeated") {
    // In a one person run every other holder comes from a stored row, so the image
    // page serves it. A link written before #3959 carries no hash and says less.
    const look = o.sha256 ? ` Open /advisor-photo/${o.sha256} on Slate to see it. ${SHARED_IMAGE_REMEDY}` : "";
    return {
      ok: false,
      text: `Google's photo for this person is the same image ${o.holders ?? 0} people hold, so it may be a placeholder and was not stored.${look}`,
    };
  }
  if (o.code === "nothing-read" && o.notReached !== undefined) {
    return {
      ok: false,
      text: `${ONE_TEXT["nothing-read"].text} The run also reached its time limit, so ${plural(o.notReached, "person was", "people were")} never asked.`,
    };
  }
  if (o.code !== "done" && o.code !== "cut-short") return ONE_TEXT[o.code];
  const c = o.counts!;
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
  const cut =
    o.code === "cut-short"
      ? ` The run reached its time limit, so ${plural(o.notReached ?? 0, "person was", "people were")} not reached; press it again to finish them.`
      : "";
  return {
    ok: o.code === "done" && c.failed === 0 && !o.held,
    text:
      `${parts.join(", ")}.` +
      cut +
      (o.held ? " Some people need a person to look at them, and the alerts channel names them." : ""),
  };
}

/**
 * The line under a person's name on their agent page (#3027), or null when the
 * face already says it. Domain words: where the photo comes from and how a
 * missing one gets fixed.
 *
 * "Not read yet" only for somebody the refresh will reach (#3161). A deactivated
 * person with no record keeps their sign in photo with nothing said, because no
 * refresh will ever read them.
 */
export function agentPhotoStateText(photo: AdvisorPhoto, person: { deactivated_at: string | null }): string | null {
  if (awaitingFirstRead(photo, person)) return "Their photo has not been read from Google yet.";
  switch (photo.kind) {
    case "none":
      return "Google holds no photo for them. One added in Google shows here after the next morning's refresh.";
    case "unreadable":
      return "Photos could not be read just now, so this is the photo from their own sign in, if any.";
    default:
      // A photo, or a deactivated person's sign in photo: the face says it.
      return null;
  }
}
