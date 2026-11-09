# Learn4Life Fleet Checkout

A shared-server vehicle checkout and return application for staff iPads and desktop administrators. The working name, organization, site, branding, fleet, authorized drivers, inspection policy and notification recipients are configurable.

**Included:** React PWA, password-free email-code sign-in, encrypted saved profiles and invited accounts, server-enforced staff/admin permissions, transactional SQLite database, private original and timestamped photos, finger signatures, linked returns, mileage carry-forward, representative review, signed-form PDFs, SMTP/optional Resend outbox, corrections with employee acknowledgment, audit history, CSV export, and verified backup/restore tools.

**Deployment is not activated by cloning this repository.** An approved always-on host, HTTPS address, organization administrator and authorized sending service still need to be configured. There are no default accounts, production seed vehicles, email recipients, or secrets. Nothing enables a paid service automatically. Physical iPad acceptance testing is a separate requirement; see [verification](docs/VERIFICATION.md).

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

- [Paper-form mapping and architecture](docs/FORM-MAPPING.md)
- [Verified service limits, workplace eligibility and cost estimates](docs/COSTS.md)
- [Deployment, HTTPS, email and backups](docs/DEPLOYMENT.md)
- [Administrator and staff guide, including iPad Home Screen installation](docs/ADMIN.md)
- [Test results and remaining acceptance checks](docs/VERIFICATION.md)
- [API contract](docs/API-CONTRACT.md)

Production can use the included Docker/Caddy deployment or an organization-managed Node server behind an HTTPS proxy. SQLite and photo data must stay on the same server's persistent local disk; never use an ephemeral hosting filesystem or a network-mounted SQLite database. A single server is intentionally the smallest architecture, not a high-availability cluster.

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
