import { sign } from './verify.js';
import { createWebhookRouter } from './router.js';
import { MemoryDedupe } from './dedupe.js';
import { formSubmissionHandler, normalizeLead, slackMessage } from './handlers/forms.js';

const $ = (id) => document.getElementById(id);
const logs = [];
const dedupe = new MemoryDedupe();
let lastDelivery = null;

const SAMPLE = {
  triggerType: 'form_submission',
  payload: {
    name: 'Contact Us', siteId: '65427cf400e02b306eaa049c',
    data: { 'First Name': 'Zaphod', 'Last Name': 'Beeblebrox', email: 'zaphod@heartofgold.ai', Message: 'Interested in a <@channel> demo & pricing', website: '' },
    submittedAt: '2026-11-10T21:35:16.117Z', id: '6321ca84df3949bfc6752327', formId: '65429eadebe8a9f3a30f62d0',
  },
};

function makeRouter(secret) {
  return createWebhookRouter({
    secret,
    dedupe,
    handlers: { form_submission: formSubmissionHandler({ slackWebhookUrl: null }) },
    log: (e) => { logs.push(`${new Date().toISOString().slice(11, 23)} ${e.level.toUpperCase()} ${e.msg}${e.reason ? `: ${e.reason}` : ''}${e.type ? ` (${e.type})` : ''}`); },
  });
}

async function refreshSignature() {
  const ts = Date.now();
  $('ts').textContent = String(ts);
  $('sig').textContent = await sign($('secret').value || ' ', ts, $('body').value);
  try { $('slack').textContent = JSON.stringify(slackMessage(normalizeLead(JSON.parse($('body').value).payload)), null, 2); } catch { $('slack').textContent = 'Body is not valid JSON.'; }
}

async function run(kind) {
  if (kind === 'retry' && !lastDelivery) await run('valid'); // a retry needs an original delivery to repeat
  const secret = $('secret').value;
  let body = $('body').value;
  let ts = Date.now();
  let signWith = secret;
  if (kind === 'stale') ts -= 6 * 60 * 1000;
  if (kind === 'wrongkey') signWith = `${secret}-rotated`;
  if (kind === 'spam') { const o = JSON.parse(body); o.payload.data.website = 'http://cheap-backlinks.example'; o.payload.id = crypto.randomUUID(); body = JSON.stringify(o); }
  if (kind === 'other') body = JSON.stringify({ triggerType: 'site_publish', payload: { siteId: SAMPLE.payload.siteId, publishedAt: new Date().toISOString() } });
  if (kind === 'valid') { const o = JSON.parse(body); o.payload.id = crypto.randomUUID(); body = JSON.stringify(o); }

  let headers;
  if (kind === 'retry' && lastDelivery) headers = lastDelivery.headers, body = lastDelivery.body;
  else {
    const signature = await sign(signWith, ts, body);
    headers = { 'content-type': 'application/json', 'x-webflow-timestamp': String(ts), 'x-webflow-signature': signature };
    if (kind === 'unsigned') headers = { 'content-type': 'application/json' };
  }
  const sentBody = kind === 'tampered' ? body.replace(/zaphod@heartofgold\.ai/, 'attacker@example.com') : body;
  if (kind === 'valid') lastDelivery = { headers, body };

  const res = await makeRouter(secret)(new Request(`${location.origin}/webhooks/webflow`, { method: 'POST', headers, body: sentBody }));
  const text = await res.text();
  const st = $('status');
  st.textContent = `HTTP ${res.status}`;
  st.className = `status s${String(res.status)[0]}`;
  $('response').textContent = JSON.stringify(JSON.parse(text), null, 2);
  $('log').textContent = logs.slice(-8).join('\n');
}

function init() {
  $('body').value = JSON.stringify(SAMPLE, null, 2);
  $('secret').addEventListener('input', refreshSignature);
  $('body').addEventListener('input', refreshSignature);
  document.querySelectorAll('[data-s]').forEach((b) => b.addEventListener('click', () => run(b.dataset.s).catch((e) => { $('response').textContent = e.message; })));
  refreshSignature();
}

init();
