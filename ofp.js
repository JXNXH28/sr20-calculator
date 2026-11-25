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
      solo: true, night: false, dep: "KGYR", dest: "KGYR", takeoffFuel: 45, pwr: 75, isaDev: 0, cruiseFfOv: null,
      windMode: "single", wind: { dir: null, spd: null }, depProc: null, arrProc: null, mid: [], seq: 0, notes: "",
      destPt: { alt: null, msa: null, wind: null, rem: Object.assign(blankRem(), { fullStop: true }) },
    });
    function normState(s) {
      const b = blankState(), o = Object.assign(b, s || {});
      o.crew = [0, 1, 2].map((i) => String((s && s.crew && s.crew[i]) || ""));
      o.wind = Object.assign({ dir: null, spd: null }, (s && s.wind) || {});
      o.destPt = Object.assign(b.destPt, (s && s.destPt) || {});
      o.destPt.rem = Object.assign(blankRem(), o.destPt.rem || {});
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
    const ctx = { airports: {}, msaAuto: {}, msaHigh: {}, windAuto: {}, conflicts: {}, glide: {}, groundFt: {}, checks: [], notes: [], unavailable: {} };
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
      byId("secAto").hidden = profile.role !== "admin";
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

    async function loadWaypoints() {
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
      renderLibrary(); renderProcSelects(); renderAto(); compute();
    }

    /* ===================================================== map ===================================================== */
    L.Icon.Default.imagePath = "vendor/images/";
    const map = L.map("map", { zoomControl: true, maxZoom: 14, minZoom: 5, tap: true, doubleClickZoom: false }).setView([33.42, -112.38], 10);
    const tileOpts = { maxNativeZoom: 12, maxZoom: 14, attribution: "FAA", keepBuffer: 3 };
    const tiles = { tac: L.tileLayer(tileUrl("VFR_Terminal"), tileOpts), sect: L.tileLayer(tileUrl("VFR_Sectional"), tileOpts) };
    let baseMode = ["auto", "tac", "sect"].includes(lsGet("ofp.base")) ? lsGet("ofp.base") : "auto";
    let tacBad = null, tacErr = 0, curBase = null;
    function applyBase() {
      const want = baseMode === "tac" ? "tac" : baseMode === "sect" ? "sect" : tacBad || map.getZoom() < 10 ? "sect" : "tac";
      if (want !== curBase) {
        if (curBase) map.removeLayer(tiles[curBase]);
        tiles[want].addTo(map); tiles[want].bringToBack(); curBase = want;
      }
      $$("#mapctl [data-base]").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.base === baseMode)));
    }
    tiles.tac.on("tileerror", () => {
      if (baseMode !== "auto" || tacBad) return;
      if (++tacErr >= 4) { tacBad = map.getCenter(); applyBase(); toast("No TAC tiles here, showing the sectional"); }
    });
    map.on("zoomend", () => { tacErr = 0; applyBase(); map.getContainer().classList.toggle("zlow", map.getZoom() < 9); });
    map.on("moveend", () => {
      tacErr = 0;
      if (tacBad && Nav.dist({ lat: tacBad.lat, lon: tacBad.lng }, { lat: map.getCenter().lat, lon: map.getCenter().lng }) > 40) { tacBad = null; applyBase(); }
    });
    $$("#mapctl [data-base]").forEach((b) => b.addEventListener("click", () => { baseMode = b.dataset.base; lsSet("ofp.base", baseMode); tacBad = null; tacErr = 0; applyBase(); }));
    applyBase();

    // One layer group per overlay. Step 3 fills airspace / glide / prep / emergency (and may add its own).
    const layers = {};
    const LAYER_DEFS = [
      ["legs", "Route", true, true], ["ato", "ATO points", true], ["personal", "Personal points", true], ["airports", "Airports", true],
      ["airspace", "Airspace", true], ["glide", "Glide band", false], ["prep", "Chart prep", true], ["emergency", "Emergency fields", false],
    ];
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
    byId("lays").addEventListener("change", (e) => {
      const k = e.target.dataset.layer; if (!k) return;
      layerOn[k] = e.target.checked; lsSet("ofp.layers", JSON.stringify(layerOn));
      if (e.target.checked) layers[k].addTo(map); else map.removeLayer(layers[k]);
    });
    map.getContainer().classList.toggle("zlow", map.getZoom() < 9);

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
    const procOf = (id) => ATO.procedures.find((p) => p.id === id) || null;
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
      if (p.proc === "dep") state.depProc = null;
      if (p.proc === "arr") state.arrProc = null;
      state.mid.splice(i, 1); changed(true);
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
    function perfAt(alt) {
      const k = [alt, state.isaDev, state.pwr].join("|");
      if (!perfCache.has(k)) perfCache.set(k, Perf.cruise({ pa: alt, isaDev: isNum(state.isaDev) ? state.isaDev : 0, pwr: isNum(state.pwr) ? state.pwr : 75 }));
      return perfCache.get(k);
    }
    const effMsa = (pt) => (isNum(pt.msa) ? pt.msa : isNum(ctx.msaAuto[pt.id]) ? ctx.msaAuto[pt.id] : null);
    function windFor(pt) {
      const own = state.windMode === "leg" ? pt.wind : state.windMode === "auto" ? ctx.windAuto[pt.id] || null : null;
      if (own && isNum(+own.dir) && isNum(+own.spd) && own.dir !== "" && own.spd !== "") return { dir: +own.dir, spd: +own.spd, src: state.windMode === "auto" ? "auto forecast" : "entered for this leg" };
      const w = state.wind;
      if (isNum(w.dir) && isNum(w.spd)) return { dir: w.dir, spd: w.spd, src: "entered (one MAG W/V)" };
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
      if (isLast && depP && depP.extraMinDest && depP.extraMinDest[icaoOf(state.dest)]) p.airwork += depP.extraMinDest[icaoOf(state.dest)];
      return p.touchGo || p.taxiBack || p.fullStop || p.airwork ? p : undefined;
    }
    let calc = { route: null, rows: [], out: null, header: {}, sig: "", message: "" };

    function buildRows(route) {
      const date = flightDate(), rows = [], depP = state.depProc ? procOf(state.depProc) : null, arrP = state.arrProc ? procOf(state.arrProc) : null;
      let prevAlt = aptElev(state.dep) + 1000;
      for (let i = 1; i < route.length; i++) {
        const a = route[i - 1], b = route[i], last = i === route.length - 1;
        const raw = Nav.dist(a, b), mc = Nav.magCourse(a, b, date);
        const proc = b.proc === "dep" ? depP : a.proc === "arr" ? arrP : null;
        const fixed = proc && proc.min != null && proc.nm != null ? { min: proc.min, nm: proc.nm } : null;
        const msa = effMsa(b);
        let alt = isNum(b.alt) ? b.alt : b.proc === "dep" && depP && depP.alt ? depP.alt : defaultAlt(mc, msa, last);
        const perf = perfAt(alt), w = windFor(b);
        const dist = fixed ? fixed.nm : raw < 0.05 ? 0 : Math.max(1, Math.round(raw));
        const row = {
          id: b.id, pt: b, name: b.name, ident: b.ident && b.ident !== b.name ? b.ident : null, dist, rawDist: raw, mc, alt, altAuto: !isNum(b.alt), prevAlt, msa,
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
      return perfAt(best ? best.alt : 5500).ff;
    }
    const fmtDate = (d) => { const m = /^(\d{4})-(\d\d)-(\d\d)$/.exec(d || ""); return m ? `${+m[3]} ${["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"][+m[2] - 1]} ${m[1].slice(2)}` : ""; };
    const hhmm = (v) => { const s = String(v || "").replace(/\D/g, ""); return s.length >= 3 ? s.padStart(4, "0").slice(0, 4) : ""; };

    function compute() {
      const route = routePoints();
      calc = { route, rows: [], out: null, header: {}, sig: "", message: "" };
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
      const tasLines = alts.map((a) => { const p = perfAt(a); return `${a}: ${p.tas} KT / ${p.ff} GPH`; });
      const lines = []; let cur = "";
      tasLines.forEach((t) => { if (cur && (cur + "   " + t).length > 54) { lines.push(cur); cur = t; } else cur = cur ? cur + "   " + t : t; });
      if (cur) lines.push(cur);
      const note = String(state.notes || "").trim();
      const w = state.wind, single = state.windMode === "single" && isNum(w.dir) && isNum(w.spd);
      const onBlock = hhmm(state.offBlock) && isNum(state.blockMin) ? Nav.addHHMM(hhmm(state.offBlock), state.blockMin) : "";
      return {
        from: icaoOf(state.dep) || state.dep, to: icaoOf(state.dest) || state.dest, offBlock: hhmm(state.offBlock), onBlock, toTime: hhmm(state.toTime),
        callsign: state.callsign, reg: state.reg, cruiseFf, magWind: single ? `${String(Math.round(w.dir)).padStart(3, "0")}/${String(Math.round(w.spd)).padStart(2, "0")}` : "",
        alt: alts.length > 2 ? alts[0] + "-" + alts[alts.length - 1] : alts.join("/"), date: fmtDate(state.date), mission: state.mission, crew: state.crew.slice(),
        takeoffFuel: isNum(state.takeoffFuel) ? state.takeoffFuel : "", notes: [...lines, ...(note ? [note] : []), ...ctx.notes],
      };
    }
    // Basic checks that need only Nav and the airport list. Safety.checks (step 3) adds to ctx.checks.
    function basicChecks() {
      const ck = [], rows = calc.rows, t = calc.out && calc.out.totals;
      const add = (level, text, row, id) => ck.push({ level, text, leg: row != null ? row + 1 : null, id: id || (row != null && rows[row] ? rows[row].id : null) });
      if (!calc.route) return ck;
      if (rows.length > OP.MAX_LEGS) add("err", `${rows.length} legs: the form holds ${OP.MAX_LEGS}; legs after ${OP.MAX_LEGS} will not print`);
      rows.forEach((r, i) => {
        if (r.error === "wind") add("err", `${r.name}: wind too strong for ${r.tas} kt TAS on MC ${p3(r.mc)}. Check the wind.`, i);
        if (!r.fixed && r.rawDist > 30) add("warn", `${r.name}: leg is ${r1(r.rawDist)} NM, more than 30 NM (B02). Add a checkpoint.`, i);
        if (!r.fixed && !Nav.semicircularOk(r.mc, r.alt, ctx.groundFt[r.id] || 0)) add("warn", `${r.name}: ${r.alt} ft does not follow the semicircular rule for MC ${p3(r.mc)}.`, i);
        if (isNum(r.msa) && r.alt < r.msa && !r.fixed) add("warn", `${r.name}: ${r.alt} ft is below the MSA ${r.msa} ft.`, i);
        if (!r.hasWind && !r.fixed && state.windMode !== "auto" && r.wspd === 0 && i === 0) add("info", "No wind entered: the plan uses calm wind.");
        if (r.pt && r.pt.type === "AIRPORT") airportApproval(r.pt.ident, ck, i, r.id, r.name);
      });
      airportApproval(state.dep, ck, null, null, state.dep);
      airportApproval(state.dest, ck, rows.length ? rows.length - 1 : null, "dest", state.dest);
      if (isNum(state.takeoffFuel) && state.takeoffFuel > MAX_FUEL) add("warn", `Takeoff fuel ${state.takeoffFuel} USG is more than the ${MAX_FUEL} USG usable.`);
      if (!(isNum(state.takeoffFuel) && state.takeoffFuel > 0)) add("warn", "Enter the takeoff fuel.");
      const last = rows[rows.length - 1];
      if (last && isNum(last.plFuel) && isNum(last.minFuel) && last.plFuel < last.minFuel) add("err", `Planned fuel at ${last.name} is ${last.plFuel.toFixed(1)} USG, less than the minimum ${last.minFuel.toFixed(1)} USG.`, rows.length - 1);
      else rows.forEach((r, i) => { if (i < rows.length - 1 && isNum(r.plFuel) && isNum(r.minFuel) && r.plFuel < r.minFuel) add("warn", `${r.name}: planned fuel ${r.plFuel.toFixed(1)} is below the minimum ${r.minFuel.toFixed(1)} USG.`, i); });
      if (t && t.incomplete) add("err", "Totals are incomplete because a leg has a wind error.");
      if ((state.dep === "KGYR" && !state.depProc) && !ck.some((c) => c.text.startsWith("Departing"))) add("info", "Departing KGYR: pick an ATO departure procedure if you use one.");
      if (state.dest === "KGYR" && !state.arrProc) add("info", "Arriving KGYR: pick an ATO arrival procedure if you use one (+10 min is added with one).");
      if (!hhmm(state.toTime)) add("info", "Enter the T/O time to get the ETOs (PTO).");
      return ck;
    }
    function airportApproval(code, ck, row, id, name) {
      const a = aptOf(code); if (!a) return;
      const dual = !state.solo, miss = [];
      if (state.solo && !a.solo) miss.push("solo");
      if (dual && !a.dual) miss.push("dual");
      if (!state.night && !a.dayVfr) miss.push("day VFR");
      if (state.night && !a.nightVfr) miss.push("night VFR");
      if (miss.length && !ck.some((c) => c.text.startsWith(a.icao + " is not"))) ck.push({ level: "warn", text: `${a.icao} is not approved for ${miss.join(", ")} (THB App. A).`, leg: row != null ? row + 1 : null, id });
      if (a.lim && (a.lim.hi || a.lim.mtom) && !ck.some((c) => c.text.startsWith(a.icao + " has"))) ck.push({ level: "info", text: `${a.icao} has high-elevation limits${a.lim.mtom ? " (MTOM " + a.lim.mtom + " lb" + (a.lim.maxTemp ? ", max " + a.lim.maxTemp + " °C" : "") + ")" : ""}.`, leg: row != null ? row + 1 : null, id });
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
        const notes = [...new Set(rows.filter((r) => !r.fixed).map((r) => r.alt))].sort((a, b) => a - b).map((a) => `${a} ft: ${perfAt(a).tas} KTAS ${perfAt(a).ff} GPH`).join(" · ");
        host.insertAdjacentHTML("beforeend", `<p class="fine">Cruise ${state.pwr}% ISA${state.isaDev >= 0 ? "+" : ""}${state.isaDev}: ${esc(notes)}</p>`);
      }
    }
    function renderChecks() {
      const host = byId("checks");
      const all = (calc.checks || []).concat(ctx.checks || []);
      if (!calc.route) { host.innerHTML = ""; return; }
      const sev = { err: 0, warn: 1, info: 2 };
      all.sort((a, b) => (a.leg == null ? 99 : a.leg) - (b.leg == null ? 99 : b.leg) || sev[a.level] - sev[b.level]);
      const bad = all.filter((c) => c.level !== "info").length;
      host.innerHTML = (bad ? "" : '<div class="ok">No warnings from the basic checks.</div>') + all.map((c, i) => `<button type="button" class="ck ${esc(c.level)}" data-ck="${i}"><b>${c.leg ? "Leg " + c.leg : "Plan"}</b><span>${esc(c.text)}</span></button>`).join("");
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
    function renderProcSelects() {
      const fill = (sel, apt, kind, cur) => {
        const procs = ATO.forAirport(icaoOf(apt) || apt, kind);
        sel.disabled = !procs.length;
        sel.innerHTML = `<option value="">${procs.length ? "None" : "No ATO procedures"}</option>` + procs.map((p) => {
          const placed = ATO.usable(p, lib.byName), dualBlock = p.dualOnly && state.solo;
          const why = !placed ? " – not placed yet" : dualBlock ? " – dual only" : p.dualOnly ? " (dual only)" : "";
          const tm = p.min != null ? ` ${Nav.fmtEet(p.min)}/${p.nm} NM` : "";
          return `<option value="${esc(p.id)}"${placed && !dualBlock ? "" : " disabled"}${p.id === cur ? " selected" : ""}>${esc(p.name + tm + why)}</option>`;
        }).join("");
        if (cur && !sel.querySelector("option[selected]")) sel.value = "";
      };
      fill(byId("depProc"), state.dep, "dep", state.depProc);
      fill(byId("arrProc"), state.dest, "arr", state.arrProc);
    }
    function setProc(kind, id) {
      const key = kind === "dep" ? "depProc" : "arrProc";
      state.mid = state.mid.filter((p) => p.proc !== kind);
      state[key] = null;
      const proc = id && procOf(id);
      if (proc) {
        const w = lib.byName[proc.point];
        if (!w || !ATO.usable(proc, lib.byName)) { toast(`${proc.name}: point ${proc.point} is not placed yet`); }
        else {
          state[key] = proc.id;
          const pt = { id: newId(), name: proc.point, ident: null, type: "USER WAYPOINT", lat: w.lat, lon: w.lon, lib: "ato", wid: w.id, proc: kind, alt: null, msa: null, wind: null, rem: blankRem() };
          if (kind === "dep") state.mid.unshift(pt); else state.mid.push(pt);
        }
      }
      changed(true);
    }
    byId("depProc").addEventListener("change", (e) => setProc("dep", e.target.value));
    byId("arrProc").addEventListener("change", (e) => setProc("arr", e.target.value));

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
      const m = state.windMode, el = byId("windnote");
      $$(".wcol1").forEach((l) => (l.style.display = m === "leg" ? "none" : ""));
      el.textContent = m === "auto" ? (Object.keys(ctx.windAuto).length ? "Automatic winds from the forecast. Any leg without one uses the MAG W/V above." : "Automatic winds are not available yet: the plan uses the MAG W/V above (enter a wind).") : m === "leg" ? "Type a magnetic wind (270/10) in each leg's Wind cell. Legs without one use calm wind." : "One magnetic wind (from, kt) is used for every leg.";
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
        if (key === "dep") { state.mid = state.mid.filter((p) => p.proc !== "dep"); state.depProc = null; }
        else { state.mid = state.mid.filter((p) => p.proc !== "arr"); state.arrProc = null; state.destPt.alt = null; }
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
    byId("clearRoute").addEventListener("click", () => { state.mid = []; state.depProc = null; state.arrProc = null; changed(true); });
    function reversedState(s) {
      const n = normState(JSON.parse(JSON.stringify(s)));
      const oldDepP = n.depProc && procOf(n.depProc), oldArrP = n.arrProc && procOf(n.arrProc);
      const dep = n.dest, dest = n.dep;
      n.dep = dep; n.dest = dest;
      n.mid = n.mid.slice().reverse();
      // a procedure point flips to the matching procedure at the other airport when ATO has one, else it becomes a plain waypoint
      const flip = (old, kind, apt) => old && ATO.forAirport(icaoOf(apt) || apt, kind).find((p) => p.point === old.point && ATO.usable(p, lib.byName));
      const newDep = flip(oldArrP, "dep", dep), newArr = flip(oldDepP, "arr", dest);
      n.mid.forEach((p) => {
        if (p.proc === "dep") p.proc = newArr ? "arr" : null; else if (p.proc === "arr") p.proc = newDep ? "dep" : null;
        p.alt = null; p.msa = null; p.wind = null; p.rem = blankRem();
      });
      n.depProc = newDep ? newDep.id : null; n.arrProc = newArr ? newArr.id : null;
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
        ${(calc.checks || []).concat(ctx.checks || []).some((c) => c.level === "err") ? '<ul class="lwarn">' + (calc.checks || []).concat(ctx.checks || []).filter((c) => c.level === "err").map((c) => `<li class="err">${esc(c.text)}</li>`).join("") + "</ul>" : ""}
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
      catch (e) { toast("Could not save " + name + ": " + dbErr(e)); }
    }
    function renderAto() {
      if (profile.role !== "admin") return;
      byId("atoList").innerHTML = ATO.points.map((p) => {
        const w = lib.byName[p.name];
        return `<button type="button" data-ato="${esc(p.name)}" class="${placing === p.name ? "sel" : ""}" title="${esc(p.desc)}">${esc(p.name)}<small>${w ? "placed" : "not placed"}</small></button>`;
      }).join("");
    }
    byId("atoList").addEventListener("click", (e) => {
      const b = e.target.closest("[data-ato]"); if (!b) return;
      const w = lib.byName[b.dataset.ato];
      placing = placing === b.dataset.ato ? null : b.dataset.ato;
      byId("map").classList.toggle("placing", !!placing);
      const h = byId("mhint"); h.hidden = !placing; h.textContent = placing ? `Click the map to place ${placing}${w ? " (replaces its position)" : ""}. Click the name again to cancel.` : "";
      if (placing && w) map.setView([w.lat, w.lon], Math.max(map.getZoom(), 11));
      if (placing && window.matchMedia("(max-width:900px)").matches) setSheet("peek");
      renderAto();
    });
    async function placeAt(latlng) {
      const name = placing, p = ATO.points.find((x) => x.name === name), w = lib.byName[name];
      if (!name) return;
      placing = null; byId("map").classList.remove("placing"); byId("mhint").hidden = true;
      await saveAto(name, latlng.lat, latlng.lng, w && w.id, p && p.desc);
      await loadWaypoints();
    }

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
