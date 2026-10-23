/**
 * The smoke canary's side of the one lease over the two smoke test advisors (#4180): reading the
 * endpoint's answers (`/api/smoke/test-advisor-lease`) and waiting for the lease up to the
 * canary's bound. The command is `scripts/smoke-test-advisor-lease.ts`; the workflow wiring is
 * pinned by `scripts/test-smoke-canary-workflow.ts`, and this by
 * `scripts/test-test-advisor-lease-wait.ts`.
 *
 * Bare node safe: imports only from scripts/.
 */
import { CANARY_LEASE_WAIT_MS, minutesOf, waitForTestAdvisors } from "./test-advisor-lease-wait.ts";

/** Every way the command can end, on its own code (L11). */
export const TEST_ADVISOR_LEASE_EXIT = {
  /** take: the lease is held for this run. release: no claim of this run's remains. */
  ok: 0,
  /** No key or no base URL here, or no token to release. */
  misconfigured: 1,
  /** The request never got a reply. */
  noAnswer: 2,
  /** A reply the endpoint never produces. */
  unreadableReply: 3,
  /** The deployment rejected the key. */
  unauthorized: 4,
  /** The deployment has no canary key configured. */
  notConfigured: 5,
  /** The deployment does not carry the endpoint. */
  endpointMissing: 6,
  /** take only: another run held the advisors past the canary's wait, so the pass is NOT MEASURED. */
  notMeasured: 7,
  /** release only: the database refused the release (the TTL frees the lease regardless). */
  releaseRefused: 8,
} as const;

export type TestAdvisorLeaseExit = (typeof TEST_ADVISOR_LEASE_EXIT)[keyof typeof TEST_ADVISOR_LEASE_EXIT];

export interface LeaseReading {
  exit: TestAdvisorLeaseExit;
  detail: string;
  /** take, when held: the claim the release must name. */
  token?: string;
}

function refusal(status: number): LeaseReading | null {
  if (status === 401) return { exit: TEST_ADVISOR_LEASE_EXIT.unauthorized, detail: "The deployment refused the canary key." };
  if (status === 503) return { exit: TEST_ADVISOR_LEASE_EXIT.notConfigured, detail: "The deployment has no canary key configured." };
  if (status === 404) return { exit: TEST_ADVISOR_LEASE_EXIT.endpointMissing, detail: "The deployment does not carry the test advisor lease endpoint yet." };
  return null;
}

function parse(body: string): Record<string, unknown> | null {
  try {
    const v: unknown = JSON.parse(body);
    return v !== null && typeof v === "object" ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** Read one answer to a take. `busy` reads as the not measured exit, which the wait asks past. */
export function readTakeReply(status: number, body: string): LeaseReading {
  const refused = refusal(status);
  if (refused) return refused;
  if (status !== 200) return { exit: TEST_ADVISOR_LEASE_EXIT.unreadableReply, detail: `The lease endpoint answered HTTP ${status}.` };
  const r = parse(body);
  if (r?.outcome === "busy") {
    return { exit: TEST_ADVISOR_LEASE_EXIT.notMeasured, detail: "Another run (usually the daily reroute drill) holds the smoke test advisors." };
  }
  if (r?.outcome === "held" && typeof r.token === "string" && r.token.length > 0) {
    return { exit: TEST_ADVISOR_LEASE_EXIT.ok, detail: "The smoke test advisors are held for this run.", token: r.token };
  }
  return { exit: TEST_ADVISOR_LEASE_EXIT.unreadableReply, detail: "The lease endpoint answered something it never produces." };
}

/** Read the answer to a release. Released and already gone are both fine: the release is idempotent. */
export function readReleaseReply(status: number, body: string): LeaseReading {
  const refused = refusal(status);
  if (refused) return refused;
  const r = parse(body);
  if (status === 500 && r?.outcome === "refused") {
    return { exit: TEST_ADVISOR_LEASE_EXIT.releaseRefused, detail: "The deployment could not release the lease; it lapses on its own within ten minutes." };
  }
  if (status === 200 && r?.outcome === "released") return { exit: TEST_ADVISOR_LEASE_EXIT.ok, detail: "Released the smoke test advisors." };
  if (status === 200 && r?.outcome === "not-held") {
    return {
      exit: TEST_ADVISOR_LEASE_EXIT.ok,
      detail: "The lease was no longer held under this run's token: released already, or it lapsed and another run took it.",
    };
  }
  return { exit: TEST_ADVISOR_LEASE_EXIT.unreadableReply, detail: `The lease endpoint answered HTTP ${status} with something it never produces.` };
}

export interface CanaryWaitDeps {
  now(): number;
  sleep(ms: number): Promise<void>;
  boundMs?: number;
  intervalMs?: number;
}

/**
 * Take the lease, asking again while another run holds it, up to the canary's bound. `ask` sends
 * one take and answers the reply's status and body; a request that throws is no answer.
 */
export async function takeLeaseWhenFree(ask: () => Promise<{ status: number; body: string }>, deps: CanaryWaitDeps): Promise<LeaseReading> {
  const boundMs = deps.boundMs ?? CANARY_LEASE_WAIT_MS;
  const waited = await waitForTestAdvisors<LeaseReading>(
    async () => {
      let reply: { status: number; body: string };
      try {
        reply = await ask();
      } catch (err) {
        return { busy: false, value: { exit: TEST_ADVISOR_LEASE_EXIT.noAnswer, detail: `The lease endpoint did not answer: ${err instanceof Error ? err.message : String(err)}` } };
      }
      const reading = readTakeReply(reply.status, reply.body);
      return reading.exit === TEST_ADVISOR_LEASE_EXIT.notMeasured ? { busy: true } : { busy: false, value: reading };
    },
    { now: deps.now, sleep: deps.sleep, boundMs, intervalMs: deps.intervalMs },
  );
  if (waited.kind === "answered") return waited.value;
  return {
    exit: TEST_ADVISOR_LEASE_EXIT.notMeasured,
    detail:
      `Another run (usually the daily reroute drill) held the smoke test advisors for the whole ${minutesOf(boundMs)} minute wait ` +
      `(${waited.tries} asks), so this full pass booked nothing and is not measured. The next full pass tries again.`,
  };
}
