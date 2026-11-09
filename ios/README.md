# Fleet Checkout for iPhone and iPad

This is a SwiftUI application, alongside the React web application. It uses the same HTTPS fleet API, individual accounts, Supabase records, private Cloudflare R2 evidence, signed PDFs and email recipients as https://fleetcheckout.app. It does not embed the website in a web view.

## Build and run

Open `FleetCheckout.xcodeproj` in Xcode, choose the FleetCheckout scheme and an iPhone/iPad simulator, then Run. The committed Xcode project is generated from `project.yml`; after changes to files or settings, run `xcodegen generate --spec ios/project.yml` from the repository root (XcodeGen is available through Homebrew).

```sh
xcodebuild -project ios/FleetCheckout.xcodeproj -scheme FleetCheckout \
  -destination 'platform=iOS Simulator,name=iPad Pro 13-inch (M5)' \
  -derivedDataPath artifacts/native-build test
```

Keep simulator code signing enabled (ad-hoc signing is sufficient) so the app can access its own Keychain. Simulator testing does not need an Apple distribution certificate. For a physical device or archive, choose the organization's approved development team under Signing & Capabilities; do not commit private provisioning profiles or signing keys.

When the shared diagram changes, run `python3 scripts/generate-native-diagram.py` to regenerate the native outline.

## Native capabilities

- Email code sign-in with a server-enforced 60-second resend cooldown; profile reuse and current checkouts.
- Native vehicle and trip lists, checkout/return inspection forms, camera capture and optional system photo picker.
- The same normalized vehicle diagram coordinates as the web/PDF renderer. Amber checkout marks remain visible while new return marks are added separately.
- Touch/Apple Pencil signature drawing and private PDF/photo previews with the system sharing menu.
- Server-calculated mileage, documented odometer replacement and signed mileage-correction acknowledgment, required-photo checks and stable idempotency keys for uncertain submissions.
- Native administrator recipient editing, staff access, vehicle editing and representative reviews. Advanced mileage corrections, odometer replacement creation, notification retries, audit exports and organization settings remain in the full web dashboard.

Sessions are stored in this-device-only Keychain storage. HTTP response caching and shared cookies are disabled; credentials are removed on cross-host PDF redirects. Downloaded private files use complete file protection and are removed at sign-out. In-flight operations are invalidated on session changes. A privacy cover hides app content when inactive. Drafts stay in memory and must be submitted online; force-quitting discards unfinished drafts.

The simulator has no camera. Real iPad acceptance must cover camera permission/denial, all required views, Apple Pencil, background/resume, photo picker restrictions, private PDF sharing and a full checkout/return.

## Before TestFlight / App Store

The web deployment does not distribute this app. A signed native archive must be uploaded to App Store Connect and processed for TestFlight. No App Store submission is implied by a successful local build.

- Confirm the owning Apple team and reserve `app.fleetcheckout.mobile` (provisional until registered); create the App Store Connect app record.
- Complete the native end-to-end acceptance checks above with test accounts and vehicles.
- Supply organization-approved privacy/support URLs, retention and account-deletion process, privacy disclosures, screenshots, age rating and review credentials/instructions for email-code sign-in. Review account deletion requirements because the service supports account creation.
- Archive with the approved signing team, validate and upload, then invite the authorized TestFlight testers.
- Choose public, unlisted or Apple Business Manager distribution. Staff-only unlisted distribution still requires App Review and app authentication.

Apple references: [TestFlight](https://developer.apple.com/testflight/), [upload builds](https://developer.apple.com/help/app-store-connect/manage-builds/upload-builds), [unlisted distribution](https://developer.apple.com/support/unlisted-app-distribution/).
