#!/usr/bin/env node

import { spawn } from 'node:child_process';
import fs from 'node:fs';

const DISCORD_CONTENT_LIMIT = 2000;
const MAX_RETRIES = 2;
const MAX_RETRY_DELAY_MS = 5000;

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const validation = validate(args, process.env);
  const deprecations = validation.deprecations || [];
  if (!validation.ok) {
    return finish(failure('input_error', validation.error), deprecations);
  }

  const rendered = renderContent(args);
  const proof = {
    mode: validation.mode,
    route_kind: validation.route_kind,
    destination: validation.destination,
    content_length: rendered.content.length,
    truncated: rendered.truncated,
  };

  if (args.dryRun) {
    return finish(
      {
        schema: 'homeboy/discord-notification-result/v1',
        status: 'dry_run',
        delivery: proof,
        attempts: 0,
      },
      deprecations,
    );
  }

  if (validation.mode === 'session') {
    const delivered =
      validation.sender.kind === 'http'
        ? await sendThroughSessionHttp(validation.sender, validation.threadId, rendered.content)
        : await sendThroughSessionCommand(validation.sender, validation.threadId, rendered.content);
    return finish(
      delivered.ok
        ? { schema: 'homeboy/discord-notification-result/v1', status: 'delivered', delivery: proof, attempts: 1 }
        : failure('delivery_error', delivered.error, proof, 1),
      deprecations,
    );
  }

  let attempts = 0;
  for (;;) {
    attempts += 1;
    let response;
    try {
      response = await fetch(validation.url, {
        method: 'POST',
        headers: validation.headers,
        body: JSON.stringify({ content: rendered.content }),
      });
    } catch {
      return finish(failure('delivery_error', 'Discord request could not be completed.', proof, attempts), deprecations);
    }

    if (response.ok) {
      return finish(
        {
          schema: 'homeboy/discord-notification-result/v1',
          status: 'delivered',
          delivery: proof,
          attempts,
        },
        deprecations,
      );
    }

    if (response.status === 429 && attempts <= MAX_RETRIES) {
      const retryAfterMs = await retryAfter(response);
      await sleep(retryAfterMs);
      continue;
    }

    return finish(failure(classify(response.status), errorFor(response.status), proof, attempts, response.status), deprecations);
  }
}

function parseArgs(tokens) {
  const args = { dryRun: false };
  // Homeboy appends --transport alongside --route whenever the caller
  // selected a transport explicitly. This extension was already chosen by that
  // id, so the value carries no new information — but rejecting the flag makes
  // every explicitly-routed notification fail.
  const names = new Set(['run-id', 'status', 'title', 'body', 'route', 'transport']);
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token === '--dry-run') {
      args.dryRun = true;
      continue;
    }
    if (!token.startsWith('--')) {
      args.error = 'Expected --run-id, --status, --title, and --body; --transport, --route and --dry-run are optional.';
      return args;
    }
    const [flag, inlineValue] = token.slice(2).split(/=(.*)/s, 2);
    if (!names.has(flag) || (inlineValue === undefined && index + 1 >= tokens.length)) {
      args.error = 'Expected --run-id, --status, --title, and --body; --transport, --route and --dry-run are optional.';
      return args;
    }
    const name = flag.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
    args[name] = inlineValue === undefined ? tokens[index + 1] : inlineValue;
    if (inlineValue === undefined) index += 1;
  }
  return args;
}

function validate(args, env) {
  const deprecations = [];
  const out = (result) => ({ ...result, deprecations });

  const session = sessionAttribution(env, deprecations);
  if (session?.error) return out({ ok: false, error: session.error });

  if (args.error || !nonEmpty(args.runId) || !nonEmpty(args.status) || !nonEmpty(args.title) || !nonEmpty(args.body)) {
    return out({ ok: false, error: args.error || 'run-id, status, title, and body must be non-empty.' });
  }

  const route = value(args.route);
  const parsedRoute = route === undefined ? undefined : parseRoute(route);
  if (parsedRoute?.error) return out({ ok: false, error: parsedRoute.error });

  // A REST post from the chat bridge's own application is a self-message its
  // ingress drops, so the session that owns this run never sees its own
  // completion. Delivering the owning thread through the configured session
  // sender makes the notification a real turn instead of a message the agent
  // cannot read.
  //
  // Only a state the session might act on is worth a turn. A run that merely
  // started reports no outcome and no decision, so it is posted for the human
  // to read without interrupting the agent. With no sender configured, the
  // notification falls back to normal bot/webhook REST delivery.
  if (
    parsedRoute?.kind === 'thread' &&
    session?.kind === 'thread' &&
    session.id === parsedRoute.id &&
    !isProgressOnlyStatus(args.status)
  ) {
    const sender = sessionSender(env, session.fromDeprecatedAlias, deprecations);
    if (sender.error) return out({ ok: false, error: sender.error });
    if (sender.configured) {
      return out({
        ok: true,
        mode: 'session',
        route_kind: 'thread',
        destination: 'session_thread',
        threadId: parsedRoute.id,
        sender: sender.value,
      });
    }
  }

  const botToken = value(env.DISCORD_BOT_TOKEN);
  const webhookUrl = value(env.DISCORD_WEBHOOK_URL);
  if (Boolean(botToken) === Boolean(webhookUrl)) {
    return out({ ok: false, error: 'Configure exactly one auth mode: DISCORD_BOT_TOKEN or DISCORD_WEBHOOK_URL.' });
  }

  const operationsChannelId = value(env.DISCORD_OPERATIONS_CHANNEL_ID);
  if (botToken) {
    const resolved = resolveBotDestination(parsedRoute, operationsChannelId);
    if (resolved.error) return out({ ok: false, error: resolved.error });
    const apiBase = value(env.DISCORD_API_BASE_URL) || 'https://discord.com/api/v10';
    let url;
    try {
      url = new URL(`channels/${encodeURIComponent(resolved.id)}/messages`, ensureApiBase(apiBase));
    } catch {
      return out({ ok: false, error: 'DISCORD_API_BASE_URL must be a valid HTTP(S) URL.' });
    }
    if (!isHttp(url)) return out({ ok: false, error: 'DISCORD_API_BASE_URL must be an HTTP(S) URL.' });
    return out({ ok: true, mode: 'bot', ...resolved, url, headers: { authorization: `Bot ${botToken}`, 'content-type': 'application/json' } });
  }

  if (operationsChannelId) return out({ ok: false, error: 'Webhook mode does not use DISCORD_OPERATIONS_CHANNEL_ID.' });
  if (parsedRoute?.kind === 'channel') return out({ ok: false, error: 'A channel route requires DISCORD_BOT_TOKEN; webhook delivery can only target its configured webhook channel or a thread.' });
  let url;
  try {
    url = new URL(webhookUrl);
  } catch {
    return out({ ok: false, error: 'DISCORD_WEBHOOK_URL must be a valid HTTP(S) URL.' });
  }
  if (!isHttp(url)) return out({ ok: false, error: 'DISCORD_WEBHOOK_URL must be an HTTP(S) URL.' });
  url.searchParams.set('wait', 'true');
  if (parsedRoute?.kind === 'thread') url.searchParams.set('thread_id', parsedRoute.id);
  return out({
    ok: true,
    mode: 'webhook',
    route_kind: parsedRoute?.kind || 'webhook',
    destination: parsedRoute ? 'dynamic_thread' : 'webhook_default',
    url,
    headers: { 'content-type': 'application/json' },
  });
}

// The invoking chat session, described by the generic session environment the
// chat bridge's installer maps its own variables onto. Only a Discord session
// attributes this transport: HOMEBOY_NOTIFICATION_SESSION_ROUTE carries an
// opaque route, and HOMEBOY_SESSION_THREAD_ID a thread id on the discord
// platform (an unset HOMEBOY_SESSION_PLATFORM counts as discord).
function sessionAttribution(env, deprecations) {
  const opaqueRoute = value(env.HOMEBOY_NOTIFICATION_SESSION_ROUTE);
  if (opaqueRoute !== undefined) {
    const parsed = parseRoute(opaqueRoute);
    if (parsed.error) return { error: 'HOMEBOY_NOTIFICATION_SESSION_ROUTE must be discord:v1:<channel|thread>:<destination-id> with Discord snowflake IDs.' };
    return { kind: parsed.kind, id: parsed.id };
  }

  const platform = value(env.HOMEBOY_SESSION_PLATFORM);
  if (platform !== undefined && platform !== 'discord') return undefined;

  const threadId = value(env.HOMEBOY_SESSION_THREAD_ID);
  const deprecatedThreadId = value(env.KIMAKI_THREAD_ID);
  if (threadId === undefined && deprecatedThreadId === undefined) return undefined;
  const resolved = threadId ?? deprecatedThreadId;
  if (!isSnowflake(resolved)) {
    return { error: 'Session thread attribution must be a Discord snowflake.' };
  }
  if (threadId === undefined) {
    // Deprecated alias shim for installs that predate the generic contract;
    // removed in the next release (see README).
    deprecations.push('KIMAKI_THREAD_ID is deprecated; set HOMEBOY_SESSION_THREAD_ID or HOMEBOY_NOTIFICATION_SESSION_ROUTE instead.');
    return { kind: 'thread', id: resolved, fromDeprecatedAlias: true };
  }
  return { kind: 'thread', id: resolved };
}

// The configured session sender turns a notification for the invoking session
// into a turn in that session. Two contracts, matching Roadie's seams:
// - HOMEBOY_SESSION_SEND_COMMAND: a command line invoked with
//   `--thread <id> --prompt <text>` appended (Roadie: `roadie send`).
// - HOMEBOY_SESSION_SEND_URL, optionally with HOMEBOY_SESSION_SEND_TOKEN_FILE:
//   POST the send options with a bearer service token read from the file
//   (Roadie's local `POST /roadie/send` service-token API).
function sessionSender(env, fromDeprecatedAlias, deprecations) {
  const sendUrl = value(env.HOMEBOY_SESSION_SEND_URL);
  if (sendUrl !== undefined) {
    let url;
    try {
      url = new URL(sendUrl);
    } catch {
      return { error: 'HOMEBOY_SESSION_SEND_URL must be a valid HTTP(S) URL.' };
    }
    if (!isHttp(url)) return { error: 'HOMEBOY_SESSION_SEND_URL must be an HTTP(S) URL.' };
    const tokenFile = value(env.HOMEBOY_SESSION_SEND_TOKEN_FILE);
    let token;
    if (tokenFile !== undefined) {
      try {
        token = fs.readFileSync(tokenFile, 'utf8').trim();
      } catch {
        return { error: 'HOMEBOY_SESSION_SEND_TOKEN_FILE must name a readable, non-empty token file.' };
      }
      if (!token) return { error: 'HOMEBOY_SESSION_SEND_TOKEN_FILE must name a readable, non-empty token file.' };
    }
    return { configured: true, value: { kind: 'http', url, token } };
  }

  const sendCommand = value(env.HOMEBOY_SESSION_SEND_COMMAND);
  if (sendCommand !== undefined) {
    const argv = splitCommandLine(sendCommand);
    if (argv.error) return { error: argv.error };
    if (!argv.tokens.length) return { error: 'HOMEBOY_SESSION_SEND_COMMAND must name a command to run.' };
    return { configured: true, value: { kind: 'command', file: argv.tokens[0], args: argv.tokens.slice(1) } };
  }

  // Deprecated alias shim for installs that predate the generic contract,
  // removed in the next release: legacy bridge attribution delivered through
  // its CLI as `<cli> send --thread <id> --prompt <text>`.
  if (fromDeprecatedAlias) {
    if (value(env.KIMAKI_CLI) !== undefined) {
      deprecations.push('KIMAKI_CLI is deprecated; set HOMEBOY_SESSION_SEND_COMMAND instead.');
    }
    return { configured: true, value: { kind: 'command', file: value(env.KIMAKI_CLI) || 'kimaki', args: ['send'] } };
  }

  return { configured: false };
}

function resolveBotDestination(route, operationsChannelId) {
  if (route) return { id: route.id, route_kind: route.kind, destination: `dynamic_${route.kind}` };
  if (!operationsChannelId) return { error: 'Bot mode without --route requires DISCORD_OPERATIONS_CHANNEL_ID.' };
  if (!isSnowflake(operationsChannelId)) return { error: 'DISCORD_OPERATIONS_CHANNEL_ID must be a Discord snowflake.' };
  return { id: operationsChannelId, route_kind: 'operations', destination: 'operations_channel' };
}

function parseRoute(route) {
  // Canonical guild-less form emitted by the chat bridge installer
  // (wp-coding-agents #261): discord:v1:<channel|thread>:<destination-id>.
  const canonical = /^discord:v1:(channel|thread):(\d{17,20})$/.exec(route);
  if (canonical) return { kind: canonical[1], id: canonical[2] };
  // Legacy 4-segment form with a guild id. The guild is not used for delivery
  // (only the destination id is), so accept it for backward compatibility.
  const legacy = /^discord:v1:(channel|thread):(\d{17,20}):(\d{17,20})$/.exec(route);
  if (legacy) return { kind: legacy[1], id: legacy[3] };
  return { error: 'route must be discord:v1:<channel|thread>:<destination-id> with Discord snowflake IDs.' };
}

function renderContent(args) {
  const content = `[${compact(args.status)}] ${compact(args.title)}\nRun: ${compact(args.runId)}\n${compact(args.body)}`;
  if (content.length <= DISCORD_CONTENT_LIMIT) return { content, truncated: false };
  let bounded = '';
  for (const character of content) {
    if (bounded.length + character.length > DISCORD_CONTENT_LIMIT - 3) break;
    bounded += character;
  }
  return { content: `${bounded}...`, truncated: true };
}

async function retryAfter(response) {
  let retryAfterSeconds = 0;
  try {
    const body = await response.json();
    retryAfterSeconds = Number(body.retry_after);
  } catch {}
  return Math.min(MAX_RETRY_DELAY_MS, Math.max(0, Number.isFinite(retryAfterSeconds) ? retryAfterSeconds * 1000 : 0));
}

function classify(status) {
  if (status === 401 || status === 403) return 'auth_error';
  if (status === 400 || status === 404 || status === 405 || status === 413 || status === 422) return 'input_error';
  return 'delivery_error';
}

function errorFor(status) {
  if (status === 401 || status === 403) return 'Discord rejected the configured credentials.';
  if (status === 400 || status === 404 || status === 405 || status === 413 || status === 422) return 'Discord rejected the notification input or destination.';
  if (status === 429) return 'Discord rate limit retries were exhausted.';
  return 'Discord returned an unexpected delivery failure.';
}

function failure(kind, error, delivery = undefined, attempts = 0, httpStatus = undefined) {
  return {
    schema: 'homeboy/discord-notification-result/v1',
    status: 'failed',
    error: { kind, message: error, ...(httpStatus === undefined ? {} : { http_status: httpStatus }) },
    ...(delivery === undefined ? {} : { delivery }),
    attempts,
  };
}

function finish(result, deprecations) {
  const payload = deprecations.length ? { ...result, deprecations } : result;
  process.stdout.write(`${JSON.stringify(payload)}\n`);
  process.exitCode = result.status === 'failed' ? 1 : 0;
}

// Statuses that announce progress rather than an outcome. Homeboy emits one of
// these when a run begins, before any result exists to act on.
const PROGRESS_ONLY_STATUSES = new Set(['started', 'running', 'queued']);

function isProgressOnlyStatus(status) {
  return PROGRESS_ONLY_STATUSES.has(String(status || '').trim().toLowerCase());
}

function sendThroughSessionCommand(sender, threadId, content) {
  return new Promise((resolve) => {
    const child = spawn(
      sender.file,
      [...sender.args, '--thread', threadId, '--prompt', content],
      { stdio: ['ignore', 'ignore', 'pipe'] },
    );
    let stderr = '';
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.once('error', () => resolve({ ok: false, error: 'The session sender command could not be started.' }));
    child.once('close', (code) =>
      resolve(
        code === 0
          ? { ok: true }
          : { ok: false, error: `The session sender command exited with status ${code}: ${compact(stderr).slice(0, 200)}` },
      ),
    );
  });
}

// Roadie's POST /roadie/send accepts the request with HTTP 200 and then streams
// the send's outcome as NDJSON events, ending with `{"exit": <code>}`. A 200
// therefore only means the request was accepted; the exit event decides
// delivery. A sender that streams no exit event is judged by its HTTP status.
async function sendThroughSessionHttp(sender, threadId, content) {
  let response;
  try {
    response = await fetch(sender.url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(sender.token === undefined ? {} : { authorization: `Bearer ${sender.token}` }),
      },
      body: JSON.stringify({ options: { thread: threadId, prompt: content } }),
    });
  } catch {
    return { ok: false, error: 'The session sender could not be reached.' };
  }
  if (!response.ok) {
    return { ok: false, error: `The session sender rejected the notification with HTTP status ${response.status}.` };
  }

  let body;
  try {
    body = await response.text();
  } catch {
    return { ok: false, error: 'The session sender response could not be read.' };
  }
  let exitCode;
  let stderr = '';
  for (const line of body.split('\n')) {
    if (!line.trim()) continue;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (event && typeof event.exit === 'number') exitCode = event.exit;
    else if (event?.stream === 'stderr' && typeof event.data === 'string') stderr += event.data;
  }
  if (exitCode === undefined || exitCode === 0) return { ok: true };
  return { ok: false, error: `The session sender exited with status ${exitCode}: ${compact(stderr).slice(0, 200)}` };
}

// Split a command line into argv without a shell: whitespace separates
// arguments, and single or double quotes group whitespace into one argument.
function splitCommandLine(input) {
  const tokens = [];
  let current = '';
  let quote;
  let started = false;
  for (const character of input) {
    if (quote !== undefined) {
      if (character === quote) quote = undefined;
      else current += character;
    } else if (character === '"' || character === "'") {
      quote = character;
      started = true;
    } else if (/\s/.test(character)) {
      if (started) {
        tokens.push(current);
        current = '';
        started = false;
      }
    } else {
      current += character;
      started = true;
    }
  }
  if (quote !== undefined) return { error: 'HOMEBOY_SESSION_SEND_COMMAND has an unterminated quote.' };
  if (started) tokens.push(current);
  return { tokens };
}

function ensureApiBase(base) {
  return base.endsWith('/') ? base : `${base}/`;
}

function compact(text) {
  return String(text).replace(/\s+/g, ' ').trim();
}

function value(input) {
  return typeof input === 'string' && input.trim() ? input.trim() : undefined;
}

function nonEmpty(input) {
  return value(input) !== undefined;
}

function isHttp(url) {
  return url.protocol === 'https:' || url.protocol === 'http:';
}

function isSnowflake(input) {
  return typeof input === 'string' && /^\d{17,20}$/.test(input);
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

await main();
