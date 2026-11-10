import { verifyWebflowSignature } from './verify.js';
import { MemoryDedupe } from './dedupe.js';

export const MAX_BODY_BYTES = 256 * 1024;

export const TRIGGER_TYPES = Object.freeze([
  'form_submission', 'site_publish', 'page_created', 'page_metadata_updated', 'page_deleted',
  'ecomm_new_order', 'ecomm_order_changed', 'ecomm_inventory_changed',
  'collection_item_created', 'collection_item_changed', 'collection_item_deleted',
  'collection_item_published', 'collection_item_unpublished', 'comment_created',
]);

const reply = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });

/**
 * Builds a fetch-style handler: (Request) => Promise<Response>.
 * Status contract. Webflow treats ANY non-200 response as a failed delivery and retries it (up to 3 more times,
 * 10 minutes apart), so: 200 = handled, duplicate, or verified-but-unhandled (never 202/204, which would trigger retries);
 * 4xx = rejected; 500 = handler failure, deliberately, so Webflow's retry gives the handler another chance.
 */
export function createWebhookRouter({ secret, handlers = {}, dedupe = new MemoryDedupe(), now = () => Date.now(), log = () => {} }) {
  for (const t of Object.keys(handlers)) if (!TRIGGER_TYPES.includes(t)) throw new Error(`unknown triggerType "${t}"`);

  return async function handle(request) {
    if (request.method !== 'POST') return reply(405, { error: 'method not allowed' });
    const declared = Number(request.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) return reply(413, { error: 'payload too large' });
    const rawBody = await request.text();
    if (new TextEncoder().encode(rawBody).length > MAX_BODY_BYTES) return reply(413, { error: 'payload too large' });

    const signature = request.headers.get('x-webflow-signature');
    const timestamp = request.headers.get('x-webflow-timestamp');
    const v = await verifyWebflowSignature({ rawBody, signature, timestamp, secret, now: now() });
    if (!v.ok) {
      log({ level: 'warn', msg: 'rejected webhook', reason: v.reason });
      return reply(401, { error: 'unauthorized' }); // reason is logged, not echoed to the caller
    }

    let event;
    try { event = JSON.parse(rawBody); } catch { return reply(400, { error: 'invalid JSON' }); }
    const type = event?.triggerType;
    if (typeof type !== 'string') return reply(400, { error: 'missing triggerType' });

    const key = signature.toLowerCase();
    if (await dedupe.seen(key)) {
      log({ level: 'info', msg: 'duplicate delivery ignored', type });
      return reply(200, { ok: true, duplicate: true });
    }

    const handler = handlers[type];
    if (!handler) {
      await dedupe.remember(key);
      return reply(200, { ok: true, ignored: type });
    }
    try {
      const result = await handler(event.payload ?? {}, { triggerType: type, receivedAt: now() });
      await dedupe.remember(key); // only after success, so a failed attempt can be retried
      log({ level: 'info', msg: 'handled', type });
      return reply(200, { ok: true, type, result: result ?? null });
    } catch (e) {
      log({ level: 'error', msg: 'handler failed', type, error: String(e?.message ?? e) });
      return reply(500, { error: 'handler failed' });
    }
  };
}
