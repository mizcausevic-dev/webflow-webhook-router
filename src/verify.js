// Webflow webhook signature verification using Web Crypto, so the same code runs on
// Cloudflare Workers, Deno, Bun, Node 20+ and in the browser.
//
// Per developers.webflow.com ("Working with webhooks"):
//   signature = hex(HMAC-SHA256(key, `${x-webflow-timestamp}:${body}`))
//   key       = the webhook's own secret (site-token webhooks created after 2025-04-14)
//               or the OAuth app's client secret (app-created webhooks)
//   timestamp = Unix epoch milliseconds; reject requests older than 5 minutes.
// Dashboard-created webhooks are not signed and cannot be verified.

export const MAX_AGE_MS = 5 * 60 * 1000;
const enc = new TextEncoder();

const keyCache = new Map();
async function hmacKey(secret) {
  if (!keyCache.has(secret)) {
    keyCache.set(secret, crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']));
  }
  return keyCache.get(secret);
}

export async function sign(secret, timestamp, body) {
  const mac = await crypto.subtle.sign('HMAC', await hmacKey(secret), enc.encode(`${timestamp}:${body}`));
  return [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Constant-time comparison of two hex strings (length leak only). */
export function timingSafeEqualHex(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * @returns {Promise<{ ok: true } | { ok: false, reason: string }>}
 */
export async function verifyWebflowSignature({ rawBody, signature, timestamp, secret, now = Date.now(), maxAgeMs = MAX_AGE_MS }) {
  if (!secret) return { ok: false, reason: 'server misconfigured: no signing secret' };
  if (!signature || !timestamp) return { ok: false, reason: 'missing x-webflow-signature or x-webflow-timestamp (dashboard webhooks are unsigned)' };
  if (!/^\d{10,16}$/.test(String(timestamp))) return { ok: false, reason: 'malformed timestamp' };
  const sig = String(signature).trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(sig)) return { ok: false, reason: 'malformed signature' };
  const age = now - Number(timestamp);
  if (Math.abs(age) > maxAgeMs) return { ok: false, reason: `timestamp outside the ${maxAgeMs / 60000}-minute window` };

  // Primary: the bytes exactly as received. Fallback: Webflow's documented JSON.stringify(parsed body)
  // form, which tolerates proxies that re-serialize JSON whitespace.
  if (timingSafeEqualHex(await sign(secret, timestamp, rawBody), sig)) return { ok: true };
  try {
    const canonical = JSON.stringify(JSON.parse(rawBody));
    if (canonical !== rawBody && timingSafeEqualHex(await sign(secret, timestamp, canonical), sig)) return { ok: true };
  } catch { /* not JSON: fall through */ }
  return { ok: false, reason: 'signature mismatch' };
}
