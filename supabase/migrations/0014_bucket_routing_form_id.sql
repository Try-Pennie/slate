-- Optional mapping from a cal.com routing-form UUID to a Slate bucket, so the
-- existing trypennie `router?form=<UUID>` embed links can resolve to a bucket
-- during the drop-in swap (see #15) without editing the site. Nullable and
-- informational; routing itself still works off the bucket `code` (xbc).
alter table buckets add column if not exists routing_form_id text;
