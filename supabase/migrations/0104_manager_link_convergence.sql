-- #1474: correct the manager links Salesforce does not back, and make the worst
-- shape impossible.
--
-- The hourly Salesforce roster sync only ever ADDED a manager link. Nothing ever
-- set `manager_id` back to null when Salesforce stopped naming a manager, so a
-- link written once (or written wrongly) survived forever and Slate's roster
-- silently diverged from the source it mirrors. That matters beyond tidiness:
-- `manager_id` decides who a time off request is routed to and who may approve it,
-- so a stale link sends someone's request to the wrong person's Slack and hands
-- them the decision.
--
-- The code change makes the sync converge. It cannot fix the two live rows,
-- because NEITHER user carries a debt-team flag, so neither appears in the SOQL
-- the sync runs and the sync has never seen them at all. A fix keyed on being in
-- that query leaves exactly the rows that lack the key still broken (L92), so the
-- correction is here.
--
-- Verified against Salesforce on 2026-08-14 before writing this, not assumed:
--   bflanagan@trypennie.com  Agent_Manager__c = 'Matthew Jamele'   (correct)
--   mjamele@trypennie.com    Agent_Manager__c = null
--   dwright@trypennie.com    Agent_Manager__c = null
-- Slate held mjamele -> bflanagan, the exact reverse of Salesforce (so the two
-- pointed at each other, and an agent was the approver for a manager's time off),
-- and dwright -> dwright.

-- 1. A row can never again be its own manager.
--
-- A constraint rather than a check in application code, because this shape cannot
-- have come from the sync (which has always skipped agentId === managerId) or from
-- the admin action (which has always thrown on it), and yet one existed. Whatever
-- wrote it is not a code path anybody can point at, so the guarantee belongs where
-- no code path can get around it.
alter table users
  drop constraint if exists users_manager_not_self;

-- Clear the self links FIRST: the constraint below is validated against existing
-- rows and would refuse to be added while one is present.
update users set manager_id = null where manager_id = id;

alter table users
  add constraint users_manager_not_self check (manager_id is null or manager_id <> id);

-- 2. Clear the one remaining link Salesforce contradicts.
--
-- Scoped to the single email and to the exact wrong value, so re-running this
-- migration cannot clear a link that has since been set correctly, and so it is a
-- no-op the moment the data is right. Not a blanket "clear every link Salesforce
-- does not back": that judgement needs the live Salesforce read, which is the
-- sync's job and not a migration's.
update users u
set manager_id = null
where u.email = 'mjamele@trypennie.com'
  and u.manager_id = (select id from users where email = 'bflanagan@trypennie.com');

-- Consequence, stated rather than discovered later: mjamele now has no manager of
-- record, so his time off is approved by team leads and up through the
-- NO_MANAGER_MESSAGE path, instead of by one of the agents who reports to him.
