# Paper form to digital workflow

Visually reviewed both pages of the user-supplied scanned `LEARN 4 LIFE.pdf`. The original includes Learn4Life / Desert Sands Charter High School and Enterprise Fleet Management logos. The completed PDFs use a clean, code-authored reconstruction of the original layout: same wording, field order, checkboxes, odometer boxes, acknowledgments and signature lines. Only the supplied logo artwork is reused from the scan. All form rules, text and vehicle outlines are drawn cleanly, with no scanner borders or pre-existing x. The original scan remains a reference asset. The shared vehicle diagram in `shared/vehicle-diagram.json` is used by both the iPad and PDF, so normalized tap coordinates and mark symbols render in the same positions. Checkout and return each retain their own signed damage entries. Legacy entries without coordinates remain area-only and are labeled approximate; they are never assigned a fabricated exact tap. The first pages are checkout (checkout download) or checkout and check-in (return download), followed by full supporting details and photos. Long field values are fitted or abbreviated on the form and retained in full in supporting details.

| Paper field                                                     | Digital location / behavior                                                                                                            |
| --------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| Employee name, department, manager                              | Authenticated employee profile; snapshotted at checkout, carried through linked return                                                 |
| Checkout date/time, projected return date/time                  | Server checkout timestamp plus employee-entered expected return; overdue flag                                                          |
| Check-in date and time                                          | Server physical-return timestamp, shown in configured site timezone                                                                    |
| VIN ID last four digits                                         | Selected stable vehicle identity, snapshot with plate/asset ID and make/model/year                                                     |
| Check out / check in rep initials                               | Authenticated administrator representative review, never entered on behalf of another person                                           |
| Authorized float-pool driver list                               | Administrator-controlled employee eligibility; server rejects unauthorized checkout                                                    |
| Fuel tank full                                                  | Explicit yes/no at both inspections                                                                                                    |
| Fuel receipt received (combined with full tank on return paper) | Separate return checkbox, retaining both facts                                                                                         |
| Interior clean                                                  | Explicit yes/no at both inspections                                                                                                    |
| Gas card issued along with key / gas card returned              | Stage-specific gas-card check; additional key-return check on return                                                                   |
| Odometer reading                                                | Latest accepted starting reading, actual-dashboard confirmation, discrepancy hold; ending entry and automatic difference/carry-forward |
| Windshield: no damage, clear, star, cracked                     | Clear / no damage, star damage, cracked choices                                                                                        |
| Damage legend: chips, dent, scratch on vehicle diagram          | Labeled front/rear/driver/passenger/roof/interior/windshield/wheels entries with chip/dent/scratch, notes and photographs              |
| No eating; remove belongings/garbage                            | Explicit acknowledgments before signature                                                                                              |
| Accuracy acknowledgment                                         | Explicit acknowledgment and employee signature                                                                                         |
| Full tank upon check-in                                         | Checkout acknowledgment retained; return records actual fuel condition without hiding exceptions                                       |
| Employee and representative signatures and dates                | Finger signature plus authenticated identity/server receipt time; separate representative action when configured                       |

Additions requested by the user: eight required separate exterior images per trip; optional additional evidence; stable trip ID; immutable snapshots; private stamped viewing copies and original uploads; mileage correction addenda with acknowledgment; vehicle hold independent of physical return; transactional notification outbox; searchable history and audit trail.

## Smallest maintainable architecture

- One shared Node 22 Express server serves the built React PWA and API on the same origin.
- SQLite WAL mode on server-local persistent storage provides transactions and a partial unique index preventing simultaneous open trips for one vehicle. No per-iPad databases.
- Private disk stores original images, derived stamped images and immutable content-addressed PDFs. Authenticated API routes enforce staff ownership and administrator access.
- Individual invited accounts use salted scrypt passwords and server-side sessions with expiry, CSRF checks and revocation. There is no name-only sign-in or self-registration. Existing SSO is not assumed configured.
- A database outbox separates submissions from email failure. SMTP or optional Resend is explicitly configured; credentials never go into the frontend.
- The browser retains unfinished form data only in memory. Offline operation cannot finalize trips; service-worker storage contains only the public application shell.

See COSTS.md for verified service limits, DEPLOYMENT.md for hosting, ADMIN.md for operation, and VERIFICATION.md for tests and physical-device boundaries.
