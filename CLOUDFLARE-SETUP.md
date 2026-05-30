# Cloudflare Worker Setup

## Worker URL
https://boat-manager-storage.fpugliano.workers.dev

---

## 1. KV Namespace Binding

1. Cloudflare Dashboard → **Workers & Pages** → **boat-manager-storage**
2. **Settings** → **Variables** → **KV Namespace Bindings**
3. Add binding: Variable name = `BOAT_DATA`, KV namespace = `boat-data`
4. **Save and Deploy**

---

## 2. Resend Email Setup (for PIN reset)

1. Create a free account at [resend.com](https://resend.com)
2. Add and verify your domain (`sailingoroboro.com`) under **Domains**
3. Go to **API Keys** → **Create API Key** (full access)
4. Copy the key — you only see it once

Then add it to the Worker:

- Cloudflare Dashboard → **boat-manager-storage** → **Settings** → **Variables**
- Under **Environment Variables**, add:
  - Variable name: `RESEND_API_KEY`
  - Value: your Resend API key
- **Save and Deploy**

---

## 3. Worker Code

Paste this into the Worker editor and click **Deploy**:

```javascript
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const cors = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, PUT, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    };

    if (request.method === 'OPTIONS') return new Response(null, { headers: cors });

    const json = (body, status = 200) =>
      new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } });

    async function hashEmail(email) {
      const buf = await crypto.subtle.digest('SHA-256',
        new TextEncoder().encode(email.toLowerCase().trim()));
      return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
    }

    // GET /api/data/:key  — fetch encrypted blob
    if (request.method === 'GET') {
      const m = url.pathname.match(/^\/api\/data\/([a-f0-9]{64})$/);
      if (!m) return json({ error: 'Not found' }, 404);
      const val = await env.BOAT_DATA.get(m[1]);
      if (!val) return json({ error: 'Not found' }, 404);
      return new Response(val, { headers: { ...cors, 'Content-Type': 'application/json' } });
    }

    // PUT /api/data/:key  — store encrypted blob
    if (request.method === 'PUT') {
      const m = url.pathname.match(/^\/api\/data\/([a-f0-9]{64})$/);
      if (!m) return json({ error: 'Not found' }, 404);
      const body = await request.json();
      if (!body.salt || !body.verify || !body.data) return json({ error: 'Bad request' }, 400);
      await env.BOAT_DATA.put(m[1], JSON.stringify(body));
      return json({ ok: true });
    }

    // POST /api/reset/send  — send 6-digit OTP via Resend
    if (request.method === 'POST' && url.pathname === '/api/reset/send') {
      const { email } = await request.json();
      if (!email) return json({ error: 'Email required' }, 400);
      const key = await hashEmail(email);
      const existing = await env.BOAT_DATA.get(key);
      if (!existing) return json({ error: 'No account found' }, 404);
      const code = String(Math.floor(100000 + Math.random() * 900000));
      await env.BOAT_DATA.put(`reset:${key}`, JSON.stringify({ code, attempts: 0 }), { expirationTtl: 600 });
      const res = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          from: 'Boat Manager <noreply@sailingoroboro.com>',
          to: email,
          subject: 'Your Boat Manager PIN reset code',
          html: `<p>Your reset code is:</p>
                 <p style="font-size:32px;font-weight:bold;letter-spacing:8px">${code}</p>
                 <p>Expires in 10 minutes. If you didn't request this, ignore this email.</p>`
        })
      });
      if (!res.ok) return json({ error: 'Email delivery failed' }, 500);
      return json({ ok: true });
    }

    // POST /api/reset/verify  — verify OTP
    if (request.method === 'POST' && url.pathname === '/api/reset/verify') {
      const { email, code } = await request.json();
      if (!email || !code) return json({ error: 'Email and code required' }, 400);
      const key = await hashEmail(email);
      const stored = await env.BOAT_DATA.get(`reset:${key}`);
      if (!stored) return json({ error: 'Invalid or expired code' }, 400);
      const { code: storedCode, attempts } = JSON.parse(stored);
      if (attempts >= 5) {
        await env.BOAT_DATA.delete(`reset:${key}`);
        return json({ error: 'Too many attempts — request a new code' }, 400);
      }
      if (code !== storedCode) {
        await env.BOAT_DATA.put(`reset:${key}`,
          JSON.stringify({ code: storedCode, attempts: attempts + 1 }),
          { expirationTtl: 600 });
        return json({ error: 'Invalid code' }, 400);
      }
      await env.BOAT_DATA.delete(`reset:${key}`);
      return json({ ok: true });
    }

    return json({ error: 'Not found' }, 404);
  }
};
```

---

## Summary of environment variables

| Variable | Value |
|---|---|
| `BOAT_DATA` | KV namespace binding (`boat-data`) |
| `RESEND_API_KEY` | API key from resend.com |
