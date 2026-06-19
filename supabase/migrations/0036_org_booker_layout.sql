-- Org-wide booker date-picker layout: 'strip' (default, next-few-days) or 'month'.
alter table organizations
  add column if not exists booker_layout text not null default 'strip';
