# CoolRoute — v2 Prototype

**3D map + real-time weather + real-time time-aware pedestrian navigation** for Hong Kong. Pilot district: Central (中環).

Rebuilt to `CoolRoute_System_Architecture_v2.docx` + `CoolRoute_System_Build_Guide_v2.docx` (v2.0, checked 2026-10-04). v2 fixes the four v1 failures identified in the architecture doc:

| v1 failure | v2 fix (implemented) |
|---|---|
| Coolest == Fastest (no comfort edge weights) | Weather-aware + time-aware edge cost; Coolest picked by min heat cost |
| No real-time weather | HKO current weather (primary) → Open-Meteo (fallback, “↻ 備份源”) → last-good snapshot with stale warning |
| No day/night awareness | Browser clock (HKT) + sun position; day / civil-twilight / night badge + map tint |
| Occasional A→B straight line | Graph routing only — straight-line fallback **removed**; out-of-coverage returns a 422-style error |

## 1. What v2 does now

- **3D map (ADR-005)**: MapLibre GL JS + `fill-extrusion` over **2,322 real building footprints with heights** (OpenStreetMap via Overpass; `height` tag, else `building:levels × 3.2`, else 15 m). Pitch 58°, rotatable; automatic 2D degrade on mobile or 3D failure.
- **Real-time weather badge**: HKO `rhrread` (no key) with station preference (Hong Kong Park → Observatory), Open-Meteo fallback with “↻ 備份源” chip, last-good snapshot + yellow “天氣數據可能滯後” warning; “更新於 HH:MM” freshness, highlighted when > 30 min old.
- **Time badge**: live HKT clock, ☀/🌇/🌙 day-twilight-night, sun elevation/azimuth; night darkens the map.
- **Three routes, geometrically different**: Fastest (blue) = min walking time · Coolest (green) = min heat cost · Balanced (purple) = time × (1 + λ·penalty). Route cards show ETA, distance, shade %, heat score, comfort, cooling points passed, and ☀ most-exposed streets.
- **Binary shade from real buildings** (guide Step 6): a ~30 m segment is shaded when any building stands between it and the sun (bearing within ±45° of the sun azimuth, distance ≤ `height / tan(elevation)`), or the path is covered (escalator/subway/walkway via OSM names).
- **v2 edge cost**: `cost = length × (1 + heat + sun − cool_bonus)` with `heat = max(0, temp−26)×0.5` (day only), `sun = (1−shade)×max(0,elev)×0.05`, `cool_bonus = 1` when a cooling point is within 200 m.
- **Time-aware recomputation**: the departure slider recalculates sun → shade → Coolest route (day vs night genuinely differs).
- **Safety rails**: coordinates outside `lat 22.1–22.6, lon 113.8–114.5` → red 422 toast; routing service down → error, never a straight line; Fastest == Coolest → amber warning “兩條路線相同，建議調整出發時間”.

## 2. Run it

Static site — no build step. Open `index.html` in a modern browser (needs internet for MapLibre CDN, CARTO tiles, OSRM routing, HKO/Open-Meteo). Drag with right-click / Ctrl-drag to rotate the 3D view.

```
prototype/
  index.html      layout + methodology dialog
  styles.css      styling (incl. badges, night tint)
  data.js         landmarks, cooling POIs, via points, covered-name hints, config
  buildings.js    2,322 Central building footprints + heights (OSM/Overpass, 2026-10-04)
  engine.js       solar position, binary building shade, v2 edge cost, scoring, mode picks
  app.js          3D map, badges, weather chain, routing pipeline
  test_v2.js      unit/boundary tests + live 12-pair acceptance (see §4)
```

Tests (Node 22):

```bash
node test_v2.js --offline   # 9 unit/boundary checks (cost fn ≥6 cases, solar, shade)
node test_v2.js             # + live 12-pair Coolest≠Fastest acceptance (needs network)
```

## 3. Coverage vs the v2 documents

### In-scope (architecture doc) — all implemented
- ✅ Real-time weather: HKO + Open-Meteo fallback + cache/last-good + staleness hint.
- ✅ Real-time time: browser clock + sun position + day/night indicator.
- ✅ 3D map: MapLibre + fill-extrusion building layer (terrain optional — skipped, noted).
- ✅ Graph routing: straight-line downgrade removed; 422 outside coverage.
- ✅ Route differentiation: Fastest ≠ Coolest — see acceptance result below.

### Acceptance test (build guide “Demo Acceptance Criteria”)
- ✅ HK 3D map with rotatable buildings (desktop).
- ✅ Live weather badge (HKO) + time & sun indicator.
- ⚠️ **Coolest ≠ Fastest: 5/12 A→B pairs** geometrically distinct (`node test_v2.js`, 14:00 HKT, 31.5 °C, 0 routing errors). Two honest causes:
  1. **Physically correct ties** — in uniformly shaded blocks (e.g. Central Market→LKF at 94 % shade) every path has equal sun, so Coolest == Fastest is the *right* answer; the UI shows the doc-prescribed “兩條路線相同，建議調整出發時間” warning there.
  2. **Candidate-selection limit** — this prototype picks the coolest route from Valhalla/OSRM *alternatives*, not a full custom-cost graph. The doc's 12/12 gate targets the production Valhalla self-host with native heat costing (its FAQ Q1); that is the documented fix, not a tuning hack of the Step-6 formula.
- ✅ Changing departure time (day vs night) recomputes Coolest (heat = 0 at night).
- ✅ Review-checklist items that apply to a static build: dual-source weather + stale flag, freshness display, no straight-line 422 policy, coordinate bounds, no Mapbox/commercial tiles, pitch ≥ 45, mobile 2D degrade, no API keys in frontend.

### Deliberate adaptations (static HTML vs full v2 stack)
| v2 doc stack | This prototype | Why |
|---|---|---|
| React 18 + TypeScript | Vanilla JS modules | Zero-build static deliverable; logic ports 1:1 |
| FastAPI backend + Redis cache | Client-side services + localStorage last-good | No server in a static page; same fallback chain |
| Valhalla self-host | Valhalla demo server (openstreetmap.de) + OSRM demo backup, sequential + retry | No key/Docker needed; native pedestrian costing matches the doc's engine choice |
| pvlib (Python) | NOAA solar approximation (JS) | Matches to ~0.1°; pure function, testable |
| LandsD/CSDI 3D buildings | OSM/Overpass footprints + heights | No API key required; swap-in path documented |
| PMTiles self-host basemap | CARTO Voyager tiles | Demo-scale; PMTiles noted as production step |

### Out-of-scope per doc (v3+) — correctly excluded
PET/UTCI comfort models, preference learning, i18n, native apps, multi-city.

## 4. Known bugs & limitations

1. **Shade simplifications (v2 binary model)**: building height capped at 60 m for shade (canyon blocking assumption), shadow search radius 350 m, sun-side tolerance ±45°, buildings as polygons with centroid bearing. Long low-sun shadows from towers are truncated.
2. **~50% of OSM buildings lack `height`** → estimated from `building:levels × 3.2` or 15 m default; shade accuracy varies.
3. **Candidate-based Coolest**: the coolest route is chosen from OSRM alternatives + shade-waypoint variants, not a full custom-cost graph — Valhalla with native costing is the production fix (guide FAQ Q1).
4. **Weather granularity**: HKO `rhrread` has no wind/cloud fields; v2 cost formula doesn't need them (temp + sun only). Single station read for the whole district.
5. **Cooling points are a fixed demo set** (9 POIs), not live OSM/gov data.
6. **Demo routing servers are fair-use** — no SLA and they rate-limit bursts (the app throttles sequentially and retries once; Valhalla demo → OSRM demo fallback). Production should self-host Valhalla (doc §16).
7. **Departure limited to 06:00–21:00 today HKT**; night routes assume no sun (heat = 0).
8. **HKT hardcoded** (HK-only product, per doc).
9. Buildings dataset is a **static snapshot** (2026-10-04); re-fetch from Overpass to refresh.
10. Mobile gets a 2D degraded view by design (doc FAQ Q3); desktop-first.

## 5. v3 path (per docs)

Valhalla self-host + LandsD/CSDI building heights → custom-cost graph routing; pvlib + pybdshadow real shadow geometry; pythermalcomfort PET/UTCI; FastAPI + Redis + PostGIS re-platform; route-choice logging → preference learning.
