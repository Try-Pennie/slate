-- #1587: the Slate half of the shared cross system rep key (PET half:
-- project-enrollment-tracker#1105 / PR #1107).
--
-- Slate identifies a rep by EMAIL, and resolves their manager by matching the
-- Agent_Manager__c picklist NAME. Both are values a person can change, so the two
-- pieces of work that must name a rep across a system boundary (#307's time off
-- feed to PET, #329's manager drift check) are betting on a string nobody promised
-- to keep stable, and Slate's own roster sync bets on email stability with no
-- fallback. A rename would not FAIL: it would quietly start naming somebody else,
-- or nobody, while every sync reported a healthy run.
--
-- Salesforce User.Id is the stable name. Nullable, because a roster row Salesforce
-- cannot resolve must be representable: a consumer then REFUSES (L75,
-- requireSalesforceUserId in src/lib/salesforce/user-id-link.ts) rather than
-- falling back to the email or the name, which is the substitution this column
-- exists to remove.
alter table users add column if not exists salesforce_user_id text;

comment on column users.salesforce_user_id is
  'Salesforce User.Id for this person, written by the hourly roster sync (#1587). Never cleared and never overwritten: a disagreement with Salesforce is reported, not rewritten. Null means unknown, and a consumer must refuse rather than fall back to an email or name match.';

-- Unique WHERE NOT NULL. One Salesforce User can back at most one Slate row, so a
-- second row claiming an id already held is refused by the database rather than
-- silently creating two Slate identities for one person. Partial, so the many rows
-- that legitimately hold NULL do not collide.
--
-- (Postgres treats NULLs as distinct in a plain unique index too, so the WHERE is
-- not strictly required for correctness. It is here because it makes the index
-- hold only the rows that carry a key, and because it states the rule the column
-- is under rather than leaving it to be inferred from NULL semantics.)
create unique index if not exists users_salesforce_user_id_key
  on users (salesforce_user_id)
  where salesforce_user_id is not null;

-- A Salesforce id is 15 or 18 characters of [a-zA-Z0-9]. The check is not
-- decoration: the failure this column is most likely to meet is somebody writing
-- the very value it replaces. An email or a person's name cannot satisfy this, so
-- the fallback the consumer contract forbids in code is also unrepresentable in
-- the data. A NULL passes, which is the "unknown" the contract is built around.
alter table users add constraint users_salesforce_user_id_shape
  check (
    salesforce_user_id is null
    or salesforce_user_id ~ '^[a-zA-Z0-9]{15,18}$'
  );
