# Fleet Checkout release readiness

Checked November 9, 2026. This is an implementation and submission checklist, not a claim of legal compliance or guaranteed Apple approval. Version 1.0.0 build 2 was successfully uploaded to App Store Connect on November 9, 2026. Apple processing completed successfully; build 2 is assigned to Owner iPad Testing and the account holder is Invited. No App Review submission has been made.

## Release gates

| Item                    | Current evidence                                                                                                                                                                                                                                            | Required next step                                                                                                                                                                                                                                                                                                          |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Native app              | SwiftUI iPhone/iPad app, iOS 18+, shared live fleet API, no web-view wrapper. Local tests and signed device archive pass. Apple accepted and processed the normal App Store distribution upload.                                                            | Physical-device acceptance remains required.                                                                                                                                                                                                                                                                                |
| Apple access            | App Store Connect and Xcode are signed in to Branden Vincent-Walker, team `6R2T984G9S`. Signed archive and App Store export/upload succeeded.                                                                                                               | Owner handles any new agreements or two-factor prompts if Apple requires them.                                                                                                                                                                                                                                              |
| App identity            | Registered bundle ID `app.fleetcheckout.mobile`; App Store Connect app `6832734217`; display name Fleet Checkout; version 1.0.0, build 2 uploaded.                                                                                                          | Retain this identity for future releases.                                                                                                                                                                                                                                                                                   |
| TestFlight              | Upload succeeded; Owner iPad Testing internal group created with the existing account holder as its only tester. Automatic distribution is disabled. Processing completed; build 2 assigned. App Store Connect shows the owner Invited on November 9, 2026. | Owner accepts the invitation on iPad and installs build 2. Physical installation and scanner acceptance remain unobserved.                                                                                                                                                                                                  |
| Physical-device testing | Simulator tests cannot exercise the camera/document scanner.                                                                                                                                                                                                | Install from TestFlight and complete the test script below on an iPad before final review.                                                                                                                                                                                                                                  |
| Distribution            | Owner selected an unlisted staff app on November 9, 2026.                                                                                                                                                                                                   | For unlisted distribution, submit a release-ready app with an unlisted note and then request the unlisted link. Keep release manual until the distribution decision is settled.                                                                                                                                             |
| Privacy and support     | No published privacy/support pages or accessible native privacy link yet. Operator confirmed as Branden Vincent-Walker. Google support account `fleetcheckout.support@gmail.com` has been created and its display name changed to Fleet Checkout Support.   | Publish accurate pages and add native links on sign-in and profile screens. Confirm subprocessors, retention and rights-request handling.                                                                                                                                                                                   |
| Account deletion        | Email verification can automatically create an account; no in-app deletion flow exists.                                                                                                                                                                     | Implement in-app initiation and completion, not just disabling access. Establish treatment of active trips, signed records, evidence, queued emails, logs and backups. Inform users of retained data and completion time. Test with isolated disposable users.                                                              |
| Backup retention        | The backup bucket has an indefinite lock and no purge schedule. Settings retentionDays does not delete data.                                                                                                                                                | Owner confirmed a 60-day policy covering signed forms, vehicle photos, gas receipts and backup copies. This does not establish a legal exception to account deletion. Resolve backup deletion/expiry and restore suppression before claiming account/data deletion. Do not silently weaken locks or delete signed evidence. |
| Review access           | Email codes expire and require mailbox access. No isolated reviewer workspace/accounts exist.                                                                                                                                                               | Provide stable reviewer credentials for driver/reviewer/admin flows in an isolated synthetic workspace. Do not give Apple admin access to live employee records or add a universal code bypass.                                                                                                                             |
| Branding rights         | Native workspace and original-layout PDF include Learn4Life branding; PDF references supplied Learn4Life/Desert Sands/Enterprise artwork.                                                                                                                   | Confirm authority to distribute these names/artwork, and supply rights documentation if Apple requests it.                                                                                                                                                                                                                  |
| Listing                 | Draft copy below; screenshots and review contact not finalized.                                                                                                                                                                                             | Capture genuine native iPhone/iPad screenshots with synthetic data. Add owner-approved contact name/email/phone, age-rating answers, territories, privacy labels and support URLs.                                                                                                                                          |

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
- Planned privacy URL: https://fleetcheckout.app/privacy (not published yet)
- Planned support URL: https://fleetcheckout.app/support (not published yet)
- Review contact: owner-confirmed name, email and international-format phone required; do not publish private account details without approval.
- Accessibility claims: leave unverified claims unset. Test VoiceOver, text scaling, contrast, reduce motion and keyboard alternatives; the damage list offers an alternative to direct diagram taps.
- Age rating: answer the actual questionnaire. Private staff photos/notes are user-generated content; do not equate lack of a public feed with no user content. No advertising, chat, gambling, unrestricted browsing or sensitive-content catalog is intentionally offered.

Draft description:

Fleet Checkout helps authorized staff inspect shared vehicles, record checkout and return mileage, and keep signed forms and supporting evidence together. Mark damage on the vehicle diagram, compare existing marks with new return damage, capture vehicle photos, and scan gas receipts with Apple's document scanner. Assigned reviewers can inspect returned vehicles and approve their availability. Administrators manage vehicles, staff access and completed-form recipients. Use the same account and submitted records on the native app and web workspace. An internet connection and authorization from your fleet administrator are required.

Review notes to finish after real device acceptance:

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
