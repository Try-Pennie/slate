-- Replace a bucket's manual members in ONE transaction (#1930, #1934).
--
-- `replaceBucketMembers` deleted every row for a bucket and then inserted the new
-- ones as two separate statements, binding neither error. So a failed insert, or
-- an isolate evicted between the two, left the bucket with NO manual members
-- while the action returned normally and the page redrew as saved. A routing pool
-- with nobody in it turns every matching lead away, and nothing said so.
--
-- Exactly the shape migration 0097 exists for on availability rules, and the same
-- answer: ordering in application code cannot close that window, one function
-- can, because a plpgsql body commits or rolls back as a whole.
--
-- THE ONE DELIBERATE DIFFERENCE FROM 0097: an EMPTY set is legitimate here and is
-- NOT refused. 0097 refuses one because an agent with no rules is silently
-- unbookable, so clearing it can only ever be a mistake. A bucket with no manual
-- members is an ordinary, working configuration: it routes by attribute criteria
-- instead, which is how most of the XBC matrix is meant to work. Refusing an
-- empty set here would block the normal case, and a guard may only refuse what
-- the system genuinely cannot do.
--
-- DISTINCT, because `bucket_members` carries `unique (bucket_id, user_id)`: the
-- same id twice in one submission would abort the whole insert and, before this
-- function, would have aborted it AFTER the delete had already committed. The
-- form can post a repeat when a membership is both matched from the roster and
-- carried over as an off-roster id (#1762), so this is reachable rather than
-- theoretical.
--
-- It returns the count actually present, so the caller can refuse to claim
-- success on a number it did not ask for, never on the mere absence of an error.
--
-- search_path is pinned per the repo rule. Everything it touches is in `public`
-- and `unnest` is a pg_catalog built-in, so a pinned path can still reach it.
create or replace function replace_bucket_members(
  p_bucket_id uuid,
  p_user_ids  uuid[]
) returns integer
language plpgsql
security invoker
set search_path = public, pg_catalog
as $$
declare
  v_written integer;
begin
  delete from bucket_members where bucket_id = p_bucket_id;

  if p_user_ids is not null and array_length(p_user_ids, 1) > 0 then
    insert into bucket_members (bucket_id, user_id)
    select distinct p_bucket_id, u
    from unnest(p_user_ids) as u;
  end if;

  select count(*) into v_written from bucket_members where bucket_id = p_bucket_id;
  return v_written;
end;
$$;
