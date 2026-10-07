// Preloaded into a spawned load test driver (`--import`), never into a suite itself.
//
// Makes every `setTimeout` in that process fire at HALF its delay. A timer runs on the
// monotonic clock and `Date.now()` on the wall clock, so a real timer can return a
// millisecond or two before the wall clock reaches the moment it was set for (#3103,
// and run 37568349592's probe sent at 599ms against a 600ms settle, #3429). Halving
// exaggerates that so a driver waiting with ONE sleep is seen to arrive early on every
// run, never only on an unlucky one, while a driver that loops until the wall clock
// reads the moment still converges. Never below one millisecond, so a loop over the
// last millisecond always lets the clock move rather than spinning in place.
const realSetTimeout = globalThis.setTimeout;
globalThis.setTimeout = (fn, ms, ...args) => {
  const asked = Number(ms) || 0;
  return realSetTimeout(fn, asked <= 0 ? 0 : Math.max(1, Math.floor(asked / 2)), ...args);
};
