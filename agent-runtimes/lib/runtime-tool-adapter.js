'use strict';

const RUNTIME_TOOLS_ENV = 'HOMEBOY_AGENT_TASK_RUNTIME_TOOLS_JSON';

function resolvedRuntimeTools(request = {}, env = process.env) {
	const direct = Array.isArray(request.resolved_runtime_tools) ? request.resolved_runtime_tools : null;
	const tools = direct || parseRuntimeTools(env?.[RUNTIME_TOOLS_ENV]);
	return tools.map(validateRuntimeTool);
}

function parseRuntimeTools(value) {
	if (!value) {
		return [];
	}
	try {
		const parsed = JSON.parse(value);
		return Array.isArray(parsed) ? parsed : [];
	} catch {
		return [];
	}
}

function validateRuntimeTool(tool) {
	const argv = Array.isArray(tool?.argv) ? tool.argv : tool?.command;
	if (!tool || typeof tool.id !== 'string' || !validId(tool.id)
		|| tool.transport !== 'stdio' || !Array.isArray(argv) || argv.length === 0
		|| argv.some((part) => typeof part !== 'string' || part.trim() === '')
		|| (tool.readiness !== undefined && tool.readiness !== 'ready')
		|| (tool.lifecycle !== undefined && tool.lifecycle !== 'runtime_owned')) {
		throw new Error(`Invalid or unready runtime tool projection: ${tool?.id || 'unknown'}.`);
	}
	const values = objectValue(tool.env);
	const envNames = arrayValue(tool.secret_env_names || tool.secret_env);
	if (Object.keys(values).some((name) => !validEnvName(name)) || envNames.some((name) => !validEnvName(name))) {
		throw new Error(`Runtime tool '${tool.id}' has an invalid environment name.`);
	}
	return {
		id: tool.id,
		argv: [...argv],
		env: values,
		secret_env_names: [...new Set(envNames)],
	};
}

function applyOpenCodeRuntimeTools(content = {}, request = {}, env = process.env) {
	const tools = resolvedRuntimeTools(request, env);
	if (tools.length === 0) {
		return content;
	}
	const mcp = objectValue(content.mcp);
	for (const tool of tools) {
		mcp[tool.id] = {
			type: 'local',
			command: tool.argv[0],
			args: tool.argv.slice(1),
			environment: runtimeToolEnvironment(tool, env),
		};
	}
	return { ...content, mcp };
}

function codexRuntimeToolConfigArgs(request = {}, env = process.env) {
	return resolvedRuntimeTools(request, env).flatMap((tool) => {
		const key = `mcp_servers.${tool.id}`;
		return [
			'--config', `${key}.command=${tomlString(tool.argv[0])}`,
			'--config', `${key}.args=${tomlValue(tool.argv.slice(1))}`,
			'--config', `${key}.env=${tomlValue(runtimeToolEnvironment(tool, env))}`,
		];
	});
}

function adapterRuntimeToolRequest(request = {}, env = process.env) {
	const tools = resolvedRuntimeTools(request, env);
	return tools.length === 0 ? request : { ...request, resolved_runtime_tools: tools.map((tool) => ({
		...tool,
		env: runtimeToolEnvironment(tool, env),
		readiness: 'ready',
		lifecycle: 'runtime_owned',
	})) };
}

function runtimeToolSecretEnvNames(request = {}, env = process.env) {
	return resolvedRuntimeTools(request, env).flatMap((tool) => tool.secret_env_names);
}

function runtimeToolEnvironment(tool, env) {
	return Object.fromEntries([
		...Object.entries(tool.env),
		...tool.secret_env_names.filter((name) => env?.[name] !== undefined).map((name) => [name, env[name]]),
	]);
}

function tomlValue(value) {
	if (Array.isArray(value)) return `[${value.map(tomlString).join(', ')}]`;
	return `{ ${Object.entries(value).map(([key, entry]) => `${key} = ${tomlString(entry)}`).join(', ')} }`;
}

function tomlString(value) {
	return JSON.stringify(String(value));
}

function validId(value) {
	return /^[A-Za-z0-9._-]+$/.test(value);
}

function validEnvName(value) {
	return typeof value === 'string' && /^[A-Za-z_][A-Za-z0-9_]*$/.test(value);
}

function arrayValue(value) {
	return Array.isArray(value) ? value : [];
}

function objectValue(value) {
	return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

module.exports = {
	RUNTIME_TOOLS_ENV,
	adapterRuntimeToolRequest,
	applyOpenCodeRuntimeTools,
	codexRuntimeToolConfigArgs,
	resolvedRuntimeTools,
	runtimeToolSecretEnvNames,
};
