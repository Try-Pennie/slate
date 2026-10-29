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

const ID_CHECKSUM_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ012345";

/**
 * The three character case checksum Salesforce appends to a 15 character id to make the
 * 18 character one: per five character block, one bit per uppercase letter (the first
 * character the lowest bit), indexing `ID_CHECKSUM_ALPHABET`. The one place it is
 * computed: `leadIdSpellings` builds the long spelling from it, and
 * `idCaseChecksumMatches` reads an 18 character id against it.
 */
export function idChecksum(short: string): string {
  let suffix = "";
  for (let block = 0; block < 3; block++) {
    let bits = 0;
    for (let i = 0; i < 5; i++) {
      const c = short[block * 5 + i] ?? "";
      if (c >= "A" && c <= "Z") bits |= 1 << i;
    }
    suffix += ID_CHECKSUM_ALPHABET[bits];
  }
  return suffix;
}

/**
 * Whether an 18 character id's suffix is the checksum of its first 15 characters' case
 * (#4388). An id whose case was changed on the way (a spreadsheet, a form that lowercases)
 * keys to a different record, and the suffix is what says so. The suffix is compared
 * without regard to its own case, since its letters encode the case of the others and
 * carry none themselves. A 15 character id carries no checksum, so it always agrees.
 */
export function idCaseChecksumMatches(id: string): boolean {
  if (id.length !== 18) return true;
  return id.slice(15).toUpperCase() === idChecksum(id.slice(0, 15));
}
