-- Google profile picture URL, captured from the OAuth metadata at login. Used
-- for the account avatar (falls back to initials when absent).
alter table users add column avatar_url text;
