# Administrator and staff guide

## Before first use

Sign in with the initial administrator invitation created by IT. The app opens with no invented staff or vehicles.

1. **Settings:** enter the organization/app name, site and timezone (default `America/Los_Angeles`). Supply an approved logo URL/accent if desired. Use **Form emails** to add approved admin assistant recipients after the mail provider is configured.
2. **Vehicles:** add each exact vehicle, its plate/asset ID, VIN last four, location and verified initial odometer reading. Save it, then upload its identification photograph or configure an approved HTTPS image URL.
3. **Staff:** approve each work email before its owner signs in with a one-time code and saves their name, charter and manager. You can also invite them. Explicitly grant authorized-driver eligibility after checking their access. Administrator status alone does not authorize someone to drive.
4. Choose **Self-service** or **Representative review**. Representative review requires a different authenticated administrator to sign. Nobody can enter someone else's approval automatically.
5. Set mileage-alert, photo, session, capacity and retention policies. Front/rear/driver/passenger images remain mandatory at checkout and return; additional views can also be required.
6. Complete the physical iPad acceptance checklist in [VERIFICATION.md](VERIFICATION.md) before staff rollout.

## Install on a shared iPad

1. Connect the iPad to a network that can reach the approved HTTPS hostname.
2. Open that address in Safari. Do not use a development laptop's `127.0.0.1` address on an iPad.
3. Use Safari's **Share → Add to Home Screen**, confirm the name and add it. Menu wording can vary by iPadOS version.
4. Open the new Home Screen icon and sign in with an individual account. When prompted during inspection, allow camera access for the approved site.
5. Test portrait and landscape, finger signatures, camera capture, retries and user switching on the actual managed device.

The app uses a web manifest and service worker. Only public application assets are cached; authenticated APIs, photos and reports are not offline-cached. Changing the app name may require re-adding the Home Screen icon on some iPads. This release has not been distributed through the App Store.

## Staff checkout

1. Find the exact vehicle by name, make/model, plate, VIN last four or site. Verify its identification before proceeding. Only **Available** vehicles can be checked out.
2. Compare the automatically populated mileage to the physical dashboard and confirm it. If it differs, submit a discrepancy and reason; the vehicle is held for administrator review rather than silently changing the reading.
3. Enter a projected return time. The form uses the iPad's local time entry; reports display the configured site timezone.
4. Answer fuel, interior and gas-card checks. Record windshield condition, chips/dents/scratches by area and notes. Problems are recorded honestly; a `No` answer does not pretend the condition was satisfactory.
5. Capture and successfully store each required view separately. **Take photo** uses the live camera. If imports are allowed, **Upload** is visibly labeled as an imported photograph. Extra windshield/interior/odometer/receipt/damage images can be added.
6. Review the information, accept the paper-form acknowledgments and sign with your finger. Tap **Submit checkout** and wait for server confirmation.
7. If checkout is **Pending checkout**, do not take the vehicle until a different administrator approves it. The transaction reserves the vehicle while review is pending. If checkout is declined, the record is cancelled without inventing a physical return, and the vehicle is placed out of service.

Unusual condition issues can trigger review even in self-service mode. The database prevents two simultaneous checkouts of one vehicle; another person's successful submission can make a previously displayed available vehicle unavailable.

## Staff return

Open your active trip and choose **Return vehicle**. The employee, exact vehicle, starting mileage and checkout record stay linked.

- Enter the actual ending odometer. Ordinary ending mileage cannot be below the starting reading. The app calculates the difference and carries the accepted ending reading into the next checkout.
- Record fuel/full tank, receipt received, cleanliness, gas card, keys, windshield, damage and notes.
- Take four new exterior photographs plus any additional required evidence. Checkout images cannot be reused as return evidence. Retakes replace the selected slot; uploads must finish before submission.
- Review the trip total, acknowledgments and your signature, then submit. Wait for confirmation.

A physical return can be complete while the vehicle remains **Pending Review** or **Out of Service**. Damage, missing items, unusually large mileage or representative requirements do not automatically release it for the next driver. Representative-required report emails wait for the representative's signature.

## Poor connectivity and shared-device privacy

Checkout and return inspections save encrypted drafts on the current device. Choose **Save & exit** or wait for the saved status. On the same browser or native app, sign back in with the same staff account. Select **Resume checkout** or **Resume return** for the vehicle and then **Resume inspection**. Drafts expire after 24 hours without changes. Browser storage eviction or clearing app data can remove drafts earlier.

Answers, damage marks, mileage and queued photographs or receipt pages resume where you left them. Retry any unfinished uploads. An unsigned draft needs fresh acknowledgments and a signature. If a signed submission was interrupted, explicitly retry the same request. The app reuses its signed contents and idempotency key. A saved draft never checks out or returns a vehicle by itself.

Always use **Sign out** before handing over the iPad. Local private UI is cleared immediately across open tabs on the same site; server sign-out is then confirmed. If offline, the login screen states that server sign-out is pending. Reconnect and let sign-out complete before handover. Never share passwords or select another person's name as authentication. Sessions also expire after configured inactivity and an absolute eight-hour limit.

If camera permission was denied, enable Camera for the approved website in Safari settings and retry. If a HEIC upload is rejected by the server codec, use live camera capture or JPEG. The app records device-reported capture/file times separately from server receipt time; neither timestamps nor watermarks prove when the scene was photographed.

## Representative review

Open **Trip history**, filter pending or flagged records, and open the trip. Compare checkout/return photos and download the reports. Review the condition, then enter your own initials, reason, decision and finger signature. You cannot representatively review your own trip.

Approve checkout to let the employee take the vehicle. On return, approve availability or keep the vehicle out of service. The original employee submission remains intact. An older trip's review must not override the vehicle state of a later trip.

## Mileage corrections and odometer replacement

- **Before checkout:** a discrepancy holds the vehicle. Verify the dashboard, then edit its accepted master reading with a reason. No signed past form is rewritten.
- **Completed trip:** open the trip and choose **Document a mileage correction**. Enter field, corrected reading and reason. The original employee signs a renewed acknowledgment. The addendum shows original and corrected values, author and timestamps. A correction to an older trip does not overwrite newer vehicle mileage.
- **During an active trip, actual odometer replacement:** an administrator records the old reading at replacement, the new initial reading and documented reason on that trip. The employee refreshes/opens the linked return, enters the actual new ending reading and explicitly acknowledges the replacement before signing. Distance is `(old-at-replacement − original-start) + (new-ending − new-initial)`. The return is held for review. The interface supports one documented replacement event per active trip.
- A lower master reading requires the explicit odometer-replacement exception. Do not use it as a shortcut for an ordinary data-entry correction.

Signed original totals remain visible; correction addenda are separately labeled. After required acknowledgment, an administrator resolves the hold. Material profile/vehicle edits affect future snapshots; administrative history records before/after values and reasons.

## Staff and vehicle administration

Use **Edit access** to update department, manager, eligibility, active status or role with a reason. Access changes revoke sessions. **Reset / renew invitation** creates a new one-use password-setting link; share it privately through the organization's approved channel. Under **Staff**, enter the employee’s work email and choose **Approve email**. They can sign in with a one-time code and complete their profile. Enable driver authorization separately. Clear **Approved staff email** to remove staff access and driver privileges while keeping the employee’s account deletion controls available. To remove reviewer access, also remove their email from **Return reviewers**. Turn off **Account active** to disable sign-in entirely. Assigned return reviewers can sign in while assigned. Adding a form-email recipient only delivers form copies. Existing password sign-in remains available as a fallback.

Archive retired vehicles instead of deleting them. Active trips must be completed or declined before mileage/status/archive changes. Vehicle IDs remain stable when names change. Complete any required representative return signature before releasing that vehicle.

## Form email recipients

Open **Administration → Form emails**. Enter each admin assistant's address, use **Add recipient** for additional addresses, and choose **Save email recipients**. Up to 20 addresses are supported; recipients do not need app accounts. Enable the employee-copy checkbox if the driver should also receive the report. Saving the list does not send old reports or a test email.

Each checkout automatically queues one PDF with the completed checkout front, check-in back clearly marked **Not yet returned**, signatures, damage marks, and checkout photos. Each check-in queues both completed forms plus all checkout and return photos. When representative review is required, sending waits for the required signature.

Open **Sending history** on the web or **Administration → Email delivery history** on iPad to see each recipient. **Accepted** means the sending provider took the message. **Delivered to mail server** means the recipient’s email server accepted it. For a bounce or failure, check the address and choose **Retry this recipient**. A delayed or uncertain send requires a reason because another copy may already be on the way. Older emails can show only provider acceptance.

PDFs larger than 20 MiB are sent as a private download link. The recipient opens it within seven days, requests a one-time code at the configured address and downloads the report. The code expires after ten minutes. An assistant can download their copy without a fleet account. Removing the recipient revokes their link. A completed return supersedes the checkout link.

## Reports, notifications, storage and audit

- Trip history searches vehicle, employee, trip ID, status and date text (`YYYY-MM-DD`). Filters include active, pending, returned, overdue and flagged trips.
- **Checkout PDF** starts with the completed original checkout page and a blank check-in back marked Not yet returned. **Both forms & photos** starts with the original checkout and check-in pages. Both include supporting details, authentic signatures, corrections, timestamps and the relevant finalized photographs. The original layout and branding are preserved in a clean reconstruction with newly drawn form rules, labels and diagram. Download again to get the updated original-form layout for existing trips; previously saved PDF files are retained. The stray x from the source scan is absent. Blue numbered marks retain the exact positions selected on the iPad. Older area-only records remain approximate, with full notes in the supporting pages.
- Photo comparisons link to stamped viewing copies and authenticated original downloads. Downloaded files and emailed attachments are outside the app's access/session controls; handle them under organization policy.
- **Export CSV** exports original trip readings and status. Correction addenda are available in trip reports and the database backup; they do not silently replace signed CSV values.
- **Private storage** shows disk use against the configured photo budget. Reports and database growth require extra headroom. No evidence is automatically deleted at the limit.
- **Audit** shows the most recent 500 administrative events. The full audit trail is in the database and backup. Passwords and invitation tokens are excluded from audit entries.
- Follow the organization's retention schedule and [backup/restore procedure](DEPLOYMENT.md). Retention settings do not run an automatic purge.

## Mark damage on the iPad

On the Inspection step, choose **Chip**, **Dent** or **Scratch**, then tap the diagram. Front is at the top and the driver side is on the left. Tap a mark or choose it from **Selected mark**, then use **Move mark** and tap its new position. **Remove mark** deletes the selection; **Undo last mark** removes the most recently added entry. Add the location and size in the numbered notes below. An area-only entry can be positioned by selecting it and using Move mark. There is a 40-mark limit per inspection. Keyboard users can focus the diagram, use arrow keys, and press Enter to place a mark.

Review the diagram before signing. Return inspection provides the checkout diagram as a reference; record the current condition separately. Saved checkout and return diagrams appear in trip details and in the completed PDFs. Submitted marks are part of the signed inspection and cannot be edited silently. Damage still holds the vehicle for administrator review.

## Email sign-in and saved profiles

Enter your approved work email and choose **Email me a sign-in code**, then enter the six-digit code. A code expires in ten minutes, works once and permits five guesses. First-time staff save their name, charter/school and manager; email is already verified. Subsequent sign-ins reuse the profile and show **My current checkouts**. **My profile** updates future forms; signed past records retain their original details. A new staff account cannot check out a vehicle until an administrator enables authorized-driver access.

Profiles and structured personal-data JSON in the database use AES-256-GCM encryption. Email lookup uses a keyed hash. Photos, generated PDFs and CSV exports are not encrypted by this feature; protect host disks and backups separately. Sessions on a shared iPad still require sign-out.

On return, amber **C** marks show the checkout inspection and cannot be moved or deleted. Add only new or worsening damage as blue **N** marks. Both sets appear on the check-in form; the checkout form stays unchanged. Older area-only entries are identified as approximate instead of claiming an exact point.

## Overdue reminders

Fleet Checkout checks hourly for overdue vehicles. Once the projected return time passes, the driver receives one reminder to complete check-in. If a returned vehicle has been waiting for review for 24 hours, each currently assigned reviewer receives one reminder. When the reviewer list is empty, active administrators handle pending reviews. The driver is excluded from reminders to review their own return. The reminder ends when the vehicle is returned or the review is recorded, respectively.
