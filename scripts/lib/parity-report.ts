// The step between the daily cal.com sweep and the app (#2031).
//
// `pnpm verify:calcom-parity` leaves a summary file; this reports it to Slate,
// which turns it into an alert with a cooldown and an all clear. The decision is
// kept here, pure and injectable, so it can be driven with hand written replies and
// no network: the entry point beside it does nothing but read the environment.
//
// It imports NOTHING, for the reason the three alerters do: it runs on a GitHub
// runner and every dependency it carries is another way for it to be unavailable
// when the install, or something else, has already gone wrong.

/**
 * One code per way of learning nothing, and one for the only pass.
 *
 * The pass is deliberately the ONLY zero. The workflow stamps the parity
 * heartbeat on it and on nothing else, so a sweep that ran faithfully and judged
 * nobody leaves the lane to go stale and page, rather than reporting itself alive
 * (#1394: a detector that has stopped concluding looks exactly like one finding
 * nothing wrong).
 */
export const REPORT_EXIT = {
  /** Slate accepted it and either paged or cleared. */
  reported: 0,
  /** No base URL or no key here; nothing was attempted. */
  notConfigured: 1,
  /** The sweep left no summary, so it died before it judged anything. */
  noSummary: 2,
  /** A summary this cannot read: a code fault, not a finding. */
  badSummary: 3,
  /** Nothing answered. Check the base URL and that the deployment serves. */
  noReply: 4,
  /** The deployment does not hold this key. */
  keyRefused: 5,
  /** The deployment has no booking API key configured, so the endpoint is closed. */
  endpointDisabled: 6,
  /** The deployment predates this endpoint. Deploy and re run. */
  notFound: 7,
  /** Slate refused the payload. A shape or vocabulary fault on this side. */
  refused: 8,
  /** A reply this cannot read: something other than the endpoint answered. */
  unreadable: 9,
  /** The sweep reached nobody, so nothing was judged and nothing was settled. */
  nothingJudged: 10,
} as const;

export interface ParitySummary {
  total: number;
  compared: number;
  findings: { verdict: string; count: number; agents: string[] }[];
}

/** What the lane's apply step repaired before the sweep ran (#2092). */
export interface ParityCorrectionSummary {
  count: number;
  agents: string[];
}

/** How many agents one finding names. Matched by a second cap at the endpoint. */
const SUMMARY_AGENT_CAP = 8;

/**
 * Shape a finished sweep's rows into what gets reported (#2031).
 *
 * `total` is the UNION of everybody either half formed a verdict about, counted
 * once, rather than the length of either side. The two halves ask about different
 * populations: the hours comparison iterates agents bookable in Slate, while the
 * roster comparison can report a cal.com host with no Slate row at all. Taking
 * Slate's side alone would let a sweep report more agents differing than it looked
 * at, which is the sort of number that makes a reader stop trusting the whole
 * message.
 *
 * `compared` is passed in rather than recomputed, because the command already
 * decides it against its own list of the verdicts that mean a week could not be
 * read on both sides, and a second derivation of that here would be free to drift
 * (L70).
 */
export function buildParitySummary(
  scheduleRows: readonly { email: string; verdict: string }[],
  membershipRows: readonly { email: string; verdict: string }[],
  compared: number,
): ParitySummary {
  const byVerdict = new Map<string, string[]>();
  for (const r of [...scheduleRows, ...membershipRows]) {
    if (r.verdict === "agree") continue;
    const at = byVerdict.get(r.verdict) ?? [];
    at.push(r.email);
    byVerdict.set(r.verdict, at);
  }
  const looked = new Set([...scheduleRows, ...membershipRows].map((r) => r.email));
  return {
    total: looked.size,
    compared,
    findings: [...byVerdict].map(([verdict, emails]) => ({
      verdict,
      count: emails.length,
      agents: emails.slice(0, SUMMARY_AGENT_CAP),
    })),
  };
}

export interface ReportInput {
  baseUrl: string;
  apiKey: string;
  runUrl: string;
  /** Returns null when the sweep left nothing behind. */
  readSummary: () => ParitySummary | null;
  /**
   * What the apply step wrote, or null when no apply ran (#2092).
   *
   * Null and a zero count are deliberately different and both reach the app: null
   * means nothing tried, so re-importing is still the remedy the alert names; zero
   * means the import ran and found nothing to write, so naming that command would
   * be advice that cannot work. A reader who cannot tell those apart cannot tell a
   * healthy morning from a broken apply step.
   */
  readApplied?: () => ParityCorrectionSummary | null;
  post: (url: string, body: unknown, apiKey: string) => Promise<{ status: number; body: unknown }>;
}

export interface ReportResult {
  exit: number;
  reason: string;
}

export async function reportOutcome(input: ReportInput): Promise<ReportResult> {
  const base = input.baseUrl.trim().replace(/\/$/, "");
  if (!base || !input.apiKey.trim()) {
    return {
      exit: REPORT_EXIT.notConfigured,
      reason: "no base URL or no BOOKING_API_KEY here, so nothing was reported",
    };
  }

  let summary: ParitySummary | null;
  try {
    summary = input.readSummary();
  } catch (err) {
    return { exit: REPORT_EXIT.badSummary, reason: `the summary could not be read: ${text(err)}` };
  }
  if (!summary) {
    return {
      exit: REPORT_EXIT.noSummary,
      reason: "the sweep left no summary, so it stopped before it judged anything",
    };
  }

  // A correction this cannot read is reported as NO apply rather than as zero. The
  // sweep's own findings are what page somebody, and they are already in hand: a
  // note about the repair failing to parse must never cost the run its report.
  let corrected: ParityCorrectionSummary | null = null;
  if (input.readApplied) {
    try {
      corrected = input.readApplied();
    } catch {
      corrected = null;
    }
  }

  let reply: { status: number; body: unknown };
  try {
    reply = await input.post(
      `${base}/api/smoke/schedule-parity`,
      { ...summary, runUrl: input.runUrl, ...(corrected ? { corrected } : {}) },
      input.apiKey,
    );
  } catch (err) {
    return { exit: REPORT_EXIT.noReply, reason: `nothing answered: ${text(err)}` };
  }

  // Each status is a different person's problem, so none of them may answer for
  // another. 503 in particular is not an outage here: it is the endpoint's own fail
  // closed for a deployment holding no booking key.
  if (reply.status === 401 || reply.status === 403) {
    return { exit: REPORT_EXIT.keyRefused, reason: "the deployment refused this key" };
  }
  if (reply.status === 503) {
    return {
      exit: REPORT_EXIT.endpointDisabled,
      reason: "the deployment has no booking API key configured, so the endpoint is closed",
    };
  }
  if (reply.status === 404) {
    return {
      exit: REPORT_EXIT.notFound,
      reason: "this deployment predates the reporting endpoint; deploy and re run",
    };
  }
  if (reply.status === 400) {
    return { exit: REPORT_EXIT.refused, reason: `Slate refused the sweep: ${errorText(reply.body)}` };
  }
  if (reply.status < 200 || reply.status >= 300) {
    return { exit: REPORT_EXIT.unreadable, reason: `unexpected reply: HTTP ${reply.status}` };
  }

  const action = (reply.body as { action?: unknown } | null)?.action;
  if (action === "page" || action === "all-clear") {
    return { exit: REPORT_EXIT.reported, reason: `Slate ${action === "page" ? "paged" : "cleared"} the drift alert` };
  }
  if (action === "unmeasured") {
    const compared = (reply.body as { compared?: unknown }).compared;
    return {
      exit: REPORT_EXIT.nothingJudged,
      reason: `the sweep compared ${typeof compared === "number" ? compared : 0} agents, so nothing was judged and nothing was settled`,
    };
  }
  return { exit: REPORT_EXIT.unreadable, reason: "the reply named no action this understands" };
}

function text(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function errorText(body: unknown): string {
  const e = (body as { error?: unknown } | null)?.error;
  return typeof e === "string" ? e : "no reason given";
}
