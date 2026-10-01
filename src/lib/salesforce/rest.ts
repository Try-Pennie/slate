/**
 * The Salesforce REST calls every Slate reader shares: one token exchange and one
 * paginated SOQL query (#2593).
 *
 * These lived privately inside `sync.ts`, which was the only reader until the
 * below-tier booking check needed to ask about leads. A second copy of the token
 * exchange and the `nextRecordsUrl` walk would be two places for the retry and the
 * error text to drift (L41), so both readers come through here.
 *
 * Both THROW on a refusal rather than answering empty: an empty answer from a
 * query that never ran is indistinguishable from Salesforce holding nothing.
 */
import { sfClientId, sfClientSecret, sfInstanceUrl } from "@/lib/env";
import { fetchSfWithRetry } from "@/lib/salesforce/retry";

export async function sfToken(): Promise<{ token: string; instanceUrl: string }> {
  const res = await fetchSfWithRetry(`${sfInstanceUrl()}/services/oauth2/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      client_id: sfClientId(),
      client_secret: sfClientSecret(),
    }),
  });
  if (!res.ok) throw new Error(`SF token failed: ${res.status} ${await res.text()}`);
  const data = (await res.json()) as { access_token: string; instance_url: string };
  return { token: data.access_token, instanceUrl: data.instance_url };
}

/** Every record a SOQL query returns, following `nextRecordsUrl` to the end. */
export async function querySoqlAll<T>(
  instanceUrl: string,
  token: string,
  soql: string,
): Promise<T[]> {
  const records: T[] = [];
  let url = `${instanceUrl}/services/data/v60.0/query?q=${encodeURIComponent(soql)}`;
  for (;;) {
    const res = await fetchSfWithRetry(url, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) throw new Error(`SF query failed: ${res.status} ${await res.text()}`);
    const data = (await res.json()) as {
      records: T[];
      done: boolean;
      nextRecordsUrl?: string;
    };
    records.push(...data.records);
    if (data.done || !data.nextRecordsUrl) break;
    url = `${instanceUrl}${data.nextRecordsUrl}`;
  }
  return records;
}

/** One page of a SOQL answer, as Salesforce sends it. */
export interface SoqlPage<T> {
  totalSize?: number;
  records: T[];
  done: boolean;
  nextRecordsUrl?: string;
}

/**
 * Every record a SOQL query returns, REFUSING a short read (#2946): the walk must end
 * holding exactly the `totalSize` the first page promised. `querySoqlAll` stops at
 * whatever `done` says, which is right for its callers; a measurement built on a
 * read that came back short would report fewer applications as a finding.
 *
 * Pure apart from the injected page getter, so a node suite drives it.
 */
export async function collectSoqlComplete<T>(getPage: (path: string | null) => Promise<SoqlPage<T>>): Promise<T[]> {
  const records: T[] = [];
  let next: string | null = null;
  let promised: number | null = null;
  for (let pages = 0; ; pages++) {
    const page = await getPage(next);
    if (!Array.isArray(page.records)) throw new Error(`SF query page ${pages} carried no records list`);
    if (pages === 0) {
      if (typeof page.totalSize !== "number") throw new Error("SF query answered with no totalSize, so a short read could not be seen");
      promised = page.totalSize;
    }
    records.push(...page.records);
    if (page.done || !page.nextRecordsUrl) break;
    next = page.nextRecordsUrl;
  }
  if (records.length !== promised) {
    throw new Error(`SF query came back short: ${records.length} records of the ${promised} it promised`);
  }
  return records;
}

/** `collectSoqlComplete` against the live org. */
export async function querySoqlComplete<T>(instanceUrl: string, token: string, soql: string): Promise<T[]> {
  return collectSoqlComplete<T>(async (path) => {
    const url = path === null ? `${instanceUrl}/services/data/v60.0/query?q=${encodeURIComponent(soql)}` : `${instanceUrl}${path}`;
    const res = await fetchSfWithRetry(url, { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) throw new Error(`SF query failed: ${res.status} ${await res.text()}`);
    return (await res.json()) as SoqlPage<T>;
  });
}
