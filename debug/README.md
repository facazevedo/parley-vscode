# Parley debug logging

Verbose, gated tracing to help diagnose what the extension is doing — request
shapes, streamed responses, tool rounds, and control flow.

## How to turn it on / off

There is a single switch: the `DEBUG` constant in
[`src/debug/debug.ts`](../src/debug/debug.ts).

```ts
export const DEBUG = true;  // set to false to silence every dbg() call
```

It is currently **on**. When on, nothing else is required.

## Where the logs go

- **Output channel:** `View → Output → "Parley Debug"`.
- **File:** `parley-debug.log` in a `debug/` folder inside the **open
  workspace** (or the extension's global-storage folder if no workspace is
  open). Run **`Parley: Open Debug Log`** to open it.

Each line is `[timestamp] [area] message {data}`. Areas include `activate`,
`client`, `request`, `stream`, `toolloop`, `turn`, and `tool`.

## What is and isn't logged

Logged: models, message/role counts, tool names + arguments, response status,
the `x-parley-provider` / `x-parley-model` / `x-parley-request-id` headers,
`finish_reason`, token usage, and content lengths (content is truncated).

**Never logged:** the API key or the `Authorization` header.

## Sharing a log

Reproduce the issue, then open the log (command above) and copy its contents.
It's plain text and safe to share (no secrets).
