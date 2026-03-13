'use strict';

// @github/copilot-sdk is ESM-only — must be loaded with dynamic import(), not require().
// _sdk.load is exposed so tests can inject a mock without needing proxyquire.
const _sdk = {
    load: () => import('@github/copilot-sdk'),
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

module.exports = function (RED) {
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
     * Returns a started CopilotClient, creating and starting it on first call.
     * Subsequent calls return the same client (or wait for it to start).
     */
    CopilotConfigNode.prototype.getClient = function () {
        if (this._startPromise) {
            return this._startPromise;
        }

        const options = {
            autoStart: false,
            autoRestart: true,
        };

        const token = this.credentials && this.credentials.githubToken;
        if (this.authMethod === 'token' && token) {
            // PAT fallback — explicit token takes priority, disables logged-in user auth
            options.githubToken = token;
            options.useLoggedInUser = false;
        } else {
            // Primary: use GitHub OAuth credentials stored by the Copilot CLI (gh auth)
            options.useLoggedInUser = true;
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
};

// Exposed for testing — allows injecting a mock SDK without proxyquire
module.exports._sdk = _sdk;
