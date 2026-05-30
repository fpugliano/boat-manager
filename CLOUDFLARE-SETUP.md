# Cloudflare Worker Setup

## Worker URL
https://boat-manager-storage.fpugliano.workers.dev

---

## 1. KV Namespace Binding

1. Cloudflare Dashboard → **Workers & Pages** → **boat-manager-storage**
2. **Settings** → **Variables** → **KV Namespace Bindings**
3. Add binding: Variable name = `BOAT_DATA`, KV namespace = `boat-data`
4. **Save and Deploy**

No other environment variables needed.

---

## 2. Worker Code

Paste this into the Worker editor and click **Deploy**:

```javascript
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const cors = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, PUT, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    };

    if (request.method === 'OPTIONS') return new Response(null, { headers: cors });

    const json = (body, status = 200) =>
      new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } });

    // GET /api/data/:key  — fetch full encrypted blob
    if (request.method === 'GET' && url.pathname.startsWith('/api/data/')) {
      const m = url.pathname.match(/^\/api\/data\/([a-f0-9]{64})$/);
      if (!m) return json({ error: 'Not found' }, 404);
      const val = await env.BOAT_DATA.get(m[1]);
      if (!val) return json({ error: 'Not found' }, 404);
      return new Response(val, { headers: { ...cors, 'Content-Type': 'application/json' } });
    }

    // PUT /api/data/:key  — store encrypted blob {salt, verify, data, hint}
    if (request.method === 'PUT' && url.pathname.startsWith('/api/data/')) {
      const m = url.pathname.match(/^\/api\/data\/([a-f0-9]{64})$/);
      if (!m) return json({ error: 'Not found' }, 404);
      const body = await request.json();
      if (!body.salt || !body.verify || !body.data) return json({ error: 'Bad request' }, 400);
      await env.BOAT_DATA.put(m[1], JSON.stringify({
        salt: body.salt, verify: body.verify, data: body.data, hint: body.hint || ''
      }));
      return json({ ok: true });
    }

    // GET /api/hint/:key  — fetch only the PIN hint (no auth required)
    if (request.method === 'GET' && url.pathname.startsWith('/api/hint/')) {
      const m = url.pathname.match(/^\/api\/hint\/([a-f0-9]{64})$/);
      if (!m) return json({ error: 'Not found' }, 404);
      const val = await env.BOAT_DATA.get(m[1]);
      if (!val) return json({ error: 'Not found' }, 404);
      const { hint } = JSON.parse(val);
      return json({ hint: hint || '' });
    }

    return json({ error: 'Not found' }, 404);
  }
};
```

---

## Data format stored in KV

Each user's record is keyed by `SHA-256(email)` and stores:

```json
{
  "salt":   "base64 random bytes (PBKDF2 input)",
  "verify": "AES-GCM encrypted canary",
  "data":   "AES-GCM encrypted app data",
  "hint":   "plain-text PIN hint (may be empty)"
}
```

The `hint` field is unencrypted so the Forgot PIN screen can show it without the PIN.
