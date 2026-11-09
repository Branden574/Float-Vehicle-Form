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
