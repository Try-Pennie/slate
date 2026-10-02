// The advisor photo refresh (#3027): every outcome a read or a run can reach is
// PRODUCED here by a fixture, rather than merely allowed for (L151).
//
// Run: node --experimental-strip-types --import ./scripts/register-paths.mjs scripts/test-advisor-photos.ts
import {
  FAILING_PAGE_AFTER_MS,
  FLIP_TO_NONE_LIMIT,
  KNOWN_PLACEHOLDER_SHA256,
  PHOTO_MAX_BYTES,
  REPEATED_IMAGE_FLOOR,
  decodeBase64Url,
  fromBase64,
  isPhotoHash,
  planRefresh,
  readPhotoResponse,
  sha256Hex,
  sniffPhotoMime,
  type PhotoRead,
  type PhotoSubjectUser,
  type StoredPhotoState,
} from "../src/lib/advisor-photos/core.ts";
import {
  DirectoryReadError,
  PHOTO_RETRY,
  needsAttention,
  runPhotoRefresh,
  type RefreshDeps,
  type PhotoWrites,
} from "../src/lib/advisor-photos/refresh.ts";
import {
  FORBIDDEN_403,
  GOOGLE_PLACEHOLDER_PNG_B64,
  NO_PHOTO_404,
  NO_USER_404,
  base64url,
  fakeImage,
  photoBody,
} from "./lib/advisor-photo-fixtures.ts";
import { assert, eq, finish } from "./lib/harness.ts";

const NOW = Date.parse("2026-10-03T04:20:00Z");

// --- the placeholder constant is the hash of what Google really serves ----------
{
  const bytes = new Uint8Array(Buffer.from(GOOGLE_PLACEHOLDER_PNG_B64, "base64"));
  eq(bytes.length, 800, "the measured placeholder is the 800 byte PNG");
  const sha = await sha256Hex(bytes);
  assert(KNOWN_PLACEHOLDER_SHA256.has(sha), "its SHA-256 is the one held as a known placeholder");
  const read = await readPhotoResponse(200, photoBody(bytes, "image/png"));
  eq(read.kind, "none", "a 200 serving the placeholder is a measured none");
  eq((read as { why?: string }).why, "placeholder", "and says it was the placeholder");
}

// --- base64url decoding ---------------------------------------------------------
{
  const bytes = new Uint8Array([0xfb, 0xff, 0xfe, 0x01, 0x02]);
  const urlSafe = Buffer.from(bytes).toString("base64url"); // carries - and _
  assert(/[-_]/.test(urlSafe), "the fixture really exercises the URL safe alphabet");
  eq([...(decodeBase64Url(urlSafe) ?? [])], [...bytes], "URL safe base64 decodes to the same bytes");
  eq([...(decodeBase64Url(urlSafe + "=") ?? [])], [...bytes], "with or without padding");
  // Google's own description of photoData: `=` written as `*`, and padding that may
  // also be `.`. Both shapes must decode to the same bytes.
  const padded = Buffer.from(bytes).toString("base64").replace(/\+/g, "-").replace(/\//g, "_");
  assert(padded.endsWith("="), "the fixture really carries padding");
  eq([...(decodeBase64Url(padded.replace(/=/g, "*")) ?? [])], [...bytes], "padding written as * decodes");
  eq([...(decodeBase64Url(padded.replace(/=/g, ".")) ?? [])], [...bytes], "padding written as . decodes");
  eq([...(decodeBase64Url(urlSafe + "..")) ?? []], [...bytes], "extra trailing dots are padding, not data");
  eq(decodeBase64Url("ab*c"), null, "a * inside the data is refused, not read as padding");
  eq(decodeBase64Url("ab+c"), null, "the standard alphabet's + is refused, not guessed at");
  eq(decodeBase64Url("a"), null, "a length no base64 can have is refused");
  eq(decodeBase64Url(""), null, "empty is refused");
  eq([...(fromBase64(Buffer.from(bytes).toString("base64")) ?? [])], [...bytes], "standard base64 round trips");
}

// --- signatures and hashes ------------------------------------------------------
eq(sniffPhotoMime(fakeImage("jpeg", 1)), "image/jpeg", "a JPEG signature is a JPEG");
eq(sniffPhotoMime(fakeImage("png", 1)), "image/png", "a PNG signature is a PNG");
eq(sniffPhotoMime(new Uint8Array([0x47, 0x49, 0x46, 0x38])), null, "a GIF is neither");
assert(isPhotoHash("a".repeat(64)), "64 lower case hex is a photo hash");
assert(!isPhotoHash("A".repeat(64)), "upper case is not");
assert(!isPhotoHash("a".repeat(63)), "63 characters is not");
assert(!isPhotoHash("../" + "a".repeat(61)), "a path is not");

// --- every outcome of one read --------------------------------------------------
{
  const jpeg = fakeImage("jpeg", 7);
  const ok = await readPhotoResponse(200, photoBody(jpeg));
  eq(ok.kind, "photo", "200 with a JPEG is a photo");
  if (ok.kind === "photo") {
    eq(ok.mime, "image/jpeg", "typed by its bytes");
    eq(ok.sha256, await sha256Hex(jpeg), "hashed over the decoded bytes");
    eq(Buffer.from(ok.base64, "base64").equals(Buffer.from(jpeg)), true, "stored base64 decodes to the bytes Google sent");
    eq(ok.width, 96, "width carried");
  }
  const mislabelled = await readPhotoResponse(200, photoBody(fakeImage("png", 3), "image/jpeg"));
  eq(mislabelled.kind === "photo" && mislabelled.mime, "image/png", "the type comes from the magic number, not the label");

  const cases: [string, number, string, PhotoRead["kind"], string][] = [
    ["no photo", 404, NO_PHOTO_404, "none", ""],
    ["no such user", 404, NO_USER_404, "not-in-directory", ""],
    ["a 404 with another body", 404, '{"error":{"message":"gone"}}', "failed", "unrecognised"],
    ["a refusal", 403, FORBIDDEN_403, "failed", "refused"],
    ["unauthorised", 401, "{}", "failed", "refused"],
    ["a rate limit", 429, "{}", "failed", "429"],
    ["a server error", 503, "{}", "failed", "503"],
    ["not JSON", 200, "<html>", "failed", "not JSON"],
    ["no photo data", 200, "{}", "failed", "no photo data"],
    ["bad base64url", 200, JSON.stringify({ photoData: "ab+c/" }), "failed", "base64url"],
    ["wrong magic number", 200, JSON.stringify({ photoData: base64url(new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39])) }), "failed", "not a JPEG or a PNG"],
    ["oversize", 200, photoBody(fakeImage("jpeg", 2, PHOTO_MAX_BYTES + 10)), "failed", "too large"],
  ];
  for (const [label, status, body, kind, reasonPart] of cases) {
    const got = await readPhotoResponse(status, body);
    eq(got.kind, kind, `${label} reads as ${kind}`);
    if (got.kind === "failed") {
      assert(got.reason.includes(reasonPart), `${label}: the reason says "${reasonPart}" (got "${got.reason}")`);
      eq(got.refused, status === 401 || status === 403, `${label}: refused only for 401 and 403`);
    }
  }
}

// --- planning ---------------------------------------------------------------------
const user = (id: string, active = true): PhotoSubjectUser => ({ id, email: `${id}@x.test`, active });
const photoRead = async (seed: number): Promise<Extract<PhotoRead, { kind: "photo" }>> =>
  (await readPhotoResponse(200, photoBody(fakeImage("jpeg", seed)))) as Extract<PhotoRead, { kind: "photo" }>;
const row = (id: string, state: "photo" | "none", sha: string | null, failing: string | null = null): StoredPhotoState => ({
  user_id: id,
  state,
  sha256: sha,
  failing_since: failing,
});

{
  // gained, unchanged, changed, none, never read none, deactivated deleted.
  const p1 = await photoRead(1);
  const p2 = await photoRead(2);
  const p3 = await photoRead(3);
  const plan = planRefresh({
    nowMs: NOW,
    full: true,
    users: [user("a"), user("b"), user("c"), user("d"), user("e"), user("gone", false)],
    rows: [row("b", "photo", p2.sha256), row("c", "photo", "old"), row("d", "none", null), row("gone", "photo", "z")],
    reads: new Map<string, PhotoRead>([
      ["a", p1],
      ["b", p2],
      ["c", p3],
      ["d", { kind: "none", why: "no-photo" }],
      ["e", { kind: "none", why: "no-photo" }],
    ]),
  });
  eq(plan.counts.gained, 1, "a never read person with a photo is gained");
  eq(plan.counts.unchanged, 2, "same hash and same none are unchanged");
  eq(plan.counts.changed, 1, "a different hash is changed");
  eq(plan.touch.sort().join(","), "b,d", "unchanged rows are only touched");
  eq(plan.full.map((r) => r.user_id).sort().join(","), "a,c,e", "changed rows are written in full");
  const a = plan.full.find((r) => r.user_id === "a")!;
  assert(a.bytes_b64 !== null && a.mime === "image/jpeg" && a.sha256 === p1.sha256, "a photo row carries its bytes, type and hash");
  const e = plan.full.find((r) => r.user_id === "e")!;
  assert(e.bytes_b64 === null && e.mime === null && e.sha256 === null, "a none row carries no image");
  for (const r of plan.full) {
    eq(Object.keys(r).sort().join(","), "bytes_b64,changed_at,checked_at,failing_since,height,last_error,mime,sha256,state,user_id,width", `the ${r.user_id} row carries every column (L705)`);
  }
  eq(plan.deleteIds.join(","), "gone", "a deactivated person's row is deleted");
  eq(plan.counts.deleted, 1, "and counted");
  assert(!needsAttention(plan), "an ordinary run needs nobody");
}

{
  // A run for one person never deletes anybody else's row.
  const plan = planRefresh({
    nowMs: NOW,
    full: false,
    users: [user("a"), user("gone", false)],
    rows: [row("gone", "photo", "z")],
    reads: new Map<string, PhotoRead>([["a", { kind: "none", why: "no-photo" }]]),
  });
  eq(plan.deleteIds.length, 0, "one person's refresh deletes nothing");
}

{
  // The flip guard: one over the limit refuses every none write; at the limit it does not.
  const users = Array.from({ length: FLIP_TO_NONE_LIMIT + 2 }, (_, i) => user(`u${i}`));
  const rows = users.map((u) => row(u.id, "photo", `sha-${u.id}`));
  const flipping = (n: number) =>
    planRefresh({
      nowMs: NOW,
      full: true,
      users,
      rows,
      reads: new Map<string, PhotoRead>(users.map((u, i) => [u.id, i < n ? { kind: "none", why: "no-photo" } : { kind: "failed", reason: "x", status: 503, refused: false }])),
    });
  const atLimit = flipping(FLIP_TO_NONE_LIMIT);
  assert(!atLimit.flipGuardTripped, `${FLIP_TO_NONE_LIMIT} losses is allowed`);
  eq(atLimit.counts.lost, FLIP_TO_NONE_LIMIT, "and written");
  const over = flipping(FLIP_TO_NONE_LIMIT + 1);
  assert(over.flipGuardTripped, `${FLIP_TO_NONE_LIMIT + 1} losses trips the guard`);
  eq(over.full.length, 0, "and no none row is written");
  eq(over.counts.lost, 0, "nobody is counted as lost");
  eq(over.heldNone.length, FLIP_TO_NONE_LIMIT + 1, "every withheld loss is named");
  assert(needsAttention(over), "a tripped guard needs a person");
}

{
  // The repeated image floor: two holders is legitimate, three is held for newcomers.
  const shared = await photoRead(50);
  const two = planRefresh({
    nowMs: NOW,
    full: true,
    users: [user("p"), user("q")],
    rows: [],
    reads: new Map<string, PhotoRead>([["p", shared], ["q", shared]]),
  });
  eq(two.full.length, 2, "two people sharing one image (a team logo) are both written");
  eq(two.repeated.length, 0, "and nothing is reported");

  const three = planRefresh({
    nowMs: NOW,
    full: true,
    users: [user("p"), user("q"), user("r")],
    rows: [row("p", "photo", shared.sha256)],
    reads: new Map<string, PhotoRead>([["p", shared], ["q", shared], ["r", shared]]),
  });
  eq(REPEATED_IMAGE_FLOOR, 3, "the floor is three");
  eq(three.repeated.length, 1, "three holders is reported as a repeated image");
  eq(three.repeated[0]!.holders.join(","), "p@x.test,q@x.test,r@x.test", "naming everybody who holds it");
  eq(three.repeated[0]!.held.join(","), "q@x.test,r@x.test", "and the people it was not written for");
  eq(three.full.length, 0, "it is not written as a new photo for anybody");
  eq(three.touch.join(","), "p", "the person who already held it keeps it");
  assert(needsAttention(three), "a repeated image needs a person");
}

{
  // Failures: the stored row is untouched, a streak starts, and pages after three days.
  const fresh = planRefresh({
    nowMs: NOW,
    full: true,
    users: [user("f"), user("n")],
    rows: [row("f", "photo", "keep")],
    reads: new Map<string, PhotoRead>([
      ["f", { kind: "failed", reason: "answered 503", status: 503, refused: false }],
      ["n", { kind: "failed", reason: "answered 503", status: 503, refused: false }],
    ]),
  });
  eq(fresh.full.length, 0, "a failure writes no image");
  eq(fresh.failed[0]!.failing_since, new Date(NOW).toISOString(), "the first failure starts the streak now");
  eq(fresh.failedNeverRead.map((f) => f.email).join(","), "n@x.test", "a never read person's failure is reported, with no row to mark");
  eq(fresh.streaks.length, 0, "one failure of somebody with a row pages nobody");
  // Somebody never read has no row to carry a streak, so their failure is the only
  // chance to say so: it needs a person, by name, on the run it happens.
  assert(needsAttention(fresh), "a never read person whose read failed needs a person");
  assert(!needsAttention({ ...fresh, failedNeverRead: [] }), "and that is the only thing making this run need one");

  const since = new Date(NOW - FAILING_PAGE_AFTER_MS).toISOString();
  const third = planRefresh({
    nowMs: NOW,
    full: true,
    users: [user("f")],
    rows: [row("f", "photo", "keep", since)],
    reads: new Map<string, PhotoRead>([["f", { kind: "failed", reason: "answered 503", status: 503, refused: false }]]),
  });
  eq(third.failed[0]!.failing_since, since, "the streak keeps its start");
  eq(third.streaks.map((s) => s.email).join(","), "f@x.test", "the third daily failure pages by name");
  const almost = planRefresh({
    nowMs: NOW - 1,
    full: true,
    users: [user("f")],
    rows: [row("f", "photo", "keep", since)],
    reads: new Map<string, PhotoRead>([["f", { kind: "failed", reason: "x", status: 503, refused: false }]]),
  });
  eq(almost.streaks.length, 0, "a millisecond short of it pages nobody");
}

{
  const plan = planRefresh({
    nowMs: NOW,
    full: true,
    users: [user("m")],
    rows: [row("m", "photo", "keep")],
    reads: new Map<string, PhotoRead>([["m", { kind: "not-in-directory" }]]),
  });
  eq(plan.notInDirectory.join(","), "m@x.test", "somebody the directory lacks is named");
  eq(plan.full.length + plan.touch.length + plan.failed.length, 0, "and never writes a row");
}

// --- the runner -------------------------------------------------------------------
interface Recorded {
  full: string[];
  touch: string[];
  failed: string[];
  deleted: string[];
}
function recorder(): { writes: PhotoWrites; rec: Recorded } {
  const rec: Recorded = { full: [], touch: [], failed: [], deleted: [] };
  return {
    rec,
    writes: {
      writeFull: async (rows) => void rec.full.push(...rows.map((r) => r.user_id)),
      touch: async (ids) => void rec.touch.push(...ids),
      markFailed: async (rows) => void rec.failed.push(...rows.map((r) => r.user_id)),
      deleteRows: async (ids) => void rec.deleted.push(...ids),
    },
  };
}

function deps(over: Partial<RefreshDeps> & { photos?: Record<string, { status: number; body: string } | Error> }): RefreshDeps & { sleeps: number[]; asked: string[] } {
  const sleeps: number[] = [];
  const asked: string[] = [];
  const photos = over.photos ?? {};
  return {
    subject: "admin@x.test",
    listUsers: async () => [user("a"), user("b"), user("gone", false)],
    listRows: async () => [row("gone", "photo", "z")],
    listDirectory: async () => [{ primaryEmail: "a@x.test" }, { primaryEmail: "other@x.test", emails: [{ address: "b@x.test" }] }],
    getPhoto: async (_s, email) => {
      asked.push(email);
      const answer = photos[email] ?? { status: 404, body: NO_PHOTO_404 };
      if (answer instanceof Error) throw answer;
      return answer;
    },
    sleep: async (ms) => void sleeps.push(ms),
    nowMs: () => NOW,
    writes: null,
    ...over,
    sleeps,
    asked,
  };
}

{
  for (const subject of [undefined, "", "   "]) {
    const out = await runPhotoRefresh(deps({ subject }));
    eq(out.status === "refused" && out.why, "no-subject", `a subject of ${JSON.stringify(subject)} refuses by name`);
    assert(out.status === "refused" && out.detail.includes("DIRECTORY_ADMIN_SUBJECT"), "naming the variable");
  }
}

{
  const jpeg = fakeImage("jpeg", 9);
  const { writes, rec } = recorder();
  const d = deps({ writes, photos: { "a@x.test": { status: 200, body: photoBody(jpeg) } } });
  const out = await runPhotoRefresh(d);
  eq(out.status, "measured", "a healthy run measures");
  if (out.status === "measured") {
    assert(out.verdict, "and reaches a verdict");
    assert(out.applied, "and applied its writes");
  }
  eq(rec.full.sort().join(","), "a,b", "a's photo and b's none are written (b found by its alias)");
  eq(rec.deleted.join(","), "gone", "the deactivated row is deleted");
  eq(d.asked.includes("gone@x.test"), false, "a deactivated person is never read");
}

{
  // A dry run decides the same and writes nothing.
  const { rec } = recorder();
  const out = await runPhotoRefresh(deps({ writes: null }));
  eq(out.status === "measured" && out.applied, false, "a dry run says it applied nothing");
  eq(rec.full.length, 0, "and wrote nothing");
}

{
  const d = deps({ listDirectory: async () => [{ primaryEmail: "a@x.test" }] });
  const out = await runPhotoRefresh(d);
  eq(d.asked.includes("b@x.test"), false, "somebody the listing lacks is not asked about");
  eq(out.status === "measured" && out.plan.notInDirectory.join(","), "b@x.test", "and is reported as not in the directory");
}

{
  const listRefused = await runPhotoRefresh(
    deps({ listDirectory: async () => { throw new DirectoryReadError("Delegated token failed: 401 invalid_grant", 401, true); } }),
  );
  eq(listRefused.status === "refused" && listRefused.why, "subject-refused", "a refused listing is the subject being unable to read the directory");
  const listDown = await runPhotoRefresh(
    deps({ listDirectory: async () => { throw new DirectoryReadError("directory list answered 503", 503, false); } }),
  );
  eq(listDown.status === "refused" && listDown.why, "directory-unreadable", "a 503 listing is a separate refusal");
  const listEmpty = await runPhotoRefresh(deps({ listDirectory: async () => [] }));
  eq(listEmpty.status === "refused" && listEmpty.why, "directory-unreadable", "an empty listing is never read as nobody existing (L98)");
  const slateDown = await runPhotoRefresh(deps({ listRows: async () => { throw new Error("advisor_photos read failed"); } }));
  eq(slateDown.status === "refused" && slateDown.why, "slate-unreadable", "an unreadable Slate refuses before asking Google");
}

{
  const allRefused = await runPhotoRefresh(
    deps({ photos: { "a@x.test": { status: 403, body: FORBIDDEN_403 }, "b@x.test": { status: 403, body: FORBIDDEN_403 } } }),
  );
  eq(allRefused.status === "refused" && allRefused.why, "subject-refused", "every photo read refused is the subject being unable to read");
  const d = deps({ photos: { "a@x.test": { status: 429, body: "{}" }, "b@x.test": { status: 500, body: "{}" } } });
  const allFailed = await runPhotoRefresh(d);
  eq(allFailed.status === "refused" && allFailed.why, "nothing-read", "every photo read failing otherwise reads nothing");
  eq(d.sleeps.length, 2 * (PHOTO_RETRY.attempts - 1), "each rate limit or 5xx was retried, finitely");
  eq(d.sleeps[0], PHOTO_RETRY.backoffMs, "through the injected sleep, never a real wait (L524)");
  const timeouts = deps({ photos: { "a@x.test": new Error("timeout"), "b@x.test": new Error("timeout") } });
  const t = await runPhotoRefresh(timeouts);
  eq(t.status === "refused" && t.why, "nothing-read", "a timeout is a failed read, retried and then reported");
}

{
  // A retry that succeeds.
  let calls = 0;
  const jpeg = fakeImage("jpeg", 11);
  const out = await runPhotoRefresh(
    deps({
      getPhoto: async (_s, email) => {
        if (email !== "a@x.test") return { status: 404, body: NO_PHOTO_404 };
        calls += 1;
        return calls === 1 ? { status: 429, body: "{}" } : { status: 200, body: photoBody(jpeg) };
      },
    }),
  );
  eq(out.status === "measured" && out.plan.counts.photo, 1, "a 429 then a 200 is a photo");
}

{
  // The flip guard keeps the verdict back.
  const users = Array.from({ length: FLIP_TO_NONE_LIMIT + 1 }, (_, i) => user(`u${i}`));
  const out = await runPhotoRefresh(
    deps({
      listUsers: async () => users,
      listRows: async () => users.map((u) => row(u.id, "photo", `s${u.id}`)),
      listDirectory: async () => users.map((u) => ({ primaryEmail: u.email })),
    }),
  );
  eq(out.status === "measured" && out.plan.flipGuardTripped, true, "a wave of losses trips the guard");
  eq(out.status === "measured" && out.verdict, false, "and is not a verdict");
}

{
  // The run's own deadline: it stops asking Google, writes what it finished, says
  // how many it never reached, and is not a verdict.
  let now = NOW;
  const jpeg = fakeImage("jpeg", 21);
  const { writes, rec } = recorder();
  const d = deps({
    writes,
    nowMs: () => now,
    deadlineMs: NOW + 1000,
    getPhoto: async (_s, email) => {
      d.asked.push(email);
      now += 1500; // each read takes longer than the time left
      return email === "a@x.test" ? { status: 200, body: photoBody(jpeg) } : { status: 404, body: NO_PHOTO_404 };
    },
  });
  const out = await runPhotoRefresh(d);
  eq(d.asked.join(","), "a@x.test", "no read starts once the deadline has passed");
  eq(out.status === "measured" && out.deadlineReached, true, "the run says it stopped at its deadline");
  eq(out.status === "measured" && out.notReached, 1, "and how many people it never reached");
  eq(out.status === "measured" && out.verdict, false, "and is not a verdict");
  eq(rec.full.join(","), "a", "what it finished is written");
  // Every read started before the deadline failed: still a refusal, and it keeps the
  // deadline fact rather than reading as an ordinary outage.
  let later = NOW;
  const cut = deps({
    nowMs: () => later,
    deadlineMs: NOW + 1000,
    getPhoto: async () => {
      later += 1500;
      return { status: 503, body: "{}" };
    },
  });
  const cutOut = await runPhotoRefresh(cut);
  eq(cutOut.status === "refused" && cutOut.why, "nothing-read", "a cut short run whose reads all failed is nothing read");
  eq(cutOut.status === "refused" && cutOut.deadlineReached, true, "and still says it hit its deadline");
  eq(cutOut.status === "refused" && cutOut.notReached, 1, "and how many it never reached");
  const healthy = await runPhotoRefresh(deps({ deadlineMs: NOW + 10 * 60_000 }));
  eq(healthy.status === "measured" && healthy.deadlineReached, false, "a run inside its deadline does not claim one");
}

{
  // One person's refresh.
  const jpeg = fakeImage("jpeg", 12);
  const d = deps({ photos: { "a@x.test": { status: 200, body: photoBody(jpeg) } } });
  let listed = false;
  d.listDirectory = async () => {
    listed = true;
    return [];
  };
  const out = await runPhotoRefresh(d, { only: "a" });
  eq(out.status, "measured", "one person's refresh measures");
  eq(listed, false, "without listing the whole directory");
  eq(d.asked.join(","), "a@x.test", "asking only about that person");
  eq(out.status === "measured" && out.verdict, false, "and never stamps the daily verdict");
  const gone = await runPhotoRefresh(deps({}), { only: "gone" });
  eq(gone.status === "refused" && gone.why, "unknown-user", "a deactivated person cannot be refreshed");
  const notThere = await runPhotoRefresh(deps({ photos: { "a@x.test": { status: 404, body: NO_USER_404 } } }), { only: "a" });
  eq(notThere.status === "measured" && notThere.plan.notInDirectory.join(","), "a@x.test", "a userKey 404 for one person is not in the directory");
}

finish();
