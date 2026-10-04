// Node sanity test for the CoolRoute v1 engine (not part of the web app).
const data = require("./data.js");
const eng = require("./engine.js");

// Hot afternoon: 2026-07-15 14:00 HKT (= 06:00 UTC)
const date = new Date(Date.UTC(2026, 6, 15, 6, 0));
const sun = eng.solarPosition(date, data.center.lat, data.center.lon);
console.log("sun:", sun.elevation.toFixed(1) + "°", "az", sun.azimuth.toFixed(1) + "°");
if (!(sun.elevation > 40 && sun.elevation < 90)) throw new Error("sun elevation implausible");
if (!(sun.azimuth > 180 && sun.azimuth < 330)) throw new Error("sun azimuth implausible for 14:00");

const weather = { apparentC: 38, windMs: 1.5 };
const plan = eng.planRoutes(data, weather, date, 0.5);
const routes = plan.solve("waterfront__pedder", "staunton__cochrane"); // IFC -> SoHo
if (!routes) throw new Error("no route found");
for (const mode of ["fastest", "coolest", "balanced"]) {
  const r = routes[mode];
  console.log(
    mode.padEnd(8),
    String(r.etaMin).padStart(5) + " min",
    String(r.distanceM).padStart(5) + " m",
    "shade " + String(r.shadePct).padStart(3) + "%",
    "comfort " + r.comfort,
    "edges " + r.edgeIds.length,
    "cooling: " + r.coolingPoints.map(p => p.name).join(", ")
  );
}
const f = routes.fastest, c = routes.coolest;
if (c.heatScore > f.heatScore) throw new Error("coolest route has higher heat score than fastest");
if (c.shadePct < f.shadePct) throw new Error("coolest route less shaded than fastest");
console.log("coolest path:", routes.coolest.nodePath.join(" -> "));
console.log("fastest path:", routes.fastest.nodePath.join(" -> "));
console.log("same path?", JSON.stringify(f.nodePath) === JSON.stringify(c.nodePath));
console.log("ALL CHECKS PASSED");
