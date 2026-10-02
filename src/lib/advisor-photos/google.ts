/**
 * The two Google directory reads the photo refresh makes (#3027), wired to the
 * real delegation. Read only: the scope is `admin.directory.user.readonly`.
 *
 * Both run AS `DIRECTORY_ADMIN_SUBJECT`. An agent subject cannot read
 * `photos.get` at all (403 for everybody, measured 2026-10-02), so the subject
 * has to hold an admin role in Google Workspace.
 */
import { getDelegatedToken } from "@/lib/google/dwd";
import { GoogleHttpError } from "@/lib/google/http-error";
import { DirectoryReadError, type DirectoryAccount } from "@/lib/advisor-photos/refresh";

export const DIRECTORY_SCOPE = "https://www.googleapis.com/auth/admin.directory.user.readonly";

const API = "https://admin.googleapis.com/admin/directory/v1";

/** One directory request may take this long before it is abandoned. */
export const DIRECTORY_REQUEST_TIMEOUT_MS = 15_000;

/** Pages of 500, the API's ceiling; 251 accounts measured 2026-10-02 is one page. */
const PAGE_SIZE = 500;
/** Finite, so a listing that keeps handing back a page token cannot loop for ever (L110). */
const MAX_PAGES = 20;

/**
 * Token errors that mean the subject is not allowed to act, as opposed to Google
 * having a bad minute: delegation revoked, the subject gone or not an admin.
 */
const REFUSING_TOKEN_REASONS = new Set(["invalid_grant", "unauthorized_client", "access_denied"]);

async function tokenFor(subject: string): Promise<string> {
  try {
    return await getDelegatedToken(subject, DIRECTORY_SCOPE);
  } catch (err) {
    if (err instanceof GoogleHttpError) {
      const refused =
        err.status === 401 || err.status === 403 || REFUSING_TOKEN_REASONS.has(err.reason ?? "") || /invalid_grant|unauthorized_client/.test(err.message);
      throw new DirectoryReadError(
        `the delegated token for the directory subject was refused (${err.status}${err.reason ? ` ${err.reason}` : ""})`,
        err.status,
        refused,
      );
    }
    throw err;
  }
}

/** Every account in the directory, all domains, with the addresses each one holds. */
export async function listDirectoryAccounts(subject: string): Promise<DirectoryAccount[]> {
  const token = await tokenFor(subject);
  const out: DirectoryAccount[] = [];
  let pageToken: string | undefined;
  for (let page = 0; page < MAX_PAGES; page++) {
    const url = new URL(`${API}/users`);
    url.searchParams.set("customer", "my_customer");
    url.searchParams.set("maxResults", String(PAGE_SIZE));
    url.searchParams.set("projection", "basic");
    url.searchParams.set("fields", "nextPageToken,users(primaryEmail,emails)");
    if (pageToken) url.searchParams.set("pageToken", pageToken);
    const res = await fetch(url, {
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(DIRECTORY_REQUEST_TIMEOUT_MS),
    });
    if (!res.ok) {
      await res.body?.cancel().catch(() => {});
      throw new DirectoryReadError(`the directory listing answered ${res.status}`, res.status, res.status === 401 || res.status === 403);
    }
    const body = (await res.json()) as { users?: DirectoryAccount[]; nextPageToken?: string };
    out.push(...(body.users ?? []));
    pageToken = body.nextPageToken;
    if (!pageToken) return out;
  }
  throw new DirectoryReadError(`the directory listing ran past ${MAX_PAGES} pages`, null, false);
}

/** One `photos.get`, returned raw so the classification stays pure. */
export async function getDirectoryPhoto(subject: string, email: string): Promise<{ status: number; body: string }> {
  const token = await tokenFor(subject);
  const res = await fetch(`${API}/users/${encodeURIComponent(email)}/photos/thumbnail`, {
    headers: { authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(DIRECTORY_REQUEST_TIMEOUT_MS),
  });
  return { status: res.status, body: await res.text() };
}
