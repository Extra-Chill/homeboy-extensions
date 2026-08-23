'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const SCHEMA = 'homeboy/external-storage-retention/v1';
const PROVIDER_ID = 'opencode.external-storage-retention';
const CONFIG_ENV = 'HOMEBOY_OPENCODE_RETENTION_CONFIG';
const MARKER = '.homeboy-opencode-retention.json';
const CREDENTIAL_NAMES = new Set(['auth.json', 'account.json', 'mcp-auth.json', 'anthropic-oauth-accounts.json', 'openai-oauth-accounts.json']);

function externalStorageRetentionProviderContract() {
	return {
		id: PROVIDER_ID,
		command: ['homeboy-opencode-external-storage-retention'],
		timeout_seconds: 30,
	};
}

function handleRequest(request, options = {}) {
	if (!request || request.schema !== SCHEMA || !['inventory', 'reclaim'].includes(request.operation)) {
		throw new Error('Expected a homeboy/external-storage-retention/v1 inventory or reclaim request.');
	}
	const config = retentionConfig(options.env || process.env, options);
	const inventory = inventoryFor(config, options);
	if (request.operation === 'inventory') return inventory;
	if (request.generation !== inventory.generation) throw new Error('OpenCode storage inventory generation is stale.');
	const requested = Array.isArray(request.reclaim_targets) ? request.reclaim_targets : [];
	const byId = new Map(inventory.items.map((item) => [item.id, item]));
	let reclaimedBytes = 0;
	const reclaimedItemIds = [];
	for (const target of requested) {
		const item = byId.get(target?.id);
		if (!item || item.reclaim_token !== target.reclaim_token || !reclaimable(item)) continue;
		const resource = config.resources.find((candidate) => candidate.id === item.id);
		const reclaimed = resource && nativeReclaim(resource, config, options);
		if (!reclaimed) continue;
		reclaimedBytes += reclaimed.bytes;
		reclaimedItemIds.push(item.id);
	}
	return { schema: SCHEMA, provider_id: PROVIDER_ID, generation: inventory.generation, reclaimed_item_ids: reclaimedItemIds, reclaimed_bytes: reclaimedBytes };
}

function retentionConfig(env, options) {
	const configured = env[CONFIG_ENV];
	let value = {};
	if (configured) value = JSON.parse(fs.readFileSync(configured, 'utf8'));
	const paths = value.paths || openCodePaths(options.command || 'opencode', env);
	const tempRoots = absolutePaths(value.temp_roots || (paths.tmp ? [paths.tmp] : []));
	const dataRoot = absolutePath(value.data_root || paths.data);
	return {
		temp_roots: tempRoots,
		data_root: dataRoot,
		resources: configuredResources(value, tempRoots, dataRoot),
		command: value.command || options.command || 'opencode',
	};
}

function configuredResources(value, tempRoots, dataRoot) {
	const resources = Array.isArray(value.resources) ? value.resources.map((resource) => ({ ...resource, path: absolutePath(resource.path) })) : [];
	for (const root of tempRoots) {
		for (const entry of safeEntries(root)) {
			const candidate = path.join(root, entry.name);
			const marker = path.join(candidate, MARKER);
			if (!entry.isDirectory() || !fs.existsSync(marker)) continue;
			try {
				const metadata = JSON.parse(fs.readFileSync(marker, 'utf8'));
				if (metadata.id && !resources.some((resource) => resource.id === metadata.id)) resources.push({ ...metadata, path: candidate, class: metadata.class || 'scratch' });
			} catch { /* An invalid ownership marker is unknown rather than reclaimable. */ }
		}
	}
	if (dataRoot) {
		for (const name of CREDENTIAL_NAMES) {
			const credential = path.join(dataRoot, name);
			if (fs.existsSync(credential) && !resources.some((resource) => resource.path === credential)) resources.push({ id: `credential:${name}`, path: credential, class: 'credential', reconstructable: false, pinned: true });
		}
		for (const name of ['opencode.db', 'opencode.db-wal', 'opencode.db-shm']) {
			const store = path.join(dataRoot, name);
			if (fs.existsSync(store) && !resources.some((resource) => resource.path === store)) resources.push({ id: `session-store:${name}`, path: store, class: 'session_store', reconstructable: false, referenced: true });
		}
	}
	return uniqueById(resources);
}

function inventoryFor(config, options) {
	const roots = [...config.temp_roots.map((root, index) => ({ id: `temp-${index}`, path: root })), ...(config.data_root ? [{ id: 'data', path: config.data_root }] : [])];
	const rootId = (candidate) => roots.find((root) => inside(candidate, root.path))?.id || 'unmanaged';
	const items = config.resources.filter((resource) => fs.existsSync(resource.path)).map((resource) => itemFor(resource, rootId(resource.path), options));
	const managed = new Set(config.resources.filter((resource) => fs.existsSync(resource.path)).map((resource) => resource.path));
	const unknownBytes = roots.reduce((total, root) => total + unknownBytesBelow(root.path, managed), 0);
	const generation = digest(JSON.stringify({ roots: roots.map((root) => [root.id, fingerprint(root.path)]), items: items.map((item) => [item.id, fingerprint(item._path), item.active, item.referenced]) }));
	return {
		schema: SCHEMA, provider_id: PROVIDER_ID, generation, roots,
		items: items.map(({ _path, ...item }) => ({ ...item, reclaim_token: digest(`${generation}:${item.id}:${fingerprint(_path)}`) })),
		unknown_bytes: unknownBytes,
	};
}

function itemFor(resource, rootId, options) {
	const ownerAlive = resource.owner?.pid && processAlive(resource.owner.pid);
	const active = resource.active === true || ownerAlive;
	const referenced = resource.referenced === true || resource.pinned === true || resource.class === 'credential';
	const known = Boolean(resource.id && resource.path && rootId !== 'unmanaged' && (resource.managed === true || fs.existsSync(path.join(resource.path, MARKER)) || ['credential', 'session_store', 'pinned_export'].includes(resource.class)));
	return {
		id: String(resource.id), root_id: rootId, class: validClass(resource.class), bytes: sizeOf(resource.path), locator: relativeLocator(resource.path), reconstructable: resource.reconstructable === true,
		active, referenced, ownership_known: known, age_days: ageDays(resource.terminal_at || resource.terminalAt || resource.path, options.now), _path: resource.path,
	};
}

function nativeReclaim(resource, config, options) {
	if (resource.class === 'scratch' || resource.class === 'durable_artifact') {
		if (!config.temp_roots.some((root) => inside(resource.path, root)) || !fs.existsSync(path.join(resource.path, MARKER))) return null;
		const bytes = sizeOf(resource.path);
		fs.rmSync(resource.path, { recursive: true, force: false });
		return { bytes };
	}
	if (resource.class !== 'session_store' || !Array.isArray(resource.expired_session_ids) || resource.expired_session_ids.length === 0) return null;
	const before = sizeOf(resource.path);
	for (const sessionId of resource.expired_session_ids) {
		const deleted = spawnSync(config.command, ['session', 'delete', sessionId], { encoding: 'utf8', env: options.env || process.env });
		if (deleted.status !== 0) return null;
	}
	const compacted = spawnSync(config.command, ['db', 'VACUUM'], { encoding: 'utf8', env: options.env || process.env });
	return compacted.status === 0 ? { bytes: Math.max(0, before - sizeOf(resource.path)) } : null;
}

function reclaimable(item) {
	return item.ownership_known && item.reconstructable && !item.active && !item.referenced && !['credential', 'pinned_export'].includes(item.class);
}

function openCodePaths(command, env) {
	const result = spawnSync(command, ['debug', 'paths'], { encoding: 'utf8', env });
	if (result.status !== 0) return {};
	return Object.fromEntries(String(result.stdout).split(/\r?\n/).map((line) => line.trim().split(/\s{2,}/)).filter(([key, value]) => key && value));
}
function safeEntries(directory) { try { return fs.readdirSync(directory, { withFileTypes: true }); } catch { return []; } }
function sizeOf(candidate) { try { const stat = fs.lstatSync(candidate); return stat.isDirectory() ? safeEntries(candidate).reduce((sum, entry) => sum + sizeOf(path.join(candidate, entry.name)), 0) : stat.size; } catch { return 0; } }
function unknownBytesBelow(root, managed) {
	if (managed.has(root)) return 0;
	const descendants = [...managed].some((known) => inside(known, root));
	if (!descendants) return sizeOf(root);
	return safeEntries(root).reduce((sum, entry) => sum + unknownBytesBelow(path.join(root, entry.name), managed), 0);
}
function fingerprint(candidate) { try { const stat = fs.statSync(candidate); return `${stat.size}:${stat.mtimeMs}:${stat.ino || 0}`; } catch { return 'missing'; } }
function digest(value) { return crypto.createHash('sha256').update(value).digest('hex'); }
function absolutePath(value) { return typeof value === 'string' && path.isAbsolute(value) ? path.resolve(value) : ''; }
function absolutePaths(values) { return [...new Set((Array.isArray(values) ? values : []).map(absolutePath).filter(Boolean))]; }
function inside(candidate, root) { if (!candidate || !root) return false; const relative = path.relative(root, candidate); return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative)); }
function relativeLocator(candidate) { return `opencode:${path.basename(candidate)}`; }
function validClass(value) { return ['scratch', 'durable_artifact', 'session_store', 'credential', 'pinned_export'].includes(value) ? value : 'scratch'; }
function processAlive(pid) { try { process.kill(pid, 0); return true; } catch { return false; } }
function ageDays(value, now = Date.now()) { const time = typeof value === 'string' ? Date.parse(value) : typeof value === 'number' ? value : (() => { try { return fs.statSync(value).mtimeMs; } catch { return now; } })(); return Number.isFinite(time) && time <= now ? Math.floor((now - time) / 86_400_000) : 0; }
function uniqueById(resources) { const seen = new Set(); return resources.filter((resource) => resource.id && !seen.has(resource.id) && seen.add(resource.id)); }

module.exports = { CONFIG_ENV, PROVIDER_ID, SCHEMA, handleRequest, externalStorageRetentionProviderContract, retentionConfig };
