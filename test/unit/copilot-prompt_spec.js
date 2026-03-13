'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const helper = require('node-red-node-test-helper');
const sinon = require('sinon');

helper.init(require.resolve('node-red'));

// Load real modules — mocking via the _sdk seam on the config module
const copilotConfigModule = require('../../nodes/copilot-config/copilot-config');
const copilotPromptModule = require('../../nodes/copilot-prompt/copilot-prompt');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const mockState = { constructorArgs: [] };

function FakeCopilotClient(options) {
    mockState.constructorArgs.push(options);
    return mockState.currentInstance;
}

function buildSession(responseContent = 'Hello from Copilot') {
    const sessionId = 'sess-' + Math.random().toString(36).slice(2);
    const session = {
        sessionId,
        on: sinon.stub().returns(() => {}),
        sendAndWait: sinon.stub().resolves({ type: 'assistant.message', data: { content: responseContent } }),
        destroy: sinon.stub().resolves(),
    };
    return session;
}

function buildClientInstance(session) {
    mockState.constructorArgs = [];
    mockState.currentInstance = {
        start: sinon.stub().resolves(),
        stop: sinon.stub().resolves([]),
        createSession: sinon.stub().resolves(session),
    };
    // Inject mock SDK
    copilotConfigModule._sdk.load = () => Promise.resolve({ CopilotClient: FakeCopilotClient });
    return mockState.currentInstance;
}

function buildFlow(promptConfig = {}) {
    return [
        { id: 'cfg1', type: 'copilot-config', name: 'Test Config' },
        {
            id: 'n1',
            type: 'copilot-prompt',
            name: 'Test Prompt',
            copilotConfig: 'cfg1',
            model: promptConfig.model || 'gpt-4o-mini',
            reasoningEffort: promptConfig.reasoningEffort || '',
            timeout: promptConfig.timeout || 10000,
            wires: [['out1'], ['err1']],
        },
        { id: 'out1', type: 'helper' },
        { id: 'err1', type: 'helper' },
    ];
}

// ---------------------------------------------------------------------------

describe('copilot-prompt node', function () {
    before(function (done) { helper.startServer(done); });
    after(function (done) { helper.stopServer(done); });
    afterEach(function (done) {
        helper.unload().then(() => { sinon.restore(); done(); }).catch(done);
    });

    // ---- Basic message handling ----

    it('loads correctly', function (done) {
        const session = buildSession();
        buildClientInstance(session);
        helper.load([copilotConfigModule, copilotPromptModule], buildFlow(), { cfg1: { githubToken: 'tok' } }, function () {
            const n = helper.getNode('n1');
            n.should.have.property('name', 'Test Prompt');
            done();
        });
    });

    it('sends a string payload as a prompt and emits the response on output 1', function (done) {
        const session = buildSession('The answer is 42');
        buildClientInstance(session);
        helper.load([copilotConfigModule, copilotPromptModule], buildFlow(), { cfg1: { githubToken: 'tok' } }, function () {
            const n = helper.getNode('n1');
            const out = helper.getNode('out1');
            out.on('input', function (msg) {
                msg.payload.should.equal('The answer is 42');
                msg.should.have.property('sessionId', session.sessionId);
                msg.should.have.property('events').which.is.an.Array();
                done();
            });
            n.receive({ payload: 'What is 6 × 7?' });
        });
    });

    it('sends an object payload { prompt, attachments } correctly', function (done) {
        const session = buildSession('Object prompt response');
        buildClientInstance(session);
        helper.load([copilotConfigModule, copilotPromptModule], buildFlow(), { cfg1: { githubToken: 'tok' } }, function () {
            const n = helper.getNode('n1');
            const out = helper.getNode('out1');
            out.on('input', function () {
                const call = session.sendAndWait.firstCall.args[0];
                call.should.have.property('prompt', 'Describe this');
                done();
            });
            n.receive({ payload: { prompt: 'Describe this', attachments: [] } });
        });
    });

    it('uses the model configured on the node', function (done) {
        const session = buildSession();
        const client = buildClientInstance(session);        helper.load([copilotConfigModule, copilotPromptModule], buildFlow({ model: 'gpt-4o-mini' }), { cfg1: { githubToken: 'tok' } }, function () {
            const n = helper.getNode('n1');
            const out = helper.getNode('out1');
            out.on('input', function () {
                const sessionCfg = client.createSession.firstCall.args[0];
                sessionCfg.should.have.property('model', 'gpt-4o-mini');
                done();
            });
            n.receive({ payload: 'test' });
        });
    });

    it('overrides model from msg.model', function (done) {
        const session = buildSession();
        const client = buildClientInstance(session);
        helper.load([copilotConfigModule, copilotPromptModule], buildFlow({ model: 'gpt-4o-mini' }), { cfg1: { githubToken: 'tok' } }, function () {
            const n = helper.getNode('n1');
            const out = helper.getNode('out1');
            out.on('input', function () {
                const sessionCfg = client.createSession.firstCall.args[0];
                sessionCfg.should.have.property('model', 'gpt-5');
                done();
            });
            n.receive({ payload: 'test', model: 'gpt-5' });
        });
    });

    // ---- Attachment handling ----

    it('passes a file-path attachment directly to the SDK', function (done) {
        const session = buildSession();
        buildClientInstance(session);
        helper.load([copilotConfigModule, copilotPromptModule], buildFlow(), { cfg1: { githubToken: 'tok' } }, function () {
            const n = helper.getNode('n1');
            const out = helper.getNode('out1');
            out.on('input', function () {
                const call = session.sendAndWait.firstCall.args[0];
                call.attachments[0].should.deepEqual({ type: 'file', path: '/tmp/test.png' });
                done();
            });
            n.receive({ payload: 'describe', attachments: [{ type: 'file', path: '/tmp/test.png' }] });
        });
    });

    it('accepts shorthand { path } attachment (no type field)', function (done) {
        const session = buildSession();
        buildClientInstance(session);
        helper.load([copilotConfigModule, copilotPromptModule], buildFlow(), { cfg1: { githubToken: 'tok' } }, function () {
            const n = helper.getNode('n1');
            const out = helper.getNode('out1');
            out.on('input', function () {
                const call = session.sendAndWait.firstCall.args[0];
                call.attachments[0].should.have.property('type', 'file');
                call.attachments[0].should.have.property('path', '/tmp/img.jpg');
                done();
            });
            n.receive({ payload: 'describe', attachments: [{ path: '/tmp/img.jpg' }] });
        });
    });

    it('writes a base64 attachment to a temp file and cleans it up', function (done) {
        const session = buildSession();
        buildClientInstance(session);
        const pngFixture = fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'test.png'));
        const b64 = pngFixture.toString('base64');

        helper.load([copilotConfigModule, copilotPromptModule], buildFlow(), { cfg1: { githubToken: 'tok' } }, function () {
            const n = helper.getNode('n1');
            const out = helper.getNode('out1');
            out.on('input', function () {
                const call = session.sendAndWait.firstCall.args[0];
                const att = call.attachments[0];
                att.should.have.property('type', 'file');
                // The temp file should have been written and then deleted
                fs.existsSync(att.path).should.be.false();
                // But it should contain the right extension hint
                att.path.should.containEql('test.png');
                done();
            });
            n.receive({ payload: 'what is this?', attachments: [{ type: 'base64', data: b64, name: 'test.png' }] });
        });
    });

    it('writes a Buffer attachment to a temp file and cleans it up', function (done) {
        const session = buildSession();
        buildClientInstance(session);
        const buf = fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'test.png'));

        helper.load([copilotConfigModule, copilotPromptModule], buildFlow(), { cfg1: { githubToken: 'tok' } }, function () {
            const n = helper.getNode('n1');
            const out = helper.getNode('out1');
            out.on('input', function () {
                const call = session.sendAndWait.firstCall.args[0];
                const att = call.attachments[0];
                att.should.have.property('type', 'file');
                fs.existsSync(att.path).should.be.false();
                att.path.should.containEql('image.bin');
                done();
            });
            n.receive({ payload: 'describe', attachments: [{ type: 'buffer', data: buf, name: 'image.bin' }] });
        });
    });

    it('merges attachments from payload.attachments and msg.attachments', function (done) {
        const session = buildSession();
        buildClientInstance(session);
        helper.load([copilotConfigModule, copilotPromptModule], buildFlow(), { cfg1: { githubToken: 'tok' } }, function () {
            const n = helper.getNode('n1');
            const out = helper.getNode('out1');
            out.on('input', function () {
                const call = session.sendAndWait.firstCall.args[0];
                call.attachments.length.should.equal(2);
                done();
            });
            n.receive({
                payload: { prompt: 'describe both', attachments: [{ type: 'file', path: '/a.png' }] },
                attachments: [{ type: 'file', path: '/b.png' }],
            });
        });
    });

    // ---- Error handling ----

    it('routes to output 2 when no config node is found', function (done) {
        // Build flow with a broken config ref
        const flow = [
            { id: 'n1', type: 'copilot-prompt', copilotConfig: 'nonexistent', wires: [['out1'], ['err1']] },
            { id: 'out1', type: 'helper' },
            { id: 'err1', type: 'helper' },
        ];
        buildClientInstance(buildSession());
        helper.load(copilotPromptModule, flow, function () {
            const n = helper.getNode('n1');
            const err = helper.getNode('err1');
            err.on('input', function (msg) {
                msg.should.have.property('error');
                done();
            });
            n.receive({ payload: 'hello' });
        });
    });

    it('routes to output 2 when the SDK throws', function (done) {
        const session = buildSession();
        session.sendAndWait.rejects(new Error('SDK boom'));
        buildClientInstance(session);
        helper.load([copilotConfigModule, copilotPromptModule], buildFlow(), { cfg1: { githubToken: 'tok' } }, function () {
            const n = helper.getNode('n1');
            const err = helper.getNode('err1');
            err.on('input', function (msg) {
                msg.payload.should.equal('SDK boom');
                msg.should.have.property('error');
                done();
            });
            n.receive({ payload: 'will fail' });
        });
    });

    it('routes to output 2 for an unsupported attachment type', function (done) {
        buildClientInstance(buildSession());
        helper.load([copilotConfigModule, copilotPromptModule], buildFlow(), { cfg1: { githubToken: 'tok' } }, function () {
            const n = helper.getNode('n1');
            const err = helper.getNode('err1');
            err.on('input', function (msg) {
                msg.payload.should.containEql('Unsupported attachment type');
                done();
            });
            n.receive({ payload: 'test', attachments: [{ type: 'unsupported', data: 'x' }] });
        });
    });
});
