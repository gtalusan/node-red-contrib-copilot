'use strict';

// @github/copilot-sdk is ESM-only — must be loaded with dynamic import(), not require().
// _sdk.load is exposed so tests can inject a mock without needing proxyquire.
const _sdk = {
    load: () => import('@github/copilot-sdk'),
};

// GitHub OAuth app registered for the Copilot CLI device flow.
const GITHUB_OAUTH_CLIENT_ID = 'Ov23ctDVkRmgkPke0Mmm';
const GITHUB_DEVICE_CODE_URL = 'https://github.com/login/device/code';
const GITHUB_TOKEN_URL = 'https://github.com/login/oauth/access_token';

// _httpPost.fn is exposed so tests can inject a mock without hitting the network.
const _httpPost = {
    fn: function httpPost(url, params) {
        const https = require('https');
        const querystring = require('querystring');
        const body = querystring.stringify(params);
        return new Promise((resolve, reject) => {
            const urlObj = new URL(url);
            const req = https.request({
                hostname: urlObj.hostname,
                path: urlObj.pathname,
                method: 'POST',
                headers: {
                    'Content-Type': 'application/x-www-form-urlencoded',
                    'Accept': 'application/json',
                    'Content-Length': Buffer.byteLength(body),
                },
            }, (res) => {
                let data = '';
                res.on('data', chunk => data += chunk);
                res.on('end', () => {
                    try { resolve(JSON.parse(data)); }
                    catch (e) { reject(new Error('Non-JSON response: ' + data)); }
                });
            });
            req.on('error', reject);
            req.write(body);
            req.end();
        });
    },
};

// Resolve the copilot CLI binary bundled with @github/copilot, which is
// a dependency of @github/copilot-sdk. Using __dirname keeps this reliable
// regardless of how the module is loaded, and works inside Docker volumes.
function resolveBundledCliPath() {
    const path = require('path');
    const fs = require('fs');
    // Walk up from this file through each node_modules search path until we find
    // @github/copilot — works in dev (nested) and flat container installs alike.
    let dir = __dirname;
    while (true) {
        const pkgJsonPath = path.join(dir, 'node_modules', '@github', 'copilot', 'package.json');
        if (fs.existsSync(pkgJsonPath)) {
            try {
                const pkgJson = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf8'));
                const binEntry = pkgJson.bin && (pkgJson.bin.copilot || Object.values(pkgJson.bin)[0]);
                if (binEntry) {
                    const resolved = path.resolve(path.dirname(pkgJsonPath), binEntry);
                    if (fs.existsSync(resolved)) return resolved;
                }
            } catch (_) { /* fall through */ }
        }
        const parent = path.dirname(dir);
        if (parent === dir) break; // reached filesystem root
        dir = parent;
    }
    return 'copilot'; // last resort: assume it's on PATH
}

const BUNDLED_CLI_PATH = resolveBundledCliPath();

// Module-level session map so all route handler closures (which accumulate on
// the same httpAdmin express app across multiple helper.load calls in tests)
// always reference the same live Map rather than stale per-factory closures.
const loginSessions = new Map();

module.exports = function (RED) {
    // Clear any sessions left over from a previous module load (test isolation).
    // In production this factory is called once; in tests it's called per-load.
    loginSessions.clear();
    function CopilotConfigNode(config) {
        RED.nodes.createNode(this, config);
        this.authMethod = config.authMethod || 'oauth'; // 'oauth' | 'token'
        this.cliPath = config.cliPath || undefined;
        this.cliUrl = config.cliUrl || undefined;
        // this.credentials.githubToken populated by Node-RED when authMethod === 'token'
        this._client = null;
        this._startPromise = null;
        this._modelsCache = null;
        this._modelsCacheAt = 0;

        this.on('close', async (done) => {
            if (this._client) {
                try {
                    await this._client.stop();
                } catch (err) {
                    this.warn('Error stopping CopilotClient: ' + err.message);
                }
                this._client = null;
                this._startPromise = null;
                this._modelsCache = null;
                this._modelsCacheAt = 0;
            }
            done();
        });
    }

    /**
     * Returns true if a GitHub token is available for authentication.
     * Used by copilot-prompt to fast-fail with a yellow status instead of
     * waiting 60 s for the SDK timeout.
     */
    CopilotConfigNode.prototype.hasToken = function () {
        return !!(this.credentials && this.credentials.githubToken);
    };

    /**
     * Returns a started CopilotClient, creating and starting it on first call.
     * Subsequent calls return the same client (or wait for it to start).
     * If the underlying CLI process has exited, the client is restarted.
     */
    CopilotConfigNode.prototype.getClient = function () {
        // If the CLI process has exited, discard the stale client so we restart fresh
        if (this._client && this._client.process && this._client.process.exitCode !== null) {
            this._client = null;
            this._startPromise = null;
        }

        if (this._startPromise) {
            return this._startPromise;
        }

        const options = {
            autoStart: false,
            autoRestart: true,
        };

        const token = this.credentials && this.credentials.githubToken;
        if (token) {
            // Token from OAuth flow or PAT — takes priority, disables logged-in user auth
            options.githubToken = token;
            options.useLoggedInUser = false;
        } else {
            // No token configured: try stored CLI credentials (oauth mode) or fail (token mode)
            options.useLoggedInUser = this.authMethod !== 'token';
        }
        if (this.cliPath) {
            options.cliPath = this.cliPath;
        } else if (!this.cliUrl) {
            // Use the bundled CLI binary so the node works without copilot on PATH
            options.cliPath = BUNDLED_CLI_PATH;
        }
        if (this.cliUrl) {
            options.cliUrl = this.cliUrl;
        }

        // Set _startPromise synchronously to prevent duplicate starts on concurrent calls
        this._startPromise = _sdk.load().then(({ CopilotClient }) => {
            this._client = new CopilotClient(options);
            return this._client.start().then(() => this._client);
        });
        return this._startPromise;
    };

    RED.nodes.registerType('copilot-config', CopilotConfigNode, {
        credentials: {
            githubToken: { type: 'password' },
        },
    });

    const MODELS_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

    // POST /copilot/auth/start
    // Starts a GitHub device-flow OAuth session, returning the URL and code
    // for the user to visit. Token polling runs in the background; when the
    // token is received it is stored directly on the config node's credentials.
    RED.httpAdmin.post('/copilot/auth/start', RED.auth.needsPermission('copilot-config.write'), async (req, res) => {
        const nodeId = req.body && req.body.nodeId;
        const sessionId = require('crypto').randomBytes(8).toString('hex');

        let deviceData;
        try {
            deviceData = await _httpPost.fn(GITHUB_DEVICE_CODE_URL, { client_id: GITHUB_OAUTH_CLIENT_ID });
        } catch (err) {
            return res.status(500).json({ error: err.message });
        }
        if (deviceData.error) {
            return res.status(500).json({ error: deviceData.error_description || deviceData.error });
        }

        const session = { done: false, error: null, createdAt: Date.now() };
        loginSessions.set(sessionId, session);
        session.ttlTimer = setTimeout(() => loginSessions.delete(sessionId), 10 * 60 * 1000).unref();

        // Poll GitHub's token endpoint in the background.
        const { device_code, interval = 5, expires_in = 900 } = deviceData;
        (async () => {
            const deadline = Date.now() + expires_in * 1000;
            let pollDelay = interval * 1000;
            while (Date.now() < deadline) {
                await new Promise(r => setTimeout(r, pollDelay).unref());
                // If the session was evicted (e.g., module reloaded in tests), stop.
                if (!loginSessions.has(sessionId)) return;
                let result;
                try {
                    result = await _httpPost.fn(GITHUB_TOKEN_URL, {
                        client_id: GITHUB_OAUTH_CLIENT_ID,
                        device_code,
                        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
                    });
                } catch (err) {
                    session.error = err.message;
                    session.done = true;
                    return;
                }
                if (result.access_token) {
                    // Store token in session so the poll response can return it to the
                    // browser, which will then write it into the credential form field.
                    // This is the reliable persistence path: Node-RED's normal credential
                    // save flow (triggered by clicking Done) includes the field value and
                    // encrypts+saves it to disk, surviving restarts and subsequent deploys.
                    session.token = result.access_token;
                    if (nodeId) {
                        const configNode = RED.nodes.getNode(nodeId);
                        if (configNode) {
                            // Also update in-memory credentials so the node can use the
                            // token immediately without waiting for a save+reload cycle.
                            if (!configNode.credentials) configNode.credentials = {};
                            configNode.credentials.githubToken = result.access_token;
                            RED.nodes.addCredentials(nodeId, { githubToken: result.access_token });
                            // Reset client and models cache so next use picks up the new token
                            configNode._client = null;
                            configNode._startPromise = null;
                            configNode._modelsCache = null;
                            configNode._modelsCacheAt = 0;
                        }
                    }
                    session.done = true;
                    return;
                }
                if (result.error === 'slow_down') pollDelay += 5000;
                if (result.error !== 'authorization_pending') {
                    session.error = result.error_description || result.error || 'Unknown error';
                    session.done = true;
                    return;
                }
            }
            session.error = 'Authorization timed out';
            session.done = true;
        })();

        res.json({ sessionId, url: deviceData.verification_uri, code: deviceData.user_code });
    });

    // GET /copilot/auth/poll/:sessionId
    // Returns { done, error } so the browser can tell when login has completed.
    RED.httpAdmin.get('/copilot/auth/poll/:sessionId', RED.auth.needsPermission('copilot-config.read'), (req, res) => {
        const session = loginSessions.get(req.params.sessionId);
        if (!session) return res.status(404).json({ error: 'Session not found' });
        if (session.done) {
            clearTimeout(session.ttlTimer);
            loginSessions.delete(req.params.sessionId);
        }
        // Return the token on success so the browser can persist it via the
        // normal Node-RED credential form flow (set into the password field,
        // saved when user clicks Done).
        res.json({ done: session.done, error: session.error || null, token: session.token || null });
    });

    // Admin endpoint: GET /copilot/models?configId=<id>
    // Used by the prompt node editor to populate the model dropdown dynamically.
    // Results are cached on the config node for MODELS_CACHE_TTL_MS to avoid
    // hitting the SDK on every editor open.
    RED.httpAdmin.get('/copilot/models', RED.auth.needsPermission('copilot-config.read'), async (req, res) => {
        const configNode = RED.nodes.getNode(req.query.configId);
        if (!configNode) {
            return res.status(404).json({ error: 'Config node not found' });
        }
        const now = Date.now();
        if (configNode._modelsCache && (now - configNode._modelsCacheAt) < MODELS_CACHE_TTL_MS) {
            return res.json(configNode._modelsCache);
        }
        try {
            const client = await configNode.getClient();
            const models = await client.listModels();
            configNode._modelsCache = models.map(m => ({
                id: m.id,
                multiplier: m.billing ? m.billing.multiplier : null,
            }));
            configNode._modelsCacheAt = now;
            res.json(configNode._modelsCache);
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    // POST /copilot/models/refresh?configId=<id>
    // Busts the models cache so the next GET /copilot/models fetches fresh data.
    // Called by the Refresh button in the prompt node editor.
    RED.httpAdmin.post('/copilot/models/refresh', RED.auth.needsPermission('copilot-config.write'), (req, res) => {
        const configNode = RED.nodes.getNode(req.query.configId);
        if (!configNode) {
            return res.status(404).json({ error: 'Config node not found' });
        }
        configNode._modelsCache = null;
        configNode._modelsCacheAt = 0;
        res.json({ ok: true });
    });
};

// Exposed for testing — allows injecting mocks without proxyquire
module.exports._sdk = _sdk;
module.exports._httpPost = _httpPost;
