import { describe, it, expect } from "vitest";
import {
  GoogleAccountMismatchError,
  googleAccountMismatchAlertKey,
  googleAccountIdsOf,
  judgeGoogleIdentity,
} from "./google-identity";
import { GOOGLE_ACCOUNT_CHANGED_MESSAGE, GOOGLE_RELINK_COPY } from "./google-identity-copy";

// #3526: the one rule deciding whether a sign in, or a session on any later
// request, is the person a Slate row belongs to. Provisioning applies it at sign in
// (src/lib/provision-integrity.test.ts) and `realCurrentUser` on every request
// (src/lib/auth.test.ts); these pin each verdict and the edges.
describe("judgeGoogleIdentity", () => {
  it("is the same person when the one Google account matches", () => {
    expect(judgeGoogleIdentity("sub-1", ["sub-1"])).toEqual({ kind: "same-person" });
  });

  it("is somebody else when the Google account differs", () => {
    expect(judgeGoogleIdentity("sub-old", ["sub-new"])).toEqual({
      kind: "different-person",
      reason: "different-account",
    });
  });

  it("records the account on a row that has none, which is how every row arms itself", () => {
    expect(judgeGoogleIdentity(null, ["sub-1"])).toEqual({ kind: "record", sub: "sub-1" });
    expect(judgeGoogleIdentity(undefined, ["sub-1"])).toEqual({ kind: "record", sub: "sub-1" });
    // A blank stored value is no id at all, never an id that matches nothing.
    expect(judgeGoogleIdentity("  ", ["sub-1"])).toEqual({ kind: "record", sub: "sub-1" });
  });

  it("refuses a session carrying no Google account, whatever the row holds (fail closed)", () => {
    for (const stored of ["sub-1", null]) {
      expect(judgeGoogleIdentity(stored, [])).toEqual({ kind: "different-person", reason: "no-account-id" });
      expect(judgeGoogleIdentity(stored, ["", "  "])).toEqual({
        kind: "different-person",
        reason: "no-account-id",
      });
    }
  });

  // Two Google accounts on one auth user is the shape of a takeover through
  // GoTrue's linking by address, so it is refused even on a row with nothing stored.
  it("refuses two different Google accounts on one auth user, armed or not", () => {
    for (const stored of ["sub-1", null]) {
      expect(judgeGoogleIdentity(stored, ["sub-1", "sub-2"])).toEqual({
        kind: "different-person",
        reason: "several-accounts",
      });
    }
    // The same account listed twice is one account.
    expect(judgeGoogleIdentity("sub-1", ["sub-1", "sub-1"])).toEqual({ kind: "same-person" });
  });
});

describe("googleAccountIdsOf", () => {
  it("reads every Google identity's sub and ignores other providers and user_metadata", () => {
    // A whole auth user as Supabase returns it, metadata included.
    const user = {
      user_metadata: { sub: "meta-sub", provider_id: "meta-sub" },
      identities: [
        { provider: "google", identity_data: { sub: "g-1" } },
        { provider: "email", identity_data: { sub: "e-1" } },
        { provider: "google", identity_data: { sub: "g-2" } },
      ],
    };
    expect(googleAccountIdsOf(user)).toEqual(["g-1", "g-2"]);
  });

  it("answers no accounts for a user with no identities, or a Google identity with no sub", () => {
    expect(googleAccountIdsOf({})).toEqual([]);
    expect(googleAccountIdsOf({ identities: null })).toEqual([]);
    expect(googleAccountIdsOf({ identities: [{ provider: "google", identity_data: { sub: 42 } }] })).toEqual([]);
    expect(googleAccountIdsOf({ identities: [{ provider: "google" }] })).toEqual([]);
  });
});

describe("GoogleAccountMismatchError", () => {
  it("carries the row and the reason for the alert, and is told apart by type", () => {
    const err = new GoogleAccountMismatchError({ userId: "u1", email: "a@trypennie.com", reason: "different-account" });
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("GoogleAccountMismatchError");
    expect([err.userId, err.email, err.reason]).toEqual(["u1", "a@trypennie.com", "different-account"]);
    expect(googleAccountMismatchAlertKey("u1")).toBe("sign_in_google_account_mismatch:u1");
  });
});

// The sign in page draws this sentence (src/app/login/page.test.tsx checks it is
// shown for the code); its wording rules are pinned here on the copy itself.
// The line above the relink button for someone with a sign in on record but no
// Google account recorded: it may claim only what is true of them.
describe("the relink line when no Google account is recorded", () => {
  const line = GOOGLE_RELINK_COPY.signInOnlyExplanation("Morgan Manager");

  it("names the person and says no Google account is recorded", () => {
    expect(line).toContain("Morgan Manager");
    expect(line).toMatch(/no Google account/i);
  });

  it("never speaks of an account they have been using, and stays short", () => {
    expect(line).not.toMatch(/have been using|their account/i);
    expect(line.length).toBeLessThan(GOOGLE_RELINK_COPY.explanation("Morgan Manager").length + 20);
  });
});

describe("the refused person's sentence", () => {
  it("names who can change the answer and is never worded as a retry", () => {
    expect(GOOGLE_ACCOUNT_CHANGED_MESSAGE).toMatch(/admin/i);
    expect(GOOGLE_ACCOUNT_CHANGED_MESSAGE).not.toMatch(/try again|sign in again|try signing in/i);
  });

  it("says nothing about whose account the address belonged to", () => {
    expect(GOOGLE_ACCOUNT_CHANGED_MESSAGE).not.toMatch(/previous|former|belonged to someone|sub\b/i);
  });
});
