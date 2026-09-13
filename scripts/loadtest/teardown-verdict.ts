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
// Three outcomes, three wordings, three exit codes:
//
//   gone            the Worker is not in the account's listing  -> confirmed, exit 0
//   still-deployed  the Worker is in the listing                -> NOT torn down
//   everything else the listing could not be read at all        -> NOT confirmed
//
// **Why the account LISTING rather than a read of the script by name.**
// `GET /accounts/{id}/workers/scripts/{name}` answers 404 for a script that is gone,
// which looks like the obvious check, but 404 is not unique to that cause: a wrong
// account id, a revoked route, or a typo in the path answers 404 too, and reading any
// of those as "gone" would be exactly the defect the previous comment here warned
// about (#1433, L183) rebuilt in a new place: a dead read wearing a clean teardown's
// clothes. The account listing inverts the burden. Nothing is called gone unless a
// reply arrives that is POSITIVELY readable: HTTP 200, a Cloudflare envelope saying
// `success: true`, a `result` that is an array, and every entry carrying a name. An
// expired token, a wrong account, a platform error page or a truncated body fails one
// of those and lands on its own refusal rather than on the pass. That is the same care
// the old comment recorded (judge the read before its content), applied to the reply's
// SHAPE rather than to a command's exit status.

/**
 * Every way the confirmation can end, and the exit code it ends on.
 *
 * One code per cause, never a shared "it failed". These are what the workflow step
 * exits on, and each names a different thing to go and do: a repo setting to create,
 * Cloudflare to ask about, a token to renew, or a deployment genuinely still running.
 */
export const TEARDOWN_EXIT = {
  /** The Worker is absent from the account's listing. The only zero. */
  gone: 0,
  /** This runner has no token, no account id, or no Worker name, so nothing was read. */
  misconfigured: 1,
  /** The Worker is still listed, so the delete did not take. */
  stillDeployed: 2,
  /** The request never got a reply at all: DNS, TLS, a timeout, no network. */
  noAnswer: 3,
  /** Cloudflare answered, and not with a 200. */
  listingRefused: 4,
  /** A 200 whose body is not a listing this can search. */
  listingUnreadable: 5,
  /** A readable listing with no Workers in it, which this account cannot be in. */
  listingEmpty: 6,
} as const;

export type TeardownVerdictKind =
  | "gone"
  | "misconfigured"
  | "still-deployed"
  | "no-answer"
  | "listing-refused"
  | "listing-unreadable"
  | "listing-empty";

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

/** The account's Worker listing endpoint for one account. */
export function workerListingUrl(accountId: string): string {
  return `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(accountId)}/workers/scripts`;
}

/** Cloudflare names a script by its `id`; compared with case and padding ignored. */
function sameName(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

/** Nothing was attempted, because this runner is missing what the read needs. */
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

/** The request never reached Cloudflare, so there is nothing to read either way. */
export function noAnswerVerdict(detail: string): TeardownVerdict {
  return {
    kind: "no-answer",
    confirmed: false,
    exitCode: TEARDOWN_EXIT.noAnswer,
    message:
      `Cloudflare never answered (${detail}), so whether the loadtest deployment is ` +
      `gone is UNKNOWN. Re-run the teardown; if it repeats, delete the Worker by hand.`,
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

/**
 * Judge one reply from the account's Worker listing.
 *
 * Pure: it takes the status and the body text and returns the verdict. Nothing here
 * reads the clock, the network, or the environment.
 */
export function judgeWorkerListing(args: {
  workerName: string;
  status: number;
  bodyText: string;
}): TeardownVerdict {
  const { workerName, status, bodyText } = args;

  // The STATUS is judged before the body, for the same reason the shell version
  // checked the listing's exit status before grepping it: a body searched without
  // first asking whether the read succeeded matches nothing when the read failed, and
  // matching nothing is what "the Worker is gone" looks like (#1433, L183).
  if (status !== 200) {
    return {
      kind: "listing-refused",
      confirmed: false,
      exitCode: TEARDOWN_EXIT.listingRefused,
      message:
        `Cloudflare answered ${status} to the account's Worker listing, so whether the ` +
        `loadtest deployment is gone is UNKNOWN. This is the listing being refused (a ` +
        `token, an account id or a route), never the Worker being absent.`,
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(bodyText) as unknown;
  } catch {
    return unreadable("the body is not JSON");
  }
  if (typeof parsed !== "object" || parsed === null) {
    return unreadable("the body is not a JSON object");
  }

  const envelope = parsed as { success?: unknown; result?: unknown };
  if (envelope.success !== true) {
    return unreadable("the reply does not say success: true");
  }
  if (!Array.isArray(envelope.result)) {
    return unreadable("the reply carries no result array");
  }

  const names: string[] = [];
  for (const entry of envelope.result) {
    const id = (entry as { id?: unknown } | null)?.id;
    // A nameless entry is not skipped. A listing this cannot fully read cannot be
    // searched for an absence: the entry it could not name may be the Worker.
    if (typeof id !== "string" || !id.trim()) {
      return unreadable("an entry in the listing carries no name");
    }
    names.push(id);
  }

  // Zero Workers is the shape of a read that returned nothing useful rather than of an
  // account with nothing deployed: this account runs Slate itself, so an empty listing
  // is refused rather than read as the loadtest Worker being absent (L98).
  if (names.length === 0) {
    return {
      kind: "listing-empty",
      confirmed: false,
      exitCode: TEARDOWN_EXIT.listingEmpty,
      message:
        `Cloudflare listed NO Workers on this account at all, which it cannot truly be, ` +
        `so this is a read that returned nothing rather than the loadtest deployment ` +
        `being gone. Whether it is gone is UNKNOWN.`,
    };
  }

  if (names.some((id) => sameName(id, workerName))) {
    return {
      kind: "still-deployed",
      confirmed: false,
      exitCode: TEARDOWN_EXIT.stillDeployed,
      message:
        `${workerName} is STILL in the account's Worker listing after the delete, so the ` +
        `loadtest deployment was not torn down. Delete it by hand before the next run.`,
    };
  }

  return {
    kind: "gone",
    confirmed: true,
    exitCode: TEARDOWN_EXIT.gone,
    message:
      `${workerName} is not among the ${names.length} Workers on this account, so the ` +
      `loadtest deployment is gone and the teardown is confirmed.`,
  };
}
