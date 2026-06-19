# Security

## Data Flow

The extension collects only context needed for the selected command. Selection, file, diagnostics, and optional workspace context are represented as explicit context attachments and previewed before larger sends.

Requests go only to the configured `parley.endpoint` (the MIT Parley API by default). No network request is made until the user sends a message or runs a command.

## Credentials

The Parley API key is stored with VS Code `SecretStorage` and sent only as a bearer token to the configured endpoint. Credentials are never stored in `settings.json`, workspace files, logs, or webview state.

The extension includes `Parley: Sign Out`, which clears stored authentication material.

## Logging

The logger does not write prompts, source snippets, request headers, tokens, cookies, or credentials. Error logs include only high-level messages and exception names/messages.

## Sensitive Files

The extension excludes common sensitive files by default:

- `.env`
- `.env.*`
- `.npmrc`
- `.pypirc`
- `id_rsa`
- `id_ed25519`
- `*.pem`
- `*.key`
- `secrets.*`
- files under `.ssh`, `.aws`, `.azure`, or `.gnupg`

Hidden files are excluded except `.parleyignore`.

## Unsupported Authentication

The extension must not automate MIT Touchstone/SAML login, collect passwords, capture browser cookies, or reverse engineer private web traffic unless the user has explicit authorization and the implementation complies with MIT policies.
