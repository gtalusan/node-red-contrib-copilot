'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const DEFAULT_MODEL = 'gpt-4.1';
const DEFAULT_TIMEOUT = 60000;
const DEFAULT_SESSION_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes

/**
 * Sniffs the file extension from a base64 string or Buffer by checking magic bytes.
 * Returns e.g. '.jpg', '.png', '.gif', '.webp', '.pdf', or '' if unknown.
 */
function guessExtension(attachment) {
    let buf;
    if (attachment.type === 'base64' && attachment.data) {
        buf = Buffer.from(attachment.data.slice(0, 16), 'base64');
    } else if (attachment.type === 'buffer' && Buffer.isBuffer(attachment.data)) {
        buf = attachment.data.slice(0, 16);
    } else {
        return '';
    }
    if (buf[0] === 0xFF && buf[1] === 0xD8) return '.jpg';
    if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4E && buf[3] === 0x47) return '.png';
    if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) return '.gif';
    if (buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46) return '.webp';
    if (buf[0] === 0x25 && buf[1] === 0x50 && buf[2] === 0x44 && buf[3] === 0x46) return '.pdf';
    return '';
}

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
function normaliseAttachment(attachment) {
    if (attachment.type === 'file' || (!attachment.type && attachment.path)) {
        return { sdkAttachment: { type: 'file', path: attachment.path }, tempFile: null };
    }

    const tmpDir = os.tmpdir();
    const rawName = attachment.name || 'attachment';
    // If the name has no extension, sniff the format from magic bytes / base64 header
    const name = path.extname(rawName) ? rawName : rawName + guessExtension(attachment);
    const tempFile = path.join(tmpDir, `nr-copilot-${Date.now()}-${Math.random().toString(36).slice(2)}-${name}`);

    if (attachment.type === 'base64') {
        fs.writeFileSync(tempFile, Buffer.from(attachment.data, 'base64'));
    } else if (attachment.type === 'buffer') {
        fs.writeFileSync(tempFile, attachment.data);
    } else {
        throw new Error(`Unsupported attachment type: "${attachment.type}"`);
    }

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

        const node = this;

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

        this.on('close', async (done) => {
            const keys = [...node._sessions.keys()];
            await Promise.all(keys.map(destroySession));
            done();
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
                node.status({ fill: 'grey', shape: 'ring', text: 'reset' });
                return done();
            }

            node.status({ fill: 'blue', shape: 'dot', text: 'sending…' });

            // --- Resolve config node ---
            const configNode = RED.nodes.getNode(node.configNodeId);
            if (!configNode) {
                node.status({ fill: 'red', shape: 'ring', text: 'no config' });
                const err = new Error('copilot-prompt: no copilot-config node configured');
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
                sdkAttachments = rawAttachments.map((a) => {
                    const { sdkAttachment, tempFile } = normaliseAttachment(a);
                    if (tempFile) tempFiles.push(tempFile);
                    return sdkAttachment;
                });
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
                node.status({ fill: 'green', shape: 'dot', text: 'done' });

                msg.payload = responseText;
                msg.conversationId = convKey;
                msg.events = events;
                send([msg, null]);
                done();
            } catch (err) {
                cleanupTempFiles(tempFiles);
                // On error, discard the session so the next message starts fresh
                await destroySession(convKey);
                node.status({ fill: 'red', shape: 'ring', text: 'error' });
                send([null, { payload: err.message, error: err, _msgid: msg._msgid }]);
                done();
            }
        });
    }

    RED.nodes.registerType('copilot-prompt', CopilotPromptNode);
};
