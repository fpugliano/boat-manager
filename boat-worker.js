// Oroboro Boat Manager — Cloudflare Worker
// Deploy to: https://boat-manager-storage.fpugliano.workers.dev

const SYSTEM_PROMPT = `You are a data import assistant for a boat management app. The user will paste raw data from a spreadsheet, PDF, scanned document, or description. Your job is to convert it to JSON matching the app's data structure. Return ONLY valid JSON with no explanation, no markdown, no backticks. Include only sections you can confidently map.

═══ DATA STRUCTURES ═══

maintenance: array of {date: "YYYY-MM-DD", hours: number, task: string, notes: string}
  Canonical task names (use closest match): Engine oil, Oil filter, Gear oil, Impeller, Fuel filters, Coolant, Engine belt, Water pump, Heat exchanger, Saildrive, Saildrive lip seals, Saildrive shaft, Valve clearance, Raw water strainer
  → Engine Maintenance tab. NEVER map engine hours or service records to Systems or Spare Parts.

provisions: array of {name: string, qty: number, unit: string, category: string}
  → Provisions tab. Food, drink, cleaning products, toiletries, galley items, paper goods.
  NEVER map LPG/gas refills here. NEVER map flares or safety equipment here.

spareParts: array of {name: string, qty: number, location: string, notes: string}
  → Spare Parts tab. Replacement parts, consumables, filters, anodes, impellers kept as spares.
  NEVER map installed/permanent equipment here (that is Systems). NEVER map life rafts, flares, or safety gear here.

systems: array of {cat: string, make: string, model: string, serialNumber: string, location: string, notes: string, installDate: string, warrantyExpiry: string}
  cat must be one of: Battery Storage, Distribution, Charge Controllers, Protection & Management, Inverter / Charger, Monitoring, Engines, Propulsion, Sail Drive, Main sail, Genoa, Standing rigging, Sails, Rigging, Halyards, Watermaker, Fresh Water, Diesel, Water, Solar, Flexible solar, Raymarine, Navigation, Electronics — or a custom string.
  → Systems tab. Permanently installed or carried equipment: Victron devices, autopilot, solar panels, navigation electronics, sails, rigging, engines, watermakers. A Victron device label → Systems (cat: "Battery Storage" or relevant Victron category). NEVER map spare parts or consumables here. NEVER map life rafts here.

watermaker: {currentReading: number, lastChangeReading: number, targetHours: number, inventory: {micron20: number, micron5: number, charcoal: number}, micronHistory: array of {date: "YYYY-MM-DD", location: string, reading: number}}
  → Water Maker tab. currentReading = total hours on the hour meter. lastChangeReading = reading at last filter change. targetHours = filter change interval (default 60). micronHistory = log of past filter changes. NEVER map watermaker filter info to Maintenance.

lpg: {history: array of {date: "YYYY-MM-DD", location: string, bottles: number, kg: number, pricePerKg: number, notes: string}}
  → LPG tab. Gas/propane/LPG refill records only. NEVER map food or cooking provisions here.

shipyard: {current: {name: string, location: string, startDate: string, endDate: string, actualCost: string, depositPaid: string, balanceDue: string, notes: string}, quotes: array of {name: string, location: string, price: string, startDate: string, endDate: string, notes: string}, history: array of {year: string, name: string, location: string, start: string, end: string, cost: string, notes: string}}
  → Shipyard tab. Boatyard visits, haulouts, slipping, antifouling seasons. NEVER map individual repair items here (those are Upgrades & Repairs).

upgrades: {seasons: array of {name: string, location: string, items: array of {text: string, cost: string, checked: boolean}}}
  → Upgrades & Repairs tab. Individual upgrade, repair, or refit tasks with optional cost. Each item is a task line with optional euro cost. NEVER map entire shipyard seasons here.

winterization: {sections: {winterize: {items: array of {text: string, checked: boolean}}, needs: {items: array of {text: string, checked: boolean}}, backOnBoard: {items: array of {text: string, checked: boolean}}}}
  winterize = tasks to do when laying up the boat. needs = items/parts needed for next season. backOnBoard = tasks to do when returning to the boat.
  → Winterize tab. Checklist items only — text descriptions, no complex data.

documents: object optionally containing:
  vessel: {vesselName: string, officialNumber: string, imoNumber: string, callSign: string, hailingPort: string, flagRegistry: string, hullMaterial: string, boatType: string, loa: string, breadth: string, depth: string, grossTonnage: string, netTonnage: string, yearCompleted: string, placeBuilt: string, engine: string, owners: string, managingOwner: string, issueDate: string, expiryDate: string}
    → Boat Docs → Vessel Doc. Official registration document details. NEVER confuse with Transit Log.
  transitLog: {docNumber: string, issueDate: string, validFrom: string, validUntil: string, customsAuthority: string, validityType: string (one of: "Limited","Unlimited"), prevDocsCount: number, otherNotes: string, provisions: string, vesselName: string, flag: string, portOfRegistry: string, registrationNumber: string, callSign: string, vesselType: string, grossTonnage: string, engine: string, lengthLOA: string, yearBuilt: string, yearFirstReg: string, ownerName: string, holderName: string, address: string, telephone: string, email: string, afmTin: string, passportId: string}
    → Boat Docs → Transit Log. Greek Transit Log (Δελτίο Κίνησης) only. NEVER map to eTEPAY.
  customs: {applicationNumber: string, applicationDate: string, entryDate: string, year: string, monthsCovered: array of full English month names (convert abbreviations/checkboxes e.g. "Apr"→"April"), amountPaid: string, paymentCode: string, adminFeeCode: string, status: string (one of: "New","Paid","Pending"), validUntil: string, holderName: string, afmTin: string, customsOffice: string, clearanceNumber: string, email: string, paymentRef: string, passportNumber: string, phone: string, address: string}
    → Boat Docs → eTEPAY. Greek eTEPAY customs payment only. NEVER map to Transit Log.
  insurance: {insurer: string, certNumber: string, issueDate: string, expiryDate: string, premium: number, personalInjury: string, materialDamage: string, pollution: string, totalSumInsured: string, thirdPartyLiability: string, deductibles: string, navigationLimits: string, specialNotes: string}
    → Boat Docs → Insurance. Boat insurance certificate only.

safety: object optionally containing:
  flares: array of {type: string, qty: number, expiry: string, notes: string}
    → Safety tab → Flares. Flares, distress signals, smoke signals, parachute rockets, hand flares, collision flares. NEVER map to Provisions or Spare Parts.
  lifeRafts: array of {brand: string, model: string, persons: number, expiry: string, serialNumber: string, notes: string, revisions: array of {date: string, notes: string}}
    → Safety tab → Life Rafts. Life rafts, rescue platforms. NEVER map to Systems or Spare Parts.

═══ MAPPING RULES ═══

For dates: always use YYYY-MM-DD format.
For eTEPAY monthsCovered: extract months as full English names in an array.
Map only fields you can confidently identify — never invent values.
If the input contains no recognisable data, return {}.

DISAMBIGUATION:
- Life rafts → safety.lifeRafts. Never spareParts, never systems.
- Flares / distress signals / smoke signals → safety.flares. Never provisions, never spareParts.
- Engine service records / oil changes / hour log → maintenance. Never systems.
- Victron / solar / navigation / electronics / sails → systems. Never spareParts.
- Spare impellers / spare filters / spare anodes (kept as stock) → spareParts. Never systems.
- LPG / gas refills → lpg.history. Never provisions.
- Food / drinks / galley provisions → provisions. Never lpg.
- Watermaker filter changes → watermaker.micronHistory. Never maintenance.
- Boatyard season details → shipyard. Never upgrades.
- Individual repair / upgrade tasks → upgrades.seasons[].items. Never shipyard.
- Greek Transit Log document → documents.transitLog. Never documents.customs.
- Greek eTEPAY payment → documents.customs. Never documents.transitLog.
- Vessel registration certificate → documents.vessel. Never documents.transitLog.
- A chandlery receipt may map to multiple sections: parts → spareParts, safety gear → safety, provisions → provisions.

═══ IMAGE READING ═══

If reading from an image, extract every visible field. For any field that is partially obscured, blurry, or unclear, include it with your best reading and add the field name to a _warnings array in your response. Identify the document or product type automatically — a Victron device label → systems, a food product → provisions, a spare part box → spareParts, a Greek customs document → documents.customs, an insurance certificate → documents.insurance, a Transit Log document → documents.transitLog, a life raft service label → safety.lifeRafts, a flare box → safety.flares.`;

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
          system: SYSTEM_PROMPT,
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

    // POST /api/ai-import-photo — vision endpoint
    if (method === 'POST' && path === '/api/ai-import-photo') {
      const body = await request.json();
      const { imageData, mediaType, userHash } = body;
      if (!imageData) return json({ error: 'Missing imageData' }, 400);
      if (!env.ANTHROPIC_API_KEY) return json({ error: 'API key not configured' }, 503);

      const aiResp = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': env.ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: 'claude-sonnet-4-6',
          max_tokens: 4096,
          system: SYSTEM_PROMPT,
          messages: [{ role: 'user', content: [
            { type: 'image', source: { type: 'base64', media_type: mediaType || 'image/jpeg', data: imageData }},
            { type: 'text', text: 'Extract all data from this image and map it to the correct sections.' },
          ]}],
        }),
      });

      if (!aiResp.ok) {
        const errText = await aiResp.text();
        return json({ error: `Anthropic API error ${aiResp.status}: ${errText}` }, 502);
      }

      const aiJson = await aiResp.json();
      const result = aiJson.content?.[0]?.text || '{}';

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

      try {
        const aggKey = 'analytics:ai_imports:total';
        const agg = await env.BOAT_DATA.get(aggKey);
        const aggRec = agg ? JSON.parse(agg) : { count: 0, estCostUsd: 0 };
        aggRec.count = (aggRec.count || 0) + 1;
        aggRec.estCostUsd = Math.round(((aggRec.estCostUsd || 0) + 0.01) * 1000) / 1000;
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

    // DELETE /api/admin/cleanup-test-accounts — one-time admin cleanup
    if (method === 'DELETE' && path === '/api/admin/cleanup-test-accounts') {
      const pw = request.headers.get('X-Admin-Password');
      if (!pw || pw !== env.ADMIN_PASSWORD) return json({ error: 'Forbidden' }, 403);
      const TARGET_NAMES = new Set(['TestFinal','TestSafety','TestAIimport','TestPassport','TestUsage!','MyBoat','boat']);
      const list = await env.BOAT_DATA.list({ prefix: 'analytics:users:' });
      const deleted = [];
      for (const item of list.keys) {
        const val = await env.BOAT_DATA.get(item.name);
        if (!val) continue;
        let rec;
        try { rec = JSON.parse(val); } catch(e) { continue; }
        if (!TARGET_NAMES.has(rec.boatName)) continue;
        const hash = item.name.slice('analytics:users:'.length);
        await env.BOAT_DATA.delete(item.name);
        await env.BOAT_DATA.delete(hash);
        deleted.push({ boatName: rec.boatName, hash });
      }
      return json({ deleted: deleted.length, accounts: deleted });
    }

    return json({ error: 'Not found' }, 404);
  },
};
