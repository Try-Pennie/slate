// Post a scheduled check's decision, or say nothing (#3092, #3101).
//
// The daily dependency audit and the nightly coverage ratchet each decide a message
// (or none) in a pure module, then end the same way: post it to the channel the
// workflow names, and stay red whether or not the post landed. This is that ending,
// once. Imports nothing outside scripts/, like every alerter here (#1598).
import { postToAlertsChannel } from "./slack-post.ts";

export type PostFn = (msg: {
  text: string;
  channel?: string;
}) => Promise<{ ok: boolean; error?: string }>;

/**
 * The ending of a detector that reports whether it CONCLUDED (the burst counter, the
 * kill switch and the router replay): post the decided alert, if any, and carry the
 * conclusion through untouched, because the workflow stamps a heartbeat from it
 * whatever happened to the post. Unlike `postDecision`, a delivered alert is ok: these
 * runs go red on their own verdict, not on having spoken.
 */
export async function postConcludedDecision(
  post: PostFn,
  env: Record<string, string | undefined>,
  decision: { alert: string | null; concluded: boolean },
): Promise<{ ok: boolean; reason: string; concluded: boolean }> {
  const res =
    decision.alert === null
      ? { ok: true, reason: "nothing to say" }
      : await postToAlertsChannel(post, decision.alert, env);
  return { ...res, concluded: decision.concluded };
}

export async function postDecision(
  post: PostFn,
  env: Record<string, string | undefined>,
  decision: { alert: string | null; detail: string },
): Promise<{ code: number; reason: string; detail: string }> {
  if (decision.alert === null) return { code: 0, reason: "nothing to say", detail: decision.detail };
  const res = await postToAlertsChannel(post, decision.alert, env);
  // Red either way: a posted alert does not fix what it reports, and an unsent one is
  // not evidence that there was nothing to report.
  return { code: 1, reason: res.reason, detail: decision.detail };
}
