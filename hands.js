// Hand control: turn the dial with your hand through the webcam.
//   Pinch (thumb + index) to grab the dial, twist your hand like a knob to turn it,
//   let go to leave it there. Only a real pinch moves it: fists and open hands do nothing.
//   "Back to now" (button or Esc) returns to the present.
// Runs entirely in the browser (MediaPipe Hand Landmarker); no frames leave the machine.
// Desktop/laptop only: on touch-first devices this file does nothing at all.

// A mouse/trackpad device: phones and tablets never load any of this.
const DESKTOP = matchMedia("(hover: hover) and (pointer: fine)").matches;
// Below this width the page shows the "bigger screen" message (see styles.css).
const WIDE_ENOUGH = matchMedia("(min-width: 900px)");

const MP_VERSION = "0.10.14";
const MP_URL = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${MP_VERSION}`;
const MODEL_URL =
  "https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task";

// Dial degrees per degree of hand twist. The dial is 15°/hour, so a 90° wrist turn ≈ 12 h.
const GAIN = 2;
const MS_PER_DIAL_DEG = 3600000 / 15;
const PINCH_ON = 0.32;   // thumb–index gap as a fraction of hand size
const PINCH_OFF = 0.48;  // hysteresis so a wobbly pinch doesn't drop the dial
// A pinch must hold this long before it grabs, so passing gestures (closing into a fist,
// waving, turning the hand) don't catch the dial on the way through.
const PINCH_CONFIRM_MS = 120;
// The dial clicks in 5-minute steps like a detented knob. It only moves to the next
// step once the hand has clearly gone past it, so tremor smaller than that is ignored.
const DETENT_MS = 5 * 60000;
const DETENT_HYSTERESIS = 1; // steps to travel past the current one before clicking over
// Pinching jolts the hand; hold the dial still briefly after grabbing while the filter settles.
const GRAB_SETTLE_MS = 300;

// Landmark indices (MediaPipe hand model).
const WRIST = 0, THUMB_TIP = 4, INDEX_MCP = 5, INDEX_TIP = 8, MIDDLE_MCP = 9;
const KNUCKLES = [5, 9, 13, 17];

// 3D distance: depth stops a sideways-turned hand from looking pinched in the 2D image.
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
const wrapDeg = (d) => ((d + 540) % 360) - 180;

// Hand roll, clockwise from straight up, as the user sees it (camera image is mirrored).
// Measured wrist → average of the four knuckles: averaging points cancels a lot of noise.
function handAngle(lm) {
  const kx = KNUCKLES.reduce((s, i) => s + lm[i].x, 0) / KNUCKLES.length;
  const ky = KNUCKLES.reduce((s, i) => s + lm[i].y, 0) / KNUCKLES.length;
  const dx = -(kx - lm[WRIST].x);
  const dy = ky - lm[WRIST].y;
  return (Math.atan2(dx, -dy) * 180) / Math.PI;
}

// One Euro filter (Casiez et al.): heavy smoothing when the hand is nearly still (kills
// jitter), light smoothing when it moves fast (keeps it responsive). Works on unwrapped degrees.
class OneEuro {
  constructor(minCutoff = 0.4, beta = 0.03, dCutoff = 1) {
    Object.assign(this, { minCutoff, beta, dCutoff });
    this.reset();
  }
  reset() { this.x = null; this.dx = 0; this.t = 0; }
  static alpha(cutoff, dt) { const tau = 1 / (2 * Math.PI * cutoff); return 1 / (1 + tau / dt); }
  filter(value, tMs) {
    if (this.x === null) { this.x = value; this.t = tMs; return value; }
    const dt = Math.max((tMs - this.t) / 1000, 1e-3);
    this.t = tMs;
    const rawDx = (value - this.x) / dt;
    this.dx += OneEuro.alpha(this.dCutoff, dt) * (rawDx - this.dx);
    const cutoff = this.minCutoff + this.beta * Math.abs(this.dx);
    this.x += OneEuro.alpha(cutoff, dt) * (value - this.x);
    return this.x;
  }
}

// Landmarks come normalised to image width and height separately; put x and z on the
// same scale as y so distances and angles aren't stretched by the 4:3 frame.
function toSquare(lm, aspect) {
  return lm.map((p) => ({ x: p.x * aspect, y: p.y, z: p.z * aspect }));
}

// A pinch, not a fist: thumb and index tips touch and the index finger reaches out rather
// than curling into the palm. The other three fingers can do anything: most people curl
// them when they pinch, some hold them out like an "OK" sign; both count.
function pinchState(lm) {
  const size = dist(lm[WRIST], lm[MIDDLE_MCP]);
  const gap = dist(lm[THUMB_TIP], lm[INDEX_TIP]) / size;
  const indexOut = dist(lm[INDEX_TIP], lm[WRIST]) > dist(lm[INDEX_MCP], lm[WRIST]) * 1.1;
  return {
    pinched: gap < PINCH_ON && indexOut,
    released: gap > PINCH_OFF || !indexOut, // fingers opened, or the hand closed into a fist
  };
}

if (DESKTOP) setup();

function setup() {
  const ui = document.createElement("div");
  ui.className = "hands";
  ui.innerHTML = `
    <button class="hands-toggle" type="button" aria-pressed="false">
      <span class="hands-icon" aria-hidden="true">✋</span><span class="hands-label">Hand control</span>
    </button>
    <div class="hands-panel" hidden>
      <canvas class="hands-preview" width="240" height="180" aria-hidden="true"></canvas>
      <p class="hands-status">Starting camera…</p>
      <ul class="hands-help">
        <li><b>Pinch</b> to grab</li>
        <li><b>Twist</b> to turn</li>
        <li><b>Let go</b> to leave it</li>
      </ul>
    </div>`;
  // Live in the side panel's toolbar (falls back to the page corner if there is none).
  const tools = document.querySelector(".side-tools");
  if (tools) tools.insertBefore(ui, tools.querySelector(".side-now"));
  else { ui.classList.add("is-floating"); document.body.appendChild(ui); }

  const toggle = ui.querySelector(".hands-toggle");
  const label = ui.querySelector(".hands-label");
  const panel = ui.querySelector(".hands-panel");
  const status = ui.querySelector(".hands-status");
  const canvas = ui.querySelector(".hands-preview");
  const ctx = canvas.getContext("2d");

  let landmarker = null, video = null, stream = null, running = false;
  let grabbing = false, pinchSince = 0;
  // While grabbed: continuous angle (unwrapped), its filtered value, and offsets.
  let unwrapped = 0, lastRaw = 0, grabAngle = 0, grabOffset = 0, detent = 0, grabbedAt = 0;
  const smoother = new OneEuro();
  // Recent dial positions, so letting go can undo the twitch that opening the fingers causes.
  let history = [];
  const RELEASE_ROLLBACK_MS = 150;

  toggle.addEventListener("click", () => (running ? stop() : start()));
  // Window shrunk past the cut-off: the dial is hidden, so turn the camera off too.
  WIDE_ENOUGH.addEventListener("change", (e) => { if (!e.matches && running) stop(); });

  async function start() {
    running = true;
    toggle.setAttribute("aria-pressed", "true");
    label.textContent = "Stop camera";
    panel.hidden = false;
    status.textContent = "Loading hand model…";
    try {
      if (!landmarker) {
        const { FilesetResolver, HandLandmarker } = await import(`${MP_URL}/vision_bundle.mjs`);
        const files = await FilesetResolver.forVisionTasks(`${MP_URL}/wasm`);
        landmarker = await HandLandmarker.createFromOptions(files, {
          baseOptions: { modelAssetPath: MODEL_URL, delegate: "GPU" },
          runningMode: "VIDEO",
          numHands: 1,
        });
      }
      if (!running) return;
      status.textContent = "Waiting for camera permission…";
      stream = await navigator.mediaDevices.getUserMedia({ video: { width: 640, height: 480, facingMode: "user" } });
      if (!running) return stopStream();
      video = document.createElement("video");
      video.srcObject = stream;
      video.muted = true;
      video.playsInline = true;
      await video.play();
      status.textContent = "Show your hand";
      loop();
    } catch (err) {
      console.error("[astrolabe] hand control failed:", err);
      status.textContent = err.name === "NotAllowedError"
        ? "Camera access was blocked. Allow it in the address bar and try again."
        : "Couldn't start hand control. Check the camera and your connection.";
      running = false;
      stopStream();
      toggle.setAttribute("aria-pressed", "false");
      label.textContent = "Hand control";
    }
  }

  function stopStream() {
    stream?.getTracks().forEach((t) => t.stop());
    stream = null;
  }

  function stop() {
    running = false;
    grabbing = false;
    stopStream();
    document.body.classList.remove("grabbing");
    toggle.setAttribute("aria-pressed", "false");
    label.textContent = "Hand control";
    panel.hidden = true;
  }

  let lastVideoTime = -1;
  function loop() {
    if (!running) return;
    if (video.currentTime !== lastVideoTime) {
      lastVideoTime = video.currentTime;
      const result = landmarker.detectForVideo(video, performance.now());
      const lm = result.landmarks?.[0];
      handle(lm);
      draw(lm);
    }
    requestAnimationFrame(loop);
  }

  function handle(lm) {
    if (!lm) {
      setGrab(false);
      pinchSince = 0;
      status.textContent = "Show your hand";
      return;
    }
    lm = toSquare(lm, video.videoWidth / video.videoHeight || 4 / 3);
    const { pinched, released } = pinchState(lm);
    const angle = handAngle(lm);

    // Debounce: only a pinch held for PINCH_CONFIRM_MS counts.
    pinchSince = pinched ? pinchSince || performance.now() : 0;
    const confirmed = pinchSince && performance.now() - pinchSince >= PINCH_CONFIRM_MS;

    if (!grabbing && confirmed) {
      setGrab(true);
      unwrapped = lastRaw = angle;
      smoother.reset();
      grabbedAt = performance.now();
      grabAngle = smoother.filter(unwrapped, grabbedAt);
      grabOffset = detent = window.astrolabe.getOffset();
      history = [];
    } else if (grabbing && released) {
      setGrab(false);
      const cutoff = performance.now() - RELEASE_ROLLBACK_MS;
      const settled = history.filter((h) => h.t <= cutoff).pop();
      if (settled && settled.ms !== detent) window.astrolabe.setOffset(settled.ms);
    }

    if (grabbing) {
      unwrapped += wrapDeg(angle - lastRaw); // follow past ±180° without a jump
      lastRaw = angle;
      const smooth = smoother.filter(unwrapped, performance.now());
      if (performance.now() - grabbedAt < GRAB_SETTLE_MS) grabAngle = smooth; // re-anchor while settling
      // Dial follows the hand: clockwise twist turns the rings clockwise (back in time).
      const raw = grabOffset - (smooth - grabAngle) * GAIN * MS_PER_DIAL_DEG;
      if (Math.abs(raw - detent) > DETENT_MS * DETENT_HYSTERESIS) {
        detent = Math.round(raw / DETENT_MS) * DETENT_MS;
        window.astrolabe.setOffset(detent);
      }
      const now = performance.now();
      history.push({ t: now, ms: detent });
      while (history.length > 2 && history[1].t < now - 1000) history.shift();
      status.textContent = "Turning…";
    } else {
      status.textContent = "Ready";
    }
  }

  function setGrab(on) {
    grabbing = on;
    document.body.classList.toggle("grabbing", on);
  }

  // Mirrored preview with the tracked hand drawn on top, so you can see it's working.
  function draw(lm) {
    const { width: w, height: h } = canvas;
    ctx.save();
    ctx.translate(w, 0);
    ctx.scale(-1, 1);
    ctx.drawImage(video, 0, 0, w, h);
    ctx.restore();
    if (!lm) return;
    ctx.fillStyle = grabbing ? "#e53935" : "#f4e7c6";
    for (const p of lm) {
      ctx.beginPath();
      ctx.arc((1 - p.x) * w, p.y * h, 2.5, 0, Math.PI * 2);
      ctx.fill();
    }
  }
}
