# Stylesheet ownership

`../styles.css` is the single entry point imported by `main.tsx`. It contains imports only, so Vite bundles these files into one stylesheet without adding runtime requests or component-loading order dependencies.

| File | Owns |
| --- | --- |
| `tokens.css` | Light/dark colours, typography defaults and design tokens |
| `base.css` | Element defaults, focus and reduced motion |
| `public.css` | Landing, sign-in, signup and session restoration |
| `dashboard.css` | Navigation, workspace layout and shared page containers |
| `components/controls.css` | Form fields, action rows and foundational control styles |
| `components/button-variants.css` | Semantic button variants and shared control shapes |
| `components/feedback.css` | Loading, empty/error states and notifications |
| `components/lists.css` | Headings, search/filter/sort, numbering and pagination |
| `components/dialogs.css` | Modal layout, footers and filter/sort dialog variants |
| `components/dropdown.css` | Bounded dropdowns and centre-picker results |
| `pages/patients.css` | Patient directory and mobile patient records |
| `pages/profile.css` | Profile display and inline editing |
| `pages/trips.css` | Pickup summary, trip rows, route timeline and trip details |
| `pages/schedules.css` | Schedule rows, editor, generation and Add action |

## Editing rules

- Add a rule to its owning file, with its responsive and accessibility rules. Do not append feature rules to the entry point or introduce a general overrides file.
- Shared classes retain their existing names. In particular, `patient-field`, `patient-form-fields` and `patient-actions` are shared controls; they are not exclusive to the patient directory.
- Keep shared page-container rules together in `dashboard.css`: record pages combine `page-panel` with page-specific classes, so splitting their sizing rules can change equal-specificity precedence.
- Keep schedule heading actions in `pages/schedules.css` and next-pickup styles in `pages/trips.css`, including rules referencing shared controls.
- Pagination owns its safe-area and Firefox Android workaround in `components/lists.css`. Its measured height is still managed by `ListPagination`; the schedule FAB consumes that height.
- Preserve import order. Foundations load before page-specific rules; shared button variants load last. Keep the relative order of existing rules and media queries within each owner when moving styles.
- This extraction preserves selectors and media/supports conditions. It removes only earlier declarations repeated identically later for the same selector and conditions; declarations with differing values, including fallbacks, remain intact. It does not rename classes or introduce cascade layers, CSS Modules or new dependencies.

## Verification

Use `npm run build --workspace frontend` for TypeScript and CSS compilation, and `git diff --check` for whitespace issues. A structural extraction can also be audited by comparing each selector's declaration sequence within its media/supports context; review competing selectors when changing import order. Browser tests require an explicit user request and must not be run automatically. No new tests are needed solely for moving stylesheet rules.
