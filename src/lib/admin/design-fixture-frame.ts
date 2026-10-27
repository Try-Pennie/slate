/**
 * One frame of a settled design's fixture, for a page's `?frame=` preview: the frame the
 * fixture names, with a theme the page can draw. Refuses, by name, a frame the fixture
 * does not hold and a theme that is neither light nor dark, so a preview never draws a
 * frame the design does not have.
 *
 * Pure and import free, so the node suites load it.
 */
export function designFixtureFrame<F extends { theme: string }>(frames: Record<string, F>, frameId: string): F & { theme: "light" | "dark" } {
  const frame = Object.prototype.hasOwnProperty.call(frames, frameId) ? frames[frameId] : undefined;
  if (!frame) throw new Error(`the fixture names no frame "${frameId}"`);
  if (frame.theme !== "light" && frame.theme !== "dark") throw new Error(`frame "${frameId}" has no theme named ${frame.theme}`);
  return frame as F & { theme: "light" | "dark" };
}
