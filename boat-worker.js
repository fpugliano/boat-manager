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
      'Access-Control-Allow-Headers': 'Content-Type, X-App-Key, X-Admin-Password',
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

    // PUT /api/analytics/users/:hash  — called by the app on signup and sync
    if (method === 'PUT' && path.startsWith('/api/analytics/users/')) {
      const hash = path.split('/api/analytics/users/')[1];
      if (!hash) return json({ error: 'Missing key' }, 400);
      const body = await request.json();
      await env.BOAT_DATA.put(`analytics:users:${hash}`, JSON.stringify(body));
      return json({ ok: true });
    }

    // GET /api/analytics  — admin-only: list all user analytics records
    if (method === 'GET' && path === '/api/analytics') {
      const pw = request.headers.get('X-Admin-Password');
      if (!pw || pw !== env.ADMIN_PASSWORD) return json({ error: 'Forbidden' }, 403);
      const list = await env.BOAT_DATA.list({ prefix: 'analytics:users:' });
      const records = [];
      for (const item of list.keys) {
        const val = await env.BOAT_DATA.get(item.name);
        if (val) records.push(JSON.parse(val));
      }
      return json(records);
    }

    return json({ error: 'Not found' }, 404);
  },
};
