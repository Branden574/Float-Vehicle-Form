# Deployment and maintenance

## What must be supplied

1. An organization-approved always-on host with persistent local disk, enough storage and backups. See [costs](COSTS.md); there is no unlimited free photo retention.
2. An HTTPS hostname reachable from staff iPads. Use an existing trusted organization proxy/certificate, or the included Caddy configuration with DNS pointing at the host and ports 80/443 reachable for certificate issuance.
3. A real administrator email/name. Individual invited accounts and email-code sign-in are implemented. Organization SSO is not integrated because no identity-provider configuration was supplied.
4. An approved SMTP relay or optional Resend account, permitted sender, and actual recipients entered in the administrator interface. The repository contains no real email addresses or sending credentials.
5. An IT owner for patching, monitoring, disk space, account access, retention decisions and restore testing.

Do not use a sleeping laptop or an ephemeral free web-service filesystem as the production database or photo store. Do not put private evidence in `public/`, the repository, or a public object-storage bucket.

## Docker + Caddy

Use Docker Engine with the Compose plugin. Docker Desktop is convenient for local testing, but its organizational licensing is separate from this app; confirm your organization's entitlement before making it a workplace dependency. A Linux server running the organization-approved container runtime avoids assuming a free Desktop license.

```sh
cp .env.example .env
mkdir -p secrets
node -e "require('node:fs').writeFileSync('secrets/profile-encryption.key',require('node:crypto').randomBytes(32).toString('hex'),{mode:0o600,flag:'wx'})"
```

Set at least:

```dotenv
NODE_ENV=production
PUBLIC_ORIGIN=https://your-approved-fleet-hostname
APP_DOMAIN=your-approved-fleet-hostname
SECURE_COOKIES=true
TRUST_PROXY=1
EMAIL_PROVIDER=disabled
```

`PUBLIC_ORIGIN` must be the exact browser origin, with no trailing slash or path. `APP_DOMAIN` is only the DNS hostname. Replace both placeholders. Never set `TRUST_PROXY=1` on a server exposed directly to untrusted clients; the provided Compose file exposes only Caddy and keeps the app port private to its network.

```sh
docker compose build
docker compose run --rm \
  -e INITIAL_ADMIN_EMAIL \
  -e INITIAL_ADMIN_NAME \
  fleet node scripts/setup.js
docker compose up -d
```

Before running setup, provide `INITIAL_ADMIN_EMAIL` and `INITIAL_ADMIN_NAME` in your shell environment or `.env`. If using shell variables, export them. Setup prints a private 72-hour invitation link. Open the real HTTPS address, activate the account and sign in. The invitation appears in local command output, so protect terminal access and avoid retaining it in shared logs.

The `fleet-data` named volume contains the SQLite database, private photos and report versions. Do not run `docker compose down -v` against production unless you deliberately intend to delete those volumes. Container images are not backups. The application runs as the unprivileged `node` user.

Verify:

```sh
docker compose ps
docker compose logs --tail=100 fleet
```

`/api/health` verifies that the app can query its database. It does not establish that SMTP, DNS, TLS, backups or storage capacity are healthy.

## Existing Node host and reverse proxy

```sh
npm ci
npm run build
npm run setup
npm start
```

Use a process supervisor that restarts the service after failures/reboots. The included default `HOST=127.0.0.1` binds only to loopback; proxy traffic from the approved HTTPS endpoint. Production startup refuses a missing/non-HTTPS `PUBLIC_ORIGIN`. Use a dedicated operating-system account, restrict the data directory to that account, and use encrypted disks/backup media according to organization policy.

The schema is initialized from `server/migrations/001_initial.sql` and recorded in `schema_migrations`. This is the initial release; future schema changes must add deliberate migrations rather than editing a deployed database manually. Back up before every upgrade.

## Email setup and semantics

In **Administration → Settings**, configure actual recipient addresses and the optional employee copy. Blank recipients create a visible failed notification; the trip and its PDF remain saved.

For approved SMTP:

```dotenv
EMAIL_PROVIDER=smtp
EMAIL_FROM=approved-sender-at-your-organization
SMTP_HOST=approved-relay-hostname
SMTP_PORT=587
SMTP_SECURE=false
SMTP_USER=organization-provided-username-if-required
SMTP_PASSWORD=organization-provided-secret-if-required
```

Replace placeholders with approved values. Port 587 uses required STARTTLS; port 465 uses `SMTP_SECURE=true`. TLS certificate checks are enabled. An approved relay can omit username/password if IT has configured another authorization mechanism. Existing Microsoft/Google accounts do not automatically authorize SMTP relaying; confirm the actual arrangement with IT.

Optional Resend:

```dotenv
EMAIL_PROVIDER=resend
EMAIL_FROM=approved-sender-on-your-verified-domain
RESEND_API_KEY=your-secret-key
```

No provider account, domain, paid plan or billing change is created by these files. Review [the free-tier limits](COSTS.md) before configuring a provider. Restart the service after changing environment variables. Provider API keys and SMTP secrets stay server-side and must not be committed.

- Checkout mail contains the checkout form and its photos. Return mail contains **both** checkout and check-in sections plus a photo appendix.
- Representative-required notifications wait in `awaiting_review` until the applicable representative signs. The physical transaction and draft report are already saved.
- Submissions use idempotency keys; one durable outbox row is created per trip/stage. The worker claims a row atomically and processes it every 15 seconds. Failed sends are retried explicitly by an administrator.
- `accepted` means provider acceptance, **not confirmed delivery**. This version does not receive delivery webhooks; the delivery field remains unset. Confirm delivery in the provider's records when needed.
- An interrupted/ambiguous send becomes `unknown`. A stable SMTP Message-ID helps tracking but does not guarantee recipient deduplication. To avoid blind duplicate delivery, unknown sends require an administrator to check the provider and give a reason before an explicit resend.
- Resend requests additionally use an idempotency key; the provider documents a 24-hour retention window. Do not infer permanent deduplication. [Resend idempotency](https://resend.com/docs/dashboard/emails/idempotency-keys), [send API](https://resend.com/docs/api-reference/emails/send-email), [SMTP configuration](https://nodemailer.com/smtp).
- A report above 20 MB is retained but not emailed automatically. Download it and resolve attachment limits with IT. Reports normally embed normalized viewing copies rather than full-size originals.

## Backup and restore

The backup script uses SQLite's online backup API, then copies immutable original/viewing images referenced by that snapshot and completed immutable PDFs. It writes a SHA-256 manifest, checks database integrity and uses restrictive permissions. Do not delete or modify evidence while a backup is running.

```sh
npm run backup -- /approved/encrypted-backup-destination/new-snapshot-directory
```

The destination must be new, outside the live data directory, and not a symlink. In containers, mount a real approved backup destination into the one-off backup container; for example, adapt this path on a Linux host:

```sh
docker compose run --rm \
  -v /approved/encrypted-backups:/backup \
  fleet node scripts/backup.js /backup/new-snapshot-directory
```

Ensure the mounted destination is writable by the container's `node` user. Schedule the command using the organization's scheduler and monitor its exit status. No background scheduler is silently installed. A directory on the same physical disk is not an off-device backup. Rotate backup generations only under an approved retention policy; the script never deletes older snapshots to make room.

Stop the application before restoring. Validate a restore into an isolated test directory first:

```sh
DATA_DIR=/approved/restore-test-directory \
  node scripts/restore.js /approved/backup/snapshot --offline
```

Restore verifies every checksum, database integrity, foreign keys and referenced photos. It revokes all sessions and unused invitations. Unconfirmed queued, failed and awaiting-review email jobs become `unknown` because they might have been sent after the snapshot. Review provider records before resending. Keep the server stopped until restore and review finish.

By default a nonempty destination is refused. The explicit `--overwrite` option preserves the prior directory as a dated sibling before replacing it; budget disk space for both. Protect the backup as sensitively as the original database: it includes password hashes, employee details, signatures and photographs. The profile encryption key and `.env` are deliberately **not** in evidence backups; preserve server secrets in the organization's separate secrets system.

## Capacity, formats and retention

- Each upload is limited to 12 MB and 45 million decoded pixels. JPEG, PNG, WebP and decoder-supported HEIC are accepted. EXIF orientation is normalized for the stamped viewing copy; original bytes are retained.
- HEIC codec availability differs by server build. On rejection use live camera capture (JPEG) or iPad **Settings → Camera → Formats → Most Compatible**, then retry. A rejected format does not count as stored evidence.
- Photos consume the configured photo budget; the administrator dashboard also counts the database and report files. Leave additional disk headroom for reports, temporary files and backups. Report growth can exceed the photo budget, so monitor actual free disk space separately.
- Unsigned uploaded drafts also consume space. They are private to their uploading account/administrators and do not reserve the vehicle. There is no automatic cleanup or evidence deletion.
- `retentionDays` records policy only. There is deliberately no one-click signed-evidence deletion. IT must export/back up, obtain the organization's retention decision and perform any approved purge using a reviewed procedure.

## Update procedure

1. Back up and test restore, record the currently deployed commit and environment configuration.
2. Build/test the new commit on an isolated database. Review any migrations and dependency changes.
3. Stop the old application, deploy the verified build, run the migrations included with that release, and restart.
4. Check sign-in, one nonproduction checkout/return, report generation, provider acceptance, and health/backup monitoring.
5. A rollback that restores the database must follow the offline restore workflow; do not blindly run old code against a new incompatible schema.

## Profile encryption and migration

Production requires `PROFILE_ENCRYPTION_KEY_FILE`. Generate the 32-byte hex key once using the command above, then retain a recovery copy in a separate secrets system. Do not regenerate it during upgrades. Compose mounts it read-only at `/run/secrets/profile-encryption.key`. On Linux, ensure the file is readable by the container's node user (UID 1000), while keeping it mode 600. Local nonproduction development generates `data/.development-profile-key`; retain that key separately if development records matter.

On first start, existing profile fields and structured personal-data JSON are migrated inside a transaction, then SQLite is vacuumed and its WAL truncated. Trip IDs and signed snapshot contents remain unchanged. A mismatched key fails startup. This is application-level field encryption, not encryption of every database column or evidence file: photos, PDFs, exported CSV, operational metadata and free-text audit reasons still require encrypted host storage and access controls. Old snapshots made before migration retain their original plaintext and need encrypted backup storage too.

Before upgrading an existing installation, stop the app and take a verified backup. An older app image cannot read the migrated database; rollback requires restoring the pre-migration snapshot. Never run the old and new app against the same live volume. Backups carry a key fingerprint but deliberately exclude the key. Restoring an encrypted snapshot requires `PROFILE_ENCRYPTION_KEY_FILE` pointing to the matching separately retained file; the restore verifies it before replacing the destination. Restores revoke email codes, sessions and pending invitations.

For Resend sign-in, set `EMAIL_PROVIDER=resend`, an approved `EMAIL_FROM`, and a sending-only `RESEND_API_KEY` scoped to the verified sender domain. Sign-in codes do not depend on report recipients. Report email remains separately configured in Administration. Provider acceptance does not establish inbox delivery; test the complete email-code flow on a staff device.
