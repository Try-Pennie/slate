-- #319: refund a per-IP rate-limit hit when the booking failed due to a
-- verify-on-book OUTAGE (a server fault, not customer behavior). The limiter
-- counts every attempt up front (rate_limit_hit, 0024); on a 503 outage the
-- booking route gives that hit back so an outage can't burn the lead's booking
-- budget and lock them out after it clears. Atomic decrement, floored at 0 so a
-- refund can never push the counter negative; window untouched (a stale window
-- already holds a small count, so decrementing is harmless).
create or replace function rate_limit_refund(p_key text)
returns void
language sql
security definer
set search_path = public
as $$
  update rate_limits
  set count = greatest(count - 1, 0)
  where key = p_key;
$$;

-- Deny-all by default; only the secret-key server client may call it.
revoke execute on function rate_limit_refund(text) from public, anon, authenticated;
