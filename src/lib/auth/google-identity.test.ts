import { describe, it, expect } from "vitest";
import { GoogleAccountMismatchError, googleAccountMismatchAlertKey, judgeGoogleIdentity } from "./google-identity";
import { GOOGLE_ACCOUNT_CHANGED_MESSAGE } from "./google-identity-copy";

// #3526: the one rule deciding whether a sign in is the person a Slate row
// belongs to. Provisioning applies it (src/lib/provision-integrity.test.ts drives
// it end to end); these pin each verdict, including the edges a stored value can
// arrive with.
describe("judgeGoogleIdentity", () => {
  it("is the same person when the account ids match", () => {
    expect(judgeGoogleIdentity("sub-1", "sub-1")).toEqual({ kind: "same-person" });
  });

  it("is somebody else when the account ids differ", () => {
    expect(judgeGoogleIdentity("sub-old", "sub-new")).toEqual({
      kind: "different-person",
      reason: "different-account",
    });
  });

  it("records the account id on a row that has none, which is how every row arms itself", () => {
    expect(judgeGoogleIdentity(null, "sub-1")).toEqual({ kind: "record" });
    expect(judgeGoogleIdentity(undefined, "sub-1")).toEqual({ kind: "record" });
    // A blank stored value is no id at all, never an id that matches nothing.
    expect(judgeGoogleIdentity("  ", "sub-1")).toEqual({ kind: "record" });
  });

  it("refuses a sign in carrying no account id once the row has one (fail closed)", () => {
    for (const offered of [null, undefined, ""]) {
      expect(judgeGoogleIdentity("sub-1", offered)).toEqual({
        kind: "different-person",
        reason: "no-account-id",
      });
    }
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
describe("the refused person's sentence", () => {
  it("names who can change the answer and is never worded as a retry", () => {
    expect(GOOGLE_ACCOUNT_CHANGED_MESSAGE).toMatch(/admin/i);
    expect(GOOGLE_ACCOUNT_CHANGED_MESSAGE).not.toMatch(/try again|sign in again|try signing in/i);
  });

  it("says nothing about whose account the address belonged to", () => {
    expect(GOOGLE_ACCOUNT_CHANGED_MESSAGE).not.toMatch(/previous|former|belonged to someone|sub\b/i);
  });
});
