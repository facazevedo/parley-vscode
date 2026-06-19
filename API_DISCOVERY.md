# Parley API Reference

Last verified: June 19, 2026

## Summary

MIT Parley exposes an **OpenAI-compatible** HTTP API. The extension's official
provider ([src/parley/ParleyClient.ts](src/parley/ParleyClient.ts)) talks to it
directly with a personal API key, so no browser/Touchstone step is required for
programmatic use.

> Earlier versions of this extension shipped a clipboard-based "copy to website"
> workflow because no API had been found. That legacy layer (and the mock
> provider) was removed in 0.2.0 now that the live API is wired up.

## Base URL and authentication

| Item | Value |
| --- | --- |
| Base URL | `https://parley.api.mit.edu/v1` (prod). `-dev` / `-test` variants exist. |
| Auth | `Authorization: Bearer sk-parley-v1-…` |
| Web app | `https://parley.mit.edu` — sign in with MIT Touchstone, then create keys under **Settings → API Keys**. |

The web app (`parley.mit.edu`) is an Open WebUI front end gated by Touchstone/Okta.
That SSO only protects the web app and the docs site (`parley-docs.mit.edu`); the
API host authenticates purely with the bearer key.

## Endpoints used

### `GET /v1/models`

Returns an OpenAI-style model list:

```json
{ "object": "list", "data": [ { "id": "bedrock/claude-sonnet-4-6", "name": "Claude Sonnet 4.6", "owned_by": "bedrock" } ] }
```

Model IDs are provider-prefixed. Observed families:

- `bedrock/claude-haiku-4-5`, `bedrock/claude-sonnet-4-6`, `bedrock/claude-opus-4-6`, `bedrock/claude-opus-4-7`, `bedrock/llama-4-maverick-17b`
- `openai/gpt-5`, `gpt-5-mini`, `gpt-5-nano`, `gpt-5.1`, `gpt-5.2`, `gpt-5.3-codex`, `gpt-5.4`, `gpt-5.5`, `gpt-image-1`
- `google/gemini-2.5-pro`, `gemini-3.0-flash`, `gemini-3.1-pro`

### `POST /v1/chat/completions`

Standard OpenAI chat completions. Request:

```json
{ "model": "bedrock/claude-sonnet-4-6", "messages": [ { "role": "user", "content": "…" } ], "stream": true }
```

- Non-streaming: reply at `choices[0].message.content`.
- Streaming (`stream: true`): SSE lines `data: {…}` with incremental
  `choices[0].delta.content`, terminated by `data: [DONE]`.

Notes from probing:
- Unknown model IDs return `400 BAD_REQUEST` with a helpful message.
- `max_tokens` is intentionally omitted by the client so reasoning models are not truncated.

### Tool calling

OpenAI-compatible. Send `tools: [{type:"function", function:{name, description, parameters}}]`;
the model replies with `choices[0].message.tool_calls[]` (`id`, `function.name`,
`function.arguments` as a JSON string). Reply with a `{role:"tool", tool_call_id, content}`
message per call and loop. Used by the chat **Agent** mode (`src/parley/tools.ts`).

### Vision / multimodal

A user message `content` may be an array mixing `{type:"text"}` and
`{type:"image_url", image_url:{url:"data:image/png;base64,…"}}` blocks. Requires a
vision-capable model (Claude, Gemini, GPT-5). Used by chat image attachments.

### Image generation

`POST /v1/images/generations` with `model` **exactly** `openai/gpt-image-1`, plus
`prompt`, `n`, `size` (`1024x1024`, `1536x1024`, `1024x1536`, `auto`). Returns
`data[0].b64_json` (PNG; no URL). Used by `Parley: Generate Image`.

### Inline completion

There is no dedicated FIM endpoint; ghost-text uses `/chat/completions` with a
completion system prompt and a `<CURSOR>` marker, on a fast model.

## How the extension proposes edits

The client sends a system prompt instructing the model to return each changed or
new file as a `File: <relative path>` line followed by a fenced code block with the
**complete** file contents. Responses are parsed by
[src/diff/extractChanges.ts](src/diff/extractChanges.ts) (whole-file blocks plus
unified diffs) and shown in a VS Code diff for explicit acceptance before applying.

## Reproduce the discovery

```bash
KEY="sk-parley-v1-…"
# list models
curl -s -H "Authorization: Bearer $KEY" https://parley.api.mit.edu/v1/models
# chat
curl -s -X POST https://parley.api.mit.edu/v1/chat/completions \
  -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d '{"model":"bedrock/claude-sonnet-4-6","messages":[{"role":"user","content":"hi"}]}'
```
