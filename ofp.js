// VFR OFP builder page: map, route editing, leg table (Nav.computeOfp), finalise, PDF, ForeFlight, history, admin ATO placement.
// Step 3 (OfpData / Safety) plugs in through window.OfpPage: see "HOOKS" below.
(function () {
  "use strict";
  const ready = window.Auth && window.L && window.Nav && window.Perf && window.ATO && window.OfpPrint && window.LAT_AIRPORTS;
  if (!ready) {
    document.body.classList.remove("booting");
    document.body.innerHTML = '<p class="unavail"><b>OFP page unavailable</b><br>Open this page from the server (not as a file) and reload.</p>';
    return;
  }
  window.Auth
    .requireUser()
    .then((u) => start(u.profile))
    .catch((e) => {
      document.body.classList.remove("booting");
      document.body.innerHTML = `<p class="unavail"><b>Sign-in service unavailable</b><br>${String((e && e.message) || e).replace(/[<>&]/g, "")}</p>`;
    });

  function start(profile) {
    const Auth = window.Auth, L = window.L, Nav = window.Nav, Perf = window.Perf, ATO = window.ATO, OP = window.OfpPrint, LAT = window.LAT_AIRPORTS;
    const byId = (id) => document.getElementById(id);
    const $$ = (s, r) => [...(r || document).querySelectorAll(s)];
    const esc = (s) => String(s == null ? "" : s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
    const isNum = (v) => typeof v === "number" && isFinite(v);
    const num = (v) => (v === "" || v == null || !isFinite(+v) ? null : +v);
    const r1 = (x) => Math.round(x * 10) / 10;
    const p3 = (n) => String(Math.round(n) % 360 || 360).padStart(3, "0");
    const lsGet = (k) => { try { return localStorage.getItem(k); } catch (e) { return null; } };
    const lsSet = (k, v) => { try { localStorage.setItem(k, v); } catch (e) { /* storage blocked */ } };
    const today = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; };
    const tileUrl = (n) => `https://tiles.arcgis.com/tiles/ssFJjBXIUyZDrSYZ/arcgis/rest/services/${n}/MapServer/tile/{z}/{y}/{x}`;
    const ADDS = "https://services6.arcgis.com/ssFJjBXIUyZDrSYZ/arcgis/rest/services/";
    const DRAFT_KEY = "ofp.draft.v1", HANDOFF_KEY = "ofp.handoff", PRICE = 3, MAX_FUEL = 56;
    let pid = 0;
    const newId = () => "p" + Date.now().toString(36) + (pid++).toString(36);

    /* ===================================================== state (draft) ===================================================== */
    // state.mid = intermediate points, in route order. The departure and arrival airports are state.dep / state.dest;
    // the arrival airport carries its own per-leg fields in state.destPt (alt, msa, wind, rem).
    // point = {id, name, ident, type:'AIRPORT'|'USER WAYPOINT', lat, lon, lib:null|'ato'|'personal'|'apt', wid, proc:null|'dep'|'arr',
    //          alt:null|ft (null = automatic), msa:null|ft (null = automatic/none), wind:{dir,spd}|null, rem:{touchGo,taxiBack,fullStop,airwork}}
    const blankRem = () => ({ touchGo: 0, taxiBack: 0, fullStop: false, airwork: 0 });
    const blankState = () => ({
      v: 1, id: null, finalKey: null, finalSig: null,
      date: today(), offBlock: "", toTime: "", blockMin: null, reg: "", callsign: "", mission: "", crew: ["", "", ""],
      solo: true, night: false, dep: "KGYR", dest: "KGYR", takeoffFuel: 45, pwr: 75, isaDev: 0, isaAuto: false, cruiseFfOv: null, auto: { legs: {}, src: {}, at: null },
      windMode: "auto", wind: { dir: null, spd: null }, depProc: null, arrProc: null, depTr: null, arrTr: null, mid: [], seq: 0, notes: "",
      destPt: { alt: null, msa: null, wind: null, rem: Object.assign(blankRem(), { fullStop: true }) },
    });
    function normState(s) {
      const b = blankState(), o = Object.assign(b, s || {});
      o.crew = [0, 1, 2].map((i) => String((s && s.crew && s.crew[i]) || ""));
      o.wind = Object.assign({ dir: null, spd: null }, (s && s.wind) || {});
      o.destPt = Object.assign(b.destPt, (s && s.destPt) || {});
      o.destPt.rem = Object.assign(blankRem(), o.destPt.rem || {});
      o.auto = o.auto && o.auto.legs ? { legs: o.auto.legs, src: o.auto.src || {}, at: o.auto.at || null } : { legs: {}, src: {}, at: null };
      o.mid = (Array.isArray(o.mid) ? o.mid : []).filter((p) => p && isNum(p.lat) && isNum(p.lon)).map((p) => {
        p.id = p.id || newId();
        p.rem = Object.assign(blankRem(), p.rem || {});
        p.type = p.type === "AIRPORT" ? "AIRPORT" : "USER WAYPOINT";
        return p;
      });
      return o;
    }
    let state;
    try { state = normState(JSON.parse(lsGet(DRAFT_KEY) || "null")); } catch (e) { state = blankState(); }

    /* ===================================================== ctx: hook point for step 3 ===================================================== */
    // Per-leg auto values, keyed by point id (the leg ARRIVING at that point; the arrival airport has id 'dest').
    //   msaAuto[id] = ft (already Nav.msa-rounded), msaHigh[id] = {lat, lon, ft}  (highest-point marker)
    //   windAuto[id] = {dir, spd, src, age}  (MAGNETIC)     conflicts[id] = [{kind, text, ...}]     glide[id] = ...
    //   groundFt[id] = ft  (terrain under the leg, for the semicircular rule above 3000 ft AGL)
    //   checks = [{leg:index|null, id, level:'err'|'warn'|'info', text}]  (from Safety.checks)    notes = extra lines for the Notes box
    //   unavailable = {airspace:true, terrain:true, wind:true,...}  sources that failed (shown as "unavailable", never as 0)
    const ctx = { airports: {}, msaAuto: {}, msaHigh: {}, windAuto: {}, conflicts: {}, glide: {}, groundFt: {}, checks: [], notes: [], unavailable: {},
      data: { airspace: [], airports: [], obstacles: [] }, sources: {}, regionKey: "", dataVersion: 0,
      legT: {}, wx: null, wxChecks: [], wxSources: {} };
    const hooks = { afterCompute: [], onRoute: [], altOptions: null };

    /* ===================================================== small UI helpers ===================================================== */
    let toastTimer = null;
    function toast(msg) {
      const el = byId("toast");
      el.textContent = msg; el.hidden = false;
      clearTimeout(toastTimer);
      toastTimer = setTimeout(() => (el.hidden = true), 4000);
    }
    // Native <dialog>. Resolves {v: data-v of the clicked button or null, f: {name: value of [name] inputs}}.
    function dialog(html, opts) {
      return new Promise((resolve) => {
        const d = document.createElement("dialog");
        if (opts && opts.cls) d.className = opts.cls;
        d.innerHTML = html;
        let v = null;
        const form = () => { const f = {}; $$("[name]", d).forEach((el) => { f[el.name] = el.type === "checkbox" ? el.checked : el.value; }); return f; };
        d.addEventListener("click", (e) => { const b = e.target.closest("[data-v]"); if (b) { v = b.dataset.v; d.close(); } });
        d.addEventListener("close", () => { const f = form(); d.remove(); resolve({ v, f }); });
        document.body.appendChild(d);
        d.showModal();
        if (opts && opts.onOpen) opts.onOpen(d);
        const first = d.querySelector("[autofocus],input[name]"); if (first) first.focus();
      });
    }
    const howEl = byId("how");
    function showHow(text, anchor) {
      if (!text) return;
      howEl.textContent = text; howEl.hidden = false;
      const r = anchor.getBoundingClientRect(), w = howEl.offsetWidth;
      howEl.style.left = Math.max(8, Math.min(window.innerWidth - w - 8, r.left + r.width / 2 - w / 2)) + "px";
      const below = r.bottom + 6 + howEl.offsetHeight < window.innerHeight;
      howEl.style.top = (below ? r.bottom + 6 : Math.max(8, r.top - howEl.offsetHeight - 6)) + "px";
    }
    document.addEventListener("click", (e) => { if (!e.target.closest("[data-how]")) howEl.hidden = true; });
    document.addEventListener("keydown", (e) => { if (e.key === "Escape") howEl.hidden = true; });

    /* ===================================================== chrome: account menu, tokens ===================================================== */
    const tokens = () => (profile && Number.isFinite(+profile.tokens) ? +profile.tokens : 0);
    function syncChrome() {
      const t = tokens(), b = byId("tokens");
      b.textContent = `${t} token${t === 1 ? "" : "s"}`;
      b.className = "badge" + (t < PRICE ? " low" : "");
      const who = profile.name || profile.email || "";
      byId("who").textContent = who;
      const w = who.trim().split(/[\s@.]+/).filter(Boolean);
      byId("ini").textContent = w.length ? (w[0][0] + (w.length > 1 ? w[1][0] : "")).toUpperCase() : "?";
      byId("adminLink").hidden = profile.role !== "admin";
      byId("secAto").hidden = profile.role !== "admin"; byId("secProcs").hidden = profile.role !== "admin";
    }
    const acctBtn = byId("acctBtn"), acctMenu = byId("acctMenu");
    const menuItems = () => [...acctMenu.querySelectorAll("[role=menuitem]")].filter((el) => !el.hidden && !el.disabled);
    const menuOpen = () => !acctMenu.hidden;
    function openMenu() { acctMenu.hidden = false; acctBtn.setAttribute("aria-expanded", "true"); const it = menuItems(); if (it[0]) it[0].focus(); }
    function closeMenu(refocus) { if (!menuOpen()) return; acctMenu.hidden = true; acctBtn.setAttribute("aria-expanded", "false"); if (refocus) acctBtn.focus(); }
    acctBtn.addEventListener("click", () => (menuOpen() ? closeMenu(true) : openMenu()));
    acctMenu.addEventListener("click", (e) => { if (e.target.closest("[role=menuitem]")) closeMenu(true); }, true);
    acctMenu.addEventListener("keydown", (e) => {
      const it = menuItems(), i = it.indexOf(document.activeElement);
      const go = (j) => { e.preventDefault(); if (it.length) it[(j + it.length) % it.length].focus(); };
      if (e.key === "ArrowDown") go(i + 1); else if (e.key === "ArrowUp") go(i < 0 ? it.length - 1 : i - 1);
      else if (e.key === "Escape") { e.preventDefault(); closeMenu(true); } else if (e.key === "Tab") closeMenu(false);
    });
    document.addEventListener("click", (e) => { if (menuOpen() && !e.target.closest(".menu")) closeMenu(false); });
    byId("signout").addEventListener("click", () => Auth.signOut());
    function refreshProfile() {
      Auth.profile().then((p) => { if (!p) return; if (p.disabled) return Auth.signOut(); profile = p; syncChrome(); }, () => {});
    }
    document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") refreshProfile(); });

    /* ===================================================== data: airports, waypoint library ===================================================== */
    const lib = { ato: [], personal: [], byName: {}, loaded: false, error: "" };
    // ATO procedures: the plate defaults in ato.js merged with the admin overrides stored in the ato_procedures table
    let procs = ATO.merge(ATO.procedures, []), procRows = [];
    const aptList = Object.values(LAT).filter((a) => a && a.icao);
    const aptOf = (code) => LAT.find(code);
    const icaoOf = (code) => { const a = aptOf(code); return a ? a.icao : null; };

    async function loadAirports() {
      const KEY = "ofp.apt.v1", MS = 30 * 864e5;
      let c = null;
      try { c = JSON.parse(lsGet(KEY) || "null"); } catch (e) { c = null; }
      if (c && c.t && Date.now() - c.t < MS && c.d && Object.keys(c.d).length >= aptList.length - 3) { ctx.airports = c.d; return; }
      try {
        const ids = aptList.map((a) => "'" + a.id.replace(/'/g, "") + "'").join(",");
        const url = `${ADDS}US_Airport/FeatureServer/0/query?outFields=IDENT,ELEVATION&returnGeometry=true&outSR=4326&f=json&where=${encodeURIComponent("IDENT IN (" + ids + ")")}`;
        const r = await fetch(url);
        if (!r.ok) throw new Error("HTTP " + r.status);
        const j = await r.json();
        const d = {};
        (j.features || []).forEach((f) => { if (f.geometry && f.attributes) d[f.attributes.IDENT] = { lat: f.geometry.y, lon: f.geometry.x, elev: f.attributes.ELEVATION }; });
        if (!Object.keys(d).length) throw new Error("no airports returned");
        ctx.airports = d; ctx.unavailable.airports = false;
        lsSet(KEY, JSON.stringify({ t: Date.now(), d }));
      } catch (e) {
        if (c && c.d) ctx.airports = c.d;          // stale cache beats nothing
        ctx.unavailable.airports = !Object.keys(ctx.airports).length;
      }
    }
    function aptCoord(code) {
      const a = aptOf(code); if (!a) return null;
      const c = ctx.airports[a.id];
      return c && isNum(c.lat) && isNum(c.lon) ? { lat: c.lat, lon: c.lon } : null;
    }
    const aptElev = (code) => { const a = aptOf(code); return a && isNum(a.elev) ? a.elev : 0; };

    async function loadProcs() {
      try {
        const rows = await Auth.rest("/ato_procedures?select=id,data,hidden&order=id.asc&limit=1000");
        procRows = Array.isArray(rows) ? rows : [];
      } catch (e) { procRows = []; }   // table missing (database setup pending) or unreachable: plate defaults only
      procs = ATO.merge(ATO.procedures, procRows);
    }
    async function loadWaypoints() {
      await loadProcs();
      try {
        const rows = await Auth.rest("/waypoints?select=id,owner,name,ident,lat,lon,notes&order=name.asc&limit=1000");
        lib.ato = []; lib.personal = []; lib.byName = {};
        (rows || []).forEach((w) => {
          if (!isNum(+w.lat) || !isNum(+w.lon)) return;
          const o = { id: w.id, name: w.name, ident: w.ident || null, lat: +w.lat, lon: +w.lon, notes: w.notes || "", shared: w.owner == null };
          if (o.shared) { lib.ato.push(o); lib.byName[o.name] = o; lib.byName[String(o.name).toUpperCase()] = o; } else lib.personal.push(o);
        });
        lib.loaded = true; lib.error = "";
      } catch (e) {
        lib.error = /relation|does not exist|schema cache|PGRST205|404/i.test(String((e && e.message) || e) + (e && e.code))
          ? "Waypoint library not available yet (database setup pending). You can still plan with map points."
          : "Waypoint library unavailable: " + String((e && e.message) || e);
      }
      renderLibrary(); renderProcSelects(); renderAto(); renderProcAdmin(); compute();
    }

    /* ===================================================== map ===================================================== */
    L.Icon.Default.imagePath = "vendor/images/";
    const map = L.map("map", { zoomControl: true, maxZoom: 14, minZoom: 5, tap: true, doubleClickZoom: false }).setView([33.42, -112.38], 10);
    // detectRetina: on HiDPI each 256px tile covers 128 CSS px and Leaflet requests one zoom higher. It also lowers the
    // layer's maxZoom by one (hiding it at the map's top zoom), so retina layers get maxZoom +1, and maxNativeZoom -1
    // because the +1 offset is added after clamping. FAA tiles exist only to z12.
    const R = L.Browser.retina ? 1 : 0;
    const tileOpts = { maxNativeZoom: 12 - R, maxZoom: 14 + R, attribution: "FAA", keepBuffer: 3, detectRetina: true };
    const OSM_ATTR = '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> contributors';
    const OSM_URL = "https://tile.openstreetmap.org/{z}/{x}/{y}.png";
    map.createPane("osmOverlay"); map.getPane("osmOverlay").style.zIndex = 250; // above the chart tiles (200), below airspace/route/markers (400+)
    const tiles = {
      tac: L.tileLayer(tileUrl("VFR_Terminal"), tileOpts), sect: L.tileLayer(tileUrl("VFR_Sectional"), tileOpts),
      osm: L.tileLayer(OSM_URL, { maxZoom: 19, attribution: OSM_ATTR, keepBuffer: 3 }),
    };
    // Our own sharper tiles (docs/CHARTS.md): {CHARTS_PUBLIC_URL}/current.json names the edition, zooms and coverage.
    // Used where they cover the map centre; the FAA tiles stay the fallback everywhere else or if they fail to load.
    const hosted = {}; // tac / sect -> {layer, bounds, minZoom, errs, bad}
    (async () => {
      const base = String((window.SB_CONFIG && window.SB_CONFIG.charts) || "").replace(/\/+$/, "");
      if (!/^https?:\/\//.test(base)) return;
      try {
        const r = await fetch(base + "/current.json", { cache: "no-cache", signal: AbortSignal.timeout(8000) });
        const m = await r.json();
        if (!r.ok || !/^\d{4}-\d{2}-\d{2}$/.test(m.edition)) return;
        [["tac", "tac"], ["sect", "sec"]].forEach(([k, dir]) => {
          const c = m.layers && m.layers[dir];
          if (!c || !(c.maxZoom >= c.minZoom) || !Array.isArray(c.bounds)) return;
          const bounds = L.latLngBounds(c.bounds);
          const layer = L.tileLayer(`${base}/${m.edition}/${dir}/{z}/{x}/{y}.webp`, {
            minNativeZoom: c.minZoom - R, maxNativeZoom: c.maxZoom - R, maxZoom: 14 + R, bounds,
            attribution: `FAA charts, edition ${m.edition}`, keepBuffer: 3, detectRetina: true,
          });
          const h = { layer, bounds, minZoom: c.minZoom - R, errs: 0, bad: false };
          layer.on("tileload", () => { h.errs = 0; });
          layer.on("tileerror", () => { if (++h.errs >= 6 && !h.bad) { h.bad = true; applyBase(); } });
          hosted[k] = h;
        });
        applyBase();
      } catch (e) { /* no hosted tiles: FAA tiles only */ }
    })();
    function layerFor(k) {
      const h = hosted[k];
      return h && !h.bad && map.getZoom() >= h.minZoom && h.bounds.contains(map.getCenter()) ? h.layer : tiles[k];
    }
    let osmOverlay = null;
    let baseMode = ["auto", "tac", "sect", "osm"].includes(lsGet("ofp.base")) ? lsGet("ofp.base") : "auto";
    let tacBad = null, tacErr = 0, curLayer = null;
    function applyBase() {
      const want = baseMode === "tac" ? "tac" : baseMode === "sect" ? "sect" : baseMode === "osm" ? "osm" : tacBad || map.getZoom() < 10 ? "sect" : "tac";
      const layer = layerFor(want);
      if (layer !== curLayer) {
        if (curLayer) map.removeLayer(curLayer);
        map.setMaxZoom(want === "osm" ? 17 : 14);
        layer.addTo(map); layer.bringToBack(); curLayer = layer;
      }
      $$("#mapctl [data-base]").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.base === baseMode)));
    }
    tiles.tac.on("tileerror", () => {
      if (baseMode !== "auto" || tacBad || curLayer !== tiles.tac || map.getZoom() < 10) return;
      if (++tacErr >= 4) { tacBad = map.getCenter(); applyBase(); toast("No TAC tiles here, showing the sectional"); }
    });
    map.on("zoomend", () => { tacErr = 0; applyBase(); map.getContainer().classList.toggle("zlow", map.getZoom() < 9); map.getContainer().classList.toggle("zvlow", map.getZoom() < 8); });
    map.on("moveend", () => {
      tacErr = 0;
      if (!tacBad) applyBase();
      if (tacBad && Nav.dist({ lat: tacBad.lat, lon: tacBad.lng }, { lat: map.getCenter().lat, lon: map.getCenter().lng }) > 40) { tacBad = null; applyBase(); }
    });
    $$("#mapctl [data-base]").forEach((b) => b.addEventListener("click", () => { baseMode = b.dataset.base; lsSet("ofp.base", baseMode); tacBad = null; tacErr = 0; applyBase(); }));
    applyBase();

    // One layer group per overlay. Step 3 fills airspace / glide / prep / emergency (and may add its own).
    const layers = {};
    const LAYER_DEFS = [
      ["legs", "Route", true, true], ["ato", "ATO points", true], ["personal", "Personal points", true], ["airports", "Airports", true],
      ["airspace", "Airspace", true], ["wx", "Weather & TFR", true], ["glide", "Glide band", false], ["prep", "Chart prep", true], ["emergency", "Emergency fields", true],
    ];
    map.createPane("wxPane"); map.getPane("wxPane").style.zIndex = 350; // weather/TFR shapes: below the route and airspace (400), above the chart overlays
    let layerOn = {};
    try { layerOn = JSON.parse(lsGet("ofp.layers") || "{}") || {}; } catch (e) { layerOn = {}; }
    LAYER_DEFS.forEach(([k, label, def, hidden]) => {
      layers[k] = L.layerGroup();
      if (layerOn[k] === undefined) layerOn[k] = def;
      if (!hidden) {
        const l = document.createElement("label");
        l.innerHTML = `<input type="checkbox" data-layer="${k}"${layerOn[k] ? " checked" : ""}> ${esc(label)}`;
        byId("lays").appendChild(l);
      }
      if (layerOn[k] || hidden) layers[k].addTo(map);
    });
    layers.verts = L.layerGroup().addTo(map);
    layers.rubber = L.layerGroup().addTo(map);
    // OpenStreetMap overlay on top of the chart (own pane), with opacity
    {
      const on = layerOn.osm === true;
      let op = parseInt(lsGet("ofp.osmop"), 10); if (!(op >= 0 && op <= 100)) op = 50;
      const l = document.createElement("label");
      l.innerHTML = `<input type="checkbox" data-osm="on"${on ? " checked" : ""}> OpenStreetMap overlay`;
      const r = document.createElement("label");
      r.innerHTML = `Opacity <input type="range" min="0" max="100" step="5" value="${op}" data-osm="op" id="osmOp" aria-label="OpenStreetMap overlay opacity"> <span id="osmOpV">${op}%</span>`;
      byId("lays").appendChild(l); byId("lays").appendChild(r);
      osmOverlay = L.tileLayer(OSM_URL, { pane: "osmOverlay", maxZoom: 19, opacity: op / 100, attribution: OSM_ATTR, keepBuffer: 3 });
      if (on) osmOverlay.addTo(map);
      byId("lays").addEventListener("input", (e) => {
        if (e.target.dataset.osm !== "op") return;
        osmOverlay.setOpacity(e.target.value / 100); byId("osmOpV").textContent = e.target.value + "%"; lsSet("ofp.osmop", e.target.value);
      });
    }
    byId("lays").addEventListener("change", (e) => {
      if (e.target.dataset.osm === "on") {
        layerOn.osm = e.target.checked; lsSet("ofp.layers", JSON.stringify(layerOn));
        if (e.target.checked) osmOverlay.addTo(map); else map.removeLayer(osmOverlay);
        return;
      }
      const k = e.target.dataset.layer; if (!k) return;
      layerOn[k] = e.target.checked; lsSet("ofp.layers", JSON.stringify(layerOn));
      if (e.target.checked) layers[k].addTo(map); else map.removeLayer(layers[k]);
    });
    map.getContainer().classList.toggle("zlow", map.getZoom() < 9); map.getContainer().classList.toggle("zvlow", map.getZoom() < 8);

    const ll = (p) => [p.lat, p.lon];
    const ptLabel = (p) => esc(p.name || p.ident || "");

    // ---- library markers (ATO, personal, airports): click adds to the route
    let placing = null; // admin: ATO point name being placed
    function libMarker(group, item, color, kind) {
      const m = L.circleMarker(ll(item), { radius: kind === "apt" ? 6 : 5, color: "#fff", weight: 1.5, fillColor: color, fillOpacity: 0.95, bubblingMouseEvents: false });
      m.bindTooltip(esc(item.label || item.name), { permanent: true, direction: "right", offset: [6, 0], className: "lbl" });
      m.on("click", (e) => { L.DomEvent.stopPropagation(e); if (placing) return placeAt(e.latlng); addLib(item, kind); });
      group.addLayer(m);
      return m;
    }
    let atoMarkers = {};
    function renderLibrary() {
      layers.ato.clearLayers(); layers.personal.clearLayers(); layers.airports.clearLayers(); atoMarkers = {};
      lib.ato.forEach((w) => {
        let m;
        if (profile.role === "admin") {
          m = L.marker(ll(w), { draggable: true, icon: L.divIcon({ className: "", html: '<div class="vtx proc" style="width:14px;height:14px;margin:-7px 0 0 -7px"></div>', iconSize: [0, 0] }) });
          m.bindTooltip(esc(w.name), { permanent: true, direction: "right", offset: [8, 0], className: "lbl" });
          m.on("click", (e) => { L.DomEvent.stopPropagation(e); if (placing) return placeAt(e.latlng); addLib(w, "ato"); });
          m.on("dragend", () => { const p = m.getLatLng(); saveAto(w.name, p.lat, p.lng, w.id, w.notes).then(loadWaypoints); });
          layers.ato.addLayer(m);
        } else m = libMarker(layers.ato, w, "#6b2fb3", "ato");
        atoMarkers[w.name] = m;
      });
      lib.personal.forEach((w) => libMarker(layers.personal, w, "#1e9d55", "personal"));
      aptList.forEach((a) => {
        const c = aptCoord(a.icao); if (!c) return;
        libMarker(layers.airports, { name: a.icao, label: a.icao, ident: a.icao, lat: c.lat, lon: c.lon, apt: a }, "#0b3d91", "apt");
      });
    }
    function libItems() {
      const out = [];
      lib.ato.forEach((w) => out.push({ kind: "ato", item: w, name: w.name, sub: "ATO point" }));
      lib.personal.forEach((w) => out.push({ kind: "personal", item: w, name: w.name, sub: "personal" }));
      aptList.forEach((a) => { const c = aptCoord(a.icao); if (c) out.push({ kind: "apt", item: { name: a.icao, ident: a.icao, lat: c.lat, lon: c.lon }, name: a.icao, sub: a.name }); });
      return out;
    }

    /* ===================================================== route model ===================================================== */
    const procOf = (id) => procs.find((p) => p.id === id) || null;
    function depPt() { const c = aptCoord(state.dep); return c ? { id: "dep", name: state.dep, ident: state.dep, type: "AIRPORT", lat: c.lat, lon: c.lon } : null; }
    function destPt() { const c = aptCoord(state.dest); return c ? Object.assign({ id: "dest", name: state.dest, ident: state.dest, type: "AIRPORT", lat: c.lat, lon: c.lon }, state.destPt) : null; }
    // [dep, ...mid, dest] or null while an airport position is unknown
    function routePoints() { const a = depPt(), b = destPt(); return a && b ? [a, ...state.mid, b] : null; }
    function insertIdx() { const n = state.mid.length; return n && state.mid[n - 1].proc === "arr" ? n - 1 : n; }
    function startIdx() { return state.mid.length && state.mid[0].proc === "dep" ? 1 : 0; }
    function addPoint(p, at) {
      const pt = Object.assign({ id: newId(), name: "", ident: null, type: "USER WAYPOINT", lat: 0, lon: 0, lib: null, wid: null, proc: null, alt: null, msa: null, wind: null, rem: blankRem() }, p);
      if (!pt.name) pt.name = "WP" + ++state.seq;
      const i = at == null ? insertIdx() : Math.max(startIdx(), Math.min(at, insertIdx()));
      state.mid.splice(i, 0, pt);
      changed(true);
      return pt;
    }
    function addLib(item, kind) {
      if (kind === "apt") return addPoint({ name: item.name, ident: item.ident, type: "AIRPORT", lat: item.lat, lon: item.lon, lib: "apt" });
      addPoint({ name: item.name, ident: item.ident, lat: item.lat, lon: item.lon, lib: kind, wid: item.id });
    }
    function removePoint(id) {
      const i = state.mid.findIndex((p) => p.id === id); if (i < 0) return;
      const p = state.mid[i];
      if (p.proc === "dep") { state.depProc = null; state.depTr = null; }
      if (p.proc === "arr") { state.arrProc = null; state.arrTr = null; }
      if (p.proc) state.mid = state.mid.filter((q) => q.proc !== p.proc);   // a procedure is all or nothing
      else state.mid.splice(i, 1);
      changed(true);
    }
    // click on the map: snap to a library point within 12 px, else a coordinate point
    function mapClick(e) {
      if (placing) return placeAt(e.latlng);
      if (!routePoints()) return toast("Airport positions are not loaded, so the route cannot be drawn yet");
      const pt = map.latLngToContainerPoint(e.latlng);
      let best = null, bd = 12;
      libItems().forEach((c) => {
        const d = pt.distanceTo(map.latLngToContainerPoint([c.item.lat, c.item.lon]));
        if (d < bd) { bd = d; best = c; }
      });
      if (best) return addLib(best.item, best.kind);
      addPoint({ lat: e.latlng.lat, lon: e.latlng.lng });
    }
    map.on("click", mapClick);

    /* ===================================================== calculation ===================================================== */
    const flightDate = () => { const m = /^(\d{4})-(\d\d)-(\d\d)$/.exec(state.date || ""); return m ? new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], 12)) : new Date(); };
    const perfCache = new Map();
    function perfAt(alt, isa) {
      const dev = isNum(isa) ? isa : isNum(state.isaDev) ? state.isaDev : 0;
      const k = [alt, dev, state.pwr].join("|");
      if (!perfCache.has(k)) perfCache.set(k, Perf.cruise({ pa: alt, isaDev: dev, pwr: isNum(state.pwr) ? state.pwr : 75 }));
      return perfCache.get(k);
    }
    const effMsa = (pt) => (isNum(pt.msa) ? pt.msa : isNum(ctx.msaAuto[pt.id]) ? ctx.msaAuto[pt.id] : null);
    // ---- automatic values stored in the draft: state.auto.legs[pointId] = {gk, msa:{ft,lat,lon,kind,msa,obs}, w:{alt,hh,dir(TRUE),spd,tempC,src,at}, em:{k,line}}
    const geomKey = (a, b) => [a.lat, a.lon, b.lat, b.lon].map((v) => v.toFixed(4)).join(",");
    const hhmm = (v) => { const s = String(v || "").replace(/\D/g, ""); return s.length >= 3 ? s.padStart(4, "0").slice(0, 4) : ""; };
    const hhKey = () => (state.date || "") + "|" + (hhmm(state.toTime).slice(0, 2) || "12");
    const legRec = (b, a) => { const rec = state.auto.legs[b.id]; return rec && rec.gk === geomKey(a, b) ? rec : null; };
    function getRec(b, a) {
      const gk = geomKey(a, b);
      let rec = state.auto.legs[b.id];
      if (!rec || rec.gk !== gk) rec = state.auto.legs[b.id] = { gk };
      return rec;
    }
    // Auto winds are taken for the hour each leg is flown: ctx.legT[id] = ms at the leg midpoint (from the previous compute), key = UTC hour number.
    const legMs = (id) => (isNum(ctx.legT[id]) ? ctx.legT[id] : planMs());
    const legHh = (id) => String(Math.round(legMs(id) / 3600e3));
    const zHour = (hh) => String(new Date(+hh * 3600e3).getUTCHours()).padStart(2, "0") + "Z";
    const autoWindRec = (b, a, alt) => {
      const rec = legRec(b, a), hh = legHh(b.id); if (!rec) return null;
      const w = rec.w; if (w && w.alt === alt && w.hh === hh) return w;
      const o = rec.ws && rec.ws[alt + "|" + hh]; return o || null;
    };
    function magWind(w, a, b) { const v = Nav.variation(Nav.mid(a, b), flightDate()); return { dir: w.spd < 1 ? 0 : Math.round(Nav.norm360(w.dir - v)), spd: Math.round(w.spd) }; }
    function isaFor(b, a, alt) {
      if (state.isaAuto) { const w = autoWindRec(b, a, alt); if (w && isNum(w.tempC)) return Math.round(w.tempC - Perf.isaTemp(alt)); }
      return isNum(state.isaDev) ? state.isaDev : 0;
    }
    function applyAuto(route) {
      ctx.msaAuto = {}; ctx.msaHigh = {}; ctx.windAuto = {}; ctx.groundFt = {};
      if (!route) return;
      for (let i = 1; i < route.length; i++) {
        const rec = legRec(route[i], route[i - 1]);
        if (rec && rec.msa && isNum(rec.msa.msa)) { ctx.msaAuto[route[i].id] = rec.msa.msa; ctx.msaHigh[route[i].id] = { lat: rec.msa.lat, lon: rec.msa.lon, ft: rec.msa.ft }; }
      }
    }
    function windFor(pt, a, alt) {
      if (state.windMode === "auto") {
        const aw = autoWindRec(pt, a, alt);
        if (aw) {
          const m = magWind(aw, a, pt); ctx.windAuto[pt.id] = { dir: m.dir, spd: m.spd, src: aw.src, at: aw.at };
          return { dir: m.dir, spd: m.spd, src: `auto forecast: ${aw.src} for ${zHour(aw.hh)} at ${alt} ft at the leg midpoint: ${p3(aw.dir)}°T/${Math.round(aw.spd)} kt → ${p3(m.dir)}°/${m.spd} kt magnetic` };
        }
      }
      const own = state.windMode === "leg" ? pt.wind : null;
      if (own && isNum(+own.dir) && isNum(+own.spd) && own.dir !== "" && own.spd !== "") return { dir: +own.dir, spd: +own.spd, src: "entered for this leg" };
      const w = state.wind;
      if (isNum(w.dir) && isNum(w.spd)) return { dir: w.dir, spd: w.spd, src: state.windMode === "auto" ? "entered MAG W/V (automatic wind not available)" : "entered (one MAG W/V)" };
      return null;
    }
    function defaultAlt(mc, msa, isLast) {
      const ap = state.arrProc && procOf(state.arrProc);
      if (isLast) return ap && ap.alt ? ap.alt : Math.ceil((aptElev(state.dest) + 1000) / 100) * 100;
      const c = Nav.semicircularAlts(mc, Math.max(3500, msa || 0), 20000);
      return c.length ? c[0] : 3500;
    }
    function patternOf(pt, isLast, depP) {
      const r = pt.rem || blankRem();
      const p = { touchGo: r.touchGo | 0, taxiBack: r.taxiBack | 0, fullStop: !!r.fullStop, airwork: +r.airwork || 0 };
      const ap = state.arrProc && procOf(state.arrProc);
      if (isLast && ap && ap.extraMin) p.fullStop = true;                        // B02: +10 for a full-stop arrival (the procedure's extraMin)
      return p.touchGo || p.taxiBack || p.fullStop || p.airwork ? p : undefined;
    }
    let calc = { route: null, rows: [], out: null, header: {}, sig: "", message: "" };

    function buildRows(route) {
      const date = flightDate(), rows = [], depP = state.depProc ? procOf(state.depProc) : null, arrP = state.arrProc ? procOf(state.arrProc) : null;
      let prevAlt = aptElev(state.dep) + 1000;
      for (let i = 1; i < route.length; i++) {
        const a = route[i - 1], b = route[i], last = i === route.length - 1;
        const raw = Nav.dist(a, b), mc = Nav.magCourse(a, b, date);
        // B02 fixed time/NM applies only to the gate leg: GYR to the exit point (dep) or entry point to GYR (arr); transition legs are normal
        const proc = b.proc === "dep" && b.procRole !== "trans" ? depP : a.proc === "arr" && a.procRole !== "trans" ? arrP : null;
        const fixed = proc && proc.min != null && proc.nm != null ? { min: proc.min, nm: proc.nm } : null;
        const msa = effMsa(b);
        let alt = isNum(b.alt) ? b.alt : b.proc && isNum(b.pAlt) ? b.pAlt : b.proc === "dep" && b.procRole !== "trans" && depP && depP.alt ? depP.alt : defaultAlt(mc, msa, last);
        const isa = isaFor(b, a, alt), perf = perfAt(alt, isa), w = windFor(b, a, alt);
        const xm = last && depP && depP.extraMinDest && depP.extraMinDest[icaoOf(state.dest)];
        const dist = fixed ? fixed.nm : raw < 0.05 ? 0 : Math.max(1, Math.round(raw));
        const row = {
          id: b.id, pt: b, name: b.name, ident: b.ident && b.ident !== b.name ? b.ident : null, dist, rawDist: raw, mc, alt, altAuto: !isNum(b.alt), prevAlt, msa,
          isa, extraMin: xm || undefined, extraHow: xm ? depP.name + " into " + icaoOf(state.dest) : undefined, groundFt: ctx.groundFt[b.id],
          tas: perf.tas, ff: perf.ff, perfHow: perf.how, wdir: w ? w.dir : mc, wspd: w ? w.spd : 0, windSrc: w ? w.src : "no wind entered (calm)", hasWind: !!w,
          fixed: fixed || undefined, pattern: patternOf(b, last, depP), proc: proc || null, lat: b.lat, lon: b.lon,
        };
        rows.push(row);
        prevAlt = alt;
      }
      return rows;
    }
    function cruiseFfOf(rows) {
      if (isNum(state.cruiseFfOv)) return state.cruiseFfOv;
      let best = null;
      rows.forEach((r) => { if (!r.fixed && (!best || r.dist > best.dist)) best = r; });
      return best ? best.ff : perfAt(5500).ff;
    }
    const fmtDate = (d) => { const m = /^(\d{4})-(\d\d)-(\d\d)$/.exec(d || ""); return m ? `${+m[3]} ${["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"][+m[2] - 1]} ${m[1].slice(2)}` : ""; };

    function compute() {
      const route = routePoints();
      calc = { route, rows: [], out: null, header: {}, sig: "", message: "" };
      applyAuto(route);
      if (!route) calc.message = ctx.unavailable.airports ? "Airport positions are unavailable (FAA ADDS did not answer). Reload to retry." : "Loading airport positions…";
      else if (route.length < 3 && state.dep === state.dest) calc.message = "Click the map to add the first point.";
      else if (route.length < 2) calc.message = "Click the map to add the first point.";
      if (route && !calc.message) {
        const rows = buildRows(route), cruiseFf = cruiseFfOf(rows);
        const toTime = hhmm(state.toTime);
        const out = Nav.computeOfp({ rows, toTime: toTime || "0000", takeoffFuel: isNum(state.takeoffFuel) ? state.takeoffFuel : 0, reserveMin: state.night ? 45 : 30, cruiseFf });
        out.rows.forEach((o, i) => {
          const r = rows[i], how = o.how, a = route[i], b = route[i + 1];
          const m = Nav.mid(a, b), tc = Nav.brg(m, b), vr = Nav.variation(m, flightDate());
          how.mc = `True course ${Math.round(tc)}° at the leg midpoint − variation ${r1(Math.abs(vr))}°${vr >= 0 ? "E" : "W"} = MC ${p3(r.mc)}`;
          how.dist = r.fixed ? `ATO procedure distance ${r.fixed.nm} NM` : `Great circle ${r1(r.rawDist)} NM, whole NM → ${r.dist} NM`;
          how.alt = `${r.altAuto ? "Automatic" : "Entered"} altitude ${r.alt} ft. ${r.perfHow}`;
          how.windSrc = r.windSrc;
          if (!toTime) o.pto = null; else how.pto = `T/O ${toTime} + ${Nav.fmtEet(out.rows.slice(0, i + 1).reduce((s, x) => s + (x.eet || 0), 0))} total EET = ${o.pto}`;
          o.rawDist = r.rawDist; o.altAuto = r.altAuto; o.windSrc = r.windSrc; o.hasWind = r.hasWind; o.pt = r.pt; o.tas = r.tas; o.ffRow = r.ff;
        });
        calc.rows = out.rows; calc.out = out;
        { // time at each leg midpoint (T/O + EET before the leg + half its EET); used by the next compute for the per-leg wind hour
          const t0 = planMs(); let cum = 0; ctx.legT = {};
          out.rows.forEach((o, i) => { const e = isNum(o.eet) ? o.eet : rows[i].tas > 0 ? rows[i].rawDist / rows[i].tas * 60 : 0; ctx.legT[rows[i].id] = t0 + 60000 * (cum + e / 2); cum += e; });
        }
        calc.header = buildHeader(out, cruiseFf);
        calc.cruiseFf = cruiseFf;
        calc.sig = JSON.stringify([calc.header, out.rows.map((r) => [r.name, r.ident, r.alt, r.msa, r.mc, r.wca, r.gs, r.dist, r.eet, r.legFuel, r.plFuel, r.minFuel, r.pattern, !!r.fixed, r.error || 0]), out.totals]);
      }
      if (state.adoptSig && calc.sig) { state.finalSig = calc.sig; delete state.adoptSig; }
      calc.checks = basicChecks();
      render();
      hooks.afterCompute.forEach((f) => { try { f(calc, ctx); } catch (e) { console.error(e); } });
      saveDraftSoon();
    }
    function buildHeader(out, cruiseFf) {
      const rows = out.rows, alts = [...new Set(rows.filter((r) => !r.fixed).map((r) => r.alt))].sort((a, b) => a - b);
      const tasLines = alts.map((a) => { const r = rows.find((x) => !x.fixed && x.alt === a); return `${a}: ${r.tas} KT / ${r.ff} GPH`; });
      const lines = []; let cur = "";
      tasLines.forEach((t) => { if (cur && (cur + "   " + t).length > 54) { lines.push(cur); cur = t; } else cur = cur ? cur + "   " + t : t; });
      if (cur) lines.push(cur);
      const note = String(state.notes || "").trim();
      // B02 "Cruise MAG W/V": the magnetic wind at the altitude flown over the most distance (dir to 10 deg, speed to whole kt)
      const byAlt = {}; rows.forEach((r) => { if (!r.fixed) byAlt[r.alt] = (byAlt[r.alt] || 0) + r.dist; });
      const cruiseAlt = Object.keys(byAlt).sort((x, y) => byAlt[y] - byAlt[x])[0];
      const cr = cruiseAlt == null ? null : rows.filter((r) => !r.fixed && r.alt === +cruiseAlt && r.hasWind).sort((x, y) => y.dist - x.dist)[0];
      const magWindStr = cr ? `${String(Math.round(cr.wdir / 10) * 10 % 360 || 360).padStart(3, "0")}/${String(Math.round(cr.wspd)).padStart(2, "0")}` : "";
      const onBlock = hhmm(state.offBlock) && isNum(state.blockMin) ? Nav.addHHMM(hhmm(state.offBlock), state.blockMin) : "";
      return {
        from: icaoOf(state.dep) || state.dep, to: icaoOf(state.dest) || state.dest, offBlock: hhmm(state.offBlock), onBlock, toTime: hhmm(state.toTime),
        callsign: state.callsign, reg: state.reg, cruiseFf, magWind: magWindStr, magWindAlt: cr ? cr.alt : null,
        alt: alts.length > 2 ? alts[0] + "-" + alts[alts.length - 1] : alts.join("/"), date: fmtDate(state.date), mission: state.mission, crew: state.crew.slice(),
        takeoffFuel: isNum(state.takeoffFuel) ? state.takeoffFuel : "", notes: [...lines, ...(note ? [note] : []), ...ctx.notes],
      };
    }
    // Checks: Safety.checks (legs, airspace, glide, airports, fuel, data sources) plus a few page-only notes.
    // Safety uses 0-based leg indexes; the UI uses 1-based. Level 'warn' | 'info' (| 'err' for page-only problems).
    function basicChecks() {
      const ck = [], rows = calc.rows, t = calc.out && calc.out.totals;
      if (!calc.route || !calc.out) return ck;
      const add = (level, text, row, code) => ck.push({ level, text, code, leg: row != null ? row + 1 : null, id: row != null && rows[row] ? rows[row].id : null });
      if (window.Safety) {
        const rr = rows.map((r) => Object.assign({}, r, { ident: r.pt && r.pt.type === "AIRPORT" ? r.pt.ident : null, groundFt: ctx.groundFt[r.id] }));
        const needWind = state.windMode === "auto" || state.isaAuto, src = Object.assign({}, ctx.sources);
        if (!needWind) delete src.winds;
        window.Safety.checks({ log: calc.out, rows: rr, solo: state.solo, night: state.night, dep: state.dep, dest: state.dest, airports: LAT, takeoffFuel: state.takeoffFuel,
          conflicts: rows.map((r) => ctx.conflicts[r.id] || []), glide: rows.map((r) => ctx.glide[r.id] || null), sources: src })
          .forEach((c) => { const row = c.leg == null ? null : c.leg; ck.push({ level: c.level, code: c.code, text: c.text, leg: row == null ? null : row + 1, id: row == null || !rows[row] ? null : rows[row].id }); });
      }
      if (rows.length > OP.MAX_LEGS && !ck.some((c) => c.code === "legs18")) add("warn", `${rows.length} legs: the form holds ${OP.MAX_LEGS}; later legs will not print`, null, "legs18");
      if (!rows.some((r) => r.hasWind || r.fixed) && state.windMode !== "auto") add("info", "No wind entered: the plan uses calm wind.");
      if (!(isNum(state.takeoffFuel) && state.takeoffFuel > 0)) add("warn", "Enter the takeoff fuel.");
      if (t && t.incomplete && !ck.some((c) => c.code === "windErr")) add("warn", "Totals are incomplete because a leg has a wind error.");
      if (!hhmm(state.toTime)) add("info", "Enter the T/O time to get the ETOs (PTO).");
      return ck;
    }

    /* ===================================================== render: panel ===================================================== */
    const chip = (val, how, cls) => `<button type="button" class="chip${cls ? " " + cls : ""}" data-how="${esc(how || "")}"${how ? "" : " disabled"}>${val === "" || val == null ? "–" : esc(val)}</button>`;
    const fmtMin = (m) => (isNum(m) ? Nav.fmtEet(m) : "");
    const f1 = (n) => (isNum(n) ? n.toFixed(1) : "");
    function remText(p) {
      const r = p.rem || {}, out = [];
      if (r.touchGo) out.push(`T&G×${r.touchGo}`);
      if (r.taxiBack) out.push(`T/B×${r.taxiBack}`);
      if (r.airwork) out.push(`${r.airwork}′ air`);
      if (r.fullStop) out.push("full stop");
      return out.join(", ") || "remark";
    }
    function renderLegs() {
      const host = byId("legs");
      if (calc.message) { host.innerHTML = `<p class="note">${esc(calc.message)}</p>${ctx.unavailable.airports ? '<button type="button" class="sm" id="retryApt">Retry</button>' : ""}`; return; }
      const rows = calc.rows, o = calc.out, leg = state.windMode === "leg";
      let h = `<table class="legs${leg ? "" : " nowc"}"><thead><tr><th>Alt / MSA</th><th>WPT</th><th>MC / WCA</th><th>GS / Dist</th><th>EET / PTO</th><th>Leg / Pl / Min</th>${leg ? '<th class="wcol">Wind</th>' : ""}</tr></thead><tbody>`;
      h += `<tr class="from"><td colspan="${leg ? 7 : 6}">From ${esc(calc.route[0].name)}${state.depProc ? " · " + esc((procOf(state.depProc) || {}).name || "") : ""} · cruise FF ${calc.cruiseFf} GPH · reserve ${state.night ? 45 : 30} min = ${f1(o.reserveGal)} USG</td></tr>`;
      rows.forEach((r, i) => {
        const pt = r.pt, ap = ctx.msaAuto[r.id], msaAuto = !isNum(pt.msa) && isNum(ap);
        const fixed = !!r.fixed, last = r.id === "dest";
        const altIn = `<input type="number" step="100" data-f="alt" data-id="${esc(r.id)}" value="${r.alt}" class="${r.altAuto ? "auto" : ""}" aria-label="Altitude leg ${i + 1}" title="${r.altAuto ? "Automatic altitude (type to override, clear to go back)" : "Entered altitude"}">`;
        const msaIn = `<input type="number" step="100" data-f="msa" data-id="${esc(r.id)}" value="${isNum(pt.msa) ? pt.msa : isNum(ap) ? ap : ""}" placeholder="MSA" class="${msaAuto ? "auto" : ""}" aria-label="MSA leg ${i + 1}">`;
        const hi = ctx.msaHigh[r.id];
        const msaTag = msaAuto ? `<span class="tag auto">auto, verify on chart${hi ? ' <button type="button" class="x" data-f="hi" data-id="' + esc(r.id) + '" title="Show the highest point">⌖</button>' : ""}</span>` : "";
        const altBtn = hooks.altOptions ? `<button type="button" class="x" data-f="altpick" data-id="${esc(r.id)}" title="Altitude options">▾</button>` : "";
        const err = !!r.error;
        h += `<tr data-row="${i}" class="${err ? "bad" : ""}"><td><div class="cell">${altIn}${altBtn}${msaIn}${msaTag}</div></td>`;
        h += `<td class="wp"><div class="wn"><span class="n">${i + 1}</span>${esc(r.name)}${!last && !pt.proc ? `<button type="button" class="x" data-f="del" data-id="${esc(r.id)}" title="Remove point">✕</button>` : ""}</div>`;
        if (r.ident) h += `<small class="fine">${esc(r.ident)}</small> `;
        if (r.proc) h += `<small class="fine">${esc(r.proc.name)}</small> `;
        h += `<button type="button" class="sm" data-f="rem" data-id="${esc(r.id)}">${esc(remText(pt))}</button></td>`;
        h += `<td><div class="cell">${chip(fixed ? "Dep" : p3(r.mc), r.how.mc || "")}${fixed ? "" : chip(isNum(r.wca) ? (r.wca > 0 ? "+" : "") + r.wca : err ? "wind" : "", r.how.wca || r.how.gs, err ? "e" : "")}</div></td>`;
        h += `<td><div class="cell">${chip(fixed ? "" : isNum(r.gs) ? r.gs : err ? "wind" : "", r.how.gs, err ? "e" : "")}${chip(r.dist, r.how.dist)}</div></td>`;
        h += `<td><div class="cell">${chip(isNum(r.eet) ? fmtMin(r.eet) : "", r.how.eet)}${chip(r.pto || "", r.how.pto || (r.pto ? "" : "Enter the T/O time"))}</div></td>`;
        h += `<td><div class="cell">${chip(f1(r.legFuel), r.how.legFuel)}${chip(f1(r.plFuel), r.how.plFuel)}${chip(f1(r.minFuel), r.how.minFuel)}</div></td>`;
        if (leg) h += `<td class="wcol"><input class="wnd" data-f="wind" data-id="${esc(r.id)}" value="${pt.wind && pt.wind.dir !== "" && pt.wind.dir != null ? esc(String(Math.round(pt.wind.dir)).padStart(3, "0") + "/" + pt.wind.spd) : ""}" placeholder="270/10" aria-label="MAG wind leg ${i + 1}"></td>`;
        h += `</tr>`;
      });
      const t = o.totals, lastRow = rows[rows.length - 1];
      h += `<tr class="tot"><td colspan="3">Totals</td><td>${chip(fmtMin(t.eet), "Sum of the leg EETs")}</td><td>${chip(f1(t.trip) + " USG", "Sum of the leg fuels")}</td><td colspan="${leg ? 2 : 1}">${lastRow && isNum(lastRow.plFuel) ? "Pl " + f1(lastRow.plFuel) : ""}</td></tr>`;
      h += "</tbody></table>";
      host.innerHTML = h;
      if (calc.cruiseFf) {
        const notes = [...new Set(rows.filter((r) => !r.fixed).map((r) => r.alt))].sort((a, b) => a - b).map((a) => { const r = rows.find((x) => !x.fixed && x.alt === a); return `${a} ft (ISA${r.isa >= 0 ? "+" : ""}${r.isa}): ${r.tas} KTAS ${r.ff} GPH`; }).join(" · ");
        host.insertAdjacentHTML("beforeend", `<p class="fine">Cruise ${state.pwr}%: ${esc(notes)}</p>`);
      }
    }
    function renderChecks() {
      const host = byId("checks");
      const all = (calc.checks || []).concat(ctx.checks || [], ctx.wxChecks || []);
      if (!calc.route) { host.innerHTML = ""; return; }
      const sev = { err: 0, warn: 1, info: 2 };
      all.sort((a, b) => (a.leg == null ? 999 : a.leg) - (b.leg == null ? 999 : b.leg) || sev[a.level] - sev[b.level]);
      const bad = all.filter((c) => c.level !== "info").length;
      let h = bad ? "" : '<div class="ok">No warnings.</div>', cur = -1;
      all.forEach((c, i) => {
        if (c.leg !== cur) {
          cur = c.leg;
          const r = c.leg ? calc.rows[c.leg - 1] : null;
          h += `<div class="grp">${c.leg ? "Leg " + c.leg + (r ? " to " + esc(r.name) : "") : "Whole plan"}</div>`;
        }
        h += `<button type="button" class="ck ${esc(c.level)}" data-ck="${i}"><span>${esc(c.text)}</span></button>`;
      });
      host.innerHTML = h;
      host._items = all;
    }
    byId("checks").addEventListener("click", (e) => {
      const b = e.target.closest("[data-ck]"); if (!b) return;
      const c = byId("checks")._items[+b.dataset.ck];
      if (c && c.leg) zoomLeg(c.leg - 1);
    });
    function zoomLeg(i) {
      const route = calc.route; if (!route || !route[i + 1]) return;
      map.fitBounds(L.latLngBounds([ll(route[i]), ll(route[i + 1])]).pad(0.5), { maxZoom: 12 });
      $$("#legs tr[data-row]").forEach((tr) => tr.classList.toggle("cur", +tr.dataset.row === i));
      const tr = document.querySelector(`#legs tr[data-row="${i}"]`); if (tr) tr.scrollIntoView({ block: "nearest" });
      if (window.matchMedia("(max-width:900px)").matches) setSheet("half");
    }

    function renderSummary() {
      const t = calc.out && calc.out.totals;
      byId("sum").textContent = t ? `${state.dep} → ${state.dest} · ${calc.rows.length} legs · ${fmtMin(t.eet)} · ${f1(t.trip)} USG` : `${state.dep} → ${state.dest}`;
    }
    const notPlaced = (proc, tr) => ATO.expand(proc, tr).filter((q) => { const w = lib.byName[q.name] || lib.byName[String(q.name).toUpperCase()]; return !w; }).map((q) => q.name);
    function renderProcSelects() {
      const fill = (sel, trSel, apt, kind, cur, curTr) => {
        const list = ATO.forAirport(icaoOf(apt) || apt, kind, procs);
        sel.disabled = !list.length;
        sel.innerHTML = `<option value="">${list.length ? "None" : "No ATO procedures"}</option>` + list.map((p) => {
          const placed = ATO.usable(p, lib.byName), dualBlock = p.dualOnly && state.solo, soloBlock = p.soloOnly && !state.solo;
          const why = !placed ? " – not placed yet" : dualBlock ? " – dual only" : soloBlock ? " – solo only" : p.dualOnly ? " (dual only)" : p.soloOnly ? " (solo only)" : "";
          const tm = p.min != null ? ` ${Nav.fmtEet(p.min)}/${p.nm} NM` : "";
          return `<option value="${esc(p.id)}"${placed && !dualBlock && !soloBlock ? "" : " disabled"}${p.id === cur ? " selected" : ""}>${esc(p.name + tm + why)}</option>`;
        }).join("");
        if (cur && !sel.querySelector("option[selected]")) sel.value = "";
        const proc = cur && list.find((p) => p.id === cur), trs = proc ? proc.transitions || [] : [];
        trSel.hidden = !trs.length;
        trSel.parentElement.hidden = !trs.length;
        trSel.innerHTML = '<option value="">Direct (no transition)</option>' + trs.map((t) => {
          const miss = notPlaced(proc, t.id), dualBlock = t.dualOnly && state.solo, soloBlock = t.soloOnly && !state.solo;
          const why = miss.length ? " – not placed: " + miss.join(", ") : dualBlock ? " – dual only" : soloBlock ? " – solo only" : t.dualOnly ? " (dual only)" : t.soloOnly ? " (solo only)" : "";
          return `<option value="${esc(t.id)}"${miss.length || dualBlock || soloBlock ? " disabled" : ""}${t.id === curTr ? " selected" : ""}>${esc(t.name + why)}</option>`;
        }).join("");
        if (curTr && !trSel.querySelector("option[selected]")) trSel.value = "";
      };
      fill(byId("depProc"), byId("depTr"), state.dep, "dep", state.depProc, state.depTr);
      fill(byId("arrProc"), byId("arrTr"), state.dest, "arr", state.arrProc, state.arrTr);
    }
    // Replace the departure/arrival procedure: every plate landmark of the chosen transition becomes a checkpoint
    function setProc(kind, id, trId) {
      const key = kind === "dep" ? "depProc" : "arrProc", trKey = kind === "dep" ? "depTr" : "arrTr";
      state.mid = state.mid.filter((p) => p.proc !== kind);
      state[key] = null; state[trKey] = null;
      const proc = id && procOf(id);
      if (proc) {
        const miss = notPlaced(proc, trId);
        if (miss.length) toast(`${proc.name}: not placed yet: ${miss.join(", ")}`);
        else {
          state[key] = proc.id; state[trKey] = trId || null;
          const pts = ATO.expand(proc, trId).map((q) => {
            const w = lib.byName[q.name] || lib.byName[String(q.name).toUpperCase()];
            return { id: newId(), name: q.name, ident: null, type: "USER WAYPOINT", lat: w.lat, lon: w.lon, lib: "ato", wid: w.id, proc: kind, procRole: q.role, pAlt: isNum(q.alt) ? q.alt : null, alt: null, msa: null, wind: null, rem: blankRem() };
          });
          if (kind === "dep") state.mid.unshift(...pts); else state.mid.push(...pts);
        }
      }
      changed(true);
    }
    byId("depProc").addEventListener("change", (e) => setProc("dep", e.target.value));
    byId("arrProc").addEventListener("change", (e) => setProc("arr", e.target.value));
    byId("depTr").addEventListener("change", (e) => state.depProc && setProc("dep", state.depProc, e.target.value));
    byId("arrTr").addEventListener("change", (e) => state.arrProc && setProc("arr", state.arrProc, e.target.value));

    function renderRouteNote() {
      const msgs = [];
      const dn = aptOf(state.dep), tn = aptOf(state.dest);
      if (dn) msgs.push(`${dn.icao}: ${dn.name}`); if (tn && tn !== dn) msgs.push(`${tn.icao}: ${tn.name}`);
      let h = esc(msgs.join(" · "));
      if (lib.error) h += `<br><span class="warnc">${esc(lib.error)}</span>`;
      if (ctx.unavailable.airports) h += '<br><span class="err">Airport positions unavailable (FAA ADDS). Reload to retry.</span>';
      byId("routeNote").innerHTML = h;
    }
    function renderWindNote() {
      const m = state.windMode, el = byId("windnote"), ws = ctx.sources.winds;
      $$(".wcol1").forEach((l) => (l.style.display = m === "leg" ? "none" : ""));
      el.textContent = m === "auto" ? (ws && ws.ok === false ? "Automatic winds unavailable: the plan uses the MAG W/V above (enter a wind)." : "Automatic winds: Open-Meteo forecast at each leg's midpoint and altitude, true wind converted to magnetic. The MAG W/V above is the fallback.") : m === "leg" ? "Type a magnetic wind (270/10) in each leg's Wind cell. Legs without one use calm wind." : "One magnetic wind (from, kt) is used for every leg.";
      const hw = calc.header && calc.header.magWind;
      if (hw) el.textContent += ` Cruise MAG W/V on the OFP: ${hw} at ${calc.header.magWindAlt} ft.`;
      if (state.isaAuto) el.textContent += " ISA deviation comes from the forecast temperature at each leg's altitude (manual value as fallback).";
    }
    function renderFinal() {
      const fin = state.id != null, cur = fin && state.finalSig && calc.sig === state.finalSig;
      const t = tokens(), free = state.id != null && state.finalKey === curKey();
      const n = byId("finNote"), fb = byId("finBtn");
      fb.textContent = free ? "Finalise again (free)" : `Finalise (${PRICE} tokens)`;
      fb.disabled = !calc.out || pendingFin;
      n.innerHTML = !calc.out ? "Add at least one point to finalise."
        : cur ? `<span class="okc">Finalised (OFP #${esc(state.id)}).</span> Print, export and send are available.`
        : fin ? `<span class="warnc">OFP #${esc(state.id)} was changed since it was finalised.</span> ${free ? "Finalise again to update it (no tokens)." : "The date or an airport changed, so finalising creates a new OFP (" + PRICE + " tokens)."}`
        : `Finalising stores the OFP and uses ${PRICE} tokens once per flight (you have ${t}). Changing winds, altitudes or fuel later and finalising again is free for the same date, from and to.`;
      $$("#outActs [data-out]").forEach((b) => (b.disabled = !cur));
    }
    const curKey = () => [state.date, icaoOf(state.dep) || state.dep, icaoOf(state.dest) || state.dest].join("|");

    function render() {
      syncChrome(); renderLegs(); renderChecks(); renderSummary(); renderFinal(); renderRouteNote(); renderWindNote(); drawRoute();
    }

    /* ===================================================== map: route drawing ===================================================== */
    let dragging = false;
    function legLabel(r) {
      if (!r) return "";
      const bits = [p3(r.mc), r.dist + " NM"];
      if (isNum(r.eet)) bits.push(fmtMin(r.eet)); else if (r.error) bits.push("wind!");
      return bits.join(" · ");
    }
    function drawLegs() {
      layers.legs.clearLayers();
      const route = calc.route; if (!route) return;
      for (let i = 1; i < route.length; i++) {
        const a = route[i - 1], b = route[i], r = calc.rows[i - 1];
        const bad = r && r.error;
        L.polyline([ll(a), ll(b)], { color: bad ? "#d62d20" : "#c2188a", weight: 4, opacity: 0.9, dashArray: r && r.fixed ? "8 6" : null, interactive: false }).addTo(layers.legs);
        const m = Nav.mid(a, b);
        if (r) L.marker([m.lat, m.lon], { icon: L.divIcon({ className: "legLbl" + (bad ? " e" : ""), html: esc(legLabel(r)), iconSize: null }), interactive: false, keyboard: false }).addTo(layers.legs);
        const h = L.marker([m.lat, m.lon], { draggable: true, icon: L.divIcon({ className: "", html: '<div class="midh"></div>', iconSize: [0, 0] }), title: "Drag to insert a point" });
        const at = i - 1;
        h.on("dragend", () => { const p = h.getLatLng(); addPoint({ lat: p.lat, lon: p.lng }, at); });
        h.on("click", (e) => L.DomEvent.stopPropagation(e));
        h.addTo(layers.legs);
      }
    }
    function drawVerts() {
      layers.verts.clearLayers();
      const route = calc.route; if (!route) return;
      route.forEach((p, i) => {
        const isApt = p.type === "AIRPORT", mid = i > 0 && i < route.length - 1, movable = mid && !p.proc;
        const html = `<div class="vtx${isApt ? " apt" : ""}${p.proc ? " proc" : ""}">${i === 0 ? "D" : i === route.length - 1 ? "A" : i}</div>`;
        const m = L.marker(ll(p), { draggable: movable, icon: L.divIcon({ className: "", html, iconSize: [0, 0] }), zIndexOffset: 500, title: p.name });
        m.bindTooltip(esc(p.name), { direction: "top", offset: [0, -12] });
        m.on("click", (e) => { L.DomEvent.stopPropagation(e); if (mid) openPointPopup(m, p); else if (i > 0) zoomLeg(i - 1); });
        m.on("contextmenu", (e) => { L.DomEvent.stop(e); if (mid) openPointPopup(m, p); });
        if (movable) {
          m.on("dragstart", () => { dragging = true; });
          m.on("drag", () => { const q = m.getLatLng(); p.lat = q.lat; p.lon = q.lng; compute(true); });
          m.on("dragend", () => {
            dragging = false;
            if (p.lib) { p.lib = null; p.wid = null; p.name = "WP" + ++state.seq; p.ident = null; p.type = "USER WAYPOINT"; }
            changed(true);
          });
        }
        m.addTo(layers.verts);
      });
    }
    function drawRoute() { drawLegs(); if (!dragging) drawVerts(); }
    function openPointPopup(marker, p) {
      const el = document.createElement("div"); el.className = "popbtns";
      el.innerHTML = `<b>${esc(p.name)}</b><small>${p.lat.toFixed(4)}, ${p.lon.toFixed(4)}</small>`;
      const btn = (label, fn) => { const b = document.createElement("button"); b.type = "button"; b.textContent = label; b.addEventListener("click", () => { map.closePopup(); fn(); }); el.appendChild(b); };
      btn("Rename", () => renamePoint(p));
      if (p.lib !== "personal" && p.type !== "AIRPORT") btn("Save as personal waypoint", () => savePersonal(p));
      btn("Remove from route", () => removePoint(p.id));
      L.popup({ closeButton: true, offset: [0, -10] }).setLatLng(marker.getLatLng()).setContent(el).openOn(map);
    }
    async function renamePoint(p) {
      const r = await dialog(`<h3>Rename point</h3><label>Name<input name="n" maxlength="40" value="${esc(p.name)}"></label><div class="btns"><button type="button" data-v="no">Cancel</button><button type="button" class="pri" data-v="ok">Rename</button></div>`);
      const n = String(r.f.n || "").trim();
      if (r.v === "ok" && n) { p.name = n.slice(0, 40); if (p.lib === "personal" || p.lib === "ato") { p.lib = null; p.wid = null; } changed(true); }
    }
    async function savePersonal(p) {
      const r = await dialog(`<h3>Save as personal waypoint</h3><label>Name (max 40, ForeFlight shows the first 6 letters)<input name="n" maxlength="40" value="${esc(p.name)}"></label><div class="btns"><button type="button" data-v="no">Cancel</button><button type="button" class="pri" data-v="ok">Save</button></div>`);
      const n = String(r.f.n || "").trim();
      if (r.v !== "ok" || !n) return;
      try {
        const id = await Auth.rpc("upsert_waypoint", { p_id: null, p_name: n, p_ident: null, p_lat: p.lat, p_lon: p.lon, p_notes: null });
        p.name = n; p.lib = "personal"; p.wid = id;
        toast("Waypoint saved"); await loadWaypoints(); changed(true);
      } catch (e) { toast("Could not save the waypoint: " + dbErr(e)); }
    }
    const dbErr = (e) => {
      const m = String((e && e.message) || e);
      return /function .* does not exist|schema cache|PGRST20\d|404/i.test(m + (e && e.code)) ? "the OFP database setup has not been applied yet (run db/schema.sql)" : m;
    };
    // live overlay while a point is being placed: line from the last point to the pointer
    const rubber = L.polyline([], { color: "#c2188a", weight: 2, dashArray: "4 6", interactive: false, opacity: 0.8 });
    const fine = window.matchMedia("(pointer:fine)").matches;
    if (fine) {
      map.on("mousemove", (e) => {
        const route = calc.route;
        if (!route || placing) { layers.rubber.clearLayers(); return; }
        const from = route[insertIdx()] || route[0];
        const to = { lat: e.latlng.lat, lon: e.latlng.lng };
        const mc = Nav.magCourse(from, to, flightDate()), d = Nav.dist(from, to);
        const alt = (calc.rows[calc.rows.length - 2] || {}).alt || 4500, tas = perfAt(alt).tas, w = state.wind;
        const t = Nav.windTriangle({ mc, tas, wdir: isNum(w.dir) ? w.dir : mc, wspd: isNum(w.spd) ? w.spd : 0 });
        layers.rubber.clearLayers();
        rubber.setLatLngs([ll(from), [to.lat, to.lon]]).addTo(layers.rubber);
        L.marker([to.lat, to.lon], { icon: L.divIcon({ className: "legLbl", html: `${p3(mc)} · ${r1(d)} NM${t.gs ? " · " + Nav.fmtEet(Nav.eet(d, t.gs)) : ""}`, iconSize: null }), interactive: false }).addTo(layers.rubber);
      });
      map.on("mouseout", () => layers.rubber.clearLayers());
      map.on("click", () => layers.rubber.clearLayers());
    }

    /* ===================================================== form fields ===================================================== */
    function getPath(o, k) { return k.split(".").reduce((a, p) => (a == null ? a : a[p]), o); }
    function setPath(o, k, v) { const ks = k.split("."), last = ks.pop(); const t = ks.reduce((a, p) => a[p], o); t[last] = v; }
    function syncFields() {
      $$("[data-k]").forEach((el) => {
        let v = getPath(state, el.dataset.k);
        if (el.dataset.t === "bool") v = el.dataset.k === "solo" ? (v ? "1" : "0") : v ? "1" : "0";
        if (document.activeElement !== el) el.value = v == null ? "" : v;
      });
      if (document.activeElement !== byId("hDep")) byId("hDep").value = state.dep;
      if (document.activeElement !== byId("hDest")) byId("hDest").value = state.dest;
    }
    function bindFields() {
      byId("fleet").innerHTML = Object.keys(window.FLEET || {}).map((r) => `<option value="${esc(r)}">`).join("");
      byId("aptlist").innerHTML = aptList.map((a) => `<option value="${esc(a.icao)}">${esc(a.name)}</option>`).join("");
      $$("[data-k]").forEach((el) => {
        const on = () => {
          const k = el.dataset.k; let v = el.value;
          if (el.dataset.t === "bool") v = v === "1";
          else if (el.dataset.t === "num") v = num(v);
          else if (k === "blockMin") v = num(v);
          else if (k === "reg") v = v.toUpperCase().trim();
          else if (k === "offBlock" || k === "toTime") v = v.replace(/\D/g, "").slice(0, 4);
          setPath(state, k, v);
          if (k === "solo" || k === "night" || k === "windMode") { renderProcSelects(); }
          changed(false);
        };
        el.addEventListener(el.tagName === "SELECT" ? "change" : "input", on);
      });
      const apt = (id, key) => byId(id).addEventListener("change", (e) => {
        const a = aptOf(e.target.value);
        if (!a) { toast("Pick an airport from the LAT list"); e.target.value = state[key]; return; }
        if (state[key] === a.icao) return;
        state[key] = a.icao;
        if (key === "dep") { state.mid = state.mid.filter((p) => p.proc !== "dep"); state.depProc = null; state.depTr = null; }
        else { state.mid = state.mid.filter((p) => p.proc !== "arr"); state.arrProc = null; state.arrTr = null; state.destPt.alt = null; }
        changed(true);
        const c = aptCoord(a.icao); if (c && !state.mid.length) map.setView([c.lat, c.lon], Math.max(map.getZoom(), 10));
      });
      apt("hDep", "dep"); apt("hDest", "dest");
    }

    // leg table edits
    function ptById(id) { return id === "dest" ? state.destPt : state.mid.find((p) => p.id === id); }
    byId("legs").addEventListener("change", (e) => {
      const el = e.target, f = el.dataset.f; if (!f) return;
      const pt = ptById(el.dataset.id); if (!pt) return;
      if (f === "alt") pt.alt = el.value === "" ? null : Math.max(0, Math.round(+el.value));
      else if (f === "msa") pt.msa = el.value === "" ? null : Math.max(0, Math.round(+el.value));
      else if (f === "wind") {
        const m = /^\s*(\d{1,3})\s*[\/ ]\s*(\d{1,3})\s*$/.exec(el.value);
        pt.wind = m ? { dir: +m[1] % 360, spd: +m[2] } : null;
        if (!m && el.value.trim()) toast("Wind as direction/speed, e.g. 270/10");
      } else return;
      changed(false);
    });
    byId("legs").addEventListener("click", async (e) => {
      const b = e.target.closest("[data-how]");
      if (b) return showHow(b.dataset.how, b);
      if (e.target.id === "retryApt") return location.reload();
      const x = e.target.closest("[data-f]"); if (!x) return;
      const id = x.dataset.id, f = x.dataset.f;
      if (f === "del") return removePoint(id);
      if (f === "hi") { const h = ctx.msaHigh[id]; if (h) { map.setView([h.lat, h.lon], Math.max(map.getZoom(), 11)); L.popup().setLatLng([h.lat, h.lon]).setContent(`Highest point near this leg: ${Math.round(h.ft)} ft (verify on chart)`).openOn(map); } return; }
      if (f === "altpick" && hooks.altOptions) return hooks.altOptions(id, x, calc);
      if (f === "rem") return editRemark(id);
    });
    async function editRemark(id) {
      const pt = ptById(id); if (!pt) return;
      const r = Object.assign(blankRem(), pt.rem);
      const res = await dialog(`<h3>Remarks for this arrival</h3>
        <p class="note">Adds time at cruise fuel flow (B02 p80-81): +10 min first arrival, +5 per further pattern, +10 per extra full-stop taxi-back, plus airwork minutes.</p>
        <label>Touch-and-goes<input name="tg" type="number" min="0" max="9" value="${r.touchGo}"></label>
        <label>Full-stop taxi-backs<input name="tb" type="number" min="0" max="9" value="${r.taxiBack}"></label>
        <label>Airwork (min)<input name="aw" type="number" min="0" max="120" value="${r.airwork}"></label>
        <label style="flex-direction:row;gap:6px;align-items:center"><input name="fs" type="checkbox"${r.fullStop ? " checked" : ""}> Full stop</label>
        <div class="btns"><button type="button" data-v="no">Cancel</button><button type="button" data-v="clear">Clear</button><button type="button" class="pri" data-v="ok">Apply</button></div>`);
      if (res.v === "clear") pt.rem = blankRem();
      else if (res.v === "ok") pt.rem = { touchGo: Math.max(0, +res.f.tg | 0), taxiBack: Math.max(0, +res.f.tb | 0), airwork: Math.max(0, +res.f.aw || 0), fullStop: !!res.f.fs };
      else return;
      changed(false);
    }

    /* ===================================================== draft save, change handling ===================================================== */
    let saveTimer = null;
    function saveDraftSoon() { clearTimeout(saveTimer); saveTimer = setTimeout(() => lsSet(DRAFT_KEY, JSON.stringify(state)), 250); }
    let compTimer = null;
    // structural = route/airports changed: also refresh the selects
    function changed(structural) {
      if (structural) { renderProcSelects(); syncFields(); }
      if (dragging) return compute();
      clearTimeout(compTimer); compTimer = setTimeout(compute, 0);
      hooks.onRoute.forEach((f) => { try { f(structural, state, calc); } catch (e) { console.error(e); } });
    }

    /* ===================================================== search ===================================================== */
    const q = byId("q"), qres = byId("qres");
    function runSearch() {
      const s = q.value.trim().toLowerCase();
      if (!s) { qres.innerHTML = ""; return; }
      const hits = libItems().filter((c) => c.name.toLowerCase().includes(s) || String(c.sub).toLowerCase().includes(s) || String(c.item.ident || "").toLowerCase().includes(s))
        .sort((a, b) => (a.name.toLowerCase().startsWith(s) ? 0 : 1) - (b.name.toLowerCase().startsWith(s) ? 0 : 1)).slice(0, 8);
      qres.innerHTML = hits.length ? hits.map((c, i) => `<li><button type="button" data-i="${i}">${esc(c.name)}<small>${esc(c.sub)}</small></button></li>`).join("") : '<li><button type="button" disabled>No match</button></li>';
      qres._hits = hits;
    }
    function pick(c) {
      qres.innerHTML = ""; q.value = "";
      map.setView([c.item.lat, c.item.lon], Math.max(map.getZoom(), 11));
      if (routePoints()) addLib(c.item, c.kind);
    }
    q.addEventListener("input", runSearch);
    q.addEventListener("keydown", (e) => { if (e.key === "Enter" && qres._hits && qres._hits[0]) { e.preventDefault(); pick(qres._hits[0]); } if (e.key === "Escape") { qres.innerHTML = ""; } });
    qres.addEventListener("click", (e) => { const b = e.target.closest("[data-i]"); if (b && qres._hits) pick(qres._hits[+b.dataset.i]); });
    document.addEventListener("click", (e) => { if (!e.target.closest("#msearch")) qres.innerHTML = ""; });

    /* ===================================================== route actions: clear, new, reverse, duplicate ===================================================== */
    byId("clearRoute").addEventListener("click", () => { state.mid = []; state.depProc = null; state.arrProc = null; state.depTr = null; state.arrTr = null; changed(true); });
    function reversedState(s) {
      const n = normState(JSON.parse(JSON.stringify(s)));
      const oldDepP = n.depProc && procOf(n.depProc), oldArrP = n.arrProc && procOf(n.arrProc);
      const dep = n.dest, dest = n.dep;
      n.dep = dep; n.dest = dest;
      n.mid = n.mid.slice().reverse();
      // a procedure point flips to the matching procedure at the other airport when ATO has one, else it becomes a plain waypoint
      const oldDepTr = n.depTr, oldArrTr = n.arrTr;
      const flip = (old, kind, apt) => old && ATO.forAirport(icaoOf(apt) || apt, kind, procs).find((p) => (p.gate || p.point) === (old.gate || old.point) && ATO.usable(p, lib.byName));
      const newDep = flip(oldArrP, "dep", dep), newArr = flip(oldDepP, "arr", dest);
      // the transition whose point list is the reversed one (gate excluded), else direct
      const names = (proc, tr) => ATO.expand(proc, tr).filter((q) => q.role === "trans").map((q) => q.name.toUpperCase());
      const sameRev = (np, oldP, oldTr) => {
        const want = names(oldP, oldTr).reverse().join("|");
        const t = (np.transitions || []).find((x) => names(np, x.id).join("|") === want && ATO.usable(np, x.id, lib.byName));
        return t && want ? t.id : null;
      };
      const newDepTr = newDep ? sameRev(newDep, oldArrP, oldArrTr) : null, newArrTr = newArr ? sameRev(newArr, oldDepP, oldDepTr) : null;
      // rebuild the procedure points from the library (the order and plate altitudes come from the new procedure)
      // a procedure that has no counterpart at the other airport stays as plain waypoints
      n.mid = n.mid.filter((p) => !p.proc || (p.proc === "dep" && !newArr) || (p.proc === "arr" && !newDep));
      n.mid.forEach((p) => { if (p.proc) { p.proc = null; p.procRole = undefined; p.pAlt = null; } });
      const mk = (proc, tr, kind) => ATO.expand(proc, tr).map((q) => { const w = lib.byName[q.name.toUpperCase()] || lib.byName[q.name]; return { id: newId(), name: q.name, ident: null, type: "USER WAYPOINT", lat: w.lat, lon: w.lon, lib: "ato", wid: w.id, proc: kind, procRole: q.role, pAlt: isNum(q.alt) ? q.alt : null, alt: null, msa: null, wind: null, rem: blankRem() }; });
      if (newDep) n.mid.unshift(...mk(newDep, newDepTr, "dep"));
      if (newArr) n.mid.push(...mk(newArr, newArrTr, "arr"));
      n.mid.forEach((p) => { p.alt = null; p.msa = null; p.wind = null; p.rem = blankRem(); });
      n.depProc = newDep ? newDep.id : null; n.arrProc = newArr ? newArr.id : null; n.depTr = newDepTr; n.arrTr = newArrTr;
      n.destPt = { alt: null, msa: null, wind: null, rem: Object.assign(blankRem(), { fullStop: true }) };
      n.id = null; n.finalKey = null; n.finalSig = null; n.toTime = ""; n.offBlock = ""; n.blockMin = null;
      return n;
    }
    function duplicateState(s) { const n = normState(JSON.parse(JSON.stringify(s))); n.id = null; n.finalKey = null; n.finalSig = null; return n; }
    function setState(n, keepView) {
      state = n; syncFields(); renderProcSelects(); changed(true);
      const c = aptCoord(state.dep); if (!keepView && c) map.fitBounds(L.latLngBounds([ll(c)].concat(state.mid.map(ll)).concat(aptCoord(state.dest) ? [ll(aptCoord(state.dest))] : [])).pad(0.3), { maxZoom: 11 });
    }
    byId("reverseBtn").addEventListener("click", () => {
      if (state.id != null && !confirm("Start the return flight as a new OFP? The current one stays in your history.")) return;
      setState(reversedState(state)); toast("Return flight: set the date and times");
    });
    byId("newBtn").addEventListener("click", () => {
      if (state.mid.length && !(state.id != null && state.finalSig === calc.sig) && !confirm("Discard this draft and start a new OFP?")) return;
      setState(blankState());
    });

    /* ===================================================== finalise ===================================================== */
    let pendingFin = false;
    function inputsPayload() { const s = JSON.parse(JSON.stringify(state)); delete s.id; delete s.finalKey; delete s.finalSig; delete s.adoptSig; return { v: 1, state: s, totals: calc.out ? calc.out.totals : null, route: OP.routeString(exportRoute()) }; }
    function exportRoute() {
      return (calc.route || []).map((p) => (p.type === "AIRPORT" ? { type: "AIRPORT", ident: icaoOf(p.ident) || p.ident, name: p.name, lat: p.lat, lon: p.lon } : { type: "USER WAYPOINT", ident: null, name: ((lib.byName[p.name] && lib.byName[p.name].ident) || p.name), lat: p.lat, lon: p.lon }));
    }
    async function finalise() {
      if (pendingFin || !calc.out) return;
      const bad = calc.rows.filter((r) => r.error);
      if (bad.length) return toast("Fix the wind error on leg " + (calc.rows.indexOf(bad[0]) + 1) + " first");
      if (!/^\d{4}-\d\d-\d\d$/.test(state.date || "")) return toast("Enter the flight date");
      if (calc.rows.some((r) => !isNum(r.eet))) return toast("Some legs could not be calculated");
      const free = state.id != null && state.finalKey === curKey();
      const t = calc.out.totals;
      const ok = await dialog(`<h3>Finalise this OFP?</h3>
        <ul><li>${esc(state.dep)} → ${esc(state.dest)} · ${esc(fmtDate(state.date))}${state.reg ? " · " + esc(state.reg) : ""}</li><li>${calc.rows.length} legs · EET ${fmtMin(t.eet)} · trip fuel ${f1(t.trip)} USG · takeoff fuel ${f1(state.takeoffFuel)} USG</li></ul>
        ${(() => { const w = (calc.checks || []).filter((c) => c.level !== "info"); return w.length ? `<p class="warnc">${w.length} warning${w.length > 1 ? "s" : ""} in the Checks panel (finalising is still allowed).</p>` : ""; })()}
        <p>${free ? "This is an update of the same flight: <b>no tokens</b> are used." : `<b>Uses ${PRICE} tokens</b> (you have ${tokens()}). Editing and finalising the same flight again (same date, from, to) is free.`}</p>
        <div class="btns"><button type="button" data-v="no">Cancel</button><button type="button" class="pri" data-v="yes" autofocus>${free ? "Update" : "Finalise (" + PRICE + " tokens)"}</button></div>`);
      if (ok.v !== "yes") return;
      pendingFin = true; renderFinal();
      try {
        const sig = calc.sig;
        const r = await Auth.rpc("finalize_ofp", { p_id: state.id, p_inputs: inputsPayload(), p_flight_date: state.date, p_dep: icaoOf(state.dep) || state.dep, p_dest: icaoOf(state.dest) || state.dest, p_route: OP.routeString(exportRoute()), p_reg: state.reg || null });
        state.id = r.id; state.finalKey = curKey(); state.finalSig = sig;
        if (Number.isFinite(+r.balance)) profile.tokens = +r.balance;
        toast(r.charged ? `${PRICE} tokens used` : "Updated, no tokens used");
        lastPdf = null;
      } catch (e) {
        const code = String((e && e.message) || e);
        if (code === "account_disabled") return Auth.signOut();
        if (code === "no_tokens") { toast("No tokens left – ask the admin for more."); refreshProfile(); }
        else if (/Failed to fetch|NetworkError|Load failed|network/i.test(code)) toast("No connection – check your network and finalise again. No token was used.");
        else if (code === "inputs_too_large") toast("This plan is too large to store. No token was used.");
        else toast(`Could not finalise (${dbErr(e)}). No token was used.`);
      } finally { pendingFin = false; render(); saveDraftSoon(); }
    }
    byId("finBtn").addEventListener("click", finalise);

    /* ===================================================== output: PDF, fpl, copy, handover ===================================================== */
    let lastPdf = null;
    async function pdfBytes() {
      if (lastPdf && lastPdf.sig === calc.sig) return lastPdf.bytes;
      const rows = calc.rows.map((r) => { const o = Object.assign({}, r); delete o.pt; delete o.how; return o; });
      const bytes = await OP.buildPdf({ rows, totals: calc.out.totals }, calc.header);
      lastPdf = { sig: calc.sig, bytes };
      return bytes;
    }
    const fileBase = () => `OFP_${String(state.dep).replace(/\W/g, "")}-${String(state.dest).replace(/\W/g, "")}_${state.date || ""}`;
    function download(blob, name) { const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 4000); }
    async function copyText(t) {
      try { await navigator.clipboard.writeText(t); return true; } catch (e) {
        const ta = document.createElement("textarea"); ta.value = t; ta.style.position = "fixed"; ta.style.opacity = "0"; document.body.appendChild(ta); ta.select();
        let ok = false; try { ok = document.execCommand("copy"); } catch (e2) { ok = false; } ta.remove(); return ok;
      }
    }
    async function out(name) {
      if (!(state.id != null && state.finalSig === calc.sig)) return toast("Finalise first (changes since the last finalise)");
      try {
        if (name === "download" || name === "print" || name === "preview") {
          const bytes = await pdfBytes();
          if (name === "download") return download(new Blob([bytes], { type: "application/pdf" }), fileBase() + ".pdf");
          if (name === "print") return window.open(URL.createObjectURL(new Blob([bytes], { type: "application/pdf" })), "_blank");
          return previewPdf(bytes);
        }
        if (name === "fpl") return download(new Blob([OP.fpl(exportRoute())], { type: "application/octet-stream" }), fileBase() + ".fpl");
        if (name === "copy") return toast((await copyText(OP.routeString(exportRoute()))) ? "Route copied" : "Could not copy the route");
        if (name === "ff") {
          // Cruise TAS from the longest leg (same leg cruiseFfOf uses for FF); max altitude over all rows.
          const rows = calc.rows || [], legs = rows.filter((r) => !r.fixed);
          const cruise = legs.reduce((b, r) => (!b || r.dist > b.dist ? r : b), null);
          const alts = rows.map((r) => r.alt).filter(isNum);
          // ETD in UTC from date + T/O time in the departure airport's time zone (planMs)
          const etd = /^\d{4}-\d\d-\d\d$/.test(state.date || "") && hhmm(state.toTime) ? new Date(planMs()) : null;
          const url = OP.foreflightUrl(exportRoute(), { tas: cruise ? cruise.tas : null, ff: cruiseFfOf(rows), alt: alts.length ? Math.max(...alts) : null, aircraft: state.callsign, etd });
          if (/iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1)) location.href = url;
          else toast("Opens ForeFlight on iPad/iPhone. Use the .fpl file or Copy route on this device.");
          return;
        }
        if (name === "send") {
          const t = calc.out.totals;
          lsSet(HANDOFF_KEY, JSON.stringify({ dep: icaoOf(state.dep) || state.dep, dest: icaoOf(state.dest) || state.dest, date: state.date, depTime: hhmm(state.toTime), durMin: t.eet, tripFuel: t.trip, takeoffFuel: state.takeoffFuel, reg: state.reg }));
          location.href = "index.html?from=ofp";
        }
      } catch (e) { toast("Could not create the file: " + String((e && e.message) || e)); }
    }
    byId("outActs").addEventListener("click", (e) => { const b = e.target.closest("[data-out]"); if (b) out(b.dataset.out); });
    async function previewPdf(bytes) {
      const pdfjs = window.pdfjsLib; pdfjs.GlobalWorkerOptions.workerSrc = "vendor/pdf.worker.min.js";
      const d = document.createElement("dialog"); d.className = "pdf";
      d.innerHTML = '<div class="btns" style="justify-content:space-between;margin:0 0 6px"><b>OFP preview</b><span><button type="button" data-o="print">Open to print</button> <button type="button" data-o="dl">Download PDF</button> <button type="button" class="pri" data-o="x">Close</button></span></div><div id="pdfpages"><p class="note">Rendering…</p></div>';
      d.addEventListener("click", (e) => { const b = e.target.closest("[data-o]"); if (!b) return; if (b.dataset.o === "x") d.close(); else out(b.dataset.o === "dl" ? "download" : "print"); });
      d.addEventListener("close", () => d.remove());
      document.body.appendChild(d); d.showModal();
      try {
        const doc = await pdfjs.getDocument({ data: bytes.slice() }).promise, host = d.querySelector("#pdfpages"), dpr = window.devicePixelRatio || 1, cvs = [];
        for (let n = 1; n <= doc.numPages; n++) {
          const pg = await doc.getPage(n), base = pg.getViewport({ scale: 1 }), w = Math.min(860, window.innerWidth - 60);
          const vp = pg.getViewport({ scale: (w / base.width) * dpr }), cv = document.createElement("canvas");
          cv.width = vp.width; cv.height = vp.height;
          await pg.render({ canvasContext: cv.getContext("2d"), viewport: vp }).promise; cvs.push(cv);
        }
        host.replaceChildren(...cvs);
      } catch (e) { d.querySelector("#pdfpages").innerHTML = `<p class="err">Could not render the preview: ${esc(String((e && e.message) || e))}. Use Download PDF.</p>`; }
    }

    /* ===================================================== history ===================================================== */
    async function openHistory() {
      let rows = null, err = "";
      try { rows = await Auth.rest("/ofps?select=id,flight_date,dep,dest,route,reg,inputs,created_at,updated_at&order=created_at.desc&limit=100"); }
      catch (e) { err = /relation|does not exist|schema cache|PGRST205|404/i.test(String((e && e.message) || e) + (e && e.code)) ? "OFP history is not available yet (database setup pending)." : "Could not load the history: " + String((e && e.message) || e); }
      const list = (rows || []).map((r, i) => `<li><div class="hmeta"><b>${esc(r.dep)} → ${esc(r.dest)}</b> · ${esc(r.flight_date)}${r.reg ? " · " + esc(r.reg) : ""}<br><span class="fine">#${r.id} · ${esc(String(r.route || "").slice(0, 70))}</span></div><div class="hbtn"><button type="button" data-v="open:${i}">Open</button><button type="button" data-v="dup:${i}">Duplicate</button><button type="button" data-v="ret:${i}">Return flight</button></div></li>`).join("");
      const res = await dialog(`<h3>OFP history</h3>${err ? `<p class="warnc">${esc(err)}</p>` : rows.length ? `<ul class="hist">${list}</ul>` : "<p>No OFPs yet. Finalise one to see it here.</p>"}<div class="btns"><button type="button" data-v="x">Close</button></div>`);
      const m = /^(open|dup|ret):(\d+)$/.exec(res.v || ""); if (!m) return;
      const row = rows[+m[2]], s = row && row.inputs && row.inputs.state;
      if (!s) return toast("This OFP has no stored plan");
      if (state.mid.length && !(state.id != null && state.finalSig === calc.sig) && !confirm("Replace the current draft?")) return;
      const base = normState(s);
      if (m[1] === "open") {
        base.id = row.id; base.finalKey = [row.flight_date, row.dep, row.dest].join("|"); base.finalSig = null; base.adoptSig = true;
        setState(base);
      } else if (m[1] === "dup") { setState(duplicateState(base)); toast("Duplicated as a new flight"); }
      else { setState(reversedState(base)); toast("Return flight: set the date and times"); }
    }
    byId("histBtn").addEventListener("click", openHistory);

    /* ===================================================== admin: ATO point placement ===================================================== */
    async function saveAto(name, lat, lon, id, notes) {
      try { await Auth.rpc("admin_upsert_waypoint", { p_id: id || null, p_name: name, p_ident: null, p_lat: +lat.toFixed(6), p_lon: +lon.toFixed(6), p_notes: notes || null }); toast(name + " saved"); }
      catch (e) { toast("Could not save " + name + ": " + dbErr(e)); return false; }
      return true;
    }
    // every ATO point name: plate list, names used by procedures (incl. admin edits) and all global library points
    function atoEntries() {
      const used = new Set(ATO.pointNames(procs).map((n) => n.toUpperCase()));
      const m = new Map();
      ATO.points.forEach((p) => m.set(p.name.toUpperCase(), { name: p.name, desc: p.desc, builtin: true }));
      ATO.pointNames(procs).forEach((n) => { if (!m.has(n.toUpperCase())) m.set(n.toUpperCase(), { name: n, desc: "", builtin: false }); });
      lib.ato.forEach((w) => { if (!m.has(w.name.toUpperCase())) m.set(w.name.toUpperCase(), { name: w.name, desc: w.notes || "", builtin: false }); });
      return Array.from(m.values()).sort((a, b) => a.name.localeCompare(b.name)).map((e) => {
        const w = lib.byName[e.name] || lib.byName[e.name.toUpperCase()] || null;
        return Object.assign(e, { w, unused: !e.builtin && !used.has(e.name.toUpperCase()) });
      });
    }
    function renderAto() {
      if (profile.role !== "admin") return;
      byId("atoList").innerHTML = atoEntries().map((p) => {
        const w = p.w, tip = (p.desc || "") + (w && w.notes && w.notes !== p.desc ? "\n" + w.notes : "");
        return `<div class="arow${p.unused ? " unused" : ""}"><button type="button" class="pt ${placing === p.name ? "sel" : ""}" data-ato="${esc(p.name)}" title="${esc(tip)}">${esc(p.name)}<small>${w ? "placed" : "not placed"}${p.unused ? " · unused" : ""}</small></button>`
          + (w ? `<button type="button" class="mini" data-ar="${esc(p.name)}">Rename</button><button type="button" class="mini" data-ad="${esc(p.name)}">Delete</button>` : "") + "</div>";
      }).join("");
      byId("atoNames").innerHTML = atoEntries().map((p) => `<option value="${esc(p.name)}">`).join("");
    }
    function startPlacing(name) {
      const w = lib.byName[name];
      placing = placing === name ? null : name;
      byId("map").classList.toggle("placing", !!placing);
      const h = byId("mhint"); h.hidden = !placing; h.textContent = placing ? `Click the map to place ${placing}${w ? " (replaces its position)" : ""}. Click the name again to cancel.` : "";
      if (placing && w) map.setView([w.lat, w.lon], Math.max(map.getZoom(), 11));
      if (placing && window.matchMedia("(max-width:900px)").matches) setSheet("peek");
      renderAto();
    }
    const globalNameTaken = (n, exceptId) => lib.ato.some((w) => w.id !== exceptId && w.name.toUpperCase() === n.toUpperCase());
    byId("atoList").addEventListener("click", async (e) => {
      const rn = e.target.closest("[data-ar]"), del = e.target.closest("[data-ad]");
      if (rn) {
        const w = lib.byName[rn.dataset.ar]; if (!w) return;
        const r = await dialog(`<h3>Rename ATO point</h3><label>Name (1-40 characters)<input name="n" maxlength="40" value="${esc(w.name)}"></label><label>Notes<input name="t" maxlength="500" value="${esc(w.notes || "")}"></label>
          <p class="fine">Procedures reference points by name: a procedure that still uses the old name will show it as not placed until it is edited.</p>
          <div class="btns"><button type="button" data-v="no">Cancel</button><button type="button" class="pri" data-v="ok">Rename</button></div>`);
        const n = String(r.f.n || "").trim().toUpperCase();
        if (r.v !== "ok") return;
        if (!n || n.length > 40) return toast("The name must be 1 to 40 characters");
        if (globalNameTaken(n, w.id)) return toast(n + " already exists");
        if (await saveAto(n, w.lat, w.lon, w.id, String(r.f.t || "").trim())) await loadWaypoints();
        return;
      }
      if (del) {
        const w = lib.byName[del.dataset.ad]; if (!w) return;
        if (!confirm(`Delete the ATO point ${w.name}? Procedures that use it will show it as not placed. This cannot be undone.`)) return;
        try { await Auth.rpc("admin_delete_waypoint", { p_id: w.id }); toast(w.name + " deleted"); await loadWaypoints(); }
        catch (err) { toast("Could not delete " + w.name + ": " + dbErr(err)); }
        return;
      }
      const b = e.target.closest("[data-ato]"); if (b) startPlacing(b.dataset.ato);
    });
    byId("atoNew").addEventListener("click", async () => {
      const r = await dialog(`<h3>New ATO point</h3><label>Name (1-40 characters, upper case)<input name="n" maxlength="40" autocapitalize="characters"></label>
        <div class="btns"><button type="button" data-v="no">Cancel</button><button type="button" class="pri" data-v="ok">Place on the map</button></div>`);
      if (r.v !== "ok") return;
      const n = String(r.f.n || "").trim().toUpperCase();
      if (!n || n.length > 40) return toast("The name must be 1 to 40 characters");
      if (globalNameTaken(n) || ATO.points.some((p) => p.name.toUpperCase() === n && lib.byName[n])) return toast(n + " already exists");
      placing = null; startPlacing(n);
    });
    async function placeAt(latlng) {
      const name = placing, p = ATO.points.find((x) => x.name === name), w = lib.byName[name];
      if (!name) return;
      placing = null; byId("map").classList.remove("placing"); byId("mhint").hidden = true;
      await saveAto(name, latlng.lat, latlng.lng, w && w.id, p ? p.desc : w && w.notes);
      await loadWaypoints();
    }

    /* ===================================================== admin: ATO procedure editor ===================================================== */
    const procRowOf = (id) => procRows.find((r) => r && r.id === id) || null;
    const defaultProc = (id) => ATO.procedures.find((p) => p.id === id) || null;
    function renderProcAdmin() {
      if (profile.role !== "admin") return;
      const edited = new Set(procRows.filter((r) => r && !r.hidden).map((r) => r.id));
      const items = procs.map((p) => ({ p, hidden: false, edited: edited.has(p.id) }));
      procRows.filter((r) => r && r.hidden).forEach((r) => {
        const base = defaultProc(r.id), d = ATO.normalize(Object.assign({}, base || {}, r.data || {}, { id: r.id }));
        items.push({ p: d, hidden: true, edited: false });
      });
      items.sort((a, b) => a.p.airport.localeCompare(b.p.airport) || a.p.kind.localeCompare(b.p.kind) || a.p.name.localeCompare(b.p.name));
      let h = "", ap = null;
      items.forEach((it) => {
        if (it.p.airport !== ap) { ap = it.p.airport; h += `<div class="pg">${esc(ap)}</div>`; }
        h += `<div class="prow${it.hidden ? " hid" : ""}"><span class="nm">${esc(it.p.name)} <small>${it.p.kind === "dep" ? "DEP" : "ARR"}</small>${it.edited ? '<span class="bdg">edited</span>' : ""}${it.hidden ? '<span class="bdg">hidden</span>' : ""}${!defaultProc(it.p.id) && !it.hidden ? '<span class="bdg">custom</span>' : ""}</span>`
          + (it.hidden ? `<button type="button" data-pshow="${esc(it.p.id)}">Show</button>` : `<button type="button" data-pedit="${esc(it.p.id)}">Edit</button>`) + "</div>";
      });
      byId("procList").innerHTML = h || '<p class="fine">No procedures.</p>';
    }
    const slugOf = (s) => String(s || "").toUpperCase().replace(/[^A-Z0-9]+/g, "");
    function newProcId(airport, kind, name) {
      const taken = new Set(procs.map((p) => p.id).concat(procRows.map((r) => r.id), ATO.procedures.map((p) => p.id)));
      const base = `${airport}-${kind}-${slugOf(name) || "NEW"}`.toUpperCase().slice(0, 55);
      let id = base, k = 2;
      while (taken.has(id)) id = base + "-" + k++;
      return id;
    }
    // draft -> the JSON stored in ato_procedures (or an error text)
    function procData(d) {
      const err = (m) => ({ err: m });
      const airport = icaoOf(String(d.airport || "").trim());
      if (!airport) return err("Airport: pick one of the LAT airports");
      const name = String(d.name || "").trim(), gate = String(d.gate || "").trim();
      if (name.length < 1 || name.length > 60) return err("Name must be 1 to 60 characters");
      if (gate.length < 1 || gate.length > 40) return err("Gate point must be 1 to 40 characters");
      const nn = (v, what) => { if (v === "" || v == null) return null; const x = Number(v); return Number.isFinite(x) && x >= 0 ? x : NaN; };
      const min = nn(d.min), nm = nn(d.nm), alt = nn(d.alt), xm = nn(d.extraMin);
      if ([min, nm, alt, xm].some((x) => Number.isNaN(x))) return err("Minutes, NM, altitude and extra minutes must be numbers");
      if ((min === null) !== (nm === null)) return err("Give both minutes and NM, or neither");
      const out = { airport, kind: d.kind === "arr" ? "arr" : "dep", name, gate, min, nm, alt, dualOnly: !!d.dualOnly, soloOnly: !!d.soloOnly, extraMin: xm || 0, extraMinDest: d.extraMinDest || {}, plate: d.plate || "", notes: String(d.notes || "").trim(), transitions: [] };
      if (out.dualOnly && out.soloOnly) return err("A procedure cannot be both dual-only and solo-only");
      for (const t of d.transitions || []) {
        const tn = String(t.name || "").trim();
        if (!tn) return err("Every transition needs a name");
        if (t.dualOnly && t.soloOnly) return err(tn + ": cannot be both dual-only and solo-only");
        const pts = [];
        for (const q of t.points || []) {
          const pn = String(q.name || "").trim();
          if (!pn) return err(tn + ": every point needs a name");
          if (pn.length > 40) return err(pn + ": point names are at most 40 characters");
          const a = nn(q.alt); if (Number.isNaN(a)) return err(pn + ": altitude must be a number");
          pts.push({ name: pn, alt: a });
        }
        out.transitions.push({ id: t.id || "", name: tn, dualOnly: !!t.dualOnly, soloOnly: !!t.soloOnly, notes: String(t.notes || "").trim(), points: pts });
      }
      return { data: out };
    }
    const procEditorHtml = (d, flags) => `<h3>${flags.isNew ? "New ATO procedure" : "Edit ATO procedure"}</h3>
      <div id="peBody"></div>
      <div class="btns">
        <button type="button" data-v="no">Cancel</button>
        ${flags.isDefault ? '<button type="button" data-v="reset">Reset to plate default</button>' : ""}
        ${!flags.isNew && !flags.isDefault ? '<button type="button" data-v="del">Delete</button>' : ""}
        ${!flags.isNew ? '<button type="button" data-v="hide">Hide</button>' : ""}
        <button type="button" class="pri" data-v="save">Save</button>
      </div>`;
    function procEditorBody(d) {
      const v = (x) => (x === null || x === undefined ? "" : esc(String(x)));
      let h = `<div class="g2">
        <label>Airport<input data-f="airport" list="aptlist" value="${v(d.airport)}" autocapitalize="characters"></label>
        <label>Kind<select data-f="kind"><option value="dep"${d.kind === "dep" ? " selected" : ""}>Departure</option><option value="arr"${d.kind === "arr" ? " selected" : ""}>Arrival</option></select></label>
        <label>Name<input data-f="name" maxlength="60" value="${v(d.name)}"></label>
        <label>Gate point (exit / entry)<input data-f="gate" list="atoNames" maxlength="40" value="${v(d.gate)}"></label>
        <label>Time at gate (min)<input type="number" min="0" step="1" data-f="min" value="${v(d.min)}"></label>
        <label>Distance at gate (NM)<input type="number" min="0" step="1" data-f="nm" value="${v(d.nm)}"></label>
        <label>Altitude (ft)<input type="number" min="0" step="100" data-f="alt" value="${v(d.alt)}"></label>
        <label>Extra minutes (full stop)<input type="number" min="0" step="1" data-f="extraMin" value="${v(d.extraMin || "")}"></label>
        <label class="ck2"><input type="checkbox" data-f="dualOnly"${d.dualOnly ? " checked" : ""}> Dual only</label>
        <label class="ck2"><input type="checkbox" data-f="soloOnly"${d.soloOnly ? " checked" : ""}> Solo only</label>
      </div><label>Notes<textarea data-f="notes" rows="3">${v(d.notes)}</textarea></label><h4>Transitions</h4>`;
      (d.transitions || []).forEach((t, i) => {
        h += `<div class="tr"><div class="g2"><label>Transition name<input data-t="${i}" data-f="tn" maxlength="60" value="${v(t.name)}"></label>
          <label class="ck2"><input type="checkbox" data-t="${i}" data-f="td"${t.dualOnly ? " checked" : ""}> Dual only</label>
          <label class="ck2"><input type="checkbox" data-t="${i}" data-f="ts"${t.soloOnly ? " checked" : ""}> Solo only</label></div>
          <label>Notes<input data-t="${i}" data-f="tnotes" value="${v(t.notes)}"></label>
          <div class="fine">Points in flying order (${d.kind === "arr" ? "toward the airport, the gate comes last" : "away from the airport, the gate comes first"}), altitude in ft</div>`;
        (t.points || []).forEach((q, j) => {
          h += `<div class="tp"><input data-t="${i}" data-p="${j}" data-f="pn" list="atoNames" maxlength="40" value="${v(q.name)}" placeholder="Point name" aria-label="Point name"><input type="number" step="100" data-t="${i}" data-p="${j}" data-f="pa" value="${v(q.alt)}" placeholder="alt" aria-label="Altitude">
            <button type="button" data-a="up" data-t="${i}" data-p="${j}" title="Move up">↑</button><button type="button" data-a="down" data-t="${i}" data-p="${j}" title="Move down">↓</button><button type="button" data-a="delp" data-t="${i}" data-p="${j}" title="Remove point">✕</button></div>`;
        });
        h += `<button type="button" data-a="addp" data-t="${i}">+ point</button> <button type="button" data-a="delt" data-t="${i}">✕ transition</button></div>`;
      });
      return h + '<button type="button" data-a="addt">+ transition</button>';
    }
    async function editProc(id) {
      const isNew = !id, base = id ? procOf(id) : null;
      if (!isNew && !base) return;
      const isDefault = !!(id && defaultProc(id));
      let draft = JSON.parse(JSON.stringify(base || { airport: state.dep ? icaoOf(state.dep) || "KGYR" : "KGYR", kind: "dep", name: "", gate: "", min: null, nm: null, alt: null, dualOnly: false, soloOnly: false, extraMin: 0, extraMinDest: {}, plate: "", notes: "", transitions: [] }));
      for (;;) {
        const r = await dialog(procEditorHtml(draft, { isNew, isDefault }), { cls: "pe", onOpen: (d) => {
          const body = d.querySelector("#peBody");
          const render = () => { body.innerHTML = procEditorBody(draft); };
          render();
          const sync = (el) => {
            const f = el.dataset.f; if (!f) return;
            const t = el.dataset.t !== undefined ? draft.transitions[+el.dataset.t] : null, q = t && el.dataset.p !== undefined ? t.points[+el.dataset.p] : null;
            const val = el.type === "checkbox" ? el.checked : el.value;
            if (q) { if (f === "pn") q.name = val; else if (f === "pa") q.alt = val === "" ? null : +val; }
            else if (t) { if (f === "tn") t.name = val; else if (f === "td") t.dualOnly = val; else if (f === "ts") t.soloOnly = val; else if (f === "tnotes") t.notes = val; }
            else if (["min", "nm", "alt", "extraMin"].includes(f)) draft[f] = val === "" ? null : +val;
            else draft[f] = val;
            if (f === "kind") render();
          };
          body.addEventListener("input", (e) => sync(e.target));
          body.addEventListener("change", (e) => sync(e.target));
          body.addEventListener("click", (e) => {
            const b = e.target.closest("[data-a]"); if (!b) return;
            const a = b.dataset.a, t = draft.transitions[+b.dataset.t], j = +b.dataset.p;
            if (a === "addt") draft.transitions.push({ id: "", name: "", dualOnly: false, soloOnly: false, notes: "", points: [] });
            else if (a === "delt") draft.transitions.splice(+b.dataset.t, 1);
            else if (a === "addp") t.points.push({ name: "", alt: null });
            else if (a === "delp") t.points.splice(j, 1);
            else if (a === "up" && j > 0) t.points.splice(j - 1, 0, t.points.splice(j, 1)[0]);
            else if (a === "down" && j < t.points.length - 1) t.points.splice(j + 1, 0, t.points.splice(j, 1)[0]);
            render();
          });
        } });
        if (r.v === "save" || r.v === "hide") {
          const res = procData(draft);
          if (res.err) { toast(res.err); continue; }
          const pid = isNew ? newProcId(res.data.airport, res.data.kind, res.data.name) : id;
          try {
            await Auth.rpc("admin_upsert_procedure", { p_id: pid, p_data: res.data, p_hidden: r.v === "hide" });
            toast(r.v === "hide" ? res.data.name + " hidden" : res.data.name + " saved");
          } catch (e) { toast("Could not save: " + (/forbidden/.test(String((e && e.message) || e)) ? "admin only" : dbErr(e))); continue; }
        } else if (r.v === "reset" || r.v === "del") {
          if (!confirm(r.v === "reset" ? "Reset this procedure to the plate default? Your edits are lost." : "Delete this procedure? This cannot be undone.")) continue;
          try { await Auth.rpc("admin_delete_procedure", { p_id: id }); toast(r.v === "reset" ? "Reset to plate default" : "Procedure deleted"); }
          catch (e) { toast("Could not " + r.v + ": " + dbErr(e)); continue; }
        } else return;
        await afterProcChange();
        return;
      }
    }
    async function afterProcChange() {
      await loadProcs();
      // a selected procedure that no longer exists (deleted/hidden) is cleared; edited ones keep their checkpoints until picked again
      if (state.depProc && !procOf(state.depProc)) { state.mid = state.mid.filter((p) => p.proc !== "dep"); state.depProc = null; state.depTr = null; }
      if (state.arrProc && !procOf(state.arrProc)) { state.mid = state.mid.filter((p) => p.proc !== "arr"); state.arrProc = null; state.arrTr = null; }
      renderProcSelects(); renderProcAdmin(); renderAto(); changed(true);
    }
    byId("procNew").addEventListener("click", () => editProc(null));
    byId("procList").addEventListener("click", async (e) => {
      const ed = e.target.closest("[data-pedit]"), sh = e.target.closest("[data-pshow]");
      if (ed) return editProc(ed.dataset.pedit);
      if (sh) {
        const row = procRowOf(sh.dataset.pshow); if (!row) return;
        try { await Auth.rpc("admin_upsert_procedure", { p_id: row.id, p_data: row.data || {}, p_hidden: false }); toast("Procedure shown"); }
        catch (err) { return toast("Could not show it: " + dbErr(err)); }
        await afterProcChange();
      }
    });

    /* ===================================================== bottom sheet (narrow screens) ===================================================== */
    const panel = byId("panel"), SHEETS = ["peek", "half", "full"];
    function setSheet(s) { panel.dataset.sheet = s; setTimeout(() => map.invalidateSize(), 220); }
    byId("grip").addEventListener("click", () => { if (grip.moved) return; setSheet(SHEETS[(SHEETS.indexOf(panel.dataset.sheet) + 1) % 3]); });
    const grip = { y: 0, moved: false };
    byId("grip").addEventListener("pointerdown", (e) => { grip.y = e.clientY; grip.moved = false; byId("grip").setPointerCapture(e.pointerId); });
    byId("grip").addEventListener("pointerup", (e) => {
      const dy = e.clientY - grip.y;
      if (Math.abs(dy) > 30) { grip.moved = true; const i = SHEETS.indexOf(panel.dataset.sheet); setSheet(SHEETS[Math.max(0, Math.min(2, i + (dy < 0 ? 1 : -1)))]); setTimeout(() => (grip.moved = false), 50); }
    });
    if (window.matchMedia("(max-width:900px)").matches) panel.dataset.sheet = "peek";
    window.addEventListener("resize", () => map.invalidateSize());

    /* ===================================================== step 3: automatic data and the safety layer ===================================================== */
    // Sources: OfpData (ADDS airspace / airports / obstacles, Terrarium terrain, Open-Meteo winds) + Safety (pure checks).
    // Per-leg results are stored in state.auto so a reload (or reopening a finalised OFP) reuses them; a leg is refetched only
    // when its geometry (terrain/MSA), its altitude or the flight hour (winds) changed, or when "Refresh data" is pressed.
    const D = window.OfpData, S = window.Safety;
    const WX_ORDER = [["hazards", "Weather hazards"], ["pireps", "PIREPs"], ["tfrs", "TFRs"], ["metar", "METAR/TAF"]];
    const SRC_ORDER = [["terrain", "Terrain"], ["obstacles", "Obstacles"], ["airspace", "Airspace"], ["airports", "Airports"], ["winds", "Winds aloft"]];
    ctx.sources = Object.assign({}, state.auto.src || {});
    let dataGen = 0, dataTimer = null, lastDataSig = "", busy = false, safeTimer = null, lastSafeSig = "", lastOut = "";
    const needWind = () => state.windMode === "auto" || !!state.isaAuto;
    const ageText = (at) => { if (!at) return ""; const m = Math.round((Date.now() - at) / 60000); return m < 1 ? "just now" : m < 90 ? m + " min ago" : Math.round(m / 60) + " h ago"; };
    function planMs() {
      const m = /^(\d{4})-(\d\d)-(\d\d)$/.exec(state.date || ""); if (!m) return Date.now();
      const hh = hhmm(state.toTime), H = hh ? +hh.slice(0, 2) : 12, M = hh ? +hh.slice(2) : 0, guess = Date.UTC(+m[1], +m[2] - 1, +m[3], H, M);
      try {
        const tz = (aptOf(state.dep) || {}).tz || "America/Phoenix";
        const f = new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric" }).formatToParts(new Date(guess));
        const g = (k) => +f.find((p) => p.type === k).value;
        return guess - (Date.UTC(g("year"), g("month") - 1, g("day"), g("hour"), g("minute")) - guess);
      } catch (e) { return guess + 7 * 3600e3; }
    }
    async function pool(items, n, fn) {
      let i = 0;
      await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => { while (i < items.length) { const k = i++; await fn(items[k], k); } }));
    }
    const srcInfo = (r) => ({ ok: !!r.ok, source: r.source, at: r.at, stale: !!r.stale, partial: !!r.partial });
    function dataSig() {
      if (!calc.route || !calc.rows.length) return "";
      return JSON.stringify([needWind(), calc.rows.map((r, i) => [geomKey(calc.route[i], calc.route[i + 1]), r.alt, !!r.fixed, needWind() ? legHh(r.id) : 0])]);
    }
    // network calls are debounced (900 ms after the last route edit); a newer schedule makes older in-flight results stale
    function scheduleData(force) { dataGen++; clearTimeout(dataTimer); dataTimer = setTimeout(() => ensureData(force), force ? 0 : 900); }
    async function ensureData(force) {
      const my = dataGen, route = calc.route, rows = calc.rows;
      if (!D || !S || !route || !rows.length) return;
      busy = true; renderAutoStatus();
      try {
        const lats = route.map((p) => p.lat), lons = route.map((p) => p.lon), pad = 0.35;
        const bb = { s: Math.min(...lats) - pad, n: Math.max(...lats) + pad, w: Math.min(...lons) - pad, e: Math.max(...lons) + pad };
        const rk = [bb.s, bb.n, bb.w, bb.e].map((v) => v.toFixed(2)).join(",");
        if (force || ctx.regionKey !== rk) {
          const [as, ap, ob] = await Promise.all([D.airspace(bb), D.airports(bb), D.obstacles(bb)]);
          if (my !== dataGen) return;
          as.data.forEach((a) => { const la = [], lo = []; a.rings.forEach((r) => r.forEach((p) => { la.push(p[0]); lo.push(p[1]); })); a._bb = { s: Math.min(...la), n: Math.max(...la), w: Math.min(...lo), e: Math.max(...lo) }; });
          ctx.data = { airspace: as.data || [], airports: ap.data || [], obstacles: ob.data || [] };
          ctx.regionKey = rk; ctx.dataVersion++;
          ctx.sources.airspace = srcInfo(as); ctx.sources.airports = srcInfo(ap); ctx.sources.obstacles = srcInfo(ob);
          lastSafeSig = ""; computeSafetySoon();
          renderAutoStatus();
        }
        const wantWind = needWind();
        let terrOk = true, windOk = true, fetched = 0;
        if (force) rows.forEach((r, i) => { const rec = getRec(route[i + 1], route[i]); delete rec.msa; delete rec.w; delete rec.ws; });
        await pool(rows.map((r, i) => i), 4, async (i) => {
          const r = rows[i], a = route[i], b = route[i + 1], rec = getRec(b, a);
          if (!rec.msa) {
            const t = await D.terrainMax(a, b, 5);
            if (my !== dataGen) return;
            if (t.ok) {
              const me = S.maxElevation(t.data, ctx.data.obstacles, a, b, 5);
              if (me) { rec.msa = { ft: Math.round(me.ft), lat: me.lat, lon: me.lon, kind: me.kind, msa: me.msa, obs: !ctx.sources.obstacles || ctx.sources.obstacles.ok !== false, at: Date.now() }; fetched++; }
            } else terrOk = false;
          }
          const hh = legHh(r.id);
          if (wantWind && !r.fixed && !autoWindRec(b, a, r.alt)) {
            const m = Nav.mid(a, b), w = await D.windsAloft({ lat: m.lat, lon: m.lon, timeMs: +hh * 3600e3, altFt: r.alt });
            if (my !== dataGen) return;
            if (w.ok) {
              rec.w = { alt: r.alt, hh, dir: w.data.dir, spd: w.data.spd, tempC: w.data.tempC, src: w.source, at: w.at }; fetched++;
              rec.ws = rec.ws || {}; rec.ws[r.alt + "|" + hh] = rec.w;
              const ks = Object.keys(rec.ws); if (ks.length > 6) ks.sort((x, y) => rec.ws[x].at - rec.ws[y].at).slice(0, ks.length - 6).forEach((k) => { delete rec.ws[k]; });
            } else windOk = false;
          }
        });
        if (my !== dataGen) return;
        const ids = new Set(route.slice(1).map((p) => p.id));
        Object.keys(state.auto.legs).forEach((k) => { if (!ids.has(k)) delete state.auto.legs[k]; });
        const recs = rows.map((r, i) => legRec(route[i + 1], route[i]));
        const lastAt = (f) => Math.max(0, ...recs.map((x) => (x && f(x)) || 0));
        ctx.sources.terrain = { ok: terrOk && recs.every((x) => x && x.msa), source: "AWS Terrain Tiles", at: lastAt((x) => x.msa && x.msa.at) || null };
        if (wantWind) ctx.sources.winds = { ok: windOk && rows.every((r, i) => r.fixed || autoWindRec(route[i + 1], route[i], r.alt)), source: "Open-Meteo (GFS)", at: lastAt((x) => x.w && x.w.at) || null };
        else delete ctx.sources.winds;
        if (fetched) state.auto.at = Date.now();
        state.auto.src = JSON.parse(JSON.stringify(ctx.sources));
      } catch (e) { console.error(e); }
      finally { if (my === dataGen) { busy = false; window.OfpPage.refresh(); renderAutoStatus(); } }
    }
    function renderAutoStatus() {
      const host = byId("autochecks"); if (!host) return;
      const items = SRC_ORDER.filter(([k]) => ctx.sources[k] && (k !== "winds" || needWind())).map(([k, label]) => {
        const s = ctx.sources[k];
        if (s.ok === false) return `<div class="srow err"><b>${label}</b> unavailable${s.partial ? " (partial)" : ""}</div>`;
        return `<div class="srow"><b>${label}</b> ${esc(s.source || "")}${s.stale ? " (stale)" : ""}${s.at ? " · " + ageText(s.at) : ""}</div>`;
      });
      const wxItems = WX_ORDER.filter(([k]) => ctx.wxSources[k]).map(([k, label]) => {
        const s = ctx.wxSources[k];
        if (s.ok === false) return `<div class="srow err"><b>${label}</b> unavailable</div>`;
        return `<div class="srow"><b>${label}</b> ${esc(s.source || "")}${s.partial ? " (partial)" : ""}${s.at ? " · " + ageText(s.at) : ""}</div>`;
      });
      const old = Math.abs(planMs() - Date.now()) > 60 * 3600e3 && needWind();
      host.innerHTML = `<div class="grp">Automatic data</div>${items.join("") || '<div class="srow">Not loaded yet.</div>'}${wxItems.join("")}${busy || wxBusy ? '<div class="srow">Loading…</div>' : ""}${old ? '<div class="srow warnc">The flight date is outside the 3-day forecast: the nearest forecast hour is used.</div>' : ""}
        <div class="srow"><button type="button" class="sm" id="refreshData"${busy ? " disabled" : ""}>Refresh data</button> <button type="button" class="sm" id="refreshWx"${wxBusy ? " disabled" : ""}>Refresh weather</button> <span class="fine">Automatic MSA, airspace, glide and winds are aids: verify on the chart.</span></div>`;
    }
    byId("autochecks").addEventListener("click", (e) => {
      if (e.target.id === "refreshData") { lastDataSig = dataSig(); scheduleData(true); }
      if (e.target.id === "refreshWx") { lastWxSig = wxSig(); scheduleWx(true); }
    });
    setInterval(renderAutoStatus, 60000);

    // ---- per-leg safety computation (conflicts, glide, emergency notes) and the overlays
    const airNear = (a, b) => { const bb = { s: Math.min(a.lat, b.lat) - 0.2, n: Math.max(a.lat, b.lat) + 0.2, w: Math.min(a.lon, b.lon) - 0.25, e: Math.max(a.lon, b.lon) + 0.25 }; return ctx.data.airspace.filter((x) => x._bb && x._bb.n >= bb.s && x._bb.s <= bb.n && x._bb.e >= bb.w && x._bb.w <= bb.e); };
    function candidateFields() {
      const m = new Map();
      ctx.data.airports.forEach((f) => m.set(f.ident, { ident: f.ident, name: f.name, lat: f.lat, lon: f.lon, elev: isNum(f.elev) ? f.elev : 0 }));
      aptList.forEach((a) => { const c = aptCoord(a.icao); if (c) m.set(a.icao, { ident: a.icao, name: a.name, lat: c.lat, lon: c.lon, elev: isNum(a.elev) ? a.elev : 0 }); });
      return [...m.values()];
    }
    function computeSafetySoon() { clearTimeout(safeTimer); safeTimer = setTimeout(computeSafety, 300); }
    function computeSafety() {
      const route = calc.route, rows = calc.rows;
      if (!S || !route || !rows.length || dragging) return;
      const sig = JSON.stringify([ctx.dataVersion, rows.map((r, i) => [geomKey(route[i], route[i + 1]), r.alt, r.prevAlt, r.fixed ? 1 : 0, r.dist])]);
      if (sig === lastSafeSig) return;
      lastSafeSig = sig;
      const prof = S.legProfile(rows.map((r) => ({ dist: r.rawDist, alt: r.alt, prevAlt: r.prevAlt })));
      const aptOk = ctx.sources.airports && ctx.sources.airports.ok !== false;
      const fields = aptOk ? candidateFields() : [];
      const conflicts = {}, glide = {}, notes = [];
      const termApts = [state.dep, state.dest].filter((v, k, arr) => arr.indexOf(v) === k).map((code) => { const ap = aptOf(code), c = aptCoord(code); return ap && c ? { ident: ap.icao, name: String(ap.name).split(/[,\/]/)[0].trim(), lat: c.lat, lon: c.lon } : null; }).filter(Boolean);
      rows.forEach((r, i) => {
        const a = route[i], b = route[i + 1];
        conflicts[r.id] = ctx.data.airspace.length ? S.airspaceConflicts(a, b, prof[i], airNear(a, b), { groundFt: 0, airports: termApts }) : [];
        if (aptOk && fields.length) {
          const g = S.glide(a, b, (nm) => S.altAt(prof[i], nm), fields, 1);
          glide[r.id] = Object.assign(g, { prof: prof[i] });
          const rec = getRec(b, a), k = [geomKey(a, b), r.alt, r.prevAlt].join("|");
          if (!rec.em || rec.em.k !== k) {
            const top = g.fields.slice().sort((x, y) => x.offNm - y.offNm).slice(0, 3);
            rec.em = { k, line: top.length ? `EMERG leg ${i + 1}: ` + top.map((f) => `${f.ident} ${Math.round(f.offNm)}NM`).join(", ") : "" };
          }
        }
        const rec2 = legRec(b, a); if (rec2 && rec2.em && rec2.em.line) notes.push(rec2.em.line);
      });
      const out = JSON.stringify([conflicts, Object.keys(glide).map((k) => [k, glide[k].gaps, glide[k].fields.map((f) => f.ident)]), notes]);
      ctx.conflicts = conflicts; ctx.glide = glide;
      const notesChanged = JSON.stringify(notes) !== JSON.stringify(ctx.notes);
      ctx.notes = notes;
      drawAirspace(); drawGlide();
      if (out !== lastOut || notesChanged) { lastOut = out; window.OfpPage.refresh(); }
    }
    const fmtAlt = (v, ref) => (v >= 99999 ? "UNL" : ref === "SFC" ? (v ? v + " AGL" : "SFC") : String(v));
    const AS_STYLE = {
      B: { color: "#1f5fbf", weight: 2.5 }, C: { color: "#b0237a", weight: 2.5 }, D: { color: "#1f5fbf", weight: 1.8, dashArray: "6 5" },
      R: { color: "#c0392b", weight: 2 }, P: { color: "#c0392b", weight: 2.5 }, W: { color: "#c0392b", weight: 1.5, dashArray: "4 4" },
      MOA: { color: "#9a2b8f", weight: 1.5, dashArray: "8 4" }, ALERT: { color: "#b5651d", weight: 1.5, dashArray: "4 4" }, DNGR: { color: "#c0392b", weight: 1.5, dashArray: "4 4" },
      MODEC: { color: "#667", weight: 1, dashArray: "2 4" },
    };
    const AS_LABEL = { MODEC: "Mode C veil", R: "Restricted", P: "Prohibited", MOA: "MOA", ALERT: "Alert", W: "Warning", DNGR: "Danger" };
    function drawAirspace() {
      layers.airspace.clearLayers();
      ctx.data.airspace.forEach((a) => {
        const st = AS_STYLE[a.cls]; if (!st) return;
        const txt = `${esc(a.name)} · ${AS_LABEL[a.cls] || "Class " + a.cls}<br>${fmtAlt(a.lowerFt, a.lowerRef)} to ${fmtAlt(a.upperFt, "MSL")} ft${a.hours ? "<br>" + esc(a.hours) : ""}<br><i>Verify on chart</i>`;
        const p = L.polygon(a.rings, Object.assign({ fillOpacity: 0.04, fillColor: st.color, opacity: 0.85 }, st));
        p.bindTooltip(txt, { sticky: true });
        p.on("contextmenu", (e) => { L.DomEvent.stop(e); L.popup().setLatLng(e.latlng).setContent(txt).openOn(map); });
        p.addTo(layers.airspace);
      });
    }
    function drawGlide() {
      layers.glide.clearLayers(); layers.emergency.clearLayers();
      const route = calc.route, rows = calc.rows; if (!route) return;
      const seen = new Set();
      rows.forEach((r, i) => {
        const g = ctx.glide[r.id]; if (!g) return;
        const a = route[i], b = route[i + 1], len = Nav.dist(a, b), course = Nav.brg(a, b), left = [], right = [];
        const n = Math.max(1, Math.ceil(len / 2));
        for (let k = 0; k <= n; k++) {
          const p = len < 1e-9 ? a : Nav.along(a, b, k / n), reach = Nav.glideReachNm(S.altAt(g.prof, len * k / n), 0);
          left.push(ll(Nav.offset(p, course - 90, reach))); right.push(ll(Nav.offset(p, course + 90, reach)));
        }
        L.polygon(left.concat(right.reverse()), { color: "#2e8b57", weight: 1, fillColor: "#2e8b57", fillOpacity: 0.12, interactive: false }).addTo(layers.glide);
        g.gaps.forEach((gp) => L.polyline([ll(Nav.along(a, b, Math.min(1, gp.fromNm / len))), ll(Nav.along(a, b, Math.min(1, Math.max(gp.toNm, gp.fromNm + 0.5) / len)))], { color: "#d62d20", weight: 8, opacity: 0.7, interactive: false }).addTo(layers.glide));
        g.fields.forEach((f) => {
          if (seen.has(f.ident)) return; seen.add(f.ident);
          L.circleMarker([f.lat, f.lon], { radius: 11, color: "#e07a10", weight: 2.5, fill: false, bubblingMouseEvents: false })
            .bindTooltip(`${esc(f.ident)}${f.name ? " " + esc(f.name) : ""}${isNum(f.elev) ? " · " + Math.round(f.elev) + " ft" : ""}<br>leg ${i + 1}: ${f.offNm} NM off track · verify on chart`).addTo(layers.emergency);
        });
      });
    }
    // ---- chart-prep marks (B02 p44/p88), on screen only. Positions are geographic, sizes are screen pixels.
    const TK = 14, ARR_OFF = 38;
    function prepIcon(cls, w, h, html, dx, dy) { // marker centred on the point, shifted by (dx,dy) screen px
      return L.divIcon({ className: cls, html, iconSize: [w, h], iconAnchor: [w / 2 - (dx || 0), h / 2 - (dy || 0)] });
    }
    function drawPrep() {
      layers.prep.clearLayers();
      const route = calc.route, rows = calc.rows; if (!route || !rows.length || dragging) return;
      const prof = S ? S.legProfile(rows.map((r) => ({ dist: r.rawDist, alt: r.alt, prevAlt: r.prevAlt }))) : [];
      const add = (m) => m.addTo(layers.prep);
      const mk = (pt, icon) => add(L.marker(map.layerPointToLatLng(pt), { icon, interactive: false, keyboard: false }));
      rows.forEach((r, i) => {
        const a = route[i], b = route[i + 1], len = r.rawDist;
        if (i < rows.length - 1) L.circle(ll(b), { radius: 1852, color: "#c2188a", weight: 2, fill: false, interactive: false }).addTo(layers.prep);
        if (!(len >= 0.2)) return;
        const pa = map.latLngToLayerPoint(ll(a)), pb = map.latLngToLayerPoint(ll(b));
        const sl = pa.distanceTo(pb);
        if (sl > 1) {
          const ux = (pb.x - pa.x) / sl, uy = (pb.y - pa.y) / sl, nx = -uy, ny = ux; // n = right of the direction of flight on screen
          const at = (d) => L.point(pa.x + ux * sl * d / len, pa.y + uy * sl * d / len);
          const tickAt = (p, side, label) => {
            const s = side * TK, W = 2 * TK + 8, c = W / 2;
            const x2 = (c + nx * s).toFixed(1), y2 = (c + ny * s).toFixed(1);
            mk(p, prepIcon("pTick", W, W, `<svg width="${W}" height="${W}" viewBox="0 0 ${W} ${W}"><line x1="${c}" y1="${c}" x2="${x2}" y2="${y2}" stroke="#fff" stroke-width="4.5"/><line x1="${c}" y1="${c}" x2="${x2}" y2="${y2}" stroke="#111" stroke-width="2"/></svg>`));
            if (label) mk(p, prepIcon("pTxt", 30, 14, `<span>${label}</span>`, nx * side * (TK + 11), ny * side * (TK + 9)));
          };
          if (len >= 3) {
            // 10 NM distance-remaining ticks counted back from the next checkpoint, LEFT of the course
            for (let d = 10; d < len - 0.5; d += 10) tickAt(at(len - d), -1, String(d));
            // 2-minute ticks from the leg start, RIGHT of the course; every second one labelled
            let step = null;
            if (!r.fixed && isNum(r.gs) && r.gs > 0) step = r.gs * 2 / 60; else if (isNum(r.eet) && r.eet > 0) step = len / r.eet * 2;
            if (step && step > 0) for (let k = 1, d = step; d < len - step * 0.3 && k < 200; k++, d = step * (k)) tickAt(at(d), 1, k % 2 === 0 ? Nav.fmtEet(2 * k) : "");
          }
          // leg arrow with 1 | MC | EET | MSA/100
          const segs = [String(i + 1), p3(r.mc), isNum(r.eet) ? Nav.fmtEet(r.eet) : "?", isNum(r.msa) ? String(Math.round(r.msa / 100)).padStart(2, "0") : "?"];
          const ws = segs.map((s) => s.length * 6.8 + 12), tw = ws.reduce((x, y) => x + y, 0);
          let A = Math.min(sl * 0.45, tw + 40), compact = A < tw + 10;
          if (compact) A = tw + 18;
          const W = Math.ceil(A + 20), H = 40, c = [W / 2, H / 2], th = Math.atan2(uy, ux) * 180 / Math.PI, flip = Math.abs(th) > 90;
          let x = -tw / 2, txt = "", dv = "";
          segs.forEach((s, k) => { txt += `<text x="${(x + ws[k] / 2).toFixed(1)}" y="4" text-anchor="middle">${s}</text>`; x += ws[k]; if (k < segs.length - 1) dv += `<line class="dv" x1="${x.toFixed(1)}" y1="-7" x2="${x.toFixed(1)}" y2="7"/>`; });
          const h = A / 2, e = compact ? tw / 2 + 9 : h;
          const sh = (x1, x2) => x2 - x1 > 0.5 ? `<line x1="${x1}" y1="0" x2="${x2}" y2="0"/>` : "";
          const lines = (compact ? "" : sh(-h, -tw / 2) + `<line x1="${-h}" y1="-5" x2="${-h}" y2="5"/>`) + sh(compact ? tw / 2 : tw / 2, e - 1) + `<polygon points="${e},0 ${e - 9},-4.5 ${e - 9},4.5" />`;
          const svg = `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}"><g transform="translate(${c[0]},${c[1]}) rotate(${th.toFixed(1)})">`
            + `<g class="aw" stroke="#fff" stroke-width="4.5" fill="#fff" stroke-linejoin="round">${lines}</g><g class="ak" stroke="#111" stroke-width="2" fill="#111">${lines}</g>`
            + `<g${flip ? ' transform="rotate(180)"' : ""}>${dv}<g class="at">${txt}</g></g></g></svg>`;
          const cen = L.point(pa.x + (pb.x - pa.x) * 0.3 + nx * ARR_OFF, pa.y + (pb.y - pa.y) * 0.3 + ny * ARR_OFF); // before the middle: drawLegs' label sits there
          mk(cen, prepIcon("pArrow", W, H, svg));
        }
        // highest elevation
        const hi = ctx.msaHigh[r.id];
        if (hi) L.marker([hi.lat, hi.lon], { icon: L.divIcon({ className: "", html: `<div class="hiMk">▲ ${Math.round(hi.ft)}</div>`, iconSize: [0, 0] }) }).bindTooltip("Highest point near leg " + (i + 1) + " (verify on chart)").addTo(layers.prep);
        // TOC / TOD
        (prof[i] || []).forEach((sg) => {
          const pm = (nm, t) => L.marker(ll(Nav.along(a, b, Math.min(1, nm / len))), { icon: L.divIcon({ className: "", html: `<div class="prepMk">${t}</div>`, iconSize: [0, 0] }), interactive: false }).addTo(layers.prep);
          if (sg.altTo > sg.altFrom + 1 && sg.distTo > 0.5) pm(sg.distTo, "TOC");
          if (sg.altTo < sg.altFrom - 1) pm(sg.distFrom, "TOD");
        });
      });
    }
    map.on("zoomend", () => { if (calc.route) drawPrep(); });

    // ---- altitude recommender (the ▾ button in the Alt cell)
    hooks.altOptions = async (id) => {
      const i = calc.rows.findIndex((r) => r.id === id), r = calc.rows[i];
      if (!r || r.fixed || !S) return toast("No altitude options for this leg");
      const a = calc.route[i], b = calc.route[i + 1], pt = ptById(id), mid = Nav.mid(a, b), tms = legMs(id);
      const alts = Nav.semicircularAlts(r.mc, 3000, 12500);
      toast("Loading winds for the options…");
      const ws = {};
      if (D) await Promise.all(alts.map(async (alt) => { const w = await D.windsAloft({ lat: mid.lat, lon: mid.lon, timeMs: tms, altFt: alt }); if (w.ok) ws[alt] = w.data; }));
      const haveW = Object.keys(ws).length > 0, v = Nav.variation(mid, flightDate()), manual = windFor(pt, a, r.alt);
      const env = {
        msa: effMsa(pt), airspaces: airNear(a, b), extra: [r.alt],
        winds: (alt) => { const w = ws[alt]; return w ? { dir: Math.round(Nav.norm360(w.dir - v)), spd: w.spd } : manual ? { dir: manual.dir, spd: manual.spd } : null; },
        cruise: (alt) => { const w = ws[alt], isa = state.isaAuto && w && isNum(w.tempC) ? Math.round(w.tempC - Perf.isaTemp(alt)) : isNum(state.isaDev) ? state.isaDev : 0; const p = perfAt(alt, isa); return { tas: p.tas, ff: p.ff }; },
      };
      const list = S.recommendAlts({ a, b, mc: r.mc, dist: r.rawDist, prevAlt: r.prevAlt, groundFt: 0 }, env);
      const rowsH = list.map((o) => `<tr><td><b>${o.alt}</b>${o.alt === r.alt ? " (now)" : ""}</td><td class="${o.ok ? "okc" : "err"}">${o.ok ? (o.rec ? "recommended" : "ok") : esc([...new Set(o.reasons)].join("; "))}</td><td>${o.gs == null ? "–" : o.gs}</td><td>${o.eet == null ? "–" : Nav.fmtEet(o.eet)}</td><td>${o.fuel == null ? "–" : o.fuel.toFixed(1)}</td><td><button type="button" class="sm" data-v="use:${o.alt}">Use</button></td></tr>`).join("");
      const res = await dialog(`<h3>Altitude options, leg ${i + 1} to ${esc(r.name)} (MC ${p3(r.mc)})</h3>
        <p class="note">Semicircular altitudes. MSA ${isNum(env.msa) ? env.msa + " ft" + (isNum(pt.msa) ? " (entered)" : " (automatic, verify on chart)") : "unknown, enter it by hand"}. ${haveW ? "Winds: Open-Meteo forecast at each altitude." : "Forecast winds unavailable: the entered wind is used."}</p>
        <div style="overflow:auto"><table class="legs" style="min-width:0"><thead><tr><th>Alt</th><th>Check</th><th>GS</th><th>EET</th><th>Fuel</th><th></th></tr></thead><tbody>${rowsH || '<tr><td colspan="6">No candidates</td></tr>'}</tbody></table></div>
        <div class="btns"><button type="button" data-v="auto">Automatic altitude</button><button type="button" data-v="x">Close</button></div>`);
      const m = /^use:(\d+)$/.exec(res.v || "");
      if (m) { pt.alt = +m[1]; changed(false); } else if (res.v === "auto") { pt.alt = null; changed(false); }
    };

    /* ---- weather and TFR checks along the route: warnings only, never blocking ---- */
    // Legs for Safety: times from T/O (planMs) plus the EETs of the current calculation. Hazards, PIREPs, TFRs and dep/dest METAR/TAF
    // come from OfpData (aviationweather.gov and tfr.faa.gov through our relays); results are kept in ctx.wx and only redrawn on change.
    let wxTimer = null, wxGen = 0, lastWxSig = "", wxBusy = false;
    function wxLegs() {
      const route = calc.route, rows = calc.rows; if (!S || !route || !rows.length) return [];
      const prof = S.legProfile(rows.map((r) => ({ dist: r.rawDist, alt: r.alt, prevAlt: r.prevAlt })));
      const t0 = planMs(); let cum = 0;
      return rows.map((r, i) => { const e = isNum(r.eet) ? r.eet : 0, lg = { i, a: route[i], b: route[i + 1], profile: prof[i], startMs: t0 + 60000 * cum, endMs: t0 + 60000 * (cum + e) }; cum += e; return lg; });
    }
    function wxSig() {
      const legs = wxLegs(); if (!legs.length) return "";
      return JSON.stringify([state.dep, state.dest, Math.round(planMs() / 600000), Math.round(legs[legs.length - 1].endMs / 600000), calc.rows.map((r, i) => [geomKey(calc.route[i], calc.route[i + 1]), r.alt])]);
    }
    function scheduleWx(force) { clearTimeout(wxTimer); wxTimer = setTimeout(() => ensureWx(force), force ? 0 : 1200); }
    async function ensureWx(force) {
      const my = ++wxGen, legs = wxLegs(), route = calc.route;
      if (!D || !D.hazards || !legs.length) return;
      wxBusy = true; renderAutoStatus();
      try {
        const lats = route.map((p) => p.lat), lons = route.map((p) => p.lon), pad = 0.1;
        const bb = { s: Math.min(...lats) - pad, n: Math.max(...lats) + pad, w: Math.min(...lons) - pad, e: Math.max(...lons) + pad };
        const depId = icaoOf(state.dep) || state.dep, destId = icaoOf(state.dest) || state.dest;
        const [hz, pr, tf, dm, am] = await Promise.all([D.hazards(bb, force), D.pireps(bb, force), D.tfrs(D.statesFor(bb), force), D.metarTaf(depId, force, aptCoord(state.dep)), depId === destId ? null : D.metarTaf(destId, force, aptCoord(state.dest))]);
        if (my !== wxGen) return;
        const t0 = legs[0].startMs, t1 = legs[legs.length - 1].endMs, nowMs = Date.now(), far = t0 - nowMs > 12 * 3600e3;
        const mid = Nav.mid(route[0], route[route.length - 1]);
        const gnd = Nav.dist(mid, aptCoord(state.dep) || mid) <= Nav.dist(mid, aptCoord(state.dest) || mid) ? aptElev(state.dep) : aptElev(state.dest);
        const items = (hz.data || []).concat(tf.data || []);
        const hits = S.hazardHits(legs, items, { groundFt: gnd });
        const pirs = S.pirepsNear(legs, pr.data || [], 25).filter((x) => x.turb || x.ice);
        // A TAF borrowed from the nearest airport (own airport has none, e.g. KGYR) is named in the text: "KGYR (TAF KLUF, 8 NM): ..."
        const wxOf = (r, id, eta) => {
          if (!(r && r.ok)) return [{ level: "info", text: `${id}: METAR/TAF unavailable - check your official briefing`, code: "wxMissing" }];
          const tf = r.data.tafFrom, pre = (c) => (tf && /^TAF/.test(c.text) ? `${id} (TAF ${tf.id}, ${tf.distNm} NM)` : id);
          const out = S.vfrWx(r.data.metars, r.data.taf, eta, { ceilFt: 3000, visSm: 5, nowMs: eta }).map((c) => ({ level: c.level === "warn" ? "warn" : "info", text: pre(c) + ": " + c.text, code: c.code }));
          if (tf) out.push({ level: "info", text: `${id} has no TAF - using the nearest one, ${tf.id} (${tf.distNm} NM)`, code: "tafNearest" });
          return out;
        };
        const depWx = wxOf(dm, depId, t0), destWx = wxOf(am || dm, destId, t1);
        const ck = [], rowId = (i) => (calc.rows[i] ? calc.rows[i].id : null);
        const add = (level, text, leg, code) => ck.push({ level, text, code, leg: leg == null ? null : leg + 1, id: leg == null ? null : rowId(leg) });
        const seen = new Set();
        hits.forEach((h) => {
          const key = h.leg + "|" + h.item.kind + "|" + h.item.id; if (h.item.kind === "TFR" && seen.has(key)) return; seen.add(key);
          const lab = S.hazardLabel(h.item), where = h.lastNm - h.firstNm < 0.5 ? `at ${h.firstNm} NM` : `${h.firstNm}–${h.lastNm} NM along the leg`;
          if (h.item.kind === "TFR") add("warn", `Leg ${h.leg + 1} passes through ${lab}${h.item.name ? " (" + h.item.name + ")" : ""}, ${where}, active at your time${h.item.agl ? `; AGL limits use ${Math.round(gnd)} ft ground (verify)` : ""}`, h.leg, "tfr");
          else add("warn", `Leg ${h.leg + 1} crosses ${lab}, ${where}`, h.leg, "hazard");
        });
        const ageMin = (p) => Math.max(0, Math.round((nowMs - p.obsTime * 1000) / 60000));
        pirs.slice(0, 8).forEach((x) => {
          const p = x.pirep, what = [x.turb ? `${[p.tbInt1, p.tbInt2].filter((v) => v && !/^NEG/i.test(v))[0] || ""} TURB`.trim() : "", x.ice ? `${[p.icgInt1, p.icgInt2].filter((v) => v && !/^NEG/i.test(v))[0] || ""} ICE`.trim() : ""].filter(Boolean).join(" ");
          add("info", `PIREP near leg ${x.leg + 1}: ${what}${isNum(+p.fltLvl) && p.fltLvl !== null && p.fltLvl !== "" ? " FL" + String(Math.round(p.fltLvl)).padStart(3, "0") : ""} (${isNum(p.obsTime) ? ageMin(p) + " min ago" : "age unknown"}, ${x.distNm} NM from track)`, x.leg, "pirep");
        });
        if (pirs.length > 8) add("info", `${pirs.length - 8} more PIREPs with turbulence or ice near the route (see the map)`, null, "pirepMore");
        const wxSeen = new Set();
        [...depWx, ...destWx].forEach((c) => { if (!wxSeen.has(c.text)) { wxSeen.add(c.text); add(c.level, c.text, null, c.code); } });
        if (!hz.ok) add("info", "Weather hazards unavailable – check your official briefing", null, "wxHazMissing");
        else if (hz.partial) add("info", "Some weather hazard products (SIGMET/G-AIRMET/CWA) did not load – check your official briefing", null, "wxHazPartial");
        if (!pr.ok) add("info", "PIREPs unavailable – check your official briefing", null, "wxPirepMissing");
        if (!D.statesFor(bb).length) add("info", "TFRs are only checked for AZ, CA, NV, UT, NM, CO and TX – check TFRs for this route in your briefing", null, "tfrArea");
        else if (!tf.ok) add("info", "TFRs unavailable – check your official briefing", null, "tfrMissing");
        else if (tf.partial) add("info", "Some TFR details did not load – check your official briefing", null, "tfrPartial");
        if (far) add("info", "Hazard forecasts don't cover your flight time yet – refresh closer to departure", null, "wxFar");
        add("info", "Weather checks are a planning aid – get an official briefing (1800wxbrief/ForeFlight)", null, "wxAid");
        ctx.wx = { hits, pireps: pirs, depWx, destWx, items, pirepList: pr.data || [], t0, t1, sources: { hazards: srcInfo(hz), pireps: srcInfo(pr), tfrs: srcInfo(tf), metar: srcInfo(dm) } };
        ctx.wxSources = ctx.wx.sources; ctx.wxChecks = ck;
        drawWx();
      } catch (e) { console.error(e); }
      finally { if (my === wxGen) { wxBusy = false; renderAutoStatus(); renderChecks(); } }
    }
    const WX_STYLE = { SIGMET: { color: "#d32f2f", dashArray: "7 5", fillOpacity: 0.07 }, CSIGMET: { color: "#d32f2f", dashArray: "7 5", fillOpacity: 0.09 }, CWA: { color: "#d32f2f", dashArray: "3 4", fillOpacity: 0.06 },
      AIRMET: { color: "#f9a825", dashArray: "7 5", fillOpacity: 0.06 }, TFR: { color: "#d32f2f", fillOpacity: 0.14 } };
    function drawWx() {
      layers.wx.clearLayers();
      const w = ctx.wx; if (!w) return;
      const t0 = w.t0, t1 = w.t1, tm = (t0 + t1) / 2;
      w.items.forEach((it) => {
        if ((isNum(it.to) && it.to < t0 - 3600e3) || (isNum(it.from) && it.from > t1 + 3600e3)) return;   // not active around the flight
        let polys = it.polys || [];
        if (it.snapshots && it.snapshots.length) polys = it.snapshots.slice().sort((a, b) => Math.abs(a.validMs - tm) - Math.abs(b.validMs - tm))[0].polys;
        const st = Object.assign({ weight: it.kind === "TFR" ? 2.2 : 1.8, opacity: 0.9, fillColor: (WX_STYLE[it.kind] || WX_STYLE.SIGMET).color, pane: "wxPane" }, WX_STYLE[it.kind] || WX_STYLE.SIGMET);
        const txt = `<b>${esc(S.hazardLabel(it))}</b>${it.name ? "<br>" + esc(it.name) : ""}${it.raw ? "<br>" + esc(String(it.raw).replace(/\s+/g, " ").slice(0, 200)) : ""}<br><i>Planning aid: verify in your briefing</i>`;
        const shapes = polys.map((r) => L.polygon(r, st)).concat((it.circles || []).map((c) => L.circle([c.lat, c.lon], Object.assign({ radius: c.radiusNm * 1852 }, st))));
        shapes.forEach((sh) => {
          sh.bindTooltip(txt, { sticky: true });
          sh.on("contextmenu", (e) => { L.DomEvent.stop(e); L.popup().setLatLng(e.latlng).setContent(txt).openOn(map); });
          sh.addTo(layers.wx);
        });
      });
      (w.pirepList || []).forEach((p) => {
        const has = (a, b) => [a, b].some((v) => v && !/^NEG/i.test(String(v)));
        const tb = has(p.tbInt1, p.tbInt2), ic = has(p.icgInt1, p.icgInt2); if (!tb && !ic) return;
        const sev = /SEV|EXTRM/i.test([p.tbInt1, p.tbInt2].join(" ")) ? "#b71c1c" : tb ? (/MOD/i.test([p.tbInt1, p.tbInt2].join(" ")) ? "#ef6c00" : "#f9a825") : "#1976d2";
        L.circleMarker([p.lat, p.lon], { radius: 5, color: "#222", weight: 1, fillColor: sev, fillOpacity: 0.95, pane: "wxPane" })
          .bindTooltip(`PIREP: ${esc(String(p.rawOb || "").slice(0, 200))}`, { sticky: true }).addTo(layers.wx);
      });
    }

    hooks.afterCompute.push(() => {
      renderAutoStatus();
      if (dragging) return;
      drawPrep();
      const ws = wxSig();
      if (ws && ws !== lastWxSig) { lastWxSig = ws; scheduleWx(false); }
      const ds = dataSig();
      if (ds && ds !== lastDataSig) { lastDataSig = ds; scheduleData(false); }
      computeSafetySoon();
    });

    /* ===================================================== HOOKS (step 3) ===================================================== */
    // window.OfpPage is the contract for OfpData / Safety. Fill ctx.*, then call refresh().
    window.OfpPage = {
      state: () => state, ctx, layers, map, L, hooks,
      calc: () => calc,                    // {route, rows, out, header, sig, checks}; rows[i].id is the point id
      refresh: () => compute(),            // recompute and redraw after changing ctx
      route: () => calc.route,
      toast, esc, dialog, perfAt, zoomLeg, setSheet,
      containers: { checks: byId("autochecks"), legs: byId("legs") },
    };
    window.dispatchEvent(new Event("ofp-ready"));

    /* ===================================================== boot ===================================================== */
    bindFields(); syncFields(); syncChrome(); renderProcSelects(); renderWindNote();
    compute();
    document.body.classList.remove("booting");
    map.invalidateSize();
    requestAnimationFrame(() => map.invalidateSize());
    window.addEventListener("load", () => map.invalidateSize());
    (async () => {
      await loadAirports();
      renderLibrary();
      await loadWaypoints();
      const c = state.mid.length ? null : aptCoord(state.dep);
      if (state.mid.length && calc.route) map.fitBounds(L.latLngBounds(calc.route.map(ll)).pad(0.25), { maxZoom: 11 });
      else if (c) map.setView([c.lat, c.lon], 10);
      compute(); renderProcSelects();
    })();
  }
})();
