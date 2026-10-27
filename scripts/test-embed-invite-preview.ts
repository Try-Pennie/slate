/**
 * #1421: the two lead-facing surfaces that #1343 left outside the copy preview.
 *
 * `pnpm preview:booker` prints every string on the booker and the manage page.
 * The EMBEDDED booker is how most real leads actually meet Slate, and the CALENDAR
 * INVITE is arguably the highest-stakes copy in the product: it is what the lead
 * still has in front of them on the day, it carries their only way to move or
 * cancel, and it is where the advisor reads their number from. Neither could be
 * read anywhere before it shipped.
 *
 * The rule that makes a preview worth having is that it holds no wording of its
 * own (L41). The invite half satisfies it the ordinary way, by calling the real
 * builders. The EMBED cannot: `widget.js` is a dependency-free static asset served
 * to third-party pages with no build step, so it imports nothing, and the preview
 * reads its declared copy block out of the shipping file instead.
 *
 * That substitution is only as good as the claim that the block is the ONLY place
 * the embed's wording lives, which is exactly the sort of claim that rots. So it
 * is checked in both directions (L96): every declared entry reaches a lead, and no
 * user-visible string sits outside the block.
 *
 * Run: node --experimental-strip-types --import ./scripts/register-paths.mjs \
 *        scripts/test-embed-invite-preview.ts
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { embedCopyEntries, embedCopyState } from "../src/lib/booking/embed-copy.ts";
import { inviteCopyScreens } from "../src/lib/booking/copy-preview.ts";
import { assert, eq, finish } from "./lib/harness.ts";
import { placeholderReplyLine } from "../src/lib/booking/manage-copy.ts";

const ROOT = join(import.meta.dirname, "..");
const widget = readFileSync(join(ROOT, "public", "widget.js"), "utf8");

/** The two ways a user-visible string reaches the DOM in `widget.js`. `title` is
 *  set through setAttribute, so it rides on the second. */
const TEXT_CONTENT = /(\w+)\.textContent\s*=\s*"([^"]*)"/g;
const ATTRIBUTE_TEXT = /setAttribute\(\s*"(?:aria-label|title|alt|placeholder)"\s*,\s*"([^"]*)"/g;

/** Built from escapes, so this file holds no literal dash to trip the copy lint. */
const DASHES = new RegExp("[\\u2013\\u2014]");
const EMOJI = new RegExp("[\\u{1F300}-\\u{1FAFF}\\u{2600}-\\u{27BF}]", "u");
const LEAKS = /undefined|NaN|\[object Object\]|\bnull\b|\{"/;

// ------------------------------------------------------------ the embed

const entries = embedCopyEntries(widget);

{
  // Anti-vacuity. Every assertion below would pass over an empty list, which is the
  // false-confidence shape these guards exist to prevent.
  assert(entries.length >= 6, `the embed's copy block still parses (got ${entries.length})`);
  for (const e of entries) {
    assert(e.text.trim().length > 0, `${e.key} is a real string`);
    assert(!LEAKS.test(e.text), `${e.key} carries no placeholder leak (${e.text})`);
    assert(!DASHES.test(e.text), `${e.key} uses no em or en dash`);
    assert(!EMOJI.test(e.text), `${e.key} carries no emoji`);
    assert(
      !embedCopyState(e.key).startsWith("(no state"),
      `${e.key} says how it reaches a lead; a bare key name is the row a reader skips`,
    );
  }
  eq(
    entries.length,
    new Set(entries.map((e) => e.key)).size,
    "no two entries share a key",
  );
}

// Every declared entry is actually USED, or the preview shows a lead copy that
// reaches nobody, which is the same lie in the other direction.
{
  const body = widget.slice(widget.indexOf("// slate-embed-copy: end"));
  const unused = entries.filter((e) => !body.includes(`COPY.${e.key}`)).map((e) => e.key);
  eq(unused, [], "every entry in the embed's copy block is used by the embed");
}

// And nothing OUTSIDE the block is copy. This is the direction that catches the
// defect: a seventh string set straight into the DOM ships as wording nobody can
// read, and the preview keeps reporting full coverage.
{
  const body = widget.slice(widget.indexOf("// slate-embed-copy: end"));
  const offenders: string[] = [];
  // The two ways a user-visible string reaches the DOM here. `title` is set via
  // setAttribute, so it is covered by the second pattern.
  for (const m of body.matchAll(TEXT_CONTENT)) {
    // The one-time chrome <style> also sets textContent, and a stylesheet is not
    // wording. Excluded by the NODE it is set on rather than by what the string
    // looks like, so a sentence can never slip through for resembling CSS.
    if (m[1] === "style") continue;
    if ([...m[2]!].length <= 1) continue;
    offenders.push(m[2]!);
  }
  for (const m of body.matchAll(ATTRIBUTE_TEXT)) {
    // A single glyph is furniture, not copy: the X in the corner is an icon whose
    // WORD is the aria-label beside it, which is declared.
    if ([...m[1]!].length <= 1) continue;
    offenders.push(m[1]!);
  }
  eq(
    offenders,
    [],
    "no user-visible string in widget.js sits outside its copy block, so the preview " +
      "showing the block is the same as showing what a lead reads",
  );
}

// Positive controls, or a renamed pattern would leave both checks green forever (L1).
{
  const sabotaged = `${widget}\n  msg.textContent = "an invented sentence";`;
  const body = sabotaged.slice(sabotaged.indexOf("// slate-embed-copy: end"));
  const found = [...body.matchAll(TEXT_CONTENT)].filter(
    (m) => m[1] !== "style" && [...m[2]!].length > 1,
  );
  eq(found.length, 1, "a string set straight into the DOM IS caught");
}
{
  // And the reader refuses rather than reporting an embed that says nothing, which
  // is how a scan matching nothing gets acted on as a real result (L100).
  let threw = false;
  try {
    embedCopyEntries("var x = 1;");
  } catch {
    threw = true;
  }
  assert(threw, "a widget.js with no copy block is an error, never an empty list");
}

// -------------------------------------------------------- the invite

const screens = inviteCopyScreens();

{
  assert(screens.length >= 2, `the invite copy is previewed (got ${screens.length} screens)`);
  for (const screen of screens) {
    assert(screen.purpose.trim().length > 20, `${screen.screen} says what it is for`);
    assert(screen.lines.length > 0, `${screen.screen} has at least one state`);
    for (const line of screen.lines) {
      const where = `${screen.screen} / ${line.state}`;
      assert(line.text.trim().length > 0, `${where} renders a real string`);
      assert(!LEAKS.test(line.text), `${where} renders no placeholder leak (${line.text})`);
      assert(!DASHES.test(line.text), `${where} uses no em or en dash`);
      assert(!EMOJI.test(line.text), `${where} carries no emoji`);
    }
    const labels = screen.lines.map((l) => l.state);
    eq(new Set(labels).size, labels.length, `${screen.screen}'s states are each described differently`);
  }
}

// A routed invite is the lead's only way back to their booking, so the manage link
// has to be IN it. A body that lost the link would still pass every check above.
// The one exception is decided, not lost: a call on the placeholder advisor offers no
// way to change it (Dan, 2026-10-27, #4206), so its invite must carry NO link, and
// is told apart by the reply to our texts line it carries instead.
{
  const bodies = screens
    .flatMap((s) => s.lines)
    .map((l) => l.text)
    .filter((t) => t.startsWith("Booked via Pennie"));
  const placeholder = bodies.filter((b) => b.includes(placeholderReplyLine("invite")));
  const routed = bodies.filter((b) => !b.includes(placeholderReplyLine("invite")));
  assert(routed.length >= 2, "both routed invite bodies are previewed, with and without a number");
  for (const b of routed) {
    assert(
      b.includes("/booking/manage/"),
      `the invite carries the lead's way back to their booking (got: ${b})`,
    );
  }
  eq(placeholder.length, 1, "the placeholder advisor's invite is previewed");
  for (const b of placeholder) {
    assert(!b.includes("/booking/manage/"), `the placeholder's invite offers no way to change the call (got: ${b})`);
  }
}

// The title must not trail an empty "with" when we never got a name, which is the
// case a preview built only from a happy-path fixture would never show. #3376: it
// names both people when it can, so the preview shows that shape, the lead-only
// shape, and the appointment alone.
{
  const titles = screens[0]!.lines.filter((l) => l.state.includes("title")).map((l) => l.text);
  assert(titles.length === 3, `all three title states are previewed (got ${titles.length})`);
  assert(
    titles.some((t) => /\bbetween\b.+\band\b/.test(t)),
    `the title names the advisor and the lead when both are known (got: ${titles.join(" | ")})`,
  );
  assert(
    titles.some((t) => /\bwith\b/.test(t)) && titles.some((t) => !/\b(with|between)\b/.test(t)),
    `a nameless booking's title names the appointment alone (got: ${titles.join(" | ")})`,
  );
}

// The preview holds no wording of its own, the same rule the booker's does, checked
// over the invite section of the same file.
{
  const src = readFileSync(join(ROOT, "src", "lib", "booking", "copy-preview.ts"), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
  const section = src.slice(src.indexOf("export function inviteCopyScreens"));
  eq(
    [...section.matchAll(/\btext:\s*(["'`])/g)].length,
    0,
    "every invite line calls the real builder rather than repeating its words",
  );
}

finish();
