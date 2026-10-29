// #4379: does Supabase Auth hold a sign in, or an account, Slate does not allow?
//
// Two halves, each read from Auth's own record, never from Slate's (L58):
//   - LOGINS: auth.mfa_amr_claims, through auth_sign_in_methods (not the audit log, which
//     production does not write to the database: 0 rows, measured 2026-10-29). Every Slate
//     sign in is OAuth (Google or Microsoft), so a session made by any other method
//     (password, otp, magic link, anonymous) is a way in that should not exist. Expected
//     zero. Independent of the session gate, which refuses such a session but cannot say
//     it was made.
//   - ACCOUNTS: the admin listing of auth users against the roster. An account outside
//     trypennie.com belongs to a coordinator, so one that no active coordinator row is
//     linked to is a sign in that outlived its row (a removal whose delete failed, a
//     link that never completed).
//
// Three outcomes per half, because "nothing found" and "nothing read" look alike
// (L98): a read that found no OAuth sign in at all in a WEEK is unmeasured, never clean
// (the positive control, L557), and so is an incomplete account listing. The page hangs off either half's
// finding; the all clear only off both measured clean.
//
// Run: node --experimental-strip-types --import ./scripts/register-paths.mjs scripts/test-auth-unexpected-sign-ins.ts
import { assert, eq, finish } from "./lib/harness.ts";
import {
  AUTH_UNEXPECTED_SIGN_IN_KEY,
  AUTH_UNEXPECTED_SIGN_IN_CADENCE_MS,
  AUTH_LOGIN_WINDOW_MS,
  AUTH_LOGIN_CONTROL_WINDOW_MS,
  authUnexpectedSignInDue,
  formatAuthUnexpectedSignInAlert,
  formatAuthUnexpectedSignInCleared,
  judgeLogins,
  judgeOutsideAccounts,
  runAuthUnexpectedSignInCheck,
} from "../src/lib/monitor/auth-unexpected-sign-ins.ts";

const reading = (methods: { method: string; sessions: number; actors: string[] }[], oauthControl = 189) => ({
  oauth_control: oauthControl,
  methods,
});
const DASHES = new RegExp("[\\u2014\\u2013]");

// --- the logins half ----------------------------------------------------------------
{
  const clean = judgeLogins(reading([{ method: "oauth", sessions: 40, actors: ["a@trypennie.com", "dana@partner.example"] }]));
  assert(clean.status === "measured" && clean.offending.length === 0, "OAuth sessions, Google and Microsoft alike, are the expected ones");

  const otp = judgeLogins(reading([
    { method: "oauth", sessions: 40, actors: ["a@trypennie.com"] },
    { method: "otp", sessions: 2, actors: ["x@trypennie.com", "y@trypennie.com"] },
    { method: "password", sessions: 1, actors: [""] },
  ]));
  assert(otp.status === "measured", "a reading with other methods is measured");
  eq(otp.status === "measured" ? otp.offending.map((o) => o.method) : [], ["otp", "password"], "a one time code and a password session are both findings");

  // The positive control (L557): a week with no OAuth sign in at all means the claims
  // stopped being written, which would otherwise read for ever as nobody signing in
  // another way. Production has signed in by OAuth every day it has been read.
  const silent = judgeLogins(reading([], 0));
  assert(silent.status === "unmeasured" && /week/.test(silent.why), "no OAuth sign in in a week is unmeasured, never clean");
  const silentWithFinding = judgeLogins(reading([{ method: "otp", sessions: 1, actors: ["x@trypennie.com"] }], 0));
  assert(
    silentWithFinding.status === "measured" && silentWithFinding.offending.length === 1,
    "but a session by another method is still a finding when the control is empty",
  );
  for (const bad of [null, "x", {}, { oauth_control: "5", methods: [] }, { oauth_control: 5, methods: "no" }, { oauth_control: 5, methods: [{ method: "otp" }] }]) {
    eq(judgeLogins(bad).status, "unmeasured", `an unreadable body ${JSON.stringify(bad)} is unmeasured`);
  }
}

// --- the accounts half --------------------------------------------------------------
{
  const users = [
    { id: "a1", email: "a@trypennie.com", banned_until: null },
    { id: "c1", email: "dana@partner.example", banned_until: null },
    { id: "c2", email: "left@partner.example", banned_until: "2126-01-01T00:00:00Z" },
    { id: "n1", email: null, banned_until: null },
  ];
  const v = judgeOutsideAccounts({ listing: { complete: true, users }, activeCoordinatorAuthIds: new Set(["c1"]), hostedDomain: "trypennie.com" });
  assert(v.status === "measured", "a complete listing is measured");
  eq(v.status === "measured" ? v.orphans.map((o) => o.authUserId) : [], ["c2", "n1"], "an outside account no active coordinator holds, and one with no address, are orphans; staff and a linked coordinator are not");

  const partial = judgeOutsideAccounts({ listing: { complete: false, users: [] }, activeCoordinatorAuthIds: new Set(), hostedDomain: "trypennie.com" });
  eq(partial.status, "unmeasured", "an incomplete listing with nothing found is unmeasured");
  const partialFound = judgeOutsideAccounts({ listing: { complete: false, users }, activeCoordinatorAuthIds: new Set(["c1"]), hostedDomain: "trypennie.com" });
  assert(partialFound.status === "measured" && partialFound.orphans.length === 2 && !partialFound.complete, "but what it did find is still a finding");
  eq(
    judgeOutsideAccounts({ listing: { complete: true, users }, activeCoordinatorAuthIds: new Set(), hostedDomain: "" }).status,
    "unmeasured",
    "with no company domain configured nothing can be judged outside it",
  );
}

// --- cadence ----------------------------------------------------------------------------
{
  eq(AUTH_UNEXPECTED_SIGN_IN_CADENCE_MS, 60 * 60_000, "it runs once an hour: the claims table has no index on its time, and the account listing is an admin API call");
  assert(authUnexpectedSignInDue(Date.UTC(2026, 9, 29, 14, 2)), "the first tick of the hour is due");
  assert(!authUnexpectedSignInDue(Date.UTC(2026, 9, 29, 14, 7)), "the next is not");
  let due = 0;
  for (let m = 0; m < 60; m += 5) if (authUnexpectedSignInDue(Date.UTC(2026, 9, 29, 3, m, 10))) due++;
  eq(due, 1, "exactly one five minute tick an hour");
  eq(AUTH_LOGIN_WINDOW_MS, 24 * 60 * 60_000, "findings come from the last day, so June's old one time code sessions never page");
  eq(AUTH_LOGIN_CONTROL_WINDOW_MS, 7 * 24 * 60 * 60_000, "and the positive control from the last week");
}

// --- copy -------------------------------------------------------------------------------
{
  const text = formatAuthUnexpectedSignInAlert({
    offending: [{ method: "otp", sessions: 2, actors: ["x@trypennie.com", "y@trypennie.com"] }],
    orphans: [{ authUserId: "c2", email: "left@partner.example" }],
  });
  assert(/^Supabase Auth/.test(text), "the page opens with what it read, never with the word Slate");
  assert(/2 sign ins/.test(text) && /otp/.test(text) && /x@trypennie\.com/.test(text), "it names how many, by what, and who");
  assert(/left@partner\.example/.test(text) && /Authentication, Users/.test(text), "and the orphan account, with where to delete it");
  assert(!DASHES.test(text), "and carries no dash");
  const many = formatAuthUnexpectedSignInAlert({
    offending: [{ method: "password", sessions: 30, actors: Array.from({ length: 30 }, (_, i) => `p${i}@trypennie.com`) }],
    orphans: [],
  });
  assert(/and 20 more/.test(many), "a long list of addresses is cut to ten with the rest counted");
  assert(/Google/.test(formatAuthUnexpectedSignInCleared()) && /Microsoft/.test(formatAuthUnexpectedSignInCleared()), "the all clear says what is allowed");
}

// --- the step: pages on a finding, clears only on both clean, else does nothing --------
{
  const DUE = Date.UTC(2026, 9, 29, 14, 1);
  async function drive(over: {
    nowMs?: number;
    logins?: () => Promise<unknown>;
    accounts?: () => Promise<{ complete: boolean; users: { id: string; email: string | null; banned_until: string | null }[] }>;
    links?: () => Promise<string[]>;
  }) {
    const sent: { key: string; text: string; subjects?: readonly string[] }[] = [];
    const resolved: string[] = [];
    const asked: string[] = [];
    const result = await runAuthUnexpectedSignInCheck({
      nowMs: over.nowMs ?? DUE,
      hostedDomain: "trypennie.com",
      readLogins: async (sinceIso, controlSinceIso) => {
        asked.push(sinceIso, controlSinceIso);
        return (over.logins ?? (async () => reading([{ method: "oauth", sessions: 9, actors: ["a@trypennie.com"] }])))();
      },
      readAccounts: over.accounts ?? (async () => ({ complete: true, users: [{ id: "a1", email: "a@trypennie.com", banned_until: null }] })),
      readActiveCoordinatorAuthIds: over.links ?? (async () => []),
      notify: async (key, _ms, text, repeat) => void sent.push({ key, text, subjects: repeat?.subjects }),
      resolve: async (key) => void resolved.push(key),
      cooldownMs: 1,
    });
    return { result, sent, resolved, asked };
  }

  const quiet = await drive({ nowMs: Date.UTC(2026, 9, 29, 14, 20) });
  eq(quiet.result.status, "not-due", "off the hour it reads nothing");
  eq(quiet.asked, [], "and asks the claims nothing");

  const healthy = await drive({});
  eq(healthy.result.status, "healthy", "both halves clean is healthy");
  eq(healthy.resolved, [AUTH_UNEXPECTED_SIGN_IN_KEY], "and clears the key");
  eq(
    healthy.asked,
    [new Date(DUE - AUTH_LOGIN_WINDOW_MS).toISOString(), new Date(DUE - AUTH_LOGIN_CONTROL_WINDOW_MS).toISOString()],
    "having asked for the day before the tick, and the week for the control",
  );

  const login = await drive({ logins: async () => reading([{ method: "otp", sessions: 1, actors: ["x@trypennie.com"] }]) });
  eq(login.result.status, "found", "a session by a one time code is a finding");
  eq(login.sent.map((s) => s.key), [AUTH_UNEXPECTED_SIGN_IN_KEY], "and pages its key");
  eq(login.sent[0]?.subjects, ["login:otp:x@trypennie.com"], "naming its subjects, so a new one posts at once");
  eq(login.resolved, [], "and clears nothing");

  const orphan = await drive({
    accounts: async () => ({ complete: true, users: [{ id: "c9", email: "gone@partner.example", banned_until: null }] }),
  });
  eq(orphan.result.status, "found", "an outside account with no coordinator behind it is a finding");
  eq(orphan.sent[0]?.subjects, ["account:c9"], "named by its auth user");

  const blindLogins = await drive({ logins: async () => reading([], 0) });
  eq(blindLogins.result.status, "unmeasured", "a week with no OAuth sign in, with clean accounts, is unmeasured");
  eq([blindLogins.sent.length, blindLogins.resolved.length], [0, 0], "and pages and clears nothing");

  const threw = await drive({ logins: async () => { throw new Error("permission denied for table mfa_amr_claims"); } });
  eq(threw.result.status, "unmeasured", "a refused claims read is unmeasured");
  eq(threw.resolved.length, 0, "and a refused claims read clears nothing");
  const threwButFound = await drive({
    logins: async () => { throw new Error("boom"); },
    accounts: async () => ({ complete: true, users: [{ id: "c9", email: "gone@partner.example", banned_until: null }] }),
  });
  eq(threwButFound.result.status, "found", "one half failing never hides the other half's finding");

  const linksFailed = await drive({ links: async () => { throw new Error("users unreadable"); } });
  eq(linksFailed.result.status, "unmeasured", "an unreadable roster is unmeasured, never every outside account an orphan");
  eq(linksFailed.sent.length, 0, "and pages nothing");
}

finish();
