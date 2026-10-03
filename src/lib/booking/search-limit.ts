/** Max booking rows a lookup returns (bounds the growth-table read, cap-safe).
 *  The lookup UI reads it to tell when a text result filled the bound (#903), so
 *  it lives here, apart from `search.ts`: that module imports the secret key
 *  client, and a client component importing from it ships that client to the
 *  browser (#3172). */
export const SEARCH_LIMIT = 20;
