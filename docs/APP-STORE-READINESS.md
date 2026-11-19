# Fleet Checkout release readiness

## November 18, 2026 vehicle calendar redesign

Version 1.0.2 (build 18) opens the native calendar in Month or the staff member's saved view. Test **Fleet → Vehicle calendar & availability** on iPhone or iPad. Browse to another day, open **Check availability**, select an interval, and check the results. Close the sheet and choose **View results** to reopen the same interval. Change a filter or time to clear the previous results.

The iPhone simulator completed a reservation and confirmed its cancellation in the isolated review workspace. It also displayed all seven dates in Week and all 30 dates in November, switched to Agenda, filtered by vehicle, and scrolled the last control above the system tab bar. The iPad simulator displayed the schedule alongside the selected day's details. Browser tests exercised calendar keyboard navigation across month boundaries, precise times, DST transitions and failed availability requests.

Apple's associated-domain service returned the production app identifier for `fleetcheckout.app`. Both iPhone and iPad simulators reached Apple's system passkey prompt on the staff domain. Real Face ID approval with a staff passkey still needs a physical device.

## November 18, 2026 calendar and update testing

Version 1.0.2 (build 16) is in internal TestFlight for **Owner iPad Testing**. The signed archive supports iPhone and iPad. Its Face ID purpose string, associated domains and bundled privacy manifest were checked. App Review’s demo instructions include passkeys and the reservation workflow.

An iPhone simulator reserved and canceled a vehicle in the isolated review workspace. A real deployment change produced **Restart now** and **Later** on the native Fleet screen. Both actions were exercised. A synthetic cancellation email was accepted by Resend at its designated delivery test address. The PostgreSQL migration was applied to the staff and review schemas after rehearsal, and an isolated Supabase schema passed the booking and cancellation concurrency checks.

## November 18, 2026 passkey testing

Version 1.0.2 (build 14) is available to Owner iPad Testing on iPhone and iPad. Beta App Review Information includes the following test steps.

1. Open **App Review workspace** and sign in with the supplied demo credentials.
2. Open **My profile**, select **Create a passkey**, and approve the system prompt.
3. Sign out, select **Sign in with a review passkey**, and confirm that the same review account opens.

An iPad Pro simulator and an iPhone simulator completed these steps with simulated Face ID and successfully removed the test credential afterward. The review workspace and staff workspace use separate associated domains. Staff can always use an email code. Apple handles device verification, and Fleet Checkout stores the credential identifier and public key. A successful Face ID match on a physical staff device still needs confirmation.

## November 18, 2026 staff testing release

Fleet Checkout 1.0.2 (build 8) is available in the internal **Owner iPad Testing** group. App Store Connect reported `IN_BETA_TESTING` after assignment. The signed archive contains the UserDefaults declaration `CA92.1`. This upload was for TestFlight.

Both fleetcheckout.app and the isolated review workspace run the updated staff approval, draft recovery, and form delivery features. Production checks for overdue reminders hourly. Resend reported a successful HTTP 204 response from the production webhook for a synthetic delivery. The migration retained both active production accounts.

Ten native tests passed on the iPad simulator. The browser matrix passed 29 checks, including checkout, return, interrupted uploads and resuming after account switching. The previously documented WebKit offline-shell navigation case was skipped. Separate Supabase and private R2 tests passed using synthetic records. Physical iPad receipt capture remains a device test.

## November 18, 2026 update

Version 1.0.0 is live. App Store Connect still shows Public under App Distribution Methods. Apple Developer Support acknowledged a follow-up about the November 9 unlisted request.

Version 1.0.1 (build 7) is available in TestFlight for Owner iPad Testing. App Store Connect shows Waiting for Review with manual release selected. On the native sign-in screen, staff can enable **Notify me when my code is sent** and allow notifications. Fleet Checkout then shows a system banner after a successful send or resend. The code itself arrives by email.

All nine native tests passed on an iPad Pro simulator. A separate UI test exercised the iPadOS notification permission prompt and observed two distinct system banners for an initial send and a resend using a simulated mail response. All five sign-in and profile API tests passed.

## November 9 submission record

Checked November 9, 2026. Version 1.0.0 build 6 contains the account-deletion and isolated-review features plus the corrected review navigation. Its signed archive passed and Apple confirmed the upload succeeded. Apple processing completed; build 6 is assigned to Owner iPad Testing and selected in the App Store version. Builds 3, 4 and 5 uploaded successfully but must not be selected for release because build 6 fixes both review navigation and the iPhone tab-bar layout. App Review submission `cbd32e0c-5dc2-4ef4-84c0-57f91e181445` was submitted November 9, 2026 at 2:50 PM Pacific and shows Waiting for Review. Privacy disclosures were published with owner approval; both screenshot uploads passed submission validation. The unlisted distribution request was submitted November 9, 2026; Apple displayed “Thank you for your submission” and will send a status update. The owner supplied an initial rollout of 5 staff at 1 organization, both managed and unmanaged devices, including 5 unmanaged devices. This document records evidence, not a guarantee of Apple approval.

## Release gates

| Item                  | Current evidence                                                                                                                                                                                                                                                                                                                                                                                                                                | Remaining step                                                                                                     |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| Native app            | SwiftUI iPhone/iPad app, iOS 18+, shared HTTPS API; no website wrapper. Nine tests pass on iPad and iPhone. Signed build 6 archive succeeds.                                                                                                                                                                                                                                                                                                    | Build 6 submitted; Apple status Waiting for Review.                                                                |
| Identity              | Team `6R2T984G9S`, bundle `app.fleetcheckout.mobile`, App Store Connect app `6832734217`.                                                                                                                                                                                                                                                                                                                                                       | Retain these identifiers.                                                                                          |
| TestFlight            | Build 6 is assigned to the Owner iPad Testing group, with one account-holder tester. Beta description, support/privacy links and isolated review credentials are saved.                                                                                                                                                                                                                                                                         | Physical-device installation and scanner acceptance remain unobserved; build-specific test steps are saved.        |
| Distribution          | Unlisted staff distribution requested; review notes explain this, and manual release remains selected. Free US availability, Business category, content rights and calculated 4+ content rating saved. Mac and Vision Pro availability disabled.                                                                                                                                                                                                | App Review and unlisted request submitted. Await Apple decisions; keep release manual until unlisted approval.     |
| Privacy and support   | Public `/privacy`, `/support` and `/deletion-status` pages live. Native sign-in/profile links implemented. Operator Branden Vincent-Walker; contact fleetcheckout.support@gmail.com. Eleven App Store privacy categories configured for functionality, linked data, no tracking.                                                                                                                                                                | Published with explicit owner approval on November 9, 2026.                                                        |
| Account deletion      | Web and native My profile flows require recent authentication and typed DELETE. Access is revoked immediately; durable encrypted cleanup jobs erase profile, owned records and private evidence. A private receipt reports progress. Other users' records are anonymized where needed.                                                                                                                                                          | Monitor cleanup and support requests; published completion target is within 7 days, including recoverable backups. |
| Retention and backups | Confirmed 60-day closed-trip expiry implemented. Indefinite backup lock disabled with approval. Backup pruning, manifest expiry, restore suppression and deletion-completion gating implemented. Updated scheduled backup and isolated restore passed in GitHub Actions run `42708923182`.                                                                                                                                                      | Monitor the daily schedule and failures. Active trips remain until closure or account deletion.                    |
| Review access         | Separate Vercel project, PostgreSQL schema/role, encryption key and private R2 bucket. Stable synthetic driver/admin/deletion accounts use ordinary password authentication. R2 key denied access to both production buckets in live permission tests. Review browser CORS configured. Native driver login, saved profile, vehicle authorization and inspection entry verified. Final iPhone Fleet and My profile navigation visually verified. | Keep credentials private and provide them only in Apple's review fields.                                           |
| Validation            | Server suite: 42 pass, 1 optional R2 skip. Isolated cloud deletion/retention: 6 pass. Native: 9 pass on iPad and iPhone. Real restricted storage tests and backup restore pass.                                                                                                                                                                                                                                                                 | Complete physical camera/receipt-scanner acceptance on iPad using the script below.                                |
| Screenshots           | Genuine native iPad and iPhone fleet screenshots uploaded, using synthetic data.                                                                                                                                                                                                                                                                                                                                                                | Both screenshot uploads passed Apple submission validation. No optional app-preview video was uploaded.            |

The review workspace has no historical backups and cannot access production evidence. Outbound email is disabled there. Production assistant recipients remain unchanged. No production employee account was deleted during validation. The backup worker only marks deletion complete after evidence cleanup and removal of affected recoverable snapshots.

## Native privacy manifest audit

`ios/FleetCheckout/PrivacyInfo.xcprivacy` declares no tracking or tracking domains. Declared data is linked to accounts and used for app functionality. The manifest is bundled in the app; it does not replace App Store Connect's privacy answers or the public privacy policy.

| Category                                 | App-specific basis                                                                                                                                                                                                   |
| ---------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Name, email, user ID                     | Verified staff accounts and signed record identity.                                                                                                                                                                  |
| Photos/videos                            | Vehicle photographs and scanned receipt page images; the app captures still images, not video.                                                                                                                       |
| Other user content                       | Signatures, inspection notes, damage marks and reviewer decisions.                                                                                                                                                   |
| Purchase history and payment information | Gas receipt images can include fuel purchases and payment method/card fragments. The app does not process payments.                                                                                                  |
| Precise location                         | Imported original image bytes are retained and can include EXIF GPS metadata. There is no GPS/location permission or background location tracking. Camera/scanner re-rendered JPEGs do not deliberately collect GPS. |
| Product interaction                      | Operational audit records such as sign-in, checkout, return and administrative changes.                                                                                                                              |
| Other diagnostic data                    | Server/provider error and request diagnostics used to operate the service.                                                                                                                                           |
| Other data types                         | Charter/school, department/manager, vehicle identifiers and mileage records.                                                                                                                                         |

The native app stores its sign-in alert preference in its own UserDefaults. The bundled privacy manifest declares the app-only reason `CA92.1`. Camera access has a task-specific purpose string; the system PhotosPicker does not request broad photo-library access. No microphone, contacts, advertising ID or tracking permission is requested.

The native binary uses URLSession HTTPS, Keychain and iOS file protection, not bundled/custom cryptographic algorithms. `ITSAppUsesNonExemptEncryption` is set to NO for this native binary's exempt operating-system encryption. Server-side database/profile/backup encryption is not embedded in the iOS executable. Confirm App Store Connect's export questions and territories; this does not substitute for the operator's export obligations.

## Draft listing and review information

- Name: Fleet Checkout
- Subtitle: Vehicle inspections & returns
- Primary category: Business
- Price: Free; no ads, purchases or subscriptions.
- Keywords: fleet,vehicle,checkout,inspection,mileage,receipt,school,return
- Privacy URL: https://fleetcheckout.app/privacy (published and verified)
- Support URL: https://fleetcheckout.app/support (published and verified in the live browser)
- Review contact: owner-provided name, support email and phone saved in the App Store version review fields. Do not copy the private phone into public repository files. Stable synthetic review credentials are saved privately in App Review Information; do not include them in this repository.
- Accessibility claims: leave unverified claims unset. Test VoiceOver, text scaling, contrast, reduce motion and keyboard alternatives; the damage list offers an alternative to direct diagram taps.
- Age rating: answer the actual questionnaire. Private staff photos/notes are user-generated content; do not equate lack of a public feed with no user content. No advertising, chat, gambling, unrestricted browsing or sensitive-content catalog is intentionally offered.

Draft description:

Fleet Checkout helps authorized staff inspect shared vehicles, record checkout and return mileage, and keep signed forms and supporting evidence together. Mark damage on the vehicle diagram, compare existing marks with new return damage, capture vehicle photos, and scan gas receipts with Apple's document scanner. Assigned reviewers can inspect returned vehicles and approve their availability. Administrators manage vehicles, staff access and completed-form recipients. Use the same account and submitted records on the native app and web workspace. An internet connection and authorization from your fleet administrator are required.

Review notes saved in App Store Connect cover:

1. Identify the app operator and staff-only use case; state the chosen distribution method.
2. Provide isolated synthetic workspace URL and stable driver, return reviewer and admin credentials. Describe the normal email-code flow and the exact standard sign-in method used by review accounts. Never include production credentials in the repository.
3. Provide steps for checkout, required exterior photos, signature, return mileage, receipt scanning, review/approval, and PDF preview. Explain simulator camera limitations without claiming they replace physical testing.
4. Identify in-app deletion location, actual processing time and any legally supported retained records once implemented and approved.
5. List Vercel, Supabase, Cloudflare R2, Resend and the private GitHub Actions backup process as service providers; no advertising or third-party native analytics SDK.
6. State that no special vehicle hardware, paid subscription, Bluetooth device or external accessory is required. Camera and optional Apple Pencil operate through system APIs.

## TestFlight: What to Test

Use synthetic fleet records and a sample receipt with no unnecessary personal/payment information.

1. Verify sign-in code and 60-second resend, complete the saved profile, and authorize the test driver if needed.
2. Release the test vehicle through the documented admin/reviewer flow. Existing test vehicle mileage is 43,000 after a flagged 1,000-mile trip; do not silently overwrite it.
3. Check out: confirm the accepted odometer, set expected return, answer condition checks, mark diagram damage, capture all four exterior views and sign.
4. Confirm the submitted checkout appears on the web after refresh.
5. Return: confirm old damage marks remain read-only, add a new mark, enter a sensible higher mileage, and answer condition questions.
6. On Photographs, tap Scan gas receipt. Test camera allow/deny, automatic edge detection, crop adjustment, multiple pages, Save and Cancel. Each saved page should appear as Receipt evidence.
7. Interrupt networking during receipt upload; restore connectivity and retry the retained pages. Confirm no silent page loss and no submission while pages remain pending. After the saved status appears, close the app, reopen it, and resume the same return with the same staff account. Verify the queued receipt pages still upload.
8. Complete vehicle photos and signature, then submit. Confirm the vehicle waits for assigned review. A different assigned reviewer signs approval; vehicle becomes Available.
9. Preview Both forms & photos and check full-size receipt pages, signatures, separate checkout/new-damage marks, employee/date filenames and configured assistant copies. Confirm receipt originals can be viewed in the web record.
10. Change iPad appearance between light/dark while entering a draft; verify readability, retained fields and unchanged black-on-white PDF signatures. Test portrait/landscape, text size, VoiceOver, finger/Pencil input and shared-device sign-out.

## Apple references checked

- [App Review Guidelines](https://developer.apple.com/app-store/review/guidelines/)
- [In-app account deletion](https://developer.apple.com/help/app-review/guideline-reference/5-1-1-account-deletion)
- [Review account information](https://developer.apple.com/help/app-review/before-submitting-for-review/complete-review/)
- [App privacy labels](https://developer.apple.com/app-store/app-privacy-details/)
- [Privacy manifest format](https://developer.apple.com/documentation/bundleresources/describing-data-use-in-privacy-manifests)
- [Native encryption declaration](https://developer.apple.com/documentation/security/complying-with-encryption-export-regulations)
- [Upload builds](https://developer.apple.com/help/app-store-connect/manage-builds/upload-builds)
- [Internal TestFlight testers](https://developer.apple.com/help/app-store-connect/test-a-beta-version/add-internal-testers)
- [Unlisted distribution](https://developer.apple.com/support/unlisted-app-distribution/)
