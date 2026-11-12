// "What can it do?": a button in the bottom-right corner that opens a pop-up listing
// every feature, each with a button to try it on the spot.

(() => {
  const openBtn = document.querySelector(".tour-open");
  const dialog = document.querySelector(".tour");
  const SAMPLE_TEXT = "Launch is Thursday at 10am PT, and the retro is Friday 4:30pm London time.";
  const SAMPLE_MEETING = "Find a one-hour call with the teams in New York and London next week.";

  // The button glows until someone has opened the pop-up once.
  let seen = false;
  try { seen = localStorage.getItem("astrolabe-tour-seen") === "1"; } catch {}
  openBtn.classList.toggle("is-new", !seen);

  openBtn.addEventListener("click", () => {
    // The sample buttons stay enabled; if the AI is unreachable, the tools card says so.
    window.astrolabeDrop?.recheck();
    dialog.showModal();
    openBtn.classList.remove("is-new");
    try { localStorage.setItem("astrolabe-tour-seen", "1"); } catch {}
  });

  dialog.querySelector(".tour-close").addEventListener("click", () => dialog.close());
  // A click on the dimmed backdrop (the dialog element itself, outside its content) closes it.
  dialog.addEventListener("click", (e) => { if (e.target === dialog) dialog.close(); });

  dialog.addEventListener("click", async (e) => {
    const kind = e.target.closest(".tour-try")?.dataset.try;
    if (!kind) return;
    dialog.close();
    if (kind === "hands") {
      const toggle = document.querySelector(".hands-toggle");
      if (toggle?.getAttribute("aria-pressed") !== "true") toggle?.click();
    } else if (kind === "text") {
      window.astrolabeDrop.readText(SAMPLE_TEXT);
    } else if (kind === "meeting") {
      window.astrolabeDrop.readText(SAMPLE_MEETING);
    } else if (kind === "image") {
      const blob = await (await fetch("sample-invite.png")).blob();
      window.astrolabeDrop.readFile(new File([blob], "sample-invite.png", { type: "image/png" }));
    }
  });
})();
