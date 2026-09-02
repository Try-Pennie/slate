-- #1663: make one person unable to become two rows by changing the case of their
-- address.
--
-- `users.email` is unique but CASE SENSITIVE, and Google addresses are effectively
-- case insensitive, so the same person can arrive under two spellings. A row
-- synced from Salesforce as Agent@trypennie.com and a login arriving as
-- agent@trypennie.com would:
--
--   1. miss provisionUser's by-email read, so provisioning treats them as new; and
--   2. pass users_email_key, because the two strings genuinely differ.
--
-- The result is one person with two identities. The roster, the bookable pool, the
-- manager link and every per agent count can each resolve to a different half, and
-- the halves never converge. #1648 does NOT stop it: that closed the transient read
-- failure and the concurrent login race, both of which are about a read returning
-- nothing when it should have returned something. This is a read that correctly
-- returns nothing, because it was asked the wrong question.
--
-- THE DECISION, stated rather than left to fall out of this file: Slate STORES the
-- normalised address. The alternative, storing whatever case arrived and comparing
-- on lower(email), keeps the display casing but makes every one of the dozens of
-- existing `.eq("email", ...)` readers individually responsible for remembering,
-- and the one that forgets fails silently by finding nothing. Storing loses casing
-- that is not worth having on a work address (the display name is users.name).
--
-- Normalising at only ONE writer would turn a silent duplicate into a hard failure
-- at login, so all three go through src/lib/auth/email.ts in the same change:
-- provisionUser, the Salesforce roster sync, and the team access grant.
-- scripts/test-email-normalization.ts keeps them there, so this index stays a
-- backstop rather than becoming the mechanism.
--
-- users_email_key is NOT replaced by this and stays useful: it is what makes an
-- exact duplicate a lost race rather than a second row, which provisionUser
-- already resolves by re-reading the winner.
--
-- MEASURED against production on 2026-09-02 before writing this: 138 users rows, 0
-- with an address differing from its lower case form, and 0 lower case values held
-- by more than one row. So the update below touches nothing today and the index
-- applies with no violation. It is written anyway rather than skipped, because a
-- migration that only works on the data that happened to exist the day it was
-- written is not a migration.

-- Any row stored in mixed case, normalised so the stored value and the value every
-- writer now produces are the same thing. Reports its own row count.
do $$
declare
  touched integer;
begin
  update users set email = lower(email) where email <> lower(email);
  get diagnostics touched = row_count;
  raise notice 'users rows normalised to lower case: %', touched;
end $$;

-- The backstop. Two spellings of one address can no longer both exist, whatever
-- writes them, including a hand written INSERT that never sees the TypeScript.
create unique index if not exists users_email_lower_idx on users (lower(email));

comment on index users_email_lower_idx is
  'One row per address, case insensitively (#1663). Slate stores the normalised form via src/lib/auth/email.ts; this refuses a writer that did not.';
