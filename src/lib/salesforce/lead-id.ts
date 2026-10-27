/**
 * Whether a string is a Salesforce LEAD id, in a module with no imports, so a page's client
 * code can ask it (#4205: the coordinator page looks a customer up as soon as a whole Lead
 * id is pasted). `lead-xbc.ts`, which re-exports it, also reaches the Salesforce REST client,
 * and importing that into a client component carried the deployment's Salesforce setting
 * names into the browser bundle, which `pnpm cf:build` refuses (#2335).
 */

/** A Salesforce LEAD id: the `00Q` key prefix, 15 or 18 characters. */
export function isLeadId(id: string): boolean {
  return /^00Q[a-zA-Z0-9]{12}(?:[a-zA-Z0-9]{3})?$/.test(id);
}
