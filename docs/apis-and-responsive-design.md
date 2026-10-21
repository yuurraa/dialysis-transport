# APIs and responsive design

The integration adapters define endpoints and contracts but are not implemented. Configure their backend credentials when implementing each integration.

## Responsive web application

Use one React application across phone, tablet and desktop browsers. Patient, caregiver and driver views prioritise stacked cards, next pickup and large actions. The coordinator view uses a wider desktop workspace, adapting to cards on smaller screens. Roles determine access; screen width only changes presentation.

`PageLayout` contains the public landing page. The coordinator dashboard has a separate fluid workspace with its own navigation and account page. Both use responsive spacing. Use compact layouts for personal views and wider layouts for coordinator workflows. Keep text at least 16px, controls at least 44px tall, visible keyboard focus, and readable status labels. Dialogs and maps must fit the viewport. No separate mobile app, desktop app or PWA is needed for this scope.

## OneMap

| Purpose | Endpoint |
| --- | --- |
| Obtain token | `POST https://www.onemap.gov.sg/api/auth/post/getToken` |
| Resolve address/postal code | `GET https://www.onemap.gov.sg/api/common/elastic/search` |
| Baseline driving route | `GET https://www.onemap.gov.sg/api/public/routingsvc/route` |

Register an account and set backend-only `ONEMAP_EMAIL` and `ONEMAP_PASSWORD`. Search and routing use the returned token in `Authorization`. Tokens expire after three days; use the supplied Unix expiry. Search can return an error inside HTTP 200, so validate the body.

Search requests include `searchVal`, `returnGeom=Y`, `getAddrDetails=Y` and `pageNum`. Driving routes use WGS84 `start=latitude,longitude`, `end=latitude,longitude`, `routeType=drive`; normalise `route_geometry`, `total_distance` and `total_time` to the service contract. Traffic adjustment belongs in trip assessment.

For later map rendering, use OneMap's `https://www.onemap.gov.sg/maps/tiles/Default/{z}/{x}/{y}.png` with Leaflet and retain the required OneMap logo and SLA attribution. Basemap tiles do not need API tokens. The map library/component has not been added yet.

Sources: [Authentication](https://www.onemap.gov.sg/apidocs/authentication), [Search token handling](https://www.onemap.gov.sg/apidocs/docs/verifyingsearchapitoken), [Routing](https://www.onemap.gov.sg/apidocs/routing), [Basemap](https://www.onemap.gov.sg/docs/maps/index.html).

## LTA DataMall

Use `TrafficIncidents` and **`v4/TrafficSpeedBands`**, under `https://datamall2.mytransport.sg/ltaodataservice/`. The current user guide is version 6.10, dated 1 October 2026. Register for API access and supply backend-only `LTA_ACCOUNT_KEY` as the `AccountKey` header.

Responses contain `value` arrays. Retrieve complete feeds with 500-record pages and `$skip`. Incidents update about every two minutes, speed bands every five minutes; cache centrally and record freshness. Match observations to the route before adjusting ETA. These feeds do not provide a complete patient-trip ETA. OneMap and traffic assessment must share the five-second response budget; do not fetch an entire traffic feed for every browser viewer.

Source: [Official LTA API user guide, sections 1, 2.18 and 2.19](https://datamall.lta.gov.sg/content/dam/datamall/datasets/LTA_DataMall_API_User_Guide.pdf).

## Google Calendar

Calendar connection is optional and distinct from Supabase login. Enable the Calendar API in a Google Cloud project, configure a web OAuth client and test users, and set backend-only `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` and `GOOGLE_CALENDAR_REDIRECT_URI`. The example callback URL reserves a future route; it is not available yet.

Request `calendar.events.owned` for each recipient's own primary calendar. Bind expiring OAuth state to the authenticated user; validate it before exchanging the code. Request offline access and securely store each user's refresh token for later schedule changes. A Google login alone does not grant Calendar access.

Create pickup events with `POST`, update with `PUT`, and remove with `DELETE` under `https://www.googleapis.com/calendar/v3/calendars/primary/events`. Use recipient tokens, RFC3339 start/end times, `Asia/Singapore` and popup reminder overrides. Store event IDs and sync status. Check trip access and stored event ownership; never include treatment details. Calendar failure must not undo a successful trip change.

Sources: [Scopes](https://developers.google.com/workspace/calendar/api/auth), [Web OAuth](https://developers.google.com/identity/protocols/oauth2/web-server), [Insert](https://developers.google.com/workspace/calendar/api/v3/reference/events/insert), [Update](https://developers.google.com/workspace/calendar/api/v3/reference/events/update), [Delete](https://developers.google.com/workspace/calendar/api/v3/reference/events/delete).

## Driver location

Location comes from the driver's browser, not OneMap or LTA. `watchDriverLocation` is a small browser boundary: it requires a secure context and permission, returns coordinate/accuracy/time updates and supplies a cleanup function. It is not wired into trip pages or backend reporting yet.

Start only on the assigned active trip after an explicit driver action. Stop on trip end, cancellation, sign-out or leaving the view. Backend authorisation remains required. Browser updates are limited to active, visible documents; do not promise background or locked-phone tracking. If updates stop, display the last-update time and stale-location state.

A phone opening a local development server by LAN IP will need HTTPS for geolocation; desktop localhost is suitable for local testing. Production requires HTTPS.

Sources: [Geolocation standard](https://www.w3.org/TR/geolocation/), [Browser API](https://developer.mozilla.org/en-US/docs/Web/API/Geolocation/watchPosition).


## Dashboard page and overlay format

New dashboard screens must reuse `PageHeading` and `Overlay` from `frontend/src/components/DashboardUI.tsx` and the theme tokens in `frontend/src/styles.css`. Keep one clear page title first, with its optional subheader underneath, and one primary action; use section headings below it. Page subheaders use readable sentence case and muted text; operational headings use the shared sans-serif family and account metadata retains the shared description style. Patient search hints consistently use “Patient name” and “ID”: “Patient name, phone or ID” for the patient list. Coordinator schedule search uses “Patient or schedule details”, with the supported fields listed in its tooltip. Search guidance may specify a full patient ID where required. Patient search actions reserve enough width for the complete search hint and wrap below the heading on narrow screens. Do not duplicate the page name in an eyebrow. Use the shared primary, secondary and destructive control styles rather than adding page-specific button palettes or radii. Action groups use primary first, Cancel/Close next, and Delete last in both visual and keyboard order. Paired actions have equal widths; the Delete shortcut remains compact. Preserve Previous/Next order for pagination and the existing Next/Sign Up, Back, Cancel sequence for signup.

List pages use open layouts with headings and thin record separators, without outer card frames. Short desktop lists end naturally; long desktop lists retain a named, keyboard-focusable bounded scroll region and visible pagination. At 760px and below, lists use natural page scrolling with pagination after the records. Patient tables become stacked name-first records on phones, with visible contact, mobility, status and Info controls; the full ID remains in Patient Details. A mobile sort selector preserves every desktop column sort and newest-record ordering. The desktop header shows Singapore date/time before the theme control. Mobile prioritises the page title and hamburger, theme, notification and account controls; the live clock is hidden on phones.

Use an `Overlay` for add, edit, detail and confirmation flows that can preserve the current page. Its header/close button and action footer remain visible; only the body scrolls. The shared component handles native modal semantics, Escape/backdrop dismissal, focus containment/restoration and background scroll locking. Pass `busy` during mutations to prevent dismissal or duplicate submission; retain inputs on failure. Supply footer actions and an optional `onSubmit` rather than embedding another form. Test with long data at desktop and phone widths, a short viewport and enlarged text.

Treatment schedules use one Edit action. For recurring entries, **Apply changes to** distinguishes the entire series from one occurrence. The editor keeps the same responsive height and Save/Cancel/Delete slots in both modes. Delete always removes the entire selected schedule (including its replacements for a recurring series), and its confirmation states this scope explicitly; it does not cancel only the selected unchanged occurrence. One-session editing lists actual dates on the recurring weekday and excludes already replaced occurrences. Series longer than 52 occurrences use a month filter, so any supported year remains reachable without rendering an unbounded list. The selected original session and new date are adjacent; the new date follows the selected session until the user explicitly changes it. Existing schedules do not show a redundant disabled schedule-type control. Single entries display their weekday and date; recurring entries display “Every [weekday]” and a labelled date range. The centre address uses the existing read-only field appearance. Delete is a secondary text action on desktop and a compact, labelled trash control on mobile; Footer actions follow reading order: Save Schedule, Cancel, then Delete. Save and Cancel use equal widths on desktop and mobile; Delete stays compact. Schedule deletion is confirmed inside the same overlay. Deleting a series removes its linked replacements; deleting a replacement restores the original occurrence only if it does not conflict with another session. Treatment deletion does not cancel transport trips.


Overlay mutation errors use the shared `error` / `onDismissError` toast rather than an error paragraph at the bottom of a long form. The toast lives inside the native modal so it remains visible and interactive in the top layer; it is announced as an alert and persists until dismissed, retried or the editor is closed. It floats above the footer without hiding its actions. Schedule validation uses this same path and retains all entered details. Page-load failures keep their persistent unavailable/retry state.


Scheduling choices use the shared `Dropdown` component rather than native select popups whose height cannot be controlled by application CSS. Its list is limited to the available space and at most 35% of the viewport (224px cap), scrolls internally and stays inside the active dialog. Arrow keys, Home/End, typeahead and Enter select options; Escape closes the list before the modal, and Tab continues through the form. Keep the existing bounded centre search for the searchable reference directory.

Recurring cards display a count of rescheduled sessions instead of joining dates into a growing comma-separated paragraph. The count opens a separate Rescheduled sessions overlay, with original and replacement dates in individual entries and a bounded scrolling body. Replacement records remain individually editable from the schedule list.

The coordinator schedule page uses “Treatment Schedule List” / “Schedule Management”, with server-side search over all permitted schedules by patient name or ID plus all fields supported by patient schedule search: centre name, weekday, date and schedule type. Cards show the full patient ID for coordinators and place the schedule type beside the patient name in a wrapping identity row for both roles. Patients also have schedule search by centre name, weekday, date or schedule type, alongside Add Schedule. Both searches trim whitespace and ignore case, apply before pagination, and use 25 records per page with fixed Previous/Next controls shown as spaced `<` and `>` buttons with accessible names. Pagination stays visible during loading, with controls disabled until ready. Related replacement details remain available even when they are on another page. Coordinator schedules remain read-only.

Patient and schedule editors preserve drafts on HTTP 409 version conflicts. They require an explicit reload before retrying; do not silently merge or overwrite a newer record.


Trips reuses `PageHeading`, compact records separated by thin rules, and shared pagination beneath the list. Long desktop lists retain a visible pagination footer; mobile pagination follows the naturally scrolling list. Coordinator status filters and their counts live in the shared filter overlay alongside dates and direction; they apply together and Cancel discards draft changes. An icon-only Filters button sits beside server search, with a top-right badge counting active status, direction and a date range changed from the default. Hide the badge when no filters are active. The date range appears only in the bounded filter overlay, where date/direction changes apply together. Details opens full route/treatment information in an overlay instead of expanding every list row. Group the patient name, muted ID and status badges first, followed by a vertical From/To route and separate timing fields; long addresses wrap and only the body scrolls while actions stay visible. Patient Next pickup is a compact summary with its own detail action above the searchable ride list; it does not repeat the full address/details grid. Coordinator schedules have a separate **Generate Trips** action; it opens an overlay with Patient ID, source details and a bounded date window, preserving entered dates on failure/conflict. Generation errors use the overlay toast. Unfilled and Needs review are distinct signals; treatment-derived arrival deadlines and earliest return pickup must not be labelled as actual pickup times. Patient next pickup remains independent of list filters. Driver and Caregiver placeholders remain until their authorized data paths exist.

Coordinator trip deletion uses a compact destructive shortcut and an explicit single-journey confirmation overlay. Preserve the selected context and error toast on failure; stale versions require reloading before retry. Keep shared primary/Cancel action order, busy dismissal protection and focus restoration.


## Interface identity and colour preferences

The shared interface uses warm Oat/Ink/Mulberry semantic tokens in `styles.css`. A one-click light/dark button is available in public and authenticated headers. `index.html` applies the saved light/dark preference before paint, defaulting to Light when storage is unavailable or a legacy System value is present. OS theme changes do not change the application theme. No photographic or gradient background is loaded into operational screens.

Use modest 5px corners on controls, thin dividers, tabular time values and readable sentence-case supporting text. Operational lists sit directly on the canvas; the next-pickup strip has a single accent edge. Routine statuses are plain text, while warnings retain their semantic accent. Trip rows align dates and status beside route/timing on desktop and form a vertical journey on phones. Schedule records align patient identity with treatment day/time and facility on desktop and stack on phones. Trip records separate origin/destination from actual pickup or treatment-derived constraints. Mulberry identifies primary actions; warning and destructive feedback have separate semantic colours and explicit wording. Editorial serif typography is reserved for the public introduction. This design replaces earlier guidance prescribing full-height empty panels, teal surfaces and uppercase subheaders; behaviour, role access and existing workflows remain unchanged.


## Header and pickup refinements

Desktop role navigation is in the top bar, followed by the Singapore clock, light/dark toggle, Notifications and Account. Mobile retains the overlay menu with the same authorized destinations. Authenticated workspaces have no sidebar or dashboard footer; public landing and account creation retain their footer. Next pickup is a compact strip containing pickup time/status, journey date/direction, any review flag and View details. Full addresses, treatment and arrival/return constraints stay in Trip details; no confirmed pickup is inferred from treatment time.


### Journey timetable responsive refinement

Desktop uses aligned records; phone layouts prioritise readable names, dates and actions without sideways scrolling. Mobile overlays fill the viewport, retain their existing focus handling and keep actions visible with safe-area padding. Plain underlined detail/generation actions retain 44px touch targets. No allocation labels, permissions, transport states, APIs or public onboarding flows change.


### Compact trip records and deletion confirmation

Pickup time/status belongs with the journey date and allocation status. Keep arrival deadlines and earliest return pickup constraints in Trip details, distinct from actual pickup time. The shared desktop header uses a 64px minimum, with a 56px phone header; all interactive targets remain at least 44px. Trip and schedule rows use tighter vertical spacing while long addresses wrap. Trip details retains the full route and treatment timings. Delete Trip uses a separate compact confirmation showing patient, date/direction, destination and single-journey deletion scope, without repeating the details viewer. Cancellation returns to the prior details context when applicable; busy, failure and stale-version handling are preserved.

### Route context and list interaction

Trip allocation states use labelled, coloured badges: red Unfilled, amber At-Risk, blue On-Track and green Resolved, with theme-aware fills and borders. Trip rows omit pickup-pending text; details show actual pickup time only when known. Arrival deadlines and earliest return constraints appear only in Trip details, keeping list rows focused on date, patient, status and route.

The next-pickup strip leads with the date/direction and uses “Pickup time to be confirmed” as secondary text when no pickup time is assigned; a known time is explicitly labelled “Pickup at”. Trip rows show coordinator patient names beneath the date; full patient identifiers remain available in Trip details and in search. An accessible info button is the only trip-row action. Coordinator deletion is available inside Trip details, beside Close in the bottom-right footer. The desktop date/identity column is capped at 15rem, leaving more space for full route addresses. Buttons retain 44px targets, accessible names, hover titles and native keyboard interaction.

Schedule rows separate patient identity, session/date range and dialysis centre into three desktop columns beside the action. They stack on phones. Generate Trips remains an outlined button with the existing eligibility and confirmation flow.

Trips, patients and treatment schedules use the shared Info button to open details. Rows are not clickable and have no hover highlight. Info controls have accessible names, native keyboard support and a 44px target; closing details restores focus to the control. Patient Info is disabled while the list is updating. The patient action column has no visible heading, with an accessible Details header retained for table semantics. Schedule Info opens a read-only overview; Generate Trips and Edit Schedule remain separate labelled actions. Table semantics and sorting remain intact.


Dashboard action buttons share a 44px minimum height, 10px/16px padding, 5px corners, a 1px border and consistent typography. Neutral, primary and destructive colours indicate purpose; text actions no longer use underlined or borderless variants. Footer buttons size to their labels and group at the right, rather than stretching or separating Close and Delete. Trip confirmation actions, Generate Trips and patient View use the same sizing and typography. Icon-only controls retain square touch targets.
