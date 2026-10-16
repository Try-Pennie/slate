// Hand a smoke canary failure to the Worker before posting it ourselves (#3801).
//
// The canary's alert step runs on bare node and posts straight to Slack, so it has
// no memory of its last post: a slow availability read posted on every failing run,
// about 31 times in a week, saying the same thing. The Worker has that memory (the
// alert throttle in `alert_state`), so the step first hands the failure over, the
// way the run already stamps its heartbeat with `POST /api/smoke/heartbeat`, and the
// Worker posts it through the same rule as every other condition: at once when a
// check is newly failing, otherwise once a day.
//
// If the handoff fails for ANY reason (no key, the Worker is down, a refusal, a
// timeout, an answer that does not say the Worker took it), the step posts directly
// as it always has, because the canary's alert has to work when the Worker is the
// thing that is down. Imports nothing: this runs with no dependency install.

/** What the Worker answered, or why there was no usable answer. */
export type HandoffResult =
  | { handled: true; outcome: "sent" | "held" }
  | { handled: false; reason: string };

export type HandoffFetch = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal },
) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>;

/** Where the run's other steps point; the same default their curl lines use. */
export const DEFAULT_SLATE_BASE_URL = "https://slate.trypennie.app";

/** Long enough for a cold Worker, short enough that the direct post is not late. */
export const HANDOFF_TIMEOUT_MS = 15_000;

export async function handOffSmokeFailure(
  input: { mode: string; text: string; checks: string[] },
  env: Record<string, string | undefined>,
  doFetch: HandoffFetch = fetch as unknown as HandoffFetch,
  timeoutMs: number = HANDOFF_TIMEOUT_MS,
): Promise<HandoffResult> {
  const key = env.BOOKING_API_KEY_CANARY?.trim() ?? "";
  if (key === "") return { handled: false, reason: "no BOOKING_API_KEY_CANARY in this step" };
  // `||`, not `??`: an unset repo variable arrives as "", which `??` would keep (#1498).
  const base = (env.SLATE_BASE_URL?.trim() || DEFAULT_SLATE_BASE_URL).replace(/\/+$/, "");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await doFetch(`${base}/api/smoke/failure`, {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify({ outcome: "failed", mode: input.mode, text: input.text, checks: input.checks }),
      signal: controller.signal,
    });
    if (!res.ok) return { handled: false, reason: `the Worker answered ${res.status}` };
    const body = (await res.json().catch(() => null)) as { outcome?: unknown } | null;
    const outcome = body?.outcome;
    // Only an answer saying the page went out, or was held because the same failure
    // was already posted, means somebody has been told. "failed" (the Worker's own
    // Slack post failed) and "skipped" (the Worker cannot post) leave it to us.
    if (outcome === "sent" || outcome === "held") return { handled: true, outcome };
    return { handled: false, reason: `the Worker did not post it (${String(outcome)})` };
  } catch (err) {
    return { handled: false, reason: err instanceof Error ? err.message : String(err) };
  } finally {
    clearTimeout(timer);
  }
}
