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
  $("#steps").innerHTML = `
    <section class="card">${step(1, "Flight")}
      <div class="fg">
        <div class="wide"><span class="lbl">Route – every airport you take off from or land at</span><div class="route" id="route"></div></div>
        ${control("date", "Date", "d")}
        ${control("time", "Departure time (local)", "h")}
        ${control("reg", "A/C registration", "t", 'list="reglist" autocomplete="off" spellcheck="false"', "N4xxAV")}
        ${control("flight", "Flight", "t", 'autocomplete="off"', "e.g. D1_1")}
        <div class="wide bemnote" id="bemNote"></div>
      </div>
    </section>
    <section class="card">${step(2, "People &amp; fuel")}
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
      </div></details>
    </section>
    <h2 class="sech">${stepIn(3, "Check each takeoff and the landing")}</h2>
    <div id="legs"></div>
    <section class="card">${step(4, "Print")}
      <div class="fg">
        <button type="button" class="pri" data-act="download">Download PDF</button>
        <button type="button" data-act="print">Open to print</button>
      </div>
    </section>`;
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

  /* ---------- one sheet ---------- */
  // Takeoff point: T/O at that leg's mass; landing box = emergency return to the same runway at T/O mass.
  // Destination: everything at landing mass; landing box = the normal landing there.
  function sheetData(p, mass) {
    const isD = p === "D";
    const g = (k) => pv(p, k);
    const n = (k) => num(g(k));
    const tow = isD ? (fin(n("ewt")) ? n("ewt") : mass) : fin(n("tow")) ? n("tow") : mass;
    const common = {
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
      surf: g("surf"),
    };
    const t = P.takeoff(Object.assign({ tow, ac: !isD && g("ac") }, common));
    const ldw = isD ? tow : fin(n("ewt")) ? n("ewt") : tow;
    const flaps = parseInt(g("eflaps"), 10);
    const l = P.landing(Object.assign({ flaps, w: ldw }, common));
    const apt = aptOf(p),
      rwy = String(g("rwy") || "").trim();
    return {
      p,
      isD,
      t,
      l,
      ldw,
      lflaps: flaps,
      llen: n("len"),
      lapt: [apt, rwy].filter(Boolean).join(" "),
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
    $("#sum").textContent = fin(L.tom)
      ? `ZFM ${Math.round(L.zfm)} · TOM ${Math.round(L.tom)} · LM ${r0(LW.lm)} lb`
      : "";
    setHTML(
      "sameSum",
      esc(
        [
          `baggage ${s.bag || 0} lb`,
          `trim ${s.trim || "–"}`,
          fin(num(s.bem)) ? `BEM ${s.bem} lb` : "BEM missing",
          s.prep ? `by ${s.prep}` : "no name",
        ].join(" · "),
      ),
    );

    // step 3: one sheet per takeoff + the destination
    const sheets = [];
    let firstIssue = null,
      loading = false,
      incomplete = null;
    points().forEach((p, idx) => {
      const isD = p === "D";
      const S = sheetData(p, isD ? LW.lm : LW.legs[idx].tow);
      sheets.push(S);
      const apt = LAT.find(S.apt),
        name = isD ? "Landing" : `Leg ${idx + 1}`;
      const head = S.t.wind ? S.t.head : 0;
      // airport-limit checks help judge the weather, so they show while drafting; performance-table warnings are results
      const latW = [
        ...(S.apt && validCode(S.apt) && !apt ? [`${S.apt} is not on the LAT approved airport list`] : []),
        ...W.latChecks(apt, { rwy: S.rwy, tow: S.tow, oat: S.oat, head, landing: isD }),
      ];
      const warn = [
        ...new Set(
          res
            ? [
                ...(isD ? [] : S.t.warn),
                ...S.l.warn.map((x) => (isD ? x : "Emergency landing: " + x)),
                ...latW,
              ]
            : latW,
        ),
      ];
      if (warn.length && !firstIssue) firstIssue = `${name}: ${warn[0]}`;
      if (busy[p]) loading = true;
      if (S.missing.length && !incomplete) incomplete = name;
      setHTML(
        "lwarn-" + p,
        warn.map(li).join("") +
          (apt && apt.lim.hi && !isD
            ? '<li class="hint">High field: AC off till 1000 ft AGL, lean, static T/O only.</li>'
            : ""),
      );
      const need = isD ? S.l.tot : Math.max(S.t.tod, S.l.tot);
      const ok = fin(need) && fin(S.lenN) ? need <= S.lenN && !warn.length : null;
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
        ].join(""),
      );
      renderRunways(p);
      renderStatus(p, AUTO.filter((k) => s.edited[`${p}.${k}`]).length);
    });

    // guidance: the first thing still missing
    const routeBad = [...Array(nStops()).keys()].some((i) => !validCode(stop(i)));
    const todo1 = routeBad
      ? "Enter the route: the airports you take off from and land at."
      : !noserver && !s.time
        ? "Set the departure time – airport and weather data then load automatically."
        : !String(s.reg).trim()
          ? "Enter the aircraft registration."
          : null;
    const todo2 =
      !fin(num(s.bem)) || !fin(num(s.bemCg))
        ? "Enter BEM and CG from the weight report (under “Usually the same”)."
        : !(num(s.w1) > 0)
          ? "Enter the pilot weight (seat 1)."
          : !(num(s.fuelTO) > 0)
            ? "Enter the take-off fuel."
            : massW[0] || null;
    const todo3 = loading
      ? "Loading airport and weather…"
      : incomplete
        ? `${incomplete}: runway or weather values are missing – ${noserver ? "enter them" : "press ↻ refresh or enter them"} under “Edit runway & weather values”.`
        : firstIssue;
    const msg = todo1 || todo2 || todo3;
    const kind = !msg ? "ok" : todo1 || (todo2 && todo2 !== massW[0]) || loading ? "todo" : "warn";
    // Calculate is offered once nothing required is missing (limit warnings do not block it)
    const canCalc = !todo1 && !(todo2 && todo2 !== massW[0]) && !loading && !incomplete;
    cur = { sheets, L, LW, canCalc, massW };
    let bannerKind = kind;
    if (res) {
      bannerKind = "ok";
      setHTML(
        "next",
        `<b>Result</b> Calculation #${esc(s.calcId)} · ${esc(fmtStamp(s.calcAt))} · tokens left ${tokens()} <button type="button" id="editBtn">Edit</button><button type="button" id="newBtn">New flight</button>`,
      );
    } else if (canCalc) {
      const none = tokens() < 1;
      bannerKind = none || notice || msg ? "warn" : "ok";
      const text = none
        ? "No tokens left – ask the admin for more."
        : notice || msg || "Ready – check the weather values, then calculate";
      setHTML(
        "next",
        `<b>${bannerKind === "ok" ? "Ready" : "Check"}</b> ${esc(text)}<button type="button" class="pri" id="calcBtn"${none || pending ? " disabled" : ""}>${pending ? "Calculating…" : "Calculate (1 token)"}</button>`,
      );
    } else {
      setHTML("next", `<b>${kind === "warn" ? "Check" : "Next"}</b> ${esc(msg)}${notice ? `<span class="note">${esc(notice)}</span>` : ""}`);
    }
    byId("next").className = bannerKind;
    [todo1, todo2, todo3].forEach((t, i) => {
      byId("tick" + (i + 1)).textContent = t ? "" : "✓";
    });
    syncChrome();

    // The single gate: the PDF is only built and previewed for a calculated result.
    if (!res) {
      seq++; // drop any preview still rendering
      lastBytes = null;
      const host = $("#pages");
      if (!host.dataset.ph) {
        host.innerHTML = '<p class="ph">Results and the PDF appear after you calculate.</p>';
        host.dataset.ph = "1";
      }
      syncChrome();
      return;
    }
    buildPdf(s, L, sheets, occ)
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
  let cur = null; // last computed sheets, for the confirm dialog
  const fmtStamp = (iso) => {
    const d = new Date(iso);
    return isNaN(d) ? String(iso || "") : d.toLocaleString([], { dateStyle: "medium", timeStyle: "short" });
  };
  function syncChrome() {
    const t = tokens();
    const b = byId("tokens");
    b.textContent = `${t} token${t === 1 ? "" : "s"}`;
    b.className = "badge" + (t < 1 ? " low" : "");
    byId("who").textContent = profile.name || profile.email || "";
    byId("adminLink").hidden = profile.role !== "admin";
    const lock = isLocked(),
      res = isRes();
    document.querySelectorAll("#steps input, #steps select, #steps textarea, #steps button").forEach((el) => {
      el.disabled = el.matches("[data-act]") ? !(res && lastBytes) : lock;
    });
    document.querySelectorAll("header [data-act]").forEach((el) => {
      el.disabled = !(res && lastBytes);
    });
    byId("reset").disabled = pending;
    byId("histBtn").disabled = pending;
  }
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
    if (t.closest("#calcBtn")) return calculate();
    if (t.closest("#editBtn")) return editInputs();
    if (t.closest("#newBtn")) return byId("reset").click();
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
  $("#reset").addEventListener("click", () => {
    notice = "";
    Object.keys(state).forEach((k) => delete state[k]);
    Object.assign(state, DEFAULTS, { date: today(), edited: {} });
    fill($("#steps"));
    renderRoute();
    renderLegs();
    applyBem(regVal());
    update();
    changed();
  });

  /* ---------- calculate (1 token), edit, history ---------- */
  function sourceOf(p) {
    const label = Snapshot.sourceLabel(Snapshot.source(state[`${p}.info`]));
    if (!label) return "entered by you";
    return ["wdir", "wspd", "wgust", "qnh", "oat"].some((k) => state.edited[`${p}.${k}`]) ? `${label}, some values edited by you` : label;
  }
  async function calculate() {
    if (pending || isRes() || !cur || !cur.canCalc || tokens() < 1) return;
    const { sheets, L, LW } = cur;
    const lines = sheets.map((S, i) => {
      const where = [S.apt, S.rwy && "RWY " + S.rwy].filter(Boolean).join(" ");
      return `${S.isD ? "Landing" : "Leg " + (i + 1)} · ${where} · wind ${windStr(S.wdir, S.wspd, S.wgust)} · ${fin(S.oat) ? S.oat + " °C" : "– °C"} · QNH ${qnhStr(S.qnh) || "–"} · source: ${sourceOf(S.p)}`;
    });
    const ok = await dialog(
      `<h3 id="{ID}">Calculate this flight?</h3>
      <ul>${lines.map(li).join("")}</ul>
      <p>TOM <b>${r0(L.tom)}</b> lb · LM <b>${r0(LW.lm)}</b> lb</p>
      <p><b>Uses 1 token</b> (you have ${tokens()}). Changing anything afterwards and calculating again costs another token; identical inputs are free.</p>
      <div class="btns"><button type="button" data-v="no">Cancel</button><button type="button" class="pri" data-v="yes">Calculate (1 token)</button></div>`,
    );
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
  function editInputs() {
    if (!isRes()) return;
    state.mode = "draft";
    delete state.calcId;
    delete state.calcAt;
    notice = "";
    update();
    changed();
  }
  const blankState = () => Object.assign({}, DEFAULTS, { date: today() });
  // Replace the form with a stored calculation: as a result (free) or as a draft template.
  function loadInputs(inputs, row, asResult) {
    const st = Snapshot.fromCanonical(inputs);
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
  }
  async function useCalc(id, asResult) {
    let row;
    try {
      // own calculations only (admins could read everyone's; that view lives in admin.html)
      row = (await Auth.rest(`/calculations?id=eq.${encodeURIComponent(id)}&user_id=eq.${profile.id}&select=id,created_at,inputs`))[0];
    } catch (e) {
      return toast("Could not load that calculation: " + String((e && e.message) || e));
    }
    if (!row || !row.inputs) return toast("Calculation not found");
    if (!isRes() && Snapshot.fingerprint(state) !== Snapshot.fingerprint(blankState()) && Snapshot.fingerprint(state) !== Snapshot.fingerprint(Snapshot.fromCanonical(row.inputs))) {
      const ok = await dialog(
        `<h3 id="{ID}">Replace what you entered?</h3><p>The form has values that are not saved as a calculation. Loading calculation #${esc(row.id)} replaces them.</p>
        <div class="btns"><button type="button" data-v="no">Keep mine</button><button type="button" class="pri" data-v="yes">Replace</button></div>`,
      );
      if (ok !== "yes") return;
    }
    loadInputs(row.inputs, row, asResult);
  }
  async function openHistory() {
    const body = (d, html) => (d.querySelector("#histBody").innerHTML = html);
    const v = await dialog(
      `<h3 id="{ID}">History</h3><div id="histBody" aria-live="polite">Loading…</div>
      <div class="btns"><button type="button" data-v="close">Close</button></div>`,
      async (d) => {
        try {
          const rows = await Auth.rest(`/calculations?user_id=eq.${profile.id}&select=id,created_at,flight_date,dep_time,route,reg&order=created_at.desc&limit=50`);
          if (!rows || !rows.length) return body(d, "<p>No calculations yet. Each calculation you run is listed here.</p>");
          body(
            d,
            `<ul class="hist">${rows
              .filter((r) => /^\d+$/.test(String(r.id)))
              .map(
                (r) => `<li><span class="hmeta"><b>${esc(r.route || "–")}</b> · ${esc(r.reg || "–")}<br>${esc(fmtDate(r.flight_date) || "no date")} ${esc(r.dep_time || "")} · calculated ${esc(fmtStamp(r.created_at))}</span>
                <button type="button" data-v="open:${r.id}">Open</button><button type="button" data-v="tpl:${r.id}">Use as template</button></li>`,
              )
              .join("")}</ul>`,
          );
        } catch (e) {
          body(d, `<p class="bad">Could not load the history: ${esc(String((e && e.message) || e))}</p>`);
        }
      },
    );
    const m = /^(open|tpl):(\d+)$/.exec(v || "");
    if (m) useCalc(m[2], m[1] === "open");
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
