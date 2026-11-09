# Vercel, Supabase and Cloudflare R2

The hosted test app uses Vercel for the React frontend and Node 22 API, a separate **Free** Supabase organization for Postgres, private Cloudflare R2 Standard storage for photos/PDFs, and Resend for email codes. The public address is **https://fleetcheckout.app**. The existing local/Docker preview and its backup remain separate recovery copies.

## Data and access

- The private `fleet` database schema is not exposed through Supabase's public API. Its tables have RLS, no anonymous/authenticated-role grants, and an application role limited to CRUD within that schema. The application performs session, CSRF, role and record-ownership checks.
- Profile fields and structured private snapshots remain AES-256-GCM encrypted using the existing application key. Losing this key makes those records unreadable. Retain a separate secure recovery copy.
- Passwordless sign-in verifies a single-use emailed code. Unknown verified accounts receive staff access, not administrator or authorized-driver permission. An administrator must authorize driving.
- R2 public access stays disabled. Its server credential grants object access to the fleet evidence bucket only. Downloads require app authorization, then use links valid for two minutes.
- Photo uploads use a ten-minute signed PUT for one staging object with a signed content length and a no-overwrite condition. Finalization rechecks the user, vehicle, trip, file size and image validity. Original bytes are preserved; a separate stamped viewing copy is created. Photo tickets cannot finalize another person's upload.
- The original-layout forms, positioned damage marks, checkout/return comparison and photo appendix are generated on the server. Reports are content-addressed and retained in private storage. Large originals and reports bypass Vercel's 4.5 MB request/response limit.
- The database keeps an outbox. Successful API mutations schedule processing with Vercel `waitUntil`; a secret-protected daily cron recovers pending work and cleans expired staging uploads, sessions and rate counters. An interrupted or ambiguous email send requires administrator review before resend.

## Configuration and deployment

Apply `supabase/migrations` to a dedicated project. The migration creates the restricted `fleet_app` role; assign its password separately through a trusted admin connection, never in committed SQL. Use the Supabase transaction pooler and the bundled Supabase CA certificate for verified TLS.

Set the server-only variables listed in `.env.example` in Vercel. `PROFILE_ENCRYPTION_KEY` replaces the mounted key file used by Docker. Production `PUBLIC_ORIGIN` must exactly match the custom HTTPS origin. Use a domain-only Resend sending key and a bucket-only R2 object key. No credentials belong in Vite environment variables or Git.

Keep R2 CORS limited to the app's exact origin and any explicitly approved test origin. Permit `GET`, `HEAD`, `PUT`, `content-type`, `content-length`, and `if-none-match`. Do not enable the public R2 URL or bind a public custom domain to the evidence bucket.

`vercel.json` supplies API rewrites, function duration/region, security headers and the authenticated daily maintenance schedule. Deploy with `vercel --prod` only after checks pass. The GitHub production branch is `main`.

## Existing data migration

`scripts/migrate-cloud.js` accepts a verified local backup through `SOURCE_BACKUP`, private cloud configuration in the environment, and optionally `MIGRATION_REPORT`. It refuses a nonempty destination, checks the encryption key, copies immutable evidence and verifies every uploaded hash, copies exact database records inside one transaction, and compares all copied values. Sessions and sign-in challenges are intentionally not migrated. Keep the source preview quiet during final migration to avoid divergent later edits.

The initial migration retained one administrator, one vehicle, one trip, ten photo records, and 26 evidence files. All transferred records and evidence hashes matched. The source backup and encryption key remain separately retained on the operator's Mac.

## Testing and limits

Run `npm test`, `npm run build`, `npm run format:check`, and `npm run test:e2e`. The test helpers support `FLEET_TEST_ADMIN_DATABASE_URL` for disposable Postgres schemas. Set the restricted `DATABASE_URL` too. They never truncate the real `fleet` schema. `FLEET_TEST_R2=1` enables the private cloud-storage integration test; run it only with a test-approved bucket and credentials. Cloud browser checks can use `FLEET_E2E_PORT=4173` and an explicit localhost CORS origin. Email is captured locally in browser tests.

The hosted test configuration caps app photo capacity at 8 GB, leaving room for reports and temporary uploads. This is an application limit, not a Cloudflare billing cap, and the R2 free allowance is shared with other account usage. Standard R2 includes 10 GB-month free; additional storage and requests can incur usage charges. Supabase Free may pause inactive projects and has lower database/transfer limits. This setup is for testing; review organizational ownership, capacity and backup requirements before regular staff rollout.

The local SQLite backup command does not back up Postgres. Scheduled encrypted cloud snapshots and isolated restore checks are configured separately; see [Cloud backups and recovery](CLOUD-BACKUPS.md) for the schedule, credentials, retention, recovery keys and restore procedure.
