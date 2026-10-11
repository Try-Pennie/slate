-- #3615: record WHAT a demotion changed on the sweep that moved the calls.
--
-- A demotion sweep (0178) moves the calls an agent can no longer serve after Twilio narrowed
-- their debt tiers or backend. The audit row for each move, and the admin screen that offers to
-- undo it, have to say what changed: "ultra_high and high to high only". By the time the sweep
-- runs (a sync at least the 30 minute debounce after the stamp) the agent's stored attributes
-- already hold the NARROWED values, so the stamp now saves the values held before, in the same
-- write as the mark, and the sweep copies both onto its job here, at the moment it decides to
-- move anybody.
--
-- jsonb holding { "from": { "debtTeam": [...], "backendService": [...] },
--                 "to":   { "debtTeam": [...], "backendService": [...] } }.
-- Nullable: NULL for every sweep that is not a demotion, and for a demotion stamped before this
-- change, which saved nothing; that reads as "not recorded" rather than inventing a before.
-- Additive only, so the code already deployed keeps working against it.
alter table bulk_reassign_jobs
  add column demotion_change jsonb;

comment on column bulk_reassign_jobs.demotion_change is
  'What the Twilio demotion behind this sweep changed (#3615): the debt tiers and backend the agent held before (saved with the demotion mark) and the ones the sweep acted on. NULL for any other sweep, or for a demotion whose earlier tiers were never saved.';
