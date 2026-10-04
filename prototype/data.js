/* CoolRoute v2 prototype — app data & config.
 * Per v2 docs: no simulated grid, no straight-line fallback — graph routing only.
 * Buildings live in buildings.js (real OSM/Overpass footprints + heights).
 * Exposed as global CR_DATA and as module.exports for Node tests.
 */
(function (root, factory) {
  const data = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = data;
  else root.CR_DATA = data;
})(typeof self !== "undefined" ? self : this, function () {
  // ---- Landmark presets for A / B pickers (real coordinates, Central HK)
  const landmarks = [
    { name: "IFC Mall / Airport Express", lat: 22.2849, lon: 114.1581 },
    { name: "Star Ferry Pier",            lat: 22.2877, lon: 114.1610 },
    { name: "Exchange Square",            lat: 22.2838, lon: 114.1583 },
    { name: "City Hall",                  lat: 22.2825, lon: 114.1615 },
    { name: "Central Market",             lat: 22.2840, lon: 114.1548 },
    { name: "Landmark",                   lat: 22.2814, lon: 114.1577 },
    { name: "Central Station",            lat: 22.2820, lon: 114.1582 },
    { name: "The Center",                 lat: 22.2846, lon: 114.1544 },
    { name: "Escalator (Queen's Rd)",     lat: 22.2838, lon: 114.1552 },
    { name: "Lan Kwai Fong",              lat: 22.2808, lon: 114.1554 },
    { name: "Tai Kwun",                   lat: 22.2818, lon: 114.1542 },
    { name: "PMQ",                        lat: 22.2831, lon: 114.1517 },
    { name: "SoHo (Elgin St)",            lat: 22.2811, lon: 114.1528 }
  ];

  // ---- Cooling points (verified demo set; stands in for OSM/gov POI layer)
  const coolingPoints = [
    { id: "cp1", name: "IFC Mall",              type: "Mall",            hours: "10:00–22:00", lat: 22.2849, lon: 114.1581 },
    { id: "cp2", name: "Central Market",        type: "Market hall",     hours: "08:00–22:00", lat: 22.2840, lon: 114.1548 },
    { id: "cp3", name: "Exchange Square",       type: "Mall",            hours: "10:00–22:00", lat: 22.2838, lon: 114.1583 },
    { id: "cp4", name: "Landmark",              type: "Mall",            hours: "10:00–22:00", lat: 22.2814, lon: 114.1577 },
    { id: "cp5", name: "City Hall",             type: "Public building", hours: "09:00–22:00", lat: 22.2825, lon: 114.1615 },
    { id: "cp6", name: "Tai Kwun",              type: "Heritage / F&B",  hours: "11:00–23:00", lat: 22.2818, lon: 114.1542 },
    { id: "cp7", name: "PMQ",                   type: "Design / F&B",    hours: "11:00–20:00", lat: 22.2831, lon: 114.1517 },
    { id: "cp8", name: "SoHo cafés",            type: "F&B",             hours: "08:00–24:00", lat: 22.2811, lon: 114.1528 },
    { id: "cp9", name: "LKF convenience store", type: "Store",           hours: "24 h",        lat: 22.2808, lon: 114.1554 }
  ];

  // Keyword-based cover detection from OSM step names (covered → shade = 1)
  const coveredHints = [
    ["escalator", 0.95], ["subway", 1.0], ["underpass", 1.0],
    ["footbridge", 0.60], ["elevated", 0.60], ["walkway", 0.55], ["arcade", 0.85]
  ];

  // Shade-rich corridors used to diversify route candidates (vias)
  const viaPoints = [
    { name: "Elevated walkway / IFC",  lat: 22.2858, lon: 114.1585 },
    { name: "Central Market",          lat: 22.2840, lon: 114.1548 },
    { name: "Mid-Levels Escalator",    lat: 22.2819, lon: 114.1525 },
    { name: "Tai Kwun / Hollywood Rd", lat: 22.2818, lon: 114.1538 },
    { name: "Statue Square / Chater",  lat: 22.2810, lon: 114.1597 },
    { name: "PMQ / Aberdeen St",       lat: 22.2831, lon: 114.1517 },
    { name: "Graham St Market",        lat: 22.2829, lon: 114.1538 },
    { name: "Hollywood Rd / Shelley",  lat: 22.2820, lon: 114.1494 },
    { name: "Bonham Strand West",      lat: 22.2856, lon: 114.1503 },
    { name: "Duddell St",              lat: 22.2801, lon: 114.1570 }
  ];

  // Routing providers (tried in order). Primary = Valhalla demo (pedestrian
  // costing — the v2 docs' preferred engine); OSRM foot demo as backup.
  // Production path per v2 docs: self-hosted Valhalla / LandsD API.
  const routingProviders = [
    {
      name: "valhalla",
      label: "Valhalla pedestrian (openstreetmap.de demo)",
      url: "https://valhalla1.openstreetmap.de/route",
      timeoutMs: 12000
    },
    {
      name: "osrm",
      label: "OSM foot routing (routing.openstreetmap.de demo)",
      url: "https://routing.openstreetmap.de/routed-foot/route/v1/foot/",
      timeoutMs: 10000
    }
  ];
  // Backward-compat alias
  const routingService = routingProviders[1];

  // Hong Kong coverage bounds (build-guide security checklist):
  // coordinates outside are rejected with a 422-style error, never straight-lined.
  const hkBounds = { latMin: 22.1, latMax: 22.6, lonMin: 113.8, lonMax: 114.5 };

  // Default weather snapshot (last-good fallback when HKO + Open-Meteo both fail)
  const fallbackWeather = {
    tempC: 31.5, rhPct: 75, source: "cached snapshot (stale)",
    fetchedAt: null, stale: true
  };

  const center = { lat: 22.2839, lon: 114.1553 };   // pilot-district centroid

  return {
    landmarks, coolingPoints, coveredHints, viaPoints,
    routingProviders, routingService, hkBounds, fallbackWeather, center
  };
});
