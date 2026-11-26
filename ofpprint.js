// OFP print: fills the blank "Excel Nav Log - Simple" form (ofpform.js) and exports a Garmin .fpl for ForeFlight.
// Classic script. Global OfpPrint; also module.exports in node.
(function (root) {
  "use strict";

  // ---- Form geometry --------------------------------------------------------------------------------------------
  // The form is a landscape page: 792 x 612 pt as displayed (MediaBox 612x792 with /Rotate 90).
  // All numbers below were measured from the blank form: text positions with `pdftotext -bbox`, cell borders by
  // scanning a 288 dpi render for dark lines. They are in DISPLAY points, x from the left, "top" = distance from the
  // top edge of the displayed page. Layout items use y-up from the bottom (y = PAGE_H - top).
  //
  //  Ladder columns (x0 of each column; every column is 34.9 wide except Remarks):
  //               Alt/MSA  WPT   MC/WCA GS/Dist EET/PTO ETO/ATO LegFuel/Pl ActFuel/Min  Remarks
  //   left        18.2     53.2  88.1   123.0   158.0   192.9   227.8       262.8        297.6 .. 367.5
  //   right       396.8    431.8 466.6  501.5   536.5   571.4   606.2       641.2        676.1 .. 746.0
  //  Ladder body starts at top 178.2; one leg = two rows of 14.7 (pitch 29.36). WPT and Remarks cells span both rows.
  //  Left ladder holds 11 blocks, right ladder 7: 18 legs. Leg 1 is the ATO departure leg (the form pre-prints XXX in
  //  MC, WCA, GS and ETO there). ETO is an in-flight cell and is never filled.
  //  header also takes toTime ('1006') for the T/O cell.
  //  Header row 1: label row top 81.9, value row 96.2 .. 110.8.  Header row 2: label top 117.2, value 128 .. 142.8.
  //   row 1 columns: From 18.2 | To 53.2 | Off Block pln 88.1 | Actual 123 | On Block pln 158 | Actual 192.9 |
  //                  T/O 227.8 | Lnd 262.8 | Callsign 297.6..367.5
  //   row 2 columns: AC reg 18.2 | Cruise FF 88.1 | Cruise MAG W/V 158 | Alt/FL 227.8 | Date 297.6..367.5
  //  Right header: value row 96.2..110.8: Mission 396.8..466.6 | Crew x3 466.6..606.2 (two cells of 69.8 + one) |
  //                Takeoff Fuel 676.1..746.0.  Notes box 396.8..746.0, top 117.2..142.8 (label "Notes" at left).
  //  Totals row top 398.8..428.5: EET value 571.4..606.2, Trip fuel value 641.2..676.1 (pre-printed "0"/"0.0" are
  //  covered with white boxes). ALTN rows (top 443.2..501.8) stay blank.
  //  Lower Notes boxes open at top 508.5 (left x 18.2..367.5, right x 396.8..746); the form is cut off there, so we
  //  close the boxes ourselves.
  const PAGE_W = 792,
    PAGE_H = 612; // displayed
  const ROW_H = 14.7,
    LEG_H = 29.36,
    BODY_TOP = 178.2;
  const COL_W = 34.9;
  const LEFT_X0 = 18.2,
    RIGHT_X0 = 396.8;
  const COLS = [
    "alt", // Altitude / MSA
    "wpt", // WPT
    "mc", // MC / WCA
    "gs", // GS / Dist
    "eet", // EET / PTO
    "eto", // ETO / ATO
    "leg", // Leg fuel / Pl. fuel
    "act", // Act. fuel / Min. fuel
  ];
  const MAX_LEGS = 18,
    LEFT_LEGS = 11;
  const REMARK_W = { left: 69.9, right: 69.9 };

  // Box of a ladder cell in y-up display coordinates. side 'left'|'right', slot = leg index within that side,
  // col = name from COLS or 'rem', line 0 (top row) | 1 (bottom row) | 'both'.
  function cell(side, slot, col, line) {
    const x0 = side === "left" ? LEFT_X0 : RIGHT_X0;
    let cx0, cx1;
    if (col === "rem") {
      cx0 = x0 + COL_W * COLS.length;
      cx1 = cx0 + REMARK_W[side];
    } else {
      cx0 = x0 + COL_W * COLS.indexOf(col);
      cx1 = cx0 + COL_W;
    }
    const top = BODY_TOP + LEG_H * slot;
    let t0 = top,
      t1 = top + LEG_H;
    if (line === 0) t1 = top + ROW_H;
    if (line === 1) t0 = top + ROW_H;
    return { x0: cx0, x1: cx1, y0: PAGE_H - t1, y1: PAGE_H - t0 };
  }
  // Header / totals boxes: [x0, x1, topValue, bottomValue] in "top" coordinates.
  const H1 = [96.2, 110.8],
    H2 = [128.0, 142.8];
  const HDR = {
    from: [18.2, 53.2, ...H1],
    to: [53.2, 88.1, ...H1],
    offBlock: [88.1, 123.0, ...H1],
    onBlock: [158.0, 192.9, ...H1],
    toTime: [227.8, 262.8, ...H1],
    callsign: [297.6, 367.5, ...H1],
    reg: [18.2, 88.1, ...H2],
    cruiseFf: [88.1, 158.0, ...H2],
    magWind: [158.0, 227.8, ...H2],
    alt: [227.8, 297.6, ...H2],
    date: [297.6, 367.5, ...H2],
    mission: [396.8, 466.6, ...H1],
    crew0: [466.6, 536.5, ...H1],
    crew1: [536.5, 606.2, ...H1],
    crew2: [606.2, 676.1, ...H1],
    takeoffFuel: [676.1, 746.0, ...H1],
    totEet: [571.4, 606.2, 398.8, 428.5],
    totTrip: [641.2, 676.1, 398.8, 428.5],
  };
  const hbox = (k) => {
    const b = HDR[k];
    return { x0: b[0], x1: b[1], y0: PAGE_H - b[3], y1: PAGE_H - b[2] };
  };
  // free-text note areas (top coordinates): [x0, x1, firstBaselineTop, lineStep, maxLines]
  const NOTE_AREAS = [
    [430, 745, 125.5, 8.2, 2], // beside the "Notes" label, top right
    [20, 366, 529, 9, 6], // lower left, under the label
    [398, 745, 529, 9, 6], // lower right
  ];
  // The pre-printed placeholder texts on the blank form that must be covered: [x0, x1, top0, top1]
  const COVER = [
    [90, 121, 180, 192.8], // 0: MC XXX
    [90, 121, 194.8, 207.4], // 1: WCA XXX
    [125, 156, 180, 192.8], // 2: GS XXX
    [195, 226, 180, 192.8], // 3: ETO XXX
    [573, 605, 405, 421], // totals EET "0"
    [643, 675, 405, 421], // totals Trip fuel "0.0"
  ];

  // Which pre-printed boxes get covered. First leg fixed (ATO procedure): only the MC XXX (we write "Dep" there);
  // WCA, GS and ETO XXX stay visible. Otherwise all four XXX are covered. Totals placeholders are always covered.
  function covers(log) {
    const r0 = log && log.rows && log.rows[0];
    return r0 && r0.fixed ? [0, 4, 5] : [0, 1, 2, 3, 4, 5];
  }

  // ---- Formatting -------------------------------------------------------------------------------------------------
  const isNum = (v) => typeof v === "number" && isFinite(v);
  const clean = (t) => String(t).replace(/[^\x20-\x7E]/g, "?");
  const p3 = (n) => String(Math.round(n) % 360).padStart(3, "0");
  const f1 = (n) => (isNum(n) ? (Math.round(n * 10) / 10).toFixed(1) : "");
  const int = (n) => (isNum(n) ? String(Math.round(n)) : "");
  const dist = (n) => {
    if (!isNum(n)) return "";
    const r = Math.round(n * 10) / 10;
    return Number.isInteger(r) ? String(r) : r.toFixed(1);
  };
  const mc = (n) => (isNum(n) ? p3(((n % 360) + 360) % 360 || 360) : "");
  const wca = (n) => (isNum(n) ? (n > 0 ? "+" : "") + Math.round(n) : "");
  const eet = (m) => {
    if (!isNum(m)) return "";
    m = Math.round(m);
    return m >= 60 ? Math.floor(m / 60) + ":" + String(m % 60).padStart(2, "0") : ":" + String(m).padStart(2, "0");
  };
  const clock = (v) => {
    if (v == null) return "";
    const s = String(v).replace(":", "");
    return /^\d{3,4}$/.test(s) ? s.padStart(4, "0") : "";
  };
  const str = (v) => {
    if (v == null) return "";
    const s = String(v);
    return /NaN|undefined|Infinity/.test(s) ? "" : s;
  };

  // ---- Layout -----------------------------------------------------------------------------------------------------
  // One item: {x, y, text, size, align:'c'|'l', cx, w}. x is the estimated left edge (0.5 em per char); y is the
  // baseline, y-up in display points. cx/w describe the cell so the renderer can centre with real font metrics.
  const EM = 0.5;
  function fit(text, w, size, minSize) {
    text = clean(text);
    let s = size;
    while (s > minSize && text.length * s * EM > w) s -= 0.25;
    while (text.length > 1 && text.length * s * EM > w) text = text.slice(0, -1);
    return { text, size: s };
  }
  function layout(log, header) {
    header = header || {};
    const items = [];
    const place = (box, text, o = {}) => {
      text = str(text);
      if (!text.trim()) return;
      const w = box.x1 - box.x0 - 2;
      const f = fit(text, w, o.size || 8, o.min || 5.5);
      const align = o.align || "c";
      const x = align === "c" ? (box.x0 + box.x1) / 2 - (f.text.length * f.size * EM) / 2 : box.x0 + 1.5;
      // baseline: for rows, o.base is offset from the box bottom, default centres a cap-height-ish glyph
      const y = box.y0 + (o.up != null ? o.up : (box.y1 - box.y0 - f.size * 0.7) / 2);
      items.push({
        x,
        y,
        text: f.text,
        size: f.size,
        align,
        cx: (box.x0 + box.x1) / 2,
        x0: box.x0,
        w,
      });
    };

    // header
    const h = header;
    const H = (k, t, o) => place(hbox(k), t, Object.assign({ size: 9 }, o));
    H("from", h.from);
    H("to", h.to);
    H("offBlock", clock(h.offBlock));
    H("onBlock", clock(h.onBlock));
    H("toTime", clock(h.toTime));
    H("callsign", h.callsign);
    H("reg", h.reg);
    H("cruiseFf", isNum(h.cruiseFf) ? f1(h.cruiseFf) : h.cruiseFf);
    H("magWind", h.magWind);
    H("alt", h.alt);
    H("date", h.date, { size: 8 });
    H("mission", h.mission, { size: 8 });
    const crew = Array.isArray(h.crew) ? h.crew : [];
    for (let i = 0; i < 3; i++) H("crew" + i, crew[i], { size: 8 });
    H("takeoffFuel", isNum(h.takeoffFuel) ? f1(h.takeoffFuel) : h.takeoffFuel);

    // notes: fill the three free-text areas in order
    const notes = (Array.isArray(h.notes) ? h.notes : []).map(str).filter((s) => s.trim());
    let ni = 0;
    NOTE_AREAS.forEach(([x0, x1, top0, step, max]) => {
      for (let k = 0; k < max && ni < notes.length; k++, ni++) {
        const f = fit(notes[ni], x1 - x0, 7, 5.5);
        items.push({ x: x0, y: PAGE_H - top0 - k * step, text: f.text, size: f.size, align: "l", cx: x0, x0, w: x1 - x0 });
      }
    });

    // legs
    const rows = (log && log.rows ? log.rows : []).slice(0, MAX_LEGS);
    rows.forEach((r, i) => {
      const side = i < LEFT_LEGS ? "left" : "right";
      const slot = i < LEFT_LEGS ? i : i - LEFT_LEGS;
      const c = (col, line) => cell(side, slot, col, line);
      const bad = !!r.error;
      place(c("alt", 0), int(r.alt));
      place(c("alt", 1), int(r.msa));
      // WPT cell spans both rows: name on the upper row, ident (if different) below, small
      place(c("wpt", 0), r.name != null ? r.name : r.ident, { size: 8 });
      if (r.ident && r.name && r.ident !== r.name) place(c("wpt", 1), "(" + r.ident + ")", { size: 6.5 });
      const dep = i === 0 && r.fixed;
      place(c("mc", 0), dep ? "Dep" : mc(r.mc));
      if (!dep) place(c("gs", 0), bad ? "" : int(r.gs));
      place(c("eet", 0), bad ? "" : eet(r.eet));
      place(c("leg", 0), bad ? "" : f1(r.legFuel));
      if (!bad && !dep) place(c("mc", 1), wca(r.wca));
      place(c("gs", 1), dist(r.dist));
      if (!bad) place(c("eet", 1), clock(r.pto));
      if (!bad) place(c("leg", 1), f1(r.plFuel));
      if (!bad) place(c("act", 1), f1(r.minFuel));
      // remarks: up to three short lines, left aligned inside the merged cell
      const rem = remarks(r);
      const rb = c("rem", "both");
      const topY = rb.y1;
      rem.slice(0, 3).forEach((t, k) => {
        const f = fit(t, rb.x1 - rb.x0 - 3, 6.5, 5.5);
        items.push({
          x: rb.x0 + 2,
          y: topY - 9 - k * 9,
          text: f.text,
          size: f.size,
          align: "l",
          cx: rb.x0,
          x0: rb.x0,
          w: rb.x1 - rb.x0 - 3,
        });
      });
    });

    // totals
    const tot = (log && log.totals) || {};
    if (isNum(tot.eet)) place(hbox("totEet"), int(tot.eet), { size: 10 });
    if (isNum(tot.trip)) place(hbox("totTrip"), f1(tot.trip), { size: 10 });
    return items;
  }
  function remarks(r) {
    const out = [];
    const p = r.pattern;
    if (p) {
      if (p.touchGo) out.push("T&G (" + p.touchGo + ")");
      if (p.taxiBack) out.push("T/B (" + p.taxiBack + ")");
      if (p.airwork) out.push(Math.round(p.airwork) + " AIRWORK");
      if (p.fullStop) out.push("Full stop");
    }
    if (r.error) out.push("CHECK WIND");
    // two lines: join short pieces
    const lines = [];
    out.forEach((t) => {
      if (lines.length && (lines[lines.length - 1] + ", " + t).length <= 12) lines[lines.length - 1] += ", " + t;
      else lines.push(t);
    });
    return lines;
  }

  // ---- PDF --------------------------------------------------------------------------------------------------------
  async function buildPdf(log, header) {
    const lib = typeof PDFLib !== "undefined" ? PDFLib : require("./vendor/pdf-lib.min.js");
    const b64 = typeof OFP_PDF_B64 !== "undefined" ? OFP_PDF_B64 : require("./ofpform.js");
    const { PDFDocument, StandardFonts, rgb, degrees } = lib;
    const doc = await PDFDocument.load(b64);
    const page = doc.getPages()[0];
    const font = await doc.embedFont(StandardFonts.Helvetica);
    const INK = rgb(0.04, 0.2, 0.58);
    // display (x right, y up) -> user space of a /Rotate 90 page: ux = PAGE_H - y, uy = x
    const W = page.getWidth(); // 612
    const toUser = (x, y) => ({ x: W - y, y: x });
    // cover the placeholders of the blank form
    const cv = covers(log);
    COVER.forEach(([x0, x1, t0, t1], ci) => {
      if (!cv.includes(ci)) return;
      page.drawRectangle({ x: t0, y: x0, width: t1 - t0, height: x1 - x0, color: rgb(1, 1, 1) });
    });
    // close the two lower Notes boxes (the blank is cut off below their label)
    [
      [LEFT_X0, 367.5],
      [RIGHT_X0, 746.0],
    ].forEach(([x0, x1]) => {
      const t0 = 508.5,
        t1 = 585;
      const o = { color: rgb(0, 0, 0), thickness: 0.7 };
      const seg = (xa, ta, xb, tb) =>
        page.drawLine(Object.assign({ start: toUser(xa, PAGE_H - ta), end: toUser(xb, PAGE_H - tb) }, o));
      seg(x0, t0, x0, t1);
      seg(x1, t0, x1, t1);
      seg(x0, t1, x1, t1);
    });
    layout(log, header).forEach((it) => {
      let size = it.size;
      while (size > 4 && font.widthOfTextAtSize(it.text, size) > it.w + 1) size -= 0.25;
      const tw = font.widthOfTextAtSize(it.text, size);
      const x = it.align === "c" ? it.cx - tw / 2 : it.x;
      const p = toUser(x, it.y);
      page.drawText(it.text, { x: p.x, y: p.y, size, font, color: INK, rotate: degrees(90) });
    });
    return doc.save();
  }

  // ---- ForeFlight / Garmin FlightPlan v1 --------------------------------------------------------------------------
  const esc = (s) =>
    String(s).replace(/[<>&"']/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&apos;" })[c]);
  const alnum = (s) => String(s == null ? "" : s).toUpperCase().replace(/[^A-Z0-9]/g, "");
  function routeString(route) {
    return (route || [])
      .map((p) => (p.type === "USER WAYPOINT" || !p.ident ? latlonId(p) : String(p.ident).toUpperCase()))
      .join(" ");
  }
  function latlonId(p) {
    const part = (v, w, pos, neg) => {
      const a = Math.abs(v);
      let d = Math.floor(a),
        m = Math.round((a - d) * 60);
      if (m === 60) {
        d++;
        m = 0;
      }
      return String(d).padStart(w, "0") + String(m).padStart(2, "0") + (v >= 0 ? pos : neg);
    };
    return part(p.lat, 2, "N", "S") + "/" + part(p.lon, 3, "E", "W");
  }
  function fpl(route) {
    route = route || [];
    const used = new Set();
    const table = []; // unique waypoints
    const byKey = new Map();
    const ids = route.map((p) => {
      const isUser = p.type === "USER WAYPOINT";
      const key = (isUser ? "U|" : "N|" + alnum(p.ident) + "|") + (+p.lat).toFixed(4) + "|" + (+p.lon).toFixed(4);
      if (byKey.has(key)) return byKey.get(key);
      let base = alnum(isUser ? p.name || p.ident : p.ident || p.name) || "WPT";
      let id = base.slice(0, isUser ? 6 : 12);
      for (let n = 1; used.has(id); n++) {
        const sfx = String(n);
        id = base.slice(0, (isUser ? 6 : 12) - sfx.length) + sfx;
      }
      used.add(id);
      byKey.set(key, id);
      table.push({ id, p, type: p.type || "USER WAYPOINT" });
      return id;
    });
    const num = (v) => (isFinite(v) ? (+v).toFixed(6) : "0.000000");
    const lines = [
      '<?xml version="1.0" encoding="utf-8"?>',
      '<flight-plan xmlns="http://www8.garmin.com/xmlschemas/FlightPlan/v1">',
      "  <created>" + new Date().toISOString().replace(/\.\d+Z$/, "Z") + "</created>",
      "  <waypoint-table>",
    ];
    table.forEach((t) => {
      lines.push(
        "    <waypoint>",
        "      <identifier>" + esc(t.id) + "</identifier>",
        "      <type>" + esc(t.type) + "</type>",
        "      <lat>" + num(t.p.lat) + "</lat>",
        "      <lon>" + num(t.p.lon) + "</lon>",
        "      <comment>" + esc(t.p.name && t.p.name !== t.id ? t.p.name : "") + "</comment>",
        "    </waypoint>",
      );
    });
    lines.push("  </waypoint-table>", "  <route>");
    const nm = route.length ? ids[0] + (route.length > 1 ? " to " + ids[ids.length - 1] : "") : "OFP";
    lines.push("    <route-name>" + esc(nm) + "</route-name>", "    <flight-plan-index>1</flight-plan-index>");
    route.forEach((p, i) => {
      lines.push(
        "    <route-point>",
        "      <waypoint-identifier>" + esc(ids[i]) + "</waypoint-identifier>",
        "      <waypoint-type>" + esc(p.type || "USER WAYPOINT") + "</waypoint-type>",
        "    </route-point>",
      );
    });
    lines.push("  </route>", "</flight-plan>", "");
    return lines.join("\n");
  }

  // ForeFlight Mobile URL scheme: foreflightmobile://maps/search?q=<tokens joined by +>
  // Tokens: waypoints in order, then speed (kts), fuel burn (gph), altitude (ft), tail number, ETD in Zulu.
  function dms(v, w, pos, neg) {
    const total = Math.round(Math.abs(v) * 3600); // nearest second; carries roll over through minutes and degrees
    const d = Math.floor(total / 3600), m = Math.floor((total % 3600) / 60), s = total % 60;
    return String(d).padStart(w, "0") + String(m).padStart(2, "0") + String(s).padStart(2, "0") + (v >= 0 ? pos : neg);
  }
  function foreflightUrl(route, opts) {
    const o = opts || {};
    const tokens = [];
    (route || []).forEach((p) => {
      if (!p || !isFinite(p.lat) || !isFinite(p.lon)) return;
      const t = p.type === "AIRPORT" && p.ident ? String(p.ident).toUpperCase() : dms(p.lat, 2, "N", "S") + "/" + dms(p.lon, 3, "E", "W");
      if (tokens[tokens.length - 1] !== t) tokens.push(t);
    });
    const pos = (v) => typeof v === "number" && isFinite(v) && v > 0;
    if (pos(o.tas)) tokens.push(Math.round(o.tas) + "kts");
    if (pos(o.ff)) tokens.push(String(Number(o.ff.toFixed(1))) + "gph");
    if (pos(o.alt)) tokens.push(Math.round(o.alt) + "ft");
    // Aircraft: ForeFlight only knows the ID of an aircraft profile on the device (the ATO profiles use the callsign, e.g. VAR848);
    // anything else is read as a waypoint ("Unable to find N848EF"), so the caller passes the OFP callsign, not the registration.
    const acft = alnum(o.aircraft);
    if (acft) tokens.push(acft);
    if (o.etd instanceof Date && !isNaN(o.etd.getTime())) {
      const e = o.etd, p2 = (n) => String(n).padStart(2, "0");
      tokens.push(e.getUTCFullYear() + p2(e.getUTCMonth() + 1) + p2(e.getUTCDate()) + "T" + p2(e.getUTCHours()) + ":" + p2(e.getUTCMinutes()) + ":" + p2(e.getUTCSeconds()) + "Z");
    }
    return "foreflightmobile://maps/search?q=" + tokens.map((t) => encodeURIComponent(t)).join("+");
  }

  const OfpPrint = { layout, buildPdf, fpl, foreflightUrl, routeString, MAX_LEGS, LEFT_LEGS, covers, cell, hbox, PAGE_H, PAGE_W };
  if (typeof module !== "undefined" && module.exports) module.exports = OfpPrint;
  else root.OfpPrint = OfpPrint;
})(typeof window !== "undefined" ? window : globalThis);
