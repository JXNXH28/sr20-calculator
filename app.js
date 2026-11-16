(function () {
  "use strict";
  const P = window.Perf,
    W = window.Wx,
    LAT = window.LAT_AIRPORTS;
  const $ = (s) => document.querySelector(s);
  const esc = (s) =>
    String(s).replace(
      /[&<>"]/g,
      (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c],
    );

  /* ---------- input definitions ---------- */
  // [key, label, type, extra]  types: t text, n number, c checkbox, s select, a textarea, d date, h time
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
  // Runway & weather of one takeoff (Ln.<key>). Autofilled by "Fetch", editable here.
  const RWYWX = [
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
    ["ac", "Air conditioning ON", "c"],
    ["trim", "Trim", "t"],
    ["tow", "T.O.W. override (lb)", "n"],
    ["eflaps", "Emergency landing flaps", "s", FLAPS],
    ["ewt", "Emergency landing mass override (lb)", "n"],
    ["remarks", "ATIS / remarks", "a"],
  ];
  const LEG_DEFAULTS = {
    time: "",
    dur: 60,
    trip: 15,
    refuel: "",
    gnd: 30,
    elev: "",
    rwy: "",
    hdg: "",
    len: "",
    slope: 0,
    surf: "paved",
    wdir: "",
    wspd: "",
    wgust: "",
    qnh: 29.92,
    oat: 15,
    ac: false,
    trim: "T/O 0",
    tow: "",
    eflaps: "100",
    ewt: "",
    remarks: "",
  };
  const today = () =>
    new Date(Date.now() - new Date().getTimezoneOffset() * 60000)
      .toISOString()
      .slice(0, 10);
  const DEFAULTS = {
    date: today(),
    reg: "N123AV",
    flight: "D1_1",
    prep: "",
    bem: 2260,
    bemCg: 140.7,
    w1: 190,
    w2: 170,
    w3: 0,
    w4: 0,
    bag: 18,
    vrbWorst: true,
    fuelTO: 38.5,
    nR: 2,
    R0: "KGYR",
    R1: "KGYR",
  };

  /* ---------- state ---------- */
  // Flat map: flight keys (date, reg, w1 …), route stops R0…R{nR-1}, leg keys L{i}.<field>.
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
  // v1 (fixed sheet 1 / sheet 2) → v2 (route): first sheet becomes leg 1, its destination the second stop.
  function migrate(o) {
    if (!o) return null;
    const s = {};
    Object.keys(DEFAULTS).forEach((k) => {
      if (o[k] !== undefined) s[k] = o[k];
    });
    const a = (k) => o["a." + k];
    if (a("apt")) {
      s.R0 = a("apt");
      s.R1 = a("l_apt") || a("apt");
      s.nR = 2;
    }
    Object.keys(LEG_DEFAULTS).forEach((k) => {
      if (a(k) !== undefined && k !== "time") s["L0." + k] = a(k);
    });
    if (o.dur !== undefined) s["L0.dur"] = o.dur;
    if (o.fuelTrip !== undefined) s["L0.trip"] = o.fuelTrip;
    return s;
  }
  const state = Object.assign(
    {},
    DEFAULTS,
    lsGet(KEY) || migrate(lsGet(OLDKEY)) || {},
  );
  state.date = today(); // never carry yesterday's date over
  const num = (v) =>
    v === "" || v === undefined || v === null ? NaN : parseFloat(v);
  const fin = P.isNum;
  const nStops = () => Math.max(1, parseInt(state.nR, 10) || 1);
  const nLegs = () => Math.max(1, nStops() - 1);
  const stop = (i) => String(state["R" + i] || "").trim().toUpperCase();
  const lk = (i, k) => `L${i}.${k}`;
  const lg = (i, k) =>
    state[lk(i, k)] !== undefined ? state[lk(i, k)] : LEG_DEFAULTS[k];
  function save() {
    const keep = Object.assign({}, state);
    delete keep.date;
    Object.keys(keep).forEach((k) => {
      if (/^L\d+\.time$/.test(k)) delete keep[k]; // never carry old times over
    });
    lsSet(KEY, keep);
  }

  /* ---------- building the input panel ---------- */
  function control(id, label, type, opts) {
    const dk = `id="${id}" data-k="${id}"`;
    if (type === "c")
      return `<label class="chk wide"><input type="checkbox" ${dk}> ${label}</label>`;
    let ctl;
    if (type === "s")
      ctl = `<select ${dk}>${opts.map(([v, t]) => `<option value="${v}">${t}</option>`).join("")}</select>`;
    else if (type === "a") ctl = `<textarea ${dk} rows="2"></textarea>`;
    else
      ctl = `<input ${dk} type="${{ n: "number", d: "date", h: "time" }[type] || "text"}"${type === "n" ? ' step="any" inputmode="decimal"' : ""}${opts ? " " + opts : ""}>`;
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
  function routeHTML() {
    const n = nStops();
    let h = "";
    for (let i = 0; i < n; i++) {
      if (i) h += '<span class="arr">→</span>';
      h += `<span class="stop"><input id="R${i}" data-k="R${i}" list="latlist" placeholder="ICAO" autocomplete="off" spellcheck="false">${n > 1 ? `<button type="button" class="x" data-del="${i}" title="Remove stop" aria-label="Remove stop ${i + 1}">×</button>` : ""}</span>`;
    }
    return h + '<button type="button" id="addStop">+ stop</button>';
  }
  function legHTML(i) {
    const p = (k) => lk(i, k),
      to = stop(i + 1) || stop(i);
    const head =
      i === 0
        ? control(p("time"), "Departure time (local)", "h")
        : control(p("gnd"), `Ground time at ${esc(stop(i)) || "stop"} (min)`, "n") +
          control(p("refuel"), "Refuel to (USG, blank = no)", "n");
    return `<section class="leg" data-leg="${i}">
      <div class="lhead"><b>Leg ${i + 1} · ${esc(stop(i)) || "?"} → ${esc(to) || "?"}</b><span class="lsum" id="sum${i}"></span></div>
      <div class="fg">${head}${control(p("dur"), "Flight time (min)", "n")}${control(p("trip"), "Trip fuel (USG)", "n")}</div>
      <div class="lrow"><span class="chips" id="chips${i}"></span><button type="button" class="fbtn" data-leg="${i}" title="Fetch airport & weather for this leg">↻</button></div>
      <div class="fstat" id="fstat${i}"></div>
      <select class="rsel" id="rsel${i}" hidden aria-label="Runway"></select>
      <ul class="lwarn" id="lwarn${i}"></ul>
      ${aptInfo(LAT.find(stop(i)))}
      <details class="rw"><summary>Runway, weather &amp; emergency landing</summary><div class="fg">${RWYWX.map(([k, l, t, o]) => control(p(k), l, t, o)).join("")}</div></details>
    </section>`;
  }
  const noserver = /[?&]noserver/.test(location.search);
  if (noserver) document.body.classList.add("noserver");
  $("#flight").innerHTML = `
    <div class="fg">
      ${control("date", "Date", "d")}
      ${control("reg", "A/C registration", "t", 'list="reglist" autocomplete="off" spellcheck="false"')}
      <div class="wide bemnote" id="bemNote"></div>
      <div class="wide"><span class="lbl">Route (one T/O data sheet per takeoff)</span><div class="route" id="route"></div></div>
      ${control("w1", "Seat 1 / pilot (lb)", "n")}${control("w2", "Seat 2 (lb)", "n")}
      ${control("w3", "Seat 3 (lb)", "n")}${control("w4", "Seat 4 (lb)", "n")}
      ${control("bag", "Baggage (lb)", "n")}${control("fuelTO", "Take-off fuel (USG)", "n")}
      <div class="wide quick"><span>After 1.5 USG taxi:</span><button type="button" data-fuel="54.5">56 → 54.5</button><button type="button" data-fuel="38.5">40 → 38.5</button></div>
      <button type="button" class="wide gobtn" id="go">Fetch airports &amp; weather</button>
    </div>
    <details class="more"><summary>More: BEM, flight no., prepared by</summary><div class="fg">
      ${control("bem", "Basic empty mass (lb)", "n")}${control("bemCg", "BEM CG (in)", "n")}
      ${control("flight", "Flight", "t")}${control("prep", "Prepared by", "t")}
      ${control("vrbWorst", "Variable wind: assume worst case (full tailwind + crosswind)", "c")}
    </div></details>`;
  $("#lists").innerHTML =
    `<datalist id="latlist">${Object.values(LAT)
      .map((a) => `<option value="${a.icao}">${esc(a.name)} · ${a.solo ? "solo" : "dual only"}</option>`)
      .join("")}</datalist>` +
    `<datalist id="reglist">${Object.entries(window.FLEET || {})
      .map(([r, f]) => `<option value="${r}">BEM ${f.bem} lb · CG ${f.cg}</option>`)
      .join("")}</datalist>`;

  function fill(root) {
    root.querySelectorAll("[data-k]").forEach((el) => {
      const k = el.dataset.k,
        m = /^L(\d+)\.(.+)$/.exec(k);
      const v = m ? lg(+m[1], m[2]) : state[k];
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
    let h = "";
    for (let i = 0; i < nLegs(); i++) h += legHTML(i);
    $("#legs").innerHTML = h;
    fill($("#legs"));
    if (noserver) $("#legs").querySelectorAll("details.rw").forEach((d) => (d.open = true));
  }
  fill($("#flight"));
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

  /* ---------- one takeoff: performance + emergency return landing ---------- */
  // The landing box on the form is the emergency return: same airport, runway and weather, at T/O weight.
  function legData(i, legTow) {
    const g = (k) => lg(i, k);
    const n = (k) => num(g(k));
    const tow = fin(n("tow")) ? n("tow") : legTow;
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
    const t = P.takeoff(Object.assign({ tow, ac: g("ac") }, common));
    const ldw = fin(n("ewt")) ? n("ewt") : tow;
    const flaps = parseInt(g("eflaps"), 10);
    const l = P.landing(Object.assign({ flaps, w: ldw }, common));
    const apt = stop(i),
      rwy = String(g("rwy") || "").trim();
    return {
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
      trim: g("trim"),
      remarks: g("remarks"),
      wdir: n("wdir"),
      wspd: n("wspd"),
      wgust: n("wgust"),
      qnh: n("qnh"),
      oat: n("oat"),
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
    v(windStr(S.wdir, S.wspd, S.wgust), C1, 526.0);
    if (isCalm(S.wdir, S.wspd)) {
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
    v(fin(t.da) ? r0(Math.round(t.da / 10) * 10) : "", C3, 488.5);
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
    host.replaceChildren(...canvases);
  }

  const li = (x) => `<li>${esc(x)}</li>`;
  function update() {
    save();
    const s = state;
    const legsIn = [];
    for (let i = 0; i < nLegs(); i++)
      legsIn.push({ trip: num(lg(i, "trip")), refuel: num(lg(i, "refuel")) });
    const L0 = P.loadSheet({
      bem: num(s.bem),
      bemMom: (num(s.bem) * num(s.bemCg)) / 1000,
      w1: num(s.w1),
      w2: num(s.w2),
      w3: num(s.w3),
      w4: num(s.w4),
      bag: num(s.bag),
      fuelTO: num(s.fuelTO),
    });
    const LW = P.legWeights(L0.zfm, num(s.fuelTO), legsIn);
    const L = P.loadSheet({
      bem: num(s.bem),
      bemMom: (num(s.bem) * num(s.bemCg)) / 1000,
      w1: num(s.w1),
      w2: num(s.w2),
      w3: num(s.w3),
      w4: num(s.w4),
      bag: num(s.bag),
      fuelTO: num(s.fuelTO),
      fuelTrip: LW.loadTrip,
    });
    const occ = [s.w1, s.w2, s.w3, s.w4].filter((v) => num(v) > 0).length;
    const sheets = [];
    const warns = [];
    if (!fin(num(s.bem)) || !fin(num(s.bemCg)))
      warns.push("Enter basic empty mass and CG from the aircraft weight report.");
    L.warn.forEach((x) => warns.push(x));
    LW.warn.forEach((x) => warns.push(x));
    for (let i = 0; i < nLegs(); i++) {
      const S = legData(i, LW.legs[i].tow);
      sheets.push(S);
      const apt = LAT.find(S.apt);
      const legW = [...S.t.warn, ...S.l.warn.map((x) => "Emergency landing: " + x)];
      if (S.apt && !apt) legW.push(`${S.apt} is not on the LAT approved airport list`);
      legW.push(
        ...W.latChecks(apt, { rwy: S.rwy, tow: S.tow, oat: S.oat, head: S.t.wind ? S.t.head : 0 }),
      );
      legW.forEach((x) => warns.push(`Leg ${i + 1}: ${x}`));
      const lw = document.getElementById("lwarn" + i);
      if (lw)
        lw.innerHTML =
          legW.map(li).join("") +
          (apt && apt.lim.hi ? li("High field: AC off till 1000 ft AGL, lean, static T/O only.") : "");
      const sum = document.getElementById("sum" + i);
      const ok = fin(S.t.tod) && fin(S.lenN) ? S.t.tod <= S.lenN && S.l.tot <= S.lenN : null;
      if (sum)
        sum.innerHTML = fin(S.t.tor)
          ? `<span class="${ok === false ? "bad" : ok ? "good" : ""}">${S.rwy ? "RWY " + esc(S.rwy) + " · " : ""}TOD ${r10(S.t.tod)}${fin(S.lenN) ? " / " + Math.round(S.lenN) : ""} ft ${ok === false ? "⚠" : ok ? "✓" : ""}</span>`
          : "";
      const chips = document.getElementById("chips" + i);
      if (chips)
        chips.innerHTML = [
          fin(S.tow) && `TOW ${r0(S.tow)} lb`,
          `Wind ${windStr(S.wdir, S.wspd, S.wgust)}`,
          fin(S.oat) && `${S.oat} °C`,
          fin(S.qnh) && `QNH ${qnhStr(S.qnh)}`,
          S.elev && `Elev ${S.elev}`,
          fin(S.l.tot) && `Emerg. LDG ${r10(S.l.tot)} ft`,
        ]
          .filter(Boolean)
          .map((x) => `<span>${esc(x)}</span>`)
          .join("");
    }
    $("#warn").innerHTML = warns.length
      ? "<b>Check:</b><ul>" + warns.map(li).join("") + "</ul>"
      : '<span class="ok">All values within limits.</span>';
    $("#sum").textContent = fin(L.tom)
      ? `ZFM ${Math.round(L.zfm)} · TOM ${Math.round(L.tom)} · LM ${Math.round(L.lm)} lb`
      : "";
    buildPdf(s, L, sheets, occ)
      .then((b) => {
        lastBytes = b;
        return preview(b);
      })
      .catch((e) => {
        console.error(e);
        $("#warn").innerHTML += "<br><b>PDF error:</b> " + esc(e.message);
      });
  }
  const schedule = () => {
    clearTimeout(timer);
    timer = setTimeout(update, 120);
  };

  // BEM / CG: fleet table (fleet.js) prefills by registration; anything typed is kept as a per-registration override.
  const fleetOf = (r) => (window.FLEET || {})[r];
  function bemNote(r) {
    const f = fleetOf(r),
      o = (lsGet(BEMKEY) || {})[r];
    const n = $("#bemNote");
    n.innerHTML = o
      ? `BEM ${esc(o.bem)} lb · CG ${esc(o.cg)} – manual override for ${esc(r)}.` +
        (f ? ' <button type="button" id="bemRestore">Restore fleet values</button>' : "")
      : f
        ? `BEM ${f.bem} lb · CG ${f.cg} in from fleet data (edit under "More").`
        : r
          ? "Not in the fleet table – enter BEM and CG under “More”."
          : "";
  }
  function setState(k, v) {
    state[k] = v;
    const el = document.getElementById(k);
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
  applyBem(regVal());

  document.addEventListener("input", (e) => {
    const el = e.target;
    if (!el.dataset || !el.dataset.k) return;
    const k = el.dataset.k;
    state[k] = el.type === "checkbox" ? el.checked : el.value;
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
  });
  // Route edits rebuild the leg cards (on change, so typing a code does not re-render under the cursor).
  document.addEventListener("change", (e) => {
    const el = e.target;
    if (!el.dataset || !/^R\d+$/.test(el.dataset.k || "")) return;
    el.value = state[el.dataset.k] = el.value.trim().toUpperCase();
    renderLegs();
    schedule();
  });
  document.addEventListener("click", (e) => {
    const t = e.target;
    if (t.closest("#addStop")) {
      const n = nStops();
      setState("R" + n, "");
      state.nR = n + 1;
      renderRoute();
      renderLegs();
      document.getElementById("R" + n).focus();
      schedule();
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
      renderRoute();
      renderLegs();
      schedule();
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
  function blobUrl() {
    return URL.createObjectURL(new Blob([lastBytes], { type: "application/pdf" }));
  }
  $("#download").addEventListener("click", () => {
    if (!lastBytes) return;
    const a = document.createElement("a");
    a.href = blobUrl();
    a.download = `SR20_TO_LoadSheet_${String(state.reg || "flight").replace(/\W+/g, "")}_${state.date || ""}.pdf`;
    a.click();
  });
  $("#print").addEventListener("click", () => {
    if (lastBytes) window.open(blobUrl(), "_blank");
  });
  $("#reset").addEventListener("click", () => {
    Object.keys(state).forEach((k) => delete state[k]);
    Object.assign(state, DEFAULTS, { date: today() });
    fill($("#flight"));
    renderRoute();
    renderLegs();
    applyBem(regVal());
    update();
  });

  // For autofill.js: read/write state through the form so the UI and the PDF stay in sync.
  window.App = {
    nLegs,
    stop,
    get: (k) => state[k],
    leg: lg,
    set: (k, v) => {
      setState(k, v);
      schedule();
    },
  };
  update();
})();
