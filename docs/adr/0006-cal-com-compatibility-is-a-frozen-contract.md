# The cal.com URL and embed contract is frozen

Slate's booking entry point (`/book?...`) and `widget.js` mirror the cal.com embed
they replaced, parameter for parameter. That shape is treated as a frozen external
contract rather than as Slate's own design.

## Status

Accepted. Recorded because "why does this route accept `attendeePhoneNumber` and
`smsReminderNumber`" has an answer that is nowhere in the repo (#1053).

## Why

Slate replaced cal.com underneath landing pages that were already live. Every one of
those pages, and every prefilled link already sent to a lead, carries cal.com's
parameter names. Being a drop-in replacement meant not touching them, which is what
let the migration happen without a coordinated change across every marketing surface
at once.

## What is frozen, and what is not

Frozen: the query parameter names the booking page accepts, the `widget.js` embed
API, and the manage link shape. These can be EXTENDED with new optional parameters;
they cannot be renamed or narrowed.

Not frozen: everything behind them. Routing, availability, the data model and the
internal APIs owe cal.com nothing, and Slate deliberately deviates where cal.com's
behaviour was the problem (see `docs/slate-vs-calcom.md`).

## Consequences

- Contact data arrives in the URL query string, which means it reaches Cloudflare's
  request log for its 7 day window. That is an accepted, documented position rather
  than an oversight, with the reasoning and what would change it in `docs/pii.md`.
- A prefill mechanism that avoided the URL (`postMessage`, `sessionStorage`) cannot
  replace the parameters, because the bare-link path has no host page to talk to.
- Renaming a parameter is a coordinated change with the landing pages, not a refactor.
