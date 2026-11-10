// form_submission -> normalized lead + Slack Block Kit message.

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const pick = (data, ...names) => {
  const keys = Object.keys(data ?? {});
  for (const n of names) {
    const k = keys.find((x) => x.toLowerCase().replace(/[\s_-]/g, '') === n);
    if (k !== undefined && String(data[k]).trim() !== '') return String(data[k]).trim();
  }
  return null;
};

/** Honeypot: a hidden field real users never fill. Name is configurable. */
export function normalizeLead(payload, { honeypot = 'website' } = {}) {
  const data = payload?.data ?? {};
  const email = pick(data, 'email', 'emailaddress');
  const first = pick(data, 'firstname', 'name', 'fullname');
  const last = pick(data, 'lastname');
  return {
    form: String(payload?.name ?? 'Unknown form').slice(0, 120),
    formId: payload?.formId ?? null,
    submissionId: payload?.id ?? null,
    submittedAt: payload?.submittedAt ?? null,
    name: [first, last].filter(Boolean).join(' ') || null,
    email: email && EMAIL.test(email) ? email.toLowerCase() : null,
    fields: Object.fromEntries(Object.entries(data).slice(0, 50).map(([k, v]) => [String(k).slice(0, 80), String(v).slice(0, 2000)])),
    spam: Boolean(String(data[honeypot] ?? '').trim()),
  };
}

/** Slack mrkdwn escaping: &, <, > are control characters (prevents @channel/link injection via form input). */
export const escapeSlack = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export function slackMessage(lead) {
  const lines = Object.entries(lead.fields).map(([k, v]) => `*${escapeSlack(k)}:* ${escapeSlack(v)}`);
  return {
    text: `New ${lead.form} submission${lead.email ? ` from ${lead.email}` : ''}`,
    blocks: [
      { type: 'header', text: { type: 'plain_text', text: `📥 ${lead.form}`.slice(0, 150) } },
      { type: 'section', text: { type: 'mrkdwn', text: lines.join('\n').slice(0, 2900) || '_empty submission_' } },
      { type: 'context', elements: [{ type: 'mrkdwn', text: `Submitted ${escapeSlack(lead.submittedAt ?? 'unknown time')} · id ${escapeSlack(lead.submissionId ?? 'n/a')}` }] },
    ],
  };
}

/** Handler factory: posts to Slack unless the honeypot tripped. `post` is injectable for tests. */
export function formSubmissionHandler({ slackWebhookUrl, post = fetch, honeypot } = {}) {
  return async (payload) => {
    const lead = normalizeLead(payload, { honeypot });
    if (lead.spam) return { dropped: 'honeypot' };
    if (slackWebhookUrl) {
      const res = await post(slackWebhookUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(slackMessage(lead)) });
      if (!res.ok) throw new Error(`Slack responded ${res.status}`);
    }
    return { lead: { form: lead.form, email: lead.email } };
  };
}
