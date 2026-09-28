// Does any of Slate's own automation still authenticate with the SHARED booking key?
// (#2822)
//
// The canary, the deploy probe and every heartbeat stamp used to send the shared
// `BOOKING_API_KEY`, so in `api_caller_seen` a partner holding that key could not be
// told from our own traffic (#2819). They now send `BOOKING_API_KEY_CANARY` and are
// recorded as `canary`. Since #2865 the shared key is retired and the Worker holds no
// such secret, so a step wired back to it would be refused with a 401 at run time, on
// the canary lane that pages about it. This catches the same mistake at build time,
// where it costs nothing. So this is a scan, not a comment.
//
// Two surfaces, each blind where the other looks:
//   - a WORKFLOW naming the bare shared key (a `secrets.` reference, an env name, a
//     `$BOOKING_API_KEY` in a shell line), outside the load test, which runs against
//     its own throwaway Worker whose key is a different secret altogether;
//   - a SCRIPT reading the bare shared key from its environment, which is how a hand
//     run smoke or deploy command would put a person's own call under `shared`.
// Comment lines are skipped on both, because a sentence explaining the shared key is
// not a use of it. Pure, so scripts/test-canary-key-wiring.ts drives it on fixtures.

/** Workflows that may name the bare shared key, each with its reason (L129). */
export const SHARED_KEY_WORKFLOW_EXEMPT: Record<string, string> = {
  "loadtest.yml":
    "names BOOKING_API_KEY only as its drivers' own variable, fed from the LOADTEST_BOOKING_API_KEY secret; the throwaway Worker it drives holds that value as BOOKING_API_KEY_CANARY (LOADTEST_ALLOWED_SECRETS, #2865) and records into its own branch database",
};

/** Script paths (relative to scripts/) that may name the bare shared key, with reasons. */
export function sharedKeyScriptExempt(rel: string): string | null {
  if (rel.startsWith("loadtest/")) return "the load test drives its own throwaway Worker, whose key is not production's";
  if (/^test-.*\.ts$/.test(rel)) return "a test suite names the key in fixtures and never sends it";
  if (/^lib\/scan-.*\.ts$/.test(rel)) return "a scanner names the key as text to look for";
  return null;
}

const BARE = /\bBOOKING_API_KEY\b/;

function isComment(line: string, marker: "#" | "//"): boolean {
  const t = line.trim();
  return marker === "#" ? t.startsWith("#") : t.startsWith("//") || t.startsWith("*") || t.startsWith("/*");
}

export interface WiringHit {
  line: number;
  text: string;
}

/** Lines of a workflow that name the bare shared key outside a comment. */
export function workflowSharedKeyHits(yaml: string): WiringHit[] {
  const hits: WiringHit[] = [];
  yaml.split("\n").forEach((text, i) => {
    if (isComment(text, "#")) return;
    const code = text.replace(/\s#.*$/, "");
    if (BARE.test(code)) hits.push({ line: i + 1, text: text.trim() });
  });
  return hits;
}

/** Lines of a script that READ the bare shared key: `process.env.BOOKING_API_KEY`, or
 *  the name passed as a string to an env helper. Outside comments. */
export function scriptSharedKeyReads(source: string): WiringHit[] {
  const hits: WiringHit[] = [];
  source.split("\n").forEach((text, i) => {
    if (isComment(text, "//")) return;
    if (/process\.env\.BOOKING_API_KEY\b|process\.env\[\s*["']BOOKING_API_KEY["']\s*\]|\(\s*["']BOOKING_API_KEY["']\s*[,)]/.test(text)) {
      hits.push({ line: i + 1, text: text.trim() });
    }
  });
  return hits;
}
