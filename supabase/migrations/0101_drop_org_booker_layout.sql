-- #1416: drop the booker's month grid layout switch.
--
-- `organizations.booker_layout` selected between two date pickers in the booker.
-- Only the exact string 'month' chose the grid; everything else fell back to the
-- day strip. Measured against production on 2026-08-12: one organization, set to
-- 'strip'. The grid was never reachable by a lead, and it was a second fully
-- maintained surface shipping in every lead's bundle.
--
-- The code that read this column goes in the same change, so the column is left
-- with no reader (L46). No data is preserved because every row holds the default,
-- and git holds the layout itself if it is ever wanted back.
alter table public.organizations
  drop column if exists booker_layout;
