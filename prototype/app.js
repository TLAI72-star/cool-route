/* CoolRoute v1 prototype — UI + map wiring
 * Routing: real pedestrian routes from an OSRM foot server (OSM data).
 * Thermal scoring: CoolRoute engine on top (sun position -> canyon shade -> heat).
 * Fallback: built-in simulated Central grid if the routing service is unreachable.
 */
(function () {
  const D = CR_DATA, E = CR_ENGINE;
  const MODE_META = {
    fastest: { name: "Fastest", icon: "⚡", color: "#f59e0b", offset: -4 },
    coolest: { name: "Coolest", icon: "❄", color: "#06b6d4", offset: 4 },
    balanced: { name: "Balanced", icon: "⚖", color: "#8b5cf6", offset: 0 }
  };

  const state = {
    a: { ...D.landmarks[0], label: D.landmarks[0].name },   // IFC
    b: { ...D.landmarks[12], label: D.landmarks[12].name }, // SoHo
    departH: 14, sens: 0.5,
    wxHourly: null, wxStale: false,
    pick: null, selected: "balanced",
    modes: null,        // {fastest: cand, coolest: cand, balanced: cand}
    source: "api",      // 'api' | 'grid'
    sun: null, seq: 0
  };

  // ---------- HKT time helpers ----------
  const hktNow = () => new Date(Date.now() + 8 * 3600e3);
  function buildDate(hFloat) {
    const n = hktNow();
    const h = Math.floor(hFloat), m = Math.round((hFloat - h) * 60);
    return new Date(Date.UTC(n.getUTCFullYear(), n.getUTCMonth(), n.getUTCDate(), h - 8, m));
  }
  const pad = x => String(x).padStart(2, "0");
  const fmtH = h => pad(Math.floor(h)) + ":" + pad(Math.round((h % 1) * 60));

  // ---------- Map ----------
  const RASTER_FALLBACK = {
    version: 8,
    sources: { carto: { type: "raster", tiles: ["https://basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}.png"], tileSize: 256, attribution: "© OpenStreetMap contributors © CARTO" } },
    layers: [{ id: "carto", type: "raster", source: "carto" }]
  };
  const map = new maplibregl.Map({
    container: "map",
    style: "https://basemaps.cartocdn.com/gl/voyager-gl-style/style.json",
    center: [D.center.lon, D.center.lat],
    zoom: 15.6,
    attributionControl: { compact: true }
  });
  map.addControl(new maplibregl.NavigationControl(), "top-right");
  map.addControl(new maplibregl.ScaleControl(), "bottom-right");

  let layersReady = false;
  const loadTimer = setTimeout(() => {
    if (!layersReady) { map.setStyle(RASTER_FALLBACK); map.once("style.load", setupLayers); }
  }, 7000);
  map.on("load", () => { clearTimeout(loadTimer); setupLayers(); });

  const routeFC = () => ({
    type: "FeatureCollection",
    features: state.modes ? ["fastest", "coolest", "balanced"].map(md => ({
      type: "Feature",
      geometry: { type: "LineString", coordinates: state.modes[md].coords },
      properties: { mode: md, selected: md === state.selected }
    })) : []
  });

  function setupLayers() {
    if (layersReady) return; layersReady = true;
    map.addSource("routes", { type: "geojson", data: routeFC() });
    map.addLayer({
      id: "route-casing", type: "line", source: "routes",
      paint: {
        "line-color": "#ffffff",
        "line-width": ["case", ["to-boolean", ["get", "selected"]], 9, 6],
        "line-opacity": ["case", ["to-boolean", ["get", "selected"]], 0.95, 0.55],
        "line-offset": ["match", ["get", "mode"], "fastest", -4, "coolest", 4, 0]
      },
      layout: { "line-cap": "round", "line-join": "round" }
    });
    map.addLayer({
      id: "route-lines", type: "line", source: "routes",
      paint: {
        "line-color": ["match", ["get", "mode"], "fastest", "#f59e0b", "coolest", "#06b6d4", "#8b5cf6"],
        "line-width": ["case", ["to-boolean", ["get", "selected"]], 5, 3.5],
        "line-opacity": ["case", ["to-boolean", ["get", "selected"]], 1, 0.55],
        "line-offset": ["match", ["get", "mode"], "fastest", -4, "coolest", 4, 0]
      },
      layout: { "line-cap": "round", "line-join": "round" }
    });

    // Click a route line to select its card
    map.on("click", "route-lines", ev => {
      if (state.pick) return;
      selectMode(ev.features[0].properties.mode);
    });
    map.on("mousemove", "route-lines", () => { if (!state.pick) map.getCanvas().style.cursor = "pointer"; });
    map.on("mouseleave", "route-lines", () => { map.getCanvas().style.cursor = ""; });

    // Cooling-point markers
    for (const p of D.coolingPoints) {
      const el = document.createElement("div");
      el.className = "marker-cp"; el.textContent = "❄"; el.title = p.name;
      el.addEventListener("click", ev => {
        ev.stopPropagation();
        new maplibregl.Popup({ closeButton: false })
          .setLngLat([p.lon, p.lat])
          .setHTML(`<div class="popup-title">❄ ${p.name}</div><div class="popup-grid"><span>Type</span><b>${p.type}</b><span>Hours</span><b>${p.hours}</b></div>`)
          .addTo(map);
      });
      new maplibregl.Marker({ element: el }).setLngLat([p.lon, p.lat]).addTo(map);
    }

    map.on("click", ev => {
      if (!state.pick) return;
      state[state.pick] = { lat: ev.lngLat.lat, lon: ev.lngLat.lng, label: "Dropped pin" };
      syncSelects(); setPick(null); recompute(true);
    });

    recompute(true);
  }

  const mkMarker = cls => {
    const el = document.createElement("div");
    el.className = "marker-ab " + cls;
    el.innerHTML = "<span>" + (cls === "marker-a" ? "A" : "B") + "</span>";
    return new maplibregl.Marker({ element: el });
  };
  const markerA = mkMarker("marker-a"), markerB = mkMarker("marker-b");

  // ---------- Weather ----------
  async function fetchWeather() {
    try {
      const url = "https://api.open-meteo.com/v1/forecast?latitude=" + D.center.lat + "&longitude=" + D.center.lon
        + "&hourly=temperature_2m,relative_humidity_2m,apparent_temperature,wind_speed_10m,cloud_cover"
        + "&timezone=Asia%2FHong_Kong&forecast_days=2";
      const res = await fetch(url);
      if (!res.ok) throw new Error("HTTP " + res.status);
      const j = await res.json();
      state.wxHourly = j.hourly; state.wxStale = false;
    } catch (err) {
      state.wxHourly = null; state.wxStale = true;
    }
    recompute(false);
  }
  function weatherFor(date) {
    if (state.wxHourly) {
      const n = hktNow();
      const hktH = (date.getUTCHours() + 8) % 24;
      const key = n.getUTCFullYear() + "-" + pad(n.getUTCMonth() + 1) + "-" + pad(n.getUTCDate())
        + "T" + pad(hktH);
      let idx = state.wxHourly.time.indexOf(key);
      if (idx < 0) idx = Math.min(state.wxHourly.time.length - 1, hktH);
      const h = state.wxHourly;
      return {
        tempC: h.temperature_2m[idx], apparentC: h.apparent_temperature[idx],
        rhPct: h.relative_humidity_2m[idx], windMs: h.wind_speed_10m[idx],
        cloudPct: h.cloud_cover[idx], source: "Open-Meteo live", stale: false
      };
    }
    return D.fallbackWeather;
  }

  // ---------- Real pedestrian routing (OSRM foot demo server) ----------
  async function fetchRoute(waypoints, alternatives) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), D.routingService.timeoutMs);
    try {
      const coords = waypoints.map(w => w[0] + "," + w[1]).join(";");
      const url = D.routingService.url + coords
        + "?geometries=geojson&overview=full&steps=true&alternatives=" + alternatives;
      const res = await fetch(url, { signal: ctrl.signal });
      if (!res.ok) throw new Error("HTTP " + res.status);
      const j = await res.json();
      if (j.code !== "Ok" || !j.routes || !j.routes.length) throw new Error(j.code || "no routes");
      return j.routes.map(r => ({
        distanceM: r.distance, durationS: r.duration,
        coords: r.geometry.coordinates,
        steps: r.legs.flatMap(l => l.steps.map(s => ({ name: s.name || "", coords: s.geometry.coordinates })))
      }));
    } finally { clearTimeout(t); }
  }

  // Shade-rich via points roughly between A and B, used to diversify candidates
  function viaBetween(a, b) {
    const padDeg = 0.004;
    const minLat = Math.min(a.lat, b.lat) - padDeg, maxLat = Math.max(a.lat, b.lat) + padDeg;
    const minLon = Math.min(a.lon, b.lon) - padDeg, maxLon = Math.max(a.lon, b.lon) + padDeg;
    return D.viaPoints.filter(v =>
      v.lat > minLat && v.lat < maxLat && v.lon > minLon && v.lon < maxLon
      && E.haversineM(a.lat, a.lon, v.lat, v.lon) > 150
      && E.haversineM(b.lat, b.lon, v.lat, v.lon) > 150).slice(0, 3);
  }

  async function planViaApi(wx) {
    const a = state.a, b = state.b;
    const reqs = [fetchRoute([[a.lon, a.lat], [b.lon, b.lat]], 3)]
      .concat(viaBetween(a, b).map(v => fetchRoute([[a.lon, a.lat], [v.lon, v.lat], [b.lon, b.lat]], 0)));
    const results = await Promise.allSettled(reqs);
    const seen = new Set(), cands = [];
    for (const r of results) {
      if (r.status !== "fulfilled") continue;
      for (const cand of r.value) {
        const sig = E.routeSignature(cand.coords);
        if (seen.has(sig)) continue;
        seen.add(sig); cands.push(cand);
      }
    }
    if (!cands.length) throw new Error("all routing requests failed");

    const date = buildDate(state.departH);
    const sun = E.solarPosition(date, D.center.lat, D.center.lon);
    state.sun = sun;
    const ctx = {
      sun, weather: wx, coolingPoints: D.coolingPoints, streetTable: D.streetTable,
      coveredHints: D.coveredHints, defaultCanyon: D.defaultCanyon, unnamedCanyon: D.unnamedCanyon
    };
    for (const c of cands) Object.assign(c, E.scoreCandidate(c, ctx));

    const lambda = 0.4 + 2.0 * state.sens;
    const pick = fn => cands.reduce((best, c) => fn(c) < fn(best) ? c : best, cands[0]);
    return {
      fastest: pick(c => c.durationS),
      coolest: pick(c => c.heatCost),
      balanced: pick(c => c.durationS * (1 + lambda * (c.heatScore / 100))),
      sun
    };
  }

  // ---------- Fallback: simulated grid (offline mode) ----------
  function planViaGrid(wx) {
    const nearest = pt => {
      let best = null, bd = Infinity;
      for (const n of Object.values(D.nodes)) {
        const d = E.haversineM(pt.lat, pt.lon, n.lat, n.lon);
        if (d < bd) { bd = d; best = n.id; }
      }
      return best;
    };
    const date = buildDate(state.departH);
    const plan = E.planRoutes(D, wx, date, state.sens);
    state.sun = plan.sun;
    const r = plan.solve(nearest(state.a), nearest(state.b));
    if (!r) throw new Error("no grid route");
    const wrap = m => ({
      coords: m.coords, distanceM: m.distanceM, etaMin: m.etaMin,
      shadePct: m.shadePct, heatScore: m.heatScore, comfort: m.comfort,
      sunnyStretches: [], coolingPoints: m.coolingPoints, durationS: m.etaMin * 60
    });
    return { fastest: wrap(r.fastest), coolest: wrap(r.coolest), balanced: wrap(r.balanced), sun: plan.sun };
  }

  // ---------- Recompute pipeline ----------
  async function recompute(moveMap) {
    const seq = ++state.seq;
    const date = buildDate(state.departH);
    const wx = weatherFor(date);
    renderWeather(wx, date);
    setLoading(true);
    try {
      const out = await planViaApi(wx);
      if (seq !== state.seq) return; // superseded
      state.source = "api"; state.modes = out; hideBanner();
    } catch (err) {
      try {
        const out = planViaGrid(wx);
        if (seq !== state.seq) return;
        state.source = "grid"; state.modes = out;
        banner("Live routing unavailable — showing the built-in simulated network instead.");
      } catch (e2) {
        if (seq !== state.seq) return;
        setLoading(false);
        return banner("No route found between A and B — try different points.");
      }
    }
    setLoading(false);
    renderRoutes();
    renderCompare();
    if (layersReady) map.getSource("routes").setData(routeFC());
    markerA.setLngLat([state.a.lon, state.a.lat]).addTo(map);
    markerB.setLngLat([state.b.lon, state.b.lat]).addTo(map);
    if (moveMap) {
      const bds = new maplibregl.LngLatBounds();
      for (const md of ["fastest", "coolest", "balanced"]) state.modes[md].coords.forEach(c => bds.extend(c));
      map.fitBounds(bds, { padding: 90, duration: 500 });
    }
  }

  // ---------- Rendering ----------
  function renderWeather(wx, date) {
    document.getElementById("wx-grid").innerHTML = [
      [wx.tempC.toFixed(1) + "°", "temp"], [wx.apparentC.toFixed(1) + "°", "feels like"],
      [Math.round(wx.rhPct) + "%", "humidity"], [wx.windMs.toFixed(1), "wind m/s"],
      [Math.round(wx.cloudPct) + "%", "cloud"]
    ].map(([v, l]) => `<div class="wx-cell"><b>${v}</b><span>${l}</span></div>`).join("");
    const src = document.getElementById("wx-source");
    src.textContent = wx.stale ? "stale" : "live · " + fmtH(state.departH) + " HKT";
    src.className = "badge" + (wx.stale ? " stale-b" : "");
    document.getElementById("wx-stale").classList.toggle("hidden", !wx.stale);
    const s = state.sun || E.solarPosition(date, D.center.lat, D.center.lon);
    document.getElementById("sun-line").textContent = s.elevation > 2
      ? "Sun " + s.elevation.toFixed(0) + "° above horizon · azimuth " + s.azimuth.toFixed(0) + "° — shade recalculated"
      : "Sun below skyline — streets shaded";
  }

  function setLoading(on) {
    if (on) document.getElementById("routes").innerHTML =
      '<div class="panel hint" style="text-align:center">Finding real pedestrian routes…</div>';
  }

  function comfortClass(c) { return c >= 60 ? "c-good" : c >= 40 ? "c-mid" : "c-bad"; }

  function selectMode(md) {
    state.selected = md;
    document.querySelectorAll(".route-card").forEach(x =>
      x.classList.toggle("selected", x.dataset.mode === md));
    if (layersReady) map.getSource("routes").setData(routeFC());
  }

  function renderRoutes() {
    const prefPick = state.sens < 0.34 ? "fastest" : state.sens > 0.67 ? "coolest" : "balanced";
    const f = state.modes.fastest;
    const srcBadge = state.source === "api"
      ? '<span class="badge">real streets · OSM foot routing</span>'
      : '<span class="badge stale-b">simulated network (offline)</span>';
    document.getElementById("routes").innerHTML =
      `<div class="hint" style="margin-bottom:6px">${srcBadge}</div>` +
      ["fastest", "coolest", "balanced"].map(md => {
        const r = state.modes[md], meta = MODE_META[md];
        const dMin = r.etaMin - f.etaMin, dShade = r.shadePct - f.shadePct, dHeat = r.heatScore - f.heatScore;
        const delta = md === "fastest" ? "baseline"
          : (dMin >= 0 ? "+" : "") + dMin.toFixed(1) + " min · " + (dShade >= 0 ? "+" : "") + dShade + "% shade · " + (dHeat >= 0 ? "+" : "") + dHeat + " heat vs fastest";
        const cps = r.coolingPoints.map(p => `<span class="cp-chip">❄ ${p.name}</span>`).join("");
        const sunny = r.sunnyStretches && r.sunnyStretches.length
          ? `<div class="rc-delta">☀ most exposed: ${r.sunnyStretches.map(s => s.name + " ~" + s.lenM + " m").join(", ")}</div>` : "";
        return `<div class="route-card ${md} ${md === state.selected ? "selected" : ""}" data-mode="${md}">
          <div class="rc-head">
            <span class="rc-name" style="color:${meta.color}">${meta.icon} ${meta.name}
              ${md === prefPick ? '<span class="pick">Best for you</span>' : ""}</span>
            <span class="rc-eta">${Math.round(r.etaMin)}<small> min</small></span>
          </div>
          <div class="rc-stats">
            <span><b>${r.distanceM}</b> m</span>
            <span>shade <b>${r.shadePct}%</b></span>
            <span>heat <b>${r.heatScore}</b>/100</span>
            <span class="comfort-pill ${comfortClass(r.comfort)}">comfort ${r.comfort}</span>
          </div>
          ${cps ? `<div class="rc-cool">${cps}</div>` : ""}
          <div class="rc-delta">${delta}</div>
          ${sunny}
        </div>`;
      }).join("");
    document.querySelectorAll(".route-card").forEach(el =>
      el.addEventListener("click", () => selectMode(el.dataset.mode)));
  }

  function renderCompare() {
    const rows = [["fastest", "#f59e0b"], ["coolest", "#06b6d4"], ["balanced", "#8b5cf6"]];
    const metrics = [
      ["Time", r => r.etaMin, v => Math.round(v) + "′"],
      ["Shade", r => r.shadePct, v => v + "%"],
      ["Comfort", r => r.comfort, v => v]
    ];
    document.getElementById("compare-bars").innerHTML = metrics.map(([label, get, fmt]) => {
      const vals = rows.map(([md]) => get(state.modes[md]));
      const max = Math.max(...vals, 1);
      return `<div class="cmp-label" style="margin-top:6px">${label}</div>` + rows.map(([md, color], i) =>
        `<div class="cmp-row"><span>${MODE_META[md].name}</span>
         <div class="cmp-track"><div class="cmp-fill" style="width:${(vals[i] / max) * 100}%;background:${color}"></div></div>
         <span class="cmp-val">${fmt(vals[i])}</span></div>`).join("");
    }).join("");
  }

  // ---------- UI wiring ----------
  const selA = document.getElementById("sel-a"), selB = document.getElementById("sel-b");
  D.landmarks.forEach((l, i) => { selA.add(new Option(l.name, i)); selB.add(new Option(l.name, i)); });
  for (const sel of [selA, selB]) {
    const pinOpt = new Option("Dropped pin 📍", "pin");
    pinOpt.disabled = true; // set programmatically only, after an actual map click
    sel.add(pinOpt);
  }
  function syncSelects() {
    selA.value = state.a.label === "Dropped pin" ? "pin" : D.landmarks.findIndex(l => l.name === state.a.label);
    selB.value = state.b.label === "Dropped pin" ? "pin" : D.landmarks.findIndex(l => l.name === state.b.label);
  }
  syncSelects();
  const onSel = key => ev => {
    const v = ev.target.value;
    if (v === "pin") return;
    const l = D.landmarks[parseInt(v, 10)];
    state[key] = { ...l, label: l.name };
    recompute(true);
  };
  selA.addEventListener("change", onSel("a"));
  selB.addEventListener("change", onSel("b"));
  document.getElementById("swap").addEventListener("click", () => {
    [state.a, state.b] = [state.b, state.a]; syncSelects(); recompute(true);
  });

  function setPick(which) {
    state.pick = state.pick === which ? null : which;
    document.getElementById("pick-a").classList.toggle("active", state.pick === "a");
    document.getElementById("pick-b").classList.toggle("active", state.pick === "b");
    banner(state.pick ? "Click anywhere on the map to set point " + state.pick.toUpperCase() : null);
  }
  document.getElementById("pick-a").addEventListener("click", () => setPick("a"));
  document.getElementById("pick-b").addEventListener("click", () => setPick("b"));

  // Debounce recompute so slider drags don't spam the routing API
  let recTimer = null;
  const debouncedRecompute = () => {
    clearTimeout(recTimer);
    recTimer = setTimeout(() => recompute(false), 350);
  };

  const depart = document.getElementById("depart");
  depart.addEventListener("input", () => {
    state.departH = parseFloat(depart.value);
    document.getElementById("depart-label").textContent = fmtH(state.departH);
    debouncedRecompute();
  });
  document.getElementById("now-btn").addEventListener("click", () => {
    const n = hktNow();
    state.departH = Math.min(21, Math.max(6, n.getUTCHours() + n.getUTCMinutes() / 60));
    depart.value = state.departH;
    document.getElementById("depart-label").textContent = fmtH(state.departH);
    recompute(false);
  });

  const sens = document.getElementById("sens");
  sens.addEventListener("input", () => {
    state.sens = parseFloat(sens.value);
    document.getElementById("sens-label").textContent =
      state.sens < 0.34 ? "I just want the quickest way" :
      state.sens > 0.67 ? "I strongly avoid sun & heat" : "Balanced trade-off";
    debouncedRecompute();
  });

  document.getElementById("method-btn").addEventListener("click", () =>
    document.getElementById("method-dialog").showModal());

  let bannerTimer = null;
  function banner(msg) {
    const el = document.getElementById("banner");
    if (!msg) return hideBanner();
    el.textContent = msg; el.classList.remove("hidden");
    clearTimeout(bannerTimer);
    bannerTimer = setTimeout(hideBanner, 6000);
  }
  function hideBanner() { document.getElementById("banner").classList.add("hidden"); }

  fetchWeather();
})();
