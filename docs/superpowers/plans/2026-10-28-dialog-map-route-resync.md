# Dialog map and CLAUDE.md re-sync with the served routes

**Goal:** Bring `docs/dialog_map.py` and `CLAUDE.md` back into agreement with the routes the app
serves on `main`, so Section 6 is again a truthful statement of the system. Six routes have no
state in the map; they become eight states. 28 states become 36.

**Design:** Every route the app serves gets a state, and the map's existing rule decides how
many. `/dashboard/trips` is one route drawn as three states because the actions differ by role;
trip details at `/dashboard/trips/:tripId` is the same situation (coordinator: recovery;
driver: report unavailability, start, complete; patient and caregiver: acknowledge, cancel; patient:
rate), so it becomes **Coordinator Trip Details**, **Driver Trip Details** and **Patient Trip
Details**. Sharing one state would be a one-off exception to that rule and would push its arrows
across all three role bands of d0. The other five routes are one state each. Dialogs inside
those pages that edit and save in place stay internal transitions, as they already are for
Coordinator Trips and My Account. Design notes that are factually wrong are corrected; design
notes that are true but describe states the team may want to change are left alone and listed
under **Open questions**.

**Architecture:** `docs/dialog_map.py` and `CLAUDE.md` only. No frontend, backend, schema or
test changes. The palette, `SVG`/`pair()` helpers, section numbering and page CSS are kept.
The PDF is **not** regenerated in this change: it is rebuilt on the owner's Mac, where the fonts
are correct.

**Authority:** User instruction on `docs-resync`, cut from `main` at c6cab5a.
`frontend/src/pages/LoginPage.tsx:64` is the route allow-list on this branch and
`frontend/src/pages/Dashboard.tsx:130-157` renders it. `frontend/src/routes.tsx` exists only on
the unmerged `routing-restructure` branch and is **not** the authority here.
`docs/use-case-map.md` governs which routes each role gets.

## Drift found

`CLAUDE.md`:

1. Line 14 says 36 Playwright tests. `npx playwright test --list` reports **19 tests in 8
   files**. Fixed to 19. (`routing-restructure` adds `tests/routing.spec.ts` with 5 more; that
   branch's PR updates the count to 24.)
2. Line 24 says routing lives in `LoginPage.tsx`. **True on this branch** and left unchanged.
   The `routes.tsx` wording belongs in the routing PR, which is what makes it true.
3. Lines 73–74 say twelve of twenty-eight states have no data path. Rebuilt from the states the
   design notes called unbuilt (the twelve are not recorded anywhere, commit 8a3db01 included):
   - **Live now (7):** Match a Driver, Recovery Options, Escalate Critical (as the `critical`
     result of recovery), Confirm Unavailability, Confirm Cancellation, Rate Driver, Preferred
     Driver.
   - **Data live, screen drawn differently (2):** Route & Traffic Monitor and Audit Log. The
     data exists per trip inside trip details; there is no separate screen.
   - **Drawn differently from the app (2):** Select Patient (caregivers see every linked
     patient together; nothing routes to a selection step) and Service Unavailable (failures
     are inline messages).
   - **Still no data path (1):** Add Reminder. Every `calendar.service.ts` method throws.
4. Line 57 cites 28 states; now 36.
5. Line 62 says `schema.sql` has 6 tables and two constraints pin the slice. It has **28
   tables**, and both constraints are dropped at `schema.sql:1287-1288`; `status` now allows
   `unfilled`, `on-track`, `at-risk`, `resolved`.
6. Line 72 says 17 methods throw `NotImplementedException`. There are **12**: 6 in
   `calendar.service.ts`, 4 in `scheduling.service.ts`, 2 in `profiles.service.ts`. It also says
   all three integration services are stubs; **OneMap and LTA are real**, only Calendar is.
7. Line 37 (no demo role switcher) is contradicted by `DemoTools.tsx`. It is a team rule, not a
   doc error, and is **left alone**.

`docs/dialog_map.py`:

8. No state for `/dashboard/availability`, `/dashboard/vehicle`, `/dashboard/drivers`,
   `/dashboard/caregivers`, `/dashboard/connections` or `/dashboard/trips/:tripId`.
9. Line 761 and the d4 note say a caregiver is not routed to Patient Schedules. The allow-list
   routes caregivers there (`LoginPage.tsx:64`). Guard becomes `[role = Patient OR Caregiver]`.
10. Line 726 says caregiver linking is not implemented. It is (`caregiver_links`,
    `CaregiverConnections.tsx`).
11. Line 741 says Match a Driver and Recovery Options have no data path. They do.
12. Lines 749–750 and the d3 note say Driver Trips carries availability on the same page and that
    no assignment exists. Availability is its own route; assignment exists.
13. Lines 734 and 760 call trip details an in-page dialog (an internal transition). It is a
    routed page with its own actions.

## States after re-sync

**Coordinator (Section 3)**: adds **Coordinator Trip Details**, **Drivers** and **Caregivers**.

**Driver (Section 4)**: adds **Driver Trip Details**, **Driver Availability** and **My
Vehicle**.

**Patient & Caregiver (Section 5)**: adds **Patient Trip Details** and **Caregiver
Connections**. Naming: the nav label is "Caregivers" for a patient and "Patient" for a
caregiver, and "Caregivers" is already the coordinator state, so the state is named after the
route's page component.

28 + 8 = **36**. Nothing is removed or renamed.

Internal transitions, not states: the week editor on Driver Availability; edit registration on
My Vehicle; driver details, car details, edit and approve/reject on Drivers; caregiver details
and edit on Caregivers; generate code, enter code, preview, confirm and unlink on Caregiver
Connections; the Details / Journey / Rate tabs, Start trip, Complete trip and location sharing on
the Trip Details states; Acknowledge on Patient Trip Details.

## Transitions moved — review these

Adding the Trip Details states moves five rows. The code now triggers each one only from the
details page (`TripsPage.tsx:380, 406`), so leaving them on the list states would be false.

- **Rate Driver** and **Preferred Driver**: From changes from **Patient Trips** to **Patient
  Trip Details**; their return transitions now land there too. **These guards were reviewed in
  PR #1** (`[trip completed AND role = Patient]`, `[role = Patient]`). The guards are carried over
  unchanged, but the From state they apply to has changed and needs a fresh review. See open
  question 6.
- **Confirm Cancellation**: from Patient Trips to Patient Trip Details. Guard unchanged.
- **Confirm Unavailability**: from Driver Trips to Driver Trip Details. Event renamed
  `"Report unavailable"` → `"Report unavailability"` to match the button.
- **Recovery Options**: from Coordinator Trips to Coordinator Trip Details. Event renamed
  `"Compare options"` → `"Generate recovery options"`; guard `[trip at-risk]` unchanged
  (`canRecover`, `TripsPage.tsx:307`).

Not moved: **Match a Driver** and **Confirm Trip Deletion**. Both are also offered on the
details page, but the list still offers them (row control and bulk delete), so the existing rows
stay true. The map keeps one entry point for each. Escalate Critical's `escalate` still returns
to Coordinator Trips.

## Transitions added

- Each role's Trips → its Trip Details on `"View trip details"`, back on `close`.
- Coordinator header navigation now reaches five pages. The three pairwise rows become five
  rows from "any Coordinator function page", defined in the Section 6 intro, in the style the
  sign-out row already uses. Driver and Patient & Caregiver navigation gets the same treatment.
- Driver navigation: `"Availability"` `[vehicle registration approved]` (`Dashboard.tsx:176`),
  `"My Vehicle"` (labelled "Register Vehicle" before approval).
- Patient & Caregiver navigation: `"Caregivers"` `[role = Patient]` / `"Patient"`
  `[role = Caregiver]` → Caregiver Connections.
- My Account gains matching rows into the new pages, and its `"Schedules"` row's guard becomes
  `[role = Patient OR Caregiver]`.

## Open questions (need team agreement; not changed here)

1. **Select Patient.** Caregivers see all linked patients' trips together and choose a patient
   inside the schedule form; no screen performs a session-scope selection. Remove the state, or
   build the screen?
2. **Service Unavailable.** Routing, traffic and recovery failures are inline messages, not a
   separate screen. Fold into the source states as an exception condition?
3. **Route & Traffic Monitor** and **Audit Log.** The data exists per trip inside trip details
   (`TripTraffic`, `TripHistoryDialog`). Redraw as internal transitions of Coordinator Trip
   Details, or keep as designed coordinator-wide screens?
4. **Escalate Critical.** Escalation is a `critical` flag returned by recovery; there is no
   `escalate` user action. Keep the user-event exit?
5. **Confirmation dialogs as states.** The map makes irreversible confirmations states. Start
   trip, Complete trip and Unlink relationship all confirm in a dialog and are modelled here as
   internal transitions. Promote them for consistency?
6. **Preferred Driver guard.** In code, rating and "Make this driver preferred" share one Rate
   tab (`TripFeedback.tsx`) that exists only on a completed trip with an assigned driver
   (`canRate`, `TripsPage.tsx:135`). So Preferred Driver effectively carries `[trip completed
   AND role = Patient]`, not `[role = Patient]`, and is entered from beside Rate Driver rather
   than as an independent action. PR #1 chose the wider guard and the separate entry; confirm
   both.
7. **Match a Driver guard.** `[trip unfilled]` predates reassignment; the code offers "Manage
   driver assignment" on any scheduled trip.

## Tasks

- [x] Section 6 first: `ROWS` gains the eight states, the five moved rows, the new navigation
      rows and the corrected Schedules guards.
- [x] `d2` coordinator: Coordinator Trip Details as a child of Coordinator Trips with Recovery
      Options (and its exceptions) under it; Drivers and Caregivers as header-nav pages.
- [x] `d3` driver: Driver Trip Details with Confirm Unavailability under it; Driver Availability
      and My Vehicle; move the availability internal transition off Driver Trips; rewrite the note.
- [x] `d4` patient & caregiver: Patient Trip Details with Confirm Cancellation, Rate Driver and
      Preferred Driver under it; Caregiver Connections; fix the Schedules guard and the notes.
- [x] `d0`: the same changes in the whole-map layout, keeping it on one A4 page.
- [x] Design-note prose in `build()`: fix items 9–13; record per-role Trip Details.
- [x] `CLAUDE.md`: lines 14, 57, 62–64, 72–75. Leave 24 and 37.
- [x] Sync check: box titles in d0 equal those in d1–d4; every drawn state is in `ROWS`; 36.
- [x] Render each figure to PNG in the scratchpad (not the PDF) and inspect for overlaps.

## Review focus

The five moved rows, above all Rate Driver and Preferred Driver against PR #1. Names must be
identical between boxes and `ROWS`. d0 has little vertical slack; widen the viewBox rather than
shrinking label text further. The scratchpad render uses this machine's fonts, so the owner's
PDF build on the Mac is the final check for label collisions.

## Execution notes

- **Acknowledge is not a driver action.** The user's description gave the driver acknowledge; the
  code gives it to patients and caregivers (`patientActions = !coordinator && !driver`,
  `TripsPage.tsx:300`). The driver's details-page actions are Report unavailability, Start and
  Complete. Modelled from the code.
- The second clarifying question (move all five rows, or only Rate and Preferred) was not
  answered. All five were moved, because the user's own description of who gets which action on
  trip details ("coordinator gets … recovery, driver gets report-unavailability … patient gets
  cancel and rate") places all five there. Each is listed under *Transitions moved* for review.
- Rate Driver and Preferred Driver event labels (`"Rate driver"`, `"Preferred driver"`) were kept
  from PR #1 even though the UI's tab is labelled "Rate" — only their From/To state changed.
- d0 grew from 920×1335 to 1000×1450. At print width (661px) it renders 958px tall, about 254mm
  against the 261mm A4 text height — measured in a scratchpad render, not estimated. Label text
  size is unchanged (9.5px); widening paid for the extra height.
- Sync was checked mechanically: box titles extracted from the five SVGs, d0 equals d1–d4 in
  both directions, and the set equals the 36 states named in `ROWS`.
- Rendering check: each figure was screenshotted at print width into the scratchpad and inspected.
  Defects found only by looking and fixed: crossing elbows in d2 and d3 (the pair dropping
  furthest must take the innermost elbow), UC text overflowing 80-tall boxes in d3, return
  labels touching child boxes in d4, and the `"Generate Trips"` guard label sitting on the
  escalate line in d0 (line raised to y 231). Labels lying over elbow lines in the d0/d2
  navigation fans are the pre-existing pattern and were left.
- The PDF was **not** regenerated; the owner rebuilds it on their Mac. This machine's fonts
  differ, so the owner's render is the final collision check.
- Header navigation rows were collapsed to "any <role> function page", defined in the Section 6
  intro, rather than listing up to five From pages per row.
