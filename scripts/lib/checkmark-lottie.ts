/**
 * Keeping only the check mark half of Pennie's loading animation (#2560).
 *
 * The source (`public/animation/loadingAnimation.lottie` in the trypennie repo)
 * is a coin spin THEN a check mark, 130 PNG frames driven by a single precomp
 * layer. trypennie's `PennieLoader` plays the check mark by splitting the
 * timeline at its exact midpoint and playing the SECOND segment,
 * `setSegment(Math.max(1, Math.floor(totalFrames / 2)), totalFrames)`. Slate
 * shows nothing but the check mark, so it ships only those frames and drops the
 * rest of the file.
 *
 * **The split is derived, not read off the file names.** The images are numbered
 * `imgSeq_167` to `imgSeq_296` and the timeline runs 0 to 129, so the numbering
 * does not map 1:1 onto frames: the main layer carries `st: -168`, which means
 * main frame `t` shows the precomp's frame `t + 168`. Taking the midpoint of the
 * image numbers instead of the timeline would land on a different picture.
 *
 * The result is retimed to start at zero rather than left sitting at its old
 * offset, so the shipped file says what it is: 65 frames, 0 to 65, one image per
 * frame.
 */

export type PrecompLayer = {
  ty: number;
  ip: number;
  op: number;
  st: number;
  refId?: string;
  ind?: number;
  [key: string]: unknown;
};

export type LottieAsset = {
  id: string;
  layers?: PrecompLayer[];
  p?: string;
  [key: string]: unknown;
};

export type LottieAnimation = {
  ip: number;
  op: number;
  fr: number;
  layers: PrecompLayer[];
  assets: LottieAsset[];
  [key: string]: unknown;
};

export type TrimResult = {
  animation: LottieAnimation;
  /** The first main-timeline frame kept, in the SOURCE's numbering. */
  startFrame: number;
  /** The source's own frame count, which is what a player reports as totalFrames. */
  sourceTotalFrames: number;
  /** The trimmed file's frame count. */
  keptFrames: number;
  /** The image asset ids kept, in timeline order. */
  keptImageIds: string[];
};

/** The split trypennie's PennieLoader uses, stated once so both sides agree. */
export function checkMarkStartFrame(totalFrames: number): number {
  return Math.max(1, Math.floor(totalFrames / 2));
}

/**
 * The check mark half of `animation`, retimed to start at frame 0.
 *
 * Throws rather than degrading on anything it did not expect: a trimmed
 * animation that quietly kept the wrong frames looks exactly like one that kept
 * the right ones until somebody watches it.
 */
export function trimToCheckMark(animation: LottieAnimation): TrimResult {
  if (animation.ip !== 0) {
    throw new Error(`expected the source timeline to start at 0, got ip=${animation.ip}`);
  }
  const sourceTotalFrames = animation.op - animation.ip;
  const startFrame = checkMarkStartFrame(sourceTotalFrames);

  const mainLayers = animation.layers.filter((l) => l.ty === 0);
  if (animation.layers.length !== 1 || mainLayers.length !== 1) {
    throw new Error(
      `expected one precomp layer on the main timeline, got ${animation.layers.length} layers ` +
        `(${mainLayers.length} precomps)`,
    );
  }
  const main = mainLayers[0]!;
  const precomp = animation.assets.find((a) => a.id === main.refId);
  if (!precomp?.layers) throw new Error(`the main layer references no precomp (refId=${main.refId})`);

  // Main frame t reads the precomp at `t - st`, so the first precomp frame the
  // check mark needs is this one. Retiming by exactly this amount is what puts
  // the kept range at zero.
  const sourceOffset = startFrame - main.st;

  const keptLayers: PrecompLayer[] = [];
  for (const layer of precomp.layers) {
    if (layer.op <= sourceOffset) continue;
    keptLayers.push({
      ...layer,
      ip: Math.max(0, layer.ip - sourceOffset),
      op: layer.op - sourceOffset,
      st: layer.st - sourceOffset,
    });
  }
  if (keptLayers.length === 0) throw new Error("trimming kept no frames at all");

  const keptImageIds = keptLayers.map((l) => l.refId).filter((id): id is string => Boolean(id));
  const keptImages = new Set(keptImageIds);
  for (const layer of keptLayers) {
    if (!layer.refId) throw new Error(`a kept precomp layer references nothing (ind=${layer.ind})`);
    if (!animation.assets.some((a) => a.id === layer.refId)) {
      throw new Error(`a kept precomp layer references a missing asset (${layer.refId})`);
    }
  }

  const keptFrames = sourceTotalFrames - startFrame;

  return {
    animation: {
      ...animation,
      ip: 0,
      op: keptFrames,
      // Zero, not `main.st - sourceOffset`: the kept precomp layers were moved
      // back by the same amount, so main frame t now reads precomp frame t.
      layers: [{ ...main, ip: 0, op: keptFrames, st: 0 }],
      assets: animation.assets
        .filter((a) => a.id === precomp.id || keptImages.has(a.id))
        .map((a) => (a.id === precomp.id ? { ...a, layers: keptLayers } : a)),
    },
    startFrame,
    sourceTotalFrames,
    keptFrames,
    keptImageIds,
  };
}
