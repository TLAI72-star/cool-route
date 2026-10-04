/* CoolRoute v2 prototype — deterministic thermal routing engine.
 * Per CoolRoute_System_Architecture_v2 / Build_Guide_v2:
 *   - time-aware: solar position (pvlib-equivalent NOAA approximation)
 *   - weather-aware edge cost: cost = length × (1 + heat + sun − cool_bonus)
 *       heat       = max(0, temp_c − 26) × 0.5          (daytime only)
 *       sun        = (1 − shade) × max(0, sun_elev) × 0.05
 *       cool_bonus = 1 if a cooling point is within 200 m
 *   - shade is BINARY (0/1) from real building geometry:
 *       a segment is shaded if any building stands between it and the sun
 *       (bearing within ±45° of sun azimuth, distance ≤ height / tan(elev)).
 * Works in the browser (global CR_ENGINE) and in Node (module.exports) for tests.
 */
(function (root, factory) {
  const lib = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = lib;
  else root.CR_ENGINE = lib;
})(typeof self !== "undefined" ? self : this, function () {
  const RAD = Math.PI / 180;

  // ---- Solar position (compact NOAA approximation; matches pvlib to ~0.1°)
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
    const elevation = 90 - zen / RAD;
    return {
      elevation,
      azimuth: ((az % 360) + 360) % 360,
      isDay: elevation > 0,
      twilight: elevation <= 0 && elevation > -6
    };
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
  function englishName(raw) {
    return (raw || "")
      .replace(/[㐀-鿿豈-﫿]/g, " ")
      .replace(/['’]/g, "'")
      .replace(/\s+/g, " ").trim().toLowerCase();
  }

  // ---- Building spatial index --------------------------------------------
  const SHADE_H_CAP = 60;    // beyond ~60 m a Central canyon is always blocked
  const SEARCH_R = 350;      // max building distance considered (m)

  function buildBuildingIndex(fc) {
    const CELL = 0.0015; // ≈ 160 m
    const grid = new Map();
    for (const f of fc.features) {
      const b = {
        lon: f._centroid[0], lat: f._centroid[1], r: f._radius,
        h: Math.min(f.properties.height, SHADE_H_CAP),
        ring: f.geometry.coordinates[0]
      };
      const k = Math.floor(b.lat / CELL) + ":" + Math.floor(b.lon / CELL);
      if (!grid.has(k)) grid.set(k, []);
      grid.get(k).push(b);
    }
    return { grid, CELL };
  }
  function nearbyBuildings(idx, lat, lon, radiusM) {
    const dLat = radiusM / 111320, dLon = radiusM / (111320 * Math.cos(lat * RAD));
    const out = [];
    for (let la = Math.floor((lat - dLat) / idx.CELL); la <= Math.floor((lat + dLat) / idx.CELL); la++)
      for (let lo = Math.floor((lon - dLon) / idx.CELL); lo <= Math.floor((lon + dLon) / idx.CELL); lo++) {
        const arr = idx.grid.get(la + ":" + lo);
        if (arr) for (const b of arr) out.push(b);
      }
    return out;
  }

  // Distance (m) / containment against a real polygon ring (equirectangular approx)
  function pointInRing(lat, lon, ring) {
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [xi, yi] = ring[i], [xj, yj] = ring[j];
      if ((yi > lat) !== (yj > lat) && lon < (xj - xi) * (lat - yi) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
  }
  function distToRingM(lat, lon, ring) {
    const kx = 111320 * Math.cos(lat * RAD), ky = 111320;
    let best = Infinity;
    for (let i = 0; i < ring.length - 1; i++) {
      const ax = (ring[i][0] - lon) * kx, ay = (ring[i][1] - lat) * ky;
      const bx = (ring[i + 1][0] - lon) * kx, by = (ring[i + 1][1] - lat) * ky;
      const dx = bx - ax, dy = by - ay;
      const t = Math.max(0, Math.min(1, -(ax * dx + ay * dy) / (dx * dx + dy * dy || 1)));
      const px = ax + t * dx, py = ay + t * dy;
      const d = Math.hypot(px, py);
      if (d < best) best = d;
    }
    return best;
  }

  // ---- Binary shade (guide Step 6: 0/1, simplified building geometry) -----
  function binaryShade(midLat, midLon, sun, bidx, covered) {
    if (covered) return 1;
    if (sun.elevation <= 0) return 1; // night: no direct sun
    const elev = Math.max(sun.elevation, 2);
    const tanE = Math.tan(elev * RAD);
    for (const b of nearbyBuildings(bidx, midLat, midLon, SEARCH_R)) {
      const cd = haversineM(midLat, midLon, b.lat, b.lon);
      if (cd - b.r > b.h / tanE) continue;         // centroid too far even for shadow
      const brg = bearingDeg(midLat, midLon, b.lat, b.lon);
      const diff = Math.abs(((brg - sun.azimuth + 540) % 360) - 180);
      if (diff > 45) continue;                     // building not toward the sun
      if (pointInRing(midLat, midLon, b.ring)) return 1;
      if (distToRingM(midLat, midLon, b.ring) <= b.h / tanE) return 1;
    }
    return 0;
  }

  // ---- Cooling access ------------------------------------------------------
  function coolingWithin(midLat, midLon, coolingPoints, maxM) {
    let best = Infinity;
    for (const p of coolingPoints) {
      const d = haversineM(midLat, midLon, p.lat, p.lon);
      if (d < best) best = d;
    }
    return best <= maxM;
  }

  // ---- v2 edge cost + candidate scoring ------------------------------------
  // ctx: { sun, weather:{tempC}, bidx, coolingPoints, coveredHints }
  function scoreCandidate(cand, ctx) {
    const { sun, weather } = ctx;
    const heat = sun.isDay ? Math.max(0, weather.tempC - 26) * 0.5 : 0;
    const sunElevPen = Math.max(0, sun.elevation) * 0.05;

    let len = 0, cost = 0, shadeLen = 0;
    const sunByStreet = {};
    for (const step of cand.steps) {
      const en = englishName(step.name);
      let covered = false;
      for (const [kw] of ctx.coveredHints) if (en.includes(kw)) { covered = true; break; }
      const label = en || "(footpath / plaza)";
      for (const seg of splitLine(step.coords, 30)) {
        const shade = binaryShade(seg.midLat, seg.midLon, sun, ctx.bidx, covered);
        const sunPen = (1 - shade) * sunElevPen;
        const coolBonus = coolingWithin(seg.midLat, seg.midLon, ctx.coolingPoints, 200) ? 1 : 0;
        const segCost = seg.lenM * (1 + heat + sunPen - coolBonus);
        len += seg.lenM; cost += segCost; shadeLen += shade * seg.lenM;
        const b = sunByStreet[label] || (sunByStreet[label] = { sunLen: 0 });
        if (shade === 0 && sun.isDay) b.sunLen += seg.lenM;
      }
    }
    if (len === 0) return null;
    const avgPenalty = cost / len - 1;                       // heat + sun − cool, per metre
    const heat01 = Math.min(1, Math.max(0, (avgPenalty + 1) / 11.5));
    const sunnyStretches = Object.entries(sunByStreet)
      .filter(([, v]) => v.sunLen >= 25)
      .sort((a, b) => b[1].sunLen - a[1].sunLen)
      .slice(0, 3)
      .map(([name, v]) => ({ name, lenM: Math.round(v.sunLen) }));
    const passed = ctx.coolingPoints.filter(p =>
      cand.coords.some(([lon, lat]) => haversineM(lat, lon, p.lat, p.lon) <= 45));
    return {
      distanceM: Math.round(cand.distanceM || len),
      etaMin: Math.round((cand.durationS / 60) * 10) / 10,
      shadePct: Math.round((shadeLen / len) * 100),
      heatScore: Math.round(heat01 * 100),
      comfort: Math.round((1 - heat01) * 100),
      totalCost: cost,
      sunnyStretches, coolingPoints: passed
    };
  }

  function routeSignature(coords) {
    return coords.filter((_, i) => i % 4 === 0)
      .map(c => c[0].toFixed(4) + "," + c[1].toFixed(4)).join(";");
  }

  // Mode picks per guide: fastest = min time, coolest = min heat cost,
  // balanced = time × (1 + λ·penalty), λ grows with heat sensitivity.
  function pickModes(cands, sensitivity) {
    const lambda = 0.4 + 2.0 * (sensitivity ?? 0.5);
    const pick = fn => cands.reduce((best, c) => fn(c) < fn(best) ? c : best, cands[0]);
    return {
      fastest: pick(c => c.durationS),
      coolest: pick(c => c.totalCost),
      balanced: pick(c => c.durationS * (1 + lambda * Math.min(1, Math.max(0,
        (c.totalCost / Math.max(1, c.distanceM) - 1) / 10))))
    };
  }

  return {
    solarPosition, haversineM, bearingDeg, splitLine, englishName,
    buildBuildingIndex, nearbyBuildings, binaryShade, coolingWithin,
    scoreCandidate, routeSignature, pickModes, SHADE_H_CAP, SEARCH_R
  };
});
