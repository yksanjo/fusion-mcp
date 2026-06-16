#!/usr/bin/env node
// fusion-mcp — a zero-dependency MCP stdio server that exposes OpenRouter Fusion
// (a panel of models answering in parallel + a judge that synthesizes one answer)
// as a single tool any MCP client (Claude Code, etc.) can call.
//
// Transport: newline-delimited JSON-RPC 2.0 over stdio (the MCP stdio transport).
// Auth:      OPENROUTER_API_KEY (required for tools/call; not needed to list tools).
// Override:  OPENROUTER_BASE_URL (defaults to https://openrouter.ai/api/v1) — used by tests.

const BASE_URL = (process.env.OPENROUTER_BASE_URL || "https://openrouter.ai/api/v1").replace(/\/$/, "");
const PROTOCOL_VERSION = "2024-11-05";
const SERVER_INFO = { name: "fusion-mcp", version: "0.1.0" };

const TOOLS = [
  {
    name: "fusion_ask",
    description:
      "Ask OpenRouter Fusion: a panel of models answers your prompt in parallel (with web search), " +
      "a judge compares them, and one synthesized answer is returned — stronger than any single model. " +
      "Use for research, expert critique, or any question where being wrong is costly. " +
      "Costs more than a single call (panel + judge completions).",
    inputSchema: {
      type: "object",
      properties: {
        prompt: { type: "string", description: "The question or task to send to the Fusion panel." },
        analysis_models: {
          type: "array",
          items: { type: "string" },
          description:
            "Optional 1-8 model slugs forming the panel (e.g. ['anthropic/claude-opus-4-8','openai/gpt-5.5']). " +
            "Omit to use Fusion's default quality preset.",
        },
        judge_model: {
          type: "string",
          description: "Optional model slug for the judge that synthesizes the panel's answers. Defaults to the first panel model.",
        },
        preset: {
          type: "string",
          description: "Optional curated preset: 'general-high' or 'general-budget'. Mutually exclusive with analysis_models.",
        },
        max_tool_calls: {
          type: "integer",
          description: "Tool iterations per panel model (1-16, default 8).",
        },
      },
      required: ["prompt"],
      additionalProperties: false,
    },
  },
];

// ---- OpenRouter call -------------------------------------------------------

async function callFusion(args) {
  const key = process.env.OPENROUTER_API_KEY;
  if (!key) {
    throw new Error("OPENROUTER_API_KEY is not set. Export it before calling fusion_ask.");
  }
  if (!args || typeof args.prompt !== "string" || !args.prompt.trim()) {
    throw new Error("`prompt` (non-empty string) is required.");
  }

  const plugin = { id: "fusion", enabled: true };
  if (Array.isArray(args.analysis_models) && args.analysis_models.length) {
    plugin.analysis_models = args.analysis_models;
  }
  if (typeof args.judge_model === "string" && args.judge_model.trim()) {
    plugin.model = args.judge_model.trim();
  }
  if (typeof args.preset === "string" && args.preset.trim()) {
    plugin.preset = args.preset.trim();
  }
  if (Number.isInteger(args.max_tool_calls)) {
    plugin.max_tool_calls = args.max_tool_calls;
  }

  const body = {
    model: "openrouter/fusion",
    messages: [{ role: "user", content: args.prompt }],
    plugins: [plugin],
  };

  const res = await fetch(`${BASE_URL}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
      "HTTP-Referer": "https://github.com/yksanjo/fusion-mcp",
      "X-Title": "fusion-mcp",
    },
    body: JSON.stringify(body),
  });

  const text = await res.text();
  if (!res.ok) {
    throw new Error(`OpenRouter ${res.status}: ${text.slice(0, 500)}`);
  }
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`OpenRouter returned non-JSON: ${text.slice(0, 200)}`);
  }
  const answer = json?.choices?.[0]?.message?.content ?? "(no content returned)";
  const usage = json?.usage || null;
  return { answer, usage, model: json?.model || "openrouter/fusion" };
}

// ---- JSON-RPC dispatch -----------------------------------------------------

async function handle(req) {
  const { id, method, params } = req;

  if (method === "initialize") {
    return reply(id, {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: { tools: {} },
      serverInfo: SERVER_INFO,
    });
  }

  if (method === "tools/list") {
    return reply(id, { tools: TOOLS });
  }

  if (method === "ping") {
    return reply(id, {});
  }

  if (method === "tools/call") {
    const name = params?.name;
    const args = params?.arguments || {};
    if (name !== "fusion_ask") {
      return reply(id, {
        content: [{ type: "text", text: `Unknown tool: ${name}` }],
        isError: true,
      });
    }
    try {
      const { answer, usage, model } = await callFusion(args);
      const footer = usage
        ? `\n\n— ${model} · tokens: ${usage.total_tokens ?? "?"}` +
          (usage.cost != null ? ` · cost: $${usage.cost}` : "")
        : `\n\n— ${model}`;
      return reply(id, { content: [{ type: "text", text: answer + footer }] });
    } catch (e) {
      return reply(id, { content: [{ type: "text", text: `Fusion error: ${e.message}` }], isError: true });
    }
  }

  // Notifications (no id) and unknown methods.
  if (id === undefined || id === null) return null; // notification: no response
  return replyError(id, -32601, `Method not found: ${method}`);
}

function reply(id, result) {
  return { jsonrpc: "2.0", id, result };
}
function replyError(id, code, message) {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

// ---- stdio loop ------------------------------------------------------------

let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let nl;
  while ((nl = buffer.indexOf("\n")) !== -1) {
    const line = buffer.slice(0, nl).trim();
    buffer = buffer.slice(nl + 1);
    if (!line) continue;
    let req;
    try {
      req = JSON.parse(line);
    } catch {
      process.stdout.write(JSON.stringify(replyError(null, -32700, "Parse error")) + "\n");
      continue;
    }
    Promise.resolve(handle(req))
      .then((out) => {
        if (out) process.stdout.write(JSON.stringify(out) + "\n");
      })
      .catch((e) => {
        process.stdout.write(JSON.stringify(replyError(req?.id ?? null, -32603, e.message)) + "\n");
      });
  }
});

process.stdin.on("end", () => process.exit(0));
