const requestSchema = 'homeboy/notification-route-resolver-request/v1';
const responseSchema = 'homeboy/notification-route-resolver/v1';
const transport = 'discord.run-completion';

let input = '';
for await (const chunk of process.stdin) input += chunk;

let request;
try {
  request = JSON.parse(input);
} catch {
  fail('Invalid notification route resolver request');
}

if (process.exitCode === undefined && !isValidRequest(request)) {
  fail('Invalid notification route resolver request');
}

if (process.exitCode === undefined) {
  const attribution = sessionAttribution(process.env);
  if (!attribution || attribution.error) {
    if (attribution?.error) fail(attribution.error);
    else emit({ schema: responseSchema, status: 'unmatched' });
  } else {
    emit({
      schema: responseSchema,
      status: 'matched',
      route: `discord:v1:${attribution.kind}:${attribution.id}`,
    });
  }
}

// Generic session attribution: the invoking chat session as described by the
// environment the chat bridge's installer maps its own variables onto.
// HOMEBOY_NOTIFICATION_SESSION_ROUTE carries an opaque route;
// HOMEBOY_SESSION_THREAD_ID carries a thread id on the discord platform.
// KIMAKI_THREAD_ID remains as a deprecated alias for installs that predate the
// generic contract (see README); it is removed in the next release.
function sessionAttribution(env) {
  const opaqueRoute = value(env.HOMEBOY_NOTIFICATION_SESSION_ROUTE);
  if (opaqueRoute !== undefined) {
    const parsed = parseRoute(opaqueRoute);
    if (parsed.error) return { error: 'Invalid Discord thread attribution' };
    return { kind: parsed.kind, id: parsed.id };
  }

  const platform = value(env.HOMEBOY_SESSION_PLATFORM);
  if (platform !== undefined && platform !== 'discord') return undefined;

  const threadId = value(env.HOMEBOY_SESSION_THREAD_ID) || value(env.KIMAKI_THREAD_ID);
  if (threadId === undefined) return undefined;
  if (!/^\d{17,20}$/.test(threadId)) return { error: 'Invalid Discord thread attribution' };
  return { kind: 'thread', id: threadId };
}

function parseRoute(route) {
  // Canonical guild-less form emitted by the chat bridge installer
  // (wp-coding-agents #261): discord:v1:<channel|thread>:<destination-id>.
  const canonical = /^discord:v1:(channel|thread):(\d{17,20})$/.exec(route);
  if (canonical) return { kind: canonical[1], id: canonical[2] };
  // Legacy 4-segment form with a guild id. The guild is not used for delivery
  // (only the destination id is), so canonicalize it and drop the guild.
  const legacy = /^discord:v1:(channel|thread):(\d{17,20}):(\d{17,20})$/.exec(route);
  if (legacy) return { kind: legacy[1], id: legacy[3] };
  return { error: true };
}

function isValidRequest(value) {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.keys(value).sort().join(',') === 'schema,transport' &&
    value.schema === requestSchema &&
    value.transport === transport
  );
}

function emit(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exitCode = 2;
}

function value(input) {
  return typeof input === 'string' && input.trim() ? input.trim() : undefined;
}
