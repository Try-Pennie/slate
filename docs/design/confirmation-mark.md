# The confirmation mark

The animated check mark a lead sees after booking, and the two built files
it depends on.

Moved out of `AGENTS.md` on 2026-10-15, where every character was loaded into
every session (#2393). `AGENTS.md` keeps the rule and points here; this is the
full text as it stood, with the reasoning, the incidents and the measurements
behind it.

## The confirmation mark's assets are built, and both are held (#2560)

The check mark a lead sees after booking is drawn by `@lottiefiles/dotlottie-react`
rather than by a `<video>`, because iOS refuses to autoplay video in Low Power
Mode and many iPhone owners leave it on permanently. Two files under
`public/brand/` make that work and NEITHER is hand made:

- `checkmark.lottie` is the check mark half of the animation trypennie ships,
  cut out at build time.
- `dotlottie-player.wasm` is copied out of `node_modules`. Slate serves it
  itself so the last screen a lead sees does not depend on jsdelivr, and naming
  a URL with `setWasmUrl` also turns the player's CDN fallbacks OFF, so a wasm
  the player refuses is not silently rescued: nothing draws.

`pnpm build:confirmation-mark` rebuilds both, and
`scripts/test-confirmation-mark-assets.ts` holds each against what it was built
from. **Bumping `@lottiefiles/dotlottie-react` means rebuilding**, or the served
wasm is a build of a different runtime; that guard is what says so, rather than a
lead's browser. It also fails a STATIC import of the player, which would put
about a megabyte and a half in the booker's first load, where the first screen is
a date picker with no use for it.

The still coin (`checkmark-still.webp`) is always in the tree underneath, and it
is the whole answer to every way the player can be absent: a chunk that never
arrives, a wasm that will not load, and a lead who asked for less motion all
leave the same correct picture rather than an empty panel.
