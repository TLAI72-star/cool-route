/* CoolRoute v1 prototype — deterministic thermal routing engine.
 * Implements the guide's MVP pipeline:
 *   sun position (pvlib stand-in) -> street-canyon shade -> edge heat cost
 *     EdgeHeatCost = length x (w1*HeatIndex + w2*SunExposure + w3*LowWind
 *                               + w4*SurfaceHeatProxy - w5*CoolingAccess)
 *   -> Dijkstra under three objectives: fastest / coolest / balanced.
 * Works in the browser (global CR_ENGINE) and in Node (module.exports) for tests.
 */
(function (root, factory) {
  const lib = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = lib;
  else root.CR_ENGINE = lib;
})(typeof self !== "undefined" ? self : this, function () {
  const RAD = Math.PI / 180;
  const WALK_M_PER_MIN = 5000 / 60; // 5 km/h

  // ---- Solar position (compact NOAA approximation) ----------------------
  function solarPosition(date, lat, lon) {
    const start = Date.UTC(date.getUTCFullYear(), 0, 0);
    const doy = Math.floor((date.getTime() - start) / 86400000);
    const utcH = date.getUTCHours() + date.getUTCMinutes() / 60;
    const gamma = (2 * Math.PI / 365) * (doy - 1 + (utcH - 12) / 24);
    const eqtime = 229.18 * (0.000075 + 0.001868 * Math.cos(gamma) - 0.032077 * Math.sin(gamma)
      - 0.014615 * Math.cos(2 * gamma) - 0.040849 * Math.sin(2 * gamma));
    const decl = 0.006918 - 0.399912 * Math.cos(gamma) + 0.070257 * Math.sin(gamma)
      - 0.006758 * Math.cos(2 * gamma) + 0.000907 * Math.sin(2 * gamma)
      - 0.002697 * Math.cos(3 * gamma) + 0.00148 * Math.sin(3 * gamma);
    const tst = utcH * 60 + eqtime + 4 * lon;
    const ha = (tst / 4 - 180) * RAD;
    const cosZen = Math.sin(lat * RAD) * Math.sin(decl)
      + Math.cos(lat * RAD) * Math.cos(decl) * Math.cos(ha);
    const zen = Math.acos(Math.min(1, Math.max(-1, cosZen)));
    let az = Math.atan2(Math.sin(ha),
      Math.cos(ha) * Math.sin(lat * RAD) - Math.tan(decl) * Math.cos(lat * RAD)) / RAD + 180;
    return { elevation: 90 - zen / RAD, azimuth: ((az % 360) + 360) % 360 };
  }

  // ---- Geo helpers -------------------------------------------------------
  function haversineM(lat1, lon1, lat2, lon2) {
    const R = 6371000;
    const dLat = (lat2 - lat1) * RAD, dLon = (lon2 - lon1) * RAD;
    const a = Math.sin(dLat / 2) ** 2
      + Math.cos(lat1 * RAD) * Math.cos(lat2 * RAD) * Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(a));
  }
  function bearingDeg(lat1, lon1, lat2, lon2) {
    const y = Math.sin((lon2 - lon1) * RAD) * Math.cos(lat2 * RAD);
    const x = Math.cos(lat1 * RAD) * Math.sin(lat2 * RAD)
      - Math.sin(lat1 * RAD) * Math.cos(lat2 * RAD) * Math.cos((lon2 - lon1) * RAD);
    return ((Math.atan2(y, x) / RAD) + 360) % 360;
  }

  // ---- Shade model: simplified street canyon ----------------------------
  // Sunward-side building casts a shadow band across the street; trees and
  // covered walkways add on top. Returns shade fraction 0..1.
  function edgeShade(edge, nodes, sun) {
    if (sun.elevation <= 2) return 1; // sun below skyline -> no direct sun
    const a = nodes[edge.a], b = nodes[edge.b];
    const axis = bearingDeg(a.lat, a.lon, b.lat, b.lon) % 180;
    const rel = Math.abs(((sun.azimuth - axis + 540) % 360) - 180); // 0..180
    const across = Math.abs(Math.sin(rel * RAD)); // sun component across street
    // Which side faces the sun? Side normals are axis±90.
    const n1 = (axis + 90) % 360, n2 = (axis + 270) % 360;
    const d1 = Math.abs(((sun.azimuth - n1 + 540) % 360) - 180);
    const sunH = d1 < 90 ? edge.h1 : edge.h2;
    const shadowW = (sunH / Math.tan(sun.elevation * RAD)) * across;
    let shade = Math.min(1, shadowW / edge.width);
    shade = Math.max(shade, edge.covered || 0);
    shade = shade + (1 - shade) * (edge.trees || 0) * 0.6;
    return Math.min(1, shade);
  }

  // ---- Edge heat cost (guide §7.1) ---------------------------------------
  const WEIGHTS = { w1: 0.35, w2: 0.30, w3: 0.10, w4: 0.15, w5: 0.10 };

  function coolingAccess(midLat, midLon, coolingPoints) {
    let best = 0;
    for (const p of coolingPoints) {
      const d = haversineM(midLat, midLon, p.lat, p.lon);
      const v = d <= 50 ? 1 : d <= 120 ? 0.5 : 0;
      if (v > best) best = v;
    }
    return best;
  }

  function edgeMetrics(edge, nodes, sun, weather, coolingPoints) {
    const a = nodes[edge.a], b = nodes[edge.b];
    const lengthM = haversineM(a.lat, a.lon, b.lat, b.lon);
    const shade = edgeShade(edge, nodes, sun);
    const sunExposure = 1 - shade;
    const heatIndex = Math.min(1, Math.max(0, (weather.apparentC - 24) / 12));
    const lowWind = Math.min(1, Math.max(0, 1 - weather.windMs / 6));
    const cool = coolingAccess((a.lat + b.lat) / 2, (a.lon + b.lon) / 2, coolingPoints);
    const raw = WEIGHTS.w1 * heatIndex + WEIGHTS.w2 * sunExposure
      + WEIGHTS.w3 * lowWind + WEIGHTS.w4 * edge.surface - WEIGHTS.w5 * cool;
    const range = WEIGHTS.w1 + WEIGHTS.w2 + WEIGHTS.w3 + WEIGHTS.w4 + WEIGHTS.w5;
    const heat01 = Math.min(1, Math.max(0, (raw + WEIGHTS.w5) / range));
    return {
      lengthM, timeMin: lengthM / (WALK_M_PER_MIN * (edge.speed || 1)), shade, sunExposure,
      heat01, heatScore: Math.round(heat01 * 100), comfort: Math.round((1 - heat01) * 100),
      cooling: cool
    };
  }

  // ---- Graph + Dijkstra ---------------------------------------------------
  function buildAdjacency(data) {
    const adj = {};
    for (const id of Object.keys(data.nodes)) adj[id] = [];
    for (const e of data.edges) { adj[e.a].push(e); adj[e.b].push(e); }
    return adj;
  }

  function dijkstra(adj, startId, endId, edgeCost) {
    const dist = { [startId]: 0 }, prev = {}, done = new Set();
    const queue = [[0, startId]];
    while (queue.length) {
      queue.sort((x, y) => x[0] - y[0]);
      const [d, u] = queue.shift();
      if (done.has(u)) continue;
      done.add(u);
      if (u === endId) break;
      for (const e of adj[u]) {
        const v = e.a === u ? e.b : e.a;
        const nd = d + edgeCost(e);
        if (dist[v] === undefined || nd < dist[v]) {
          dist[v] = nd; prev[v] = { from: u, edge: e };
          queue.push([nd, v]);
        }
      }
    }
    if (dist[endId] === undefined) return null;
    const path = [], edgesPath = [];
    let cur = endId;
    while (cur !== startId) { path.unshift(cur); edgesPath.unshift(prev[cur].edge); cur = prev[cur].from; }
    path.unshift(startId);
    return { nodes: path, edges: edgesPath, cost: dist[endId] };
  }

  // ---- Route planning: three objectives ----------------------------------
  function planRoutes(data, weather, date, sensitivity) {
    const sun = solarPosition(date, data.center.lat, data.center.lon);
    const adj = buildAdjacency(data);
    const m = {}; // edgeId -> metrics
    for (const e of data.edges) m[e.id] = edgeMetrics(e, data.nodes, sun, weather, data.coolingPoints);

    const lambda = 0.4 + 2.0 * (sensitivity ?? 0.5); // heat-sensitivity preference
    const costs = {
      fastest: e => m[e.id].timeMin,
      coolest: e => m[e.id].lengthM * (0.15 + 0.85 * m[e.id].heat01),
      balanced: e => m[e.id].timeMin * (1 + lambda * m[e.id].heat01)
    };

    function solve(startId, endId) {
      const out = {};
      for (const mode of ["fastest", "coolest", "balanced"]) {
        const r = dijkstra(adj, startId, endId, costs[mode]);
        if (!r) return null;
        let len = 0, time = 0, shadeAcc = 0, heatAcc = 0;
        const coords = [];
        for (const e of r.edges) {
          const em = m[e.id];
          len += em.lengthM; time += em.timeMin;
          shadeAcc += em.shade * em.lengthM; heatAcc += em.heat01 * em.lengthM;
        }
        r.nodes.forEach((n, i) => { if (i === 0 || n !== r.nodes[i - 1]) coords.push([data.nodes[n].lon, data.nodes[n].lat]); });
        const passed = data.coolingPoints.filter(p =>
          r.nodes.some(n => haversineM(data.nodes[n].lat, data.nodes[n].lon, p.lat, p.lon) <= 45));
        out[mode] = {
          mode, nodePath: r.nodes, edgeIds: r.edges.map(e => e.id), coords,
          distanceM: Math.round(len), etaMin: Math.round(time * 10) / 10,
          shadePct: Math.round((shadeAcc / len) * 100),
          heatScore: Math.round((heatAcc / len) * 100),
          comfort: Math.round((1 - heatAcc / len) * 100),
          coolingPoints: passed
        };
      }
      return out;
    }
    return { sun, edgeMetrics: m, solve };
  }

  // ============================================================
  // Real-route scoring: OSRM foot geometry + thermal model
  // ============================================================

  // Split a LineString into segments of at most maxLenM, with midpoints/bearings
  function splitLine(coords, maxLenM) {
    const segs = [];
    for (let i = 0; i < coords.length - 1; i++) {
      const [lon1, lat1] = coords[i], [lon2, lat2] = coords[i + 1];
      const len = haversineM(lat1, lon1, lat2, lon2);
      if (len < 0.5) continue;
      const n = Math.max(1, Math.ceil(len / maxLenM));
      for (let k = 0; k < n; k++) {
        const t0 = k / n, t1 = (k + 1) / n, tm = (t0 + t1) / 2;
        const aLat = lat1 + (lat2 - lat1) * t0, aLon = lon1 + (lon2 - lon1) * t0;
        const bLat = lat1 + (lat2 - lat1) * t1, bLon = lon1 + (lon2 - lon1) * t1;
        segs.push({
          midLat: lat1 + (lat2 - lat1) * tm, midLon: lon1 + (lon2 - lon1) * tm,
          lenM: len / n, bearing: bearingDeg(aLat, aLon, bLat, bLon)
        });
      }
    }
    return segs;
  }

  // "德輔道中 Des Voeux Road Central" -> "des voeux road central"
  function englishName(raw) {
    return (raw || "")
      .replace(/[㐀-鿿豈-﫿]/g, " ")
      .replace(/['']/g, "'")
      .replace(/\s+/g, " ").trim().toLowerCase();
  }

  function canyonForName(rawName, streetTable, coveredHints, defaultCanyon, unnamedCanyon) {
    const en = englishName(rawName);
    const openDefault = unnamedCanyon || { w: 8, h: 10, trees: 0.15, surface: 0.80, covered: 0 };
    let params = { ...(en ? defaultCanyon : openDefault) };
    if (en) {
      for (const key of Object.keys(streetTable)) {
        if (en.includes(key) || (en.length >= 6 && key.includes(en))) {
          params = { ...params, ...streetTable[key] };
          break;
        }
      }
      for (const [kw, cov] of coveredHints) {
        if (en.includes(kw)) params.covered = Math.max(params.covered || 0, cov);
      }
    }
    return { params, en };
  }

  // Shade for one segment given its bearing and canyon params
  function segmentShade(bearing, p, sun) {
    if ((p.covered || 0) >= 1) return 1;
    if (sun.elevation <= 2) return 1;
    const axis = bearing % 180;
    const rel = Math.abs(((sun.azimuth - axis + 540) % 360) - 180);
    const across = Math.abs(Math.sin(rel * RAD));
    let shade = p.h > 0
      ? Math.min(1, (p.h / Math.tan(sun.elevation * RAD)) * across / p.w)
      : 0;
    shade = Math.max(shade, p.covered || 0);
    shade = shade + (1 - shade) * (p.trees || 0) * 0.6;
    return Math.min(1, shade);
  }

  // Score one API route candidate thermally.
  // candidate: { distanceM, durationS, coords, steps: [{name, coords}] }
  // ctx: { sun, weather, coolingPoints, streetTable, coveredHints, defaultCanyon }
  function scoreCandidate(cand, ctx) {
    const { sun, weather, coolingPoints } = ctx;
    const heatIndex = Math.min(1, Math.max(0, (weather.apparentC - 24) / 12));
    const lowWind = Math.min(1, Math.max(0, 1 - weather.windMs / 6));
    const range = WEIGHTS.w1 + WEIGHTS.w2 + WEIGHTS.w3 + WEIGHTS.w4 + WEIGHTS.w5;

    let len = 0, shadeAcc = 0, heatAcc = 0;
    const sunByStreet = {}; // name -> {sunLen, totalLen}
    for (const step of cand.steps) {
      const { params, en } = canyonForName(step.name, ctx.streetTable, ctx.coveredHints, ctx.defaultCanyon, ctx.unnamedCanyon);
      const label = en || "(footpath / plaza)";
      for (const seg of splitLine(step.coords, 30)) {
        const shade = segmentShade(seg.bearing, params, sun);
        const sunE = 1 - shade;
        const cool = coolingAccess(seg.midLat, seg.midLon, coolingPoints);
        const raw = WEIGHTS.w1 * heatIndex + WEIGHTS.w2 * sunE
          + WEIGHTS.w3 * lowWind + WEIGHTS.w4 * params.surface - WEIGHTS.w5 * cool;
        const heat01 = Math.min(1, Math.max(0, (raw + WEIGHTS.w5) / range));
        len += seg.lenM; shadeAcc += shade * seg.lenM; heatAcc += heat01 * seg.lenM;
        const b = sunByStreet[label] || (sunByStreet[label] = { sunLen: 0, totalLen: 0 });
        b.totalLen += seg.lenM; if (sunE > 0.6) b.sunLen += seg.lenM;
      }
    }
    if (len === 0) return null;
    const heat01 = heatAcc / len;
    const sunnyStretches = Object.entries(sunByStreet)
      .filter(([, v]) => v.sunLen >= 25)
      .sort((a, b) => b[1].sunLen - a[1].sunLen)
      .slice(0, 3)
      .map(([name, v]) => ({ name, lenM: Math.round(v.sunLen) }));
    const passed = coolingPoints.filter(p =>
      cand.coords.some(([lon, lat]) => haversineM(lat, lon, p.lat, p.lon) <= 45));
    return {
      distanceM: Math.round(cand.distanceM || len),
      etaMin: Math.round((cand.durationS / 60) * 10) / 10,
      shadePct: Math.round((shadeAcc / len) * 100),
      heatScore: Math.round(heat01 * 100),
      comfort: Math.round((1 - heat01) * 100),
      heatCost: len * (0.15 + 0.85 * heat01),
      sunnyStretches, coolingPoints: passed
    };
  }

  // Geometry signature for deduplication
  function routeSignature(coords) {
    return coords.filter((_, i) => i % 4 === 0)
      .map(c => c[0].toFixed(4) + "," + c[1].toFixed(4)).join(";");
  }

  return {
    solarPosition, haversineM, bearingDeg, edgeShade, edgeMetrics, planRoutes, WEIGHTS, WALK_M_PER_MIN,
    splitLine, englishName, canyonForName, segmentShade, scoreCandidate, routeSignature, coolingAccess
  };
});
