/**
 * Rebuilds the two confirmation-mark assets Slate serves itself (#2560).
 *
 *   public/brand/checkmark.lottie          the check mark half of Pennie's animation
 *   public/brand/dotlottie-player.wasm     the player's own wasm, copied out of node_modules
 *
 * Run it after bumping `@lottiefiles/dotlottie-react`, or when the source
 * animation changes:
 *
 *   node --experimental-strip-types scripts/build-confirmation-mark-assets.ts
 *   node --experimental-strip-types scripts/build-confirmation-mark-assets.ts --source <path to .lottie>
 *
 * With no `--source` it downloads the animation from the trypennie repo through
 * `gh`, which is where the asset lives and is the only copy anybody maintains.
 * `scripts/test-confirmation-mark-assets.ts` then holds what this produced
 * against what it was produced from, so a dependency bump that leaves a stale
 * wasm in `public/` fails the build rather than failing in a lead's browser.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readArchive, writeArchive, type ArchiveEntry } from "./lib/dotlottie-archive.ts";
import { trimToCheckMark, type LottieAnimation } from "./lib/checkmark-lottie.ts";
import {
  CHECKMARK_LOTTIE_PATH,
  DOTLOTTIE_WASM_PATH,
  installedWasmPath,
  SOURCE_LOTTIE_REPO_PATH,
  SOURCE_LOTTIE_REPO,
} from "./lib/confirmation-mark-assets.ts";

const root = join(import.meta.dirname, "..");

function sourceLottie(): Buffer {
  const flag = process.argv.indexOf("--source");
  if (flag >= 0) {
    const path = process.argv[flag + 1];
    if (!path) throw new Error("--source needs a path to a .lottie file");
    return readFileSync(path);
  }
  console.log(`fetching ${SOURCE_LOTTIE_REPO_PATH} from ${SOURCE_LOTTIE_REPO} through gh`);
  const out = mkdtempSync(join(tmpdir(), "slate-lottie-"));
  const encoded = join(out, "encoded.b64");
  // `gh api` prints the blob base64-encoded; a file is used rather than a pipe
  // because the source is about a megabyte and execFileSync buffers stdout.
  writeFileSync(
    encoded,
    execFileSync(
      "gh",
      ["api", `repos/${SOURCE_LOTTIE_REPO}/contents/${SOURCE_LOTTIE_REPO_PATH}`, "--jq", ".content"],
      { maxBuffer: 64 * 1024 * 1024, encoding: "utf8" },
    ),
  );
  return Buffer.from(readFileSync(encoded, "utf8").replace(/\s+/g, ""), "base64");
}

const entries = readArchive(sourceLottie());
const animationEntry = entries.find((e) => e.name.startsWith("a/") && e.name.endsWith(".json"));
const manifest = entries.find((e) => e.name === "manifest.json");
if (!animationEntry) throw new Error("the source archive holds no animation under a/");
if (!manifest) throw new Error("the source archive holds no manifest.json");

const source = JSON.parse(animationEntry.data.toString("utf8")) as LottieAnimation;
const trimmed = trimToCheckMark(source);

console.log(
  `source: ${trimmed.sourceTotalFrames} frames at ${source.fr}fps; ` +
    `the check mark is frames ${trimmed.startFrame} to ${trimmed.sourceTotalFrames} ` +
    `(${trimmed.keptFrames} frames, ${(trimmed.keptFrames / source.fr).toFixed(3)}s)`,
);
console.log(`keeping images ${trimmed.keptImageIds[0]} to ${trimmed.keptImageIds.at(-1)}`);

const kept = new Set(trimmed.keptImageIds.map((id) => `${id}.png`));
const out: ArchiveEntry[] = [
  manifest,
  { name: animationEntry.name, data: Buffer.from(JSON.stringify(trimmed.animation)) },
];
for (const entry of entries) {
  if (!entry.name.startsWith("i/")) continue;
  if (kept.has(entry.name.slice("i/".length))) out.push(entry);
}
const images = out.length - 2;
if (images !== trimmed.keptImageIds.length) {
  throw new Error(`the archive holds ${images} of the ${trimmed.keptImageIds.length} kept images`);
}

const lottiePath = join(root, CHECKMARK_LOTTIE_PATH);
writeFileSync(lottiePath, writeArchive(out));
console.log(`wrote ${CHECKMARK_LOTTIE_PATH}: ${statSync(lottiePath).size} bytes, ${images} frames`);

const wasm = readFileSync(installedWasmPath(root));
const wasmPath = join(root, DOTLOTTIE_WASM_PATH);
writeFileSync(wasmPath, wasm);
console.log(`wrote ${DOTLOTTIE_WASM_PATH}: ${wasm.length} bytes`);
