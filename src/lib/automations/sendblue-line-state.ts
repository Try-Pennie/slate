/**
 * Whether a texting line is still alive, asked of Sendblue (#3718), so a lead's saved
 * line is offered again until it is gone (Dan, 2026-10-15).
 *
 * `GET https://api.sendblue.co/status/<line>`, the call Pennie's own "Log Number Health"
 * workflow makes, answered `{ status, message, phone_number }`. Measured 2026-10-15:
 * a live line is `OK` / "Number is online"; a made up number is a 404 `NOT FOUND` /
 * "Number not found"; a wrong key is a 401 "Invalid Credentials".
 *
 * DEAD is exactly what Pennie's Number Management workflows already treat as gone:
 * "Number is offline", "Number does not support iMessage", "Number not found". Every
 * other outcome is UNKNOWN, which keeps the saved line: our key refused, an outage, a
 * message nobody has seen, no answer in time, or no key configured are all problems
 * on our side or Sendblue's, never evidence the lead's line has stopped working. Each
 * is reported through `onUnread` (no key configured is not, since nothing failed).
 *
 * Pure apart from the injected fetch and timer, so `scripts/test-sendblue-line-state.ts`
 * drives every outcome without Sendblue and without waiting (L524).
 */
import { readWithinDeadline, realTimer, type ScheduleTimer } from "../read-within-deadline.ts";

export type LineState = "alive" | "dead" | "unknown";

/** Short, so the confirmation's one wait is left mostly to the automations service. */
export const SENDBLUE_STATE_DEADLINE_MS = 1_000;

const DEAD_MESSAGES = ["number is offline", "does not support imessage", "number not found"];

export interface SendblueLineStateDeps {
  keyId: string;
  secret: string;
  fetchImpl: typeof fetch;
  timer?: ScheduleTimer;
  onUnread: (err: unknown) => void;
}

export async function sendblueLineState(line: string, deps: SendblueLineStateDeps): Promise<LineState> {
  const keyId = deps.keyId.trim();
  const secret = deps.secret.trim();
  if (keyId === "" || secret === "") return "unknown";
  // Called bare: Cloudflare's fetch throws "Illegal invocation" as a method of another object.
  const doFetch = deps.fetchImpl;
  const state = await readWithinDeadline<LineState>(
    async () => {
      const res = await doFetch(`https://api.sendblue.co/status/${encodeURIComponent(line)}`, {
        headers: { "sb-api-key-id": keyId, "sb-api-secret-key": secret },
      });
      type StatusBody = { status?: unknown; message?: unknown } | null;
      const body = (await res.json().catch(() => null)) as StatusBody;
      const status = typeof body?.status === "string" ? body.status.toUpperCase() : "";
      const message = typeof body?.message === "string" ? body.message.toLowerCase() : "";
      if (DEAD_MESSAGES.some((m) => message.includes(m))) return "dead";
      if (res.ok && status === "OK" && message.includes("online")) return "alive";
      throw new Error(`sendblue status answered ${res.status}${message ? `: ${message}` : ""}`);
    },
    SENDBLUE_STATE_DEADLINE_MS,
    deps.onUnread,
    deps.timer ?? realTimer,
  );
  return state ?? "unknown";
}
