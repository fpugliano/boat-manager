// Oroboro Boat Manager — Cloudflare Worker
// Deploy to: https://boat-manager-storage.fpugliano.workers.dev

export default {
  async fetch(request, env) {
    const url    = new URL(request.url);
    const path   = url.pathname;
    const method = request.method;

    // CORS headers
    const cors = {
      'Access-Control-Allow-Origin':  '*',
      'Access-Control-Allow-Methods': 'GET, PUT, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, X-App-Key',
    };

    if (method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: cors });
    }

    const json = (obj, status = 200) =>
      new Response(JSON.stringify(obj), {
        status,
        headers: { 'Content-Type': 'application/json', ...cors },
      });

    // GET /api/hint/:uuid
    if (method === 'GET' && path.startsWith('/api/hint/')) {
      const uuid = path.split('/api/hint/')[1];
      if (!uuid) return json({ error: 'Missing key' }, 400);
      const val = await env.BOAT_DATA.get(uuid);
      if (!val) return json({ error: 'Not found' }, 404);
      const rec = JSON.parse(val);
      return json({ hint: rec.hint || '' });
    }

    // GET /api/data/:uuid
    if (method === 'GET' && path.startsWith('/api/data/')) {
      const uuid = path.split('/api/data/')[1];
      if (!uuid) return json({ error: 'Missing key' }, 400);
      const val = await env.BOAT_DATA.get(uuid);
      if (!val) return json({ error: 'Not found' }, 404);
      return json(JSON.parse(val));
    }

    // PUT /api/data/:uuid
    if (method === 'PUT' && path.startsWith('/api/data/')) {
      const uuid = path.split('/api/data/')[1];
      if (!uuid) return json({ error: 'Missing key' }, 400);
      const body = await request.json();
      if (!body.salt || !body.verify || !body.data) {
        return json({ error: 'Missing required fields' }, 400);
      }
      await env.BOAT_DATA.put(uuid, JSON.stringify(body));
      return json({ ok: true });
    }

    // DELETE /api/data/:uuid
    if (method === 'DELETE' && path.startsWith('/api/data/')) {
      const uuid = path.split('/api/data/')[1];
      if (!uuid) return json({ error: 'Missing key' }, 400);
      await env.BOAT_DATA.delete(uuid);
      return json({ ok: true });
    }

    return json({ error: 'Not found' }, 404);
  },
};
