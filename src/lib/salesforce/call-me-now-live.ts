/**
 * Call me now against the real org (#3718): the reads and the one write
 * `call-me-now.ts` decides with.
 *
 * A lead is waiting on the button, so every Salesforce call here is bounded tighter
 * than the background default (10 seconds an attempt, three attempts): two attempts of
 * five seconds, so the worst case is about ten seconds, not thirty. The write is safe to
 * retry because it sets fixed values. One token serves the whole press.
 *
 * One Salesforce login is kept per isolate for `CALL_ME_NOW_LOGIN_TTL_MS` rather than
 * taken on every card load: the button check runs on each one, and Slate's Salesforce
 * user is shared with other integrations under one hourly login ceiling. Fifteen minutes
 * is the shortest session Salesforce can be set to, so a kept login cannot expire while
 * in use whatever the org's setting; a login Salesforce refuses (401) is dropped
 * (`forgetCallMeNowLogin`), so a revoked one costs one failed ask, not fifteen minutes of
 * them, while an outage does not turn every card load back into a fresh login.
 *
 * The switch is read through its own cache, a minute long, because trypennie may turn
 * Call me now off when nobody is there to call, and the button should follow within a
 * minute. A failed read serves the last reading for five minutes, then fails.
 */
import { createReadingCache } from "./pilot-settings";
import { querySoqlComplete, sfToken, updateSfRecord } from "./rest";
import type { SfFetchOptions } from "./retry";
import { isLeadId } from "./lead-xbc";
import {
  leadFromRecord,
  LEAD_SOQL_FIELDS,
  SWITCH_SOQL,
  switchFromRecord,
  type CallMeNowDeps,
  type CallMeNowSwitch,
} from "./call-me-now";

export const CALL_ME_NOW_SF_OPTS: SfFetchOptions = { maxAttempts: 2, timeoutMs: 5_000 };

export const CALL_ME_NOW_LOGIN_TTL_MS = 15 * 60_000;

const loginCache = createReadingCache(() => sfToken(CALL_ME_NOW_SF_OPTS), {
  ttlMs: CALL_ME_NOW_LOGIN_TTL_MS,
  // Never served past its window: an old login is worth nothing once a fresh one fails.
  staleMs: CALL_ME_NOW_LOGIN_TTL_MS,
});

/** Drops the kept login after Salesforce refuses it, so the next ask logs in afresh. */
export function forgetCallMeNowLogin(): void {
  loginCache.forget();
}

export const CALL_ME_NOW_SWITCH_TTL_MS = 60_000;
export const CALL_ME_NOW_SWITCH_STALE_MS = 5 * 60_000;

async function readSwitchLive(): Promise<CallMeNowSwitch> {
  const { token, instanceUrl } = await loginCache.read();
  const records = await querySoqlComplete<Record<string, unknown>>(instanceUrl, token, SWITCH_SOQL, CALL_ME_NOW_SF_OPTS);
  // trypennie reads one record; two would make "the" switch a pick, none means the read
  // did not reach what trypennie reads.
  if (records.length !== 1) throw new Error(`WebsiteConfiguration__c holds ${records.length} records, and the switch is read from exactly one`);
  return switchFromRecord(records[0]!);
}

const switchCache = createReadingCache(readSwitchLive, {
  ttlMs: CALL_ME_NOW_SWITCH_TTL_MS,
  staleMs: CALL_ME_NOW_SWITCH_STALE_MS,
});

/** The deps for one check or press, on the kept login. */
export function liveCallMeNowDeps(): CallMeNowDeps {
  const token = () => loginCache.read();
  return {
    async readLead(leadId) {
      if (!isLeadId(leadId)) throw new Error("not a Lead id");
      const { token: t, instanceUrl } = await token();
      const rows = await querySoqlComplete<Record<string, unknown>>(
        instanceUrl,
        t,
        `SELECT ${LEAD_SOQL_FIELDS} FROM Lead WHERE Id = '${leadId}'`,
        CALL_ME_NOW_SF_OPTS,
      );
      return rows.length === 0 ? null : leadFromRecord(rows[0]!);
    },
    readSwitch: () => switchCache.read(),
    async writeRequested(leadId) {
      const { token: t, instanceUrl } = await token();
      await updateSfRecord(instanceUrl, t, "Lead", leadId, { CallMeNow__c: true, Call_Me_Now_Pending__c: true }, CALL_ME_NOW_SF_OPTS);
    },
  };
}
