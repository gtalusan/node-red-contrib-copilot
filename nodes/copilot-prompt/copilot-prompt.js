'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { fileTypeFromBuffer } = require('file-type');

const DEFAULT_MODEL = 'gpt-4.1';
const DEFAULT_TIMEOUT = 60000;
const DEFAULT_SESSION_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes

/**
 * Normalises an attachment descriptor into an SDK-compatible `{ type, path }` object.
 * Binary and base64 payloads are written to temp files; the caller is responsible
 * for deleting them once the session send has completed.
 *
 * Supported input shapes:
 *   { type: 'file',   path: '/abs/path' }               → passed through
 *   { path: '/abs/path' }                                → shorthand for type=file
 *   { type: 'base64', data: '<b64 string>', name: '…' } → decoded to temp file
 *   { type: 'buffer', data: Buffer,         name: '…' } → written to temp file
 *
 * Returns { sdkAttachment, tempFile } where tempFile is the path to clean up (or null).
 */
async function normaliseAttachment(attachment) {
    if (attachment.type === 'file' || (!attachment.type && attachment.path)) {
        return { sdkAttachment: { type: 'file', path: attachment.path }, tempFile: null };
    }

    let buf;
    if (attachment.type === 'base64') {
        buf = Buffer.from(attachment.data, 'base64');
    } else if (attachment.type === 'buffer') {
        buf = attachment.data;
    } else {
        throw new Error(`Unsupported attachment type: "${attachment.type}"`);
    }

    const tmpDir = os.tmpdir();
    const rawName = attachment.name || 'attachment';
    let name = rawName;
    if (!path.extname(rawName)) {
        const detected = await fileTypeFromBuffer(buf);
        if (detected) name = rawName + '.' + detected.ext;
    }
    const tempFile = path.join(tmpDir, `nr-copilot-${Date.now()}-${Math.random().toString(36).slice(2)}-${name}`);
    fs.writeFileSync(tempFile, buf);

    return { sdkAttachment: { type: 'file', path: tempFile, displayName: name }, tempFile };
}

/**
 * Cleans up a list of temp file paths, swallowing any errors.
 */
function cleanupTempFiles(tempFiles) {
    for (const f of tempFiles) {
        try { fs.unlinkSync(f); } catch (_) { /* ignore */ }
    }
}

module.exports = function (RED) {
    function CopilotPromptNode(config) {
        RED.nodes.createNode(this, config);
        this.configNodeId = config.copilotConfig;
        this.model = config.model || DEFAULT_MODEL;
        this.reasoningEffort = config.reasoningEffort || undefined;
        this.timeout = parseInt(config.timeout, 10) || DEFAULT_TIMEOUT;
        this.conversationId = config.conversationId || ''; // '' means use node.id
        const sessionTimeoutMin = parseFloat(config.sessionTimeout);
        this.sessionTimeoutMs = isFinite(sessionTimeoutMin) && sessionTimeoutMin > 0
            ? sessionTimeoutMin * 60 * 1000
            : (sessionTimeoutMin === 0 ? 0 : DEFAULT_SESSION_TIMEOUT_MS);

        // Map of conversationId → { session, timer|null }
        this._sessions = new Map();
        this._statusTimer = null; // clears the green "done" status after 15 s

        const node = this;

        function setStatus(fill, shape, text, autoClearMs) {
            clearTimeout(node._statusTimer);
            node._statusTimer = null;
            node.status({ fill, shape, text });
            if (autoClearMs) {
                node._statusTimer = setTimeout(() => node.status({}), autoClearMs);
            }
        }

        // Show yellow "auth required" if the config node has no token yet.
        // Runs after a short delay so config nodes have time to fully register.
        function checkAuthStatus() {
            const cfg = RED.nodes.getNode(node.configNodeId);
            if (cfg && !cfg.hasToken()) {
                setStatus('yellow', 'ring', 'auth required');
            }
        }
        setTimeout(checkAuthStatus, 500);

        // Destroy a single session entry and clear its idle timer.
        async function destroySession(key) {
            const entry = node._sessions.get(key);
            if (!entry) return;
            node._sessions.delete(key);
            clearTimeout(entry.timer);
            try { await entry.session.destroy(); } catch (_) { /* ignore */ }
        }

        // Arm (or re-arm) the idle timer for a session.
        function armTimer(key) {
            if (node.sessionTimeoutMs === 0) return null;
            return setTimeout(() => destroySession(key), node.sessionTimeoutMs);
        }

        this.on('close', async (doneCb) => {
            clearTimeout(node._statusTimer);
            const keys = [...node._sessions.keys()];
            await Promise.all(keys.map(destroySession));
            doneCb();
        });

        this.on('input', async function (msg, send, done) {
            // Support both old (1-arg send) and new (2-arg) Node-RED APIs
            send = send || function () { node.send.apply(node, arguments); };
            done = done || function (err) { if (err) { node.error(err, msg); } };

            // Resolve the conversation key: msg > node config > node.id
            const convKey = msg.conversationId || node.conversationId || node.id;

            // msg.reset = true: destroy the session and swallow the message
            if (msg.reset) {
                await destroySession(convKey);
                setStatus('grey', 'ring', 'reset', 15000);
                return done();
            }

            setStatus('blue', 'dot', 'sending…');

            // --- Resolve config node ---
            const configNode = RED.nodes.getNode(node.configNodeId);
            if (!configNode) {
                setStatus('red', 'ring', 'no config');
                const err = new Error('copilot-prompt: no copilot-config node configured');
                send([null, { payload: err.message, error: err, _msgid: msg._msgid }]);
                return done();
            }

            // Fast-fail with yellow if no auth token — avoids waiting 60 s for SDK timeout
            if (!configNode.hasToken()) {
                setStatus('yellow', 'ring', 'auth required');
                const err = new Error('copilot-prompt: no authentication token configured');
                send([null, { payload: err.message, error: err, _msgid: msg._msgid }]);
                return done();
            }

            // --- Parse prompt + attachments from msg ---
            let prompt;
            let rawAttachments = [];

            if (typeof msg.payload === 'string') {
                prompt = msg.payload;
            } else if (msg.payload && typeof msg.payload === 'object') {
                prompt = msg.payload.prompt || '';
                const pa = msg.payload.attachments;
                rawAttachments = Array.isArray(pa) ? pa : (pa ? [pa] : []);
            } else {
                prompt = String(msg.payload || '');
            }

            // msg.attachments can supplement / override
            const ma = msg.attachments;
            if (ma) {
                rawAttachments = rawAttachments.concat(Array.isArray(ma) ? ma : [ma]);
            }

            // Model can be overridden per-message
            const model = msg.model || node.model;

            // --- Normalise attachments ---
            const tempFiles = [];
            let sdkAttachments;
            try {
                const normalised = await Promise.all(rawAttachments.map(a => normaliseAttachment(a)));
                for (const { sdkAttachment, tempFile } of normalised) {
                    if (tempFile) tempFiles.push(tempFile);
                    sdkAttachments = (sdkAttachments || []).concat(sdkAttachment);
                }
                sdkAttachments = sdkAttachments || [];
            } catch (err) {
                cleanupTempFiles(tempFiles);
                node.status({ fill: 'red', shape: 'ring', text: 'attachment error' });
                send([null, { payload: err.message, error: err, _msgid: msg._msgid }]);
                return done();
            }

            // --- Get or create a session for this conversation ---
            let client;
            let session;
            try {
                client = await configNode.getClient();

                let entry = node._sessions.get(convKey);
                if (entry) {
                    // Re-arm the idle timer and reuse the live session
                    clearTimeout(entry.timer);
                    entry.timer = armTimer(convKey);
                    session = entry.session;
                } else {
                    const { approveAll } = await import('@github/copilot-sdk');
                    const sessionConfig = { model, onPermissionRequest: approveAll };
                    if (node.reasoningEffort) sessionConfig.reasoningEffort = node.reasoningEffort;
                    // Pass gitHubToken to session config for per-session authentication (0.3.0+)
                    if (configNode.credentials && configNode.credentials.githubToken) {
                        sessionConfig.gitHubToken = configNode.credentials.githubToken;
                    }
                    session = await client.createSession(sessionConfig);
                    const timer = armTimer(convKey);
                    node._sessions.set(convKey, { session, timer });
                }

                const messageOptions = { prompt };
                if (sdkAttachments.length > 0) {
                    messageOptions.attachments = sdkAttachments;
                }

                const events = [];
                session.on((event) => events.push(event));

                const response = await session.sendAndWait(messageOptions, node.timeout);

                cleanupTempFiles(tempFiles);

                const responseText = response ? response.data.content : '';
                setStatus('green', 'dot', 'done', 15000);

                msg.payload = responseText;
                msg.conversationId = convKey;
                msg.events = events;
                send([msg, null]);
                done();
            } catch (err) {
                cleanupTempFiles(tempFiles);
                // On error, discard the session so the next message starts fresh
                await destroySession(convKey);
                setStatus('red', 'ring', err.message || 'error');
                send([null, { payload: err.message, error: err, _msgid: msg._msgid }]);
                done();
            }
        });
    }

    RED.nodes.registerType('copilot-prompt', CopilotPromptNode);
};
