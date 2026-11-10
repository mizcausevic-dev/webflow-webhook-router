# Security Policy

## Reporting a vulnerability

Please open a [private security advisory](../../security/advisories/new) rather than a public issue.

## Threat model

| Threat | Control |
|---|---|
| Forged requests | HMAC-SHA256 over `timestamp:body` with a server-held secret, compared in constant time |
| Replay of a captured request | Timestamp must be within ±5 minutes, and delivered signatures are remembered (idempotency store) |
| Oversized bodies / memory exhaustion | 256 KB cap checked on `Content-Length` and on the actual body |
| Information leakage | The rejection reason is logged server-side but never returned to the caller |
| Injection into downstream tools | Form values are escaped for Slack mrkdwn (`&`, `<`, `>`) and truncated |
| Secret handling | Secrets come only from environment bindings (`wrangler secret put` / env vars), never from code or config files |

Dashboard-created Webflow webhooks are unsigned, so they can't be authenticated. Create webhooks via the API (`POST /v2/sites/{site_id}/webhooks`) or an OAuth app.
