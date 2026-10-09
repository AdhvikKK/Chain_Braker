/* ==========================================================================
   ChainBreaker — local server
   --------------------------------------------------------------------------
   Two jobs:
     1. Serve this folder over http://127.0.0.1:8787 so the browser has a real
        origin (and so localStorage is stable).
     2. Proxy chat requests to an OpenAI-compatible endpoint, holding the API
        key server-side. The key never reaches the browser. This is what
        Kivd talks through.

   Zero dependencies. Run it with:  node server.js
   ========================================================================== */

"use strict";

const http = require("http");
const https = require("https");
const fs = require("fs");
const path = require("path");

const ROOT = __dirname;
const CONFIG_PATH = path.join(ROOT, "config.json");

/* ------------------------------------------------------------- presets ---
   Every one of these speaks the OpenAI chat-completions format, so switching
   provider is a one-word change in config.json. */

const PRESETS = {
  deepseek: {
    baseUrl: "https://api.deepseek.com/v1",
    model: "deepseek-flash",
    hint: "DeepSeek — paid, very cheap, 1M context.",
  },
  openrouter: {
    baseUrl: "https://openrouter.ai/api/v1",
    model: "deepseek/deepseek-chat-v3.1:free",
    hint: "OpenRouter — has genuinely free models (look for the :free suffix).",
  },
  groq: {
    baseUrl: "https://api.groq.com/openai/v1",
    model: "openai/gpt-oss-20b",
    hint: "Groq — fast, has a free developer tier. Newest small model: openai/gpt-oss-20b",
  },
  ollama: {
    baseUrl: "http://127.0.0.1:11434/v1",
    model: "llama3.2",
    apiKey: "ollama",
    hint: "Ollama — runs on your own machine. Free, private, no key needed.",
  },
  custom: {
    baseUrl: "http://127.0.0.1:8000/v1",
    model: "my-model",
    hint: "Anything that speaks the OpenAI format, including LM Studio and vLLM.",
  },
};

const DEFAULT_CONFIG = {
  preset: "deepseek",
  apiKey: "",
  baseUrl: "",
  model: "",
  port: 8787,
  systemPromptOverride: "",
  extraBody: {},
};

/* -------------------------------------------------------------- config --- */

function readConfig() {
  let fromDisk = {};
  try {
    if (fs.existsSync(CONFIG_PATH)) {
      fromDisk = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
    }
  } catch (err) {
    console.error("\n  config.json could not be parsed: " + err.message);
    console.error("  Fix the JSON (check for trailing commas) and start again.\n");
    process.exit(1);
  }

  const cfg = Object.assign({}, DEFAULT_CONFIG, fromDisk);
  const preset = PRESETS[cfg.preset] || PRESETS.deepseek;

  // A preset fills in whatever the config leaves blank.
  cfg.resolved = {
    baseUrl: (cfg.baseUrl || preset.baseUrl).replace(/\/+$/, ""),
    model: cfg.model || preset.model,
    apiKey: cfg.apiKey || preset.apiKey || "",
    hint: preset.hint,
  };

  // Environment variables win, so the key can stay out of the file entirely.
  if (process.env.CHAINBREAKER_API_KEY) cfg.resolved.apiKey = process.env.CHAINBREAKER_API_KEY;
  if (process.env.CHAINBREAKER_BASE_URL)
    cfg.resolved.baseUrl = process.env.CHAINBREAKER_BASE_URL.replace(/\/+$/, "");
  if (process.env.CHAINBREAKER_MODEL) cfg.resolved.model = process.env.CHAINBREAKER_MODEL;

  return cfg;
}

function writeDefaultConfigIfMissing() {
  if (fs.existsSync(CONFIG_PATH)) return;
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(DEFAULT_CONFIG, null, 2) + "\n", "utf8");
  console.log("  Created config.json with defaults.");
}

/* --------------------------------------------------------------- static --- */

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
};

/* Blocklisted by name, plus every dotfile — .env and .git are the likeliest
   places for something that should never be served. */
const DENY = new Set(["config.json", "server.js", "start.cmd", "start.ps1", "package.json"]);

function serveStatic(req, res, pathname) {
  let rel = decodeURIComponent(pathname);
  if (rel === "/") rel = "/index_2.html";

  const target = path.normalize(path.join(ROOT, rel));

  // Never serve outside this folder, and never serve our own secrets.
  if (!target.startsWith(ROOT + path.sep) && target !== ROOT) {
    res.writeHead(403, { "Content-Type": "text/plain" });
    return res.end("Forbidden");
  }

  const base = path.basename(target);
  if (DENY.has(base) || base.startsWith(".") || target.split(path.sep).some((p) => p.startsWith("."))) {
    res.writeHead(403, { "Content-Type": "text/plain" });
    return res.end("Forbidden");
  }

  fs.readFile(target, (err, data) => {
    if (err) {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      return res.end("Not found: " + rel);
    }
    res.writeHead(200, {
      "Content-Type": MIME[path.extname(target).toLowerCase()] || "application/octet-stream",
      "Cache-Control": "no-store",
    });
    res.end(data);
  });
}

/* ----------------------------------------------------------------- body --- */

function readJsonBody(req, limitBytes) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > (limitBytes || 4 * 1024 * 1024)) {
        reject(new Error("Request body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (!raw.trim()) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch (e) {
        reject(new Error("Body was not valid JSON"));
      }
    });
    req.on("error", reject);
  });
}

/* ------------------------------------------------------------ chat proxy --- */

function friendlyError(status, payload) {
  const apiMessage =
    (payload && payload.error && payload.error.message) ||
    (payload && payload.message) ||
    "";

  if (status === 401 || status === 403) {
    return "The API key was rejected. Check `apiKey` in config.json.";
  }
  if (status === 402) {
    return "This account is out of credit. Top up, or switch to a free provider in config.json.";
  }
  if (status === 429) {
    return "Rate limited by the provider. Wait a moment, or switch provider in config.json.";
  }
  if (status === 400) {
    return apiMessage
      ? "The provider rejected the request: " + apiMessage
      : "The provider rejected the request. The model name may be wrong.";
  }
  if (status === 404) {
    return "Endpoint or model not found. Check `baseUrl` and `model` in config.json.";
  }
  return apiMessage || "Provider returned HTTP " + status + ".";
}

function handleChat(req, res, cfg) {
  readJsonBody(req)
    .then((body) => {
      const system = String(body.system || "").trim();
      const history = Array.isArray(body.messages) ? body.messages : [];

      if (!history.length) {
        res.writeHead(400, { "Content-Type": "application/json" });
        return res.end(JSON.stringify({ error: "No messages supplied." }));
      }

      const messages = [];
      if (system) messages.push({ role: "system", content: system });
      for (const m of history) {
        if (!m || typeof m.content !== "string") continue;
        messages.push({
          role: m.role === "assistant" ? "assistant" : "user",
          content: m.content,
        });
      }

      const upstreamBody = Object.assign(
        {
          model: cfg.resolved.model,
          messages,
          stream: true,
        },
        cfg.extraBody || {}
      );

      const target = new URL(cfg.resolved.baseUrl + "/chat/completions");
      const payload = JSON.stringify(upstreamBody);

      // http.request cannot speak TLS — it throws ERR_INVALID_PROTOCOL for an
      // https URL. Pick the transport from the scheme.
      const transport = target.protocol === "https:" ? https : http;

      const upstream = transport.request(
        {
          protocol: target.protocol,
          hostname: target.hostname,
          port: target.port || (target.protocol === "https:" ? 443 : 80),
          path: target.pathname + target.search,
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Accept: "text/event-stream",
            Authorization: "Bearer " + cfg.resolved.apiKey,
            "Content-Length": Buffer.byteLength(payload),
          },
        },
        (up) => {
          if (up.statusCode !== 200) {
            const parts = [];
            up.on("data", (c) => parts.push(c));
            up.on("end", () => {
              let parsed = null;
              try {
                parsed = JSON.parse(Buffer.concat(parts).toString("utf8"));
              } catch (e) {}
              const message = friendlyError(up.statusCode, parsed);
              res.writeHead(200, {
                "Content-Type": "text/event-stream; charset=utf-8",
                "Cache-Control": "no-store",
                Connection: "keep-alive",
              });
              res.write("data: " + JSON.stringify({ type: "error", message }) + "\n\n");
              res.write("data: " + JSON.stringify({ type: "done" }) + "\n\n");
              res.end();
            });
            return;
          }

          res.writeHead(200, {
            "Content-Type": "text/event-stream; charset=utf-8",
            "Cache-Control": "no-store",
            Connection: "keep-alive",
            "X-Accel-Buffering": "no",
          });

          let buffer = "";
          let sentAnyText = false;

          up.setEncoding("utf8");
          up.on("data", (chunk) => {
            buffer += chunk;

            // Process whole SSE lines only; keep any partial line for later.
            const lines = buffer.split("\n");
            buffer = lines.pop();

            for (const line of lines) {
              const trimmed = line.trim();
              if (!trimmed || !trimmed.startsWith("data:")) continue;

              const data = trimmed.slice(5).trim();
              if (data === "[DONE]") continue;

              let json;
              try {
                json = JSON.parse(data);
              } catch (e) {
                continue;
              }

              const choice = json.choices && json.choices[0];
              if (!choice) continue;
              const delta = choice.delta || {};

              // Reasoning models stream their scratchpad separately.
              if (delta.reasoning_content && !sentAnyText) {
                res.write("data: " + JSON.stringify({ type: "thinking" }) + "\n\n");
              }

              if (typeof delta.content === "string" && delta.content.length) {
                sentAnyText = true;
                res.write(
                  "data: " + JSON.stringify({ type: "delta", text: delta.content }) + "\n\n"
                );
              }

              if (choice.finish_reason && !sentAnyText && !delta.tool_calls) {
                res.write(
                  "data: " +
                    JSON.stringify({
                      type: "error",
                      message: "The model finished without returning any text.",
                    }) +
                    "\n\n"
                );
              }
            }
          });

          up.on("end", () => {
            res.write("data: " + JSON.stringify({ type: "done" }) + "\n\n");
            res.end();
          });

          up.on("error", (err) => {
            res.write(
              "data: " +
                JSON.stringify({ type: "error", message: "Connection dropped: " + err.message }) +
                "\n\n"
            );
            res.write("data: " + JSON.stringify({ type: "done" }) + "\n\n");
            res.end();
          });
        }
      );

      upstream.on("error", (err) => {
        const message =
          "Could not reach " +
          cfg.resolved.baseUrl +
          " — " +
          err.message +
          (cfg.preset === "ollama" ? " (is Ollama running?)" : "");
        res.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8" });
        res.write("data: " + JSON.stringify({ type: "error", message }) + "\n\n");
        res.write("data: " + JSON.stringify({ type: "done" }) + "\n\n");
        res.end();
      });

      // If the browser hangs up, stop paying for tokens.
      req.on("close", () => upstream.destroy());

      upstream.write(payload);
      upstream.end();
    })
    .catch((err) => {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: err.message }));
    });
}

/* ---------------------------------------------------------------- server --- */

writeDefaultConfigIfMissing();
const config = readConfig();

const server = http.createServer((req, res) => {
  const parsed = new URL(req.url, "http://127.0.0.1");
  const pathname = parsed.pathname;

  if (pathname === "/api/health") {
    res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
    return res.end(
      JSON.stringify({
        ok: true,
        preset: config.preset,
        model: config.resolved.model,
        baseUrl: config.resolved.baseUrl,
        hasKey: Boolean(config.resolved.apiKey),
        hint: config.resolved.hint,
      })
    );
  }

  if (pathname === "/api/chat" && req.method === "POST") {
    return handleChat(req, res, config);
  }

  if (req.method !== "GET" && req.method !== "HEAD") {
    res.writeHead(405, { "Content-Type": "text/plain" });
    return res.end("Method not allowed");
  }

  serveStatic(req, res, pathname);
});

server.listen(config.port, "127.0.0.1", () => {
  const line = "─".repeat(64);
  console.log("\n" + line);
  console.log("  ChainBreaker is running");
  console.log(line);
  console.log("  Open:      http://localhost:" + config.port + "/index.html");
  console.log("  Provider:  " + config.preset + "  (" + config.resolved.hint + ")");
  console.log("  Model:     " + config.resolved.model);
  console.log(
    "  API key:   " + (config.resolved.apiKey ? "loaded" : "MISSING — edit config.json")
  );
  console.log(line);
  console.log("  Press Ctrl+C in this window to stop the server.");
  console.log(line + "\n");

  if (!config.resolved.apiKey) {
    console.log("  config.json exists but has no apiKey, so Kivd cannot reply.");
    console.log("  Open config.json, paste your key, then restart this server.\n");
  }
});

server.on("error", (err) => {
  if (err.code === "EADDRINUSE") {
    console.error(
      "\n  Port " + config.port + " is already in use. Either the server is already running,");
    console.error("  or change \"port\" in config.json to something else.\n");
  } else {
    console.error("\n  Server error: " + err.message + "\n");
  }
  process.exit(1);
});
