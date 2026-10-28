# Demo clock

The approved fix is a clock scoped to each demo journey. The assigned pickup,
treatment and session dates remain unchanged when Make pickup due is selected.
Instead, that control moves the demo clock to pickup and starts it at normal speed.
Before activation the clock is paused before the planned pickup, allowing assignment
and patient acknowledgement. Repeating the control must never rewind a running clock.

Trip eligibility, start/completion timestamps, availability and recovery planning use
the demo clock. Request expiry, credentials, route-cache age, audit records and GPS
freshness use real time. Ordinary trips always use real time. Existing RBAC, booking
conflicts and saved driver availability remain enforced. Reset creates a fresh clock.
Controls display the simulated Singapore date/time and explain the clock transition.

Moving bookings to real time caused the reported failure. Disabling availability
would conceal it; changing the global clock would affect real users. A clock carried
on the tagged trip is the smallest option that also works across role switches and
allows the existing trip responses to supply the browser with the same clock.

Deployment uses the repository's canonical, idempotent database/schema.sql. No live
database write is possible through the currently connected Supabase account.
