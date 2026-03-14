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

    it('getClient() uses a stored credential token when authMethod is oauth', function (done) {
        buildMockInstance();
        // Token stored from a prior OAuth flow — should be passed to the SDK
        const flow = [{ id: 'cfg1', type: 'copilot-config', authMethod: 'oauth' }];
        helper.load(copilotConfigModule, flow, { cfg1: { githubToken: 'gho_fromOAuthFlow' } }, async function () {
            const n = helper.getNode('cfg1');
            await n.getClient();
            const opts = mockState.constructorArgs[0];
            opts.should.have.property('githubToken', 'gho_fromOAuthFlow');
            opts.should.have.property('useLoggedInUser', false);
            done();
        });
    });

    it('getClient() uses useLoggedInUser=false when authMethod is token but no token is provided', function (done) {
        buildMockInstance();
        const flow = [{ id: 'cfg1', type: 'copilot-config', authMethod: 'token' }];
        // No credentials — token mode without a token: no auth attempted
        helper.load(copilotConfigModule, flow, {}, async function () {
            const n = helper.getNode('cfg1');
            await n.getClient();
            const opts = mockState.constructorArgs[0];
            opts.should.have.property('useLoggedInUser', false);
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

    it('getClient() restarts a new client when the previous CLI process has exited', function (done) {
        buildMockInstance();
        const flow = [{ id: 'cfg1', type: 'copilot-config' }];
        helper.load(copilotConfigModule, flow, { cfg1: { githubToken: 'tok' } }, async function () {
            const n = helper.getNode('cfg1');
            const c1 = await n.getClient();

            // Simulate a dead CLI process by patching exitCode
            n._client.process = { exitCode: 1 };

            // Build a new mock instance for the restarted client
            buildMockInstance();
            const c2 = await n.getClient();

            // Should have constructed a fresh client, not reused the dead one
            c2.should.not.equal(c1);
            mockState.constructorArgs.length.should.equal(1);
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

        it('returns cached result on second request without calling listModels again', function (done) {
            const inst = buildMockInstance();
            const flow = [{ id: 'cfg1', type: 'copilot-config', authMethod: 'token' }];
            helper.load(copilotConfigModule, flow, { cfg1: { githubToken: 'tok' } }, function () {
                helper.request()
                    .get('/copilot/models?configId=cfg1')
                    .expect(200)
                    .end(function (err) {
                        if (err) return done(err);
                        helper.request()
                            .get('/copilot/models?configId=cfg1')
                            .expect(200)
                            .end(function (err2, res) {
                                if (err2) return done(err2);
                                inst.listModels.calledOnce.should.be.true();
                                res.body[0].should.have.property('id', 'claude-haiku-4.5');
                                done();
                            });
                    });
            });
        });

        it('refreshes cache after TTL expires', function (done) {
            const inst = buildMockInstance();
            const flow = [{ id: 'cfg1', type: 'copilot-config', authMethod: 'token' }];
            helper.load(copilotConfigModule, flow, { cfg1: { githubToken: 'tok' } }, function () {
                const n = helper.getNode('cfg1');
                helper.request()
                    .get('/copilot/models?configId=cfg1')
                    .expect(200)
                    .end(function (err) {
                        if (err) return done(err);
                        // Backdate the cache timestamp to simulate TTL expiry
                        n._modelsCacheAt = Date.now() - (6 * 60 * 1000);
                        helper.request()
                            .get('/copilot/models?configId=cfg1')
                            .expect(200)
                            .end(function (err2) {
                                if (err2) return done(err2);
                                inst.listModels.calledTwice.should.be.true();
                                done();
                            });
                    });
            });
        });
    });

    describe('POST /copilot/models/refresh', function () {
        it('busts the models cache so next GET fetches fresh data', function (done) {
            const inst = buildMockInstance();
            const flow = [{ id: 'cfg1', type: 'copilot-config', authMethod: 'token' }];
            helper.load(copilotConfigModule, flow, { cfg1: { githubToken: 'tok' } }, function () {
                // Warm the cache
                helper.request().get('/copilot/models?configId=cfg1').expect(200).end(function (err) {
                    if (err) return done(err);
                    inst.listModels.calledOnce.should.be.true();

                    // Bust the cache
                    helper.request().post('/copilot/models/refresh?configId=cfg1').expect(200).end(function (err2) {
                        if (err2) return done(err2);

                        // Next GET should call listModels again
                        helper.request().get('/copilot/models?configId=cfg1').expect(200).end(function (err3) {
                            if (err3) return done(err3);
                            inst.listModels.calledTwice.should.be.true();
                            done();
                        });
                    });
                });
            });
        });

        it('returns 404 for unknown configId', function (done) {
            buildMockInstance();
            helper.load(copilotConfigModule, [], {}, function () {
                helper.request()
                    .post('/copilot/models/refresh?configId=doesnotexist')
                    .expect(404, done);
            });
        });
    });

    describe('POST /copilot/auth/start and GET /copilot/auth/poll', function () {
        // Build a mock _httpPost.fn that routes by URL so that stale background
        // polling loops from earlier tests don't consume the device-code slot.
        function buildHttpPostMock(deviceCodeResponse, tokenResponses) {
            let pollCount = 0;
            return function mockHttpPost(url, _params) {
                if (url.includes('device/code')) {
                    return Promise.resolve(deviceCodeResponse);
                }
                // Token polling endpoint
                const resp = tokenResponses[pollCount++] || { error: 'expired_token', error_description: 'expired' };
                return Promise.resolve(resp);
            };
        }

        const DEVICE_CODE_RESP = {
            device_code: 'dev_code_abc',
            user_code: 'AB12-CD34',
            verification_uri: 'https://github.com/login/device',
            interval: 0,
            expires_in: 900,
        };

        beforeEach(function () { buildMockInstance(); });

        it('start returns sessionId, url and code from GitHub device code response', function (done) {
            copilotConfigModule._httpPost.fn = buildHttpPostMock(DEVICE_CODE_RESP, []);

            const flow = [{ id: 'cfg1', type: 'copilot-config', authMethod: 'oauth' }];
            helper.load(copilotConfigModule, flow, {}, function () {
                helper.request()
                    .post('/copilot/auth/start')
                    .send({ nodeId: 'cfg1' })
                    .expect(200)
                    .end(function (err, res) {
                        if (err) return done(err);
                        res.body.should.have.property('url', 'https://github.com/login/device');
                        res.body.should.have.property('code', 'AB12-CD34');
                        res.body.should.have.property('sessionId').which.is.a.String();
                        done();
                    });
            });
        });

        it('poll returns done:true once background token poll receives an access_token', function (done) {
            copilotConfigModule._httpPost.fn = buildHttpPostMock(DEVICE_CODE_RESP, [
                { error: 'authorization_pending' },
                { access_token: 'gho_test_token' },
            ]);

            const flow = [{ id: 'cfg1', type: 'copilot-config', authMethod: 'oauth' }];
            helper.load(copilotConfigModule, flow, {}, function () {
                helper.request().post('/copilot/auth/start').send({ nodeId: 'cfg1' }).end(function (err, startRes) {
                    if (err) return done(err);
                    const sessionId = startRes.body.sessionId;
                    // Retry polling until done=true (background loop uses 0-ms timers)
                    let attempts = 0;
                    function poll() {
                        helper.request()
                            .get('/copilot/auth/poll/' + sessionId)
                            .end(function (err2, pollRes) {
                                if (err2) return done(err2);
                                if (pollRes.status === 404 || !pollRes.body.done) {
                                    if (++attempts > 20) return done(new Error('poll never returned done'));
                                    return setTimeout(poll, 50);
                                }
                                try {
                                    pollRes.body.should.have.property('done', true);
                                    pollRes.body.should.have.property('error', null);
                                    pollRes.body.should.have.property('token', 'gho_test_token');
                                    done();
                                } catch (e) { done(e); }
                            });
                    }
                    setTimeout(poll, 50);
                });
            });
        });

        it('stores the token on the config node, clears client and models cache', function (done) {
            copilotConfigModule._httpPost.fn = buildHttpPostMock(DEVICE_CODE_RESP, [
                { access_token: 'gho_persisted_token' },
            ]);

            const flow = [{ id: 'cfg1', type: 'copilot-config', authMethod: 'oauth' }];
            helper.load(copilotConfigModule, flow, {}, function () {
                const n = helper.getNode('cfg1');
                // Simulate a warm models cache
                n._modelsCache = [{ id: 'old-model', multiplier: 1 }];
                n._modelsCacheAt = Date.now();

                helper.request().post('/copilot/auth/start').send({ nodeId: 'cfg1' }).end(function (err) {
                    if (err) return done(err);
                    setTimeout(function () {
                        // Token should be set in memory on the node
                        n.credentials.should.have.property('githubToken', 'gho_persisted_token');
                        // Client should be reset so next call picks up the new token
                        (n._startPromise === null).should.be.true();
                        // Models cache should be cleared so next load fetches fresh data
                        (n._modelsCache === null).should.be.true();
                        done();
                    }, 100);
                });
            });
        });

        it('poll returns 404 for unknown sessionId', function (done) {
            copilotConfigModule._httpPost.fn = buildHttpPostMock(DEVICE_CODE_RESP, []);
            const flow = [{ id: 'cfg1', type: 'copilot-config', authMethod: 'oauth' }];
            helper.load(copilotConfigModule, flow, {}, function () {
                helper.request()
                    .get('/copilot/auth/poll/doesnotexist')
                    .expect(404, done);
            });
        });
    });
});
