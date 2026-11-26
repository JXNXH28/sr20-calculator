# Accounts and tokens: setup

1 token = 1 calculation (a frozen snapshot of the form inputs). Re-running identical inputs is free. You invite users and grant tokens.

## 1. Create the Supabase project
- Create a project at supabase.com (free tier is fine). Note: free projects **pause after 7 days of inactivity**; unpause from the dashboard if that happens.

## 2. Create the database schema
- Dashboard -> SQL Editor -> paste all of `db/schema.sql` -> Run.
- **OFP builder** (`ofp.html`): the OFP section at the end of the file (tables `ofps`, `waypoints` and `ato_procedures`, `finalize_ofp`, `admin_upsert_procedure`, ledger reason `ofp`) is additive and idempotent. On an existing project, re-run the whole file to enable OFPs (3 tokens per flight); the T/O calculator is unaffected. Until it is applied, the admin page simply hides the OFP count and list.

## 3. Auth settings (Authentication)
- Sign In / Providers -> turn **off** "Allow new users to sign up". Invites still work.
- URL Configuration:
  - Site URL: your production URL.
  - Redirect URLs: `https://<production-domain>/login.html`, `https://*-<your-vercel-team>.vercel.app/login.html` (preview wildcard), `http://localhost:8765/login.html`.

## 4. Custom SMTP (needed for invites)
Supabase's built-in mailer is heavily rate-limited and meant for testing only.
- Create a free Resend account, verify your domain (or a sender), create an API key.
- Dashboard -> Authentication -> SMTP Settings -> enable custom SMTP:
  host `smtp.resend.com`, port `465`, user `resend`, password = the Resend API key, sender = a verified address.
- Authentication -> Email Templates -> **Invite user**: make sure the link uses `{{ .ConfirmationURL }}`.

## 5. JWT signing keys
The middleware verifies tokens against the project JWKS (`<SUPABASE_URL>/auth/v1/.well-known/jwks.json`), which needs an **asymmetric** signing key. In Dashboard -> Settings -> JWT Keys, if the project still uses the legacy HS256 secret, migrate to / rotate in the new asymmetric key (ECC P-256) and make it the active signing key.

## 6. Environment variables
Vercel -> Project -> Settings -> Environment Variables, for **Production and Preview**:
- `SUPABASE_URL` - project URL
- `SUPABASE_ANON_KEY` - the publishable (anon) key
- `SUPABASE_SERVICE_ROLE_KEY` - the secret key (server only; never expose to the browser)

Redeploy afterwards. For local dev, export the same three variables in your shell before `node server.js`.

## 7. First admin
1. Dashboard -> Authentication -> Users -> **Invite user**, enter your email.
2. Open the emailed link and set a password.
3. In the SQL Editor run:
   `update public.profiles set role = 'admin' where email = 'you@example.com';`
4. Sign in, open `/admin.html`, invite colleagues, and grant them tokens.
5. To offer shared ATO waypoints, sign in as admin, open `/ofp.html` and place the ATO points on the map (stored as global waypoints; users add their own personal points there too). The same page has admin editors for ATO points (new, rename, delete) and for ATO procedures and their transitions; those edits are stored in `ato_procedures` as overrides of the plate defaults in `ato.js` (re-run the OFP part of `db/schema.sql` first; without the table the plate defaults are used).
