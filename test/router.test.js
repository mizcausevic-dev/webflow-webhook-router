import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { sign, verifyWebflowSignature, timingSafeEqualHex, MAX_AGE_MS } from '../src/verify.js';
import { createWebhookRouter, TRIGGER_TYPES } from '../src/router.js';
import { MemoryDedupe } from '../src/dedupe.js';
import { normalizeLead, slackMessage, escapeSlack, formSubmissionHandler } from '../src/handlers/forms.js';
import { cacheTagsFor } from '../src/handlers/cms.js';

const SECRET = 'whsec_test_2b4acfd1c5518bf03c73a4889d197d77';
const NOW = 1_762_810_000_000;
const body = readFileSync(new URL('../examples/form_submission.json', import.meta.url), 'utf8').trim();

async function signedRequest({ raw = body, ts = NOW, secret = SECRET, method = 'POST', sig } = {}) {
  const signature = sig ?? (await sign(secret, ts, raw));
  return new Request('https://hooks.example.com/webhooks/webflow', {
    method, body: method === 'POST' ? raw : undefined,
    headers: { 'content-type': 'application/json', 'x-webflow-timestamp': String(ts), 'x-webflow-signature': signature },
  });
}

test('Web Crypto signature matches an independent node:crypto HMAC', async () => {
  const ours = await sign(SECRET, NOW, body);
  const theirs = createHmac('sha256', SECRET).update(`${NOW}:${body}`).digest('hex');
  assert.equal(ours, theirs);
});

test('verify: valid, tampered, stale, future, malformed, missing secret', async () => {
  const signature = await sign(SECRET, NOW, body);
  const base = { rawBody: body, signature, timestamp: String(NOW), secret: SECRET, now: NOW };
  assert.deepEqual(await verifyWebflowSignature(base), { ok: true });
  assert.equal((await verifyWebflowSignature({ ...base, rawBody: body.replace('Zaphod', 'Arthur') })).reason, 'signature mismatch');
  assert.match((await verifyWebflowSignature({ ...base, now: NOW + MAX_AGE_MS + 1 })).reason, /window/);
  assert.match((await verifyWebflowSignature({ ...base, now: NOW - MAX_AGE_MS - 1 })).reason, /window/);
  assert.equal((await verifyWebflowSignature({ ...base, timestamp: 'abc' })).reason, 'malformed timestamp');
  assert.equal((await verifyWebflowSignature({ ...base, signature: 'zz' })).reason, 'malformed signature');
  assert.match((await verifyWebflowSignature({ ...base, secret: '' })).reason, /misconfigured/);
  assert.match((await verifyWebflowSignature({ ...base, signature: null })).reason, /unsigned/);
});

test('verify accepts the documented JSON.stringify(parsed) form when whitespace was re-serialized', async () => {
  const pretty = JSON.stringify(JSON.parse(body), null, 2);
  const signature = await sign(SECRET, NOW, JSON.stringify(JSON.parse(body)));
  assert.deepEqual(await verifyWebflowSignature({ rawBody: pretty, signature, timestamp: String(NOW), secret: SECRET, now: NOW }), { ok: true });
});

test('timingSafeEqualHex', () => {
  assert.equal(timingSafeEqualHex('ab', 'ab'), true);
  assert.equal(timingSafeEqualHex('ab', 'ac'), false);
  assert.equal(timingSafeEqualHex('ab', 'abc'), false);
});

function router(extra = {}) {
  const calls = [];
  const r = createWebhookRouter({
    secret: SECRET, now: () => NOW,
    handlers: { form_submission: async (p) => { calls.push(p); return { n: calls.length }; } },
    ...extra,
  });
  return { r, calls };
}

test('router: 200 on a valid delivery, handler gets the payload', async () => {
  const { r, calls } = router();
  const res = await r(await signedRequest());
  assert.equal(res.status, 200);
  assert.equal(calls[0].name, 'Contact Us');
});

test('router: duplicate delivery is acknowledged but not re-processed', async () => {
  const { r, calls } = router();
  const req1 = await signedRequest();
  const req2 = await signedRequest();
  assert.equal((await r(req1)).status, 200);
  const second = await r(req2);
  assert.equal(second.status, 200);
  assert.equal((await second.json()).duplicate, true);
  assert.equal(calls.length, 1);
});

test('router: rejects bad method, bad signature, oversize, bad JSON; never echoes the reason', async () => {
  const { r } = router();
  assert.equal((await r(await signedRequest({ method: 'GET' }))).status, 405);
  const bad = await r(await signedRequest({ sig: 'f'.repeat(64) }));
  assert.equal(bad.status, 401);
  assert.deepEqual(await bad.json(), { error: 'unauthorized' });
  assert.equal((await r(await signedRequest({ raw: `{"x":"${'a'.repeat(300 * 1024)}"}` }))).status, 413);
  assert.equal((await r(await signedRequest({ raw: 'not json' }))).status, 400);
});

test('router: verified event without a handler gets 200 (any non-200 makes Webflow retry); handler failure gets 500 and can be retried', async () => {
  const siteBody = JSON.stringify({ triggerType: 'site_publish', payload: { siteId: 's' } });
  const { r } = router();
  assert.equal((await r(await signedRequest({ raw: siteBody }))).status, 200);

  let attempts = 0;
  const flaky = createWebhookRouter({ secret: SECRET, now: () => NOW, handlers: { form_submission: async () => { if (++attempts === 1) throw new Error('downstream down'); return 'ok'; } } });
  assert.equal((await flaky(await signedRequest())).status, 500);
  assert.equal((await flaky(await signedRequest())).status, 200, 'a failed attempt must not be marked as seen');
});

test('router config rejects unknown trigger types; 14 documented types', () => {
  assert.throws(() => createWebhookRouter({ secret: SECRET, handlers: { form_submit: () => {} } }), /unknown triggerType/);
  assert.equal(TRIGGER_TYPES.length, 14);
});

test('dedupe TTL expires', async () => {
  let t = 0;
  const d = new MemoryDedupe({ ttlMs: 100, now: () => t });
  await d.remember('k');
  assert.equal(await d.seen('k'), true);
  t = 101;
  assert.equal(await d.seen('k'), false);
});

test('lead normalization, honeypot and Slack escaping', async () => {
  const payload = JSON.parse(body).payload;
  const lead = normalizeLead(payload);
  assert.equal(lead.email, 'zaphod@heartofgold.ai');
  assert.equal(lead.name, 'Zaphod Beeblebrox');
  assert.equal(lead.spam, false);
  assert.equal(normalizeLead({ data: { ...payload.data, website: 'http://spam' } }).spam, true);
  assert.equal(escapeSlack('<@channel> & <https://x|y>'), '&lt;@channel&gt; &amp; &lt;https://x|y&gt;');
  const msg = JSON.stringify(slackMessage(lead));
  assert.ok(!msg.includes('<@channel>'), 'mention injection must be escaped');

  const posted = [];
  const h = formSubmissionHandler({ slackWebhookUrl: 'https://hooks.slack.test/x', post: async (url, init) => { posted.push(JSON.parse(init.body)); return new Response('ok'); } });
  await h(payload);
  assert.equal(posted.length, 1);
  assert.deepEqual(await h({ data: { website: 'bot' } }), { dropped: 'honeypot' });
  const failing = formSubmissionHandler({ slackWebhookUrl: 'https://x', post: async () => new Response('no', { status: 500 }) });
  await assert.rejects(() => failing(payload), /Slack responded 500/);
});

test('CMS cache tags', () => {
  assert.deepEqual(cacheTagsFor('collection_item_changed', { collectionId: 'c1', fieldData: { slug: 'post-1' } }), ['collection:c1', 'item:post-1']);
  assert.deepEqual(cacheTagsFor('site_publish', {}), ['site:all']);
});

test('worker entry wires the router and 404s other paths', async () => {
  const { default: worker } = await import('../src/worker.js');
  const env = { WEBFLOW_WEBHOOK_SECRET: SECRET };
  assert.equal((await worker.fetch(new Request('https://x/other'), env)).status, 404);
  const ts = Date.now();
  const res = await worker.fetch(await signedRequest({ ts }), env);
  assert.equal(res.status, 200);
});
