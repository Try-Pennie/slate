// The decision behind the load run's teardown confirmation (#2277), kept apart from
// the live IO so every outcome it can reach is driven offline by
// scripts/test-loadtest-teardown-verdict.ts.
//
// The teardown job deletes the loadtest deployment and then has to say whether it is
// really GONE, because a zero exit from `wrangler delete` is not the deployment being
// absent. The first confirmation asked `wrangler deployments list --env loadtest`,
// which errors once the Worker no longer exists, so a successful teardown took the
// "could not list deployments" branch and failed the job. Two causes were sharing one
// sentence (L11), and a step that is red for doing its job stops being read (L36).
//
// **TWO reads, and each closes the other's ambiguity.** Neither can answer this alone:
//
//   - `GET /accounts/{id}/workers/scripts/{name}` answers 404 for a script that is
//     gone, which looks like the obvious check. But 404 is not unique to that cause: a
//     wrong account id, a revoked route or a typo in the path answers 404 too, and
//     reading any of those as "gone" would be the defect the previous comment here
//     warned about (#1433, L183) rebuilt in a new place.
//   - `GET /accounts/{id}/workers/scripts` lists the account's Workers, and an absence
//     from a listing that is POSITIVELY readable (HTTP 200, a Cloudflare envelope
//     saying success, a result array, every entry named) cannot be produced by an
//     expired token, a wrong account or an error page. But it rests on an assumption
//     nobody here has measured: that the endpoint returns EVERY script in one reply.
//     The published schema for it carries no paging parameters and no `result_info`,
//     which is evidence and not a measurement, and a platform guarantee that is the
//     whole reason a guard is safe has to be measured on the real target rather than
//     believed (L82). It cannot be measured from a machine with no account token, so
//     the check is built not to DEPEND on it. If that listing ever truncated, a Worker
//     that is still deployed would fall off the page and read as gone, which is a
//     CONFIRMED teardown over a live deployment: worse than the bug this fixes, which
//     was only a correct teardown reading as red.
//
// So an absence from the listing is not a verdict, it is a claim to be confirmed. The
// Worker is called gone only when BOTH agree: the listing was readable and did not
// name it, AND the read of it by name answered 404. The listing's 200 is what proves
// the token, the account id and the route are good, which is exactly the ambiguity
// that made a bare 404 unsafe, so the pair is unambiguous where neither is alone.
//
// Listed-but-absent-from-the-listing has its own outcome (`listing-incomplete`): the
// Worker is still there AND the listing cannot be trusted, and a reader needs telling
// both, so it is neither `gone` nor `still-deployed`.

/**
 * Every way the confirmation can end, and the exit code it ends on.
 *
 * One code per cause, never a shared "it failed". These are what the workflow step
 * exits on, and each names a different thing to go and do: a repo setting to create,
 * Cloudflare to ask about, a token to renew, or a deployment genuinely still running.
 *
 * Codes are APPENDED, never renumbered, so nothing that already reads one changes
 * meaning.
 */
export const TEARDOWN_EXIT = {
  /** Absent from a readable listing AND 404 by name. The only zero. */
  gone: 0,
  /** This runner has no token, no account id, or no Worker name, so nothing was read. */
  misconfigured: 1,
  /** The Worker is still listed, so the delete did not take. */
  stillDeployed: 2,
  /** The listing request never got a reply at all: DNS, TLS, a timeout, no network. */
  noAnswer: 3,
  /** Cloudflare answered the listing, and not with a 200. */
  listingRefused: 4,
  /** A 200 whose body is not a listing this can search. */
  listingUnreadable: 5,
  /** A readable listing with no Workers in it, which this account cannot be in. */
  listingEmpty: 6,
  /** Absent from the listing and PRESENT by name: still deployed, and the listing lies. */
  listingIncomplete: 7,
  /** The by-name read answered in a way this cannot act on. */
  byNameUnreadable: 8,
  /** The by-name read never got a reply, so the absence was never confirmed. */
  byNameNoAnswer: 9,
} as const;

export type TeardownVerdictKind =
  | "gone"
  | "misconfigured"
  | "still-deployed"
  | "no-answer"
  | "listing-refused"
  | "listing-unreadable"
  | "listing-empty"
  | "listing-incomplete"
  | "by-name-unreadable"
  | "by-name-no-answer";

/**
 * One outcome, its wording, and what to exit on.
 *
 * `confirmed` is the discriminant the caller branches on rather than re-deriving the
 * meaning from the code: only the `gone` arm may carry it, and the test pins that it
 * can never disagree with the exit code.
 */
export type TeardownVerdict =
  | { kind: "gone"; confirmed: true; exitCode: number; message: string }
  | {
      kind: Exclude<TeardownVerdictKind, "gone">;
      confirmed: false;
      exitCode: number;
      message: string;
    };

/**
 * What the LISTING read alone establishes.
 *
 * `name-absent` is deliberately not a verdict. It is the one reading this check
 * refuses to act on by itself, because acting on it is what would make the listing's
 * completeness load bearing.
 */
export type ListingReading =
  | { kind: "name-absent"; listedCount: number }
  | { kind: "decided"; verdict: TeardownVerdict };

/** The account's Worker listing endpoint. */
export function workerListingUrl(accountId: string): string {
  return `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(accountId)}/workers/scripts`;
}

/** One Worker on that account, addressed by name. */
export function workerByNameUrl(accountId: string, workerName: string): string {
  return `${workerListingUrl(accountId)}/${encodeURIComponent(workerName)}`;
}

/** Cloudflare names a script by its `id`; compared with case and padding ignored. */
function sameName(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

/** Nothing was attempted, because this runner is missing what the reads need. */
export function misconfiguredVerdict(missing: string[]): TeardownVerdict {
  const named = missing.length > 0 ? missing.join(", ") : "(nothing named)";
  return {
    kind: "misconfigured",
    confirmed: false,
    exitCode: TEARDOWN_EXIT.misconfigured,
    message:
      `nothing was checked: this job is missing ${named}, so whether the loadtest ` +
      `deployment is gone is UNKNOWN. Create the missing settings and re-run the teardown.`,
  };
}

/** The listing request never reached Cloudflare, so there is nothing to read either way. */
export function noAnswerVerdict(detail: string): TeardownVerdict {
  return {
    kind: "no-answer",
    confirmed: false,
    exitCode: TEARDOWN_EXIT.noAnswer,
    message:
      `Cloudflare never answered the account's Worker listing (${detail}), so whether ` +
      `the loadtest deployment is gone is UNKNOWN. Re-run the teardown; if it repeats, ` +
      `delete the Worker by hand.`,
  };
}

/** The by-name request never reached Cloudflare, so the absence was never confirmed. */
export function byNameNoAnswerVerdict(workerName: string, detail: string): TeardownVerdict {
  return {
    kind: "by-name-no-answer",
    confirmed: false,
    exitCode: TEARDOWN_EXIT.byNameNoAnswer,
    message:
      `${workerName} was absent from the account's Worker listing, and the second read ` +
      `confirming that got no reply from Cloudflare (${detail}). One read alone cannot ` +
      `say it is gone, so whether it is gone is UNKNOWN.`,
  };
}

function unreadable(why: string): TeardownVerdict {
  return {
    kind: "listing-unreadable",
    confirmed: false,
    exitCode: TEARDOWN_EXIT.listingUnreadable,
    message:
      `Cloudflare answered 200 with something this cannot read as a Worker listing ` +
      `(${why}), so whether the loadtest deployment is gone is UNKNOWN.`,
  };
}

const decided = (verdict: TeardownVerdict): ListingReading => ({ kind: "decided", verdict });

/**
 * Judge one reply from the account's Worker listing.
 *
 * Pure: it takes the status and the body text and returns either a settled verdict or
 * the one unsettled reading, `name-absent`. Nothing here reads the clock, the network
 * or the environment.
 */
export function readWorkerListing(args: {
  workerName: string;
  status: number;
  bodyText: string;
}): ListingReading {
  const { workerName, status, bodyText } = args;

  // The STATUS is judged before the body, for the same reason the shell version
  // checked the listing's exit status before grepping it: a body searched without
  // first asking whether the read succeeded matches nothing when the read failed, and
  // matching nothing is what "the Worker is gone" looks like (#1433, L183).
  if (status !== 200) {
    return decided({
      kind: "listing-refused",
      confirmed: false,
      exitCode: TEARDOWN_EXIT.listingRefused,
      message:
        `Cloudflare answered ${status} to the account's Worker listing, so whether the ` +
        `loadtest deployment is gone is UNKNOWN. This is the listing being refused (a ` +
        `token, an account id or a route), never the Worker being absent.`,
    });
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(bodyText) as unknown;
  } catch {
    return decided(unreadable("the body is not JSON"));
  }
  if (typeof parsed !== "object" || parsed === null) {
    return decided(unreadable("the body is not a JSON object"));
  }

  const envelope = parsed as { success?: unknown; result?: unknown };
  if (envelope.success !== true) {
    return decided(unreadable("the reply does not say success: true"));
  }
  if (!Array.isArray(envelope.result)) {
    return decided(unreadable("the reply carries no result array"));
  }

  const names: string[] = [];
  for (const entry of envelope.result) {
    const id = (entry as { id?: unknown } | null)?.id;
    // A nameless entry is not skipped. A listing this cannot fully read cannot be
    // searched for an absence: the entry it could not name may be the Worker.
    if (typeof id !== "string" || !id.trim()) {
      return decided(unreadable("an entry in the listing carries no name"));
    }
    names.push(id);
  }

  // Zero Workers is the shape of a read that returned nothing useful rather than of an
  // account with nothing deployed: this account runs Slate itself, so an empty listing
  // is refused rather than read as the loadtest Worker being absent (L98).
  if (names.length === 0) {
    return decided({
      kind: "listing-empty",
      confirmed: false,
      exitCode: TEARDOWN_EXIT.listingEmpty,
      message:
        `Cloudflare listed NO Workers on this account at all, which it cannot truly be, ` +
        `so this is a read that returned nothing rather than the loadtest deployment ` +
        `being gone. Whether it is gone is UNKNOWN.`,
    });
  }

  if (names.some((id) => sameName(id, workerName))) {
    return decided({
      kind: "still-deployed",
      confirmed: false,
      exitCode: TEARDOWN_EXIT.stillDeployed,
      message:
        `${workerName} is STILL in the account's Worker listing after the delete, so the ` +
        `loadtest deployment was not torn down. Delete it by hand before the next run.`,
    });
  }

  // Absent, which is a claim rather than a verdict: see the header. The caller confirms
  // it by name before anything exits zero.
  return { kind: "name-absent", listedCount: names.length };
}

/**
 * Judge the SECOND read, of the Worker by name, made only when the listing was
 * readable and did not name it.
 *
 * The body is deliberately not parsed. Everything a body could establish here (that
 * this is really the Cloudflare API, that the token is good, that the account id
 * resolves, that the route is right) was already established by the listing's 200 a
 * moment earlier, and the one thing left to learn is carried by the status alone. So
 * a 404 is the Worker being absent, a 200 is it being present, and every other status
 * is its own refusal rather than a guess in either direction. The text is kept only to
 * put an excerpt in that refusal's message, never to decide anything.
 */
export function judgeByName(args: {
  workerName: string;
  listedCount: number;
  status: number;
  bodyText: string;
}): TeardownVerdict {
  const { workerName, listedCount, status, bodyText } = args;

  if (status === 404) {
    return {
      kind: "gone",
      confirmed: true,
      exitCode: TEARDOWN_EXIT.gone,
      message:
        `${workerName} is not among the ${listedCount} Workers on this account and a ` +
        `read of it by name answers 404, so the loadtest deployment is gone and the ` +
        `teardown is confirmed.`,
    };
  }

  if (status === 200) {
    return {
      kind: "listing-incomplete",
      confirmed: false,
      exitCode: TEARDOWN_EXIT.listingIncomplete,
      message:
        `${workerName} is STILL deployed: a read of it by name answers 200, while the ` +
        `account's listing of ${listedCount} Workers did not name it. So the teardown ` +
        `did not take AND that listing is incomplete, which means nothing else should ` +
        `be judged by it either. Delete the Worker by hand and re-read this check.`,
    };
  }

  const excerpt = bodyText.trim().replace(/\s+/g, " ").slice(0, 120);
  return {
    kind: "by-name-unreadable",
    confirmed: false,
    exitCode: TEARDOWN_EXIT.byNameUnreadable,
    message:
      `${workerName} was absent from the account's Worker listing, and the second read ` +
      `confirming that answered ${status}, which is neither present nor absent ` +
      `(${excerpt || "an empty body"}). One read alone cannot say it is gone, so whether ` +
      `it is gone is UNKNOWN.`,
  };
}
