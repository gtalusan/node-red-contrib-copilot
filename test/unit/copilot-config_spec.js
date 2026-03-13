'use strict';

const helper = require('node-red-node-test-helper');
const sinon = require('sinon');

helper.init(require.resolve('node-red'));

// Load the real module — we inject mocks via the exposed _sdk seam
const copilotConfigModule = require('../../nodes/copilot-config/copilot-config');

// ---------------------------------------------------------------------------
// Mock state — rebuilt per test
// ---------------------------------------------------------------------------
const mockState = {
    instance: null,
    constructorArgs: [],
};

function FakeCopilotClient(options) {
    mockState.constructorArgs.push(options);
    return mockState.instance;
}

function buildMockInstance(modelOverrides) {
    mockState.constructorArgs = [];
    const defaultModels = [
        { id: 'claude-haiku-4.5', billing: { multiplier: 0 } },
        { id: 'claude-sonnet-4.6', billing: { multiplier: 1 } },
        { id: 'gpt-4.1', billing: { multiplier: 1 } },
    ];
    mockState.instance = {
        start: sinon.stub().resolves(),
        stop: sinon.stub().resolves([]),
        createSession: sinon.stub(),
        listModels: sinon.stub().resolves(modelOverrides || defaultModels),
    };
    // Inject the mock SDK loader before each test
    copilotConfigModule._sdk.load = () => Promise.resolve({ CopilotClient: FakeCopilotClient });
    return mockState.instance;
}

// ---------------------------------------------------------------------------

describe('copilot-config node', function () {
    before(function (done) { helper.startServer(done); });
    after(function (done) { helper.stopServer(done); });
    afterEach(function (done) {
        helper.unload().then(() => { sinon.restore(); done(); }).catch(done);
    });

    it('loads with the correct name', function (done) {
        buildMockInstance();
        const flow = [{ id: 'cfg1', type: 'copilot-config', name: 'My Copilot' }];
        helper.load(copilotConfigModule, flow, { cfg1: { githubToken: 'ghp_test' } }, function () {
            const n = helper.getNode('cfg1');
            n.should.have.property('name', 'My Copilot');
            done();
        });
    });

    it('getClient() uses useLoggedInUser=true when authMethod is oauth (default)', function (done) {
        buildMockInstance();
        const flow = [{ id: 'cfg1', type: 'copilot-config', authMethod: 'oauth' }];
        helper.load(copilotConfigModule, flow, {}, async function () {
            const n = helper.getNode('cfg1');
            await n.getClient();
            const opts = mockState.constructorArgs[0];
            opts.should.have.property('useLoggedInUser', true);
            opts.should.not.have.property('githubToken');
            done();
        });
    });

    it('getClient() uses oauth even when no authMethod is set (default behaviour)', function (done) {
        buildMockInstance();
        // No authMethod in config — should default to oauth
        const flow = [{ id: 'cfg1', type: 'copilot-config' }];
        helper.load(copilotConfigModule, flow, {}, async function () {
            const n = helper.getNode('cfg1');
            await n.getClient();
            const opts = mockState.constructorArgs[0];
            opts.should.have.property('useLoggedInUser', true);
            opts.should.not.have.property('githubToken');
            done();
        });
    });

    it('getClient() ignores a stored token when authMethod is oauth', function (done) {
        buildMockInstance();
        // Even if a token credential exists, oauth mode must NOT pass it to the SDK
        const flow = [{ id: 'cfg1', type: 'copilot-config', authMethod: 'oauth' }];
        helper.load(copilotConfigModule, flow, { cfg1: { githubToken: 'ghp_shouldbeignored' } }, async function () {
            const n = helper.getNode('cfg1');
            await n.getClient();
            const opts = mockState.constructorArgs[0];
            opts.should.have.property('useLoggedInUser', true);
            opts.should.not.have.property('githubToken');
            done();
        });
    });

    it('getClient() falls back to oauth when authMethod is token but no token is provided', function (done) {
        buildMockInstance();
        const flow = [{ id: 'cfg1', type: 'copilot-config', authMethod: 'token' }];
        // No credentials provided — should gracefully fall back to oauth
        helper.load(copilotConfigModule, flow, {}, async function () {
            const n = helper.getNode('cfg1');
            await n.getClient();
            const opts = mockState.constructorArgs[0];
            opts.should.have.property('useLoggedInUser', true);
            opts.should.not.have.property('githubToken');
            done();
        });
    });

    it('getClient() creates a CopilotClient with the GitHub token when authMethod is token', function (done) {
        const inst = buildMockInstance();
        const flow = [{ id: 'cfg1', type: 'copilot-config', name: 'Test', authMethod: 'token' }];
        helper.load(copilotConfigModule, flow, { cfg1: { githubToken: 'ghp_abc123' } }, async function () {
            const n = helper.getNode('cfg1');
            const client = await n.getClient();
            mockState.constructorArgs.length.should.equal(1);
            const opts = mockState.constructorArgs[0];
            opts.should.have.property('githubToken', 'ghp_abc123');
            opts.should.have.property('useLoggedInUser', false);
            inst.start.calledOnce.should.be.true();
            client.should.equal(inst);
            done();
        });
    });

    it('getClient() sets cliPath to bundled binary when no cliUrl is given', function (done) {
        buildMockInstance();
        const flow = [{ id: 'cfg1', type: 'copilot-config' }];
        helper.load(copilotConfigModule, flow, { cfg1: { githubToken: 'tok' } }, async function () {
            const n = helper.getNode('cfg1');
            await n.getClient();
            const opts = mockState.constructorArgs[0];
            opts.should.have.property('cliPath');
            opts.cliPath.should.not.equal('copilot'); // resolved to a real path, not fallback
            done();
        });
    });

    it('getClient() returns the same client on repeated calls (singleton)', function (done) {
        const inst = buildMockInstance();
        const flow = [{ id: 'cfg1', type: 'copilot-config' }];
        helper.load(copilotConfigModule, flow, { cfg1: { githubToken: 'tok' } }, async function () {
            const n = helper.getNode('cfg1');
            const c1 = await n.getClient();
            const c2 = await n.getClient();
            c1.should.equal(c2);
            inst.start.calledOnce.should.be.true();
            done();
        });
    });

    it('stops the client when the node is closed', function (done) {
        const inst = buildMockInstance();
        const flow = [{ id: 'cfg1', type: 'copilot-config' }];
        helper.load(copilotConfigModule, flow, { cfg1: { githubToken: 'tok' } }, async function () {
            const n = helper.getNode('cfg1');
            await n.getClient();
            await helper.unload();
            inst.stop.calledOnce.should.be.true();
            done();
        });
    });

    describe('GET /copilot/models', function () {
        it('returns model ids with multipliers for a valid config node', function (done) {
            buildMockInstance();
            const flow = [{ id: 'cfg1', type: 'copilot-config', authMethod: 'token' }];
            helper.load(copilotConfigModule, flow, { cfg1: { githubToken: 'tok' } }, function () {
                helper.request()
                    .get('/copilot/models?configId=cfg1')
                    .expect(200)
                    .end(function (err, res) {
                        if (err) return done(err);
                        res.body.should.be.an.Array();
                        res.body[0].should.have.property('id', 'claude-haiku-4.5');
                        res.body[0].should.have.property('multiplier', 0);
                        res.body[1].should.have.property('id', 'claude-sonnet-4.6');
                        res.body[1].should.have.property('multiplier', 1);
                        done();
                    });
            });
        });

        it('returns 404 when configId is missing or unknown', function (done) {
            buildMockInstance();
            helper.load(copilotConfigModule, [], {}, function () {
                helper.request()
                    .get('/copilot/models?configId=doesnotexist')
                    .expect(404, done);
            });
        });

        it('returns 500 when listModels() throws', function (done) {
            const inst = buildMockInstance();
            inst.listModels.rejects(new Error('API unavailable'));
            const flow = [{ id: 'cfg1', type: 'copilot-config', authMethod: 'token' }];
            helper.load(copilotConfigModule, flow, { cfg1: { githubToken: 'tok' } }, function () {
                helper.request()
                    .get('/copilot/models?configId=cfg1')
                    .expect(500)
                    .end(function (err, res) {
                        if (err) return done(err);
                        res.body.should.have.property('error', 'API unavailable');
                        done();
                    });
            });
        });

        it('handles models with no billing field gracefully (multiplier is null)', function (done) {
            buildMockInstance([{ id: 'unknown-model' }]);
            const flow = [{ id: 'cfg1', type: 'copilot-config', authMethod: 'token' }];
            helper.load(copilotConfigModule, flow, { cfg1: { githubToken: 'tok' } }, function () {
                helper.request()
                    .get('/copilot/models?configId=cfg1')
                    .expect(200)
                    .end(function (err, res) {
                        if (err) return done(err);
                        res.body[0].should.have.property('id', 'unknown-model');
                        res.body[0].should.have.property('multiplier', null);
                        done();
                    });
            });
        });
    });
});
