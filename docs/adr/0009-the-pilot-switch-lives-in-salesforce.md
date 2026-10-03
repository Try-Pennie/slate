# The pilot switch lives in Salesforce, and trypennie reads it

Which leads are booked through Slate rather than cal.com is decided on trypennie's
side, by `shouldUseSlate` (`src/utils/booking.ts` in Halo-lab-Trypennie/trypennie),
reading fields on the one `WebsiteConfiguration__c` record in Salesforce:
`SlatePilotActive__c` (the switch), `SlatePilotTiers__c` (which debt tiers) and
`SlatePilotPercent__c` (what share of those leads). Slate holds no copy of any of
them. Turning the pilot on, widening it, splitting it or turning it off is an edit
to that record, and no deploy on either side.

## Status

Accepted, and live since 2026-09-29 (#2508: "Ready to flip, 2026-09-29"). Backfilled
as a record in #3130: the decision lived across #2508, #2870, #2871 and the pilot
report docs, and nothing in this repo said why Slate has no setting for it.

## The decision, as it was made

The scope, Dan, 2026-09-29 (#2508): "the pilot starts on the two pages already
wired, `/booking/[SO_ID]` and `/my-offers/result`", superseding his 2026-09-25
decision that all Low pages flip at once, because the other surfaces could not load
Slate yet.

The principle the switch's shape follows was recorded on the trypennie side issues
the same day, in the issue text:

- #2870 (2026-09-29): every surface left on cal.com "is a deploy needed before the
  pilot can widen, which is the thing Dan wants to avoid: widening should be a
  Salesforce edit, never a code change."
- #2871: the pilot tier was a literal (`xbc?.startsWith('1')`), so "widening the
  pilot to Medium or any other tier needs Denys to edit and deploy, where Dan wants
  widening to be a switch." Its direction was to read the tiers from Salesforce
  beside `SlatePilotActive__c`, with "an empty or unreadable list means cal.com, so
  a misconfigured record fails toward the incumbent."

The per lead split followed in trypennie#517 (merged 2026-09-30): Low leads are
split by a hash of the submission id against `SlatePilotPercent__c`, with null
meaning 100 (`docs/pilot-split-report.md`).

## Why

Recorded above in the issues' own words: widening the pilot must not need anybody
to edit and deploy code, in either repo. The switch sits where trypennie already
reads its site configuration, so the page that chooses the booker reads it directly
and Slate is not on that path at all.

## What it costs

- **Salesforce keeps no history of these fields.** A report cannot ask what the
  switch said on a past day, so `pnpm report:pilot-compare` and the split report
  ASSUME the split held and print what Salesforce holds now, exiting on a current
  value that contradicts the assumption (`docs/pilot-compare-report.md`).
- **Slate cannot see the switch except by reading Salesforce.** The two pilot
  reports do so through `scripts/lib/pilot-settings-read.ts`, which refuses on any
  count of records but one.
- **It is not Slate's kill switch.** Unticking `SlatePilotActive__c` sends leads to
  cal.com. Stopping public booking in Slate (`booking_settings.public_booking_paused`,
  DEPLOY.md "Feature flags and the kill switch") refuses them on the Slate booker
  instead. They answer different incidents.

## What would change it

Cutover (#65), when cal.com is no longer the alternative and there is nothing left
to switch between, or a need to change the split faster or more finely than an edit
to one Salesforce record allows.

## Where the mechanics live

trypennie's `shouldUseSlate`; `scripts/lib/pilot-settings-read.ts`;
`docs/pilot-split-report.md` and `docs/pilot-compare-report.md`.
