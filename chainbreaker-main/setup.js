/* ==========================================================================
   ChainBreaker — onboarding flow
   Plays the welcome animation, collects the profile and checks the local
   server. Kivd's system prompt is generated from the answers, not editable.
   ========================================================================== */

(function () {
  "use strict";

  if (!window.ChainBreaker) {
    document.body.innerHTML =
      '<p style="padding:40px;font-family:system-ui">profile.js failed to load, so setup cannot run.</p>';
    return;
  }

  var CB = window.ChainBreaker;

  var form = document.getElementById("setupForm");
  var panels = document.querySelectorAll(".panel");
  var navItems = document.querySelectorAll("[data-stepnav]");
  var backBtn = document.getElementById("backBtn");
  var nextBtn = document.getElementById("nextBtn");
  var finishBtn = document.getElementById("finishBtn");
  var progressBar = document.getElementById("progressBar");
  var splash = document.getElementById("splash");

  var nameInput = document.getElementById("name");
  var ageInput = document.getElementById("age");
  var statusInput = document.getElementById("status");
  var goalInput = document.getElementById("goal");
  var nameError = document.getElementById("nameError");
  var ageError = document.getElementById("ageError");
  var toneChips = document.getElementById("toneChips");
  var toneHint = document.getElementById("toneHint");
  var recheckBtn = document.getElementById("recheckBtn");

  var conn = document.getElementById("conn");
  var connIcon = document.getElementById("connIcon");
  var connTitle = document.getElementById("connTitle");
  var connMessage = document.getElementById("connMessage");
  var connMeta = document.getElementById("connMeta");
  var connProvider = document.getElementById("connProvider");
  var connModel = document.getElementById("connModel");
  var connKey = document.getElementById("connKey");

  var TONE_HINTS = {
    gentle: "Warm and encouraging, but still honest. Never lectures.",
    direct: "Names the problem plainly, without being harsh.",
    blunt: "Says it in the first sentence if you're avoiding something. Still no shaming.",
  };

  var STEP_COUNT = 3;
  var step = 1;

  var existing = CB.loadProfile();

  var draft = existing || {
    name: "",
    age: "",
    status: "",
    goal: "",
    tone: "direct",
    customPrompt: "",
  };

  /* --------------------------------------------------------------- splash --
     Re-editing your setup shouldn't replay the whole welcome, so skip it when
     a profile already exists. Clicking or pressing a key skips it early. */
  function skipSplash() {
    if (splash) splash.classList.add("is-skipped");
  }

  if (splash) {
    if (existing) skipSplash();
    splash.addEventListener("click", skipSplash);
    window.setTimeout(function () {
      document.addEventListener("keydown", skipSplash, { once: true });
    }, 60);
    window.setTimeout(skipSplash, 3400);
  }

  /* ------------------------------------------------------------- helpers -- */

  function setTone(tone) {
    draft.tone = tone;
    var chips = toneChips.querySelectorAll(".chip");
    for (var i = 0; i < chips.length; i++) {
      var active = chips[i].getAttribute("data-tone") === tone;
      chips[i].classList.toggle("is-active", active);
      chips[i].setAttribute("aria-pressed", active ? "true" : "false");
    }
    toneHint.textContent = TONE_HINTS[tone] || "";
  }

  function showStep(next) {
    step = Math.min(STEP_COUNT, Math.max(1, next));

    for (var i = 0; i < panels.length; i++) {
      panels[i].classList.toggle("is-active", Number(panels[i].dataset.panel) === step);
    }

    for (var j = 0; j < navItems.length; j++) {
      var n = Number(navItems[j].dataset.stepnav);
      navItems[j].classList.toggle("is-active", n === step);
      navItems[j].classList.toggle("is-done", n < step);
    }

    backBtn.hidden = step === 1;
    nextBtn.hidden = step === STEP_COUNT;
    finishBtn.hidden = step !== STEP_COUNT;
    progressBar.style.width = (step / STEP_COUNT) * 100 + "%";

    if (step === 3) checkConnection();

    var heading = document.querySelector('.panel[data-panel="' + step + '"] h2');
    if (heading) {
      heading.setAttribute("tabindex", "-1");
      heading.focus({ preventScroll: true });
    }
    window.scrollTo(0, 0);
  }

  function validAge(raw) {
    if (raw === "") return true; // optional
    var n = Number(raw);
    return Number.isFinite(n) && n >= 10 && n <= 100 && Math.floor(n) === n;
  }

  function validateStep1() {
    var nameOk = nameInput.value.trim().length > 0;
    nameError.hidden = nameOk;
    nameInput.classList.toggle("is-invalid", !nameOk);

    var ageOk = validAge(ageInput.value.trim());
    ageError.hidden = ageOk;
    ageInput.classList.toggle("is-invalid", !ageOk);

    if (!nameOk) nameInput.focus();
    else if (!ageOk) ageInput.focus();

    return nameOk && ageOk;
  }

  /* ----------------------------------------------------- connection check -- */

  function paintConn(state, title, message) {
    conn.dataset.state = state;
    connTitle.textContent = title;
    connMessage.textContent = message;
    connIcon.classList.toggle("is-spinning", state === "checking");
    connMeta.hidden = state !== "ok" && state !== "warn";
  }

  function checkConnection() {
    paintConn("checking", "Checking your local server…", "Looking for a server on this address.");

    if (location.protocol === "file:") {
      paintConn(
        "bad",
        "This page was opened as a file",
        "Start the server by double-clicking start.cmd, then open http://localhost:8787/index.html"
      );
      return;
    }

    var controller = typeof AbortController !== "undefined" ? new AbortController() : null;
    var timer = setTimeout(function () {
      if (controller) controller.abort();
    }, 6000);

    fetch("/api/health", { signal: controller ? controller.signal : undefined })
      .then(function (res) {
        var type = res.headers.get("content-type") || "";
        if (type.indexOf("application/json") === -1) throw new Error("not-cb");
        return res.json();
      })
      .then(function (data) {
        connProvider.textContent = data.preset || "—";
        connModel.textContent = data.model || "—";
        connKey.textContent = data.hasKey ? "loaded" : "missing";

        if (data.hasKey) {
          paintConn(
            "ok",
            "Kivd is connected",
            "Your server is running with the " + data.model + " model. You're ready."
          );
        } else {
          paintConn(
            "warn",
            "Server running, but no API key",
            "Open config.json, paste your key where it says PASTE_YOUR_API_KEY_HERE, then restart the server."
          );
        }
      })
      .catch(function (err) {
        if (err && err.message === "not-cb") {
          paintConn(
            "bad",
            "That's a different web server",
            "Something is serving this folder, but it isn't the ChainBreaker server, so Kivd can't reply. Close it and run start.cmd instead."
          );
        } else if (location.port === "8787") {
          paintConn(
            "bad",
            "The ChainBreaker server isn't responding",
            "Double-click start.cmd in the chainbreaker folder and leave the black window open, then press Check again."
          );
        } else {
          paintConn(
            "bad",
            "Can't reach the server",
            "Open http://localhost:8787/index.html instead of this address, and make sure start.cmd is running."
          );
        }
      })
      .then(function () {
        clearTimeout(timer);
      });
  }

  /* ---------------------------------------------------------------- wiring -- */

  nameInput.value = draft.name || "";
  ageInput.value = draft.age || "";
  statusInput.value = draft.status || "";
  goalInput.value = draft.goal || "";
  setTone(draft.tone || "direct");

  function syncFromFields() {
    draft.name = nameInput.value.trim();
    draft.age = ageInput.value.trim();
    draft.status = statusInput.value;
    draft.goal = goalInput.value.trim();
    if (draft.name) {
      nameError.hidden = true;
      nameInput.classList.remove("is-invalid");
    }
  }

  form.addEventListener("input", function () {
    syncFromFields();
  });

  form.addEventListener("change", function (event) {
    if (event.target === statusInput) syncFromFields();
  });

  toneChips.addEventListener("click", function (event) {
    var chip = event.target.closest("[data-tone]");
    if (!chip) return;
    syncFromFields();
    setTone(chip.getAttribute("data-tone"));
  });

  recheckBtn.addEventListener("click", checkConnection);

  nextBtn.addEventListener("click", function () {
    if (step === 1 && !validateStep1()) return;
    syncFromFields();
    showStep(step + 1);
  });

  backBtn.addEventListener("click", function () {
    showStep(step - 1);
  });

  // Enter advances on the single-line steps, but never hijacks the textareas.
  form.addEventListener("keydown", function (event) {
    if (event.key !== "Enter" || event.shiftKey) return;
    var tag = (event.target.tagName || "").toLowerCase();
    if (tag === "input" && step < STEP_COUNT) {
      event.preventDefault();
      nextBtn.click();
    }
  });

  for (var n = 0; n < navItems.length; n++) {
    (function (item) {
      item.addEventListener("click", function () {
        var target = Number(item.dataset.stepnav);
        if (target > step && !validateStep1()) return;
        syncFromFields();
        showStep(target);
      });
    })(navItems[n]);
  }

  form.addEventListener("submit", function (event) {
    event.preventDefault();

    if (!validateStep1()) {
      showStep(1);
      return;
    }
    syncFromFields();

    var saved = CB.saveProfile({
      name: draft.name,
      age: draft.age,
      status: draft.status,
      goal: draft.goal,
      tone: draft.tone,
      // The prompt is always generated from the answers now, never hand-edited.
      customPrompt: "",
      // Preserve these, or Kivd would introduce himself all over again.
      greeted: existing ? existing.greeted : false,
      createdAt: existing ? existing.createdAt : 0,
    });

    if (!saved) {
      paintConn(
        "bad",
        "Could not save your profile",
        "This browser is blocking local storage. Check that you're not in a private window, and that storage is allowed for localhost."
      );
      return;
    }

    finishBtn.disabled = true;
    finishBtn.textContent = "Opening…";
    window.location.href = "index_2.html";
  });

  showStep(1);
})();
