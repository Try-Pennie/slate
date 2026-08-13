/**
 * Transport guard for #1024. The public booker collects lead name, email, and
 * phone, so a first-time visitor following an http:// link must be redirected to
 * https:// BEFORE the browser sends anything.
 *
 * That redirect is served by the Worker itself (`worker/index.ts` via
 * `src/lib/http/https-redirect.ts`), NOT by Cloudflare config. A zone Redirect
 * Rule cannot do it: `slate.trypennie.app` is a Workers **Custom Domain**, which
 * makes the Worker the origin, so zone rules are never consulted for it (proven
 * by deploying a valid one and watching plaintext requests pass it). The
 * zone-wide "Always Use HTTPS" toggle would have worked but was rejected on
 * blast radius, since the zone carries nine hostnames, several of them
 * machine-to-machine.
 *
 * So why keep a LIVE canary check for behavior that now lives in code and has
 * unit tests? Because the unit tests prove the decision, not the deployment. A
 * bad deploy, a Custom Domain reattached as a route, or someone reordering the
 * Worker entry would all leave the tests green while production served
 * plaintext. This module holds the pure logic so the verdict is unit-testable
 * off the network; the canary asserts the real site every 30 min (a detective
 * control, matching the after-the-fact model of main-push-guard).
 */
import { retryTransient } from "./retry.ts";


/**
 * The http:// URL to probe for a given smoke base, or `null` when the base isn't
 * a public https host we expect to redirect. A localhost / loopback / already-http
 * base (a local dev run) returns null so the caller SKIPs the check instead of
 * false-failing on a dev server that legitimately serves plain http.
 */
export function httpProbeUrl(base: string): string | null {
  let url: URL;
  try {
    url = new URL(base);
  } catch {
    return null;
  }
  if (url.protocol !== "https:") return null;
  if (url.hostname === "localhost" || url.hostname === "127.0.0.1") return null;
  url.protocol = "http:";
  return url.toString();
}

const REDIRECT_STATUSES = new Set([301, 302, 307, 308]);

/**
 * True only when an http:// response is a redirect to an https:// URL. A 200 over
 * plaintext (the audited #1024 gap) or a redirect whose Location is another
 * http:// URL is NOT compliant.
 */
export function isHttpsRedirect(status: number, location: string | null | undefined): boolean {
  if (!REDIRECT_STATUSES.has(status)) return false;
  if (!location) return false;
  return /^https:\/\//i.test(location);
}

/**
 * The http:// URL to probe for a FILE under public/, or null to skip.
 *
 * #1203 / #1204: Cloudflare's asset binding answers a request for anything under
 * public/ without invoking the Worker, so `widget.js` (the script partner pages
 * load to embed the booker) was the one surface the #1024 redirect and the
 * global hardening headers never reached. Probing the site root would not catch
 * that, because the root is a page and pages were always covered: the probe has
 * to hit the asset path itself.
 */
export function assetProbeUrl(base: string, assetPath: string): string | null {
  const origin = httpProbeUrl(base);
  if (!origin) return null;
  return new URL(assetPath, origin).toString();
}

/**
 * The baseline hardening headers every Slate response is supposed to carry
 * (served globally by next.config `headers()`; HSTS #1024, the other two #1030).
 * Lowercased because a live probe reads them off a `Headers` object.
 */
export const HARDENING_HEADERS = [
  "strict-transport-security",
  "x-content-type-options",
  "referrer-policy",
] as const;

/**
 * Which of the hardening headers a response is missing, in order; empty when it
 * carries all of them.
 *
 * Takes a getter rather than a `Headers` so the decision is unit-testable off
 * the network. A present-but-EMPTY value counts as missing: a blank
 * Referrer-Policy tells a browser nothing, and scoring it as present would
 * report a real gap as covered.
 */
export function missingSecurityHeaders(
  get: (name: string) => string | null | undefined,
): string[] {
  return HARDENING_HEADERS.filter((name) => !get(name)?.trim());
}

/**
 * Fetch a probe URL, giving ONE unreachable result a second look (#1210).
 *
 * Only the unreachable path retries. A response that arrived and is wrong (a 404,
 * an HTML body where javascript belongs, a missing header) is a real finding on
 * the first look, and retrying it would delay the same answer. That distinction is
 * what `reached` carries: it is about whether we got an answer, never about
 * whether we liked it.
 *
 * The delay is deliberately tiny. The canary shares its run with the booking
 * scenarios and pays this on every 30 minute tick, so a long backoff would cost
 * wall clock on every healthy run to save a rare false page.
 */
export const PROBE_RETRY_DELAYS_MS = [500] as const;

/**
 * The trailing note that makes a RECOVERED blip visible (L77).
 *
 * A retry that quietly succeeded leaves a green run identical to one that never
 * needed it, so a probe blipping on every single tick would read as perfect
 * health for as long as it lasted. The line still passes; it just says it took two
 * looks, which is the difference between an occasional blip and a pattern.
 */
export function retryNote(attempts: number): string {
  return attempts > 1 ? ` (reached on attempt ${attempts})` : "";
}

export type ProbeOutcome =
  | { reached: true; response: Response; attempts: number }
  | { reached: false; reason: string; attempts: number };

export async function fetchProbe(opts: {
  fetchImpl: typeof fetch;
  url: string;
  init?: RequestInit;
  /** Total attempts including the first. Default 2, so one retry (#1210). */
  attempts?: number;
  delaysMs?: readonly number[];
  sleep?: (ms: number) => Promise<void>;
}): Promise<ProbeOutcome> {
  const result = await retryTransient<Response>({
    attempts: opts.attempts ?? 2,
    delaysMs: opts.delaysMs ?? PROBE_RETRY_DELAYS_MS,
    sleep: opts.sleep,
    run: async () => {
      try {
        // Any response is an ANSWER, however bad. Only a rejection is retryable.
        return { ok: true, value: await opts.fetchImpl(opts.url, opts.init) };
      } catch (e) {
        return { ok: false, reason: e instanceof Error ? e.message : String(e) };
      }
    },
  });
  return result.ok
    ? { reached: true, response: result.value, attempts: result.attempts }
    : { reached: false, reason: result.reason, attempts: result.attempts };
}

/** What the live smoke check should do about an observed transport state. */
export type RedirectVerdict = "ok" | "warn" | "page";

/**
 * Warn-then-page tiering for any live transport check.
 *
 * Paging BEFORE the fix is live in production is self-inflicted alert noise, so
 * a non-compliant result only pages once we EXPECT compliance (the
 * EXPECT_HTTPS_REDIRECT repo var, set once the behavior is confirmed live).
 * Until then it is a visible WARN. Once expected, non-compliance is a real
 * regression and pages.
 */
export function transportVerdict(compliant: boolean, expected: boolean): RedirectVerdict {
  if (compliant) return "ok";
  return expected ? "page" : "warn";
}

/**
 * Decide whether a missing http->https redirect should PAGE or merely WARN.
 * The redirect-shaped caller of `transportVerdict`, kept as its own name because
 * that is what the smoke check reads as at the call site.
 */
export function redirectVerdict(isRedirect: boolean, expectRedirect: boolean): RedirectVerdict {
  return transportVerdict(isRedirect, expectRedirect);
}

/** One line the smoke canary prints: `fail` counts against the run, `warn` does not. */
export type TransportCheck = {
  level: "ok" | "fail" | "warn" | "skip";
  message: string;
};

/**
 * Probe a static asset and judge its transport, for the smoke canary (#1203 / #1204).
 *
 * Three findings, in the order that matters if more than one is true:
 *   1. does `http://…/<asset>` redirect to https (#1203),
 *   2. does the asset still SERVE as the script partner pages load (the
 *      regression that routing assets through the Worker could introduce, and
 *      the worst of the three, since every embed breaks at once),
 *   3. does it carry the hardening headers (#1204).
 *
 * `fetch` is injected so every branch is provable without a network and a test
 * can never touch the live site. An unreachable asset fails 2 AND 3: "we could
 * not tell" must never score as healthy, which is how a broken deploy reads as a
 * quiet day around here.
 *
 * #1210: an unreachable probe gets ONE retry before that hard failure, because a
 * single network blip on a 30 minute tick used to page for something already
 * fine. Nothing else retries: a 404, the wrong content type or a missing header
 * all answered on the first look, and a second look could only give the same
 * answer later.
 */
export async function evaluateStaticAssetTransport(opts: {
  base: string;
  expected: boolean;
  assetPath?: string;
  fetchImpl?: typeof fetch;
  /** Retry shape, injected so a suite pays no wall clock (#1210). */
  attempts?: number;
  delaysMs?: readonly number[];
  sleep?: (ms: number) => Promise<void>;
}): Promise<TransportCheck[]> {
  const assetPath = opts.assetPath ?? "/widget.js";
  const doFetch = opts.fetchImpl ?? fetch;
  const retry = { attempts: opts.attempts, delaysMs: opts.delaysMs, sleep: opts.sleep };
  const probe = assetProbeUrl(opts.base, assetPath);
  if (!probe) {
    return [
      {
        level: "skip",
        message: `static asset transport check (base ${opts.base} is not a public https host)`,
      },
    ];
  }

  const plainProbe = await fetchProbe({
    fetchImpl: doFetch,
    url: probe,
    init: { redirect: "manual" },
    ...retry,
  });
  const plain = plainProbe.reached
    ? {
        status: plainProbe.response.status,
        location: plainProbe.response.headers.get("location"),
      }
    : { status: 0, location: null };
  const redirectLevel = transportVerdict(
    isHttpsRedirect(plain.status, plain.location),
    opts.expected,
  );
  const checks: TransportCheck[] = [
    {
      level: redirectLevel === "page" ? "fail" : redirectLevel,
      message:
        `http://…${assetPath} redirects to https:// (#1203): ` +
        `got ${plain.status} -> ${plain.location ?? "(no Location)"}` +
        retryNote(plainProbe.attempts),
    },
  ];

  const secureProbe = await fetchProbe({
    fetchImpl: doFetch,
    url: new URL(assetPath, opts.base).toString(),
    ...retry,
  });
  const secure = secureProbe.reached
    ? {
        status: secureProbe.response.status,
        contentType: secureProbe.response.headers.get("content-type") ?? "",
        missing: missingSecurityHeaders((name) => secureProbe.response.headers.get(name)),
        reachable: true,
        reason: "",
      }
    : {
        status: 0,
        contentType: "",
        // Unreachable: report every header as missing rather than an empty list,
        // which would read as "all present".
        missing: [...HARDENING_HEADERS],
        reachable: false,
        reason: secureProbe.reason,
      };

  const servesAsExpected =
    secure.reachable && secure.status === 200 && /javascript/i.test(secure.contentType);
  checks.push({
    // Always a hard fail, never gated on `expected`: this one is not about the
    // fix being live, it is the embed being broken.
    level: servesAsExpected ? "ok" : "fail",
    message:
      `${assetPath} still serves as javascript (got ${secure.status} ` +
      `${secure.contentType || "(no content-type)"})` +
      // Say WHY when there was no answer at all, or the reader gets "got 0" and
      // has to guess between a dead site and a broken probe.
      (secure.reachable ? "" : `: unreachable, ${secure.reason}`) +
      retryNote(secureProbe.attempts),
  });

  const headerLevel = transportVerdict(secure.missing.length === 0, opts.expected);
  checks.push({
    // An unreachable asset never merely "warns": we measured nothing.
    level: !secure.reachable ? "fail" : headerLevel === "page" ? "fail" : headerLevel,
    message:
      `${assetPath} carries the hardening headers (#1204): ` +
      (secure.missing.length ? `missing ${secure.missing.join(", ")}` : "all present"),
  });

  return checks;
}
