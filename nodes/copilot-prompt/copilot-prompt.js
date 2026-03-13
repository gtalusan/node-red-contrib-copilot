'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const DEFAULT_MODEL = 'claude-haiku-4.5';
const DEFAULT_TIMEOUT = 60000;

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
    const name = attachment.name || 'attachment';
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

        const node = this;

        this.on('input', async function (msg, send, done) {
            // Support both old (1-arg send) and new (2-arg) Node-RED APIs
            send = send || function () { node.send.apply(node, arguments); };
            done = done || function (err) { if (err) { node.error(err, msg); } };

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
                rawAttachments = msg.payload.attachments || [];
            } else {
                prompt = String(msg.payload || '');
            }

            // msg.attachments can supplement / override
            if (Array.isArray(msg.attachments)) {
                rawAttachments = rawAttachments.concat(msg.attachments);
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

            // --- Build session config ---
            const { approveAll } = await import('@github/copilot-sdk');
            const sessionConfig = { model, onPermissionRequest: approveAll };
            if (node.reasoningEffort) {
                sessionConfig.reasoningEffort = node.reasoningEffort;
            }

            // --- Send to Copilot ---
            let client;
            let session;
            try {
                client = await configNode.getClient();
                session = await client.createSession(sessionConfig);

                const messageOptions = { prompt };
                if (sdkAttachments.length > 0) {
                    messageOptions.attachments = sdkAttachments;
                }

                const events = [];
                session.on((event) => events.push(event));

                const response = await session.sendAndWait(messageOptions, node.timeout);

                cleanupTempFiles(tempFiles);
                await session.destroy();

                const responseText = response ? response.data.content : '';
                node.status({ fill: 'green', shape: 'dot', text: 'done' });

                msg.payload = responseText;
                msg.sessionId = session.sessionId;
                msg.events = events;
                send([msg, null]);
                done();
            } catch (err) {
                cleanupTempFiles(tempFiles);
                if (session) {
                    try { await session.destroy(); } catch (_) { /* ignore */ }
                }
                node.status({ fill: 'red', shape: 'ring', text: 'error' });
                send([null, { payload: err.message, error: err, _msgid: msg._msgid }]);
                done();
            }
        });
    }

    RED.nodes.registerType('copilot-prompt', CopilotPromptNode);
};
