# Verification record

Local verification completed **November 9, 2026**. This record separates performed checks from production and physical-device acceptance. Test accounts, vehicles, signatures and photographs are synthetic and are never seeded into the production application.

## Performed checks

| Check                                  | Result                                         | Scope                                                                                                                              |
| -------------------------------------- | ---------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| TypeScript + production frontend build | Passed                                         | `npm run build`; Vite production bundle                                                                                            |
| Server/integration tests               | **16 passed**                                  | `npm test`; real temporary SQLite databases and HTTP requests                                                                      |
| Browser tests                          | **14 passed, 1 explicitly skipped/unverified** | Chromium desktop 1440×1000, WebKit tablet 820×1180, Chromium phone 390×844                                                         |
| Formatting                             | Passed                                         | `npm run format:check`                                                                                                             |
| Dependency audit                       | No known vulnerabilities reported              | `npm audit` on the installed lockfile; not a guarantee that all vulnerabilities are known                                          |
| Container build/start                  | Passed                                         | Docker image builds on Linux ARM64; health endpoint returns HTTP 200; process runs as UID 1000                                     |
| PDF rendering                          | Reviewed                                       | Generated completed-trip report rendered with Poppler; labels, mileage, signatures, times, photo appendix and pagination inspected |
| Backup/restore                         | Passed                                         | Consistent SQLite snapshot, original/viewing-photo checksums, isolated restore, session revocation, corrupt-file/symlink rejection |

The browser suite's WebKit offline-reload attempt returned **“WebKit encountered an internal error”** during navigation. That specific case is explicitly skipped in repeat runs and **is not counted as passed**. WebKit online workflow, upload retry, permission-denial handling, session switching, manifest/worker registration and private-cache exclusion passed. Chromium offline shell reload passed. Actual Safari/Home Screen offline behavior remains a physical iPad acceptance item.

## Server coverage

- Checkout at 42,500 miles; linked return at 42,625; trip total 125; next checkout begins at 42,625.
- Two simultaneous requests using separate server/database connections produce one successful checkout and one conflict. The partial unique index independently rejects a second open trip for the vehicle.
- Duplicate checkout/return submissions replay one stored transaction and one outbox event per stage.
- Required photos must be stored, belong to the employee/vehicle/stage/draft, cover all required views and contain distinct files. Original bytes are retained separately from stamped viewing copies. Checkout evidence cannot be reused for return.
- Invalid image bytes, missing uploads, storage exhaustion, invalid readings and ordinary ending mileage below the starting value are rejected.
- Staff cannot use administrator routes or read another employee's trips/photos; unauthenticated private-photo access, missing CSRF and foreign-origin writes are rejected. Server inactivity expiry is enforced.
- Invited account activation and administrator-controlled driver authorization are exercised.
- Damage/fuel issues and unusually large mileage hold availability while preserving the physical return.
- Representative signatures require a different administrator. Declined checkout is cancelled without inventing a physical return. Required review cannot be bypassed through availability edits or notification retry.
- Required representative signatures defer notification sending until review is complete.
- Corrections preserve original signed readings. Older-trip corrections do not overwrite newer mileage; current corrections require the original employee's renewed acknowledgment and retain an availability hold.
- A documented active-trip odometer replacement supports a lower actual ending reading with explicit employee acknowledgment and correct distance across both odometers.
- Failed mail does not roll back a trip. Atomic outbox claims avoid duplicate worker sends. Provider acceptance is distinct from delivery; ambiguous sends require an explicit reasoned resend.
- Archive history, discrepancy holds, private backup integrity, restore session revocation and notification uncertainty after restore are covered.

## Browser coverage

The complete visible path creates a vehicle as administrator, switches to an invited staff account, checks it out, answers every inspection question, uploads four views, draws a pointer signature, returns it with four new views, downloads both forms and confirms mileage carry-forward.

Additional checks cover an interrupted photo upload and explicit retry, a denied camera permission response, offline sign-out clearing the form, a different staff account not inheriting the previous draft, and delayed responses from a signed-out administrator being discarded after the account switch. Layout checks found no horizontal overflow at the tested viewport widths. PWA cache inspection confirmed no `/api/` entries.

These tests use browser automation, pointer-generated signatures and synthetic uploaded images. They **do not establish that physical camera capture, finger input, iPadOS installation or managed-device behavior passed**.

## Remaining organization setup and acceptance

No approved production hostname, always-on host, administrator identity, SSO configuration or live sending credentials were supplied. No production service or paid plan was provisioned, and no real email was sent. The implementation is ready for an organization-controlled setup and acceptance pass, not a claim of an already deployed production fleet.

An organization representative should complete the following on an actual managed iPad and the intended production host:

- [ ] Trusted HTTPS access from the staff network and Home Screen installation/launch.
- [ ] Live rear-camera capture of four distinct views at both stages, preview/retake, portrait and landscape, permission denial/recovery, and representative real JPEG/HEIC uploads.
- [ ] Finger signatures and review on the actual screen outdoors; acceptable text contrast and tap targets for staff.
- [ ] Wi-Fi loss during upload and final submission, explicit retry, background/foreground behavior and browser eviction. Never rely on background syncing.
- [ ] Sign-out, session expiry, browser back/forward and next-user isolation on the shared iPad. Finish pending server sign-out before handover.
- [ ] Two actual iPads racing for one vehicle; inspect the displayed conflict and the one resulting trip.
- [ ] Organization email-provider authorization, approved sender/recipients, both-form delivery, attachment limits, quota failures and manual resend procedure. Confirm inbox delivery in provider records.
- [ ] Host-specific photo codec support, disk monitoring, backup scheduling, encrypted off-device storage and a restore rehearsal on the deployed operating system.
- [ ] Fleet/staff master records, driver eligibility, review responsibility and retention policy approved by the organization.

SSO, confirmed-delivery webhooks, future reservations, automatic retention deletion, native iOS/App Store distribution and physical odometer integration are not implemented or claimed. They are unnecessary for the delivered invited-account, immediate checkout/return workflow. One active-trip odometer replacement event is supported per trip. Load/scale, high availability and a formal independent penetration test have not been performed.

## Reproduce

```sh
npm ci
npm run build
npm test
npx playwright install chromium webkit
npm run test:e2e
npm run format:check
npm audit
docker build -t learn4life-fleet:verification .
```

Local generated PDFs and screenshots are written to ignored `artifacts/`; failure traces go to ignored `test-results/`. Do not publish real fleet evidence in these directories. The GitHub workflow runs formatting, build, API tests, browser tests and dependency audit with read-only repository permissions and no production credentials.
