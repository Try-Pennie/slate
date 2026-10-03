// The post-deploy probe's three reads over real HTTP (#1037), shared by every caller
// so the plain probe, the gradual deploy (#3095) and the rollback (#3094) judge a
// deployment by the SAME requests rather than three copies that drift (L41).
//
// Dependency free (node's global fetch only): the deploy and rollback jobs run this on
// bare node.

import type { ProbeDeps } from "./post-deploy-probe.ts";

export interface ProbeHttpConfig {
  /** Base URL, no trailing slash needed. */
  appUrl: string;
  /** The canary's own booking key; the version endpoint is key-authed. */
  key: string;
  /** The isolated test bucket the availability read uses. */
  bucket: string;
  /**
   * The value of the `Cloudflare-Workers-Version-Overrides` header, or null for none
   * (#3095). Sent on EVERY request, so the version, health and availability answers
   * all come from the version it names rather than from whichever side of a split the
   * request happened to land on.
   */
  versionOverride: string | null;
}

/** The header Cloudflare reads to pin a request to one version in the deployment. */
export const VERSION_OVERRIDE_HEADER = "Cloudflare-Workers-Version-Overrides";

export function probeHeaders(cfg: Pick<ProbeHttpConfig, "versionOverride">, authed: string | null): Record<string, string> {
  return {
    ...(authed ? { authorization: `Bearer ${authed}` } : {}),
    ...(cfg.versionOverride ? { [VERSION_OVERRIDE_HEADER]: cfg.versionOverride } : {}),
  };
}

export function httpProbeDeps(cfg: ProbeHttpConfig): ProbeDeps {
  const appUrl = cfg.appUrl.replace(/\/$/, "");
  const authed = probeHeaders(cfg, cfg.key);
  const anonymous = probeHeaders(cfg, null);
  return {
    // null means RETRY, not fail: during propagation the previous version answers,
    // and a transient network error here must not fail a good deploy.
    liveCommit: async () => {
      try {
        const res = await fetch(`${appUrl}/api/smoke/version`, { headers: authed });
        if (!res.ok) return null;
        const body = (await res.json()) as { commit?: unknown };
        return typeof body.commit === "string" ? body.commit : null;
      } catch {
        return null;
      }
    },
    health: async () => {
      try {
        const res = await fetch(`${appUrl}/api/health`, { headers: anonymous });
        // The real contract (src/app/api/health/route.ts): `db` is the STRING
        // "ok" | "unreachable", not a boolean. Anything else maps to null, i.e.
        // "could not tell", so an unexpected shape never reads as healthy. `reason`
        // is carried as given and only an exact `heartbeat_stale` is ever excused.
        const body = (await res.json().catch(() => ({}))) as { db?: unknown; reason?: unknown };
        const dbOk = body.db === "ok" ? true : body.db === "unreachable" ? false : null;
        return { status: res.status, dbOk, reason: typeof body.reason === "string" ? body.reason : null };
      } catch {
        return { status: 0, dbOk: null, reason: null };
      }
    },
    availability: async () => {
      try {
        const from = new Date().toISOString();
        const res = await fetch(
          `${appUrl}/api/availability?bucket=${encodeURIComponent(cfg.bucket)}&from=${encodeURIComponent(from)}`,
          { headers: authed },
        );
        const body = (await res.json().catch(() => ({}))) as { slots?: unknown };
        return { status: res.status, slotsPresent: Array.isArray(body.slots) && body.slots.length > 0 };
      } catch {
        return { status: 0, slotsPresent: false };
      }
    },
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    now: () => Date.now(),
  };
}
