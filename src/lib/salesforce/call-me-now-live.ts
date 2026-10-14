/**
 * Call me now against the real org (#3718): the reads and the one write
 * `call-me-now.ts` decides with.
 *
 * A lead is waiting on the button, so every Salesforce call here is bounded tighter
 * than the background default (10 seconds an attempt, three attempts): two attempts of
 * five seconds, so the worst case is about ten seconds, not thirty. The write is safe to
 * retry because it sets fixed values. One token serves the whole press.
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

export const CALL_ME_NOW_SWITCH_TTL_MS = 60_000;
export const CALL_ME_NOW_SWITCH_STALE_MS = 5 * 60_000;

async function readSwitchLive(): Promise<CallMeNowSwitch> {
  const { token, instanceUrl } = await sfToken(CALL_ME_NOW_SF_OPTS);
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

/** The deps for one check or press, sharing one token across its calls. */
export function liveCallMeNowDeps(): CallMeNowDeps {
  let auth: Promise<{ token: string; instanceUrl: string }> | null = null;
  const token = () => (auth ??= sfToken(CALL_ME_NOW_SF_OPTS));
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
