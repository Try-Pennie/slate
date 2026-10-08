// The pilot split settings as Salesforce holds them NOW (#2946): `WebsiteConfiguration__c`,
// measured on 2026-10-01 to be one record (trypennie.com) carrying SlatePilotActive__c,
// SlatePilotPercent__c and SlatePilotTiers__c. trypennie reads the same record to decide
// which booker a lead sees, so these fields are what actually sends a lead to Slate.
// Salesforce keeps no history of them, so this is a reading of today, never of the days
// a report covers.
//
// Read by the pilot reports (scripts/report-pilot-*.ts), and, through the cache below,
// by the per page low volume alarm and the admin alerts page, which judge the Low pages
// only while the pilot sends Slate every Low lead.
//
// THROWS on a failed read, and on any count of records but one: two configuration
// records would make "the" setting a pick (L521), and none means the read did not
// reach what trypennie reads.
import { sfToken, querySoqlComplete } from "@/lib/salesforce/rest";

export interface PilotSettings {
  active: boolean | null;
  percent: number | null;
  tiers: string | null;
  lastModified: string | null;
}

interface ConfigRecord {
  SlatePilotActive__c?: unknown;
  SlatePilotPercent__c?: unknown;
  SlatePilotTiers__c?: unknown;
  LastModifiedDate?: unknown;
}

export const PILOT_SETTINGS_SOQL =
  "SELECT SlatePilotActive__c, SlatePilotPercent__c, SlatePilotTiers__c, LastModifiedDate FROM WebsiteConfiguration__c";

/** One record's fields, each null when Salesforce sent nothing readable (never a guessed default). */
export function settingsFromRecords(records: readonly ConfigRecord[]): PilotSettings {
  if (records.length !== 1) {
    throw new Error(`WebsiteConfiguration__c holds ${records.length} records, and the pilot settings are read from exactly one`);
  }
  const r = records[0];
  return {
    active: typeof r.SlatePilotActive__c === "boolean" ? r.SlatePilotActive__c : null,
    percent: typeof r.SlatePilotPercent__c === "number" && Number.isFinite(r.SlatePilotPercent__c) ? r.SlatePilotPercent__c : null,
    tiers: typeof r.SlatePilotTiers__c === "string" && r.SlatePilotTiers__c.trim() !== "" ? r.SlatePilotTiers__c.trim() : null,
    lastModified: typeof r.LastModifiedDate === "string" ? r.LastModifiedDate : null,
  };
}

/** Reads the settings live, with a token of its own unless one is passed. */
export async function readPilotSettings(auth?: { token: string; instanceUrl: string }): Promise<PilotSettings> {
  const { token, instanceUrl } = auth ?? (await sfToken());
  return settingsFromRecords(await querySoqlComplete<ConfigRecord>(instanceUrl, token, PILOT_SETTINGS_SOQL));
}

/**
 * How long a reading is kept. The monitor lane asks every 5 minutes in business hours
 * and the admin page on every load; the settings change when somebody edits one record,
 * so a reading this old is still today's answer, at a fraction of the Salesforce calls.
 */
export const PILOT_SETTINGS_TTL_MS = 10 * 60_000;

/**
 * How old a reading may be and still be served when a fresh read FAILS. One Salesforce
 * blip should not stand the per page alarm down; a long outage should, in its own words,
 * rather than an old split being believed for ever.
 */
export const PILOT_SETTINGS_STALE_MS = 60 * 60_000;

/**
 * A kept reading per isolate. A failure is never kept, so the next ask tries again. The
 * clock is passed in, so the windows are tested without waiting; a caller with no clock
 * of its own (a page rendering) leaves it to be read here.
 */
export function createPilotSettingsCache(read: () => Promise<PilotSettings>) {
  let kept: { atMs: number; settings: PilotSettings } | null = null;
  return {
    async read(nowMs: number = Date.now()): Promise<PilotSettings> {
      if (kept && nowMs - kept.atMs < PILOT_SETTINGS_TTL_MS) return kept.settings;
      try {
        const settings = await read();
        kept = { atMs: nowMs, settings };
        return settings;
      } catch (err) {
        if (kept && nowMs - kept.atMs < PILOT_SETTINGS_STALE_MS) return kept.settings;
        throw err;
      }
    },
  };
}

/** The isolate's one cache, for the monitor lane and the admin alerts page. */
export const pilotSettingsCache = createPilotSettingsCache(() => readPilotSettings());
