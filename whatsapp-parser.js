/* ==========================================================================
   ChainBreaker — WhatsApp Chat Parser
   --------------------------------------------------------------------------
   Parses exported WhatsApp chats (.txt and .zip from Android & iOS).
   Handles multi-line messages, Unicode markers (LTR/RTL, narrow spaces),
   system events, media omissions, links, mentions, and generates stats.
   ========================================================================== */

(function (global) {
  "use strict";

  // Unicode markers frequently injected by WhatsApp export tools
  var UNICODE_CLEAN_RE = /[\u200E\u200F\uFEFF]/g;
  var NARROW_SPACE_RE = /[\u202F\u00A0]/g;

  // URL matching regex
  var URL_RE = /https?:\/\/[^\s<>"'`{}|\\^~[\]]+/gi;

  // Mentions matching regex (@Name or @PhoneNumber)
  var MENTION_RE = /@(?:\d{7,15}|[A-Za-z0-9_.-]+)/g;

  // Known media omissions in various WhatsApp language exports
  var MEDIA_OMITTED_RE = /<(?:media|image|video|audio|document|sticker|contact card|location|gif|poll) omitted>|\b(?:image|video|audio|sticker|document|gif)\s+omitted\b|<attached:\s*[^>]+>/i;

  // Known system messages
  var SYSTEM_PATTERNS = [
    /messages and calls are end-to-end encrypted/i,
    /created group/i,
    /changed the subject to/i,
    /changed the group (icon|description|settings)/i,
    /added\b/i,
    /removed\b/i,
    /left\b/i,
    /joined using this group's invite link/i,
    /security code changed/i,
    /changed their phone number/i,
    /started a call/i,
    /missed (voice|video) call/i,
    /disappearing messages/i,
    /turned (on|off) disappearing messages/i,
  ];

  // Message deleted patterns
  var DELETED_RE = /\b(?:this message was deleted|you deleted this message)\b/i;

  // Question indicators
  var QUESTION_WORDS = /\b(?:who|what|when|where|why|how|which|whose|whom|can|could|would|should|will|is|are|was|were|do|does|did|have|has|had|anyone|anybody)\b/i;

  /* -------------------------------------------------------------------------
     WhatsApp timestamp patterns
     -------------------------------------------------------------------------
     Format 1: [DD/MM/YY, H:MM:SS AM/PM] Sender: Message   (iOS)
     Format 2: [DD/MM/YYYY, HH:MM:SS] Sender: Message     (iOS 24h)
     Format 3: DD/MM/YY, H:MM AM/PM - Sender: Message     (Android)
     Format 4: DD/MM/YYYY, HH:MM - Sender: Message        (Android 24h)
     Format 5: MM/DD/YY, H:MM AM/PM - Sender: Message     (US Android)
     Format 6: [MM/DD/YY, H:MM:SS AM/PM] Sender: Message  (US iOS)
     Format 7: YYYY-MM-DD, HH:MM - Sender: Message        (ISO-ish)
  */

  // RegEx matching iOS style: [date, time] Sender: message
  var IOS_RE = /^\[(\d{1,4}[-/. ]\d{1,2}[-/. ]\d{2,4}),?\s+(\d{1,2}:\d{2}(?::\d{2})?(?:\s*[AaPp][Mm])?)\]\s+(.*?)$/;

  // RegEx matching Android style: date, time - Sender: message
  var ANDROID_RE = /^(\d{1,4}[-/. ]\d{1,2}[-/. ]\d{2,4}),?\s+(\d{1,2}:\d{2}(?::\d{2})?(?:\s*[AaPp][Mm])?)\s+-\s+(.*?)$/;

  function cleanLine(line) {
    if (!line) return "";
    return line.replace(UNICODE_CLEAN_RE, "").replace(NARROW_SPACE_RE, " ");
  }

  function parseDateString(dateStr, timeStr) {
    if (!dateStr) return new Date();

    // Split date delimiters: slash, dot, dash, space
    var parts = dateStr.split(/[-/. ]/).map(function (p) {
      return parseInt(p, 10);
    });

    if (parts.length < 3) return new Date();

    var year, month, day;

    // Detect year position
    if (parts[0] > 1000) {
      // YYYY-MM-DD
      year = parts[0];
      month = parts[1] - 1;
      day = parts[2];
    } else {
      // Could be DD/MM/YY or MM/DD/YY
      // WhatsApp in India / UK / Europe is almost always DD/MM/YY
      // If first part > 12, it MUST be day
      if (parts[0] > 12) {
        day = parts[0];
        month = parts[1] - 1;
        year = parts[2];
      } else if (parts[1] > 12) {
        // MM/DD/YY
        month = parts[0] - 1;
        day = parts[1];
        year = parts[2];
      } else {
        // Default to DD/MM/YY for Indian / International locale
        day = parts[0];
        month = parts[1] - 1;
        year = parts[2];
      }

      if (year < 100) {
        year += 2000;
      }
    }

    var hours = 0;
    var minutes = 0;
    var seconds = 0;

    if (timeStr) {
      var ampmMatch = timeStr.match(/([AaPp][Mm])/);
      var ampm = ampmMatch ? ampmMatch[1].toUpperCase() : null;
      var cleanTime = timeStr.replace(/[AaPp][Mm]/, "").trim();
      var tParts = cleanTime.split(":").map(function (p) {
        return parseInt(p, 10) || 0;
      });

      hours = tParts[0] || 0;
      minutes = tParts[1] || 0;
      seconds = tParts[2] || 0;

      if (ampm === "PM" && hours < 12) hours += 12;
      if (ampm === "AM" && hours === 12) hours = 0;
    }

    var d = new Date(year, month, day, hours, minutes, seconds);
    return isNaN(d.getTime()) ? new Date() : d;
  }

  function pad(n) {
    return n < 10 ? "0" + n : String(n);
  }

  function formatDateIso(d) {
    return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate());
  }

  function formatTimeShort(d) {
    return pad(d.getHours()) + ":" + pad(d.getMinutes());
  }

  function isSystemMessage(sender, text) {
    if (!sender || sender === "System") return true;
    var combined = (sender + ": " + text).toLowerCase();
    for (var i = 0; i < SYSTEM_PATTERNS.length; i++) {
      if (SYSTEM_PATTERNS[i].test(combined)) return true;
    }
    return false;
  }

  /* -------------------------------------------------------------------------
     Main Parser
     ------------------------------------------------------------------------- */
  function parse(rawText, options) {
    options = options || {};
    var lines = String(rawText || "").split(/\r?\n/);
    var messages = [];
    var currentMsg = null;
    var participantsMap = {};

    for (var i = 0; i < lines.length; i++) {
      var rawLine = lines[i];
      var line = cleanLine(rawLine);
      if (!line && !currentMsg) continue;

      var match = null;
      var isIos = false;

      if (line.charAt(0) === "[") {
        match = IOS_RE.exec(line);
        isIos = true;
      } else {
        match = ANDROID_RE.exec(line);
      }

      if (match) {
        // Line starts a new message
        var datePart = match[1];
        var timePart = match[2];
        var rest = match[3];

        var sender = "System";
        var messageText = rest;

        // In both iOS and Android, sender is separated from message by ": "
        var colonIdx = rest.indexOf(": ");
        if (colonIdx !== -1) {
          sender = rest.substring(0, colonIdx).trim();
          messageText = rest.substring(colonIdx + 2);
        }

        var parsedDate = parseDateString(datePart, timePart);

        currentMsg = {
          id: messages.length + 1,
          date: parsedDate,
          dateStr: formatDateIso(parsedDate),
          timeStr: formatTimeShort(parsedDate),
          sender: sender,
          text: messageText,
          isSystem: false,
          isMedia: false,
          isDeleted: false,
          links: [],
          mentions: [],
        };

        // Classify message
        currentMsg.isDeleted = DELETED_RE.test(messageText);
        currentMsg.isMedia = MEDIA_OMITTED_RE.test(messageText);
        currentMsg.isSystem = isSystemMessage(sender, messageText);

        messages.push(currentMsg);
      } else if (currentMsg) {
        // Continuation of the previous message
        currentMsg.text += "\n" + rawLine;
      }
    }

    // Post-process messages: extract links, mentions, word counts, stats
    var stats = {
      totalMessages: messages.length,
      userMessages: 0,
      systemMessages: 0,
      mediaCount: 0,
      deletedCount: 0,
      participantCount: 0,
      startDate: null,
      endDate: null,
      daysSpan: 1,
      topLinks: [],
      detectedQuestions: [],
      hourlyActivity: {},
      dailyActivity: {},
    };

    var seenLinks = {};

    for (var m = 0; m < messages.length; m++) {
      var msg = messages[m];

      if (msg.isSystem) {
        stats.systemMessages++;
      } else {
        stats.userMessages++;

        // Track participants
        if (!participantsMap[msg.sender]) {
          participantsMap[msg.sender] = {
            name: msg.sender,
            count: 0,
            wordCount: 0,
            mediaCount: 0,
            firstActive: msg.date,
            lastActive: msg.date,
          };
        }
        var pStats = participantsMap[msg.sender];
        pStats.count++;
        pStats.wordCount += msg.text.split(/\s+/).filter(Boolean).length;
        if (msg.isMedia) pStats.mediaCount++;
        pStats.lastActive = msg.date;

        // Activity metrics
        var hour = msg.date.getHours();
        stats.hourlyActivity[hour] = (stats.hourlyActivity[hour] || 0) + 1;

        var dayOfWeek = msg.date.getDay();
        stats.dailyActivity[dayOfWeek] = (stats.dailyActivity[dayOfWeek] || 0) + 1;

        // Detect questions
        if (msg.text.indexOf("?") !== -1 || QUESTION_WORDS.test(msg.text)) {
          var trimmedQ = msg.text.trim();
          if (trimmedQ.length > 8 && trimmedQ.length < 250) {
            stats.detectedQuestions.push({
              sender: msg.sender,
              dateStr: msg.dateStr,
              text: trimmedQ,
            });
          }
        }
      }

      if (msg.isMedia) stats.mediaCount++;
      if (msg.isDeleted) stats.deletedCount++;

      // Date boundaries
      if (!stats.startDate || msg.date < stats.startDate) stats.startDate = msg.date;
      if (!stats.endDate || msg.date > stats.endDate) stats.endDate = msg.date;

      // Extract links
      var urls = msg.text.match(URL_RE);
      if (urls) {
        msg.links = urls;
        for (var u = 0; u < urls.length; u++) {
          var cleanUrl = urls[u].replace(/[.,!?;:]$/, "");
          if (!seenLinks[cleanUrl]) {
            seenLinks[cleanUrl] = { url: cleanUrl, sender: msg.sender, dateStr: msg.dateStr };
            stats.topLinks.push(seenLinks[cleanUrl]);
          }
        }
      }

      // Extract mentions
      var mentions = msg.text.match(MENTION_RE);
      if (mentions) {
        msg.mentions = mentions;
      }
    }

    stats.participantCount = Object.keys(participantsMap).length;

    if (stats.startDate && stats.endDate) {
      var diffTime = Math.abs(stats.endDate - stats.startDate);
      stats.daysSpan = Math.max(1, Math.ceil(diffTime / (1000 * 60 * 60 * 24)));
    }

    // Infer chat name from file or participants
    var chatName = options.chatName || "";
    if (!chatName) {
      var names = Object.keys(participantsMap);
      if (names.length === 0) chatName = "WhatsApp Chat";
      else if (names.length === 1) chatName = "Chat with " + names[0];
      else if (names.length === 2) chatName = names[0] + " & " + names[1];
      else chatName = "Group: " + names.slice(0, 3).join(", ") + " +" + (names.length - 3);
    }

    return {
      chatName: chatName,
      messages: messages,
      participants: participantsMap,
      stats: stats,
      toCondensedText: function (condensedOpts) {
        return toCondensedText(messages, condensedOpts);
      },
      getChunks: function (maxTokens) {
        return getChunks(messages, maxTokens);
      },
    };
  }

  /* -------------------------------------------------------------------------
     Condensed format optimized for LLM token efficiency
     ------------------------------------------------------------------------- */
  function toCondensedText(messages, opts) {
    opts = opts || {};
    var filterSender = opts.sender || null;
    var startDate = opts.startDate ? new Date(opts.startDate) : null;
    var endDate = opts.endDate ? new Date(opts.endDate) : null;
    var includeMedia = Boolean(opts.includeMedia);

    var lines = [];
    var lastDate = null;

    for (var i = 0; i < messages.length; i++) {
      var m = messages[i];
      if (m.isSystem) continue;
      if (m.isMedia && !includeMedia) continue;
      if (m.isDeleted) continue;
      if (filterSender && m.sender !== filterSender) continue;
      if (startDate && m.date < startDate) continue;
      if (endDate && m.date > endDate) continue;

      if (m.dateStr !== lastDate) {
        lines.push("\n--- " + m.dateStr + " ---");
        lastDate = m.dateStr;
      }

      // Compact representation: [HH:MM] Sender: text
      var cleanText = m.text.replace(/\r?\n+/g, " ").trim();
      lines.push("[" + m.timeStr + "] " + m.sender + ": " + cleanText);
    }

    return lines.join("\n").trim();
  }

  /* -------------------------------------------------------------------------
     Chunking for large chats (ensures context fits in model window)
     ------------------------------------------------------------------------- */
  function getChunks(messages, maxTokens) {
    // 1 token ~= 4 chars of English text
    var maxChars = (maxTokens || 3500) * 3.8;
    var chunks = [];
    var currentChunk = [];
    var currentChars = 0;

    var validMessages = messages.filter(function (m) {
      return !m.isSystem && !m.isDeleted;
    });

    for (var i = 0; i < validMessages.length; i++) {
      var m = validMessages[i];
      var line = "[" + m.dateStr + " " + m.timeStr + "] " + m.sender + ": " + m.text.replace(/\n+/g, " ");
      var lineLen = line.length + 1;

      if (currentChars + lineLen > maxChars && currentChunk.length > 0) {
        chunks.push(currentChunk.join("\n"));
        currentChunk = [line];
        currentChars = lineLen;
      } else {
        currentChunk.push(line);
        currentChars += lineLen;
      }
    }

    if (currentChunk.length > 0) {
      chunks.push(currentChunk.join("\n"));
    }

    return chunks;
  }

  /* -------------------------------------------------------------------------
     Zip Archive & File Reader Helper
     ------------------------------------------------------------------------- */
  function parseFile(file, callback) {
    if (!file) return callback(new Error("No file provided"));

    var fileName = file.name || "";
    var isZip = /\.zip$/i.test(fileName);

    if (isZip) {
      if (!global.JSZip) {
        return callback(new Error("JSZip is not loaded to decompress .zip file"));
      }

      var zip = new global.JSZip();
      zip
        .loadAsync(file)
        .then(function (contents) {
          // Find the primary chat file (often named _chat.txt or WhatsApp Chat with ....txt)
          var chatFileName = null;
          var entries = Object.keys(contents.files);

          for (var i = 0; i < entries.length; i++) {
            var entry = entries[i];
            if (/\.(txt)$/i.test(entry) && !entry.startsWith("__MACOSX")) {
              chatFileName = entry;
              break;
            }
          }

          if (!chatFileName) {
            return callback(new Error("No .txt chat file found inside the zip archive"));
          }

          return contents.files[chatFileName].async("string").then(function (text) {
            var chatTitle = fileName.replace(/\.zip$/i, "").replace(/^WhatsApp Chat - /i, "");
            var parsed = parse(text, { chatName: chatTitle });
            callback(null, parsed);
          });
        })
        .catch(function (err) {
          callback(err);
        });
    } else {
      // Plain text file (.txt)
      var reader = new FileReader();
      reader.onload = function (e) {
        var text = e.target.result;
        var chatTitle = fileName.replace(/\.txt$/i, "").replace(/^WhatsApp Chat - /i, "").replace(/^WhatsApp Chat with /i, "");
        var parsed = parse(text, { chatName: chatTitle });
        callback(null, parsed);
      };
      reader.onerror = function (e) {
        callback(new Error("Failed to read file: " + e.target.error));
      };
      reader.readAsText(file);
    }
  }

  /* -------------------------------------------------------------------------
     Realistic Sample WhatsApp Chat
     ------------------------------------------------------------------------- */
  function getSampleChat() {
    return [
      "12/10/24, 09:30 - Messages and calls are end-to-end encrypted. No one outside of this chat, not even WhatsApp, can read or listen to them.",
      "12/10/24, 09:32 - Ananya created group \"Project Genesis — Final Deliverable\"",
      "12/10/24, 09:33 - Ananya added Rohan Verma, Dr. Siddharth, and Tanvi Mehta",
      "12/10/24, 09:35 - Ananya: Hey team! Starting this group to coordinate our final submission for the AI Hackathon and college symposium.",
      "12/10/24, 09:36 - Rohan Verma: Great! What is our absolute final deadline for submission?",
      "12/10/24, 09:37 - Ananya: The portal closes this Sunday (Oct 20) at 11:59 PM sharp. No extensions granted by the review committee.",
      "12/10/24, 09:40 - Tanvi Mehta: Understood. How are we splitting the modules? I can take the UI/UX frontend and responsive dashboard.",
      "12/10/24, 09:42 - Rohan Verma: I will handle the backend API integration and WebLLM client-side model pipeline.",
      "12/10/24, 09:45 - Ananya: Perfect. I'll write the research paper draft, system architecture diagrams, and prepare the slide deck.",
      "12/10/24, 10:15 - Dr. Siddharth: Good plan team. Please make sure the AI privacy aspect is highlighted. All data must stay local in the user's browser without uploading chats to cloud servers.",
      "12/10/24, 10:18 - Rohan Verma: Yes sir, using WebGPU with WebLLM guarantees 100% on-device inference.",
      "12/10/24, 10:20 - Ananya: Agreed! Decision: We will strictly mandate client-side WebLLM with no cloud data leak.",
      "13/10/24, 14:10 - Tanvi Mehta: Here is the Figma mockup link for review: https://figma.com/file/genesis-prototype-v2",
      "13/10/24, 14:15 - Ananya: Looks fantastic! Can we make the Important Stuff summary cards have checkboxes for action items?",
      "13/10/24, 14:18 - Tanvi Mehta: Yes, will add interactive task toggles and export to Markdown.",
      "13/10/24, 16:00 - Rohan Verma: <Media omitted>",
      "13/10/24, 16:02 - Rohan Verma: Attached the benchmark results. WebLLM Llama-3.2 runs at 28 tokens/sec on modern laptop GPUs.",
      "14/10/24, 11:00 - Ananya: Quick check — when are we doing our first full dry-run test?",
      "14/10/24, 11:05 - Rohan Verma: How about Thursday Oct 17 at 4:30 PM in Lab 302?",
      "14/10/24, 11:08 - Tanvi Mehta: Thursday 4:30 PM works for me.",
      "14/10/24, 11:10 - Dr. Siddharth: I will join at 5:00 PM for the review.",
      "14/10/24, 11:12 - Ananya: Confirmed! Action items summary:",
      "1. Tanvi: Finalize UI components by Wednesday Oct 16.",
      "2. Rohan: Finish WhatsApp parser and WebLLM streaming by Wednesday night.",
      "3. Ananya: Draft presentation deck and abstract by Thursday morning.",
      "4. Team: Dry run on Thursday Oct 17 at 4:30 PM in Lab 302.",
      "15/10/24, 18:20 - Tanvi Mehta: Did anyone check what font licensing requirements we need for the poster?",
      "15/10/24, 18:25 - Ananya: Inter and SFMono are open source and free for commercial/academic use.",
      "16/10/24, 20:30 - Rohan Verma: GitHub repo is updated: https://github.com/project-genesis/ai-chat-reader",
      "16/10/24, 20:32 - Tanvi Mehta: Pulling latest commits now. Frontend is ready!",
      "17/10/24, 16:30 - Ananya: Heading to Lab 302 now. See everyone there!",
      "17/10/24, 17:45 - Dr. Siddharth: Excellent demo today. Ready for Sunday's submission.",
      "18/10/24, 09:00 - Ananya: Remember to send your final proofread sections by Saturday 6 PM.",
    ].join("\n");
  }

  // Export module
  var WhatsAppParserExport = {
    parse: parse,
    parseFile: parseFile,
    toCondensedText: toCondensedText,
    getChunks: getChunks,
    getSampleChat: getSampleChat,
  };

  if (typeof module !== "undefined" && module.exports) {
    module.exports = { WhatsAppParser: WhatsAppParserExport };
  }
  if (typeof window !== "undefined") {
    window.WhatsAppParser = WhatsAppParserExport;
  }
  global.WhatsAppParser = WhatsAppParserExport;
})(typeof window !== "undefined" ? window : global);
