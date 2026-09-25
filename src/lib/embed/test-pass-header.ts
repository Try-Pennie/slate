/**
 * The browser's half of the public test bucket's pass (#2666).
 *
 * Split from `test-pass.ts` because the Booker, the manage page and the admin
 * panel all import this, and that module pulls in `node:crypto`, which has no
 * place in a client bundle. Imports nothing.
 */

/** The one header the pass travels in, on every read and write that needs it. */
export const TEST_PASS_HEADER = "x-slate-test-pass";

/**
 * The codes a refused pass is answered with. Three, because the tester has three
 * different things to do: reload (expired, or refused), or tell us (switched off).
 */
export const TEST_PASS_REFUSAL_CODES = {
  expired: "TEST_PASS_EXPIRED",
  refused: "TEST_PASS_REFUSED",
  off: "TEST_PASS_OFF",
} as const;

export type TestPassRefusalCode =
  (typeof TEST_PASS_REFUSAL_CODES)[keyof typeof TEST_PASS_REFUSAL_CODES];

const CODES: readonly string[] = Object.values(TEST_PASS_REFUSAL_CODES);

/** The headers carrying a pass, or undefined when there is none, so a request for
 *  a real bucket is sent exactly as it always was. */
export function testPassHeaders(pass: string | null | undefined): Record<string, string> | undefined {
  return pass ? { [TEST_PASS_HEADER]: pass } : undefined;
}

/**
 * The server's own sentence when a reply is a refused pass, or null for any other
 * reply. The sentence is read back rather than rebuilt here, so the tester reads
 * the words the refusal was made with, whichever surface met it.
 */
export function testPassRefusalSentence(body: unknown): string | null {
  if (!body || typeof body !== "object") return null;
  const { code, error } = body as { code?: unknown; error?: unknown };
  if (typeof code !== "string" || !CODES.includes(code)) return null;
  return typeof error === "string" && error.length > 0 ? error : null;
}
