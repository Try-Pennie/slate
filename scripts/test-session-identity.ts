// #4379: may this session act as this row? The judge `realCurrentUser` runs on every
// request, now that a session can come through Microsoft as well as Google.
//
// Two questions, both read from things the session holder cannot write:
//   - HOW the session was made, from the verified claims' `amr`: an OAuth sign in and
//     nothing else, since the Email provider stays off and a password, magic link or
//     one time code session means a way in that should not exist;
//   - WHOSE account it is, from the identities GoTrue keeps on the auth user: staff
//     hold their one Google account and no Microsoft one; a coordinator whose row
//     records a Microsoft account holds exactly that one and no Google one. That second
//     rule is the tested exception to the Google check, which on its own refuses any
//     session with no Google account.
//
// Every refusal is paired with the same session admitted (L159).
//
// Run: node --experimental-strip-types scripts/test-session-identity.ts
import { assert, eq, finish } from "./lib/harness.ts";
import { amrIsOauthOnly, judgeSessionIdentity } from "../src/lib/auth/session-identity.ts";

const google = (sub: string) => ({ provider: "google", identity_data: { sub } });
const azure = (sub: string) => ({ provider: "azure", identity_data: { sub } });

const staff = { role: "admin" as const, google_sub: "g-1", microsoft_sub: null };
const coordinator = { role: "coordinator" as const, google_sub: null, microsoft_sub: "ms-1" };
const OAUTH = [{ method: "oauth", timestamp: 1 }];

// --- how the session was made --------------------------------------------------
{
  assert(amrIsOauthOnly(OAUTH), "an OAuth sign in, in the detailed form, is admitted");
  assert(amrIsOauthOnly(["oauth"]), "and in the RFC 8176 string form");
  for (const [what, amr] of [
    ["a password sign in", [{ method: "password", timestamp: 1 }]],
    ["a magic link", [{ method: "magiclink", timestamp: 1 }]],
    ["a one time code", ["otp"]],
    ["an anonymous session", [{ method: "anonymous", timestamp: 1 }]],
    ["OAuth with a second method beside it", [{ method: "oauth", timestamp: 1 }, { method: "mfa/totp", timestamp: 2 }]],
    ["an empty list", []],
    ["no amr at all", undefined],
    ["an amr that is not a list", "oauth"],
    ["an entry with no method", [{ timestamp: 1 }]],
  ] as const) {
    assert(!amrIsOauthOnly(amr), `${what} is refused`);
    const v = judgeSessionIdentity({ row: staff, amr, user: { identities: [google("g-1")] } });
    eq(v.admit ? "admitted" : v.reason, "not-oauth", `${what} is refused at the gate before whose account it is`);
  }
}

// --- staff: their Google account, as before -------------------------------------
{
  const ok = judgeSessionIdentity({ row: staff, amr: OAUTH, user: { identities: [google("g-1")] } });
  assert(ok.admit, "a staff session on the row's own Google account is admitted");
  const other = judgeSessionIdentity({ row: staff, amr: OAUTH, user: { identities: [google("g-2")] } });
  assert(!other.admit && other.reason === "google" && other.google === "different-account", "a different Google account is the Google refusal, which alerts");
  const none = judgeSessionIdentity({ row: staff, amr: OAUTH, user: { identities: [] } });
  assert(!none.admit && none.reason === "google" && none.google === "no-account-id", "no Google account is still refused for staff");
  const withMicrosoft = judgeSessionIdentity({ row: staff, amr: OAUTH, user: { identities: [google("g-1"), azure("ms-x")] } });
  assert(
    !withMicrosoft.admit && withMicrosoft.reason === "microsoft-on-google-row",
    "a staff auth user that also holds a Microsoft account is refused: the session cannot say which one it came through",
  );
  const unarmed = judgeSessionIdentity({ row: { ...staff, google_sub: null }, amr: OAUTH, user: { identities: [google("g-1")] } });
  assert(unarmed.admit, "an unarmed staff row is admitted on one Google account, as before (it records at its next sign in)");
}

// --- a Microsoft coordinator: the tested exception ---------------------------------
{
  const ok = judgeSessionIdentity({ row: coordinator, amr: OAUTH, user: { identities: [azure("ms-1")] } });
  assert(ok.admit, "a coordinator on the Microsoft account their row records is admitted with no Google account");
  const other = judgeSessionIdentity({ row: coordinator, amr: OAUTH, user: { identities: [azure("ms-2")] } });
  assert(!other.admit && other.reason === "microsoft-account", "a different Microsoft account is refused");
  const two = judgeSessionIdentity({ row: coordinator, amr: OAUTH, user: { identities: [azure("ms-1"), azure("ms-2")] } });
  assert(!two.admit && two.reason === "microsoft-account", "two Microsoft accounts on one auth user are refused, even with the right one among them");
  const withGoogle = judgeSessionIdentity({ row: coordinator, amr: OAUTH, user: { identities: [azure("ms-1"), google("g-9")] } });
  assert(!withGoogle.admit && withGoogle.reason === "google-on-microsoft-row", "a coordinator holding a Google account beside it is refused");
  const googleOnly = judgeSessionIdentity({ row: coordinator, amr: OAUTH, user: { identities: [google("g-9")] } });
  assert(!googleOnly.admit && googleOnly.reason === "google-on-microsoft-row", "and so is a Google account alone on a row that records a Microsoft one");
  const noAccount = judgeSessionIdentity({ row: coordinator, amr: OAUTH, user: { identities: [] } });
  assert(!noAccount.admit && noAccount.reason === "microsoft-account", "a session with no account at all on a Microsoft row is refused");
  const notOauth = judgeSessionIdentity({ row: coordinator, amr: [{ method: "password", timestamp: 1 }], user: { identities: [azure("ms-1")] } });
  assert(!notOauth.admit && notOauth.reason === "not-oauth", "a coordinator is held to the OAuth only rule too");
}

// --- a Microsoft sign in reaching a row that records none ----------------------------
{
  // The row a Microsoft sign in links always records the account, so one that does not
  // is a Google row (staff, or a coordinator on a Pennie Google account), and a session
  // carrying a Microsoft account there cannot be told from somebody else.
  const googleCoordinator = { role: "coordinator" as const, google_sub: "g-5", microsoft_sub: null };
  assert(
    judgeSessionIdentity({ row: googleCoordinator, amr: OAUTH, user: { identities: [google("g-5")] } }).admit,
    "a coordinator on a Pennie Google account keeps signing in with Google",
  );
  const msOnly = judgeSessionIdentity({ row: googleCoordinator, amr: OAUTH, user: { identities: [azure("ms-1")] } });
  assert(!msOnly.admit && msOnly.reason === "microsoft-on-google-row", "a Microsoft account alone on a Google row is refused");
  const notCoordinator = judgeSessionIdentity({ row: { ...coordinator, role: "admin" as const }, amr: OAUTH, user: { identities: [azure("ms-1")] } });
  assert(!notCoordinator.admit && notCoordinator.reason === "not-a-coordinator", "a row recording a Microsoft account that is not a coordinator's is refused");
}

finish();
