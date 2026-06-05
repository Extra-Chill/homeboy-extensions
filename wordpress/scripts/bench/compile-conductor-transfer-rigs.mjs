#!/usr/bin/env node
/**
 * External dependencies
 */
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';

/**
 * Internal dependencies
 */
const require = createRequire(import.meta.url);
const { compileConductorTransferRigs } = require('../../lib/conductor-transfer-workload.js');

const input = JSON.parse(readFileSync(0, 'utf8'));
const output = compileConductorTransferRigs(input);
process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
