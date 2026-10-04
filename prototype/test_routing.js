// Scores real OSRM route candidates with the thermal engine (uses the saved
// fixture sample_route.json: IFC -> SoHo, fetched from routing.openstreetmap.de).
const fs = require("fs");
const D = require("./data.js");
const E = require("./engine.js");

const j = JSON.parse(fs.readFileSync(__dirname + "/sample_route.json", "utf8"));
if (j.code !== "Ok") throw new Error("fixture not Ok");

const date = new Date(Date.UTC(2026, 9, 3, 6, 0)); // 3 Oct 2026 14:00 HKT
const sun = E.solarPosition(date, D.center.lat, D.center.lon);
const ctx = {
  sun, weather: { apparentC: 34.5, windMs: 2.0 },
  coolingPoints: D.coolingPoints, streetTable: D.streetTable,
  coveredHints: D.coveredHints, defaultCanyon: D.defaultCanyon
};
console.log("sun", sun.elevation.toFixed(0) + "°", "az", sun.azimuth.toFixed(0) + "°");

// name-matching sanity
for (const nm of ["德輔道中 Des Voeux Road Central", "中環至半山自動扶手電梯系統 Central-Mid-Levels Escalator System", "伊利近街 Elgin Street", ""]) {
  const { params, en } = E.canyonForName(nm, D.streetTable, D.coveredHints, D.defaultCanyon);
  console.log(`name "${nm.slice(0, 40)}" -> en="${en}" w=${params.w} h=${params.h} covered=${params.covered || 0}`);
}

const scored = j.routes.map((r, i) => {
  const cand = {
    distanceM: r.distance, durationS: r.duration,
    coords: r.geometry.coordinates,
    steps: r.legs[0].steps.map(s => ({ name: s.name, coords: s.geometry.coordinates }))
  };
  const m = E.scoreCandidate(cand, ctx);
  console.log(`\nroute ${i}: ${m.distanceM} m  ${m.etaMin} min  shade ${m.shadePct}%  heat ${m.heatScore}/100  comfort ${m.comfort}  heatCost ${Math.round(m.heatCost)}`);
  console.log("  sunny stretches:", m.sunnyStretches.map(s => s.name + " ~" + s.lenM + " m").join("; ") || "none");
  console.log("  cooling passed:", m.coolingPoints.map(p => p.name).join(", ") || "none");
  return m;
});

const bestHeat = Math.min(...scored.map(m => m.heatCost));
console.log("\nmode picks -> fastest:", scored.indexOf(scored.reduce((a, b) => a.etaMin < b.etaMin ? a : b)),
  "coolest:", scored.findIndex(m => m.heatCost === bestHeat));
console.log("signatures distinct:", new Set(j.routes.map(r => E.routeSignature(r.geometry.coordinates))).size === j.routes.length);
console.log("ALL ROUTING SCORE CHECKS DONE");
