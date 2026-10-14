// The colours a host page may set on the booker (#3718). Run:
//   node --experimental-strip-types --import ./scripts/register-paths.mjs scripts/test-host-colours.ts
//
// A host sets the button colour (`brand`) and, on the inline card, the card's
// background (`bg`). Each is kept only when text on it can be read: the button's
// label, and the card's title, must reach 4.5:1 in graphite or beige, whichever is
// better. A colour that cannot, or does not parse, is REFUSED: Slate keeps its own
// default and the refusal is returned, so the page can log it.
import { judgeHostColours } from "../src/lib/embed/host-colours.ts";
import { DEFAULT_BRAND_COLOR } from "../src/lib/brand-label.ts";
import { eq, finish } from "./lib/harness.ts";

const GRAPHITE = "var(--fg-on-sky)";
const BEIGE = "var(--pennie-beige)";

{
  const r = judgeHostColours({ brand: null, bg: null, embedded: true });
  eq([r.brandColor, r.cardSurface, r.refused], [DEFAULT_BRAND_COLOR, undefined, []], "nothing set, embedded: Pennie sky and no card colour");
  eq(judgeHostColours({ brand: null, bg: null, embedded: false }).brandColor, undefined, "nothing set, standalone: no brand, as before");
}
{
  const r = judgeHostColours({ brand: "#000000", bg: null, embedded: true });
  eq([r.brandColor, r.refused], ["#000000", []], "trypennie's black button reads fine (a beige label) and is kept");
}
{
  const r = judgeHostColours({ brand: "#808080", bg: null, embedded: true });
  eq(r.brandColor, DEFAULT_BRAND_COLOR, "a mid grey no label can be read on falls back to Pennie sky");
  eq(r.refused.map((x) => [x.which, x.value]), [["brand", "#808080"]], "and the refusal says which colour and what was sent");
}
{
  const r = judgeHostColours({ brand: "orange", bg: null, embedded: true });
  eq([r.brandColor, r.refused.map((x) => x.which)], [DEFAULT_BRAND_COLOR, ["brand"]], "a colour that is not hex is refused, not guessed at");
}
{
  const r = judgeHostColours({ brand: null, bg: "#FFF4D6", embedded: true });
  eq(r.cardSurface, { background: "#FFF4D6", ink: GRAPHITE }, "a light card colour is kept with graphite text");
}
{
  const r = judgeHostColours({ brand: null, bg: "#1D212F", embedded: true });
  eq(r.cardSurface, { background: "#1D212F", ink: BEIGE }, "a dark card colour is kept with beige text");
}
{
  const r = judgeHostColours({ brand: null, bg: "#7A7A7A", embedded: true });
  eq(r.cardSurface, undefined, "a card colour neither text reads on keeps Slate's own card");
  eq(r.refused.map((x) => x.which), ["bg"], "and is refused");
}
{
  const r = judgeHostColours({ brand: "#808080", bg: "url(x)", embedded: true });
  eq(r.refused.map((x) => x.which), ["brand", "bg"], "both refusals are returned together");
  eq(r.refused.every((x) => x.reason.length > 0), true, "each with a reason");
}

finish();
