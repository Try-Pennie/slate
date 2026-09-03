# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Two first-class audiences, with **no standing ranking between them** (Dan, 2026-09-03). A change that helps one and hurts the other needs an explicit decision each time; there is deliberately no default winner to fall back on.

**Leads**, in the embedded booker on Pennie's landing pages. They have just engaged with a debt relief offer and are booking a call, often on a phone, inside the same session. They are **warm but apprehensive** (Dan, 2026-09-03): willing to book, and uneasy about the conversation itself rather than about the calendar. The hard part for them is agreeing to talk to a stranger about their debt, not picking a time.

**Internal staff**, in the admin and self service screens. Three roles with ascending rights, enforced server side: agents (their own working hours and time off), managers (approve their team's time off, see their team), admins (roster, buckets, routing, business hours, monitoring). About 136 people on the roster today, roughly 103 bookable; the design target is 100 to 200.

## Product Purpose

Slate is Pennie's booking layer, replacing cal.com. It takes a lead from a landing page to a booked call with the right agent, keeps Google Calendar in sync in both directions, and tells the downstream systems the booking happened.

Success is a booked call the lead actually **attends**, not merely a booking created. The show rate framing comes from the project's own booking domain work rather than from this interview, so treat it as the recorded goal and confirm it before building anything that trades bookings for attendance.

## Positioning

Slate is not a general scheduling tool that happens to serve Pennie. It is Pennie's **routing** layer that happens to book, and two mechanisms are the reason it exists rather than a cal.com configuration:

**Routing by the XBC contract.** A three digit code selects one of about 60 buckets across debt tier, backend service and legal status, with round robin inside a bucket and a tier drop ladder as fallback. A neighbouring scheduling product cannot copy this because the codes are Pennie's own routing vocabulary, shared with Salesforce and the landing pages.

**Cache first availability.** The booker reads a precomputed index rather than a live calendar, which is why it answers in roughly 39ms warm where cal.com took about 8.8 seconds, and it still verifies the chosen agent against live Google at confirm time so the speed costs no correctness.

## Operating Context

The booker is embedded through `widget.js` on Pennie landing pages as a drop in replacement for the cal.com embed, so the URL contract is a hard constraint rather than an implementation detail.

**A parallel run is in progress.** cal.com still takes every real lead. Slate's roster was flipped bookable on 2026-09-02 and computes availability nobody can book yet. Cutover is tracked as its own milestone. So Slate is live, correct, and carrying no real traffic, which is the single most important fact about evaluating it right now.

Salesforce owns the roster and the manager of record; Slate syncs hourly and never writes back, so anything editable in Slate that Salesforce also owns will silently revert.

Google Workspace supplies calendars through domain wide delegation, scoped to Calendar and gmail.send **only**. There is no directory scope, which is why Slate cannot confirm that an address exists and cannot fetch a profile photo for anybody who has not signed in themselves. Alerts go to Slack, history to Snowflake, and the whole thing runs on Cloudflare Workers.

**How work arrives.** Dan does not write code and does not live in the terminal; all code is written by Claude. He reviews rendered screens and answers structured choices, so a design proposal reaches him as a picture or a picker, not as a diff. Two commands exist so copy can be read before it ships: `pnpm preview:alerts` and `pnpm preview:booker`.

## Capabilities and Constraints

A bookable time passes three gates in one shared predicate: the organisation's business hours, then the agent's working hours, then their calendar. Each hour window is judged in its own timezone and the two are never intersected.

**The roster is not all Eastern.** It spans seven timezones, with 27 people in Phoenix and 16 in Los Angeles, so any timezone mistake is visible in production data rather than theoretical.

Debt teams are an ordered five rung ladder (low, medium, high, very high, ultra high) whose human labels already exist in the codebase. The stored data also holds values outside that ladder, so anything keyed on the five rungs needs an honest path for the rest rather than dropping them.

Access is default deny at the database as well as in code. Impersonation ("view as") exists for admins with a role ceiling, and it is the most consequential action in the internal product.

Explicitly undecided: the cutover date; whether split opening hours are wanted for the organisation (split shifts for agents are being built, the organisation side is deferred because the org path reads one window per day).

## Brand Commitments

The **Pennie Design System**, exported at `~/Documents/Pennie Branding/Pennie Design System/`. That export is the source of truth and supersedes any older markdown description of the brand.

Colour runs 80/15/5: beige and white surfaces dominate, navy appears occasionally as a band, graphite carries text. **Sky is the only action colour.** Yellow, mint and peach are illustration accents and never calls to action. No hard black anywhere, including shadows; errors use a muted rose.

Type is PP Mori only, at weights 200, 400 and 600. Body is 400 and headings are 600, never 700 or 800. Rates, payments and statistics use tabular numerals.

Shape: buttons and cards at 16px, large bands 24px, chips 4px, and fully rounded pills reserved for badges.

Voice is warm, plain and optimistic: a financial **partner**, not a bank. Buttons are verb phrases ("View my offers", "Continue", never "Submit"). Rates are always disclosed and never guaranteed, so the language is "may", "up to", "based on eligibility".

Two rules bind every piece of output, not just the interface: **no dashes used as punctuation** anywhere, and no emoji in user facing copy or alerts.

**Pennie is a lending marketplace.** It is not the Pennsylvania health insurance site of a similar name. Confusing the two is a factual error about the company, so it is a binding constraint rather than a style note.

The consumer booker defaults to beige and light, and an embed host may override it to dark, so both themes are maintained. The internal screens support light and dark.

## Evidence on Hand

The exported design system on disk, above, holds the real tokens and assets. Real roster data exists: 136 agents, about 103 bookable, seven timezones. The availability performance figures above are measured, not estimated.

**There is no real booking traffic through Slate and no funnel data**, because cal.com is still taking every lead during the parallel run. Nothing may invent conversion rates, show rates, drop off points or lead quotes, and any design argument resting on lead behaviour has to say it is a hypothesis.

## Product Principles

**Neither audience wins by default.** A decision that helps a lead and costs staff, or the reverse, is argued and recorded rather than resolved by a standing rule.

**In the booker, speed and reassurance pull against each other.** The lead is warm enough to book and anxious enough to need a reason to trust it, so every added step or sentence argues its case against bounce risk. Neither "make it shorter" nor "explain more" is automatically right.

**An empty state, an error state and a could not measure state are three different screens.** This is the product's most repeated failure, and it is a product rule rather than an engineering detail: a reassuring blank is worse than a refusal.

**A number or label may claim only what its check actually measured.** Copy that overstates what was verified is a defect even when the value is correct.

**A time taking action shows started, still alive, and failed as three distinguishable things.** A control that looks the same whether the work is running, hung or dead is not finished.

## Accessibility & Inclusion

WCAG 2.1 AA, with extra care beyond it: a visible sky focus ring, full keyboard navigation, `prefers-reduced-motion` honoured, colour never the sole signal, and targets of 44px or more.

Contrast is **verified rather than asserted**, and recent evidence says that matters here: 25 focus rings shipped drawing at about 1.57:1 against a 3:1 requirement, which is the failure nobody reports because the people who depend on it are the only ones who would notice.
