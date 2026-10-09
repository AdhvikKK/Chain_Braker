/* ==========================================================================
   ChainBreaker — application
   --------------------------------------------------------------------------
   Talks to the local server at /api/chat, which proxies an OpenAI-compatible
   provider. Kivd opens the conversation on first run; everything after that
   is real model output. Nothing on screen is canned.
   ========================================================================== */

(function () {
  "use strict";

  var CB = window.ChainBreaker;
  if (!CB) return;

  var doc = document;
  var root = doc.documentElement;

  var chat = doc.getElementById("chat");
  var messages = doc.getElementById("messages");
  var empty = doc.getElementById("empty");
  var suggestions = doc.getElementById("suggestions");
  var form = doc.getElementById("composerForm");
  var input = doc.getElementById("composer");
  var sendBtn = doc.getElementById("sendBtn");
  var template = doc.getElementById("msgTemplate");
  var convos = doc.getElementById("convos");
  var searchInput = doc.getElementById("search");
  var notice = doc.getElementById("notice");
  var noticeTitle = doc.getElementById("noticeTitle");
  var noticeText = doc.getElementById("noticeText");
  var modelLabel = doc.getElementById("modelLabel");
  var modelDot = doc.getElementById("modelDot");
  var viewChat = doc.getElementById("viewChat");
  var viewTracking = doc.getElementById("viewTracking");
  var viewFreeze = doc.getElementById("viewFreeze");
  var viewRecovery = doc.getElementById("viewRecovery");
  var trackingBadge = doc.getElementById("trackingBadge");

  var SEND_ICON = '<svg class="icon" viewBox="0 0 24 24"><use href="#i-send"></use></svg>';
  var STOP_ICON = '<svg class="icon" viewBox="0 0 24 24"><use href="#i-stop"></use></svg>';

  var profile = CB.loadProfile();
  if (!profile) {
    window.location.replace("index.html");
    return;
  }

  var state = {
    chats: CB.loadChats(),
    currentId: null,
    sending: false,
    controller: null,
    connected: false,
    view: "chat",
    opening: false,
  };

  /* ======================================================================
     1. MARKDOWN → HTML   (single-pass highlighter)
     ====================================================================== */

  function escapeHtml(text) {
    return String(text)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
  }

  var KEYWORD_WORDS =
    "const|let|var|function|return|if|else|for|while|new|class|import|from|export|default|" +
    "await|async|def|try|catch|finally|throw|of|in|typeof|instanceof|null|undefined|true|" +
    "false|this|yield|lambda|elif|pass|None|True|False|extends|implements|interface|public|" +
    "private|static|void|enum|struct|fn|match|use|pub|mut|switch|case|break|continue|do|with|" +
    "as|not|and|or|is|global|nonlocal|raise|assert|del|print";

  var SLASH_LANGS = /^(js|javascript|jsx|mjs|cjs|ts|typescript|tsx|java|c|h|cpp|c\+\+|cs|csharp|go|golang|rust|rs|swift|kotlin|kt|php|scala|dart|scss|less|json5)$/i;
  var HASH_LANGS = /^(py|python|rb|ruby|sh|bash|zsh|shell|console|yaml|yml|toml|r|perl|make|makefile|dockerfile|ini|conf)$/i;

  function tokenPattern(lang) {
    var parts = [];

    if (SLASH_LANGS.test(lang)) {
      parts.push("(\\/\\/[^\\n]*)");
    } else if (HASH_LANGS.test(lang)) {
      parts.push("(#[^\\n]*)");
    } else {
      // Unknown or plain text: skip comments, so "#fff" in CSS and "http://"
      // in prose are never mis-styled. "(?!)" never matches.
      parts.push("(?!)");
    }

    parts.push("(`[^`\\n]*`|\"[^\"\\n]*\"|'[^'\\n]*')");
    parts.push("\\b(" + KEYWORD_WORDS + ")\\b");
    parts.push("\\b(\\d+(?:\\.\\d+)?)\\b");

    return new RegExp(parts.join("|"), "g");
  }

  var patternCache = {};

  /* One single pass over the escaped source. Because replacement text is never
     re-scanned, inserted markup can't be highlighted again — which is what
     makes this safe compared with one regex pass per token type. */
  function highlight(code, lang) {
    var key = String(lang || "text").toLowerCase();
    if (!patternCache[key]) patternCache[key] = tokenPattern(key);

    return escapeHtml(code).replace(patternCache[key], function (match, comment, str, kw, num) {
      if (comment) return '<span class="tok-com">' + comment + "</span>";
      if (str) return '<span class="tok-str">' + str + "</span>";
      if (kw) return '<span class="tok-key">' + kw + "</span>";
      if (num) return '<span class="tok-num">' + num + "</span>";
      return match;
    });
  }

  function inline(text) {
    var codes = [];
    var out = escapeHtml(text);

    out = out.replace(/`([^`]+)`/g, function (_, code) {
      codes.push(code);
      return "\u0001" + (codes.length - 1) + "\u0001";
    });

    out = out.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
    out = out.replace(/(^|[\s(])\*([^*\n]+)\*/g, "$1<em>$2</em>");

    out = out.replace(/\u0001(\d+)\u0001/g, function (_, n) {
      return "<code>" + codes[Number(n)] + "</code>";
    });

    return out;
  }

  function codeBlockHtml(lang, code) {
    var label = lang || "text";
    return (
      '<div class="code-block">' +
      '<div class="code-head">' +
      '<span class="code-lang">' + escapeHtml(label) + "</span>" +
      '<button class="code-copy" type="button" data-code-copy>' +
      '<svg class="icon" viewBox="0 0 24 24"><use href="#i-copy"></use></svg><span>Copy</span>' +
      "</button>" +
      "</div>" +
      "<pre><code>" + highlight(code, label) + "</code></pre>" +
      "</div>"
    );
  }

  function renderText(text) {
    var lines = text.split("\n");
    var html = "";
    var listTag = null;
    var items = [];
    var para = [];

    function closeList() {
      if (listTag) {
        html += "<" + listTag + ">" + items.join("") + "</" + listTag + ">";
        items = [];
        listTag = null;
      }
    }

    function flushPara() {
      if (para.length) {
        html += "<p>" + inline(para.join(" ")) + "</p>";
        para = [];
      }
    }

    for (var i = 0; i < lines.length; i++) {
      var line = lines[i];
      var ordered = /^\s*\d+\.\s+(.*)$/.exec(line);
      var bullet = /^\s*[-*]\s+(.*)$/.exec(line);

      if (ordered) {
        flushPara();
        if (listTag !== "ol") {
          closeList();
          listTag = "ol";
        }
        items.push("<li>" + inline(ordered[1]) + "</li>");
      } else if (bullet) {
        flushPara();
        if (listTag !== "ul") {
          closeList();
          listTag = "ul";
        }
        items.push("<li>" + inline(bullet[1]) + "</li>");
      } else if (line.trim() === "") {
        flushPara();
        closeList();
      } else {
        closeList();
        para.push(line.trim());
      }
    }

    flushPara();
    closeList();
    return html;
  }

  function renderMarkdown(source) {
    var html = "";
    var pattern = /```([a-zA-Z0-9+#._-]*)\n?([\s\S]*?)(?:```|$)/g;
    var last = 0;
    var match;

    while ((match = pattern.exec(source)) !== null) {
      html += renderText(source.slice(last, match.index));
      html += codeBlockHtml(match[1], match[2].replace(/\n$/, ""));
      last = pattern.lastIndex;
    }
    html += renderText(source.slice(last));

    return html;
  }

  /* ======================================================================
     2. CONVERSATION STORE
     ====================================================================== */

  function currentChat() {
    for (var i = 0; i < state.chats.length; i++) {
      if (state.chats[i].id === state.currentId) return state.chats[i];
    }
    return null;
  }

  function persist() {
    CB.saveChats(state.chats);
    updateTrackingBadge();
  }

  function ensureChat() {
    var existing = currentChat();
    if (existing) return existing;

    var fresh = CB.makeChat();
    state.chats.unshift(fresh);
    state.currentId = fresh.id;
    return fresh;
  }

  function titleFrom(text) {
    var clean = text.replace(/\s+/g, " ").trim();
    return clean.length > 42 ? clean.slice(0, 42) + "…" : clean;
  }

  /* ======================================================================
     3. TRACKING   (derived from real conversations — nothing faked)
     ====================================================================== */

  function pad(n) {
    return n < 10 ? "0" + n : String(n);
  }

  function dayKey(ts) {
    var d = new Date(ts);
    return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate());
  }

  function todayKey() {
    return dayKey(Date.now());
  }

  /* Every day on which at least one message exists, newest first. */
  function activeDays() {
    var seen = {};
    state.chats.forEach(function (c) {
      (c.messages || []).forEach(function (m) {
        var ts = m.at || c.createdAt;
        if (!ts) return;
        var key = dayKey(ts);
        if (!seen[key]) seen[key] = { key: key, count: 0 };
        seen[key].count++;
      });
    });

    return Object.keys(seen)
      .map(function (k) {
        return seen[k];
      })
      .sort(function (a, b) {
        return a.key < b.key ? 1 : a.key > b.key ? -1 : 0;
      });
  }

  function currentStreak(days) {
    if (!days.length) return 0;

    var day = 86400000;
    var now = new Date();
    var startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    var have = {};
    days.forEach(function (d) {
      have[d.key] = true;
    });

    // A streak is still alive if the most recent day is today or yesterday.
    var cursor = have[todayKey()] ? startOfToday : startOfToday - day;
    if (!have[dayKey(cursor)]) return 0;

    var streak = 0;
    while (have[dayKey(cursor)]) {
      streak++;
      cursor -= day;
    }
    return streak;
  }

  function dayLabel(key) {
    var parts = key.split("-");
    var d = new Date(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2]));

    if (key === todayKey()) return "Today";
    if (key === dayKey(Date.now() - 86400000)) return "Yesterday";
    return d.toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "short" });
  }

  function updateTrackingBadge() {
    var count = activeDays().length;
    trackingBadge.textContent = String(count);
  }

  function totalMessages() {
    var n = 0;
    state.chats.forEach(function (c) {
      n += (c.messages || []).length;
    });
    return n;
  }

  function renderTracking() {
    var days = activeDays();
    var streak = currentStreak(days);

    var stats = [
      { label: "Days you showed up", value: String(days.length), icon: "i-check" },
      { label: "Current streak", value: streak + (streak === 1 ? " day" : " days"), icon: "i-flame" },
      { label: "Conversations", value: String(state.chats.length), icon: "i-message" },
      { label: "Messages", value: String(totalMessages()), icon: "i-chart" },
    ];

    var statsEl = doc.getElementById("trackStats");
    statsEl.innerHTML = "";
    stats.forEach(function (s) {
      var card = doc.createElement("div");
      card.className = "track-stat";
      card.innerHTML =
        '<span class="track-stat-icon"><svg class="icon" viewBox="0 0 24 24"><use href="#' +
        s.icon +
        '"></use></svg></span>' +
        '<span class="track-stat-value"></span><span class="track-stat-label"></span>';
      card.querySelector(".track-stat-value").textContent = s.value;
      card.querySelector(".track-stat-label").textContent = s.label;
      statsEl.appendChild(card);
    });

    var listEl = doc.getElementById("trackDays");
    listEl.innerHTML = "";

    if (!days.length) {
      var none = doc.createElement("p");
      none.className = "track-empty";
      none.textContent =
        "Nothing tracked yet. The first time you tell Kivd about your day, it appears here.";
      listEl.appendChild(none);
      return;
    }

    // Last 14 calendar days, so gaps are visible rather than smoothed over.
    var day = 86400000;
    var have = {};
    days.forEach(function (d) {
      have[d.key] = d.count;
    });

    for (var i = 0; i < 14; i++) {
      var key = dayKey(Date.now() - i * day);
      var row = doc.createElement("div");
      row.className = "track-day" + (have[key] ? " is-logged" : "");

      var dot = doc.createElement("span");
      dot.className = "track-day-dot";
      dot.setAttribute("aria-hidden", "true");

      var label = doc.createElement("span");
      label.className = "track-day-label";
      label.textContent = dayLabel(key);

      var meta = doc.createElement("span");
      meta.className = "track-day-meta";
      meta.textContent = have[key] ? have[key] + " messages" : "nothing logged";

      row.appendChild(dot);
      row.appendChild(label);
      row.appendChild(meta);
      listEl.appendChild(row);
    }
  }

  /* ======================================================================
     4. VIEWS
     ====================================================================== */

  function showView(name) {
    state.view = name;

    viewChat.hidden = name !== "chat";
    viewTracking.hidden = name !== "tracking";
    viewFreeze.hidden = name !== "freeze";
    viewRecovery.hidden = name !== "recovery";

    var links = doc.querySelectorAll("[data-view]");
    for (var i = 0; i < links.length; i++) {
      links[i].classList.toggle("is-active", links[i].getAttribute("data-view") === name);
    }

    if (name === "tracking") renderTracking();
    if (name === "recovery") renderRecovery();
    closeSidebar();

    if (name === "chat" && window.innerWidth > 860) input.focus();
  }

  /* ======================================================================
     5. SIDEBAR
     ====================================================================== */

  function dayBucket(timestamp) {
    var now = new Date();
    var startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    var day = 86400000;

    if (timestamp >= startOfToday) return "Today";
    if (timestamp >= startOfToday - day) return "Yesterday";
    if (timestamp >= startOfToday - day * 7) return "Previous 7 days";
    if (timestamp >= startOfToday - day * 30) return "Previous 30 days";
    return "Older";
  }

  function renderSidebar() {
    convos.innerHTML = "";

    if (!state.chats.length) {
      var hint = doc.createElement("p");
      hint.className = "convos-hint";
      hint.textContent = "No chats yet. Your conversations will appear here.";
      convos.appendChild(hint);
      return;
    }

    var order = ["Today", "Yesterday", "Previous 7 days", "Previous 30 days", "Older"];
    var groups = {};
    var query = (searchInput.value || "").trim().toLowerCase();

    state.chats.forEach(function (c) {
      if (query && (c.title || "").toLowerCase().indexOf(query) === -1) return;
      var bucket = dayBucket(c.createdAt);
      if (!groups[bucket]) groups[bucket] = [];
      groups[bucket].push(c);
    });

    var shown = 0;

    order.forEach(function (label) {
      var list = groups[label];
      if (!list || !list.length) return;
      shown += list.length;

      var heading = doc.createElement("p");
      heading.className = "convos-group";
      heading.textContent = label;
      convos.appendChild(heading);

      list.forEach(function (c) {
        var row = doc.createElement("div");
        row.className = "convo" + (c.id === state.currentId ? " is-active" : "");
        row.dataset.id = c.id;
        row.setAttribute("role", "button");
        row.setAttribute("tabindex", "0");

        var icon = doc.createElement("span");
        icon.className = "convo-icon";
        icon.innerHTML = '<svg class="icon" viewBox="0 0 24 24"><use href="#i-message"></use></svg>';

        var title = doc.createElement("span");
        title.className = "convo-title";
        title.textContent = c.title || "New chat";

        var tools = doc.createElement("span");
        tools.className = "convo-tools";
        tools.innerHTML =
          '<button class="icon-btn sm" type="button" data-delete aria-label="Delete chat">' +
          '<svg class="icon" viewBox="0 0 24 24"><use href="#i-trash"></use></svg></button>';

        row.appendChild(icon);
        row.appendChild(title);
        row.appendChild(tools);
        convos.appendChild(row);
      });
    });

    if (!shown) {
      var none = doc.createElement("p");
      none.className = "convos-hint";
      none.textContent = query ? "No chats match that search." : "No chats yet.";
      convos.appendChild(none);
    }
  }

  /* ======================================================================
     6. MESSAGES
     ====================================================================== */

  function nearBottom() {
    return chat.scrollTop + chat.clientHeight >= chat.scrollHeight - 140;
  }

  function scrollToBottom(force) {
    if (force || nearBottom()) chat.scrollTop = chat.scrollHeight;
  }

  function clearMessages() {
    messages.innerHTML = "";
    renderEmptyState();
  }

  function renderEmptyState() {
    var hasMessages = messages.children.length > 0;
    empty.classList.toggle("is-hidden", hasMessages);
    if (hasMessages) return;

    doc.getElementById("emptyTitle").textContent = CB.greeting(profile) + ".";
    doc.getElementById("emptyText").textContent = profile.goal
      ? "You said you're working on: " + profile.goal
      : "Tell Kivd how today went. You can change how he talks to you in your setup.";

    suggestions.innerHTML = "";
    CB.suggestions(profile).forEach(function (s) {
      var button = doc.createElement("button");
      button.className = "suggestion";
      button.type = "button";
      button.dataset.prompt = s.prompt;
      button.innerHTML =
        '<svg class="icon" viewBox="0 0 24 24"><use href="#' + s.icon + '"></use></svg>' +
        "<strong></strong><span></span>";
      button.querySelector("strong").textContent = s.title;
      button.querySelector("span").textContent = s.text;
      suggestions.appendChild(button);
    });
  }

  function addUserMessage(text) {
    var el = doc.createElement("article");
    el.className = "msg is-user";
    el.innerHTML =
      '<div class="msg-avatar" aria-hidden="true"></div>' +
      '<div class="msg-body"><div class="msg-name">You</div>' +
      '<div class="msg-content"></div></div>';
    el.querySelector(".msg-avatar").textContent = (CB.firstName(profile)[0] || "Y").toUpperCase();
    el.querySelector(".msg-content").textContent = text;
    messages.appendChild(el);
    return el;
  }

  function addAiMessage() {
    var node = template.content.cloneNode(true);
    node.querySelector(".msg").classList.add("is-ai");
    messages.appendChild(node);
    return messages.lastElementChild;
  }

  function paintMessages(conversation) {
    messages.innerHTML = "";
    conversation.messages.forEach(function (m) {
      if (m.role === "user") {
        addUserMessage(m.text);
        return;
      }
      var article = addAiMessage();
      article.dataset.reply = m.text;
      article.querySelector(".msg-content").innerHTML = renderMarkdown(m.text);
      var actions = article.querySelector(".msg-actions");
      actions.style.opacity = "";
      actions.style.pointerEvents = "";
    });
    renderEmptyState();
    chat.scrollTop = chat.scrollHeight;
  }

  function openChat(id) {
    if (state.sending || state.opening) return;
    state.currentId = id;
    var target = currentChat();
    if (!target) return;
    paintMessages(target);
    renderSidebar();
    showView("chat");
    if (window.innerWidth > 860) input.focus();
  }

  /* ======================================================================
     7. SENDING
     ====================================================================== */

  function setSendMode(mode) {
    if (mode === "busy") {
      sendBtn.innerHTML = STOP_ICON;
      sendBtn.classList.add("is-stop");
      sendBtn.setAttribute("aria-label", "Stop generating");
      sendBtn.removeAttribute("disabled");
      sendBtn.dataset.mode = "stop";
    } else {
      sendBtn.innerHTML = SEND_ICON;
      sendBtn.classList.remove("is-stop");
      sendBtn.setAttribute("aria-label", "Send message");
      sendBtn.dataset.mode = "send";
      sendBtn.disabled = input.value.trim() === "";
    }
  }

  function autogrow() {
    input.style.height = "auto";
    input.style.height = Math.min(input.scrollHeight, 200) + "px";
  }

  function showNotice(title, text) {
    noticeTitle.textContent = title;
    noticeText.textContent = text;
    notice.hidden = false;
  }

  function hideNotice() {
    notice.hidden = true;
  }

  function failMessage(article, message) {
    var content = article.querySelector(".msg-content");
    content.innerHTML = "";
    var box = doc.createElement("div");
    box.className = "reply-error";
    box.innerHTML = '<svg class="icon" viewBox="0 0 24 24"><use href="#i-alert"></use></svg>';
    var span = doc.createElement("span");
    span.textContent = message;
    box.appendChild(span);
    content.appendChild(box);
    var actions = article.querySelector(".msg-actions");
    actions.style.opacity = "";
    actions.style.pointerEvents = "";
  }

  /* Streams a reply into `article`, then calls onDone(finalText, errorText).
     `wire` is the message array actually sent upstream — deliberately separate
     from what gets stored, so Kivd's opening turn is never saved as
     something the user said. */
  function streamInto(article, wire, onDone) {
    var contentEl = article.querySelector(".msg-content");
    var actions = article.querySelector(".msg-actions");

    actions.style.opacity = "0";
    actions.style.pointerEvents = "none";
    contentEl.innerHTML =
      '<div class="typing" aria-label="Kivd is thinking"><i></i><i></i><i></i></div>';

    var full = "";
    var renderQueued = false;
    var streamError = null;

    function paint() {
      renderQueued = false;
      contentEl.innerHTML = renderMarkdown(full) + '<span class="caret" aria-hidden="true"></span>';
      scrollToBottom(false);
    }

    function schedulePaint() {
      if (renderQueued) return;
      renderQueued = true;
      window.requestAnimationFrame(paint);
    }

    function settle(errorText) {
      state.sending = false;
      state.opening = false;
      state.controller = null;
      setSendMode("idle");

      if (errorText) {
        failMessage(article, errorText);
        onDone(null, errorText);
        return;
      }

      if (!full.trim()) {
        var emptyMsg =
          "Kivd returned an empty reply. Try again, or check the model name in config.json.";
        failMessage(article, emptyMsg);
        onDone(null, emptyMsg);
        return;
      }

      contentEl.innerHTML = renderMarkdown(full);
      actions.style.opacity = "";
      actions.style.pointerEvents = "";
      article.dataset.reply = full;
      onDone(full, null);
    }

    var controller = typeof AbortController !== "undefined" ? new AbortController() : null;
    state.controller = controller;

    // Goes to the local server, which adds the API key server-side.
    // The key must never appear in this file — this file is served to the browser.
    fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ system: CB.buildSystem(profile), messages: wire }),
      signal: controller ? controller.signal : undefined,
    })

      .then(function (res) {
        if (!res.ok) {
          return res.json().then(
            function (data) {
              throw new Error(data.error || "Server returned HTTP " + res.status);
            },
            function () {
              throw new Error("Server returned HTTP " + res.status);
            }
          );
        }
        if (!res.body || !res.body.getReader) {
          throw new Error("This browser can't read streamed replies. Try Chrome, Edge or Firefox.");
        }

        var reader = res.body.getReader();
        var decoder = new TextDecoder();
        var buffer = "";

        function handleLine(line) {
          var trimmed = line.trim();
          if (!trimmed || trimmed.indexOf("data:") !== 0) return;

          var payload;
          try {
            payload = JSON.parse(trimmed.slice(5).trim());
          } catch (e) {
            return;
          }

          if (payload.type === "delta") {
            full += payload.text;
            schedulePaint();
          } else if (payload.type === "error") {
            streamError = payload.message;
          }
        }

        function pump() {
          return reader.read().then(function (result) {
            if (result.done) {
              if (buffer) handleLine(buffer);
              settle(streamError);
              return;
            }
            buffer += decoder.decode(result.value, { stream: true });
            var lines = buffer.split("\n");
            buffer = lines.pop();
            for (var i = 0; i < lines.length; i++) handleLine(lines[i]);
            return pump();
          });
        }

        return pump();
      })
      .catch(function (err) {
        if (err && err.name === "AbortError") {
          if (full.trim()) {
            settle(null);
          } else {
            contentEl.innerHTML = "";
            article.remove();
            state.sending = false;
            state.opening = false;
            state.controller = null;
            setSendMode("idle");
            onDone(null, "stopped");
          }
          return;
        }
        settle(
          (err && err.message) || "Could not reach the local server. Is start.cmd still running?"
        );
      });
  }

  /* Asks the model for a reply to the current conversation. Split out of send()
     so the emergency panel can hand control back here once someone is safe. */
  function requestReply() {
    var conversation = currentChat();
    if (!conversation) return;

    var article = addAiMessage();
    state.sending = true;
    setSendMode("busy");
    scrollToBottom(true);

    var wire = conversation.messages.map(function (m) {
      // Every message is stored with its timestamp. Older ones carry their date
      // into the prompt, so Kivd can tell "yesterday" from "last week" instead
      // of treating everything as if it happened now.
      var stamp = "";
      if (m.at && dayKey(m.at) !== todayKey()) stamp = "[" + dayLabel(dayKey(m.at)) + "] ";
      return { role: m.role, content: stamp + m.text };
    });

    streamInto(article, wire, function (reply) {
      if (!reply) return;
      conversation.messages.push({ role: "assistant", text: reply, at: Date.now() });
      persist();
      renderSidebar();
      scrollToBottom(false);
    });
  }

  function send(text) {
    if (state.sending || state.opening) return;

    var value = (text !== undefined ? text : input.value).trim();
    if (!value) return;

    if (!state.connected) {
      showNotice(
        "Kivd isn't connected",
        "Replies will fail until the server is running with an API key. Start it with start.cmd."
      );
    }

    // Checked before anything else, and without asking the model. If someone is
    // in danger, the options have to appear immediately.
    var risk = CB.detectRisk(value);

    var conversation = ensureChat();
    conversation.messages.push({ role: "user", text: value, at: Date.now() });
    if (!conversation.title) conversation.title = titleFrom(value);
    persist();

    empty.classList.add("is-hidden");
    addUserMessage(value);
    input.value = "";
    autogrow();
    scrollToBottom(true);

    if (risk === "high") {
      setSendMode("idle");
      showCrisis();
      return;
    }

    // Medium risk gets a written, warm reply rather than a model guess — this is
    // the moment where a generic answer does real damage.
    if (risk === "medium") {
      setSendMode("idle");
      addComfortMessage();
      return;
    }

    requestReply();
  }

  /* Kivd opens the conversation the first time. This is a real model call —
     the fallback only fires if the model cannot be reached, so the very first
     screen is never silent. */
  function runOpening() {
    if (profile.greeted) return;

    var conversation = ensureChat();
    if (!conversation.title) conversation.title = "First conversation";
    persist();
    renderSidebar();

    var article = addAiMessage();
    state.opening = true;
    setSendMode("busy");

    var wire = [{ role: "user", content: CB.openingInstruction }];

    streamInto(article, wire, function (reply) {
      var text = reply || CB.openingFallback(profile);

      if (!reply) {
        // Model unreachable: drop in the scripted hello so Kivd still speaks.
        article.querySelector(".msg-content").innerHTML = renderMarkdown(text);
        var actions = article.querySelector(".msg-actions");
        actions.style.opacity = "";
        actions.style.pointerEvents = "";
        article.dataset.reply = text;
      }

      conversation.messages.push({ role: "assistant", text: text, at: Date.now() });
      profile.greeted = true;
      CB.saveProfile(profile);
      persist();
      renderSidebar();
      scrollToBottom(true);
      if (window.innerWidth > 860) input.focus();
    });
  }

  /* Every NEW chat opens with the three intake questions: goal, plan, and
     whether the old habits still fit. Real model call, scripted fallback. */
  function runIntake() {
    var conversation = ensureChat();
    if (!conversation.title) conversation.title = "Setting a goal";
    persist();
    renderSidebar();

    var article = addAiMessage();
    state.opening = true;
    setSendMode("busy");

    var wire = [{ role: "user", content: CB.intakeInstruction }];

    streamInto(article, wire, function (reply) {
      var text = reply || CB.intakeFallback(profile);

      if (!reply) {
        article.querySelector(".msg-content").innerHTML = renderMarkdown(text);
        var actions = article.querySelector(".msg-actions");
        actions.style.opacity = "";
        actions.style.pointerEvents = "";
        article.dataset.reply = text;
      }

      conversation.messages.push({ role: "assistant", text: text, at: Date.now() });
      persist();
      renderSidebar();
      scrollToBottom(true);
      if (window.innerWidth > 860) input.focus();
    });
  }

  /* ======================================================================
     8. CONNECTION
     ====================================================================== */

  function checkHealth() {
    if (location.protocol === "file:") {
      modelLabel.textContent = "Not connected";
      modelDot.classList.add("is-off");
      showNotice(
        "Opened as a file",
        "Start the server by double-clicking start.cmd, then open http://localhost:8787/ instead."
      );
      return;
    }

    fetch("/api/health")
      .then(function (res) {
        var type = res.headers.get("content-type") || "";
        if (type.indexOf("application/json") === -1) throw new Error("not-cb");
        return res.json();
      })
      .then(function (data) {
        state.connected = Boolean(data.hasKey);
        modelLabel.textContent = data.model || "Connected";
        modelDot.classList.toggle("is-off", !data.hasKey);

        if (!data.hasKey) {
          showNotice(
            "No API key configured",
            "The server is running but config.json has no apiKey. Add one and restart it."
          );
        } else {
          hideNotice();
        }
      })
      .catch(function (err) {
        state.connected = false;
        modelLabel.textContent = "Not connected";
        modelDot.classList.add("is-off");
        showNotice(
          err && err.message === "not-cb" ? "Wrong web server" : "Server not reachable",
          "Kivd needs the local server. Double-click start.cmd in the chainbreaker folder, then open http://localhost:8787/"
        );
      });
  }

  /* ======================================================================
     9. UI WIRING
     ====================================================================== */

  function renderProfile() {
    var name = profile.name.trim();
    doc.getElementById("userName").textContent = name || "You";
    doc.getElementById("userAvatar").textContent = (CB.firstName(profile)[0] || "Y").toUpperCase();

    var STATUS_LABEL = {
      student: "Student",
      working: "Working",
      other: "Other",
    };
    var meta = [
      profile.age ? profile.age + " years" : "",
      STATUS_LABEL[profile.status] || "",
    ]
      .filter(Boolean)
      .join(" · ");
    doc.getElementById("userMeta").textContent = meta || "Tap to edit your setup";
  }

  function openSidebar() {
    doc.getElementById("sidebar").classList.add("is-open");
    doc.getElementById("scrim").hidden = false;
  }

  function closeSidebar() {
    doc.getElementById("sidebar").classList.remove("is-open");
    doc.getElementById("scrim").hidden = true;
  }

  function newChat() {
    if (state.sending || state.opening) return;
    state.currentId = null;
    clearMessages();
    renderSidebar();
    showView("chat");
    input.value = "";
    autogrow();
    setSendMode("idle");

    // A fresh chat opens with Kivd asking about the goal and the plan.
    if (profile.greeted) runIntake();
    else input.focus();
  }

  form.addEventListener("submit", function (event) {
    event.preventDefault();
    if (sendBtn.dataset.mode === "stop") {
      if (state.controller) state.controller.abort();
      return;
    }
    send();
  });

  input.addEventListener("input", function () {
    autogrow();
    if (!state.sending && !state.opening) sendBtn.disabled = input.value.trim() === "";
  });

  input.addEventListener("keydown", function (event) {
    if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      if (!state.sending && !state.opening) send();
    }
  });

  doc.getElementById("newChat").addEventListener("click", newChat);
  doc.getElementById("newChatTop").addEventListener("click", newChat);
  doc.getElementById("sidebarOpen").addEventListener("click", openSidebar);
  doc.getElementById("sidebarClose").addEventListener("click", closeSidebar);
  doc.getElementById("scrim").addEventListener("click", closeSidebar);
  doc.getElementById("userChip").addEventListener("click", function () {
    window.location.href = "index.html";
  });

  doc.getElementById("themeBtn").addEventListener("click", function () {
    var next = root.getAttribute("data-theme") === "dark" ? "light" : "dark";
    root.setAttribute("data-theme", next);
    try {
      localStorage.setItem("chainbreaker-theme", next);
    } catch (e) {}
  });

  function flashComposerHint(message) {
    var hint = doc.querySelector(".composer-hint");
    if (!hint) return;
    if (!hint.dataset.original) hint.dataset.original = hint.textContent;
    hint.textContent = message;
    window.clearTimeout(hint._timer);
    hint._timer = window.setTimeout(function () {
      hint.textContent = hint.dataset.original;
    }, 2400);
  }

  doc.getElementById("attachBtn").addEventListener("click", function () {
    flashComposerHint("Attachments aren't implemented yet");
  });

  doc.getElementById("micBtn").addEventListener("click", function () {
    flashComposerHint("Voice input isn't implemented yet");
  });

  var viewLinks = doc.querySelectorAll("[data-view]");
  for (var v = 0; v < viewLinks.length; v++) {
    (function (link) {
      link.addEventListener("click", function () {
        showView(link.getAttribute("data-view"));
      });
    })(viewLinks[v]);
  }

  searchInput.addEventListener("input", renderSidebar);

  convos.addEventListener("click", function (event) {
    var row = event.target.closest(".convo");
    if (!row) return;

    if (event.target.closest("[data-delete]")) {
      var id = row.dataset.id;
      state.chats = state.chats.filter(function (c) {
        return c.id !== id;
      });
      if (state.currentId === id) {
        state.currentId = null;
        clearMessages();
      }
      persist();
      renderSidebar();
      if (state.view === "tracking") renderTracking();
      return;
    }

    openChat(row.dataset.id);
  });

  convos.addEventListener("keydown", function (event) {
    var row = event.target.closest(".convo");
    if (!row) return;
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      openChat(row.dataset.id);
    }
  });

  suggestions.addEventListener("click", function (event) {
    var card = event.target.closest("[data-prompt]");
    if (!card) return;
    input.value = card.dataset.prompt;
    autogrow();
    send();
  });

  /* ------------------------------------------------- message-level actions */

  function copyText(text, button) {
    function done() {
      if (!button) return;
      var label = button.querySelector("span");
      var original = label ? label.textContent : null;
      button.classList.add("is-done");
      if (label) label.textContent = "Copied";
      window.setTimeout(function () {
        button.classList.remove("is-done");
        if (label && original) label.textContent = original;
      }, 1400);
    }

    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done, done);
      return;
    }

    var ta = doc.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    doc.body.appendChild(ta);
    ta.select();
    try {
      doc.execCommand("copy");
    } catch (e) {}
    doc.body.removeChild(ta);
    done();
  }

  messages.addEventListener("click", function (event) {
    var copyBtn = event.target.closest("[data-code-copy]");
    if (copyBtn) {
      var code = copyBtn.closest(".code-block").querySelector("pre code");
      copyText(code.textContent, copyBtn);
      return;
    }

    var action = event.target.closest("[data-act]");
    if (!action) return;

    var article = action.closest(".msg");
    var kind = action.dataset.act;

    if (kind === "copy") {
      copyText(article.querySelector(".msg-content").textContent.trim(), null);
      action.classList.add("is-on");
      window.setTimeout(function () {
        action.classList.remove("is-on");
      }, 1200);
      return;
    }

    if (kind === "good" || kind === "bad") {
      var peers = article.querySelectorAll('[data-act="good"], [data-act="bad"]');
      for (var i = 0; i < peers.length; i++) {
        if (peers[i] !== action) peers[i].classList.remove("is-on");
      }
      action.classList.toggle("is-on");
      return;
    }

    if (kind === "retry") {
      if (state.sending || state.opening) return;
      var conversation = currentChat();
      if (!conversation) return;

      while (
        conversation.messages.length &&
        conversation.messages[conversation.messages.length - 1].role === "assistant"
      ) {
        conversation.messages.pop();
      }
      var lastUser = conversation.messages[conversation.messages.length - 1];
      if (!lastUser) return;
      var text = lastUser.text;
      conversation.messages.pop();
      persist();
      paintMessages(conversation);
      send(text);
    }
  });

  doc.addEventListener("keydown", function (event) {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
      event.preventDefault();
      newChat();
    }
    if (event.key === "Escape") closeSidebar();
  });

  /* ======================================================================
     9b. TIME FREEZE
     --------------------------------------------------------------------
     Two countdowns you start on purpose: 2 minutes for an urge to pass, and
     35 minutes for a focused session. They keep running while you move around
     the app, and the one that's running shows in the sidebar.
     ====================================================================== */

  var RING_LENGTH = 2 * Math.PI * 54; // matches r="54" in the markup
  var TIMERS = [
    { id: "urge", total: 120, left: 120, running: false, handle: null },
    { id: "session", total: 2100, left: 2100, running: false, handle: null },
  ];

  function formatClock(seconds) {
    var s = Math.max(0, Math.round(seconds));
    var m = Math.floor(s / 60);
    var r = s % 60;
    return m + ":" + (r < 10 ? "0" + r : r);
  }

  function paintFreezeBadge() {
    var badge = doc.getElementById("freezeBadge");
    if (!badge) return;

    var soonest = null;
    for (var i = 0; i < TIMERS.length; i++) {
      var t = TIMERS[i];
      if (t.running && t.left > 0 && (!soonest || t.left < soonest.left)) soonest = t;
    }

    if (soonest) {
      badge.textContent = formatClock(soonest.left);
      badge.hidden = false;
    } else {
      badge.hidden = true;
    }
  }

  function paintTimer(t) {
    var card = doc.querySelector('[data-timer="' + t.id + '"]');

    if (card) {
      var clock = card.querySelector("[data-clock]");
      var ring = card.querySelector("[data-ring]");
      var state = card.querySelector("[data-state]");
      var startBtn = card.querySelector("[data-start]");

      clock.textContent = formatClock(t.left);
      ring.style.strokeDasharray = String(RING_LENGTH);
      ring.style.strokeDashoffset = String(RING_LENGTH * (1 - t.left / t.total));

      card.classList.toggle("is-running", t.running);
      card.classList.toggle("is-done", t.left <= 0);

      if (t.left <= 0) {
        state.textContent =
          t.id === "urge" ? "It passed. That's the whole point." : "Session done. Nice work.";
      } else if (t.running) {
        state.textContent = "Counting down…";
      } else if (t.left < t.total) {
        state.textContent = "Paused";
      } else {
        state.textContent = t.id === "urge" ? "For an urge to pass" : "For a focused session";
      }

      if (startBtn) {
        startBtn.textContent = t.running
          ? "Pause"
          : t.left <= 0
            ? "Again"
            : t.left < t.total
              ? "Resume"
              : "Start";
      }
    }

    paintFreezeBadge();
  }

  /* --- sound -------------------------------------------------------------
     Generated with the Web Audio API, so there are no audio files to ship.
     Browsers only allow sound after a gesture — starting a timer is one. */
  var audio = (function () {
    var ctx = null;

    function context() {
      var AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return null;
      if (!ctx) ctx = new AC();
      if (ctx.state === "suspended" && ctx.resume) ctx.resume();
      return ctx;
    }

    function tone(freq, at, dur, peak) {
      var c = context();
      if (!c) return;
      var osc = c.createOscillator();
      var gain = c.createGain();
      osc.type = "sine";
      osc.frequency.value = freq;
      var t0 = c.currentTime + at;
      gain.gain.setValueAtTime(0.0001, t0);
      gain.gain.linearRampToValueAtTime(peak, t0 + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
      osc.connect(gain);
      gain.connect(c.destination);
      osc.start(t0);
      osc.stop(t0 + dur + 0.05);
    }

    return {
      unlock: function () {
        context();
      },
      /* Friendly rising chime — a timer finished. */
      chime: function () {
        tone(523.25, 0, 0.9, 0.22);
        tone(659.25, 0.16, 0.9, 0.22);
        tone(783.99, 0.32, 1.3, 0.22);
      },
      /* Urgent repeated beeps — you left the app mid-urge. */
      alarm: function () {
        for (var i = 0; i < 8; i++) tone(880, i * 0.26, 0.15, 0.3);
      },
    };
  })();

  /* --- breathing overlay -------------------------------------------------- */

  var breathe = doc.getElementById("breathe");
  var breatheStep = doc.getElementById("breatheStep");
  var breatheClock = doc.getElementById("breatheClock");
  var breatheHint = doc.getElementById("breatheHint");
  var breatheExit = doc.getElementById("breatheExit");

  var BREATHE_STEPS = [
    { text: "Breathe in…", ms: 4000 },
    { text: "Hold", ms: 2000 },
    { text: "Breathe out…", ms: 4000 },
    { text: "Rest", ms: 2000 },
  ];
  var breatheIndex = 0;
  var breatheHandle = null;

  function urgeTimer() {
    for (var i = 0; i < TIMERS.length; i++) {
      if (TIMERS[i].id === "urge") return TIMERS[i];
    }
    return null;
  }

  /* The overlay serves two things: the 2-minute urge timer, and a 2-minute
     meditation offered when someone sounds like giving up. */
  var breatheMode = "urge";
  var MEDITATE_SECONDS = 120;
  var meditateLeft = 0;
  var meditateHandle = null;

  function paintBreatheClock(t) {
    if (breatheMode !== "urge") return;
    if (breatheClock && t && t.id === "urge") breatheClock.textContent = formatClock(t.left);
  }

  function runBreatheCycle() {
    window.clearTimeout(breatheHandle);
    if (!breatheStep) return;

    var step = BREATHE_STEPS[breatheIndex % BREATHE_STEPS.length];
    breatheStep.textContent = step.text;
    breatheIndex += 1;

    breatheHandle = window.setTimeout(runBreatheCycle, step.ms);
  }

  function stopMeditation() {
    window.clearInterval(meditateHandle);
    meditateHandle = null;
    meditateLeft = 0;
  }

  function showBreathe(mode) {
    if (!breathe) return;
    breatheMode = mode === "meditate" ? "meditate" : "urge";
    breatheIndex = 0;
    breathe.classList.remove("is-done");
    if (breatheStep) breatheStep.textContent = "Breathe in…";

    if (breatheMode === "meditate") {
      if (breatheHint) {
        breatheHint.textContent =
          "Nothing to fix and nothing to decide for two minutes. Just follow the circle.";
      }
      if (breatheClock) breatheClock.textContent = formatClock(MEDITATE_SECONDS);
      if (breatheExit) breatheExit.textContent = "Finish";
    } else {
      if (breatheHint) {
        breatheHint.textContent =
          "Stay with it. The urge peaks, then it drops — you don't have to do anything.";
      }
      if (breatheExit) breatheExit.textContent = "I'm okay now";
    }

    breathe.hidden = false;
    runBreatheCycle();
  }

  function hideBreathe() {
    window.clearTimeout(breatheHandle);
    breatheHandle = null;
    stopMeditation();
    if (breathe) breathe.hidden = true;
    if (doc.title.indexOf("Come back") !== -1) doc.title = "ChainBreaker";
  }

  function finishBreathe() {
    window.clearTimeout(breatheHandle);
    breatheHandle = null;
    stopMeditation();
    if (!breathe) return;
    breathe.classList.add("is-done");

    if (breatheMode === "meditate") {
      if (breatheStep) breatheStep.textContent = "Two minutes, done.";
      if (breatheHint) {
        breatheHint.textContent =
          "You stayed. That is the whole skill — the feeling came, and you didn't have to act on it.";
      }
    } else {
      if (breatheStep) breatheStep.textContent = "It passed.";
      if (breatheHint) {
        breatheHint.textContent =
          "That was the whole urge. Nothing bad happened, and you didn't have to fight it.";
      }
    }

    if (breatheExit) breatheExit.textContent = "Back to Kivd";
    doc.title = "ChainBreaker";
  }

  function startMeditation() {
    audio.unlock();
    stopMeditation();
    meditateLeft = MEDITATE_SECONDS;
    showBreathe("meditate");

    meditateHandle = window.setInterval(function () {
      meditateLeft -= 1;
      if (breatheClock) breatheClock.textContent = formatClock(Math.max(0, meditateLeft));
      if (meditateLeft <= 0) {
        stopMeditation();
        audio.chime();
        finishBreathe();
      }
    }, 1000);
  }

  /* Given when someone sounds like giving up. Comfort first, then ask what they
     are going through, then send them to the meditation. Deliberately written,
     not generated — a generic reply here does real damage. */
  var COMFORT_LINES = [
    "{Name}, thank you for saying that out loud. That takes something.\n\n" +
      "Whatever you're going through, you don't have to explain it neatly — just start " +
      "anywhere, and I'll listen.\n\n" +
      "But do one thing for me first: two minutes. Not to fix it, just to breathe. Then tell " +
      "me everything.",
    "I hear you, {Name}. That sounds heavy, and you don't have to carry it well.\n\n" +
      "Tell me what you're actually going through — there's no wrong way to say it, and " +
      "nothing you say will be too much for me.\n\n" +
      "Before that, though: give me two minutes of just breathing. It makes the next part " +
      "easier.",
    "{Name}, I'm glad you told me instead of holding it alone.\n\n" +
      "What you're feeling is real, and it makes sense that it's wearing you down. Tell me " +
      "what it's like day to day — heavy, numb, or just flat.\n\n" +
      "First, two minutes. Breathe with me, then we talk properly.",
  ];
  var comfortIndex = 0;
  var giveUpCard = null;

  function addComfortMessage() {
    var conversation = currentChat();
    if (!conversation) return;

    var first = CB.firstName(profile) || "Hey";
    var text = COMFORT_LINES[comfortIndex % COMFORT_LINES.length].replace(/\{Name\}/g, first);
    comfortIndex += 1;

    var article = addAiMessage();
    article.dataset.reply = text;
    article.querySelector(".msg-content").innerHTML = renderMarkdown(text);
    var actions = article.querySelector(".msg-actions");
    actions.style.opacity = "";
    actions.style.pointerEvents = "";

    conversation.messages.push({ role: "assistant", text: text, at: Date.now() });
    persist();
    renderSidebar();
    scrollToBottom(true);
    addGiveUpCard();
  }

  function addGiveUpCard() {
    if (giveUpCard && giveUpCard.parentNode) giveUpCard.parentNode.removeChild(giveUpCard);

    giveUpCard = doc.createElement("div");
    giveUpCard.className = "giveup";
    giveUpCard.innerHTML =
      "<p>Two minutes, breathing with me. Nothing to fix, nothing to decide — just follow " +
      "the circle.</p>" +
      '<button class="btn btn-primary" type="button" data-meditate>' +
      '<svg class="icon" viewBox="0 0 24 24"><use href="#i-freeze"></use></svg>' +
      "Start a 2-minute meditation</button>";
    messages.appendChild(giveUpCard);
    scrollToBottom(false);
  }

  if (breatheExit) {
    breatheExit.addEventListener("click", function () {
      var wasMeditation = breatheMode === "meditate";
      hideBreathe();
      if (!wasMeditation) resetTimer(urgeTimer());
    });
  }

  /* ------------------------------------------------------------ emergency --
     Raised by the app itself, without the model, the moment a message suggests
     intent to self-harm. Everything on it is one tap. */

  var crisis = doc.getElementById("crisis");
  var crisisTip = doc.getElementById("crisisTip");
  var crisisFamily = doc.getElementById("crisisFamily");
  var crisisBreathe = doc.getElementById("crisisBreathe");
  var crisisSafe = doc.getElementById("crisisSafe");
  var crisisTherapist = doc.getElementById("crisisTherapist");

  function showCrisis() {
    if (!crisis) return;
    if (crisisTip) crisisTip.hidden = true;
    crisis.hidden = false;
    if (crisis.scrollTop) crisis.scrollTop = 0;
    audio.unlock();
    // A soft chord, not an alarm. This moment needs steady, not panic.
    audio.chime();
  }

  function hideCrisis() {
    if (crisis) crisis.hidden = true;
  }

  if (crisisFamily) {
    crisisFamily.addEventListener("click", function () {
      if (crisisTip) crisisTip.hidden = false;
    });
  }

  if (crisisBreathe) {
    crisisBreathe.addEventListener("click", function () {
      hideCrisis();
      startMeditation();
    });
  }

  if (crisisSafe) {
    crisisSafe.addEventListener("click", function () {
      hideCrisis();
      // They've said they're safe, so hand the conversation back to Kivd.
      requestReply();
    });
  }

  /* The meditation button on the "giving up" card. */
  messages.addEventListener("click", function (event) {
    if (event.target.closest("[data-meditate]")) startMeditation();
  });

  /* ---------------------------------------------------- therapist / pro ---
     Entry points only. Requests are saved on this device and never sent,
     because there is no matching service yet — and the copy says so. */

  /* -------------------------------------------------------- safe space ---
     The user's side only. Signing in creates a private room on this device.
     There is no therapist backend yet, and the copy says so plainly rather
     than implying someone is reading it. */

  var recoveryStatus = doc.getElementById("recoveryStatus");
  var recoveryIntro = doc.getElementById("recoveryIntro");
  var recoveryChat = doc.getElementById("recoveryChat");
  var recoverySignIn = doc.getElementById("recoverySignIn");
  var recName = doc.getElementById("recName");
  var recContact = doc.getElementById("recContact");
  var recContactError = doc.getElementById("recContactError");
  var personThread = doc.getElementById("personThread");
  var personForm = doc.getElementById("personForm");
  var personInput = doc.getElementById("personInput");
  var personState = doc.getElementById("personState");
  var requestForm = doc.getElementById("requestForm");
  var requestWhat = doc.getElementById("reqWhat");
  var requestWhatError = doc.getElementById("reqWhatError");

  function renderPersonThread() {
    if (!personThread) return;

    var rec = CB.loadRecovery();
    personThread.innerHTML = "";

    if (!rec.messages.length) {
      var empty = doc.createElement("p");
      empty.className = "person-empty";
      empty.textContent =
        "This is your private thread. Once a therapist is assigned, what you write here " +
        "reaches them. For now it stays on this device, so nothing you type is lost and " +
        "nobody sees it before you choose to send it.";
      personThread.appendChild(empty);
      return;
    }

    for (var i = 0; i < rec.messages.length; i++) {
      var m = rec.messages[i];
      var isUser = m.role === "user";
      var article = doc.createElement("article");
      article.className = "msg " + (isUser ? "is-user" : "is-ai");
      article.innerHTML =
        '<div class="msg-avatar" aria-hidden="true"></div>' +
        '<div class="msg-body"><div class="msg-name"></div><div class="msg-content"></div></div>';
      article.querySelector(".msg-avatar").textContent = isUser
        ? (CB.firstName(profile)[0] || "Y").toUpperCase()
        : "T";
      article.querySelector(".msg-name").textContent = isUser ? "You" : "Your therapist";
      article.querySelector(".msg-content").textContent = m.text;
      personThread.appendChild(article);
    }

    personThread.scrollTop = personThread.scrollHeight;
  }

  function renderRecovery() {
    var rec = CB.loadRecovery();
    var requests = CB.loadRequests();

    if (recoveryIntro) recoveryIntro.hidden = rec.signedIn;
    if (recoveryChat) recoveryChat.hidden = !rec.signedIn;

    var session = CB.loadSession();
    if (recoveryEnd) recoveryEnd.hidden = !session.active;
    // Signing out mid-session would strand the clinician, who cannot leave on
    // their side. So the client ends the session first, consciously.
    if (recoverySignOut) {
      recoverySignOut.disabled = session.active;
      recoverySignOut.title = session.active
        ? "End the session before signing out — your therapist cannot leave until you do."
        : "";
    }

    if (recName && !recName.value) recName.value = rec.name || profile.name || "";
    if (recContact && !recContact.value) recContact.value = rec.contact || "";
    if (personState) {
      if (session.active) {
        personState.textContent = "Session open · your therapist can join";
      } else if (requests.length) {
        personState.textContent = "Request received · not assigned yet";
      } else {
        personState.textContent = "Not assigned yet";
      }
    }

    if (recoveryStatus) {
      recoveryStatus.innerHTML = "";

      var rows = [
        ["Status", rec.signedIn ? "Signed in" : "Not signed in"],
        ["Session", session.active ? "Open" : "Closed"],
        ["Your therapist", "Not assigned yet"],
        ["Your anonymous code", CB.anonId(profile)],
        ["Requests you've made", requests.length ? String(requests.length) : "None"],
      ];

      for (var i = 0; i < rows.length; i++) {
        var row = doc.createElement("div");
        var key = doc.createElement("span");
        key.className = "k";
        key.textContent = rows[i][0];
        var value = doc.createElement("span");
        value.className = "v";
        value.textContent = rows[i][1];
        row.appendChild(key);
        row.appendChild(value);
        recoveryStatus.appendChild(row);
      }
    }

    if (rec.signedIn) renderPersonThread();
  }

  /* Signing in creates the room. Nothing leaves the device. */
  if (recoverySignIn) {
    recoverySignIn.addEventListener("submit", function (event) {
      event.preventDefault();

      var contact = (recContact && recContact.value ? recContact.value : "").trim();
      if (!contact) {
        if (recContactError) recContactError.hidden = false;
        if (recContact) recContact.classList.add("is-invalid");
        if (recContact) recContact.focus();
        return;
      }
      if (recContactError) recContactError.hidden = true;
      if (recContact) recContact.classList.remove("is-invalid");

      var rec = CB.loadRecovery();
      rec.signedIn = true;
      rec.contact = contact;
      rec.name = ((recName && recName.value) || profile.name || "").trim();
      if (!rec.since) rec.since = Date.now();
      CB.saveRecovery(rec);

      // Opening the room opens the session. Only the client can close it, which
      // is what keeps the clinician locked in until this side ends it.
      var session = CB.loadSession();
      if (!session.active) {
        session.active = true;
        session.startedAt = Date.now();
        session.endedAt = 0;
        CB.saveSession(session);
      }

      renderRecovery();
      if (personInput) personInput.focus();
    });
  }

  var recoveryEnd = doc.getElementById("recoveryEnd");
  if (recoveryEnd) {
    recoveryEnd.addEventListener("click", function () {
      var session = CB.loadSession();
      session.active = false;
      session.endedAt = Date.now();
      CB.saveSession(session);
      renderRecovery();
    });
  }

  var recoverySignOut = doc.getElementById("recoverySignOut");
  if (recoverySignOut) {
    recoverySignOut.addEventListener("click", function () {
      var rec = CB.loadRecovery();
      rec.signedIn = false;
      CB.saveRecovery(rec); // messages are kept, only the session ends
      renderRecovery();
    });
  }

  if (personForm) {
    personForm.addEventListener("submit", function (event) {
      event.preventDefault();

      var value = (personInput && personInput.value ? personInput.value : "").trim();
      if (!value) return;

      var rec = CB.loadRecovery();
      rec.messages.push({ role: "user", text: value, at: Date.now() });
      CB.saveRecovery(rec);

      personInput.value = "";
      personInput.style.height = "auto";
      renderPersonThread();
    });
  }

  var requestToggle = doc.getElementById("requestToggle");
  if (requestToggle && requestForm) {
    requestToggle.addEventListener("click", function () {
      requestForm.hidden = !requestForm.hidden;
      if (!requestForm.hidden && requestWhat) requestWhat.focus();
    });
  }

  var requestCancelBtn = doc.getElementById("requestCancel");
  if (requestCancelBtn) {
    requestCancelBtn.addEventListener("click", function () {
      if (requestForm) requestForm.hidden = true;
    });
  }

  if (requestForm) {
    requestForm.addEventListener("submit", function (event) {
      event.preventDefault();

      var what = (requestWhat && requestWhat.value ? requestWhat.value : "").trim();
      var ok = what.length > 0;

      if (requestWhatError) requestWhatError.hidden = ok;
      if (requestWhat) requestWhat.classList.toggle("is-invalid", !ok);
      if (!ok) {
        if (requestWhat) requestWhat.focus();
        return;
      }

      var whenField = doc.getElementById("reqWhen");
      var urgencyField = doc.getElementById("reqUrgency");
      var contactField = doc.getElementById("reqContact");
      var consentField = doc.getElementById("reqConsent");

      CB.addRequest({
        at: Date.now(),
        what: what,
        when: whenField ? whenField.value : "",
        urgency: urgencyField ? urgencyField.value : "",
        contact: contactField ? contactField.value.trim() : "",
        consent: Boolean(consentField && consentField.checked),
      });

      requestForm.reset();
      requestForm.hidden = true;
      renderRecovery();

      // Said plainly, in place — not a banner with a "fix this" link.
      var done = doc.createElement("p");
      done.className = "doc-alert";
      done.textContent =
        "Saved on this device. No therapist has been contacted yet — the matching service " +
        "isn't built. If you are in danger right now, call 14416 or 112.";
      requestForm.parentNode.insertBefore(done, requestForm);
      window.setTimeout(function () {
        if (done.parentNode) done.parentNode.removeChild(done);
      }, 10000);
    });
  }

  if (crisisTherapist) {
    crisisTherapist.addEventListener("click", function () {
      hideCrisis();
      showView("recovery");
    });
  }

  /* Leaving mid-urge — or mid-meditation — is exactly when it wins. So the
     alarm does not stop after one burst: it repeats until they come back. */
  var awayAlarm = null;

  function shouldWatch() {
    var u = urgeTimer();
    return Boolean((u && u.running) || meditateHandle);
  }

  function startAwayAlarm() {
    if (awayAlarm || !shouldWatch()) return;
    audio.alarm();
    doc.title = "🔴 Come back — keep breathing";
    awayAlarm = window.setInterval(function () {
      if (!shouldWatch()) {
        stopAwayAlarm();
        return;
      }
      audio.alarm();
    }, 3000);
  }

  function stopAwayAlarm() {
    if (awayAlarm) {
      window.clearInterval(awayAlarm);
      awayAlarm = null;
    }
    if (doc.title.indexOf("Come back") !== -1) doc.title = "ChainBreaker";
  }

  function checkAway() {
    if (doc.hidden || !doc.hasFocus()) startAwayAlarm();
    else stopAwayAlarm();
  }

  doc.addEventListener("visibilitychange", checkAway);
  window.addEventListener("blur", function () {
    window.setTimeout(checkAway, 60);
  });
  window.addEventListener("focus", stopAwayAlarm);

  /* --- timer control ------------------------------------------------------ */

  function toggleTimer(t) {
    if (t.running) {
      t.running = false;
      window.clearInterval(t.handle);
      t.handle = null;
      if (t.id === "urge") hideBreathe();
    } else {
      audio.unlock();
      if (t.left <= 0) t.left = t.total;
      t.running = true;
      if (t.id === "urge") showBreathe();

      t.handle = window.setInterval(function () {
        t.left -= 1;

        if (t.left <= 0) {
          t.left = 0;
          t.running = false;
          window.clearInterval(t.handle);
          t.handle = null;
          audio.chime();
          if (t.id === "urge") finishBreathe();
        }

        paintTimer(t);
        paintBreatheClock(t);
      }, 1000);
    }

    paintTimer(t);
    paintBreatheClock(t);
  }

  function resetTimer(t) {
    if (!t) return;
    t.running = false;
    window.clearInterval(t.handle);
    t.handle = null;
    t.left = t.total;
    if (t.id === "urge") hideBreathe();
    paintTimer(t);
    paintBreatheClock(t);
  }

  (function wireFreeze() {
    var host = doc.getElementById("viewFreeze");
    if (!host) return;

    for (var i = 0; i < TIMERS.length; i++) paintTimer(TIMERS[i]);

    host.addEventListener("click", function (event) {
      var card = event.target.closest("[data-timer]");
      if (!card) return;

      var isStart = Boolean(event.target.closest("[data-start]"));
      var isReset = Boolean(event.target.closest("[data-reset]"));
      if (!isStart && !isReset) return;

      var id = card.getAttribute("data-timer");
      for (var j = 0; j < TIMERS.length; j++) {
        if (TIMERS[j].id !== id) continue;
        if (isStart) toggleTimer(TIMERS[j]);
        else resetTimer(TIMERS[j]);
      }
    });
  })();

  /* ======================================================================
     10. BOOT
     ====================================================================== */

  renderProfile();
  renderSidebar();
  updateTrackingBadge();
  renderRecovery();

  if (state.chats.length) {
    state.currentId = state.chats[0].id;
    paintMessages(state.chats[0]);
  } else {
    renderEmptyState();
  }

  showView("chat");
  setSendMode("idle");
  autogrow();
  checkHealth();

  // Kivd says hello first — once, on the very first visit.
  if (!profile.greeted) runOpening();

  doc.addEventListener("visibilitychange", function () {
    if (!doc.hidden) checkHealth();
  });
})();
