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

Run `npm test` after installing dependencies. It runs:

- Disposable PostgreSQL tests for SQL functions, RLS, role restrictions and database updates.
- Backend HTTP tests for account requests and CORS, including actual backend startup.
- Browser tests for Google callback handling, signup, role views, errors and sign-out.

Tests use fictional identities and do not connect to the hosted Supabase project. Real Google consent and Render configuration still need checking on the deployed app.

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

Active coordinators can list patient records and update only Status and Notes. They cannot create patients or alter patient-owned personal details. The browser locks those fields, the API accepts only status/notes updates, and database column privileges enforce the same restriction, including direct Data API requests. Fields are full name, contact number, street, optional unit number, six-digit postal code, mobility, Yes/No assistance requirement, optional notes (up to 1,000 characters) and coordinator-managed status. Street and postal code are required in the form. Contact entry uses one field accepting an eight-digit local number or a country code and number, such as +65 81234567. Singapore numbers require eight digits; other numbers use a basic 6–14 digit format with at most 15 digits including the country code. The combined number is stored in the existing phone column; these checks validate format, not reachability. Existing addresses are preserved as the street value; existing unit/postal/notes values default to empty until updated. Deactivation preserves the record and does not disable a Google login. Patient records do not create login accounts. New patients complete transport details in the landing signup card before their account and profile are committed together. Existing incomplete patient accounts finish in that card; completed patients edit through My Account; the same record appears in the coordinator Patients List under Patient Management. The existing database patient UUID is shown as Patient ID in the list, editor and patient My Account; it is stable, not editable and distinct from the login account ID. Ownership is unique per patient account and is assigned by the server/database. Patients cannot assign ownership, edit another patient or change profile status. Existing coordinator-created records remain unowned; attaching those records to existing accounts requires a separate verified linking flow, with no automatic name matching. Caregiver access is not implemented yet. Access is checked by NestJS and by database row-level policies. Search matches names and contact numbers case-insensitively, or a complete Patient ID. Each data-column heading cycles default → ▲ ascending → ▼ descending → default. Unselected columns show no indicator, and selecting another column clears the previous selection. Actions is not sortable. Search and sorting run on the server before pagination, with a stable ID tie-breaker. Changing either resets to page 1, and no-match results retain pagination. Records are paginated in groups of 25; the table scrolls within the desktop panel while pagination stays at its bottom, including for an empty list; failed saves retain the form. View opens a centred Patient Details modal over the dimmed list, with disabled fields beneath Patient ID: <record UUID>. It uses the same responsive overlay styling as schedule forms. Edit Patient enables only Status and Notes; Save Patient and Cancel both return to those read-only fields, and Close, Escape or a backdrop click dismisses the modal while preserving search, sort and page. Dismissal is blocked while saving; closing discards unsaved edits and restores focus to the record’s View button. The account dropdown holds the Google photo, username with its role tag, and email. My Account remains in the account dropdown and mobile bar, without a large page heading. Personal transport details appear only under My Account as disabled input fields. Edit profile unlocks the form; Cancel discards edits and locks the fields again, while Save profile persists changes and locks the updated fields on My Account. Trips shows transport information, without the personal profile, detached journey-actions panel or an Overview tab. Every active role uses the shared shell. Profile headers share a small role-and-ID line above Account Details, with Patient Details used for coordinator patient viewing. Patients use their patient record ID; the other roles use their persisted application account ID. The generic account metadata block remains coordinator-only; patients see their transport profile, and drivers/caregivers do not see the generic section.

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

Apply the schema and deploy backend/frontend together. Older requests without a type remain recurring for compatibility. Do not drop type or replacement metadata during rollback; preserve the current database checks and API semantics so an excluded original occurrence cannot silently become active again. Trip generation, transport feasibility checks, calendar views, Google Calendar sync and caregiver access remain pending.
