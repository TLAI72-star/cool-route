/* CoolRoute v2 prototype — UI + map wiring
 * Per v2 docs: 3D fill-extrusion buildings, HKO live weather (dual-source),
 * day/night awareness, graph routing ONLY (no straight-line fallback),
 * Coolest ≠ Fastest by construction, similarity warning when identical.
 */
(function () {
  const D = CR_DATA, E = CR_ENGINE, BLD = CR_BUILDINGS;
  const MODE_META = {
    fastest: { name: "Fastest", icon: "⚡", color: "#2563eb" },   // blue (guide §3.2)
    coolest: { name: "Coolest", icon: "❄", color: "#16a34a" },   // green
    balanced: { name: "Balanced", icon: "⚖", color: "#8b5cf6" }  // purple
  };
  const IS_MOBILE = matchMedia("(pointer: coarse)").matches || innerWidth < 820;

  const state = {
    a: { ...D.landmarks[0], label: D.landmarks[0].name },
    b: { ...D.landmarks[12], label: D.landmarks[12].name },
    departH: null,            // set to current HKT time below
    sens: 0.5,
    weather: null,            // {tempC, rhPct, source, fetchedAt(Date), stale, backup}
    pick: null, selected: "balanced",
    modes: null, identicalFC: false,
    sun: null, seq: 0
  };
  const bidx = E.buildBuildingIndex(BLD);

  // ---------- HKT time helpers ----------
  const hktNow = () => new Date(Date.now() + 8 * 3600e3);
  function buildDate(hFloat) {
    const n = hktNow();
    const h = Math.floor(hFloat), m = Math.round((hFloat - h) * 60);
    return new Date(Date.UTC(n.getUTCFullYear(), n.getUTCMonth(), n.getUTCDate(), h - 8, m));
  }
  const pad = x => String(x).padStart(2, "0");
  const fmtH = h => pad(Math.floor(h)) + ":" + pad(Math.round((h % 1) * 60));
  state.departH = (() => { const n = hktNow(); return Math.min(21, Math.max(6, n.getUTCHours() + n.getUTCMinutes() / 60)); })();

  // ---------- Map (3D per ADR-005) ----------
  const RASTER_FALLBACK = {
    version: 8,
    sources: { carto: { type: "raster", tiles: ["https://basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}.png"], tileSize: 256, attribution: "© OpenStreetMap contributors © CARTO" } },
    layers: [{ id: "carto", type: "raster", source: "carto" }]
  };
  const map = new maplibregl.Map({
    container: "map",
    style: "https://basemaps.cartocdn.com/gl/voyager-gl-style/style.json",
    center: [D.center.lon, D.center.lat],
    zoom: 15.8,
    pitch: IS_MOBILE ? 0 : 58,       // guide: pitch 45–60 required for 3D
    bearing: -20,
    maxPitch: 65,
    antialias: true,
    attributionControl: { compact: true }
  });
  map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), "top-right");
  map.addControl(new maplibregl.ScaleControl(), "bottom-right");

  let layersReady = false, buildings3D = false;
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

    // 3D buildings (ADR-005; degrade to 2D on failure — failure-mode table)
    if (!IS_MOBILE) {
      try {
        map.addSource("buildings", { type: "geojson", data: BLD });
        map.addLayer({
          id: "3d-buildings",
          source: "buildings",
          type: "fill-extrusion",
          paint: {
            "fill-extrusion-color": "#a8b8ad",
            "fill-extrusion-height": ["get", "height"],
            "fill-extrusion-base": 0,
            "fill-extrusion-opacity": 0.75
          }
        });
        buildings3D = true;
      } catch (err) {
        console.warn("3D buildings unavailable, degrading to 2D", err);
        buildings3D = false;
      }
    }

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
        "line-color": ["match", ["get", "mode"],
          "fastest", MODE_META.fastest.color, "coolest", MODE_META.coolest.color, MODE_META.balanced.color],
        "line-width": ["case", ["to-boolean", ["get", "selected"]], 5, 3.5],
        "line-opacity": ["case", ["to-boolean", ["get", "selected"]], 1, 0.55],
        "line-offset": ["match", ["get", "mode"], "fastest", -4, "coolest", 4, 0]
      },
      layout: { "line-cap": "round", "line-join": "round" }
    });

    map.on("click", "route-lines", ev => { if (!state.pick) selectMode(ev.features[0].properties.mode); });
    map.on("mousemove", "route-lines", () => { if (!state.pick) map.getCanvas().style.cursor = "pointer"; });
    map.on("mouseleave", "route-lines", () => { map.getCanvas().style.cursor = ""; });

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

  // ---------- Weather: HKO primary → Open-Meteo fallback → last-good snapshot
  async function fetchWeather() {
    try {
      const res = await fetch("https://data.weather.gov.hk/weatherAPI/opendata/weather.php?dataType=rhrread&lang=en");
      if (!res.ok) throw new Error("HTTP " + res.status);
      const j = await res.json();
      const stations = j.temperature?.data || [];
      const pref = ["Hong Kong Park", "Hong Kong Observatory", "King's Park"];
      const st = pref.map(p => stations.find(s => s.place === p)).find(Boolean) || stations[0];
      if (!st) throw new Error("no temperature stations");
      const rh = (j.humidity?.data || [])[0];
      return finishWeather({
        tempC: st.value, rhPct: rh ? rh.value : null,
        source: "HKO · " + st.place, backup: false, stale: false,
        fetchedAt: new Date(j.temperature.recordTime || j.updateTime)
      });
    } catch (e1) {
      try {
        const u = "https://api.open-meteo.com/v1/forecast?latitude=" + D.center.lat + "&longitude=" + D.center.lon
          + "&current=temperature_2m,relative_humidity_2m&timezone=Asia%2FHong_Kong";
        const res = await fetch(u);
        if (!res.ok) throw new Error("HTTP " + res.status);
        const j = await res.json();
        return finishWeather({
          tempC: j.current.temperature_2m, rhPct: j.current.relative_humidity_2m,
          source: "Open-Meteo (fallback)", backup: true, stale: false,
          fetchedAt: new Date(j.current.time)
        });
      } catch (e2) {
        const last = readLastGood();
        state.weather = last || { ...D.fallbackWeather, fetchedAt: null };
        renderWeather(); recompute(false);
      }
    }
  }
  function finishWeather(wx) {
    if (isNaN(wx.fetchedAt)) wx.fetchedAt = new Date();
    state.weather = wx;
    try { localStorage.setItem("coolroute:lastgood", JSON.stringify({ ...wx, fetchedAt: wx.fetchedAt.getTime() })); } catch (e) {}
    renderWeather(); recompute(false);
  }
  function readLastGood() {
    try {
      const j = JSON.parse(localStorage.getItem("coolroute:lastgood"));
      if (j && j.tempC != null) return { ...j, stale: true, fetchedAt: new Date(j.fetchedAt) };
    } catch (e) {}
    return null;
  }

  // ---------- Routing (graph only — NO straight-line fallback) ----------
  function decodePolyline(str, precision) {
    const f = Math.pow(10, -(precision || 6));
    let index = 0, lat = 0, lon = 0;
    const coords = [];
    while (index < str.length) {
      let b, shift = 0, result = 0;
      do { b = str.charCodeAt(index++) - 63; result |= (b & 0x1f) << shift; shift += 5; } while (b >= 0x20);
      lat += (result & 1) ? ~(result >> 1) : (result >> 1);
      shift = 0; result = 0;
      do { b = str.charCodeAt(index++) - 63; result |= (b & 0x1f) << shift; shift += 5; } while (b >= 0x20);
      lon += (result & 1) ? ~(result >> 1) : (result >> 1);
      coords.push([lon * f, lat * f]);
    }
    return coords;
  }

  async function fetchRouteValhalla(waypoints, alternates) {
    const cfg = D.routingProviders.find(p => p.name === "valhalla");
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), cfg.timeoutMs);
    try {
      const res = await fetch(cfg.url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          locations: waypoints.map(([lon, lat]) => ({ lat, lon })),
          costing: "pedestrian",
          alternates,
          directions_options: { units: "kilometers", language: "en-US" }
        }),
        signal: ctrl.signal
      });
      if (!res.ok) throw new Error("HTTP " + res.status);
      const j = await res.json();
      const trips = [j.trip].concat((j.alternates || []).map(a => a.trip)).filter(Boolean);
      if (!trips.length || !trips[0].legs) throw new Error("no valhalla routes");
      return trips.map(trip => {
        const coords = [], steps = [];
        let distanceM = 0, durationS = 0;
        for (const leg of trip.legs) {
          const shape = decodePolyline(leg.shape);
          const startAt = coords.length ? 1 : 0; // drop shared joint between legs
          coords.push(...shape.slice(startAt));
          for (const m of leg.maneuvers) {
            const seg = shape.slice(m.begin_shape_index, m.end_shape_index + 1);
            if (seg.length) steps.push({ name: (m.street_names && m.street_names[0]) || "", coords: seg });
          }
          distanceM += (leg.summary.length || 0) * 1000;
          durationS += leg.summary.time || 0;
        }
        return { distanceM, durationS, coords, steps };
      }).filter(c => c.coords.length > 1);
    } finally { clearTimeout(t); }
  }

  async function fetchRouteOsrm(waypoints, alternatives) {
    const cfg = D.routingProviders.find(p => p.name === "osrm") || D.routingService;
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), cfg.timeoutMs);
    try {
      const coords = waypoints.map(w => w[0] + "," + w[1]).join(";");
      const res = await fetch(cfg.url + coords
        + "?geometries=geojson&overview=full&steps=true&alternatives=" + alternatives, { signal: ctrl.signal });
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

  const PROVIDERS = { valhalla: fetchRouteValhalla, osrm: fetchRouteOsrm };
  async function fetchRouteAny(waypoints, alternatives) {
    let lastErr = null;
    for (const p of D.routingProviders) {
      try {
        const routes = await PROVIDERS[p.name](waypoints, alternatives);
        if (routes && routes.length) return routes;
      } catch (e) { lastErr = e; }
    }
    throw lastErr || new Error("all routing providers failed");
  }
  const inHK = p => p.lat >= D.hkBounds.latMin && p.lat <= D.hkBounds.latMax
    && p.lon >= D.hkBounds.lonMin && p.lon <= D.hkBounds.lonMax;

  function viaBetween(a, b) {
    const padDeg = 0.004;
    const minLat = Math.min(a.lat, b.lat) - padDeg, maxLat = Math.max(a.lat, b.lat) + padDeg;
    const minLon = Math.min(a.lon, b.lon) - padDeg, maxLon = Math.max(a.lon, b.lon) + padDeg;
    return D.viaPoints.filter(v =>
      v.lat > minLat && v.lat < maxLat && v.lon > minLon && v.lon < maxLon
      && E.haversineM(a.lat, a.lon, v.lat, v.lon) > 150
      && E.haversineM(b.lat, b.lon, v.lat, v.lon) > 150).slice(0, 4);
  }

  // Sequential with retry — demo servers rate-limit bursts (fair-use policy)
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  async function fetchRouteRetry(wp, alt) {
    try { return await fetchRouteAny(wp, alt); }
    catch (e) { await sleep(1500); return fetchRouteAny(wp, alt); }
  }

  async function planRoutes(wx) {
    if (!inHK(state.a) || !inHK(state.b))
      throw { code: 422, message: "該區域暫未覆蓋 — point outside graph coverage (HK bounds). Please pick nearer points." };
    const a = state.a, b = state.b;
    const results = [];
    results.push(await fetchRouteRetry([[a.lon, a.lat], [b.lon, b.lat]], 3).catch(e => ({ __err: e })));
    for (const v of viaBetween(a, b)) {
      await sleep(300);
      results.push(await fetchRouteRetry([[a.lon, a.lat], [v.lon, v.lat], [b.lon, b.lat]], 0).catch(e => ({ __err: e })));
    }
    const seen = new Set(), cands = [];
    for (const r of results) {
      if (!r || r.__err) continue;
      for (const cand of r) {
        const sig = E.routeSignature(cand.coords);
        if (seen.has(sig)) continue;
        seen.add(sig); cands.push(cand);
      }
    }
    if (!cands.length) throw { code: 503, message: "Routing service unavailable — please try again in a moment." };

    const date = buildDate(state.departH);
    const sun = E.solarPosition(date, D.center.lat, D.center.lon);
    state.sun = sun;
    const ctx = {
      sun, weather: { tempC: wx.tempC }, bidx,
      coolingPoints: D.coolingPoints, coveredHints: D.coveredHints
    };
    for (const c of cands) Object.assign(c, E.scoreCandidate(c, ctx));
    return E.pickModes(cands, state.sens);
  }

  // ---------- Recompute pipeline ----------
  async function recompute(moveMap) {
    const seq = ++state.seq;
    if (!state.weather) {
      const last = readLastGood();
      state.weather = last || { ...D.fallbackWeather, fetchedAt: null };
    }
    renderTimeBadge(); renderWeather(); setLoading(true);
    try {
      const modes = await planRoutes(state.weather);
      if (seq !== state.seq) return;
      state.modes = modes;
      state.identicalFC = E.routeSignature(modes.fastest.coords) === E.routeSignature(modes.coolest.coords);
      hideBanner();
    } catch (err) {
      if (seq !== state.seq) return;
      setLoading(false);
      state.modes = null;
      if (layersReady) map.getSource("routes").setData(routeFC());
      banner("🔴 " + (err && err.message || "Routing failed."), true);
      document.getElementById("routes").innerHTML =
        '<div class="panel hint" style="text-align:center">No route to display — see message above.</div>';
      document.getElementById("compare-bars").innerHTML = "";
      return;
    }
    setLoading(false);
    renderRoutes(); renderCompare();
    if (layersReady) map.getSource("routes").setData(routeFC());
    markerA.setLngLat([state.a.lon, state.a.lat]).addTo(map);
    markerB.setLngLat([state.b.lon, state.b.lat]).addTo(map);
    if (moveMap) {
      const bds = new maplibregl.LngLatBounds();
      for (const md of ["fastest", "coolest", "balanced"]) state.modes[md].coords.forEach(c => bds.extend(c));
      map.fitBounds(bds, { padding: 90, duration: 500 });
    }
  }

  // ---------- Badges ----------
  function renderTimeBadge() {
    const date = buildDate(state.departH);
    const s = state.sun || E.solarPosition(date, D.center.lat, D.center.lon);
    const icon = s.isDay ? "☀" : s.twilight ? "🌇" : "🌙";
    const label = s.isDay ? "day" : s.twilight ? "twilight" : "night";
    document.getElementById("time-badge").innerHTML =
      `${icon} <b>${fmtH(state.departH)}</b> HKT · ${label} · sun ${s.elevation.toFixed(0)}° / az ${s.azimuth.toFixed(0)}°`;
    const tint = document.getElementById("night-tint");
    tint.style.opacity = s.isDay ? 0 : s.twilight ? 0.15 : 0.38;
  }
  function renderWeather() {
    const wx = state.weather;
    if (!wx) return;
    const ageMin = wx.fetchedAt ? (Date.now() - wx.fetchedAt.getTime()) / 60000 : Infinity;
    const aged = ageMin > 30;   // freshness rule: highlight beyond 30 min
    const src = wx.stale ? "stale" : wx.backup ? "↻ 備份源" : "live";
    const cls = wx.stale || aged ? "wx-badge stale-b" : "wx-badge";
    document.getElementById("weather-badge").innerHTML =
      `🌡 <b>${wx.tempC.toFixed(1)}°C</b> · RH ${wx.rhPct != null ? Math.round(wx.rhPct) + "%" : "—"} ` +
      `<span class="${cls}">${wx.source}${wx.fetchedAt ? " · 更新於 " + pad(wx.fetchedAt.getHours()) + ":" + pad(wx.fetchedAt.getMinutes()) : ""} · ${src}</span>`;
    document.getElementById("wx-stale").classList.toggle("hidden", !(wx.stale || aged));
  }

  // ---------- Rendering ----------
  function setLoading(on) {
    if (on) document.getElementById("routes").innerHTML =
      '<div class="panel hint" style="text-align:center">Computing graph routes…</div>';
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
    const warn = state.identicalFC
      ? `<div class="warn-bar">⚠ 兩條路線相同 — Fastest and Coolest coincide at this departure time. 建議調整出發時間 (try a different departure time).</div>` : "";
    document.getElementById("routes").innerHTML = warn +
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
    const rows = [["fastest", MODE_META.fastest.color], ["coolest", MODE_META.coolest.color], ["balanced", MODE_META.balanced.color]];
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
    pinOpt.disabled = true;
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

  let recTimer = null;
  const debouncedRecompute = () => {
    clearTimeout(recTimer);
    recTimer = setTimeout(() => recompute(false), 350);
  };

  const depart = document.getElementById("depart");
  depart.value = state.departH;
  document.getElementById("depart-label").textContent = fmtH(state.departH);
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
  function banner(msg, sticky) {
    const el = document.getElementById("banner");
    if (!msg) return hideBanner();
    el.textContent = msg; el.classList.remove("hidden");
    clearTimeout(bannerTimer);
    if (!sticky) bannerTimer = setTimeout(hideBanner, 6000);
  }
  function hideBanner() { document.getElementById("banner").classList.add("hidden"); }

  // Re-tint the map as day turns to night
  setInterval(() => { renderTimeBadge(); }, 60000);

  fetchWeather();
})();
