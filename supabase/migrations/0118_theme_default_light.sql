-- #2100: light is the product's answer to "what theme do I get", rather than
-- whatever each person's operating system is set to.
--
-- Decided by Dan on 2026-09-08 while walking /me. `system` stays a choice
-- anybody can make; it stops being the one made for them.
--
-- THE EXISTING ROWS MOVE TOO, and that is a decision rather than a cleanup.
-- Measured the same day: 145 rows held `system`, 2 held `light`, 1 held `dark`.
-- Nothing records whether a `system` row was ever chosen or merely seeded, so a
-- deliberate choice and an untouched default are the same value (the same shape
-- as the seeded working hours in #1753). Two people had set a real preference,
-- which is why only `system` moves and the 3 explicit rows are left exactly as
-- they are.
--
-- It has to happen HERE, in the same change as the default, and not later: after
-- this ships, a `system` row can only mean somebody chose it, so the window in
-- which this move is safe closes the moment the control starts working properly
-- (which is the rest of #2100).
--
-- `users` is not a Snowflake mirrored table, so there is no export cursor to
-- rewind for the rows this touches.
alter table public.users
  alter column theme_preference set default 'light';

do $$
declare
  v_moved integer;
begin
  update public.users
     set theme_preference = 'light'
   where theme_preference = 'system';

  get diagnostics v_moved = row_count;

  -- Never a bare "done": say what actually landed, so a migration that moved
  -- nothing is distinguishable from one that moved the roster.
  raise notice '#2100: moved % user(s) from the seeded system default to light', v_moved;
end;
$$;

comment on column public.users.theme_preference is
  '#2100: system | light | dark. Defaults to light; system follows the device and is a deliberate choice, not the fallback.';
