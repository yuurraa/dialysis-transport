# Folder Organisation Implementation Plan

**Goal:** Make source ownership discoverable without changing application behavior.

**Design:** User approved full frontend/backend organisation and immediate execution. Use frontend feature folders, preserve backend domain modules, group provider integrations and shared infrastructure. Retain stylesheet ownership, entry points, database deployment order, test discovery and submitted document paths.

**Architecture:** Move files and rewrite relative imports by resolving their original targets before moving either endpoint. Keep existing dependency directions and public exports.

**Authority:** User request to organise the full application on feat/google-calendar. Existing ownership notes permit this explicitly requested cross-cutting reorganisation.

**Tasks:**
- [x] Map file owners and rewrite source/test imports while moving files.
- [x] Update active documentation and provide a source layout guide.
- [x] Verify import targets, mechanical equivalence, whitespace and production builds.

**Review focus:** Relative imports including CSS; backend dependency injection identity; cross-workspace test imports; unchanged startup/build paths; stylesheet and SQL order.

**Execution notes:** Inline, reversible move-only refactor. No new tests or dependencies; automated test execution is reserved for explicit requests. Existing feature branch retained. No commit or push requested.

**Verification results:** Both production builds passed. All 101 existing source/test TypeScript files were compared against HEAD after normalising only relative import specifiers: no other code changes. All relative imports resolve and all 60 moves are complete. `git diff --check` passed. Automated tests were not executed. Vite reports a bundle-size advisory; bundle splitting is outside this move-only change.
