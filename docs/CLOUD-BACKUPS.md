# Cloud backup and recovery

The cloud backup exports a consistent PostgreSQL `fleet` schema and copies the immutable photos and generated PDFs referenced by that fleet into the separate private R2 bucket `fleet-checkout-backups`. Database exports, manifests, and evidence are AES-256-GCM encrypted before upload. The live Vercel storage credential cannot access this bucket.

## Schedule and verification

The scheduler lives in the private repository `Branden574/fleet-checkout-backups`, avoiding the public-repository 60-day inactivity disablement. It checks out the application source at a reviewed commit and runs without this Mac.

The daily job runs at 09:17 UTC (1:17 a.m. Pacific standard time, 2:17 a.m. daylight time). GitHub can delay scheduled jobs, so this is a daily recovery point, not continuous replication or a guaranteed start time. Run it manually after important configuration or migration work.

Every run exports all 17 current tables from one repeatable-read snapshot, writes a native PostgreSQL archive, verifies new encrypted objects by downloading them again, and writes the authenticated manifest last. Interrupted runs cannot produce a completed manifest. Unchanged immutable evidence is reused, avoiding a full extra copy each day. Temporary upload staging objects are excluded.

The recovery check downloads the committed cloud snapshot, authenticates/decrypts it, verifies every evidence file's SHA-256 hash, restores the database with `pg_restore --exit-on-error` in a disposable PostgreSQL container with no network and no published ports, and compares every table count and the profile-key fingerprint. It cannot change the live database or send email. A green job means both backup and recovery verification passed.

## Access and retention

- `fleet_backup` can SELECT fleet tables only; it has no write privileges, role administration, schema ownership or RLS bypass. New tables require explicit SELECT grants and a backup SELECT policy.
- `fleet-backup-source-readonly` can only read `fleet-checkout-evidence`.
- `fleet-backup-destination` can read/write only `fleet-checkout-backups`.
- The backup bucket has no public URL, custom domain or browser CORS access. The `protect-fleet-recovery-files` bucket lock applies indefinitely to all objects. No automatic purge is configured. A Cloudflare account administrator can change that rule; object-only keys cannot.
- Backups remain in the same Cloudflare account as the evidence. Separate credentials and a bucket lock protect against app-level mistakes, not loss or compromise of the entire Cloudflare account. R2 storage/operation charges include backups; the app's 8 GB upload limit is not an account billing cap.
- Do not rotate the backup encryption key without preserving older keys and separating the new encrypted object namespace. Existing evidence copies need their original key.

## Recovery keys

Keep `BACKUP_ENCRYPTION_KEY` and the original `PROFILE_ENCRYPTION_KEY` in an organization-controlled password manager or offline recovery store. Neither key is embedded in a backup. The first opens the outer backup; the second opens private application records. Losing either makes recovery incomplete. Keep these separate from the R2 bucket. Local private operator configuration is under ignored `artifacts/cloud/`; do not commit or attach it to support tickets.

## Recovery procedure

1. Stop application writes and preserve the current environment before any live recovery. Choose a successful workflow run and its manifest key.
2. Load backup credentials into the environment from a private secret store. Download into a new directory:

   ```sh
   node scripts/cloud-backup-download.js 'snapshots/SNAPSHOT-ID/manifest.aes' /absolute/new/recovery-directory
   ```

   This refuses an existing directory, invalid paths, wrong keys, authentication failures and checksum mismatches. Never restore a directory containing `.incomplete`.

3. Restore first into an isolated PostgreSQL instance using a compatible Postgres tool version. Create the non-login placeholder roles `fleet_app` and `fleet_backup`, then use `pg_restore --no-owner --no-acl --exit-on-error`. Compare all table counts with `manifest.json`. Run the repository's database migrations and provision fresh least-privilege roles/credentials for a replacement cloud project; grants are deliberately not included in the archive.
4. Re-upload verified `photos/` and `reports/` to a new private evidence bucket preserving their exact relative paths. Verify upload hashes. Never overwrite the existing production bucket as a first recovery step.
5. Reconfigure the server with the matching profile encryption key. Clear restored sessions, login codes, rate limits and upload tickets; reconcile pending/processing notifications manually before starting workers to avoid replaying old messages. Review idempotency records against any activity after the chosen snapshot.
6. Check sign-in, staff/admin authorization, one known trip, diagram marks, original photos, both PDF pages, mileage and recipient settings before switching traffic. Re-enable writes and take a fresh backup.

For routine isolated verification, put the chosen `manifestKey` in a JSON file named by `BACKUP_RESULT_FILE` and run `node scripts/cloud-backup-verify.js`. Docker is required; the script creates and removes only its own uniquely named recovery container.
