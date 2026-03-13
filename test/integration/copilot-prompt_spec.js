'use strict';

/**
 * Integration tests — make real calls to the GitHub Copilot API.
 * Requires GITHUB_TOKEN env var. All tests are skipped when it is absent.
 * Uses a low-cost model to minimise token spend.
 *
 * The flow is loaded once for the whole suite so the CLI starts only once,
 * keeping the total wall-clock time well under a minute.
 */

const helper = require('node-red-node-test-helper');
const copilotConfigModule = require('../../nodes/copilot-config/copilot-config');
const copilotPromptModule = require('../../nodes/copilot-prompt/copilot-prompt');
const fs = require('fs');
const path = require('path');

helper.init(require.resolve('node-red'));

const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const MODEL = 'gpt-4.1';
const TIMEOUT = 90000;

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

// Skip entire suite if no token provided
(GITHUB_TOKEN ? describe : describe.skip)('copilot-prompt integration', function () {
    this.timeout(TIMEOUT);

    // Load once — CLI starts here, reused for all tests
    before(function (done) {
        helper.startServer(() => {
            helper.load(
                [copilotConfigModule, copilotPromptModule],
                buildFlow(),
                { cfg1: { githubToken: GITHUB_TOKEN } },
                done
            );
        });
    });

    after(function (done) {
        helper.unload().then(() => helper.stopServer(done)).catch(done);
    });

    // Helper: send a message and collect the first output, failing on error output
    function send(msg, cb) {
        const out = helper.getNode('out1');
        const err = helper.getNode('err1');
        function cleanup() {
            out.removeAllListeners('input');
            err.removeAllListeners('input');
        }
        out.once('input', function (m) { cleanup(); cb(null, m); });
        err.once('input', function (m) { cleanup(); cb(new Error('Error output: ' + m.payload)); });
        helper.getNode('n1').receive(msg);
    }

    it('returns a response to a simple prompt', function (done) {
        send({ payload: 'Reply with only the word PONG', conversationId: 'test-1' }, function (err, msg) {
            if (err) return done(err);
            msg.payload.should.be.a.String().and.not.empty();
            msg.should.have.property('conversationId', 'test-1');
            msg.should.have.property('events').which.is.an.Array();
            done();
        });
    });

    it('response contains expected keyword for a constrained prompt', function (done) {
        send({ payload: 'Reply with only the single word PONG and nothing else.', conversationId: 'test-2' }, function (err, msg) {
            if (err) return done(err);
            msg.payload.toUpperCase().should.containEql('PONG');
            done();
        });
    });

    it('handles a file attachment (test fixture PNG)', function (done) {
        const fixturePath = path.join(__dirname, '..', 'fixtures', 'test.png');
        send({
            payload: 'What colour is the shape in this image? Reply with only the colour name.',
            attachments: [{ type: 'file', path: fixturePath }],
            conversationId: 'test-3',
        }, function (err, msg) {
            if (err) return done(err);
            msg.payload.toLowerCase().should.containEql('red');
            done();
        });
    });

    it('handles a base64 attachment', function (done) {
        const b64 = fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'test.png')).toString('base64');
        send({
            payload: 'What colour is the shape in this image? Reply with only the colour name.',
            attachments: [{ type: 'base64', data: b64, name: 'test.png' }],
            conversationId: 'test-4',
        }, function (err, msg) {
            if (err) return done(err);
            msg.payload.toLowerCase().should.containEql('red');
            done();
        });
    });

    it('model can be overridden per-message via msg.model', function (done) {
        send({
            payload: 'Reply with only the word PONG',
            model: 'gpt-5-mini', // override to a different model
            conversationId: 'test-5',
        }, function (err, msg) {
            if (err) return done(err);
            msg.payload.should.be.a.String().and.not.empty();
            done();
        });
    });
});

