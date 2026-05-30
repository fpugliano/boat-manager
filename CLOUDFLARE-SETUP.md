# Cloudflare KV Namespace Binding Setup

## Your worker is live at:
https://boat-manager-storage.fpugliano.workers.dev

## Steps to complete the KV binding

1. Go to [Cloudflare Dashboard](https://dash.cloudflare.com) → **Workers & Pages**
2. Click on **boat-manager-storage**
3. Click **Settings** → **Variables** → scroll to **KV Namespace Bindings**
4. Click **Add binding**
   - **Variable name:** `BOAT_DATA`
   - **KV namespace:** Select `boat-data` from the dropdown, or click **Create a namespace** and name it `boat-data`
5. Click **Save and Deploy**

---

## Expected Worker API

The app sends/receives encrypted blobs. Your worker needs these two endpoints:

### `GET /api/data/:uuid`
Returns stored boat data for the given UUID.

**200 response:**
```json
{ "salt": "...", "verify": "...", "data": "..." }
```
**404** if UUID not found.

---

### `PUT /api/data/:uuid`
Stores encrypted boat data. Body:
```json
{ "salt": "...", "verify": "...", "data": "..." }
```
**200 response:**
```json
{ "ok": true }
```

---

## Reference Worker Code

If you need to (re)deploy the worker, here is the full implementation:

```javascript
export default {
  async fetch(request, env) {
    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, PUT, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    };

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }

    const url = new URL(request.url);
    const match = url.pathname.match(/^\/api\/data\/([a-f0-9]+)$/);
    if (!match) {
      return new Response('Not found', { status: 404, headers: corsHeaders });
    }
    const uuid = match[1];

    if (request.method === 'GET') {
      const val = await env.BOAT_DATA.get(uuid);
      if (!val) return new Response('Not found', { status: 404, headers: corsHeaders });
      return new Response(val, {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    if (request.method === 'PUT') {
      const body = await request.json();
      if (!body.salt || !body.verify || !body.data) {
        return new Response('Bad request', { status: 400, headers: corsHeaders });
      }
      await env.BOAT_DATA.put(uuid, JSON.stringify(body));
      return new Response(JSON.stringify({ ok: true }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    return new Response('Method not allowed', { status: 405, headers: corsHeaders });
  }
};
```

Paste this into the worker editor (or deploy via Wrangler), then complete the KV binding steps above.
