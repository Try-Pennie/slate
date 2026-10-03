// Every bearerTokenMatches key carries a rotation slot (#3110). The scan logic is in
// scripts/lib/scan-bearer-rotation-slots.ts; this runs it over src/ and proves it
// still catches a single value call (L1).
// Run: node --experimental-strip-types scripts/test-bearer-rotation-slots.ts
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { scanBearerRotationSlots } from "./lib/scan-bearer-rotation-slots.ts";
import { assert, eq, fail, finish } from "./lib/harness.ts";

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (/\.(ts|tsx)$/.test(p) && !/\.test\.(ts|tsx)$/.test(p)) out.push(p);
  }
  return out;
}

// --- the scanner, on fixtures ------------------------------------------------------
{
  const single = `if (!bearerTokenMatches(req.headers.get("authorization"), key)) {}`;
  eq(scanBearerRotationSlots("a.ts", single).length, 1, "a single value call is caught");

  const pair = `if (!bearerTokenMatches(req.headers.get("authorization"), [key, reassignApiKey2()])) {}`;
  eq(scanBearerRotationSlots("a.ts", pair).length, 0, "a key and its slot pass");

  const multiline = `return bearerTokenMatches(\n  req.headers.get("authorization"),\n  [cronSecret(), cronSecret2()],\n);`;
  eq(scanBearerRotationSlots("a.ts", multiline).length, 0, "a call spread over lines is read whole");

  const oneEntry = `bearerTokenMatches(h, [key])`;
  eq(scanBearerRotationSlots("a.ts", oneEntry).length, 1, "an array of ONE is still a single value");

  const reasoned = `// rotation-slot-ok: a fixture that is never deployed\nbearerTokenMatches(h, key)`;
  eq(scanBearerRotationSlots("a.ts", reasoned).length, 0, "the escape hatch with a reason passes");

  const bare = `// rotation-slot-ok:\nbearerTokenMatches(h, key)`;
  eq(scanBearerRotationSlots("a.ts", bare).length, 1, "the escape hatch without a reason does not");

  const definition = `export function bearerTokenMatches(header: string | null, secret: string): boolean {`;
  eq(scanBearerRotationSlots("a.ts", definition).length, 0, "the definition is not a call");

  // A comma inside a comment or a string is not a second slot.
  const commentComma = `bearerTokenMatches(h, [key /* , old */])`;
  eq(scanBearerRotationSlots("a.ts", commentComma).length, 1, "a comma inside a block comment is not a second slot");
  const lineCommentComma = `bearerTokenMatches(h, [\n  key, // , old\n])`;
  eq(scanBearerRotationSlots("a.ts", lineCommentComma).length, 1, "a comma inside a line comment is not a second slot");
  const stringComma = `bearerTokenMatches(h, ["a,b"])`;
  eq(scanBearerRotationSlots("a.ts", stringComma).length, 1, "a comma inside a string literal is not a second slot");
  const literalSlot = `bearerTokenMatches(h, [key, ""])`;
  eq(scanBearerRotationSlots("a.ts", literalSlot).length, 1, "a string literal is never a configured slot");
  const parenInString = `bearerTokenMatches(h, [key, k2(")")])`;
  eq(scanBearerRotationSlots("a.ts", parenInString).length, 0, "a bracket inside a string does not end the call early");
  const inComment = `// bearerTokenMatches(h, key) is how it used to read`;
  eq(scanBearerRotationSlots("a.ts", inComment).length, 0, "a call named in a comment is not a call");
}

// --- the real tree -------------------------------------------------------------------
const files = walk("src");
let calls = 0;
const findings = [];
for (const file of files) {
  const src = readFileSync(file, "utf8");
  if (!/\bbearerTokenMatches\s*\(/.test(src)) continue;
  if (file.endsWith("bearer-auth.ts")) continue;
  calls += (src.match(/\bbearerTokenMatches\s*\(/g) ?? []).length;
  findings.push(...scanBearerRotationSlots(file, src));
}
// A scan that read nothing reads exactly like a clean tree (L98).
assert(calls >= 7, `the scan found the bearer calls it exists to judge (${calls})`);
for (const f of findings) {
  fail(`${f.file}:${f.line} checks a bearer key with no rotation slot; pass [KEY, KEY_2] (#3110): ${f.text}`);
}

// --- positive control on the REAL tree: strip one slot, it must be caught ------------
{
  const cron = readFileSync("src/lib/cron.ts", "utf8");
  const broken = cron.replace(/\[\s*cronSecret\(\),\s*cronSecret2\(\)\s*\]/, "cronSecret()");
  assert(broken !== cron, "the control found cron's slot pair to remove");
  eq(scanBearerRotationSlots("src/lib/cron.ts", broken).length, 1, "and the scan catches cron with its slot removed");
}

finish();
