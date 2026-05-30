import { mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const PORT_MIN = 1;
const PORT_MAX = 65535;

export function resolveHomeboyInvocationRuntime(options = {}) {
    const sourceEnv = options.env || process.env;
    const namespace = sanitizeSegment(options.namespace || 'workload');
    const context = parseInvocationContext(sourceEnv);
    const legacy = parseLegacyInvocationEnv(sourceEnv);
    const invocationId = context?.id ?? legacy.invocationId;
    const baseDirs = context?.baseDirs ?? legacy.baseDirs;
    const portRange = context?.portRange ?? legacy.portRange;
    const namedLeases = context?.namedLeases ?? [];
    const isolated = Boolean(context || invocationId || baseDirs.state || baseDirs.artifact || baseDirs.tmp);
    const dirs = isolated ? scopedDirs(baseDirs, namespace) : emptyDirs();
    const runtimeEnv = buildRuntimeEnv({ sourceEnv, invocationId, namespace, dirs, portRange, namedLeases, isolated });

    return {
        isolated,
        namespace,
        invocationId,
        namedLeases,
        baseDirs,
        dirs,
        portRange,
        env: runtimeEnv,
        childEnv(extraEnv = {}) {
            return { ...runtimeEnv, ...extraEnv };
        },
        async prepareDirs() {
            await Promise.all(Object.values(dirs).filter(Boolean).map((dir) => mkdir(dir, { recursive: true })));
            return dirs;
        },
        assertPort(port) {
            if (!portRange) return Number(port);
            const normalizedPort = normalizePort(port, 'port');
            if (normalizedPort < portRange.base || normalizedPort > portRange.max) {
                throw new Error(`Port ${normalizedPort} is outside Homeboy invocation range ${portRange.base}-${portRange.max}.`);
            }
            return normalizedPort;
        },
    };
}

function parseInvocationContext(env) {
    const rawContext = nonEmptyString(env.HOMEBOY_INVOCATION_CONTEXT_JSON);
    if (!rawContext) return null;

    let context;
    try {
        context = JSON.parse(rawContext);
    } catch (error) {
        throw new Error(`HOMEBOY_INVOCATION_CONTEXT_JSON must be valid JSON: ${error.message}`);
    }

    if (!context || typeof context !== 'object' || Array.isArray(context)) {
        throw new Error('HOMEBOY_INVOCATION_CONTEXT_JSON must be a JSON object.');
    }

    return {
        id: requiredContextString(context, 'id'),
        baseDirs: {
            state: requiredContextString(context, 'state_dir'),
            artifact: requiredContextString(context, 'artifact_dir'),
            tmp: requiredContextString(context, 'tmp_dir'),
        },
        portRange: parseContextPortRange(context.port_range),
        namedLeases: parseNamedLeases(context.named_leases),
    };
}

function parseLegacyInvocationEnv(env) {
    return {
        invocationId: nonEmptyString(env.HOMEBOY_INVOCATION_ID),
        baseDirs: {
            state: nonEmptyString(env.HOMEBOY_INVOCATION_STATE_DIR),
            artifact: nonEmptyString(env.HOMEBOY_INVOCATION_ARTIFACT_DIR),
            tmp: nonEmptyString(env.HOMEBOY_INVOCATION_TMP_DIR),
        },
        portRange: parseLegacyPortRange(env),
    };
}

function scopedDirs(baseDirs, namespace) {
    const state = scopedDir(baseDirs.state, namespace);
    const artifact = scopedDir(baseDirs.artifact, namespace);
    const tmp = scopedDir(baseDirs.tmp, namespace);

    return {
        state,
        artifact,
        tmp,
        home: state ? join(state, 'home') : null,
        config: state ? join(state, 'config') : null,
        cache: state ? join(state, 'cache') : null,
        data: state ? join(state, 'data') : null,
    };
}

function emptyDirs() {
    return {
        state: null,
        artifact: null,
        tmp: null,
        home: null,
        config: null,
        cache: null,
        data: null,
    };
}

function scopedDir(baseDir, namespace) {
    return baseDir ? resolve(baseDir, namespace) : null;
}

function buildRuntimeEnv({ sourceEnv, invocationId, namespace, dirs, portRange, namedLeases, isolated }) {
    const env = { ...sourceEnv };

    if (isolated) {
        env.HOMEBOY_INVOCATION_NAMESPACE = namespace;
        if (invocationId) env.HOMEBOY_INVOCATION_ID = invocationId;
        if (dirs.state) env.HOMEBOY_INVOCATION_STATE_DIR = dirs.state;
        if (dirs.artifact) env.HOMEBOY_INVOCATION_ARTIFACT_DIR = dirs.artifact;
        if (dirs.tmp) {
            env.HOMEBOY_INVOCATION_TMP_DIR = dirs.tmp;
            env.TMPDIR = dirs.tmp;
            env.TMP = dirs.tmp;
            env.TEMP = dirs.tmp;
        }
        if (dirs.home) env.HOME = dirs.home;
        if (dirs.config) env.XDG_CONFIG_HOME = dirs.config;
        if (dirs.cache) env.XDG_CACHE_HOME = dirs.cache;
        if (dirs.data) env.XDG_DATA_HOME = dirs.data;
        if (dirs.state) env.XDG_STATE_HOME = dirs.state;
        const contextJson = invocationContextJson({ invocationId, dirs, portRange, namedLeases });
        if (contextJson) env.HOMEBOY_INVOCATION_CONTEXT_JSON = JSON.stringify(contextJson);
    }

    if (portRange) {
        env.HOMEBOY_INVOCATION_PORT_BASE = String(portRange.base);
        env.HOMEBOY_INVOCATION_PORT_MAX = String(portRange.max);
    }

    return env;
}

function invocationContextJson({ invocationId, dirs, portRange, namedLeases }) {
    if (!invocationId || !dirs.state || !dirs.artifact || !dirs.tmp) return null;

    const context = {
        id: invocationId,
        state_dir: dirs.state,
        artifact_dir: dirs.artifact,
        tmp_dir: dirs.tmp,
    };
    if (portRange) context.port_range = { base: portRange.base, max: portRange.max };
    if (namedLeases.length > 0) context.named_leases = namedLeases;
    return context;
}

function parseContextPortRange(portRange) {
    if (portRange == null) return null;
    if (typeof portRange !== 'object' || Array.isArray(portRange)) {
        throw new Error('HOMEBOY_INVOCATION_CONTEXT_JSON port_range must be an object.');
    }

    const base = normalizePort(portRange.base, 'HOMEBOY_INVOCATION_CONTEXT_JSON port_range.base');
    const max = normalizePort(portRange.max, 'HOMEBOY_INVOCATION_CONTEXT_JSON port_range.max');
    if (base > max) {
        throw new Error(`HOMEBOY_INVOCATION_CONTEXT_JSON port_range.base (${base}) must be less than or equal to port_range.max (${max}).`);
    }

    return { base, max };
}

function parseLegacyPortRange(env) {
    const rawBase = nonEmptyString(env.HOMEBOY_INVOCATION_PORT_BASE);
    const rawMax = nonEmptyString(env.HOMEBOY_INVOCATION_PORT_MAX);

    if (!rawBase && !rawMax) return null;
    if (!rawBase || !rawMax) {
        throw new Error('HOMEBOY_INVOCATION_PORT_BASE and HOMEBOY_INVOCATION_PORT_MAX must be set together.');
    }

    const base = normalizePort(rawBase, 'HOMEBOY_INVOCATION_PORT_BASE');
    const max = normalizePort(rawMax, 'HOMEBOY_INVOCATION_PORT_MAX');
    if (base > max) {
        throw new Error(`HOMEBOY_INVOCATION_PORT_BASE (${base}) must be less than or equal to HOMEBOY_INVOCATION_PORT_MAX (${max}).`);
    }

    return { base, max };
}

function normalizePort(value, label) {
    const raw = String(value ?? '').trim();
    if (!/^\d+$/.test(raw)) {
        throw new Error(`${label} must be an integer port, got "${raw}".`);
    }

    const port = Number(raw);
    if (!Number.isSafeInteger(port) || port < PORT_MIN || port > PORT_MAX) {
        throw new Error(`${label} must be between ${PORT_MIN} and ${PORT_MAX}, got ${raw}.`);
    }

    return port;
}

function parseNamedLeases(namedLeases) {
    if (namedLeases == null) return [];
    if (!Array.isArray(namedLeases)) {
        throw new Error('HOMEBOY_INVOCATION_CONTEXT_JSON named_leases must be an array.');
    }

    return namedLeases.map((lease, index) => {
        const value = nonEmptyString(lease);
        if (!value) {
            throw new Error(`HOMEBOY_INVOCATION_CONTEXT_JSON named_leases[${index}] must be a non-empty string.`);
        }
        return value;
    });
}

function requiredContextString(context, key) {
    const value = nonEmptyString(context[key]);
    if (!value) {
        throw new Error(`HOMEBOY_INVOCATION_CONTEXT_JSON ${key} must be a non-empty string.`);
    }
    return value;
}

function nonEmptyString(value) {
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
}

function sanitizeSegment(value) {
    const segment = String(value || 'workload')
        .trim()
        .replace(/[^A-Za-z0-9._-]+/g, '-')
        .replace(/^-+|-+$/g, '');
    return segment || 'workload';
}
