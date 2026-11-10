// Cloudflare Workers entry. Secrets: WEBFLOW_WEBHOOK_SECRET (required), SLACK_WEBHOOK_URL (optional).
// Optional KV binding WEBHOOK_DEDUPE for cross-isolate idempotency.
import { createWebhookRouter } from './router.js';
import { KvDedupe, MemoryDedupe } from './dedupe.js';
import { formSubmissionHandler } from './handlers/forms.js';
import { cmsInvalidationHandler } from './handlers/cms.js';

let cached;
export default {
  async fetch(request, env) {
    if (new URL(request.url).pathname !== '/webhooks/webflow') return new Response('not found', { status: 404 });
    cached ??= createWebhookRouter({
      secret: env.WEBFLOW_WEBHOOK_SECRET,
      dedupe: env.WEBHOOK_DEDUPE ? new KvDedupe(env.WEBHOOK_DEDUPE) : new MemoryDedupe(),
      handlers: {
        form_submission: formSubmissionHandler({ slackWebhookUrl: env.SLACK_WEBHOOK_URL }),
        collection_item_changed: cmsInvalidationHandler({ purge: async () => {} }),
        collection_item_published: cmsInvalidationHandler({ purge: async () => {} }),
      },
      log: (e) => console.log(JSON.stringify(e)),
    });
    return cached(request);
  },
};
