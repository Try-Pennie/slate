/**
 * The one branded moment on the confirmation screen (#2163).
 *
 * Dan, 2026-09-09, seeing what was there: "what the hell is this image?" It was a
 * scatter of blank iridescent discs, taken from the design system's brand graphics
 * during the redesign. Coins say MONEY, and this screen is about a CALL that has
 * just been booked, so a lead read a picture of loans at the moment they were
 * being told a time and a person.
 *
 * Pennie already had the right asset, and it is the one the live cal.com
 * confirmation shows today: an iridescent coin with a tick struck into it. It
 * exists as a 2.1 second animation that resolves the Pennie P into the tick, and
 * as a still of the finished coin.
 *
 * Two facts about the pair decide how they are used, and both were measured
 * rather than assumed:
 *
 * - The STILL is fully transparent (alpha 0 at every edge), so it sits on any
 *   background in either theme.
 * - The VIDEO is opaque, on its own cream ground. It cannot sit on an arbitrary
 *   background: on the dark theme's card it would be a cream square. So the mark
 *   sits in a panel painted that exact cream in BOTH themes, and the video's ground
 *   disappears into it. That is also why the panel is not `bg-pennie-sky-soft` any
 *   more: a cream square inside a blue panel is exactly the seam this avoids.
 *
 *   The ground is `#F9F7F2`, and getting that number took three attempts, which is
 *   the part worth knowing. `--pennie-beige` (`#F9F6F0`) is not it. Decoding a
 *   frame to a canvas and reading the pixel says `#F9F5F0`, and that is not it
 *   either: Chrome COLOUR MANAGES video when it composites, so what a canvas hands
 *   back is not what the screen shows. The only measurement that counts is a
 *   pixel taken from a SCREENSHOT of the running page, which reads `#F9F7F2`. At
 *   144px the difference between any two of these is a visible square edge inside
 *   the panel. Re-measure that way if the asset ever changes.
 *
 * **It does not rest on the video's own last frame.** The animation resolves the
 * Pennie P into a small, pale flat tick, which is a weak thing to leave on the
 * screen and is a different picture from the one a reduced motion lead sees. So
 * the video fades out when it ends and the still coin underneath is revealed:
 * every lead ends up looking at the same mark, and it is the stronger one. Seen,
 * not assumed: the end frame was read out of the decoded video.
 */

export const CONFIRMATION_MARK = {
  /** 500x500, 2.134s, H.264. Plays once and holds the tick. */
  video: "/brand/checkmark.mp4",
  /** 432x429, transparent. The poster, and the whole thing under reduced motion. */
  still: "/brand/checkmark-still.webp",
  /** Drawn at this size in both forms. Stated once so the video and the still
   *  cannot differ, which would make the panel resize as one replaced the other. */
  size: 144,
  /** The video's own ground AS PAINTED, measured from a screenshot of the running
   *  page rather than from a decoded frame. See the header: the two disagree.
   *  colour-ok: a MEASUREMENT of a video file, not a colour Slate chose. It has
   *  to match what the asset paints, so pinning it to a token would make the
   *  still and the video disagree the first time the token moved (#1903). */
  ground: "#F9F7F2",
  /** How long the video takes to give way to the still once it ends. Long enough
   *  to read as a settle rather than a glitch, short enough not to be a second
   *  animation. */
  settleMs: 260,
} as const;
