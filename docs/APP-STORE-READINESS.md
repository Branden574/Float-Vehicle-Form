# Fleet Checkout release readiness

Checked November 9, 2026. Version 1.0.0 build 6 contains the account-deletion and isolated-review features plus the corrected review navigation. Its signed archive passed; upload is in progress. Builds 3, 4 and 5 uploaded successfully but must not be selected for release because build 6 fixes both review navigation and the iPhone tab-bar layout. No App Review submission has been made yet. This document records evidence, not a guarantee of Apple approval.

## Release gates

| Item                  | Current evidence                                                                                                                                                                                                                                                                                                                                                                                                                                | Remaining step                                                                                                     |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| Native app            | SwiftUI iPhone/iPad app, iOS 18+, shared HTTPS API; no website wrapper. Nine tests pass on iPad and iPhone. Signed build 6 archive succeeds.                                                                                                                                                                                                                                                                                                    | Select processed build 6 for TestFlight and App Review.                                                            |
| Identity              | Team `6R2T984G9S`, bundle `app.fleetcheckout.mobile`, App Store Connect app `6832734217`.                                                                                                                                                                                                                                                                                                                                                       | Retain these identifiers.                                                                                          |
| TestFlight            | Existing Owner iPad Testing group has the account holder invited; build 2 was previously assigned.                                                                                                                                                                                                                                                                                                                                              | Assign build 6 when processed. Physical-device installation and scanner acceptance remain unobserved.              |
| Distribution          | Unlisted staff distribution requested; review notes explain this, and manual release remains selected. Free US availability, Business category, content rights and calculated 4+ content rating saved. Mac and Vision Pro availability disabled.                                                                                                                                                                                                | Submit App Review, then request unlisted distribution. Keep manual release until Apple resolves the request.       |
| Privacy and support   | Public `/privacy`, `/support` and `/deletion-status` pages live. Native sign-in/profile links implemented. Operator Branden Vincent-Walker; contact fleetcheckout.support@gmail.com. Eleven App Store privacy categories configured for functionality, linked data, no tracking.                                                                                                                                                                | Final Apple privacy publishing agreement awaits owner confirmation.                                                |
| Account deletion      | Web and native My profile flows require recent authentication and typed DELETE. Access is revoked immediately; durable encrypted cleanup jobs erase profile, owned records and private evidence. A private receipt reports progress. Other users' records are anonymized where needed.                                                                                                                                                          | Monitor cleanup and support requests; published completion target is within 7 days, including recoverable backups. |
| Retention and backups | Confirmed 60-day closed-trip expiry implemented. Indefinite backup lock disabled with approval. Backup pruning, manifest expiry, restore suppression and deletion-completion gating implemented. Updated scheduled backup and isolated restore passed in GitHub Actions run `42708923182`.                                                                                                                                                      | Monitor the daily schedule and failures. Active trips remain until closure or account deletion.                    |
| Review access         | Separate Vercel project, PostgreSQL schema/role, encryption key and private R2 bucket. Stable synthetic driver/admin/deletion accounts use ordinary password authentication. R2 key denied access to both production buckets in live permission tests. Review browser CORS configured. Native driver login, saved profile, vehicle authorization and inspection entry verified. Final iPhone Fleet and My profile navigation visually verified. | Keep credentials private and provide them only in Apple's review fields.                                           |
| Validation            | Server suite: 42 pass, 1 optional R2 skip. Isolated cloud deletion/retention: 6 pass. Native: 9 pass on iPad and iPhone. Real restricted storage tests and backup restore pass.                                                                                                                                                                                                                                                                 | Complete physical camera/receipt-scanner acceptance on iPad using the script below.                                |
| Screenshots           | Genuine native iPad and iPhone fleet screenshots uploaded, using synthetic data.                                                                                                                                                                                                                                                                                                                                                                | Both screenshot uploads show 1 of 10 accepted assets.                                                              |

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

No third-party native SDK/package is linked. Native source audit found no UserDefaults, file timestamp, disk-space, boot-time or active-keyboard required-reason API use; the accessed-API list is empty. Recheck if code or dependencies change. Camera access has a task-specific purpose string; the system PhotosPicker does not request broad photo-library access. No microphone, contacts, advertising ID or tracking permission is requested.

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
7. Interrupt networking during receipt upload; restore connectivity and retry the retained pages. Confirm no silent page loss and no submission while pages remain pending. Drafts are in-memory: keep the app open and do not force-quit during this check.
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
