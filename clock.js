// Rings are drawn outer → inner in this order (west → east). Add or swap zones here.
// 8 rings is about the limit before the inner ring's hour labels run out of room.
const ZONES = [
  { city: "Vancouver", tz: "America/Vancouver", color: "#2f6f9f" },
  { city: "New York", tz: "America/New_York", color: "#7a4fa3" },
  { city: "London", tz: "Europe/London", color: "#2f8a5f" },
  { city: "Dubai", tz: "Asia/Dubai", color: "#b8762a" },
  { city: "Kolkata", tz: "Asia/Kolkata", color: "#c0453a" },
  { city: "Singapore", tz: "Asia/Singapore", color: "#178f8f" },
  { city: "Tokyo", tz: "Asia/Tokyo", color: "#c2407e" },
  { city: "Sydney", tz: "Australia/Sydney", color: "#6b7f1f" },
];

const SVG_NS = "http://www.w3.org/2000/svg";
const BEZEL_R = 510;
const RING_OUTER = 498;
const BAND = 38; // rotating band: minute row + hour row
const LANE = 12; // fixed strip with the city name
const RING_GAP = 2;
const RING_STEP = BAND + LANE + RING_GAP;
const DEG_PER_HOUR = 15; // rings are 24h around
const FONT = "-apple-system, Helvetica, sans-serif";
const WORK_START = 9, WORK_END = 17; // working hours used by the meeting finder
const WORK_COLOR = "#3fbf7f";

const svg = document.getElementById("clock");

function el(tag, attrs = {}, parent = svg) {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  parent.appendChild(node);
  return node;
}

// Degrees measured clockwise from 12 o'clock.
function polar(r, deg) {
  const a = ((deg - 90) * Math.PI) / 180;
  return [r * Math.cos(a), r * Math.sin(a)];
}

function arcPath(r, a0, a1) {
  const [x0, y0] = polar(r, a0);
  const [x1, y1] = polar(r, a1);
  const large = a1 - a0 > 180 ? 1 : 0;
  return `M${x0} ${y0} A${r} ${r} 0 ${large} 1 ${x1} ${y1}`;
}

const hour12 = (h) => h % 12 || 12;
const ampm = (h) => (h < 12 ? "AM" : "PM");

// --- Time zone math -------------------------------------------------------

const formatters = new Map();

function offsetMinutes(tz, date) {
  let f = formatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: tz, hourCycle: "h23",
      year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit",
    });
    formatters.set(tz, f);
  }
  const p = Object.fromEntries(f.formatToParts(date).map((x) => [x.type, x.value]));
  const wallAsUtc = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour % 24, +p.minute, +p.second);
  return Math.round((wallAsUtc - Math.floor(date.getTime() / 1000) * 1000) / 60000);
}

// --- Static drawing -------------------------------------------------------

function drawDefs() {
  const defs = el("defs");
  defs.innerHTML = `
    <linearGradient id="bezelGrad" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#3b3b41"/>
      <stop offset="100%" stop-color="#17171a"/>
    </linearGradient>
    <radialGradient id="wallShadow">
      <stop offset="90%" stop-color="#000" stop-opacity="0.35"/>
      <stop offset="100%" stop-color="#000" stop-opacity="0"/>
    </radialGradient>`;
  return defs;
}

function ringRadii(i) {
  const outer = RING_OUTER - i * RING_STEP;
  const bandInner = outer - BAND;
  return { outer, laneMid: bandInner - LANE / 2, laneInner: bandInner - LANE };
}

// The rotating part: hour labels on the inner row, 15/30/45 on the outer row.
function drawBand(zone, i) {
  const { outer } = ringRadii(i);
  const g = el("g", { class: "band" });
  const mid = outer - BAND / 2;
  // Only :30 gets a minute label. Small inner rings drop AM/PM
  // (the day/night shading already tells you which half of the day it is).
  const showAmPm = (2 * Math.PI * (outer - 27)) / 24 >= 50;

  // Night base, then the 6 AM–6 PM daylight arc on top.
  el("circle", { r: mid, fill: "none", stroke: "#1f2a3d", "stroke-width": BAND }, g);
  el("path", {
    d: arcPath(mid, 6 * DEG_PER_HOUR, 18 * DEG_PER_HOUR),
    fill: "none", stroke: "#f4e7c6", "stroke-width": BAND,
  }, g);
  // Working hours (9 AM–5 PM), shown only while planning a meeting.
  el("path", {
    class: "work", d: arcPath(outer - 3, WORK_START * DEG_PER_HOUR, WORK_END * DEG_PER_HOUR),
    fill: "none", stroke: WORK_COLOR, "stroke-width": 6,
  }, g);

  for (let q = 0; q < 96; q++) {
    const h = Math.floor(q / 4);
    const quarter = q % 4;
    const day = h >= 6 && h < 18;
    const ink = day ? "#3a3326" : "#c9d3e6";
    const deg = (q / 4) * DEG_PER_HOUR;
    const onHour = quarter === 0;
    if (quarter === 1 || quarter === 3) continue; // only hours and :30 get a tick

    const [x0, y0] = polar(outer, deg);
    const [x1, y1] = polar(outer - (onHour ? 13 : 4), deg);
    el("line", {
      x1: x0, y1: y0, x2: x1, y2: y1, stroke: ink, "stroke-width": onHour ? 2 : 1,
      ...(onHour ? {} : { class: "minor" }),
    }, g);

    const label = el("text", {
      ...(onHour ? {} : { class: "minor" }),
      transform: `rotate(${deg}) translate(0 ${-(outer - (onHour ? 27 : 10))})`,
      "text-anchor": "middle", "dominant-baseline": "central", "font-family": FONT,
      fill: ink, "font-size": onHour ? 15 : 10,
      "font-weight": onHour ? (h % 12 === 0 ? 700 : 600) : quarter === 2 ? 600 : 400,
      opacity: onHour ? 1 : 0.8,
    }, g);
    label.textContent = onHour
      ? (showAmPm ? `${hour12(h)} ${ampm(h)}` : String(hour12(h)))
      : String(quarter * 15);

    // 6 AM and 6 PM sit exactly on the day/night edge, so half the label lands on
    // the wrong background and vanishes. Back them with a pill in their own colour.
    if (onHour && (h === 6 || h === 18)) {
      const b = label.getBBox();
      const padX = 4, padY = 1.5;
      g.insertBefore(el("rect", {
        transform: label.getAttribute("transform"),
        x: b.x - padX, y: b.y - padY, width: b.width + 2 * padX, height: b.height + 2 * padY,
        rx: (b.height + 2 * padY) / 2, fill: day ? "#f4e7c6" : "#1f2a3d",
      }, g), label);
    }
  }
  return g;
}

// The fixed part: a coloured strip under each band that carries the city name.
function drawLane(zone, i, defs) {
  const { laneMid } = ringRadii(i);
  const g = el("g", { class: "lane" });
  el("circle", { r: laneMid, fill: "none", stroke: zone.color, "stroke-width": LANE }, g);

  const id = `lane-${i}`;
  el("path", { id, d: arcPath(laneMid, -90, 90), fill: "none" }, defs);
  const text = el("text", {
    "font-size": 10.5, "font-weight": 700, "letter-spacing": 1.4,
    fill: "#fff", "font-family": FONT, "dominant-baseline": "central",
  }, g);
  // Name appears on both sides of the marker.
  for (const offset of ["28%", "72%"]) {
    const tp = el("textPath", { href: `#${id}`, startOffset: offset, "text-anchor": "middle" }, text);
    tp.textContent = zone.city.toUpperCase();
  }
  return g;
}

// --- Build ----------------------------------------------------------------

const defs = drawDefs();
// Static gradient shadow instead of a blur filter, which is costly to repaint.
el("circle", { cy: 12, r: BEZEL_R + 18, fill: "url(#wallShadow)" });
el("circle", { r: BEZEL_R, fill: "url(#bezelGrad)" });

const bands = ZONES.map(drawBand);
const lanes = ZONES.map((z, i) => drawLane(z, i, defs));

// Meeting overlap: a translucent wedge over every ring, from the slot's start to its end.
// It is fixed to times, not to the screen, so it moves with the dial (see render).
const overlap = el("path", { class: "overlap", fill: "#e53935", "fill-opacity": 0.13,
  stroke: "#e53935", "stroke-width": 2, "stroke-opacity": 0.7 });
let meeting = null; // { zones: [tz], start, end } while a meeting is shown

function sectorPath(r0, r1, a0, a1) {
  const [ax, ay] = polar(r1, a0), [bx, by] = polar(r1, a1);
  const [cx, cy] = polar(r0, a1), [dx, dy] = polar(r0, a0);
  const large = a1 - a0 > 180 ? 1 : 0;
  return `M${ax} ${ay} A${r1} ${r1} 0 ${large} 1 ${bx} ${by} L${cx} ${cy} A${r0} ${r0} 0 ${large} 0 ${dx} ${dy} Z`;
}

function renderOverlap(t) {
  if (!meeting) return overlap.setAttribute("d", "");
  const toDeg = (ms) => ((ms - t.getTime()) / 3600000) * DEG_PER_HOUR;
  const a0 = Math.max(toDeg(meeting.start), -179), a1 = Math.min(toDeg(meeting.end), 179);
  overlap.setAttribute("d", a1 > a0 ? sectorPath(innermostR, RING_OUTER, a0, a1) : "");
}

// Reading marker at 12 o'clock: read every ring straight down this line.
const innermost = ringRadii(ZONES.length - 1).laneInner;
const innermostR = innermost;
el("line", {
  x1: 0, y1: -(RING_OUTER + 2), x2: 0, y2: -innermost,
  stroke: "#e53935", "stroke-width": 2.5, opacity: 0.85,
});
el("path", { d: `M0 ${-(RING_OUTER - 2)} L-11 -524 L11 -524 Z`, fill: "#e53935" });

// Name in the centre.
const centre = el("g", { "text-anchor": "middle", "font-family": "Georgia, 'Times New Roman', serif" });
el("text", { y: 6, "font-size": 20, "letter-spacing": 3, fill: "#f2ead8" }, centre).textContent = "ASTROLABE";
el("line", { x1: -40, y1: 24, x2: 40, y2: 24, stroke: "#e53935", "stroke-width": 1.5 }, centre);
const subtitle = el("text", { y: 44, "font-size": 11, "letter-spacing": 4, fill: "#8d8d96", "font-family": FONT }, centre);
subtitle.textContent = "WORLD TIME";

// --- Animation and time travel -------------------------------------------

// offsetMs shifts the displayed moment away from now (hand control sets it).
let offsetMs = 0;

function formatOffset(ms) {
  const total = Math.round(Math.abs(ms) / 60000);
  const d = Math.floor(total / 1440), h = Math.floor((total % 1440) / 60), m = total % 60;
  const parts = [d && `${d}D`, h && `${h}H`, (m || !(d || h)) && `${m}M`].filter(Boolean);
  return `${ms < 0 ? "−" : "+"}${parts.join(" ")}`;
}

// --- Side panel: the same moment as a plain list ----------------------------

const LOCAL_TZ = Intl.DateTimeFormat().resolvedOptions().timeZone;
const panelFmt = new Map();
function fmt(tz) {
  let f = panelFmt.get(tz);
  if (!f) {
    f = {
      time: new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "numeric", minute: "2-digit" }),
      date: new Intl.DateTimeFormat("en-GB", { timeZone: tz, weekday: "short", day: "numeric", month: "short" }),
      ymd: new Intl.DateTimeFormat("en-CA", { timeZone: tz }), // 2026-11-10, sortable
    };
    panelFmt.set(tz, f);
  }
  return f;
}

function relativeToYou(mins) {
  if (mins === 0) return "Same as you";
  const h = Math.floor(Math.abs(mins) / 60), m = Math.abs(mins) % 60;
  return `${h ? `${h}h` : ""}${h && m ? " " : ""}${m ? `${m}m` : ""} ${mins > 0 ? "ahead" : "behind"}`;
}

const sideList = document.querySelector(".side-list");
const sideState = document.querySelector(".side-state");
const sideStateText = document.querySelector(".side-state-text");
const sideNow = document.querySelector(".side-now");
const rows = ZONES.map((z) => {
  const li = document.createElement("li");
  li.className = "side-row";
  li.style.setProperty("--zone", z.color);
  li.innerHTML = `
    <span class="side-city"></span>
    <span class="side-time-row"><span class="side-time"></span><sup class="side-day"></sup></span>
    <span class="side-meta"><span class="side-date"></span><span class="side-rel"></span></span>`;
  li.querySelector(".side-city").textContent = z.city;
  if (z.tz === LOCAL_TZ) li.classList.add("is-you");
  sideList.appendChild(li);
  return {
    time: li.querySelector(".side-time"),
    date: li.querySelector(".side-date"),
    rel: li.querySelector(".side-rel"),
    day: li.querySelector(".side-day"),
  };
});
sideNow.addEventListener("click", () => window.astrolabe.returnToNow());
addEventListener("keydown", (e) => {
  // Esc inside an open pop-up only closes the pop-up.
  if (e.key === "Escape" && !document.querySelector("dialog[open]")) window.astrolabe.returnToNow();
});

// Only touch the DOM when text actually changes; render runs every frame while gliding.
const put = (node, text) => { if (node.textContent !== text) node.textContent = text; };

function renderPanel(t, travelling) {
  const youDay = fmt(LOCAL_TZ).ymd.format(t);
  const youOffset = offsetMinutes(LOCAL_TZ, t);
  ZONES.forEach((z, i) => {
    const f = fmt(z.tz);
    const dayDiff = Math.round((Date.parse(f.ymd.format(t)) - Date.parse(youDay)) / 86400000);
    // Like flight times: "1:00 AM +1" when it's already tomorrow there.
    put(rows[i].time, f.time.format(t));
    put(rows[i].day, dayDiff ? `${dayDiff > 0 ? "+" : "−"}${Math.abs(dayDiff)}` : "");
    rows[i].day.title = dayDiff ? `${Math.abs(dayDiff)} day${Math.abs(dayDiff) > 1 ? "s" : ""} ${dayDiff > 0 ? "ahead of" : "behind"} you` : "";
    put(rows[i].date, f.date.format(t));
    put(rows[i].rel, z.tz === LOCAL_TZ ? "You" : relativeToYou(offsetMinutes(z.tz, t) - youOffset));
  });
  put(sideStateText, travelling ? `${formatOffset(offsetMs)} from now` : "Live");
  sideState.classList.toggle("is-travelling", travelling);
  sideNow.hidden = !travelling;
}

function render() {
  const t = new Date(Date.now() + offsetMs);
  ZONES.forEach((z, i) => {
    const zt = new Date(t.getTime() + offsetMinutes(z.tz, t) * 60000);
    const hours = zt.getUTCHours() + zt.getUTCMinutes() / 60 + zt.getUTCSeconds() / 3600;
    bands[i].setAttribute("transform", `rotate(${-hours * DEG_PER_HOUR})`);
  });
  const travelling = Math.abs(offsetMs) >= 60000;
  subtitle.textContent = travelling ? formatOffset(offsetMs) : "WORLD TIME";
  subtitle.setAttribute("fill", travelling ? "#e53935" : "#8d8d96");
  document.body.classList.toggle("travelling", travelling);
  renderOverlap(t);
  renderPanel(t, travelling);
}

// Meeting finder: light up the rings taking part (with their working hours) and dim the rest.
function setMeeting(m) {
  meeting = m;
  svg.classList.toggle("planning", !!m);
  ZONES.forEach((z, i) => {
    const on = !!m && m.zones.includes(z.tz);
    bands[i].classList.toggle("is-in", on);
    lanes[i].classList.toggle("is-in", on);
  });
  render();
}

// Rings turn only 15° per hour, so one update per second is plenty.
// Redrawing every animation frame repainted ~1000 SVG nodes 60×/s and lagged the machine.
function tick() {
  // A pinned moment stays put while real time moves on, so keep the offset in step.
  if (pinnedAt !== null && !gliding) offsetMs = targetMs = pinnedAt - Date.now();
  render();
  setTimeout(tick, 1000 - (Date.now() % 1000));
}

// Coalesce rapid offset changes (hand tracking) into at most one render per frame.
// The dial never jumps: the shown offset glides toward the target set by hand control.
// Exponential approach (frame-rate independent) turns small steps into smooth motion,
// which also keeps the concentric rings from strobing when they move.
let targetMs = 0;
let gliding = false;
// When set, the dial shows this fixed instant (e.g. a dropped "Thu 10:00 AM PT") rather
// than "now + offset", which would creep forward a second every second.
let pinnedAt = null;
let glideMs = 110; // time constant; bigger = softer, laggier

function glide(prev) {
  const now = performance.now();
  if (pinnedAt !== null) targetMs = pinnedAt - Date.now();
  const k = 1 - Math.exp(-(now - prev) / glideMs);
  offsetMs += (targetMs - offsetMs) * k;
  // Finish once within 30 s: that's an invisible 0.125° on the dial, and it cuts the long
  // slow tail an exponential glide would otherwise have on big jumps.
  if (Math.abs(targetMs - offsetMs) < 30000) { offsetMs = targetMs; gliding = false; }
  render();
  document.body.classList.toggle("moving", gliding);
  if (gliding) requestAnimationFrame(() => glide(now));
}

const DAY_MS = 86400000;

function moveTo(ms, softness = 110) {
  // The rings repeat every 24 h, so skip whole days instantly and only glide the rest
  // (at most 12 h). Jumping 9 days ahead would otherwise spin the dial 9 times.
  const far = ms - offsetMs;
  if (Math.abs(far) > DAY_MS / 2) offsetMs += Math.round(far / DAY_MS) * DAY_MS;
  targetMs = ms;
  glideMs = softness;
  if (!gliding) { gliding = true; const t = performance.now(); requestAnimationFrame(() => glide(t)); }
}

function unpin() {
  if (pinnedAt === null) return;
  pinnedAt = null;
  dispatchEvent(new Event("astrolabe:unpin"));
}

window.astrolabe = {
  getOffset: () => targetMs,
  // Manual turning (hand control) starts from wherever the dial is, then moves freely.
  setOffset(ms) { unpin(); moveTo(ms); },
  returnToNow() { unpin(); setMeeting(null); dispatchEvent(new Event("astrolabe:now")); moveTo(0, 260); },
  // { zones: [tz], start, end } lights up those rings and the overlap; null clears it.
  setMeeting,
  zones: ZONES,
  localTz: LOCAL_TZ,
  offsetMinutes,
  // Turn to a fixed instant (epoch ms) and hold it there.
  showMoment(epochMs) { pinnedAt = epochMs; moveTo(epochMs - Date.now(), 220); },
  // Wall-clock time in an IANA zone → epoch ms. Two refinements settle DST edges.
  wallTimeToEpoch(local, tz) {
    const [d, t] = local.split("T");
    const [y, mo, da] = d.split("-").map(Number);
    const [h, mi] = t.split(":").map(Number);
    const wall = Date.UTC(y, mo - 1, da, h, mi);
    let guess = wall;
    for (let i = 0; i < 2; i++) guess = wall - offsetMinutes(tz, new Date(guess)) * 60000;
    return guess;
  },
};

tick();
