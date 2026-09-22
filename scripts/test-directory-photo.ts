/**
 * The Workspace directory photo read (#2600).
 *
 * The rule pinned here is the one that was got WRONG first time and that no
 * amount of code reading would have caught: Google serves `thumbnailPhotoUrl`
 * for accounts with NO photo, pointing at a placeholder it generates, so the
 * field's presence counts the roster rather than the photos. The first pass
 * reported 94 of 98 bookable agents with a photo when the real answer is 84
 * (measured 2026-09-22, all 98 fetched).
 *
 * Run: node --experimental-strip-types scripts/test-directory-photo.ts
 */
import {
  uploadedPhotoUrl,
  workspacePhotoUrl,
  advisorPhotoUrl,
  clearDirectoryPhotoCache,
  DIRECTORY_PHOTO_TTL_MS,
  DIRECTORY_SCOPE,
  type DirectoryPhoto,
  type DirectoryDeps,
} from "../src/lib/google/directory.ts";
import { assert, eq, finish } from "./lib/harness.ts";

/** Both shapes are real values read off the live directory on 2026-09-22. */
const REAL = "https://lh3.googleusercontent.com/a/ACg8ocK_example=s96-c";
const PLACEHOLDER = "https://lh3.google.com/u/0/ogw/default-user=s96-c";

// --- the host rule -----------------------------------------------------------
eq(uploadedPhotoUrl(REAL), REAL, "an uploaded photo is kept");
eq(
  uploadedPhotoUrl(PLACEHOLDER),
  null,
  "Google's generated placeholder is not a photo, which 10 of the 94 agents carrying the field have",
);
eq(uploadedPhotoUrl(undefined), null, "no field at all is no photo");
eq(uploadedPhotoUrl(""), null, "an empty string is no photo");
eq(uploadedPhotoUrl(42), null, "a value that is not a string is no photo");
eq(uploadedPhotoUrl("not a url"), null, "something that will not parse is no photo");
eq(
  uploadedPhotoUrl("https://lh3.googleusercontent.com.evil.test/a/x"),
  null,
  "a lookalike host is no photo, because the check is the HOST and not a substring",
);

// --- the read ----------------------------------------------------------------
function deps(over: Partial<DirectoryDeps> & { body?: unknown; ok?: boolean; status?: number }) {
  const calls = { get: 0, scopes: [] as string[], urls: [] as string[] };
  const base: DirectoryDeps = {
    token: async (_email, scope) => {
      calls.scopes.push(scope);
      return "tok";
    },
    get: async (url) => {
      calls.get++;
      calls.urls.push(url);
      return { ok: over.ok ?? true, status: over.status ?? 200, body: over.body ?? {} };
    },
    nowMs: () => 1_000,
  };
  return { deps: { ...base, ...over } as DirectoryDeps, calls };
}

/** Each case starts from an empty cache, or the one before it answers for it. */
function fresh(over: Parameters<typeof deps>[0]) {
  clearDirectoryPhotoCache();
  return deps(over);
}

{
  const { deps: d, calls } = fresh({ body: { thumbnailPhotoUrl: REAL } });
  const got: DirectoryPhoto = await workspacePhotoUrl("a@x.test", d);
  assert(got.ok === true && got.url === REAL, "a real photo comes back");
  eq(calls.scopes[0], DIRECTORY_SCOPE, "it asks for the directory scope");
  assert(
    calls.urls[0].includes("viewType=domain_public"),
    "it reads the domain public view, which is what the impersonated agent may read",
  );
}
{
  const { deps: d } = fresh({ body: { thumbnailPhotoUrl: PLACEHOLDER } });
  const got = await workspacePhotoUrl("b@x.test", d);
  assert(
    got.ok === true && got.url === null,
    "a placeholder reads as a successful read that found no photo",
  );
}
{
  const { deps: d } = fresh({ ok: false, status: 403 });
  const got = await workspacePhotoUrl("c@x.test", d);
  assert(
    got.ok === false,
    "a refused read is a different answer from no photo, or a bad minute at Google is indistinguishable from an agent with no picture (L215)",
  );
  assert(
    got.ok === false && got.status === 403,
    "and it carries the status, so a caller tells a rate limit from a refusal without reading the message (L35)",
  );
}
{
  const { deps: d } = fresh({ ok: false, status: 429 });
  const got = await workspacePhotoUrl("c2@x.test", d);
  assert(got.ok === false && got.status === 429, "a rate limit is reported as one");
}
{
  const { deps: d } = fresh({
    token: async () => {
      throw new Error("delegation refused");
    },
  });
  const got = await workspacePhotoUrl("d@x.test", d);
  assert(got.ok === false, "a thrown token is reported rather than propagated");
}

// --- the cache ---------------------------------------------------------------
{
  let now = 5_000;
  const { deps: d, calls } = fresh({
    body: { thumbnailPhotoUrl: REAL },
    nowMs: () => now,
  });
  await workspacePhotoUrl("e@x.test", d);
  await workspacePhotoUrl("e@x.test", d);
  eq(calls.get, 1, "a second read inside the window costs nothing");
  now += DIRECTORY_PHOTO_TTL_MS + 1;
  await workspacePhotoUrl("e@x.test", d);
  eq(calls.get, 2, "and it is read again once the window has passed");
}
{
  const { deps: d, calls } = fresh({ ok: false, status: 500 });
  await workspacePhotoUrl("f@x.test", d);
  await workspacePhotoUrl("f@x.test", d);
  eq(
    calls.get,
    2,
    "a failure is never cached, or one bad minute holds an agent's page on the initials for an hour",
  );
}

// --- what a page actually calls ------------------------------------------------
{
  const { deps: d, calls } = fresh({ body: { thumbnailPhotoUrl: REAL } });
  eq(await advisorPhotoUrl(null, d), null, "no address means no photo");
  eq(calls.get, 0, "and Google is never asked about nobody");
}
{
  const { deps: d } = fresh({ ok: false, status: 500 });
  eq(
    await advisorPhotoUrl("g@x.test", d),
    null,
    "a failure reaches the page as null rather than throwing, because the fallback is the initials",
  );
}

finish();
