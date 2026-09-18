// How the check mark half of Pennie's animation is cut out of the whole (#2560).
//
// The source is a coin spin THEN a check mark, and trypennie's PennieLoader
// plays the check mark by splitting the timeline at its midpoint and playing the
// second segment. Slate ships only that half, so the same split has to be made
// once, at build time, against a file whose IMAGE NUMBERING does not line up
// with its TIMELINE: the images run imgSeq_167 to imgSeq_296 while the timeline
// runs 0 to 129, and the main layer's `st: -168` is what reconciles them.
//
// Splitting on the image numbers instead lands on a different picture, which is
// the mistake this file exists to make impossible: it is asserted as a control
// below, because a trimmer that kept the wrong 65 frames would look completely
// healthy until somebody watched the confirmation screen.
//
// Run: node --experimental-strip-types scripts/test-checkmark-lottie.ts
import {
  checkMarkStartFrame,
  trimToCheckMark,
  type LottieAnimation,
} from "./lib/checkmark-lottie.ts";
import { readArchive, writeArchive } from "./lib/dotlottie-archive.ts";
import { assert, eq, finish } from "./lib/harness.ts";

/**
 * The real file's shape, at the real numbers: one precomp layer carrying
 * `st: -168`, and 130 one-frame image layers numbered from 167.
 */
function sourceAnimation(): LottieAnimation {
  const layers = [];
  for (let n = 167; n <= 296; n++) {
    layers.push({
      ty: 2,
      ind: n - 166,
      nm: `Image Layer ${n + 1}`,
      refId: `imgSeq_${n}`,
      ip: n,
      // The real file's last layer is held for two frames; everything else is one.
      op: n === 296 ? n + 2 : n + 1,
      st: n,
    });
  }
  return {
    nm: "Main Scene",
    v: "5.7.0",
    fr: 30,
    w: 500,
    h: 500,
    ip: 0,
    op: 129,
    layers: [{ ty: 0, ind: 1, nm: "[00000-00296].png", refId: "sequence_0", ip: 0, op: 129, st: -168 }],
    assets: [
      { id: "sequence_0", nm: "sequence_0", fr: 30, layers },
      ...layers.map((l) => ({ id: l.refId, u: "/i/", w: 500, h: 500, p: `${l.refId}.png` })),
    ],
  };
}

const source = sourceAnimation();
const trimmed = trimToCheckMark(source);

eq(
  checkMarkStartFrame(129),
  64,
  "the split is PennieLoader's own: max(1, floor(totalFrames / 2)) of the TIMELINE",
);
eq(trimmed.startFrame, 64, "the check mark starts at main frame 64");
eq(trimmed.keptFrames, 65, "65 frames are kept (64 up to but not including 129)");
eq(trimmed.animation.op, 65, "the trimmed timeline runs 0 to 65");
eq(trimmed.animation.ip, 0, "the trimmed timeline starts at zero, not at its old offset");

// The derivation that matters. Main frame `t` reads the precomp at `t - st`, so
// frame 64 reads precomp frame 232, which is imgSeq_232.
eq(trimmed.keptImageIds[0], "imgSeq_232", "the first kept image is the one main frame 64 shows");
eq(trimmed.keptImageIds.at(-1), "imgSeq_296", "the last kept image is the animation's own last");
eq(trimmed.keptImageIds.length, 65, "one image per kept frame");

// The control. Halving the IMAGE NUMBERS instead of the timeline gives
// imgSeq_231 (the midpoint of 167..296), a different picture one frame earlier,
// and a trimmer that did that would produce a perfectly valid file.
assert(
  trimmed.keptImageIds[0] !== "imgSeq_231",
  "control: the split is NOT the midpoint of the image numbering, which lands elsewhere",
);

const precomp = trimmed.animation.assets.find((a) => a.id === "sequence_0");
eq(precomp?.layers?.length, 65, "the precomp keeps exactly the kept layers");
eq(precomp?.layers?.[0]?.ip, 0, "the first kept layer is retimed to frame 0");
eq(precomp?.layers?.[0]?.st, 0, "and its own start time moves with it");
eq(precomp?.layers?.at(-1)?.ip, 64, "the last kept layer sits on the last frame");
eq(trimmed.animation.layers[0]?.st, 0, "the main layer now reads the precomp from its start");
eq(
  trimmed.animation.assets.length,
  66,
  "the dropped frames' images are dropped too (one precomp plus 65 images)",
);
assert(
  !trimmed.animation.assets.some((a) => a.id === "imgSeq_167"),
  "an image from the coin spin is not carried along unused",
);

for (const layer of precomp?.layers ?? []) {
  assert(
    trimmed.animation.assets.some((a) => a.id === layer.refId),
    `every kept layer still resolves to an image it can draw (${layer.refId})`,
  );
}

// Each way it can be handed something it did not expect. A trimmer that guessed
// instead of refusing would write a file that plays the wrong thing.
for (const [name, broken] of [
  ["a timeline that does not start at zero", { ...source, ip: 4 }],
  ["more than one layer on the main timeline", { ...source, layers: [...source.layers, source.layers[0]!] }],
  ["a main layer referencing no precomp", { ...source, layers: [{ ...source.layers[0]!, refId: "nope" }] }],
] as const) {
  let threw = false;
  try {
    trimToCheckMark(broken as LottieAnimation);
  } catch {
    threw = true;
  }
  assert(threw, `trimming refuses ${name} rather than guessing`);
}

// The archive half: what is written back has to be readable, and reading it back
// has to give the same bytes. A zip writer that dropped an entry would show up
// as a frame that never draws, which nothing else here could see.
const roundTrip = readArchive(
  writeArchive([
    { name: "manifest.json", data: Buffer.from('{"version":"2"}') },
    { name: "a/Main Scene.json", data: Buffer.from(JSON.stringify(trimmed.animation)) },
    { name: "i/imgSeq_232.png", data: Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4, 5]) },
  ]),
);
eq(roundTrip.length, 3, "every entry written comes back");
eq(roundTrip[0]?.name, "manifest.json", "and in the order it was written");
eq(
  roundTrip[2]?.data.toString("hex"),
  "89504e470102030405",
  "a binary entry survives the round trip byte for byte",
);
eq(
  JSON.parse(roundTrip[1]!.data.toString("utf8")).op,
  65,
  "the animation JSON survives the round trip",
);

// Deterministic output, so the committed asset can be checked against its own
// build step rather than being rebuilt and diffed against a moving target.
const twice = [0, 1].map(() =>
  writeArchive([{ name: "a.json", data: Buffer.from("x") }]).toString("hex"),
);
eq(twice[0], twice[1], "writing the same entries twice gives the same bytes");

finish();
