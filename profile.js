/* ==========================================================================
   ChainBreaker — shared profile, prompt and conversation storage
   --------------------------------------------------------------------------
   Loaded by index.html and index_2.html so the storage contract lives in one
   place. Nothing here touches the network.
   ========================================================================== */

(function (global) {
  "use strict";

  var PROFILE_KEY = "chainbreaker.profile.v1";
  var CHATS_KEY = "chainbreaker.chats.v1";

  var DEFAULTS = {
    name: "",
    age: "",
    status: "", // student | working | other
    goal: "",
    tone: "direct", // gentle | direct | blunt
    customPrompt: "", // empty means "use the generated persona"
    greeted: false, // has Kivd sent the opening message yet
    createdAt: 0,
  };

  /* Some browsers block storage on file:// or in private mode. Rather than
     throwing, we report it so the UI can explain itself. */
  var storageWorks = (function () {
    try {
      var probe = "__cb_probe__";
      global.localStorage.setItem(probe, "1");
      global.localStorage.removeItem(probe);
      return true;
    } catch (e) {
      return false;
    }
  })();

  function readJSON(key, fallback) {
    if (!storageWorks) return fallback;
    try {
      var raw = global.localStorage.getItem(key);
      if (!raw) return fallback;
      var parsed = JSON.parse(raw);
      return parsed === null || parsed === undefined ? fallback : parsed;
    } catch (e) {
      return fallback;
    }
  }

  function writeJSON(key, value) {
    if (!storageWorks) return false;
    try {
      global.localStorage.setItem(key, JSON.stringify(value));
      return true;
    } catch (e) {
      return false;
    }
  }

  function loadProfile() {
    var stored = readJSON(PROFILE_KEY, null);
    if (!stored || typeof stored !== "object") return null;
    var merged = {};
    for (var k in DEFAULTS) {
      if (Object.prototype.hasOwnProperty.call(DEFAULTS, k)) {
        merged[k] = stored[k] === undefined ? DEFAULTS[k] : stored[k];
      }
    }
    return merged;
  }

  function saveProfile(profile) {
    var merged = {};
    for (var k in DEFAULTS) {
      if (Object.prototype.hasOwnProperty.call(DEFAULTS, k)) {
        merged[k] = profile[k] === undefined ? DEFAULTS[k] : profile[k];
      }
    }
    if (!merged.createdAt) merged.createdAt = Date.now();
    return writeJSON(PROFILE_KEY, merged) ? merged : false;
  }

  function clearProfile() {
    if (!storageWorks) return;
    try {
      global.localStorage.removeItem(PROFILE_KEY);
    } catch (e) {}
  }

  function isReady() {
    var p = loadProfile();
    return Boolean(p && p.name);
  }

  /* ---------------------------------------------------------------- chats */

  function loadChats() {
    var chats = readJSON(CHATS_KEY, []);
    return Array.isArray(chats) ? chats : [];
  }

  function saveChats(chats) {
    return writeJSON(CHATS_KEY, Array.isArray(chats) ? chats : []);
  }

  function makeChat() {
    return {
      id: "c_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 7),
      title: "",
      createdAt: Date.now(),
      messages: [],
    };
  }

  /* ------------------------------------------------ safe space / pro tier ---
     Only the entry points exist so far. Requests and messages are stored on
     this device and deliberately NOT sent anywhere, because there is no
     matching service or therapist backend yet. */

  var REQUESTS_KEY = "chainbreaker.requests.v1";
  var RECOVERY_KEY = "chainbreaker.recovery.v1";

  function loadRequests() {
    var list = readJSON(REQUESTS_KEY, []);
    return Array.isArray(list) ? list : [];
  }

  function addRequest(entry) {
    var list = loadRequests();
    list.unshift(entry);
    return writeJSON(REQUESTS_KEY, list) ? list : false;
  }

  function loadRecovery() {
    var r = readJSON(RECOVERY_KEY, null);
    if (!r || typeof r !== "object") {
      return { signedIn: false, contact: "", name: "", since: 0, messages: [] };
    }
    return {
      signedIn: Boolean(r.signedIn),
      contact: r.contact || "",
      name: r.name || "",
      since: r.since || 0,
      messages: Array.isArray(r.messages) ? r.messages : [],
    };
  }

  function saveRecovery(state) {
    return writeJSON(RECOVERY_KEY, state);
  }

  /* ------------------------------------------------------------- privacy ---
     A short, stable code derived from the private fields, so a therapist can
     tell "same client" without ever being shown who that is. This is
     anonymising, not encryption: it keeps the name off the therapist's screen,
     it does not protect anything at rest. */

  function anonId(profile) {
    var seed = [
      String(profile.name || "").toLowerCase().trim(),
      String(profile.age || ""),
      String(profile.status || ""),
      String(profile.createdAt || ""),
    ].join("|");

    // Two FNV-1a passes in opposite directions, then base36.
    var h1 = 0x811c9dc5;
    for (var i = 0; i < seed.length; i++) {
      h1 ^= seed.charCodeAt(i);
      h1 = Math.imul(h1, 0x01000193) >>> 0;
    }
    var h2 = 0x811c9dc5;
    for (var j = seed.length - 1; j >= 0; j--) {
      h2 ^= seed.charCodeAt(j) + j;
      h2 = Math.imul(h2, 0x01000193) >>> 0;
    }

    var code = (h1.toString(36) + h2.toString(36)).toUpperCase().replace(/[^0-9A-Z]/g, "");
    return "CB-" + code.slice(0, 6);
  }

  /* The therapist is only ever shown a coarse age band and the goal in the
     client's own words. Never a name, never a contact, never a date of birth. */
  function ageBand(profile) {
    var n = Number(profile.age);
    if (!n || !isFinite(n)) return "Not given";
    if (n < 18) return "Under 18";
    if (n < 25) return "18–24";
    if (n < 35) return "25–34";
    if (n < 50) return "35–49";
    return "50+";
  }

  /* ------------------------------------------------- session (both sides) ---
     Shared on this device so the therapist console and the client screen agree.
     Across two machines this needs a real backend — see the README. */

  var SESSION_KEY = "chainbreaker.session.v1";
  var THERAPIST_KEY = "chainbreaker.therapistAuth.v1";

  function loadSession() {
    var s = readJSON(SESSION_KEY, null);
    if (!s || typeof s !== "object") {
      return { active: false, open: false, startedAt: 0, endedAt: 0, therapist: "" };
    }
    return {
      active: Boolean(s.active),
      open: Boolean(s.open),
      startedAt: s.startedAt || 0,
      endedAt: s.endedAt || 0,
      therapist: s.therapist || "",
    };
  }

  function saveSession(s) {
    return writeJSON(SESSION_KEY, s);
  }

  function loadTherapistAuth() {
    var a = readJSON(THERAPIST_KEY, null);
    if (!a || typeof a !== "object") return null;
    return { name: a.name || "", email: a.email || "", at: a.at || 0 };
  }

  function saveTherapistAuth(a) {
    return writeJSON(THERAPIST_KEY, a);
  }

  function clearTherapistAuth() {
    if (!storageWorks) return;
    try {
      global.localStorage.removeItem(THERAPIST_KEY);
    } catch (e) {}
  }

  /* ------------------------------------------------------------- prompts ---
     The persona is generated from the profile, but the user can replace it
     with anything they like in setup — that is the "edit the prompt" step. */

  var TONE_TEXT = {
    gentle: "Be warm and encouraging, but still honest. Never lecture.",
    direct: "Be direct and specific. Name the problem plainly, without being harsh.",
    blunt:
      "Be blunt. If they are avoiding something, say so in the first sentence. Still no shaming.",
  };

  var STATUS_TEXT = {
    student: "a student",
    working: "working rather than studying",
    other: "not studying and not working at the moment",
  };

  function firstName(profile) {
    var n = profile && profile.name ? String(profile.name) : "";
    n = n.trim();
    return n ? n.split(/\s+/)[0] : "";
  }

  /* The current date and time, so Kivd knows what "today" means. */
  function nowLine() {
    var d = new Date();
    var date = d.toLocaleDateString("en-IN", {
      weekday: "long",
      day: "numeric",
      month: "long",
      year: "numeric",
    });
    var time = d.toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" });
    var zone = "";
    try {
      zone = Intl.DateTimeFormat().resolvedOptions().timeZone || "";
    } catch (e) {}
    return date + ", " + time + (zone ? " (" + zone + ")" : "");
  }

  function persona(profile) {
    var lines = [
      "You are Kivd, the companion inside ChainBreaker — a private app that helps people",
      "understand their daily struggles, steady themselves, build healthier routines and",
      "break patterns that are hurting them. You are a companion, not an instructor.",
      "",
      "You are speaking with one person, and you already know them. Use what you know",
      "naturally — never recite it back as a list, and never ask for information you",
      "already have below.",
      "",
      "WHO YOU ARE TALKING TO",
      "- Name: " + (profile.name || "the user"),
    ];

    if (profile.age) lines.push("- Age: " + profile.age);
    if (profile.status) {
      lines.push("- Currently: " + (STATUS_TEXT[profile.status] || profile.status));
    }
    if (profile.goal) lines.push("- The one thing they want to change: " + profile.goal);
    lines.push("- Preferred tone: " + (TONE_TEXT[profile.tone] || TONE_TEXT.direct));

    lines.push("");
    lines.push("RIGHT NOW");
    lines.push("- " + nowLine());
    lines.push(
      "- Use this. If they mention something from days ago, remember when it was. If they say"
    );
    lines.push(
      '  "yesterday" or "last week", work out what that actually means. Never claim a date you'
    );
    lines.push("  are not sure of.");

    lines.push("");
    lines.push("WHERE THEY LIVE — INDIA");
    lines.push("- Assume India. Everything you suggest must fit an Indian life, not an American one.");
    lines.push("  Money in rupees. Distances in kilometres. Hot weather, monsoon, chai, hostels,");
    lines.push("  shared rooms, PG accommodation, family close by.");
    lines.push("- Academic reality: board exams, JEE, NEET, CUET, university semesters, internals,");
    lines.push("  backlogs, placements, coaching centres. Exams and results seasons are enormous");
    lines.push("  pressure points, and family expectations are usually part of the picture.");
    lines.push(
      "- Never suggest something they cannot access: no $200 therapy apps, no insurance plans,"
    );
    lines.push("  no gym-only advice. Prefer what is free and already near them.");
    lines.push("- Indian English spelling: colour, realise, practise, organise.");

    lines.push("");
    lines.push("HOW YOU TALK — ASK MORE THAN YOU TELL");
    lines.push("- Your default move is a question, not an answer. Ask one question at a time.");
    lines.push("- Before you suggest anything, make sure you actually understand what happened.");
    lines.push("  If you are not sure, ask. Guessing at their life is worse than asking.");
    lines.push(
      "- Questions should open things up, not interrogate: 'What was going on just before that?'"
    );
    lines.push("  beats 'Why did you do that?'");
    lines.push("- Short. Two or three sentences is usually enough. Never lecture.");
    lines.push("- Use their name occasionally, not in every message.");
    lines.push("- Plain language. No clinical jargon, no bullet lists unless they genuinely help.");
    lines.push("- Do not give advice they did not ask for. Offer it, or wait until they ask.");

    lines.push("");
    lines.push("HOW YOU HELP THEM HEAL");
    lines.push("- Healing is slow and not linear. Treat a slip as information, never as failure.");
    lines.push("- Name what they did well out loud. People remember their failures and forget their");
    lines.push("  progress, so the good part needs saying.");
    lines.push("- Look for the pattern, not the incident: what happens before, what it costs, what");
    lines.push("  helped last time. Then say the pattern back to them plainly.");
    lines.push("- Help them reach their own conclusion. A thing they work out themselves sticks; a");
    lines.push("  thing you tell them does not.");
    lines.push("- Sit with the hard feeling before trying to fix it. Sometimes the right reply is");
    lines.push("  'that sounds exhausting' and nothing else.");
    lines.push("- When you do suggest something, make it one small thing they can do today. Not");
    lines.push('  "sleep better" — "put the phone on the kitchen counter tonight".');
    lines.push("- Hold them to what they said they would do, without nagging or shaming.");

    lines.push("");
    lines.push("WHEN THEY BRING UP SOMETHING PARTICULAR");
    lines.push(
      "- A craving or an urge: do not argue with it and do not moralise. Ask what it feels like"
    );
    lines.push(
      "  and where they are. Point them to the Time Freeze timer in the app. Remind them an"
    );
    lines.push("  urge peaks and drops, usually inside a few minutes, and they only have to wait.");
    lines.push(
      "- A slip or relapse: first, no shame — say it plainly, then move on. Ask what happened"
    );
    lines.push(
      "  just before. Look for one thing that was different from the days that went well. End"
    );
    lines.push("  with one thing to try tomorrow, not a lecture.");
    lines.push(
      "- Exam, result or deadline stress: separate what they control from what they do not."
    );
    lines.push("  Shrink the next step until it is small enough to start. Sleep matters more than");
    lines.push("  one more hour of revision, and say so.");
    lines.push(
      "- Cannot sleep: ask what their evenings actually look like. Fix the hour before bed"
    );
    lines.push("  before talking about sleep itself.");
    lines.push(
      "- Family pressure: take it seriously and do not tell them to just talk to their parents."
    );
    lines.push("  It is complicated and often not safe or simple. Ask what happens if they do.");
    lines.push(
      "- Low mood that has lasted weeks, or they sound flat and hopeless: say kindly that this"
    );
    lines.push("  is bigger than a habit and deserves a real person. Do not try to coach it away.");
    lines.push(
      "- Sounding like they are giving up — hopeless, exhausted, 'what is the point': do NOT"
    );
    lines.push("  jump to advice. Steady them first: say something true and kind that you actually");
    lines.push("  know about them. Then one honest good thing about how far they have already come.");
    lines.push("  Only then ask a single gentle question. Motivate first, then ask — never the");
    lines.push("  other way round.");
    lines.push(
      "- Never reply with something generic like 'I'm sorry you feel that way'. That is the one"
    );
    lines.push("  thing that makes people stop talking. If they say 'I am depressed', answer with");
    lines.push("  what you actually heard from them, then ask what it feels like day to day — heavy,");
    lines.push("  numb, or flat. Specific beats sympathetic, every time.");
    lines.push(
      "- Anything about self-harm, suicide, abuse or a medical emergency: the app puts emergency"
    );
    lines.push("  options on screen by itself, without you. Keep your own reply to two short, warm");
    lines.push("  sentences and point them at those options. Do not lecture, and do not list");
    lines.push("  helplines — the screen is already doing that.");

    lines.push("");
    lines.push("BOUNDARY — THIS MATTERS");
    lines.push("You are not a doctor, therapist or counsellor, and you must not act like one.");
    lines.push("Do not diagnose, and never give medical or medication advice. When something is");
    lines.push("beyond what a companion should handle, say so plainly and kindly, point them to a");
    lines.push("real person, and stop trying to manage it yourself. Never minimise it, and never");
    lines.push("promise to keep it secret.");

    return lines.join("\n");
  }

  /* The system prompt is always generated from the profile now. It used to be
     editable in setup; that field is gone, so a customPrompt left behind in an
     older profile is deliberately ignored — otherwise a stale prompt would
     reintroduce the previous assistant name. */
  function buildSystem(profile) {
    return persona(profile);
  }

  /* The synthetic first turn that makes Kivd open the conversation. It is a
     real model call, so the greeting is genuinely Kivd's — this text is the
     instruction, not the reply. */
  var OPENING_INSTRUCTION = [
    "(This is the very first message of our conversation and nobody has spoken yet.)",
    "Greet me by name and ask how my day was today.",
    "One or two short sentences. Do not introduce yourself, do not list what you can do,",
    "and do not offer a menu of options.",
  ].join(" ");

  /* Used when the model is unreachable, so the app is never silent. */
  function openingFallback(profile) {
    var first = firstName(profile);
    return first ? "Hi " + first + ", how was your day today?" : "Hi, how was your day today?";
  }

  /* Every NEW chat opens with this intake instead of the greeting. */
  var INTAKE_INSTRUCTION = [
    "(A new conversation is starting and nobody has spoken yet.)",
    "Ask me three things, in this order, numbered 1 to 3:",
    "1) what my goal is,",
    "2) how I plan to achieve it,",
    "3) whether I think I will manage to achieve it if I carry on with my bad habits.",
    "Keep each question to a single line. Do not answer them yourself, and do not give advice yet.",
  ].join(" ");

  function intakeFallback(profile) {
    var first = firstName(profile);
    return [
      (first ? first + ", let's" : "Let's") + " set this up properly. Three questions:",
      "",
      "1. What is your goal?",
      "2. How do you plan to achieve it?",
      "3. If you carry on with your bad habits, do you think you'll get there?",
    ].join("\n");
  }

  function greeting(profile) {
    var hour = new Date().getHours();
    var part = hour < 12 ? "Good morning" : hour < 18 ? "Good afternoon" : "Good evening";
    var first = firstName(profile);
    return part + (first ? ", " + first : "");
  }

  /* Suggestion cards are derived from the profile rather than hardcoded. */
  function suggestions(profile) {
    var out = [];
    var goal = (profile.goal || "").trim();

    out.push({
      icon: "i-message",
      title: "Tell Kivd about today",
      text: "What actually happened, good or bad",
      prompt: "Let me tell you about my day.",
    });

    out.push(
      goal
        ? {
            icon: "i-target",
            title: "Work on your goal",
            text: goal.length > 46 ? goal.slice(0, 46) + "…" : goal,
            prompt:
              "The thing I want to change is: " +
              goal +
              ". Break it into one small action I can do today, and tell me what usually gets in the way.",
          }
        : {
            icon: "i-target",
            title: "Set a goal",
            text: "Name the one thing to change",
            prompt:
              "Help me pick the one habit I most need to change. Ask me what's been going wrong lately.",
          }
    );

    out.push({
      icon: "i-flame",
      title: "Break a bad habit",
      text: "What sets it off, and what beats it",
      prompt:
        "I want to break a bad habit. Ask me what sets it off, then help me plan around it.",
    });

    out.push({
      icon: "i-bulb",
      title: "Something's on my mind",
      text: "Untangle it together",
      prompt: "Something's been on my mind. Ask me one question to get started.",
    });

    return out.slice(0, 4);
  }

  /* ----------------------------------------------------------- risk check ---
     Deliberately simple, and entirely client-side, so it fires instantly and
     never depends on the model noticing. "high" means possible intent to
     self-harm — that gets the emergency panel. "medium" means giving up or
     hopeless, which deserves care but not the emergency panel. */

  var HIGH_RISK = [
    /\b(kill|killing)\s+my\s?self\b/i,
    /\bsuicid\w*/i,
    /\bend\s+my\s+life\b/i,
    /\bend\s+it\s+all\b/i,
    /\b(want|wanna|wanting|going|gonna|plan)\s+to\s+die\b/i,
    /\bdon'?t\s+want\s+to\s+(live|be\s+here|exist|wake\s+up)\b/i,
    /\b(hurt|harm|cut|burn|starve)\s+my\s?self\b/i,
    /\bself[\s-]?harm\w*/i,
    /\bno\s+reason\s+to\s+live\b/i,
    /\bbetter\s+off\s+dead\b/i,
    /\bnot\s+worth\s+living\b/i,
    /\boverdose\b/i,
    // Hinglish and Hindi, because people often switch language at this point.
    /\bmarna\s+chaht/i,
    /\bmar\s+(jaun|jaoon|jana|dunga|dungi|raha|rahi)\b/i,
    /\bjaan\s+de(na|doon|dunga|dungi)\b/i,
    /\bkhatam\s+kar\s+(doon|dunga|dungi|dena|le)\b/i,
    /\baatmhatya\b/i,
  ];

  var MEDIUM_RISK = [
    /* "give up" only counts when it is about them, not about sugar or cigarettes. */
    /\b(i\s+)?(want|wanna|wanting|going|gonna)\s+to\s+give\s+up\b(?!\s+(sugar|sweets|soda|coffee|tea|meat|smoking|drinking|alcohol|vaping|weed|drugs?|junk|screens?|social|my\s+phone|my\s+seat|chocolate|carbs|fast\s+food))/i,
    /\bgive\s+up\s+on\s+(life|everything|myself|it\s+all|living)\b/i,
    /\bfeel\s+(like\s+)?giving\s+up\b/i,
    /\bhopeless\b/i,
    /\bno\s+point\b/i,
    /\bcan'?t\s+(do\s+this|take\s+it|go\s+on|keep\s+going)\b/i,
    /\bhate\s+my\s?self\b/i,
    /\bworthless\b/i,
    /\bbreaking\s+down\b/i,
    /\bnot\s+feeling\s+good\b/i,
    /\bdepress(ed|ing)\b/i,
    /\bfed\s+up\s+with\s+(life|everything|myself)\b/i,
    /\bso\s+(sad|empty|hopeless|worthless|done)\b/i,
    // Hinglish
    /\bhaar\s+(gaya|gayi|gya|mann)\b/i,
    /\bmann\s+nahi\s+lag/i,
    /\budaas\b/i,
  ];

  function detectRisk(text) {
    var t = String(text || "");
    for (var i = 0; i < HIGH_RISK.length; i++) {
      if (HIGH_RISK[i].test(t)) return "high";
    }
    for (var j = 0; j < MEDIUM_RISK.length; j++) {
      if (MEDIUM_RISK[j].test(t)) return "medium";
    }
    return null;
  }

  global.ChainBreaker = {
    PROFILE_KEY: PROFILE_KEY,
    CHATS_KEY: CHATS_KEY,
    storageWorks: storageWorks,
    loadProfile: loadProfile,
    saveProfile: saveProfile,
    clearProfile: clearProfile,
    isReady: isReady,
    loadChats: loadChats,
    saveChats: saveChats,
    makeChat: makeChat,
    loadRequests: loadRequests,
    addRequest: addRequest,
    loadRecovery: loadRecovery,
    saveRecovery: saveRecovery,
    anonId: anonId,
    ageBand: ageBand,
    loadSession: loadSession,
    saveSession: saveSession,
    loadTherapistAuth: loadTherapistAuth,
    saveTherapistAuth: saveTherapistAuth,
    clearTherapistAuth: clearTherapistAuth,
    persona: persona,
    buildSystem: buildSystem,
    openingInstruction: OPENING_INSTRUCTION,
    openingFallback: openingFallback,
    intakeInstruction: INTAKE_INSTRUCTION,
    intakeFallback: intakeFallback,
    greeting: greeting,
    suggestions: suggestions,
    firstName: firstName,
    detectRisk: detectRisk,
  };
})(window);
