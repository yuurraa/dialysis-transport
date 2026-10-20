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

New dashboard screens must reuse `PageHeading` and `Overlay` from `frontend/src/components/DashboardUI.tsx` and the theme tokens in `frontend/src/styles.css`. Keep one clear page title first, with its optional subheader underneath, and one primary action; use section headings below it. Page subheaders, including Treatment Schedules, use the small, spaced uppercase Patient Management typography; account metadata retains the shared description style. Patient search hints consistently use “Patient name” and “ID”: “Patient name, phone or ID” for the patient list. Coordinator schedule search uses “Patient or schedule details”, with the supported fields listed in its tooltip. Search guidance may specify a full patient ID where required. Patient search actions reserve enough width for the complete search hint and wrap below the heading on narrow screens. Do not duplicate the page name in an eyebrow. Use the shared primary, secondary and destructive control styles rather than adding page-specific button palettes or radii. Action groups use primary first, Cancel/Close next, and Delete last in both visual and keyboard order. Paired actions have equal widths; the Delete shortcut remains compact. Preserve Previous/Next order for pagination and the existing Next/Sign Up, Back, Cancel sequence for signup.

List pages use `dashboard-trips page-panel`, with a fixed heading/toolbar and a `panel-scroll` region (a keyboard-focusable, named region for long lists). The dashboard fits the available viewport on phones and desktops. Records scroll inside their panel; long content must not enlarge the outer box or spill beyond its border. Patient tables retain their bounded horizontal/vertical scroll region and pagination. The compact DT mark retains application identity in the mobile header.

Use an `Overlay` for add, edit, detail and confirmation flows that can preserve the current page. Its header/close button and action footer remain visible; only the body scrolls. The shared component handles native modal semantics, Escape/backdrop dismissal, focus containment/restoration and background scroll locking. Pass `busy` during mutations to prevent dismissal or duplicate submission; retain inputs on failure. Supply footer actions and an optional `onSubmit` rather than embedding another form. Test with long data at desktop and phone widths, a short viewport and enlarged text.

Treatment schedules use one Edit action. For recurring entries, **Apply changes to** distinguishes the entire series from one occurrence. The editor keeps the same responsive height and Save/Cancel/Delete slots in both modes. Delete always removes the entire selected schedule (including its replacements for a recurring series), and its confirmation states this scope explicitly; it does not cancel only the selected unchanged occurrence. One-session editing lists actual dates on the recurring weekday and excludes already replaced occurrences. Series longer than 52 occurrences use a month filter, so any supported year remains reachable without rendering an unbounded list. The selected original session and new date are adjacent; the new date follows the selected session until the user explicitly changes it. Existing schedules do not show a redundant disabled schedule-type control. Single entries display their weekday and date; recurring entries display “Every [weekday]” and a labelled date range. The centre address uses the existing read-only field appearance. Delete is a secondary text action on desktop and a compact, labelled trash control on mobile; Footer actions follow reading order: Save Schedule, Cancel, then Delete. Save and Cancel use equal widths on desktop and mobile; Delete stays compact. Schedule deletion is confirmed inside the same overlay. Deleting a series removes its linked replacements; deleting a replacement restores the original occurrence only if it does not conflict with another session. Treatment deletion does not cancel transport trips.


Overlay mutation errors use the shared `error` / `onDismissError` toast rather than an error paragraph at the bottom of a long form. The toast lives inside the native modal so it remains visible and interactive in the top layer; it is announced as an alert and persists until dismissed, retried or the editor is closed. It floats above the footer without hiding its actions. Schedule validation uses this same path and retains all entered details. Page-load failures keep their persistent unavailable/retry state.


Scheduling choices use the shared `Dropdown` component rather than native select popups whose height cannot be controlled by application CSS. Its list is limited to the available space and at most 35% of the viewport (224px cap), scrolls internally and stays inside the active dialog. Arrow keys, Home/End, typeahead and Enter select options; Escape closes the list before the modal, and Tab continues through the form. Keep the existing bounded centre search for the searchable reference directory.

Recurring cards display a count of rescheduled sessions instead of joining dates into a growing comma-separated paragraph. The count opens a separate Rescheduled sessions overlay, with original and replacement dates in individual entries and a bounded scrolling body. Replacement records remain individually editable from the schedule list.

The coordinator schedule page uses “Treatment Schedule List” / “Schedule Management”, with search over the loaded schedule list by patient name or ID plus all fields supported by patient schedule search: centre name, weekday, date and schedule type. Cards show the full patient ID for coordinators and place the schedule type beside the patient name in a wrapping identity row for both roles. Patients also have schedule search by centre name, weekday, date or schedule type, alongside Add Schedule. Both searches trim whitespace and ignore case. Coordinator schedules remain read-only.
