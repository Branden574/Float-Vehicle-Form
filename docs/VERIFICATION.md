# Verification record

Local verification completed **November 9, 2026**. This record separates performed checks from production and physical-device acceptance. Test accounts, vehicles, signatures and photographs are synthetic and are never seeded into the production application.

## Performed checks

| Check                                  | Result                                         | Scope                                                                                                                                                 |
| -------------------------------------- | ---------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| TypeScript + production frontend build | Passed                                         | `npm run build`; Vite production bundle                                                                                                               |
| Server/integration tests               | **28 passed; 1 opt-in cloud test skipped**     | `npm test`; real temporary SQLite databases and HTTP requests                                                                                         |
| Browser tests                          | **23 passed, 1 explicitly skipped/unverified** | Chromium desktop 1440×1000, WebKit tablet 820×1180, Chromium phone 390×844                                                                            |
| Formatting                             | Passed                                         | `npm run format:check`                                                                                                                                |
| Dependency audit                       | No known vulnerabilities reported              | `npm audit` on the installed lockfile; not a guarantee that all vulnerabilities are known                                                             |
| Container build/start                  | Passed                                         | Docker image builds on Linux ARM64; health endpoint returns HTTP 200; process runs as UID 1000                                                        |
| PDF rendering                          | Reviewed                                       | Clean form reconstruction rendered with Poppler; field/checkmark placement, both signatures, No answers, damage markings and photo appendix inspected |
| Backup/restore                         | Passed                                         | Consistent SQLite snapshot, original/viewing-photo checksums, isolated restore, session revocation, corrupt-file/symlink rejection                    |

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

Original-form regression checks verify embedded source pages, local dates, odometer digits, stage-specific signatures and checkout isolation with a clearly pending check-in back. Return fuel/receipt is Yes only when both separate answers are Yes. Template bytes and renderer version participate in the report cache key: fresh downloads use the new layout, while previously saved report files remain immutable.

## Browser coverage

The complete visible path creates a vehicle as administrator, switches to an invited staff account, checks it out, answers every inspection question, uploads four views, draws a pointer signature, returns it with four new views, downloads both forms and confirms mileage carry-forward.

Additional checks cover an interrupted photo upload and explicit retry, a denied camera permission response, offline sign-out clearing the form, sign-out clearing other open tabs, a different staff account not inheriting the previous draft, and delayed responses from a signed-out administrator being discarded after the account switch. Layout checks found no horizontal overflow at the tested viewport widths. PWA cache inspection confirmed no `/api/` entries.

These tests use browser automation, pointer-generated signatures and synthetic uploaded images. They **do not establish that physical camera capture, finger input, iPadOS installation or managed-device behavior passed**.

## Remaining organization setup and acceptance

A temporary HTTPS preview is running on the development Mac with a privately configured Resend sender. The live code-request endpoint successfully submitted a message to the provider’s delivery-test address; actual staff inbox delivery remains an acceptance check. The existing preview administrator and trip survived the encryption migration, and an isolated restore of the encrypted preview backup was readable with the separately retained key. A permanent organization-approved host, production hostname, SSO configuration and physical iPad acceptance remain separate from this test deployment.

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

SSO, confirmed-delivery webhooks, future reservations, automatic retention deletion, App Store distribution and physical odometer integration are not implemented or claimed. Native iOS implementation and its separate acceptance boundary are documented below. One active-trip odometer replacement event is supported per trip. Load/scale, high availability and a formal independent penetration test have not been performed.

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

## Diagram and clean-template verification

The clean template reproduces the paper form layout, using original branding and newly authored labels, rules and car outlines. Tests check deterministic template hashing, exact normalized mark placement on checkout and check-in PDFs, invalid/out-of-range coordinates, diagram version validation, backward compatibility with area-only entries, and independent persistence of checkout and return marks. Browser tests place, move, remove and undo marks with touch events in tablet/phone emulation, enter notes, submit the inspection, reload and read back stored positions, and download its PDF. Physical iPad acceptance remains user testing; browser emulation is not a hardware test.

## Saved profiles and email-code verification

Server tests cover code expiry, five-guess lockout, single use/replay, resend cooldown, disabled users, failed delivery cleanup, staff-only registration, authorization boundaries and self-profile updates. Database scanning confirms that profile values are absent as plaintext after writes; reopening and legacy-row migration preserve readable profiles and signed snapshot contents. A wrong key is rejected. Encrypted restore requires the matching separate key and revokes pending codes.

Browser tests verify first-time email-code sign-in using an isolated test mailbox, profile completion, sign-out and repeat code sign-in with prefilled details. The checkout dashboard links to the employee's active trip. Return tests preserve the original checkout mark and add a separate new mark on the same touch diagram. PDF operator checks and Poppler rendering confirm C/N labels on the return form, including the no-new-damage case.

The extended browser run exposed a photo rate-limit issue: read requests consumed the same per-IP budget as uploads, so thumbnail viewing and shared-network traffic could block uploads. Photo mutation limits now apply per authenticated user and do not count read-only photo requests. The complete suite passed after the fix. This is not a load-test claim.

## Cloud migration and form-email update

The server suite also passed 16 Postgres integration cases against disposable schemas in the Free Supabase project. The new assistant-recipient test separately passed against Postgres, including administrator-only changes, persistent recipient settings, the optional employee copy, and real checkout/return PDF attachments. No human recipients are used in these tests.

Private R2 integration verified uploads larger than Vercel's request limit, byte-identical original downloads, rejection of object replacement and foreign-user access, idempotent completion, and signed PDF downloads. The original records and all 26 migrated evidence files matched their source data and hashes. The restricted app role uses verified TLS; Supabase security advisors reported no issues.

Browser tests now cover adding, saving, reopening and removing assistant addresses on desktop, tablet and phone. Checkout PDFs include the blank check-in back marked Not yet returned; return PDFs contain both completed forms and both sets of photos. PDF regression checks prevent future return values/signatures from leaking into a checkout-stage report.

The HTML sign-in email was visually checked at desktop and 390px phone widths with no horizontal overflow. Resend accepted the new-domain HTML message sent to its delivery simulator. This is not a Gmail/Outlook rendering or actual inbox-delivery confirmation.

Four WebKit tablet workflows passed against the actual Supabase database and private R2 bucket using disposable test records: checkout/return with interrupted-upload retry and PDF download; touch damage with checkout/return separation; email-code profile reuse; and assistant recipient editing. Physical iPad camera, Home Screen and real recipient inbox acceptance remain user acceptance checks.

## Scheduled cloud backups — November 9, 2026

- Consistent native PostgreSQL archive of all 17 fleet tables, using a separate SELECT-only role (17 readable, zero writable tables). Supabase security advisors reported no issues after the migration.
- First encrypted backup: 28 immutable photo/PDF files, 81,448,980 bytes; new objects were downloaded after upload and authenticated/checksummed. Private R2 backup bucket is separate from the live evidence bucket and has an enabled indefinite object lock.
- Recovery downloaded the committed cloud manifest/archive/evidence and restored all 17 tables into a fresh PostgreSQL 17 container with no network or exposed ports. Counts and the profile-key fingerprint matched; all 28 evidence checksums passed. All 27 encrypted private fields in the recovered archive decrypted using the separately retained profile key. No production data was changed by this recovery check.
- Every scheduled run repeats isolated restoration and full evidence checksum verification. Native iPad/device acceptance is a separate test boundary; backup success does not establish camera, Apple Pencil, or App Store readiness.

The private scheduled job [42691973129](https://github.com/Branden574/fleet-checkout-backups/actions/runs/42691973129) passed on GitHub's runner: PostgreSQL 17.11 dump, encrypted manifest `2026-11-09T20-20-41.189Z-6f8ad1b39b27`, 17 restored tables and 28 verified evidence files. This establishes unattended cloud execution and restoration; the first future cron trigger has not happened yet. The runner explicitly installs PostgreSQL 17 from the verified official package repository rather than relying on its default PostgreSQL 16 binary.

## Web sign-in resend — November 9, 2026

A dedicated resend button unlocks after 60 seconds, with server-side enforcement and a `Retry-After` header. Successful resend clears the old entered code and replaces the challenge. The backend test verifies that the previous challenge is invalid and the new one works. The timed UI test passes on Chromium desktop/phone and WebKit iPad. Unit suite: 31 passed, one optional cloud test skipped. Production build passed; commit `518ba34` deployed successfully to fleetcheckout.app.

## Native iOS application — initial build

The new `ios/` SwiftUI target is a genuine native application using the shared production API. Four XCTest cases passed on the iPad Pro 13-inch (M5), iPadOS 27 simulator: mileage with an odometer replacement; lossless damage coordinates/stage encoding; credential stripping on external redirects and HTTPS downgrade rejection; and resend Retry-After plus Keychain cookie/CSRF/idempotency request behavior. The simulator build needs normal ad-hoc signing for Keychain access. Full native workflow acceptance and physical-device camera/Pencil testing remain separate from these tests. No TestFlight upload or App Store approval has occurred.

Full local web regression after resend: 26 browser tests passed, one existing WebKit offline-reload test skipped. The first cloud CI run exhausted its 15-minute job budget after dependency installation took over 14 minutes; the tests that ran passed. The job budget is now 30 minutes.

The same four native tests also passed on iPhone 17 Pro / iOS 26.5. An unsigned Release archive for real iOS devices compiled successfully; unsigned archives cannot be installed through TestFlight or the App Store. The native sign-in screen was opened manually in the iPad simulator, requested the real account code successfully, and visibly unlocked Resend code after its countdown. Authenticated native UI acceptance is awaiting the user entering that code.

Native follow-up: all five XCTest cases passed on iPhone 17 Pro after adding automatic damage-region mapping and pre-submission photo preview. The first native GitHub job [42694839802](https://github.com/Branden574/Float-Vehicle-Form/actions/runs/42694839802) passed on Xcode 26.3 with the initial four tests. A second unattended backup and restore [42694979302](https://github.com/Branden574/fleet-checkout-backups/actions/runs/42694979302) also passed after pinning the scheduler to application commit `648e255`.

Native historical-record compatibility: the signed-in iPad exposed an older trip snapshot without a charter field. Native trip snapshots now accept that historical shape and display its saved department as the legacy charter fallback, matching the PDF renderer. No signed data is rewritten, and current account decoding remains strict. Six XCTest cases passed on the iPad simulator, including list/detail decoding of the pre-charter record. The updated native dashboard, persisted sign-in, saved profile and existing trip loaded successfully against production.

## Descriptive PDF filenames

Report downloads and notification attachments share one server-generated filename built from the signed employee name, signed vehicle name and the checkout date in the saved fleet timezone. Completed return bundles also include the return date and `Checkout-and-Check-in`. Web and native clients use those same names. Names are bounded and safe for file paths and headers; private immutable R2 object keys remain unchanged. Existing cached PDFs receive the new download label without rewriting signed evidence. Previously delivered emails and already downloaded files retain their original names.
