---
name: slate-embed-contract
description: Restyle the Slate embed (widget.js + embedded Booker) without breaking the cal.com drop-in contract. Use when editing widget.js or embed theming.
---

# Slate embed contract

Slate embeds into arbitrary Pennie landing pages (today: trypennie.com) the same
way cal.com does: `public/widget.js` injects a modal overlay + iframe into the
**host page**, and the iframe loads `Booker.tsx` at `<origin>/book?…`. The whole
value prop is that swapping cal -> Slate on trypennie is ~3 edits (script src,
origin, add `external_id`). A visual redesign must keep that drop-in contract
intact. This skill is the guardrail for anyone touching `public/widget.js` or how
`/book` consumes embed params.

Pair this with the `pennie-design-system-in-slate` skill for the actual tokens.

---

## The two styling zones (do NOT confuse them)

There are two separate CSS worlds. They are styled in completely different ways.

| Zone | Lives in | Styling mechanism | Can read `--pennie-*`? |
|------|----------|-------------------|------------------------|
| **Booker** (the actual UI) | inside the iframe at `/book` | full Pennie design system (globals.css + PP Mori + Tailwind) | YES |
| **Modal chrome** (overlay, modal box, close button, loader) | host page DOM, injected by `widget.js` | inline styles / injected `<style>` string in vanilla JS | **NO** |

### Zone 1 - Booker (inside the iframe): full design system

`src/components/Booker.tsx` rendered by `src/app/book/page.tsx`. This is a normal
Slate React surface. It gets the entire Pennie system: beige/white surfaces, sky
CTA, PP Mori, 16px radii, semantic `--pennie-*` tokens, `data-theme` theming. Style
it like any other surface. The iframe is a hard CSS boundary - nothing leaks in or
out. Honor the `embedded`, `theme`, and `brandColor` props it already receives.

### Zone 2 - Modal chrome (host page): LITERAL values only

`openModal` in `public/widget.js` builds the overlay, modal card, and close button
and appends them to the **host page's** `document.body`. The host page does not
have Slate's stylesheet, so `--pennie-*` CSS variables **do not exist there**.

**Referencing `var(--pennie-*)` in the chrome is a no-op and will silently break.**
Every Pennie value used in the chrome must be written as a LITERAL.

Recommended chrome literals (sourced from `colors_and_type.css`):

| Chrome element | Property | Literal value | Pennie token it mirrors |
|----------------|----------|---------------|-------------------------|
| Modal card | `background` | `#ffffff` (white) | `--surface` |
| Modal card | `border-radius` | `16px` | `--radius-xl` |
| Modal card | `box-shadow` | `0 12px 32px rgba(29,33,47,0.18)` | `--shadow-pop` (navy-tinted) |
| Overlay scrim | `background` | `rgba(29,33,47,0.55)` (navy) | navy `rgb(29,33,47)` -- **NOT hard black** |
| Close button | `color` | `rgb(106,106,112)`; hover/focus -> `rgb(52,52,52)` | `--pennie-muted` -> graphite |
| Close button | focus ring | `outline:3px solid rgba(130,208,255,0.45);outline-offset:2px` | `--focus-ring` (sky glow) |
| Chrome text/glyph | `font-family` | `'PP Mori',-apple-system,BlinkMacSystemFont,'Segoe UI',system-ui,sans-serif` | falls back to system-ui (PP Mori is NOT on the host) |

The brief bans hard black scrims -- use the navy scrim. Keep the modal card white
(the beige lives on the Booker inside the iframe). Do not depend on PP Mori for
chrome text; it will not load on the host page, so the only chrome text is the
close glyph and it falls back to system-ui by design.

**Chrome stays a fixed Pennie shell; only the Booker honors `brand`/`theme`.**
Do not half-theme the chrome from host `ui.brandColor` -- keep it a fixed white /
navy-scrim / sky-focus shell.

---

## The drop-in contract (must NOT break)

The entire point is cal.com API compatibility. Visual work touches NONE of this.
Do not refactor the `Cal` queue / param / message plumbing while restyling.

1. **`Cal()` global API shape** (`widget.js` global + `ns` handlers):
   - `Cal("init", "<ns>", { origin })` - origin per namespace
   - `Cal.ns["<ns>"]("ui", { theme, brandColor, layout, ... })`
   - `Cal.ns["<ns>"]("prerender", ...)` - accepted, no-op (Slate is cache-first)
   - `Cal("on", { action: "bookingSuccessful", callback })`
   - `window.Cal.config.forwardQueryParams = true`
   - The loader stub queues commands before `widget.js` loads; keep draining
     `prior.q` / `priorNs[ns].q`.

2. **`data-cal-*` triggers** (delegated click listener): `data-cal-link`,
   `data-cal-namespace`, `data-cal-config`. Keep the delegated listener so
   dynamically-added triggers still work.

3. **URL params** built by `bookingUrl` and read by `/book/page.tsx`:
   `xbc` (bucket / routing key), `external_id` (-> salesforceId), prefill keys,
   `embed=1`, `theme`, `brand`. Keep forwarding `theme`/`brand`/`embed=1`.

4. **postMessage contract** (Booker <-> widget.js):
   - `slate:resize { height }` - Booker posts `scrollHeight`; widget sets iframe height
   - `slate:bookingSuccessful { data }` - widget re-emits the cal-style
     `bookingSuccessful` host event. `data` is `{ booking, salesforceId, outcome }`,
     where `booking` is the Booker's confirm response: `id`, `startsAt`, `endsAt`,
     `manageUrl`, `duplicateWarning` and `calendarLinks` (#2643). It is posted for a
     fresh booking (`outcome: "created"`) AND for a lead moving the call they
     already have (`outcome: "rescheduled"`, whose `booking` is the reschedule
     response, same fields bar `duplicateWarning`), so a host that redirects on it
     ends both the same way (#2644). The lead's contact
     is deliberately NOT in it: the host already holds it, and a browser message is
     the wrong channel for more personal data.
   - **The host ends the booking by redirecting, not Slate** (Dan, 2026-09-23).
     trypennie navigates the whole window to
     `/my-offers/result/booking-confirmed?bookingId=<data.booking.id>&submissionId=<id>`
     on this message, the way cal.com's `successRedirectUrl` does today, and that
     page reads the booking server side through the key authed by id lookup
     (`docs/booking-api.md` section 3), which carries the contact and the calendar
     links. So `data.booking.id` is load bearing: renaming or dropping it breaks
     the confirmation page for every Slate booking.
   - **A wrong `parentOrigin` fails silently in the browser**, so the Booker checks
     it (#2641): when the declared origin differs from `document.referrer`'s origin,
     it reports the two origins once per load through `/api/client-errors`, which
     logs them (`tag=client-errors msg="embed origin mismatch"`) and says so in the
     info channel at most daily. There is deliberately no allow list: a preview or
     staging host must keep working. A host should pass `window.location.origin`.
   - If a loading state needs a new signal, **ADD** `slate:ready` -- do NOT rename
     or drop the existing two.

5. **`widget.js` stays vanilla / dependency-free.** Single IIFE served as plain
   `/widget.js`, no build step (~6KB). Do NOT import React, Tailwind, `globals.css`,
   or fonts into it. Chrome styling = inline styles / an injected `<style>` string
   only. Importing anything breaks the standalone-script contract and adds host
   payload + FOUC.

---

## Testing the embed from any host page (#2660)

Slate has no staging deployment, so a partner testing the embed from THEIR staging
site used to have one path: book a real advisor, with a real invite, a real text
from Regal, and a cancel by hand afterwards. The public test bucket is the safe
path. Open the embed exactly as a real page does, with the bucket code `PARTNER`:

```html
<button data-cal-link="router?form=review&xbc=PARTNER" data-cal-namespace="review">Book a call</button>
```

or `/book?xbc=PARTNER&embed=1&parentOrigin=<your origin>` directly. Every host
page may use it and no key is needed (Dan, 2026-09-24: any origin for now;
restricting it to approved host origins is #2666, which also records the exposure
this accepts).

**What it proves, and only this:** the embed contract. Times are offered, the
booking confirms, the host receives `slate:bookingSuccessful`, the redirect lands,
the confirmed page reads the booking back through the by id lookup, and the
tester receives a real Google Calendar invite. **What it never does:** reach Regal
(no webhook fires, no text is sent), touch Salesforce, or land on a real advisor.
The call is placed on `smoketest@trypennie.com`, the calendar the canary books,
under the event type "Partner test call". "No Regal" is a statement about SLATE's
webhook and Salesforce writes; it says nothing about the host's own
`bookingSuccessful` handler, pixels or backend calls, which run wherever the host
page points them.

What a tester will see:

- **Every screen says it is a test**: a mint band reading "This is a test
  booking. It reaches a test calendar only and sends no texts." on the booker,
  the confirmation, the panel for a call they already have, and the manage page;
  the invite's description opens with the same sentence; the admin's booking
  lookup and detail carry a "Test" mark beside it. The confirm response, the
  `slate:bookingSuccessful` payload's `booking` and the by id lookup all carry
  `isTest: true`, so a host can label its own confirmed page.
- **A second attempt with the same address** inside the first call's window is
  shown the existing call panel for the TEST booking (Move or Cancel), exactly as
  a lead would be. Test bookings and real bookings live in separate worlds: a
  tester who pastes a real lead's id is never shown that lead's call, and a test
  booking under an address never blocks the real lead who owns it.
- **The caps apply**: 3 confirms a minute and 10 an hour per address, 5 an hour
  per contact, and 8 partner test calls a day on the test calendar. On trypennie's
  own host page the results page hides the embed for 14 days after any booking in
  that browser (its `useBookingRedirect`), so a second run there needs a fresh
  browser profile.
- **No reminder email** is sent for a test booking, and no text.
- **Cancel through the manage link** in the invite when done; nothing cleans up
  automatically, a test booking lives out its time.
- A real lead's own `xbc` (three digits) can never reach the bucket, and a typo
  near the code is rescued to the Low pool like any unreadable code; only the
  exact, upper case `PARTNER` is served.

**Before the seed has run, `PARTNER` answers the same 404 as a typo** and the
booker says it could not load times. The rollout order in `DEPLOY.md` avoids that;
`scripts/seed-smoke-test.ts` run without `APPLY=1` measures whether it is served.

---

## brandColor behavior (D14)

KEEP the override knob (preserves cal.com parity). The embed **explicitly passes
Pennie's sky through as the default** `brandColor`; a host page may still override
it via `ui.brandColor`. It is NOT sky-only-ignore. The brand color tints the
Booker's dots / selected-ring / confirm / avatar (inline, since the hex is dynamic).

---

## ResizeObserver gotcha (load-bearing)

The Booker posts `scrollHeight` via a `ResizeObserver` (`slate:resize`), and
`widget.js` sets the iframe height from it. Therefore:

**The confirmation delight must animate `opacity` / `transform` ONLY -- never
`height`.** A height animation continuously fires the ResizeObserver and posts a
moving `scrollHeight`, which makes the iframe jitter/resize during the animation.
Calm single fade/rise on opacity+transform only. Keep iframe `min-height` >= the
Booker's collapsed height so it never flashes blank before the first `slate:resize`.

---

## Embed delight (D16)

Branch on the `embedded` flag in `Booker.tsx`:
- **Standalone confirmation** (`embedded === false`): the heavy iridescent Pennie 3D
  graphic.
- **Embedded confirmation** (`embedded === true`): a **lightweight inline SVG** only
  (check-badge / smile in a sky-soft puck) -- performance matters in the iframe. Do
  NOT ship the heavy iridescent graphic inside the embed.

Warm copy both places ("You're booked! Sarah will call you Thursday at 2:00.").
Calm single fade/rise, `prefers-reduced-motion` honored, opacity/transform only
(see ResizeObserver gotcha).

---

## Default-theme flip (D10)

`src/app/book/page.tsx` currently defaults the embed to `theme="dark"` (and
`Booker.tsx` defaults its `theme` prop to dark), but DISCOVERY says the Booker
should default to **beige/light**. trypennie sends **no `ui.theme`**, so whatever
the default is, is what renders for the real integration. **Flip the default to
light** in `/book/page.tsx` (and the `Booker` prop default). The host can still
override via the `theme` param; both themes stay maintained. This is a default
change inside `/book`, not a contract change -- the param plumbing is untouched.

---

## Modal a11y to ADD (host-side chrome)

Almost none of this exists today. Add it to `widget.js` (the iframe handles its own
*internal* focus; the host side just needs to manage the modal shell).

- `role="dialog"` + `aria-modal="true"` + `aria-label` (e.g. "Book a call") on the modal.
- **Focus trap**: move focus into the modal on open; Tab cycles between the close
  button and the iframe, never escaping to the host page behind the scrim.
- **Focus restore**: store the trigger element (`el` from the delegated click) before
  opening; restore focus to it on close.
- **Escape to close** (`keydown`). Click-on-overlay-to-close already exists.
- **Scroll lock**: set `document.body.style.overflow = 'hidden'` on open, restore on close.
- **Background inert**: `inert` (or `aria-hidden="true"`) on the rest of `document.body`
  while open so screen readers don't wander into the host page.
- **Close target >= 44x44px** hit area (currently ~24px glyph with small padding).
- **Reduced-motion gating**: any fade/transition respects `prefers-reduced-motion`.
- **Branded loading state**: render a Pennie loader on the white modal surface before
  the iframe paints; remove on iframe `load` (or a new `slate:ready` message); optionally
  fade the iframe in. Prevents the blank-white-box "broken" look on slow connections.
- **Mobile full-screen below 640px**: `inset:0; width:100%; height:100dvh;
  max-height:none; border-radius:0` (or top-rounded sheet). Use `100dvh` not `100vh`
  (iOS URL-bar bug); switch `max-height:90vh` -> `90dvh`.

---

## Pitfalls

- **Chrome cannot read `--pennie-*`** (host page scope) -- inline literals only. Highest-leverage gotcha.
- **PP Mori won't load on the host page** -- chrome falls back to system-ui; do not depend on it for chrome text.
- **Font FOUC inside the iframe** -- `theme` arrives as a URL param read server-side in `/book/page.tsx`; render the correct theme class + iframe `color-scheme`/background server-side so there's no white-then-beige flash. Don't move theme to a client-only effect.
- **Layout shift on the host** -- the overlay is `position:fixed`; keep it that way (never `absolute`/inline) so it never shifts host layout. The only shift risk is the iframe height jumping on `slate:resize`; keep `min-height` and `transition:height .15s ease`.
- **Style leakage** -- inline styles avoid leaking *out*, but host `!important` / inherited `font`/`color` can bleed *in*. Strongest fix: wrap the chrome in a (closed) **Shadow DOM** host on `document.body`. If Shadow DOM is out of scope this pass, minimum acceptable is to explicitly reset inheritable props (`font-family`, `font-size`, `line-height`, `color`, `letter-spacing`, `text-align`, `box-sizing`, `margin`/`padding`) on every injected node -- especially the close `<button>`.
- **Do not refactor the `Cal` queue / param / message plumbing while restyling** -- visual scope only; a regression breaks the trypennie drop-in.
- **postMessage uses `"*"` origin, unchecked `e.origin`** -- leave for the security/hardening pass; do not entangle with visual work.

---

## Verification

Use Playwright MCP against `pnpm dev`:

1. Load `public/embed-example.html`, click "Schedule your call" to open the modal.
2. Confirm chrome literals render: modal `border-radius:16px`, white card, navy
   `--shadow-pop` shadow, navy scrim `rgba(29,33,47,0.55)` (not black), sky focus
   ring on the close button.
3. Confirm `slate:resize` posts correctly: the iframe height tracks the Booker
   without scroll/jitter (and the confirmation animation does NOT resize the iframe).
4. Confirm `slate:bookingSuccessful` still fires (the `Cal("on", ...)` callback logs
   in the console).
5. Modal a11y: Tab cycles within the modal, Escape closes, focus returns to the
   trigger, background scroll is locked, close target >= 44px.
6. Booker inside in light + dark + with a `brand` color; embed default renders light.
7. Mobile full-screen at 375px (`100dvh`); branded loading state visible mid-boot
   (throttle network).
8. **Isolation test**: serve a hostile copy of `embed-example.html` with
   `* { font-family:"Comic Sans MS" !important; box-sizing:content-box } button { all:unset }`
   and confirm the chrome renders identically to the neutral host, and Slate's chrome
   does not restyle the host's own `.cta` button.

Acceptance: chrome identical on neutral vs hostile host; literals correct; no host
layout shift; resize + bookingSuccessful intact; a11y passes; reduced-motion disables
transitions.

---

## Key files

- `public/widget.js` -- `openModal` chrome, `bookingUrl` theming handoff, message listener, delegated trigger.
- `public/embed-example.html` -- the cal loader snippet + `data-cal-link` trigger Slate must stay compatible with.
- `src/app/book/page.tsx` -- reads `embed`/`theme`/`brand`/`xbc`/`external_id`; theme default to flip to light.
- `src/components/Booker.tsx` -- `PALETTE` light/dark, `brandColor` inline overrides, `slate:resize` ResizeObserver, `slate:bookingSuccessful`, `embedded` flag, confirmation screen.
- DISCOVERY: `.claude/orchestration-slate-brand-redesign/DISCOVERY.md` (D14/D15/D16).
- Research: `.claude/orchestration-slate-brand-redesign/research/embed-css-isolation.md`.
