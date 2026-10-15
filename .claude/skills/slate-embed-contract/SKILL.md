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
   - `Cal.ns["<ns>"]("prerender", ...)` - accepted, no-op. Slate does NOT build
     the frame at page load the way cal.com's pre-render does; it warms the
     availability read at render (#251), and builds the frame, hidden, on the
     trigger's first hover, focus or touch (#2679), then KEEPS it (see "One
     frame per namespace" and "Pre built on intent" below).
   - `Cal("on", { action: "bookingSuccessful", callback })`
   - `window.Cal.config.forwardQueryParams = true`
   - The loader stub queues commands before `widget.js` loads; keep draining
     `prior.q` / `priorNs[ns].q`.

2. **`data-cal-*` triggers** (delegated click listener): `data-cal-link`,
   `data-cal-namespace`, `data-cal-config`. Keep the delegated listener so
   dynamically-added triggers still work.
   **`data-cal-config` is read** (#2716): it is JSON on the trigger, and an
   attribute that is not JSON, or not a JSON object, is ignored and never breaks
   the open (one `console.warn` per page says so, since it may have carried a
   partner key). cal.com's `metadata[<key>]` entries are mapped onto booking URL
   params through the `PARTNER_METADATA` table in `widget.js`:
   `metadata[sfdc_submission_id]` -> `submissionId`,
   `metadata[regal_profile_id]` -> `regalProfileId`. An unknown metadata key is
   dropped, with one `console.warn` per key per page, never forwarded under a
   generic rename. `layout`, `cal.embed.pageType` and every other non metadata key
   are accepted as no ops. A URL param (the link's own query, or the forwarded
   host query) wins over the config on a collision. The table's param names are
   held against `PARTNER_KEYS` in both directions by
   `src/components/widget-embed.test.ts`, which reads the
   `slate-partner-metadata` block out of the shipped file, so adding a partner key
   means adding its metadata spelling there too.

3. **URL params** built by `bookingUrl` and read by `/book/page.tsx`:
   `xbc` (bucket / routing key), `external_id` (-> salesforceId), prefill keys,
   `embed=1`, `theme`, `brand`. Keep forwarding `theme`/`brand`/`embed=1`.
   Two prefill keys are load bearing (#2659): **`submissionId`** (the lead's
   Salesforce submission) and **`regalProfileId`** (the Regal contact). A host
   page passes each when it has it, under exactly that spelling, and leaves it
   off otherwise. `/book` keeps them in `prefill`, so they ride into the booking,
   every webhook (Regal receives `sfdc_submission_id` / `regal_profile_id`) and
   the warehouse, and they come back on `booking` below. trypennie passes
   `submissionId` on the inline iframe URL today.

4. **postMessage contract** (Booker <-> widget.js):
   - `slate:resize { height }` - Booker posts `scrollHeight`; widget sets iframe height
   - `slate:bookingSuccessful { data }` - widget re-emits the cal-style
     `bookingSuccessful` host event. `data` is `{ booking, salesforceId, outcome }`,
     where `booking` is the Booker's confirm response: `id`, the booking's own
     `salesforceId` and `externalId` as stored (#2750, `null` when it holds none),
     `startsAt`, `endsAt`,
     `manageUrl`, `duplicateWarning`, `calendarLinks` (#2643), and the partner
     join keys `submissionId` and `regalProfileId` (#2659, `null` when the URL
     carried none). It is posted for a
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
   - **Two lead ids ride on the success message, and they differ on a moved call
     (#2750).** `data.booking.salesforceId` / `data.booking.externalId`, and the V2
     events' `salesforceId` / `externalId`, are the ids the BOOKING is stored
     under. `data.salesforceId` beside `booking` is the PAGE's `external_id`. A
     lead who submits twice holds two lead records; moving the call they already
     have from the second page leaves it on the FIRST lead, and the by id lookup
     refuses a booking the id it is given does not own (#2657), so a lookup made
     with the page's id 404s. **A host looks a booking up with the id from the
     EVENT's booking, never one it re-derives from its own page.** The V2 payload
     never falls back to the page's id: a booking holding none answers `null`.
   - **A wrong `parentOrigin` fails silently in the browser**, so the Booker checks
     it (#2641): when the declared origin differs from `document.referrer`'s origin,
     it reports the two origins once per load through `/api/client-errors`, which
     logs them (`tag=client-errors msg="embed origin mismatch"`) and says so in the
     info channel at most daily. There is deliberately no allow list: a preview or
     staging host must keep working. A host should pass `window.location.origin`.
   - **The confirm carries the framing page's ORIGIN (#2728).** When the Booker is
     inside a frame, its `/booking` POST adds `referrerOrigin`: `document.referrer`
     reduced to scheme, host and port, never its path or query, which on a booking
     page can carry a lead's details. It is absent when the Booker is its own page
     (that referrer is whatever linked to it, not a host) and when the referrer is
     Slate's own origin. The server does not trust it: `readReferrerOrigin`
     (`src/lib/embed/referrer-origin.ts`) reduces it again, drops anything that is
     not a web origin, and a value of the wrong type never refuses the booking. It
     is stored as `bookings.referrer_origin`, beside `prefill.parentOrigin`, and the
     off site page (`src/lib/monitor/offsite-origin.ts`) pages when EITHER one is
     not the production site, which is what catches a host that framed `/book`
     itself and declared nothing. A host whose referrer policy is `no-referrer`
     records null, which is absence, not a finding.
   - If a loading state needs a new signal, **ADD** a message; do NOT rename or
     drop an existing one.
   - **The booker lifecycle (#2658).** Pennie's GA4 tagging spec instruments
     cal.com's booker one event per stage, through `Cal.ns.<ns>("on", ...)`, so
     `widget.js` announces the same stages under cal.com's names. Each is a raw
     `slate:*` message the Booker posts (through `postToParent`, known origin
     only, no lead contact), re-emitted by the widget under the cal.com name. The
     names live in `src/lib/embed/lifecycle-events.ts`; the mapping is pinned by
     `src/components/widget-embed.test.ts` driving the real file.

     | widget event (`on` action) | raw message | when | `detail.data` |
     |---|---|---|---|
     | `navigatedToBooker` | widget only | a `data-cal-link` trigger is clicked, before the modal opens or reopens | `{}` |
     | `bookerViewed` | `slate:bookerViewed` | first render of the Booker in this frame load, so once per page load for one link (#2678); of an inline card's pieces only the times piece sends it, never the Call me now piece or a pop up a piece opens (#3718) | `{ slotsLoaded }` |
     | `bookerReady` | `slate:bookerReady` | the availability answered with at least one time, once per frame load, from the same frames as `bookerViewed` (#3718) | `{ slotsLoaded: true }` |
     | `bookerReopened` | widget only | the modal is opened again on the same page, after the open succeeded (#2677) | `{}` |
     | `bookerReloaded` | widget only | the modal iframe fires `load` a second or later time: a retry, or a reload inside the frame, never a close and reopen | `{}` |
     | `linkFailed` | `slate:linkFailed`, and widget only for the modal's own load failure | the availability read failed (`availability_failed`), the page boundary caught a crash (`booker_crashed`), or the modal's iframe never loaded (`load_timeout`, `load_error`) | `{ code, msg }` |
     | `bookingSuccessfulV2` | derived from `slate:bookingSuccessful` with `outcome: "created"` | a fresh booking | `{ uid, startTime, endTime, status: "confirmed", isTest, salesforceId, externalId }`, the ids the booking's own (#2750) |
     | `rescheduleBookingSuccessfulV2` | derived from `outcome: "rescheduled"` | a lead moved the call they already had | same shape |
     | `bookingCancelled` | `slate:bookingCancelled` | the in embed cancel (`cancelExistingCall`) succeeded | `{ booking: { uid, startTime, endTime, cancellationReason } }` |
     | `bookingSuccessful` | `slate:bookingSuccessful` | UNCHANGED, fresh and moved alike | `{ booking, salesforceId, outcome }` |
     | `*` | | every event above, `detail.type` set | |

     **Which one a host should use.** A host records a booking from
     `bookingSuccessfulV2` OR from `bookingSuccessful`, never both: they announce
     the same booking and would double count it. A host written against
     `bookingSuccessful` keeps working (trypennie's redirect is built on it,
     #2643); a host built to the spec listens to the V2 pair. A moved call is
     `rescheduleBookingSuccessfulV2` and is never announced as
     `bookingSuccessfulV2`. A host that frames `/book` in its own iframe listens
     for the raw `slate:*` names directly.

     **A cancel from the manage page has no host event.** The link in the invite
     opens Slate's own page outside any host, so nothing can announce it to a
     host; that is true on cal.com too. Only the in embed cancel announces.

     **One frame per namespace, kept across close and reopen (#2678).** The
     modal is built on the first click and never removed: closing it (the X,
     the scrim, Escape, `slate:escape`) hides the overlay (`display:none`,
     `aria-hidden="true"`, `inert` where the browser has it) and returns focus
     to the trigger. The next click on a trigger with the same namespace and
     the same booking URL shows the same overlay and the same iframe, so the
     Booker keeps its chosen day, time and typed details, and the host sees
     `navigatedToBooker` then `bookerReopened` and nothing else: `bookerViewed`
     and `bookerReady` fire once per page load, which is what the GA4 spec's
     `view_booker` once per visit rule needs. A trigger whose booking URL differs
     (another `xbc`, other params) REPLACES that namespace's frame, so one frame
     is held per namespace however often a page rewrites its link; a second
     namespace gets a frame of its own, and only one overlay is on screen at a
     time. The 12 second load timeout runs against the first load only: a loaded
     frame gets no clock on reopen, and a frame closed mid-load has its clock
     started again when it is shown. `bookerReloaded` needs a real second `load`
     of one iframe, which a close and reopen is not.

     While a frame is hidden, `activeIframe` is null (it names the frame ON
     SCREEN, and nothing is), so a booking or an escape from a hidden frame is
     ignored. A `slate:resize` from a hidden frame still sets that frame's
     height, and a lifecycle message that arrives while hidden (a `bookerReady`
     after a fast close) is still announced, because both are facts about that
     frame load and neither will be posted again. Every one of those is matched
     against the frames the widget itself built; a message from any other window
     is dropped on every branch. `src/components/widget-embed.test.ts` pins all
     of it against the real file.

     **Pre built on intent (#2679).** The trigger's first hover, focus or touch
     (the same delegated listener that warms availability) builds that
     namespace's frame hidden, so the first click only shows it: measured from a
     local host page against production, the booker answered with times a
     median 1ms after the click with a 1.5s hover, against 848ms before. Rules
     that keep it invisible: until the first show the overlay is hidden with
     `visibility:hidden` (a `display:none` frame gets a zero width viewport, so
     the Booker would lay out at 0px), plus `aria-hidden` and `inert`; it takes
     no focus, no key (the keydown listener exists only while shown) and no
     scroll lock; and everything it says (`bookerViewed`, `bookerReady`,
     `linkFailed`, `bookerReloaded`) is HELD and announced on the first show,
     right after that click's `navigatedToBooker`, because a hover is not a
     view. A frame replaced or never opened announces nothing. Its 12 second
     load clock starts at the pre build, so a frame that never loads is reported
     on the first open at once; a held timeout is dropped if the frame then
     loads before anyone opens it. Intent never replaces an existing frame (only
     a click does), render never pre builds (that would load a booker per button
     on every page view), and a pre build that throws is swallowed, because the
     click builds again on the path the error beacon watches.

5. **`widget.js` stays vanilla / dependency-free.** Single IIFE served as plain
   `/widget.js`, no build step (~6KB). Do NOT import React, Tailwind, `globals.css`,
   or fonts into it. Chrome styling = inline styles / an injected `<style>` string
   only. Importing anything breaks the standalone-script contract and adds host
   payload + FOUC.

---

## The inline card and its two pieces (#3718)

`Cal("inline", { elementOrSelector, calLink, config })` draws the booker INSIDE an
element on the host page (`/book?layout=inline`), as the compact card: title, Call me
now row (`callMeNow=above|below` on the link, for a lead), day strip and six times.

**Pieces (Geoff, 2026-10-15).** `config.piece` of `"times"` or `"callMeNow"` draws one
piece on its own (`&piece=`), just its tile with no title or card background, so the
page places each where it fits. The tiles keep Slate's own white (light) or dark
surface; `cal-bg` does not recolour them (Dan, 2026-10-15). Each piece frame starts at
height 0 and is rounded by widget.js, so the Call me now piece takes no room for a lead
it is not offered to. An unknown piece draws the whole card.

**A piece never changes in place: it asks the host for the pop up.** It posts
`slate:openBooker` (`PIECE_MESSAGE` in `src/lib/embed/lifecycle-events.ts`; widget.js
holds its own copy, pinned by `widget-embed.test.ts`), taken only from a piece frame
widget.js built:

| `data` | widget.js opens |
|---|---|
| `{ slot: <instant> }` (a picked time) | the full booker with `&slot=`, landing on the details step for it, or on its day saying it was just taken |
| `{ day: <yyyy-mm-dd> }` (View more times) | the full booker with `&day=`, on that day |
| `{ callMeNow: "press" }` | a 520px pop up with the card (`layout=inline&cmnPress=1`), which makes the request on arrival and shows the confirmation or the failure |

**Only the times piece (or the whole card) announces `bookerViewed` and
`bookerReady`** (Dan, 2026-10-15), since GA4 counts a booker view once per visit and a
page with both pieces holds two frames, plus a third when a pop up opens. The Call me
now piece and the pop ups a piece opens announce neither; `linkFailed` and the booking
events are announced from wherever they happen.

`readInlineEntry` (`src/lib/embed/inline-entry.ts`) reads all of these, for `/book`
and `/demo` alike. A link starting `demo?` is drawn from `/demo` (the test calendar, a
made up lead, a Call me now that calls nobody); `/demo/pieces` places both pieces that
way, and `/demo` may be framed by Slate's own pages only (`frame-ancestors 'self'`).

## Testing the embed from an approved host page (#2660, #2666)

Slate has no staging deployment, so a partner testing the embed from THEIR staging
site used to have one path: book a real advisor, with a real invite, a real text
from Regal, and a cancel by hand afterwards. The public test bucket is the safe
path. Open the embed exactly as a real page does, with the bucket code `PARTNER`:

```html
<button data-cal-link="router?form=review&xbc=PARTNER" data-cal-namespace="review">Book a call</button>
```

or `/book?xbc=PARTNER&embed=1&parentOrigin=<your origin>` directly. No key is
needed, but **it works only from a website listed in `EMBED_TEST_ORIGINS`**
(#2666; `wrangler.jsonc`, today `https://dev.trypennie.com` and
`https://trypennie.com`, never `localhost`). It no longer works from any host page,
which is what #2660 first shipped:

- `/book` reads the Referer of the iframe's OWN document request and compares its
  origin with the list by exact equality. A website not on it, a request with no
  Referer, an empty list, or a deployment with no `EMBED_TEST_PASS_SECRET` gets a
  page saying test bookings are not available there and why, in
  `TEST_ACCESS_COPY` (`src/lib/booking/booker-copy.ts`), never a booker.
- On a match, `/book` hands the Booker a **pass**: an HMAC over the code and an
  expiry, good for `TEST_PASS_TTL_MS` (30 minutes, `src/lib/embed/test-pass.ts`).
  The Booker sends it on every read of the times and on the confirm, and each of
  those routes refuses the test bucket without a good one (403 with a
  `TEST_PASS_*` code). A modal left open past the expiry is told to reload.
- **The Referer check is a convenience gate, not authentication**: anything that
  is not a browser can send any Referer. It keeps the test path off websites
  nobody approved. To test from a new website, ask for its exact origin to be
  added to the list.

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

**Never test on a real bucket code instead (#2760).** A test on a real code is a
real lead to the monitors: from trypennie.com or with no host page it can un-park
the below tier check and page (#2737), the failure rate watch counts it (#2513),
and from any other host it pages `booking_offsite_origin`. When a test genuinely
has to reach a real advisor, use the bucket with the most advisors, never a one
person pool, and cancel it once done: `docs/smoke-test-runbook.md` has the rule
and what it costs.

---

## brandColor behavior (D14)

KEEP the override knob (preserves cal.com parity). The embed **explicitly passes
Pennie's sky through as the default** `brandColor`; a host page may still override
it via `ui.brandColor`. It is NOT sky-only-ignore. The brand color tints the
Booker's dots / selected-ring / confirm / avatar (inline, since the hex is dynamic).

**Host colours on the inline card, and the contrast refusal (#3718).** A host
passes cal.com's `cssVarsPerTheme` in its `ui` call; widget.js forwards the
entry for the theme the booker draws in: `cal-brand` as `brand` (it wins over
the single `brandColor`, as on cal.com) and `cal-bg` as `bg`, the inline card's
background. `/book` reads `bg` only on the inline card. Every booker page reads
`brand` through `readHostColours` (`src/lib/embed/host-colours.ts`), which keeps
a colour only when graphite or beige text on it reaches 4.5:1 and uses the better
one as the text colour. A colour that fails, or is not `#rgb` / `#rrggbb`, is
refused: Slate keeps its own default and logs
`tag=host-colours msg="host colour refused"` with the page, the colour and why.
The card paints its background and that text colour only on what sits directly
on it (the title and the line under the Call me now confirmation); the panels
keep their own surface. trypennie's pop up sends `#000000`, which reads at
18:1, so the rule changes nothing live.

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

## Modal a11y (host-side chrome)

All of this is in `widget.js` now; keep every item when touching the chrome (the
iframe handles its own *internal* focus; the host side manages the modal shell).

- `role="dialog"` + `aria-modal="true"` + `aria-label` (e.g. "Book a call") on the modal.
- **Focus trap**: move focus into the modal on open; Tab cycles between the close
  button and the iframe, never escaping to the host page behind the scrim.
- **Focus restore**: store the trigger element (`el` from the delegated click) on
  every open, not only the first, since two buttons can share one namespace and
  link and the frame is kept between them (#2678); restore focus to it on close.
- **A hidden frame is out of the tree**: the kept overlay carries
  `aria-hidden="true"` and `inert` (where supported) on top of `display:none`
  while closed, and loses all three when shown, so a screen reader never lands
  in a booker nobody opened and Tab never reaches its iframe.
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
- **postMessage is origin bound on both ends; do not loosen it while restyling** (#593, #2641, #2674).
  The Booker posts only to the origin `embedParentOrigin` resolves (the host's
  `parentOrigin`, falling back to `document.referrer`'s origin) and SKIPS the post
  when neither yields a real origin, never `"*"`, because `slate:bookingSuccessful`
  carries lead data. `widget.js` accepts a message only when
  `e.source === activeIframe.contentWindow`, on every branch, the lifecycle
  messages included (#2658). A host passing the wrong `parentOrigin` sees nothing
  in the browser, which is why the Booker reports a mismatch through
  `/api/client-errors` (see the postMessage contract above). This pitfall used to
  say the origin was `"*"` and unchecked, left for a hardening pass; that pass
  shipped in #593, so do not plan it again.

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
   Then close and click the trigger again: the same iframe comes back with the
   day and time still chosen, and the host's `*` listener shows exactly
   `navigatedToBooker` and `bookerReopened` for the reopen (#2678).
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
- `src/app/book/page.tsx` -- reads `embed`/`theme`/`brand`/`xbc`/`external_id`, keeps every other param (`submissionId`, `regalProfileId`, ...) in `prefill`; theme default to flip to light.
- `src/components/Booker.tsx` -- `PALETTE` light/dark, `brandColor` inline overrides, `slate:resize` ResizeObserver, `slate:bookingSuccessful`, `embedded` flag, confirmation screen.
- DISCOVERY: `.claude/orchestration-slate-brand-redesign/DISCOVERY.md` (D14/D15/D16).
- Research: `.claude/orchestration-slate-brand-redesign/research/embed-css-isolation.md`.
