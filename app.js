(function () {
  "use strict";
  // Nothing starts before sign-in: the page stays hidden (body.booting) until Auth.requireUser() resolves.
  if (!window.Auth) {
    document.body.classList.remove("booting");
    document.body.innerHTML = '<p class="unavail"><b>Sign-in service unavailable</b><br>Open this page from the server (not as a file) and reload.</p>';
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
  const Auth = window.Auth;
  const P = window.Perf,
    W = window.Wx,
    Snapshot = window.Snapshot,
    LAT = window.LAT_AIRPORTS;
  const $ = (s) => document.querySelector(s);
  const byId = (id) => document.getElementById(id);
  const esc = (s) =>
    String(s).replace(
      /[&<>"]/g,
      (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c],
    );
  const noserver = /[?&]noserver/.test(location.search);
  if (noserver) document.body.classList.add("noserver");

  /* ---------- field definitions ---------- */
  // One sheet = one "point": a takeoff ("L0", "L1", …) or the destination landing ("D").
  // [key, label, type, options]  types: t text, n number, c checkbox, s select, a textarea, d date, h time
  const SURF = [
    ["paved", "Paved"],
    ["dry", "Dry grass"],
    ["wet", "Wet grass"],
  ];
  const FLAPS = [
    ["100", "100 %"],
    ["50", "50 %"],
    ["0", "0 %"],
  ];
  const pointFields = (isD) =>
    [
      ["elev", "Elevation (ft)", "n"],
      ["rwy", "Runway", "t"],
      ["hdg", "Runway heading (°M)", "n"],
      ["len", "Runway length (ft)", "n"],
      ["slope", "Slope % (+up / −down)", "n"],
      ["surf", "Surface", "s", SURF],
      ["wdir", "Wind dir (°M)", "n"],
      ["wspd", "Wind speed (kt)", "n"],
      ["wgust", "Gust (kt)", "n"],
      ["qnh", "QNH (inHg or hPa)", "n"],
      ["oat", "OAT (°C)", "n"],
      !isD && ["tow", "T.O.W. override (lb)", "n"],
      !isD && ["eflaps", "Emergency landing flaps", "s", FLAPS],
      [
        "ewt",
        isD ? "Landing mass override (lb)" : "Emergency landing mass override (lb)",
        "n",
      ],
      ["remarks", "ATIS / remarks", "a"],
    ].filter(Boolean);
  // Filled by the automatic fetch; typing into one marks it "edited" and protects it from the next fetch.
  const AUTO = ["elev", "rwy", "hdg", "len", "surf", "wdir", "wspd", "wgust", "qnh", "oat", "remarks"];
  const META = ["info", "ends", "fkey", "fat", "pick"]; // fetch bookkeeping per point
  // Values that usually stay the same keep a default; everything else starts empty with a placeholder.
  const PT_DEFAULTS = Snapshot.PT_DEFAULTS;
  const today = () =>
    new Date(Date.now() - new Date().getTimezoneOffset() * 60000)
      .toISOString()
      .slice(0, 10);
  const DEFAULTS = Snapshot.DEFAULTS; // flight-level defaults; the same list decides what a calculation stores

  /* ---------- state (browser localStorage only, nothing leaves the device) ---------- */
  // Flat map: flight keys (date, reg, w1 …), route stops R0…R{nR-1}, point keys "L0.oat", "D.rwy", edited flags.
  const KEY = "sr20calc.v2",
    OLDKEY = "sr20calc.v1",
    BEMKEY = "sr20calc.bem";
  function lsGet(k) {
    try {
      return JSON.parse(localStorage.getItem(k));
    } catch (e) {
      return null;
    }
  }
  function lsSet(k, v) {
    try {
      localStorage.setItem(k, JSON.stringify(v));
    } catch (e) {
      /* ignore */
    }
  }
  // v1 (fixed sheet 1 / sheet 2) → route: first sheet's airports become the first two stops.
  function migrate(o) {
    if (!o) return null;
    const s = {};
    Object.keys(DEFAULTS).forEach((k) => {
      if (o[k] !== undefined) s[k] = o[k];
    });
    if (o["a.apt"]) {
      s.R0 = o["a.apt"];
      s.R1 = o["a.l_apt"] || o["a.apt"];
    }
    if (o.dur !== undefined) s["L0.dur"] = o.dur;
    if (o.fuelTrip !== undefined) s["L0.trip"] = o.fuelTrip;
    return s;
  }
  const state = Object.assign({}, DEFAULTS, lsGet(KEY) || migrate(lsGet(OLDKEY)) || {});
  if (!state.edited || typeof state.edited !== "object") state.edited = {};
  const FETCHED = new RegExp(`^(L\\d+|D)\\.(${[...AUTO, ...META, "time"].join("|")})$`);
  function clearFetched() {
    Object.keys(state).forEach((k) => {
      if (FETCHED.test(k)) delete state[k];
    });
    state.edited = {};
  }
  // A saved flight from an earlier day: keep route, people and settings, drop its date, time and weather.
  // (a calculated sheet stays as it was)
  if (state.mode !== "result" && (!state.date || state.date < today())) {
    state.date = today();
    state.time = "";
    clearFetched();
  }
  const num = (v) =>
    v === "" || v === undefined || v === null ? NaN : parseFloat(v);
  const fin = P.isNum;
  const nStops = () => Math.max(1, parseInt(state.nR, 10) || 1);
  const nLegs = () => Math.max(1, nStops() - 1);
  const stop = (i) => String(state["R" + i] || "").trim().toUpperCase();
  const validCode = (c) => /^[A-Z0-9]{3,4}$/.test(c);
  const points = () => [...Array(nLegs()).keys()].map((i) => "L" + i).concat("D");
  const aptOf = (p) => (p === "D" ? stop(nStops() - 1) : stop(+p.slice(1)));
  const pv = (p, k) => {
    const v = state[`${p}.${k}`];
    return v !== undefined ? v : PT_DEFAULTS[k] !== undefined ? PT_DEFAULTS[k] : "";
  };
  const save = () => lsSet(KEY, state);
  const busy = {}; // point -> fetch in progress (not persisted)
  // Draft: the form works, weather loads, no results. Result: one calculated snapshot, inputs read-only.
  const isRes = () => state.mode === "result";
  let pending = false; // a calculation request is on its way
  let notice = ""; // message under the banner (calculation errors)
  const isLocked = () => isRes() || pending;
  const tokens = () => (profile && Number.isFinite(+profile.tokens) ? +profile.tokens : 0);

  /* ---------- building the input panel ---------- */
  function control(id, label, type, opts, ph) {
    const dk = `id="${id}" data-k="${id}"`;
    if (type === "c")
      return `<label class="chk"><input type="checkbox" ${dk}> ${label}</label>`;
    let ctl;
    if (type === "s")
      ctl = `<select ${dk}>${opts.map(([v, t]) => `<option value="${v}">${t}</option>`).join("")}</select>`;
    else if (type === "a")
      ctl = `<textarea ${dk} rows="2" placeholder="${ph || ""}"></textarea>`;
    else
      ctl = `<input ${dk} type="${{ n: "number", d: "date", h: "time" }[type] || "text"}"${type === "n" ? ' step="any" inputmode="decimal"' : ""}${ph ? ` placeholder="${ph}"` : ""}${opts ? " " + opts : ""}>`;
    return `<label class="${type === "a" ? "wide" : ""}"><span>${label}</span>${ctl}</label>`;
  }
  const yn = (b) => (b ? "✓" : "–");
  function aptInfo(a) {
    if (!a) return "";
    return `<details class="info"><summary>ⓘ ${esc(a.name)} – LAT airport info</summary>
      <table class="appr"><tr><th>Solo</th><th>Dual</th><th>Day VFR</th><th>Day IFR</th><th>Night VFR</th><th>Night IFR</th></tr>
      <tr>${["solo", "dual", "dayVfr", "dayIfr", "nightVfr", "nightIfr"].map((k) => `<td class="${a[k] ? "y" : "n"}">${yn(a[k])}</td>`).join("")}</tr></table>
      <p>Field elevation ${Math.round(a.elev)} ft (FAA)${a.dist ? ` · ${a.dist} NM from GYR` : ""}</p>
      <ul>${a.notes.map((n) => `<li>${esc(n)}</li>`).join("")}</ul>
      <p class="fine">THB Appendix A, 07 APR 2026. Refer to the FAA Chart Supplement.</p></details>`;
  }
  const stepIn = (n, title) =>
    `<span class="num">${n}</span>${title}<span class="tick" id="tick${n}"></span>`;
  const step = (n, title) => `<h2>${stepIn(n, title)}</h2>`;
  // finished steps 1 and 2 collapse to this one-line summary (CSS only: the inputs stay in the DOM)
  const sumBtn = (n) =>
    `<button type="button" class="sumbtn" id="sumbtn${n}" data-step="${n}" aria-expanded="false" hidden><span class="num">${n}</span><span class="sumtxt"></span><span class="tick">✓</span><span class="chg" aria-hidden="true">Edit</span></button>`;
  $("#steps").innerHTML = `
    <section class="card" id="step1" data-step="1">${sumBtn(1)}${step(1, "Flight")}
      <div class="fg">
        <div class="wide"><span class="lbl">Route – every airport you take off from or land at</span><div class="route" id="route"></div></div>
        ${control("date", "Date", "d")}
        ${control("time", "Departure time (local)", "h")}
        ${control("reg", "A/C registration", "t", 'list="reglist" autocomplete="off" spellcheck="false"', "N4xxAV")}
        ${control("flight", "Flight", "t", 'autocomplete="off"', "e.g. D1_1")}
        <div class="wide bemnote" id="bemNote"></div>
      </div>
    </section>
    <section class="card" id="step2" data-step="2">${sumBtn(2)}${step(2, "People &amp; fuel")}
      <div class="fg">
        ${control("w1", "Seat 1 / pilot", "n", "", "lb")}${control("w2", "Seat 2", "n", "", "lb")}
        ${control("w3", "Seat 3", "n", "", "lb")}${control("w4", "Seat 4", "n", "", "lb")}
        ${control("fuelTO", "Take-off fuel (USG)", "n", "", "USG")}
        <div class="quick"><span>after 1.5 USG taxi</span><button type="button" data-fuel="54.5">56 → 54.5</button><button type="button" data-fuel="38.5">40 → 38.5</button></div>
        <div class="wide mass" id="mass"></div>
        <ul class="wide lwarn" id="mwarn"></ul>
      </div>
      <details class="same"><summary>Usually the same: <span id="sameSum"></span></summary><div class="fg">
        ${control("bag", "Baggage (lb)", "n")}${control("trim", "Trim", "t")}
        ${control("prep", "Prepared by", "t", "", "your name")}<span></span>
        ${control("bem", "Basic empty mass (lb)", "n", "", "from fleet")}${control("bemCg", "BEM CG (in)", "n", "", "from fleet")}
        <div class="wide">${control("vrbWorst", "Variable wind: assume worst case (full tailwind + crosswind)", "c")}</div>
        <div class="wide">${control("sheetMode", "T/O data sheets", "s", [
          ["lat", "One per takeoff + destination landing (standard)"],
          ["pair", "Two per takeoff: immediate return + arrival (remarks KGYR-KGYR / KGYR-KBXK)"],
        ])}</div>
      </div></details>
    </section>
    <div id="preSlot"></div>
    <h2 class="sech">${stepIn(3, "Check each takeoff and the landing")}</h2>
    <div id="legs"></div>`;
  $("#lists").innerHTML =
    `<datalist id="latlist">${Object.values(LAT)
      .map((a) => `<option value="${a.icao}">${esc(a.name)} · ${a.solo ? "solo" : "dual only"}</option>`)
      .join("")}</datalist>` +
    `<datalist id="reglist">${Object.entries(window.FLEET || {})
      .map(([r, f]) => `<option value="${r}">BEM ${f.bem} lb · CG ${f.cg}</option>`)
      .join("")}</datalist>`;

  function routeHTML() {
    const n = nStops();
    let h = "";
    for (let i = 0; i < n; i++) {
      if (i) h += '<span class="arr">→</span>';
      const ph = i === 0 ? "From" : i === n - 1 ? "To" : "Via";
      h += `<span class="stop"><input id="R${i}" data-k="R${i}" list="latlist" placeholder="${ph}" maxlength="4" autocomplete="off" autocapitalize="characters" spellcheck="false" aria-label="${ph} (ICAO)">${n > 1 ? `<button type="button" class="x" tabindex="-1" data-del="${i}" title="Remove this airport" aria-label="Remove airport ${i + 1}">×</button>` : ""}</span>`;
    }
    return h + '<button type="button" id="addStop">+ stop</button>';
  }
  function pointHTML(p) {
    const isD = p === "D",
      i = isD ? -1 : +p.slice(1),
      k = (f) => `${p}.${f}`,
      apt = aptOf(p),
      ph = noserver ? "" : "auto";
    const title = isD
      ? `Landing · ${esc(apt) || "destination"}`
      : `Leg ${i + 1} · ${esc(apt) || "?"} → ${esc(stop(i + 1) || apt) || "?"}`;
    const plan = isD
      ? control(k("eflaps"), "Landing flaps", "s", FLAPS)
      : (i > 0
          ? control(k("gnd"), `Time on ground at ${esc(apt) || "stop"} (min)`, "n") +
            control(k("refuel"), "Refuel to (USG)", "n", "", "no refuel")
          : "") +
        control(k("dur"), "Flight time (min)", "n") +
        control(k("trip"), "Trip fuel (USG)", "n") +
        control(k("ac"), "Air conditioning ON for takeoff", "c");
    return `<section class="leg${isD ? " dest" : ""}" data-p="${p}">
      <div class="lhead"><b>${title}</b><span class="lsum" id="sum-${p}"></span></div>
      <label class="rwl" id="rwl-${p}" hidden><span>Runway</span><select class="rsel" id="rsel-${p}" data-rsel="${p}"></select></label>
      <div class="tiles" id="tiles-${p}"></div>
      <div class="fstat" id="fstat-${p}"></div>
      <ul class="lwarn" id="lwarn-${p}"></ul>
      <div class="fg plan">${plan}</div>
      ${aptInfo(LAT.find(apt))}
      <details class="rw"><summary>Edit runway &amp; weather values</summary><div class="fg">${pointFields(isD)
        .map(([f, l, t, o]) => control(k(f), l, t, o, AUTO.includes(f) ? ph : ""))
        .join("")}</div></details>
    </section>`;
  }
  function fill(root) {
    root.querySelectorAll("[data-k]").forEach((el) => {
      const key = el.dataset.k,
        m = /^(L\d+|D)\.(.+)$/.exec(key);
      const v = m ? pv(m[1], m[2]) : state[key];
      if (v === undefined) return;
      if (el.type === "checkbox") el.checked = !!v;
      else el.value = v;
    });
  }
  function renderRoute() {
    $("#route").innerHTML = routeHTML();
    fill($("#route"));
  }
  function renderLegs() {
    const was = {};
    document.querySelectorAll("#legs details").forEach((d) => {
      was[d.className + d.closest(".leg").dataset.p] = d.open;
    });
    $("#legs").innerHTML = points().map(pointHTML).join("");
    // while drafting, the runway & weather values start open so they are easy to review; later choices are kept
    document.querySelectorAll("#legs details").forEach((d) => {
      const id = d.className + d.closest(".leg").dataset.p;
      d.open = was[id] !== undefined ? was[id] : d.className === "rw";
    });
    fill($("#legs"));
  }
  fill($("#steps"));
  renderRoute();
  renderLegs();

  /* ---------- formatting ---------- */
  const r0 = (v) => (fin(v) ? String(Math.round(v)) : "");
  const r10 = (v) => (fin(v) ? String(Math.ceil(v / 10 - 1e-9) * 10) : "");
  const r1 = (v) => (fin(v) ? v.toFixed(1) : "");
  const isCalm = (d, s) => (!fin(d) && !fin(s)) || s === 0; // nothing entered, or 0 kt
  function windStr(d, s, g) {
    if (isCalm(d, s)) return "CALM";
    if (!fin(d) && fin(s)) return `VRB/${Math.round(s)}`;
    return `${fin(d) ? String(Math.round(d)).padStart(3, "0") : "---"}/${fin(s) ? Math.round(s) : "--"}${fin(g) && g > s ? "G" + Math.round(g) : ""}`;
  }
  function qnhStr(q) {
    return fin(q) ? (q > 80 ? String(Math.round(q)) : q.toFixed(2)) : "";
  }
  const side = (v) => (v >= 0 ? "R" : "L");

  // Weather / runway conditions of point q, as the performance functions take them.
  function condOf(q) {
    const n = (k) => num(pv(q, k));
    return {
      vrbWorst: state.vrbWorst,
      elev: n("elev"),
      qnh: n("qnh"),
      oat: n("oat"),
      wdir: n("wdir"),
      wspd: n("wspd"),
      wgust: n("wgust"),
      hdg: n("hdg"),
      len: n("len"),
      slope: n("slope"),
      surf: pv(q, "surf"),
    };
  }
  // Landing box of a T/O data sheet: landing at point q's runway and weather, at mass w, with q's landing flaps.
  function landingBox(q, w) {
    const flaps = parseInt(pv(q, "eflaps"), 10);
    const rwy = String(pv(q, "rwy") || "").trim();
    return {
      l: P.landing(Object.assign({ flaps, w }, condOf(q))),
      ldw: w,
      lflaps: flaps,
      llen: num(pv(q, "len")),
      lapt: [aptOf(q), rwy].filter(Boolean).join(" "),
    };
  }

  /* ---------- one sheet ---------- */
  // Takeoff point: T/O at that leg's mass; landing box = emergency return to the same runway at T/O mass.
  // Destination: everything at landing mass; landing box = the normal landing there.
  function sheetData(p, mass) {
    const isD = p === "D";
    const g = (k) => pv(p, k);
    const n = (k) => num(g(k));
    const tow = isD ? (fin(n("ewt")) ? n("ewt") : mass) : fin(n("tow")) ? n("tow") : mass;
    const t = P.takeoff(Object.assign({ tow, ac: !isD && g("ac") }, condOf(p)));
    const lb = landingBox(p, isD ? tow : fin(n("ewt")) ? n("ewt") : tow);
    const apt = aptOf(p),
      rwy = String(g("rwy") || "").trim();
    return {
      p,
      isD,
      t,
      l: lb.l,
      ldw: lb.ldw,
      lflaps: lb.lflaps,
      llen: lb.llen,
      lapt: lb.lapt,
      dateac: [fmtDate(state.date), state.reg].filter(Boolean).join(" / "),
      apt,
      elev: g("elev") === "" ? "" : Math.round(n("elev")) + " ft",
      rwy,
      len: g("len") === "" ? "" : Math.round(n("len")) + " ft",
      lenN: n("len"),
      tow,
      trim: state.trim,
      remarks: g("remarks"),
      wdir: n("wdir"),
      wspd: n("wspd"),
      wgust: n("wgust"),
      qnh: n("qnh"),
      oat: n("oat"),
      missing: ["elev", "len", "qnh", "oat"].filter((k) => !fin(n(k))),
    };
  }

  /* ---------- PDF filling (draws onto the original LAT form) ---------- */
  const { PDFDocument, StandardFonts, rgb } = window.PDFLib;
  const INK = rgb(0.04, 0.2, 0.58),
    RED = rgb(0.8, 0, 0);
  const clean = (t) => String(t).replace(/[^\x20-\xFF]/g, "?");

  function put(c, text, x, y, o = {}) {
    text = clean(text);
    if (!text.trim()) return;
    const font = o.bold === false ? c.font : c.bold;
    let size = o.size || 10;
    if (o.maxW)
      while (size > 5 && font.widthOfTextAtSize(text, size) > o.maxW)
        size -= 0.25;
    c.page.drawText(text, { x, y, size, font, color: o.color || INK });
  }
  const wrap = (font, text, size, maxW) => {
    const lines = [];
    String(text)
      .split("\n")
      .forEach((para) => {
        let line = "";
        para.split(/\s+/).forEach((w) => {
          const t = line ? line + " " + w : w;
          if (font.widthOfTextAtSize(clean(t), size) <= maxW || !line) line = t;
          else {
            lines.push(line);
            line = w;
          }
        });
        lines.push(line);
      });
    return lines;
  };

  // T/O data sheet: label coordinates come from the form; value goes just below each label.
  const DY2 = -278.2; // second box offset
  function drawSheet(c, dy, S, occ) {
    const v = (text, x, ly, o) =>
      put(c, text, x, ly - 14 + dy, Object.assign({ size: 10, maxW: 66 }, o));
    const C1 = 169.2,
      C2 = 241.2,
      C3 = 313.2,
      C4 = 385.3;
    const bad = (a, b) => (fin(a) && fin(b) && a > b ? { color: RED } : {});
    const t = S.t,
      l = S.l;
    v(S.dateac, C1, 646.3, { size: 8.5 });
    v(S.apt, C1, 622.5);
    v(S.elev, C1, 598.9);
    v(S.rwy, C1, 575.1);
    v(S.len, C1, 551.4);
    v(r0(S.tow), C2, 646.3);
    v(S.trim, C2, 598.9);
    v(r0(t.vr), C2, 575.1);
    v(r0(t.vlof), C2, 551.4);
    if (occ >= 1 && occ <= 4) {
      const cx = 259.4 + 7.2 * (occ - 1) + 1.7,
        cy = 606.5 + dy + 2.1;
      c.page.drawEllipse({
        x: cx,
        y: cy,
        xScale: 4.8,
        yScale: 4.8,
        borderColor: INK,
        borderWidth: 0.9,
      });
    }
    v(r10(t.tor), C3, 646.3, bad(t.tor, S.lenN));
    v(r10(t.tod), C3, 620.3, bad(t.tod, S.lenN));
    v(r0(t.roc), C3, 559.1);
    // nothing known about the weather yet: leave the wind boxes empty instead of printing CALM
    const noWx = !fin(S.wdir) && !fin(S.wspd) && !fin(S.qnh) && !fin(S.oat);
    if (!noWx) v(windStr(S.wdir, S.wspd, S.wgust), C1, 526.0);
    if (noWx) {
      /* empty */
    } else if (isCalm(S.wdir, S.wspd)) {
      v("0 / 0°", C1, 502.3);
      v("HW 0", C1, 478.6);
    } else if (t.wind) {
      const sd = (x) => (t.wind.vrb ? "" : side(x)); // variable wind has no side
      v(
        `${r0(Math.abs(t.cross))}${sd(t.cross)} / ${fin(t.wca) ? r0(Math.abs(t.wca)) + "°" + sd(t.wca) : ""}`,
        C1,
        502.3,
      );
      v(
        t.head >= 0 ? `HW ${r0(t.head)}` : `TW ${r0(-t.head)}`,
        C1,
        478.6,
        t.head < 0 ? { color: RED } : {},
      );
    }
    v(qnhStr(S.qnh), C2, 526.0);
    v(r0(t.pa), C2, 502.3);
    v(fin(t.ff) ? r1(t.ff) : "", C2, 478.6);
    v(fin(S.oat) ? String(S.oat) : "", C3, 525.1);
    v(r0(t.da), C3, 488.5);
    // ATIS / remarks
    if (S.remarks) {
      wrap(c.bold, S.remarks, 8, 118)
        .slice(0, 10)
        .forEach((ln, i) => put(c, ln, 387.5, 628 + dy - i * 10, { size: 8 }));
    }
    // landing data
    if (fin(S.ldw)) {
      const w = `${r0(S.ldw)} / ${r0(l.vref)} / ${r0(l.vtgt)}`;
      put(c, w, C4, 502.3 - 14 + dy, { size: 10, maxW: 90 });
      put(c, "F" + S.lflaps, C4 + 96, 502.3 - 14 + dy, { size: 7 });
    }
    if (fin(l.tot)) {
      put(
        c,
        `${S.lapt ? S.lapt + "  " : ""}${r0(S.llen)} / ${r10(l.tot)}`,
        C4,
        478.6 - 14 + dy,
        Object.assign({ size: 10, maxW: 118 }, bad(l.tot, S.llen)),
      );
    }
  }

  // Load sheet: calibrated on the image placed on page 2 (523x797 px at 74.075/42.339, 463.85 pt wide).
  const PS = 463.85 / 523;
  const gx = (px) => 74.075 + px * PS;
  const gy = (py) => 42.339 + (797 - py) * PS;
  const MX = (m) => 193.5 + (m - 300) * 1.7412; // moment axis (px)
  const MY = (lb) => 461.0 + (3200 - lb) * 0.227; // mass axis (px)
  const ROWTOP = (i) => 176.2 + 28.5 * i,
    ROWC = (i) => ROWTOP(i) + 14.25;
  const GREY = new Set([3, 6, 8]); // rows with a printed max-box at the bottom
  const DIGX = [143.8, 158.0, 172.2, 186.4];

  function drawLoad(c, s, L) {
    const P2 = (text, px, py, o) => put(c, text, gx(px), gy(py), o);
    P2(s.reg, 150, 88, { size: 11, maxW: 80 });
    P2(s.flight, 150, 112, { size: 11, maxW: 80 });
    P2(fmtDate(s.date), 150, 137, { size: 11, maxW: 80 });
    P2(s.prep, 58, 726, { size: 9, maxW: 120 });
    if (L && L.m && fin(L.m.bem))
      P2(L.m.bem.toFixed(1), 323, 181, { size: 9, maxW: 42 });
    // cross out occupied seats on the cabin sketch (image px boxes)
    [
      [1, 355.5, 121.8, 391.3, 148.8],
      [2, 355.5, 84.5, 391.3, 111.8],
      [3, 407, 117, 442.5, 146.2],
      [4, 407, 87.5, 442.5, 117],
    ].forEach(([n, x0, y0, x1, y1]) => {
      if (!(num(s["w" + n]) > 0)) return;
      const seg = (a, b, c2, d) =>
        c.page.drawLine({
          start: { x: gx(a), y: gy(b) },
          end: { x: gx(c2), y: gy(d) },
          thickness: 1.3,
          color: INK,
        });
      seg(x0 + 2, y0 + 2, x1 - 2, y1 - 2);
      seg(x0 + 2, y1 - 2, x1 - 2, y0 + 2);
    });
    if (!L || !fin(L.zfm)) return;
    const w = L.w;
    const wts = [
      w.bem,
      w.s12,
      w.s34,
      w.bag,
      L.zfm,
      w.fuelTO,
      L.tom,
      w.trip,
      L.lm,
    ];
    wts.forEach((v, i) => {
      if (!fin(v)) return;
      const d = String(Math.round(v)).padStart(4, " ");
      [...d].forEach((ch, k) => {
        if (ch !== " ")
          c.page.drawText(ch, {
            x:
              gx(DIGX[k]) -
              c.bold.widthOfTextAtSize(ch, GREY.has(i) ? 9.5 : 11) / 2,
            y: gy(ROWTOP(i) + (GREY.has(i) ? 14.5 : 18.5)),
            size: GREY.has(i) ? 9.5 : 11,
            font: c.bold,
            color: INK,
          });
      });
    });
    if (!L.cum) return;
    const cm = L.cum,
      X = [cm.bem, cm.s12, cm.s34, cm.bag, cm.fuel, cm.lm].map(MX);
    const [x0, x1, x2, x3, x4, x5] = X;
    const cy = (i) => ROWC(i);
    // trim line: straight down, then along the row to the left/right, never diagonal
    const path = [
      [x0, 202],
      [x0, cy(1)],
      [x1, cy(1)],
      [x1, cy(2)],
      [x2, cy(2)],
      [x2, cy(3)],
      [x3, cy(3)],
      [x3, cy(5)],
      [x4, cy(5)],
      [x4, cy(7)],
      [x5, cy(7)],
      [x5, cy(8)],
    ];
    const seg = (a, b, th = 1.1) =>
      c.page.drawLine({
        start: { x: gx(a[0]), y: gy(a[1]) },
        end: { x: gx(b[0]), y: gy(b[1]) },
        thickness: th,
        color: INK,
      });
    for (let i = 1; i < path.length; i++) seg(path[i - 1], path[i]);
    const dot = (px, py, r, col = INK) =>
      c.page.drawCircle({ x: gx(px), y: gy(py), size: r, color: col });
    dot(x0, 202, 1.8);
    [
      [x0, cy(0)],
      [x1, cy(1)],
      [x2, cy(2)],
      [x3, cy(3)],
      [x3, cy(4)],
      [x4, cy(5)],
      [x4, cy(6)],
      [x5, cy(7)],
      [x5, cy(8)],
    ].forEach(([a, b]) => dot(a, b, 1.3));
    // drops into the envelope: down from ZFM / TOM / LM, across from the mass axis
    [
      ["ZFM", x3, 4, L.zfm],
      ["TOM", x4, 6, L.tom],
      ["LM", x5, 8, L.lm],
    ].forEach(([name, x, row, lb]) => {
      const y = MY(lb),
        ok = L.inside[name.toLowerCase()],
        col = ok ? INK : RED;
      seg([x, cy(row)], [x, y], 0.9);
      c.page.drawLine({
        start: { x: gx(MX(300)), y: gy(y) },
        end: { x: gx(x), y: gy(y) },
        thickness: 0.5,
        color: INK,
        dashArray: [2, 2],
      });
      dot(x, y, 2.4, col);
      put(c, name, gx(x) + 4, gy(y) + 2.5, { size: 7, color: col });
    });
  }
  const MON = [
    "JAN",
    "FEB",
    "MAR",
    "APR",
    "MAY",
    "JUN",
    "JUL",
    "AUG",
    "SEP",
    "OCT",
    "NOV",
    "DEC",
  ];
  function fmtDate(d) {
    // 2026-11-11 -> "11 NOV 26"
    const m = /^(\d{4})-(\d\d)-(\d\d)$/.exec(d || "");
    return m ? `${m[3]} ${MON[+m[2] - 1]} ${m[1].slice(2)}` : d || "";
  }

  // Sheets as printed. Standard: as computed. Pair mode: every takeoff sheet twice, identical except the landing box and
  // the remarks (first line = route tag): immediate return "DEP-DEP" (landing box as in the takeoff sheet), arrival "DEP-ARR".
  const joinRemarks = (tag, rem) => [tag, String(rem || "").trim()].filter(Boolean).join("\n");
  function pdfSheets(sheets) {
    if (state.sheetMode !== "pair") return sheets;
    const out = [];
    sheets.forEach((S) => {
      if (S.isD || !S.arr) return;
      const dep = aptOf(S.p);
      out.push({ ...S, remarks: joinRemarks(`${dep}-${dep}`, S.remarks) });
      out.push({ ...S, ...S.arr.box, remarks: joinRemarks(`${dep}-${S.arr.apt}`, S.remarks) });
    });
    return out;
  }

  // ceil(n/2) copies of the T/O page (two sheets each), then the load sheet.
  async function buildPdf(s, L, sheets, occ) {
    const bin = atob(window.FORM_PDF_B64);
    const bytes = Uint8Array.from(bin, (ch) => ch.charCodeAt(0));
    const doc = await PDFDocument.load(bytes);
    const font = await doc.embedFont(StandardFonts.Helvetica),
      bold = await doc.embedFont(StandardFonts.HelveticaBold);
    const toPages = [doc.getPage(0)];
    for (let k = 1; k < Math.ceil(sheets.length / 2); k++) {
      const [copy] = await doc.copyPages(doc, [0]);
      toPages.push(doc.insertPage(k, copy));
    }
    sheets.forEach((S, i) =>
      drawSheet({ page: toPages[i >> 1], font, bold }, i % 2 ? DY2 : 0, S, occ),
    );
    drawLoad({ page: doc.getPage(toPages.length), font, bold }, s, L);
    return doc.save();
  }


  /* ---------- render + preview ---------- */
  const pdfjs = window.pdfjsLib;
  pdfjs.GlobalWorkerOptions.workerSrc = "vendor/pdf.worker.min.js";
  let lastBytes = null,
    seq = 0,
    timer = null;

  async function preview(bytes) {
    const my = ++seq;
    const doc = await pdfjs.getDocument({ data: bytes.slice() }).promise;
    const host = $("#pages");
    const w = Math.min(host.clientWidth - 8, 820),
      dpr = window.devicePixelRatio || 1;
    const canvases = [];
    for (let n = 1; n <= doc.numPages; n++) {
      const pg = await doc.getPage(n);
      const base = pg.getViewport({ scale: 1 });
      const vp = pg.getViewport({ scale: (w / base.width) * dpr });
      const cv = document.createElement("canvas");
      cv.width = vp.width;
      cv.height = vp.height;
      cv.style.width = w + "px";
      cv.style.height = vp.height / dpr + "px";
      await pg.render({ canvasContext: cv.getContext("2d"), viewport: vp })
        .promise;
      canvases.push(cv);
    }
    if (my !== seq) return;
    if (!isRes()) return;
    host.replaceChildren(...canvases);
    delete host.dataset.ph;
  }

  const li = (x) => `<li>${esc(x)}</li>`;
  const tile = (label, value, sub, cls) =>
    `<div class="tile${cls ? " " + cls : ""}"><span>${label}</span><b>${value === "" || value === undefined ? "–" : esc(value)}</b>${sub ? `<i>${esc(sub)}</i>` : ""}</div>`;
  const setHTML = (id, html) => {
    const el = byId(id);
    if (el && el.innerHTML !== html) el.innerHTML = html;
  };

  // Runway picker: the ends found by the fetch, best first choice already applied.
  function renderRunways(p) {
    const ends = state[`${p}.ends`] || [],
      wrap = byId("rwl-" + p),
      sel = byId("rsel-" + p);
    if (!wrap) return;
    wrap.hidden = !ends.length;
    const sig = JSON.stringify(ends);
    if (sel.dataset.sig !== sig) {
      sel.dataset.sig = sig;
      sel.innerHTML =
        '<option value="">other (edited)</option>' +
        ends
          .map(
            (e, i) =>
              `<option value="${i}">RWY ${esc(e.id)} · ${e.len} ft · ${e.head >= 0 ? "headwind" : "tailwind"} ${Math.abs(e.head)} kt${e.surf === "dry" ? " · grass/other" : ""}</option>`,
          )
          .join("");
    }
    const cur = ends.findIndex((e) => W.rwyKey(e.id) === W.rwyKey(pv(p, "rwy")));
    sel.value = cur < 0 ? "" : String(cur);
  }
  function renderStatus(p, nEdited) {
    if (isRes()) nEdited = 0;
    const info = state[`${p}.info`] || {},
      parts = [];
    if (busy[p]) parts.push('<span class="spin">Loading airport and weather…</span>');
    else {
      (info.out || []).forEach((x) => parts.push(esc(x)));
      (info.warn || []).forEach((x) => parts.push(`<span class="note">${esc(x)}</span>`));
      if (info.err) parts.push(`<span class="err">${esc(info.err)}</span>`);
    }
    if (nEdited)
      parts.push(
        `<span class="note">${nEdited} value${nEdited > 1 ? "s" : ""} edited by you</span>${isLocked() ? "" : ` <button type="button" data-unedit="${p}">↺ use fetched</button>`}`,
      );
    if (!noserver && validCode(aptOf(p)) && !busy[p] && !isLocked())
      parts.push(`<button type="button" data-refresh="${p}" title="Fetch airport and weather again">↻ refresh</button>`);
    setHTML("fstat-" + p, parts.join(" · "));
  }

  /* ---------- pre-flight check (draft only): weather plausibility, never a performance verdict ---------- */
  const STALE_MS = 30 * 60000, // fetched longer ago than this: refresh
    METAR_STALE_MS = 75 * 60000; // METARs are hourly: older than this means a newer one is overdue
  const pre = document.createElement("div");
  pre.id = "pre";
  const phoneMq = window.matchMedia ? matchMedia("(max-width:900px)") : null;
  let ageTimer = null, // one interval, only while drafting
    staleSig = "";
  const ageText = (ms, fetched) => {
    const m = Math.max(0, Math.floor((Date.now() - ms) / 60000)),
      t = m < 1 ? "just now" : m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60} min`;
    return m < 1 ? (fetched ? "fetched just now" : "just now") : fetched ? `fetched ${t} ago` : `${t} old`;
  };
  const friendlySrc = (src) => {
    const m = /^model (forecast|analysis)/.exec(src);
    return m ? "Model " + m[1] : src;
  };
  // Where each weather group (wind; temp + QNH) of a sheet came from, how old it is, and whether it is past 30 min.
  // Observation time: info.obs (ms, from the METAR) recorded by autofill.js; fetch time: state["<p>.fat"].
  function wxInfo(p) {
    const info = state[`${p}.info`] || {},
      out = info.out || [],
      obs = info.obs || {},
      fat = state[`${p}.fat`],
      now = Date.now();
    const line = (re) => {
      const x = out.find((o) => re.test(o));
      return x ? x.replace(re, "") : "";
    };
    const wsrc = line(/^wind: /),
      tsrc = line(/^temp\/QNH: /) || wsrc;
    const grp = (src, at, keys) => {
      const mine = keys.every((k) => state.edited[`${p}.${k}`]),
        part = !mine && keys.some((k) => state.edited[`${p}.${k}`]);
      const metar = /^METAR/.test(src),
        useObs = metar && fin(at);
      const g = { label: mine ? "Entered by you" : friendlySrc(src), part, mine, at: null, fetched: false, stale: false, ageMs: 0 };
      if (!mine && src) {
        if (useObs) g.at = at;
        else if (fin(fat)) {
          g.at = fat;
          g.fetched = true;
        }
        const obsAge = useObs ? now - at : null,
          fetchAge = fin(fat) ? now - fat : null;
        g.ageMs = obsAge !== null ? obsAge : fetchAge !== null ? fetchAge : 0;
        // Stale = fetched long ago (a refresh fixes it) or a METAR older than the hourly cycle allows.
        // A normal 31–59 min old METAR is the current one, so it is not flagged.
        g.stale = (fetchAge !== null && fetchAge > STALE_MS) || (obsAge !== null && obsAge > METAR_STALE_MS);
      }
      return g;
    };
    const w = grp(wsrc, obs.wind, ["wdir", "wspd"]),
      t = grp(tsrc, obs.temp, ["oat", "qnh"]);
    return { w, t, stale: w.stale || t.stale, min: Math.floor(Math.max(w.ageMs, t.ageMs) / 60000) };
  }
  const srcRow = (name, g) => {
    let h = g.label ? esc(g.label) : '<span class="hint">not loaded – press ↻ Refresh or enter the values</span>';
    if (g.part) h += " (partly edited by you)";
    if (g.at !== null) h += ` · <span class="age" data-at="${g.at}"${g.fetched ? ' data-f="1"' : ""}>${esc(ageText(g.at, g.fetched))}</span>`;
    return `<div><span>${name}</span> ${h}</div>`;
  };
  function preCard(S, idx, apt, latW) {
    const p = S.p,
      isD = S.isD,
      wc = S.t.wind,
      hdg = num(pv(p, "hdg")),
      wx = wxInfo(p),
      info = state[`${p}.info`] || {},
      load = !!busy[p];
    const hasWind = fin(S.wspd) || fin(S.wdir),
      calm = !hasWind || isCalm(S.wdir, S.wspd);
    const surf = (SURF.find(([v]) => v === pv(p, "surf")) || [])[1] || "";
    const where = [S.apt, apt && apt.name].filter(Boolean).join(" · ");
    const title = isD ? "Landing" : `Leg ${idx + 1}`;
    const head = wc && !calm ? wc.head : 0,
      cross = wc && !calm ? wc.cross : 0;
    const flags = [];
    if (!load) {
      if (info.err) flags.push(info.err);
      const miss = [
        !S.rwy && "runway",
        !fin(hdg) && "runway heading",
        !fin(S.lenN) && "runway length",
        !fin(num(pv(p, "elev"))) && "elevation",
        !hasWind && "wind",
        !fin(S.qnh) && "QNH",
        !fin(S.oat) && "OAT",
      ].filter(Boolean);
      if (miss.length) flags.push(`Missing: ${miss.join(", ")} – ${noserver ? "enter them under Edit values" : "press ↻ Refresh or use Edit values"}`);
      (info.warn || []).forEach((x) => flags.push(x));
      if (wx.stale) flags.push("Weather may be outdated – refresh before calculating");
      if (wc && !calm && Math.round(-head) >= 1) flags.push(`Tailwind ${r0(-head)} kt${wc.vrb ? " (variable wind, worst case)" : ""}`);
      if (wc && !calm && Math.abs(cross) >= 10 - 1e-9) flags.push(`Crosswind ${r0(Math.abs(cross))} kt`);
      latW.forEach((x) => flags.push(x));
    }
    const uniq = [...new Set(flags)];
    const status = load
      ? '<span class="pst">Loading…</span>'
      : uniq.length
        ? `<span class="pst warn">⚠ ${uniq.length} flag${uniq.length > 1 ? "s" : ""}</span>`
        : '<span class="pst ok">✓ Weather looks complete</span>';
    const tiles = [
      tile("Runway", S.rwy),
      tile("Heading", fin(hdg) ? r0(hdg) + " °M" : ""),
      tile("Length", fin(S.lenN) ? r0(S.lenN) + " ft" : ""),
      tile("Surface", surf),
      tile("Wind", hasWind ? windStr(S.wdir, S.wspd, S.wgust) : ""),
      calm
        ? tile("Head/tailwind", hasWind ? "Calm" : "")
        : tile(head >= 0 ? "Headwind" : "Tailwind", wc ? r0(Math.abs(head)) + " kt" : "", wc && wc.vrb ? "variable, worst case" : "", wc && head < 0 ? "bad" : ""),
      calm
        ? tile("Crosswind", hasWind ? "0 kt" : "")
        : tile("Crosswind", wc ? r0(Math.abs(cross)) + " kt" : "", wc && !wc.vrb ? `from the ${cross >= 0 ? "right" : "left"}` : ""),
      tile("OAT", fin(S.oat) ? S.oat + " °C" : ""),
      tile("QNH", fin(S.qnh) ? qnhStr(S.qnh) + (S.qnh > 80 ? " hPa" : " inHg") : ""),
      tile("Elevation", S.elev),
      tile("Pressure alt.", fin(S.t.pa) ? r0(S.t.pa) + " ft" : ""),
      tile("Density alt.", fin(S.t.da) ? r0(S.t.da) + " ft" : ""),
    ].join("");
    const can = !isLocked();
    return `<section class="pcard" data-p="${p}">
      <div class="pch"><b>${title}${S.apt ? ` · ${esc(S.apt)}` : ""}</b>${status}</div>
      ${where ? `<div class="pwhere">${esc(where)}</div>` : ""}
      <div class="tiles">${tiles}</div>
      <div class="psrc">${srcRow("Wind", wx.w)}${srcRow("Temp / QNH", wx.t)}</div>
      ${uniq.length ? `<ul class="lwarn">${uniq.map(li).join("")}</ul>` : ""}
      <div class="pact"><button type="button" data-pre-edit="${p}"${can ? "" : " disabled"}>Edit values</button>${noserver ? "" : `<button type="button" data-refresh="${p}"${load || !can || !validCode(S.apt) ? " disabled" : ""}>↻ Refresh</button>`}</div>
    </section>`;
  }
  function preHTML(cards, L, LW, massW) {
    return `<h2 class="preh">Pre-flight check</h2>
      <p class="pren">Weather and runway plausibility only. Distances, speeds and the PDF appear after you calculate.</p>
      ${cards.join("")}
      <section class="pcard pmass"><div class="pch"><b>Masses</b></div>
        <p>${fin(L.tom) ? `ZFM <b>${r0(L.zfm)}</b> · T/O <b>${r0(L.tom)}</b> · landing <b>${r0(LW.lm)}</b> lb` : "Masses are not complete yet (step 2)."}</p>
        ${massW.length ? `<ul class="lwarn">${massW.map(li).join("")}</ul>` : ""}</section>`;
  }
  // every 60 s: refresh the age texts only; a full update() only when a sheet crossed the 30 min line
  const staleNow = () => points().map((p) => (wxInfo(p).stale ? 1 : 0)).join("");
  function tickAge() {
    if (isRes() || document.hidden) return;
    document.querySelectorAll("#pre .age").forEach((el) => {
      el.textContent = ageText(+el.dataset.at, el.dataset.f === "1");
    });
    if (staleNow() !== staleSig) update();
  }
  document.addEventListener("visibilitychange", tickAge);

  // Verdict strip (result mode): one row per sheet, from the same need / ok / warnings as the card verdicts.
  function stripRow(S, idx, need, ok, warn) {
    const known = fin(need) && fin(S.lenN) && S.lenN > 0,
      spare = known ? (S.lenN - need) / S.lenN : NaN,
      dist = (v) => (fin(v) ? r10(v) : "–"),
      where = [S.apt, S.rwy && "RWY " + S.rwy].filter(Boolean).join(" ") || "–",
      len = fin(S.lenN) ? r0(S.lenN) : "–",
      spareTxt = !known ? "– % spare" : spare >= 0 ? `${Math.round(spare * 100)} % spare` : `${r10(need - S.lenN)} ft too long`,
      lines = S.isD ? [`${dist(S.l.tot)} of ${len} ft · ${spareTxt}`] : [`T/O ${dist(S.t.tod)} of ${len} ft · ${spareTxt}`, `emergency landing ${dist(S.l.tot)} ft`],
      arrOver = S.arr && fin(S.arr.box.l.tot) && fin(S.arr.box.llen) && S.arr.box.l.tot > S.arr.box.llen;
    if (S.arr) lines.push(`landing ${S.arr.apt} ${dist(S.arr.box.l.tot)} of ${fin(S.arr.box.llen) ? r0(S.arr.box.llen) : "–"} ft`);
    return `<div class="vrow ${ok === null ? "na" : ok ? "ok" : "no"}"><div class="vh"><b>${S.isD ? "Landing" : "Leg " + (idx + 1)} · ${esc(where)}</b><span class="vst">${ok === null ? "–" : ok ? "✓ OK" : "⚠ check"}</span></div>
      ${lines.map((x, i) => `<div class="vl"${S.arr && i === lines.length - 1 && arrOver ? ' style="color:var(--vno)"' : ""}>${esc(x)}</div>`).join("")}
      <div class="vbar" aria-hidden="true"><i style="width:${known ? Math.min(100, Math.max(0, (need / S.lenN) * 100)).toFixed(1) : 0}%"></i></div>
      ${warn.length ? `<div class="vw">⚠ ${esc(warn[0])}</div>` : ""}</div>`;
  }

  function update() {
    save();
    const s = state,
      res = isRes();
    const legsIn = [];
    for (let i = 0; i < nLegs(); i++)
      legsIn.push({ trip: num(pv("L" + i, "trip")), refuel: num(pv("L" + i, "refuel")) });
    const load = (fuelTrip) =>
      P.loadSheet({
        bem: num(s.bem),
        bemMom: (num(s.bem) * num(s.bemCg)) / 1000,
        w1: num(s.w1),
        w2: num(s.w2),
        w3: num(s.w3),
        w4: num(s.w4),
        bag: num(s.bag),
        fuelTO: num(s.fuelTO),
        fuelTrip,
      });
    const LW = P.legWeights(load(0).zfm, num(s.fuelTO), legsIn);
    const L = load(LW.loadTrip);
    const pair = s.sheetMode === "pair";
    // Landing mass at the end of leg i = ZFM + (fuel at its takeoff - its trip fuel) x lb/USG; point D's landing mass override wins for the last leg.
    const zfm0 = load(0).zfm;
    const legLm = (i) => {
      const trip = fin(legsIn[i].trip) ? legsIn[i].trip : 0;
      const lm = zfm0 + (LW.legs[i].fuel - trip) * P.LB_PER_USG;
      return i === nLegs() - 1 && fin(num(pv("D", "ewt"))) ? num(pv("D", "ewt")) : lm;
    };
    const occ = [s.w1, s.w2, s.w3, s.w4].filter((v) => num(v) > 0).length;

    // step 2: masses
    const massW = [...L.warn, ...LW.warn];
    setHTML(
      "mass",
      fin(L.tom)
        ? `ZFM <b>${Math.round(L.zfm)}</b> · T/O <b>${Math.round(L.tom)}</b> · landing <b>${r0(LW.lm)}</b> lb`
        : "",
    );
    setHTML("mwarn", massW.map(li).join(""));
    setHTML(
      "sameSum",
      esc(
        [
          `baggage ${s.bag || 0} lb`,
          `trim ${s.trim || "–"}`,
          fin(num(s.bem)) ? `BEM ${s.bem} lb` : "BEM missing",
          s.prep ? `by ${s.prep}` : "no name",
          ...(pair ? ["sheets: 2 per takeoff"] : []),
        ].join(" · "),
      ),
    );

    // step 3: one sheet per takeoff + the destination
    const sheets = [],
      cards = [],
      strip = [];
    let firstIssue = null,
      loading = false,
      incomplete = null,
      incompleteId = null;
    points().forEach((p, idx) => {
      const isD = p === "D";
      const S = sheetData(p, isD ? LW.lm : LW.legs[idx].tow);
      sheets.push(S);
      if (pair && !isD) {
        const arrP = idx + 1 < nLegs() ? "L" + (idx + 1) : "D";
        S.arr = {
          p: arrP,
          apt: aptOf(arrP),
          lm: legLm(idx),
          box: landingBox(arrP, legLm(idx)),
          where: [aptOf(arrP), String(pv(arrP, "rwy") || "").trim() && "RWY " + String(pv(arrP, "rwy")).trim()].filter(Boolean).join(" "),
        };
      }
      const arrOver = !!(res && S.arr && fin(S.arr.box.l.tot) && fin(S.arr.box.llen) && S.arr.box.l.tot > S.arr.box.llen);
      const apt = LAT.find(S.apt),
        name = isD ? "Landing" : `Leg ${idx + 1}`;
      const head = S.t.wind ? S.t.head : 0;
      // airport-limit checks help judge the weather, so they show while drafting; performance-table warnings are results
      const latW = [
        ...(S.apt && validCode(S.apt) && !apt ? [`${S.apt} is not on the LAT approved airport list`] : []),
        ...W.latChecks(apt, { rwy: S.rwy, tow: S.tow, oat: S.oat, head, landing: isD }),
      ];
      if (!res) cards.push(preCard(S, idx, apt, latW));
      const warn = [
        ...new Set(
          res
            ? [
                ...(isD ? [] : S.t.warn),
                ...S.l.warn.map((x) => (isD ? x : "Emergency landing: " + x)),
                ...(S.arr ? S.arr.box.l.warn.map((x) => `Arrival ${S.arr.apt}: ${x}`) : []),
                ...(arrOver && !S.arr.box.l.warn.some((x) => /exceeds runway length/.test(x)) ? [`Arrival ${S.arr.apt}: landing distance exceeds runway length`] : []),
                ...latW,
              ]
            : latW,
        ),
      ];
      if (warn.length && !firstIssue) firstIssue = `${name}: ${warn[0]}`;
      if (busy[p]) loading = true;
      if (S.missing.length && !incomplete) {
        incomplete = name;
        incompleteId = `${p}.${S.missing[0]}`;
      }
      setHTML(
        "lwarn-" + p,
        warn.map(li).join("") +
          (apt && apt.lim.hi && !isD
            ? '<li class="hint">High field: AC off till 1000 ft AGL, lean, static T/O only.</li>'
            : ""),
      );
      const need = isD ? S.l.tot : Math.max(S.t.tod, S.l.tot);
      const ok = fin(need) && fin(S.lenN) ? need <= S.lenN && !arrOver && !warn.length : null;
      if (res) strip.push(stripRow(S, idx, need, ok, warn));
      setHTML(
        "sum-" + p,
        res && fin(need) && fin(S.lenN)
          ? `<span class="${ok ? "good" : "bad"}">${ok ? "✓ OK" : "⚠ check"}</span>`
          : "",
      );
      const hw = S.t.wind && !isCalm(S.wdir, S.wspd) ? (head >= 0 ? `headwind ${r0(head)}` : `tailwind ${r0(-head)}`) : "";
      const anyWx = fin(S.wspd) || fin(S.wdir) || fin(S.oat) || fin(S.qnh);
      setHTML(
        "tiles-" + p,
        [
          tile("Wind", anyWx ? windStr(S.wdir, S.wspd, S.wgust) : "", hw, head < 0 ? "bad" : ""),
          tile("OAT", fin(S.oat) ? S.oat + " °C" : ""),
          tile("QNH", qnhStr(S.qnh)),
          tile("Elevation", S.elev, fin(S.t.da) ? `DA ${r0(S.t.da)} ft` : ""),
          tile(isD ? "Landing mass" : "T/O mass", fin(S.tow) ? r0(S.tow) + " lb" : ""),
          !res
            ? "" // distances only appear in a calculated result
            : isD
            ? tile("Landing dist.", fin(S.l.tot) ? r10(S.l.tot) + " ft" : "", fin(S.lenN) ? `of ${r0(S.lenN)} ft` : "", S.l.tot > S.lenN ? "bad" : "")
            : tile("T/O dist. 50 ft", fin(S.t.tod) ? r10(S.t.tod) + " ft" : "", fin(S.lenN) ? `of ${r0(S.lenN)} ft` : "", S.t.tod > S.lenN ? "bad" : ""),
          !res || isD ? "" : tile("Emerg. landing", fin(S.l.tot) ? r10(S.l.tot) + " ft" : "", "same runway, T/O mass", S.l.tot > S.lenN ? "bad" : ""),
          !res || !S.arr ? "" : tile("Arrival landing", fin(S.arr.box.l.tot) ? r10(S.arr.box.l.tot) + " ft" : "", fin(S.arr.box.llen) ? `${S.arr.where} · of ${r0(S.arr.box.llen)} ft` : S.arr.where, arrOver ? "bad" : ""),
        ].join(""),
      );
      renderRunways(p);
      renderStatus(p, AUTO.filter((k) => s.edited[`${p}.${k}`]).length);
    });

    setHTML("vstrip", strip.join(""));

    // guidance: the first thing still missing
    // Each todo: banner text, short text for the phone action bar, and the field to jump to
    const T = (msg, short, id) => ({ msg, short, id });
    const badStop = [...Array(nStops()).keys()].findIndex((i) => !validCode(stop(i)));
    const t1 =
      badStop >= 0
        ? T("Enter the route: the airports you take off from and land at.", "Enter the route", "R" + badStop)
        : !noserver && !s.time
          ? T("Set the departure time – airport and weather data then load automatically.", "Set the departure time", "time")
          : !String(s.reg).trim()
            ? T("Enter the aircraft registration.", "Enter the aircraft registration", "reg")
            : null;
    const t2 =
      !fin(num(s.bem)) || !fin(num(s.bemCg))
        ? T("Enter BEM and CG from the weight report (under “Usually the same”).", "Enter BEM and CG", fin(num(s.bem)) ? "bemCg" : "bem")
        : !(num(s.w1) > 0)
          ? T("Enter the pilot weight (seat 1).", "Enter the pilot weight", "w1")
          : !(num(s.fuelTO) > 0)
            ? T("Enter the take-off fuel.", "Enter the take-off fuel", "fuelTO")
            : massW[0]
              ? T(massW[0], "Check the masses", "w1")
              : null;
    const t3 = loading
      ? T("Loading airport and weather…", "Loading airport and weather…", null)
      : incomplete
        ? T(
            `${incomplete}: runway or weather values are missing – ${noserver ? "enter them" : "press ↻ refresh or enter them"} under “Edit runway & weather values”.`,
            `${incomplete}: enter runway & weather values`,
            incompleteId,
          )
        : firstIssue
          ? T(firstIssue, "", null)
          : null;
    const todo1 = t1 && t1.msg,
      todo2 = t2 && t2.msg,
      todo3 = t3 && t3.msg;
    const msg = todo1 || todo2 || todo3;
    const kind = !msg ? "ok" : todo1 || (todo2 && todo2 !== massW[0]) || loading ? "todo" : "warn";
    // Calculate is offered once nothing required is missing (limit warnings do not block it)
    const canCalc = !todo1 && !(todo2 && todo2 !== massW[0]) && !loading && !incomplete;
    const need = t1 || (t2 && t2.msg !== massW[0] ? t2 : null) || t3;
    cur = { sheets, L, LW, canCalc, massW, target: need && need.id };
    let bannerKind = kind;
    const pdfOff = res && lastBytes ? "" : " disabled";
    let bar = "";
    if (res) {
      bannerKind = "ok";
      setHTML(
        "next",
        `<b>Result</b> Calculation #${esc(s.calcId)} · ${esc(fmtStamp(s.calcAt))} · tokens left ${tokens()}<div class="acts"><button type="button" class="pri" data-act="download"${pdfOff}>Download PDF</button><button type="button" data-act="print"${pdfOff}>Open to print</button><button type="button" id="editBtn" data-m="edit">Edit</button><button type="button" id="newBtn" data-m="new">New flight</button></div>`,
      );
      bar = `<button type="button" class="pri" data-act="download"${pdfOff}>Download PDF</button><button type="button" data-m="edit">Edit</button>`;
    } else if (canCalc) {
      const none = tokens() < 1;
      bannerKind = none || notice || msg ? "warn" : "ok";
      const text = none
        ? "No tokens left – ask the admin for more."
        : notice || msg || "Ready – check the weather values, then calculate";
      setHTML(
        "next",
        `<b>${bannerKind === "ok" ? "Ready" : "Check"}</b> ${esc(text)}<button type="button" class="pri" id="calcBtn" data-m="calc"${none || pending ? " disabled" : ""}>${pending ? "Calculating…" : "Calculate (1 token)"}</button>`,
      );
      bar = `<button type="button" class="pri" data-m="calc"${none || pending ? " disabled" : ""}>${pending ? "Calculating…" : "Calculate (1 token)"}</button>`;
    } else {
      setHTML("next", `<b>${kind === "warn" ? "Check" : "Next"}</b> ${esc(msg)}${notice ? `<span class="note">${esc(notice)}</span>` : ""}`);
      const bt = (need && need.short) || "Complete the form";
      bar = `<button type="button" data-m="todo" title="${esc(need ? need.msg : "")}"${need && need.id ? "" : " disabled"}>${esc(bt.length > 52 ? bt.slice(0, 51) + "…" : bt)}</button>`;
    }
    setHTML("mbar", bar);
    byId("next").className = bannerKind;
    [todo1, todo2, todo3].forEach((t, i) => {
      byId("tick" + (i + 1)).textContent = t ? "" : "✓";
    });
    // steps 1 and 2: summary line and whether they may collapse (complete, no missing value, no mass warning)
    const dts = fmtDay(s.date);
    stepInfo = {
      1: {
        done: !todo1,
        text: [[...Array(nStops()).keys()].map(stop).join(" → "), [dts, s.time].filter(Boolean).join(" "), String(s.reg).trim().toUpperCase()].filter(Boolean).join(" · "),
      },
      2: {
        done: !todo2,
        text: [`Pilot ${s.w1 || "–"}`, `${occ} POB`, `${s.fuelTO || 0} USG`, fin(L.tom) ? `TOM ${Math.round(L.tom)} lb` : ""].filter(Boolean).join(" · "),
      },
    };
    applyCollapse();
    syncChrome();

    // The single gate: the PDF is only built and previewed for a calculated result.
    const host = $("#pages");
    if (!res) {
      seq++; // drop any preview still rendering
      lastBytes = null;
      // draft: the pre-flight panel (weather only) sits where the PDF will be; on phones inside the left column above step 3
      if (host.dataset.ph !== "1") {
        host.replaceChildren();
        host.dataset.ph = "1";
      }
      const slot = phoneMq && phoneMq.matches ? byId("preSlot") : host;
      if (pre.parentNode !== slot) slot.appendChild(pre);
      const html = preHTML(cards, L, LW, massW);
      if (pre.innerHTML !== html) pre.innerHTML = html;
      staleSig = staleNow();
      if (!ageTimer) ageTimer = setInterval(tickAge, 60000);
      syncChrome();
      return;
    }
    if (ageTimer) {
      clearInterval(ageTimer);
      ageTimer = null;
    }
    pre.remove();
    if (host.dataset.ph === "1") {
      host.innerHTML = '<p class="ph">Preparing the PDF…</p>';
      host.dataset.ph = "2";
    }
    buildPdf(s, L, pdfSheets(sheets), occ)
      .then((b) => {
        if (!isRes()) return;
        lastBytes = b;
        syncChrome();
        return preview(b);
      })
      .catch((e) => {
        console.error(e);
        setHTML("next", "<b>PDF error</b> " + esc(e.message));
      });
  }

  /* ---------- account chrome, locking, toast ---------- */
  let cur = null; // last computed sheets, for the confirm dialog (+ the field the phone bar jumps to)
  let stepInfo = null; // steps 1 and 2: { done, text } from the last update()
  const fmtStamp = (iso) => {
    const d = new Date(iso);
    return isNaN(d) ? String(iso || "") : d.toLocaleString([], { dateStyle: "medium", timeStyle: "short" });
  };
  const initials = (n) => {
    const w = String(n || "").split(/[\s.@_-]+/).filter(Boolean);
    return w.length ? (w[0][0] + (w.length > 1 ? w[1][0] : "")).toUpperCase() : "?";
  };
  const MON3 = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const fmtDay = (d) => {
    const m = /^\d{4}-(\d\d)-(\d\d)$/.exec(d || "");
    return m ? `${+m[2]} ${MON3[+m[1] - 1]}` : "";
  };
  function syncChrome() {
    const t = tokens();
    const b = byId("tokens");
    b.textContent = `${t} token${t === 1 ? "" : "s"}`;
    b.className = "badge" + (t < 1 ? " low" : "");
    const who = profile.name || profile.email || "";
    byId("who").textContent = who;
    byId("ini").textContent = initials(who);
    byId("acctBtn").setAttribute("aria-label", `Account menu${who ? ", " + who : ""}`);
    byId("adminLink").hidden = profile.role !== "admin";
    const lock = isLocked(),
      res = isRes();
    // the collapsed-step summary buttons stay usable in result mode (they only expand the step)
    document.querySelectorAll("#steps input, #steps select, #steps textarea, #steps button:not(.sumbtn)").forEach((el) => {
      el.disabled = lock;
    });
    document.querySelectorAll("[data-act]").forEach((el) => {
      el.disabled = !(res && lastBytes);
    });
    byId("reset").disabled = pending;
    byId("histBtn").disabled = pending;
  }

  /* ---------- collapsing finished steps 1 and 2 (CSS only; the inputs stay in the DOM) ---------- */
  const collapsed = { 1: false, 2: false }, // currently shown as a one-line summary
    leftStep = { 1: false, 2: false }; // focus has been in this step and left it
  let pressing = false; // a pointer is down inside step 1 or 2: no collapsing under the user's finger
  const reducedMotion = () => window.matchMedia && matchMedia("(prefers-reduced-motion: reduce)").matches;
  function applyCollapse() {
    if (!stepInfo) return;
    [1, 2].forEach((n) => {
      const info = stepInfo[n],
        sec = byId("step" + n),
        btn = byId("sumbtn" + n),
        inside = sec.contains(document.activeElement);
      if (!info.done || inside) {
        // incomplete (also after loading a template) or being edited: always open
        collapsed[n] = false;
        leftStep[n] = false;
      } else if (leftStep[n] && !pressing) collapsed[n] = true;
      sec.classList.toggle("collapsed", collapsed[n]);
      btn.hidden = !collapsed[n];
      if (collapsed[n]) btn.querySelector(".sumtxt").textContent = info.text;
    });
  }
  function expandStep(n, focus) {
    collapsed[n] = false;
    leftStep[n] = false;
    applyCollapse();
    if (!focus) return;
    const first = byId(n === 1 ? "R0" : "w1"),
      sec = byId("step" + n);
    sec.tabIndex = -1; // lock mode: focus stays inside the step so it is not collapsed again at once
    (first && !first.disabled ? first : sec).focus();
  }
  // Phone bar: jump to the field the todo is about (open its details, scroll, focus)
  function focusField(id) {
    const el = id && byId(id);
    if (!el || isLocked()) return;
    const sec = el.closest(".card[data-step]");
    if (sec && collapsed[+sec.dataset.step]) expandStep(+sec.dataset.step, false);
    for (let d = el.closest("details"); d; d = d.parentElement && d.parentElement.closest("details")) d.open = true;
    el.scrollIntoView({ block: "center", behavior: reducedMotion() ? "auto" : "smooth" });
    el.focus({ preventScroll: true });
  }
  document.addEventListener("pointerdown", (e) => {
    const sec = e.target.closest && e.target.closest("#step1, #step2");
    pressing = !!sec;
    if (sec) leftStep[+sec.dataset.step] = false;
  });
  ["pointerup", "pointercancel"].forEach((ev) => document.addEventListener(ev, () => (pressing = false)));
  document.addEventListener("focusout", (e) => {
    const sec = e.target.closest && e.target.closest("#step1, #step2");
    if (!sec) return;
    setTimeout(() => {
      // ignore: focus is still in the step, a pointer is pressing in it, or the field was just re-rendered away
      if (pressing || !e.target.isConnected || sec.contains(document.activeElement)) return;
      leftStep[+sec.dataset.step] = true;
      applyCollapse();
    }, 0);
  });

  /* ---------- account menu ---------- */
  const acctBtn = byId("acctBtn"),
    acctMenu = byId("acctMenu");
  const menuItems = () => [...acctMenu.querySelectorAll("[role=menuitem]")].filter((el) => !el.hidden && !el.disabled);
  const menuOpen = () => !acctMenu.hidden;
  function openMenu() {
    acctMenu.hidden = false;
    acctBtn.setAttribute("aria-expanded", "true");
    const it = menuItems();
    if (it[0]) it[0].focus();
  }
  function closeMenu(refocus) {
    if (!menuOpen()) return;
    acctMenu.hidden = true;
    acctBtn.setAttribute("aria-expanded", "false");
    if (refocus) acctBtn.focus();
  }
  acctBtn.addEventListener("click", () => (menuOpen() ? closeMenu(true) : openMenu()));
  acctBtn.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (!menuOpen()) openMenu();
    }
  });
  // capture: the menu closes (focus back on the button) before the chosen item's own handler runs, so a dialog restores focus to the button
  acctMenu.addEventListener("click", (e) => {
    if (e.target.closest("[role=menuitem]")) closeMenu(true);
  }, true);
  acctMenu.addEventListener("keydown", (e) => {
    const it = menuItems(),
      i = it.indexOf(document.activeElement);
    const go = (j) => {
      e.preventDefault();
      if (it.length) it[(j + it.length) % it.length].focus();
    };
    if (e.key === "ArrowDown") go(i + 1);
    else if (e.key === "ArrowUp") go(i < 0 ? it.length - 1 : i - 1);
    else if (e.key === "Home") go(0);
    else if (e.key === "End") go(it.length - 1);
    else if (e.key === "Escape") {
      e.preventDefault();
      closeMenu(true);
    } else if (e.key === "Tab") closeMenu(false);
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && menuOpen()) closeMenu(true);
  });
  document.addEventListener("click", (e) => {
    if (menuOpen() && !e.target.closest(".menu")) closeMenu(false);
  });

  let toastTimer = null;
  function toast(msg) {
    const el = byId("toast");
    el.textContent = msg;
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (el.hidden = true), 3500);
  }
  // Native <dialog> (Esc closes it). Resolves with the data-v of the clicked button, or null.
  let dlgN = 0;
  function dialog(html, onOpen) {
    return new Promise((resolve) => {
      const d = document.createElement("dialog"),
        id = "dlgT" + ++dlgN;
      d.innerHTML = html.replace("{ID}", id);
      d.setAttribute("aria-labelledby", id);
      let v = null;
      d.addEventListener("click", (e) => {
        const b = e.target.closest("[data-v]");
        if (b) {
          v = b.dataset.v;
          d.close();
        }
      });
      d.addEventListener("close", () => {
        d.remove();
        resolve(v);
      });
      document.body.appendChild(d);
      d.showModal();
      if (onOpen) onOpen(d);
    });
  }
  const changed = () => {
    if (window.App.onChange) window.App.onChange();
  };
  const schedule = () => {
    clearTimeout(timer);
    timer = setTimeout(update, 120);
  };

  // BEM / CG: fleet table (fleet.js) prefills by registration; anything typed is kept as a per-registration override.
  const fleetOf = (r) => (window.FLEET || {})[r];
  function bemNote(r) {
    const f = fleetOf(r),
      o = (lsGet(BEMKEY) || {})[r];
    byId("bemNote").innerHTML = o
      ? `BEM ${esc(o.bem)} lb · CG ${esc(o.cg)} in – your own values for ${esc(r)}.` +
        (f ? ' <button type="button" id="bemRestore">Restore fleet values</button>' : "")
      : f
        ? `${esc(r)}: BEM ${f.bem} lb · CG ${f.cg} in (fleet table).`
        : r
          ? `${esc(r)} is not in the fleet table – enter BEM and CG under “Usually the same”.`
          : "";
  }
  function setState(k, v) {
    state[k] = v;
    const el = byId(k);
    if (el) {
      if (el.type === "checkbox") el.checked = !!v;
      else el.value = v;
    }
  }
  function applyBem(r) {
    const v = (lsGet(BEMKEY) || {})[r] || fleetOf(r);
    if (v) {
      setState("bem", v.bem);
      setState("bemCg", v.cg);
    }
    bemNote(r);
  }
  const regVal = () => String(state.reg || "").trim().toUpperCase();
  if (isRes()) bemNote(regVal()); // a calculated sheet keeps the BEM and CG it was calculated with
  else applyBem(regVal());

  // A changed airport invalidates what was fetched or typed for that point.
  function resetPoint(p) {
    [...AUTO, ...META].forEach((k) => {
      delete state[`${p}.${k}`];
      delete state.edited[`${p}.${k}`];
    });
  }
  function commitStop(el) {
    const k = el.dataset.k,
      i = +k.slice(1),
      v = el.value.trim().toUpperCase();
    if (stop(i) === v && el.value === v) return;
    el.value = state[k] = v;
    if (i < nLegs()) resetPoint("L" + i);
    if (i === nStops() - 1) resetPoint("D");
    renderLegs();
    schedule();
    changed();
  }
  document.addEventListener("input", (e) => {
    const el = e.target;
    if (!el.dataset || !el.dataset.k || isLocked()) return;
    notice = "";
    const k = el.dataset.k;
    if (/^R\d+$/.test(k)) {
      // commit while typing once it is a known airport or four characters; otherwise on blur
      const v = el.value.trim().toUpperCase();
      if (LAT.find(v) || v.length === 4) commitStop(el);
      return;
    }
    state[k] = el.type === "checkbox" ? el.checked : el.value;
    const m = /^(L\d+|D)\.(.+)$/.exec(k);
    if (m && AUTO.includes(m[2])) {
      if (el.value === "") delete state.edited[k];
      else state.edited[k] = 1;
    }
    if (k === "reg") applyBem(regVal());
    else if (k === "bem" || k === "bemCg") {
      const r = regVal();
      if (r) {
        const map = lsGet(BEMKEY) || {},
          f = fleetOf(r),
          cur = { bem: state.bem, cg: state.bemCg };
        if (f && num(cur.bem) === f.bem && num(cur.cg) === f.cg) delete map[r];
        else map[r] = cur;
        lsSet(BEMKEY, map);
        bemNote(r);
      }
    }
    schedule();
    changed();
  });
  document.addEventListener("change", (e) => {
    const el = e.target;
    if (isLocked()) return;
    if (el.dataset && /^R\d+$/.test(el.dataset.k || "")) return commitStop(el);
    if (el.dataset && el.dataset.k === "reg") {
      el.value = state.reg = regVal();
      applyBem(state.reg);
      schedule();
    }
    const p = el.dataset && el.dataset.rsel;
    if (p && el.value !== "") {
      const end = (state[`${p}.ends`] || [])[+el.value];
      if (!end) return;
      ["rwy", "hdg", "len", "surf"].forEach((k) => delete state.edited[`${p}.${k}`]);
      setState(`${p}.rwy`, end.id);
      setState(`${p}.hdg`, end.hdg);
      setState(`${p}.len`, end.len);
      setState(`${p}.surf`, end.surf);
      state[`${p}.pick`] = end.id; // keep this choice when the weather refreshes
      schedule();
    }
  });
  function act(name) {
    if (!lastBytes || !isRes()) return;
    const url = URL.createObjectURL(new Blob([lastBytes], { type: "application/pdf" }));
    if (name === "print") return window.open(url, "_blank");
    const a = document.createElement("a");
    a.href = url;
    a.download = `SR20_TO_LoadSheet_${String(state.reg || "flight").replace(/\W+/g, "")}_${state.date || ""}.pdf`;
    a.click();
  }
  document.addEventListener("click", (e) => {
    const t = e.target;
    const a = t.closest("[data-act]");
    if (a) return act(a.dataset.act);
    // banner and phone bar share these handlers
    const m = t.closest("[data-m]");
    if (m) {
      const f = m.dataset.m;
      if (f === "calc") return startCalculate();
      if (f === "edit") return editResult();
      if (f === "new") return newFlight();
      if (f === "todo") return focusField(cur && cur.target);
    }
    const pe = t.closest("[data-pre-edit]");
    if (pe) return focusField(`${pe.dataset.preEdit}.elev`);
    const sb = t.closest(".sumbtn");
    if (sb) return expandStep(+sb.dataset.step, true);
    if (isLocked()) return;
    if (t.closest("#addStop")) {
      const n = nStops();
      setState("R" + n, "");
      state.nR = n + 1;
      // the old destination becomes a takeoff point: move what was fetched for it
      if (n > 1)
        [...AUTO, ...META].forEach((k) => {
          if (state[`D.${k}`] !== undefined) state[`L${n - 1}.${k}`] = state[`D.${k}`];
        });
      delete state[`L${n - 1}.fkey`];
      delete state[`L${n - 1}.pick`];
      resetPoint("D");
      renderRoute();
      renderLegs();
      byId("R" + n).focus();
      schedule();
      changed();
      return;
    }
    const del = t.closest("[data-del]");
    if (del) {
      const d = +del.dataset.del,
        n = nStops();
      for (let i = d; i < n - 1; i++) state["R" + i] = state["R" + (i + 1)];
      delete state["R" + (n - 1)];
      state.nR = n - 1;
      // the takeoff from the removed stop disappears; later takeoffs move up one
      const moved = {};
      Object.keys(state)
        .filter((k) => /^L\d+\./.test(k))
        .forEach((k) => {
          const [, i, f] = /^L(\d+)\.(.+)$/.exec(k);
          if (+i !== d) moved[`L${+i > d ? +i - 1 : +i}.${f}`] = state[k];
          delete state[k];
        });
      Object.assign(state, moved);
      state.edited = {};
      resetPoint("D");
      for (let i = nLegs(); i < n; i++) resetPoint("L" + i);
      renderRoute();
      renderLegs();
      schedule();
      changed();
      return;
    }
    const un = t.closest("[data-unedit]");
    if (un) {
      const p = un.dataset.unedit;
      AUTO.forEach((k) => delete state.edited[`${p}.${k}`]);
      delete state[`${p}.pick`];
      if (window.App.refresh) window.App.refresh(p);
      schedule();
      return;
    }
    const rf = t.closest("[data-refresh]");
    if (rf) {
      if (window.App.refresh) window.App.refresh(rf.dataset.refresh);
      return;
    }
    if (t.closest("#bemRestore")) {
      const map = lsGet(BEMKEY) || {},
        r = regVal();
      delete map[r];
      lsSet(BEMKEY, map);
      applyBem(r);
      schedule();
      return;
    }
    const fb = t.closest("[data-fuel]");
    if (fb) {
      setState("fuelTO", fb.dataset.fuel);
      schedule();
    }
  });
  window.addEventListener("resize", schedule);
  function newFlight() {
    if (pending) return;
    notice = "";
    collapsed[1] = collapsed[2] = leftStep[1] = leftStep[2] = false;
    Object.keys(state).forEach((k) => delete state[k]);
    Object.assign(state, DEFAULTS, { date: today(), edited: {} });
    fill($("#steps"));
    renderRoute();
    renderLegs();
    applyBem(regVal());
    update();
    changed();
  }
  byId("reset").addEventListener("click", newFlight);

  /* ---------- calculate (1 token), edit, history ---------- */
  function sourceOf(p) {
    const label = Snapshot.sourceLabel(Snapshot.source(state[`${p}.info`]));
    if (!label) return "entered by you";
    return ["wdir", "wspd", "wgust", "qnh", "oat"].some((k) => state.edited[`${p}.${k}`]) ? `${label}, some values edited by you` : label;
  }
  async function startCalculate() {
    if (pending || isRes() || !cur || !cur.canCalc || tokens() < 1) return;
    const { sheets, L, LW } = cur;
    const lines = sheets.map((S, i) => {
      const where = [S.apt, S.rwy && "RWY " + S.rwy].filter(Boolean).join(" ");
      return `${S.isD ? "Landing" : "Leg " + (i + 1)} · ${where} · wind ${windStr(S.wdir, S.wspd, S.wgust)} · ${fin(S.oat) ? S.oat + " °C" : "– °C"} · QNH ${qnhStr(S.qnh) || "–"} · source: ${sourceOf(S.p)}`;
    });
    const old = sheets.map((S, i) => ({ name: S.isD ? "Landing" : "Leg " + (i + 1), w: wxInfo(S.p) })).filter((x) => x.w.stale);
    const ok = await dialog(
      `<h3 id="{ID}">Calculate this flight?</h3>
      <ul>${lines.map(li).join("")}</ul>
      ${old.length ? `<ul class="lwarn">${old.map((x) => li(`Weather for ${x.name} is ${x.w.min} min old.`)).join("")}</ul>` : ""}
      <p>TOM <b>${r0(L.tom)}</b> lb · LM <b>${r0(LW.lm)}</b> lb</p>
      <p><b>Uses 1 token</b> (you have ${tokens()}). Changing anything afterwards and calculating again costs another token; identical inputs are free.</p>
      <div class="btns"><button type="button" data-v="no">Cancel</button>${old.length && !noserver ? '<button type="button" data-v="refresh">Refresh weather first</button>' : ""}<button type="button" class="pri" data-v="yes">Calculate (1 token)</button></div>`,
    );
    if (ok === "refresh") {
      if (window.App.refresh) window.App.refresh(true);
      return;
    }
    if (ok !== "yes" || pending || isRes()) return;
    pending = true;
    notice = "";
    update();
    try {
      const m = Snapshot.meta(state),
        r = await Auth.rpc("calculate", {
          p_inputs: Snapshot.canonical(state),
          p_flight_date: m.flight_date,
          p_dep_time: m.dep_time,
          p_route: m.route,
          p_reg: m.reg,
        });
      state.mode = "result";
      state.calcId = r.id;
      state.calcAt = r.created_at;
      if (Number.isFinite(+r.balance)) profile.tokens = +r.balance;
      toast(r.charged ? "1 token used" : "Already calculated – no token used");
    } catch (e) {
      const code = String((e && e.message) || e);
      if (code === "account_disabled") return Auth.signOut();
      if (code === "no_tokens") {
        notice = "No tokens left – ask the admin for more.";
        Auth.profile().then((p) => {
          profile = p;
          update();
        }, () => {});
      } else
        notice = /Failed to fetch|NetworkError|Load failed|network/i.test(code)
          ? "No connection – check your network and calculate again. No token was used."
          : `Could not calculate (${code}). No token was used.`;
    } finally {
      pending = false;
      update();
    }
  }
  function editResult() {
    if (!isRes()) return;
    state.mode = "draft";
    delete state.calcId;
    delete state.calcAt;
    notice = "";
    update();
    changed();
  }
  const blankState = () => Object.assign({}, DEFAULTS, { date: today() });

  // Return flight: the same flight the other way round, as a state map (input: Snapshot.fromCanonical output).
  // Stops are reversed and per-point keys follow their airport (L<i> = stop i, D = last stop); the legs' flight time
  // and trip fuel follow their leg (leg i <-> leg n-2-i); ground time follows its stop. Airport/runway/weather values,
  // fetch bookkeeping, edited flags, slope, mass overrides and refuel amounts are dropped (different runway, weather
  // must be refetched, refuel meaning flips). Date stays, time is cleared. People, fuel, BEM, reg, trim stay.
  function reverseRoute(st) {
    const n = Math.max(1, parseInt(st.nR, 10) || 1),
      legs = n - 1,
      out = {};
    Object.keys(st).forEach((k) => {
      if (!/^(L\d+|D)\./.test(k) && !/^R\d+$/.test(k) && k !== "edited") out[k] = st[k];
    });
    out.nR = n;
    for (let i = 0; i < n; i++) out["R" + i] = st["R" + (n - 1 - i)] || "";
    out.time = "";
    out.edited = {};
    const copy = (from, to, k) => {
      if (st[`${from}.${k}`] !== undefined) out[`${to}.${k}`] = st[`${from}.${k}`];
    };
    for (let i = 0; i < legs; i++) ["dur", "trip"].forEach((k) => copy("L" + i, "L" + (legs - 1 - i), k));
    for (let i = 0; i < n; i++) {
      const from = i < legs ? "L" + i : "D",
        to = n - 1 - i < legs ? "L" + (n - 1 - i) : "D";
      copy(from, to, "eflaps");
      if (from !== "D" && to !== "D") copy(from, to, "ac");
      if (i > 0 && i < n - 1) copy(from, to, "gnd");
    }
    return out;
  }
  // Replace the form with a stored calculation's state: as a result (free) or as a draft (template / return flight).
  function loadInputs(st, row, asResult, ret) {
    Object.keys(state).forEach((k) => delete state[k]);
    Object.assign(state, DEFAULTS, st, { edited: {} });
    if (asResult) {
      // protect the stored values from a later weather fetch (Edit keeps them)
      points().forEach((p) =>
        AUTO.forEach((k) => {
          const v = state[`${p}.${k}`];
          if (v !== undefined && v !== "") state.edited[`${p}.${k}`] = 1;
        }),
      );
      state.mode = "result";
      state.calcId = row.id;
      state.calcAt = row.created_at;
    } else if (!state.date || state.date < today()) {
      state.date = today();
      state.time = "";
      clearFetched();
    }
    notice = "";
    fill($("#steps"));
    renderRoute();
    renderLegs();
    bemNote(regVal());
    update();
    changed();
    if (ret) toast(`Return flight: ${stop(0)} → ${stop(nStops() - 1)} – set the departure time`);
  }
  // how: "open" (result), "tpl" (draft template) or "ret" (draft, route reversed)
  async function useCalc(id, how) {
    let row;
    try {
      // own calculations only (admins could read everyone's; that view lives in admin.html)
      row = (await Auth.rest(`/calculations?id=eq.${encodeURIComponent(id)}&user_id=eq.${profile.id}&select=id,created_at,inputs`))[0];
    } catch (e) {
      return toast("Could not load that calculation: " + String((e && e.message) || e));
    }
    if (!row || !row.inputs) return toast("Calculation not found");
    let st = Snapshot.fromCanonical(row.inputs);
    if (how === "ret") st = reverseRoute(st);
    if (!isRes() && Snapshot.fingerprint(state) !== Snapshot.fingerprint(blankState()) && Snapshot.fingerprint(state) !== Snapshot.fingerprint(st)) {
      const ok = await dialog(
        `<h3 id="{ID}">Replace what you entered?</h3><p>The form has values that are not saved as a calculation. Loading calculation #${esc(row.id)}${how === "ret" ? " as a return flight" : ""} replaces them.</p>
        <div class="btns"><button type="button" data-v="no">Keep mine</button><button type="button" class="pri" data-v="yes">Replace</button></div>`,
      );
      if (ok !== "yes") return;
    }
    loadInputs(st, row, how === "open", how === "ret");
  }
  // "2 h ago" for the history (the absolute time goes in the title)
  function relTime(iso, now = Date.now()) {
    const t = new Date(iso).getTime();
    if (isNaN(t)) return "";
    const m = Math.floor((now - t) / 60000);
    if (m < 1) return "just now";
    if (m < 60) return `${m} min ago`;
    if (m < 1440) return `${Math.floor(m / 60)} h ago`;
    if (m < 14400) return `${Math.floor(m / 1440)} d ago`;
    return new Date(t).toLocaleDateString([], { dateStyle: "medium" });
  }
  const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  // flight date -> group heading: Today / Tomorrow / Yesterday / "Thu 20 Nov 2026"; none -> "No date"
  function dayHeading(d, base = today()) {
    const m = /^(\d{4})-(\d\d)-(\d\d)$/.exec(d || "");
    if (!m) return "No date";
    const day = (x) => Date.UTC(+x[1], +x[2] - 1, +x[3]) / 864e5,
      diff = day(m) - day(/^(\d{4})-(\d\d)-(\d\d)$/.exec(base));
    if (diff === 0) return "Today";
    if (diff === 1) return "Tomorrow";
    if (diff === -1) return "Yesterday";
    return `${DOW[new Date(Date.UTC(+m[1], +m[2] - 1, +m[3])).getUTCDay()]} ${+m[3]} ${MON3[+m[2] - 1]} ${m[1]}`;
  }
  function histRows(rows, q) {
    q = String(q || "").trim().toLowerCase().replace(/^#/, "");
    const hit = rows.filter((r) => !q || [r.route, r.reg, String(r.id)].some((x) => String(x || "").toLowerCase().includes(q)));
    if (!hit.length) return `<p class="hempty">${rows.length ? "No calculation matches your search." : "No calculations yet."}</p>`;
    const groups = new Map();
    hit.forEach((r) => {
      const k = r.flight_date || "";
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(r);
    });
    const keys = [...groups.keys()].sort((a, b) => (!a ? 1 : !b ? -1 : a < b ? 1 : -1)); // dates newest first, "No date" last
    return keys
      .map((k) => {
        const g = groups.get(k).sort((a, b) => (a.created_at < b.created_at ? 1 : a.created_at > b.created_at ? -1 : 0));
        return `<h4 class="hgrp">${esc(dayHeading(k))}</h4><ul class="hist">${g
          .map(
            (r) => `<li><span class="hmeta"><b>${esc(String(r.route || "–").split("-").join(" → "))}</b>${r.dep_time ? " · " + esc(r.dep_time) : ""} · ${esc(r.reg || "–")} · #${r.id}<br>calculated <span title="${esc(fmtStamp(r.created_at))}">${esc(relTime(r.created_at) || fmtStamp(r.created_at))}</span></span>
            <span class="hbtn"><button type="button" data-v="open:${r.id}">Open</button><button type="button" data-v="tpl:${r.id}">Use as template</button><button type="button" data-v="ret:${r.id}">Return flight</button></span></li>`,
          )
          .join("")}</ul>`;
      })
      .join("");
  }
  async function openHistory() {
    const list = (d, html) => (d.querySelector("#histList").innerHTML = html);
    const v = await dialog(
      `<h3 id="{ID}">History</h3><input type="search" id="histQ" placeholder="Search route, registration or #number" aria-label="Search history by route, registration or number" autocomplete="off" disabled>
      <div id="histList" aria-live="polite">Loading…</div>
      <div class="btns"><button type="button" data-v="close">Close</button></div>`,
      async (d) => {
        const q = d.querySelector("#histQ");
        const phone = phoneMq && phoneMq.matches;
        if (phone) d.querySelector("[data-v=close]").focus(); // no on-screen keyboard popping up
        try {
          const rows = (await Auth.rest(`/calculations?user_id=eq.${profile.id}&select=id,created_at,flight_date,dep_time,route,reg&order=created_at.desc&limit=50`)) || [];
          const ok = rows.filter((r) => /^\d+$/.test(String(r.id)));
          if (!ok.length) return list(d, "<p>No calculations yet. Each calculation you run is listed here.</p>");
          q.disabled = false;
          if (!phone) q.focus();
          const draw = () => list(d, histRows(ok, q.value));
          q.addEventListener("input", draw);
          draw();
        } catch (e) {
          list(d, `<p class="bad">Could not load the history: ${esc(String((e && e.message) || e))}</p>`);
        }
      },
    );
    const m = /^(open|tpl|ret):(\d+)$/.exec(v || "");
    if (m) useCalc(m[2], m[1]);
  }
  byId("histBtn").addEventListener("click", openHistory);
  byId("signout").addEventListener("click", () => Auth.signOut());

  // Tokens granted (or an account disabled) while this page is open: re-read the profile when the tab comes back.
  let lastProfileAt = Date.now();
  function refreshProfile() {
    if (document.visibilityState !== "visible" || Date.now() - lastProfileAt < 10000) return;
    lastProfileAt = Date.now();
    Auth.profile().then((p) => {
      if (!p) return;
      if (p.disabled) return Auth.signOut();
      const changed = p.tokens !== profile.tokens || p.role !== profile.role;
      profile = p;
      if (changed) update();
    }, () => {});
  }
  document.addEventListener("visibilitychange", refreshProfile);
  window.addEventListener("focus", refreshProfile);

  // For autofill.js: it reads the flight through this and writes what it fetched.
  window.App = {
    noserver,
    points: () => points().map((p) => ({ p, icao: aptOf(p), landing: p === "D" })),
    get: (k) => state[k],
    reverseRoute,
    pv,
    // write a fetched value; a value the user typed is left alone
    setAuto(p, k, v) {
      if (isLocked() || state.edited[`${p}.${k}`]) return;
      setState(`${p}.${k}`, v);
    },
    setMeta(p, o) {
      if (isLocked()) return;
      Object.keys(o).forEach((k) => {
        if (o[k] === undefined) delete state[`${p}.${k}`];
        else state[`${p}.${k}`] = o[k];
      });
      schedule();
    },
    setBusy(p, b) {
      busy[p] = b;
      schedule();
    },
    onChange: null,
    refresh: null,
  };
  update();
  window.dispatchEvent(new Event("app-ready")); // autofill.js starts now
  document.body.classList.remove("booting");
  }
})();
