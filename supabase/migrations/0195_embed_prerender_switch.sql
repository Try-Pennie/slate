-- #3706: the switch for building Slate's booker as a partner page loads.
--
-- A host page calls the embed's `prerender` command at page load, the way it does for
-- cal.com, and widget.js builds the booker frame hidden then, so the lead's first click
-- shows times that have already loaded. Whether Slate honours that call is Slate's own
-- decision (Dan, 2026-10-20), made on the admin Embedding page with no deploy: widget.js
-- asks `GET /api/embed/config` and builds the frame only when it answers true.
--
-- NOT NULL DEFAULT false, so a settings row that predates this column, and a database
-- where nobody ever pressed the switch, leave the prerender a no op exactly as before
-- (L72): the click builds the booker, as it always has.
alter table booking_settings
  add column embed_prerender_enabled boolean not null default false;

comment on column booking_settings.embed_prerender_enabled is
  'The #3706 prerender switch. True lets widget.js build the booker frame, hidden, when the host page calls prerender at page load, so the first click only shows it. Read by GET /api/embed/config through a 15 second per isolate cache; a failed read answers false. NOT NULL DEFAULT false: off until an admin turns it on, and a prerender is then a no op as before.';
