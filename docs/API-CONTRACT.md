# Internal API contract

All JSON camelCase. API returns JSON errors `{error: string}` with appropriate status. Cookie authentication, CSRF header `X-CSRF-Token` required for mutations after login, same origin enforced. Idempotency header `Idempotency-Key` required on final submissions. Frontend uses credentials same-origin. Images are authenticated same-origin URLs. Empty data is normal; no production seed passwords or invented addresses.

- `POST /api/auth/request-code {email}` -> `{challengeId,expiresInSeconds}`. Sends a six-digit code; 10-minute expiry, five guesses, one use, one-minute resend delay and IP limits. Requires configured email sender.
- `POST /api/auth/verify-code {challengeId,code}` -> `{user,csrfToken,settings}`. Unknown verified emails create staff accounts with driver authorization disabled.
- `PATCH /api/auth/profile {name,email,charter,department?,manager}` -> updated session. Authenticated, CSRF protected; email must match the signed-in account. Cannot change role or eligibility.
- `POST /api/auth/login {email,password}` -> `{user,csrfToken,settings}`
- `GET /api/auth/me` -> `{user,csrfToken,settings}`; 401 if expired
- `POST /api/auth/logout` -> 204
- `POST /api/auth/accept-invite {token,password}` -> success, then sign in
- `GET /api/vehicles` -> `{vehicles}`; `GET /api/trips` -> `{trips}` scoped to current staff or all for administrator
- `GET /api/trips/:id` -> `{trip,photos,reviews,revisions,notifications}`
- `POST /api/photos` multipart `file,vehicleId,stage,view,draftId,deviceCapturedAt,source,tripId?` -> `{photo}`; source `camera` or `upload`; view `front,rear,driver,passenger,windshield,interior,odometer,receipt,wheels,damage,other`; `stage` checkout or return. Same draftId UUID groups temporary photo uploads. Originals preserved, separate stamped display JPEG. Required view uniqueness and hash replay prevention per stage. Finalizations only accept owned uploaded photos from same vehicle/stage/draft.
- `GET /api/photos/:id?original=1` private download, default stamped view
- `POST /api/trips/checkout {vehicleId,draftId,projectedReturnAt,startingMileage,mileageConfirmed,inspection,photoIds,signature,acknowledgments}` -> `{trip}`
- `POST /api/trips/:id/return {draftId,endingMileage,inspection,photoIds,signature,acknowledgments}` -> `{trip}`
- `GET /api/trips/:id/report?stage=checkout|return` -> PDF; return includes both sections
- `POST /api/trips/:id/review {stage,initials,signature,decision,reason}` admin signature review; decision `approve` or `out_of_service`
- `POST /api/trips/:id/corrections {field,value,reason,odometerReplacement?}` admin appends revision. Fields `startingMileage,endingMileage`; no alteration of signed original or blind old-trip overwrite. Require employee acknowledgment for material revisions via `POST /api/trips/:id/revisions/:revisionId/acknowledge {signature}`.
- `POST /api/vehicles/:id/discrepancy {observedMileage,reason}` locks available vehicle for review; does not edit accepted mileage
- `GET /api/admin/overview` -> `{users,notifications,audit,storage:{bytes,limitBytes},settings}`
- `POST /api/admin/vehicles` and `PATCH /api/admin/vehicles/:id` vehicle fields and required `reason` for edits; `archived` boolean
- `POST /api/admin/users` -> `{user,inviteToken}` (admin securely shares invite; never automatic external message); `PATCH /api/admin/users/:id` with reason. Email verification can create an unapproved staff account; only administrators grant driver eligibility. Fields email,name,charter,department,manager,role,authorizedDriver,active.
- `PATCH /api/admin/settings { ...settings,reason }` -> `{settings}`
- `POST /api/admin/notifications/:id/retry` -> notification state; retry failed only, explicit resend accepted requires `{resend:true,reason}`
- `GET /api/admin/export.csv` -> trip CSV

User: `{id,email,name,department,manager,role:'staff'|'admin',authorizedDriver,active}`.

Vehicle: `{id,name,make,model,year,plate,vinLast4,site,currentMileage,status:'available'|'checked_out'|'pending_review'|'out_of_service',photoUrl,notes,archived}`.

Trip: `{id,vehicleId,employeeId,status:'pending_checkout'|'active'|'returned'|'cancelled',checkoutAt,projectedReturnAt,returnedAt,startingMileage,endingMileage,tripMileage,employeeSnapshot,vehicleSnapshot,checkoutInspection,returnInspection,checkoutSignature,returnSignature,flags: string[],overdue}`.

Inspection: `{fuelFull:boolean,interiorClean:boolean,gasCard:boolean,receiptReceived?:boolean,keyReturned?:boolean,windshield:'clear'|'star'|'cracked',damage:[{area:'front'|'rear'|'driver'|'passenger'|'roof'|'interior'|'windshield'|'wheels',type:'chip'|'dent'|'scratch',notes:string}],notes:string}`. Representative initials/signatures are separate authenticated reviews, shown as not applicable in self-service and pending until signed in review mode. Never self-sign for representative.

Signature is PNG data URL from finger canvas; acknowledgment shape `{accurate:true,noEating:true,removeBelongings:true,fullTank:true}` required on checkout; return requires accurate plus fullTank/removeBelongings (UI may send all four).

Settings: `{appName,organizationName,site,timezone,accentColor,logoUrl,notificationRecipients:string[],employeeCopy:boolean,reviewMode:'self_service'|'representative',allowPhotoImports:boolean,largeMileageThreshold:number,storageLimitBytes:number,retentionDays:number,sessionMinutes:number}`. Default timezone America/Los_Angeles, name Learn4Life Fleet Checkout, no invented recipients. Retention is policy only, no automatic deletion. Four required exterior views are always required.

Photo: `{id,vehicleId,employeeId,tripId,stage,view,deviceCapturedAt,receivedAt,source,url,originalUrl,bytes}`. Return photos cannot reference checkout photos. Out-of-service issues on physical return set vehicle pending_review while trip is returned; separate admin review controls release.

## Implemented additions

- `GET /api/public-settings`: public branding only; no staff directory or recipients.
- `GET /manifest.webmanifest`: configurable public install name and theme.
- `GET /api/health`: database availability check.
- `POST /api/admin/vehicle-images`: private identification-photo upload; multipart `file,vehicleId,reason`.
- `POST /api/admin/users/:id/invite {reason}`: rotate one-use invitation and revoke existing sessions.
- `POST /api/trips/:id/odometer-replacement {oldReading,newReading,reason}`: administrator records one replacement on an active trip. Return must include the exact `odometerReplacementId` and `odometerReplacementAcknowledged:true`. Distance includes both odometers; the ending reading may be lower than the original checkout only with this documented exception.
- A declined pending checkout becomes `cancelled`, preserves its inspection and has no invented physical-return timestamp.
- Notifications can be `awaiting_review,pending,processing,failed,unknown,accepted,delivered`. Required representative review defers sending. `delivered` is reserved; no delivery webhook is currently integrated. Unknown/accepted resends require an explicit reason.
- The administrator overview also includes archived vehicles and actual disk usage. The configured limit is enforced against photo bytes, with reports/database requiring additional headroom.
- Department and manager must be configured by an administrator before final checkout.

Return inspections with `damageScope: "new"` contain only new/worsening damage. The immutable checkout inspection is the read-only baseline, displayed alongside new marks and included on the return PDF. Legacy inspections without this field retain their original all-damage semantics. Checkout rejects new-only scope.
