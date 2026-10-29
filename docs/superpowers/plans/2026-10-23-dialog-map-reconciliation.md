# Dialog map reconciliation with the built interface

**Goal:** Bring the behavioural model in `docs/dialog_map.py` back into agreement with the
implemented routes, screens and actions, so Section 6 remains a truthful formal statement of
the system rather than of the Lab 1 mockups. 19 states become 28.

**Design:** Four corrections. (1) The three role maps no longer start at invented landing
screens: `/dashboard` redirects, so each map's entry state is the Trips function page, named
per role. (2) The function pages the app actually routes to — Schedules, Patients, My Account
— become states, reachable from each other through the shared header navigation rather than
only from the entry state. (3) Signup is a real two-step flow on the landing card and an
inactive account is a real screen, so Login gains three successor states instead of one
catch-all self-transition. (4) Coordinator trip creation is removed: journeys are derived from
a treatment schedule by **Generate Trips**, per the agreed UC-03 revision, not typed into a
New Trip form. Unimplemented but agreed states (Match a Driver, Recovery Options, Route &
Traffic Monitor, Audit Log, Select Patient, UC-09/11/12/13 states) stay — the map is the
designed model, and absence from the current slice is not drift.

**Architecture:** `docs/dialog_map.py` only. No frontend, backend, schema or test changes. The
existing palette, `SVG`/`pair()` helpers, section numbering and page CSS are kept; only
coordinates, box/row data and the design-note prose change.

**Authority:** User reported three gaps and asked for the remaining drift to be found, planned
and implemented in `docs/dialog_map.py` alone. `docs/use-case-map.md` governs which routes
each role gets; `frontend/src/pages/LoginPage.tsx:56` is the authoritative route allow-list.

## Drift found

The three gaps as reported, with one correction:

1. `/dashboard/schedules` — confirmed. No state in the map.
2. `/dashboard/account` — confirmed. No state in the map.
3. There is **no box labelled Overview** in `dialog_map.py`; nothing to delete. The drift is
   that the coordinator map's entry state is called **Dashboard** and is described as the
   landing screen, while the app has no landing screen at all — `/dashboard` redirects to
   `/dashboard/trips`. The fix is a rename and a retargeting, not a removal.

Found on top of those:

4. **Entry states name screens that do not exist.** `Dashboard`, `Assigned Trips` and
   `Your Rides` are all one route, `/dashboard/trips`, rendering role-specific content
   (`Dashboard.tsx:164`). Rename to **Coordinator Trips**, **Driver Trips**,
   **Patient Trips**, matching the vocabulary already used in `use-case-map.md`.
5. **Login models a credential form.** Authentication is Google OAuth; there is no password
   field. `submit credentials` becomes `continue with Google`, and sign-in is unavailable
   (control disabled) while the backend health check fails — a guard on the state, not a
   transition.
6. **Signup is missing entirely.** `AccountPanel.tsx` is a two-step flow on the landing card:
   **Create Account** (username + role; Next, Cancel, change Google account) then
   **Complete Details** (patient contact/pickup fields, or a review list for other roles;
   Sign Up, Back, Cancel). The role select offers patient, caregiver and driver only —
   coordinators are manually provisioned, so no signup path reaches the coordinator map.
7. **An inactive account is its own screen,** not an inline error on Login. It shows identity,
   "Account inactive", and sign out as the only exit. New exception state **Account Inactive**.
8. **A patient with an incomplete profile re-enters Complete Details from inside the
   dashboard** (`onPatientProfileMissing`, `LoginPage.tsx:46`). Two transitions, neither modelled.
9. **The caregiver entry guard is wrong.** `[linked patients = 1]` leaves a caregiver with no
   links unmodelled; the app admits them to Patient Trips with honest unavailable content.
   Guard becomes `[role = Patient OR (role = Caregiver AND linked patients ≤ 1)]`.
10. **New Trip contradicts the agreed UC-03 revision** and does not exist in the app. Remove;
    replace with **Generate Trips** on Coordinator Schedules.
11. **Profiles / Record Form overstate coordinator authority.** The route is
    `/dashboard/patients`; patient creation belongs to signup and deletion is not permitted,
    so `"add new"` and `archive record` are both fictional. Rename to **Patients** /
    **Patient Details**, scope the save to status and notes.
12. **Coordinator trip deletion is implemented and unmodelled.** New state
    **Confirm Trip Deletion**, guard `[journey unassigned]`.
13. **Patient schedule entry is implemented and unmodelled.** New states **Patient Schedules**
    (guard `[role = Patient]` — caregivers are not on the allow-list until UC-02.1),
    **Schedule Form** and **Confirm Schedule Deletion**.
14. **Entry-state internal transitions are stale.** Both trip lists now do server-side
    search, filtering, sorting and pagination with status counts; the patient next-pickup card
    shows pickup status and review flag with details in a dialog, not an inline driver map,
    and the "later rides this week" list is a bounded date-filtered page.
15. **Two design notes are now false:** the Section 2 note about a demo role switcher in the
    top navigation (there is none; the project rule forbids it), and the Section 5 note that
    Your Rides carries "the driver map inline" (the detached panel was removed).

Considered and deliberately **not** changed: Select Patient, Match a Driver, Recovery
Options, Route & Traffic Monitor, Audit Log, Escalate Critical, Service Unavailable, Confirm
Unavailability, Confirm Cancellation, Rate Driver, Preferred Driver, Add Reminder, Calendar
Service. All are agreed design with no contradicting implementation.

## States after reconciliation

**Shared entry (Section 2)** — Login, Create Account*, Complete Details*, Account Inactive*
(exception), Select Patient, My Account*.

**Coordinator (Section 3)** — Coordinator Trips (was Dashboard), Coordinator Schedules*,
Generate Trips*, Confirm Trip Deletion*, Patients (was Profiles), Patient Details (was Record
Form), Match a Driver, Recovery Options, Route & Traffic Monitor, Audit Log, Escalate Critical,
Service Unavailable. New Trip removed.

**Driver (Section 4)** — Driver Trips (was Assigned Trips), Confirm Unavailability.

**Patient & Caregiver (Section 5)** — Patient Trips (was Your Rides), Patient Schedules*,
Schedule Form*, Confirm Schedule Deletion*, Confirm Cancellation, Rate Driver, Preferred
Driver, Add Reminder. Calendar Service stays an external participant, not a state.

`*` new. 19 − 1 + 10 = 28 states.

**My Account belongs to no role map.** Every active role routes to it, so it is drawn once in
the shared entry band of d0 and in Section 2, exactly as Login and Select Patient are, and
appears in Sections 3–5 as an edge target annotated `(shared, section 2)` — the treatment the
Login box already gets there. Editing is *not* a separate state: the patient profile edits in
place on the same route, so `edit / unlock owned details`, `save / update owned profile
[version current]` and `cancel / discard changes` are internal transitions, under the existing
convention that in-place confirmation is an internal transition.

Filter, sort and detail overlays are **not** states anywhere. They re-parameterise a list or
expand a record without changing the available actions, which is what `select filter / update
list` already covers. Only irreversible confirmations become states, consistent with Confirm
Unavailability and Confirm Cancellation.

## Transitions and guards added

Shared entry:

- Login → Create Account `[authenticated AND no account record]`
- Create Account → Complete Details, `Next`; Complete Details → Create Account, `Back`
- Create Account self-transition, `change Google account / restart Google selection`
- Complete Details → Patient Trips, `Sign Up` `[role = Patient]` / save account and owned
  patient profile atomically; same for `[role = Caregiver]`; → Driver Trips `[role = Driver]`
- Create Account → Login and Complete Details → Login, `Cancel / clear session`
- Login → Complete Details `[account exists AND role = Patient AND owned profile incomplete]`
- Login → Account Inactive `[account inactive]`; Account Inactive → Login, `sign out`
- Login self-transition `[Google sign-in failed] / show inline error`
- any function page → My Account, `"My Account"`; My Account → `"Trips"` / `"Schedules"` /
  `"Patients"` back into the role map
- My Account → Complete Details `[role = Patient AND owned profile missing]`

Coordinator:

- Coordinator Trips ↔ Coordinator Schedules, Coordinator Trips ↔ Patients (header navigation;
  the table's From cell lists every page the menu is reachable from)
- Coordinator Schedules → Generate Trips, `"Generate Trips"` `[schedule version current AND
  sessions in supported range]`; → Coordinator Schedules on `confirm / create unfilled
  outbound and return journeys` and on `cancel`
- Coordinator Trips → Confirm Trip Deletion, `"Delete Trip"` `[journey unassigned]`; →
  Coordinator Trips on `confirm / delete journey, retain history` and on `cancel`
- Patients → Patient Details, `select record` (no `"add new"`); Patient Details → Patients on
  `save / update status and notes` and on `cancel` (no `archive`)

Patient & Caregiver:

- Patient Trips ↔ Patient Schedules `[role = Patient]`
- Patient Schedules → Schedule Form, `"Add Schedule"` / `"Edit Schedule"`; → Patient Schedules
  on `save / store treatment schedule [version current]` and on `cancel`. The whole-series /
  one-session scope choice stays an internal transition on Schedule Form.
- Schedule Form → Confirm Schedule Deletion, `"Delete Schedule"`; → Patient Schedules on
  `confirm / delete schedule and linked replacements`; → Schedule Form on `cancel`

Sign-out stays drawn once; its row's From cell becomes "any function page (all role maps)".

## Section 6 and design notes

Section 6: 4 rows deleted (New Trip ×3, Record Form `archive`), 6 From/To state names
rewritten by the renames, `Profiles → Record Form` loses `"add new"`, Login's 6 rows become 9
with Google events and the new guards, and roughly 30 rows are added for the states above.
Order stays shared-entry → coordinator → driver → patient, sign-out last.

Design notes:

- *How to read this map* — add My Account to the sentence listing the states shared by every
  role, alongside Login and Select Patient.
- *Section 2* — replace credentials with Google OAuth; state that sign-in is disabled while
  the backend health check fails; describe the two signup steps and that only patient,
  caregiver and driver can be created, coordinators being manually provisioned; explain
  Account Inactive as a state rather than an inline error; revise the caregiver guard to
  `≤ 1` and record that a caregiver currently receives no patient scope until UC-02.1;
  **delete the demo role-switcher note** — the app has no role switcher and the project rules
  forbid one.
- *Section 3* — Trips is the landing route and `/dashboard` only redirects; Generate Trips
  replaces New Trip because journeys are derived from treatment requirements with the
  15-minute buffer (UC-03 revision) and generation is idempotent; Patients covers UC-02 with
  coordinator writes limited to status and notes, creation belonging to signup and deletion
  not permitted; Confirm Trip Deletion applies only to unassigned journeys and retains
  history. Escalate Critical and Service Unavailable notes unchanged.
- *Section 4* — rename; note that Driver Trips currently renders an honest unavailable surface
  because no assignments exist, while the availability and notification internal transitions
  remain the designed UC-06/UC-10 behaviour.
- *Section 5* — rename; next pickup shows pickup status, journey date/direction and any review
  flag with addresses in the details dialog, so **delete the inline-driver-map claim**;
  Schedules is guarded to Patient because caregiver links are not implemented; the scope
  choice inside Schedule Form is internal.
- Notifications are a header dropdown on every function page, currently unavailable; record
  that in the Section 2 notes rather than repeating an internal transition on six boxes.

## Tasks

- [x] Section 6 first: rewrite `ROWS` to the full reconciled list. It is the formal statement,
      so the diagrams are then drawn to match it, not the other way round.
- [x] `d1` shared entry: Login → Create Account → Complete Details chain, Account Inactive,
      My Account, renamed role entry targets, revised guards. Grow the viewBox.
- [x] `d2` coordinator: rename Dashboard/Profiles/Record Form, delete New Trip, add Coordinator
      Schedules, Generate Trips, Confirm Trip Deletion and the shared My Account target.
      Children hang to the right of their parent, as Record Form already does.
- [x] `d3` driver: rename, add the shared My Account target, refresh the note box.
- [x] `d4` patient & caregiver: rename, add Patient Schedules, Schedule Form, Confirm Schedule
      Deletion and the shared My Account target; revise the entry state's internal transitions.
- [x] `d0`: re-lay out all three regions in the three-column parent/child shape so the whole
      map still fits one A4 page, and rebuild the shared entry band with the signup chain and
      My Account. Target 880 × ≤1300; the left-margin bus carries sign-out, My Account and the
      three guarded entry lanes.
- [x] Rewrite the design-note prose in `build()` per the section above.
- [x] Cross-check sync: every box in `d0` appears in `d1`–`d4` and the reverse; every drawn
      transition has a `ROWS` row.
- [x] Run `python3 docs/dialog_map.py`, render each PDF page to an image and inspect every page
      for overlapping labels, arrows crossing boxes and figures running past the page edge.

## Review focus

Overlapping labels raise no error, so every page gets looked at, not just regenerated. d0 is
already the full height of its page; if it overflows after the additions, tighten the column
pitch and shorten label text rather than widening the viewBox — width scales inversely with
rendered text size, and the d0 labels are already at 9.5px. No state may be drawn twice in one
diagram. Names must be identical between boxes and `ROWS`, or the sync check is meaningless.
Guards must match `LoginPage.tsx:56`: Trips and My Account for every role, Schedules for
patient and coordinator only, Patients for coordinator only. No state may imply an action the
app does not perform — that is the no-placeholder rule applied to the model.

## Execution notes

- Final count is 28, not the 29 first written above: Edit My Details was folded into My Account
  as an internal transition, exactly as the My Account paragraph argues, so only 10 states were
  added. Ten removals/renames otherwise as planned; New Trip is the only state deleted.
- Sync was checked mechanically, not by eye: a script extracts every box title from the five
  rendered SVGs and compares the sets. `d0` and `d1`–`d4` match exactly in both directions, and
  every state drawn appears in `ROWS`. `ROWS` is deliberately finer than the drawings in three
  places (My Account's per-role menu targets, the sign-out row, and Cancel from either sign-up
  step), all of which are transitions the diagrams draw once.
- `d0` grew from 880×1265 to 920×1335. Widening it was what made the extra height affordable:
  the figure scales to the text column, so a wider viewBox buys vertical room at a small cost in
  rendered label size. It now renders 248mm tall against the 261mm A4 text height — measured,
  not estimated. The three regions were re-laid-out into the entry/list/child column shape so the
  Coordinator map holds twelve states in roughly the height its nine used to need.
- Rendering check: each figure is screenshotted at true print width (661px) with print media
  emulated, and the whole document is swept page by page. Three defects were found only by
  looking — the sign-out spine passing through the My Account box in `d0`, the sign-up label
  colliding with the Login self-transition label, and the My Account arrow in `d3`/`d4` landing
  in the gap between the Login and My Account boxes rather than on either.
- `[service timeout > 5 s]` must be written with a literal `>` in a diagram label (`label()`
  escapes it) and as `&gt;` in `ROWS` (table cells are emitted raw). Getting this backwards
  prints the entity.
- `CLAUDE.md` records "19 states" and the filename `docs/dialog-map.pdf`; the real file is
  `docs/Dynamic_Model_Dialog_Map.pdf` and the count is now 28. Out of scope here (this change is
  `dialog_map.py` only) and left for the user.
