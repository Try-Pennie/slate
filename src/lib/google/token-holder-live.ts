import { getCloudflareContext } from "@opennextjs/cloudflare";
import { afterResponse } from "@/lib/after-response";
import { log } from "@/lib/log";
import { isWorkersRuntime } from "@/lib/platform/runtime";
import { realTimer } from "@/lib/read-within-deadline";
import { TOKEN_HOLDER_BINDING } from "@/lib/google/token-holder-object";
import { makeTokenHolderClient, type TokenHolderClient, type TokenHolderNamespace } from "@/lib/google/token-holder";

/**
 * The shared token holder (#3512), wired to the deployment: the binding and the work run
 * after a response. The decisions live in `token-holder.ts` and `dwd.ts`; this is only
 * where they meet the runtime, and it is what `dwd`'s tests replace.
 */

let warnedUnbound = false;

/**
 * The holder client, or null where there is no binding. Off the Workers runtime (`next
 * dev`, a script) there is no request context and no binding, which is expected and says
 * nothing: those callers mint exactly as before. ON the runtime a missing binding is a
 * broken deployment, said once per isolate rather than once per token read, and every
 * caller still mints, so no booking depends on it.
 */
export function tokenHolder(): TokenHolderClient | null {
  let ns: TokenHolderNamespace | undefined;
  try {
    const env = getCloudflareContext().env as unknown as Record<string, unknown>;
    ns = env[TOKEN_HOLDER_BINDING] as TokenHolderNamespace | undefined;
  } catch {
    ns = undefined;
  }
  if (!ns) {
    if (!warnedUnbound && isWorkersRuntime()) {
      warnedUnbound = true;
      log.warn("google-token-holder", { msg: `no ${TOKEN_HOLDER_BINDING} binding; every token read on this isolate mints itself` });
    }
    return null;
  }
  return makeTokenHolderClient({ namespace: ns, timer: realTimer, now: () => Date.now() });
}

/** Work that must outlive the response: a put, a refresh. A failure is logged by
 *  `afterResponse` under its label, never thrown at the caller. */
export function tokenHolderBackground(label: string, work: () => Promise<unknown>): void {
  afterResponse(label, work);
}
