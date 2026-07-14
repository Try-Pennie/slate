// #600: a webhook credential must never be rendered back into the page.
//
// The admin form used to bind the live Regal API key as an input's `defaultValue`, so the
// secret was embedded in the server-rendered HTML and shown on screen in plain text to
// anyone who opened /admin, screen-shared, or took a screenshot. The key is the only thing
// authenticating Slate's booking events to Regal.
//
// The fix is write-only: blank keeps the saved key, a typed value replaces it. That is easy
// to undo by accident, because re-adding `defaultValue={webhook?.auth_header}` looks like a
// convenience ("show the admin what's saved") rather than a leak. This guard makes that
// regression fail the build.
//
// Run: node --experimental-strip-types scripts/test-no-rendered-secrets.ts
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

let failures = 0;
const assert = (cond: boolean, msg: string) => {
  if (!cond) {
    console.error("FAIL:", msg);
    failures++;
  } else console.log("ok:", msg);
};

const SECRET_FIELDS = ["auth_header", "secret"];
const SURFACES = ["src/app/admin/page.tsx"];

for (const file of SURFACES) {
  const src = readFileSync(resolve(repoRoot, file), "utf8");

  for (const field of SECRET_FIELDS) {
    // Bound into an input: value={...auth_header...} / defaultValue={...auth_header...}
    const bound = new RegExp(`(?:default)?[Vv]alue=\\{[^}]*\\b${field}\\b[^}]*\\}`);
    assert(
      !bound.test(src),
      `${file}: never binds \`${field}\` to an input value (#600)`,
    );

    // Interpolated into the markup: {webhook.auth_header} on its own renders the secret.
    // A boolean/ternary USE of the field is fine and is how the form says "a key is saved",
    // so only a bare render is a failure.
    const rendered = new RegExp(`\\{\\s*webhook[?.]*\\.${field}\\s*\\}`);
    assert(
      !rendered.test(src),
      `${file}: never renders \`${field}\` as text (#600)`,
    );
  }
}

// The write-only contract only holds if a blank field means "keep the current key". If the
// action goes back to writing null on blank, the page no longer showing the key turns into
// a silent wipe: an admin edits the URL, the blank key field nulls the credential, and every
// booking event to Regal starts posting an empty Authorization header.
const actions = readFileSync(resolve(repoRoot, "src/app/admin/actions.ts"), "utf8");
assert(
  !/update\(\{\s*url,\s*format,\s*auth_header:\s*authHeader\s*\}\)/.test(actions),
  "setWebhookEndpoint does not unconditionally write auth_header (blank would wipe the key) (#600)",
);

console.log(failures === 0 ? "\nALL PASSED" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
