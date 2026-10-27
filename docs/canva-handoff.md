# Canva UI handoff

**Update 2026-10-28 (D50):** the team's mockups (`ui reference/`) are
implemented in the existing app. The page-by-page mapping and every deliberate
difference are in `docs/decisions.md` D50. Visual approval against the PDFs is
still pending the team's review in a browser. The inventory below remains the
behaviour to preserve.

Visual design is **pending the Canva references**. The current screens use a
plain high-contrast theme (`apps/mobile/src/theme.ts`). They are functionally
tested, but their look is not approved. The Canva designs will define
appearance only. They do not change data contracts, safety rules,
observe-only behaviour, or the D29, D46 and D48 decisions.

## Screen inventory (current behaviour to preserve)
Navigation is state-based (D5). There are no URL routes: one `index.html`.

| Screen / section | File | Shown when | Data source | States that need a design |
|---|---|---|---|---|
| Pairing | `src/screens/PairingScreen.tsx` | Field build, no stored session | Local gateway `POST /api/v1/pairing` | Empty input; submitting; errors (wrong code, rate-limited with wait time, no pairing set up, gateway unreachable, timeout, unreadable answer); "pairing ended" notice |
| Paired view: header, connection banner, status card, section tabs | `src/screens/StatusScreen.tsx` | Field build, stored session | `GET /api/v1/robot/status`, polled every 10 s | Connecting; connected; gateway unavailable; "Latest report" vs "Last received"; fresh vs stale age; no status data; faults list; self-check "Unknown" dot; tabs "Robot status" / "Run results" (status card scrolls with the page, D46) |
| Robot status section | `StatusScreen.tsx` | Tab "Robot status" | (none) | Status-limitation note; "Forget this device" with confirm and cancel |
| Results: run list | `src/screens/ResultsScreen.tsx` | Tab "Run results" | `GET /api/v1/runs` | Loading; failed with "Try again"; empty; list rows (title, synthetic tag, recorded time range, record count, "Run status: not reported by the gateway"); all-runs note (D46) |
| Results: run detail | `ResultsScreen.tsx` | A run is selected | `GET /runs/:id/readings`, `GET /runs/:id/recommendation` | Back button; readings loading, failed with retry, empty, missing run; per-record rows (pH, EC "unit unconfirmed", moisture, temperature, lime commanded, expected post-correction pH, robot time); run total commanded lime with "not a measurement" note; recommendation loading, failed with retry, "not stored yet", available (warning banner for synthetic/draft/retired, rule set and time, inputs, weather note, top-5 crops with reasons, Open-Meteo credit when a forecast was used) |
| Landing | `src/screens/LandingScreen.tsx` | Native build with no gateway URL | (none) | "No robot data yet" |
| Online notice | `src/screens/OnlineUnavailableScreen.tsx` | Online (Vercel) build (D48) | (none) | "Online access is not available yet"; "misconfigured build" |

**Must stay visible in any design:**
- synthetic-data labels
- "commanded, not measured" lime notes
- "unit unconfirmed" on EC
- ages and stale labels
- "expected post-correction pH" (never "predicted")
- the status-limitation note

**Must not appear:**
- cell maps, field selection, cell-progress counts or percentages (D29)
- verification or observed post-treatment data
- any robot-control button

## Assets to supply from Canva
1. **Frames for every screen and state** listed above, at a narrow width
   (about 375 px) and a laptop width (about 1280 px). The laptop is the field
   interface (D41).
2. **Colour tokens:** hex values for background, surfaces, borders, primary,
   text and muted text, plus the success, warning/stale and error states.
   Include the contrast intent: sunlight readability needs strong contrast,
   and colour must never be the only signal.
3. **Typography:** font families, weights and sizes per text role. The font
   files and their licences must be supplied; field screens may not load
   fonts from a CDN.
4. **Spacing and sizing:** the spacing scale, corner radii, border widths,
   and minimum touch-target size (currently 52 px).
5. **Icons and images:** SVG or PNG exports with licences, bundled locally.
   The self-check dot states (ok, fault, unknown) need distinct shapes or
   labels, not just colour.
6. **Component states:** default, pressed, focused and disabled for buttons,
   tabs, run rows and the text input.
7. **Notes** on anything in a design that would need new data. That needs a
   decision before it can be implemented.
