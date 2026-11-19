# Learn4Life Fleet Checkout

A shared-server vehicle checkout and return application for staff iPads and desktop administrators. The working name, organization, site, branding, fleet, authorized drivers, inspection policy and notification recipients are configurable.

**Included:** React PWA, password-free email-code sign-in, encrypted saved profiles and invited accounts, server-enforced staff/admin permissions, transactional SQLite or Postgres database, private original and timestamped photos, finger signatures, linked returns, mileage carry-forward, representative review, signed-form PDFs, SMTP/optional Resend outbox, corrections with employee acknowledgment, audit history, CSV export, and verified local backup/restore tools.

The hosted test app is available at [fleetcheckout.app](https://fleetcheckout.app), using Vercel, a separate Free Supabase project, private Cloudflare R2 evidence storage, and Resend. See [cloud setup and recovery](docs/CLOUD-MIGRATION.md). Cloning this repository does not grant access or provision services. There are no default accounts, production seed vehicles, email recipients, or secrets. Physical iPad acceptance testing remains a separate requirement; see [verification](docs/VERIFICATION.md).

## Native iPhone and iPad app

The repository also includes a SwiftUI app in [`ios/`](ios/README.md), using the same accounts, vehicles, inspections and PDF API. Open the committed Xcode project to run it. Signed native builds are distributed through TestFlight and the App Store. Scheduled encrypted cloud backups and isolated restore checks are documented in [cloud backups](docs/CLOUD-BACKUPS.md).

## Reservations and release notices

Open **Fleet → Vehicle calendar & availability** to browse the schedule by site or vehicle. Month, Week and Agenda share the selected date. A dot marks a date with bookings. For a specific trip, open **Check availability**, enter the pickup and expected return in the workspace time zone, and select a vehicle from the results. **View results** reopens the checked interval while you browse other dates. Editing the interval or changing the filters clears those results. Booking owners and assigned managers can see reservation details and cancellation notes.

[View the iPhone calendar and availability screens](docs/images/vehicle-calendar.png)

A future booking holds its time. Physical pickup requires the usual signed checkout during the reserved period. Open the booking, then choose **Start checkout inspection**. Approval, return inspection and form delivery follow the existing trip rules. Adjacent bookings can meet at the same instant. Out-of-service vehicles, pending inspections, overlapping trips and overdue returns can restrict availability.

Open **My upcoming reservations** or a calendar entry to cancel. After confirmation, the booking releases its time and the system records who canceled it. Under **Administration → Reviewers → Reservation managers**, an administrator can assign approved staff for the fleet. When this list is empty, assigned return reviewers receive cancellation notices. A manager canceling another driver’s booking also notifies that driver. Recipients can open **Vehicle calendar → Cancellation notices** to see the notice and email status. Administrators and assigned managers can include canceled bookings in the calendar.

Calendar data refreshes on opening, returning to the screen and approximately every minute while visible. The server rechecks availability when creating a reservation or signing out a vehicle. The local SQLite migration runs at startup. On hosted PostgreSQL, apply the reservation migration to the workspace schema before releasing the clients.

Each deployed web build publishes an uncached release identifier. Open web sessions offer **Refresh now** or **Later** when a newer deployment appears. The native Fleet screen offers **Restart now** to reload workspace data, or **Later** to keep working. Inspections can be completed first. Native executable updates install through TestFlight or the App Store. Deploy the web release after the matching iOS build from `ios/project.yml` is available to testers.

## Start locally

Requires Node.js 22.13+ and npm. Use a currently supported patched Node 22 release.

```sh
npm ci
cp .env.example .env
```

Edit `.env` for local development:

```dotenv
NODE_ENV=development
HOST=127.0.0.1
PORT=3000
DATA_DIR=./data
PUBLIC_ORIGIN=http://127.0.0.1:5173
SECURE_COOKIES=false
TRUST_PROXY=0
EMAIL_PROVIDER=disabled
INITIAL_ADMIN_EMAIL=your-approved-work-email
INITIAL_ADMIN_NAME=Your Name
```

Replace the email placeholder with a real authorized administrator address. Then:

```sh
npm run setup
npm run dev
```

Setup prints a private, one-use invitation link valid for 72 hours. Open it locally, choose a password of at least 12 characters, then sign in. No invitation is emailed automatically. Treat the link as a credential. Alternatively, supply `INITIAL_ADMIN_PASSWORD` securely during setup and remove it afterward. Setup refuses to overwrite an existing administrator.

The frontend runs at [localhost:5173](http://127.0.0.1:5173), proxying its API to port 3000. Add vehicles and staff under **Administration**. A new administrator is not automatically an authorized driver: explicitly grant driver eligibility when appropriate. To use the app from an iPad, deploy it at an HTTPS address reachable by that device; the iPad's `localhost` does not refer to your server.

## Deployment and operation

- [Vercel, Supabase, R2 and the existing-data migration](docs/CLOUD-MIGRATION.md)
- [Paper-form mapping and architecture](docs/FORM-MAPPING.md)
- [Verified service limits, workplace eligibility and cost estimates](docs/COSTS.md)
- [Deployment, HTTPS, email and backups](docs/DEPLOYMENT.md)
- [Administrator and staff guide, including iPad Home Screen installation](docs/ADMIN.md)
- [Test results and remaining acceptance checks](docs/VERIFICATION.md)
- [API contract](docs/API-CONTRACT.md)

The hosted deployment uses Postgres and R2 rather than Vercel's ephemeral filesystem. Alternatively, the included Docker/Caddy deployment or an organization-managed Node server can use SQLite and local evidence storage. In local mode, SQLite and photo data must stay on the same server's persistent local disk; never use an ephemeral hosting filesystem or a network-mounted SQLite database.

## Verify changes

```sh
npm run build
npm test
npx playwright install chromium webkit
npm run test:e2e
npm run format:check
npm audit
```

Tests use isolated temporary databases and synthetic `.test` identities and photos. They do not send external email. Browser tests start their own local server on port 4173 and require a completed build. Generated evidence lives in ignored `artifacts/` and `test-results/` directories.

## Source layout

```text
src/                      React interface, photo capture, signatures and administration
public/                   PWA shell, manifest and icons (no inspection evidence)
server/app.js             HTTP application factory and middleware
server/auth.js            Invited accounts, sessions, CSRF and role checks
server/store.js            Shared database and snapshot mapping
server/migrations/        Versioned initial database schema and constraints
server/photos.js          Private uploads, validation and timestamped viewing copies
server/trips.js            Transactional checkout, return, review and corrections
server/admin.js            Audited fleet, staff, configuration and export APIs
server/reports.js          Printable forms and private photo appendix
server/notifications.js    Transactional outbox and configured email adapters
scripts/                  First administrator, consistent backups and offline restore
tests/                    API, concurrency, notification, backup and browser tests
```

Signed submissions are historical snapshots. Later mileage revisions are addenda, with renewed employee signatures; they do not rewrite the original forms or overwrite a newer trip's mileage. A return is physically recorded even when damage or review requirements keep the vehicle unavailable.

Unfinished browser forms exist only in memory. Reloading, signing out, expiry or browser eviction can clear them. Uploaded but unsubmitted evidence remains private on the server and is included in capacity accounting/backups. There is no automatic evidence deletion and no claimed reliable iPad background synchronization.
