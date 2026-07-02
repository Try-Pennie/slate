// PII guard: nothing under public/ (publicly reachable and in git history) may
// carry real personal data. A demo lead leaked a real name, Gmail, US phone, and
// production Salesforce id via embed-example.html (#590). Demo values must be
// obviously fake: example.* email domains, the reserved 555-01xx phone range,
// and non-Salesforce external ids.
// Run: node --experimental-strip-types scripts/test-public-pii.ts
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

let failures = 0;
function fail(msg: string) {
  console.error("FAIL:", msg);
  failures++;
}

// Text formats a demo/example page might use. Binary assets (images, fonts) are
// skipped — PII would have to be text to be readable anyway.
const TEXT_EXT = /\.(html?|js|mjs|json|txt|svg|css|xml|md)$/i;
const ALLOWED_EMAIL_DOMAINS = /^(example\.(com|org|net)|test\.test)$/i;

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (TEXT_EXT.test(p)) out.push(p);
  }
  return out;
}

/** Decode the URL-encoding a cal-style embed link uses so %40/%2B are scanned. */
function decode(line: string): string {
  return line.replace(/%40/gi, "@").replace(/%2B/gi, "+");
}

const EMAIL_RE = /[a-z0-9._%+-]+@([a-z0-9.-]+\.[a-z]{2,})/gi;
// +1 then 10 digits. The North American 555-01xx range is reserved for fiction;
// treat any other exchange as a real number.
const PHONE_RE = /\+1(\d{3})(\d{3})\d{4}/g;
// Salesforce record ids: a 3-char object key prefix, five 0s, then 7+ id chars.
// The leaked id was a04Ui00000HnjwfIAB.
const SF_ID_RE = /\b[a-zA-Z0-9]{3}[a-zA-Z0-9]{2}00000[a-zA-Z0-9]{7,10}\b/g;

const files = (() => {
  try {
    return walk("public");
  } catch {
    return [];
  }
})();

for (const file of files) {
  readFileSync(file, "utf8")
    .split("\n")
    .forEach((raw, i) => {
      const line = decode(raw);
      const at = `${file}:${i + 1}`;

      for (const m of line.matchAll(EMAIL_RE)) {
        if (!ALLOWED_EMAIL_DOMAINS.test(m[1])) {
          fail(`${at} has a real-looking email (${m[0]}); use an example.* address`);
        }
      }
      for (const m of line.matchAll(PHONE_RE)) {
        if (m[2] !== "555") {
          fail(`${at} has a real-looking phone (${m[0]}); use the reserved 555-01xx range`);
        }
      }
      for (const m of line.matchAll(SF_ID_RE)) {
        fail(`${at} has a Salesforce-id-like token (${m[0]}); use a non-Salesforce demo id`);
      }
    });
}

if (failures === 0) {
  console.log(`ok: no real PII across ${files.length} public/ text files`);
}
console.log(failures === 0 ? "\nALL PASSED" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
