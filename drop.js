// Drop anything with a time in it, and the dial turns to it.
//   Drag a screenshot onto the page, paste one (⌘V), or type/paste text into the box.
//   server.py sends it to NVIDIA's free Nemotron vision model, which returns the times;
//   the dial and panel turn to the first one. ‹ › (or ← →) step through several.
//   Below hand control, the tools card previews the dropped file and names the time shown.
// The model only reads; the time-zone maths happens here, with the browser's Intl data.

(() => {
  const form = document.querySelector(".ask");
  const input = document.querySelector(".ask-input");
  const go = document.querySelector(".ask-go");
  const clearBtn = document.querySelector(".ask-clear");
  const status = document.querySelector(".ask-status");
  const overlay = document.querySelector(".drop-overlay");
  const preview = document.querySelector(".preview");
  const previewImg = preview.querySelector(".preview-img");
  const previewText = preview.querySelector(".preview-text");
  const found = preview.querySelector(".found");
  const foundLabel = found.querySelector(".found-label");
  const foundSource = found.querySelector(".found-source");
  const foundNav = found.querySelector(".found-nav");
  const foundCount = found.querySelector(".found-count");

  const USER_TZ = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const MAX_SIDE = 1600; // px; screenshots are downscaled before upload

  let ready = false;
  let busy = false;
  let moments = [];
  let index = 0;

  const say = (text, kind = "") => {
    status.textContent = text;
    status.dataset.kind = kind;
  };

  // --- Is the server (and a key) there? ----------------------------------------

  // Checked on load, again every 15 s while unavailable, and whenever the guide opens, so
  // a server that starts (or restarts) later is picked up without reloading the page.
  let retry = null;
  async function checkServer() {
    clearTimeout(retry);
    try {
      const res = await fetch("/api/health", { cache: "no-store" });
      const info = await res.json();
      ready = info.configured;
    } catch {
      ready = false;
    }
    if (!ready) retry = setTimeout(checkServer, 15000);
    if (ready && status.dataset.kind === "warn") say("");
    input.disabled = !ready;
    syncGo();
    return ready;
  }
  const UNAVAILABLE = "The AI reader isn't available right now. Please try again in a moment.";

  // Read stays off until there's something in the box (and the server is ready).
  // The × shows whenever there's text, so a read question stays visible until you clear it.
  const syncGo = () => {
    go.disabled = !ready || busy || !input.value.trim();
    clearBtn.hidden = !input.value;
  };
  input.addEventListener("input", syncGo);
  clearBtn.addEventListener("click", () => {
    detach();
    input.value = "";
    syncGo();
    input.focus();
  });

  // Playful words while waiting, instead of naming the model. One changes every 1.6 s.
  const WORDS = ["Squinting", "Deciphering", "Flabbergasting", "Cogitating", "Unscrambling",
    "Time-wrangling", "Clock-whispering", "Rummaging", "Noodling", "Pondering", "Calibrating"];
  let wordTimer = null;
  function startWords() {
    let i = Math.floor(Math.random() * WORDS.length);
    const next = () => say(`${WORDS[i++ % WORDS.length]}…`, "busy");
    next();
    wordTimer = setInterval(next, 1600);
  }
  const stopWords = () => clearInterval(wordTimer);

  // --- Reading -------------------------------------------------------------------

  function isValidZone(tz) {
    try { new Intl.DateTimeFormat("en-US", { timeZone: tz }); return true; } catch { return false; }
  }

  async function read({ text = "", image = null }) {
    if (busy) return;
    if (!ready && !(await checkServer())) return say(UNAVAILABLE, "error");
    busy = true;
    syncGo();
    startWords();
    try {
      const res = await fetch("/api/extract", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text, image, now: new Date().toString(), tz: USER_TZ }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Something went wrong.");

      const events = data.events
        .filter((e) => isValidZone(e.tz))
        .map((e) => ({ ...e, at: window.astrolabe.wallTimeToEpoch(e.local, e.tz) }))
        .filter((e) => Number.isFinite(e.at));
      stopWords();
      // A meeting request: the meeting finder picks the slot and turns the dial.
      if (data.meeting) {
        clear();
        window.astrolabeMeeting.hide();
        if (window.astrolabeMeeting.show(data.meeting)) { say(""); input.blur(); return; }
      }
      if (!events.length) {
        say("No date or time found in that.", "warn");
        return;
      }
      window.astrolabeMeeting.hide();
      moments = events;
      say("");
      input.blur(); // so ← → step through the times straight away
      show(0);
    } catch (err) {
      stopWords();
      console.error("[astrolabe] read failed:", err);
      say(err.message === "Failed to fetch" ? "Lost the server. Is server.py running?" : err.message, "error");
    } finally {
      stopWords();
      busy = false;
      syncGo();
    }
  }

  // --- Preview and found time --------------------------------------------------

  function sourceText(m) {
    // How the source wrote it, e.g. "Thu 12 Nov, 10:00 AM PST (Los Angeles)".
    const day = new Intl.DateTimeFormat("en-GB", {
      timeZone: m.tz, weekday: "short", day: "numeric", month: "short",
    }).format(m.at);
    const time = new Intl.DateTimeFormat("en-US", {
      timeZone: m.tz, hour: "numeric", minute: "2-digit", timeZoneName: "short",
    }).format(m.at);
    const place = m.tz.split("/").pop().replace(/_/g, " ");
    return `${day}, ${time} (${place})`;
  }

  function show(i) {
    index = (i + moments.length) % moments.length;
    const m = moments[index];
    foundLabel.textContent = m.label || "Found time";
    foundSource.textContent = sourceText(m);
    foundNav.hidden = moments.length < 2;
    foundCount.textContent = `${index + 1} of ${moments.length}`;
    found.hidden = false;
    syncPreview();
    window.astrolabe.showMoment(m.at);
  }

  function clear() {
    moments = [];
    found.hidden = true;
    syncPreview();
  }

  // The section shows while there's a file to preview or a found time to name.
  const syncPreview = () => { preview.hidden = previewImg.hidden && previewText.hidden && found.hidden; };

  found.querySelector(".found-prev").addEventListener("click", () => show(index - 1));
  found.querySelector(".found-next").addEventListener("click", () => show(index + 1));
  // Turning by hand or going back to now lets go of the dropped time.
  addEventListener("astrolabe:unpin", clear);

  addEventListener("keydown", (e) => {
    if (!moments.length || e.target === input) return;
    if (e.key === "ArrowRight") show(index + 1);
    if (e.key === "ArrowLeft") show(index - 1);
  });

  // --- Inputs: typed text, pasted text/images, dropped files ------------------------

  // A dropped or pasted file shows its name in the box (read-only) until × clears it;
  // Read sends the file again rather than its name.
  let attached = null;
  function attach(name, payload) {
    attached = payload;
    previewImg.hidden = !payload.image;
    previewText.hidden = !!payload.image;
    if (payload.image) previewImg.src = payload.image;
    else previewText.textContent = payload.text.slice(0, 600);
    syncPreview();
    input.value = name;
    input.readOnly = true;
    input.classList.add("has-file");
    syncGo();
  }
  function detach() {
    attached = null;
    previewImg.hidden = previewText.hidden = true;
    previewImg.removeAttribute("src");
    syncPreview();
    input.readOnly = false;
    input.classList.remove("has-file");
  }

  form.addEventListener("submit", (e) => {
    e.preventDefault();
    if (attached) return read(attached);
    const text = input.value.trim();
    if (text) read({ text });
  });

  async function imageToDataUrl(file) {
    const bmp = await createImageBitmap(file);
    const scale = Math.min(1, MAX_SIDE / Math.max(bmp.width, bmp.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(bmp.width * scale);
    canvas.height = Math.round(bmp.height * scale);
    canvas.getContext("2d").drawImage(bmp, 0, 0, canvas.width, canvas.height);
    bmp.close();
    return canvas.toDataURL("image/jpeg", 0.85);
  }

  async function readFile(file) {
    if (file.type.startsWith("image/")) {
      let payload;
      try { payload = { image: await imageToDataUrl(file) }; }
      catch { return say("Couldn't open that image.", "error"); }
      attach(file.name && file.name !== "image.png" ? file.name : "Pasted image", payload);
      read(payload);
    } else if (file.type.startsWith("text/") || /\.(txt|ics|eml|md)$/i.test(file.name)) {
      const payload = { text: (await file.text()).slice(0, 8000) };
      attach(file.name, payload);
      read(payload);
    } else {
      say("Drop an image or a text file.", "warn");
    }
  }

  addEventListener("paste", (e) => {
    const items = [...(e.clipboardData?.items || [])];
    const img = items.find((it) => it.type.startsWith("image/"));
    if (img) {
      e.preventDefault();
      readFile(img.getAsFile());
    } else if (e.target !== input) {
      // Text pasted anywhere else on the page: read it directly.
      const text = e.clipboardData.getData("text").trim();
      if (text) { e.preventDefault(); read({ text }); }
    }
  });

  // Drag overlay: count enters/leaves so child elements don't make it flicker.
  let depth = 0;
  const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes("Files");
  addEventListener("dragenter", (e) => {
    if (!hasFiles(e) || !ready) return;
    depth++;
    overlay.hidden = false;
  });
  addEventListener("dragleave", () => { if (--depth <= 0) { depth = 0; overlay.hidden = true; } });
  addEventListener("dragover", (e) => { if (hasFiles(e)) e.preventDefault(); });
  addEventListener("drop", (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    depth = 0;
    overlay.hidden = true;
    const file = e.dataTransfer.files[0];
    if (file && ready) readFile(file);
  });

  // For the "What can it do?" pop-up: run a sample through the same path as a real drop.
  window.astrolabeDrop = {
    isReady: () => ready,
    recheck: checkServer,
    readFile,
    readText(text) {
      detach();
      input.value = text;
      syncGo();
      read({ text });
    },
  };

  checkServer();
})();
