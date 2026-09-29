// The confirmation mark's assets, held against the things they were built from
// (#2560).
//
// Three of these fail SILENTLY in production and in every other test:
//
//   - a `@lottiefiles/dotlottie-react` bump leaves the wasm in public/ behind.
//     Slate serves that file itself so the confirmation screen does not depend on
//     jsdelivr, and naming a URL also turns the player's CDN fallbacks OFF, so a
//     wasm the player refuses is not silently rescued: nothing draws.
//   - the animation is rebuilt and loses a frame's image. The player reports no
//     error for a layer whose asset is missing; it just draws nothing there.
//   - a static import of the player creeps into the booker's first load. Every
//     lead then pays for a megabyte and a half of wasm on a date picker, and the
//     only symptom is a number in a build report nobody reads.
//
// Run: node --experimental-strip-types scripts/test-confirmation-mark-assets.ts
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { readArchive } from "./lib/dotlottie-archive.ts";
import {
  CHECKMARK_LOTTIE_PATH,
  DOTLOTTIE_WASM_PATH,
  installedWasmPath,
  installedWasmVersion,
  webPackageRoots,
} from "./lib/confirmation-mark-assets.ts";
import { assert, eq, finish } from "./lib/harness.ts";

const root = join(import.meta.dirname, "..");
const read = (p: string) => readFileSync(join(root, p));

// --- the wasm matches the installed player -------------------------------
const servedWasm = read(DOTLOTTIE_WASM_PATH);
const installedWasm = readFileSync(installedWasmPath(root));
assert(
  servedWasm.equals(installedWasm),
  `${DOTLOTTIE_WASM_PATH} is the wasm the installed @lottiefiles/dotlottie-web ` +
    `(${installedWasmVersion(root)}) ships. Rebuild it with ` +
    `\`node --experimental-strip-types scripts/build-confirmation-mark-assets.ts\`.`,
);
// Positive control: the comparison must be able to say no, or a guard that
// happened to compare a file with itself would pass forever.
assert(
  !servedWasm.equals(Buffer.concat([installedWasm, Buffer.from([0])])),
  "positive control: the comparison rejects bytes that differ",
);
assert(servedWasm.length > 100_000, "the served wasm is a real build, not a placeholder");

// --- the animation is whole ----------------------------------------------
const entries = readArchive(read(CHECKMARK_LOTTIE_PATH));
const animationEntry = entries.find((e) => e.name.startsWith("a/") && e.name.endsWith(".json"));
assert(Boolean(entries.find((e) => e.name === "manifest.json")), "the archive carries a manifest");
assert(Boolean(animationEntry), "the archive carries an animation under a/");

const animation = JSON.parse(animationEntry!.data.toString("utf8")) as {
  ip: number;
  op: number;
  fr: number;
  layers: { st: number; refId?: string }[];
  assets: { id: string; layers?: { refId?: string }[] }[];
};
const images = new Set(
  entries.filter((e) => e.name.startsWith("i/")).map((e) => e.name.slice(2).replace(/\.png$/, "")),
);
const precomp = animation.assets.find((a) => a.layers);

eq(animation.ip, 0, "the shipped animation starts at frame 0");
eq(animation.layers[0]?.st, 0, "and its precomp layer reads from the precomp's own start");
assert(animation.op > 0, "the shipped animation has a length");
eq(
  precomp?.layers?.length,
  animation.op,
  "one image layer per frame, which is what a PNG sequence is",
);
eq(images.size, animation.op, "and one image file per layer");

for (const layer of precomp?.layers ?? []) {
  assert(
    Boolean(layer.refId) && images.has(layer.refId!),
    `every frame's image is in the archive (${layer.refId})`,
  );
}
// Nothing carried along that no frame draws: that is half the file size the
// whole exercise was about.
for (const id of images) {
  assert(
    (precomp?.layers ?? []).some((l) => l.refId === id),
    `every image in the archive is drawn by a frame (${id})`,
  );
}

// --- the video is gone, and so is every reference to it -------------------
//
// The name is ASSEMBLED rather than written out, because a scanner that has to
// name what it is looking for matches its own source and reports itself as the
// last remaining reference (L245).
const DELETED_VIDEO = ["checkmark", "mp4"].join(".");
const mentionsDeletedVideo = (text: string) => text.includes(DELETED_VIDEO);

assert(
  mentionsDeletedVideo(`src="/brand/${DELETED_VIDEO}"`),
  "positive control: the reference scan catches the shape it is looking for",
);
assert(
  !existsSync(join(root, "public/brand", DELETED_VIDEO)),
  "the mp4 the dotLottie player replaced is deleted, not left behind unserved",
);
const sourceDirs = ["src", "worker", "public", "scripts"];
function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(join(root, dir), { withFileTypes: true })) {
    const rel = `${dir}/${entry.name}`;
    if (entry.isDirectory()) out.push(...walk(rel));
    else if (/\.(ts|tsx|js|mjs|css|html|json)$/.test(entry.name)) out.push(rel);
  }
  return out;
}
const sources = sourceDirs.flatMap(walk);
assert(sources.length > 100, "positive control: the tree walk found files to read");
const stillAskForVideo = sources.filter((file) =>
  mentionsDeletedVideo(readFileSync(join(root, file), "utf8")),
);
{
  assert(
    stillAskForVideo.length === 0,
    `nothing still asks for the deleted video (offenders: ${stillAskForVideo.join(", ") || "none"}; ${sources.length} files read)`,
  );
}

// --- the warm and the player are one copy of the runtime ------------------
{
  const { direct, viaReact } = webPackageRoots(root);
  assert(
    direct === viaReact,
    `the app's own dotlottie-web is the copy the react player uses, so warming it warms the real player (app: ${direct}; react: ${viaReact}). Pin @lottiefiles/dotlottie-web in package.json to the version @lottiefiles/dotlottie-react depends on.`,
  );
}

// --- the player stays out of the booker's first load ----------------------
const mark = readFileSync(join(root, "src/components/ConfirmationMark.tsx"), "utf8");
assert(
  mark.includes('import("@/components/ConfirmationMarkPlayer")'),
  "ConfirmationMark reaches the player through a dynamic import",
);
assert(
  !/^\s*import\s[^\n]*ConfirmationMarkPlayer/m.test(mark),
  "and never through a static one, which would put the wasm in the booker's first load",
);
// One assertion over the whole tree, not one per file. The per file form printed
// 2,670 `ok` lines into a suite whose other output a person has to read, and a
// guard nobody can read the output of is one whose failure gets scrolled past.
// The offenders are NAMED in the message, so a failure still says which file.
const scanned = sources.filter(
  (f) => f.startsWith("src/") && !f.includes("ConfirmationMarkPlayer"),
);
const staticImporters = scanned.filter((file) =>
  /^\s*import\s[^\n]*@lottiefiles/m.test(readFileSync(join(root, file), "utf8")),
);
// A scan that read no files and a tree with no offender produce the same empty
// list, so say how many were read (L98).
assert(scanned.length > 100, `the scan read the source tree (${scanned.length} files)`);
assert(
  staticImporters.length === 0,
  `nothing but the player module statically imports the dotLottie runtime, which would put about a megabyte and a half in the booker's first load (offenders: ${staticImporters.join(", ") || "none"}; ${scanned.length} files read)`,
);

// The positive control: the scan must catch a static import, or an empty result
// proves only that it looked at nothing (L1).
assert(
  /^\s*import\s[^\n]*@lottiefiles/m.test(
    'import { DotLottieReact } from "@lottiefiles/dotlottie-react";',
  ),
  "the scan recognises a static import of the runtime",
);
assert(
  !/^\s*import\s[^\n]*@lottiefiles/m.test(
    'const p = await import("@lottiefiles/dotlottie-react");',
  ),
  "and does not mistake a dynamic import for one",
);

finish();
