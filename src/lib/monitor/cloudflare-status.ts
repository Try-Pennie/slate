/**
 * Whether Cloudflare's own status page reports a Workers incident (2026-10-26).
 *
 * That evening Cloudflare stopped firing Slate's every minute cron for 17 minutes
 * ("Delayed, missed, and duplicated Workers Cron Triggers"). Nothing in Slate was
 * wrong and nothing in Slate could fix it, and none of the pages that went out said
 * so. The core lanes' page now quotes the incident when there is one.
 *
 * Read only when a core lane is quiet, cached for a few minutes because the page is
 * evaluated every minute, and bounded by a short timeout because it runs inside a
 * cron lane. Every way of failing is `unknown`, which the page says nothing about:
 * a status page that could not be read is not evidence that Cloudflare is fine (L11).
 * A failed read is not cached, so the next tick tries again.
 */
import { log } from "@/lib/log";

export const CLOUDFLARE_STATUS_URL = "https://www.cloudflarestatus.com/api/v2/incidents/unresolved.json";

/** How long one read answers for. The page repeats daily; its reader wants minutes, not seconds. */
export const CLOUDFLARE_STATUS_CACHE_MS = 5 * 60_000;

/** Long enough for a status page on a bad day, short enough to cost the lane little. */
const READ_TIMEOUT_MS = 3_000;

export type CloudflareCronStatus =
  | { kind: "incident"; names: string[] }
  | { kind: "clear" }
  | { kind: "unknown" };

/** An incident is ours to quote when its title or a component it lists names Workers or cron. */
const TOUCHES_WORKERS = /\bworkers?\b|\bcron\b/i;

/** The status from the feed's body. Pure, so every shape is drivable without a network. */
export function parseCloudflareIncidents(body: unknown): CloudflareCronStatus {
  const incidents = (body as { incidents?: unknown } | null)?.incidents;
  if (!Array.isArray(incidents)) return { kind: "unknown" };
  const names: string[] = [];
  for (const raw of incidents) {
    const incident = raw as { name?: unknown; components?: unknown } | null;
    if (typeof incident?.name !== "string") return { kind: "unknown" };
    const components = Array.isArray(incident.components) ? incident.components : [];
    const touches =
      TOUCHES_WORKERS.test(incident.name) ||
      components.some((c) => typeof (c as { name?: unknown })?.name === "string" && TOUCHES_WORKERS.test((c as { name: string }).name));
    if (touches) names.push(incident.name);
  }
  return names.length > 0 ? { kind: "incident", names } : { kind: "clear" };
}

let cached: { atMs: number; status: CloudflareCronStatus } | null = null;

/** For tests: forget the cached read. */
export function resetCloudflareStatusCache(): void {
  cached = null;
}

/** Cloudflare's current Workers status, never throwing. */
export async function readCloudflareCronStatus(
  // deadline-ok: the AbortController below aborts the read after `timeoutMs`.
  fetchImpl: (url: string, init?: RequestInit) => Promise<Response> = fetch,
  nowMs: number = Date.now(),
  timeoutMs: number = READ_TIMEOUT_MS,
): Promise<CloudflareCronStatus> {
  if (cached && nowMs - cached.atMs < CLOUDFLARE_STATUS_CACHE_MS) return cached.status;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(CLOUDFLARE_STATUS_URL, { signal: controller.signal });
    if (!res.ok) {
      log.warn("cloudflare-status", { msg: "status page read refused", status: res.status });
      return { kind: "unknown" };
    }
    const status = parseCloudflareIncidents(await res.json());
    if (status.kind !== "unknown") cached = { atMs: nowMs, status };
    return status;
  } catch (err) {
    log.warn("cloudflare-status", { msg: "status page read failed" }, err);
    return { kind: "unknown" };
  } finally {
    clearTimeout(timer);
  }
}
