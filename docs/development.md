# Development and deployment

## Local development

Use Node.js 24 and run the root commands listed in the [README](../README.md). Copy `frontend/.env.example` to `frontend/.env.local` and `backend/.env.example` to `backend/.env`, then fill in the shared Supabase URL and publishable key. Complete the [authentication setup](authentication.md) before testing signup.

| Setting | Local | Render |
| --- | --- | --- |
| Frontend `VITE_API_URL` | Empty; Vite proxies `/api` to port 3000 | Backend HTTPS origin, without `/api` |
| Backend `FRONTEND_ORIGIN` | `http://localhost:5173` | Frontend HTTPS origin |
| Backend `PORT` | `3000` | Supplied by Render |

Keep actual credentials in local environment files and Render settings. Commit placeholders in `.env.example`. Restart local services after changing environment values; rebuild the frontend after changing Vite variables.

Vite listens on port 5173 on all network interfaces. For phone testing, use its printed Network URL on the same Wi-Fi. Google login and browser location on a phone need HTTPS; use the deployed site for those checks.

## Render deployment

Use the same repository and branch for both services. Set Root Directory to the folder containing the root `package.json` and lockfile, such as `dialysis-transport-app`; leave it blank if those files are at the repository root.

| Setting | Frontend Static Site | Backend Web Service |
| --- | --- | --- |
| Build | `npm ci --include=dev && npm run build --workspace frontend` | `npm ci --include=dev && npm run build --workspace backend` |
| Publish directory | `frontend/dist` | N/A |
| Start | N/A | `npm run start --workspace backend` |
| Health check | N/A | `/api/health` |

Set Node.js 24 for both builds. Supply the frontend's `VITE_SUPABASE_URL` and `VITE_SUPABASE_PUBLISHABLE_KEY`, and the backend's `SUPABASE_URL` and `SUPABASE_PUBLISHABLE_KEY`, alongside the environment settings above.

On the Static Site, add a **Rewrite** from `/*` to `/index.html` so `/auth/callback`, `/dashboard/trips`, `/dashboard/account` and `/dashboard/patients` load the application on direct visits and refresh. Configure the deployed callback in Supabase as described in [Authentication](authentication.md).

## Tests

The shared budget is approximately 70 tests across frontend, backend and database, not 70 per layer. Current source counts are 16 + 15 + 20 = 51 (including the optional concurrency test); see the README for scope and allocation. Reserve the remaining budget for unimplemented features, and replace duplicate or low-value coverage before adding cases.

Run `npm test` after installing dependencies. It runs:

- Disposable PostgreSQL tests for SQL functions, RLS, role restrictions and database updates.
- Backend HTTP tests for account requests and CORS, including actual backend startup.
- A small browser suite for login/signup, editing, driver review/availability, trips and sign-out.

Tests use fictional identities and do not connect to the hosted Supabase project. Real Google consent and Render configuration still need checking on the deployed app.

The normal database suite uses a single-session disposable engine. To verify real concurrent writes, opt into the additional integration test against a disposable **local PostgreSQL cluster** with the `anon` and `authenticated` roles already created. The local OS database user must be able to create/drop databases. Set `PG_CONCURRENCY_BIN` to an absolute `psql` executable path, `PG_CONCURRENCY_SOCKET` to its live Unix socket directory, and optionally `PG_CONCURRENCY_PORT` (default `5432`), then run:

```bash
node --test --test-name-pattern='real PostgreSQL' database/tests/accounts.test.mjs
```

This test creates and drops its own database containing fictional fixtures. It verifies actual lock waits between independent connections for overlapping inserts, stale schedule edits, edit/delete races, and stale patient-status updates. Inherited PostgreSQL connection settings are removed and TCP/remote connection targets are rejected. Without the opt-in variables, this integration test is skipped; ordinary database tests alone do not prove concurrent behavior.

Windows browser tests use Microsoft Edge. On other platforms, install Chromium with `npm exec --workspace frontend -- playwright install chromium`; Linux may need Playwright system dependencies. The test frontend uses port 5199.

## Troubleshooting

- **Google login succeeds but signup/account lookup fails:** inspect `/api/auth/me` in the browser Network panel. Check backend availability, `VITE_API_URL` and `FRONTEND_ORIGIN`. CORS must match the frontend's scheme, hostname and port; the backend normalizes trailing slashes.
- **Local `/api/auth/me` returns 401:** the local backend could not validate the saved Supabase session. The app clears it and returns to Google sign-in. If fresh login still fails, compare the frontend/backend Supabase project settings and check the backend's provider error code. Render deployments do not affect requests through the local Vite proxy.
- **Auth user exists but no account row:** the application row is created after the user submits Username and Role. A failed account lookup can block that form.
- **Account lookup unavailable on first visit:** Render's free backend service may be starting. The account panel retries automatically and shows periodic loading reminders.
- **Health reports OK but registration fails:** `/api/health` checks process liveness only. Inspect the account request and confirm the account SQL is installed in the same Supabase project used by both services.

## Patient records

The dashboard greeting uses the patient's stored full name and updates after profile edits. Coordinators use their username. Driver and caregiver greetings fall back to their username until their operational profiles provide a full name. Reapply `database/schema.sql` to include the profile name in account responses; Google identity metadata is not used for this greeting.

Apply the complete [database/schema.sql](../database/schema.sql) in the Supabase SQL Editor before using **Menu → Patients**. It is safe to reapply and preserves existing accounts and patient records. No new environment settings are needed.

Active coordinators can list patient records and update only Status and Notes. They cannot create patients or alter patient-owned personal details. The browser locks those fields, the API accepts only versioned status/notes updates, and the protected database function enforces the same restriction. Direct Data API updates are revoked. Fields are full name, contact number, street, optional unit number, six-digit postal code, mobility, Yes/No assistance requirement, optional notes (up to 1,000 characters) and coordinator-managed status. Street and postal code are required in the form. Contact entry uses one field accepting an eight-digit local number or a country code and number, such as +65 81234567. Singapore numbers require eight digits; other numbers use a basic 6–14 digit format with at most 15 digits including the country code. The combined number is stored in the existing phone column; these checks validate format, not reachability. Existing addresses are preserved as the street value; existing unit/postal/notes values default to empty until updated. Deactivation preserves the record and does not disable a Google login. Patient records do not create login accounts. New patients complete transport details in the landing signup card before their account and profile are committed together. Existing incomplete patient accounts finish in that card; completed patients edit through My Account; the same record appears in the coordinator Patients List under Patient Management. The existing database patient UUID is shown as Patient ID in the list, editor and patient My Account; it is stable, not editable and distinct from the login account ID. Ownership is unique per patient account and is assigned by the server/database. Patients cannot assign ownership, edit another patient or change profile status. Existing coordinator-created records remain unowned; attaching those records to existing accounts requires a separate verified linking flow, with no automatic name matching. Caregiver access is not implemented yet. Access is checked by NestJS and by database row-level policies. Search matches names and contact numbers case-insensitively, or a complete Patient ID. Each data-column heading cycles default → ▲ ascending → ▼ descending → default. Unselected columns show no indicator, and selecting another column clears the previous selection. Actions is not sortable. Search and sorting run on the server before pagination, with a stable ID tie-breaker. Changing either resets to page 1, and no-match results retain pagination. Records are paginated in groups of 25; the table scrolls within the desktop panel while pagination stays at its bottom, including for an empty list; failed saves retain the form. View opens a centred Patient Details modal over the dimmed list, with disabled fields beneath Patient ID: <record UUID>. It uses the same responsive overlay styling as schedule forms. Edit Patient enables only Status and Notes; Save Patient and Cancel both return to those read-only fields, and Close, Escape or a backdrop click dismisses the modal while preserving search, sort and page. Dismissal is blocked while saving; closing discards unsaved edits and restores focus to the record’s View button. The account dropdown holds the Google photo, username with its role tag, and email. My Account remains in the account dropdown and mobile bar, without a large page heading. Personal transport details appear only under My Account as disabled input fields. Edit profile unlocks the form; Cancel discards edits and locks the fields again, while Save profile persists changes and locks the updated fields on My Account. Trips shows transport information, without the personal profile, detached journey-actions panel or an Overview tab. Every active role uses the shared shell. Profile headers share a small role-and-ID line above Account Details, with Patient Details used for coordinator patient viewing. Patients use their patient record ID; the other roles use their persisted application account ID. The generic account metadata block remains coordinator-only; patients see their transport profile, and drivers/caregivers do not see the generic section.

## Implementation boundaries

Google login, account registration, initial role views, shared coordinator/patient dashboards, patient profile completion/editing and coordinator patient record management are implemented. Coordinator trip counts and trip lists remain unavailable until the operational services are connected. Patient treatment-schedule entry/editing and coordinator read access are implemented. Caregiver/driver/vehicle record management, linking legacy patient records to accounts, caregiver links, driver verification, transport scheduling/assignment, trips, recovery, notifications and live integrations remain under development.

The backend groups work into auth, profiles, scheduling, trips and integrations. Use SQL and transactions/RPCs for persistence and atomic operations. Apply server-side permissions before exposing transport data. The finalised use cases govern scope; class and dialog diagrams remain provisional. See [Use-case coverage](use-case-map.md) and [Integrations and responsive design](apis-and-responsive-design.md).

## Treatment schedules

Reapply `database/schema.sql` in Supabase SQL Editor before using the updated schedules feature. Existing entries remain recurring; earlier multi-day entries are split without losing days or changing the first entry’s UUID. Schema reruns preserve accounts, schedules and replacement links. No new environment variables are needed.

The schema also imports 45 centres from the [official NKF directory](https://nkfs.org/contact-us/dialysis-centre-locations/), checked on 20 October 2026. This is an NKF reference snapshot, not nationwide provider coverage or a service agreement. Stable imported IDs preserve references on rerun; matching manually entered names/postcodes and custom centres remain. Other verified centres can be added through Supabase Table Editor using `name`, full `address` and six-digit `postal_code`, with a generated ID.

Patients use `/dashboard/schedules`; coordinators have a read-only view. GET/POST `/api/schedules` and PATCH `/api/schedules/:id` enforce current account status and Patient ownership. Drivers and Caregivers have no access in this slice.

- **Recurring:** one weekday, time range and centre, repeating weekly between inclusive effective dates.
- **Single Session:** one specific date, time range and centre, independent of recurring entries.
- **Reschedule Session:** select a valid original occurrence of a recurring entry and save a single replacement. Its date, time or centre may differ; other weeks remain unchanged. Editing that replacement retains the same original link. A second replacement for the same original date is rejected; edit the existing replacement instead.

The replacement and original exclusion are one atomic operation: a failed save cannot remove the original session. Exclusions are derived from persisted `replaces_schedule_id`/`replaces_date` links; future Trip generation and calendar views must omit those original dates and include the replacement once. Overlap checks consider actual dates across all three cases, including weeks after an excluded occurrence. Back-to-back sessions are permitted. Changing a recurring weekday/date range cannot invalidate its linked original occurrences. Existing entry types and replacement source links are immutable; centres, times and permitted dates remain editable.

All times are Singapore local time. Only same-day sessions are supported. The application records appointments already arranged with a centre; it does not book clinical capacity or confirm transport.

Add/Edit/Reschedule uses a centred modal over the dimmed list. Cancel, Escape and backdrop clicks dismiss it when not saving, and focus returns to the opening control. Centre selection uses bounded searchable results and an always-present, read-only address field. Single sessions and recurring entries have distinct fields and labels; rescheduled dates are shown on the original entry.

Apply the schema and deploy backend/frontend together. Older requests without a type remain recurring for compatibility. Do not drop type or replacement metadata during rollback; preserve the current database checks and API semantics so an excluded original occurrence cannot silently become active again. Trip generation is available as described below; resource assignment, transport feasibility checks, calendar views, Google Calendar sync and caregiver access remain pending.


Schedule deletion uses `DELETE /api/schedules/:id` and the owner-only `delete_my_treatment` database function. Reapply the existing `database/schema.sql` before deploying this version; no direct table DELETE grant or service-role key is needed. The operation checks live account/profile ownership, serializes with schedule writes, and removes a series and its replacements atomically. Deleting a replacement revalidates the restored original session; overlap failures roll back the deletion. This currently manages treatment requirements only, since trip generation is not implemented.

Reapply `database/schema.sql` before deploying these API/frontend changes together. Patient and schedule reads now include a `version`. Patient saves and schedule edits/deletes must send the version originally read; a stale version returns HTTP 409 and keeps the draft available until the user chooses to reload. Coordinator patient edits use `save_patient(target, details)` with `details.version`; owner profile saves use `save_my_patient(details)`. Schedule edits use `update_my_treatment(target, details, expected_version)`, and deletion uses `delete_my_treatment(target, expected_version)`. Authenticated direct table UPDATE is revoked for both tables so clients cannot bypass version checks. Inserts remain protected by ownership and database validation. Replacement insert/edit/removal also changes the parent version.

`GET /api/schedules?page=1&search=...` now calls the RLS-respecting `list_treatments` function. Search is applied before pagination (10 records per page); the response includes `total`, `page`, `pageSize` and the related schedule `context` needed for exception counts, history and editing across pages. Search supports the existing centre/day/date/type fields, plus patient name/ID for coordinators. Sorting remains effective start date, then schedule ID.

New or updated treatment dates must be within AD 0001-01-01 through 9999-12-31, and the selected weekday must occur within the date range. The database enforces these rules even for direct inserts. Date/occurrence constraints use `NOT VALID` during upgrade to preserve existing records; they still enforce every new insert/update. Any historical invalid records require explicit correction rather than automatic deletion. The list displays unsupported legacy dates as “Invalid date” instead of failing to render. Keep these constraints, version columns and protected write functions when rolling back application code; old clients without versions must reload/update rather than silently overwrite newer data.

For every new dashboard page, follow the shared page/overlay format in [Integrations and responsive design](apis-and-responsive-design.md#dashboard-page-and-overlay-format).


## Initial trip generation

Reapply `database/schema.sql` and deploy the backend/frontend together. This adds RLS-protected `trips` and `trip_history` tables, `generate_treatment_trips(target, from_date, until_date, expected_version)` and `list_trips(page_no, from_date, until_date, status_filter, search_text, direction_filter)`. No service-role key is required. Authenticated direct INSERT/UPDATE/DELETE on operational tables is revoked. Source UUIDs are retained as history even after a treatment schedule is deleted.

`POST /api/trips/generate` accepts only `schedule_id`, `from_date`, `until_date` and the source `version`; active Coordinators only. Windows are inclusive, future and no longer than 90 days. Generation locks Patient → Schedule → Trips, rechecks the source version and creates/refreshes snapshots atomically. A unique root-occurrence/direction key prevents duplicate pairs, including concurrent identical requests. The response reports `created`, `updated` (including restored journeys), `unchanged`, `skipped` (retained as zero for response compatibility) and `total`. Recurring generation excludes replaced originals and includes replacements whose actual dates fall in the chosen range. Already-started sessions are skipped. Buffer overflow beyond the supported year range is rejected.

`GET /api/trips` accepts `page`, `from`, `until`, `status`, `search` and `direction`; the default starts on Singapore today with no end date. Omit `until` or send an empty value for an open-ended view (`until_date=NULL` in the database). An explicit end date must be on or after the start; list views have no 90-day span cap. Trip generation remains limited to 90 days. Date, direction and literal, case-insensitive search filtering precede status filtering and pagination (25 journeys/page). Search covers route/centre text, weekday, date, times, journey direction, status, pickup-pending/review labels, plus patient name/ID for Coordinators. Search is limited to 100 characters. Counts reflect the active date/search/direction scope before status filtering; Next pickup remains independent of list filters. The response includes `trips`, `total`, `page`, `pageSize`, range-scoped category `counts` and the next authorized pending journey independently of the selected list window. Active Patients read only owned active-profile trips; active Coordinators read permitted operational trips. Drivers and Caregivers are denied until their assignment/link access is implemented.

Each session produces two Unfilled journeys. Outbound `arrival_by` is treatment start minus 15 minutes; return `pickup_not_before` is treatment end plus 15 minutes, in `Asia/Singapore`. `pickup_at` remains null and no Driver/Vehicle assignment is claimed. Operational risk, confirmation, cancellation, tracking and calendars remain separate future changes.

Requirement changes mark affected current/future unfilled journeys `review_required` and append history. Regeneration refreshes matching journey snapshots and clears that flag; it does not silently delete old journeys whose occurrences no longer exist. Those remain for explicit coordinator review until cancellation/recovery is implemented. Return journeys remain pending through their Singapore pickup-ready day, including the treatment-end buffer. Database tests cover buffers, recurrence exceptions, retries, source/profile changes, private history and pagination. The opt-in PostgreSQL concurrency test also verifies concurrent generation and generation/source-edit races.


Coordinator **Delete Trip** removes one unassigned journey from normal lists, counts and next pickup. `DELETE /api/trips/:id` requires exactly `{version}` and calls `delete_trip(target, expected_version)`. It checks the active coordinator role, locks Patient → Trip, verifies the current version, records `deleted_at` and a durable `deleted` history event. The row and its unique occurrence key remain for audit. Explicitly generating the same future session restores deleted journeys using their existing IDs and current treatment/patient details, clears `deleted_at`, increments their versions and records a `restored` history event alongside the original deletion. Unchanged surviving journeys remain untouched, and repeated generation creates no duplicates. Reapply `database/schema.sql` to enable restoration in an existing database. Patients cannot delete trips; direct table writes remain revoked. Source/profile changes and generation refreshes increment trip versions, so a stale delete returns HTTP 409 with an explicit reload action. This does not alter the treatment schedule or automatically delete the other journey in the session.

## Driver vehicle registration

Apply the full `database/schema.sql` in Supabase before deploying the vehicle-registration screens/API. No mock records are changed automatically. Existing personal Driver profiles remain intact; vehicle registration is stored separately in `driver_vehicles`, with one current vehicle per Driver and unique normalised plates. Account active/inactive status continues to govern login. Registration status is Pending review, Approved or Rejected; no vehicle row means Not submitted. Drivers complete personal signup first and enter Register Vehicle at `/dashboard/vehicle`; coordinators manage submissions at `/dashboard/drivers`.

Owner submission and coordinator review run through narrow database functions using the caller’s JWT. Direct vehicle writes are revoked, RLS limits reads to the owner and active coordinators, and internal submission/review snapshots are retained. Version checks reject stale decisions; rejection needs a reason, and changes to Approved/Rejected submissions return to Pending review. Review is simulated for this school project, with no document uploads. Availability, trip assignments and driving actions remain outside this milestone. See [Authentication](authentication.md#vehicle-registration) for fields, review flow and endpoints.


## Driver availability

Reapply `database/schema.sql` before deploying the backend/frontend together. The new `driver_availability` table and `get_my_availability` / `save_my_availability` RPCs use the signed-in identity; no service-role key or environment changes are needed. Existing accounts, vehicles and schedules are preserved. Availability starts empty, with no times assumed available.

Drivers open `/dashboard/availability`. Only active drivers with an approved vehicle can read or save their own availability; both the backend and database enforce this. The page shows an approval-required state for pending, rejected or missing vehicle registrations. Resubmitting a vehicle preserves saved availability but blocks access until approval is restored. Coordinators and other roles cannot use these endpoints.

`GET /api/drivers/me/availability` returns `{ eligible, availability }`. `PATCH` accepts only `{ weekly_slots, version }` and atomically saves the whole schedule. Version `0` creates the first record; later saves send the version read, with HTTP 409 on stale versions. Availability writes lock the account and vehicle consistently with registration/review to prevent approval changes during a save. Authenticated direct table writes are revoked; owner-only reads use RLS.

All slots represent Singapore local time. Weekly integer keys `0..335` encode Monday through Sunday, 48 half-hour slots per day (`weekday_index * 48 + half_hour_index`). Unselected slots are unavailable. The compact grid shows 05:00–24:00 with 24px rows, green selected slots and a weekly hours total. Today’s Singapore weekday is highlighted; a live time line crosses the grid during the visible time range and updates every 15 seconds. On phones, a day-by-day list replaces the grid and highlights today’s heading. No full-day toggle or instruction paragraphs are shown. Existing stored slots outside this view are preserved. Desktop supports mouse dragging and keyboard arrows/Space; mobile lists contiguous available ranges for all seven days. On mobile, Edit availability opens a day-selection overlay; Continue opens that day’s From/To editor with Add/Remove controls. Save availability persists the selected day while preserving other days, and Cancel discards the editor changes. Desktop retains its existing grid draft and Save/Cancel flow. Overlapping or reversed ranges are rejected, and adjacent ranges merge automatically. New mobile ranges use the same 05:00–24:00 window as desktop and preserve other days; earlier stored ranges remain visible and removable. Each mobile day is a compact horizontal row with scrollable time ranges and no dividers. Mobile rows use a 104px day column and compact 48px row height, with no per-row action controls. A divider sits below the mobile weekly summary, and the plain Edit availability button sits below the list at the bottom right. Existing desktop drafts retain Save/Cancel controls if the viewport switches to mobile. Edits stay in a draft until Save availability; Cancel restores the saved schedule.

Only selected green weekly slots indicate availability; all unselected slots are unavailable. Date exceptions are removed from the UI, API and database. Reapplying the schema removes the retired exceptions column and three-argument save RPC while preserving weekly slots and versions. Deploy backend/frontend with the updated schema together.

Trip assignment, matching and coordinator availability views are outside this milestone. Future matching must use weekly slots and recheck current driver/vehicle eligibility. For application rollback, disable the availability route while preserving its table and protected functions; do not delete saved schedules.


### Driver vehicle navigation after approval

Reapply `database/schema.sql` for `driver_vehicles.registered_at`. The migration fills the most recent approval from the current approved row or existing private audit snapshots, including vehicles awaiting reapproval. New approvals set this timestamp; resubmissions and rejections retain it. No mock account updates are required.

Before first approval, Driver navigation contains Register Vehicle. Following approval it contains Availability, then My Vehicle, with Availability as the default landing page. The vehicle route stays `/dashboard/vehicle` for existing bookmarks. My Vehicle includes the current vehicle/licence fields, status, submitted date and current approval date (a dash until the current submission is approved), with the existing Edit registration and confirmation flow. My Vehicle stays visible during reapproval, while availability still requires the vehicle's current status to be approved. Ride totals and ratings are not part of this page.


### Driver personal account editing

Reapply `database/schema.sql` for the `drivers.version` column and protected `update_my_driver(details, expected_version)` function. Deploy backend and frontend together. Existing profiles start at version 1. `GET /api/profiles/driver` includes the current version; `PATCH` with that version updates only the signed-in active Driver's full name, phone, birth date and gender. Stale saves return HTTP 409. Both database and backend enforce ownership and allowed fields; direct table writes remain revoked. Signup and legacy-profile completion still use `save_my_driver` without a version and cannot overwrite an existing profile.

The Account Details page uses the shared Account Management subheader and Edit profile/Save profile/Cancel controls. Failed saves keep the draft and show a shared viewport toast; conflicts require reloading. Saving disables controls and completing/cancelling restores focus to Edit profile. Personal edits do not reset vehicle registration, approval, or availability. Account status, role, username and verified email remain outside this personal-details form.


### Coordinator driver availability popup

Reapply `database/schema.sql` before deploying the backend/frontend together. The migration adds `get_driver_availability(target)` and extends availability SELECT RLS to active Coordinators; direct writes remain revoked. `GET /api/drivers/:id/availability` is active-Coordinator-only and validates the target Driver account ID. Patients, Caregivers and Drivers cannot use this coordinator endpoint. Missing Driver accounts return 404. Active Drivers retain their existing owned availability endpoint and approval checks.

Each Driver List row has Schedule, Car and Info icons in that order. Schedule opens a centred read-only Weekly Availability popup, reusing the same grid on desktop and compact day/range list on phones. The view loads current saved slots and includes weekly hours. Missing schedules show No availability set; service failures have a retry action. Saved schedules remain inspectable for inactive Drivers and vehicles awaiting reapproval, with an ineligibility note. This does not make those drivers assignable or permit Coordinator edits. Focus returns to the schedule button after dismissal.

`WeeklyAvailabilityView` shares rendering, time formatting, Singapore clock and weekly slot grouping between the driver's editor and coordinator inspection. The popup is an individual reference view. A filtered driver list or daily timeline during future trip assignment remains separate work; no assignment or combined-driver calendar is included here.


### Optional mock drivers

After applying `database/schema.sql`, run `database/seed.sql` in Supabase SQL Editor as project owner to add three fictional Driver records. These are app records without Auth identities or usable Google logins. All contact, demographic, licence and vehicle information is fictional, even though the display names are familiar. Existing Drivers, including Charles Leclerc, remain unchanged. The script is transactional and rerunnable: existing demo emails are skipped, preserving edits; a collision with a linked/non-Driver account aborts the operation.

The mock vehicles are approved using an existing active Coordinator as the review reference; their audit snapshots include `mock_seed: true`. No coordinator account is created or changed. Different capacity, accessibility and Singapore-time availability provide assignment fixtures:

| Driver | Vehicle | Capacity | Wheelchair accessible | Weekly availability |
| --- | --- | ---: | --- | --- |
| Max Verstappen | Honda Fit | 3 | No | Mon–Fri, 08:00–14:00 (30h) |
| Lewis Hamilton | Mercedes-Benz Vito | 6 | Yes | Mon/Wed/Fri, 10:00–18:00 (24h) |
| Lando Norris | Perodua Myvi | 4 | No | Tue/Thu/Sat, 16:00–22:00 (18h) |

These are optional demo records, not part of schema reapplication or automatic application startup. The final SELECT displays only the seeded demo drivers for inspection. It does not simulate overlapping trip assignments, since assignment is not implemented yet.


### Schedule trip-generation indicators

Reapply `database/schema.sql` before deploying this frontend. Coordinator schedule rows include a Trips indicator calculated by the protected, RLS-respecting `private.treatment_trip_coverage` helper through the existing `list_treatments` response. Patient responses omit this metadata, and the helper rejects non-Coordinators. No new environment variables or backend endpoints are needed.

Coverage examines a bounded 90-day window starting from today or the relevant future schedule start, including earlier upcoming replacements. Both outbound and return journeys must be present, undeleted and current for a session to count as covered. Current source/patient versions, times, source IDs and review flags are checked; Unfilled still counts as generated because assignment is a separate workflow. Replaced original occurrences are excluded, and their replacement sessions are checked once.

Rows show Not generated, Partially generated, Generated, or No upcoming sessions. Missing coverage metadata shows Coverage unavailable, never Not generated. The through date ends before the first uncovered session, so later generated trips cannot conceal an earlier gap. The Generate Trips overlay shows a Trips already generated section with actual start/end dates for each complete run of upcoming sessions, splitting ranges at gaps; the tooltip identifies the checked date window. Expired/already-started sessions are excluded, consistent with generation. Existing trips requiring refresh make coverage partial rather than falsely complete. Deleted journeys count as missing until a coordinator explicitly generates their session again; manual generation restores them. When opted in, the daily refill preserves deleted journeys; only explicit manual generation restores them.

Successful generation reloads the current schedule list without changing its search, filters, sorting or page. The added Trips column is coordinator-only; patient row layout remains unchanged. This indicator concerns generated journeys only and does not claim that a driver has been assigned or that transport is confirmed.

Trip filter Reset restores today onwards with an empty optional Until date. The UI omits the end-date query parameter when blank, and changing From date preserves the blank end. Existing pagination, ownership, search and category counts apply to the complete future range. Reapply `database/schema.sql` when deploying the updated nullable-end list API.

### Automatic trip generation

In the coordinator's Generate Trips popup, **Auto-generate trips** defaults off for every existing or new treatment schedule. Checkbox changes remain a draft until the adjacent Save button is pressed; Close discards an unsaved change. Enabling it atomically fills Singapore today through today + 29 days inclusive; manual generation remains available with its existing 90-day maximum range. Turning it off keeps existing journeys. Rescheduled sessions inherit their original recurring schedule's setting, including replacements moved beyond the original end date. Manage the setting on the original schedule, not on an individual replacement.

Preferences live in RLS-protected `treatment_trip_generation`, with their own concurrency version so coordinator changes never change the patient's treatment version or invalidate current trip snapshots. `PATCH /api/schedules/:id/auto-generation` accepts exactly `{enabled, version, setting_version}`; active coordinators only. Both the schedule version and preference version are checked. Missing preferences mean off/version 0. Patients cannot read or change preferences or supply them during signup/schedule creation.

Automatic calls use the same locked generation core as manual calls, with deleted-journey restoration disabled. They require an active patient profile and account, stop when no upcoming source or replacement is in the window, and preserve unique occurrence/direction keys and audit history. A failed schedule rolls back its generated changes without blocking other schedules. `last_run_at` records successful attempts and `last_error` records an error code without patient details; the popup flags failed runs. The database-only runner and internal generation function are not executable by browser roles.

**Supabase setup:** Enable the **Cron** module (`pg_cron`) under **Integrations**, then reapply `database/schema.sql` as the project owner. The schema registers the named job `dialysis-automatic-trips` at `5 16 * * *` (00:05 Singapore daily). Reapplying updates the same job rather than adding another. If Cron is not installed, the schema emits a notice and skips job registration; immediate enabling and manual generation still work, but there is no daily refill until Cron is enabled and the schema is reapplied. No app server timer, HTTP callback or service-role secret is required. See the [Supabase Cron installation guide](https://supabase.com/docs/guides/cron/install) and [job scheduling guide](https://supabase.com/docs/guides/cron/quickstart).

Inspect the named job and its History under Supabase Cron. The project owner can also invoke `select private.run_automatic_trip_generation();` to refill opted-in schedules immediately; it returns processed/failed schedule counts. Do not grant this function to client roles. To suspend all background generation, deactivate this named job in Cron; existing trips and per-schedule settings remain. Deactivate the job before rolling back to a schema that lacks its runner. To resume, reactivate it; switching individual preferences off is the per-patient alternative. This change has not been applied to the hosted database by the agent.
