'use strict';

const assert = require('node:assert/strict');
const {
	adapterRuntimeToolRequest,
	applyOpenCodeRuntimeTools,
	codexRuntimeToolConfigArgs,
	resolvedRuntimeTools,
} = require('./runtime-tool-adapter');

const request = {
	resolved_runtime_tools: [{
		id: 'fixture.mcp',
		transport: 'stdio',
		argv: ['/fixture/mcp', '--isolated'],
		env: { FIXTURE_MODE: 'isolated' },
		secret_env_names: ['FIXTURE_TOKEN'],
		readiness: 'ready',
		lifecycle: 'runtime_owned',
	}],
};
const env = { FIXTURE_TOKEN: 'private-token' };

assert.deepEqual(resolvedRuntimeTools(request, env)[0].argv, ['/fixture/mcp', '--isolated']);
const openCode = applyOpenCodeRuntimeTools({}, request, env);
assert.deepEqual(openCode.mcp['fixture.mcp'], {
	type: 'local', command: '/fixture/mcp', args: ['--isolated'], environment: { FIXTURE_MODE: 'isolated', FIXTURE_TOKEN: 'private-token' },
});
const codex = codexRuntimeToolConfigArgs(request, env);
assert.equal(codex.includes('mcp_servers.fixture.mcp.command="/fixture/mcp"'), true);
assert.equal(codex.includes('mcp_servers.fixture.mcp.args=["--isolated"]'), true);
assert.equal(codex.some((value) => value.includes('private-token')), true);
const adapter = adapterRuntimeToolRequest(request, env);
assert.deepEqual(adapter.resolved_runtime_tools[0].argv, ['/fixture/mcp', '--isolated']);
assert.equal(adapter.resolved_runtime_tools[0].env.FIXTURE_TOKEN, 'private-token');
assert.throws(() => resolvedRuntimeTools({ resolved_runtime_tools: [{ ...request.resolved_runtime_tools[0], readiness: 'missing' }] }), /unready/);
assert.throws(() => resolvedRuntimeTools({ resolved_runtime_tools: [{ ...request.resolved_runtime_tools[0], lifecycle: 'caller_owned' }] }), /unready/);

process.stdout.write('Runtime tool adapter boundary passed\n');
