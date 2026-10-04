/* CoolRoute v1 prototype — simulated pedestrian network for Central, Hong Kong.
 * Geometry follows real Central street alignments approximately; edge attributes
 * (building height, street width, tree cover, covered walkway) are hand-tuned
 * demo values standing in for LandsD/CSDI + OSM layers in the full build.
 * Exposed as global CR_DATA and as module.exports for Node tests.
 */
(function (root, factory) {
  const data = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = data;
  else root.CR_DATA = data;
})(typeof self !== "undefined" ? self : this, function () {
  // ---- Street axes -------------------------------------------------------
  // hS/hN/hW/hE = effective shading height (street podium) in metres: towers
  // set back above the podium, so only the podium wall casts on the carriageway.
  // East-west corridors, south -> north
  const EW = [
    { id: "staunton",   lat: 22.2806, label: "Staunton St (SoHo)",   width: 10, hS: 18, hN: 20, trees: 0.30, surface: 0.70, speed: 0.95 },
    { id: "hollywood",  lat: 22.2819, label: "Hollywood Rd",         width: 13, hS: 20, hN: 22, trees: 0.35, surface: 0.75, speed: 0.95 },
    { id: "wellington", lat: 22.2828, label: "Wellington St",        width: 12, hS: 22, hN: 25, trees: 0.15, surface: 0.85, speed: 0.90 },
    { id: "queens",     lat: 22.2839, label: "Queen's Rd Central",   width: 16, hS: 25, hN: 28, trees: 0.10, surface: 0.90, speed: 1.00 },
    { id: "desvoeux",   lat: 22.2850, label: "Des Voeux Rd (tram)",  width: 22, hS: 28, hN: 30, trees: 0.05, surface: 0.95, speed: 1.05 },
    { id: "connaught",  lat: 22.2861, label: "Connaught Rd",         width: 28, hS: 30, hN: 15, trees: 0.08, surface: 0.90, speed: 1.05 },
    { id: "waterfront", lat: 22.2873, label: "Harbourfront Walk",    width: 20, hS: 30, hN: 0,  trees: 0.15, surface: 0.80, covered: 0.8, speed: 1.10 }
  ];
  // North-south corridors, west -> east
  const NS = [
    { id: "shelley",   lon: 114.1492, label: "Shelley St",        width: 8,  hW: 14, hE: 14, trees: 0.35, surface: 0.75, speed: 0.75 },
    { id: "aberdeen",  lon: 114.1508, label: "Aberdeen St",       width: 9,  hW: 14, hE: 16, trees: 0.30, surface: 0.80, speed: 0.90 },
    { id: "cochrane",  lon: 114.1525, label: "Cochrane St",       width: 10, hW: 15, hE: 16, trees: 0.15, surface: 0.85, speed: 1.00 },
    { id: "graham",    lon: 114.1538, label: "Graham St Market",  width: 8,  hW: 14, hE: 15, trees: 0.05, surface: 0.95, speed: 0.75 },
    { id: "wyndham",   lon: 114.1553, label: "Wyndham St",        width: 12, hW: 16, hE: 18, trees: 0.10, surface: 0.90, speed: 0.95 },
    { id: "duddell",   lon: 114.1570, label: "Duddell St",        width: 10, hW: 18, hE: 20, trees: 0.20, surface: 0.85, speed: 1.00 },
    { id: "pedder",    lon: 114.1583, label: "Pedder St",         width: 18, hW: 20, hE: 22, trees: 0.08, surface: 0.90, speed: 1.00 },
    { id: "harbour",   lon: 114.1605, label: "Edinburgh Pl",      width: 22, hW: 12, hE: 10, trees: 0.25, surface: 0.85, speed: 1.00 }
  ];
  // Which NS corridors reach the harbourfront row
  const WATERFRONT_NS = new Set(["pedder", "harbour"]);
  // Segments with covered walkways / escalator (fraction 0..1), keyed "a|b"
  const COVERED = {
    "cochrane:queens|staunton": 0.95,     // Central–Mid-Levels Escalator tube
    "shelley:staunton|hollywood": 0.90,   // Escalator upper section
    "connaught:duddell|pedder": 0.70,     // Exchange Sq / IFC elevated walkway
    "connaught:pedder|harbour": 0.70,
    "graham:wellington|queens": 0.35      // market stall awnings
  };

  // ---- Build graph -------------------------------------------------------
  const nodes = {};   // id -> {id, lat, lon, label}
  const edges = [];   // {id, a, b, street, axis:'EW'|'NS', width, hSunSide?, h1, h2, trees, surface, covered, coords}
  const ewById = Object.fromEntries(EW.map(e => [e.id, e]));
  const nsById = Object.fromEntries(NS.map(e => [e.id, e]));

  function nodeId(ew, ns) { return ew + "__" + ns; }
  function addNode(ew, ns) {
    const id = nodeId(ew, ns);
    if (!nodes[id]) nodes[id] = { id, lat: ewById[ew].lat, lon: nsById[ns].lon, label: ewById[ew].label + " × " + nsById[ns].label };
    return id;
  }
  function coveredFor(axis, streetId, aId, bId) {
    const key1 = streetId + ":" + aId + "|" + bId;
    const key2 = streetId + ":" + bId + "|" + aId;
    return COVERED[key1] || COVERED[key2] || 0;
  }

  // EW edges: along each corridor between consecutive NS streets it intersects
  for (const ew of EW) {
    const nsList = ew.id === "waterfront" ? NS.filter(n => WATERFRONT_NS.has(n.id)) : NS;
    for (let i = 0; i < nsList.length - 1; i++) {
      const a = addNode(ew.id, nsList[i].id), b = addNode(ew.id, nsList[i + 1].id);
      edges.push({
        id: "e" + edges.length, a, b, street: ew.label, axis: "EW",
        width: ew.width, h1: ew.hS, h2: ew.hN,   // h1 = south side, h2 = north side
        trees: ew.trees, surface: ew.surface, speed: ew.speed || 1,
        covered: Math.max(ew.covered || 0, coveredFor("EW", ew.id, nsList[i].id, nsList[i + 1].id)),
        coords: [[nodes[a].lon, nodes[a].lat], [nodes[b].lon, nodes[b].lat]]
      });
    }
  }
  // NS edges: along each corridor between consecutive EW streets it intersects
  for (const ns of NS) {
    const ewList = WATERFRONT_NS.has(ns.id) ? EW : EW.filter(e => e.id !== "waterfront");
    for (let i = 0; i < ewList.length - 1; i++) {
      const a = addNode(ewList[i].id, ns.id), b = addNode(ewList[i + 1].id, ns.id);
      edges.push({
        id: "e" + edges.length, a, b, street: ns.label, axis: "NS",
        width: ns.width, h1: ns.hW, h2: ns.hE,   // h1 = west side, h2 = east side
        trees: ns.trees, surface: ns.surface, speed: ns.speed || 1,
        covered: Math.max(ns.covered || 0, coveredFor("NS", ns.id, ewList[i].id, ewList[i + 1].id)),
        coords: [[nodes[a].lon, nodes[a].lat], [nodes[b].lon, nodes[b].lat]]
      });
    }
  }

  // ---- Cooling points (v1: verified demo set, standing in for OSM/gov POIs)
  const coolingPoints = [
    { id: "cp1", name: "IFC Mall",              type: "Mall",            hours: "10:00–22:00", node: "waterfront__pedder" },
    { id: "cp2", name: "Central Market",        type: "Market hall",     hours: "08:00–22:00", node: "desvoeux__graham" },
    { id: "cp3", name: "Exchange Square",       type: "Mall",            hours: "10:00–22:00", node: "connaught__pedder" },
    { id: "cp4", name: "Landmark",              type: "Mall",            hours: "10:00–22:00", node: "desvoeux__pedder" },
    { id: "cp5", name: "City Hall",             type: "Public building", hours: "09:00–22:00", node: "connaught__harbour" },
    { id: "cp6", name: "Tai Kwun",              type: "Heritage / F&B",  hours: "11:00–23:00", node: "hollywood__wyndham" },
    { id: "cp7", name: "PMQ",                   type: "Design / F&B",    hours: "11:00–20:00", node: "hollywood__aberdeen" },
    { id: "cp8", name: "SoHo cafés",            type: "F&B",             hours: "08:00–24:00", node: "staunton__cochrane" },
    { id: "cp9", name: "LKF convenience store", type: "Store",           hours: "24 h",        node: "wellington__wyndham" }
  ].map(p => ({ ...p, lat: nodes[p.node].lat, lon: nodes[p.node].lon }));

  // ---- Landmark presets for A / B pickers (real coordinates) --------------
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

  // ---- Street canyon parameters by OSM street name ------------------------
  // w = street width (m), h = effective podium shading height (m),
  // trees = canopy fraction, surface = heat proxy 0..1, covered = fixed shade.
  // Names matched case-insensitively against the English part of OSM names.
  const streetTable = {
    "des voeux road central": { w: 22, h: 28, trees: 0.05, surface: 0.95 },
    "queen's road central":   { w: 16, h: 26, trees: 0.10, surface: 0.90 },
    "connaught road central": { w: 28, h: 28, trees: 0.08, surface: 0.90 },
    "hollywood road":         { w: 13, h: 21, trees: 0.35, surface: 0.75 },
    "wellington street":      { w: 12, h: 23, trees: 0.15, surface: 0.85 },
    "staunton street":        { w: 10, h: 19, trees: 0.30, surface: 0.70 },
    "elgin street":           { w: 9,  h: 18, trees: 0.25, surface: 0.75 },
    "aberdeen street":        { w: 9,  h: 15, trees: 0.30, surface: 0.80 },
    "cochrane street":        { w: 10, h: 16, trees: 0.15, surface: 0.85 },
    "graham street":          { w: 8,  h: 15, trees: 0.05, surface: 0.95, covered: 0.30 },
    "gage street":            { w: 8,  h: 15, trees: 0.05, surface: 0.95, covered: 0.25 },
    "wyndham street":         { w: 12, h: 17, trees: 0.10, surface: 0.90 },
    "duddell street":         { w: 10, h: 19, trees: 0.20, surface: 0.85 },
    "pedder street":          { w: 18, h: 21, trees: 0.08, surface: 0.90 },
    "shelley street":         { w: 8,  h: 14, trees: 0.35, surface: 0.75 },
    "peel street":            { w: 8,  h: 15, trees: 0.10, surface: 0.85 },
    "pottinger street":       { w: 8,  h: 15, trees: 0.05, surface: 0.85 },
    "ice house street":       { w: 10, h: 22, trees: 0.10, surface: 0.90 },
    "on lan street":          { w: 8,  h: 16, trees: 0.05, surface: 0.90 },
    "jubilee street":         { w: 10, h: 22, trees: 0.05, surface: 0.90 },
    "rumsey street":          { w: 12, h: 20, trees: 0.05, surface: 0.90 },
    "wing lok street":        { w: 12, h: 18, trees: 0.08, surface: 0.90 },
    "bonham strand":          { w: 14, h: 20, trees: 0.08, surface: 0.90 },
    "kau u fong":             { w: 8,  h: 14, trees: 0.10, surface: 0.85 },
    "lyndhurst terrace":      { w: 10, h: 18, trees: 0.10, surface: 0.85 },
    "leung fai terrace":      { w: 6,  h: 12, trees: 0.30, surface: 0.70 },
    "man kwong street":       { w: 20, h: 12, trees: 0.15, surface: 0.85 },
    "man fai street":         { w: 12, h: 10, trees: 0.10, surface: 0.85 },
    "man yiu street":         { w: 16, h: 15, trees: 0.10, surface: 0.85 },
    "statue square":          { w: 20, h: 8,  trees: 0.30, surface: 0.75 },
    "chater road":            { w: 16, h: 24, trees: 0.15, surface: 0.85 },
    "caine road":             { w: 14, h: 18, trees: 0.20, surface: 0.85 },
    "old bailey street":      { w: 10, h: 16, trees: 0.15, surface: 0.85 },
    "central-mid-levels escalator": { w: 6, h: 0, trees: 0, surface: 0.70, covered: 0.95 }
  };
  // Keyword-based cover detection for OSM names not in the table
  const coveredHints = [
    ["escalator", 0.95], ["subway", 1.0], ["underpass", 1.0],
    ["footbridge", 0.60], ["elevated", 0.60], ["walkway", 0.55], ["arcade", 0.85]
  ];
  const defaultCanyon = { w: 12, h: 18, trees: 0.12, surface: 0.85, covered: 0 };
  // Unnamed OSM steps (footpaths, plazas, stairs, mall passages): mostly open —
  // low effective shading so harbourfront walkways are not falsely marked shady.
  const unnamedCanyon = { w: 8, h: 10, trees: 0.15, surface: 0.80, covered: 0 };

  // Shade-rich corridors used to diversify route candidates (vias)
  const viaPoints = [
    { name: "Elevated walkway / IFC",     lat: 22.2858, lon: 114.1585 },
    { name: "Central Market",             lat: 22.2840, lon: 114.1548 },
    { name: "Mid-Levels Escalator",       lat: 22.2819, lon: 114.1525 },
    { name: "Tai Kwun / Hollywood Rd",    lat: 22.2818, lon: 114.1538 },
    { name: "Statue Square / Chater",     lat: 22.2810, lon: 114.1597 },
    { name: "PMQ / Aberdeen St",          lat: 22.2831, lon: 114.1517 }
  ];

  // Default weather snapshot (used as stale fallback if Open-Meteo fails) —
  // a typical hot HK afternoon, mirroring the guide's demo scenario.
  const fallbackWeather = {
    time: "cached 14:00",
    tempC: 33.2, apparentC: 38.1, rhPct: 72, windMs: 1.8, cloudPct: 25,
    source: "cached snapshot (stale)", stale: true
  };

  const center = { lat: 22.2839, lon: 114.1553 };   // pilot-district centroid

  // Routing service: OSRM foot profile demo server (OSM data, no key required)
  const routingService = {
    url: "https://routing.openstreetmap.de/routed-foot/route/v1/foot/",
    label: "OSM foot routing (routing.openstreetmap.de demo)",
    timeoutMs: 10000
  };

  return {
    nodes, edges, coolingPoints, landmarks, fallbackWeather, center,
    streetTable, coveredHints, defaultCanyon, unnamedCanyon, viaPoints, routingService
  };
});
