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
