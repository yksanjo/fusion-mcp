# fusion-mcp

A zero-dependency [MCP](https://modelcontextprotocol.io) server that exposes
**[OpenRouter Fusion](https://openrouter.ai/fusion)** as a tool any agent can call.

Fusion sends your prompt to a *panel* of models in parallel (with web search), a
*judge* model compares their answers, and you get back one synthesized answer —
stronger than any single model. This wraps it so Claude Code (or any MCP client)
can reach Fusion directly instead of going through the OpenRouter web UI.

## Tool

### `fusion_ask`

| arg | required | description |
|-----|----------|-------------|
| `prompt` | ✅ | The question or task for the Fusion panel. |
| `analysis_models` | | 1–8 model slugs forming the panel. Omit for Fusion's default preset. |
| `judge_model` | | Model that synthesizes the panel's answers. Defaults to the first panel model. |
| `preset` | | Curated preset: `general-high` or `general-budget`. |
| `max_tool_calls` | | Tool iterations per panel model (1–16, default 8). |

> Fusion runs several completions per call (panel + judge), so it costs more than
> a single model call. Use it where being wrong is costly: research, critique, decisions.

## Setup

Requires Node ≥ 18 and an OpenRouter API key.

```bash
export OPENROUTER_API_KEY=sk-or-...
```

### Wire into Claude Code

```bash
claude mcp add fusion -e OPENROUTER_API_KEY=sk-or-... -- node /Users/yoshikondo/fusion-mcp/server.mjs
```

Or add to your MCP config manually:

```json
{
  "mcpServers": {
    "fusion": {
      "command": "node",
      "args": ["/Users/yoshikondo/fusion-mcp/server.mjs"],
      "env": { "OPENROUTER_API_KEY": "sk-or-..." }
    }
  }
}
```

Then in a session: *"use fusion_ask to research X"*.

## Test

```bash
npm test
```

The test suite spins up a real local HTTP server standing in for OpenRouter and
drives a real child-process MCP server over real stdio — nothing internal is mocked.

## License

MIT
