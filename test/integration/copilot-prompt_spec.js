'use strict';

/**
 * Integration tests — make real calls to the GitHub Copilot API.
 * Requires GITHUB_TOKEN env var. All tests are skipped when it is absent.
 * Uses gpt-4o-mini (cheapest available model) to minimise token spend.
 */

const helper = require('node-red-node-test-helper');
const copilotConfigModule = require('../../nodes/copilot-config/copilot-config');
const copilotPromptModule = require('../../nodes/copilot-prompt/copilot-prompt');
const fs = require('fs');
const path = require('path');

helper.init(require.resolve('node-red'));

const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const MODEL = 'claude-haiku-4.5';
const TIMEOUT = 90000;

// Skip entire suite if no token provided
(GITHUB_TOKEN ? describe : describe.skip)('copilot-prompt integration', function () {
    this.timeout(TIMEOUT);

    before(function (done) { helper.startServer(done); });
    after(function (done) { helper.stopServer(done); });
    afterEach(function (done) {
        helper.unload().then(done).catch(done);
    });

    function buildFlow(model) {
        return [
            { id: 'cfg1', type: 'copilot-config', name: 'Integration Config', authMethod: 'token' },
            {
                id: 'n1',
                type: 'copilot-prompt',
                copilotConfig: 'cfg1',
                model: model || MODEL,
                timeout: TIMEOUT - 5000,
                wires: [['out1'], ['err1']],
            },
            { id: 'out1', type: 'helper' },
            { id: 'err1', type: 'helper' },
        ];
    }

    it('returns a response to a simple prompt', function (done) {
        helper.load(
            [copilotConfigModule, copilotPromptModule],
            buildFlow(),
            { cfg1: { githubToken: GITHUB_TOKEN } },
            function () {
                const out = helper.getNode('out1');
                const err = helper.getNode('err1');

                err.on('input', function (msg) {
                    done(new Error('Got error output: ' + msg.payload));
                });

                out.on('input', function (msg) {
                    msg.payload.should.be.a.String().and.not.empty();
                    msg.should.have.property('sessionId');
                    msg.should.have.property('events').which.is.an.Array();
                    done();
                });

                helper.getNode('n1').receive({ payload: 'Reply with only the word PONG' });
            }
        );
    });

    it('response contains expected keyword for a constrained prompt', function (done) {
        helper.load(
            [copilotConfigModule, copilotPromptModule],
            buildFlow(),
            { cfg1: { githubToken: GITHUB_TOKEN } },
            function () {
                const out = helper.getNode('out1');
                const err = helper.getNode('err1');

                err.on('input', function (msg) {
                    done(new Error('Got error output: ' + msg.payload));
                });

                out.on('input', function (msg) {
                    const text = msg.payload.toUpperCase();
                    text.should.containEql('PONG');
                    done();
                });

                helper.getNode('n1').receive({
                    payload: 'Reply with only the single word PONG and nothing else.',
                });
            }
        );
    });

    it('handles a file attachment (test fixture PNG)', function (done) {
        const fixturePath = path.join(__dirname, '..', 'fixtures', 'test.png');

        helper.load(
            [copilotConfigModule, copilotPromptModule],
            buildFlow(),
            { cfg1: { githubToken: GITHUB_TOKEN } },
            function () {
                const out = helper.getNode('out1');
                const err = helper.getNode('err1');

                err.on('input', function (msg) {
                    done(new Error('Got error output: ' + msg.payload));
                });

                out.on('input', function (msg) {
                    msg.payload.should.be.a.String().and.not.empty();
                    done();
                });

                helper.getNode('n1').receive({
                    payload: 'Describe what you see in this image in one sentence.',
                    attachments: [{ type: 'file', path: fixturePath }],
                });
            }
        );
    });

    it('handles a base64 attachment', function (done) {
        const fixturePath = path.join(__dirname, '..', 'fixtures', 'test.png');
        const b64 = fs.readFileSync(fixturePath).toString('base64');

        helper.load(
            [copilotConfigModule, copilotPromptModule],
            buildFlow(),
            { cfg1: { githubToken: GITHUB_TOKEN } },
            function () {
                const out = helper.getNode('out1');
                const err = helper.getNode('err1');

                err.on('input', function (msg) {
                    done(new Error('Got error output: ' + msg.payload));
                });

                out.on('input', function (msg) {
                    msg.payload.should.be.a.String().and.not.empty();
                    done();
                });

                helper.getNode('n1').receive({
                    payload: 'Describe what you see in this image.',
                    attachments: [{ type: 'base64', data: b64, name: 'test.png' }],
                });
            }
        );
    });

    it('model can be overridden per-message via msg.model', function (done) {
        helper.load(
            [copilotConfigModule, copilotPromptModule],
            buildFlow('claude-haiku-4.5'),   // node default
            { cfg1: { githubToken: GITHUB_TOKEN } },
            function () {
                const out = helper.getNode('out1');
                const err = helper.getNode('err1');

                err.on('input', function (msg) {
                    done(new Error('Got error output: ' + msg.payload));
                });

                out.on('input', function (msg) {
                    msg.payload.should.be.a.String().and.not.empty();
                    done();
                });

                helper.getNode('n1').receive({
                    payload: 'Reply with only the word PONG',
                    model: 'claude-haiku-4.5', // override — same model, just testing the path
                });
            }
        );
    });
});
