# Privacy

## What May Be Sent

When you send a message, the extension may send to the Parley API (`https://parley.api.mit.edu/v1`):

- The prompt typed by the user.
- Selected code and surrounding context.
- The current file, only for commands that ask for it.
- Diagnostics/problems, only when requested by the command and allowed by settings.
- User-selected files, if such a workflow is added and confirmed by the user.

The extension never sends the whole workspace by default.

## Preview and Control

Large context sends are previewed in an editor tab before submission. Users can cancel before anything leaves VS Code.

## Telemetry

`parley.telemetry.enabled` defaults to `false`. This extension currently emits no telemetry.

## Where Data Goes

Requests go only to the configured `parley.endpoint` (the MIT Parley API by default), authenticated with your API key. No request is made until you send a message or run a command.

## Data Not Sent Intentionally

The extension filters common secrets and credential files and avoids hidden files by default. It also supports `.parleyignore` and optional `.gitignore` matching.
