# CoolRoute — v1 Prototype

Heat-aware pedestrian routing for Hong Kong. **Pilot district: Central (中環).**
Enter A → B, get three routes on real streets — **Fastest / Coolest / Balanced** — each explained with time, distance, shade %, heat score, estimated comfort, cooling points passed, and the most sun-exposed stretches.

Built to the spec in `../CoolRoute_System_Architecture_and_Build_Guide.docx` (research checked 2026-10-03).

---

## 1. What v1 does now

| Feature | Status |
|---|---|
| Interactive web map (MapLibre GL + CARTO Voyager basemap) | ✅ |
| A/B input: 13 landmark presets + drop a pin **anywhere** on the map | ✅ |
| **Real pedestrian routing** via OSRM foot demo server (`routing.openstreetmap.de`, OpenStreetMap data, no API key) | ✅ |
| Three route modes compared side-by-side (cards + comparison bars) | ✅ |
| Time-aware shade: NOAA solar position from the departure-time slider (06:00–21:00 HKT, "Now" button) | ✅ |
| Thermal scoring per ~30 m segment: street-name → canyon table (width, podium height, trees); escalators / subways / footbridges auto-detected as covered | ✅ |
| Live weather (Open-Meteo hourly: temp, feels-like, RH, wind, cloud) with stale-data fallback | ✅ |
| 9 cooling POIs (❄ IFC, Central Market, City Hall, Tai Kwun, PMQ…) with type + hours; routes list the ones they pass | ✅ |
| Heat-sensitivity slider (personalisation placeholder) re-weights the Balanced objective and the "Best for you" pick | ✅ |
| Explainability: "☀ most exposed" streets per route; full methodology dialog (formula, weights, sources, licences, failure modes) | ✅ |
| Failure modes: routing API down → simulated pilot grid + on-screen notice; weather down → cached snapshot + stale warning | ✅ |

## 2. Run it

Static site — no build step. Open `index.html` in a browser (or serve the folder).
**Requires internet** for: MapLibre CDN, CARTO basemap tiles, OSRM routing, Open-Meteo weather.

```
prototype/
  index.html      UI layout + methodology dialog
  styles.css      styling
  data.js         Central canyon table, landmarks, cooling POIs, via points, config
  engine.js       solar position, shade model, heat cost, Dijkstra, route scoring
  app.js          map + UI wiring, API routing pipeline, fallback
  test_engine.js  Node test — grid engine (fallback path)
  test_routing.js Node test — thermal scoring of real OSRM routes (fixture)
  sample_route.json  saved OSRM response used by test_routing.js
```

Tests (Node 22):

```bash
node test_engine.js     # solar position, 3 objectives differ on the grid
node test_routing.js    # bilingual name parsing, real-route thermal scoring
```

## 3. How it works (pipeline)

```
A/B + departure time
  → OSRM foot: direct query (alternatives=3) + ≤3 shade-corridor waypoint variants
  → dedupe by geometry signature
  → per candidate: split into ≤30 m segments
  → street name → canyon params (streetTable / coveredHints / defaults)
  → shade = f(sun elevation & azimuth, segment bearing, podium height, width, trees, covered)
  → EdgeHeatCost = length × (0.35·HeatIndex + 0.30·SunExposure + 0.10·LowWind
                             + 0.15·SurfaceHeatProxy − 0.10·CoolingAccess)   [guide §7.1]
  → Fastest = min API time · Coolest = min cumulative heat cost
    Balanced = min time × (1 + λ·heat), λ = 0.4 + 2 × sensitivity
```

Scores are normalised 0–100 and are **relative comparisons only** — no medical or safety claims (per guide §7.1, §17).

## 4. Coverage vs. the build guide

### Implemented
- **Target MVP** (guide header): single HK pilot district, A→B, 3 routes with time / distance / shade-sun / comfort — ✅ done.
- **§8 time-aware algorithm**, steps 1–7 — ✅ done. Step 8 (confidence / data freshness) — ⚠️ partial: weather staleness is shown; no per-route confidence indicator.
- **§7.1 MVP comfort score** — ✅ exact formula, domain weights w1–w5 = 0.35/0.30/0.10/0.15/0.10.
- **§9 objectives** — ✅ Fastest, Coolest, Balanced.
- **§12 build plan items** — map, routing, weather+solar, shade, thermal score, 3 modes, cooling POIs — ✅ done.
- **§15 failure modes** — weather stale ✅; routing down → fallback ✅; snap failure (OSRM snaps; pins free) ✅; "no cooling point along route stays valid" ✅.
- **§16 licensing** — sources + licences recorded in the methodology dialog ✅.
- **§17 (what not to build)** — respected: no CFD, no native app, no black-box model, no medical claims.
- **§18 demo scenario** — Central, 14:00, 3 routes compared, cooling point on route, updates when departure time changes ✅.

### Partial / simplified (deliberate for v1)
- **§5/§6 routing engine** — guide recommends a *local graph* (OSMnx/Valhalla) with custom edge costs. v1 instead takes OSRM demo-server **candidates** and scores them client-side: equivalent demo value, but the coolest route can only be chosen from returned candidates, not the full graph.
- **§3 spatial layers** — buildings/trees are a hand-tuned canyon table keyed on ~30 named Central streets, not LandsD/CSDI building heights or tree datasets.
- **§10 personalisation / AI** — deterministic baseline ✅; the "learning" stage is a manual sensitivity slider, not a learned preference model.
- **§11 tech stack** — v1 is a vanilla-JS static page (zero backend), not React+TS / FastAPI / PostGIS / Valhalla. Logic is modular so it ports over.
- **§14 data model** — `WeatherSnapshot` / `RouteResult` exist conceptually; `Edge.shade_pct_by_hour` is computed live per segment instead of stored.

### Not in v1 (roadmap)
- **§9 "Cooling Stops" objective** (guarantee a cooling point within N minutes).
- **§8 step 8 confidence indicator** per route + wording downgrade when confidence is low.
- **§7.2 MRT / PET / UTCI** via pythermalcomfort + pvlib + pybdshadow (needs real building geometry).
- Response caching / self-hosting for rate limits (§15, §16).
- HKO weather source; LandsD 3D Pedestrian Route Search API as a routing provider.

## 5. Known bugs & limitations

**Fixed in the v1 audit (2026-10-03):**
- ~~Unnamed steps (footpaths/plazas) inherited the default street canyon (18 m podium) → open harbourfront walkways were scored too shady.~~ Now a separate `unnamedCanyon` (h = 10 m). Residual: indoor mall passages vs open plazas are still indistinguishable without OSM `covered`/`indoor` tags.
- ~~"Dropped pin 📍" was selectable from the dropdown without dropping a pin (no-op).~~ Option now disabled for manual selection.
- ~~Departure/sensitivity sliders fired an API request on every tick while dragging.~~ Recompute is now debounced (350 ms).
- ~~Disclaimer still read "simulated pilot network" after the switch to real streets.~~ Corrected.

**Open / accepted:**
1. **Candidate-based "coolest"** — if the OSRM alternatives don't include a shady corridor, Coolest may equal Fastest (honest, but limits the demo on some ODs). Mitigation: shade-waypoint variants; proper fix = own graph (Valhalla/OSMnx).
2. **Canyon table coverage** — outside ~30 named Central streets, default parameters apply and heat scores get coarser the further you leave the pilot area.
3. **Absolute comfort bands** — on extreme-heat days every route shows red; the numbers still rank routes relatively (by design, but visually flat).
4. **Weather has no retry** — if the first fetch fails, the app stays on the stale snapshot until reload.
5. **Departure is "today, 06:00–21:00 HKT" only** — no date picker; outside daylight the model assumes full shade.
6. **OSRM demo server is fair-use** — no SLA, no caching; heavy use should move to self-hosted Valhalla (see guide §16).
7. **Route dedupe samples every 4th coordinate** — two near-identical routes could theoretically collapse into one.
8. **Grid-fallback snapping** — in offline-fallback mode, pins far outside Central silently snap to the nearest simulated node.
9. **HKT is hardcoded** for "Now" and sun calculations (by design — HK-only product).
10. **Preview requires internet** — CDN, tiles, routing, and weather are all remote; nothing is bundled.

## 6. v2 roadmap (from the guide)

1. Own pedestrian graph (Valhalla self-host or OSMnx export) → true full-graph heat routing + Valhalla/LandsD providers behind one adapter.
2. LandsD/CSDI building heights + tree datasets → per-edge shade from real geometry (pybdshadow-style), replacing the canyon table.
3. pythermalcomfort MRT/PET/UTCI upgrade; survey-calibrated weights.
4. Cooling-Stops objective + per-route confidence + wording downgrade.
5. React + FastAPI + PostGIS re-platform; PostGIS-cached edge scores; route-choice logging → learned preference model (§10).
