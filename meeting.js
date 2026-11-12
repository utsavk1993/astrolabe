// Meeting finder. Ask for something like "a call with Tokyo and London next week" and the
// AI (server.py) only names the cities, the first day and the length. Everything else is
// worked out here: the first slot in the next 7 days when everyone is within working hours,
// shown on the dial as lit-up rings and a red wedge over the overlap.

(() => {
  const { setMeeting, zones: DIAL, localTz, offsetMinutes, showMoment, wallTimeToEpoch } = window.astrolabe;
  const WORK = [9, 17];     // core working hours, local time, Monday to Friday
  const STRETCH = [8, 19];  // used only when no slot fits everyone's core hours
  const STEP = 15 * 60000;  // slots are checked every 15 minutes
  const HORIZON = 7 * 24 * 3600000;

  const card = document.querySelector(".meeting");
  const els = Object.fromEntries(
    ["label", "when", "note", "people"].map((k) => [k, card.querySelector(`.meeting-${k}`)]));
  card.querySelector(".meeting-close").addEventListener("click", () => window.astrolabe.returnToNow());
  addEventListener("astrolabe:now", () => { card.hidden = true; });

  // --- Finding the slot ------------------------------------------------------------

  // Local hour (fractional) and weekday (0 = Sunday) of an instant in a zone.
  function localParts(ms, tz) {
    const d = new Date(ms + offsetMinutes(tz, new Date(ms)) * 60000);
    return { hour: d.getUTCHours() + d.getUTCMinutes() / 60, weekday: d.getUTCDay() };
  }

  // How much a slot asks of someone: 0 = core hours, 1 = a slightly long day,
  // 2 = early morning or evening, 4 = night or weekend.
  function cost(ms, tz) {
    const { hour, weekday } = localParts(ms, tz);
    if (weekday === 0 || weekday === 6) return 4;
    if (hour >= WORK[0] && hour < WORK[1]) return 0;
    if (hour >= STRETCH[0] && hour < STRETCH[1]) return 1;
    if (hour >= 7 && hour < 22) return 2;
    return 4;
  }

  // The first run of slots, at least `minutes` long, where every zone costs ≤ maxCost.
  // Returns the whole run, so the wedge shows how much room there is around the meeting.
  function firstRun(tzs, from, minutes, maxCost) {
    const need = Math.ceil((minutes * 60000) / STEP);
    let runStart = null, len = 0;
    for (let t = from; t < from + HORIZON; t += STEP) {
      if (tzs.every((tz) => cost(t, tz) <= maxCost)) {
        if (runStart === null) runStart = t;
        len++;
      } else {
        if (len >= need) return { start: runStart, end: t };
        runStart = null; len = 0;
      }
    }
    return len >= need ? { start: runStart, end: runStart + len * STEP } : null;
  }

  // When hours never overlap: the slot that asks the least of everyone in total.
  function leastBad(tzs, from, minutes) {
    const need = Math.ceil((minutes * 60000) / STEP);
    let best = null;
    for (let t = from; t < from + HORIZON; t += STEP) {
      let total = 0;
      for (let k = 0; k < need; k++) for (const tz of tzs) total += cost(t + k * STEP, tz);
      if (!best || total < best.total) best = { start: t, end: t + need * STEP, total };
    }
    return best;
  }

  function find({ zones, from, minutes }) {
    const tzs = [...new Set([localTz, ...zones])];
    // From midnight of the requested day, or from now (next quarter hour) if that's later.
    const dayStart = wallTimeToEpoch(`${from}T00:00`, localTz);
    const start = Math.max(dayStart, Math.ceil(Date.now() / STEP) * STEP);
    const core = firstRun(tzs, start, minutes, 0);
    if (core) return { ...core, tzs, tier: "core" };
    const stretch = firstRun(tzs, start, minutes, 1);
    if (stretch) return { ...stretch, tzs, tier: "stretch" };
    return { ...leastBad(tzs, start, minutes), tzs, tier: "none" };
  }

  // --- Showing it -------------------------------------------------------------------

  const cityOf = (tz) => DIAL.find((z) => z.tz === tz)?.city || tz.split("/").pop().replace(/_/g, " ");
  const timeFmt = (tz) => new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "numeric", minute: "2-digit" });
  const dayFmt = (tz) => new Intl.DateTimeFormat("en-GB", { timeZone: tz, weekday: "short", day: "numeric", month: "short" });
  const range = (tz, a, b) => `${timeFmt(tz).format(a)} – ${timeFmt(tz).format(b)}`;
  const span = (tz, a, b) => `${timeFmt(tz).format(a)} to ${timeFmt(tz).format(b)}`;

  function show(request) {
    const zones = request.zones.filter((tz) => {
      try { new Intl.DateTimeFormat("en-US", { timeZone: tz }); return true; } catch { return false; }
    });
    if (!zones.length) return false;
    const slot = find({ ...request, zones });
    const meetEnd = slot.start + request.minutes * 60000;

    els.label.textContent = request.label || "Meeting";
    els.when.textContent = `${dayFmt(localTz).format(slot.start)}, ${range(localTz, slot.start, meetEnd)} your time`;
    els.note.textContent = {
      core: slot.end - slot.start > request.minutes * 60000
        ? `Everyone is within working hours (9 AM – 5 PM) from ${span(localTz, slot.start, slot.end)} your time. The red wedge on the dial marks that window.`
        : "Everyone is within working hours (9 AM – 5 PM) for this slot.",
      stretch: "No slot this week fits everyone's 9-to-5, so this one stretches the day to between 8 AM and 7 PM for someone.",
      none: "These working days don't overlap this week. This is the slot that asks the least of everyone; times outside someone's working hours are shown in orange.",
    }[slot.tier];

    els.people.replaceChildren(...slot.tzs.map((tz) => {
      const li = document.createElement("li");
      const outside = cost(slot.start, tz) > 0 || cost(meetEnd - 1, tz) > 0;
      const onDial = DIAL.some((z) => z.tz === tz);
      li.className = outside ? "is-outside" : "";
      if (outside) li.title = "Outside working hours";
      li.innerHTML = `<span class="meeting-city"></span><span class="meeting-time"></span>`;
      li.firstChild.textContent = cityOf(tz) + (tz === localTz ? " (you)" : onDial ? "" : " · not on the dial");
      li.lastChild.textContent = `${dayFmt(tz).format(slot.start).split(" ")[0]} ${range(tz, slot.start, meetEnd)}`;
      return li;
    }));
    card.hidden = false;

    setMeeting({ zones: slot.tzs, start: slot.start, end: slot.end });
    showMoment(slot.start);
    return true;
  }

  window.astrolabeMeeting = { show, hide: () => { card.hidden = true; setMeeting(null); } };
})();
