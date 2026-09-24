/**
 * The one branded moment on the confirmation screen (#2163, #2560).
 *
 * Dan, 2026-09-09, seeing what was there: "what the hell is this image?" It was a
 * scatter of blank iridescent discs, taken from the design system's brand graphics
 * during the redesign. Coins say MONEY, and this screen is about a CALL that has
 * just been booked, so a lead read a picture of loans at the moment they were
 * being told a time and a person.
 *
 * Pennie already had the right asset, and it is the one the live cal.com
 * confirmation shows today: an iridescent coin with a tick struck into it. It
 * exists as a 2.2 second animation that resolves the Pennie P into the tick, and
 * as a still of the finished coin.
 *
 * **It is drawn by a dotLottie player, not by a `<video>`, and that is the whole
 * point of #2560.** iOS refuses to autoplay video in Low Power Mode and
 * `playsInline` does not change that, so every lead on an iPhone with Low Power
 * Mode on saw a still picture and, possibly, a play button drawn over it. Many
 * iPhone owners leave Low Power Mode on permanently, so it was a standing share
 * of leads rather than an edge case. A dotLottie player paints frames onto a
 * canvas from JavaScript, which nothing on iOS blocks.
 *
 * Three facts about the pair decide how they are used, and each was measured
 * rather than assumed:
 *
 * - The STILL is fully transparent (alpha 0 at every edge), so it sits on any
 *   background in either theme.
 * - So are the ANIMATION's frames. Every one of the 65 PNGs is fully transparent
 *   at every edge pixel and between 88% and 99% transparent overall, measured
 *   frame by frame out of the source archive. This is what the mp4 was NOT: that
 *   one was opaque, on its own cream ground, so the mark had to sit in a panel
 *   painted that exact cream in both themes to hide the seam. **That panel and
 *   its measured `#F9F7F2` are gone with the video**, because there is no longer
 *   a square of cream to disguise. If the assets are ever replaced, measure the
 *   new frames' alpha before assuming this still holds.
 * - The animation carries its own images, so it needs no font and no network
 *   beyond the two files below.
 *
 * **It does not rest on the animation's own last frame.** The animation resolves
 * the Pennie P into a small, pale flat tick, which is a weak thing to leave on
 * the screen and is a different picture from the one a reduced motion lead sees.
 * So the canvas fades out when it completes and the still coin underneath is
 * revealed: every lead ends up looking at the same mark, and it is the stronger
 * one.
 */

export const CONFIRMATION_MARK = {
  /**
   * 500x500, 65 frames at 30fps (2.167s), transparent. Built by
   * `scripts/build-confirmation-mark-assets.ts` from the animation trypennie
   * ships, keeping only the check mark half of it.
   */
  animation: "/brand/checkmark.lottie",
  /**
   * The player's wasm, served by Slate rather than by the player's default
   * jsdelivr CDN (with its unpkg fallback). The confirmation screen is the last
   * thing a lead sees and it should not depend on a third party being up.
   * Naming a URL also turns those fallbacks OFF, which is the behaviour wanted
   * here: a failure to load ours surfaces as a load error the still coin covers,
   * rather than quietly reaching a CDN.
   *
   * It is copied out of `node_modules` by the same build script and held against
   * the installed package by `scripts/test-confirmation-mark-assets.ts`, so a
   * version bump that leaves a stale wasm here fails the build rather than
   * failing in a lead's browser.
   */
  wasm: "/brand/dotlottie-player.wasm",
  /** 432x429, transparent. The base layer, and the whole thing under reduced motion. */
  still: "/brand/checkmark-still.webp",
  /** Drawn at this size in both forms. Stated once so the canvas and the still
   *  cannot differ, which would make the panel resize as one replaced the other. */
  size: 144,
  /** How long the canvas takes to give way to the still once the animation ends.
   *  Long enough to read as a settle rather than a glitch, short enough not to be
   *  a second animation. */
  settleMs: 260,
  /**
   * How long the confirmation screen holds the spot empty waiting for the
   * animation's first frame (#2636). Past it the still coin goes up and the
   * animation is dropped for this booking, because showing the coin and then
   * swapping it for the drawing is what read as broken. Short enough that an
   * empty spot beside the heading reads as the page arriving, not as a missing
   * picture; the early load in `preloadConfirmationMark` is what makes the
   * drawing usually ready inside it.
   */
  holdMs: 500,
} as const;
