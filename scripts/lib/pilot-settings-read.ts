// The pilot split settings as Salesforce holds them NOW (#2946), for both pilot
// reports: `WebsiteConfiguration__c`, measured on 2026-10-01 to be one record
// (trypennie.com) carrying SlatePilotActive__c, SlatePilotPercent__c and
// SlatePilotTiers__c. Salesforce keeps no history of those fields, so this is a
// reading of today, never of the days a report covers.
//
// THROWS on a failed read, and on any count of records but one: two configuration
// records would make "the" setting a pick (L521), and none means the read did not
// reach what trypennie reads.
import { sfToken, querySoqlComplete } from "@/lib/salesforce/rest";
import type { PilotSettings } from "./pilot-compare.ts";

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
