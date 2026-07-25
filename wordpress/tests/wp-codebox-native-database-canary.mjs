/**
 * External dependencies
 */
import { strict as assert } from 'node:assert';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const cli = process.env.WP_CODEBOX_NATIVE_CANARY_BIN;
if (!cli) {
  console.log('WP Codebox native database canary skipped: WP_CODEBOX_NATIVE_CANARY_BIN is not set.');
  process.exit(0);
}

const descriptorRun = spawnSync(cli, ['runtime', 'descriptor', '--json'], { encoding: 'utf8' });
let descriptor;
try {
  descriptor = descriptorRun.status === 0 ? JSON.parse(descriptorRun.stdout) : null;
} catch {
  descriptor = null;
}
if (!descriptor?.capabilities?.includes('runtime-service:mysql:native:mariadb')) {
  console.log('WP Codebox native database canary skipped: CLI does not advertise native MariaDB support.');
  process.exit(0);
}

const extension = path.resolve(import.meta.dirname, '..');
const runner = path.join(extension, 'scripts/test/test-runner-wp-codebox.sh');
const root = await mkdtemp(path.join(os.tmpdir(), 'wp-codebox-native-database-canary-'));
const component = path.join(root, 'native-database-canary');
try {
  await mkdir(path.join(component, 'tests'), { recursive: true });
  await writeFile(path.join(component, 'native-database-canary.php'), '<?php\n/* Plugin Name: Native Database Canary */\n');
  await writeFile(path.join(component, 'tests/test-native-database.php'), `<?php
class Native_Database_Canary_Test extends WP_UnitTestCase {
    public function test_managed_mysql_connection(): void {
        global $wpdb;
        $this->assertSame( 'mysql', $wpdb->get_var( 'SELECT @@version_comment IS NOT NULL' ) ? 'mysql' : 'unavailable' );
    }
}
`);

  const run = spawnSync(runner, [], {
    env: {
      ...process.env,
      HOMEBOY_COMPONENT_PATH: component,
      COMPONENT_ID: 'native-database-canary',
      HOMEBOY_WP_CODEBOX_BIN: cli,
      HOMEBOY_SETTINGS_JSON: JSON.stringify({
        database_type: 'mysql',
        wp_codebox_database_service: { provider: 'native', engine: 'mariadb' },
      }),
    },
    encoding: 'utf8',
    timeout: 180_000,
  });
  assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`);
} finally {
  await rm(root, { recursive: true, force: true });
}

console.log('WP Codebox native database canary passed.');
