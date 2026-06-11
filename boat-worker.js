// Oroboro Boat Manager — Cloudflare Worker
// Deploy to: https://boat-manager-storage.fpugliano.workers.dev

const SYSTEM_PROMPT = `You are a data import assistant for a boat management app. The user will provide raw data from a spreadsheet, PDF, scanned document, photo, or description. Your job is to convert it to JSON matching the app's data structure. Return ONLY valid JSON with no explanation, no markdown, no backticks.

═══ LANGUAGE RULES ═══

The app stores data in English. If the source is in another language (Greek, French, Italian, Spanish, Norwegian, Polish, etc.):
- Translate field VALUES to English EXCEPT: proper nouns (boat names, company names, place names, people names, port names), document numbers, codes, and serial numbers — keep those exactly as written.
- For document type fields with fixed values (e.g. validityType: "Limited" or "Unlimited") always use the English value regardless of source language.
- Greek ΑΦΜ/ΤΙΝ → afmTin field. Greek Δελτίο Κίνησης → documents.transitLog. Greek ΤΕΠΗ/eTEPAY → documents.customs.
- If a field value is ambiguous due to translation, include it in _warnings.

═══ RECEIPT & INVOICE HANDLING ═══

A receipt or invoice may contain multiple categories of items. Split them:
- Marine parts, filters, anodes, impellers purchased → spareParts (with qty and name)
- Food, drink, cleaning products, galley items → provisions
- Safety gear (flares, smoke signals) → safety.flares
- LPG/gas refill line items → lpg.history (one entry per refill event)
- Labour/service charges from a boatyard → upgrades season items

For receipts:
- Ignore VAT lines, totals, subtotals, payment method lines — do not map these
- Unit price → unitPrice field in spareParts if available
- If a receipt line is ambiguous (could be spare part or consumable), map to spareParts with a _warnings entry
- Store/supplier name → location field in spareParts, or notes field

For shipyard invoices:
- Map yard name → shipyard.current.name, location → shipyard.current.location
- Total cost → shipyard.current.actualCost (preserve currency symbol e.g. "€4.200")
- Deposit paid → shipyard.current.depositPaid, balance → shipyard.current.balanceDue
- Invoice dates → shipyard.current.startDate / endDate
- Individual line items (haul-out, antifouling, osmosis work, welding, etc.) → upgrades section as a new season with items
- Do NOT put individual repair line items in shipyard.current.notes — use upgrades

═══ DATA STRUCTURES ═══

maintenance: array of {date: "YYYY-MM-DD", hours: number, task: string, notes: string}
  Canonical task names (use closest match): Engine oil, Oil filter, Gear oil, Impeller, Fuel filters, Coolant, Engine belt, Water pump, Heat exchanger, Saildrive, Saildrive lip seals, Saildrive shaft, Valve clearance, Raw water strainer
  → Engine Maintenance tab. NEVER map engine hours or service records to Systems or Spare Parts.

provisions: array of {name: string, qty: number, unit: string, category: string}
  category must be one of: food, drinks, cleaning, toiletries, galley, paper, other
  → Provisions tab. Food, drink, cleaning products, toiletries, galley items, paper goods.
  NEVER map LPG/gas refills here. NEVER map flares or safety equipment here.

spareParts: array of {name: string, qty: number, location: string, notes: string}
  → Spare Parts tab. Replacement parts, consumables, filters, anodes, impellers kept as spares.
  NEVER map installed/permanent equipment here (that is Systems). NEVER map life rafts, flares, or safety gear here.

systems: array of {cat: string, make: string, model: string, serialNumber: string, location: string, notes: string, installDate: string, warrantyExpiry: string}
  cat must be one of: Battery Storage, Distribution, Charge Controllers, Protection & Management, Inverter / Charger, Monitoring, Engines, Propulsion, Sail Drive, Main sail, Genoa, Standing rigging, Sails, Rigging, Halyards, Watermaker, Fresh Water, Diesel, Water, Solar, Flexible solar, Raymarine, Navigation, Electronics — or a custom string.
  → Systems tab. Permanently installed equipment: Victron devices, autopilot, solar panels, navigation electronics, sails, rigging, engines, watermakers.
  NEVER map spare parts or consumables here. NEVER map life rafts here.

watermaker: {currentReading: number, lastChangeReading: number, targetHours: number, inventory: {micron20: number, micron5: number, charcoal: number}, micronHistory: array of {date: "YYYY-MM-DD", location: string, reading: number}}
  → Water Maker tab. currentReading = total hours on the hour meter. NEVER map watermaker filter info to Maintenance.

lpg: {history: array of {date: "YYYY-MM-DD", location: string, bottles: number, kg: number, pricePerKg: number, notes: string}}
  → LPG tab. Gas/propane/LPG refill records only.
  If price is given per bottle rather than per kg, calculate pricePerKg = totalPrice / totalKg if both available; otherwise put the raw value in notes.
  NEVER map food or cooking provisions here.

shipyard: {current: {name: string, location: string, startDate: string, endDate: string, actualCost: string, depositPaid: string, balanceDue: string, notes: string}, quotes: array of {name: string, location: string, price: string, startDate: string, endDate: string, notes: string}, history: array of {year: string, name: string, location: string, start: string, end: string, cost: string, notes: string}}
  → Shipyard tab. Boatyard visits, haulouts, slipping, antifouling seasons. NEVER map individual repair items here.

upgrades: {seasons: array of {name: string, location: string, items: array of {text: string, cost: string, checked: boolean}}}
  → Upgrades & Repairs tab. Individual upgrade, repair, or refit tasks with optional cost.
  For invoices with line items: create one season. name = yard or supplier name, location = place. Each line item becomes one {text, cost, checked: false} entry.
  Cost format: preserve currency symbol as string e.g. "€450".
  NEVER map entire shipyard seasons here.

winterization: {sections: {winterize: {items: array of {text: string, checked: boolean}}, needs: {items: array of {text: string, checked: boolean}}, backOnBoard: {items: array of {text: string, checked: boolean}}}}
  → Winterize tab. Checklist items only.

documents: object optionally containing:
  vessel: {vesselName, officialNumber, imoNumber, callSign, hailingPort, flagRegistry, hullMaterial, boatType, loa, breadth, depth, grossTonnage, netTonnage, yearCompleted, placeBuilt, engine, owners, managingOwner, issueDate, expiryDate}
    → Boat Docs → Vessel Doc.
  transitLog: {docNumber, issueDate, validFrom, validUntil, customsAuthority, validityType ("Limited" or "Unlimited"), prevDocsCount, otherNotes, provisions, vesselName, flag, portOfRegistry, registrationNumber, callSign, vesselType, grossTonnage, engine, lengthLOA, yearBuilt, yearFirstReg, ownerName, holderName, address, telephone, email, afmTin, passportId}
    → Boat Docs → Transit Log. Greek Transit Log (Δελτίο Κινήσεως) only.
  customs: {applicationNumber, applicationDate, entryDate, year, monthsCovered (array of full English month names), amountPaid, paymentCode, adminFeeCode, status ("New","Paid","Pending"), validUntil, holderName, afmTin, customsOffice, clearanceNumber, email, paymentRef, passportNumber, phone, address}
    → Boat Docs → eTEPAY. Greek eTEPAY customs payment only.
  insurance: {insurer, certNumber, issueDate, expiryDate, premium, personalInjury, materialDamage, pollution, totalSumInsured, thirdPartyLiability, deductibles, navigationLimits, specialNotes}
    → Boat Docs → Insurance.

safety: object optionally containing:
  flares: array of {type: string, qty: number, expiry: string, notes: string}
    type examples: "Parachute rocket", "Hand flare", "Smoke signal", "Collision flare", "Orange smoke"
  lifeRafts: array of {brand: string, model: string, persons: number, expiry: string, serialNumber: string, notes: string, revisions: array of {date: string, notes: string}}

═══ CONFIDENCE RULES ═══

- Include a field only if you can read it clearly or infer it with high confidence.
- If a field is partially obscured, rotated, stamped over, or blurry: include your best reading AND add the field name + reason to _warnings array.
  _warnings format: array of strings e.g. ["expiryDate: partially obscured", "serialNumber: blurry, verify manually"]
- If the input contains no recognisable data at all, return {}.
- Never invent a value. Never guess a number. Omit rather than fabricate.

═══ DISAMBIGUATION ═══

- Life rafts → safety.lifeRafts. Never spareParts, never systems.
- Flares / distress signals / smoke signals → safety.flares. Never provisions, never spareParts.
- Engine service records / oil changes → maintenance. Never systems.
- Victron / solar / navigation / electronics / sails → systems. Never spareParts.
- Spare impellers / spare filters / spare anodes (kept as stock) → spareParts. Never systems.
- LPG / gas / propane / butane refills → lpg.history. Never provisions.
- Food / drinks / galley → provisions. Never lpg.
- Watermaker filter changes → watermaker.micronHistory. Never maintenance.
- Boatyard season / haulout dates / total cost → shipyard. Never upgrades.
- Individual repair / upgrade tasks with line-item costs → upgrades.seasons[].items. Never shipyard.current.notes.
- Greek Transit Log (Δελτίο Κίνησης) → documents.transitLog. Never documents.customs.
- Greek eTEPAY / ΤΕΠΗ → documents.customs. Never documents.transitLog.
- Vessel registration certificate → documents.vessel. Never documents.transitLog.
- A chandlery receipt splits: parts → spareParts, safety gear → safety, provisions → provisions.
- A boatyard invoice splits: yard info → shipyard.current, line items → upgrades season.

═══ IMAGE READING ═══

Before reading any image:
1. Identify the document/object type first.
2. If the image is rotated or upside-down, read it in the correct orientation.
3. Stamps, stickers, or handwritten annotations overlaid on a printed document — read them too.
4. If a field spans two lines, join them into one string.
5. Dates in DD/MM/YYYY or MM/YYYY → convert to YYYY-MM-DD. If only month/year visible, use first of month (e.g. "06/2026" → "2026-06-01").

Auto-identification:
- Victron device label (yellow/blue sticker with serial number) → systems
- Food product / grocery item → provisions
- Spare part box / marine part packaging → spareParts
- Greek document with ΤΕΠΗ or eTEPAY → documents.customs
- Greek document titled ΔΕΛΤΙΟ ΚΙΝΗΣΕΩΣ → documents.transitLog
- Insurance certificate → documents.insurance
- Vessel registration / certificate of registry → documents.vessel
- Life raft service label → safety.lifeRafts
- Flare box → safety.flares
- Marine chandlery receipt → split by item category
- Boatyard / shipyard invoice → split: shipyard + upgrades
- Engine logbook / service record → maintenance
- Watermaker hour meter photo → watermaker.currentReading`;

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
