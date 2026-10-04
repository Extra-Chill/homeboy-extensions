import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const extensionPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const resolver = path.join(extensionPath, 'scripts/resolve-route.mjs');
const request = {
  schema: 'homeboy/notification-route-resolver-request/v1',
  transport: 'discord.run-completion',
};
const guildId = '123456789012345678';
const threadOneId = '323456789012345678';
const threadTwoId = '423456789012345678';
const channelId = '223456789012345678';

await testMatchedRouteFromGenericThread();
await testMatchedRouteFromOpaqueRoute();
await testForeignPlatformIsUnmatched();
await testDeprecatedAliasStillResolvesTheSession();
await testAttributionPrecedence();
await testMissingContextIsUnmatched();
await testInvalidRequestsFailClosed();
await testInvalidContextFailsClosedWithoutDisclosure();
await testConcurrentInvocationsDoNotCrossRoutes();
console.log('discord route resolver tests passed');

// Generic session attribution: HOMEBOY_SESSION_THREAD_ID carries the Discord
// thread of the invoking session, optionally scoped by HOMEBOY_SESSION_PLATFORM.
async function testMatchedRouteFromGenericThread() {
  const result = await resolve({ HOMEBOY_SESSION_THREAD_ID: threadOneId });
  assert.equal(result.code, 0);
  assert.equal(result.stderr, '');
  assert.deepEqual(JSON.parse(result.stdout), {
    schema: 'homeboy/notification-route-resolver/v1',
    status: 'matched',
    route: `discord:v1:thread:${threadOneId}`,
  });
  assert.equal(result.stdout.split('\n').filter(Boolean).length, 1);

  const scoped = await resolve({ HOMEBOY_SESSION_PLATFORM: 'discord', HOMEBOY_SESSION_THREAD_ID: threadOneId });
  assert.equal(scoped.code, 0);
  assert.deepEqual(JSON.parse(scoped.stdout).route, `discord:v1:thread:${threadOneId}`);
}

// An opaque session route is used as-is; the legacy guild-bearing form is
// canonicalized because only the destination id is used for delivery.
async function testMatchedRouteFromOpaqueRoute() {
  for (const [route, expected] of [
    [`discord:v1:thread:${threadOneId}`, `discord:v1:thread:${threadOneId}`],
    [`discord:v1:channel:${channelId}`, `discord:v1:channel:${channelId}`],
    [`discord:v1:thread:${guildId}:${threadTwoId}`, `discord:v1:thread:${threadTwoId}`],
  ]) {
    const result = await resolve({ HOMEBOY_NOTIFICATION_SESSION_ROUTE: route });
    assert.equal(result.code, 0);
    assert.deepEqual(JSON.parse(result.stdout), {
      schema: 'homeboy/notification-route-resolver/v1',
      status: 'matched',
      route: expected,
    });
  }
}

// The transport only resolves Discord sessions; another platform's session
// context is unmatched, not an error.
async function testForeignPlatformIsUnmatched() {
  const result = await resolve({ HOMEBOY_SESSION_PLATFORM: 'other-chat', HOMEBOY_SESSION_THREAD_ID: threadOneId });
  assert.equal(result.code, 0);
  assert.deepEqual(JSON.parse(result.stdout), {
    schema: 'homeboy/notification-route-resolver/v1',
    status: 'unmatched',
  });
}

// Deprecated shim for installs that predate the generic contract, removed in
// the next release (see README): KIMAKI_THREAD_ID still resolves the session.
async function testDeprecatedAliasStillResolvesTheSession() {
  const result = await resolve({ KIMAKI_THREAD_ID: threadOneId });
  assert.equal(result.code, 0);
  assert.deepEqual(JSON.parse(result.stdout), {
    schema: 'homeboy/notification-route-resolver/v1',
    status: 'matched',
    route: `discord:v1:thread:${threadOneId}`,
  });
}

async function testAttributionPrecedence() {
  const result = await resolve({
    HOMEBOY_NOTIFICATION_SESSION_ROUTE: `discord:v1:thread:${threadTwoId}`,
    HOMEBOY_SESSION_THREAD_ID: threadOneId,
    KIMAKI_THREAD_ID: guildId,
  });
  assert.equal(result.code, 0);
  assert.deepEqual(JSON.parse(result.stdout).route, `discord:v1:thread:${threadTwoId}`);

  const generic = await resolve({
    HOMEBOY_SESSION_THREAD_ID: threadOneId,
    KIMAKI_THREAD_ID: guildId,
  });
  assert.deepEqual(JSON.parse(generic.stdout).route, `discord:v1:thread:${threadOneId}`);
}

async function testMissingContextIsUnmatched() {
  const result = await resolve({ DISCORD_THREAD_ID: threadOneId });
  assert.equal(result.code, 0);
  assert.deepEqual(JSON.parse(result.stdout), {
    schema: 'homeboy/notification-route-resolver/v1',
    status: 'unmatched',
  });
}

async function testInvalidRequestsFailClosed() {
  const invalidRequests = [
    '{',
    JSON.stringify({ ...request, schema: 'unsupported' }),
    JSON.stringify({ ...request, transport: 'other.transport' }),
    JSON.stringify({ ...request, unexpected: true }),
  ];
  for (const input of invalidRequests) {
    const result = await resolve({ KIMAKI_THREAD_ID: threadOneId }, input);
    assert.equal(result.code, 2);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr, 'Invalid notification route resolver request\n');
  }
}

async function testInvalidContextFailsClosedWithoutDisclosure() {
  const secret = 'token=do-not-disclose';
  const invalidContexts = [
    { KIMAKI_THREAD_ID: '123' },
    { KIMAKI_THREAD_ID: 'not-a-snowflake' },
    { KIMAKI_THREAD_ID: '1'.repeat(21) },
    { KIMAKI_THREAD_ID: secret },
    { HOMEBOY_SESSION_THREAD_ID: '123' },
    { HOMEBOY_NOTIFICATION_SESSION_ROUTE: 'discord:v1:thread:not-an-id' },
    { HOMEBOY_NOTIFICATION_SESSION_ROUTE: secret },
  ];
  for (const env of invalidContexts) {
    const result = await resolve(env);
    assert.equal(result.code, 2);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr, 'Invalid Discord thread attribution\n');
    assert.equal(`${result.stdout}${result.stderr}`.includes(secret), false);
  }
}

async function testConcurrentInvocationsDoNotCrossRoutes() {
  const [first, second] = await Promise.all([
    resolve({ HOMEBOY_SESSION_THREAD_ID: threadOneId }),
    resolve({ HOMEBOY_SESSION_THREAD_ID: threadTwoId }),
  ]);
  assert.equal(JSON.parse(first.stdout).route, `discord:v1:thread:${threadOneId}`);
  assert.equal(JSON.parse(second.stdout).route, `discord:v1:thread:${threadTwoId}`);
}

function resolve(env = {}, input = JSON.stringify(request)) {
  return new Promise((resolveResult, reject) => {
    const child = spawn(process.execPath, [resolver], { env, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => (stdout += chunk));
    child.stderr.on('data', (chunk) => (stderr += chunk));
    child.on('error', reject);
    child.on('close', (code) => resolveResult({ code, stdout, stderr }));
    child.stdin.end(input);
  });
}
