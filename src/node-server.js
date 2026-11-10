// Node 20+ adapter: wraps the fetch-style router in node:http. Usage: node src/node-server.js
import http from 'node:http';
import { createWebhookRouter } from './router.js';
import { formSubmissionHandler } from './handlers/forms.js';

const router = createWebhookRouter({
  secret: process.env.WEBFLOW_WEBHOOK_SECRET,
  handlers: { form_submission: formSubmissionHandler({ slackWebhookUrl: process.env.SLACK_WEBHOOK_URL }) },
  log: (e) => console.log(JSON.stringify(e)),
});

const port = Number(process.env.PORT ?? 8787);
http.createServer(async (req, res) => {
  if (req.url !== '/webhooks/webflow') { res.writeHead(404).end(); return; }
  const chunks = [];
  let size = 0;
  for await (const c of req) { size += c.length; if (size > 256 * 1024) { res.writeHead(413).end(); return; } chunks.push(c); }
  const request = new Request(`http://localhost${req.url}`, { method: req.method, headers: req.headers, body: req.method === 'POST' ? Buffer.concat(chunks) : undefined });
  const response = await router(request);
  res.writeHead(response.status, Object.fromEntries(response.headers));
  res.end(await response.text());
}).listen(port, () => console.log(`listening on http://localhost:${port}/webhooks/webflow`));
