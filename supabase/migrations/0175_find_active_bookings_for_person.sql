-- A lead's active bookings in ONE call (#3476).
--
-- Every confirm's person check read the lead's active bookings with one PostgREST
-- request per signal: each strong id against external_id and again against
-- salesforce_id, the email, and the phone. A typical confirm sent four at once, and a
-- 100 confirm crowd about 400, and request COUNT is what queues in the API layer
-- (#3492). This answers every signal in one request, with the same rules:
--
--   - a strong id is matched against BOTH id columns (#2663);
--   - the email case insensitively, through ilike, with the caller's escaping
--     (`escapeLike`, #620) so an `_` or `%` in an address is a character, never a
--     wildcard; the trigram index on attendee_email serves it;
--   - the phone exactly, as E.164 (the caller normalises it);
--   - only confirmed and rescheduled bookings;
--   - at most 20 rows per signal, the bound each separate read had;
--   - only the world asked for (#2660): 'real' or 'test' by the booking's bucket, or
--     'both' for the lookup API, which reports each row's world. The world is NAMED,
--     never defaulted: a forgotten one must not read as every booking (L168).
--
-- Every value arrives as a PARAMETER, never as filter text: an id inside a PostgREST
-- `or` filter would be parsed as syntax, which is why the reads were separate.
--
-- WHAT IT ANSWERS: a jsonb array of bookings rows as to_jsonb renders them, each with
-- its bucket's world as is_test, read by `readPersonBookings`
-- (src/lib/booking/person-bookings-answer.ts). Proved against the old reads, signal by
-- signal, by scripts/verify-person-bookings-sql.ts.
--
-- SECURITY INVOKER: it reads with the caller's own rights, so it grants nothing the
-- caller could not already read. The server calls it with the secret key; execute is
-- still revoked from the web roles, so it is not a public endpoint at all.
create or replace function find_active_bookings_for_person(
  p_ids        text[],
  p_email_like text,
  p_phone      text,
  p_world      text
)
returns jsonb
language plpgsql
stable
security invoker
set search_path = public, pg_catalog
as $$
declare
  v_answer jsonb;
begin
  if p_world is null or p_world not in ('real', 'test', 'both') then
    raise exception 'find_active_bookings_for_person needs a world of real, test or both, not %', coalesce(p_world, 'none') using errcode = '22023';
  end if;

  with world as (
    select b.*
      from bookings b
      join buckets bu on bu.id = b.bucket_id
     where b.status in ('confirmed', 'rescheduled')
       and (p_world = 'both' or bu.is_test = (p_world = 'test'))
  ),
  hits as (
    select h.id
      from unnest(coalesce(p_ids, '{}'::text[])) as sid(v)
      cross join lateral (
        (select w.id from world w where w.external_id = sid.v limit 20)
        union
        (select w.id from world w where w.salesforce_id = sid.v limit 20)
      ) h
    union
    (select w.id from world w where p_email_like is not null and p_email_like <> '' and w.attendee_email ilike p_email_like limit 20)
    union
    (select w.id from world w where p_phone is not null and p_phone <> '' and w.attendee_phone = p_phone limit 20)
  )
  select coalesce(jsonb_agg(to_jsonb(b) || jsonb_build_object('is_test', bu.is_test) order by b.id), '[]'::jsonb)
    into v_answer
    from bookings b
    join buckets bu on bu.id = b.bucket_id
   where b.id in (select id from hits);

  return v_answer;
end;
$$;

comment on function find_active_bookings_for_person(text[], text, text, text) is
  'A lead''s active bookings for every signal at once (#3476): each strong id against external_id and salesforce_id, the email by escaped ilike, the phone exactly, at most 20 rows per signal, in the named world (real, test or both). Answers a jsonb array of bookings rows with is_test.';

revoke execute on function find_active_bookings_for_person(text[], text, text, text)
  from public, anon, authenticated;
