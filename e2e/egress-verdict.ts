/**
 * Whether the server under test stayed on this machine, judged after the run.
 *
 * Read from TWO independent sources (L345), so neither can answer for the other:
 * the guard's own log file, and the server's own output, where the guard also
 * prints every refusal. A log that went missing or could not be read is its own
 * failure, never an empty log, because "the record is gone" and "nothing was
 * recorded" look identical otherwise (L11, L98). Each cause has its own message.
 *
 * Pure, so `scripts/test-e2e-isolation.ts` drives every outcome without a server.
 */

/** The marker the guard prints on every refusal, beside the log line. */
export const EGRESS_REFUSED_MARKER = "E2E_EGRESS_REFUSED";

export type EgressEvidence = {
  /** Whether the guard's load marker file exists. */
  loaded: boolean;
  /** The log file's contents, or null when it is missing or could not be read. */
  log: string | null;
  /** Why the log could not be read, when it could not. */
  logProblem?: string;
  /** Everything the server printed. */
  serverOutput: string;
};

export function egressVerdict(e: EgressEvidence): string | null {
  if (!e.loaded) {
    return "The egress guard never loaded into the server, so nothing proves the run stayed on this machine.";
  }
  if (e.log === null) {
    return `The egress guard's log could not be read (${e.logProblem ?? "missing"}), so a refused connection could not be seen. Failing rather than reading it as empty.`;
  }
  if (e.log.trim()) {
    return `The server tried to reach another machine, and the guard refused it:\n${e.log.trim()}`;
  }
  const printed = e.serverOutput
    .split("\n")
    .filter((l) => l.includes(EGRESS_REFUSED_MARKER))
    .slice(0, 10);
  if (printed.length) {
    return `The server's own output shows refused connections its log does not carry:\n${printed.join("\n")}`;
  }
  return null;
}
