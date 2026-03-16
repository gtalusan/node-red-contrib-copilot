# @george.talusan/node-red-contrib-copilot

![npm](https://img.shields.io/npm/v/%40george.talusan%2Fnode-red-contrib-copilot?label=npm)
![Node-RED](https://img.shields.io/badge/node--red-%3E%3D3.0.0-red)
![License](https://img.shields.io/badge/license-ISC-blue)

Embed GitHub Copilot into your Node-RED flows. Send prompts and file attachments to any Copilot model and wire the response into the rest of your automation.

Built on the [`@github/copilot-sdk`](https://github.com/github/copilot-sdk) — the same engine that powers Copilot CLI.

---

## Requirements

### GitHub Copilot subscription

A GitHub Copilot subscription is required. A free tier with limited usage is available — see [GitHub Copilot pricing](https://github.com/features/copilot#pricing).

### Authentication

Two methods are supported:

| Method | When to use |
|--------|-------------|
| **OAuth (default)** | You are logged in via `gh auth login` or the Copilot CLI on the host machine |
| **Fine-grained PAT** | Headless / containerised deployments; token must have the **Copilot Requests** permission |

> ⚠️ Classic PATs with the `copilot` scope do **not** work. You must use a fine-grained PAT with **Copilot Requests** permission.

### Node.js

**Node.js v20 or later** is required (matches the `@github/copilot-sdk` minimum). The `@github/copilot` CLI binary bundled with the SDK is a native binary that requires a glibc-based (non-musl) environment.

---

## Docker

The recommended container is:

```
nodered/node-red:latest-debian
```

This image provides:
- Node-RED (latest stable)
- **Node.js v20** — meets the `@github/copilot-sdk` minimum requirement
- **Debian (glibc)** — the CLI binary is dynamically linked against glibc; Alpine/musl images are **not** supported

> ⚠️ Do **not** use Alpine-based images (`nodered/node-red:latest`). The bundled Copilot CLI binary requires glibc and will not run on musl libc.

### Quick start

```bash
docker run -d \
  --name nodered \
  -p 1880:1880 \
  -v /your/data:/data \
  nodered/node-red:latest-debian
```

---

## Installation

### Via the Node-RED Palette Manager

Search for `@george.talusan/node-red-contrib-copilot` in the Palette Manager and click **Install**.

If you are publishing your own fork or a renamed package, note that the Node-RED Flow Library does not auto-index npm packages. After publishing, submit it manually at `https://flows.nodered.org/add/node`.

### Via npm (inside your Node-RED data directory)

```bash
cd /your/node-red/data
npm install @george.talusan/node-red-contrib-copilot
```

### In Docker

```bash
docker exec nodered npm install @george.talusan/node-red-contrib-copilot --prefix /data
docker restart nodered
```

---

## Nodes

### `copilot-config` (configuration node)

Holds credentials and connection settings. Referenced by one or more `copilot` nodes.

| Field | Description |
|-------|-------------|
| **Name** | Label for this configuration |
| **Auth method** | `oauth` — use locally stored `gh` credentials; `token` — use a fine-grained PAT |
| **Token** | Fine-grained PAT with **Copilot Requests** permission (only when auth method is `token`) |
| **CLI Path** | Override the path to the `copilot` binary (leave blank to use the bundled binary) |
| **CLI URL** | Connect to an external CLI server instead of spawning a local process |

### `copilot` (prompt node)

Sends a prompt to GitHub Copilot and emits the response.

#### Inputs

| Property | Type | Description |
|----------|------|-------------|
| `msg.payload` | `string` | Plain string used as the prompt |
| `msg.payload` | `object` | `{ prompt: string, attachments: Attachment[] }` |
| `msg.attachments` | `Attachment[]` | Additional attachments merged with any included in `msg.payload` |
| `msg.model` | `string` | Override the model for this message only |
| `msg.conversationId` | `string` | Optional conversation key shared between nodes or flows |
| `msg.reset` | `boolean` | When `true`, destroys the current session for the resolved conversation and stops the message from reaching Copilot |

#### Attachment formats

```js
// File path (passed directly to the SDK)
{ type: "file", path: "/absolute/path/to/file.png" }

// Base64-encoded data
{ type: "base64", data: "<base64 string>", name: "image.jpg" }

// Node.js Buffer
{ type: "buffer", data: Buffer.from(...), name: "file.bin" }

// Shorthand — type is inferred as "file"
{ path: "/absolute/path/to/file.txt" }
```

#### Outputs

| Output | Property | Type | Description |
|--------|----------|------|-------------|
| **1 — Response** | `msg.payload` | `string` | The assistant's response text |
| | `msg.conversationId` | `string` | Conversation ID used for the message |
| | `msg.events` | `array` | All events emitted during the Copilot session |
| **2 — Error** | `msg.payload` | `string` | Error message |
| | `msg.error` | `Error` | The error object |

#### Session lifecycle

Sessions are created on first use and kept alive between messages so that conversation context is preserved. A session is closed when:

- A message with `msg.reset = true` is received.
- The session has been idle longer than the configured **Session idle** timeout (default 30 minutes; set to `0` to disable).
- An error occurs — the session is discarded so the next message starts fresh.
- The node is redeployed or Node-RED shuts down.

#### Node configuration

| Field | Description |
|-------|-------------|
| **Config** | Select a `copilot-config` node |
| **Model** | Dynamically populated from the API — shows token cost multiplier, e.g. `claude-haiku-4.5 (0x)` |
| **Reasoning** | Reasoning effort hint: `low`, `medium`, `high`, `xhigh` (model-dependent) |
| **Timeout** | Request timeout in milliseconds (default: 60,000) |
| **Conv. ID** | Optional identifier for sharing a conversation thread (defaults to the node ID when blank) |
| **Session idle (min)** | Idle timeout in minutes before sessions are discarded (set `0` to disable; default 30) |

---

## Architecture

```
Node-RED flow
      ↓
 copilot node
      ↓
@github/copilot-sdk (Node.js)
      ↓  JSON-RPC
Copilot CLI (bundled, spawned as subprocess)
      ↓  HTTPS
GitHub Copilot API
```

The SDK manages the CLI process lifecycle automatically. The CLI binary is bundled with the `@github/copilot` package (a dependency of `@github/copilot-sdk`) and is resolved automatically at startup — no manual PATH configuration needed.

---

## Example flow

The example flow used in this README is included in the repository under [`examples/copilot-test-flow.json`](./examples/copilot-test-flow.json).


---

## Development

```bash
git clone https://github.com/gtalusan/node-red-contrib-copilot
cd node-red-contrib-copilot
npm install

# Unit tests (mocked, no API key required)
npm test

# Integration tests (real API — requires a fine-grained PAT)
GITHUB_TOKEN=<your-fine-grained-pat> npm run test:integration
```

### Deploying to Docker during development

```bash
npm pack
cp george.talusan-node-red-contrib-copilot-*.tgz ~/your/node-red/data/
docker exec nodered npm install /data/george.talusan-node-red-contrib-copilot-*.tgz --prefix /data
docker restart nodered
```

---

## Dependencies

| Package | Role |
|---------|------|
| [`@github/copilot-sdk`](https://www.npmjs.com/package/@github/copilot-sdk) `0.1.32` | Copilot client — session management, model listing, prompt dispatch |
| [`@github/copilot`](https://www.npmjs.com/package/@github/copilot) | Copilot CLI binary (bundled, installed transitively via the SDK) |

---

## Billing

Each prompt counts against your Copilot premium request quota. The model dropdown shows each model's cost multiplier (e.g. `(0x)` = free/included, `(1x)` = one premium request). See [Requests in GitHub Copilot](https://docs.github.com/en/copilot/concepts/billing/copilot-requests) for details.

---

## License

ISC

Icon derived from [primer/octicons](https://github.com/primer/octicons) — MIT License © GitHub, Inc.
