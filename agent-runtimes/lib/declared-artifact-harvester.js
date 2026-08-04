'use strict';

/**
 * External dependencies
 */
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_BUDGET = {
	maxBytes: 50 * 1024 * 1024,
	maxFiles: 1_000,
	maxDepth: 32,
};

function harvestDeclaredArtifacts({ request = {}, config = {}, cwd = '', artifactDir = '' } = {}) {
	const declarations = declaredArtifacts(request);
	if (declarations.length === 0) {
		return emptyResult();
	}
	if (!artifactDir) {
		return captureFailure(declarations, 'artifact_root', 'The scheduler-owned artifact root is required for declared artifacts.');
	}
	const workspaceRoot = realDirectory(cwd);
	if (!workspaceRoot) {
		return captureFailure(declarations, 'workspace_root', 'The declared artifact workspace root does not exist.');
	}
	const root = path.resolve(artifactDir);
	const budget = artifactBudget(request, config);
	const result = emptyResult();
	const destinations = declarationDestinations(declarations, root, request.task_id);
	const prepared = [];
	for (const declaration of declarations) {
		if (!validDeclaredPath(declaration.path)) {
			if (declaration.required) {
				result.errors.push({ artifact: declaration.name, code: 'invalid_path', message: 'Required declared artifacts need an explicit workspace-relative path.' });
			} else {
				result.missing.optional.push({ name: declaration.name, path: '', required: false });
			}
			continue;
		}
		if (destinations.collisions.has(declaration)) {
			result.errors.push({ artifact: declaration.name, code: 'destination_collision', message: 'Declared artifact destination collides with another declaration.' });
			continue;
		}
		const source = resolveSource(workspaceRoot, declaration.path);
		if (source.error) {
			result.errors.push({ artifact: declaration.name, code: 'unsafe_path', message: source.error });
			continue;
		}
		if (!fs.existsSync(source.path)) {
			const missing = { name: declaration.name, path: declaration.path, required: declaration.required === true };
			(result.missing[missing.required ? 'required' : 'optional']).push(missing);
			continue;
		}
		try {
			if (root === source.path || root.startsWith(`${source.path}${path.sep}`)) {
				throw new Error('Declared artifact source must not contain the scheduler artifact root.');
			}
			const collected = collectSource(source.path, workspaceRoot, budget);
			prepared.push({ declaration, source: source.path, destination: destinations.paths.get(declaration), collected });
		} catch (error) {
			result.errors.push({ artifact: declaration.name, code: 'capture_failed', message: error.message });
		}
	}
	for (const { declaration, source, destination, collected } of prepared) {
		try {
			copyEntries(collected.entries, source, destination, collected.directory);
			const digest = collected.directory
				? digestTree(collected.entries, source)
				: collected.entries[0].digest;
			const artifact = {
				id: declaration.id || declaration.name,
				name: declaration.name,
				kind: declaration.kind || declaration.artifact_type || declaration.type || (collected.directory ? 'directory' : 'file'),
				...(declaration.artifact_type ? { artifact_type: declaration.artifact_type } : {}),
				...(declaration.artifact_schema || declaration.schema ? { artifact_schema: declaration.artifact_schema || declaration.schema } : {}),
				path: destination,
				required: declaration.required === true,
				bytes: collected.bytes,
				sha256: digest,
				file_count: collected.entries.length,
				provenance: { source_path: declaration.path, workspace_root: workspaceRoot },
				...(declaration.description ? { description: declaration.description } : {}),
				...(declaration.metadata && typeof declaration.metadata === 'object' && !Array.isArray(declaration.metadata) ? { metadata: declaration.metadata } : {}),
			};
			result.artifacts.push(artifact);
			result.evidence_refs.push({ kind: artifact.kind, label: artifact.name, uri: `file://${destination}`, sha256: digest });
		} catch (error) {
			result.errors.push({ artifact: declaration.name, code: 'capture_failed', message: error.message });
		}
	}
	return result;
}

function declaredArtifacts(request = {}) {
	const source = Array.isArray(request.artifact_declarations)
		? request.artifact_declarations
		: (Array.isArray(request.executor?.artifact_declarations) ? request.executor.artifact_declarations : []);
	return source.filter((artifact) => artifact && typeof artifact === 'object' && (artifact.name || artifact.id))
		.map((artifact) => ({ ...artifact, name: String(artifact.name || artifact.id) }));
}

function declarationDestinations(declarations, root, taskId) {
	const paths = new Map();
	const counts = new Map();
	for (const declaration of declarations) {
		const destination = path.join(root, 'declared', safeFileSegment(taskId), safeFileSegment(declaration.name));
		paths.set(declaration, destination);
		counts.set(destination, (counts.get(destination) || 0) + 1);
	}
	return { paths, collisions: new Set(declarations.filter((declaration) => counts.get(paths.get(declaration)) > 1)) };
}

function validDeclaredPath(value) {
	return typeof value === 'string' && value !== '';
}

function artifactBudget(request, config) {
	const limits = request.limits || {};
	return {
		maxBytes: positiveInteger(config.declared_artifact_max_bytes || config.declaredArtifactMaxBytes || limits.declared_artifact_max_bytes || limits.declaredArtifactMaxBytes, DEFAULT_BUDGET.maxBytes),
		maxFiles: positiveInteger(config.declared_artifact_max_files || config.declaredArtifactMaxFiles || limits.declared_artifact_max_files || limits.declaredArtifactMaxFiles, DEFAULT_BUDGET.maxFiles),
		maxDepth: positiveInteger(config.declared_artifact_max_depth || config.declaredArtifactMaxDepth || limits.declared_artifact_max_depth || limits.declaredArtifactMaxDepth, DEFAULT_BUDGET.maxDepth),
	};
}

function resolveSource(workspaceRoot, declaredPath) {
	if (path.isAbsolute(declaredPath) || declaredPath.includes('\0') || declaredPath.split(/[\\/]+/).includes('..')) {
		return { error: 'Declared artifact paths must be workspace-relative.' };
	}
	const candidate = path.resolve(workspaceRoot, declaredPath);
	if (candidate !== workspaceRoot && !candidate.startsWith(`${workspaceRoot}${path.sep}`)) {
		return { error: 'Declared artifact path escapes the workspace root.' };
	}
	return { path: candidate };
}

function collectSource(source, workspaceRoot, budget) {
	const rootStat = fs.lstatSync(source);
	if (rootStat.isSymbolicLink() || !rootStat.isFile() && !rootStat.isDirectory()) {
		throw new Error('Declared artifact source must be a regular file or directory.');
	}
	const entries = [];
	const visit = (current, depth) => {
		if (depth > budget.maxDepth) {
			throw new Error(`Declared artifact exceeds the ${budget.maxDepth}-level traversal budget.`);
		}
		const stat = fs.lstatSync(current);
		if (stat.isSymbolicLink() || !stat.isFile() && !stat.isDirectory()) {
			throw new Error('Declared artifact tree contains a symlink or unsafe file type.');
		}
		const real = fs.realpathSync(current);
		if (real !== workspaceRoot && !real.startsWith(`${workspaceRoot}${path.sep}`)) {
			throw new Error('Declared artifact source resolves outside the workspace root.');
		}
		if (stat.isDirectory()) {
			for (const name of fs.readdirSync(current).sort()) {
				visit(path.join(current, name), depth + 1);
			}
			return;
		}
		if (entries.length >= budget.maxFiles) {
			throw new Error(`Declared artifact exceeds the ${budget.maxFiles}-file budget.`);
		}
		const usedBytes = entries.reduce((total, entry) => total + entry.bytes, 0);
		const staged = stagedFile(current, budget.maxBytes - usedBytes);
		entries.push({ path: current, ...staged });
	};
	visit(source, 0);
	return { entries, bytes: entries.reduce((total, entry) => total + entry.bytes, 0), directory: rootStat.isDirectory() };
}

function copyEntries(entries, source, destination, directory) {
	if (directory) {
		fs.mkdirSync(destination, { recursive: true });
	}
	for (const entry of entries) {
		const relative = path.relative(source, entry.path);
		const target = relative ? path.join(destination, relative) : destination;
		fs.mkdirSync(path.dirname(target), { recursive: true });
		fs.writeFileSync(target, entry.content);
	}
}

function digestTree(entries, source) {
	const digest = crypto.createHash('sha256');
	for (const entry of entries) {
		digest.update(`${path.relative(source, entry.path)}\0${entry.digest}\n`);
	}
	return digest.digest('hex');
}

function stagedFile(filePath, maxBytes) {
	const fd = fs.openSync(filePath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
	try {
		const stat = fs.fstatSync(fd);
		if (!stat.isFile()) {
			throw new Error('Declared artifact source must be a regular file.');
		}
		if (stat.size > maxBytes) {
			throw new Error('Declared artifact exceeds the byte budget.');
		}
		const content = Buffer.alloc(stat.size);
		let offset = 0;
		while (offset < content.length) {
			const bytes = fs.readSync(fd, content, offset, content.length - offset, offset);
			if (bytes === 0) {
				throw new Error('Declared artifact changed while it was being staged.');
			}
			offset += bytes;
		}
		return { bytes: stat.size, content, digest: crypto.createHash('sha256').update(content).digest('hex') };
	} finally {
		fs.closeSync(fd);
	}
}

function realDirectory(value) {
	try {
		return fs.statSync(value).isDirectory() ? fs.realpathSync(value) : '';
	} catch {
		return '';
	}
}

function positiveInteger(value, fallback) {
	return Number.isSafeInteger(Number(value)) && Number(value) > 0 ? Number(value) : fallback;
}

function safeFileSegment(value) {
	return String(value || 'artifact').replace(/[^a-z0-9._-]+/gi, '-').replace(/^-+|-+$/g, '') || 'artifact';
}

function emptyResult() {
	return { artifacts: [], evidence_refs: [], errors: [], missing: { required: [], optional: [] } };
}

function captureFailure(declarations, code, message) {
	const result = emptyResult();
	result.errors = declarations.map((declaration) => ({ artifact: declaration.name, code, message }));
	return result;
}

module.exports = { harvestDeclaredArtifacts };
