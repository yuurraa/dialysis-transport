# Routing restructure

**Goal:** Replace the navigation embedded in `LoginPage.tsx` and `Dashboard.tsx` with one
route table that every role guard, nav link and page dispatch reads from. Today the same role
rules are written out four times, and adding a route means editing all four in step. That
duplication is what this change removes. The router must also have room for the remaining
dialog-map states and the caregiver branch, without drawing screens that have no data path.

**Design:** Recommendation: **a minimal hand-rolled router built around one route table, and
no new dependency.** Move to react-router (declarative mode) only when the caregiver branch
needs patient-scoped URL parameters. The reasons follow.

*What the router actually has to carry.* The 28 dialog-map states are not 28 routes. Mapped
against the code (table below), they come to 7 function-page routes, 4 landing-card states that
all live at `/`, 6 in-page dialogs, and 11 states with no data path. Dialogs stay component
state, as they are now. Giving a confirmation its own URL would let Back or reload reopen
"Confirm Trip Deletion" with nothing behind it. The function routes are flat (`/dashboard/<page>`)
and none of them take parameters. That is too little to justify a routing library.

*Where the guard collapse comes from.* The duplication goes away because one table says
"this path, this label, these roles, this page". Both options need that table, and
react-router does not supply it. You would still write a `RequireRole` wrapper or filter the
table before emitting `<Route>`s. So the library does not do the main job here. It only adds a
second way of expressing redirects, and those would have to sit alongside the auth effect at
`LoginPage.tsx:52-59`. That effect cannot move into a router: it depends on `checking`,
`resolvedAccount` and `profile_complete`, which only `LoginPage` knows.

*Bundle cost, measured rather than quoted.* I bundled react-router 8.5.0 with React 19.3.0
using esbuild (minified, then gzip -9) and compared it against React alone:

| Variant | Min | Gzip | vs React-only |
| --- | --- | --- | --- |
| React + ReactDOM only | 223.5 kB | 69.1 kB | — |
| + `BrowserRouter`/`Routes`/`NavLink`/`Navigate` | 266.4 kB | 83.9 kB | +42.9 kB / +14.8 kB gz |
| + `createBrowserRouter`/`RouterProvider` (data mode) | 324.9 kB | 102.5 kB | +101.5 kB / +33.4 kB gz |
| Hand-rolled table + `useSyncExternalStore` | ~1 kB | <0.5 kB | — |

Declarative mode adds 21% to the React baseline. That is affordable, but the build already
triggers Vite's >500 kB advisory and it would buy nothing the table does not already give.
Data mode is ruled out. Its loaders would want auth resolution moved out of `LoginPage`, which
the auth constraint forbids.

*Role guards.* Hand-rolled: each entry carries `allow(account)`. The allow-list, nav and
dispatch all call `routesFor(account)`. React-router: you would derive `<Route>`s from the same
filtered table and handle denial with `<Navigate>`. Both are one predicate per route. The
hand-rolled version keeps the single redirect point the auth effect already has.

*Caregiver branch.* The dialog-map guard is `[role = Patient OR (role = Caregiver AND linked
patients ≤ 1)]`, with Select Patient reached when a caregiver has more than one linked patient.
A predicate on `account` expresses that directly; a `roles: Role[]` array could not. This is why
the table uses `allow(account)` rather than a list of roles. Once UC-02.1 gives `Account` a
linked-patient count, Select Patient becomes one table entry, and the caregiver gains Schedules
by editing one predicate. If the selected patient has to appear in the URL
(`/dashboard/p/:patientId/trips`, so Back and bookmarks keep the scope), that is the point
where nested params earn react-router. The table entries correspond one-to-one to
`<Route path element>`, so migrating then costs one file. Do not add param matching ahead of
that.

*State → route mapping* (28 states, from `docs/dialog_map.py` Section 6):

| Kind | States | Routing treatment |
| --- | --- | --- |
| Route | Coordinator/Driver/Patient Trips → `/dashboard/trips`; Coordinator/Patient Schedules → `/dashboard/schedules`; Patients → `/dashboard/patients`; My Account → `/dashboard/account` | Table entries |
| Landing card at `/` | Login, Create Account, Complete Details, Account Inactive | Unchanged; `LoginPage` chooses between them from auth state, not from the path |
| In-page dialog | Generate Trips, Confirm Trip Deletion, Patient Details, Match a Driver (manual assignment dialog), Schedule Form, Confirm Schedule Deletion | Unchanged component state; no URL |
| No data path | Select Patient, Recovery Options, Route & Traffic Monitor, Audit Log, Escalate Critical, Service Unavailable, Confirm Unavailability, Confirm Cancellation, Rate Driver, Preferred Driver, Add Reminder | **No entry, no stub, no comment placeholder.** A typed URL falls through to the existing redirect to `/dashboard/trips` |

That table counts 11 states with no data path; `CLAUDE.md` says twelve. The gap is Match a
Driver. Automatic matching is unbuilt, but manual assignment (`TripAssignmentDialog`) is real,
so it is listed here as a dialog. Three routes the app serves have **no dialog-map state at
all**: `/dashboard/drivers`, `/dashboard/availability` and `/dashboard/vehicle`. They came in
after the 2026-10-23 reconciliation. That is map drift, recorded here and left for a separate
`dialog_map.py` change.

**Architecture:** One new file, `frontend/src/routes.tsx`, with no dependency added. It contains:

- `navigate(path, replace?)`: `pushState`/`replaceState`, `scrollTo(0, 0)`, then dispatch a
  `popstate` event so there is a single listener.
- `usePath()`: `useSyncExternalStore(subscribe-to-popstate, () => location.pathname)`. Each
  render reads the live pathname, so the raw `replaceState` at `LoginPage.tsx:152` is picked up
  without being rewritten.
- `dashboardRoutes`: an ordered array of `{ path, label, allow(account), nav }`. Array order is
  nav order: Trips, Availability, Vehicle, Schedules, Patients, Drivers, then Account with
  `nav: false` because it lives in the account dropdown.
- `routesFor(account)` and `homePath = '/dashboard/trips'`.

Page elements stay in `Dashboard.tsx`, as a `path → element` lookup that replaces the ternary.
They need Dashboard-local state (`notify`, `driverRegistered`, `vehicleChanged`,
`profileResolved`), and moving them would push that state into the table. The coordinator
Account Details JSX becomes a local `AccountPage` in the same file. `Dashboard` drops its
`path`/`onNavigate` props and calls `usePath()` and `navigate` itself. `DriverAvailability`
keeps its `onViewVehicle` prop, so its file is untouched.

Two conditions stay outside the table on purpose, because they are data-state rather than role
guards:

1. The driver nav hides Availability and Vehicle until `/drivers/me` resolves, and Vehicle's
   label switches between Register Vehicle and My Vehicle.
2. Driver pages other than Trips and Account show a loading or error state until registration
   loads.

The route guard still admits `/dashboard/availability` for an unregistered driver, as the
allow-list does today, and the page explains itself.

Not touched: `styles.css`, everything under `src/styles/` (the stylesheet has been split into
partials since `CLAUDE.md` was written, and the partials are Haoyu's too), `src/components/`,
and the bodies of `TripsPage`, `PatientsPage` and `TreatmentSchedules`. Nav markup stays the
same: `<a href>` inside `.dashboard-navigation` with `aria-current="page"`, so the 44px
min-height and 3px `:focus-visible` rules (`dashboard.css:63`, `:708`) keep matching. There are
no backend, schema or API changes.

**Authority:** User request of 2026-10-26: plan only, no source changes on this pass.
`docs/use-case-map.md` § Function pages governs which routes each role gets. Where it disagrees
with the code, the code at `LoginPage.tsx:56` is the behaviour being preserved, because this is
a refactor (see Execution notes). The user's constraints: no screens for states without a data
path, Haoyu's files untouched, auth/role redirects and `/auth/callback` handling preserved,
WCAG control rules preserved, and `auth.spec.ts`/`dashboard.spec.ts` passing unchanged.

## Tasks

- [x] Characterisation test first: add `frontend/tests/routing.spec.ts`, a single
      table-driven test that pins the guards no existing test covers. For each role, a deep link
      to every dashboard path must land on the path itself if allowed and on `/dashboard/trips`
      if not. Also cover: `/dashboard` redirects to trips; an unauthenticated
      `/dashboard/trips` goes to `/`; a patient's `/dashboard/profile` goes to
      `/dashboard/account`; an unknown `/dashboard/x` goes to trips; an authenticated
      `/auth/callback` ends on trips; and Back/Forward between two pages renders the matching
      `aria-current` link. Unlike the house's failing-first rule, this test **must pass against
      the current code**: it records today's behaviour so the refactor can be checked against
      it. Run it and record that it passes.
- [x] Capture a before snapshot. For coordinator, patient, caregiver and driver (registered and
      unregistered), save the `outerHTML` of `.dashboard-header` and `#dashboard-drawer` on each
      allowed page. A scratch script is enough; it does not get committed.
- [x] Add `src/routes.tsx` as described in Architecture.
- [x] `LoginPage.tsx`: replace `useState(pathname)`, `navigate` and the `popstate` listener
      (`:12`, `:32-41`) with `usePath()`/`navigate`. Replace the `allowed` array at `:56` with
      `routesFor(account).some(r => r.path === path)`. Leave `:54`, `:57-58`, `:109` and
      `:151-153` logically unchanged. Stop passing `path`/`onNavigate` to `Dashboard`.
- [x] `Dashboard.tsx`: derive the current route from `usePath()`. Replace the page booleans
      (`:121-131`), the nav links (`:146-156`), the mobile-title ternary (`:170`) and the
      dispatch ternary (`:203`) with reads from `routesFor(account)` plus the `path → element`
      lookup. Keep the driver loading and error gate and the caregiver unavailable surface
      exactly as rendered now.
- [x] Re-run the snapshot script and diff the result against the before snapshot. Expect zero
      differences.
- [x] Run `npm run check --workspace frontend`, the full `npm run test --workspace frontend`
      (all specs, not just the two named, since six other specs deep-link into `/dashboard/*`),
      and `npm run build`. Record the change in bundle size; expect roughly zero.
- [ ] *Deferred to a separate PR at the user's direction.* Update `CLAUDE.md` § Scope boundary, which says routing lives "currently inside
      `LoginPage.tsx`", and § Where things are, so both point at `src/routes.tsx`.

## Review focus

- **One source of truth.** After the change, `grep -n "'/dashboard/" frontend/src` should hit
  `routes.tsx`. Elsewhere it should hit only the `/dashboard/profile` legacy redirect and the
  `onViewVehicle` target. A role check that names a path outside the table is the duplication
  coming back.
- **Redirect races.** The auth effect at `LoginPage.tsx:52-59` must still wait on `checking`.
  `usePath()` must not cause a redirect to `/` before `resolvedAccount` matches `user`. The
  `auth.spec.ts` sign-out → Back → reload sequence is the test that catches this.
- **`/auth/callback`.** The code read at `:109` happens at mount, and the cleanup
  `replaceState` must stay `replaceState`, never `pushState`, so Back never returns to a URL
  carrying a code. No arbitrary return URL may be honoured.
- **Nav order and focus.** `dashboard.spec.ts` tabs Trips → Schedules → Patients → Drivers →
  Close for coordinators. Table order must keep that. Clicking a drawer link must still close
  the drawer and return focus to the toggle (the `:76` path-change effect).
- **Modifier clicks.** Ctrl, Cmd, Shift and middle-click on nav links must still fall through
  to the browser (`follow`, `:135-137`).
- **No invented UI.** The diff must not contain any entry, label, comment stub or component
  for a no-data-path state.
- **Markup unchanged.** An empty header/drawer snapshot diff is the evidence that the WCAG
  sizing and focus rules still apply. Changed class names or wrapper elements would silently
  drop them.

## Execution notes

Verified before planning (2026-10-26, branch `routing-restructure`, clean tree):

- **No client router installed.** `frontend/package.json` lists only React, ReactDOM and
  Supabase. The root lockfile does contain `node_modules/router@2.2.0`, but that is the Express
  router pulled in by the NestJS backend, not a client router.
- **LoginPage references confirmed exactly:** `useState(window.location.pathname)` `:12` (the
  component starts at `:11`), `pushState`/`replaceState` `:33`, `popstate` listener `:37-41`
  (registered at `:39`), allow-list `:56`, redirects `:54-58`, callback detection `:109` and
  cleanup `:151-153`.
- **Dashboard line numbers in the request are stale.** `path` and `onNavigate` props are at
  `:20-21`, page booleans at `:121-131` (not 88-93), nav links at `:146-156` (not 109-111),
  dispatch ternary at `:203` (not 159; `:159` is the skip link).
- **The guard is written four times, not three.** The mobile title ternary at `:170` repeats it
  as well.
- **Stray duplicate in the allow-list.** At `:56`, `/dashboard/trips` appears twice for
  drivers, once as `home` and once in the driver spread. It is harmless; the table removes it.
- **Doc drift, not fixed here.** `use-case-map.md` says Drivers "enter `/dashboard/vehicle`
  with Register Vehicle as their only main navigation tab". The code sends every role to
  `/dashboard/trips`, and drivers have Trips, Availability and Vehicle. `CLAUDE.md` says the
  suite has 36 tests; it has 19 across 8 specs. `CLAUDE.md` also describes `styles.css` as one
  1000-line file; it is a 17-line `@import` entry over `src/styles/`.
- **Coverage gap.** No existing test asserts a role-denied redirect, the WCAG control sizing or
  the focus outline. `auth.spec.ts` and `dashboard.spec.ts` assert no URL paths at all; they
  check rendered state, nav order and focus. That is why the characterisation spec and the
  markup snapshot are tasks.
- **Bundle figures** come from a scratch esbuild project outside the repo (react-router 8.5.0,
  React 19.3.0, production define, minified, gzip -9). They are measured, not taken from
  package metadata.

Implementation (2026-10-26):

- **Characterisation test first.** `tests/routing.spec.ts` has 7 tests: one per role across all
  7 dashboard paths, plus redirects, signed-out access and Back/Forward. All 7 passed against
  unmodified HEAD. To show the test bites, I temporarily removed `/dashboard/drivers` from the
  coordinator allow-list at `LoginPage.tsx:56`. The coordinator test failed on `toHaveURL`, and
  the mutation was reverted.
- **The suite was not green at HEAD, before any source change.** It ran 23 passed, 3 failed
  (26 tests: the 19 existing plus the 7 new). After the change it ran 23 passed, 3 failed: the
  same set.
  - `dashboard.spec.ts` is **flaky at HEAD**. Over 4 repeats it failed 2/4 at HEAD and 2/4 on
    the branch, in the same alternating pattern. It hangs re-opening or closing the mobile
    drawer (line 39 or 41) after a backdrop-click dismissal. That is the drawer's close-animation
    race; no path changes in that part of the test. Its routing-relevant steps (drawer tab order
    Trips → Schedules → Patients → Drivers, lines 22-31) pass on every run. Not fixed here: it
    is drawer and animation code, outside routing.
  - `trips.spec.ts:36` hardcodes `until_date: '2026-11-18'`. The four-week horizon computed
    from today (2026-10-26) ends 2026-11-15. The fixture is date-dependent.
  - `trips.spec.ts:115`: `getByRole('region', { name: 'Trip list' })` now matches two elements
    (the "Trip List" section and the "Trip list" scroll region), a strict-mode violation.
  - All three are recorded for a separate fix. `auth.spec.ts` passes unchanged, as does
    `dashboard.spec.ts` whenever its drawer race lands the passing way. Neither file was edited.
- **Markup snapshot.** I compared the `outerHTML` of `.dashboard-header` and `#dashboard-drawer`
  (clock stripped) for coordinator, patient, caregiver, unregistered driver and registered
  driver, on every allowed page: 20 page states. Before and after are **byte-identical**. The
  registered-driver fixture needed a complete vehicle record: a partial one crashed
  `DriverRegistration` on `new Date(undefined)`, which is a fixture gap, not an app change.
- **One source of truth, with a caveat.** Role checks now live only in
  `routes.tsx` (`allow(account)`). `Dashboard.tsx` still names paths in its `pages` lookup and in
  three comparisons, but those keys and comparisons are typed `DashboardPath` (`as const
  satisfies`). A route without a page, a page without a route, or a typo fails
  `npm run check`. The account dropdown's `href="/dashboard/account"` stays a literal so its
  markup is unchanged. The only other literal is the legacy `/dashboard/profile` redirect.
- **Data-state refinements stay in Dashboard, as planned.** These are: the driver links hidden
  until `/drivers/me` resolves, Availability only once approved, the Register Vehicle /
  My Vehicle label, and the loading/error gate (`awaitingVehicle`).
- **`/auth/callback`.** `LoginPage.tsx:109` and the `replaceState` cleanup are untouched.
  `usePath()` re-reads `location.pathname` on every render, so the cleanup is seen without an
  event. The routing spec confirms an authenticated callback still lands on Trips.
- **Bundle:** frontend JS went 616,250 → 615,533 bytes minified (165,321 → 165,290 gzip), down
  0.7 kB. The Vite >500 kB advisory is unchanged and no dependency was added.
  `npm run check`, `npm run build` (both workspaces) and `git diff --check` pass.
- **Files changed:** `src/routes.tsx` (new), `src/pages/LoginPage.tsx`,
  `src/pages/Dashboard.tsx`, `tests/routing.spec.ts` (new). Nothing under `src/styles/`,
  `src/components/`, or the bodies of `TripsPage`, `PatientsPage` or `TreatmentSchedules` was
  touched.
- **For the separate docs PR:** in `CLAUDE.md`, the test count (36 → now 26), the `styles.css`
  description, the "twelve" no-data-path states, and the routing location (now
  `src/routes.tsx`). In `use-case-map.md`, the driver entry route. In `dialog_map.py`, the three
  unmodelled routes.
