-- #3718: the texting line each lead was given after pressing Call me now.
--
-- Pennie's automations service hands out a different line on every ask (measured
-- 2026-10-15: six asks for one lead, six lines), and Dan's rule is that the same lead
-- sees the same line every time unless that line no longer exists. So Slate keeps the
-- line it gave, and replaces it only when Sendblue says the line is gone
-- (src/lib/automations/lead-texting-line.ts).
--
-- One row per lead, keyed on the first 15 characters of the Salesforce Lead id, which a
-- 15 and an 18 character id for the same lead share, so the primary key is what makes
-- two presses at once end on one line: the first insert wins and the second reads it.
-- The line is Pennie's own Sendblue number, never the lead's contact details.
--
-- One row per lead who ever pressed Call me now on the inline card, which is a small
-- share of leads; read and written only by the primary key.

create table lead_texting_lines (
  lead_key     text        primary key check (lead_key ~ '^00Q[A-Za-z0-9]{12}$'),
  line         text        not null check (line ~ '^\+[1-9][0-9]{7,14}$'),
  given_at     timestamptz not null default now(),
  replaced_at  timestamptz
);

alter table lead_texting_lines enable row level security;

comment on table lead_texting_lines is
  'The #3718 texting line per lead for the Call me now confirmation: the Sendblue line Slate gave the lead, reused on every later press until Sendblue reports it dead, then replaced (replaced_at). Keyed on the 15 character Lead id. Written and read by /api/call-me-now only.';
