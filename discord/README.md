# Discord Notifications Extension

`discord` is an outbound-only Homeboy notification transport. It posts a run-completion message through Discord's REST API but does not own inbound interactions, buttons, or an orchestration lifecycle. Homeboy's durable run/daemon lifecycle remains authoritative.

Requires a Homeboy version with typed notification transport registry support.

## Setup

Install the extension and select exactly one authentication mode. Keep credentials in your shell secret manager or service environment; the helper never writes them or includes them in its JSON result.

```sh
homeboy extension install https://github.com/Extra-Chill/homeboy-extensions --id discord

# Bot REST delivery. This optional channel is used only for route-less operations
# notifications; a run-scoped route always takes precedence.
export DISCORD_BOT_TOKEN='...'
export DISCORD_OPERATIONS_CHANNEL_ID='123456789012345678'

# Or webhook delivery to its configured default channel.
export DISCORD_WEBHOOK_URL='https://discord.com/api/webhooks/...'
```

`DISCORD_BOT_TOKEN` is the only bot credential name the helper reads. Homeboy
discovers the `discord.run-completion` transport from this extension's
manifest. A Homeboy version with extension-owned route resolver support can
select it automatically from invocation-scoped Discord context. Explicit
notification CLI or environment routes always take precedence.

## Session attribution

A chat-bridge install describes the invoking session to Homeboy through a
generic session contract, so this extension stays independent of any bridge:

| Variable | Meaning |
|---|---|
| `HOMEBOY_NOTIFICATION_SESSION_ROUTE` | Opaque notification route of the invoking session, e.g. `discord:v1:thread:123456789012345678`. |
| `HOMEBOY_SESSION_PLATFORM` | Platform of the invoking session (`discord`). Optional; an unset platform counts as `discord`. |
| `HOMEBOY_SESSION_THREAD_ID` | Discord thread id of the invoking session. |

The bridge's installer maps its own variables onto this contract (for example,
Roadie's `ROADIE_THREAD_ID` becomes `HOMEBOY_SESSION_THREAD_ID`). The route
resolver emits `discord:v1:thread:<thread-id>` from these variables without
notification flags. Homeboy persists the opaque route with the run, so
concurrent detached runs deliver independently. Missing session context
preserves route-less behavior; invalid context fails closed.

## Session delivery

A notification whose route is the invoking session's own thread and whose
status announces an outcome (anything other than `started`, `running`, or
`queued`) is worth a turn in that session: a REST post from the bridge's own
bot is a self-message its ingress drops, so the owning session would never see
its own run finish. That notification is delivered through a configured
session sender. Configure one of:

**Command sender** — the command line is invoked with `--thread <id> --prompt <text>` appended:

```sh
export HOMEBOY_SESSION_SEND_COMMAND='roadie send'
```

**HTTP sender** — matches Roadie's local send API; the service token is read
from a file so it never appears in the process environment or the result
envelope:

```sh
export HOMEBOY_SESSION_SEND_URL='http://127.0.0.1:29988/roadie/send'
export HOMEBOY_SESSION_SEND_TOKEN_FILE='/run/homeboy/roadie-service-token'
```

The HTTP sender POSTs `{"options":{"thread":"<id>","prompt":"<text>"}}` as
JSON with `Authorization: Bearer <service token>`; a `2xx` response counts as
delivered, and any other response is reported as a delivery failure.

With no session sender configured, the notification falls back to normal
bot/webhook REST delivery — the transport's default behavior for every other
route — so a plain Discord bot install needs none of the session variables.

## Deprecated compatibility aliases

`KIMAKI_THREAD_ID` (session attribution) and `KIMAKI_CLI` (session sender,
invoked as `<cli> send --thread <id> --prompt <text>`) are supported this
release only for installs that predate the generic contract. When one is used,
the result envelope reports it in a `deprecations` list; both are removed in
the next release. With only `KIMAKI_THREAD_ID` set, the shim falls back to the
historical `kimaki` CLI name. `KIMAKI_BOT_TOKEN` is no longer read at all —
export `DISCORD_BOT_TOKEN` instead. New installs must use the generic
variables above.

## Usage

```sh
homeboy --notification-transport discord.run-completion \
  --notification-route 'discord:v1:thread:234567890123456789' \
  --detach-after-handoff test
```

Start the daemon after setting its service environment or shell:

```sh
homeboy daemon start
```

The helper emits one typed JSON envelope to stdout, for example:

```json
{"schema":"homeboy/discord-notification-result/v1","status":"delivered","delivery":{"mode":"bot","route_kind":"thread","destination":"dynamic_thread","content_length":74,"truncated":false},"attempts":1}
```

A session turn carries `mode: "session"` with `destination: "session_thread"`,
and appends a `deprecations` list when a deprecated alias provided the session
context:

```json
{"schema":"homeboy/discord-notification-result/v1","status":"delivered","delivery":{"mode":"session","route_kind":"thread","destination":"session_thread","content_length":74,"truncated":false},"attempts":1,"deprecations":["KIMAKI_THREAD_ID is deprecated; set HOMEBOY_SESSION_THREAD_ID or HOMEBOY_NOTIFICATION_SESSION_ROUTE instead."]}
```

Use `--dry-run` to validate arguments and configuration shape without network I/O or secret output:

```sh
node ~/.config/homeboy/extensions/discord/scripts/notify.mjs \
  --run-id run-123 --status pass --title 'homeboy run pass' --body 'Run completed' --dry-run
```

Discord content is bounded to 2,000 characters. The helper retries a Discord `429` at most twice, using the service's `retry_after` value capped at five seconds. Authentication and destination/input rejections are reported as typed `auth_error` or `input_error` results; credentials, webhook URLs, token files, and destination IDs are never included in diagnostics. Result evidence exposes only a route kind and a safe destination classification.

`DISCORD_OPERATIONS_CHANNEL_ID` is an optional bot-mode operations fallback only
when a run has no route. Without a route or this explicit fallback, bot delivery
fails closed. Webhooks use their configured default channel without a route, or
an explicit dynamic thread route; webhook delivery never reads ambient session
configuration. Bot tokens remain service-level authentication and never appear
in routes.

`DISCORD_API_BASE_URL` is an optional HTTP(S) API base override for deterministic local testing only. Production bot delivery defaults to `https://discord.com/api/v10`.
