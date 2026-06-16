-- Remember where each request's Slack manager notification was posted (DM or
-- fallback channel), so approve / reject / cancel can edit that same message to
-- mirror the request's status instead of leaving a stale "pending" notice.
alter table ooo_requests
  add column slack_channel text,
  add column slack_ts text;
