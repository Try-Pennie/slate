// How a smoke script records its own crash (#4062), so the canary alert can say
// "The reschedule smoke crashed after 4 checks passed: the connection timed out."
// rather than claiming the run never started.
//
// `crashReason` is the one short reason for a thrown error, shared by the crash
// record and the teardown lines (scripts/lib/smoke-own-booking.ts): a network failure
// the runner meets is said in words, anything else goes through `shortErrorReason`,
// so a raw error or a stack never reaches Slack. It imports the app's error text, so
// it is for scripts run with the alias hook; smoke-latency, which runs on bare node,
// does not use it.
import { shortErrorReason } from "@/lib/notify/error-text";
import { failureLogPath, nodeSmokeFailureIo, recordCrash, type FailureLogIo } from "./smoke-failure-log.ts";

/** The socket codes a runner's request fails with, in the words the alert uses. */
const NETWORK_WORDS: Record<string, string> = {
  ETIMEDOUT: "the connection timed out",
  UND_ERR_CONNECT_TIMEOUT: "the connection timed out",
  UND_ERR_HEADERS_TIMEOUT: "the response timed out",
  UND_ERR_BODY_TIMEOUT: "the response timed out",
  ECONNRESET: "the connection was reset",
  UND_ERR_SOCKET: "the connection was reset",
  EPIPE: "the connection was reset",
  ECONNABORTED: "the connection was aborted",
  ECONNREFUSED: "the connection was refused",
  ENOTFOUND: "the host name did not resolve",
  EAI_AGAIN: "the host name did not resolve",
  ENETUNREACH: "the network was unreachable",
  EHOSTUNREACH: "the network was unreachable",
};

/** One short line for a thrown error: words for a network failure, else its text. */
export function crashReason(err: unknown): string {
  const code = (err as { cause?: { code?: unknown } } | null)?.cause?.code;
  if (typeof code === "string" && NETWORK_WORDS[code]) return NETWORK_WORDS[code];
  const reason = shortErrorReason(err);
  return typeof code === "string" && /^[A-Z_]+$/.test(code) ? `${reason} (${code})` : reason;
}

/**
 * Record a smoke's crash in the failure log and print it. Called from each smoke
 * script's crash handler. Returns whether it was recorded (false on a hand run with
 * no SMOKE_FAILURE_FILE), and never throws, so the handler still exits 1.
 */
export function recordSmokeCrash(
  where: string,
  err: unknown,
  env: Record<string, string | undefined> = process.env,
  io: FailureLogIo = nodeSmokeFailureIo,
): boolean {
  let reason: string;
  try {
    reason = crashReason(err);
  } catch {
    reason = "an error that could not be read";
  }
  console.error(`${where} crashed: ${reason}`);
  return recordCrash(io, failureLogPath(env), where, reason);
}
