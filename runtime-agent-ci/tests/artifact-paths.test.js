'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');

const { artifactManifestForFiles } = require('../lib/artifact-paths.cjs');

const root = path.join(process.cwd(), 'artifacts');
const manifest = artifactManifestForFiles({ run_dir: root }, [
  path.join(root, 'nested', '.', 'result.json'),
  path.join(root, 'nested', '..'),
  path.join(root, '..', 'outside.json'),
  { path: path.join(root, 'events.json'), role: 'events' },
]);

assert.deepEqual(manifest.artifacts.map((artifact) => artifact.path).sort(), [
  'events.json',
  'nested/result.json',
]);
assert.equal(manifest.artifacts.every((artifact) => !path.isAbsolute(artifact.path)), true);
