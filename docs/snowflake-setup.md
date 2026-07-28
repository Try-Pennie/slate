# Snowflake mirror: one-time provisioning runbook

This is the manual, copy-paste-once setup for the Slate archival mirror
(milestone #15, discussion #1095). It provisions the Snowflake side and sets the
Worker config so the export lane (Phase 3) can authenticate. Do this once, before
the export lane ships. The SQL companion is `docs/snowflake-setup.sql`.

Roles: **Dan runs the numbered steps** (they need your Snowflake ACCOUNTADMIN and
your Cloudflare/wrangler login). Claude prepared the SQL and this runbook.

## What gets created

| Object | Name | Purpose |
|--------|------|---------|
| Warehouse | `SLATE_WH` | XS, auto-suspends after 60s idle. |
| Database | `SLATE` | Holds the mirror. |
| Schema | `SLATE.PUBLIC` | The six mirror tables. |
| Role | `SLATE_ROLE` | SELECT + INSERT + UPDATE, **no DELETE** (append-only writer). |
| Service user | `SLATE_SERVICE` | Key-pair auth, no password. |

DSR erasure (the only path that removes warehouse rows) is provisioned later, in
the Phase 7 runbook, as a separate privileged operator step. There is deliberately
no standing DELETE credential on the Worker.

## Worker config it produces

One secret and six non-secret vars:

- **Secret** (`wrangler secret put`): `SNOWFLAKE_PRIVATE_KEY` (the RSA private key).
- **Vars** (`wrangler.jsonc` under `vars`, not sensitive): `SNOWFLAKE_ACCOUNT`,
  `SNOWFLAKE_USER`, `SNOWFLAKE_DATABASE`, `SNOWFLAKE_SCHEMA`, `SNOWFLAKE_WAREHOUSE`,
  `SNOWFLAKE_ROLE`.

While `SNOWFLAKE_PRIVATE_KEY` is unset, the export lane is a safe no-op (it logs
"not configured" and skips), so shipping the code before this runbook is done does
no harm.

---

## Step 1: Generate the RSA key-pair

Run these in a scratch directory OUTSIDE the Slate repo (the private key must
never be committed). This makes an unencrypted 2048-bit PKCS#8 key-pair, the
format the Worker's JWT signer expects.

Make and enter a scratch dir:

```bash
mkdir -p ~/snowflake-slate-keys && cd ~/snowflake-slate-keys
```

Generate the private key:

```bash
openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 -out slate_snowflake_key.p8
```

Derive the public key:

```bash
openssl rsa -in slate_snowflake_key.p8 -pubout -out slate_snowflake_key.pub
```

## Step 2: Create the Snowflake objects

Open `docs/snowflake-setup.sql` in a Snowsight worksheet, set the role to
ACCOUNTADMIN, and run the whole script. It is idempotent (safe to re-run) and
runs cleanly on every Snowflake edition. It ends with one OPTIONAL hardening line
(`ALTER USER SLATE_SERVICE SET TYPE = SERVICE`) that locks the service user to
key-pair only: run it if your edition accepts it, and skip it if it errors (the
key-pair login already works either way).

**Re-run it after any change to the mirror columns.** The CREATE TABLE statements
are all IF NOT EXISTS, so on an already-provisioned warehouse they do nothing;
the `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` block near the end is what
actually adds a column introduced later. This matters for `exported_at`, the
warehouse load stamp the export MERGE writes on every row (#1116): a mirror table
missing that column fails 100% of its exports. To confirm the live warehouse is
in shape, hit `/api/admin/snowflake-check` as an admin. It returns 200 when the
login works and every mirror table has the stamp, and 503 naming the tables that
do not.

You do **not** have to remember to click it. Since #1144 the same check also runs
at the tail of the 6-hourly `snowflake-reconcile` lane: it Slack-alerts when the
probe fails and stamps a `snowflake-check` heartbeat only when the probe passes, so
a check that stops succeeding pages within 8 hours even if the alert itself cannot
get through. The admin page is now for on-demand confirmation during setup, not the
only thing standing between a broken warehouse statement and production. Before that
it was: #1143 was a SQL compilation error that broke every retention verification
and was found only because someone happened to open the page.

Beyond the login and the load stamp, the probe runs the two statements that a unit
test cannot prove, because every unit test of them answers with a stand-in: the
archive-verification question the retention lanes gate on, and the repair MERGE they
call to make an unconfirmed row verifiable. Both run against a booking the warehouse
was just confirmed to hold, so the repair takes its MATCHED branch and writes nothing
new.

## Step 3: Register the public key on the service user

Print the public key body as a single line (no header/footer, no line breaks):

```bash
grep -v 'PUBLIC KEY' ~/snowflake-slate-keys/slate_snowflake_key.pub | tr -d '\n' && echo
```

Copy that output, then run this in Snowsight (paste it in place of the placeholder):

```sql
ALTER USER SLATE_SERVICE SET RSA_PUBLIC_KEY = 'PASTE_PUBLIC_KEY_BODY_HERE';
```

## Step 4: Find your account identifier

The Worker needs the account URL prefix (locator plus region), for example
`ab12345.us-east-1`. In Snowsight run:

```sql
SELECT CURRENT_ORGANIZATION_NAME(), CURRENT_ACCOUNT_NAME(), CURRENT_REGION();
```

If unsure of the exact URL form, open Snowsight, click your account (bottom left),
"View account details", and copy the account identifier from the account URL. It
is the part before `.snowflakecomputing.com`.

## Step 5: Set the six non-secret vars in wrangler.jsonc

These are committed config, not secrets. Claude will open a PR that adds them to
`wrangler.jsonc` with placeholder values; you confirm the values are:

```
SNOWFLAKE_ACCOUNT   = <account identifier: the host prefix from SYSTEM$ALLOWLIST(), e.g. the regionless orgname-accountname>
SNOWFLAKE_USER      = SLATE_SERVICE
SNOWFLAKE_DATABASE  = SLATE
SNOWFLAKE_SCHEMA    = PUBLIC
SNOWFLAKE_WAREHOUSE = SLATE_WH
SNOWFLAKE_ROLE      = SLATE_ROLE
```

## Step 6: Set the private-key secret on the Worker

From the Slate repo, with your wrangler login active, feed the key file straight
into the secret. Do NOT paste the key at the interactive prompt: the key has
multiple lines, and an interactive paste stops at the first line break, storing a
broken key and spilling the rest into your shell.

```bash
cd ~/Documents/Slate && wrangler secret put SNOWFLAKE_PRIVATE_KEY < ~/snowflake-slate-keys/slate_snowflake_key.p8
```

That uploads the entire multi-line key as one value. (For local development, put
the same key in `.env.local` as `SNOWFLAKE_PRIVATE_KEY`, with the newlines written
as literal `\n` on one line, matching how `GOOGLE_SA_PRIVATE_KEY` is stored. The
Worker reads either real newlines or literal `\n`.)

## Step 7: Delete the local key files

The private key now lives only in the Worker secret (and your `.env.local` if you
set it). Remove the scratch copies:

```bash
rm -rf ~/snowflake-slate-keys
```

## Step 8: Verify

Confirm the vars shipped and the secret is set:

```bash
wrangler secret list
```

`SNOWFLAKE_PRIVATE_KEY` should appear. Once the Phase 3 export lane is deployed,
its first successful tick (and the Phase 5 reconciliation) confirm the key,
account, and grants all line up end to end.

---

## Rotating the key later

Re-run Step 1 (new pair), Step 3 (`ALTER USER ... SET RSA_PUBLIC_KEY`, which
replaces the old one), and Step 6 (`wrangler secret put SNOWFLAKE_PRIVATE_KEY`).
Snowflake also supports `RSA_PUBLIC_KEY_2` for zero-downtime rotation if needed.
