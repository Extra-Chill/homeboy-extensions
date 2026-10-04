import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

const extensionPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const helper = path.join(extensionPath, 'scripts/notify.mjs');
const secretToken = 'bot-secret-123';
const secretWebhook = '/webhooks/webhook-id/webhook-secret-456';
const guildId = '123456789012345678';
const channelId = '223456789012345678';
const threadOneId = '323456789012345678';
const threadTwoId = '423456789012345678';

await testConcurrentThreadRoutesDoNotCrossDeliver();
await testGuildlessThreadRoute();
await testGuildlessChannelRoute();
await testDynamicChannelRoute();
await testOperationsChannelDelivery();
await testRouteLessBotFailsClosed();
await testWebhookDelivery();
await testRateLimitRetry();
await testMalformedRouteBeforeNetwork();
await testCrossModeRouteBeforeNetwork();
await testAuthFailureClassification();
await testTruncation();
await testRedactionAndDryRun();
await testTransportFlagIsAccepted();
await testSessionDeliveryViaCommandSender();
await testSessionDeliveryViaHttpSender();
await testHttpSenderTakesPrecedenceOverCommandSender();
await testHttpSenderFailureClassification();
await testNoSessionSenderFallsBackToRest();
await testProgressOnlyStatusNeverBecomesSessionTurn();
await testForeignSessionPlatformIgnoresAttribution();
await testInvalidSessionAttributionFailsClosed();
await testDeprecatedKimakiAliasesDeliverThroughLegacyCli();
await testDeprecatedThreadAliasUsesDefaultLegacyCli();
await testGenericSessionEnvironmentWinsOverDeprecatedAliases();
await testDeprecatedAliasRestFallbackForProgressOnlyAndForeignThread();
await testKimakiBotTokenFallbackIsRemoved();
console.log('discord notification tests passed');

// Homeboy appends --transport alongside --route whenever a caller selects a
// transport explicitly, so rejecting the flag broke every explicitly-routed
// notification. Nothing exercised it before, which is why that shipped.
async function testTransportFlagIsAccepted() {
  await withServer(async ({ baseUrl, requests }) => {
    const result = await notify(
      { DISCORD_BOT_TOKEN: secretToken, DISCORD_API_BASE_URL: `${baseUrl}/api/v10` },
      { transport: 'discord.run-completion', route: channelRoute(channelId) },
    );
    assert.equal(result.status, 'delivered');
    assert.equal(result.delivery.route_kind, 'channel');
    assert.equal(requests[0].url, `/api/v10/channels/${channelId}/messages`);
  });

  // An unknown flag must still be refused, so accepting --transport does not
  // turn the parser permissive.
  const run = await notifyRaw(
    { DISCORD_BOT_TOKEN: secretToken },
    { route: channelRoute(channelId) },
    ['--totally-unknown', 'x'],
  );
  assert.equal(run.code, 1);
  assert.match(run.stdout, /input_error/);
}

// A REST post from the chat bridge's own bot is a self-message its ingress
// drops, so the session that owns this run would never see its own completion.
// The owning thread is delivered through the configured session sender so the
// notification becomes a real turn.
async function testSessionDeliveryViaCommandSender() {
  const stubDir = fs.mkdtempSync(path.join(os.tmpdir(), 'discord-notify-session-'));
  const argvLog = path.join(stubDir, 'argv.json');
  const stub = path.join(stubDir, 'sender-stub.mjs');
  fs.writeFileSync(
    stub,
    `#!/usr/bin/env node\nimport fs from 'node:fs';\nfs.writeFileSync(${JSON.stringify(argvLog)}, JSON.stringify(process.argv.slice(2)));\n`,
  );
  fs.chmodSync(stub, 0o755);
  const senderEnv = { HOMEBOY_SESSION_THREAD_ID: threadOneId, HOMEBOY_SESSION_SEND_COMMAND: `${process.execPath} ${stub}` };

  await withServer(async ({ baseUrl, requests }) => {
    const result = await notify(
      { DISCORD_BOT_TOKEN: secretToken, ...senderEnv, DISCORD_API_BASE_URL: `${baseUrl}/api/v10` },
      { route: threadRoute(threadOneId), body: 'cook finished' },
    );
    assert.equal(result.status, 'delivered');
    assert.equal(result.delivery.mode, 'session');
    assert.equal(result.delivery.destination, 'session_thread');
    assert.equal(result.deprecations, undefined);
    assert.equal(requests.length, 0);
  });

  const argv = JSON.parse(fs.readFileSync(argvLog, 'utf8'));
  assert.deepEqual(argv, ['--thread', threadOneId, '--prompt', '[pass] homeboy run pass\nRun: run-123\ncook finished']);

  // An explicit platform of another chat service must not attribute this
  // transport's session: the notification falls back to REST delivery and the
  // sender is never invoked.
  const invoked = fs.readFileSync(argvLog, 'utf8');
  await withServer(async ({ baseUrl, requests }) => {
    const result = await notify(
      {
        DISCORD_BOT_TOKEN: secretToken,
        HOMEBOY_SESSION_PLATFORM: 'other-chat',
        ...senderEnv,
        DISCORD_API_BASE_URL: `${baseUrl}/api/v10`,
      },
      { route: threadRoute(threadOneId) },
    );
    assert.equal(result.delivery.mode, 'bot');
    assert.equal(result.delivery.destination, 'dynamic_thread');
    assert.equal(requests[0].url, `/api/v10/channels/${threadOneId}/messages`);
  });
  assert.equal(fs.readFileSync(argvLog, 'utf8'), invoked);

  // An explicit discord platform attributes the session again.
  await withServer(async ({ baseUrl, requests }) => {
    const result = await notify(
      {
        DISCORD_BOT_TOKEN: secretToken,
        HOMEBOY_SESSION_PLATFORM: 'discord',
        ...senderEnv,
        DISCORD_API_BASE_URL: `${baseUrl}/api/v10`,
      },
      { route: threadRoute(threadOneId) },
    );
    assert.equal(result.delivery.mode, 'session');
    assert.equal(requests.length, 0);
  });
  assert.notEqual(fs.readFileSync(argvLog, 'utf8'), invoked);

  fs.rmSync(stubDir, { recursive: true, force: true });
}

// The HTTP sender posts the send options with a bearer service token, matching
// Roadie's local `POST /roadie/send` service-token API.
async function testSessionDeliveryViaHttpSender() {
  const tokenDir = fs.mkdtempSync(path.join(os.tmpdir(), 'discord-notify-token-'));
  const tokenFile = path.join(tokenDir, 'service-token');
  fs.writeFileSync(tokenFile, `  service-secret-789\n`);

  await withServer(async ({ baseUrl, requests }) => {
    const result = await notify(
      {
        HOMEBOY_SESSION_THREAD_ID: threadOneId,
        HOMEBOY_SESSION_SEND_URL: `${baseUrl}/roadie/send`,
        HOMEBOY_SESSION_SEND_TOKEN_FILE: tokenFile,
      },
      { route: threadRoute(threadOneId) },
    );
    assert.equal(result.status, 'delivered');
    assert.equal(result.delivery.mode, 'session');
    assert.equal(result.delivery.destination, 'session_thread');
    assert.equal(requests.length, 1);
    assert.equal(requests[0].url, '/roadie/send');
    assert.equal(requests[0].headers.authorization, 'Bearer service-secret-789');
    assert.deepEqual(Object.keys(requests[0].body), ['options']);
    assert.equal(requests[0].body.options.prompt, '[pass] homeboy run pass\nRun: run-123\nRun completed');
    assert.doesNotMatch(JSON.stringify(result), /service-secret-789/);
  }, (_request, response) => response.writeHead(200, { 'content-type': 'application/x-ndjson' }).end('{"exit":0}\n'));

  // An unreadable token file fails closed before any network I/O.
  await withServer(async ({ baseUrl, requests }) => {
    const run = await notifyRaw(
      {
        HOMEBOY_SESSION_THREAD_ID: threadOneId,
        HOMEBOY_SESSION_SEND_URL: `${baseUrl}/roadie/send`,
        HOMEBOY_SESSION_SEND_TOKEN_FILE: path.join(tokenDir, 'missing'),
      },
      { route: threadRoute(threadOneId) },
    );
    assert.equal(run.code, 1);
    assert.equal(JSON.parse(run.stdout).error.kind, 'input_error');
    assert.equal(requests.length, 0);
  });

  fs.rmSync(tokenDir, { recursive: true, force: true });
}

async function testHttpSenderTakesPrecedenceOverCommandSender() {
  const stubDir = fs.mkdtempSync(path.join(os.tmpdir(), 'discord-notify-precedence-'));
  const argvLog = path.join(stubDir, 'argv.json');
  const stub = path.join(stubDir, 'sender-stub.mjs');
  fs.writeFileSync(
    stub,
    `#!/usr/bin/env node\nimport fs from 'node:fs';\nfs.writeFileSync(${JSON.stringify(argvLog)}, JSON.stringify(process.argv.slice(2)));\n`,
  );
  fs.chmodSync(stub, 0o755);

  await withServer(async ({ baseUrl, requests }) => {
    const result = await notify(
      {
        HOMEBOY_SESSION_THREAD_ID: threadOneId,
        HOMEBOY_SESSION_SEND_URL: `${baseUrl}/roadie/send`,
        HOMEBOY_SESSION_SEND_COMMAND: `${process.execPath} ${stub}`,
      },
      { route: threadRoute(threadOneId) },
    );
    assert.equal(result.status, 'delivered');
    assert.equal(requests.length, 1);
    assert.equal(requests[0].url, '/roadie/send');
    assert.equal(fs.existsSync(argvLog), false);
  });

  fs.rmSync(stubDir, { recursive: true, force: true });
}

async function testHttpSenderFailureClassification() {
  await withServer(async ({ baseUrl, requests }) => {
    const run = await notifyRaw(
      {
        HOMEBOY_SESSION_THREAD_ID: threadOneId,
        HOMEBOY_SESSION_SEND_URL: `${baseUrl}/roadie/send`,
      },
      { route: threadRoute(threadOneId) },
    );
    assert.equal(run.code, 1);
    const result = JSON.parse(run.stdout);
    assert.equal(result.error.kind, 'delivery_error');
    assert.equal(result.attempts, 1);
    assert.equal(requests.length, 1);
  }, (_request, response) => response.writeHead(403).end('no'));

  // Roadie accepts with HTTP 200 and streams the send's outcome; a nonzero
  // exit event is a failed delivery even though the status was 200.
  await withServer(async ({ baseUrl, requests }) => {
    const run = await notifyRaw(
      {
        HOMEBOY_SESSION_THREAD_ID: threadOneId,
        HOMEBOY_SESSION_SEND_URL: `${baseUrl}/roadie/send`,
      },
      { route: threadRoute(threadOneId) },
    );
    assert.equal(run.code, 1);
    const result = JSON.parse(run.stdout);
    assert.equal(result.error.kind, 'delivery_error');
    assert.match(result.error.message, /exited with status 1: thread not found/);
    assert.equal(requests.length, 1);
  }, (_request, response) =>
    response
      .writeHead(200, { 'content-type': 'application/x-ndjson' })
      .end('{"stream":"stderr","data":"thread not found\\n"}\n{"exit":1}\n'));

  // A sender that cannot be reached is a delivery failure, not an auth or
  // input error, and nothing falls back to REST delivery.
  const run = await notifyRaw(
    {
      HOMEBOY_SESSION_THREAD_ID: threadOneId,
      HOMEBOY_SESSION_SEND_URL: 'http://127.0.0.1:1/roadie/send',
    },
    { route: threadRoute(threadOneId) },
  );
  assert.equal(run.code, 1);
  assert.equal(JSON.parse(run.stdout).error.kind, 'delivery_error');
}

// Without a configured session sender, an owning-thread outcome notification
// falls back to normal bot/webhook REST delivery — the transport's default
// behavior for every other route.
async function testNoSessionSenderFallsBackToRest() {
  await withServer(async ({ baseUrl, requests }) => {
    const result = await notify(
      { DISCORD_BOT_TOKEN: secretToken, HOMEBOY_SESSION_THREAD_ID: threadOneId, DISCORD_API_BASE_URL: `${baseUrl}/api/v10` },
      { route: threadRoute(threadOneId) },
    );
    assert.equal(result.delivery.mode, 'bot');
    assert.equal(result.delivery.destination, 'dynamic_thread');
    assert.equal(requests[0].url, `/api/v10/channels/${threadOneId}/messages`);
  });

  // With no sender and no Discord credentials there is no way to deliver, so
  // the helper fails closed instead of silently dropping the notification.
  await withServer(async ({ baseUrl, requests }) => {
    const run = await notifyRaw(
      { HOMEBOY_SESSION_THREAD_ID: threadOneId, DISCORD_API_BASE_URL: `${baseUrl}/api/v10` },
      { route: threadRoute(threadOneId) },
    );
    assert.equal(run.code, 1);
    assert.match(JSON.parse(run.stdout).error.message, /exactly one auth mode/);
    assert.equal(requests.length, 0);
  });
}

// A run that only announces its start carries no outcome to act on, so it is
// posted for the human to read rather than interrupting the agent — even when
// a session sender is configured.
async function testProgressOnlyStatusNeverBecomesSessionTurn() {
  const stubDir = fs.mkdtempSync(path.join(os.tmpdir(), 'discord-notify-progress-'));
  const stub = path.join(stubDir, 'sender-stub.mjs');
  fs.writeFileSync(stub, '#!/usr/bin/env node\nprocess.exit(1)\n');
  fs.chmodSync(stub, 0o755);

  for (const status of ['started', 'running', 'queued']) {
    await withServer(async ({ baseUrl, requests }) => {
      const result = await notify(
        {
          DISCORD_BOT_TOKEN: secretToken,
          HOMEBOY_SESSION_THREAD_ID: threadOneId,
          HOMEBOY_SESSION_SEND_COMMAND: `${process.execPath} ${stub}`,
          DISCORD_API_BASE_URL: `${baseUrl}/api/v10`,
        },
        { route: threadRoute(threadOneId), status },
      );
      assert.equal(result.delivery.mode, 'bot');
      assert.equal(requests[0].url, `/api/v10/channels/${threadOneId}/messages`);
    });
  }

  fs.rmSync(stubDir, { recursive: true, force: true });
}

async function testForeignSessionPlatformIgnoresAttribution() {
  await withServer(async ({ baseUrl, requests }) => {
    const run = await notifyRaw(
      {
        DISCORD_BOT_TOKEN: secretToken,
        HOMEBOY_SESSION_PLATFORM: 'slack',
        HOMEBOY_SESSION_THREAD_ID: 'not-a-snowflake',
        DISCORD_API_BASE_URL: `${baseUrl}/api/v10`,
      },
      { route: channelRoute(channelId) },
    );
    assert.equal(run.code, 0);
    assert.equal(JSON.parse(run.stdout).delivery.mode, 'bot');
    assert.equal(requests[0].url, `/api/v10/channels/${channelId}/messages`);
  });
}

async function testInvalidSessionAttributionFailsClosed() {
  for (const env of [
    { HOMEBOY_SESSION_THREAD_ID: '123' },
    { HOMEBOY_SESSION_THREAD_ID: 'not-a-snowflake' },
    { HOMEBOY_NOTIFICATION_SESSION_ROUTE: 'discord:v1:thread:not-an-id' },
  ]) {
    await withServer(async ({ baseUrl, requests }) => {
      const run = await notifyRaw(
        { DISCORD_BOT_TOKEN: secretToken, DISCORD_API_BASE_URL: `${baseUrl}/api/v10`, ...env },
        { route: channelRoute(channelId) },
      );
      assert.equal(run.code, 1);
      assert.equal(JSON.parse(run.stdout).error.kind, 'input_error');
      assert.doesNotMatch(run.stdout, /not-a-snowflake|not-an-id/);
      assert.equal(requests.length, 0);
    });
  }
}

// Deprecated shim for installs that predate the generic contract, removed in
// the next release: legacy attribution delivered through its CLI as
// `<cli> send --thread <id> --prompt <text>`, reported in the result envelope.
async function testDeprecatedKimakiAliasesDeliverThroughLegacyCli() {
  const stubDir = fs.mkdtempSync(path.join(os.tmpdir(), 'discord-notify-legacy-'));
  const argvLog = path.join(stubDir, 'argv.json');
  const stub = path.join(stubDir, 'legacy-cli-stub.mjs');
  fs.writeFileSync(
    stub,
    `#!/usr/bin/env node\nimport fs from 'node:fs';\nfs.writeFileSync(${JSON.stringify(argvLog)}, JSON.stringify(process.argv.slice(2)));\n`,
  );
  fs.chmodSync(stub, 0o755);

  await withServer(async ({ baseUrl, requests }) => {
    const result = await notify(
      {
        KIMAKI_THREAD_ID: threadOneId,
        KIMAKI_CLI: stub,
        DISCORD_API_BASE_URL: `${baseUrl}/api/v10`,
      },
      { route: threadRoute(threadOneId), body: 'cook finished' },
    );
    assert.equal(result.status, 'delivered');
    assert.equal(result.delivery.mode, 'session');
    assert.equal(result.delivery.destination, 'session_thread');
    assert.equal(requests.length, 0);
    assert.equal(Array.isArray(result.deprecations), true);
    assert.equal(result.deprecations.length, 2);
    assert.match(result.deprecations[0], /KIMAKI_THREAD_ID/);
    assert.match(result.deprecations[1], /KIMAKI_CLI/);
    assert.doesNotMatch(JSON.stringify(result), /legacy-cli-stub/);
  });

  const argv = JSON.parse(fs.readFileSync(argvLog, 'utf8'));
  assert.deepEqual(argv.slice(0, 4), ['send', '--thread', threadOneId, '--prompt']);
  assert.match(argv[4], /cook finished/);

  fs.rmSync(stubDir, { recursive: true, force: true });
}

// The legacy shim defaults to the historical CLI name when only the deprecated
// thread attribution is set, so pre-contract installs keep delivering.
async function testDeprecatedThreadAliasUsesDefaultLegacyCli() {
  const stubDir = fs.mkdtempSync(path.join(os.tmpdir(), 'discord-notify-default-'));
  const argvLog = path.join(stubDir, 'argv.json');
  fs.writeFileSync(
    path.join(stubDir, 'kimaki'),
    `#!/usr/bin/env node\nimport fs from 'node:fs';\nfs.writeFileSync(${JSON.stringify(argvLog)}, JSON.stringify(process.argv.slice(2)));\n`,
  );
  fs.chmodSync(path.join(stubDir, 'kimaki'), 0o755);
  const previousPath = process.env.PATH;
  process.env.PATH = `${stubDir}:${previousPath}`;
  try {
    await withServer(async () => {
      const result = await notify(
        { KIMAKI_THREAD_ID: threadOneId },
        { route: threadRoute(threadOneId) },
      );
      assert.equal(result.status, 'delivered');
      assert.equal(result.delivery.mode, 'session');
      assert.deepEqual(result.deprecations.map((warning) => (warning.match(/KIMAKI_[A-Z_]+/) || [])[0]).sort(), ['KIMAKI_THREAD_ID']);
    });
  } finally {
    process.env.PATH = previousPath;
  }

  const argv = JSON.parse(fs.readFileSync(argvLog, 'utf8'));
  assert.deepEqual(argv.slice(0, 3), ['send', '--thread', threadOneId]);

  fs.rmSync(stubDir, { recursive: true, force: true });
}

// A partial migration keeps working: generic sender configuration wins over
// the legacy CLI, while the deprecated attribution still resolves the session.
async function testGenericSessionEnvironmentWinsOverDeprecatedAliases() {
  const stubDir = fs.mkdtempSync(path.join(os.tmpdir(), 'discord-notify-mixed-'));
  const argvLog = path.join(stubDir, 'argv.json');
  const genericStub = path.join(stubDir, 'generic-stub.mjs');
  const legacyStub = path.join(stubDir, 'legacy-stub.mjs');
  for (const [file, log] of [[genericStub, argvLog], [legacyStub, path.join(stubDir, 'unused.json')]]) {
    fs.writeFileSync(
      file,
      `#!/usr/bin/env node\nimport fs from 'node:fs';\nfs.writeFileSync(${JSON.stringify(log)}, JSON.stringify(process.argv.slice(2)));\n`,
    );
    fs.chmodSync(file, 0o755);
  }

  await withServer(async () => {
    const result = await notify(
      {
        KIMAKI_THREAD_ID: threadOneId,
        KIMAKI_CLI: legacyStub,
        HOMEBOY_SESSION_SEND_COMMAND: `${process.execPath} ${genericStub}`,
      },
      { route: threadRoute(threadOneId) },
    );
    assert.equal(result.status, 'delivered');
    assert.equal(result.delivery.mode, 'session');
    const sender = JSON.parse(fs.readFileSync(argvLog, 'utf8'));
    assert.equal(sender[0], '--thread');
    assert.deepEqual(result.deprecations.map((warning) => (warning.match(/KIMAKI_[A-Z_]+/) || [])[0]).sort(), ['KIMAKI_THREAD_ID']);
  });

  fs.rmSync(stubDir, { recursive: true, force: true });
}

async function testDeprecatedAliasRestFallbackForProgressOnlyAndForeignThread() {
  await withServer(async ({ baseUrl, requests }) => {
    const [progress, foreign] = await Promise.all([
      notify(
        { DISCORD_BOT_TOKEN: secretToken, KIMAKI_THREAD_ID: threadOneId, DISCORD_API_BASE_URL: `${baseUrl}/api/v10` },
        { route: threadRoute(threadOneId), status: 'started', runId: 'run-progress' },
      ),
      notify(
        { DISCORD_BOT_TOKEN: secretToken, KIMAKI_THREAD_ID: threadOneId, DISCORD_API_BASE_URL: `${baseUrl}/api/v10` },
        { route: threadRoute(threadTwoId), runId: 'run-foreign' },
      ),
    ]);
    assert.equal(progress.delivery.mode, 'bot');
    assert.equal(foreign.delivery.mode, 'bot');
    assert.equal(progress.deprecations.length, 1);
    assert.equal(foreign.deprecations.length, 1);
    assert.deepEqual(
      requests.map((request) => request.url).sort(),
      [`/api/v10/channels/${threadOneId}/messages`, `/api/v10/channels/${threadTwoId}/messages`],
    );
  });
}

// The token fallback was removed: DISCORD_BOT_TOKEN is the only bot
// credential name, so installs must export that name explicitly.
async function testKimakiBotTokenFallbackIsRemoved() {
  await withServer(async ({ baseUrl, requests }) => {
    const run = await notifyRaw(
      { KIMAKI_BOT_TOKEN: secretToken, DISCORD_API_BASE_URL: `${baseUrl}/api/v10` },
      { route: threadRoute(threadOneId) },
    );
    assert.equal(run.code, 1);
    assert.match(JSON.parse(run.stdout).error.message, /exactly one auth mode/);
    assert.equal(requests.length, 0);
  });

  await withServer(async ({ baseUrl, requests }) => {
    const result = await notify(
      { DISCORD_BOT_TOKEN: secretToken, KIMAKI_BOT_TOKEN: 'stale-token', DISCORD_API_BASE_URL: `${baseUrl}/api/v10` },
      { route: threadRoute(threadOneId) },
    );
    assert.equal(result.status, 'delivered');
    assert.equal(requests[0].headers.authorization, `Bot ${secretToken}`);
  });
}

async function testConcurrentThreadRoutesDoNotCrossDeliver() {
  await withServer(async ({ baseUrl, requests }) => {
    const env = { DISCORD_BOT_TOKEN: secretToken, DISCORD_API_BASE_URL: `${baseUrl}/api/v10` };
    const [first, second] = await Promise.all([
      notify(env, { route: threadRoute(threadOneId), runId: 'run-one' }),
      notify(env, { route: threadRoute(threadTwoId), runId: 'run-two' }),
    ]);
    assert.equal(first.delivery.route_kind, 'thread');
    assert.equal(second.delivery.route_kind, 'thread');
    assert.equal(first.delivery.destination, 'dynamic_thread');
    assert.equal(second.delivery.destination, 'dynamic_thread');
    assert.deepEqual(
      requests.map((request) => [request.url, request.body.content.includes('run-one') ? 'run-one' : 'run-two']).sort(),
      [
        [`/api/v10/channels/${threadOneId}/messages`, 'run-one'],
        [`/api/v10/channels/${threadTwoId}/messages`, 'run-two'],
      ],
    );
  });
}

async function testGuildlessThreadRoute() {
  // Canonical guild-less form emitted by the chat bridge installer
  // (wp-coding-agents #261): discord:v1:thread:<destination-id>.
  await withServer(async ({ baseUrl, requests }) => {
    const result = await notify(
      { DISCORD_BOT_TOKEN: secretToken, DISCORD_API_BASE_URL: `${baseUrl}/api/v10` },
      { route: `discord:v1:thread:${threadOneId}` },
    );
    assert.equal(result.delivery.route_kind, 'thread');
    assert.equal(result.delivery.destination, 'dynamic_thread');
    assert.equal(requests[0].url, `/api/v10/channels/${threadOneId}/messages`);
  });
}

async function testGuildlessChannelRoute() {
  await withServer(async ({ baseUrl, requests }) => {
    const result = await notify(
      { DISCORD_BOT_TOKEN: secretToken, DISCORD_API_BASE_URL: `${baseUrl}/api/v10` },
      { route: `discord:v1:channel:${channelId}` },
    );
    assert.equal(result.delivery.route_kind, 'channel');
    assert.equal(result.delivery.destination, 'dynamic_channel');
    assert.equal(requests[0].url, `/api/v10/channels/${channelId}/messages`);
  });
}

async function testDynamicChannelRoute() {
  await withServer(async ({ baseUrl, requests }) => {
    const result = await notify({ DISCORD_BOT_TOKEN: secretToken, DISCORD_OPERATIONS_CHANNEL_ID: threadOneId, DISCORD_API_BASE_URL: `${baseUrl}/api/v10` }, { route: channelRoute(channelId) });
    assert.equal(result.delivery.route_kind, 'channel');
    assert.equal(result.delivery.destination, 'dynamic_channel');
    assert.equal(requests[0].url, `/api/v10/channels/${channelId}/messages`);
  });
}

async function testOperationsChannelDelivery() {
  await withServer(async ({ baseUrl, requests }) => {
    const result = await notify({ DISCORD_BOT_TOKEN: secretToken, DISCORD_OPERATIONS_CHANNEL_ID: channelId, DISCORD_API_BASE_URL: `${baseUrl}/api/v10` }, { route: '' });
    assert.equal(result.delivery.route_kind, 'operations');
    assert.equal(result.delivery.destination, 'operations_channel');
    assert.equal(requests[0].url, `/api/v10/channels/${channelId}/messages`);
  });
}

async function testRouteLessBotFailsClosed() {
  await withServer(async ({ baseUrl, requests }) => {
    const run = await notifyRaw({ DISCORD_BOT_TOKEN: secretToken, DISCORD_API_BASE_URL: `${baseUrl}/api/v10` });
    assert.equal(run.code, 1);
    assert.equal(JSON.parse(run.stdout).error.kind, 'input_error');
    assert.equal(requests.length, 0);
  });
}

async function testWebhookDelivery() {
  await withServer(async ({ baseUrl, requests }) => {
    const [defaultResult, threadResult] = await Promise.all([
      notify({ DISCORD_WEBHOOK_URL: `${baseUrl}${secretWebhook}` }),
      notify({ DISCORD_WEBHOOK_URL: `${baseUrl}${secretWebhook}` }, { route: threadRoute(threadTwoId) }),
    ]);
    assert.equal(defaultResult.delivery.destination, 'webhook_default');
    assert.equal(threadResult.delivery.destination, 'dynamic_thread');
    assert.deepEqual(requests.map((request) => request.url).sort(), [
      `${secretWebhook}?wait=true`,
      `${secretWebhook}?wait=true&thread_id=${threadTwoId}`,
    ]);
    assert.equal(requests[0].headers.authorization, undefined);
  });
}

async function testRateLimitRetry() {
  let calls = 0;
  await withServer(async ({ baseUrl, requests }) => {
    const result = await notify({ DISCORD_BOT_TOKEN: secretToken, DISCORD_API_BASE_URL: `${baseUrl}/api/v10` }, { route: channelRoute(channelId) });
    assert.equal(result.status, 'delivered');
    assert.equal(result.attempts, 2);
    assert.equal(requests.length, 2);
  }, (_request, response) => {
    calls += 1;
    if (calls === 1) return response.writeHead(429, { 'content-type': 'application/json' }).end('{"retry_after":0}');
    response.writeHead(200).end('{}');
  });
}

async function testMalformedRouteBeforeNetwork() {
  await withServer(async ({ baseUrl, requests }) => {
    const run = await notifyRaw({ DISCORD_BOT_TOKEN: secretToken, DISCORD_API_BASE_URL: `${baseUrl}/api/v10` }, { route: 'discord:v1:thread:not-a-guild:not-a-thread' });
    assert.equal(run.code, 1);
    assert.equal(JSON.parse(run.stdout).error.kind, 'input_error');
    assert.equal(requests.length, 0);
  });
}

async function testCrossModeRouteBeforeNetwork() {
  await withServer(async ({ baseUrl, requests }) => {
    const run = await notifyRaw({ DISCORD_WEBHOOK_URL: `${baseUrl}${secretWebhook}` }, { route: channelRoute(channelId) });
    assert.equal(run.code, 1);
    assert.equal(JSON.parse(run.stdout).error.kind, 'input_error');
    assert.equal(requests.length, 0);
  });
}

async function testAuthFailureClassification() {
  await withServer(async ({ baseUrl }) => {
    const run = await notifyRaw({ DISCORD_BOT_TOKEN: secretToken, DISCORD_API_BASE_URL: `${baseUrl}/api/v10` }, { route: channelRoute(channelId) });
    assert.equal(run.code, 1);
    assert.equal(JSON.parse(run.stdout).error.kind, 'auth_error');
  }, (_request, response) => response.writeHead(401).end('{}'));
}

async function testTruncation() {
  await withServer(async ({ baseUrl, requests }) => {
    const result = await notify({ DISCORD_BOT_TOKEN: secretToken, DISCORD_API_BASE_URL: `${baseUrl}/api/v10` }, { route: channelRoute(channelId), body: 'x'.repeat(3000) });
    assert.equal(result.delivery.content_length, 2000);
    assert.equal(result.delivery.truncated, true);
    assert.equal(requests[0].body.content.length, 2000);
    assert.equal(requests[0].body.content.endsWith('...'), true);
  });
}

async function testRedactionAndDryRun() {
  const tokenDir = fs.mkdtempSync(path.join(os.tmpdir(), 'discord-notify-redact-'));
  const tokenFile = path.join(tokenDir, 'service-token');
  fs.writeFileSync(tokenFile, 'dry-run-service-secret');
  const stubDir = fs.mkdtempSync(path.join(os.tmpdir(), 'discord-notify-redact-'));
  const stub = path.join(stubDir, 'redact-stub.mjs');
  fs.writeFileSync(stub, '#!/usr/bin/env node\n');
  fs.chmodSync(stub, 0o755);
  try {
    for (const [env, expectedMode] of [
      [{ DISCORD_BOT_TOKEN: secretToken, DISCORD_OPERATIONS_CHANNEL_ID: channelId }, 'bot'],
      [{ DISCORD_WEBHOOK_URL: `https://example.invalid${secretWebhook}` }, 'webhook'],
      [
        {
          HOMEBOY_SESSION_THREAD_ID: threadOneId,
          HOMEBOY_SESSION_SEND_URL: 'http://127.0.0.1:29988/roadie/send',
          HOMEBOY_SESSION_SEND_TOKEN_FILE: tokenFile,
        },
        'session',
      ],
      [{ KIMAKI_THREAD_ID: threadOneId, KIMAKI_CLI: stub }, 'session'],
    ]) {
      const run = await notifyRaw(env, { dryRun: true, route: `discord:v1:thread:${threadOneId}` });
      assert.equal(run.code, 0);
      assert.doesNotMatch(run.stdout, /webhook-secret-456|bot-secret-123|example\.invalid|dry-run-service-secret/);
      const result = JSON.parse(run.stdout);
      assert.equal(result.status, 'dry_run');
      assert.equal(result.attempts, 0);
      assert.equal(result.delivery.mode, expectedMode);
      if (env.KIMAKI_THREAD_ID) {
        assert.equal(result.deprecations.length, 2);
        assert.doesNotMatch(run.stdout, /redact-stub/);
      } else {
        assert.equal(result.deprecations, undefined);
      }
    }
  } finally {
    fs.rmSync(tokenDir, { recursive: true, force: true });
    fs.rmSync(stubDir, { recursive: true, force: true });
  }
}

async function withServer(test, responder = (_request, response) => response.writeHead(200).end('{}')) {
  const requests = [];
  const server = http.createServer(async (request, response) => {
    let raw = '';
    for await (const chunk of request) raw += chunk;
    requests.push({ url: request.url, headers: request.headers, body: parseBody(raw) });
    responder(request, response);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    await test({ baseUrl: `http://127.0.0.1:${server.address().port}`, requests });
  } finally {
    server.close();
    await once(server, 'close');
  }
}

function parseBody(raw) {
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

function notify(env, overrides = {}) {
  return notifyRaw(env, overrides).then((run) => {
    assert.equal(run.code, 0, run.stderr);
    return JSON.parse(run.stdout);
  });
}

function notifyRaw(env, overrides = {}, extraArgs = []) {
  const args = ['--run-id', overrides.runId || 'run-123', '--status', overrides.status || 'pass', '--title', 'homeboy run pass', '--body', overrides.body || 'Run completed'];
  if (overrides.transport !== undefined) args.push('--transport', overrides.transport);
  if (overrides.route !== undefined) args.push('--route', overrides.route);
  if (overrides.dryRun) args.push('--dry-run');
  args.push(...extraArgs);
  return new Promise((resolve, reject) => {
    const childEnv = { ...process.env };
    for (const name of [
      'DISCORD_BOT_TOKEN',
      'DISCORD_WEBHOOK_URL',
      'DISCORD_OPERATIONS_CHANNEL_ID',
      'DISCORD_API_BASE_URL',
      'KIMAKI_BOT_TOKEN',
      'KIMAKI_THREAD_ID',
      'KIMAKI_CLI',
      'HOMEBOY_SESSION_PLATFORM',
      'HOMEBOY_SESSION_THREAD_ID',
      'HOMEBOY_NOTIFICATION_SESSION_ROUTE',
      'HOMEBOY_SESSION_SEND_COMMAND',
      'HOMEBOY_SESSION_SEND_URL',
      'HOMEBOY_SESSION_SEND_TOKEN_FILE',
    ]) delete childEnv[name];
    const child = spawn(process.execPath, [helper, ...args], { env: { ...childEnv, ...env } });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', (code) => resolve({ code, stdout, stderr }));
  });
}

function channelRoute(id) {
  return `discord:v1:channel:${guildId}:${id}`;
}

function threadRoute(id) {
  return `discord:v1:thread:${guildId}:${id}`;
}
