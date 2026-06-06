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
      'Access-Control-Allow-Methods': 'GET, PUT, DELETE, POST, OPTIONS',
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

    // POST /api/ai-import — proxy to Anthropic, track analytics
    if (method === 'POST' && path === '/api/ai-import') {
      const body = await request.json();
      const { content, userHash } = body;
      if (!content) return json({ error: 'Missing content' }, 400);
      if (!env.ANTHROPIC_API_KEY) return json({ error: 'API key not configured' }, 503);

      const systemPrompt = `You are a data import assistant for a boat management app. The user will paste raw data from a spreadsheet, PDF, scanned document, or description. Your job is to convert it to JSON matching the app's data structure. Return ONLY valid JSON with no explanation, no markdown, no backticks. The JSON should contain only the sections you can confidently map. Top-level keys and their schemas:

maintenance: array of {date: "YYYY-MM-DD", hours: number, task: string, notes: string}
provisions: array of {name: string, qty: number, unit: string, category: string}
spareParts: array of {name: string, qty: number, location: string, notes: string}
documents: object optionally containing:
  transitLog: {docNumber: string, issueDate: string, validFrom: string, validUntil: string, customsAuthority: string, validityType: string, holderName: string, vesselName: string, flag: string}
  customs: {applicationNumber: string, applicationDate: string, entryDate: string, year: string, monthsCovered: array of full English month names (convert abbreviations or checkboxes to full names e.g. "Apr"→"April"), amountPaid: string, paymentCode: string, adminFeeCode: string, status: string (one of: "New","Paid","Pending"), validUntil: string, holderName: string, afmTin: string, customsOffice: string, clearanceNumber: string, email: string, paymentRef: string, passportNumber: string, phone: string, address: string}
  insurance: {insurer: string, certNumber: string, issueDate: string, expiryDate: string, premium: number, personalInjury: string, materialDamage: string, pollution: string, totalSumInsured: string, thirdPartyLiability: string, deductibles: string, navigationLimits: string, specialNotes: string}

Use these canonical task names for maintenance: Engine oil, Oil filter, Gear oil, Impeller, Fuel filters, Coolant, Engine belt, Water pump, Heat exchanger, Saildrive, Saildrive lip seals, Saildrive shaft, Valve clearance, Raw water strainer. If a task doesn't match, use the closest canonical name. For eTEPAY monthsCovered, extract the list of months covered as full English month names in an array. For dates always use YYYY-MM-DD format. Map only fields you can confidently identify — never invent values. If the input contains no recognisable data, return {}.`;

      const aiResp = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': env.ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: 'claude-sonnet-4-6',
          max_tokens: 2000,
          system: systemPrompt,
          messages: [{ role: 'user', content: String(content).slice(0, 8000) }],
        }),
      });

      if (!aiResp.ok) {
        const errText = await aiResp.text();
        return json({ error: `Anthropic API error ${aiResp.status}: ${errText}` }, 502);
      }

      const aiJson = await aiResp.json();
      const result = aiJson.content?.[0]?.text || '{}';

      // Track per-user analytics
      if (userHash && /^[0-9a-f]{40,}$/.test(userHash)) {
        try {
          const userKey = `analytics:users:${userHash}`;
          const existing = await env.BOAT_DATA.get(userKey);
          if (existing) {
            const rec = JSON.parse(existing);
            rec.aiImports = (rec.aiImports || 0) + 1;
            await env.BOAT_DATA.put(userKey, JSON.stringify(rec));
          }
        } catch(e) {}
      }

      // Track aggregate
      try {
        const aggKey = 'analytics:ai_imports:total';
        const agg = await env.BOAT_DATA.get(aggKey);
        const aggRec = agg ? JSON.parse(agg) : { count: 0, estCostUsd: 0 };
        aggRec.count = (aggRec.count || 0) + 1;
        aggRec.estCostUsd = Math.round(((aggRec.estCostUsd || 0) + 0.002) * 1000) / 1000;
        await env.BOAT_DATA.put(aggKey, JSON.stringify(aggRec));
      } catch(e) {}

      return json({ result });
    }

    // GET /api/analytics/ai-aggregate — admin-only
    if (method === 'GET' && path === '/api/analytics/ai-aggregate') {
      const pw = request.headers.get('X-Admin-Password');
      if (!pw || pw !== env.ADMIN_PASSWORD) return json({ error: 'Forbidden' }, 403);
      const val = await env.BOAT_DATA.get('analytics:ai_imports:total');
      return json(val ? JSON.parse(val) : { count: 0, estCostUsd: 0 });
    }

    return json({ error: 'Not found' }, 404);
  },
};
