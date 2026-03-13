# node-red-contrib-copilot

![node-red-contrib-copilot](https://img.shields.io/npm/v/node-red-contrib-copilot?label=npm)
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

**Node.js v24** is required. The `@github/copilot` CLI binary bundled with the SDK is a native binary that requires a glibc-based (non-musl) environment.

---

## Docker

The recommended container is:

```
nodered/node-red-dev:5.0.0-beta.3-debian
```

This image provides:
- Node-RED 5.0 (beta)
- **Node.js v24** — required by the bundled Copilot CLI binary
- **Debian (glibc)** — the CLI binary is dynamically linked against glibc; Alpine (musl) is **not** supported

### Quick start

```bash
docker run -d \
  --name nodered \
  -p 1880:1880 \
  -v /your/data:/data \
  nodered/node-red-dev:5.0.0-beta.3-debian
```

---

## Installation

### Via the Node-RED Palette Manager

Search for `node-red-contrib-copilot` in the Palette Manager and click **Install**.

### Via npm (inside your Node-RED data directory)

```bash
cd /your/node-red/data
npm install node-red-contrib-copilot
```

### In Docker

```bash
docker exec nodered npm install node-red-contrib-copilot --prefix /data
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
| `msg.attachments` | `Attachment[]` | Merged with any attachments in `msg.payload` |
| `msg.model` | `string` | Override the model for this message only |

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
| | `msg.sessionId` | `string` | Copilot session ID |
| | `msg.events` | `array` | All events emitted during the session |
| **2 — Error** | `msg.payload` | `string` | Error message |
| | `msg.error` | `Error` | The error object |

#### Node configuration

| Field | Description |
|-------|-------------|
| **Config** | Select a `copilot-config` node |
| **Model** | Dynamically populated from the API — shows token cost multiplier, e.g. `claude-haiku-4.5 (0x)` |
| **Reasoning** | Reasoning effort hint: `low`, `medium`, `high`, `xhigh` (model-dependent) |
| **Timeout** | Request timeout in milliseconds (default: 60,000) |

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

The example flow used in this README is included in the repository: [copilot-test-flow.json](./copilot-test-flow.json)


---

## Development

```bash
git clone https://github.com/yourname/node-red-contrib-copilot
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
cp node-red-contrib-copilot-*.tgz ~/your/node-red/data/
docker exec nodered npm install /data/node-red-contrib-copilot-*.tgz --prefix /data
docker restart nodered
```

---

## Dependencies

| Package | Role |
|---------|------|
| [`@github/copilot-sdk`](https://www.npmjs.com/package/@github/copilot-sdk) `0.1.30` | Copilot client — session management, model listing, prompt dispatch |
| [`@github/copilot`](https://www.npmjs.com/package/@github/copilot) | Copilot CLI binary (bundled, installed transitively via the SDK) |

---

## Billing

Each prompt counts against your Copilot premium request quota. The model dropdown shows each model's cost multiplier (e.g. `(0x)` = free/included, `(1x)` = one premium request). See [Requests in GitHub Copilot](https://docs.github.com/en/copilot/concepts/billing/copilot-requests) for details.

---

## License

ISC

Icon derived from [primer/octicons](https://github.com/primer/octicons) — MIT License © GitHub, Inc.
