'use strict';

// ═══════════════════════════════════════════════════════════
//  CONSTANTS & DEFAULTS
// ═══════════════════════════════════════════════════════════

const ENC_KEY      = 'bm_enc';        // AES-GCM encrypted app data
const SALT_KEY     = 'bm_salt';       // random PBKDF2 salt (not sensitive)
const VERIFY_KEY   = 'bm_verify';     // encrypted canary for password verification
const ATTEMPTS_KEY = 'bm_attempts';   // {count, lockUntil}
const BACKUP_TS    = 'bm_last_backup';// timestamp of last manual backup
const logoSrc = (typeof OROBORO_LOGO !== 'undefined') ? OROBORO_LOGO : '';
const STORAGE_WORKER_URL = (typeof OWNER_STORAGE_URL !== 'undefined') ? OWNER_STORAGE_URL : '';
const EMAIL_KEY     = 'bm_email';
const HINT_KEY      = 'bm_hint';
const UPGRADES_DATA_VERSION = 2;
const LAST_SYNC_KEY = 'bm_last_sync';

// ── Crypto runtime state (memory only — never persisted) ───────
let cryptoKey    = null;   // CryptoKey object; null = locked
let lastActivity   = 0;
let lockTimer      = null;
let _autoSyncTimer = null;
const LOCK_MS    = 5 * 60 * 1000;  // auto-lock after 5 min idle
const MAX_FAILS  = 5;              // attempts before lockout
const LOCKOUT_MS = 30 * 1000;      // lockout duration
let syncStatus = 'idle'; // 'idle'|'syncing'|'synced'|'offline'


const EMPTY_DEFAULTS = {
  meta:{ boatName:'', ownerName:'', email:'', flag:'', hullType:'catamaran', setupComplete:false },
  documents:{
    vessel:{
      vesselName:'', officialNumber:'', imoNumber:'',
      callSign:'', hailingPort:'', flagRegistry:'',
      hullMaterial:'', boatType:'',
      grossTonnage:'', netTonnage:'', loa:'', breadth:'', depth:'',
      yearCompleted:'', placeBuilt:'',
      owners:'', managingOwner:'',
      issueDate:'', expiryDate:'', engine:''
    },
    insurance:{
      insurer:'', policyNumber:'',
      certNumber:'', issueDate:'', expiryDate:'',
      premium:'', maxPersonalInjury:'',
      maxMaterial:'',
      maxPollution:'',
      renewalHistory:[]
    },
    customs:{
      holderName:'', address:'',
      email:'', afm:'',
      customsOffice:'', clearanceNumber:'',
      paymentRef:'', validUntil:'', renewalHistory:[]
    }
  },
  crew:[],
  photos:{vesselDoc:[], insurance:[], transitLog:[], crewList:[]},
  shipyard:{
    current:{name:'', location:'', contact:'', website:'', startDate:'', endDate:'',
             estimatedCost:'', actualCost:'', status:'Provisional', depositPaid:'', balanceDue:'', notes:''},
    quotes:[], history:[]
  },
  watermaker:{currentReading:0, lastChangeReading:0, targetHours:60, charcoalChangedDate:null, inventory:{micron20:0, micron5:0, charcoal:0}},
  lpg:{bottles:[], history:[]},
  provisions:{items:[]},
  spareParts:[
    {id:'ex_p1', desc:'Heat Exchanger gasket', pn:'128370-13201', category:'Inboard', qty:4, minQuantity:2, unitPrice:0,  location:'', storeUrl:''},
    {id:'ex_p2', desc:'Engine Oil filter',     pn:'119305-35170-9', category:'Inboard', qty:2, minQuantity:1, unitPrice:8,  location:'', storeUrl:''},
    {id:'ex_p3', desc:'Impeller',              pn:'128990-42570', category:'Outboard', qty:1, minQuantity:1, unitPrice:26, location:'', storeUrl:''},
  ],
  systems:[
    {id:'ex_s1', cat:'Battery Storage', category:'Battery Storage', make:'Victron', model:'Lithium Battery A', serialNumber:'', location:'engine room port',       installDate:'', lastService:'', warrantyExpiry:'', manualUrl:'', notes:'12V', photos:[]},
    {id:'ex_s2', cat:'Battery Storage', category:'Battery Storage', make:'Victron', model:'Lithium Battery B', serialNumber:'', location:'engine room centre',     installDate:'', lastService:'', warrantyExpiry:'', manualUrl:'', notes:'12V', photos:[]},
    {id:'ex_s3', cat:'Battery Storage', category:'Battery Storage', make:'Victron', model:'Lithium Battery C', serialNumber:'', location:'engine room starboard',  installDate:'', lastService:'', warrantyExpiry:'', manualUrl:'', notes:'12V', photos:[]},
  ],
  safety: { flares: [], lifeRafts: [] },
  schengen: null
};

// ═══════════════════════════════════════════════════════════
//  YANMAR FULL MAINTENANCE SCHEDULE
// ═══════════════════════════════════════════════════════════

const YANMAR_SCHED = [
  // FUEL SYSTEM
  {id:'fs3',sys:'Fuel System',         task:'Drain the fuel tank',                            type:'user',  intHrs:250,  initHrs:50,   intLabel:'Initial 50h, then every 250h'},
  {id:'fs4',sys:'Fuel System',         task:'Drain the fuel filter',                          type:'user',  intHrs:50,   initHrs:null, intLabel:'Every 50h'},
  {id:'fs5',sys:'Fuel System',         task:'Replace the fuel filter',                        type:'parts', intHrs:250,  initHrs:null, intLabel:'Every 250h'},
  {id:'fs6',sys:'Fuel System',         task:'Check injection timing',                         type:'shop',  intHrs:1000, initHrs:null, intLabel:'Every 1000h'},
  {id:'fs7',sys:'Fuel System',         task:'Check injection spray condition',                type:'shop',  intHrs:1000, initHrs:null, intLabel:'Every 1000h'},
  // LUBRICATING SYSTEM
  {id:'ls3',sys:'Lubricating System',  task:'Replace crankcase lube oil',                     type:'parts', intHrs:150,  initHrs:50,   intLabel:'Initial 50h, then every 150h'},
  {id:'ls4',sys:'Lubricating System',  task:'Replace marine gear lube oil',                   type:'parts', intHrs:150,  initHrs:50,   intLabel:'Initial 50h, then every 150h'},
  {id:'ls5',sys:'Lubricating System',  task:'Replace sail drive oil',                         type:'parts', intHrs:100,  initHrs:50,   intLabel:'Initial 50h, then every 100h'},
  {id:'ls6',sys:'Lubricating System',  task:'Replace engine lube oil filter',                 type:'parts', intHrs:250,  initHrs:50,   intLabel:'Initial 50h, then every 250h'},
  // COOLING SYSTEM
  {id:'cs3',sys:'Cooling System',      task:'Check / replace impeller of cooling water pump', type:'parts', intHrs:250,  initHrs:null, intLabel:'Check every 250h, replace every 1000h'},
  {id:'cs4',sys:'Cooling System',      task:'Replace fresh water coolant',                    type:'parts', intHrs:null, initHrs:null, intLabel:'Every year', annual:true},
  {id:'cs5',sys:'Cooling System',      task:'Clean and check water passages',                 type:'shop',  intHrs:1000, initHrs:null, intLabel:'Every 1000h'},
  // AIR INTAKE & EXHAUST
  {id:'ae1',sys:'Air Intake & Exhaust',task:'Clean air intake silencer element',              type:'user',  intHrs:250,  initHrs:null, intLabel:'Every 250h'},
  {id:'ae2',sys:'Air Intake & Exhaust',task:'Clean exhaust / water mixing elbow',             type:'user',  intHrs:250,  initHrs:null, intLabel:'Every 250h'},
  {id:'ae4',sys:'Air Intake & Exhaust',task:'Diaphragm assembly inspection',                  type:'shop',  intHrs:1000, initHrs:null, intLabel:'Every 1000h'},
  // ELECTRICAL SYSTEM
  {id:'el2',sys:'Electrical System',   task:'Check electrolyte level in battery',             type:'user',  intHrs:50,   initHrs:null, intLabel:'Every 50h'},
  {id:'el3',sys:'Electrical System',   task:'Adjust / replace alternator driving belt',       type:'user',  intHrs:250,  initHrs:50,   intLabel:'Initial 50h, then every 250h'},
  {id:'el4',sys:'Electrical System',   task:'Check wiring connectors',                        type:'user',  intHrs:250,  initHrs:null, intLabel:'Every 250h'},
  // CYLINDER HEAD
  {id:'ch2',sys:'Cylinder Head',       task:'Retighten all major nuts and bolts',             type:'shop',  intHrs:1000, initHrs:null, intLabel:'Every 1000h'},
  {id:'ch3',sys:'Cylinder Head',       task:'Adjust intake / exhaust valve clearance',        type:'shop',  intHrs:1000, initHrs:50,   intLabel:'Initial 50h, then every 1000h'},
  // REMOTE CONTROL
  {id:'rc1',sys:'Remote Control',      task:'Check / adjust remote control operation',        type:'shop',  intHrs:1000, initHrs:50,   intLabel:'Initial 50h, then every 1000h'},
  {id:'rc2',sys:'Remote Control',      task:'Adjust propeller shaft alignment',               type:'shop',  intHrs:1000, initHrs:50,   intLabel:'Initial 50h, then every 1000h'},
];

// ═══════════════════════════════════════════════════════════
//  STATE
// ═══════════════════════════════════════════════════════════

let data = {};
let ui = {
  tab:'documents', docSub:'vessel', maintEngine:'port',
  photoSub:'vesselDoc', crewOpen:null, sysOpen:null, sysTab:'All', sysOverviewOpen:false,
  partsSearch:'', partsFilter:'All', alertsOpen:false, maintShowAll:false, maintTaskFilter:'All',
  provisionsSub:'all', provisionsView:'list', provHistGroup:null, tlDetailId:null
};
let _photoCtx = null; // {section, index} for upload

// ═══════════════════════════════════════════════════════════
//  UTILITIES
// ═══════════════════════════════════════════════════════════

function uid(){ return '_'+Math.random().toString(36).slice(2,9)+Date.now().toString(36); }
function esc(s){ return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
function normCat(c){ if(!c) return c; if(c==='Port Engine'||c==='Starboard Engine') return 'Inboard'; if(c==='Suzuki Outboard') return 'Outboard'; return c; }
function fmtSchedDate(d){ if(!d) return ''; return d.slice(5)+'/'+d.slice(2,4); } // "2026-05-30" → "05-30/26"
let _lastSchedUndo = null;

function parseISODate(str) {
  if (!str) return null;
  const m = String(str).match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return null;
  return new Date(+m[1], +m[2]-1, +m[3]);
}
function fmtDateEU(isoStr) {
  const d = parseISODate(isoStr);
  if (!d || isNaN(d)) return isoStr || '';
  return String(d.getDate()).padStart(2,'0') + '/' + String(d.getMonth()+1).padStart(2,'0') + '/' + d.getFullYear();
}
function daysUntil(dateStr) {
  if (!dateStr) return 9999;
  const d = parseISODate(dateStr) || new Date(dateStr);
  const now = new Date(); now.setHours(0,0,0,0); d.setHours(0,0,0,0);
  return Math.round((d - now) / 86400000);
}

function fmtDate(dateStr) {
  if (!dateStr) return '';
  const d = parseISODate(dateStr) || new Date(dateStr);
  if (isNaN(d)) return dateStr;
  return d.toLocaleDateString('en-GB',{day:'numeric',month:'short',year:'numeric'});
}

function alertColor(days, threshold) {
  if (days < 0) return 'red';
  if (days <= threshold * 0.25) return 'red';
  if (days <= threshold * 0.5) return 'orange';
  return 'yellow';
}

function expiryBadge(dateStr, threshold=90) {
  const d = daysUntil(dateStr);
  if (d > threshold) return '';
  const cls = d < 0 ? 'b-red' : d < threshold*0.3 ? 'b-red' : 'b-orange';
  const txt = d < 0 ? `Expired ${Math.abs(d)}d ago` : `Expires in ${d}d`;
  return `<span class="badge ${cls}">${txt}</span>`;
}


function initials(name) {
  return (name||'?').split(' ').map(w=>w[0]).slice(0,2).join('').toUpperCase();
}

function engLabel(id) {
  if (data.meta.hullType === 'catamaran') {
    return id === 'port' ? 'Port Engine' : 'Starboard Engine';
  }
  return 'Engine';
}

function getEngines() {
  if (data.meta.hullType === 'catamaran') return ['port','starboard'];
  return ['main'];
}

// ═══════════════════════════════════════════════════════════
//  STORAGE
// ═══════════════════════════════════════════════════════════

// ── Low-level base64 / Uint8Array helpers ─────────────────────
function u8ToB64(u8) {
  let s = ''; for (let i = 0; i < u8.length; i++) s += String.fromCharCode(u8[i]);
  return btoa(s);
}
function b64ToU8(b64) {
  const s = atob(b64); const u = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) u[i] = s.charCodeAt(i); return u;
}

// ── Key derivation (PBKDF2 → AES-GCM 256) ─────────────────────
async function getOrCreateSalt() {
  let b = localStorage.getItem(SALT_KEY);
  if (!b) { b = u8ToB64(crypto.getRandomValues(new Uint8Array(16))); localStorage.setItem(SALT_KEY, b); }
  return b64ToU8(b);
}

async function deriveKey(password, salt) {
  const km = await crypto.subtle.importKey('raw', new TextEncoder().encode(password),
    { name:'PBKDF2' }, false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name:'PBKDF2', salt, iterations:100000, hash:'SHA-256' },
    km, { name:'AES-GCM', length:256 }, false, ['encrypt','decrypt']);
}

// ── AES-GCM encrypt / decrypt ──────────────────────────────────
async function aesEncrypt(key, plaintext) {
  const iv  = crypto.getRandomValues(new Uint8Array(12));
  const ct  = await crypto.subtle.encrypt({ name:'AES-GCM', iv }, key, new TextEncoder().encode(plaintext));
  return JSON.stringify({ iv: u8ToB64(iv), data: u8ToB64(new Uint8Array(ct)) });
}
async function aesDecrypt(key, storedJson) {
  const s  = JSON.parse(storedJson);
  const pt = await crypto.subtle.decrypt({ name:'AES-GCM', iv:b64ToU8(s.iv) }, key, b64ToU8(s.data));
  return new TextDecoder().decode(pt);
}

// ── Encrypted save / load ──────────────────────────────────────
async function save() {
  if (!cryptoKey) return;
  try {
    const enc = await aesEncrypt(cryptoKey, JSON.stringify(data));
    localStorage.setItem(ENC_KEY, enc);
    pushToCloud();
  } catch(e) { console.warn('Save failed', e); }
}

async function load() {
  if (!cryptoKey) return false;
  try {
    const raw = localStorage.getItem(ENC_KEY);
    if (!raw) return false;
    data = JSON.parse(await aesDecrypt(cryptoKey, raw));
    return true;
  } catch(e) { return false; }
}

function saveField(path, value) {
  const parts = path.split('.');
  let obj = data;
  for (let i = 0; i < parts.length-1; i++) {
    if (obj[parts[i]] === undefined) obj[parts[i]] = {};
    obj = obj[parts[i]];
  }
  obj[parts[parts.length-1]] = value;
  save(); // async fire-and-forget — data already updated in memory
  renderAlertBar();
}

// ── Encrypted export / import ──────────────────────────────────
function handleImport(input) {
  const file = input.files[0]; if (!file) return;
  const reader = new FileReader();
  reader.onload = async e => {
    try {
      const fileJson = JSON.parse(e.target.result);
      // Ask for the password used to encrypt this export
      showModal('Restore Backup', `
        <div style="font-size:14px;color:var(--label2);margin-bottom:14px">
          Enter the 4-digit PIN from the account that created this backup.
        </div>
        <div class="mi-label">PIN</div>
        <input class="mi" type="number" id="imp-pw" placeholder="4-digit PIN" maxlength="4" pattern="[0-9]*" inputmode="numeric" autofocus>
        <div id="imp-err" style="color:var(--red);font-size:13px;min-height:18px;margin-bottom:8px"></div>
        <div class="modal-btns">
          <button class="btn btn-s" onclick="hideModal()">Cancel</button>
          <button class="btn btn-p" id="imp-btn" onclick="doImport(${JSON.stringify(JSON.stringify(fileJson))})">Restore</button>
        </div>`);
    } catch { showToast('Import failed — invalid file', true); }
    input.value = '';
  };
  reader.readAsText(file);
}

async function doImport(fileJsonStr) {
  const pin   = (document.getElementById('imp-pw')?.value || '').trim();
  const errEl = document.getElementById('imp-err');
  const btn   = document.getElementById('imp-btn');
  if (!pin) { if (errEl) errEl.textContent = 'Enter your 4-digit PIN'; return; }
  if (errEl) errEl.textContent = '';
  if (btn) { btn.textContent = 'Importing…'; btn.disabled = true; }

  try {
    const fileJson = JSON.parse(fileJsonStr);

    // ── Full backup format: { format, salt, verify, data } ──────────
    if (fileJson.format === 'oroboro-boat-backup-v1') {
      if (!fileJson.salt || !fileJson.verify || !fileJson.data) throw new Error('corrupted');
      const salt = b64ToU8(fileJson.salt);
      const key  = await deriveKey(pin, salt);
      // Verify PIN before attempting decrypt
      try { await aesDecrypt(key, fileJson.verify); }
      catch {
        if (errEl) errEl.textContent = 'Wrong PIN — this backup was created with a different PIN';
        if (btn) { btn.textContent = 'Restore'; btn.disabled = false; }
        return;
      }
      let decrypted;
      try { decrypted = JSON.parse(await aesDecrypt(key, fileJson.data)); }
      catch { throw new Error('corrupted'); }
      // Restore credentials
      localStorage.setItem(SALT_KEY,   fileJson.salt);
      localStorage.setItem(VERIFY_KEY, fileJson.verify);
      if (decrypted.meta?.email) localStorage.setItem(EMAIL_KEY, decrypted.meta.email);
      cryptoKey = key;
      data = decrypted;
      localStorage.setItem('bm_just_imported', Date.now());
      await save();
      await pushToCloud();
      migrateData();
      startActivityTracking();
      hideModal();
      document.getElementById('setupOv').classList.add('hidden');
      document.getElementById('app').classList.remove('hidden');
      renderApp();
      showToast('Backup restored successfully');
      return;
    }

    // ── Section export format: { iv, data } ─────────────────────────
    const salt = await getOrCreateSalt();
    const key  = await deriveKey(pin, salt);
    let inner;
    try { inner = JSON.parse(await aesDecrypt(key, JSON.stringify(fileJson))); }
    catch { throw new Error('wrong_pin'); }
    if (!inner?.payload) throw new Error('corrupted');
    deepMerge(data, inner.payload);
    await save();
    hideModal(); renderApp(); showToast('Data imported successfully');

  } catch(e) {
    const msg = e.message === 'corrupted'
      ? 'Backup file appears to be corrupted'
      : 'Wrong PIN — this backup was created with a different PIN';
    if (errEl) errEl.textContent = msg;
    if (btn) { btn.textContent = 'Restore'; btn.disabled = false; }
  }
}

function handleJsonImport(input) {
  const file = input.files[0]; if (!file) return;
  input.value = '';
  const reader = new FileReader();
  reader.onload = async e => {
    try {
      const json = JSON.parse(e.target.result);
      if (typeof json !== 'object' || Array.isArray(json) || json === null) throw new Error('Expected a JSON object');
      const KNOWN = ['documents','crew','transitLog','spareParts','maintenance','maintenance2','shipyard','systems','watermaker','lpg','provisions','schengen','winterization','upgrades','passageLog','coastalLog'];
      if (!KNOWN.some(k => k in json)) throw new Error('No recognised fields found (expected: documents, crew, maintenance, transitLog, etc.)');

      // Handle maintenance separately — flat import format (engineHours, log[])
      // differs from the internal nested structure (engines.port.hours, engines.port.log[])
      if (json.maintenance) {
        const m = json.maintenance;
        if (!data.maintenance) data.maintenance = { engines: {}, sched: {}, log: [] };
        if (!data.maintenance.engines) data.maintenance.engines = {};
        if (!data.maintenance.log) data.maintenance.log = [];
        ['port', 'starboard'].forEach(eid => {
          if (!data.maintenance.engines[eid])
            data.maintenance.engines[eid] = { hours: 0, schedule: [], log: [], customTasks: [] };
          if (m.engineHours !== undefined)
            data.maintenance.engines[eid].hours = Math.max(0, parseInt(m.engineHours) || 0);
        });
        if (Array.isArray(m.log)) {
          m.log.forEach(entry => data.maintenance.log.push({
            id:    uid(),
            date:  entry.date  || '',
            hours: entry.hours !== undefined ? String(entry.hours) : '',
            task:  entry.task  || '',
            cost:  entry.cost  || '',
            notes: entry.location || entry.notes || ''
          }));
        }
      }

      // Handle schengen — merge persons by name, append unknown ones
      if (json.schengen?.persons) {
        if (!data.schengen) data.schengen = { persons: [] };
        if (!Array.isArray(data.schengen.persons)) data.schengen.persons = [];
        (json.schengen.persons || []).forEach(imp => {
          const name = (imp.name || '').trim().toLowerCase();
          const existing = name
            ? data.schengen.persons.find(p => (p.name || '').trim().toLowerCase() === name)
            : null;
          if (existing) {
            // Merge log entries — skip duplicates matched by type+date
            const seen = new Set((existing.log || []).map(e => e.type + '|' + e.date));
            (imp.log || []).forEach(e => {
              if (!seen.has(e.type + '|' + e.date)) {
                existing.log.push({ ...e, id: uid() });
                seen.add(e.type + '|' + e.date);
              }
            });
            // Merge passports — skip duplicates by flag
            if (Array.isArray(imp.passports)) {
              const existFlags = new Set((existing.passports || []).map(pp => pp.flag));
              imp.passports.forEach(pp => { if (!existFlags.has(pp.flag)) existing.passports.push(pp); });
            }
          } else {
            data.schengen.persons.push({ ...imp, log: (imp.log || []).map(e => ({ ...e, id: uid() })) });
          }
        });
      }

      // Merge everything else (documents, crew, transitLog, spareParts, etc.)
      const rest = Object.assign({}, json);
      delete rest.maintenance;
      delete rest.schengen;
      if (Object.keys(rest).length > 0) deepMerge(data, rest);

      await save();
      localStorage.setItem('bm_just_imported', Date.now());
      await pushToCloud();
      renderApp();
      const cloudOk = syncStatus === 'synced';
      showToast(cloudOk ? 'Data imported and synced to cloud' : 'Data imported locally — cloud sync failed, tap Sync Now to retry', !cloudOk);
    } catch(e) {
      showToast('Import failed — ' + e.message, true);
    }
  };
  reader.readAsText(file);
}

// ═══════════════════════════════════════════════════════════
//  TOAST
// ═══════════════════════════════════════════════════════════

function showToast(msg, err) {
  const t = document.createElement('div');
  t.style.cssText = `position:fixed;bottom:30px;left:50%;transform:translateX(-50%);
    background:${err?'var(--red)':'#333'};color:#fff;padding:10px 20px;border-radius:20px;
    font-size:14px;z-index:9999;box-shadow:0 4px 12px rgba(0,0,0,.3)`;
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 2800);
}

// ═══════════════════════════════════════════════════════════
//  ALERT SYSTEM
// ═══════════════════════════════════════════════════════════

function getAlerts() {
  const alerts = [];
  const I = data.documents?.insurance;
  const C = data.documents?.customs;

  if (I?.expiryDate) {
    const d = daysUntil(I.expiryDate);
    if (d <= 60) alerts.push({color:alertColor(d,60), days:d, text:`Insurance expires ${d<0?Math.abs(d)+'d ago':'in '+d+'d'}`});
  }
  if (C?.validUntil) {
    const d = daysUntil(C.validUntil);
    if (d <= 30) alerts.push({color:alertColor(d,30), days:d, text:`eTEPAY Transit Log expires ${d<0?Math.abs(d)+'d ago':'in '+d+'d'}`});
  }
  (data.crew||[]).forEach(p => {
    if (p.passportExpiry) {
      const d = daysUntil(p.passportExpiry);
      if (d <= 10) alerts.push({color:alertColor(d,10), days:d, text:`${p.name} — passport expires ${d<0?Math.abs(d)+'d ago':'in '+d+'d'}`});
    }
    if (p.seamanBookExpiry) {
      const d = daysUntil(p.seamanBookExpiry);
      if (d <= 10) alerts.push({color:alertColor(d,10), days:d, text:`${p.name} — seaman book expires ${d<0?Math.abs(d)+'d ago':'in '+d+'d'}`});
    }
  });
  // Safety — flares and life rafts
  (data.safety?.flares||[]).forEach(f => {
    if (!f.expiry) return;
    const d = daysUntil(f.expiry);
    if (d <= 180) alerts.push({color:alertColor(d,180), days:d, text:`Flare: ${f.type||'Flare'} ${d<0?`expired ${Math.abs(d)}d ago`:`expires in ${d}d`}`});
  });
  (data.safety?.lifeRafts||[]).forEach(r => {
    if (!r.expiry) return;
    const d = daysUntil(r.expiry);
    if (d <= 180) alerts.push({color:alertColor(d,180), days:d, text:`Life raft: ${[r.brand,r.model].filter(Boolean).join(' ')||'Life Raft'} ${d<0?`expired ${Math.abs(d)}d ago`:`expires in ${d}d`}`});
  });
  // Maintenance — only overdue tasks
  getEngines().forEach(eid => {
    MAINT_TASKS.forEach(task => {
      const s = calcMaintStatus(task, eid);
      if (s && s.color === 'red') {
        const intHrs = data.maintenance?.intervals?.[task.id]?.hrs ?? task.intHrs;
        alerts.push({color:'red', days: intHrs ? -(parseFloat(s.label)||0) : -1, text:`${engLabel(eid)}: ${task.task} — ${s.label}`});
      }
    });
    (data.maintenance?.customIntervalTasks||[]).forEach(cit => {
      ['check','replace'].forEach(type => {
        const s = calcCustomIntervalStatus(cit, type, eid);
        if (s && s.color === 'red') {
          const lbl = type === 'check' ? `${cit.name} — check` : `${cit.name} — replace`;
          alerts.push({color:'red', days:-(parseFloat(s.label)||0), text:`${engLabel(eid)}: ${lbl} — ${s.label}`});
        }
      });
    });
  });
  return alerts.sort((a,b) => a.days - b.days);
}

function renderAlertBar() {
  const el = document.getElementById('alertBar'); if (!el) return;
  const alerts = getAlerts();
  const open = ui.alertsOpen;
  el.innerHTML = `
    <div class="alert-toggle" onclick="ui.alertsOpen=!ui.alertsOpen;renderAlertBar()">
      <span>⚠️ Alerts ${alerts.length>0?`<span class="badge-count">${alerts.length}</span>`:''}</span>
      <span style="color:var(--label3)">${open?'▲':'▼'}</span>
    </div>
    ${open ? `<div class="alert-list">${alerts.length===0
      ? '<div class="no-alerts">✅ All clear — no upcoming expirations</div>'
      : alerts.map(a=>`<div class="alert-row"><div class="adot ${a.color}"></div><div class="alert-txt">${esc(a.text)}</div></div>`).join('')
    }</div>` : ''}`;
}

// ═══════════════════════════════════════════════════════════
//  SETUP SCREEN
// ═══════════════════════════════════════════════════════════

function renderSetup(setupEmail = '') {
  const ov = document.getElementById('setupOv');
  ov.classList.remove('hidden');
  const hull = data.meta?.hullType || 'catamaran';
  ov.innerHTML = `
    <div class="setup-inner">
      <div class="setup-logo"><img src="oroboro-logo-black-transparent-v2.png" alt="Oroboro" style="max-width:220px;height:auto;display:block;margin:0 auto 24px;"></div>
      <div class="setup-h">Boat Manager</div>
      <div class="setup-sub">Set up your boat. Your encrypted data syncs to the cloud.</div>
      <label class="setup-lbl">Boat Name</label>
      <input class="setup-inp" id="s-boat" placeholder="e.g. OROBORO" value="${esc(data.meta?.boatName||'')}">
      <label class="setup-lbl">Owner Name</label>
      <input class="setup-inp" id="s-owner" placeholder="e.g. John Smith" value="${esc(data.meta?.ownerName||'')}">
      <label class="setup-lbl">Email</label>
      <input class="setup-inp" id="s-email" type="email" placeholder="your@email.com" value="${esc(setupEmail)}">
      <label class="setup-lbl">Flag / Nationality</label>
      <input class="setup-inp" id="s-flag" placeholder="e.g. USA" value="${esc(data.meta?.flag||'')}">
      <label class="setup-lbl" style="margin-bottom:10px">Hull Type</label>
      <div class="hull-row">
        <div class="hull-opt ${hull==='monohull'?'sel':''}" onclick="selHull('monohull')">
          <div class="hull-icon">⛵</div>
          <div class="hull-lbl">Monohull</div>
          <div class="hull-sub">Single engine</div>
        </div>
        <div class="hull-opt ${hull==='catamaran'?'sel':''}" onclick="selHull('catamaran')">
          <div class="hull-icon">🛥️</div>
          <div class="hull-lbl">Catamaran</div>
          <div class="hull-sub">Port + Starboard</div>
        </div>
      </div>
      <div style="display:flex;align-items:center;gap:12px;margin-bottom:20px;padding:14px;background:var(--surface);border-radius:12px;border:0.5px solid var(--sep);"><input type="checkbox" id="privacyConsent" onchange="var b=document.getElementById('setupSubmitBtn');if(b)b.disabled=!this.checked;" style="width:22px;height:22px;flex-shrink:0;cursor:pointer;display:inline-block!important;visibility:visible!important;appearance:checkbox!important;-webkit-appearance:checkbox!important;"><span style="font-size:14px;color:var(--label);line-height:1.4;">I have read and agree to the <button type="button" ontouchstart="event.preventDefault();showPrivacyPolicy();" onclick="showPrivacyPolicy();" style="background:none;border:none;color:#185FA5;font-family:var(--font);font-size:14px;cursor:pointer;padding:0;line-height:inherit;vertical-align:baseline;">Privacy Policy</button> and <button type="button" ontouchstart="event.preventDefault();showTermsOfUse();" onclick="showTermsOfUse();" style="background:none;border:none;color:#185FA5;font-family:var(--font);font-size:14px;cursor:pointer;padding:0;line-height:inherit;vertical-align:baseline;">Terms of Use</button></span></div>
      <button class="setup-go" id="setupSubmitBtn" onclick="completeSetup()" disabled>Set Up My Boat →</button>
      <button onclick="renderLoginScreen()"
        style="width:100%;margin-top:14px;border:none;background:none;font-family:var(--font);
          font-size:15px;color:var(--label3);cursor:pointer;padding:10px">
        ← Back to login
      </button>
    </div>`;
}

function selHull(t) {
  data.meta.hullType = t;
  document.querySelectorAll('.hull-opt').forEach(el => {
    el.classList.toggle('sel', el.textContent.toLowerCase().includes(t));
  });
}

function completeSetup() {
  const name  = document.getElementById('s-boat').value.trim();
  const owner = document.getElementById('s-owner').value.trim();
  const email = document.getElementById('s-email').value.trim().toLowerCase();
  const flag  = document.getElementById('s-flag').value.trim();
  if (!name)  { showToast('Please enter a boat name', true); return; }
  if (!email || !email.includes('@')) { showToast('Please enter a valid email', true); return; }
  data.meta.boatName  = name;
  data.meta.ownerName = owner;
  data.meta.email     = email;
  data.meta.flag      = flag;
  localStorage.setItem(EMAIL_KEY, email);
  data.meta.setupComplete = true;
  // Don't save yet — we have no crypto key. Show PIN setup next.
  renderPINSetup();
}

// ═══════════════════════════════════════════════════════════
//  APP SHELL
// ═══════════════════════════════════════════════════════════

const TABS = [
  {id:'documents',  icon:'📄', label:'Boat Docs'},
  {id:'clearance',  icon:'⚓', label:'Clearance'},
  {id:'logbook',    icon:'📖', label:'Log Book'},
  {id:'provisions', icon:'🛒', label:'Provisions'},
  {id:'watermaker', icon:'💧', label:'Water Maker'},
  {id:'lpg',        icon:'🔥', label:'LPG'},
  {id:'maint',      icon:'🔧', label:'Engine Maintenance'},
  {id:'schengen',   icon:'🛂', label:'Schengen'},
  {id:'shipyard',   icon:'⚓', label:'Shipyard'},
  {id:'winter',     icon:'❄️', label:'Winterize'},
  {id:'upgrades',   icon:'🔧', label:'Upgrades & Repairs'},
  {id:'parts',      icon:'🔩', label:'Spare Parts'},
  {id:'safety',     icon:'🛡️', label:'Safety'},
  {id:'systems',    icon:'🔌', label:'Systems'},
  {id:'settings',   icon:'⚙️', label:'Settings'},
];
const CUSTOMIZABLE_TABS = TABS.filter(t => t.id !== 'settings');
const DOC_SUBTAB_DEFS = [
  {id:'insurance',  icon:'🛡️', label:'Insurance'},
  {id:'customs',    icon:'🛃', label:'eTEPAY'},
  {id:'transitlog', icon:'📜', label:'Transit Log'},
  {id:'photos',     icon:'📷', label:'Document Photos'},
];

function renderApp() {
  const app = document.getElementById('app');
  app.innerHTML = `
    <div class="hdr">
      <div class="hdr-content">
        <img src="oroboro-logo-transparent.png" alt="Oroboro">
        <div class="hdr-sub">Boat Manager — ${esc(data.meta.boatName||'My Boat')}</div>
        <span id="sync-dot" class="sync-dot" onclick="pushToCloud()" title="Not synced">●</span>
        <button onclick="lockApp()" title="Lock app" style="position:absolute;right:14px;top:50%;
          transform:translateY(-50%);background:none;border:none;color:#aaa;font-size:20px;
          cursor:pointer;padding:4px;line-height:1">🔓</button>
      </div>
    </div>
    <div class="alert-bar" id="alertBar"></div>
    <div class="tab-bar">
      ${getVisibleTabs().map(t=>`<button class="tab-btn ${ui.tab===t.id?'active':''}" onclick="showTab('${t.id}')">${t.icon} ${t.label}</button>`).join('')}
    </div>
    <main id="mainContent" style="padding-bottom:120px"></main>
    <div class="backup-bar" id="backupBar"></div>`;
  renderAlertBar();
  renderBackupBar();
  renderActiveTab();
}

function showTab(tab) {
  ui.tab = tab;
  document.querySelectorAll('.tab-btn').forEach(b => {
    b.classList.toggle('active', b.textContent.includes(TABS.find(t=>t.id===tab)?.label||''));
  });
  renderActiveTab();
}

function renderActiveTab() {
  const mc = document.getElementById('mainContent'); if (!mc) return;
  try {
    switch(ui.tab) {
      case 'documents':  mc.innerHTML = renderDocuments(); break;
      case 'clearance':  mc.innerHTML = renderClearance(); break;
      case 'logbook':    mc.innerHTML = renderPassageLog(); break;
      case 'crew':       mc.innerHTML = renderCrew(); break;
      case 'shipyard':    mc.innerHTML = renderShipyard(); break;
      case 'watermaker':  mc.innerHTML = renderWatermaker(); break;
      case 'lpg':         mc.innerHTML = renderLpg(); break;
      case 'provisions':  mc.innerHTML = renderProvisions(); break;
      case 'maint':       mc.innerHTML = renderMaintenance(); break;
      case 'upgrades':  mc.innerHTML = renderUpgrades(); break;
      case 'schengen':  mc.innerHTML = renderSchengen(); break;
      case 'parts':     mc.innerHTML = renderParts(); break;
      case 'safety':    mc.innerHTML = renderSafety(); break;
      case 'systems':   mc.innerHTML = renderSystems(); break;
      case 'winter':    mc.innerHTML = renderWinterization(); break;
      case 'settings':  mc.innerHTML = renderSettings(); break;
    }
  } catch(e) {
    console.error('renderActiveTab error in tab "' + ui.tab + '":', e);
    ui.tab = 'documents';
    try { mc.innerHTML = renderDocuments(); } catch(e2) { console.error('renderDocuments fallback failed:', e2); }
  }
}

// ═══════════════════════════════════════════════════════════
//  SECTION 1 — DOCUMENTS
// ═══════════════════════════════════════════════════════════

function renderDocuments() {
  const SUBS = getVisibleDocSubtabs();
  if (!SUBS[ui.docSub]) ui.docSub = Object.keys(SUBS)[0];
  return `
    <div class="subtab-bar">
      ${Object.keys(SUBS).map(s=>`
        <div class="pill ${ui.docSub===s?'active':''}" onclick="setDocSub('${s}')">${SUBS[s]}</div>`).join('')}
    </div>
    ${ui.docSub==='vessel' ? renderVesselDoc()
    : ui.docSub==='insurance' ? renderInsurance()
    : ui.docSub==='transitlog' ? renderTransitLog()
    : ui.docSub==='photos' ? renderPhotos()
    : renderCustoms()}`;
}

function setDocSub(s) {
  ui.docSub = s;
  try {
    document.getElementById('mainContent').innerHTML = renderDocuments();
  } catch(e) {
    console.error('setDocSub error for sub-tab "' + s + '":', e);
    const mc = document.getElementById('mainContent');
    if (mc) mc.innerHTML = `<div style="padding:20px;color:var(--red);font-size:13px">Error loading tab: ${esc(e.message)}</div>`;
  }
}

function renderVesselDoc() {
  const v = data.documents?.vessel || {};
  const exp = expiryBadge(v.expiryDate, 90);
  return `
    <div class="sec-hd" style="display:flex;align-items:center;justify-content:space-between">Vessel Identification<button class="btn btn-s btn-sm" onclick="archiveVesselDoc()">Archive &amp; New</button></div>
    <div class="card"><div class="card-body">
      ${fr('Vessel Name','documents.vessel.vesselName',v.vesselName)}
      ${fr('Official No.','documents.vessel.officialNumber',v.officialNumber)}
      ${fr('IMO Number','documents.vessel.imoNumber',v.imoNumber)}
      ${fr('Call Sign','documents.vessel.callSign',v.callSign)}
      ${fr('Hailing Port','documents.vessel.hailingPort',v.hailingPort)}
      ${fr('Flag / Registry','documents.vessel.flagRegistry',v.flagRegistry)}
    </div></div>
    <div class="sec-hd">Vessel Details</div>
    <div class="card"><div class="card-body">
      ${fr('Hull Material','documents.vessel.hullMaterial',v.hullMaterial)}
      ${fr('Type of Boat','documents.vessel.boatType',v.boatType)}
      ${fr('LOA','documents.vessel.loa',v.loa)}
      ${fr('Breadth','documents.vessel.breadth',v.breadth)}
      ${fr('Depth / Draft','documents.vessel.depth',v.depth)}
      ${fr('Gross Tonnage','documents.vessel.grossTonnage',v.grossTonnage)}
      ${fr('Net Tonnage','documents.vessel.netTonnage',v.netTonnage)}
      ${fr('Year Completed','documents.vessel.yearCompleted',v.yearCompleted)}
      ${fr('Place Built','documents.vessel.placeBuilt',v.placeBuilt)}
      ${fr('Engine','documents.vessel.engine',v.engine)}
    </div></div>
    <div class="sec-hd">Ownership & Registration</div>
    <div class="card"><div class="card-body">
      ${fr('Owner(s)','documents.vessel.owners',v.owners)}
      ${fr('Managing Owner','documents.vessel.managingOwner',v.managingOwner)}
      ${fr('Issue Date','documents.vessel.issueDate',v.issueDate,'date')}
      ${frExpiry('documents.vessel.expiryDate',v.expiryDate,exp)}
    </div></div>
    <div class="sec-hd">Registration History</div>
    <div class="card">
      <div style="overflow-x:auto">
        <table class="tbl"><thead><tr><th>Reg No.</th><th>Issued</th><th>Expires</th><th>Owner(s)</th><th></th></tr></thead>
        <tbody>${(v.registrationHistory||[]).map((r,i)=>`
          <tr><td style="font-size:12px">${esc(r.officialNumber||'—')}</td><td style="font-size:12px">${esc(r.issueDate||'')}</td>
          <td style="font-size:12px">${esc(r.expiryDate||'')}</td><td style="font-size:12px">${esc(r.owners||'')}</td>
          <td style="white-space:nowrap"><button style="background:none;border:none;padding:2px 4px;cursor:pointer;font-size:14px;color:var(--label3);line-height:1;flex-shrink:0" onclick="editVesselDocHistory(${i})">✏️</button> <button class="btn btn-d btn-xs" onclick="removeVesselDocHistory(${i})">✕</button></td></tr>`
        ).join('') || '<tr><td colspan="5" style="color:var(--label3);padding:12px">No history yet</td></tr>'}</tbody>
        </table>
      </div>
    </div>`;
}

function renderInsurance() {
  const I = data.documents?.insurance || {};
  const exp = expiryBadge(I.expiryDate, 60);
  return `
    <div class="sec-hd" style="display:flex;align-items:center;justify-content:space-between">Policy Details<button class="btn btn-s btn-sm" onclick="archiveInsurance()">Archive &amp; New</button></div>
    <div class="card"><div class="card-body">
      ${fr('Insurer','documents.insurance.insurer',I.insurer)}
      ${fr('Certificate No.','documents.insurance.certNumber',I.certNumber)}
      ${fr('Issue Date','documents.insurance.issueDate',I.issueDate,'date')}
      ${frExpiry('documents.insurance.expiryDate',I.expiryDate,exp)}
      ${fr('Annual Premium (€)','documents.insurance.premium',I.premium)}
    </div></div>
    <div class="sec-hd">Maximum Cover</div>
    <div class="card"><div class="card-body">
      ${frArea('Personal Injury/Death','documents.insurance.maxPersonalInjury',I.maxPersonalInjury)}
      ${frArea('Material Damage','documents.insurance.maxMaterial',I.maxMaterial)}
      ${frArea('Pollution','documents.insurance.maxPollution',I.maxPollution)}
      ${frArea('Total Sum Insured','documents.insurance.totalSumInsured',I.totalSumInsured)}
      ${frArea('Third Party Liability','documents.insurance.thirdPartyLiability',I.thirdPartyLiability)}
      ${frArea('Deductibles','documents.insurance.deductibles',I.deductibles)}
      ${frArea('Navigation Limits','documents.insurance.navigationLimits',I.navigationLimits)}
      ${frArea('Conditions / Special Notes','documents.insurance.specialNotes',I.specialNotes)}
    </div></div>
    <div class="sec-hd">Renewal History</div>
    <div class="card">
      <div class="card-hd">History <button class="card-hd-btn" onclick="addInsuranceRenewal()">+ Add</button></div>
      <div style="overflow-x:auto">
        <table class="tbl"><thead><tr><th>Year</th><th>Insurer</th><th>Premium</th><th>Expiry</th><th></th></tr></thead>
        <tbody>${(I.renewalHistory||[]).map((r,i)=>`
          <tr><td>${esc(r.year)}</td><td>${esc(r.insurer)}</td><td>${esc(r.premium)}</td>
          <td>${esc(fmtDateEU(r.expiry)||r.expiry||'')}</td><td style="white-space:nowrap"><button style="background:none;border:none;padding:2px 4px;cursor:pointer;font-size:14px;color:var(--label3);line-height:1;flex-shrink:0" onclick="editInsuranceHistory(${i})">✏️</button> <button class="btn btn-d btn-xs" onclick="removeInsuranceRenewal(${i})">✕</button></td></tr>`
        ).join('') || '<tr><td colspan="5" style="color:var(--label3);padding:12px">No history yet</td></tr>'}</tbody>
        </table>
      </div>
    </div>`;
}

function renderCustoms() {
  const C = data.documents?.customs || {};
  const exp = expiryBadge(C.validUntil, 60);
  return `
    <div class="sec-hd" style="display:flex;align-items:center;justify-content:space-between">eTEPAY Application<button class="btn btn-s btn-sm" onclick="archiveCustoms()">Archive &amp; New</button></div>
    <div class="card"><div class="card-body">
      ${fr('Application Number','documents.customs.applicationNumber',C.applicationNumber)}
      ${fr('Application Date','documents.customs.applicationDate',C.applicationDate)}
      ${fr('Entry into Greek Waters','documents.customs.entryDate',C.entryDate)}
      ${fr('Year','documents.customs.year',C.year)}
      ${frMonths('documents.customs.monthsCovered',C.monthsCovered)}
      ${fr('Amount Paid','documents.customs.amountPaid',C.amountPaid)}
      ${fr('Payment Code (RF)','documents.customs.paymentCode',C.paymentCode)}
      ${fr('Admin Fee Code (e-Paravolo)','documents.customs.adminFeeCode',C.adminFeeCode)}
      ${frSelect('Status','documents.customs.status',C.status||'New',['New','Paid','Pending'])}
      ${frExpiry('documents.customs.validUntil',C.validUntil,exp,'Valid Until')}
    </div></div>
    <div class="sec-hd">Holder Details</div>
    <div class="card"><div class="card-body">
      ${fr('Holder Name','documents.customs.holderName',C.holderName)}
      ${fr('AFM / Tax No.','documents.customs.afm',C.afm)}
      ${fr('Customs Office','documents.customs.customsOffice',C.customsOffice)}
      ${fr('Clearance No.','documents.customs.clearanceNumber',C.clearanceNumber)}
      ${fr('Email','documents.customs.email',C.email)}
      ${fr('Payment Ref.','documents.customs.paymentRef',C.paymentRef)}
    </div></div>
    <div class="sec-hd">Owner Details</div>
    <div class="card"><div class="card-body">
      ${fr('Passport Number','documents.customs.ownerPassportNumber',C.ownerPassportNumber)}
      ${fr('Phone','documents.customs.ownerPhone',C.ownerPhone)}
      ${frArea('Address','documents.customs.ownerAddress',C.ownerAddress||C.address)}
    </div></div>
    <div class="sec-hd">Renewal History</div>
    <div class="card">
      <div class="card-hd">History <button class="card-hd-btn" onclick="addCustomsRenewal()">+ Add</button></div>
      <div style="overflow-x:auto">
        <table class="tbl"><thead><tr><th>Year</th><th>Months</th><th>Amount</th><th>Payment Code</th><th>Date Paid</th><th>Notes</th><th></th></tr></thead>
        <tbody>${(C.renewalHistory||[]).map((r,i)=>`
          <tr>
            <td>${esc(r.year)}</td>
            <td>${esc(r.months||r.cost||'')}</td>
            <td>${esc(r.amount||r.cost||'')}</td>
            <td style="font-size:11px">${esc(r.paymentCode||'')}</td>
            <td>${esc(r.datePaid||r.validUntil||'')}</td>
            <td>${esc(r.notes||'')}</td>
            <td style="white-space:nowrap"><button style="background:none;border:none;padding:2px 4px;cursor:pointer;font-size:14px;color:var(--label3);line-height:1;flex-shrink:0" onclick="editCustomsHistory(${i})">✏️</button> <button class="btn btn-d btn-xs" onclick="removeCustomsRenewal(${i})">✕</button></td>
          </tr>`
        ).join('') || '<tr><td colspan="7" style="color:var(--label3);padding:12px">No history yet</td></tr>'}</tbody>
        </table>
      </div>
    </div>
    <div class="tip">💡 Since 2024, Transit Logs are submitted digitally via <b>myaade.gov.gr</b>. Cost: €30, valid 6 months. Submit at first Greek port of entry, then present at every subsequent port.</div>`;
}

// Form row helpers
function fr(label, path, value, type) {
  const t = type === 'date' ? 'date' : 'text';
  return `<div class="fr">
    <div class="fl">${esc(label)}</div>
    <input class="fi" type="${t}" value="${esc(value||'')}" onblur="saveField('${path}',this.value)" placeholder="—">
  </div>`;
}
function frArea(label, path, value) {
  return `<div class="fr" style="align-items:flex-start;padding-top:12px">
    <div class="fl">${esc(label)}</div>
    <textarea class="fi-area" onblur="saveField('${path}',this.value)" placeholder="—">${esc(value||'')}</textarea>
  </div>`;
}
function frExpiry(path, value, badge, label) {
  return `<div class="fr">
    <div class="fl">${esc(label||'Expiry Date')} ${badge}</div>
    <input class="fi" type="date" value="${esc(value||'')}" onblur="saveField('${path}',this.value)">
  </div>`;
}
function frMonths(path, value) {
  const ABB  = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const FULL = ['January','February','March','April','May','June','July','August','September','October','November','December'];
  const sel  = new Set(Array.isArray(value) ? value : (value||'').split(',').map(s=>s.trim()).filter(Boolean));
  const boxes = ABB.map((a,i) => `<label style="display:flex;flex-direction:column;align-items:center;gap:2px;cursor:pointer;font-size:11px">
    <input type="checkbox" ${sel.has(FULL[i])?'checked':''} data-month="${FULL[i]}" onchange="saveMonthsField('${path}',this)" style="margin:0">
    ${a}</label>`).join('');
  return `<div class="fr" style="align-items:flex-start;padding-top:12px">
    <div class="fl">Months Covered</div>
    <div style="display:flex;flex-wrap:wrap;gap:10px;padding-top:2px">${boxes}</div>
  </div>`;
}
function saveMonthsField(path, el) {
  const FULL = ['January','February','March','April','May','June','July','August','September','October','November','December'];
  const boxes = el.closest('.fr').querySelectorAll('input[type=checkbox]');
  const sorted = FULL.filter(m => [...boxes].some(b => b.dataset.month===m && b.checked));
  saveField(path, sorted.join(','));
}

function editVesselDocHistory(i) {
  const r = data.documents.vessel?.registrationHistory?.[i]; if (!r) return;
  showModal('Edit Registration', `
    <div class="mi-label">Reg / Official No.</div><input class="mi" id="vh-reg" value="${esc(r.officialNumber||'')}">
    <div class="mi-label">Issue Date</div><input class="mi" id="vh-iss" value="${esc(r.issueDate||'')}">
    <div class="mi-label">Expiry Date</div><input class="mi" id="vh-exp" value="${esc(r.expiryDate||'')}">
    <div class="mi-label">Owner(s)</div><input class="mi" id="vh-own" value="${esc(r.owners||'')}">
    <div class="modal-btns">
      <button class="btn btn-s" onclick="hideModal()">Cancel</button>
      <button class="btn btn-p" onclick="saveVesselDocHistory(${i})">Save</button>
    </div>`);
}
function saveVesselDocHistory(i) {
  const r = data.documents.vessel?.registrationHistory?.[i]; if (!r) return;
  r.officialNumber = document.getElementById('vh-reg')?.value||'';
  r.issueDate      = document.getElementById('vh-iss')?.value||'';
  r.expiryDate     = document.getElementById('vh-exp')?.value||'';
  r.owners         = document.getElementById('vh-own')?.value||'';
  save(); hideModal(); document.getElementById('mainContent').innerHTML = renderDocuments();
}

function editInsuranceHistory(i) {
  const r = data.documents.insurance?.renewalHistory?.[i]; if (!r) return;
  showModal('Edit Insurance Record', `
    <div class="mi-label">Year</div><input class="mi" id="ih-yr" value="${esc(r.year||'')}">
    <div class="mi-label">Insurer</div><input class="mi" id="ih-ins" value="${esc(r.insurer||'')}">
    <div class="mi-label">Premium</div><input class="mi" id="ih-pre" value="${esc(r.premium||'')}">
    <div class="mi-label">Expiry Date</div><input class="mi" id="ih-exp" value="${esc(r.expiry||'')}">
    <div class="mi-label">Cert Number</div><input class="mi" id="ih-cert" value="${esc(r.certNumber||'')}">
    <div class="mi-label">Notes</div><input class="mi" id="ih-notes" value="${esc(r.notes||'')}">
    <div class="modal-btns">
      <button class="btn btn-s" onclick="hideModal()">Cancel</button>
      <button class="btn btn-p" onclick="saveInsuranceHistory(${i})">Save</button>
    </div>`);
}
function saveInsuranceHistory(i) {
  const r = data.documents.insurance?.renewalHistory?.[i]; if (!r) return;
  r.year       = document.getElementById('ih-yr')?.value||'';
  r.insurer    = document.getElementById('ih-ins')?.value||'';
  r.premium    = document.getElementById('ih-pre')?.value||'';
  r.expiry     = document.getElementById('ih-exp')?.value||'';
  r.certNumber = document.getElementById('ih-cert')?.value||'';
  r.notes      = document.getElementById('ih-notes')?.value||'';
  save(); hideModal(); document.getElementById('mainContent').innerHTML = renderDocuments();
}

function editCustomsHistory(i) {
  const r = data.documents.customs?.renewalHistory?.[i]; if (!r) return;
  showModal('Edit eTEPAY Record', `
    <div class="mi-label">Year</div><input class="mi" id="ch-yr" value="${esc(r.year||'')}">
    <div class="mi-label">Months Covered</div><input class="mi" id="ch-mo" value="${esc(r.months||'')}">
    <div class="mi-label">Amount</div><input class="mi" id="ch-amt" value="${esc(r.amount||'')}">
    <div class="mi-label">Payment Code (RF)</div><input class="mi" id="ch-pc" value="${esc(r.paymentCode||'')}">
    <div class="mi-label">Date Paid</div><input class="mi" id="ch-dp" value="${esc(r.datePaid||'')}">
    <div class="mi-label">Notes</div><input class="mi" id="ch-notes" value="${esc(r.notes||'')}">
    <div class="modal-btns">
      <button class="btn btn-s" onclick="hideModal()">Cancel</button>
      <button class="btn btn-p" onclick="saveCustomsHistory(${i})">Save</button>
    </div>`);
}
function saveCustomsHistory(i) {
  const r = data.documents.customs?.renewalHistory?.[i]; if (!r) return;
  r.year        = document.getElementById('ch-yr')?.value||'';
  r.months      = document.getElementById('ch-mo')?.value||'';
  r.amount      = document.getElementById('ch-amt')?.value||'';
  r.paymentCode = document.getElementById('ch-pc')?.value||'';
  r.datePaid    = document.getElementById('ch-dp')?.value||'';
  r.notes       = document.getElementById('ch-notes')?.value||'';
  save(); hideModal(); document.getElementById('mainContent').innerHTML = renderDocuments();
}

function archiveVesselDoc() {
  if (!confirm('Archive current registration details and clear for new period?')) return;
  const v = data.documents.vessel;
  if (!v.registrationHistory) v.registrationHistory = [];
  v.registrationHistory.unshift({
    officialNumber: v.officialNumber||'', issueDate: v.issueDate||'',
    expiryDate: v.expiryDate||'', owners: v.owners||''
  });
  ['officialNumber','issueDate','expiryDate','owners','managingOwner'].forEach(k => { v[k] = ''; });
  save(); document.getElementById('mainContent').innerHTML = renderDocuments();
}

function removeVesselDocHistory(i) {
  data.documents.vessel.registrationHistory.splice(i, 1); save();
  document.getElementById('mainContent').innerHTML = renderDocuments();
}

function archiveInsurance() {
  if (!confirm('Archive current policy details and start fresh for the new period?')) return;
  const I = data.documents.insurance;
  if (!I.renewalHistory) I.renewalHistory = [];
  const yr = I.issueDate ? I.issueDate.slice(-4)||I.issueDate.slice(0,4) : String(new Date().getFullYear());
  I.renewalHistory.unshift({year:yr, insurer:I.insurer||'', premium:I.premium||'', expiry:I.expiryDate||''});
  ['insurer','certNumber','issueDate','expiryDate','premium',
   'maxPersonalInjury','maxMaterial','maxPollution','totalSumInsured',
   'thirdPartyLiability','deductibles','navigationLimits','specialNotes'].forEach(k => { I[k] = ''; });
  save(); document.getElementById('mainContent').innerHTML = renderDocuments();
}

function archiveCustoms() {
  if (!confirm('Archive current eTEPAY application and start fresh for the new period?')) return;
  const C = data.documents.customs;
  if (!C.renewalHistory) C.renewalHistory = [];
  C.renewalHistory.unshift({
    year:C.year||'', months:C.monthsCovered||'', amount:C.amountPaid||'',
    paymentCode:C.paymentCode||'', datePaid:C.applicationDate||'', notes:''
  });
  ['applicationNumber','applicationDate','entryDate','year','monthsCovered',
   'amountPaid','paymentCode','adminFeeCode','validUntil'].forEach(k => { C[k] = ''; });
  C.status = 'New';
  save(); document.getElementById('mainContent').innerHTML = renderDocuments();
}

function addInsuranceRenewal() {
  showModal('Add Insurance Renewal', `
    <div class="mi-label">Year</div><input class="mi" id="m-year" placeholder="2025">
    <div class="mi-label">Insurer</div><input class="mi" id="m-ins" placeholder="Insurer name">
    <div class="mi-label">Annual Premium</div><input class="mi" id="m-prem" placeholder="€ 0.00">
    <div class="mi-label">Expiry</div><input class="mi" id="m-exp" type="date">
    <div class="modal-btns">
      <button class="btn btn-p w-full" onclick="saveInsuranceRenewal()">Add</button>
    </div>`);
}
function saveInsuranceRenewal() {
  if (!data.documents.insurance.renewalHistory) data.documents.insurance.renewalHistory = [];
  data.documents.insurance.renewalHistory.push({
    year: document.getElementById('m-year').value,
    insurer: document.getElementById('m-ins').value,
    premium: document.getElementById('m-prem').value,
    expiry: document.getElementById('m-exp').value
  });
  save(); hideModal(); document.getElementById('mainContent').innerHTML = renderDocuments();
}
function removeInsuranceRenewal(i) {
  data.documents.insurance.renewalHistory.splice(i,1);
  save(); document.getElementById('mainContent').innerHTML = renderDocuments();
}

function addCustomsRenewal() {
  showModal('Add Renewal Entry', `
    <div class="mi-label">Year</div><input class="mi" id="m-year" placeholder="2026">
    <div class="mi-label">Months Covered</div><input class="mi" id="m-months" placeholder="e.g. April,May,June">
    <div class="mi-label">Amount Paid</div><input class="mi" id="m-amount" placeholder="€231.00">
    <div class="mi-label">Payment Code (RF)</div><input class="mi" id="m-pcode" placeholder="RF…">
    <div class="mi-label">Date Paid</div><input class="mi" id="m-dpaid" type="date">
    <div class="mi-label">Notes</div><input class="mi" id="m-notes" placeholder="Optional">
    <div class="modal-btns">
      <button class="btn btn-s" onclick="hideModal()">Cancel</button>
      <button class="btn btn-p" onclick="saveCustomsRenewal()">Add</button>
    </div>`);
}
function saveCustomsRenewal() {
  if (!data.documents.customs.renewalHistory) data.documents.customs.renewalHistory = [];
  data.documents.customs.renewalHistory.push({
    year:        document.getElementById('m-year').value,
    months:      document.getElementById('m-months').value,
    amount:      document.getElementById('m-amount').value,
    paymentCode: document.getElementById('m-pcode').value,
    datePaid:    document.getElementById('m-dpaid').value,
    notes:       document.getElementById('m-notes').value
  });
  save(); hideModal(); document.getElementById('mainContent').innerHTML = renderDocuments();
}
function removeCustomsRenewal(i) {
  data.documents.customs.renewalHistory.splice(i,1);
  save(); document.getElementById('mainContent').innerHTML = renderDocuments();
}

// ═══════════════════════════════════════════════════════════
//  SECTION 2 — CREW & PASSPORTS
// ═══════════════════════════════════════════════════════════

function renderCrew() {
  const crew = data.crew || [];
  return `
    <div class="btn-row">
      <button class="btn btn-p btn-sm" onclick="showAddCrew()">+ Add Person</button>
    </div>
    ${crew.map((p,i) => renderCrewCard(p,i)).join('')}
    ${crew.length===0?`<div style="text-align:center;padding:40px 0;color:var(--label3)">No crew added yet</div>`:''}`;
}

function renderCrewCard(p, i) {
  const open = ui.crewOpen === p.id;
  const passExp = expiryBadge(p.passportExpiry, 180);
  const seamExp = expiryBadge(p.seamanBookExpiry, 180);
  return `
    <div class="crew-card">
      <div class="crew-hdr" onclick="toggleCrew('${p.id}')">
        <div class="crew-av">${initials(p.name)}</div>
        <div style="flex:1">
          <div style="font-size:16px;font-weight:600">${esc(p.name)}</div>
          <div style="font-size:13px;color:var(--label3)">${esc(p.role)} · ${esc(p.nationality)}</div>
        </div>
        <div style="display:flex;gap:6px;align-items:center">
          <span style="color:var(--label3)">${open?'▲':'▼'}</span>
        </div>
      </div>
      <div class="crew-body ${open?'open':''}">
        <div class="sec-hd" style="padding:0 16px;margin-top:14px">Personal Details</div>
        <div class="card" style="margin:0 0 0 0;border-radius:0;box-shadow:none">
          ${fr('Full Name','crew.'+i+'.name',p.name)}
          ${frSelect('Role','crew.'+i+'.role',p.role,['Skipper','Crew','Passenger'])}
          ${fr('Nationality','crew.'+i+'.nationality',p.nationality)}
          ${fr('Date of Birth','crew.'+i+'.dob',p.dob,'date')}
        </div>
        <div class="sec-hd" style="padding:0 16px">Travel Documents</div>
        <div class="card" style="margin:0;border-radius:0;box-shadow:none">
          ${fr('Passport No.','crew.'+i+'.passportNumber',p.passportNumber)}
          ${frExpiry('crew.'+i+'.passportExpiry',p.passportExpiry,passExp,'Passport Expiry')}
          ${fr('Seaman Book No.','crew.'+i+'.seamanBookNumber',p.seamanBookNumber)}
          ${frExpiry('crew.'+i+'.seamanBookExpiry',p.seamanBookExpiry,seamExp,'Seaman Bk. Expiry')}
        </div>
        <div class="btn-row">
          <button class="btn btn-d btn-sm" onclick="removeCrew(${i})">Remove ${esc(p.name)}</button>
        </div>
      </div>
    </div>`;
}

function frSelect(label, path, value, options) {
  return `<div class="fr">
    <div class="fl">${esc(label)}</div>
    <select class="fi" onchange="saveField('${path}',this.value)">
      ${options.map(o=>`<option ${o===value?'selected':''}>${esc(o)}</option>`).join('')}
    </select>
  </div>`;
}

function toggleCrew(id) {
  ui.crewOpen = (ui.crewOpen === id) ? null : id;
  document.getElementById('mainContent').innerHTML = renderCrew();
}

function showAddCrew() {
  showModal('Add Crew Member', `
    <div class="mi-label">Full Name</div><input class="mi" id="m-name" placeholder="Full name">
    <div class="mi-label">Role</div>
    <select class="mi" id="m-role"><option>Skipper</option><option>Crew</option><option>Passenger</option></select>
    <div class="mi-label">Nationality</div><input class="mi" id="m-nat" placeholder="e.g. USA">
    <div class="mi-label">Date of Birth</div><input class="mi" id="m-dob" type="date">
    <div class="mi-label">Passport No.</div><input class="mi" id="m-pp" placeholder="Passport number">
    <div class="mi-label">Seaman Book No.</div><input class="mi" id="m-sb" placeholder="Seaman book number">
    <div class="modal-btns">
      <button class="btn btn-s" onclick="hideModal()">Cancel</button>
      <button class="btn btn-p" onclick="saveCrew()">Add</button>
    </div>`);
}
function saveCrew() {
  if (!data.crew) data.crew = [];
  data.crew.push({
    id: uid(), name: document.getElementById('m-name').value,
    role: document.getElementById('m-role').value,
    nationality: document.getElementById('m-nat').value,
    dob: document.getElementById('m-dob').value,
    passportNumber: document.getElementById('m-pp').value,
    passportExpiry: '', seamanBookNumber: document.getElementById('m-sb').value,
    seamanBookExpiry: ''
  });
  save(); hideModal(); document.getElementById('mainContent').innerHTML = renderCrew();
}
function removeCrew(i) {
  if (!confirm('Remove this crew member?')) return;
  data.crew.splice(i,1); save();
  document.getElementById('mainContent').innerHTML = renderCrew();
}

// ═══════════════════════════════════════════════════════════
//  SECTION 3 — PHOTOS
// ═══════════════════════════════════════════════════════════

const PHOTO_SUBS = ['vesselDoc','insurance','transitLog','crewList'];
const PHOTO_LABELS = {'vesselDoc':'Vessel Doc','insurance':'Insurance','transitLog':'Transit Log','crewList':'Crew List'};

function renderPhotos() {
  const sub = ui.photoSub;
  const photos = data.photos?.[sub] || [];
  return `
    <div class="subtab-bar">
      ${PHOTO_SUBS.map(s=>`<div class="pill ${sub===s?'active':''}" onclick="ui.photoSub='${s}';document.getElementById('mainContent').innerHTML=renderDocuments()">
        ${PHOTO_LABELS[s]}
      </div>`).join('')}
    </div>
    <div style="margin-top:12px">
      <div class="upload-zone" onclick="_photoCtx={section:'${sub}'};document.getElementById('photoFile').click()">
        📷 Tap to add photo
      </div>
      <div class="photo-grid">
        ${photos.map((p,i)=>`
          <div class="photo-item">
            <img src="${p.data}" onclick="viewPhoto(${i},'${sub}')" alt="${esc(p.caption||'')}">
            <button class="photo-del" onclick="deletePhoto(${i},'${sub}')">✕</button>
            <input class="photo-cap" value="${esc(p.caption||'')}" placeholder="Caption…"
              onblur="savePhotoCaption('${sub}',${i},this.value)">
            ${p.sizeKb ? `<div style="font-size:10px;color:var(--label3);text-align:center;padding:2px 0">Saved as ${p.sizeKb} KB</div>` : ''}
          </div>`).join('')}
      </div>
    </div>`;
}

function compressImage(file, maxSize, quality, callback) {
  const reader = new FileReader();
  reader.onload = function(e) {
    const img = new Image();
    img.onload = function() {
      const canvas = document.createElement('canvas');
      let w = img.width, h = img.height;
      if (w > maxSize || h > maxSize) {
        if (w > h) { h = Math.round(h * maxSize / w); w = maxSize; }
        else { w = Math.round(w * maxSize / h); h = maxSize; }
      }
      canvas.width = w; canvas.height = h;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0, w, h);
      callback(canvas.toDataURL('image/jpeg', quality));
    };
    img.src = e.target.result;
  };
  reader.readAsDataURL(file);
}

function handlePhotoUpload(input) {
  const file = input.files[0]; if (!file) return;
  compressImage(file, 1200, 0.7, function(compressed) {
    const base64 = compressed.split(',')[1] || '';
    const sizeKb = Math.round(base64.length * 0.75 / 1024);
    const section = _photoCtx?.section || ui.photoSub;
    if (!data.photos) data.photos = {};
    if (!data.photos[section]) data.photos[section] = [];
    data.photos[section].push({id:uid(), data:compressed, caption:'', sizeKb});
    save(); document.getElementById('mainContent').innerHTML = renderPhotos();
  });
  input.value = '';
}

function deletePhoto(i, section) {
  if (!confirm('Delete this photo?')) return;
  data.photos[section].splice(i,1); save();
  document.getElementById('mainContent').innerHTML = renderPhotos();
}

function savePhotoCaption(section, i, val) {
  if (data.photos?.[section]?.[i]) { data.photos[section][i].caption = val; save(); }
}

function viewPhoto(i, section) {
  const p = data.photos?.[section]?.[i]; if (!p) return;
  showModal(p.caption||'Photo', `<img src="${p.data}" style="width:100%;border-radius:8px">`);
}

// ═══════════════════════════════════════════════════════════
//  SECTION 4 — SHIPYARD
// ═══════════════════════════════════════════════════════════

function shortDate(dateStr) {
  if (!dateStr) return '';
  const d = new Date(dateStr + 'T00:00:00');
  return ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][d.getMonth()] + ' ' + String(d.getFullYear()).slice(2);
}

function fmtCost(v) {
  const n = parseFloat(String(v||'').replace(/[€$£,\s]/g,''));
  return isNaN(n) ? '—' : '€' + n.toLocaleString('en', {minimumFractionDigits:0, maximumFractionDigits:0});
}

function renderShipyard() {
  if (!data.shipyard) data.shipyard = {current:{}, quotes:[], history:[]};
  // Migrate flat structure (pre-redesign) to nested data.shipyard.current
  if (data.shipyard.name && !Object.keys(data.shipyard.current || {}).length) {
    data.shipyard.current = {
      name:         data.shipyard.name,
      location:     data.shipyard.location,
      startDate:    data.shipyard.startDate,
      endDate:      data.shipyard.endDate,
      actualCost:   data.shipyard.actualCost || data.shipyard.cost,
      depositPaid:  data.shipyard.depositPaid,
      balanceDue:   data.shipyard.balanceDue,
      notes:        data.shipyard.notes,
    };
    ['name','location','startDate','endDate','actualCost','cost','depositPaid','balanceDue','notes']
      .forEach(k => delete data.shipyard[k]);
    save();
  }
  const s = data.shipyard.current || {};
  const isOwner = localStorage.getItem(EMAIL_KEY) === OWNER_EMAIL;
  const exMsg = !isOwner && (data.shipyard.history?.length || data.shipyard.quotes?.length)
    ? `<div style="margin:8px 12px;font-size:12px;color:var(--label3);font-style:italic">These are examples — replace with your own data</div>` : '';

  // Season label from start date
  const yr = s.startDate ? new Date(s.startDate+'T00:00:00').getFullYear() : null;
  const seasonLabel = yr ? `${yr}/${yr+1}` : '';

  // ── Card 1: Current season ────────────────────────────────
  const card1 = `
    <div class="sec-hd" style="display:flex;align-items:center;justify-content:space-between">
      Current season
      ${seasonLabel ? `<span style="font-size:12px;font-weight:400;color:var(--label3)">${esc(seasonLabel)}</span>` : ''}
    </div>
    <div class="card"><div class="card-body">
      ${fr('Shipyard','shipyard.current.name',s.name)}
      ${fr('Location','shipyard.current.location',s.location)}
      ${fr('Start date','shipyard.current.startDate',s.startDate,'date')}
      ${fr('End date','shipyard.current.endDate',s.endDate,'date')}
      ${fr('Cost quoted','shipyard.current.actualCost',s.actualCost?fmtCost(s.actualCost):'')}
      ${fr('Deposit paid','shipyard.current.depositPaid',s.depositPaid?fmtCost(s.depositPaid):'')}
      ${fr('Balance due','shipyard.current.balanceDue',s.balanceDue?fmtCost(s.balanceDue):'')}
      <div class="fr"><div class="fl">Total paid</div><div class="fv">${(()=>{const d=parseFloat((s.depositPaid||'').replace(/[€$£,\s]/g,''));const b=parseFloat((s.balanceDue||'').replace(/[€$£,\s]/g,''));return(!isNaN(d)&&!isNaN(b))?fmtCost(d+b):'—';})()}</div></div>
      ${frArea('Notes','shipyard.current.notes',s.notes)}
    </div></div>`;

  // ── Card 2: Quote comparison ──────────────────────────────
  const sorted = (data.shipyard.quotes||[])
    .map((q,i) => ({q, i}))
    .sort((a,b) => (parseFloat((a.q.price||'').replace(/[^0-9.]/g,''))||0) - (parseFloat((b.q.price||'').replace(/[^0-9.]/g,''))||0));

  const quoteRows = sorted.length ? sorted.map(({q,i}) => `
    <div style="display:flex;align-items:center;gap:10px;padding:11px 14px;border-bottom:1px solid var(--sep)">
      <div style="flex-shrink:0;min-width:0;max-width:35%">
        <div style="font-size:14px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(q.name||'')}</div>
        <div style="font-size:12px;color:var(--label3);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(q.location||'')}</div>
      </div>
      <div style="flex:1;min-width:0;font-size:12px;color:var(--label3);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(q.notes||'')}</div>
      <div style="font-size:14px;font-weight:600;flex-shrink:0">${fmtCost(q.price)}</div>
      <div style="flex-shrink:0;display:flex;align-items:center;gap:4px">
        <button onclick="selectQuote(${i})" style="${q.selected
          ? 'background:var(--green);color:#fff;border:none;border-radius:10px;padding:3px 10px;font-size:11px;font-weight:700;font-family:var(--font);cursor:pointer'
          : 'background:var(--surface2);color:var(--label2);border:0.5px solid var(--sep);border-radius:10px;padding:3px 10px;font-size:11px;font-weight:600;font-family:var(--font);cursor:pointer'}">${q.selected ? '✓ Selected' : 'Select'}</button>
        <button onclick="editQuote(${i})" style="background:none;border:none;padding:2px 4px;cursor:pointer;font-size:14px;color:var(--label3);line-height:1;flex-shrink:0">✏️</button>
      </div>
    </div>`).join('') : `<div style="padding:18px 14px;color:var(--label3);font-size:13px">No quotes yet — tap + Add quote</div>`;

  const card2 = `
    <div class="sec-hd" style="display:flex;align-items:center;justify-content:space-between">
      Quote comparison
      <button onclick="showAddQuote()" style="background:var(--blue);color:#fff;border:none;border-radius:8px;padding:5px 12px;font-size:12px;font-weight:600;font-family:var(--font);cursor:pointer">+ Add quote</button>
    </div>
    <div class="card">${quoteRows}</div>`;

  // ── Card 3: Past seasons ──────────────────────────────────
  const histSorted = (data.shipyard.history||[])
    .map((h,i) => ({h, i}))
    .sort((a,b) => {
      if (a.h.start && b.h.start) return b.h.start.localeCompare(a.h.start);
      return (b.h.year||'').localeCompare(a.h.year||'');
    });

  const histRows = histSorted.length ? histSorted.map(({h,i}) => {
    const yrRaw = h.year||''; const yrM = yrRaw.match(/^(\d{4})[-\/](\d{2,4})$/);
    const yr = yrM ? yrM[1]+'/'+yrM[2].slice(-2) : yrRaw;
    const dateRange = [h.start, h.end].filter(Boolean).map(shortDate).join('–');
    const hasNotes = (h.notes||'').length > 30;
    const notesId = `sy-notes-${i}`;
    return `<div style="border-bottom:1px solid var(--sep)">
      <div style="display:flex;align-items:center;gap:8px;padding:8px 14px;overflow-x:hidden">
        <div style="font-size:12px;font-weight:700;flex-shrink:0;width:60px;white-space:nowrap">${esc(yr)}</div>
        <div style="font-size:13px;flex-shrink:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:110px">${esc(h.location||h.name||'')}</div>
        <div style="font-size:11px;color:var(--label3);flex-shrink:0;white-space:nowrap">${esc(dateRange)}</div>
        <div id="${notesId}" style="font-size:11px;color:var(--label3);flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;${hasNotes?'cursor:pointer':''}"
          ${hasNotes?`onclick="var el=document.getElementById('${notesId}');var exp=el.dataset.expanded==='1';el.dataset.expanded=exp?'0':'1';el.style.whiteSpace=exp?'nowrap':'normal';el.style.overflow=exp?'hidden':'visible';el.style.textOverflow=exp?'ellipsis':'clip';" title="Tap to expand"`:''}>
          ${esc(h.notes||'')}${hasNotes?` <span style="color:var(--blue);font-size:10px">▼</span>`:''}
        </div>
        <div style="font-size:12px;font-weight:600;flex-shrink:0;white-space:nowrap">${fmtCost(h.cost)}</div>
        <button onclick="editShipyardHistory(${i})" style="background:none;border:none;padding:2px 4px;cursor:pointer;font-size:14px;color:var(--label3);line-height:1;flex-shrink:0">✏️</button>
      </div>
    </div>`;
  }).join('') : `<div style="padding:18px 14px;color:var(--label3);font-size:13px">No past seasons yet</div>`;

  const card3 = `
    <div class="sec-hd" style="display:flex;align-items:center;justify-content:space-between">
      Past seasons
      <button onclick="showAddShipyardHistory()" style="background:var(--blue);color:#fff;border:none;border-radius:8px;padding:5px 12px;font-size:12px;font-weight:600;font-family:var(--font);cursor:pointer">+ Add</button>
    </div>
    <div class="card">${histRows}</div>`;

  return exMsg + card1 + card2 + card3;
}

function showAddQuote() {
  showModal('Add Quote', `
    <div class="mi-label">Shipyard Name</div><input class="mi" id="m-sn" placeholder="Name" autofocus>
    <div class="mi-label">Location</div><input class="mi" id="m-sl" placeholder="City, Country">
    <div class="mi-label">Cost quoted</div><input class="mi" id="m-sp" placeholder="€ 0,000">
    <div class="mi-label">Start date</div><input class="mi" id="m-qsd" type="date">
    <div class="mi-label">End date</div><input class="mi" id="m-qed" type="date">
    <div class="mi-label">Notes</div><input class="mi" id="m-snotes" placeholder="Optional">
    <div class="modal-btns">
      <button class="btn btn-s" onclick="hideModal()">Cancel</button>
      <button class="btn btn-p" onclick="saveQuote()">Add</button>
    </div>`);
}
function saveQuote() {
  if (!data.shipyard) data.shipyard = {current:{}, quotes:[], history:[]};
  if (!data.shipyard.quotes) data.shipyard.quotes = [];
  data.shipyard.quotes.push({
    id:uid(), name:document.getElementById('m-sn').value,
    location:document.getElementById('m-sl').value,
    price:document.getElementById('m-sp').value,
    startDate:document.getElementById('m-qsd').value,
    endDate:document.getElementById('m-qed').value,
    notes:document.getElementById('m-snotes').value, selected:false
  });
  save(); hideModal(); document.getElementById('mainContent').innerHTML = renderShipyard();
}
function editQuote(i) {
  const q = data.shipyard?.quotes?.[i]; if (!q) return;
  showModal('Edit Quote', `
    <div class="mi-label">Shipyard Name</div><input class="mi" id="m-sn" value="${esc(q.name||'')}" autofocus>
    <div class="mi-label">Location</div><input class="mi" id="m-sl" value="${esc(q.location||'')}">
    <div class="mi-label">Cost quoted</div><input class="mi" id="m-sp" value="${esc(q.price||'')}">
    <div class="mi-label">Start date</div><input class="mi" id="m-qsd" type="date" value="${esc(q.startDate||'')}">
    <div class="mi-label">End date</div><input class="mi" id="m-qed" type="date" value="${esc(q.endDate||'')}">
    <div class="mi-label">Notes</div><input class="mi" id="m-snotes" value="${esc(q.notes||'')}">
    <div class="modal-btns">
      <button onclick="if(confirm('Remove this quote?')){hideModal();removeQuote(${i})}" style="background:#FCEBEB;border:0.5px solid #F09595;color:#A32D2D;border-radius:8px;padding:8px 14px;font-family:var(--font);font-size:14px;font-weight:600;cursor:pointer;margin-right:auto">Delete</button>
      <button class="btn btn-s" onclick="hideModal()">Cancel</button>
      <button class="btn btn-p" onclick="saveEditQuote(${i})">Save</button>
    </div>`);
}
function saveEditQuote(i) {
  const q = data.shipyard?.quotes?.[i]; if (!q) return;
  q.name      = document.getElementById('m-sn').value;
  q.location  = document.getElementById('m-sl').value;
  q.price     = document.getElementById('m-sp').value;
  q.startDate = document.getElementById('m-qsd').value;
  q.endDate   = document.getElementById('m-qed').value;
  q.notes     = document.getElementById('m-snotes').value;
  save(); hideModal(); document.getElementById('mainContent').innerHTML = renderShipyard();
}
function selectQuote(i) {
  if (!data.shipyard?.quotes?.[i]) return;
  const wasSelected = data.shipyard.quotes[i].selected;
  const q = data.shipyard.quotes[i];
  data.shipyard.quotes.forEach((qq,j) => qq.selected = (j===i ? !wasSelected : false));
  if (!data.shipyard.current) data.shipyard.current = {};
  if (!wasSelected) {
    if (q.name)      data.shipyard.current.name       = q.name;
    if (q.location)  data.shipyard.current.location   = q.location;
    if (q.price)     data.shipyard.current.actualCost = q.price;
    if (q.startDate) data.shipyard.current.startDate  = q.startDate;
    if (q.endDate)   data.shipyard.current.endDate    = q.endDate;
  } else {
    if (data.shipyard.current.name       === q.name)      data.shipyard.current.name       = '';
    if (data.shipyard.current.location   === q.location)  data.shipyard.current.location   = '';
    if (data.shipyard.current.actualCost === q.price)     data.shipyard.current.actualCost = '';
    if (data.shipyard.current.startDate  === q.startDate) data.shipyard.current.startDate  = '';
    if (data.shipyard.current.endDate    === q.endDate)   data.shipyard.current.endDate    = '';
  }
  save(); document.getElementById('mainContent').innerHTML = renderShipyard();
}
function removeQuote(i) {
  data.shipyard.quotes.splice(i,1); save();
  document.getElementById('mainContent').innerHTML = renderShipyard();
}
function showAddShipyardHistory() {
  showModal('Add Past Season', `
    <div class="mi-label">Year</div><input class="mi" id="m-yr" placeholder="e.g. 2024" autofocus>
    <div class="mi-label">Shipyard</div><input class="mi" id="m-sy" placeholder="Name">
    <div class="mi-label">Location</div><input class="mi" id="m-sloc" placeholder="City, Country">
    <div class="mi-label">Start Date</div><input class="mi" id="m-sd" type="date">
    <div class="mi-label">End Date</div><input class="mi" id="m-ed" type="date">
    <div class="mi-label">Cost Paid</div><input class="mi" id="m-cp" placeholder="€ 0,000">
    <div class="mi-label">Notes</div><input class="mi" id="m-hn" placeholder="Optional">
    <div class="modal-btns">
      <button class="btn btn-s" onclick="hideModal()">Cancel</button>
      <button class="btn btn-p" onclick="saveShipyardHistory()">Add</button>
    </div>`);
}
function saveShipyardHistory() {
  if (!data.shipyard.history) data.shipyard.history = [];
  data.shipyard.history.push({
    id:uid(), year:document.getElementById('m-yr').value,
    name:document.getElementById('m-sy').value,
    location:document.getElementById('m-sloc')?.value||'',
    start:document.getElementById('m-sd').value,
    end:document.getElementById('m-ed').value,
    cost:document.getElementById('m-cp').value,
    notes:document.getElementById('m-hn').value
  });
  save(); hideModal(); document.getElementById('mainContent').innerHTML = renderShipyard();
}
function editShipyardHistory(i) {
  const h = data.shipyard?.history?.[i]; if (!h) return;
  showModal('Edit Past Season', `
    <div class="mi-label">Year</div><input class="mi" id="m-yr" value="${esc(h.year||'')}" autofocus>
    <div class="mi-label">Shipyard</div><input class="mi" id="m-sy" value="${esc(h.name||'')}">
    <div class="mi-label">Location</div><input class="mi" id="m-sloc" value="${esc(h.location||'')}">
    <div class="mi-label">Start Date</div><input class="mi" id="m-sd" type="date" value="${esc(h.start||'')}">
    <div class="mi-label">End Date</div><input class="mi" id="m-ed" type="date" value="${esc(h.end||'')}">
    <div class="mi-label">Cost Paid</div><input class="mi" id="m-cp" value="${esc(h.cost||'')}">
    <div class="mi-label">Notes</div><input class="mi" id="m-hn" value="${esc(h.notes||'')}">
    <div class="modal-btns">
      <button onclick="if(confirm('Remove this season?')){hideModal();removeShipyardHistory(${i})}" style="background:#FCEBEB;border:0.5px solid #F09595;color:#A32D2D;border-radius:8px;padding:8px 14px;font-family:var(--font);font-size:14px;font-weight:600;cursor:pointer;margin-right:auto">Delete</button>
      <button class="btn btn-s" onclick="hideModal()">Cancel</button>
      <button class="btn btn-p" onclick="saveEditShipyardHistory(${i})">Save</button>
    </div>`);
}
function saveEditShipyardHistory(i) {
  const h = data.shipyard?.history?.[i]; if (!h) return;
  h.year     = document.getElementById('m-yr').value;
  h.name     = document.getElementById('m-sy').value;
  h.location = document.getElementById('m-sloc')?.value||'';
  h.start    = document.getElementById('m-sd').value;
  h.end      = document.getElementById('m-ed').value;
  h.cost     = document.getElementById('m-cp').value;
  h.notes    = document.getElementById('m-hn').value;
  save(); hideModal(); document.getElementById('mainContent').innerHTML = renderShipyard();
}
function removeShipyardHistory(i) {
  data.shipyard.history.splice(i,1); save();
  document.getElementById('mainContent').innerHTML = renderShipyard();
}

// ═══════════════════════════════════════════════════════════
//  SECTION 5 — MAINTENANCE
// ═══════════════════════════════════════════════════════════

// ── Simplified maintenance tasks ──────────────────────────

const MAINT_TASKS = [
  // Engine
  { id:'mt_oil',        task:'Engine oil',               intHrs:150,  intDays:null, intLabel:'Every 150h' },
  { id:'mt_oilfilter',  task:'Engine oil filter',        intHrs:150,  intDays:null, intLabel:'Every 150h' },
  { id:'mt_coolant',    task:'Engine coolant',           intHrs:null, intDays:365,  intLabel:'Every 12 months' },
  { id:'mt_ffuel',      task:'Fuel filters',             intHrs:250,  intDays:null, intLabel:'Every 250h' },
  { id:'mt_impeller',   task:'Raw water pump impeller',  intHrs:250,  intDays:null, intLabel:'Every 250h' },
  { id:'mt_belts_rep',  task:'Engine belt',              intHrs:1000, intDays:null, intLabel:'Every 1000h' },
  { id:'mt_rwbelt_rep', task:'Raw water pump belt',      intHrs:1000, intDays:null, intLabel:'Every 1000h' },
  { id:'mt_hex',        task:'Heat exchanger',           intHrs:1000, intDays:null, intLabel:'Every 1000h' },
  { id:'mt_mixelbow',   task:'Mixing elbow',             intHrs:1000, intDays:null, intLabel:'Every 1000h' },
  // Sail Drive
  { id:'mt_sailoil',    task:'Gear oil',                 intHrs:150,  intDays:null, intLabel:'Every 150h' },
  { id:'mt_sdseals',    task:'Lip seals',                intHrs:1000, intDays:null, intLabel:'Every 1000h' },
  { id:'mt_sdshaft',    task:'Propeller shaft',          intHrs:1000, intDays:null, intLabel:'Every 1000h' },
  // Genset (independent intervals, gs_ prefix)
  { id:'gs_oil',        task:'Genset oil',               intHrs:150,  intDays:null, intLabel:'Every 150h' },
  { id:'gs_oilfilter',  task:'Genset oil filter',        intHrs:150,  intDays:null, intLabel:'Every 150h' },
  { id:'gs_coolant',    task:'Genset coolant',           intHrs:null, intDays:365,  intLabel:'Every 12 months' },
  { id:'gs_ffuel',      task:'Genset fuel filters',      intHrs:250,  intDays:null, intLabel:'Every 250h' },
  { id:'gs_impeller',   task:'Genset raw water impeller',intHrs:250,  intDays:null, intLabel:'Every 250h' },
  { id:'gs_belts_rep',  task:'Genset engine belt',       intHrs:1000, intDays:null, intLabel:'Every 1000h' },
  { id:'gs_rwbelt_rep', task:'Genset raw water belt',    intHrs:1000, intDays:null, intLabel:'Every 1000h' },
  { id:'gs_hex',        task:'Genset heat exchanger',    intHrs:1000, intDays:null, intLabel:'Every 1000h' },
  { id:'gs_mixelbow',   task:'Genset mixing elbow',      intHrs:1000, intDays:null, intLabel:'Every 1000h' },
];

const MAINT_CATEGORIES = [
  { id:'engine',    label:'Engine',     tasks:['mt_oil','mt_oilfilter','mt_coolant','mt_ffuel','mt_impeller','mt_belts_rep','mt_rwbelt_rep','mt_hex','mt_mixelbow'] },
  { id:'saildrive', label:'Sail Drive', tasks:['mt_sailoil','mt_sdseals','mt_sdshaft'] },
  { id:'genset',    label:'Genset',     tasks:['gs_oil','gs_oilfilter','gs_coolant','gs_ffuel','gs_impeller','gs_belts_rep','gs_rwbelt_rep','gs_hex','gs_mixelbow'] },
];

const INTERVAL_CONFIG = MAINT_CATEGORIES;

function getActiveCategories() {
  if (!data.maintenance) return ['engine','saildrive'];
  if (!data.maintenance.activeCategories) {
    data.maintenance.activeCategories = ['engine','saildrive'];
  }
  return data.maintenance.activeCategories;
}

function maintTaskKeywords(taskId) {
  return {
    mt_oil:        ['engine oil', 'oil change', 'lube oil', 'crankcase', 'oil filter', 'oil & filter', 'oil and filter'],
    mt_oilfilter:  ['oil filter', 'oilfilter', 'engine oil filter'],
    mt_coolant:    ['coolant', 'antifreeze', 'fresh water coolant'],
    mt_ffuel:      ['fuel filter', 'diesel filter', 'racor', 'separ', 'fuel water filter'],
    mt_impeller:   ['impeller', 'raw water pump impeller', 'raw water impeller'],
    mt_belts_rep:  ['belt', 'belts', 'engine belt'],
    mt_rwbelt_rep: ['raw water pump belt', 'pump belt', 'water pump belt', 'raw water belt'],
    mt_mixelbow:   ['mixing elbow', 'water mixing elbow', 'exhaust elbow'],
    mt_hex:        ['heat exchanger'],
    mt_sailoil:    ['gear oil', 'sail drive oil', 'saildrive oil'],
    mt_sdseals:    ['lip seal', 'saildrive seal', 'sail drive seal', 'oil seal'],
    mt_sdshaft:    ['saildrive shaft', 'sail drive shaft', 'propeller shaft'],
    gs_oil:        ['genset oil', 'generator oil', 'genset oil change'],
    gs_oilfilter:  ['genset oil filter', 'generator oil filter'],
    gs_coolant:    ['genset coolant', 'generator coolant'],
    gs_ffuel:      ['genset fuel filter', 'generator fuel filter'],
    gs_impeller:   ['genset impeller', 'generator impeller', 'genset raw water'],
    gs_belts_rep:  ['genset belt', 'generator belt'],
    gs_rwbelt_rep: ['genset raw water belt', 'generator raw water belt', 'genset pump belt'],
    gs_hex:        ['genset heat exchanger', 'generator heat exchanger'],
    gs_mixelbow:   ['genset mixing elbow', 'generator mixing elbow'],
  }[taskId] || [];
}

const MAINT_CANONICAL_TASKS = [
  'Engine oil','Oil filter','Gear oil','Impeller',
  'Fuel filters','Coolant','Engine belt',
  'Water pump','Heat exchanger','Saildrive',
  'Saildrive lip seals','Saildrive shaft',
  'Valve clearance','Raw water strainer',
];
const MAINT_TASK_MAP = {
  // informal → new canonical
  'Engine oil PT/STBD + filter':'Engine oil',
  'Engine oil PT/STBD':'Engine oil',
  'Engine oil & filter PT/STBD':'Engine oil',
  'Engine oil & filter - winterising':'Engine oil',
  '50hr service PT/STBD':'Engine oil',
  'Engine filters PT/STBD':'Oil filter',
  'First & second fuel filters PT/STBD':'Oil filter',
  'Gear oil PT/STBD':'Gear oil',
  'Gear oil - whole exchange':'Gear oil',
  'Changed gear oil PT/STBD':'Gear oil',
  'Gear oil STBD/Port':'Gear oil',
  'Gear oil PT/STBD - 2 times full':'Gear oil',
  'Impeller PT/STBD':'Impeller',
  'Impeller only STBD':'Impeller',
  'Replaced impeller both sides - both were good':'Impeller',
  'Impeller changed PT/STBD':'Impeller',
  'Diesel fuel filters PT/STBD':'Fuel filters',
  'Diesel fuel filters':'Fuel filters',
  'Secondary diesel filters':'Fuel filters',
  'Racor fuel water filter Separ':'Fuel filters',
  'Seaform filter priming':'Fuel filters',
  'Yanmar coolant':'Coolant',
  'New Yanmar coolant':'Coolant',
  'Yanmar coolant - whole change':'Coolant',
  'Inspect and adjust belt tensioning':'Belt inspection / tensioning',
  'Inspect & adjust belt tension':'Belt inspection / tensioning',
  'Belt replacement PT':'Engine belt',
  'Belts changed PT/STBD':'Engine belt',
  'Replace belts':'Engine belt',
  'Water pump replacement - leak in port engine':'Water pump',
  'New STBD water pump':'Water pump',
  'Replaced STBD raw water pump':'Water pump',
  'Water pump lip seal PT/STBD':'Water pump',
  'Clean heat exchanger':'Heat exchanger',
  'New saildrive shafts PT/STBD':'Saildrive',
  'Exchange new saildrive thru hulls':'Saildrive',
  'Saildrive internal anodes':'Saildrive',
  'Added port engine coolant 400ml':'Coolant',
  'Added stbd engine coolant 400ml':'Coolant',
  'Impeller check OK':'Impeller',
  // old canonical → new canonical
  'Engine oil change':'Engine oil',
  'Oil filter change':'Oil filter',
  'Gear oil change':'Gear oil',
  'Impeller replacement':'Impeller',
  'Diesel fuel filter change':'Fuel filters',
  'Coolant change':'Coolant',
  'Belt replacement':'Engine belt',
  'Raw water pump replacement':'Water pump',
  'Heat exchanger service':'Heat exchanger',
  'Saildrive service':'Saildrive',
  'Saildrive lip seal replacement':'Saildrive lip seals',
  'Saildrive shaft replacement':'Saildrive shaft',
  'Cleaned raw water strainer':'Raw water strainer',
};
function normalizeMaintTask(t) { return MAINT_TASK_MAP[t] || t; }
function getMaintTaskDropdown(currentTask, pfx) {
  const isCustom = !!currentTask && !MAINT_CANONICAL_TASKS.includes(currentTask);
  const opts = MAINT_CANONICAL_TASKS.map(t =>
    `<option value="${esc(t)}" ${currentTask===t?'selected':''}>${esc(t)}</option>`
  ).join('');
  return `<select class="mi" id="${pfx}-task-sel" onchange="maintTaskSelChange('${pfx}')">
    ${opts}
    <option value="__custom__" ${isCustom?'selected':''}>+ Custom task…</option>
  </select>
  <input class="mi" id="${pfx}-task-txt" placeholder="Describe task" value="${isCustom?esc(currentTask):''}" style="display:${isCustom?'block':'none'};margin-top:6px">`;
}
function maintTaskSelChange(pfx) {
  const sel = document.getElementById(pfx+'-task-sel');
  const txt = document.getElementById(pfx+'-task-txt');
  if (!sel||!txt) return;
  txt.style.display = sel.value==='__custom__' ? 'block' : 'none';
  if (sel.value==='__custom__') txt.focus();
}
function getMaintTaskValue(pfx) {
  const sel = document.getElementById(pfx+'-task-sel');
  if (!sel) return '';
  return sel.value==='__custom__'
    ? (document.getElementById(pfx+'-task-txt')?.value.trim()||'')
    : sel.value;
}
function setMaintFilter(t) {
  ui.maintTaskFilter = t;
  document.getElementById('mainContent').innerHTML = renderMaintenance();
}
function setMaintLogSort(col) {
  const cur = ui.maintLogSort;
  if (!cur || cur.col !== col) ui.maintLogSort = {col, dir:'asc'};
  else if (cur.dir === 'asc')  ui.maintLogSort = {col, dir:'desc'};
  else                          ui.maintLogSort = null;
  document.getElementById('mainContent').innerHTML = renderMaintenance();
}
function cycleMaintLogSort() {
  const states = [
    {col:'date',  dir:'desc'},
    {col:'date',  dir:'asc'},
    {col:'hours', dir:'desc'},
    {col:'hours', dir:'asc'},
    {col:'task',  dir:'asc'},
    {col:'task',  dir:'desc'},
  ];
  const cur = ui.maintLogSort || states[0];
  const idx = states.findIndex(s => s.col===cur.col && s.dir===cur.dir);
  ui.maintLogSort = states[(idx + 1) % states.length];
  document.getElementById('mainContent').innerHTML = renderMaintenance();
}
function getMaintLog() { return data.maintenance?.log || []; }

function lastMaintEntry(taskId, eid) {
  const keys = maintTaskKeywords(taskId);
  if (!keys.length) return null;
  const task = MAINT_TASKS.find(t => t.id === taskId);
  const log  = getMaintLog().filter(e => (e.engines||['port','starboard']).includes(eid));
  const hits = log.filter(e => e.task && keys.some(k => e.task.toLowerCase().includes(k)));
  if (!hits.length) return null;
  return hits.reduce((best, e) => {
    if (task?.intDays) return (!best || e.date > best.date) ? e : best;
    return (parseFloat(e.hours)||0) > (parseFloat(best?.hours)||0) ? e : best;
  }, null);
}

function calcMaintStatus(task, eid) {
  const engHours  = data.maintenance?.engines?.[eid]?.hours || 0;
  const entry     = lastMaintEntry(task.id, eid);
  const customInt = data.maintenance?.intervals?.[task.id];
  const intDays   = customInt?.days !== undefined ? customInt.days : task.intDays;
  const intHrs    = customInt?.hrs  !== undefined ? customInt.hrs  : task.intHrs;
  if (!intHrs && !intDays) return null;
  if (intDays) {
    if (!entry) return { color:'red', label:'Never done' };
    const daysLeft = Math.ceil(((parseISODate(entry.date)||new Date(entry.date)).getTime() + intDays*86400000 - Date.now()) / 86400000);
    const color = daysLeft <= 0 ? 'red' : daysLeft <= intDays*0.25 ? 'orange' : 'green';
    return { color, label: daysLeft <= 0 ? `${Math.abs(daysLeft)}d overdue` : `${daysLeft}d left` };
  }
  if (!entry) {
    return { color:'grey', label:'No log entry' };
  }
  const lastHrs   = parseFloat(entry.hours) || 0;
  const remaining = lastHrs + intHrs - engHours;
  const color = remaining <= 0 ? 'red' : remaining <= intHrs*0.25 ? 'orange' : 'green';
  return { color, label: remaining <= 0 ? `${Math.abs(remaining)}h overdue` : `${remaining}h` };
}

function getMaintIntervalLabel(task) {
  const customInt = data.maintenance?.intervals?.[task.id];
  const intDays = customInt?.days !== undefined ? customInt.days : task.intDays;
  const intHrs  = customInt?.hrs  !== undefined ? customInt.hrs  : task.intHrs;
  if (!intHrs && !intDays) return '';
  if (intDays) {
    const months = Math.round(intDays / 30.5);
    return months >= 2 ? `Every ${months} months` : `Every ${intDays}d`;
  }
  return `Every ${intHrs}h`;
}

function calcCustomIntervalStatus(cit, type, eid) {
  const engHours = data.maintenance?.engines?.[eid]?.hours || 0;
  const intHrs   = type === 'check' ? cit.checkHrs : cit.replaceHrs;
  if (!intHrs) return null;
  const name = cit.name.toLowerCase();
  const log  = getMaintLog();
  const hits = log.filter(e => {
    const t = (e.task||'').toLowerCase();
    const engOk = !(e.engines||[]).length || (e.engines||[]).includes(eid);
    return (t === name || t.startsWith(name + ' —') || t.startsWith(name + ' -')) && engOk;
  });
  const entry   = hits.reduce((best, e) => (parseFloat(e.hours)||0) > (parseFloat(best?.hours)||0) ? e : null, null);
  const lastHrs = entry ? (parseFloat(entry.hours)||0) : 0;
  const remaining = lastHrs === 0 ? (intHrs - engHours) : (lastHrs + intHrs - engHours);
  const color = remaining <= 0 ? 'red' : remaining <= intHrs*0.25 ? 'orange' : 'green';
  return { color, label: remaining <= 0 ? `${Math.abs(remaining)}h overdue` : `${remaining}h` };
}

function calcSchedStatus(item, eid) {
  const hours = data.maintenance?.engines?.[eid]?.hours || 0;
  const e = data.maintenance?.sched?.[item.id]?.[eid] || {};
  if (!item.intHrs) {
    return { color:'grey', label: e.date ? fmtSchedDate(e.date) : '—', lastDoneAt: 0 };
  }
  const last = e.lastDoneAt || 0;
  const nextDue = last === 0 ? (item.initHrs || item.intHrs) : last + item.intHrs;
  const remaining = nextDue - hours;
  const color = remaining <= 0 ? 'red' : remaining <= item.intHrs * 0.2 ? 'orange' : 'green';
  const label = remaining <= 0 ? `${Math.abs(remaining)}h OD` : `${remaining}h`;
  return { color, label, remaining, nextDue, lastDoneAt: last };
}

function _schedHistory(eid, taskId) {
  const e = data.maintenance?.sched?.[taskId]?.[eid] || {};
  return e.history
    ? [...e.history]
    : (e.lastDoneAt ? [{hours: e.lastDoneAt, date: e.date||'', notes: e.notes||'', cost: e.cost||''}] : []);
}

function markSchedDone(taskId, eid) {
  ensureEngine(eid);
  if (!data.maintenance.sched) data.maintenance.sched = {};
  if (!data.maintenance.sched[taskId]) data.maintenance.sched[taskId] = {};
  const item   = YANMAR_SCHED.find(t => t.id === taskId);
  const hours  = data.maintenance.engines[eid].hours || 0;
  const prev   = JSON.parse(JSON.stringify(data.maintenance.sched[taskId][eid] || {}));
  _lastSchedUndo = {taskId, eid, prevEntry: prev};
  const history = _schedHistory(eid, taskId);
  const entry  = {hours: item?.intHrs ? hours : 0, date: new Date().toISOString().slice(0,10), notes:'', cost:''};
  history.push(entry);
  history.sort((a,b) => a.hours - b.hours);
  const last = history[history.length - 1];
  data.maintenance.sched[taskId][eid] = {lastDoneAt: last.hours, date: last.date, history};
  save(); renderAlertBar();
  document.getElementById('mainContent').innerHTML = renderMaintenance();
  showUndoToast();
}

function undoSchedDone() {
  if (!_lastSchedUndo) return;
  const {taskId, eid, prevEntry} = _lastSchedUndo;
  _lastSchedUndo = null;
  if (!data.maintenance.sched) data.maintenance.sched = {};
  data.maintenance.sched[taskId] = data.maintenance.sched[taskId] || {};
  data.maintenance.sched[taskId][eid] = prevEntry;
  save(); renderAlertBar();
  document.getElementById('mainContent').innerHTML = renderMaintenance();
  document.getElementById('undo-toast')?.remove();
  showToast('Undone');
}

function showUndoToast() {
  document.getElementById('undo-toast')?.remove();
  const t = document.createElement('div');
  t.id = 'undo-toast';
  t.style.cssText = 'position:fixed;bottom:30px;left:50%;transform:translateX(-50%);background:#333;color:#fff;padding:10px 16px;border-radius:20px;font-size:14px;z-index:9999;box-shadow:0 4px 12px rgba(0,0,0,.3);display:flex;align-items:center;gap:12px;white-space:nowrap';
  t.innerHTML = `<span>Marked done</span><button onclick="undoSchedDone()" style="background:rgba(255,255,255,.2);border:none;color:#fff;padding:4px 12px;border-radius:12px;font-family:inherit;font-size:13px;cursor:pointer;font-weight:600">Undo</button>`;
  document.body.appendChild(t);
  setTimeout(() => { t.remove(); _lastSchedUndo = null; }, 5000);
}

function showEditSchedItem(taskId) {
  const item = YANMAR_SCHED.find(t => t.id === taskId); if (!item) return;
  showModal(esc(item.task), buildEditSchedHTML(taskId));
}

function buildEditSchedHTML(taskId) {
  const item  = YANMAR_SCHED.find(t => t.id === taskId) || {};
  const eids  = getEngines();
  const isCat = data.meta.hullType === 'catamaran';
  const eLbl  = {port:'Port', starboard:'Starboard', main:'Engine'};
  const today = new Date().toISOString().slice(0,10);

  const engSections = eids.map(eid => {
    const history = _schedHistory(eid, taskId);
    const curHrs  = data.maintenance?.engines?.[eid]?.hours || 0;
    const rows = history.length
      ? history.slice().reverse().map((h, ri) => {
          const origIdx = history.length - 1 - ri;
          return `<div style="display:flex;align-items:center;gap:8px;padding:6px 0;border-bottom:1px solid var(--sep)">
            <div style="flex:1;font-size:13px">${fmtSchedDate(h.date)} · ${h.hours}h${h.notes?' · '+esc(h.notes):''}</div>
            <button class="btn btn-d btn-xs" onclick="deleteSchedHistEntry('${taskId}','${eid}',${origIdx})">✕</button>
          </div>`;
        }).join('')
      : `<div style="font-size:13px;color:var(--label3);padding:6px 0">No entries yet</div>`;

    return `${isCat ? `<div style="font-weight:600;color:var(--blue);font-size:13px;margin-top:14px;margin-bottom:6px">${eLbl[eid]}</div>` : ''}
      ${rows}
      <div style="margin-top:10px;display:grid;grid-template-columns:1fr 1fr;gap:8px">
        <div><div class="mi-label">Hours</div>
          <input class="mi" id="ea-h-${eid}" type="number" min="0" placeholder="${curHrs}"></div>
        <div><div class="mi-label">Date</div>
          <input class="mi" id="ea-d-${eid}" type="date" value="${today}"></div>
      </div>
      <div class="mi-label">Notes</div><input class="mi" id="ea-n-${eid}" placeholder="Optional">
      <div class="mi-label">Cost (€)</div><input class="mi" id="ea-c-${eid}" type="number" min="0" placeholder="0">
      <button class="btn btn-p btn-sm w-full" onclick="addSchedHistEntry('${taskId}','${eid}')" style="margin-bottom:4px">+ Add Entry${isCat?' ('+eLbl[eid]+')':''}</button>`;
  }).join('');

  return `<div style="font-size:12px;color:var(--label3);margin-bottom:10px">${esc(item.intLabel||'')}</div>
    ${engSections}
    <div class="modal-btns" style="margin-top:12px">
      <button class="btn btn-p w-full" onclick="hideModal();document.getElementById('mainContent').innerHTML=renderMaintenance()">Done</button>
    </div>`;
}

function addSchedHistEntry(taskId, eid) {
  ensureEngine(eid);
  if (!data.maintenance.sched) data.maintenance.sched = {};
  if (!data.maintenance.sched[taskId]) data.maintenance.sched[taskId] = {};
  const defHrs = data.maintenance.engines[eid]?.hours || 0;
  const hours  = parseInt(document.getElementById(`ea-h-${eid}`)?.value) || defHrs;
  const date   = document.getElementById(`ea-d-${eid}`)?.value || new Date().toISOString().slice(0,10);
  const notes  = document.getElementById(`ea-n-${eid}`)?.value || '';
  const cost   = document.getElementById(`ea-c-${eid}`)?.value || '';
  const history = _schedHistory(eid, taskId);
  history.push({hours, date, notes, cost});
  history.sort((a,b) => a.hours - b.hours);
  const last = history[history.length - 1];
  data.maintenance.sched[taskId][eid] = {lastDoneAt: last.hours, date: last.date, history};
  save(); renderAlertBar();
  document.getElementById('modalBody').innerHTML =
    `<div class="modal-title">${esc(YANMAR_SCHED.find(t=>t.id===taskId)?.task||'')}</div>`
    + buildEditSchedHTML(taskId);
  document.getElementById('mainContent').innerHTML = renderMaintenance();
}

function deleteSchedHistEntry(taskId, eid, idx) {
  const history = _schedHistory(eid, taskId);
  history.splice(idx, 1);
  history.sort((a,b) => a.hours - b.hours);
  const last = history[history.length - 1];
  if (!data.maintenance.sched) data.maintenance.sched = {};
  if (!data.maintenance.sched[taskId]) data.maintenance.sched[taskId] = {};
  data.maintenance.sched[taskId][eid] = last
    ? {lastDoneAt: last.hours, date: last.date, history}
    : {lastDoneAt: 0, date: '', history: []};
  save(); renderAlertBar();
  document.getElementById('modalBody').innerHTML =
    `<div class="modal-title">${esc(YANMAR_SCHED.find(t=>t.id===taskId)?.task||'')}</div>`
    + buildEditSchedHTML(taskId);
  document.getElementById('mainContent').innerHTML = renderMaintenance();
}

function renderMaintGauges() {
  const log      = getMaintLog();
  const eids     = getEngines();
  const curHours = eids.length ? Math.max(...eids.map(eid => data.maintenance?.engines?.[eid]?.hours || 0)) : 0;
  const gaugeDefs = [
    {title:'Engine Oil + Filter', tasks:['Engine oil','Oil filter'],   interval:150, green:50,  amber:20},
    {title:'Gear Oil',            tasks:['Gear oil'],                  interval:150, green:50,  amber:20},
    {title:'Fuel Filters',        tasks:['Fuel filters'],              interval:250, green:80,  amber:30},
    {title:'Lip Seals',           tasks:['Saildrive lip seals'],       interval:800, green:200, amber:100},
  ];
  const order = (() => {
    const o = data.maintenance?.gaugeOrder;
    return (Array.isArray(o) && o.length === 4) ? o : [0,1,2,3];
  })();

  function lastH(...tasks) {
    const entries = log.filter(e => tasks.includes(e.task));
    if (!entries.length) return null;
    return Math.max(...entries.map(e => parseFloat(e.hours) || 0));
  }

  function gauge(title, lastHours, interval, greenT, amberT, pos) {
    const due     = lastHours !== null ? lastHours + interval : null;
    const rem     = due !== null ? due - curHours : null;
    const overdue = rem !== null && rem <= 0;
    const pct     = rem === null ? 0 : overdue ? 1 : Math.min(1, rem / interval);
    const color   = rem === null  ? '#9ca3af'
                  : rem >= greenT ? '#22C55E'
                  : rem >= amberT ? '#F59E0B'
                  : '#EF4444';
    const num      = rem === null ? '—' : String(Math.max(0, Math.round(rem)));
    const dueLabel = due !== null ? `Due: ${Math.round(due)}h` : 'No data';
    const L      = 163;
    const offset = Math.round(L * (1 - pct));
    return `
      <div data-gauge-pos="${pos}" draggable="true"
        ondragstart="gaugeDragStart(event,${pos})"
        ondragover="gaugeDragOver(event,${pos})"
        ondragleave="gaugeDragLeave(event)"
        ondrop="gaugeDrop(event,${pos})"
        ondragend="gaugeDragEnd()"
        style="background:var(--surface);border:0.5px solid var(--sep);border-radius:14px;padding:12px 8px 10px;text-align:center">
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:4px">
          <div style="font-size:10px;font-weight:700;color:var(--label2);line-height:1.3">${title}</div>
          <span class="prov-grip" style="font-size:13px;line-height:1">⠿</span>
        </div>
        <svg viewBox="0 0 130 72" style="width:100%;display:block">
          <path d="M13,65 A52,52 0 0,1 117,65" fill="none" stroke="#e5e7eb" stroke-width="10" stroke-linecap="round"/>
          <path d="M13,65 A52,52 0 0,1 117,65" fill="none" stroke="${color}" stroke-width="10" stroke-linecap="round" stroke-dasharray="${L}" stroke-dashoffset="${offset}"/>
          <text x="65" y="48" text-anchor="middle" font-size="22" font-weight="800" fill="${color}" font-family="var(--font)">${num}</text>
          <text x="65" y="62" text-anchor="middle" font-size="10" fill="#9ca3af" font-family="var(--font)">hrs left</text>
        </svg>
        <div style="font-size:11px;color:var(--label3);margin-top:-2px">${dueLabel}</div>
      </div>`;
  }

  return `
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:14px">
      ${order.map((defIdx, pos) => {
        const d = gaugeDefs[defIdx] || gaugeDefs[0];
        return gauge(d.title, lastH(...d.tasks), d.interval, d.green, d.amber, pos);
      }).join('')}
    </div>`;
}

let _gaugeDragPos = null;
function gaugeDragStart(e, pos) {
  _gaugeDragPos = pos;
  e.dataTransfer.effectAllowed = 'move';
  e.dataTransfer.setData('text/plain', String(pos));
  setTimeout(() => document.querySelector(`[data-gauge-pos="${pos}"]`)?.classList.add('prov-dragging'), 0);
}
function gaugeDragOver(e, pos) {
  if (_gaugeDragPos === null || _gaugeDragPos === pos) return;
  e.preventDefault(); e.dataTransfer.dropEffect = 'move';
  document.querySelectorAll('.prov-drag-over').forEach(el => el.classList.remove('prov-drag-over'));
  e.currentTarget.classList.add('prov-drag-over');
}
function gaugeDragLeave(e) { if (!e.currentTarget.contains(e.relatedTarget)) e.currentTarget.classList.remove('prov-drag-over'); }
function gaugeDrop(e, toPos) {
  e.preventDefault();
  document.querySelectorAll('.prov-drag-over,.prov-dragging').forEach(el => el.classList.remove('prov-drag-over','prov-dragging'));
  const fromPos = _gaugeDragPos; _gaugeDragPos = null;
  _gaugeDoReorder(fromPos, toPos);
}
function gaugeDragEnd() {
  document.querySelectorAll('.prov-drag-over,.prov-dragging').forEach(el => el.classList.remove('prov-drag-over','prov-dragging'));
  _gaugeDragPos = null;
}
function _gaugeDoReorder(fromPos, toPos) {
  if (fromPos === null || toPos === null || fromPos === toPos) return;
  if (!data.maintenance) data.maintenance = {engines:{}, sched:{}, log:[]};
  const cur = (Array.isArray(data.maintenance.gaugeOrder) && data.maintenance.gaugeOrder.length===4)
    ? [...data.maintenance.gaugeOrder] : [0,1,2,3];
  const [moved] = cur.splice(fromPos, 1);
  cur.splice(toPos, 0, moved);
  data.maintenance.gaugeOrder = cur;
  save();
  document.getElementById('mainContent').innerHTML = renderMaintenance();
}

function renderMaintenance() {
  const isCat = data.meta.hullType === 'catamaran';
  const eids  = getEngines();
  const eLbl  = {port:'Port', starboard:'Stbd', main:'Engine'};
  // ── Hours ──
  const hoursHtml = `<div style="display:grid;grid-template-columns:${eids.length > 1 ? '1fr 1fr' : '1fr'};gap:10px;margin-bottom:14px">
    ${eids.map(eid => {
      const h = data.maintenance?.engines?.[eid]?.hours || 0;
      return `<div style="background:var(--surface);border:0.5px solid var(--sep);border-radius:14px;padding:12px 8px 10px;text-align:center">
        <div style="font-size:10px;font-weight:700;color:var(--label2);line-height:1.3;margin-bottom:4px">${eLbl[eid]}</div>
        <input type="number" value="${h}" min="0"
          style="width:100%;text-align:center;font-size:22px;font-weight:800;color:var(--label);background:none;border:none;outline:none;font-family:var(--font);padding:4px 0;-moz-appearance:textfield;appearance:textfield"
          onblur="setHours('${eid}',this.value)">
        <div style="font-size:10px;color:#9ca3af;margin-top:2px">hrs</div>
      </div>`;
    }).join('')}
  </div>`;
  // ── Coming up ──
  const colorRank = {red:2, orange:1, green:0, grey:-1};
  const activeCatTasks = new Set(
    MAINT_CATEGORIES.filter(c => getActiveCategories().includes(c.id)).flatMap(c => c.tasks)
  );
  const taskRows = MAINT_TASKS.filter(t => activeCatTasks.has(t.id)).flatMap(task => {
    const rawStatuses = eids.map(eid => { const s = calcMaintStatus(task, eid); return s ? {eid, ...s} : null; });
    const statuses = rawStatuses.filter(Boolean);
    if (!statuses.length) return [];
    const worst = statuses.reduce((a,b) => (colorRank[b.color]||0) > (colorRank[a.color]||0) ? b : a);
    return [{task, statuses, worstColor: worst.color}];
  });
  const customTaskRows = (data.maintenance?.customIntervalTasks||[]).flatMap(cit => {
    const rows = [];
    ['check','replace'].forEach(type => {
      const intHrs = type === 'check' ? cit.checkHrs : cit.replaceHrs;
      if (!intHrs) return;
      const statuses = eids.map(eid => { const s = calcCustomIntervalStatus(cit, type, eid); return s ? {eid, ...s} : null; }).filter(Boolean);
      if (!statuses.length) return;
      const worst = statuses.reduce((a,b) => (colorRank[b.color]||0) > (colorRank[a.color]||0) ? b : a);
      const taskName = cit.checkHrs && cit.replaceHrs ? `${cit.name} — ${type}` : cit.name;
      rows.push({task:{task:taskName, _intLabel:`Every ${intHrs}h`}, statuses, worstColor:worst.color});
    });
    return rows;
  });
  const allTaskRows = [...taskRows, ...customTaskRows];
  const showAll = ui.maintShowAll;
  const visible = showAll ? allTaskRows : allTaskRows.filter(r => r.worstColor !== 'green' && r.worstColor !== 'grey');
  const hiddenN = allTaskRows.filter(r => r.worstColor === 'green').length;
  const portHours = data.maintenance?.engines?.port?.hours || 0;
  const stbdHours = data.maintenance?.engines?.starboard?.hours || 0;
  const hoursDiverge = isCat && Math.abs(portHours - stbdHours) > 30;

  const comingRows = visible.map(({task, statuses}) => {
    const worst = statuses.reduce((a,b) => (colorRank[b.color]||0) > (colorRank[a.color]||0) ? b : a);
    let badgesHtml;
    if (hoursDiverge && statuses.length > 1) {
      badgesHtml = statuses.map(s =>
        `<span class="msb msb-${s.color}">${esc(eLbl[s.eid])} ${esc(s.label)}</span>`
      ).join('');
    } else {
      badgesHtml = `<span class="msb msb-${worst.color}">${esc(worst.label)}</span>`;
    }
    return `<div class="maint-row2">
      <div class="maint-task-name">${esc(task.task)}<span class="maint-int-lbl">${esc(task._intLabel || getMaintIntervalLabel(task))}</span></div>
      <div style="display:flex;gap:6px;flex-wrap:wrap">${badgesHtml}</div>
    </div>`;
  }).join('');
  const comingUpHtml = `
    <div class="sec-hd">Coming up</div>
    <div class="card">
      ${comingRows || '<div style="padding:16px;font-size:13px;color:var(--label3)">All tasks up to date ✓</div>'}
      ${!showAll && hiddenN > 0 ? `<div style="padding:10px 16px;border-top:1px solid var(--sep)"><button class="btn btn-s btn-sm" onclick="ui.maintShowAll=true;document.getElementById('mainContent').innerHTML=renderMaintenance()">Show ${hiddenN} green task${hiddenN>1?'s':''} ▾</button></div>` : ''}
      ${showAll && hiddenN > 0 ? `<div style="padding:10px 16px;border-top:1px solid var(--sep)"><button class="btn btn-s btn-sm" onclick="ui.maintShowAll=false;document.getElementById('mainContent').innerHTML=renderMaintenance()">Hide green tasks ▴</button></div>` : ''}
    </div>`;
  // ── Log ──
  const log = getMaintLog();
  const logFilter = ui.maintTaskFilter || 'All';
  const indexedLog = log.map((e, origIdx) => ({e, origIdx}));
  const filtered = logFilter === 'All' ? indexedLog : indexedLog.filter(({e}) => e.task === logFilter);
  const tasksWithEntries = MAINT_CANONICAL_TASKS.filter(t => log.some(e => e.task === t));
  const customTasksWithEntries = [...new Set(log.map(e => e.task))].filter(t => !MAINT_CANONICAL_TASKS.includes(t));
  const allFilterTasks = [...tasksWithEntries, ...customTasksWithEntries];
  const filterPills = allFilterTasks.length > 0 ? `<div class="subtab-bar" style="margin-bottom:10px">
    <div class="pill ${logFilter==='All'?'active':''}" onclick="ui.maintTaskFilter='All';document.getElementById('mainContent').innerHTML=renderMaintenance()">All</div>
    ${allFilterTasks.map(t => `<div class="pill ${logFilter===t?'active':''}" onclick="setMaintFilter(this.dataset.task)" data-task="${esc(t)}">${esc(t)}</div>`).join('')}
  </div>` : '';
  const logSort = ui.maintLogSort;
  const display = logSort ? [...filtered].sort((a, b) => {
    let va, vb;
    if      (logSort.col==='date')  { va=a.e.date||'';  vb=b.e.date||''; }
    else if (logSort.col==='hours') { va=parseFloat(a.e.hours)||0; vb=parseFloat(b.e.hours)||0; }
    else if (logSort.col==='task')  { va=a.e.task||'';  vb=b.e.task||''; }
    else { va=vb=0; }
    return (va<vb?-1:va>vb?1:0)*(logSort.dir==='asc'?1:-1);
  }) : filtered;
  function hdrCol(col, label, style) {
    const arrow = logSort?.col===col ? (logSort.dir==='asc' ? ' ▲' : ' ▼') : '';
    return `<div onclick="setMaintLogSort('${col}')" style="cursor:pointer;user-select:none;white-space:nowrap;overflow:hidden;padding:7px 0;font-size:11px;font-weight:700;${style}">${label}${arrow}</div>`;
  }
  const bLbl = {port:'PT', starboard:'STB'};
  const logRows = display.map(({e, origIdx}) => {
    const eid = e.id || '';
    const dp = e.date ? (() => { const [y,m,d]=e.date.split('-'); return `${+m}/${+d}/${y.slice(2)}`; })() : '';
    const engBadges = isCat ? (e.engines||[]).map(eng =>
      `<span style="font-size:10px;font-weight:700;padding:1px 4px;border-radius:4px;background:var(--surface2);color:var(--label3);flex-shrink:0;white-space:nowrap;margin-left:3px">${bLbl[eng]||eng}</span>`
    ).join('') : '';
    return `<div data-maint-id="${esc(eid)}" draggable="true"
      ondragstart="maintLogDragStart(event,'${esc(eid)}')"
      ondragover="maintLogDragOver(event,'${esc(eid)}')"
      ondragleave="maintLogDragLeave(event)"
      ondrop="maintLogDrop(event,'${esc(eid)}')"
      ondragend="maintLogDragEnd()"
      style="display:flex;align-items:center;width:100%;box-sizing:border-box;padding:0 12px;border-bottom:1px solid var(--sep)">
      <span class="prov-grip" style="width:20px;flex-shrink:0;padding:8px 0" ontouchstart="maintLogTouchStart(event,'${esc(eid)}')">⠿</span>
      <span style="width:60px;flex-shrink:0;font-size:11px;color:var(--label3);white-space:nowrap;overflow:hidden;padding:8px 4px 8px 0">${esc(dp)}</span>
      <span style="width:42px;flex-shrink:0;font-size:11px;color:var(--label3);white-space:nowrap;overflow:hidden;padding:8px 4px 8px 0">${esc(String(e.hours))}h</span>
      <span style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12px;font-weight:500;padding:8px 4px 8px 0">${esc(e.task)}</span>
      ${engBadges}
      <button style="background:none;border:none;padding:2px 4px;cursor:pointer;font-size:14px;color:var(--label3);line-height:1;flex-shrink:0;margin-left:4px" onclick="editMaintEntry(${origIdx})">✏️</button>
    </div>`;
  }).join('') || `<div style="color:var(--label3);padding:12px 16px;font-size:13px">${logFilter==='All'?'No entries yet':'No entries for this task'}</div>`;
  const logHtml = `
    <div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:6px;margin-bottom:8px">
      <div class="sec-hd" style="margin:0">Maintenance Log</div>
      <div style="display:flex;align-items:center;gap:8px">
        <span style="font-size:11px;color:var(--label3)">${display.length} ${display.length===1?'entry':'entries'}</span>
        <button onclick="printMaintLog()" style="font-size:12px;background:none;border:0.5px solid var(--sep);border-radius:8px;padding:4px 8px;cursor:pointer;font-family:var(--font);color:var(--label2);line-height:1.4">🖨 Print</button>
        <button class="btn btn-p btn-sm" onclick="showAddMaintEntry()">+ Add entry</button>
      </div>
    </div>
    ${filterPills}
    <div class="card">
      <div style="display:flex;align-items:center;width:100%;box-sizing:border-box;padding:0 12px;background:var(--surface2);border-bottom:1px solid var(--sep)">
        <div style="width:20px;flex-shrink:0"></div>
        ${hdrCol('date','Date','flex-shrink:0;width:60px;')}
        ${hdrCol('hours','Hrs','flex-shrink:0;width:42px;')}
        ${hdrCol('task','Task','flex:1;min-width:0;')}
        <div style="width:26px;flex-shrink:0"></div>
      </div>
      ${logRows}
    </div>`;
  const activeCats      = getActiveCategories();
  const activeCatLabels = MAINT_CATEGORIES.filter(c => activeCats.includes(c.id)).map(c => c.label).join(', ');
  const intervalsCardHtml = `
  <div onclick="showIntervalsModal()" style="background:#E6F1FB;border-radius:12px;padding:11px 14px;display:flex;align-items:center;justify-content:space-between;margin-bottom:14px;border:0.5px solid #B5D4F4;cursor:pointer">
    <div>
      <div style="font-size:12px;font-weight:600;color:#0C447C">Service intervals</div>
      <div style="font-size:11px;color:#185FA5;margin-top:1px">${esc(activeCatLabels)}${(data.maintenance?.customIntervalTasks||[]).length ? ' · ' + (data.maintenance.customIntervalTasks.length) + ' custom' : ''}</div>
    </div>
    <button onclick="event.stopPropagation();showIntervalsModal()" style="font-size:12px;background:#185FA5;color:#fff;border:none;border-radius:8px;padding:6px 12px;cursor:pointer;font-family:var(--font);font-weight:600">Edit ›</button>
  </div>`;
  return hoursHtml + renderMaintGauges() + comingUpHtml + intervalsCardHtml + logHtml;
}

function showIntervalsModal(editingCat) {
  const intervals   = data.maintenance?.intervals || {};
  const activeCats  = getActiveCategories();
  const customTasks = data.maintenance?.customIntervalTasks || [];
  const inpStyle    = 'width:58px;text-align:center;border:0.5px solid var(--sep);border-radius:8px;padding:5px 4px;font-family:var(--font);font-size:13px;background:var(--bg);color:var(--label);-moz-appearance:textfield;appearance:textfield';

  function getVal(taskId) {
    const cust = intervals[taskId];
    const task = MAINT_TASKS.find(t => t.id === taskId);
    if (cust) return cust.days ? Math.round(cust.days / 30.5) : (cust.hrs || '');
    if (!task) return '';
    return task.intDays ? Math.round(task.intDays / 30.5) : (task.intHrs || '');
  }

  function unitFor(taskId) {
    const cust = intervals[taskId];
    const task = MAINT_TASKS.find(t => t.id === taskId);
    return (cust?.days || task?.intDays) ? 'mo' : 'h';
  }

  const activeSections = MAINT_CATEGORIES.filter(c => activeCats.includes(c.id)).map(cat => {
    const isEditing = editingCat === cat.id;
    const taskRows = cat.tasks.map(tid => {
      const task = MAINT_TASKS.find(t => t.id === tid);
      if (!task) return '';
      const unit = unitFor(tid);
      return `<div style="display:flex;justify-content:space-between;align-items:center;padding:10px 14px;border-bottom:0.5px solid var(--sep)">
        <div style="font-size:13px;font-weight:500;color:var(--label)">${esc(task.task)}</div>
        <div style="display:flex;align-items:center;gap:6px">
          <input type="number" min="1" id="int_${tid}" value="${getVal(tid)}" placeholder="—" style="${inpStyle}">
          <span style="font-size:12px;color:var(--label3);width:18px">${unit}</span>
        </div>
      </div>`;
    }).join('');

    const header = isEditing
      ? `<div style="display:flex;align-items:center;justify-content:space-between;padding:10px 14px;border-bottom:0.5px solid var(--sep);background:var(--surface2)">
          <div style="font-size:12px;font-weight:700;color:var(--label)">${esc(cat.label)}</div>
          <div style="display:flex;gap:8px">
            <button onclick="deleteMaintCategory('${cat.id}')" style="font-size:12px;color:#E24B4A;background:none;border:1px solid #E24B4A;border-radius:8px;padding:3px 10px;cursor:pointer;font-family:var(--font);font-weight:600">Delete</button>
            <button onclick="showIntervalsModal()" style="font-size:12px;background:none;border:0.5px solid var(--sep);border-radius:8px;padding:3px 10px;cursor:pointer;font-family:var(--font);color:var(--label2)">Done</button>
          </div>
        </div>`
      : `<div style="display:flex;align-items:center;justify-content:space-between;padding:10px 14px;border-bottom:0.5px solid var(--sep);background:var(--surface2)">
          <div style="font-size:12px;font-weight:700;color:var(--label)">${esc(cat.label)}</div>
          <button onclick="showIntervalsModal('${cat.id}')" style="font-size:12px;background:none;border:0.5px solid var(--sep);border-radius:8px;padding:3px 10px;cursor:pointer;font-family:var(--font);color:var(--label2)">Edit</button>
        </div>`;

    return `<div style="font-size:10px;font-weight:800;color:var(--label3);text-transform:uppercase;letter-spacing:.07em;margin-bottom:8px">${esc(cat.label)}</div>
      <div class="card" style="margin-bottom:16px">${header}${taskRows}</div>`;
  }).join('');

  const inactiveCats = MAINT_CATEGORIES.filter(c => !activeCats.includes(c.id));
  const addButtons = inactiveCats.length ? `
    <div style="font-size:10px;font-weight:800;color:var(--label3);text-transform:uppercase;letter-spacing:.07em;margin-bottom:8px">Add category</div>
    <div style="display:flex;flex-wrap:wrap;gap:8px;margin-bottom:16px">
      ${inactiveCats.map(c => `<button onclick="addMaintCategory('${c.id}')" style="font-size:13px;background:var(--surface);border:0.5px solid var(--sep);border-radius:10px;padding:8px 16px;cursor:pointer;font-family:var(--font);color:var(--label2);font-weight:500">+ ${esc(c.label)}</button>`).join('')}
    </div>` : '';

  const customHtml = customTasks.map(cit => `
    <div style="display:flex;justify-content:space-between;align-items:center;padding:10px 14px;border-bottom:0.5px solid var(--sep)">
      <div style="font-size:13px;font-weight:500;color:var(--label)">${esc(cit.name)}</div>
      <div style="display:flex;align-items:center;gap:6px">
        <input type="number" min="1" id="cit_${esc(cit.id)}" value="${cit.replaceHrs||''}" placeholder="—" style="${inpStyle}">
        <span style="font-size:12px;color:var(--label3);width:18px">h</span>
        <button onclick="deleteCustomIntervalTask('${esc(cit.id)}')" style="background:none;border:none;color:#E24B4A;font-size:15px;cursor:pointer;padding:0 0 0 2px;line-height:1" title="Remove">✕</button>
      </div>
    </div>`).join('');

  const html = `
    <div style="max-height:65vh;overflow-y:auto;padding-right:2px;margin-bottom:12px">
      ${activeSections}
      ${addButtons}
      <div style="font-size:10px;font-weight:800;color:var(--label3);text-transform:uppercase;letter-spacing:.07em;margin-bottom:8px">Custom tasks</div>
      <div class="card" style="margin-bottom:4px">
        ${customHtml}
        <div style="padding:10px 14px">
          <input class="mi" id="new_cit_name" placeholder="Task name" style="margin-bottom:8px">
          <div style="display:flex;gap:8px">
            <input type="number" min="1" id="new_cit_hrs" placeholder="Interval" style="flex:1;text-align:center;border:0.5px solid var(--sep);border-radius:8px;padding:7px 4px;font-size:13px;background:var(--bg);color:var(--label);-moz-appearance:textfield;appearance:textfield">
            <span style="font-size:12px;color:var(--label3);align-self:center">h</span>
            <button onclick="addCustomIntervalTask()" class="btn btn-s btn-sm" style="white-space:nowrap">+ Add</button>
          </div>
        </div>
      </div>
    </div>
    <div style="display:flex;gap:8px">
      <button class="btn btn-s" style="flex:1" onclick="hideModal()">Cancel</button>
      <button class="btn btn-p" style="flex:2" onclick="saveIntervals()">Save</button>
    </div>`;

  showModal('Service intervals', html);
}

function addMaintCategory(catId) {
  if (!data.maintenance) data.maintenance = {};
  const active = getActiveCategories();
  if (!active.includes(catId)) {
    active.push(catId);
    data.maintenance.activeCategories = active;
    save();
  }
  showIntervalsModal();
}

function deleteMaintCategory(catId) {
  if (!data.maintenance) return;
  const active = getActiveCategories();
  data.maintenance.activeCategories = active.filter(id => id !== catId);
  save();
  showIntervalsModal();
}

function saveIntervals() {
  if (!data.maintenance) data.maintenance = {};
  if (!data.maintenance.intervals) data.maintenance.intervals = {};
  const ints = data.maintenance.intervals;

  MAINT_TASKS.forEach(task => {
    const el  = document.getElementById('int_' + task.id);
    if (!el) return;
    const val = parseInt(el.value);
    if (val > 0) {
      ints[task.id] = task.intDays ? { days: Math.round(val * 30.5) } : { hrs: val };
    } else {
      delete ints[task.id];
    }
  });

  (data.maintenance.customIntervalTasks || []).forEach(cit => {
    const el  = document.getElementById('cit_' + cit.id);
    const val = el ? parseInt(el.value) : NaN;
    cit.replaceHrs = val > 0 ? val : null;
    cit.checkHrs   = null;
  });

  save(); hideModal();
  document.getElementById('mainContent').innerHTML = renderMaintenance();
  showToast('Intervals saved');
}

function addCustomIntervalTask() {
  const name = document.getElementById('new_cit_name')?.value?.trim();
  if (!name) { showToast('Enter a task name', true); return; }
  const hrs = parseInt(document.getElementById('new_cit_hrs')?.value);
  if (!(hrs > 0)) { showToast('Enter an interval in hours', true); return; }
  if (!data.maintenance) data.maintenance = {};
  if (!data.maintenance.customIntervalTasks) data.maintenance.customIntervalTasks = [];
  data.maintenance.customIntervalTasks.push({ id: uid(), name, replaceHrs: hrs, checkHrs: null });
  save();
  showIntervalsModal();
}

function deleteCustomIntervalTask(id) {
  if (!data.maintenance?.customIntervalTasks) return;
  data.maintenance.customIntervalTasks = data.maintenance.customIntervalTasks.filter(t => t.id !== id);
  save();
  showIntervalsModal();
}

function printMaintLog() {
  const log  = getMaintLog();
  const isCat = data.meta.hullType === 'catamaran';
  const tl   = data.transitLog;
  const boatName = tl?.logs?.[tl?.currentLog]?.vesselName || data.meta?.boatName || data.meta?.vesselName || 'Vessel';
  const printDate = new Date().toLocaleDateString('en-GB', {day:'numeric', month:'long', year:'numeric'});
  const engLbl = {port:'Port', starboard:'Stbd'};
  const rows = log.map(e => {
    const engines = isCat ? (e.engines||[]).map(eng => engLbl[eng]||eng).join(', ') : '';
    return `<tr>
      <td>${esc(e.date||'')}</td>
      <td>${esc(String(e.hours||''))}</td>
      <td>${esc(e.task||'')}</td>
      ${isCat ? `<td>${esc(engines)}</td>` : ''}
      <td>${esc(e.notes||'')}</td>
    </tr>`;
  }).join('');
  const engHeader = isCat ? '<th>Engine</th>' : '';
  const html = `<!DOCTYPE html><html><head><meta charset="utf-8">
  <title>${esc(boatName)} — Maintenance Log</title>
  <style>
    body{font-family:Arial,sans-serif;font-size:12px;color:#000;margin:28px}
    h1{font-size:18px;margin:0 0 3px}
    .sub{color:#666;font-size:11px;margin-bottom:18px}
    table{width:100%;border-collapse:collapse}
    th{background:#f2f2f2;text-align:left;padding:6px 8px;border-bottom:2px solid #bbb;font-size:11px;font-weight:700}
    td{padding:5px 8px;border-bottom:1px solid #e4e4e4;vertical-align:top;font-size:12px}
    tr:last-child td{border-bottom:none}
  </style></head><body>
  <h1>${esc(boatName)}</h1>
  <div class="sub">Maintenance Log &nbsp;·&nbsp; Printed ${esc(printDate)} &nbsp;·&nbsp; ${log.length} entries</div>
  <table><thead><tr><th>Date</th><th>Hours</th><th>Task</th>${engHeader}<th>Notes / Location</th></tr></thead>
  <tbody>${rows}</tbody></table>
  </body></html>`;
  const w = window.open('', '_blank');
  if (w) { w.document.write(html); w.document.close(); w.focus(); w.print(); }
}

function maintLogDragStart(e, id) {
  if (e.target.closest('button,input,select')) { e.preventDefault(); return; }
  _maintLogDragId = id;
  e.dataTransfer.effectAllowed = 'move';
  e.dataTransfer.setData('text/plain', id);
  setTimeout(() => document.querySelector(`[data-maint-id="${id}"]`)?.classList.add('prov-dragging'), 0);
}
function maintLogDragOver(e, id) {
  if (!_maintLogDragId || _maintLogDragId === id) return;
  e.preventDefault(); e.dataTransfer.dropEffect = 'move';
  document.querySelectorAll('.prov-drag-over').forEach(el => el.classList.remove('prov-drag-over'));
  e.currentTarget.classList.add('prov-drag-over');
}
function maintLogDragLeave(e) { if (!e.currentTarget.contains(e.relatedTarget)) e.currentTarget.classList.remove('prov-drag-over'); }
function maintLogDrop(e, targetId) {
  e.preventDefault();
  document.querySelectorAll('.prov-drag-over,.prov-dragging').forEach(el => el.classList.remove('prov-drag-over','prov-dragging'));
  const fromId = _maintLogDragId; _maintLogDragId = null;
  _maintLogDoReorder(fromId, targetId);
}
function maintLogDragEnd() {
  document.querySelectorAll('.prov-drag-over,.prov-dragging').forEach(el => el.classList.remove('prov-drag-over','prov-dragging'));
  _maintLogDragId = null;
}
function maintLogTouchStart(e, id) {
  e.preventDefault();
  const touch = e.touches[0], row = e.currentTarget.closest('[data-maint-id]'); if (!row) return;
  const rect = row.getBoundingClientRect(), clone = row.cloneNode(true);
  Object.assign(clone.style, {position:'fixed',left:rect.left+'px',top:rect.top+'px',width:rect.width+'px',opacity:'0.85',zIndex:'9999',pointerEvents:'none',outline:'2px dashed var(--blue)',borderRadius:'4px',background:'var(--surface)',boxShadow:'0 4px 16px rgba(0,0,0,.18)',transition:'none'});
  document.body.appendChild(clone); row.style.opacity = '0.3';
  _maintLogTouchState = {id, row, clone, offsetY: touch.clientY - rect.top, over: null};
  document.addEventListener('touchmove', _maintLogTouchMove, {passive:false});
  document.addEventListener('touchend', _maintLogTouchEnd);
}
function _maintLogTouchMove(e) {
  e.preventDefault(); if (!_maintLogTouchState) return;
  const touch = e.touches[0], {clone, offsetY} = _maintLogTouchState;
  clone.style.top = (touch.clientY - offsetY) + 'px';
  clone.style.display = 'none';
  const under = document.elementFromPoint(touch.clientX, touch.clientY);
  clone.style.display = '';
  const targetRow = under?.closest('[data-maint-id]');
  document.querySelectorAll('.prov-drag-over').forEach(el => el.classList.remove('prov-drag-over'));
  if (targetRow && targetRow !== _maintLogTouchState.row) { targetRow.classList.add('prov-drag-over'); _maintLogTouchState.over = targetRow; }
  else { _maintLogTouchState.over = null; }
}
function _maintLogTouchEnd() {
  document.removeEventListener('touchmove', _maintLogTouchMove); document.removeEventListener('touchend', _maintLogTouchEnd);
  if (!_maintLogTouchState) return;
  const {id, row, clone, over} = _maintLogTouchState; _maintLogTouchState = null;
  clone.remove(); row.style.opacity = '';
  document.querySelectorAll('.prov-drag-over').forEach(el => el.classList.remove('prov-drag-over'));
  if (over) _maintLogDoReorder(id, over.dataset.maintId);
}
function _maintLogDoReorder(fromId, toId) {
  if (!fromId || !toId || fromId === toId) return;
  const log = getMaintLog();
  const fromIdx = log.findIndex(e => e.id === fromId);
  const toIdx   = log.findIndex(e => e.id === toId);
  if (fromIdx === -1 || toIdx === -1) return;
  const [moved] = log.splice(fromIdx, 1);
  log.splice(log.findIndex(e => e.id === toId), 0, moved);
  save();
  document.getElementById('mainContent').innerHTML = renderMaintenance();
}

function setHours(eid, val) {
  const v = Math.max(0, parseInt(val) || 0);
  if (!data.maintenance) data.maintenance = {engines:{}, sched:{}, log:[]};
  if (!data.maintenance.engines) data.maintenance.engines = {};
  if (!data.maintenance.engines[eid]) data.maintenance.engines[eid] = {hours:0};
  data.maintenance.engines[eid].hours = v;
  save();
  document.getElementById('mainContent').innerHTML = renderMaintenance();
}

function showAddMaintEntry() {
  const isCat = data.meta.hullType === 'catamaran';
  const portH = data.maintenance?.engines?.port?.hours || 0;
  const stbdH = data.maintenance?.engines?.starboard?.hours || 0;
  const defH  = isCat ? Math.max(portH, stbdH) : portH;
  const lastTask = getMaintLog()[0]?.task || MAINT_CANONICAL_TASKS[0];
  const defTask = MAINT_CANONICAL_TASKS.includes(lastTask) ? lastTask : MAINT_CANONICAL_TASKS[0];
  showModal('Add Maintenance Entry', `
    <div class="mi-label">Date</div><input class="mi" id="m-ld" type="date" value="${new Date().toISOString().slice(0,10)}">
    <div class="mi-label">Engine Hours</div><input class="mi" id="m-lh" type="number" value="${defH}" placeholder="Engine hours">
    <div class="mi-label">Task Performed</div>
    ${getMaintTaskDropdown(defTask, 'm')}
    ${isCat ? `<div class="mi-label">Engine</div>
    <div style="display:flex;gap:16px;margin-bottom:12px">
      <label style="display:flex;align-items:center;gap:6px;font-size:14px"><input type="checkbox" id="m-ep" checked> Port</label>
      <label style="display:flex;align-items:center;gap:6px;font-size:14px"><input type="checkbox" id="m-es" checked> Stbd</label>
    </div>` : ''}
    <div class="mi-label">Cost (€)</div><input class="mi" id="m-lc" placeholder="Optional">
    <div class="mi-label">Notes / Location</div><input class="mi" id="m-ln" placeholder="Optional">
    <div class="modal-btns">
      <button class="btn btn-s" onclick="hideModal()">Cancel</button>
      <button class="btn btn-p" onclick="saveMaintEntry()">Add</button>
    </div>`);
}

function saveMaintEntry() {
  const isCat = data.meta.hullType === 'catamaran';
  const engines = isCat
    ? ['port','starboard'].filter(e => document.getElementById(e==='port'?'m-ep':'m-es')?.checked)
    : getEngines();
  if (!engines.length) { showToast('Select at least one engine', true); return; }
  if (!data.maintenance) data.maintenance = {engines:{}, sched:{}, log:[]};
  if (!data.maintenance.log) data.maintenance.log = [];
  const entry = {
    id: uid(),
    date:  document.getElementById('m-ld').value,
    hours: document.getElementById('m-lh').value,
    task:  getMaintTaskValue('m'),
    cost:  document.getElementById('m-lc').value || '',
    notes: document.getElementById('m-ln').value || '',
    engines
  };
  data.maintenance.log.unshift(entry);
  const hrs = parseFloat(entry.hours) || 0;
  if (hrs && entry.task) {
    if (!data.maintenance.sched) data.maintenance.sched = {};
    matchMaintTasks(entry.task).forEach(taskId => {
      if (!data.maintenance.sched[taskId]) data.maintenance.sched[taskId] = {};
      engines.forEach(eid => {
        const cur = data.maintenance.sched[taskId][eid] || {};
        if (hrs > (cur.lastDoneAt||0))
          data.maintenance.sched[taskId][eid] = {lastDoneAt:hrs, date:entry.date};
      });
    });
  }
  save(); hideModal(); document.getElementById('mainContent').innerHTML = renderMaintenance();
}

function removeMaintEntry(i) {
  if (!data.maintenance?.log) return;
  data.maintenance.log.splice(i, 1);
  save(); document.getElementById('mainContent').innerHTML = renderMaintenance();
}

function editMaintEntry(i) {
  const e = data.maintenance?.log?.[i]; if (!e) return;
  const isCat = data.meta.hullType === 'catamaran';
  const portChk = (e.engines||[]).includes('port')      ? 'checked' : '';
  const stbdChk = (e.engines||[]).includes('starboard') ? 'checked' : '';
  showModal('Edit Maintenance Entry', `
    <div class="mi-label">Date</div><input class="mi" id="me-ld" type="date" value="${esc(e.date||'')}">
    <div class="mi-label">Engine Hours</div><input class="mi" id="me-lh" type="number" value="${esc(String(e.hours||''))}">
    <div class="mi-label">Task Performed</div>
    ${getMaintTaskDropdown(e.task||'', 'me')}
    ${isCat ? `<div class="mi-label">Engine</div>
    <div style="display:flex;gap:16px;margin-bottom:12px">
      <label style="display:flex;align-items:center;gap:6px;font-size:14px"><input type="checkbox" id="me-ep" ${portChk}> Port</label>
      <label style="display:flex;align-items:center;gap:6px;font-size:14px"><input type="checkbox" id="me-es" ${stbdChk}> Stbd</label>
    </div>` : ''}
    <div class="mi-label">Cost (€)</div><input class="mi" id="me-lc" value="${esc(e.cost||'')}">
    <div class="mi-label">Notes / Location</div><input class="mi" id="me-ln" value="${esc(e.notes||'')}">
    <div class="modal-btns">
      <button onclick="if(confirm('Remove this entry?')){hideModal();removeMaintEntry(${i})}" style="background:#FCEBEB;border:0.5px solid #F09595;color:#A32D2D;border-radius:8px;padding:8px 14px;font-family:var(--font);font-size:14px;font-weight:600;cursor:pointer;margin-right:auto">Delete</button>
      <button class="btn btn-s" onclick="hideModal()">Cancel</button>
      <button class="btn btn-p" onclick="saveEditMaintEntry(${i})">Save</button>
    </div>`);
}

function saveEditMaintEntry(i) {
  const e = data.maintenance?.log?.[i]; if (!e) return;
  const isCat = data.meta.hullType === 'catamaran';
  const engines = isCat
    ? ['port','starboard'].filter(eng => document.getElementById(eng==='port'?'me-ep':'me-es')?.checked)
    : getEngines();
  if (!engines.length) { showToast('Select at least one engine', true); return; }
  e.date    = document.getElementById('me-ld').value;
  e.hours   = document.getElementById('me-lh').value;
  e.task    = getMaintTaskValue('me');
  e.cost    = document.getElementById('me-lc').value || '';
  e.notes   = document.getElementById('me-ln').value || '';
  e.engines = engines;
  save(); hideModal(); document.getElementById('mainContent').innerHTML = renderMaintenance();
}

// ═══════════════════════════════════════════════════════════
//  SECTION 6 — SPARE PARTS
// ═══════════════════════════════════════════════════════════

// ═══════════════════════════════════════════════════════════
//  SCHENGEN TRACKER
// ═══════════════════════════════════════════════════════════

function getSchengenData() {
  if (!data.schengen) {
    data.schengen = { persons: [
      {name:'', passports:[{flag:'🇺🇸', country:'US', eu:false}], activePassport:0, log:[]},
      {name:'', passports:[{flag:'🇺🇸', country:'US', eu:false}], activePassport:0, log:[]}
    ]};
  }
  return data.schengen;
}

function calcSchengenDays(log) {
  const todayMid = new Date(); todayMid.setHours(0,0,0,0);
  const windowStart = new Date(todayMid); windowStart.setDate(windowStart.getDate()-179);
  const sorted = [...(log||[])].sort((a,b)=>a.date.localeCompare(b.date));
  let days = 0, inDate = null, inIsSeaman = false;
  for (const e of sorted) {
    if (e.type==='in') { inDate = parseISODate(e.date); inIsSeaman = e.seamanBook === true; }
    else if (e.type==='out' && inDate) {
      if (!inIsSeaman) { // seaman's book stays don't count toward Schengen days
        const out = parseISODate(e.date);
        if (!out || out > todayMid) { inDate = null; inIsSeaman = false; continue; }
        const s = inDate < windowStart ? windowStart : inDate;
        if (s <= out) days += Math.round((out-s)/86400000)+1;
      }
      inDate = null; inIsSeaman = false;
    }
  }
  if (inDate && !inIsSeaman) {
    const s = inDate < windowStart ? windowStart : inDate;
    if (s <= todayMid) days += Math.round((todayMid-s)/86400000)+1;
  }
  return { days, inSchengen: inDate !== null };
}

function isSeamanBookActive(log) {
  const sorted = [...(log||[])].sort((a,b)=>a.date.localeCompare(b.date));
  for (let i = sorted.length-1; i >= 0; i--) {
    if (sorted[i].type === 'in') return sorted[i].seamanBook === true;
  }
  return false;
}

function isCurrentlyInSchengen(log) {
  const todayMid = new Date(); todayMid.setHours(0,0,0,0);
  const sorted = [...(log||[])].sort((a,b)=>a.date.localeCompare(b.date));
  let inside = false;
  for (const e of sorted) {
    if (e.type==='in') { inside = true; }
    else if (e.type==='out') {
      const out = parseISODate(e.date);
      if (out && out <= todayMid) inside = false; // ignore future checkouts
    }
  }
  return inside;
}

function schengenRerender() { document.getElementById('mainContent').innerHTML = renderSchengen(); }

function schengenDedup(sd) {
  const seen = new Set();
  sd.persons = sd.persons.filter(p => {
    const k = (p.name||'').trim().toLowerCase();
    if (!k) return true;
    if (seen.has(k)) return false;
    seen.add(k); return true;
  });
}
function renderSchengen() {
  const sd = getSchengenData();
  schengenDedup(sd);
  const hasData = sd.persons.some(p=>p.name);
  const isOwner = localStorage.getItem(EMAIL_KEY) === OWNER_EMAIL;
  const exampleBanner = (!isOwner && hasData) ? `
    <div style="margin:0 12px 8px;padding:8px 12px;background:var(--surface2);border-radius:10px;font-size:12px;color:var(--label3);font-style:italic">
      These are example travellers — tap ⚙ Edit travellers to set up your own
    </div>` : '';
  const warnings = [];
  sd.persons.forEach(p => {
    if (!p.name) return;
    const eu = p.passports?.[p.activePassport||0]?.eu;
    if (eu) return;
    const {days} = calcSchengenDays(p.log);
    const rem = 90-days;
    if (rem < 0) warnings.push(`⚠ ${p.name}: OVERSTAYED by ${Math.abs(rem)} days`);
    else if (rem < 20) warnings.push(`${p.name}: ${rem} days remaining`);
  });
  const warningBanner = warnings.length ? `
    <div style="margin:0 12px 10px;padding:10px 14px;background:rgba(255,59,48,.1);border:0.5px solid var(--red);border-radius:10px;font-size:13px;color:var(--red);font-weight:600">
      ⚠️ ${warnings.join(' · ')}
    </div>` : '';
  const emptyMsg = !hasData ? `
    <div style="margin:20px 12px;padding:16px;background:var(--surface);border:0.5px solid var(--sep);border-radius:12px;text-align:center;color:var(--label3);font-size:14px">
      Tap ⚙ Edit travellers to set up
    </div>` : '';
  const statusCard = hasData ? `
    <div style="margin:0 12px 10px;background:var(--surface);border:0.5px solid var(--sep);border-radius:14px;overflow:hidden">
      <div style="display:grid;grid-template-columns:1fr 1fr;min-width:0;width:100%">
        ${sd.persons.map((p,i)=>renderSchengenPersonStatus(p,i)).join('')}
      </div>
    </div>` : '';
  const logCard = hasData ? renderSchengenLog(sd) : '';
  return `<div style="background:#f2f2f7;min-height:100%;padding-bottom:80px">
    <div style="display:flex;align-items:center;justify-content:space-between;padding:12px 12px 8px">
      <div style="font-size:17px;font-weight:700">🛂 Schengen</div>
      <button onclick="showSchengenEdit()" style="background:var(--surface);border:0.5px solid var(--sep);border-radius:8px;padding:6px 14px;font-size:13px;font-weight:600;font-family:var(--font);color:var(--label);cursor:pointer">⚙ Edit travellers</button>
    </div>
    ${warningBanner}${exampleBanner}${emptyMsg}${statusCard}${logCard}
  </div>`;
}

function renderSchengenPersonStatus(p, idx) {
  const activePassIdx = p.activePassport || 0;
  const activePass = p.passports?.[activePassIdx];
  const isEU = activePass?.eu === true;
  const {days} = calcSchengenDays(p.log);
  const remaining = 90 - days;
  const overstayed = remaining < 0;
  const inStatus = isCurrentlyInSchengen(p.log);
  const seamanActive = isSeamanBookActive(p.log);
  const circleColor = remaining > 30 ? 'var(--green)' : remaining > 10 ? 'var(--orange)' : 'var(--red)';
  const exitBy = new Date(); exitBy.setDate(exitBy.getDate() + Math.max(0, remaining));
  const exitByStr = overstayed
    ? `⚠ Overstayed by ${Math.abs(remaining)} day${Math.abs(remaining)===1?'':'s'}`
    : exitBy.toLocaleDateString('en-GB', {day:'numeric', month:'short', year:'numeric'});
  const exitByColor = overstayed || remaining < 30 ? 'var(--red)' : 'var(--green)';
  const lastLogEntry = [...(p.log||[])].sort((a,b)=>a.date.localeCompare(b.date)).pop();
  const borderRight = idx === 0 ? 'border-right:1px solid var(--sep);' : '';
  const passportBtns = (p.passports||[]).map((pp, pi) => {
    const CC = {'European Union':'EU','United States':'US','Japan':'JP','United Kingdom':'UK','Australia':'AU','New Zealand':'NZ','Canada':'CA'};
    const label = [pp.flag, pp.country ? (CC[pp.country] || pp.country.slice(0,2).toUpperCase()) : ''].filter(Boolean).join(' ') || '?';
    const active = pi === activePassIdx;
    return `<button onclick="setSchengenPassport(${idx},${pi})" style="background:${active?'var(--blue)':'var(--surface2)'};color:${active?'#fff':'var(--label)'};border:0.5px solid ${active?'var(--blue)':'var(--sep)'};border-radius:8px;padding:3px 6px;font-size:11px;cursor:pointer;line-height:1.4;font-family:var(--font);white-space:nowrap">${label}</button>`;
  }).join('');
  const statusBadge = seamanActive
    ? `<span style="background:#F59E0B;color:#fff;font-size:10px;font-weight:700;padding:2px 7px;border-radius:10px">Seaman's Book — Greece</span>`
    : `<span style="background:${inStatus?'var(--green)':'var(--sep)'};color:${inStatus?'#fff':'var(--label2)'};font-size:10px;font-weight:700;padding:2px 7px;border-radius:10px">${inStatus?'In Schengen':'Outside'}</span>`;
  const seamanWarning = seamanActive ? `<div style="margin:6px 0 8px;padding:8px 10px;background:rgba(245,158,11,.12);border:1px solid #F59E0B;border-radius:8px">
    <div style="font-size:11px;font-weight:700;color:#D97706;margin-bottom:2px">Register passport entry before flying</div>
    <div style="font-size:11px;color:#D97706">You entered Greece on a Seaman's Book. Visit immigration to add a passport entry stamp before departing by air.</div>
  </div>` : '';
  const CL = 101;
  const gPct    = Math.min(1, Math.max(0, Math.max(0, remaining) / 90));
  const gOffset = Math.round(CL * (1 - gPct));
  const gNum    = String(Math.max(0, remaining));
  const gFs     = gNum.length > 3 ? '11' : '14';
  const gColor  = remaining > 30 ? '#22C55E' : remaining > 10 ? '#F59E0B' : '#EF4444';
  return `<div style="padding:14px 10px;min-width:0;overflow:hidden;${borderRight}">
    <div style="font-size:13px;font-weight:700;margin-bottom:6px">${esc(p.name||'—')}</div>
    <div style="margin-bottom:${seamanActive?'0':'8px'}">${statusBadge}</div>
    ${seamanWarning}
    ${isEU ? `<div style="font-size:11px;color:var(--green);font-weight:600;margin-bottom:10px">🇪🇺 EU Passport · No limit</div>` : `
      <svg viewBox="0 0 80 44" style="width:100%;display:block">
        <path d="M8,40 A32,32 0 0,1 72,40" fill="none" stroke="#e5e7eb" stroke-width="10" stroke-linecap="round"/>
        <path d="M8,40 A32,32 0 0,1 72,40" fill="none" stroke="${gColor}" stroke-width="10" stroke-linecap="round" stroke-dasharray="${CL}" stroke-dashoffset="${gOffset}"/>
        <text x="40" y="28" text-anchor="middle" font-size="${gFs}" font-weight="800" fill="${gColor}" font-family="var(--font)">${gNum}</text>
        <text x="40" y="38" text-anchor="middle" font-size="7" fill="#9ca3af" font-family="var(--font)">days</text>
      </svg>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:4px;margin-bottom:6px">
        <div style="background:var(--surface2);border-radius:8px;padding:5px;text-align:center">
          <div style="font-size:14px;font-weight:700">${days}</div>
          <div style="font-size:9px;color:var(--label3)">Used</div>
        </div>
        <div style="background:var(--surface2);border-radius:8px;padding:5px;text-align:center">
          <div style="font-size:14px;font-weight:700;color:${circleColor}">${overstayed?'-':''}${Math.abs(remaining)}</div>
          <div style="font-size:9px;color:var(--label3)">${overstayed?'Over':'Left'}</div>
        </div>
      </div>
      ${overstayed
        ? `<div style="font-size:10px;color:var(--red);margin-bottom:8px;text-align:center;font-weight:600">${exitByStr}</div>`
        : (inStatus && lastLogEntry?.type === 'in')
          ? `<div style="font-size:10px;color:var(--label3);margin-bottom:8px;text-align:center">Exit by <span style="color:${exitByColor};font-weight:600">${exitByStr}</span></div>`
          : `<div style="font-size:10px;color:var(--label3);margin-bottom:8px;text-align:center">Next entry: up to <span style="color:var(--green);font-weight:600">${remaining}</span> days</div>`
      }`}
    <div style="display:flex;gap:4px;margin-bottom:8px;flex-wrap:wrap">${passportBtns}</div>
    <div style="display:flex;gap:5px">
      <button onclick="showSchengenCheckIn(${idx})" style="flex:1;background:var(--green);color:#fff;border:none;border-radius:8px;padding:7px 2px;font-size:11px;font-weight:600;font-family:var(--font);cursor:pointer">Check In</button>
      <button onclick="showSchengenCheckOut(${idx})" style="flex:1;background:var(--surface2);color:var(--label);border:0.5px solid var(--sep);border-radius:8px;padding:7px 2px;font-size:11px;font-weight:600;font-family:var(--font);cursor:pointer">Check Out</button>
    </div>
  </div>`;
}

function renderSchengenPersonLog(p, idx) {
  const sorted = [...(p?.log||[])].sort((a,b)=>b.date.localeCompare(a.date));
  const borderRight = idx === 0 ? 'border-right:1px solid var(--sep);' : '';
  // Build trip-duration map: check-in id → days count or 'ongoing'
  const todayMs = new Date().setHours(23,59,59,999);
  const chrono = [...(p?.log||[])].sort((a,b)=>a.date.localeCompare(b.date));
  const tripDays = {};
  let lastIn = null;
  for (const e of chrono) {
    if (e.type==='in') { lastIn = e; }
    else if (e.type==='out' && lastIn) {
      const outD = parseISODate(e.date);
      if (outD && outD.getTime() <= todayMs) {
        const inD = parseISODate(lastIn.date);
        if (inD) tripDays[lastIn.id] = Math.round((outD-inD)/86400000)+1;
        lastIn = null;
      }
    }
  }
  if (lastIn) tripDays[lastIn.id] = 'ongoing';
  const rows = sorted.map(e => {
    const typeColor = e.type==='in' ? 'var(--green)' : 'var(--label2)';
    const typeLabel = e.type==='in' ? '↓ In' : '↑ Out';
    const flag = e.passport ? `${e.passport} ` : '';
    const d = parseISODate(e.date); const dateStr = d ? String(d.getDate()).padStart(2,'0')+'/'+String(d.getMonth()+1).padStart(2,'0')+'/'+String(d.getFullYear()).slice(-2) : esc(e.date);
    const loc = e.location ? ` · ${esc(e.location)}` : '';
    const note = e.notes ? ` · <span style="color:var(--label3)">${esc(e.notes)}</span>` : '';
    const dur = e.type==='in' && tripDays[e.id] !== undefined
      ? ` · <span style="color:var(--label3)">${tripDays[e.id]==='ongoing'?'ongoing':tripDays[e.id]+' days'}</span>` : '';
    const entryBadge = e.type==='in'
      ? (e.seamanBook
        ? `<span style="background:#F59E0B;color:#fff;font-size:9px;font-weight:700;padding:1px 5px;border-radius:5px;flex-shrink:0">Seaman's Book</span>`
        : `<span style="background:var(--green);color:#fff;font-size:9px;font-weight:700;padding:1px 5px;border-radius:5px;flex-shrink:0">Passport</span>`)
      : '';
    return `<div style="display:flex;align-items:center;gap:4px;padding:7px 10px;border-bottom:1px solid var(--sep);overflow:hidden">
      <span style="font-size:11px;font-weight:600;color:${typeColor};flex-shrink:0;white-space:nowrap">${typeLabel} ${flag}</span>
      ${entryBadge}
      <span style="font-size:11px;color:var(--label3);flex-shrink:0;white-space:nowrap">${dateStr}</span>
      <span style="font-size:11px;flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--label2)">${loc}${note}${dur}</span>
      <button onclick="showSchengenEditEntry(${idx},'${e.id}')" style="background:none;border:none;padding:2px 4px;cursor:pointer;font-size:14px;color:var(--label3);line-height:1;flex-shrink:0">✏️</button>
    </div>`;
  }).join('') || `<div style="padding:14px 10px;text-align:center;color:var(--label3);font-size:12px">No entries</div>`;
  return `<div style="min-width:0;overflow:hidden;${borderRight}">
    <div style="padding:10px 10px 6px;font-size:12px;font-weight:700;color:var(--label);border-bottom:1px solid var(--sep)">${esc(p.name||'Person '+(idx+1))}</div>
    ${rows}
    <div style="padding:8px 10px">
      <button onclick="showSchengenAddEntry(${idx})" style="font-size:11px;color:var(--blue);background:none;border:none;cursor:pointer;font-family:var(--font);padding:0">+ Add entry</button>
    </div>
  </div>`;
}

function renderSchengenLog(sd) {
  const cols = sd.persons.map((p,i) => renderSchengenPersonLog(p,i)).join('');
  return `<div style="margin:0 12px 16px;background:var(--surface);border:0.5px solid var(--sep);border-radius:14px;overflow:hidden">
    <div style="display:grid;grid-template-columns:1fr 1fr;min-width:0;width:100%">${cols}</div>
  </div>`;
}

function setSchengenPassport(personIdx, passportIdx) {
  const sd = getSchengenData();
  if (!sd.persons[personIdx]) return;
  sd.persons[personIdx].activePassport = passportIdx;
  save(); schengenRerender();
}

function showSchengenAddEntry(personIdx) {
  const sd = getSchengenData();
  const p = sd.persons[personIdx];
  const today = new Date().toISOString().slice(0,10);
  const passOpts = (p.passports||[]).map((pp,i)=>`<option value="${i}">${[pp.flag,pp.country].filter(Boolean).join(' ')||'Passport '+(i+1)}</option>`).join('');
  const activeStyle = 'flex:1;padding:10px;font-size:13px;font-weight:600;font-family:var(--font);cursor:pointer;border-radius:10px;border:none;';
  const inActive   = activeStyle+'background:var(--green);color:#fff';
  const outActive  = activeStyle+'background:var(--blue);color:#fff';
  const inInactive = activeStyle+'background:var(--surface2);color:var(--label);border:0.5px solid var(--sep)';
  showModal(`Add Entry — ${esc(p.name||'Person '+(personIdx+1))}`, `
    <input type="hidden" id="sch-etype" value="in">
    <div style="display:flex;gap:8px;margin-bottom:14px">
      <button type="button" id="sch-btn-in"  style="${inActive}"   onclick="document.getElementById('sch-etype').value='in';document.getElementById('sch-in-fields').style.display='';document.getElementById('sch-out-fields').style.display='none';document.getElementById('sch-btn-in').style.cssText='${inActive}';document.getElementById('sch-btn-out').style.cssText='${inInactive}'">↓ Check In</button>
      <button type="button" id="sch-btn-out" style="${inInactive}" onclick="document.getElementById('sch-etype').value='out';document.getElementById('sch-out-fields').style.display='';document.getElementById('sch-in-fields').style.display='none';document.getElementById('sch-btn-out').style.cssText='${outActive}';document.getElementById('sch-btn-in').style.cssText='${inInactive}'">↑ Check Out</button>
    </div>
    <div class="mi-label">Date</div><input class="mi" id="sch-date" type="date" value="${today}">
    <div id="sch-in-fields">
      <div class="mi-label">Passport</div><select class="mi" id="sch-pass">${passOpts}</select>
      <div class="mi-label">Location / Country</div><input class="mi" id="sch-loc" placeholder="e.g. Greece (Athens)">
    </div>
    <div id="sch-out-fields" style="display:none">
      <div class="mi-label">Destination</div><input class="mi" id="sch-dest" placeholder="e.g. Turkey (Istanbul)">
      <div class="mi-label">Notes</div><input class="mi" id="sch-notes" placeholder="Optional">
    </div>
    <div class="modal-btns">
      <button class="btn btn-s" onclick="hideModal()">Cancel</button>
      <button class="btn btn-p" onclick="saveSchengenAddEntry(${personIdx})">Save</button>
    </div>`);
}

function saveSchengenAddEntry(personIdx) {
  const sd = getSchengenData();
  const p = sd.persons[personIdx]; if (!p) return;
  const date = document.getElementById('sch-date')?.value;
  if (!date) { showToast('Enter a date', true); return; }
  const type = document.getElementById('sch-etype')?.value || 'in';
  const today = new Date().toISOString().slice(0,10);
  if (type === 'out' && date > today) { showToast('Check out date cannot be in the future', true); return; }
  if (type === 'in') {
    const passIdx = parseInt(document.getElementById('sch-pass')?.value)||0;
    const passport = p.passports?.[passIdx]?.flag||'';
    const location = document.getElementById('sch-loc')?.value.trim()||'';
    p.log.push({id:uid(), type:'in', date, passport, location});
    p.activePassport = passIdx;
  } else {
    const location = document.getElementById('sch-dest')?.value.trim()||'';
    const notes = document.getElementById('sch-notes')?.value.trim()||'';
    p.log.push({id:uid(), type:'out', date, location, notes});
  }
  save(); hideModal(); schengenRerender();
}

function schSeamanToggle(checked) {
  document.getElementById('sch-seaman-warn').style.display = checked ? 'block' : 'none';
}
function showSchengenCheckIn(personIdx) {
  const sd = getSchengenData();
  const p = sd.persons[personIdx];
  const activeIdx = p.activePassport || 0;
  const passOpts = (p.passports||[]).map((pp,i)=>`<option value="${i}" ${i===activeIdx?'selected':''}>${[pp.flag, pp.country].filter(Boolean).join(' ') || 'Passport '+(i+1)}</option>`).join('');
  showModal(`Check In — ${esc(p.name||'Person '+(personIdx+1))}`, `
    <div class="mi-label">Date</div><input class="mi" id="sch-date" type="date" value="${new Date().toISOString().slice(0,10)}" autofocus>
    <div class="mi-label">Passport</div><select class="mi" id="sch-pass">${passOpts}</select>
    <div style="margin:10px 0;padding:10px 12px;background:var(--surface2);border-radius:10px">
      <label style="display:flex;align-items:center;gap:10px;cursor:pointer">
        <input type="checkbox" id="sch-seaman" onchange="schSeamanToggle(this.checked)" style="width:18px;height:18px;accent-color:#F59E0B;flex-shrink:0">
        <div>
          <div style="font-size:13px;font-weight:600;color:var(--label)">Entered on Seaman's Book</div>
          <div style="font-size:11px;color:var(--label3);margin-top:1px">Greece only · does not count Schengen days</div>
        </div>
      </label>
      <div id="sch-seaman-warn" style="display:none;margin-top:8px;padding:8px 10px;background:rgba(245,158,11,.12);border:1px solid #F59E0B;border-radius:8px;font-size:12px;color:#D97706;font-weight:500">⚠ Before flying out of Greece, visit immigration to register a passport entry stamp.</div>
    </div>
    <div class="mi-label">Location / Country</div><input class="mi" id="sch-loc" placeholder="e.g. Greece (Athens)">
    <div class="modal-btns">
      <button class="btn btn-s" onclick="hideModal()">Cancel</button>
      <button class="btn btn-p" onclick="saveSchengenCheckIn(${personIdx})">Check In</button>
    </div>`);
}

function saveSchengenCheckIn(personIdx) {
  const sd = getSchengenData();
  const p = sd.persons[personIdx]; if (!p) return;
  const date = document.getElementById('sch-date')?.value;
  if (!date) { showToast('Enter a date', true); return; }
  const passIdx = parseInt(document.getElementById('sch-pass')?.value)||0;
  const passport = p.passports?.[passIdx]?.flag||'';
  const location = document.getElementById('sch-loc')?.value.trim()||'';
  const seamanBook = document.getElementById('sch-seaman')?.checked || false;
  const entry = {id:uid(), type:'in', date, passport, location};
  if (seamanBook) entry.seamanBook = true;
  p.log.push(entry);
  p.activePassport = passIdx;
  save(); hideModal(); schengenRerender();
}

function showSchengenCheckOut(personIdx) {
  const sd = getSchengenData();
  const p = sd.persons[personIdx];
  const activeIdx = p?.activePassport || 0;
  const passOpts = (p?.passports||[]).map((pp,i)=>`<option value="${i}" ${i===activeIdx?'selected':''}>${[pp.flag, pp.country].filter(Boolean).join(' ') || 'Passport '+(i+1)}</option>`).join('');
  showModal(`Check Out — ${esc(p?.name||'Person '+(personIdx+1))}`, `
    <div class="mi-label">Date</div><input class="mi" id="sch-date" type="date" value="${new Date().toISOString().slice(0,10)}" autofocus>
    <div class="mi-label">Passport</div><select class="mi" id="sch-pass">${passOpts}</select>
    <div class="mi-label">Destination</div><input class="mi" id="sch-loc" placeholder="e.g. Turkey (Istanbul)">
    <div class="mi-label">Notes (optional)</div><input class="mi" id="sch-notes" placeholder="e.g. Overland to Tbilisi">
    <div class="modal-btns">
      <button class="btn btn-s" onclick="hideModal()">Cancel</button>
      <button class="btn btn-p" onclick="saveSchengenCheckOut(${personIdx})">Check Out</button>
    </div>`);
}

function saveSchengenCheckOut(personIdx) {
  const sd = getSchengenData();
  const p = sd.persons[personIdx]; if (!p) return;
  const date = document.getElementById('sch-date')?.value;
  if (!date) { showToast('Enter a date', true); return; }
  if (date > new Date().toISOString().slice(0,10)) { showToast('Check out date cannot be in the future', true); return; }
  const passIdx = parseInt(document.getElementById('sch-pass')?.value)||0;
  const passport = p.passports?.[passIdx]?.flag||'';
  const location = document.getElementById('sch-loc')?.value.trim()||'';
  const notes = document.getElementById('sch-notes')?.value.trim()||'';
  p.log.push({id:uid(), type:'out', date, passport, location, notes});
  save(); hideModal(); schengenRerender();
}

function showSchengenEditEntry(personIdx, entryId) {
  const sd = getSchengenData();
  const p = sd.persons[personIdx]; if (!p) return;
  const e = p.log.find(x=>x.id===entryId); if (!e) return;
  const passOpts = e.type==='in' ? (p.passports||[]).map((pp,i)=>`<option value="${i}" ${pp.flag===e.passport?'selected':''}>${pp.flag} ${esc(pp.country)}</option>`).join('') : '';
  showModal('Edit Entry', `
    <div class="mi-label">Date</div><input class="mi" id="sch-date" type="date" value="${esc(e.date)}">
    ${e.type==='in'?`<div class="mi-label">Passport</div><select class="mi" id="sch-pass">${passOpts}</select>`:''}
    <div class="mi-label">${e.type==='in'?'Location':'Destination'}</div><input class="mi" id="sch-loc" value="${esc(e.location||'')}">
    <div class="modal-btns">
      <button onclick="if(confirm('Delete this entry?')){hideModal();deleteSchengenEntry(${personIdx},'${entryId}')}" style="background:#FCEBEB;border:0.5px solid #F09595;color:#A32D2D;border-radius:8px;padding:8px 14px;font-family:var(--font);font-size:14px;font-weight:600;cursor:pointer;margin-right:auto">Delete</button>
      <button class="btn btn-s" onclick="hideModal()">Cancel</button>
      <button class="btn btn-p" onclick="saveSchengenEditEntry(${personIdx},'${entryId}')">Save</button>
    </div>`);
}

function saveSchengenEditEntry(personIdx, entryId) {
  const sd = getSchengenData();
  const p = sd.persons[personIdx]; if (!p) return;
  const e = p.log.find(x=>x.id===entryId); if (!e) return;
  e.date = document.getElementById('sch-date')?.value||e.date;
  if (e.type==='in') { const pi = parseInt(document.getElementById('sch-pass')?.value)||0; e.passport = p.passports?.[pi]?.flag||e.passport; }
  e.location = document.getElementById('sch-loc')?.value.trim()||'';
  save(); hideModal(); schengenRerender();
}

function deleteSchengenEntry(personIdx, entryId) {
  const sd = getSchengenData();
  const p = sd.persons[personIdx]; if (!p) return;
  p.log = p.log.filter(x=>x.id!==entryId);
  save(); schengenRerender();
}

const SCHENGEN_PASSPORT_OPTS = [
  {key:'eu', flag:'🇪🇺', country:'European Union', eu:true},
  {key:'us', flag:'🇺🇸', country:'United States',  eu:false},
  {key:'jp', flag:'🇯🇵', country:'Japan',          eu:false},
  {key:'gb', flag:'🇬🇧', country:'United Kingdom', eu:false},
  {key:'au', flag:'🇦🇺', country:'Australia',      eu:false},
  {key:'nz', flag:'🇳🇿', country:'New Zealand',    eu:false},
  {key:'ca', flag:'🇨🇦', country:'Canada',         eu:false},
  {key:'other', flag:'', country:'Other (type manually)', eu:false},
];
const SCHENGEN_FLAG_TO_KEY = {'🇪🇺':'eu','🇺🇸':'us','🇯🇵':'jp','🇬🇧':'gb','🇦🇺':'au','🇳🇿':'nz','🇨🇦':'ca'};
const SCHENGEN_PASSPORT_MAP = {
  eu:  {flag:'🇪🇺', country:'European Union', eu:true},
  us:  {flag:'🇺🇸', country:'United States',  eu:false},
  jp:  {flag:'🇯🇵', country:'Japan',          eu:false},
  gb:  {flag:'🇬🇧', country:'United Kingdom', eu:false},
  au:  {flag:'🇦🇺', country:'Australia',      eu:false},
  nz:  {flag:'🇳🇿', country:'New Zealand',    eu:false},
  ca:  {flag:'🇨🇦', country:'Canada',         eu:false},
};

function schengenPassSelChange(i, pi) {
  const sel = document.getElementById(`sch-psel-${i}-${pi}`);
  const otherDiv = document.getElementById(`sch-pother-${i}-${pi}`);
  if (otherDiv) otherDiv.style.display = sel?.value === 'other' ? 'flex' : 'none';
}

let _schPi = [0, 0];
let _pendingBackup = null;

function schPassportRow(i, pi, pp) {
  const selKey = SCHENGEN_FLAG_TO_KEY[pp.flag] || 'other';
  const isOther = selKey === 'other';
  const opts = SCHENGEN_PASSPORT_OPTS.map(o =>
    `<option value="${o.key}" ${o.key===selKey?'selected':''}>${o.flag?o.flag+' ':''}${o.country}</option>`
  ).join('');
  return `<div id="sch-prow-${i}-${pi}" style="display:flex;align-items:center;gap:8px;margin-bottom:8px">
      <select id="sch-psel-${i}-${pi}" class="fi" style="flex:1;font-size:13px;border-radius:20px;padding:6px 10px;background:var(--surface2)" onchange="schengenPassSelChange(${i},${pi})">${opts}</select>
      <button onclick="schRemovePassport(${i},${pi})" style="background:none;border:none;color:var(--red);cursor:pointer;font-size:15px;padding:0 4px;flex-shrink:0;font-family:var(--font)">✕</button>
    </div>
    <div id="sch-pother-${i}-${pi}" style="display:${isOther?'flex':'none'};align-items:center;gap:8px;margin-bottom:6px;padding-left:8px">
      <input class="fi" id="sch-potherval-${i}-${pi}" style="flex:1;font-size:13px" placeholder="Country name" value="${isOther?esc(pp.country||''):''}">
      <label style="display:flex;align-items:center;gap:4px;font-size:12px;color:var(--label3);white-space:nowrap;cursor:pointer">
        <input type="checkbox" id="sch-peu-${i}-${pi}" ${pp.eu===true&&isOther?'checked':''}> EU
      </label>
    </div>`;
}

function schEditName(i) {
  document.getElementById(`sch-namerow-${i}`).style.display = 'none';
  const ed = document.getElementById(`sch-nameedit-${i}`);
  ed.style.display = 'flex';
  setTimeout(() => document.getElementById(`sch-nameinput-${i}`)?.focus(), 30);
}

function schConfirmName(i) {
  const val = (document.getElementById(`sch-nameinput-${i}`)?.value || '').trim();
  document.getElementById(`sch-namedisplay-${i}`).textContent = val || `Person ${i+1}`;
  document.getElementById(`sch-nameedit-${i}`).style.display = 'none';
  document.getElementById(`sch-namerow-${i}`).style.display = 'flex';
}

function schAddPassport(personIdx) {
  const container = document.getElementById(`sch-passports-${personIdx}`);
  if (!container) return;
  const pi = _schPi[personIdx]++;
  const temp = document.createElement('div');
  temp.innerHTML = schPassportRow(personIdx, pi, {flag:'🇺🇸', country:'United States', eu:false}).trim();
  while (temp.firstChild) container.appendChild(temp.firstChild);
}

function schAddTraveller() {
  const container = document.getElementById('sch-persons-container');
  if (!container) return;
  const i = _schPi.length;
  _schPi.push(0);
  const div = document.createElement('div');
  div.style.cssText = 'background:var(--surface);border:0.5px solid var(--sep);border-radius:14px;padding:16px;margin-bottom:12px;overflow:hidden';
  div.innerHTML = `
    <div id="sch-namerow-${i}" style="display:none;align-items:center;gap:8px;margin-bottom:12px">
      <span id="sch-namedisplay-${i}" style="font-size:16px;font-weight:700;flex:1;color:var(--label)">Person ${i+1}</span>
      <button onclick="schEditName(${i})" style="background:none;border:none;cursor:pointer;font-size:15px;color:var(--label3);padding:2px 4px;font-family:var(--font)">✏️</button>
    </div>
    <div id="sch-nameedit-${i}" style="display:flex;align-items:center;gap:8px;margin-bottom:12px">
      <input id="sch-nameinput-${i}" class="fi" style="flex:1;font-size:15px;font-weight:600" value="" placeholder="Person name">
      <button onclick="schConfirmName(${i})" style="background:none;border:none;cursor:pointer;font-size:18px;color:var(--green);padding:2px 4px;font-family:var(--font);font-weight:700">✓</button>
    </div>
    <div style="font-size:12px;color:var(--label3);margin-bottom:8px">Passports <span style="font-style:italic">(tap to change)</span></div>
    <div id="sch-passports-${i}"></div>
    <button onclick="schAddPassport(${i})" style="font-size:13px;color:var(--blue);background:none;border:none;cursor:pointer;padding:4px 0;font-family:var(--font)">+ Add passport</button>`;
  container.appendChild(div);
  setTimeout(() => document.getElementById(`sch-nameinput-${i}`)?.focus(), 30);
}

function schRemovePassport(i, pi) {
  const row = document.getElementById(`sch-prow-${i}-${pi}`);
  const other = document.getElementById(`sch-pother-${i}-${pi}`);
  if (row)   { row.style.display = 'none';   row.dataset.deleted = '1'; }
  if (other)   other.style.display = 'none';
}

function deleteSchengenPerson(i) {
  const sd = getSchengenData();
  const name = sd.persons[i]?.name || 'this person';
  if (!confirm(`Delete ${name} and all their travel history? This cannot be undone.`)) return;
  const key = name.trim().toLowerCase();
  sd.persons = sd.persons.filter(p => (p.name||'').trim().toLowerCase() !== key);
  save(); hideModal(); showSchengenEdit(); schengenRerender();
}
function showSchengenEdit() {
  const sd = getSchengenData();
  schengenDedup(sd);
  _schPi = sd.persons.map(p => (p.passports||[]).length);
  const personsHtml = sd.persons.map((p,i) => {
    const passHtml = (p.passports||[]).map((pp,pi) => schPassportRow(i,pi,pp)).join('');
    return `
      <div style="background:var(--surface);border:0.5px solid var(--sep);border-radius:14px;padding:16px;margin-bottom:12px;overflow:hidden">
        <div id="sch-namerow-${i}" style="display:flex;align-items:center;gap:8px;margin-bottom:12px">
          <span id="sch-namedisplay-${i}" style="font-size:16px;font-weight:700;flex:1;color:var(--label)">${esc(p.name||'Person '+(i+1))}</span>
          <button onclick="schEditName(${i})" style="background:none;border:none;cursor:pointer;font-size:15px;color:var(--label3);padding:2px 4px;font-family:var(--font)">✏️</button>
          <button onclick="deleteSchengenPerson(${i})" style="background:none;border:none;cursor:pointer;font-size:13px;color:var(--red);padding:2px 6px;font-family:var(--font);border:1px solid var(--red);border-radius:8px;line-height:1.4">Delete</button>
        </div>
        <div id="sch-nameedit-${i}" style="display:none;align-items:center;gap:8px;margin-bottom:12px">
          <input id="sch-nameinput-${i}" class="fi" style="flex:1;font-size:15px;font-weight:600" value="${esc(p.name||'')}" placeholder="Person name">
          <button onclick="schConfirmName(${i})" style="background:none;border:none;cursor:pointer;font-size:18px;color:var(--green);padding:2px 4px;font-family:var(--font);font-weight:700">✓</button>
        </div>
        <div style="font-size:12px;color:var(--label3);margin-bottom:8px">Passports <span style="font-style:italic">(tap to change)</span></div>
        <div id="sch-passports-${i}">${passHtml}</div>
        <button onclick="schAddPassport(${i})" style="font-size:13px;color:var(--blue);background:none;border:none;cursor:pointer;padding:4px 0;font-family:var(--font)">+ Add passport</button>
      </div>`;
  }).join('');
  showModal('Edit Travellers', `
    <div id="sch-persons-container">${personsHtml}</div>
    <button onclick="schAddTraveller()" style="font-size:14px;color:var(--blue);background:none;border:none;cursor:pointer;padding:8px 0 4px;font-family:var(--font);display:block;width:100%;text-align:left">+ Add traveller</button>
    <div class="modal-btns" style="margin-top:4px">
      <button class="btn btn-s" onclick="hideModal()">Cancel</button>
      <button class="btn btn-p" onclick="saveSchengenEdit()">Save</button>
    </div>`);
}

function saveSchengenEdit() {
  const sd = getSchengenData();
  sd.persons.forEach((p,i) => {
    const nameInput   = document.getElementById(`sch-nameinput-${i}`);
    const nameDisplay = document.getElementById(`sch-namedisplay-${i}`);
    p.name = (nameInput?.value || nameDisplay?.textContent || '').trim();
    const newPassports = [];
    const total = _schPi[i];
    for (let pi = 0; pi < total; pi++) {
      const row = document.getElementById(`sch-prow-${i}-${pi}`);
      if (!row || row.dataset.deleted === '1') continue;
      const sel = document.getElementById(`sch-psel-${i}-${pi}`)?.value || 'other';
      let pp;
      if (sel === 'other') {
        pp = {flag:'', country:document.getElementById(`sch-potherval-${i}-${pi}`)?.value.trim()||'', eu:document.getElementById(`sch-peu-${i}-${pi}`)?.checked||false};
      } else {
        pp = {...(SCHENGEN_PASSPORT_MAP[sel]||{flag:'', country:'', eu:false})};
      }
      newPassports.push(pp);
    }
    p.passports = newPassports;
    if ((p.activePassport||0) >= p.passports.length) p.activePassport = 0;
  });
  for (let i = sd.persons.length; i < _schPi.length; i++) {
    const nameInput = document.getElementById(`sch-nameinput-${i}`);
    const name = (nameInput?.value || '').trim();
    if (!name) continue;
    const newPassports = [];
    const total = _schPi[i];
    for (let pi = 0; pi < total; pi++) {
      const row = document.getElementById(`sch-prow-${i}-${pi}`);
      if (!row || row.dataset.deleted === '1') continue;
      const sel = document.getElementById(`sch-psel-${i}-${pi}`)?.value || 'other';
      let pp;
      if (sel === 'other') {
        pp = {flag:'', country:document.getElementById(`sch-potherval-${i}-${pi}`)?.value.trim()||'', eu:document.getElementById(`sch-peu-${i}-${pi}`)?.checked||false};
      } else {
        pp = {...(SCHENGEN_PASSPORT_MAP[sel]||{flag:'', country:'', eu:false})};
      }
      newPassports.push(pp);
    }
    sd.persons.push({name, passports: newPassports, activePassport: 0, trips: []});
  }
  schengenDedup(sd);
  save(); hideModal(); schengenRerender();
}

// ═══════════════════════════════════════════════════════════
//  WATER MAKER TAB
// ═══════════════════════════════════════════════════════════

function getWatermakerData() {
  if (!data.watermaker) data.watermaker = {currentReading:0, lastChangeReading:0, targetHours:60, charcoalChangedDate:null, inventory:{micron20:0, micron5:0, charcoal:0}};
  if (!data.watermaker.inventory) data.watermaker.inventory = {micron20:0, micron5:0, charcoal:0};
  return data.watermaker;
}

function renderWatermaker() {
  const wm = getWatermakerData();
  const email = localStorage.getItem(EMAIL_KEY);
  const isOwner = email === OWNER_EMAIL;
  const hoursUsed = Math.max(0, (wm.currentReading||0) - (wm.lastChangeReading||0));
  const target = wm.targetHours || 60;
  const hoursLeft = Math.max(0, target - hoursUsed);
  const pct = Math.min(1, hoursUsed / target);
  const arcColor = pct < 0.7 ? '#22C55E' : pct < 0.9 ? '#F59E0B' : '#EF4444';
  const usedColor = hoursUsed >= 50 ? (hoursUsed >= 65 ? 'var(--red)' : 'var(--orange)') : 'var(--green)';
  const warn = (target - hoursUsed) <= 10
    ? `<div style="margin:0 0 10px;padding:10px 14px;background:rgba(255,149,0,.1);border:0.5px solid var(--orange);border-radius:10px;font-size:13px;color:var(--orange);font-weight:600">⚠ 5 &amp; 20 micron filters — change recommended in ${Math.max(0,target-hoursUsed)}h</div>` : '';
  const exampleBanner = (!isOwner && !wm.exampleDismissed) ? `<div style="margin:0 0 10px;padding:8px 12px;background:var(--surface2);border-radius:10px;font-size:12px;color:var(--label3);font-style:italic">These are example values — update with your own readings</div>` : '';

  // SVG semicircular gauge — speedometer style
  const totalArc = 283;
  const dashoffset = Math.round(totalArc * (1 - pct));
  const gauge = `<svg width="220" height="130" viewBox="0 0 220 130" style="display:block;margin:0 auto 4px">
    <path d="M 20 110 A 90 90 0 0 1 200 110" fill="none" stroke="#e5e7eb" stroke-width="16" stroke-linecap="round" stroke-dasharray="283" stroke-dashoffset="0"/>
    <path id="wmArcFill" d="M 20 110 A 90 90 0 0 1 200 110" fill="none" stroke="${arcColor}" stroke-width="16" stroke-linecap="round" stroke-dasharray="283" stroke-dashoffset="${dashoffset}"/>
    <text x="110" y="90" text-anchor="middle" font-size="30" font-weight="800" fill="${arcColor}" font-family="var(--font)">${hoursUsed}</text>
    <text x="110" y="108" text-anchor="middle" font-size="11" fill="#9ca3af" font-family="var(--font)">hours used</text>
    <text x="18" y="126" text-anchor="middle" font-size="10" fill="#9ca3af" font-family="var(--font)">0</text>
    <text x="110" y="22" text-anchor="middle" font-size="10" fill="#9ca3af" font-family="var(--font)">${Math.round(target/2)}</text>
    <text x="202" y="126" text-anchor="middle" font-size="10" fill="#9ca3af" font-family="var(--font)">${target}</text>
  </svg>`;

  // Charcoal filter card
  let charMonthsElapsed = 0, charMonthsLeft = 6, charDueStr = '—', charChangedStr = '—';
  if (wm.charcoalChangedDate) {
    const changed = parseISODate(wm.charcoalChangedDate);
    if (changed) {
      const now = new Date(); now.setHours(0,0,0,0);
      charMonthsElapsed = Math.round((now - changed) / (30.44 * 86400000) * 10) / 10;
      charMonthsLeft = Math.max(0, Math.round((6 - charMonthsElapsed) * 10) / 10);
      charChangedStr = changed.toLocaleDateString('en-GB', {day:'numeric', month:'short', year:'numeric'});
      const due = new Date(changed); due.setMonth(due.getMonth() + 6);
      charDueStr = due.toLocaleDateString('en-GB', {day:'numeric', month:'short', year:'numeric'});
    }
  }
  const charPct = Math.min(1, charMonthsElapsed / 6);
  const charBarColor = charPct >= 0.9 ? 'var(--red)' : charPct >= 0.7 ? 'var(--orange)' : 'var(--green)';

  // Inventory dots helper
  const invDotColor = n => n <= 2 ? '#EF4444' : n <= 5 ? '#F59E0B' : '#22C55E';
  const invDots = count => {
    if (count === 0) return '';
    const dotCount = Math.min(count, 20);
    const col = invDotColor(count);
    return Array.from({length:dotCount}, () =>
      `<span style="display:inline-block;width:10px;height:10px;border-radius:50%;background:${col};margin:1px 2px"></span>`
    ).join('');
  };
  const invColor = n => n <= 2 ? '#EF4444' : n <= 5 ? '#F59E0B' : '#22C55E';
  const inv = wm.inventory;
  const invRow = (label, key) => {
    const n = inv[key]||0;
    return `
    <div style="padding:8px 14px;border-bottom:1px solid var(--sep)">
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:${n>0?'4px':'0'}">
        <div style="font-size:13px;flex:1">${label}</div>
        <div style="font-size:14px;font-weight:700;min-width:20px;text-align:right;color:${invColor(n)}">${n}</div>
        <button onclick="wmInvChange('${key}',1)" style="background:var(--surface2);border:none;border-radius:8px;width:28px;height:28px;font-size:16px;cursor:pointer;line-height:1;font-family:var(--font)">+</button>
        <button onclick="wmInvChange('${key}',-1)" style="background:var(--surface2);border:none;border-radius:8px;width:28px;height:28px;font-size:16px;cursor:pointer;line-height:1;font-family:var(--font)">−</button>
      </div>
      ${n>0?`<div style="display:flex;flex-wrap:wrap;gap:1px">${invDots(n)}</div>`:''}
    </div>`;
  };

  return `<div style="padding:12px">
    ${exampleBanner}${warn}
    <div class="card" style="margin-bottom:12px">
      <div style="padding:16px 14px 8px">
        ${gauge}
        <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:6px;margin-bottom:12px">
          <div style="background:var(--surface2);border-radius:10px;padding:8px;text-align:center">
            <div style="font-size:18px;font-weight:800;color:${usedColor}">${hoursUsed}</div>
            <div style="font-size:9px;color:var(--label3)">Hours used</div>
          </div>
          <div style="background:var(--surface2);border-radius:10px;padding:8px;text-align:center">
            <div style="font-size:18px;font-weight:800;color:var(--green)">${hoursLeft}</div>
            <div style="font-size:9px;color:var(--label3)">Hours left</div>
          </div>
          <div style="background:var(--surface2);border-radius:10px;padding:8px;text-align:center">
            <div style="font-size:18px;font-weight:800">${target}</div>
            <div style="font-size:9px;color:var(--label3)">Target hrs</div>
          </div>
        </div>
        <div style="display:flex;align-items:center;justify-content:space-between;padding:8px 0;border-top:1px solid var(--sep)">
          <div style="font-size:13px;color:var(--label2)">Current reading</div>
          <div style="display:flex;align-items:center;gap:8px">
            <span style="font-size:15px;font-weight:700;color:var(--blue)">${wm.currentReading||0}h</span>
            <button onclick="wmUpdateReading()" style="background:var(--blue);border:none;border-radius:8px;padding:3px 10px;font-size:12px;font-weight:600;font-family:var(--font);cursor:pointer;color:#fff">Update</button>
          </div>
        </div>
        <div style="padding:8px 0;border-top:1px solid var(--sep)">
          <div style="display:flex;align-items:center;justify-content:space-between">
            <div style="font-size:13px;color:var(--label2)">Reading at last filter change</div>
            <div style="display:flex;align-items:center;gap:8px">
              <span style="font-size:14px;font-weight:600">${wm.lastChangeReading||0}h</span>
              <button onclick="wmUpdateLastChange()" style="background:var(--blue);border:none;border-radius:8px;padding:3px 10px;font-size:12px;font-weight:600;font-family:var(--font);cursor:pointer;color:#fff">Update</button>
            </div>
          </div>
          ${!(wm.lastChangeReading) ? `<div style="font-size:11px;color:var(--label3);margin-top:3px">Tap Update to set the reading from your last filter change</div>` : ''}
        </div>
        <div style="display:flex;gap:8px;margin-top:8px">
          <button onclick="wmEditTarget()" style="flex:1;background:var(--blue);border:none;border-radius:8px;padding:9px 8px;font-size:12px;font-weight:700;font-family:var(--font);cursor:pointer;color:#fff">Edit target (${target}h)</button>
          <button onclick="wmChangeFilters()" style="flex:1;background:var(--blue);border:none;border-radius:8px;padding:9px 8px;font-size:12px;font-weight:700;font-family:var(--font);cursor:pointer;color:#fff">Change Filters</button>
        </div>
      </div>
    </div>
    <div class="card" style="margin-bottom:12px">
      <div class="card-hd">Charcoal filter — 6 month interval</div>
      <div style="padding:12px 14px">
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:10px">
          <div style="background:var(--surface2);border-radius:10px;padding:8px;text-align:center">
            <div style="font-size:18px;font-weight:800;color:${charBarColor}">${charMonthsElapsed}</div>
            <div style="font-size:9px;color:var(--label3)">months elapsed</div>
          </div>
          <div style="background:var(--surface2);border-radius:10px;padding:8px;text-align:center">
            <div style="font-size:18px;font-weight:800;color:var(--green)">${charMonthsLeft}</div>
            <div style="font-size:9px;color:var(--label3)">months left</div>
          </div>
        </div>
        <div style="height:8px;background:var(--surface2);border-radius:4px;margin-bottom:8px;overflow:hidden">
          <div style="height:8px;background:${charBarColor};width:${Math.round(charPct*100)}%;border-radius:4px;transition:width .4s"></div>
        </div>
        <div style="display:flex;justify-content:space-between;font-size:11px;color:var(--label3);margin-bottom:10px">
          <span>Changed ${charChangedStr} <button onclick="wmEditCharcoalDate()" style="background:none;border:none;padding:2px 4px;cursor:pointer;font-size:14px;color:var(--label3);line-height:1;flex-shrink:0">✏️</button></span><span>Due ${charDueStr}</span>
        </div>
        <button onclick="wmChangeCharcoal()" style="flex:1;background:var(--blue);border:none;border-radius:8px;padding:9px 8px;font-size:12px;font-weight:700;font-family:var(--font);cursor:pointer;color:#fff">Change Charcoal Filter</button>
      </div>
    </div>
    <div class="card">
      <div class="card-hd">Spare filters inventory</div>
      ${invRow('20 micron filter','micron20')}
      ${invRow('5 micron filter','micron5')}
      ${invRow('Charcoal filter','charcoal')}
    </div>
    <div class="card" style="margin-top:12px">
      <div class="card-hd">Filter change history</div>
      <div style="display:flex;align-items:center;justify-content:space-between;padding:8px 14px 4px">
        <span style="font-size:11px;font-weight:700;color:var(--label3);text-transform:uppercase;letter-spacing:.5px">5 &amp; 20 micron filters</span>
        <button onclick="wmAddMicronHistoryEntry()" style="background:none;border:none;font-size:12px;font-weight:600;color:var(--blue);font-family:var(--font);cursor:pointer;padding:0">+ Add entry</button>
      </div>
      ${(()=>{
          // Deduplicate by reading+date only
          const seen = new Set();
          const clean = (wm.micronHistory||[]).filter(r => {
            const key = `${r.reading}|${r.date}`;
            if (seen.has(key)) return false;
            seen.add(key); return true;
          });
          if (clean.length === 0) return `<div style="padding:4px 14px 10px;font-size:13px;color:var(--label3)">No changes recorded yet</div>`;
          // Sort by reading ascending for hours-lasted calc, then display descending by date
          const byReading = [...clean].sort((a,b) => (a.reading||0) - (b.reading||0));
          const lastedMap = {};
          byReading.forEach((r,i,arr) => {
            if (i === 0) { lastedMap[r.reading] = null; return; } // oldest: no prior
            lastedMap[r.reading] = (r.reading||0) - (arr[i-1].reading||0);
          });
          // Display sorted date-descending, use original indices for edit/delete
          const display = clean.slice().sort((a,b) => b.date.localeCompare(a.date));
          return display.map(r => {
            const origIdx = (wm.micronHistory||[]).indexOf(r);
            const d = parseISODate(r.date); const ds = d ? String(d.getDate()).padStart(2,'0')+'/'+String(d.getMonth()+1).padStart(2,'0')+'/'+String(d.getFullYear()).slice(-2) : r.date;
            const lasted = lastedMap[r.reading];
            const hrsLabel = (lasted == null || lasted <= 0)
              ? `<span style="color:var(--label3);flex-shrink:0">—</span>`
              : `<span style="color:var(--label3);flex-shrink:0">${lasted}h</span>`;
            return `<div style="display:flex;align-items:center;gap:8px;padding:7px 14px;border-top:1px solid var(--sep);font-size:12px">
              <span style="flex-shrink:0;color:var(--label3)">${ds}</span>
              ${r.location?`<span style="color:var(--label2);flex-shrink:0">${esc(r.location)}</span>`:''}
              <span style="color:var(--label3)">${r.reading}h</span>
              <span style="flex:1"></span>
              ${hrsLabel}
              <button onclick="wmEditMicronHistory(${origIdx})" style="background:none;border:none;padding:2px 4px;cursor:pointer;font-size:14px;color:var(--label3);line-height:1;flex-shrink:0">✏️</button>
            </div>`;
          }).join('');
        })()}
      <div style="display:flex;align-items:center;justify-content:space-between;padding:8px 14px 4px;border-top:1px solid var(--sep)">
        <span style="font-size:11px;font-weight:700;color:var(--label3);text-transform:uppercase;letter-spacing:.5px">Charcoal filter</span>
        <button onclick="wmAddCharcoalHistoryEntry()" style="background:none;border:none;font-size:12px;font-weight:600;color:var(--blue);font-family:var(--font);cursor:pointer;padding:0">+ Add entry</button>
      </div>
      ${(wm.charcoalHistory||[]).length === 0
        ? `<div style="padding:4px 14px 10px;font-size:13px;color:var(--label3)">No changes recorded yet</div>`
        : (wm.charcoalHistory||[]).map((r,i)=>{
            const d = parseISODate(r.date); const ds = d ? String(d.getDate()).padStart(2,'0')+'/'+String(d.getMonth()+1).padStart(2,'0')+'/'+String(d.getFullYear()).slice(-2) : r.date;
            return `<div style="display:flex;align-items:center;gap:8px;padding:7px 14px;border-top:1px solid var(--sep);font-size:12px">
              <span style="flex-shrink:0;color:var(--label3)">${ds}</span>
              ${r.location?`<span style="color:var(--label2);flex:1">${esc(r.location)}</span>`:'<span style="flex:1"></span>'}
              <button onclick="wmEditCharcoalHistory(${i})" style="background:none;border:none;padding:2px 4px;cursor:pointer;font-size:14px;color:var(--label3);line-height:1;flex-shrink:0">✏️</button>
            </div>`;
          }).join('')}
    </div>
  </div>`;
}

function wmUpdateReading() {
  const wm = getWatermakerData();
  showModal('Update Hour Meter Reading', `
    <div class="mi-label">Current hour meter reading</div>
    <input class="mi" id="wm-cur" type="number" min="0" placeholder="${wm.currentReading||0}" value="${wm.currentReading||0}" autofocus>
    <div class="modal-btns">
      <button class="btn btn-s" onclick="hideModal()">Cancel</button>
      <button class="btn btn-p" onclick="wmSaveReading()">Save</button>
    </div>`);
}
function wmSaveReading() {
  const wm = getWatermakerData();
  const v = parseInt(document.getElementById('wm-cur')?.value);
  if (!isNaN(v) && v >= 0) { wm.currentReading = v; wm.exampleDismissed = true; save(); }
  hideModal(); document.getElementById('mainContent').innerHTML = renderWatermaker();
}

function wmUpdateLastChange() {
  const wm = getWatermakerData();
  showModal('Last Filter Change Reading', `
    <div class="mi-label">Hour meter reading when you last changed the filters</div>
    <input class="mi" id="wm-lc" type="number" min="0" value="${wm.lastChangeReading||0}" autofocus>
    <div class="modal-btns">
      <button class="btn btn-s" onclick="hideModal()">Cancel</button>
      <button class="btn btn-p" onclick="wmSaveLastChange()">Save</button>
    </div>`);
}
function wmSaveLastChange() {
  const wm = getWatermakerData();
  const v = parseInt(document.getElementById('wm-lc')?.value);
  if (!isNaN(v) && v >= 0) { wm.lastChangeReading = v; wm.exampleDismissed = true; save(); }
  hideModal(); document.getElementById('mainContent').innerHTML = renderWatermaker();
}

function wmSaveEditLastChange() {
  const wm = getWatermakerData();
  const v = parseInt(document.getElementById('wm-elc')?.value);
  if (!isNaN(v) && v >= 0) { wm.lastChangeReading = v; wm.exampleDismissed = true; save(); }
  hideModal(); document.getElementById('mainContent').innerHTML = renderWatermaker();
}

function wmEditCharcoalDate() {
  const wm = getWatermakerData();
  showModal('Edit Charcoal Filter Change Date', `
    <div class="mi-label">Date charcoal filter was last changed</div>
    <input class="mi" id="wm-ecd" type="date" value="${wm.charcoalChangedDate||''}" autofocus>
    <div class="modal-btns">
      <button class="btn btn-s" onclick="hideModal()">Cancel</button>
      <button class="btn btn-p" onclick="wmSaveEditCharcoalDate()">Save</button>
    </div>`);
}
function wmSaveEditCharcoalDate() {
  const wm = getWatermakerData();
  const v = document.getElementById('wm-ecd')?.value;
  if (v) { wm.charcoalChangedDate = v; wm.exampleDismissed = true; save(); }
  hideModal(); document.getElementById('mainContent').innerHTML = renderWatermaker();
}

function wmEditTarget() {
  const wm = getWatermakerData();
  showModal('Edit Filter Target Hours', `
    <div class="mi-label">Target hours between filter changes</div>
    <input class="mi" id="wm-tgt" type="number" min="1" value="${wm.targetHours||60}" autofocus>
    <div class="modal-btns">
      <button class="btn btn-s" onclick="hideModal()">Cancel</button>
      <button class="btn btn-p" onclick="wmSaveTarget()">Save</button>
    </div>`);
}
function wmSaveTarget() {
  const wm = getWatermakerData();
  const v = parseInt(document.getElementById('wm-tgt')?.value);
  if (!isNaN(v) && v > 0) { wm.targetHours = v; wm.exampleDismissed = true; save(); }
  hideModal(); document.getElementById('mainContent').innerHTML = renderWatermaker();
}

function wmChangeFilters() {
  const wm = getWatermakerData();
  showModal('Change Filters', `
    <div class="mi-label">Current hour meter reading</div>
    <input class="mi" id="wm-chg" type="number" min="0" value="${wm.currentReading||0}" autofocus>
    <div class="mi-label">Location (optional)</div>
    <input class="mi" id="wm-chgloc" placeholder="e.g. Paros marina">
    <div style="font-size:12px;color:var(--label3);margin:8px 0 4px">Both 5 and 20 micron filters will be reset. Inventory will be decremented by 1 each.</div>
    <div class="modal-btns">
      <button class="btn btn-s" onclick="hideModal()">Cancel</button>
      <button class="btn btn-p" onclick="wmSaveFilterChange()">Confirm Change</button>
    </div>`);
}
function wmSaveFilterChange() {
  const wm = getWatermakerData();
  const v = parseInt(document.getElementById('wm-chg')?.value);
  if (!isNaN(v) && v >= 0) {
    const loc = document.getElementById('wm-chgloc')?.value.trim()||'';
    wm.currentReading = v;
    wm.lastChangeReading = v;
    if (!wm.micronHistory) wm.micronHistory = [];
    wm.micronHistory.unshift({id:uid(), date:new Date().toISOString().slice(0,10), location:loc, reading:v});
    if (wm.inventory.micron20 > 0) wm.inventory.micron20--;
    if (wm.inventory.micron5 > 0) wm.inventory.micron5--;
    wm.exampleDismissed = true;
    save();
  }
  hideModal(); document.getElementById('mainContent').innerHTML = renderWatermaker();
}

function wmChangeCharcoal() {
  showModal('Change Charcoal Filter', `
    <div style="font-size:14px;color:var(--label2);margin-bottom:8px">Set today as the new charcoal filter change date.<br>Inventory will be decremented by 1.</div>
    <div class="mi-label">Location (optional)</div>
    <input class="mi" id="wm-ccloc" placeholder="e.g. Paros marina">
    <div class="modal-btns">
      <button class="btn btn-s" onclick="hideModal()">Cancel</button>
      <button class="btn btn-p" onclick="wmSaveCharcoalChange()">Confirm Change</button>
    </div>`);
}
function wmSaveCharcoalChange() {
  const wm = getWatermakerData();
  const today = new Date().toISOString().slice(0,10);
  const loc = document.getElementById('wm-ccloc')?.value.trim()||'';
  wm.charcoalChangedDate = today;
  if (!wm.charcoalHistory) wm.charcoalHistory = [];
  wm.charcoalHistory.unshift({id:uid(), date:today, location:loc});
  if (wm.inventory.charcoal > 0) wm.inventory.charcoal--;
  wm.exampleDismissed = true;
  save(); hideModal(); document.getElementById('mainContent').innerHTML = renderWatermaker();
}

function wmAddMicronHistoryEntry() {
  const wm = getWatermakerData();
  const today = new Date().toISOString().slice(0,10);
  showModal('Add Filter Change Entry', `
    <div class="mi-label">Date</div><input class="mi" id="wmna-d" type="date" value="${today}" autofocus>
    <div class="mi-label">Hour meter reading</div><input class="mi" id="wmna-r" type="number" min="0" placeholder="0">
    <div class="mi-label">Location (optional)</div><input class="mi" id="wmna-l" placeholder="e.g. Paros marina">
    <div class="modal-btns">
      <button class="btn btn-s" onclick="hideModal()">Cancel</button>
      <button class="btn btn-p" onclick="wmSaveAddMicronHistoryEntry()">Save</button>
    </div>`);
}
function wmSaveAddMicronHistoryEntry() {
  const wm = getWatermakerData();
  const date = document.getElementById('wmna-d')?.value; if (!date) { showToast('Enter a date', true); return; }
  const reading = parseInt(document.getElementById('wmna-r')?.value);
  const loc = document.getElementById('wmna-l')?.value.trim()||'';
  if (isNaN(reading) || reading < 0) { showToast('Enter a valid reading', true); return; }
  if (!wm.micronHistory) wm.micronHistory = [];
  wm.micronHistory.unshift({id:uid(), date, location:loc, reading});
  wm.micronHistory.sort((a,b) => b.date.localeCompare(a.date));
  wm.lastChangeReading = wm.micronHistory[0].reading;
  wm.exampleDismissed = true;
  save(); hideModal(); document.getElementById('mainContent').innerHTML = renderWatermaker();
}

function wmAddCharcoalHistoryEntry() {
  const today = new Date().toISOString().slice(0,10);
  showModal('Add Charcoal Filter Change Entry', `
    <div class="mi-label">Date</div><input class="mi" id="wmca-d" type="date" value="${today}" autofocus>
    <div class="mi-label">Location (optional)</div><input class="mi" id="wmca-l" placeholder="e.g. Paros marina">
    <div class="modal-btns">
      <button class="btn btn-s" onclick="hideModal()">Cancel</button>
      <button class="btn btn-p" onclick="wmSaveAddCharcoalHistoryEntry()">Save</button>
    </div>`);
}
function wmSaveAddCharcoalHistoryEntry() {
  const wm = getWatermakerData();
  const date = document.getElementById('wmca-d')?.value; if (!date) { showToast('Enter a date', true); return; }
  const loc = document.getElementById('wmca-l')?.value.trim()||'';
  if (!wm.charcoalHistory) wm.charcoalHistory = [];
  wm.charcoalHistory.unshift({id:uid(), date, location:loc});
  wm.charcoalHistory.sort((a,b) => b.date.localeCompare(a.date));
  wm.charcoalChangedDate = wm.charcoalHistory[0].date;
  wm.exampleDismissed = true;
  save(); hideModal(); document.getElementById('mainContent').innerHTML = renderWatermaker();
}

function wmEditMicronHistory(i) {
  const wm = getWatermakerData();
  const r = wm.micronHistory?.[i]; if (!r) return;
  showModal('Edit Filter Change', `
    <div class="mi-label">Date</div><input class="mi" id="wmh-d" type="date" value="${esc(r.date||'')}">
    <div class="mi-label">Location</div><input class="mi" id="wmh-l" value="${esc(r.location||'')}">
    <div class="mi-label">Hour meter reading</div><input class="mi" id="wmh-r" type="number" min="0" value="${r.reading||0}">
    <div class="modal-btns">
      <button onclick="if(confirm('Delete this filter change record?')){hideModal();wmDeleteMicronHistory(${i})}" style="background:#FCEBEB;border:0.5px solid #F09595;color:#A32D2D;border-radius:8px;padding:8px 14px;font-family:var(--font);font-size:14px;font-weight:600;cursor:pointer;margin-right:auto">Delete</button>
      <button class="btn btn-s" onclick="hideModal()">Cancel</button>
      <button class="btn btn-p" onclick="wmSaveEditMicronHistory(${i})">Save</button>
    </div>`);
}
function wmSaveEditMicronHistory(i) {
  const wm = getWatermakerData();
  const r = wm.micronHistory?.[i]; if (!r) return;
  r.date     = document.getElementById('wmh-d')?.value||r.date;
  r.location = document.getElementById('wmh-l')?.value.trim()||'';
  const v = parseInt(document.getElementById('wmh-r')?.value);
  if (!isNaN(v)) r.reading = v;
  save(); hideModal(); document.getElementById('mainContent').innerHTML = renderWatermaker();
}
function wmDeleteMicronHistory(i) {
  const wm = getWatermakerData();
  wm.micronHistory.splice(i, 1);
  save(); document.getElementById('mainContent').innerHTML = renderWatermaker();
}

function wmEditCharcoalHistory(i) {
  const wm = getWatermakerData();
  const r = wm.charcoalHistory?.[i]; if (!r) return;
  showModal('Edit Charcoal Change', `
    <div class="mi-label">Date</div><input class="mi" id="wmch-d" type="date" value="${esc(r.date||'')}">
    <div class="mi-label">Location</div><input class="mi" id="wmch-l" value="${esc(r.location||'')}">
    <div class="modal-btns">
      <button onclick="if(confirm('Delete this charcoal change record?')){hideModal();wmDeleteCharcoalHistory(${i})}" style="background:#FCEBEB;border:0.5px solid #F09595;color:#A32D2D;border-radius:8px;padding:8px 14px;font-family:var(--font);font-size:14px;font-weight:600;cursor:pointer;margin-right:auto">Delete</button>
      <button class="btn btn-s" onclick="hideModal()">Cancel</button>
      <button class="btn btn-p" onclick="wmSaveEditCharcoalHistory(${i})">Save</button>
    </div>`);
}
function wmSaveEditCharcoalHistory(i) {
  const wm = getWatermakerData();
  const r = wm.charcoalHistory?.[i]; if (!r) return;
  r.date     = document.getElementById('wmch-d')?.value||r.date;
  r.location = document.getElementById('wmch-l')?.value.trim()||'';
  save(); hideModal(); document.getElementById('mainContent').innerHTML = renderWatermaker();
}
function wmDeleteCharcoalHistory(i) {
  const wm = getWatermakerData();
  wm.charcoalHistory.splice(i, 1);
  save(); document.getElementById('mainContent').innerHTML = renderWatermaker();
}

function wmInvChange(key, delta) {
  const wm = getWatermakerData();
  wm.inventory[key] = Math.max(0, (wm.inventory[key]||0) + delta);
  wm.exampleDismissed = true;
  save(); document.getElementById('mainContent').innerHTML = renderWatermaker();
}

// ═══════════════════════════════════════════════════════════
//  LPG TAB
// ═══════════════════════════════════════════════════════════

function getLpgData() {
  if (!data.lpg) data.lpg = {bottles:[], history:[]};
  if (!data.lpg.history) data.lpg.history = [];
  if (!data.lpg.bottles) data.lpg.bottles = [];
  return data.lpg;
}

function renderLpg() {
  const lpg = getLpgData();
  const email = localStorage.getItem(EMAIL_KEY);
  const isOwner = email === OWNER_EMAIL;
  const bottles = lpg.bottles||[];
  const full = bottles.filter(b=>b.full).length;
  const total = bottles.length;
  const kgOnBoard = bottles.filter(b=>b.full).reduce((s,b)=>s+b.kg,0);
  const pct = total > 0 ? Math.min(1, full/total) : 0;
  const arcColor = pct > 0.5 ? '#22C55E' : pct >= 0.25 ? '#F59E0B' : '#EF4444';
  const exampleBanner = (!isOwner && lpg.exampleDismissed === false) ? `<div style="margin:0 0 10px;padding:8px 12px;background:var(--surface2);border-radius:10px;font-size:12px;color:var(--label3);font-style:italic">These are example values — update with your own data</div>` : '';
  const warn = full <= 1 ? `<div style="margin:0 0 10px;padding:10px 14px;background:rgba(255,59,48,.1);border:0.5px solid var(--red);border-radius:10px;font-size:13px;color:var(--red);font-weight:600">⚠ Only ${full} bottle${full===1?'':'s'} remaining — consider refilling soon</div>` : '';

  // Semicircle gauge
  const totalArc = 283, dashoffset = Math.round(totalArc*(1-pct));
  const gauge = `<svg width="220" height="130" viewBox="0 0 220 130" style="display:block;margin:0 auto 4px">
    <path d="M 20 110 A 90 90 0 0 1 200 110" fill="none" stroke="#e5e7eb" stroke-width="16" stroke-linecap="round" stroke-dasharray="283" stroke-dashoffset="0"/>
    <path d="M 20 110 A 90 90 0 0 1 200 110" fill="none" stroke="${arcColor}" stroke-width="16" stroke-linecap="round" stroke-dasharray="283" stroke-dashoffset="${dashoffset}"/>
    <text x="110" y="88" text-anchor="middle" font-size="34" font-weight="800" fill="${arcColor}" font-family="var(--font)">${full}</text>
    <text x="110" y="108" text-anchor="middle" font-size="11" fill="#9ca3af" font-family="var(--font)">of ${total} bottles</text>
    <text x="18" y="126" text-anchor="middle" font-size="10" fill="#9ca3af" font-family="var(--font)">0</text>
    <text x="110" y="22" text-anchor="middle" font-size="10" fill="#9ca3af" font-family="var(--font)">${Math.round(total/2)}</text>
    <text x="202" y="126" text-anchor="middle" font-size="10" fill="#9ca3af" font-family="var(--font)">${total}</text>
  </svg>`;

  // Bottle icons
  const bottleIcons = bottles.map(b=>b.full
    ? `<div style="display:inline-flex;flex-direction:column;align-items:center;margin:0 4px"><span style="font-size:22px">🔥</span><span style="font-size:9px;color:var(--label3)">${b.kg}kg</span></div>`
    : `<div style="display:inline-flex;flex-direction:column;align-items:center;margin:0 4px"><span style="display:inline-flex;width:24px;height:32px;border:2px dashed #d1d5db;border-radius:4px"></span><span style="font-size:9px;color:var(--label3)">${b.kg}kg</span></div>`
  ).join('');

  // Price stats from history
  const prices = (lpg.history||[]).filter(h=>h.pricePerKg>0).map(h=>h.pricePerKg);
  const priceCard = prices.length ? `
    <div class="card" style="margin-bottom:12px">
      <div class="card-hd">Price per kg — all time</div>
      <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:6px;padding:12px 14px">
        <div style="background:var(--surface2);border-radius:10px;padding:8px;text-align:center">
          <div style="font-size:16px;font-weight:800;color:#22C55E">€${Math.min(...prices).toFixed(2)}</div>
          <div style="font-size:9px;color:var(--label3)">Lowest</div>
        </div>
        <div style="background:var(--surface2);border-radius:10px;padding:8px;text-align:center">
          <div style="font-size:16px;font-weight:800">€${(prices.reduce((a,b)=>a+b,0)/prices.length).toFixed(2)}</div>
          <div style="font-size:9px;color:var(--label3)">Average</div>
        </div>
        <div style="background:var(--surface2);border-radius:10px;padding:8px;text-align:center">
          <div style="font-size:16px;font-weight:800;color:#EF4444">€${Math.max(...prices).toFixed(2)}</div>
          <div style="font-size:9px;color:var(--label3)">Highest</div>
        </div>
      </div>
    </div>` : '';

  // Refill history
  const sorted = [...(lpg.history||[])].sort((a,b)=>b.date.localeCompare(a.date));
  const pricedEntries = sorted.filter(h=>h.pricePerKg>0);
  const minPrice = pricedEntries.length>=2 ? Math.min(...pricedEntries.map(h=>h.pricePerKg)) : null;
  const maxPrice = pricedEntries.length>=2 ? Math.max(...pricedEntries.map(h=>h.pricePerKg)) : null;
  const showBadges = minPrice !== null && minPrice !== maxPrice;
  const histRows = sorted.map(h => {
    const origIdx = lpg.history.indexOf(h);
    const d = parseISODate(h.date); const ds = d ? String(d.getDate()).padStart(2,'0')+'/'+String(d.getMonth()+1).padStart(2,'0')+'/'+String(d.getFullYear()).slice(-2) : h.date;
    const priceBadge = showBadges && h.pricePerKg
      ? (h.pricePerKg<=minPrice ? `<span style="background:rgba(52,199,89,.15);color:var(--green);border-radius:6px;padding:1px 6px;font-size:10px;font-weight:600">Cheapest</span>`
         : h.pricePerKg>=maxPrice ? `<span style="background:rgba(255,59,48,.12);color:var(--red);border-radius:6px;padding:1px 6px;font-size:10px;font-weight:600">Priciest</span>` : '') : '';
    return `<div style="display:flex;align-items:center;gap:8px;padding:8px 14px;border-top:1px solid var(--sep);font-size:12px">
      <span style="flex-shrink:0;color:var(--label3)">${ds}</span>
      ${h.location?`<span style="color:var(--label2);flex-shrink:0">${esc(h.location)}</span>`:''}
      <span style="color:var(--label3);flex-shrink:0">${h.bottles}×${h.kg||11}kg</span>
      ${h.pricePerKg?`<span style="color:var(--label3);flex-shrink:0">€${Number(h.pricePerKg).toFixed(2)}/kg</span>${priceBadge}`:''}
      <span style="flex:1"></span>
      <button onclick="lpgEditHistory(${origIdx})" style="background:none;border:none;padding:2px 4px;cursor:pointer;font-size:14px;color:var(--label3);line-height:1;flex-shrink:0">✏️</button>
    </div>`;
  }).join('');

  return `<div style="padding:12px">
    <div style="display:flex;justify-content:flex-end;margin-bottom:8px">
      <button onclick="lpgAddFill()" style="background:var(--blue);color:#fff;border:none;border-radius:8px;padding:5px 14px;font-size:13px;font-weight:600;font-family:var(--font);cursor:pointer">+ New Fill</button>
    </div>
    ${exampleBanner}${warn}
    <div class="card" style="margin-bottom:12px">
      <div class="card-hd">Bottles on board</div>
      <div style="padding:12px 14px 8px">
        ${gauge}
        <div style="display:flex;justify-content:center;gap:4px;align-items:center;margin-bottom:12px;flex-wrap:wrap">${bottleIcons}</div>
        <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:6px;margin-bottom:12px">
          <div style="background:var(--surface2);border-radius:10px;padding:8px;text-align:center">
            <div style="font-size:18px;font-weight:800;color:${arcColor}">${full}</div>
            <div style="font-size:9px;color:var(--label3)">Full bottles</div>
          </div>
          <div style="background:var(--surface2);border-radius:10px;padding:8px;text-align:center">
            <div style="font-size:18px;font-weight:800">${kgOnBoard.toFixed(0)}</div>
            <div style="font-size:9px;color:var(--label3)">kg on board</div>
          </div>
          <div style="background:var(--surface2);border-radius:10px;padding:8px;text-align:center">
            <div style="font-size:18px;font-weight:800">${total}</div>
            <div style="font-size:9px;color:var(--label3)">Total bottles</div>
          </div>
        </div>
        <div style="display:flex;gap:8px;margin-top:4px">
          <button onclick="lpgEditBottles()" style="flex:1;background:var(--surface2);border:0.5px solid var(--sep);border-radius:10px;padding:9px 8px;font-size:12px;font-weight:600;font-family:var(--font);cursor:pointer;color:var(--label)">Edit bottles</button>
          <button onclick="lpgUseBottle()" style="flex:1;background:var(--blue);border:none;border-radius:10px;padding:9px 8px;font-size:12px;font-weight:700;font-family:var(--font);cursor:pointer;color:#fff">Used a bottle</button>
        </div>
      </div>
    </div>
    ${priceCard}
    <div class="card">
      <div style="display:flex;align-items:center;justify-content:space-between;padding:10px 14px 6px">
        <span style="font-size:14px;font-weight:700">Refill history</span>
        <button onclick="lpgAddFill()" style="background:var(--blue);color:#fff;border:none;border-radius:8px;padding:4px 12px;font-size:12px;font-weight:600;font-family:var(--font);cursor:pointer">+ Add entry</button>
      </div>
      ${sorted.length===0?`<div style="padding:8px 14px 12px;font-size:13px;color:var(--label3)">No refills recorded yet</div>`:histRows}
    </div>
  </div>`;
}

function lpgFillModal(entry, idx) {
  const lpg = getLpgData();
  const today = new Date().toISOString().slice(0,10);
  const isEdit = entry != null;
  const defaultKg = (lpg.history?.length ? lpg.history[0].kg : null) || 11;
  const e = entry || {date:today, location:'', bottles:1, kg:defaultKg, pricePerKg:'', notes:''};
  showModal(isEdit?'Edit Refill':'New Fill', `
    <div class="mi-label">Date</div><input class="mi" id="lpg-d" type="date" value="${esc(e.date)}" autofocus>
    <div class="mi-label">Location</div><input class="mi" id="lpg-loc" value="${esc(e.location||'')}">
    <div class="mi-label">Number of bottles</div><input class="mi" id="lpg-b" type="number" min="1" value="${e.bottles||1}" oninput="lpgUpdateTotal()">
    <div class="mi-label">kg per bottle</div><input class="mi" id="lpg-kg" type="number" min="1" value="${e.kg||11}" oninput="lpgUpdateTotal()">
    <div class="mi-label">Price per kg (€)</div><input class="mi" id="lpg-ppkg" type="number" min="0" step="0.01" value="${e.pricePerKg||''}" oninput="lpgUpdateTotal()">
    <div id="lpg-total" style="font-size:12px;color:var(--label3);margin:6px 0 4px;text-align:right"></div>
    <div class="mi-label">Notes (optional)</div><input class="mi" id="lpg-notes" value="${esc(e.notes||'')}">
    <div class="modal-btns">
      ${isEdit?`<button onclick="if(confirm('Delete this refill entry?')){hideModal();lpgDeleteHistory(${idx})}" style="background:#FCEBEB;border:0.5px solid #F09595;color:#A32D2D;border-radius:8px;padding:8px 14px;font-family:var(--font);font-size:14px;font-weight:600;cursor:pointer;margin-right:auto">Delete</button>`:''}
      <button class="btn btn-s" onclick="hideModal()">Cancel</button>
      <button class="btn btn-p" onclick="lpgSaveFill(${isEdit?idx:'null'})">${isEdit?'Save':'Add Refill'}</button>
    </div>`);
  lpgUpdateTotal();
}
function lpgUpdateTotal() {
  const b = parseFloat(document.getElementById('lpg-b')?.value)||0;
  const kg = parseFloat(document.getElementById('lpg-kg')?.value)||0;
  const p = parseFloat(document.getElementById('lpg-ppkg')?.value)||0;
  const el = document.getElementById('lpg-total');
  if (el) el.textContent = (b&&kg&&p) ? `Total: €${(b*kg*p).toFixed(2)}` : '';
}
function lpgSaveFill(idx) {
  const lpg = getLpgData();
  const date = document.getElementById('lpg-d')?.value; if (!date) { showToast('Enter a date', true); return; }
  const bottles = parseInt(document.getElementById('lpg-b')?.value)||1;
  const kg = parseFloat(document.getElementById('lpg-kg')?.value)||11;
  const pricePerKg = parseFloat(document.getElementById('lpg-ppkg')?.value)||0;
  const location = document.getElementById('lpg-loc')?.value.trim()||'';
  const notes = document.getElementById('lpg-notes')?.value.trim()||'';
  if (idx != null && idx !== 'null') {
    lpg.history[idx] = {...lpg.history[idx], date, location, bottles, kg, pricePerKg, notes};
  } else {
    lpg.history.unshift({id:uid(), date, location, bottles, kg, pricePerKg, notes});
  }
  if (lpg.exampleDismissed === false) lpg.exampleDismissed = true;
  save(); hideModal(); document.getElementById('mainContent').innerHTML = renderLpg();
}
function lpgAddFill() { lpgFillModal(null, null); }
function lpgEditHistory(i) { const lpg = getLpgData(); lpgFillModal(lpg.history[i], i); }
function lpgDeleteHistory(i) {
  const lpg = getLpgData(); lpg.history.splice(i,1);
  save(); document.getElementById('mainContent').innerHTML = renderLpg();
}
let lpgBottlesWip = [];
function lpgEditBottles() {
  const lpg = getLpgData();
  lpgBottlesWip = lpg.bottles.map(b=>({...b}));
  lpgRenderBottlesModal();
}
function lpgRenderBottlesModal() {
  const rows = lpgBottlesWip.map((b,i)=>`
    <div style="display:flex;align-items:center;gap:8px;padding:8px 0;border-top:1px solid var(--sep)">
      <span style="flex:1;font-size:14px">${b.kg} kg</span>
      <button onclick="lpgBottleToggle(${i})" style="background:${b.full?'rgba(52,199,89,.15)':'var(--surface2)'};color:${b.full?'var(--green)':'var(--label3)'};border:0.5px solid ${b.full?'var(--green)':'var(--sep)'};border-radius:8px;padding:3px 10px;font-size:12px;font-weight:600;font-family:var(--font);cursor:pointer">${b.full?'Full':'Empty'}</button>
      <button onclick="lpgBottleRemove(${i})" style="background:none;border:none;padding:2px 6px;cursor:pointer;font-size:14px;color:var(--label3)">✕</button>
    </div>`).join('');
  showModal('Edit Bottles', `
    <div>${rows}</div>
    <div style="display:flex;align-items:center;gap:8px;margin-top:10px">
      <input class="mi" id="lpg-new-kg" type="number" min="1" placeholder="kg size" style="flex:1">
      <button onclick="lpgBottleAdd()" style="background:var(--blue);color:#fff;border:none;border-radius:8px;padding:6px 12px;font-size:12px;font-weight:600;font-family:var(--font);cursor:pointer">+ Add bottle</button>
    </div>
    <div class="modal-btns">
      <button class="btn btn-s" onclick="hideModal()">Cancel</button>
      <button class="btn btn-p" onclick="lpgSaveBottles()">Save</button>
    </div>`);
}
function lpgBottleToggle(i) { lpgBottlesWip[i].full=!lpgBottlesWip[i].full; lpgRenderBottlesModal(); }
function lpgBottleRemove(i) { lpgBottlesWip.splice(i,1); lpgRenderBottlesModal(); }
function lpgBottleAdd() {
  const v = parseFloat(document.getElementById('lpg-new-kg')?.value);
  if (!v||v<=0) { showToast('Enter a valid kg size', true); return; }
  lpgBottlesWip.push({id:uid(), kg:v, full:true});
  lpgRenderBottlesModal();
}
function lpgSaveBottles() {
  const lpg = getLpgData();
  lpg.bottles = lpgBottlesWip.map(b=>({...b}));
  if (lpg.exampleDismissed === false) lpg.exampleDismissed = true;
  save(); hideModal(); document.getElementById('mainContent').innerHTML = renderLpg();
}
function lpgUseBottle() {
  const lpg = getLpgData();
  const fullList = (lpg.bottles||[]).map((b,i)=>({...b,i})).filter(b=>b.full);
  if (fullList.length===0) { showToast('No full bottles remaining', true); return; }
  const rows = fullList.map(b=>`
    <button onclick="lpgMarkUsed(${b.i})" style="display:flex;align-items:center;gap:10px;width:100%;background:var(--surface2);border:0.5px solid var(--sep);border-radius:10px;padding:10px 12px;margin-bottom:8px;cursor:pointer;font-family:var(--font)">
      <span style="font-size:22px">🔥</span>
      <span style="font-size:14px;font-weight:600;color:var(--label)">${b.kg} kg bottle</span>
    </button>`).join('');
  showModal('Which bottle was used?', `
    ${rows}
    <div class="modal-btns"><button class="btn btn-s" onclick="hideModal()">Cancel</button></div>`);
}
function lpgMarkUsed(i) {
  const lpg = getLpgData();
  if (lpg.bottles[i]) { lpg.bottles[i].full=false; if (lpg.exampleDismissed===false) lpg.exampleDismissed=true; save(); }
  hideModal(); document.getElementById('mainContent').innerHTML = renderLpg();
}

function prefillLpgData() {
  const email = localStorage.getItem(EMAIL_KEY);
  const existing = data.lpg;
  if (existing && (existing.history?.length || existing.bottles?.length > 0)) return false;
  if (!data.lpg) data.lpg = {};
  const dAgo = n => { const d = new Date(); d.setDate(d.getDate()-n); return d.toISOString().slice(0,10); };
  if (email === OWNER_EMAIL) {
    const odLpg = (typeof OROBORO_DATA !== 'undefined') ? (OROBORO_DATA.lpg || {}) : {};
    data.lpg = {
      bottles: odLpg.bottles || [{id:'b1',kg:11,full:true},{id:'b2',kg:11,full:false},{id:'b3',kg:11,full:false}],
      history: odLpg.history || []
    };
  } else {
    data.lpg = {bottles:[
      {id:uid(), kg:11, full:true},
      {id:uid(), kg:11, full:true},
      {id:uid(), kg:11, full:false}
    ], exampleDismissed:false, history:[
      {id:'ex_lpg1', date:dAgo(60),  location:'Example Marina', bottles:3, kg:11, pricePerKg:1.90, notes:'Tank refill (Example)'},
      {id:'ex_lpg2', date:dAgo(180), location:'Example Port',   bottles:2, kg:11, pricePerKg:1.65, notes:'Tank refill (Example)'}
    ]};
  }
  return true;
}

// ═══════════════════════════════════════════════════════════
//  PROVISIONS TAB
// ═══════════════════════════════════════════════════════════

let _provDragId = null, _provTouchState = null;
let _partsDragId = null, _partsTouchState = null;
let _maintLogDragId = null, _maintLogTouchState = null;
let _sysDragId = null, _sysTouchState = null;
let _winDragId = null, _winDragSid = null, _winTouchState = null;
const PROV_CATS = [
  {id:'all',        label:'All'},
  {id:'food',       label:'🥫 Food'},
  {id:'drinks',     label:'🥤 Drinks'},
  {id:'toiletries', label:'🧴 Toiletries & Cleaning'},
  {id:'misc',       label:'📦 Misc'},
];
const PROV_CAT_LABELS = {food:'Food',drinks:'Drinks',toiletries:'Toiletries & Cleaning',misc:'Misc'};
const PROV_CAT_ORDER  = ['food','drinks','toiletries','misc'];

function getProvisionsData() {
  if (!data.provisions) data.provisions = {items:[]};
  if (!data.provisions.items) data.provisions.items = [];
  for (const it of data.provisions.items) {
    if (it.category === 'cleaning') it.category = 'toiletries';
    if (it.category === 'medical')  it.category = 'misc';
  }
  return data.provisions;
}

function renderProvisions() {
  const v = ui.provisionsView || 'list';
  if (v === 'insights') return renderProvisionsInsights();
  if (v === 'history')  return renderProvisionsHistory();
  return renderProvisionsList();
}

function _provViewToggle() {
  const v = ui.provisionsView || 'list';
  const btn = (label, val) => {
    const active = v === val;
    return `<button onclick="ui.provisionsView='${val}';ui.provHistGroup=null;document.getElementById('mainContent').innerHTML=renderProvisions()"
      style="flex:1;border:none;border-radius:6px;padding:5px;font-size:12px;font-weight:600;font-family:var(--font);cursor:pointer;transition:all .15s;${active?'background:var(--surface);color:var(--blue);box-shadow:0 1px 2px rgba(0,0,0,.08)':'background:transparent;color:var(--label3)'}">${label}</button>`;
  };
  return `<div style="display:flex;background:var(--surface2);border-radius:8px;padding:2px;gap:2px;margin-bottom:8px">
    ${btn('List','list')}${btn('History','history')}${btn('Insights','insights')}
  </div>`;
}

// ── Provisions name normalization for Insights matching ───────────────────────
// Strips size/count tokens so "Tuna Rio Mare 2x160g" and "Rio Mare Tuna" can match.
function _normProvName(n) {
  return (n || '').toLowerCase()
    .replace(/\d+(?:[.,]\d+)?(?:\s*x\s*\d+(?:[.,]\d+)?)?\s*(?:g|gr|kg|ml|l|cl|pcs?|pieces?|pc|rolls?|ply|ct|pack|τεμ)\b/gi, '')
    .replace(/\b\d+[-–]\w+\b/g, '') // "3-ply", "2-pack"
    .replace(/[^\w\s]/g, ' ')
    .replace(/\s+/g, ' ').trim();
}
const _PROV_SW = new Set(['in','of','the','a','an','and','or','for','with','to','from','by','de','la','le']);
function _provTokenSet(n) {
  return new Set(_normProvName(n).split(' ').filter(w => w.length >= 2 && !_PROV_SW.has(w)));
}
// True if shorter token set is a subset of the larger (handles word-order + extra descriptors).
// Requires shorter set to have ≥ 2 tokens to avoid spurious single-word matches.
function _provNamesMatch(a, b) {
  const ta = _provTokenSet(a), tb = _provTokenSet(b);
  if (!ta.size || !tb.size) return _normProvName(a) === _normProvName(b);
  const [smaller, larger] = ta.size <= tb.size ? [ta, tb] : [tb, ta];
  if (smaller.size < 2) return _normProvName(a) === _normProvName(b);
  return [...smaller].every(t => larger.has(t));
}

function renderProvisionsHistory() {
  getProvisionsData(); // ensure data.provisions exists
  const history = (data.provisions?.history || []);
  const fmtDate = d => {
    try { const dt = new Date(d); return dt.toLocaleDateString('en-GB',{day:'numeric',month:'short',year:'numeric'}); }
    catch(e) { return d || '—'; }
  };
  const fmt = n => n != null ? `€${Number(n).toFixed(2)}` : '';

  // Drill-down: show a single receipt group's items
  if (ui.provHistGroup) {
    const [gDate, ...gStoreParts] = ui.provHistGroup.split('_');
    const gStore = gStoreParts.join('_');
    const items = history.filter(it =>
      (it.lastPurchaseDate || '') === gDate && (it.lastStore || '') === gStore
    );
    const total = items.reduce((s, it) => s + (it.lastPrice != null ? Number(it.lastPrice) : 0), 0);
    const hasTotal = items.some(it => it.lastPrice != null);
    return `<div style="padding:12px">
      ${_provViewToggle()}
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:12px;justify-content:space-between">
        <div style="display:flex;align-items:center;gap:8px">
          <button onclick="ui.provHistGroup=null;document.getElementById('mainContent').innerHTML=renderProvisions()"
            style="background:none;border:none;font-size:18px;cursor:pointer;color:var(--label2);line-height:1;padding:0">←</button>
          <div>
            <div style="font-size:15px;font-weight:700;color:var(--label)">${esc(gStore || 'Unknown store')}</div>
            <div style="font-size:12px;color:var(--label3)">${esc(fmtDate(gDate))} · ${items.length} item${items.length!==1?'s':''}${hasTotal?' · '+fmt(total):''}</div>
          </div>
        </div>
        <button onclick="if(confirm('Delete this receipt? This removes all ${items.length} item${items.length!==1?'s':''} from your price history.'))provHistDeleteGroup()" style="background:#FCEBEB;border:0.5px solid #F09595;color:#A32D2D;border-radius:8px;padding:5px 12px;font-size:13px;font-weight:600;font-family:var(--font);cursor:pointer;flex-shrink:0">🗑</button>
      </div>
      <div class="card">
        ${items.map(it => `
          <div style="display:flex;justify-content:space-between;align-items:baseline;padding:9px 14px;border-bottom:1px solid var(--sep)">
            <div style="flex:1;min-width:0">
              <div style="font-size:13px;color:var(--label);font-weight:500">${esc(it.name||'?')}</div>
              ${it.qty && it.qty !== 1 ? `<div style="font-size:11px;color:var(--label3)">×${it.qty}${it.unit?' '+esc(it.unit):''}</div>` : ''}
            </div>
            <div style="font-size:13px;font-weight:600;color:var(--blue);flex-shrink:0;margin-left:10px">${it.lastPrice!=null?fmt(it.lastPrice):''}</div>
          </div>`).join('')}
      </div>
    </div>`;
  }

  // Empty state
  if (!history.length) return `<div style="padding:12px">
    ${_provViewToggle()}
    <div style="padding:40px 16px;text-align:center">
      <div style="font-size:40px;margin-bottom:12px">🧾</div>
      <div style="font-size:15px;font-weight:600;color:var(--label);margin-bottom:8px">No receipt history yet</div>
      <div style="font-size:13px;color:var(--label3);line-height:1.6;max-width:260px;margin:0 auto">Import a supermarket receipt with AI Import to see it here.</div>
    </div>
  </div>`;

  // Build receipt groups: key = "date_store"
  const groupMap = {};
  history.forEach(it => {
    const key = `${it.lastPurchaseDate || ''}_${it.lastStore || ''}`;
    if (!groupMap[key]) groupMap[key] = { date: it.lastPurchaseDate||'', store: it.lastStore||'', items: [] };
    groupMap[key].items.push(it);
  });
  // Sort groups reverse-chronological
  const groups = Object.entries(groupMap)
    .sort(([,a],[,b]) => (b.date||'').localeCompare(a.date||''))
    .map(([key, g]) => ({ key, ...g }));

  const cards = groups.map(g => {
    const total = g.items.reduce((s, it) => s + (it.lastPrice != null ? Number(it.lastPrice) : 0), 0);
    const hasTotal = g.items.some(it => it.lastPrice != null);
    return `<div onclick="ui.provHistGroup='${esc(g.key)}';document.getElementById('mainContent').innerHTML=renderProvisions()"
      class="card" style="margin-bottom:10px;cursor:pointer;display:flex;align-items:center;justify-content:space-between;padding:14px">
      <div>
        <div style="font-size:14px;font-weight:700;color:var(--label)">${esc(g.store || 'Unknown store')}</div>
        <div style="font-size:12px;color:var(--label3);margin-top:2px">${esc(fmtDate(g.date))} · ${g.items.length} item${g.items.length!==1?'s':''}</div>
      </div>
      <div style="text-align:right;flex-shrink:0;margin-left:12px">
        ${hasTotal?`<div style="font-size:16px;font-weight:700;color:var(--blue)">${fmt(total)}</div>`:''}
        <div style="font-size:18px;color:var(--label3)">›</div>
      </div>
    </div>`;
  }).join('');

  return `<div style="padding:12px">
    ${_provViewToggle()}
    ${cards}
  </div>`;
}

function renderProvisionsList() {
  const prov = getProvisionsData();
  const email = localStorage.getItem(EMAIL_KEY);
  const isOwner = email === OWNER_EMAIL;
  const sub = ui.provisionsSub || 'all';

  const exampleBanner = (!isOwner && prov.exampleDismissed === false)
    ? `<div style="margin:0 0 10px;padding:8px 12px;background:var(--surface2);border-radius:10px;font-size:12px;color:var(--label3);font-style:italic">These are example items — add your own provisions</div>`
    : '';

  // Subtab bar
  const subtabs = PROV_CATS.map(c =>
    `<div class="pill ${sub===c.id?'active':''}" onclick="setProvSub('${c.id}')">${c.label}</div>`
  ).join('');

  const items = prov.items || [];
  const visible = sub === 'all' ? items : items.filter(it => it.category === sub);

  // Shopping list — all unchecked items (bought=false/undefined means "needs buying")
  const needed = items.filter(it => !it.bought)
    .sort((a,b) => PROV_CAT_ORDER.indexOf(a.category) - PROV_CAT_ORDER.indexOf(b.category));
  const shoppingCard = needed.length ? `
    <div style="background:rgba(251,146,60,.12);border:0.5px solid #fb923c;border-radius:14px;padding:10px 14px;margin-bottom:12px">
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:8px">
        <span style="font-size:14px;font-weight:700">🛍 Shopping list</span>
        <span style="background:#fb923c;color:#fff;border-radius:10px;padding:1px 8px;font-size:11px;font-weight:700">${needed.length}</span>
      </div>
      ${needed.map(it=>`
        <div style="display:flex;align-items:center;gap:8px;padding:4px 0">
          <input type="checkbox" onchange="provToggleBought(${items.indexOf(it)},this.checked)" style="width:16px;height:16px;cursor:pointer;accent-color:#fb923c">
          <span style="flex:1;font-size:13px">${esc(it.name)}</span>
        </div>`).join('')}
    </div>` : '';

  // Group visible items by category
  const byCat = {};
  for (const it of visible) {
    if (!byCat[it.category]) byCat[it.category] = [];
    byCat[it.category].push(it);
  }
  const catCards = PROV_CAT_ORDER.filter(c => byCat[c]).map(c => {
    const rows = byCat[c].map(it => {
      const origIdx = items.indexOf(it);
      return `<div data-prov-id="${it.id}" draggable="true" ondragstart="provDragStart(event,'${it.id}')" ondragover="provDragOver(event,'${it.id}')" ondragleave="provDragLeave(event)" ondrop="provDrop(event,'${it.id}')" ondragend="provDragEnd()" style="display:flex;align-items:center;gap:6px;padding:8px 14px;border-top:1px solid var(--sep)">
        <span class="prov-grip" ontouchstart="provTouchStart(event,'${it.id}')">⠿</span>
        <input type="checkbox" ${it.bought?'checked':''} onchange="provToggleBought(${origIdx},this.checked)" style="width:17px;height:17px;flex-shrink:0;cursor:pointer;accent-color:var(--blue)">
        <div style="flex:1;min-width:0">
          <div style="font-size:13px;font-weight:600;color:var(--label)">${esc(it.name)}</div>
          ${it.location?`<div style="font-size:11px;color:var(--label3)">${esc(it.location)}</div>`:''}
        </div>
        <button onclick="provEdit(${origIdx})" style="background:none;border:none;padding:2px 4px;cursor:pointer;font-size:14px;color:var(--label3);line-height:1;flex-shrink:0">✏️</button>
      </div>`;
    }).join('');
    return `<div class="card" style="margin-bottom:10px">
      <div class="card-hd">${PROV_CAT_LABELS[c]}</div>
      ${rows}
    </div>`;
  }).join('');

  const emptyMsg = visible.length === 0
    ? `<div style="padding:20px;text-align:center;color:var(--label3);font-size:13px">No items in this category</div>`
    : '';

  return `<div style="padding:12px">
    ${_provViewToggle()}
    <div style="display:flex;justify-content:flex-end;margin-bottom:8px">
      <button onclick="provAddModal()" style="background:var(--blue);color:#fff;border:none;border-radius:8px;padding:5px 14px;font-size:13px;font-weight:600;font-family:var(--font);cursor:pointer">+ Add item</button>
    </div>
    ${exampleBanner}
    <div class="subtab-bar" style="margin-bottom:10px">${subtabs}</div>
    ${shoppingCard}
    ${catCards}${emptyMsg}
  </div>`;
}

function renderProvisionsInsights() {
  const prov = getProvisionsData();
  const items = prov.history || [];  // read from AI-import history, not the manual list
  const now = new Date();
  const thisYM = now.getFullYear() * 100 + (now.getMonth() + 1);
  const lastDate = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const lastYM = lastDate.getFullYear() * 100 + (lastDate.getMonth() + 1);
  const fmt = n => `€${Number(n).toFixed(2)}`;

  const hasData = items.some(it => (it.priceHistory || []).some(h => h.price != null));

  if (!hasData) {
    return `<div style="padding:12px">
      ${_provViewToggle()}
      <div style="padding:40px 16px;text-align:center">
        <div style="font-size:40px;margin-bottom:12px">📊</div>
        <div style="font-size:15px;font-weight:600;color:var(--label);margin-bottom:8px">No spend data yet</div>
        <div style="font-size:13px;color:var(--label3);line-height:1.6;max-width:260px;margin:0 auto">Insights build up automatically from AI-imported receipts — no manual entry needed.</div>
      </div>
    </div>`;
  }

  // Monthly spend
  let thisMonthSpend = 0, lastMonthSpend = 0;
  items.forEach(it => {
    (it.priceHistory || []).forEach(h => {
      if (h.price == null || !h.date) return;
      try {
        const d = new Date(h.date);
        const ym = d.getFullYear() * 100 + (d.getMonth() + 1);
        if (ym === thisYM) thisMonthSpend += Number(h.price) || 0;
        if (ym === lastYM) lastMonthSpend += Number(h.price) || 0;
      } catch(e) {}
    });
  });
  const spendDiff = thisMonthSpend - lastMonthSpend;
  const spendArrow = spendDiff > 0 ? '↑' : spendDiff < 0 ? '↓' : '→';
  const spendColor = spendDiff > 0 ? 'var(--red)' : spendDiff < 0 ? 'var(--green)' : 'var(--label3)';
  // Fix: when lastMonthSpend is 0 there's no real baseline — don't show a misleading arrow
  const vsLastMonthHtml = lastMonthSpend === 0
    ? `<div style="padding:0 14px 12px;font-size:12px;color:var(--label3)">No data for last month</div>`
    : spendDiff !== 0
      ? `<div style="padding:0 14px 12px;font-size:12px;color:${spendColor};font-weight:600">${spendArrow} ${fmt(Math.abs(spendDiff))} vs last month</div>`
      : '';
  const spendCard = (thisMonthSpend > 0 || lastMonthSpend > 0) ? `
    <div class="card" style="margin-bottom:12px">
      <div class="card-hd">Monthly spend</div>
      <div style="display:grid;grid-template-columns:1fr 1fr;padding:12px 14px;gap:8px">
        <div style="text-align:center">
          <div style="font-size:20px;font-weight:700;color:var(--blue)">${fmt(thisMonthSpend)}</div>
          <div style="font-size:11px;color:var(--label3);margin-top:2px">This month</div>
        </div>
        <div style="text-align:center">
          <div style="font-size:20px;font-weight:700;color:var(--label2)">${fmt(lastMonthSpend)}</div>
          <div style="font-size:11px;color:var(--label3);margin-top:2px">Last month</div>
        </div>
      </div>
      ${vsLastMonthHtml}
    </div>` : '';

  // Store price comparison — smart name matching handles word-order and size-suffix variance
  // Uses _provNamesMatch() (bidirectional token-subset) instead of exact lowercase key.
  const nameGroups = []; // [{displayName, tokens, byStore:{store:[price,...]}}]
  items.forEach(it => {
    (it.priceHistory || []).forEach(h => {
      if (!h.store || h.price == null) return;
      const name = (it.name || '').trim();
      if (!name) return;
      let group = nameGroups.find(g => _provNamesMatch(name, g.displayName));
      if (!group) {
        group = { displayName: name, byStore: {} };
        nameGroups.push(group);
      }
      if (!group.byStore[h.store]) group.byStore[h.store] = [];
      group.byStore[h.store].push(Number(h.price));
    });
  });
  const comparisons = nameGroups.filter(x => Object.keys(x.byStore).length >= 2);
  const storeCard = comparisons.length ? `
    <div class="card" style="margin-bottom:12px">
      <div class="card-hd">Store price comparison</div>
      ${comparisons.map(item => {
        const storeLatest = Object.entries(item.byStore).map(([store, prices]) => ({ store, price: prices[prices.length - 1] }));
        storeLatest.sort((a,b) => a.price - b.price);
        const cheapest = storeLatest[0];
        const priciest = storeLatest[storeLatest.length - 1];
        const pctDiff = priciest.price > 0 ? Math.round((priciest.price - cheapest.price) / priciest.price * 100) : 0;
        return `<div style="padding:10px 14px;border-bottom:1px solid var(--sep)">
          <div style="font-size:13px;font-weight:600;color:var(--label);margin-bottom:6px">${esc(item.displayName)}</div>
          ${storeLatest.map(({store, price}) => `
            <div style="display:flex;justify-content:space-between;align-items:center;padding:2px 0">
              <span style="font-size:12px;color:var(--label2)">${esc(store)}</span>
              <span style="font-size:12px;font-weight:700;color:${store===cheapest.store?'var(--green)':'var(--label)'}">${fmt(price)}${store===cheapest.store?' ✓':''}</span>
            </div>`).join('')}
          ${pctDiff > 0 ? `<div style="font-size:11px;color:var(--green);margin-top:4px">${pctDiff}% cheaper at ${esc(cheapest.store)}</div>` : ''}
        </div>`;
      }).join('')}
    </div>` : '';

  // Buying frequency — smart name matching so "Tuna Rio Mare" and "Rio Mare Tuna" count as one item
  const freqGroups = []; // [{displayName, dates:[]}]
  items.forEach(it => {
    const hist = (it.priceHistory || []).filter(h => h.date);
    if (!hist.length) return;
    const name = (it.name || '').trim();
    if (!name) return;
    let group = freqGroups.find(g => _provNamesMatch(name, g.displayName));
    if (!group) { group = { displayName: name, dates: [] }; freqGroups.push(group); }
    hist.forEach(h => group.dates.push(h.date));
  });
  const allEntries = {}; // kept for compatibility with code below
  freqGroups.forEach(g => { if (g.dates.length >= 2) allEntries[g.displayName] = { name: g.displayName, dates: g.dates }; });
  const freqItems = Object.values(allEntries).filter(x => x.dates.length >= 2).map(x => {
    x.dates.sort();
    const first = new Date(x.dates[0]);
    const last  = new Date(x.dates[x.dates.length - 1]);
    const days  = Math.round((last - first) / 86400000);
    const avgDays = Math.round(days / (x.dates.length - 1));
    return { name: x.name, avgDays, count: x.dates.length };
  }).filter(x => x.avgDays > 0);
  const freqCard = freqItems.length ? `
    <div class="card" style="margin-bottom:12px">
      <div class="card-hd">Buying frequency</div>
      ${freqItems.map(it => `
        <div style="display:flex;justify-content:space-between;align-items:center;padding:10px 14px;border-bottom:1px solid var(--sep)">
          <span style="font-size:13px;color:var(--label)">${esc(it.name)}</span>
          <span style="font-size:12px;color:var(--label3);font-weight:500">every ~${it.avgDays}d</span>
        </div>`).join('')}
    </div>` : '';

  return `<div style="padding:12px">
    ${_provViewToggle()}
    ${spendCard}${storeCard}${freqCard}
  </div>`;
}

function setProvSub(s) {
  ui.provisionsSub = s;
  document.getElementById('mainContent').innerHTML = renderProvisions();
}

function provToggleBought(idx, checked) {
  const prov = getProvisionsData();
  if (!prov.items[idx]) return;
  prov.items[idx].bought = checked;
  save(); document.getElementById('mainContent').innerHTML = renderProvisions();
}
function provHistDeleteGroup() {
  const key = ui.provHistGroup;
  if (!key) return;
  getProvisionsData();
  const [gDate, ...gStoreParts] = key.split('_');
  const gStore = gStoreParts.join('_');
  data.provisions.history = (data.provisions.history || []).filter(it =>
    !((it.lastPurchaseDate || '') === gDate && (it.lastStore || '') === gStore)
  );
  ui.provHistGroup = null;
  save();
  document.getElementById('mainContent').innerHTML = renderProvisions();
}

function provDragStart(e, id) {
  if (e.target.closest('button,input,select')) { e.preventDefault(); return; }
  _provDragId = id;
  e.dataTransfer.effectAllowed = 'move';
  e.dataTransfer.setData('text/plain', id);
  setTimeout(() => document.querySelector(`[data-prov-id="${id}"]`)?.classList.add('prov-dragging'), 0);
}
function provDragOver(e, id) {
  if (!_provDragId || _provDragId === id) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = 'move';
  document.querySelectorAll('.prov-drag-over').forEach(el => el.classList.remove('prov-drag-over'));
  e.currentTarget.classList.add('prov-drag-over');
}
function provDragLeave(e) {
  if (!e.currentTarget.contains(e.relatedTarget)) e.currentTarget.classList.remove('prov-drag-over');
}
function provDrop(e, targetId) {
  e.preventDefault();
  document.querySelectorAll('.prov-drag-over,.prov-dragging').forEach(el => el.classList.remove('prov-drag-over','prov-dragging'));
  const fromId = _provDragId; _provDragId = null;
  _provDoReorder(fromId, targetId);
}
function provDragEnd() {
  document.querySelectorAll('.prov-drag-over,.prov-dragging').forEach(el => el.classList.remove('prov-drag-over','prov-dragging'));
  _provDragId = null;
}
function provTouchStart(e, id) {
  e.preventDefault();
  const touch = e.touches[0];
  const row = e.currentTarget.closest('[data-prov-id]');
  if (!row) return;
  const rect = row.getBoundingClientRect();
  const clone = row.cloneNode(true);
  Object.assign(clone.style, {position:'fixed',left:rect.left+'px',top:rect.top+'px',width:rect.width+'px',
    opacity:'0.85',zIndex:'9999',pointerEvents:'none',outline:'2px dashed var(--blue)',
    borderRadius:'4px',background:'var(--surface)',boxShadow:'0 4px 16px rgba(0,0,0,.18)',transition:'none'});
  document.body.appendChild(clone);
  row.style.opacity = '0.3';
  _provTouchState = {id, row, clone, offsetY: touch.clientY - rect.top, over: null};
  document.addEventListener('touchmove', _provTouchMove, {passive:false});
  document.addEventListener('touchend', _provTouchEnd);
}
function _provTouchMove(e) {
  e.preventDefault();
  if (!_provTouchState) return;
  const touch = e.touches[0];
  const {clone, offsetY} = _provTouchState;
  clone.style.top = (touch.clientY - offsetY) + 'px';
  clone.style.display = 'none';
  const under = document.elementFromPoint(touch.clientX, touch.clientY);
  clone.style.display = '';
  const targetRow = under?.closest('[data-prov-id]');
  document.querySelectorAll('.prov-drag-over').forEach(el => el.classList.remove('prov-drag-over'));
  if (targetRow && targetRow !== _provTouchState.row) {
    targetRow.classList.add('prov-drag-over');
    _provTouchState.over = targetRow;
  } else { _provTouchState.over = null; }
}
function _provTouchEnd() {
  document.removeEventListener('touchmove', _provTouchMove);
  document.removeEventListener('touchend', _provTouchEnd);
  if (!_provTouchState) return;
  const {id, row, clone, over} = _provTouchState;
  _provTouchState = null;
  clone.remove(); row.style.opacity = '';
  document.querySelectorAll('.prov-drag-over').forEach(el => el.classList.remove('prov-drag-over'));
  if (over) _provDoReorder(id, over.dataset.provId);
}
function _provDoReorder(fromId, toId) {
  if (!fromId || !toId || fromId === toId) return;
  const prov = getProvisionsData();
  const fromIdx = prov.items.findIndex(it => it.id === fromId);
  const toIdx   = prov.items.findIndex(it => it.id === toId);
  if (fromIdx === -1 || toIdx === -1) return;
  if (prov.items[fromIdx].category !== prov.items[toIdx].category) return;
  const [moved] = prov.items.splice(fromIdx, 1);
  prov.items.splice(prov.items.findIndex(it => it.id === toId), 0, moved);
  save();
  document.getElementById('mainContent').innerHTML = renderProvisions();
}

function provItemModal(item, idx, lockedCat) {
  const isEdit = item != null;
  const sub = ui.provisionsSub || 'all';
  const defaultCat = lockedCat || (sub !== 'all' ? sub : 'food');
  const e = item || {name:'', category:defaultCat, location:'', qty:0, minQty:0, unit:''};
  const catField = lockedCat
    ? `<div style="font-size:14px;color:var(--label);padding:8px 0 4px">${esc(PROV_CAT_LABELS[lockedCat]||lockedCat)}</div><input type="hidden" id="pv-cat" value="${esc(lockedCat)}">`
    : `<select class="mi" id="pv-cat">${PROV_CAT_ORDER.map(c=>`<option value="${c}" ${e.category===c?'selected':''}>${PROV_CAT_LABELS[c]}</option>`).join('')}</select>`;
  showModal(isEdit ? 'Edit Item' : 'Add Item', `
    <div class="mi-label">Name</div><input class="mi" id="pv-name" value="${esc(e.name)}" autofocus>
    <div class="mi-label">Category</div>
    ${catField}
    <div class="mi-label">Location on boat</div><input class="mi" id="pv-loc" value="${esc(e.location||'')}">
    <div class="mi-label">Unit (optional)</div><input class="mi" id="pv-unit" placeholder="bottles, cans, rolls…" value="${esc(e.unit||'')}">
    <div class="modal-btns">
      ${isEdit?`<button onclick="if(confirm('Delete this item?')){hideModal();provDelete(${idx})}" style="background:#FCEBEB;border:0.5px solid #F09595;color:#A32D2D;border-radius:8px;padding:8px 14px;font-family:var(--font);font-size:14px;font-weight:600;cursor:pointer;margin-right:auto">Delete</button>`:''}
      <button class="btn btn-s" onclick="hideModal()">Cancel</button>
      <button class="btn btn-p" onclick="provSave(${isEdit?idx:'null'})">${isEdit?'Save':'Add Item'}</button>
    </div>`);
}

function provAddModal() {
  const sub = ui.provisionsSub || 'all';
  const locked = sub !== 'all' ? sub : null;
  provItemModal(null, null, locked);
}
function provEdit(idx) { const prov = getProvisionsData(); provItemModal(prov.items[idx], idx); }

function provSave(idx) {
  const prov = getProvisionsData();
  const name = document.getElementById('pv-name')?.value.trim();
  if (!name) { showToast('Enter a name', true); return; }
  const category = document.getElementById('pv-cat')?.value || 'misc';
  const location = document.getElementById('pv-loc')?.value.trim() || '';
  const unit    = document.getElementById('pv-unit')?.value.trim() || '';
  if (idx != null && idx !== 'null') {
    prov.items[idx] = {...prov.items[idx], name, category, location, unit};
  } else {
    prov.items.push({id:uid(), name, category, location, unit});
  }
  if (prov.exampleDismissed === false) prov.exampleDismissed = true;
  save(); hideModal(); document.getElementById('mainContent').innerHTML = renderProvisions();
}

function provDelete(idx) {
  const prov = getProvisionsData();
  prov.items.splice(idx, 1);
  save(); document.getElementById('mainContent').innerHTML = renderProvisions();
}

function prefillProvisionsData() {
  const email = localStorage.getItem(EMAIL_KEY);
  if (email === OWNER_EMAIL) return false;
  const prov = data.provisions;
  if (prov && (prov.items?.length > 0 || prov.history?.length > 0)) return false;
  // Dates always land in the correct calendar month regardless of when the user registers
  const d1 = (() => { const d=new Date(); d.setDate(1); d.setMonth(d.getMonth()-1); d.setDate(12); return d.toISOString().slice(0,10); })();
  const d2 = (() => { const d=new Date(); d.setDate(5); return d.toISOString().slice(0,10); })();
  const s1 = 'Alpha Supermarket (Example)', s2 = 'Beta Market (Example)';
  const ph = (date, price, store) => [{date, price, store}];
  data.provisions = {
    exampleDismissed: false,
    items: [
      {id:'pv_ex1', name:'Pasta (Example)',            category:'food',       location:'Galley locker', unit:'packs'},
      {id:'pv_ex2', name:'Canned tomatoes (Example)',  category:'food',       location:'Galley locker', unit:'cans'},
      {id:'pv_ex3', name:'Olive oil (Example)',        category:'food',       location:'Galley',        unit:'bottles'},
      {id:'pv_ex4', name:'Sunscreen SPF50 (Example)', category:'toiletries', location:'Nav station',   unit:'bottles'},
      {id:'pv_ex5', name:'Toilet paper (Example)',     category:'toiletries', location:'Aft cabin',     unit:'rolls'},
      {id:'pv_ex6', name:'Dish soap (Example)',        category:'toiletries', location:'Galley',        unit:'bottles'},
    ],
    history: [
      // Receipt 1 — last month at s1
      {id:'pv_h_ex1',  name:'Pasta (Example)',            qty:2, unit:'packs',   category:'food',       lastPrice:2.50,  lastStore:s1, lastPurchaseDate:d1, priceHistory:ph(d1,2.50, s1),  importedAt:d1},
      {id:'pv_h_ex2',  name:'Canned tomatoes (Example)', qty:4, unit:'cans',    category:'food',       lastPrice:1.20,  lastStore:s1, lastPurchaseDate:d1, priceHistory:ph(d1,1.20, s1),  importedAt:d1},
      {id:'pv_h_ex3',  name:'Olive oil (Example)',        qty:1, unit:'bottles', category:'food',       lastPrice:8.90,  lastStore:s1, lastPurchaseDate:d1, priceHistory:ph(d1,8.90, s1),  importedAt:d1},
      {id:'pv_h_ex4',  name:'Toilet paper (Example)',    qty:1, unit:'packs',   category:'toiletries', lastPrice:5.40,  lastStore:s1, lastPurchaseDate:d1, priceHistory:ph(d1,5.40, s1),  importedAt:d1},
      {id:'pv_h_ex5',  name:'Dish soap (Example)',        qty:1, unit:'bottles', category:'toiletries', lastPrice:2.10,  lastStore:s1, lastPurchaseDate:d1, priceHistory:ph(d1,2.10, s1),  importedAt:d1},
      // Receipt 2 — this month at s2; 3 items overlap with Receipt 1 → store comparison + buying frequency in Insights
      {id:'pv_h_ex6',  name:'Pasta (Example)',            qty:2, unit:'packs',   category:'food',       lastPrice:2.80,  lastStore:s2, lastPurchaseDate:d2, priceHistory:ph(d2,2.80, s2),  importedAt:d2},
      {id:'pv_h_ex7',  name:'Olive oil (Example)',        qty:1, unit:'bottles', category:'food',       lastPrice:8.20,  lastStore:s2, lastPurchaseDate:d2, priceHistory:ph(d2,8.20, s2),  importedAt:d2},
      {id:'pv_h_ex8',  name:'Sunscreen SPF50 (Example)', qty:2, unit:'bottles', category:'toiletries', lastPrice:12.50, lastStore:s2, lastPurchaseDate:d2, priceHistory:ph(d2,12.50,s2),  importedAt:d2},
      {id:'pv_h_ex9',  name:'Dish soap (Example)',        qty:1, unit:'bottles', category:'toiletries', lastPrice:1.90,  lastStore:s2, lastPurchaseDate:d2, priceHistory:ph(d2,1.90, s2),  importedAt:d2},
      {id:'pv_h_ex10', name:'Coffee (Example)',            qty:1, unit:'packs',   category:'drinks',     lastPrice:4.50,  lastStore:s2, lastPurchaseDate:d2, priceHistory:ph(d2,4.50, s2),  importedAt:d2},
    ]
  };
  return true;
}

function prefillNewUserSampleData() {
  const email = localStorage.getItem(EMAIL_KEY);
  if (email === OWNER_EMAIL) return false;

  const dAgo = n => { const d = new Date(); d.setDate(d.getDate()-n); return d.toISOString().slice(0,10); };
  let dirty = false;

  // ── Vessel Doc ──
  if (!data.documents?.vessel?.vesselName) {
    if (!data.documents) data.documents = JSON.parse(JSON.stringify(EMPTY_DEFAULTS.documents));
    data.documents.vessel = {
      vesselName:'S/V Example', officialNumber:'EX-123456', imoNumber:'EX-IMO-0001',
      callSign:'EXMP1', hailingPort:'Example Port', flagRegistry:'Example Flag State',
      hullMaterial:'GRP Fiberglass', boatType:'Sailing Catamaran (Example)',
      grossTonnage:'14', netTonnage:'12', loa:'12.0m', breadth:'6.5m', depth:'1.2m',
      yearCompleted:'2015', placeBuilt:'Example Country',
      owners:'Example Owner', managingOwner:'Example Owner',
      issueDate:'2020-01-15', expiryDate:'2030-01-15',
      engine:'Example Diesel 30hp (×2)', registrationHistory:[]
    };
    dirty = true;
  }

  // ── Insurance ──
  if (!data.documents?.insurance?.insurer) {
    if (!data.documents) data.documents = JSON.parse(JSON.stringify(EMPTY_DEFAULTS.documents));
    data.documents.insurance = {
      insurer:'Example Insurance Co (Example)', policyNumber:'EX-POLICY-001',
      certNumber:'EX-CERT-001', issueDate:'2025-01-01', expiryDate:'2026-01-01',
      premium:'1,200',
      maxPersonalInjury:'€500,000 per person (Example)',
      maxMaterial:'€300,000 per accident (Example)',
      maxPollution:'€150,000 per accident (Example)',
      renewalHistory:[]
    };
    dirty = true;
  }

  // ── eTEPAY / Customs ──
  if (!data.documents?.customs?.holderName && !data.documents?.customs?.clearanceNumber) {
    if (!data.documents) data.documents = JSON.parse(JSON.stringify(EMPTY_DEFAULTS.documents));
    data.documents.customs = {
      holderName:'Example Owner', address:'123 Example Street, Example City',
      email:'owner@example.com', afm:'EX-TAX-001',
      customsOffice:'GR003102 - Syros', clearanceNumber:'EX-CLEAR-0001',
      paymentRef:'EX-PAY-0001', validUntil:'2026-11-01',
      applicationNumber:'EX-APP-0001', applicationDate:'01/04/2025', entryDate:'01/04/2025',
      year:'2025', monthsCovered:'April,May,June,July,August,September,October',
      amountPaid:'€0 (Example)', paymentCode:'EX-RF-00000000001',
      adminFeeCode:'EX-FEE-00000000001', status:'New',
      ownerPassportNumber:'EX-PASS-001', ownerPhone:'+1 555 0100',
      ownerAddress:'123 Example Street, Example City (Example)',
      renewalHistory:[]
    };
    dirty = true;
  }

  // ── Boat Docs / Transit Log ──
  if (!data.transitLog) data.transitLog = {};
  const tl = data.transitLog;
  if (!tl.logs) tl.logs = {};
  if (!tl.currentLog) tl.currentLog = 'tl_2526';
  const curLog = tl.logs[tl.currentLog];
  if (!curLog?.docNumber && !curLog?.vesselName && !curLog?.stamps?.length) {
    tl.currentLog = 'tl_2526';
    tl.logs['tl_2526'] = {
      season:'2025-2026', archived:false,
      stamps:[
        {id:uid(), date:dAgo(90), port:'Example Marina', type:'Arrival',   authority:'GR003102 - Syros', notes:'Example'},
        {id:uid(), date:dAgo(30), port:'Another Port',   type:'Departure', authority:'GR003102 - Syros', notes:'Example'},
      ],
      docNumber:'25GRDK310200000001', issueDate:dAgo(90), validFrom:dAgo(90), validUntil:'01/12/2026',
      customsAuthority:'GR003102 - Syros', validityType:'Limited (Ορισμένη)', prevDocCount:'0',
      otherNotes:'Example transit log — replace with your own data', provisions:'',
      vesselName:'S/V Example', flag:'US', portOfRegistry:'Example Port', regNumber:'EX123456',
      callSign:'EX1234', vesselType:'Sail Yacht', gt:'14', engine:'Example Diesel 30hp', loa:'12m',
      yearBuilt:'2015', yearFirstReg:'2015',
      ownerName:'Example Owner', holderName:'Example Owner', address:'', telephone:'', email:'', afm:'', idNumber:''
    };
    tl.logs['tl_2425'] = {
      season:'2024-2025', archived:true,
      stamps:[
        {id:uid(), date:'2024-10-05', port:'Barcelona',   type:'Arrival',   authority:'Spain Customs',   notes:'Example'},
        {id:uid(), date:'2025-04-20', port:'Palma',       type:'Departure', authority:'Spain Customs',   notes:'Example'},
      ],
      docNumber:'24GRDK310200000005', issueDate:'2024-10-01', validFrom:'2024-10-01', validUntil:'01/11/2025',
      customsAuthority:'GR003102 - Syros', validityType:'Limited (Ορισμένη)', prevDocCount:'0',
      otherNotes:'Example — past season', provisions:'',
      vesselName:'S/V Example', flag:'US', portOfRegistry:'Example Port', regNumber:'EX123456',
      callSign:'EX1234', vesselType:'Sail Yacht', gt:'14', engine:'Example Diesel 30hp', loa:'12m',
      yearBuilt:'2015', yearFirstReg:'2015',
      ownerName:'Example Owner', holderName:'Example Owner', address:'', telephone:'', email:'', afm:'', idNumber:''
    };
    dirty = true;
  }

  // ── Provisions ──
  if (!data.provisions?.items?.length) {
    data.provisions = {exampleDismissed:false, items:[
      {id:uid(), name:'Pasta (Example)',         category:'food',       location:'Galley locker',  qty:4,  minQty:6, unit:'packs'},
      {id:uid(), name:'Olive oil (Example)',     category:'food',       location:'Galley',         qty:2,  minQty:3, unit:'bottles'},
      {id:uid(), name:'Tomato sauce (Example)',  category:'food',       location:'Galley locker',  qty:6,  minQty:4, unit:'cans'},
      {id:uid(), name:'Rice (Example)',          category:'food',       location:'Galley locker',  qty:3,  minQty:4, unit:'packs'},
      {id:uid(), name:'Canned tuna (Example)',   category:'food',       location:'Galley locker',  qty:8,  minQty:6, unit:'cans'},
      {id:uid(), name:'Water 6L (Example)',      category:'drinks',     location:'Cockpit locker', qty:6,  minQty:4, unit:'bottles'},
      {id:uid(), name:'Wine (Example)',          category:'drinks',     location:'Galley locker',  qty:3,  minQty:2, unit:'bottles'},
      {id:uid(), name:'Beer (Example)',          category:'drinks',     location:'Fridge',         qty:12, minQty:6, unit:'cans'},
      {id:uid(), name:'Soap (Example)',          category:'toiletries', location:'Heads',          qty:3,  minQty:2, unit:'bars'},
      {id:uid(), name:'Shampoo (Example)',       category:'toiletries', location:'Heads',          qty:2,  minQty:2, unit:'bottles'},
      {id:uid(), name:'Dish soap (Example)',     category:'toiletries', location:'Galley',         qty:2,  minQty:2, unit:'bottles'},
      {id:uid(), name:'Sunscreen (Example)',     category:'misc',       location:'Nav station',    qty:2,  minQty:2, unit:'bottles'},
      {id:uid(), name:'Batteries AA (Example)',  category:'misc',       location:'Nav station',    qty:8,  minQty:4, unit:'pcs'},
    ]};
    dirty = true;
  }

  // ── Water Maker ──
  if (!data.watermaker?.currentReading) {
    data.watermaker = {
      currentReading:150, lastChangeReading:0, targetHours:200,
      charcoalChangedDate:dAgo(180), exampleDismissed:false,
      inventory:{micron20:2, micron5:1, charcoal:1}
    };
    dirty = true;
  }

  // ── LPG ──
  if (!data.lpg?.bottles?.length && !data.lpg?.history?.length) {
    data.lpg = {
      exampleDismissed:false,
      bottles:[
        {id:uid(), kg:11, full:true},
        {id:uid(), kg:11, full:false},
      ],
      history:[
        {id:uid(), date:dAgo(60), location:'Example Marina', bottles:1, kg:11, pricePerKg:1.80, notes:'Tank 1 refill (Example)'},
      ]
    };
    dirty = true;
  }

  // ── Engine Maintenance ──
  const realMaintEntries = (data.maintenance?.log||[]).filter(e => !e.id?.startsWith('seed_'));
  if (!realMaintEntries.length) {
    if (!data.maintenance) data.maintenance = {engines:{}, sched:{}, log:[]};
    if (!data.maintenance.engines) data.maintenance.engines = {};
    if (!data.maintenance.log) data.maintenance.log = [];
    ['port','starboard'].forEach(eid => {
      if (!data.maintenance.engines[eid]) data.maintenance.engines[eid] = {hours:0, schedule:[], log:[], customTasks:[]};
      data.maintenance.engines[eid].hours = 450;
    });
    const entries = [
      {id:uid(), date:dAgo(90),  hours:'300', task:'Engine oil', cost:'€85',  notes:'Example entry', engines:['port','starboard']},
      {id:uid(), date:dAgo(180), hours:'250', task:'Impeller',   cost:'€120', notes:'Example entry', engines:['port','starboard']},
      {id:uid(), date:dAgo(90),  hours:'300', task:'Gear oil',   cost:'€60',  notes:'Example entry', engines:['port','starboard']},
    ];
    entries.forEach(e => data.maintenance.log.unshift(e));
    if (!data.maintenance.sched) data.maintenance.sched = {};
    ['mt_oil','mt_sailoil','mt_impeller'].forEach(tid => {
      data.maintenance.sched[tid] = {};
      ['port','starboard'].forEach(eid => { data.maintenance.sched[tid][eid] = {lastDoneAt:300, date:dAgo(90)}; });
    });
    dirty = true;
  }

  // ── Schengen ──
  // Demonstrates the rolling 180-day window: Dec–Feb (60d) + Mar–Apr (30d) = 90d limit,
  // then a Jun entry that is an overstay. Dates are anchored to current year at runtime.
  if (!data.schengen?.persons?.some(p => p.name)) {
    const yr = new Date().getFullYear();
    const dt = (y, m, d) => `${y}-${String(m).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
    data.schengen = {persons:[{
      name:'Example Owner', activePassport:0,
      passports:[{flag:'🇺🇸', country:'United States', eu:false}],
      log:[
        {id:uid(), type:'in',  date:dt(yr-1,12,10), passport:'🇺🇸', location:'Gibraltar (Example)'},
        {id:uid(), type:'out', date:dt(yr,2,7),      passport:'',    location:'Gibraltar (Example)',          notes:'60 days — fine so far (Example)'},
        {id:uid(), type:'in',  date:dt(yr,3,20),     passport:'🇺🇸', location:'Palma de Mallorca (Example)'},
        {id:uid(), type:'out', date:dt(yr,4,19),     passport:'',    location:'Palma de Mallorca (Example)', notes:'30 days — 90 days total used in rolling window (Example)'},
        {id:uid(), type:'in',  date:dt(yr,6,4),      passport:'🇺🇸', location:'Sardinia (Example)',          notes:'Overstay — rolling 180-day window already has 90 days used (Example)'},
        {id:uid(), type:'out', date:dt(yr,6,18),     passport:'',    location:'Sardinia (Example)',           notes:'14 days overstay (Example)'},
      ]
    }]};
    dirty = true;
  }

  // ── Shipyard ──
  if (!data.shipyard?.history?.length && !data.shipyard?.quotes?.length) {
    if (!data.shipyard) data.shipyard = {};
    if (!data.shipyard.current) data.shipyard.current = {};
    data.shipyard.history = [
      {id:uid(), year:'2024/2025', name:'Example Boatyard',        location:'Example Marina', start:'2024-10-01', end:'2025-04-01', cost:'€2,800', notes:'Antifouling and hull inspection (Example)'},
      {id:uid(), year:'2023/2024', name:'Another Example Boatyard', location:'Example Port',   start:'2023-10-15', end:'2024-03-15', cost:'€3,500', notes:'Full haul out and engine service (Example)'},
    ];
    dirty = true;
  }

  // ── Winterize ──
  if (!data.winterization) {
    const mk = (text, checked) => ({id:uid(), text, asterisk:false, checked:!!checked, group:null});
    data.winterization = {currentSeason:'w2526', seasons:{w2526:{
      name:'Winter 2025/26', archived:false, sections:{
        winterize:  {items:[mk('Remove sails (Example)',true), mk('Change engine oil (Example)',true), mk('Flush raw water system (Example)'), mk('Remove impellers (Example)'), mk('Drain water tanks (Example)')]},
        needs:      {items:[mk('Engine oil (Example)'), mk('Fuel filters (Example)'), mk('Impeller kit (Example)')]},
        backOnBoard:{items:[mk('Connect shore power (Example)'), mk('Hoist sails (Example)'), mk('Watermaker flush (Example)')]}
      }
    }}};
    dirty = true;
  }

  // ── Upgrades & Repairs ──
  if (!data.upgrades?.seasons?.length) {
    const mk = (text, cost, done) => ({id:uid(), text, cost:cost||'', checked:!!done});
    data.upgrades = {version:UPGRADES_DATA_VERSION, seasons:[
      {id:uid(), name:'2024/2025', location:'Example Marina', items:[
        mk('Replaced engine impeller (Example)','120',true),
        mk('New shore power cable (Example)','85',false),
        mk('Antifouling repaint (Example)','380',false),
      ]}
    ]};
    dirty = true;
  }

  // ── Spare Parts (replace default ex_ entries) ──
  const hasRealParts = data.spareParts?.some(p => !p.id?.startsWith('ex_'));
  if (!hasRealParts) {
    data.spareParts = [
      {id:uid(), desc:'Impeller (raw water pump)',pn:'',category:'Yanmar Engine',qty:1,minQuantity:1,unitPrice:45, location:'Engine bay',notes:'Example'},
      {id:uid(), desc:'Engine oil filter',        pn:'',category:'Yanmar Engine',qty:2,minQuantity:1,unitPrice:12, location:'Engine bay',notes:'Example'},
      {id:uid(), desc:'Diesel fuel filter',       pn:'',category:'Yanmar Engine',qty:1,minQuantity:1,unitPrice:18, location:'Engine bay',notes:'Example'},
      {id:uid(), desc:'Hull zinc anodes',         pn:'',category:'Saildrive',    qty:4,minQuantity:2,unitPrice:8,  location:'Lazarette', notes:'Example'},
      {id:uid(), desc:'V-belts (alternator)',     pn:'',category:'Yanmar Engine',qty:2,minQuantity:1,unitPrice:15, location:'Engine bay',notes:'Example'},
    ];
    dirty = true;
  }

  // ── Systems (replace default ex_ entries) ──
  const hasRealSystems = data.systems?.some(s => !s.id?.startsWith('ex_'));
  if (!hasRealSystems) {
    data.systems = [
      {id:uid(), cat:'House Bank',             category:'House Bank',             make:'Victron Energy',  model:'LiFePO4 Smart 12.8V/200Ah (Example)',  serialNumber:'', location:'Hull battery locker', notes:'Example — update with your own details', installDate:'', lastService:'', warrantyExpiry:'', manualUrl:'', photos:[]},
      {id:uid(), cat:'Chartplotter & Displays',category:'Chartplotter & Displays',make:'Raymarine',       model:'Axiom 12 MFD (Example)',               serialNumber:'', location:'Helm station',       notes:'Example — update with your own details', installDate:'', lastService:'', warrantyExpiry:'', manualUrl:'', photos:[]},
      {id:uid(), cat:'Main Engines',           category:'Main Engines',           make:'Yanmar',          model:'3YM30 30HP Diesel (Example)',           serialNumber:'', location:'Engine room',        notes:'Example — update with your own details', installDate:'', lastService:'', warrantyExpiry:'', manualUrl:'', photos:[]},
      {id:uid(), cat:'Charge Controllers',     category:'Charge Controllers',     make:'Victron Energy',  model:'SmartSolar MPPT 100/30 (Example)',      serialNumber:'', location:'Below deck',         notes:'Example — update with your own details', installDate:'', lastService:'', warrantyExpiry:'', manualUrl:'', photos:[]},
      {id:uid(), cat:'Sensors & Network',      category:'Sensors & Network',      make:'Standard Horizon',model:'GX2200 Matrix VHF (Example)',           serialNumber:'', location:'Helm station',       notes:'Example — update with your own details', installDate:'', lastService:'', warrantyExpiry:'', manualUrl:'', photos:[]},
    ];
    dirty = true;
  }

  return dirty;
}

function prefillWatermakerData() {
  const email = localStorage.getItem(EMAIL_KEY);
  const wm = data.watermaker;
  if (wm && wm.currentReading) return false;
  if (!data.watermaker) data.watermaker = {};
  if (email === OWNER_EMAIL) {
    data.watermaker = {currentReading:1978, lastChangeReading:1925, targetHours:60, charcoalChangedDate:'2026-03-20', inventory:{micron20:3, micron5:1, charcoal:2}};
  } else {
    const dAgo = n => { const d = new Date(); d.setDate(d.getDate()-n); return d.toISOString().slice(0,10); };
    data.watermaker = {currentReading:20, lastChangeReading:0, targetHours:60, charcoalChangedDate:dAgo(120), inventory:{micron20:3, micron5:3, charcoal:3}, exampleDismissed:false};
  }
  return true;
}

function prefillShipyardData() {
  if (localStorage.getItem(EMAIL_KEY) === OWNER_EMAIL) return false;
  if (!data.shipyard) data.shipyard = {};
  const sy = data.shipyard;
  const hasCurrent = !!(sy.current?.name);
  const hasQuotes  = !!(sy.quotes?.length);
  const hasHistory = !!(sy.history?.length);
  if (hasCurrent && hasQuotes && hasHistory) return false;

  const dRel = (yearsAgo, extraDays = 0) => {
    const d = new Date();
    d.setFullYear(d.getFullYear() - yearsAgo);
    d.setDate(d.getDate() + extraDays);
    return d.toISOString().slice(0, 10);
  };
  const seasonLabel = yearsAgo => {
    const y = new Date().getFullYear() - yearsAgo;
    return `${y}/${y + 1}`;
  };
  const dAbs = offsetDays => {
    const d = new Date();
    d.setDate(d.getDate() + offsetDays);
    return d.toISOString().slice(0, 10);
  };

  if (!hasCurrent) {
    data.shipyard.current = {
      name:         'Palma Boat Yard (Example)',
      location:     'Palma de Mallorca, Spain',
      startDate:    dAbs(-25),
      endDate:      dAbs(5),
      actualCost:   '€3,500',
      depositPaid:  '€1,200',
      balanceDue:   '€2,300',
      notes:        'Annual haul-out. Antifouling bottom paint, hull inspection, anode replacement, propeller polish (Example)',
    };
  }

  if (!hasQuotes) {
    data.shipyard.quotes = [
      {
        id: uid(),
        name:     'Palma Boat Yard (Example)',
        location: 'Palma de Mallorca, Spain',
        price:    '€3,500',
        notes:    'Antifouling + hull inspection + anodes (Example)',
        selected: true,
      },
      {
        id: uid(),
        name:     'Port Adriano Marina (Example)',
        location: 'Calvià, Mallorca',
        price:    '€4,100',
        notes:    'Full antifouling + osmosis treatment + anodes (Example)',
        selected: false,
      },
      {
        id: uid(),
        name:     'Club de Mar (Example)',
        location: 'Palma de Mallorca, Spain',
        price:    '€2,950',
        notes:    'Basic antifouling only, no extras (Example)',
        selected: false,
      },
    ];
  }

  if (!hasHistory) {
    data.shipyard.history = [
      {
        id: uid(),
        year:     seasonLabel(2),
        name:     'Gouvia Marina Boatyard (Example)',
        location: 'Corfu, Greece',
        start:    dRel(2),
        end:      dRel(2, 18),
        cost:     '€2,800',
        notes:    'Antifouling, hull inspection, saildrive service, cutlass bearing replacement (Example)',
      },
      {
        id: uid(),
        year:     seasonLabel(1),
        name:     'Marina de Lagos (Example)',
        location: 'Lagos, Portugal',
        start:    dRel(1),
        end:      dRel(1, 14),
        cost:     '€3,100',
        notes:    'Antifouling, waterline repaint, propeller polish, engine raw-water impeller (Example)',
      },
    ];
  }
  return true;
}

function prefillSchengenData() {
  const email = localStorage.getItem(EMAIL_KEY);
  if (email === OWNER_EMAIL) {
    const fp = data.schengen?.persons?.[0];
    const euOk = fp?.passports?.some(pp => pp.flag === '🇪🇺' && pp.eu === true);
    const usOk = fp?.passports?.some(pp => pp.flag === '🇺🇸' && pp.eu === false);
    if (fp?.name && euOk && usOk) return false;
    const odPersons = (typeof OROBORO_DATA !== 'undefined') ? (OROBORO_DATA.schengen?.persons || []) : [];
    if (!odPersons.length) return false;
    data.schengen = { persons: odPersons.map(p => ({
      ...p, log: (p.log || []).map(e => ({...e, id:uid()}))
    }))};
    return true;
  }
  // Non-owner: seed example travellers if empty
  if (data.schengen?.persons?.some(p => p.name)) return false;
  const dAgo = n => { const d = new Date(); d.setDate(d.getDate()-n); return d.toISOString().slice(0,10); };
  data.schengen = { persons: [
    { name:'Alex Smith', activePassport:0,
      passports:[
        {flag:'🇺🇸', country:'United States', eu:false},
        {flag:'🇦🇺', country:'Australia',     eu:false}
      ],
      log:[
        {id:uid(), type:'in',  date:dAgo(180), passport:'🇺🇸', location:'Spain (Barcelona)'},
        {id:uid(), type:'out', date:dAgo(120), passport:'',    location:'Morocco'},
        {id:uid(), type:'in',  date:dAgo(60),  passport:'🇺🇸', location:'Greece (Athens)'},
        {id:uid(), type:'out', date:dAgo(30),  passport:'',    location:'Turkey (Bodrum)'}
      ]
    },
    { name:'Maria Santos', activePassport:0,
      passports:[
        {flag:'🇬🇧', country:'United Kingdom', eu:false}
      ],
      log:[
        {id:uid(), type:'in',  date:dAgo(90), passport:'🇬🇧', location:'France (Marseille)'},
        {id:uid(), type:'out', date:dAgo(45), passport:'',    location:'Tunisia'}
      ]
    }
  ]};
  return true;
}

function partsDragStart(e, id) {
  if (e.target.closest('button,input,select,a')) { e.preventDefault(); return; }
  _partsDragId = id;
  e.dataTransfer.effectAllowed = 'move';
  e.dataTransfer.setData('text/plain', id);
  setTimeout(() => document.querySelector(`[data-parts-id="${id}"]`)?.classList.add('prov-dragging'), 0);
}
function partsDragOver(e, id) {
  if (!_partsDragId || _partsDragId === id) return;
  e.preventDefault(); e.dataTransfer.dropEffect = 'move';
  document.querySelectorAll('.prov-drag-over').forEach(el => el.classList.remove('prov-drag-over'));
  e.currentTarget.classList.add('prov-drag-over');
}
function partsDragLeave(e) { if (!e.currentTarget.contains(e.relatedTarget)) e.currentTarget.classList.remove('prov-drag-over'); }
function partsDrop(e, targetId) {
  e.preventDefault();
  document.querySelectorAll('.prov-drag-over,.prov-dragging').forEach(el => el.classList.remove('prov-drag-over','prov-dragging'));
  const fromId = _partsDragId; _partsDragId = null;
  _partsDoReorder(fromId, targetId);
}
function partsDragEnd() {
  document.querySelectorAll('.prov-drag-over,.prov-dragging').forEach(el => el.classList.remove('prov-drag-over','prov-dragging'));
  _partsDragId = null;
}
function partsTouchStart(e, id) {
  e.preventDefault();
  const touch = e.touches[0], row = e.currentTarget.closest('[data-parts-id]'); if (!row) return;
  const rect = row.getBoundingClientRect(), clone = row.cloneNode(true);
  Object.assign(clone.style, {position:'fixed',left:rect.left+'px',top:rect.top+'px',width:rect.width+'px',opacity:'0.85',zIndex:'9999',pointerEvents:'none',outline:'2px dashed var(--blue)',borderRadius:'4px',background:'var(--surface)',boxShadow:'0 4px 16px rgba(0,0,0,.18)',transition:'none'});
  document.body.appendChild(clone); row.style.opacity = '0.3';
  _partsTouchState = {id, row, clone, offsetY: touch.clientY - rect.top, over: null};
  document.addEventListener('touchmove', _partsTouchMove, {passive:false});
  document.addEventListener('touchend', _partsTouchEnd);
}
function _partsTouchMove(e) {
  e.preventDefault(); if (!_partsTouchState) return;
  const touch = e.touches[0], {clone, offsetY} = _partsTouchState;
  clone.style.top = (touch.clientY - offsetY) + 'px';
  clone.style.display = 'none';
  const under = document.elementFromPoint(touch.clientX, touch.clientY);
  clone.style.display = '';
  const targetRow = under?.closest('[data-parts-id]');
  document.querySelectorAll('.prov-drag-over').forEach(el => el.classList.remove('prov-drag-over'));
  if (targetRow && targetRow !== _partsTouchState.row) { targetRow.classList.add('prov-drag-over'); _partsTouchState.over = targetRow; }
  else { _partsTouchState.over = null; }
}
function _partsTouchEnd() {
  document.removeEventListener('touchmove', _partsTouchMove); document.removeEventListener('touchend', _partsTouchEnd);
  if (!_partsTouchState) return;
  const {id, row, clone, over} = _partsTouchState; _partsTouchState = null;
  clone.remove(); row.style.opacity = '';
  document.querySelectorAll('.prov-drag-over').forEach(el => el.classList.remove('prov-drag-over'));
  if (over) _partsDoReorder(id, over.dataset.partsId);
}
function _partsDoReorder(fromId, toId) {
  if (!fromId || !toId || fromId === toId) return;
  const parts = data.spareParts || [];
  const fromIdx = parts.findIndex(p => p.id === fromId);
  if (fromIdx === -1 || parts.findIndex(p => p.id === toId) === -1) return;
  const [moved] = parts.splice(fromIdx, 1);
  parts.splice(parts.findIndex(p => p.id === toId), 0, moved);
  save(); document.getElementById('mainContent').innerHTML = renderParts();
}

function renderParts() {
  const parts = data.spareParts || [];
  const q = ui.partsSearch.toLowerCase();
  const cat = ui.partsFilter;
  const customCats = parts.map(p => normCat(p.category)).filter(c => c && !PART_CATEGORIES.includes(c));
  const cats = ['All', ...PART_CATEGORIES, ...new Set(customCats)];
  const filtered = parts.filter(p => {
    const matchQ = !q || p.desc?.toLowerCase().includes(q) || p.pn?.toLowerCase().includes(q);
    const matchC = cat === 'All' || normCat(p.category) === cat;
    return matchQ && matchC;
  });
  const totalValue = parts.reduce((s,p) => s + (p.qty||0)*(p.unitPrice||0), 0).toFixed(2);

  return `
    <div class="parts-top">
      <input class="search-box" placeholder="🔍 Search parts…" value="${esc(ui.partsSearch)}"
        oninput="ui.partsSearch=this.value;document.getElementById('mainContent').innerHTML=renderParts()">
    </div>
    <div class="subtab-bar" style="margin-bottom:10px">
      ${cats.map(c => `<div class="pill ${ui.partsFilter===c?'active':''}"
        onclick="ui.partsFilter='${esc(c)}';document.getElementById('mainContent').innerHTML=renderParts()">${esc(c)}</div>`).join('')}
    </div>
    <div class="btn-row" style="padding:0 0 10px">
      <button class="btn btn-p btn-sm" onclick="showAddPart()">+ Add Part</button>
    </div>
    <div class="card">
      <div class="card-hd">${filtered.length} items${cat!=='All'?' ('+cat+')':''}</div>
      <div class="card-body">
        ${filtered.map(p => {
          const low = (p.qty||0) <= (p.minQuantity||0);
          const idx = parts.indexOf(p);
          const storeDisplay = p.storeUrl
            ? `<a href="${esc(p.storeUrl)}" target="_blank" rel="noopener" style="color:var(--blue)">${esc(p.location||'Shop')}</a>`
            : esc(p.location||'');
          const meta = [p.pn?esc(p.pn):null, esc(normCat(p.category)), storeDisplay||null, `€${p.unitPrice||0}`].filter(Boolean).join(' · ');
          return `<div class="part-row" data-parts-id="${p.id}" draggable="true" ondragstart="partsDragStart(event,'${p.id}')" ondragover="partsDragOver(event,'${p.id}')" ondragleave="partsDragLeave(event)" ondrop="partsDrop(event,'${p.id}')" ondragend="partsDragEnd()">
            <span class="prov-grip" ontouchstart="partsTouchStart(event,'${p.id}')">⠿</span>
            <div class="qty-wrap">
              <button class="qb" onclick="adjQty(${idx},-1)">−</button>
              <div class="qn ${low?'low':''}">${p.qty||0}</div>
              <button class="qb" onclick="adjQty(${idx},1)">+</button>
            </div>
            <div class="p-info">
              <div class="p-desc">${esc(p.desc)} ${low?`<span class="badge b-red">Low</span>`:''}</div>
              <div class="p-meta">${meta}</div>
            </div>
            <button class="no-print" style="background:none;border:none;padding:2px 4px;cursor:pointer;font-size:14px;color:var(--label3);line-height:1;flex-shrink:0;margin-right:4px" onclick="showEditPart(${idx})">✏️</button>
          </div>`;
        }).join('') || '<div style="padding:16px;color:var(--label3)">No parts — tap + Add Part to get started</div>'}
      </div>
      <div class="parts-footer">Total inventory value: €${totalValue}</div>
    </div>`;
}

function adjQty(i, delta) {
  if (!data.spareParts?.[i]) return;
  data.spareParts[i].qty = Math.max(0, (data.spareParts[i].qty||0) + delta);
  save(); document.getElementById('mainContent').innerHTML = renderParts();
}
function removePart(i) {
  data.spareParts.splice(i,1); save();
  document.getElementById('mainContent').innerHTML = renderParts();
}

const PART_CATEGORIES = ['Yanmar Engine','Saildrive','Water Maker','Oils & Fluids','Outboard','Plumbing'];

function partCatSelChange() {
  const sel  = document.getElementById('m-pc-sel')?.value;
  const wrap = document.getElementById('m-pc-custom-wrap');
  if (wrap) wrap.style.display = sel === 'Custom' ? 'block' : 'none';
}

function getPartCategory() {
  const sel = document.getElementById('m-pc-sel')?.value;
  if (sel === 'Custom') return (document.getElementById('m-pc')?.value || '').trim();
  return sel || '';
}

function _partModalFields(p) {
  const cur      = p.category || '';
  const isCustom = cur !== '' && !PART_CATEGORIES.includes(cur);
  const selVal   = isCustom ? 'Custom' : (cur || PART_CATEGORIES[0]);
  const opts     = PART_CATEGORIES.map(c =>
    `<option value="${c}" ${c===selVal?'selected':''}>${c}</option>`
  ).join('') + `<option value="Custom" ${selVal==='Custom'?'selected':''}>Custom…</option>`;
  return `
    <div class="mi-label">Description</div><input class="mi" id="m-pd" placeholder="Part description" value="${esc(p.desc||'')}">
    <div class="mi-label">Part Number</div><input class="mi" id="m-ppn" placeholder="Optional" value="${esc(p.pn||'')}">
    <div class="mi-label">Category</div>
    <select class="mi" id="m-pc-sel" onchange="partCatSelChange()">${opts}</select>
    <div id="m-pc-custom-wrap" style="display:${isCustom?'block':'none'};margin-top:6px">
      <input class="mi" id="m-pc" placeholder="Category name" value="${esc(isCustom?cur:'')}">
    </div>
    <div class="mi-label">Quantity</div><input class="mi" id="m-pq" type="number" value="${p.qty??1}" min="0">
    <div class="mi-label">Min Quantity</div><input class="mi" id="m-pmq" type="number" value="${p.minQuantity??1}" min="0">
    <div class="mi-label">Unit Price (€)</div><input class="mi" id="m-pp2" type="number" value="${p.unitPrice??0}" min="0" step="0.01">
    <div class="mi-label">From Store</div><input class="mi" id="m-pl" placeholder="e.g. Yanmar dealer" value="${esc(p.location||'')}">
    <div class="mi-label">Store URL</div><input class="mi" id="m-purl" type="url" placeholder="https://…" value="${esc(p.storeUrl||'')}">`;
}

function showAddPart() {
  showModal('Add Spare Part', `
    ${_partModalFields({})}
    <div class="modal-btns">
      <button class="btn btn-s" onclick="hideModal()">Cancel</button>
      <button class="btn btn-p" onclick="savePart()">Add</button>
    </div>`);
}
function savePart() {
  if (!data.spareParts) data.spareParts = [];
  data.spareParts.push({
    id:uid(),
    desc:document.getElementById('m-pd').value,
    pn:document.getElementById('m-ppn').value,
    category:getPartCategory(),
    qty:parseInt(document.getElementById('m-pq').value)||0,
    minQuantity:parseInt(document.getElementById('m-pmq').value)||0,
    unitPrice:parseFloat(document.getElementById('m-pp2').value)||0,
    location:document.getElementById('m-pl').value,
    storeUrl:document.getElementById('m-purl').value,
  });
  save(); hideModal(); document.getElementById('mainContent').innerHTML = renderParts();
}
function showEditPart(idx) {
  const p = data.spareParts?.[idx]; if (!p) return;
  showModal('Edit Part', `
    ${_partModalFields(p)}
    <div class="modal-btns">
      <button onclick="if(confirm('Remove this part?')){hideModal();removePart(${idx})}" style="background:#FCEBEB;border:0.5px solid #F09595;color:#A32D2D;border-radius:8px;padding:8px 14px;font-family:var(--font);font-size:14px;font-weight:600;cursor:pointer;margin-right:auto">Delete</button>
      <button class="btn btn-s" onclick="hideModal()">Cancel</button>
      <button class="btn btn-p" onclick="saveEditedPart(${idx})">Save</button>
    </div>`);
}
function saveEditedPart(idx) {
  if (!data.spareParts?.[idx]) return;
  Object.assign(data.spareParts[idx], {
    desc:document.getElementById('m-pd').value,
    pn:document.getElementById('m-ppn').value,
    category:getPartCategory(),
    qty:parseInt(document.getElementById('m-pq').value)||0,
    minQuantity:parseInt(document.getElementById('m-pmq').value)||0,
    unitPrice:parseFloat(document.getElementById('m-pp2').value)||0,
    location:document.getElementById('m-pl').value,
    storeUrl:document.getElementById('m-purl').value,
  });
  save(); hideModal(); document.getElementById('mainContent').innerHTML = renderParts();
}

// ═══════════════════════════════════════════════════════════
//  SAFETY TAB
// ═══════════════════════════════════════════════════════════

function safetyStatusBadge(expiry) {
  if (!expiry) return '';
  const d = daysUntil(expiry);
  if (d < 0) return '<span class="badge b-red">Expired</span>';
  if (d <= 180) { const m = Math.max(1, Math.ceil(d/30)); return `<span class="badge b-orange">${m} month${m!==1?'s':''}</span>`; }
  return '<span class="badge b-green">OK</span>';
}

function renderSafety() {
  if (!data.safety) data.safety = { flares:[], lifeRafts:[] };
  const flares = data.safety.flares || [];
  const rafts  = data.safety.lifeRafts || [];

  const expiredFlares = flares.filter(f => f.expiry && daysUntil(f.expiry) < 0);
  const alertHtml = expiredFlares.length
    ? `<div style="margin-bottom:12px;padding:10px 14px;background:rgba(239,68,68,.08);border:0.5px solid #EF4444;border-radius:10px;font-size:13px;color:#EF4444;font-weight:600">🔴 ${expiredFlares.length} flare type${expiredFlares.length!==1?'s':''} expired — replace immediately</div>`
    : '';

  const flareRowsHtml = flares.length ? flares.map(f => {
    const expired = f.expiry && daysUntil(f.expiry) < 0;
    return `<div class="part-row" data-safety-flare-id="${f.id}" draggable="true"
      ondragstart="safetyFlareDragStart(event,'${f.id}')"
      ondragover="safetyFlareDragOver(event,'${f.id}')"
      ondragleave="safetyFlareDragLeave(event)"
      ondrop="safetyFlareDrop(event,'${f.id}')"
      ondragend="safetyFlareDragEnd()">
      <span class="prov-grip" ontouchstart="safetyFlareTouchStart(event,'${f.id}')">⠿</span>
      <div class="qty-wrap">
        <button class="qb" onclick="adjFlareQty('${f.id}',-1)">−</button>
        <div class="qn"${expired?' style="color:var(--red)"':''}>${f.qty||0}</div>
        <button class="qb" onclick="adjFlareQty('${f.id}',1)">+</button>
      </div>
      <div class="p-info">
        <div class="p-desc">${esc(f.type||'—')} ${safetyStatusBadge(f.expiry)}</div>
        <div class="p-meta">${f.expiry?esc(fmtDate(f.expiry)):'No expiry set'}${f.notes?' · '+esc(f.notes):''}</div>
      </div>
      <button class="no-print" style="background:none;border:none;padding:2px 4px;cursor:pointer;font-size:14px;color:var(--label3);line-height:1;flex-shrink:0;margin-right:4px" onclick="showEditFlare('${f.id}')">✏️</button>
    </div>`;
  }).join('') : '<div style="padding:16px;color:var(--label3)">No flares — tap + Add to get started</div>';

  const raftRowsHtml = rafts.length ? rafts.map((r, idx) => {
    const raftName = [r.brand,r.model].filter(Boolean).join(' ') || '—';
    const revisions = r.revisions || [];
    const revRows = revisions.map(rev => `
      <div style="display:flex;align-items:center;gap:10px;padding:6px 14px 6px 50px;border-top:1px solid var(--sep)">
        <div class="p-info"><div style="font-size:12px;color:var(--label2)">${esc(fmtDate(rev.date)||rev.date||'—')}${rev.notes?' · '+esc(rev.notes):''}</div></div>
        <button class="no-print" style="background:none;border:none;padding:2px 4px;cursor:pointer;font-size:14px;color:var(--label3);line-height:1;flex-shrink:0" onclick="showEditRevision('${r.id}','${rev.id}')">✏️</button>
      </div>`).join('');
    const isLast = idx === rafts.length - 1;
    return `<div data-safety-raft-id="${r.id}" draggable="true"${isLast?'':' style="border-bottom:1px solid var(--sep)"'}
      ondragstart="safetyRaftDragStart(event,'${r.id}')"
      ondragover="safetyRaftDragOver(event,'${r.id}')"
      ondragleave="safetyRaftDragLeave(event)"
      ondrop="safetyRaftDrop(event,'${r.id}')"
      ondragend="safetyRaftDragEnd()">
      <div class="part-row" style="border-bottom:none">
        <span class="prov-grip" ontouchstart="safetyRaftTouchStart(event,'${r.id}')">⠿</span>
        <div class="p-info">
          <div class="p-desc">${esc(raftName)} · ${r.persons||'—'} persons ${safetyStatusBadge(r.expiry)}</div>
          <div class="p-meta">${r.expiry?esc(fmtDate(r.expiry)):'No expiry set'}${r.serialNumber?' · S/N: '+esc(r.serialNumber):''}</div>
        </div>
        <button class="no-print" style="background:none;border:none;padding:2px 4px;cursor:pointer;font-size:14px;color:var(--label3);line-height:1;flex-shrink:0;margin-right:4px" onclick="showEditRaft('${r.id}')">✏️</button>
      </div>
      <div style="background:var(--surface2)">
        ${revRows}
        <div style="padding:6px 14px 6px 50px${revRows?';border-top:1px solid var(--sep)':''}">
          <button class="btn btn-s btn-xs" onclick="showAddRevision('${r.id}')">+ Add revision</button>
        </div>
      </div>
    </div>`;
  }).join('') : '<div style="padding:16px;color:var(--label3)">No life rafts — tap + Add to get started</div>';

  return `${alertHtml}
    <div class="card" style="margin-bottom:14px">
      <div class="card-hd" style="display:flex;align-items:center;justify-content:space-between">
        <span>Flares <span style="color:var(--blue);font-weight:700">${flares.length} ITEMS</span></span>
        <button class="btn btn-p btn-sm" onclick="showAddFlare()">+ Add</button>
      </div>
      <div style="padding:0">${flareRowsHtml}</div>
    </div>
    <div class="card">
      <div class="card-hd" style="display:flex;align-items:center;justify-content:space-between">
        <span>Life Rafts <span style="color:var(--blue);font-weight:700">${rafts.length} ITEMS</span></span>
        <button class="btn btn-p btn-sm" onclick="showAddRaft()">+ Add</button>
      </div>
      <div style="padding:0">${raftRowsHtml}</div>
    </div>`;
}

// ── Flare qty ──
function adjFlareQty(id, delta) {
  const f = (data.safety?.flares||[]).find(f=>f.id===id); if (!f) return;
  f.qty = Math.max(0, (f.qty||0)+delta);
  save(); document.getElementById('mainContent').innerHTML = renderSafety();
}

// ── Flare modals ──
function showAddFlare() {
  showModal('Add Flare', `
    <div class="mi-label">Type</div><input class="mi" id="sf-type" placeholder="e.g. Red hand flare">
    <div class="mi-label">Quantity</div><input class="mi" id="sf-qty" type="number" value="1" min="0">
    <div class="mi-label">Expiry Date</div><input class="mi" id="sf-exp" type="date">
    <div class="mi-label">Notes</div><input class="mi" id="sf-notes" placeholder="Optional">
    <div class="modal-btns">
      <button class="btn btn-s" onclick="hideModal()">Cancel</button>
      <button class="btn btn-p" onclick="saveFlare()">Add</button>
    </div>`);
}
function saveFlare() {
  if (!data.safety) data.safety = {flares:[],lifeRafts:[]};
  if (!data.safety.flares) data.safety.flares = [];
  data.safety.flares.push({id:uid(), type:document.getElementById('sf-type').value.trim(), qty:parseInt(document.getElementById('sf-qty').value)||0, expiry:document.getElementById('sf-exp').value, notes:document.getElementById('sf-notes').value.trim()});
  save(); hideModal(); document.getElementById('mainContent').innerHTML = renderSafety();
}
function showEditFlare(id) {
  const f = (data.safety?.flares||[]).find(f=>f.id===id); if (!f) return;
  showModal('Edit Flare', `
    <div class="mi-label">Type</div><input class="mi" id="sf-type" value="${esc(f.type||'')}">
    <div class="mi-label">Quantity</div><input class="mi" id="sf-qty" type="number" value="${f.qty||0}" min="0">
    <div class="mi-label">Expiry Date</div><input class="mi" id="sf-exp" type="date" value="${esc(f.expiry||'')}">
    <div class="mi-label">Notes</div><input class="mi" id="sf-notes" value="${esc(f.notes||'')}">
    <div class="modal-btns">
      <button onclick="if(confirm('Delete this flare?')){hideModal();removeFlare('${id}')}" style="background:#FCEBEB;border:0.5px solid #F09595;color:#A32D2D;border-radius:8px;padding:8px 14px;font-family:var(--font);font-size:14px;font-weight:600;cursor:pointer;margin-right:auto">Delete</button>
      <button class="btn btn-s" onclick="hideModal()">Cancel</button>
      <button class="btn btn-p" onclick="saveEditFlare('${id}')">Save</button>
    </div>`);
}
function saveEditFlare(id) {
  const f = (data.safety?.flares||[]).find(f=>f.id===id); if (!f) return;
  f.type=document.getElementById('sf-type').value.trim(); f.qty=parseInt(document.getElementById('sf-qty').value)||0;
  f.expiry=document.getElementById('sf-exp').value; f.notes=document.getElementById('sf-notes').value.trim();
  save(); hideModal(); document.getElementById('mainContent').innerHTML = renderSafety();
}
function removeFlare(id) {
  if (!data.safety?.flares) return;
  data.safety.flares = data.safety.flares.filter(f=>f.id!==id);
  save(); document.getElementById('mainContent').innerHTML = renderSafety();
}

// ── Raft modals ──
function showAddRaft() {
  showModal('Add Life Raft', `
    <div class="mi-label">Brand</div><input class="mi" id="sr-brand" placeholder="e.g. Survitec">
    <div class="mi-label">Model</div><input class="mi" id="sr-model" placeholder="e.g. Ocean ISO 6">
    <div class="mi-label">Persons</div><input class="mi" id="sr-persons" type="number" value="6" min="1">
    <div class="mi-label">Expiry Date</div><input class="mi" id="sr-exp" type="date">
    <div class="mi-label">Serial Number</div><input class="mi" id="sr-sn" placeholder="Optional">
    <div class="mi-label">Notes</div><input class="mi" id="sr-notes" placeholder="Optional">
    <div class="modal-btns">
      <button class="btn btn-s" onclick="hideModal()">Cancel</button>
      <button class="btn btn-p" onclick="saveRaft()">Add</button>
    </div>`);
}
function saveRaft() {
  if (!data.safety) data.safety = {flares:[],lifeRafts:[]};
  if (!data.safety.lifeRafts) data.safety.lifeRafts = [];
  data.safety.lifeRafts.push({id:uid(), brand:document.getElementById('sr-brand').value.trim(), model:document.getElementById('sr-model').value.trim(), persons:parseInt(document.getElementById('sr-persons').value)||0, expiry:document.getElementById('sr-exp').value, serialNumber:document.getElementById('sr-sn').value.trim(), notes:document.getElementById('sr-notes').value.trim(), revisions:[]});
  save(); hideModal(); document.getElementById('mainContent').innerHTML = renderSafety();
}
function showEditRaft(id) {
  const r = (data.safety?.lifeRafts||[]).find(r=>r.id===id); if (!r) return;
  showModal('Edit Life Raft', `
    <div class="mi-label">Brand</div><input class="mi" id="sr-brand" value="${esc(r.brand||'')}">
    <div class="mi-label">Model</div><input class="mi" id="sr-model" value="${esc(r.model||'')}">
    <div class="mi-label">Persons</div><input class="mi" id="sr-persons" type="number" value="${r.persons||6}" min="1">
    <div class="mi-label">Expiry Date</div><input class="mi" id="sr-exp" type="date" value="${esc(r.expiry||'')}">
    <div class="mi-label">Serial Number</div><input class="mi" id="sr-sn" value="${esc(r.serialNumber||'')}">
    <div class="mi-label">Notes</div><input class="mi" id="sr-notes" value="${esc(r.notes||'')}">
    <div class="modal-btns">
      <button onclick="if(confirm('Delete this life raft?')){hideModal();removeRaft('${id}')}" style="background:#FCEBEB;border:0.5px solid #F09595;color:#A32D2D;border-radius:8px;padding:8px 14px;font-family:var(--font);font-size:14px;font-weight:600;cursor:pointer;margin-right:auto">Delete</button>
      <button class="btn btn-s" onclick="hideModal()">Cancel</button>
      <button class="btn btn-p" onclick="saveEditRaft('${id}')">Save</button>
    </div>`);
}
function saveEditRaft(id) {
  const r = (data.safety?.lifeRafts||[]).find(r=>r.id===id); if (!r) return;
  r.brand=document.getElementById('sr-brand').value.trim(); r.model=document.getElementById('sr-model').value.trim();
  r.persons=parseInt(document.getElementById('sr-persons').value)||0; r.expiry=document.getElementById('sr-exp').value;
  r.serialNumber=document.getElementById('sr-sn').value.trim(); r.notes=document.getElementById('sr-notes').value.trim();
  save(); hideModal(); document.getElementById('mainContent').innerHTML = renderSafety();
}
function removeRaft(id) {
  if (!data.safety?.lifeRafts) return;
  data.safety.lifeRafts = data.safety.lifeRafts.filter(r=>r.id!==id);
  save(); document.getElementById('mainContent').innerHTML = renderSafety();
}

// ── Revision modals ──
function showAddRevision(raftId) {
  const today = new Date().toISOString().slice(0,10);
  showModal('Add Revision', `
    <div class="mi-label">Date</div><input class="mi" id="srv-date" type="date" value="${today}">
    <div class="mi-label">Notes</div><input class="mi" id="srv-notes" placeholder="e.g. Annual service">
    <div class="modal-btns">
      <button class="btn btn-s" onclick="hideModal()">Cancel</button>
      <button class="btn btn-p" onclick="saveRevision('${raftId}')">Add</button>
    </div>`);
}
function saveRevision(raftId) {
  const r = (data.safety?.lifeRafts||[]).find(r=>r.id===raftId); if (!r) return;
  if (!r.revisions) r.revisions = [];
  r.revisions.push({id:uid(), date:document.getElementById('srv-date').value, notes:document.getElementById('srv-notes').value.trim()});
  save(); hideModal(); document.getElementById('mainContent').innerHTML = renderSafety();
}
function showEditRevision(raftId, revId) {
  const r = (data.safety?.lifeRafts||[]).find(r=>r.id===raftId); if (!r) return;
  const rev = (r.revisions||[]).find(rv=>rv.id===revId); if (!rev) return;
  showModal('Edit Revision', `
    <div class="mi-label">Date</div><input class="mi" id="srv-date" type="date" value="${esc(rev.date||'')}">
    <div class="mi-label">Notes</div><input class="mi" id="srv-notes" value="${esc(rev.notes||'')}">
    <div class="modal-btns">
      <button onclick="if(confirm('Delete this revision?')){hideModal();removeRevision('${raftId}','${revId}')}" style="background:#FCEBEB;border:0.5px solid #F09595;color:#A32D2D;border-radius:8px;padding:8px 14px;font-family:var(--font);font-size:14px;font-weight:600;cursor:pointer;margin-right:auto">Delete</button>
      <button class="btn btn-s" onclick="hideModal()">Cancel</button>
      <button class="btn btn-p" onclick="saveEditRevision('${raftId}','${revId}')">Save</button>
    </div>`);
}
function saveEditRevision(raftId, revId) {
  const r = (data.safety?.lifeRafts||[]).find(r=>r.id===raftId); if (!r) return;
  const rev = (r.revisions||[]).find(rv=>rv.id===revId); if (!rev) return;
  rev.date=document.getElementById('srv-date').value; rev.notes=document.getElementById('srv-notes').value.trim();
  save(); hideModal(); document.getElementById('mainContent').innerHTML = renderSafety();
}
function removeRevision(raftId, revId) {
  const r = (data.safety?.lifeRafts||[]).find(r=>r.id===raftId); if (!r) return;
  r.revisions = (r.revisions||[]).filter(rv=>rv.id!==revId);
  save(); document.getElementById('mainContent').innerHTML = renderSafety();
}

// ── Flare drag-to-reorder ──
let _safetyFlareDragId = null, _safetyFlareTouchState = null;
function safetyFlareDragStart(e, id) {
  if (e.target.closest('button,input,select,a')) { e.preventDefault(); return; }
  _safetyFlareDragId = id; e.dataTransfer.effectAllowed='move'; e.dataTransfer.setData('text/plain',id);
  setTimeout(()=>document.querySelector(`[data-safety-flare-id="${id}"]`)?.classList.add('prov-dragging'),0);
}
function safetyFlareDragOver(e, id) {
  if (!_safetyFlareDragId||_safetyFlareDragId===id) return;
  e.preventDefault(); e.dataTransfer.dropEffect='move';
  document.querySelectorAll('.prov-drag-over').forEach(el=>el.classList.remove('prov-drag-over'));
  e.currentTarget.classList.add('prov-drag-over');
}
function safetyFlareDragLeave(e) { if (!e.currentTarget.contains(e.relatedTarget)) e.currentTarget.classList.remove('prov-drag-over'); }
function safetyFlareDrop(e, targetId) {
  e.preventDefault();
  document.querySelectorAll('.prov-drag-over,.prov-dragging').forEach(el=>el.classList.remove('prov-drag-over','prov-dragging'));
  const fromId=_safetyFlareDragId; _safetyFlareDragId=null; _safetyFlareDoReorder(fromId,targetId);
}
function safetyFlareDragEnd() {
  document.querySelectorAll('.prov-drag-over,.prov-dragging').forEach(el=>el.classList.remove('prov-drag-over','prov-dragging'));
  _safetyFlareDragId=null;
}
function safetyFlareTouchStart(e, id) {
  e.preventDefault();
  const touch=e.touches[0], row=e.currentTarget.closest('[data-safety-flare-id]'); if (!row) return;
  const rect=row.getBoundingClientRect(), clone=row.cloneNode(true);
  Object.assign(clone.style,{position:'fixed',left:rect.left+'px',top:rect.top+'px',width:rect.width+'px',opacity:'0.85',zIndex:'9999',pointerEvents:'none',outline:'2px dashed var(--blue)',borderRadius:'4px',background:'var(--surface)',boxShadow:'0 4px 16px rgba(0,0,0,.18)',transition:'none'});
  document.body.appendChild(clone); row.style.opacity='0.3';
  _safetyFlareTouchState={id,row,clone,offsetY:touch.clientY-rect.top,over:null};
  document.addEventListener('touchmove',_safetyFlareTouchMove,{passive:false});
  document.addEventListener('touchend',_safetyFlareTouchEnd);
}
function _safetyFlareTouchMove(e) {
  e.preventDefault(); if (!_safetyFlareTouchState) return;
  const touch=e.touches[0],{clone,offsetY}=_safetyFlareTouchState;
  clone.style.top=(touch.clientY-offsetY)+'px'; clone.style.display='none';
  const under=document.elementFromPoint(touch.clientX,touch.clientY); clone.style.display='';
  const targetRow=under?.closest('[data-safety-flare-id]');
  document.querySelectorAll('.prov-drag-over').forEach(el=>el.classList.remove('prov-drag-over'));
  if (targetRow&&targetRow!==_safetyFlareTouchState.row){targetRow.classList.add('prov-drag-over');_safetyFlareTouchState.over=targetRow;}
  else{_safetyFlareTouchState.over=null;}
}
function _safetyFlareTouchEnd() {
  document.removeEventListener('touchmove',_safetyFlareTouchMove); document.removeEventListener('touchend',_safetyFlareTouchEnd);
  if (!_safetyFlareTouchState) return;
  const{id,row,clone,over}=_safetyFlareTouchState; _safetyFlareTouchState=null;
  clone.remove(); row.style.opacity='';
  document.querySelectorAll('.prov-drag-over').forEach(el=>el.classList.remove('prov-drag-over'));
  if (over) _safetyFlareDoReorder(id, over.dataset.safetyFlareId);
}
function _safetyFlareDoReorder(fromId, toId) {
  if (!fromId||!toId||fromId===toId) return;
  const arr=data.safety?.flares||[]; const fi=arr.findIndex(f=>f.id===fromId);
  if (fi===-1||!arr.find(f=>f.id===toId)) return;
  const[moved]=arr.splice(fi,1); arr.splice(arr.findIndex(f=>f.id===toId),0,moved);
  save(); document.getElementById('mainContent').innerHTML=renderSafety();
}

// ── Raft drag-to-reorder ──
let _safetyRaftDragId = null, _safetyRaftTouchState = null;
function safetyRaftDragStart(e, id) {
  if (e.target.closest('button,input,select,a')) { e.preventDefault(); return; }
  _safetyRaftDragId=id; e.dataTransfer.effectAllowed='move'; e.dataTransfer.setData('text/plain',id);
  setTimeout(()=>document.querySelector(`[data-safety-raft-id="${id}"]`)?.classList.add('prov-dragging'),0);
}
function safetyRaftDragOver(e, id) {
  if (!_safetyRaftDragId||_safetyRaftDragId===id) return;
  e.preventDefault(); e.dataTransfer.dropEffect='move';
  document.querySelectorAll('.prov-drag-over').forEach(el=>el.classList.remove('prov-drag-over'));
  e.currentTarget.classList.add('prov-drag-over');
}
function safetyRaftDragLeave(e) { if (!e.currentTarget.contains(e.relatedTarget)) e.currentTarget.classList.remove('prov-drag-over'); }
function safetyRaftDrop(e, targetId) {
  e.preventDefault();
  document.querySelectorAll('.prov-drag-over,.prov-dragging').forEach(el=>el.classList.remove('prov-drag-over','prov-dragging'));
  const fromId=_safetyRaftDragId; _safetyRaftDragId=null; _safetyRaftDoReorder(fromId,targetId);
}
function safetyRaftDragEnd() {
  document.querySelectorAll('.prov-drag-over,.prov-dragging').forEach(el=>el.classList.remove('prov-drag-over','prov-dragging'));
  _safetyRaftDragId=null;
}
function safetyRaftTouchStart(e, id) {
  e.preventDefault();
  const touch=e.touches[0], row=e.currentTarget.closest('[data-safety-raft-id]'); if (!row) return;
  const rect=row.getBoundingClientRect(), clone=row.cloneNode(true);
  Object.assign(clone.style,{position:'fixed',left:rect.left+'px',top:rect.top+'px',width:rect.width+'px',opacity:'0.85',zIndex:'9999',pointerEvents:'none',outline:'2px dashed var(--blue)',borderRadius:'4px',background:'var(--surface)',boxShadow:'0 4px 16px rgba(0,0,0,.18)',transition:'none'});
  document.body.appendChild(clone); row.style.opacity='0.3';
  _safetyRaftTouchState={id,row,clone,offsetY:touch.clientY-rect.top,over:null};
  document.addEventListener('touchmove',_safetyRaftTouchMove,{passive:false});
  document.addEventListener('touchend',_safetyRaftTouchEnd);
}
function _safetyRaftTouchMove(e) {
  e.preventDefault(); if (!_safetyRaftTouchState) return;
  const touch=e.touches[0],{clone,offsetY}=_safetyRaftTouchState;
  clone.style.top=(touch.clientY-offsetY)+'px'; clone.style.display='none';
  const under=document.elementFromPoint(touch.clientX,touch.clientY); clone.style.display='';
  const targetRow=under?.closest('[data-safety-raft-id]');
  document.querySelectorAll('.prov-drag-over').forEach(el=>el.classList.remove('prov-drag-over'));
  if (targetRow&&targetRow!==_safetyRaftTouchState.row){targetRow.classList.add('prov-drag-over');_safetyRaftTouchState.over=targetRow;}
  else{_safetyRaftTouchState.over=null;}
}
function _safetyRaftTouchEnd() {
  document.removeEventListener('touchmove',_safetyRaftTouchMove); document.removeEventListener('touchend',_safetyRaftTouchEnd);
  if (!_safetyRaftTouchState) return;
  const{id,row,clone,over}=_safetyRaftTouchState; _safetyRaftTouchState=null;
  clone.remove(); row.style.opacity='';
  document.querySelectorAll('.prov-drag-over').forEach(el=>el.classList.remove('prov-drag-over'));
  if (over) _safetyRaftDoReorder(id, over.dataset.safetyRaftId);
}
function _safetyRaftDoReorder(fromId, toId) {
  if (!fromId||!toId||fromId===toId) return;
  const arr=data.safety?.lifeRafts||[]; const fi=arr.findIndex(r=>r.id===fromId);
  if (fi===-1||!arr.find(r=>r.id===toId)) return;
  const[moved]=arr.splice(fi,1); arr.splice(arr.findIndex(r=>r.id===toId),0,moved);
  save(); document.getElementById('mainContent').innerHTML=renderSafety();
}

// ── Safety prefill ──
function prefillSafetyData() {
  if (data.safety?.flares?.length || data.safety?.lifeRafts?.length) return false;
  if (!data.safety) data.safety = {flares:[],lifeRafts:[]};
  const dFwd = n => { const d=new Date(); d.setDate(d.getDate()+n); return d.toISOString().slice(0,10); };
  const today = new Date().toISOString().slice(0,10);
  data.safety.flares = [
    {id:uid(), type:'Red hand flare (Example)',        qty:4, expiry:dFwd(730),  notes:''},
    {id:uid(), type:'Parachute rocket (Example)',      qty:2, expiry:dFwd(730),  notes:''},
    {id:uid(), type:'Orange smoke (Example)',          qty:2, expiry:dFwd(548),  notes:''},
    {id:uid(), type:'White collision flare (Example)', qty:4, expiry:dFwd(1095), notes:''},
  ];
  data.safety.lifeRafts = [{
    id:uid(), brand:'Example Brand', model:'Ocean ISO 6 (Example)', persons:6,
    expiry:dFwd(730), serialNumber:'EXAMPLE-001',
    notes:'Replace this with your actual life raft details',
    revisions:[{id:uid(), date:today, notes:'Annual service (Example) — update with your actual service history'}]
  }];
  return true;
}

// ═══════════════════════════════════════════════════════════
//  SECTION 7 — SYSTEMS
// ═══════════════════════════════════════════════════════════

// ═══════════════════════════════════════════════════════════
//  UPGRADES & REPAIRS
// ═══════════════════════════════════════════════════════════

function getUpgradesData() {
  const isOwner = localStorage.getItem(EMAIL_KEY) === OWNER_EMAIL;
  if (!data.upgrades || !data.upgrades.seasons || (isOwner && data.upgrades.seasons.length < 5)) {
    const mk = (text, cost, done) => ({id:uid(), text, cost:cost||'', checked:!!done});
    if (isOwner) {
      const odSeasons = (typeof OROBORO_DATA !== 'undefined') ? (OROBORO_DATA.upgrades?.seasons || []) : [];
      data.upgrades = { version: UPGRADES_DATA_VERSION, seasons: odSeasons.map(s => ({
        id: uid(), name: s.name, location: s.location,
        items: (s.items || []).map(i => mk(i.text, i.cost, i.checked))
      }))};
    } else {
      data.upgrades = { version: UPGRADES_DATA_VERSION, seasons:[
        {id:uid(), name:'2024/2025', location:'Example Marina', items:[
          mk('Replaced engine impeller','45',false),
          mk('Painted antifouling on hulls','280',false),
          mk('New shore power cable','120',false)
        ]}
      ]};
    }
  }
  return data.upgrades;
}

function upgRerender() { document.getElementById('mainContent').innerHTML = renderUpgrades(); }

function renderUpgrades() {
  if (!ui.upgOpen) ui.upgOpen = {};
  if (!ui.upgEdit) ui.upgEdit = null;
  if (!ui.upgAddItem) ui.upgAddItem = null;
  if (!ui.upgConfirmDel) ui.upgConfirmDel = null;
  const wd = getUpgradesData();
  const isOwner = localStorage.getItem(EMAIL_KEY) === OWNER_EMAIL;

  // Grand total across all seasons
  let grandTotal = 0;
  wd.seasons.forEach(s => s.items.forEach(it => { grandTotal += parseFloat(it.cost)||0; }));

  const reversedSeasons = wd.seasons.slice().reverse();
  const firstId = reversedSeasons[0]?.id;
  const cards = reversedSeasons.map(s => renderUpgradeSeason(s, s.id === firstId)).join('');
  const summary = grandTotal > 0 ? `<div style="margin:4px 12px 16px;padding:12px 16px;background:var(--surface);border:0.5px solid var(--sep);border-radius:12px;font-size:13px;color:var(--label3)">All seasons total: <b style="color:var(--label)">€${grandTotal.toLocaleString('en',{minimumFractionDigits:0,maximumFractionDigits:2})}</b></div>` : '';
  const exMsg = !isOwner ? `<div style="margin:0 12px 12px;font-size:12px;color:var(--label3);font-style:italic">Replace these examples with your own upgrades and repairs</div>` : '';

  return `<div style="display:flex;align-items:center;justify-content:space-between;padding:12px 12px 8px">
    <div style="font-size:17px;font-weight:700">🔧 Upgrades &amp; Repairs</div>
    <button onclick="showAddUpgradeSeason()" style="background:var(--surface);border:0.5px solid var(--sep);border-radius:8px;padding:6px 14px;font-size:13px;font-weight:600;font-family:var(--font);color:var(--label);cursor:pointer">+ Add season</button>
  </div>
  ${exMsg}${cards}${summary}`;
}

function renderUpgradeSeason(s, isFirst = false) {
  const done = s.items.filter(x=>x.checked).length, total = s.items.length;
  const complete = total > 0 && done === total;
  const pct = total ? Math.round(done/total*100) : 0;
  // most recent season always open by default; others: open if in-progress, closed if complete
  const open = ui.upgOpen[s.id] !== undefined ? ui.upgOpen[s.id] : (isFirst || !complete);
  const badge = complete ? `<span style="background:var(--green);color:#fff;font-size:10px;font-weight:700;padding:2px 8px;border-radius:10px;margin-left:6px">✓ Complete</span>` : '';
  const hdr = `<div onclick="ui.upgOpen['${s.id}']=!${open};upgRerender()"
    style="display:flex;align-items:center;gap:12px;padding:13px 14px;cursor:pointer;user-select:none;-webkit-user-select:none">
    <div style="width:34px;height:34px;border-radius:9px;background:rgba(0,122,255,.1);display:flex;align-items:center;justify-content:center;font-size:17px;flex-shrink:0">⚓</div>
    <div style="flex:1;min-width:0">
      <div style="font-size:15px;font-weight:700;color:var(--label)">${esc(s.name)}${badge}</div>
      <div style="font-size:12px;color:var(--label3);margin-top:1px">${esc(s.location||'')}</div>
    </div>
    <div style="display:flex;align-items:center;gap:8px;flex-shrink:0">
      <span style="font-size:12px;color:var(--label3)">${done}/${total}</span>
      <span style="font-size:11px;color:var(--label3)">${open?'▲':'▼'}</span>
    </div>
  </div>
  <div style="height:3px;background:var(--surface2)">
    <div style="height:3px;background:${complete?'var(--green)':'var(--orange)'};width:${pct}%;transition:width .4s"></div>
  </div>`;

  let body = '';
  if (!open) {
    if (complete) body = `<div style="padding:10px 16px;font-size:12px;color:var(--label3);border-top:1px solid var(--sep)">${total} items completed · tap to expand</div>`;
  } else {
    const rows = s.items.map((item, idx) => renderUpgradeItem(s, item, idx)).join('');
    const addRow = renderUpgradeAddRow(s);
    const seasonTotal = s.items.reduce((sum,it)=>sum+(parseFloat(it.cost)||0),0);
    const totLine = seasonTotal > 0 ? `<div style="padding:8px 16px 10px;font-size:12px;color:var(--label3);border-top:1px solid var(--sep)">Season total: <b style="color:var(--label)">€${seasonTotal.toLocaleString('en',{minimumFractionDigits:0,maximumFractionDigits:2})}</b></div>` : '';
    body = `<div style="border-top:1px solid var(--sep)">${rows}${addRow}${totLine}</div>`;
  }

  return `<div style="background:var(--surface);border:0.5px solid var(--sep);border-radius:14px;margin:0 12px 10px;overflow:hidden">${hdr}${body}</div>`;
}

function renderUpgradeItem(s, item, idx) {
  const sid = s.id, iid = item.id;
  // Inline delete confirm
  if (ui.upgConfirmDel === iid) {
    return `<div style="display:flex;align-items:center;gap:10px;padding:11px 14px;border-bottom:1px solid var(--sep);background:rgba(255,59,48,.05)">
      <span style="flex:1;font-size:13px;color:var(--label2)">Remove "${esc(item.text)}"?</span>
      <button class="btn btn-d btn-xs" onclick="deleteUpgradeItem('${sid}','${iid}')">Remove</button>
      <button class="btn btn-s btn-xs" onclick="ui.upgConfirmDel=null;upgRerender()">Cancel</button>
    </div>`;
  }
  // Inline edit
  if (ui.upgEdit?.iid === iid) {
    return `<div style="display:flex;align-items:center;gap:8px;padding:10px 14px;border-bottom:1px solid var(--sep);background:var(--surface2)">
      <input id="ueit" class="fi" style="flex:1;font-size:14px" value="${esc(item.text)}"
        onkeydown="if(event.key==='Enter')saveUpgradeItemEdit('${sid}','${iid}')">
      <div style="display:flex;align-items:center;gap:4px;flex-shrink:0">
        <span style="font-size:13px;color:var(--label3)">€</span>
        <input id="uecost" class="fi" type="number" min="0" step="0.01" style="width:70px;font-size:14px" value="${esc(item.cost||'')}" placeholder="0"
          onkeydown="if(event.key==='Enter')saveUpgradeItemEdit('${sid}','${iid}')">
      </div>
      <button class="btn btn-p btn-xs" onclick="saveUpgradeItemEdit('${sid}','${iid}')">Save</button>
      <button class="btn btn-s btn-xs" onclick="ui.upgEdit=null;upgRerender()">Cancel</button>
      <button onclick="if(confirm('Remove this item?')){ui.upgEdit=null;deleteUpgradeItem('${sid}','${iid}')}" style="background:#FCEBEB;border:0.5px solid #F09595;color:#A32D2D;border-radius:8px;padding:4px 10px;font-family:var(--font);font-size:12px;font-weight:600;cursor:pointer">🗑</button>
    </div>`;
  }
  // Normal row
  const complete = s.items.length > 0 && s.items.every(x => x.checked);
  const costTxt = item.cost ? ` <span style="color:var(--label3);font-size:12px">· €${item.cost}</span>` : '';
  const chkStyle = item.checked
    ? 'background:var(--green);border-color:var(--green)'
    : 'background:var(--surface);border:2px solid var(--sep)';
  const chkMark = item.checked ? '<svg width="11" height="9" viewBox="0 0 11 9"><polyline points="1,4.5 4,7.5 10,1" stroke="#fff" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>' : '';
  const chkClick = complete ? '' : `onclick="toggleUpgradeItem('${sid}','${iid}')"`;
  const chkCursor = complete ? 'cursor:default' : 'cursor:pointer';
  return `<div style="display:flex;align-items:center;gap:12px;padding:11px 14px;border-bottom:1px solid var(--sep)">
    <div ${chkClick}
      style="width:22px;height:22px;border-radius:6px;${chkStyle};flex-shrink:0;display:flex;align-items:center;justify-content:center;${chkCursor};transition:all .15s">
      ${chkMark}
    </div>
    <div style="flex:1;font-size:14px;line-height:1.4;${chkCursor}"${complete ? '' : ` onclick="toggleUpgradeItem('${sid}','${iid}')"`}>${esc(item.text)}${costTxt}</div>
    <div style="display:flex;gap:2px;flex-shrink:0">
      <button onclick="ui.upgEdit={iid:'${iid}'};upgRerender();setTimeout(()=>document.getElementById('ueit')?.focus(),40)"
        style="background:none;border:none;padding:2px 4px;cursor:pointer;font-size:14px;color:var(--label3);line-height:1;flex-shrink:0">✏️</button>
    </div>
  </div>`;
}

function renderUpgradeAddRow(s) {
  if (ui.upgAddItem === s.id) {
    return `<div style="display:flex;align-items:center;gap:8px;padding:10px 14px;border-bottom:1px solid var(--sep);background:var(--surface2)">
      <input id="uadd-t" class="fi" style="flex:1;font-size:14px" placeholder="Item description"
        onkeydown="if(event.key==='Enter')saveUpgradeNewItem('${s.id}')">
      <div style="display:flex;align-items:center;gap:4px;flex-shrink:0">
        <span style="font-size:13px;color:var(--label3)">€</span>
        <input id="uadd-c" class="fi" type="number" min="0" step="0.01" style="width:70px;font-size:14px" placeholder="0"
          onkeydown="if(event.key==='Enter')saveUpgradeNewItem('${s.id}')">
      </div>
      <button class="btn btn-p btn-xs" onclick="saveUpgradeNewItem('${s.id}')">Add</button>
      <button class="btn btn-s btn-xs" onclick="ui.upgAddItem=null;upgRerender()">✕</button>
    </div>`;
  }
  return `<div onclick="ui.upgAddItem='${s.id}';upgRerender();setTimeout(()=>document.getElementById('uadd-t')?.focus(),40)"
    style="display:flex;align-items:center;gap:10px;padding:11px 14px;cursor:pointer;color:var(--label3)">
    <span style="font-size:18px;line-height:1;margin-left:2px">＋</span>
    <span style="font-size:14px">Add item</span>
  </div>`;
}

function toggleUpgradeItem(sid, iid) {
  const s = getUpgradesData().seasons.find(x=>x.id===sid); if (!s) return;
  const item = s.items.find(x=>x.id===iid); if (!item) return;
  item.checked = !item.checked;
  save(); upgRerender();
}

function saveUpgradeItemEdit(sid, iid) {
  const s = getUpgradesData().seasons.find(x=>x.id===sid); if (!s) return;
  const item = s.items.find(x=>x.id===iid); if (!item) return;
  const t = document.getElementById('ueit')?.value.trim();
  if (t) item.text = t;
  item.cost = document.getElementById('uecost')?.value || '';
  ui.upgEdit = null;
  save(); upgRerender();
}

function deleteUpgradeItem(sid, iid) {
  const s = getUpgradesData().seasons.find(x=>x.id===sid); if (!s) return;
  s.items = s.items.filter(x=>x.id!==iid);
  ui.upgConfirmDel = null;
  save(); upgRerender();
}

function saveUpgradeNewItem(sid) {
  const s = getUpgradesData().seasons.find(x=>x.id===sid); if (!s) return;
  const t = document.getElementById('uadd-t')?.value.trim();
  if (!t) { showToast('Enter item description', true); return; }
  s.items.push({id:uid(), text:t, cost:document.getElementById('uadd-c')?.value||'', checked:false});
  ui.upgAddItem = null;
  save(); upgRerender();
}

function showAddUpgradeSeason() {
  showModal('Add Season', `
    <div class="mi-label">Season name</div><input class="mi" id="uas-n" placeholder="e.g. 2027/2028" autofocus>
    <div class="mi-label">Location</div><input class="mi" id="uas-l" placeholder="e.g. Paros">
    <div class="modal-btns">
      <button class="btn btn-s" onclick="hideModal()">Cancel</button>
      <button class="btn btn-p" onclick="saveUpgradeSeason()">Save</button>
    </div>`);
}

function saveUpgradeSeason() {
  const name = document.getElementById('uas-n')?.value.trim();
  if (!name) { showToast('Enter a season name', true); return; }
  const wd = getUpgradesData();
  wd.seasons.push({id:uid(), name, location:document.getElementById('uas-l')?.value.trim()||'', open:true, items:[]});
  save(); hideModal(); upgRerender();
}

function prefillUpgradesData() {
  const forceReseed = localStorage.getItem('force_upgrades_reseed');
  if (forceReseed) {
    localStorage.removeItem('force_upgrades_reseed');
    delete data.upgrades;
    getUpgradesData();
    return true;
  }
  if (localStorage.getItem(EMAIL_KEY) !== OWNER_EMAIL) return false;
  if (data.upgrades?.version >= UPGRADES_DATA_VERSION) return false;
  delete data.upgrades;
  getUpgradesData();
  return true;
}

const SYS_GROUPS = [
  {id:'All',      label:'All'},
  {id:'Victron',  label:'⚡ Victron',        cats:['Battery Storage','Distribution','Charge Controllers','Protection & Management','Inverter / Charger','Monitoring','House Bank','Distribution & Protection','Alternator Charging','Future Projects']},
  {id:'Engines',  label:'🔧 Engines',        cats:['Engines','Propulsion','Sail Drive','Main Engines','Start Batteries','Fuel System']},
  {id:'Sails',    label:'⛵ Sails & Rigging', cats:['Main sail','Genoa','Standing rigging','Sails','Rigging','Halyards','Deck Equipment']},
  {id:'Water',    label:'💧 Water & Fuel',    cats:['Watermaker','Fresh Water','Diesel','Water','Bilge','Sanitation','Fuel Transfer']},
  {id:'Solar',    label:'☀️ Solar',           cats:['Solar','Flexible solar','Rigid Panels — Stern Arch','Flexible Panels — Cabin Roof','Charge Controllers']},
  {id:'Raymarine',label:'📡 Raymarine',       cats:['Raymarine','Navigation','Electronics','Chartplotter & Displays','Radar','AIS & GPS','Autopilot','Sensors & Network']},
  {id:'Other',    label:'➕ Other'},
];
const SYS_ALL_CATS = SYS_GROUPS.filter(g=>g.cats).flatMap(g=>g.cats);
const SYS_CAT_ICON = {};
SYS_GROUPS.forEach(g => {
  if (!g.cats) return;
  const emoji = g.label.split(' ')[0]; // "☀️ Solar" → "☀️", handles multi-codepoint emoji correctly
  g.cats.forEach(c => SYS_CAT_ICON[c] = emoji);
});

function sysDragStart(e, id) {
  if (e.target.closest('button,input,select,textarea,a')) { e.preventDefault(); return; }
  _sysDragId = id;
  e.dataTransfer.effectAllowed = 'move';
  e.dataTransfer.setData('text/plain', id);
  setTimeout(() => document.querySelector(`[data-sys-id="${id}"]`)?.classList.add('prov-dragging'), 0);
}
function sysDragOver(e, id) {
  if (!_sysDragId || _sysDragId === id) return;
  e.preventDefault(); e.dataTransfer.dropEffect = 'move';
  document.querySelectorAll('.prov-drag-over').forEach(el => el.classList.remove('prov-drag-over'));
  e.currentTarget.classList.add('prov-drag-over');
}
function sysDragLeave(e) { if (!e.currentTarget.contains(e.relatedTarget)) e.currentTarget.classList.remove('prov-drag-over'); }
function sysDrop(e, targetId) {
  e.preventDefault();
  document.querySelectorAll('.prov-drag-over,.prov-dragging').forEach(el => el.classList.remove('prov-drag-over','prov-dragging'));
  const fromId = _sysDragId; _sysDragId = null;
  _sysDoReorder(fromId, targetId);
}
function sysDragEnd() {
  document.querySelectorAll('.prov-drag-over,.prov-dragging').forEach(el => el.classList.remove('prov-drag-over','prov-dragging'));
  _sysDragId = null;
}
function sysTouchStart(e, id) {
  e.preventDefault(); e.stopPropagation();
  const touch = e.touches[0], row = e.currentTarget.closest('[data-sys-id]'); if (!row) return;
  const rect = row.getBoundingClientRect(), clone = row.cloneNode(true);
  Object.assign(clone.style, {position:'fixed',left:rect.left+'px',top:rect.top+'px',width:rect.width+'px',opacity:'0.85',zIndex:'9999',pointerEvents:'none',outline:'2px dashed var(--blue)',borderRadius:'4px',background:'var(--surface)',boxShadow:'0 4px 16px rgba(0,0,0,.18)',transition:'none'});
  document.body.appendChild(clone); row.style.opacity = '0.3';
  _sysTouchState = {id, row, clone, offsetY: touch.clientY - rect.top, over: null};
  document.addEventListener('touchmove', _sysTouchMove, {passive:false});
  document.addEventListener('touchend', _sysTouchEnd);
}
function _sysTouchMove(e) {
  e.preventDefault(); if (!_sysTouchState) return;
  const touch = e.touches[0], {clone, offsetY} = _sysTouchState;
  clone.style.top = (touch.clientY - offsetY) + 'px';
  clone.style.display = 'none';
  const under = document.elementFromPoint(touch.clientX, touch.clientY);
  clone.style.display = '';
  const targetRow = under?.closest('[data-sys-id]');
  document.querySelectorAll('.prov-drag-over').forEach(el => el.classList.remove('prov-drag-over'));
  if (targetRow && targetRow !== _sysTouchState.row) { targetRow.classList.add('prov-drag-over'); _sysTouchState.over = targetRow; }
  else { _sysTouchState.over = null; }
}
function _sysTouchEnd() {
  document.removeEventListener('touchmove', _sysTouchMove); document.removeEventListener('touchend', _sysTouchEnd);
  if (!_sysTouchState) return;
  const {id, row, clone, over} = _sysTouchState; _sysTouchState = null;
  clone.remove(); row.style.opacity = '';
  document.querySelectorAll('.prov-drag-over').forEach(el => el.classList.remove('prov-drag-over'));
  if (over) _sysDoReorder(id, over.dataset.sysId);
}
function _sysDoReorder(fromId, toId) {
  if (!fromId || !toId || fromId === toId) return;
  const systems = data.systems || [];
  const fromIdx = systems.findIndex(s => s.id === fromId);
  if (fromIdx === -1 || systems.findIndex(s => s.id === toId) === -1) return;
  const [moved] = systems.splice(fromIdx, 1);
  systems.splice(systems.findIndex(s => s.id === toId), 0, moved);
  save(); document.getElementById('mainContent').innerHTML = renderSystems();
}

function renderSystemsOverview() {
  const systems = data.systems || [];
  const ps = data.meta?.powerSpec;
  if (!systems.length && !ps) return '';

  const open = ui.sysOverviewOpen;
  const toggle = "ui.sysOverviewOpen=!ui.sysOverviewOpen;document.getElementById('mainContent').innerHTML=renderSystems()";

  // Planned/uninstalled items excluded from all totals
  const planned  = x => (x.notes||'').toUpperCase().includes('NOT YET INSTALLED');
  const total    = systems.reduce((s, x) => s + (!planned(x) && x.purchasePriceUsd > 0 ? x.purchasePriceUsd : 0), 0);
  const priced   = systems.filter(x => !planned(x) && x.purchasePriceUsd > 0).length;
  const unpriced = systems.length - priced;

  const fmtK = n => { n = Math.round(n); return n >= 10000 ? '$' + (n/1000).toFixed(1).replace(/\.0$/,'') + 'k' : '$' + n.toLocaleString(); };

  // Collapsed one-liner
  let summary = `${systems.length} systems`;
  if (total > 0) summary += ` · ${fmtK(total)} invested`;
  if (ps?.houseBankAh) summary += ` · ${Number(ps.houseBankAh).toLocaleString()}Ah LFP`;
  if (ps?.solarW)      summary += ` · ${Number(ps.solarW).toLocaleString()}W solar`;

  const hdr = `
    <div onclick="${toggle}" style="display:flex;align-items:center;gap:10px;padding:12px 16px;cursor:pointer;user-select:none;-webkit-user-select:none">
      <span style="font-size:16px;flex-shrink:0">📊</span>
      <div style="flex:1;min-width:0">
        <div style="font-size:13px;font-weight:600">Systems Overview</div>
        ${!open ? `<div style="font-size:12px;color:var(--label3);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;margin-top:1px">${esc(summary)}</div>` : ''}
      </div>
      <span style="color:var(--label3);font-size:13px;flex-shrink:0">${open ? '▲' : '▼'}</span>
    </div>`;

  if (!open) return `<div style="background:var(--surface);border-radius:var(--radius);margin-bottom:10px">${hdr}</div>`;

  // Section 1: headline tiles
  const sec1 = `
    <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:8px;padding:14px 16px">
      <div style="text-align:center">
        <div style="font-size:22px;font-weight:700;color:var(--blue);line-height:1.1">${systems.length}</div>
        <div style="font-size:11px;color:var(--label3);margin-top:3px">total systems</div>
      </div>
      <div style="text-align:center">
        <div style="font-size:22px;font-weight:700;color:var(--blue);line-height:1.1">${fmtK(total)}</div>
        <div style="font-size:11px;color:var(--label3);margin-top:3px">invested</div>
      </div>
      <div style="text-align:center">
        <div style="font-size:22px;font-weight:700;color:var(--blue);line-height:1.1">${priced}</div>
        <div style="font-size:11px;color:var(--label3);margin-top:3px">priced</div>
        <div style="font-size:11px;color:var(--label3)">${unpriced} from build</div>
      </div>
    </div>`;

  // Section 2: investment bar chart — five named categories, planned items excluded
  const isLFP     = x => x.make==='Victron Energy' && /lifepo4/i.test(x.model||'');
  const chartDefs = [
    { label:'LiFePO4 Batteries', match: x => isLFP(x)                                              },
    { label:'Victron',           match: x => x.make==='Victron Energy' && !isLFP(x) && !planned(x) },
    { label:'Flex Solar',        match: x => x.make==='SUNBEAMsystem'                               },
    { label:'Rigid Solar',       match: x => x.make==='SunPower'                                    },
    { label:'Raymarine',         match: x => x.make==='Raymarine'                                   },
  ];
  const cats = chartDefs
    .map(d => [d.label, systems.filter(x => !planned(x) && x.purchasePriceUsd>0 && d.match(x)).reduce((t,x)=>t+x.purchasePriceUsd,0)])
    .filter(([,amt]) => amt > 0)
    .sort((a,b) => b[1]-a[1]);
  const maxAmt = cats.length ? cats[0][1] : 1;
  const bars = cats.map(([c, amt]) => {
    const pct = Math.round(amt / maxAmt * 100);
    return `
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:7px">
        <div style="font-size:12px;color:var(--label2);width:128px;flex-shrink:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(c)}</div>
        <div style="flex:1;background:var(--sep);border-radius:3px;height:5px">
          <div style="width:${pct}%;background:var(--blue);border-radius:3px;height:5px;min-width:3px"></div>
        </div>
        <div style="font-size:12px;color:var(--label2);text-align:right;white-space:nowrap;min-width:52px">${fmtK(amt)}</div>
      </div>`;
  }).join('');
  const sec2 = cats.length ? `
    <div style="border-top:1px solid var(--sep);padding:14px 16px 7px">
      <div style="font-size:11px;font-weight:600;color:var(--label3);text-transform:uppercase;letter-spacing:.5px;margin-bottom:10px">Investment by category</div>
      ${bars}
    </div>` : '';

  // Section 3: vessel quick-reference — power spec + engines
  const sec3_ps = ps ? `
    <div${cats.length ? '' : ''}>
      <div style="display:flex;align-items:center;margin-bottom:8px">
        <div style="font-size:11px;font-weight:600;color:var(--label3);text-transform:uppercase;letter-spacing:.5px;flex:1">Power Spec</div>
        <button onclick="event.stopPropagation();editPowerSpec()" style="background:none;border:none;padding:0;cursor:pointer;font-size:12px;color:var(--blue);font-weight:500">✏️ Edit</button>
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px 16px;margin-bottom:2px">
        <div>
          <div style="font-size:11px;color:var(--label3)">House Bank</div>
          <div style="font-size:15px;font-weight:600">${Number(ps.houseBankAh||0).toLocaleString()}Ah</div>
          <div style="font-size:12px;color:var(--label3)">${esc(ps.houseBankDesc||'')}</div>
        </div>
        <div>
          <div style="font-size:11px;color:var(--label3)">Solar</div>
          <div style="font-size:15px;font-weight:600">${Number(ps.solarW||0).toLocaleString()}W</div>
          <div style="font-size:12px;color:var(--label3)">${esc(ps.solarDesc||'')}</div>
        </div>
        <div>
          <div style="font-size:11px;color:var(--label3)">Inverter</div>
          <div style="font-size:15px;font-weight:600">${Number(ps.inverterVA||0).toLocaleString()}VA</div>
          <div style="font-size:12px;color:var(--label3)">${esc(ps.inverterDesc||'')}</div>
        </div>
        <div>
          <div style="font-size:11px;color:var(--label3)">Alternator(s)</div>
          <div style="font-size:15px;font-weight:600">${Number(ps.alternatorA||0).toLocaleString()}A</div>
          <div style="font-size:12px;color:var(--label3)">${esc(ps.alternatorDesc||'')}</div>
        </div>
      </div>
    </div>` : '';

  const yanmars = systems
    .filter(x => x.make === 'Yanmar')
    .sort((a, b) => {
      const aP = (a.location || '').toLowerCase().includes('port') ? 0 : 1;
      const bP = (b.location || '').toLowerCase().includes('port') ? 0 : 1;
      return aP - bP;
    });
  const engLines = yanmars.map(x => {
    const side = (x.location || '').toLowerCase().includes('port') ? 'Port' : 'Stbd';
    return `<div style="font-size:13px;color:var(--label2);margin-bottom:3px">${esc(x.make)} ${esc(x.model)} · <span style="color:var(--label3)">${side}</span> · <span style="font-family:monospace;font-size:12px">${esc(x.serialNumber||'—')}</span></div>`;
  }).join('');
  const sec3_eng = yanmars.length ? `
    <div${sec3_ps ? ' style="border-top:1px solid var(--sep);padding-top:12px;margin-top:12px"' : ''}>
      <div style="font-size:11px;font-weight:600;color:var(--label3);text-transform:uppercase;letter-spacing:.5px;margin-bottom:8px">Engines</div>
      ${engLines}
    </div>` : '';

  const sec3 = (sec3_ps || sec3_eng) ? `
    <div style="border-top:1px solid var(--sep);padding:14px 16px">
      ${sec3_ps}
      ${sec3_eng}
    </div>` : '';

  return `
    <div style="background:var(--surface);border-radius:var(--radius);margin-bottom:10px">
      ${hdr}
      <div style="border-top:1px solid var(--sep)">
        ${sec1}
        ${sec2}
        ${sec3}
      </div>
    </div>`;
}

function editPowerSpec() {
  const ps = data.meta?.powerSpec || {};
  showModal('Edit Power Spec', `
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:0 12px">
      <div>
        <div class="mi-label">House Bank (Ah)</div>
        <input class="mi" type="number" id="ps-hbah" value="${esc(String(ps.houseBankAh||''))}">
      </div>
      <div>
        <div class="mi-label">House Bank desc</div>
        <input class="mi" id="ps-hbdesc" value="${esc(ps.houseBankDesc||'')}">
      </div>
      <div style="margin-top:10px">
        <div class="mi-label">Solar (W)</div>
        <input class="mi" type="number" id="ps-sw" value="${esc(String(ps.solarW||''))}">
      </div>
      <div style="margin-top:10px">
        <div class="mi-label">Solar desc</div>
        <input class="mi" id="ps-sdesc" value="${esc(ps.solarDesc||'')}">
      </div>
      <div style="margin-top:10px">
        <div class="mi-label">Inverter (VA)</div>
        <input class="mi" type="number" id="ps-iva" value="${esc(String(ps.inverterVA||''))}">
      </div>
      <div style="margin-top:10px">
        <div class="mi-label">Inverter desc</div>
        <input class="mi" id="ps-idesc" value="${esc(ps.inverterDesc||'')}">
      </div>
      <div style="margin-top:10px">
        <div class="mi-label">Alternator (A)</div>
        <input class="mi" type="number" id="ps-alta" value="${esc(String(ps.alternatorA||''))}">
      </div>
      <div style="margin-top:10px">
        <div class="mi-label">Alternator desc</div>
        <input class="mi" id="ps-adesc" value="${esc(ps.alternatorDesc||'')}">
      </div>
    </div>
    <div class="modal-btns">
      <button class="btn btn-s" onclick="hideModal()">Cancel</button>
      <button class="btn btn-p" onclick="savePowerSpec()">Save</button>
    </div>`);
}

function savePowerSpec() {
  if (!data.meta) data.meta = {};
  data.meta.powerSpec = {
    houseBankAh:    Number(document.getElementById('ps-hbah').value)  || 0,
    houseBankDesc:  document.getElementById('ps-hbdesc').value.trim(),
    solarW:         Number(document.getElementById('ps-sw').value)    || 0,
    solarDesc:      document.getElementById('ps-sdesc').value.trim(),
    inverterVA:     Number(document.getElementById('ps-iva').value)   || 0,
    inverterDesc:   document.getElementById('ps-idesc').value.trim(),
    alternatorA:    Number(document.getElementById('ps-alta').value)  || 0,
    alternatorDesc: document.getElementById('ps-adesc').value.trim(),
  };
  save();
  pushToCloud();
  hideModal();
  document.getElementById('mainContent').innerHTML = renderSystems();
}

function renderSystems() {
  const systems = data.systems || [];
  if (!ui.sysTab) ui.sysTab = 'All';
  const curGroup = SYS_GROUPS.find(g=>g.id===ui.sysTab) || SYS_GROUPS[0];

  let filtered;
  if (curGroup.id === 'All')        filtered = systems;
  else if (curGroup.id === 'Other') filtered = systems.filter(s => !SYS_ALL_CATS.includes(s.cat||s.category));
  else                              filtered = systems.filter(s => (curGroup.cats||[]).includes(s.cat||s.category));

  const cats = [...new Set(filtered.map(s=>s.cat||s.category).filter(Boolean))];
  const noCat = filtered.filter(s=>!(s.cat||s.category));

  const pills = SYS_GROUPS.map(g =>
    `<div class="pill ${ui.sysTab===g.id?'active':''}" onclick="ui.sysTab='${g.id}';document.getElementById('mainContent').innerHTML=renderSystems()">${g.label}</div>`
  ).join('');

  const body = (cats.length===0 && noCat.length===0)
    ? `<div style="padding:30px 16px;text-align:center;color:var(--label3);font-size:14px">No systems in this category — tap + Add to add one</div>`
    : cats.map(cat=>`
        <div class="sec-hd">${esc(cat)}</div>
        ${filtered.filter(s=>(s.cat||s.category)===cat).map(s=>renderSystemCard(s)).join('')}
      `).join('') + noCat.map(s=>renderSystemCard(s)).join('');

  return `
    ${renderSystemsOverview()}
    <div class="subtab-bar" style="margin-bottom:10px">${pills}</div>
    <div class="btn-row">
      <button class="btn btn-p btn-sm" onclick="showAddSystem()">+ Add System</button>
    </div>
    ${body}`;
}

function renderSystemCard(s) {
  const open = ui.sysOpen === s.id;
  const wExp = expiryBadge(s.warrantyExpiry, 90);
  const idx = data.systems.indexOf(s);
  const hasPurchase = s.purchasePriceUsd || s.purchasePriceOriginal || s.supplier || s.invoiceRef || s.partCode;
  const icon = SYS_CAT_ICON[s.cat] || '➕';
  return `
    <div class="sys-card" data-sys-id="${s.id}" draggable="true" ondragstart="sysDragStart(event,'${s.id}')" ondragover="sysDragOver(event,'${s.id}')" ondragleave="sysDragLeave(event)" ondrop="sysDrop(event,'${s.id}')" ondragend="sysDragEnd()">
      <div class="sys-hdr" onclick="ui.sysOpen=ui.sysOpen==='${s.id}'?null:'${s.id}';document.getElementById('mainContent').innerHTML=renderSystems()">
        <span class="prov-grip" ontouchstart="sysTouchStart(event,'${s.id}')" style="margin-right:4px">⠿</span>
        <div class="sys-icon">${icon}</div>
        <div style="flex:1">
          <div style="font-size:15px;font-weight:600">${esc(s.make?s.make+' ':'')}${esc(s.model)}</div>
          <div style="font-size:12px;color:var(--label3)">${esc(s.notes||'')} ${s.location?'· '+esc(s.location):''}</div>
        </div>
        <div style="display:flex;align-items:center;gap:4px">
          <button onclick="event.stopPropagation();editSystem('${s.id}')" style="background:none;border:none;padding:2px 4px;cursor:pointer;font-size:14px;color:var(--label3);line-height:1;flex-shrink:0" title="Edit">✏️</button>
          <span style="color:var(--label3);margin-left:2px">${open?'▲':'▼'}</span>
        </div>
      </div>
      <div class="sys-body ${open?'open':''}">
        ${fr('Make','systems.'+idx+'.make',s.make)}
        ${fr('Model','systems.'+idx+'.model',s.model)}
        ${fr('Serial No.','systems.'+idx+'.serialNumber',s.serialNumber)}
        ${fr('Location','systems.'+idx+'.location',s.location)}
        ${fr('Install Date','systems.'+idx+'.installDate',s.installDate,'date')}
        ${fr('Last Service','systems.'+idx+'.lastService',s.lastService,'date')}
        ${frExpiry('systems.'+idx+'.warrantyExpiry',s.warrantyExpiry,wExp,'Warranty Expiry')}
        ${fr('Manual URL','systems.'+idx+'.manualUrl',s.manualUrl)}
        <div class="fr" style="align-items:flex-start;padding-top:12px">
          <div class="fl">Notes</div>
          <textarea class="fi-area" onblur="saveField('systems.${idx}.notes',this.value)">${esc(s.notes||'')}</textarea>
        </div>
        ${hasPurchase ? `
        <div style="border-top:1px solid var(--border);margin:14px 0 8px"></div>
        <div style="font-size:11px;font-weight:600;color:var(--label3);text-transform:uppercase;letter-spacing:.5px;margin-bottom:4px">Purchase</div>
        ${s.purchasePriceUsd ? `<div class="fr"><div class="fl">Price</div><div>$${Number(s.purchasePriceUsd).toLocaleString()}${s.purchasePriceOriginal?`<div style="font-size:12px;color:var(--label3)">${esc(s.purchasePriceOriginal)} at purchase</div>`:''}</div></div>` : ''}
        ${fr('Supplier','systems.'+idx+'.supplier',s.supplier)}
        ${fr('Invoice Ref','systems.'+idx+'.invoiceRef',s.invoiceRef)}
        <div class="fr"><div class="fl">Part Code</div><input class="fi" type="text" value="${esc(s.partCode||'')}" onblur="saveField('systems.${idx}.partCode',this.value)" placeholder="—" style="font-family:monospace;font-size:13px"></div>
        ` : ''}
        ${s.manualUrl?`<div class="btn-row"><a href="${esc(s.manualUrl)}" target="_blank"><button class="btn btn-s btn-xs">📄 Manual</button></a></div>`:''}
      </div>
    </div>`;
}

function showAddSystem() {
  const existingCats = [...new Set([...SYS_ALL_CATS, ...(data.systems||[]).map(s=>s.cat||s.category).filter(Boolean)])];
  const catOptions = existingCats.map(c=>`<option value="${esc(c)}">${esc(c)}</option>`).join('');
  const hasExisting = existingCats.length > 0;
  showModal('Add System', `
    <div class="mi-label">Category</div>
    <select class="mi" id="m-scat-sel" onchange="var v=this.value;var ni=document.getElementById('m-scat-new');if(v==='__new__'){ni.style.display='block';ni.focus();}else{ni.style.display='none';}">
      ${hasExisting ? '<option value="">— Select existing —</option>' : ''}
      ${catOptions}
      <option value="__new__">+ New category…</option>
    </select>
    <input class="mi" id="m-scat-new" placeholder="New category name" style="display:${hasExisting?'none':'block'};margin-top:6px">

    <div class="mi-label">Make</div><input class="mi" id="m-smk" placeholder="e.g. Victron">
    <div class="mi-label">Model</div><input class="mi" id="m-smd" placeholder="e.g. MPPT 75/15">
    <div class="mi-label">Serial Number</div><input class="mi" id="m-sser" placeholder="Optional">
    <div class="mi-label">Location</div><input class="mi" id="m-sloc" placeholder="e.g. engine room">
    <div class="mi-label">Notes</div><input class="mi" id="m-snt" placeholder="Optional">
    <div class="modal-btns">
      <button class="btn btn-s" onclick="hideModal()">Cancel</button>
      <button class="btn btn-p" onclick="saveSystem()">Add</button>
    </div>`);
}
function saveSystem() {
  if (!data.systems) data.systems = [];
  const selVal = document.getElementById('m-scat-sel')?.value;
  const cat = (selVal === '__new__' || !selVal)
    ? (document.getElementById('m-scat-new')?.value.trim() || '')
    : selVal;
  if (!cat) { showToast('Please enter a category', true); return; }
  data.systems.push({
    id:uid(), cat,
    category:cat,
    make:document.getElementById('m-smk').value,
    model:document.getElementById('m-smd').value,
    serialNumber:document.getElementById('m-sser').value,
    location:document.getElementById('m-sloc').value,
    notes:document.getElementById('m-snt').value,
    installDate:'', lastService:'', warrantyExpiry:'', manualUrl:'', photos:[]
  });
  save(); hideModal(); document.getElementById('mainContent').innerHTML = renderSystems();
}
function removeSystem(id) {
  data.systems = data.systems.filter(s=>s.id!==id); save();
  document.getElementById('mainContent').innerHTML = renderSystems();
}
function editSystem(id) {
  const s = (data.systems||[]).find(x=>x.id===id); if (!s) return;
  const existingCats = [...new Set([...SYS_ALL_CATS, ...(data.systems||[]).map(x=>x.cat||x.category).filter(Boolean)])];
  const curCat = s.cat||s.category||'';
  const catOptions = existingCats.map(c=>`<option value="${esc(c)}" ${c===curCat?'selected':''}>${esc(c)}</option>`).join('');
  const isCustom = curCat && !existingCats.includes(curCat) && !SYS_ALL_CATS.includes(curCat);
  showModal('Edit System', `
    <div class="mi-label">Category</div>
    <select class="mi" id="es-cat-sel" onchange="var v=this.value;var ni=document.getElementById('es-cat-new');if(v==='__new__'){ni.style.display='block';ni.focus();}else{ni.style.display='none';}">
      <option value="">— Select —</option>
      ${catOptions}
      <option value="__new__" ${isCustom?'selected':''}>+ New category…</option>
    </select>
    <input class="mi" id="es-cat-new" placeholder="New category name" value="${isCustom?esc(curCat):''}" style="display:${isCustom?'block':'none'};margin-top:6px">
    <div class="mi-label">Make</div><input class="mi" id="es-mk" value="${esc(s.make||'')}">
    <div class="mi-label">Model</div><input class="mi" id="es-md" value="${esc(s.model||'')}">
    <div class="mi-label">Serial Number</div><input class="mi" id="es-ser" value="${esc(s.serialNumber||'')}">
    <div class="mi-label">Location</div><input class="mi" id="es-loc" value="${esc(s.location||'')}">
    <div class="mi-label">Install Date</div><input class="mi" id="es-inst" type="date" value="${esc(s.installDate||'')}">
    <div class="mi-label">Last Service</div><input class="mi" id="es-svc" type="date" value="${esc(s.lastService||'')}">
    <div class="mi-label">Warranty Expiry</div><input class="mi" id="es-war" type="date" value="${esc(s.warrantyExpiry||'')}">
    <div class="mi-label">Manual URL</div><input class="mi" id="es-url" value="${esc(s.manualUrl||'')}">
    <div class="mi-label">Notes</div><input class="mi" id="es-nt" value="${esc(s.notes||'')}">
    <div style="border-top:1px solid var(--border);margin:16px 0 8px"></div>
    <div class="mi-label" style="color:var(--label3)">Purchase (optional)</div>
    <div style="display:flex;gap:8px">
      <div style="flex:1"><div class="mi-label">Price USD</div><input class="mi" id="es-pusd" type="number" step="1" placeholder="e.g. 1934" value="${esc(s.purchasePriceUsd!=null?String(s.purchasePriceUsd):'')}" style="width:100%"></div>
      <div style="flex:1"><div class="mi-label">Original price</div><input class="mi" id="es-porg" placeholder="e.g. €1,712 EUR" value="${esc(s.purchasePriceOriginal||'')}" style="width:100%"></div>
    </div>
    <div class="mi-label">Supplier</div><input class="mi" id="es-sup" value="${esc(s.supplier||'')}">
    <div class="mi-label">Invoice Ref</div><input class="mi" id="es-inv" value="${esc(s.invoiceRef||'')}">
    <div class="mi-label">Part Code</div><input class="mi" id="es-pcode" value="${esc(s.partCode||'')}" style="font-family:monospace">
    <div class="modal-btns">
      <button onclick="if(confirm('Remove this system?')){hideModal();removeSystem('${id}')}" style="background:#FCEBEB;border:0.5px solid #F09595;color:#A32D2D;border-radius:8px;padding:8px 14px;font-family:var(--font);font-size:14px;font-weight:600;cursor:pointer;margin-right:auto">Delete</button>
      <button class="btn btn-s" onclick="hideModal()">Cancel</button>
      <button class="btn btn-p" onclick="saveEditSystem('${id}')">Save</button>
    </div>`);
}
function saveEditSystem(id) {
  const s = (data.systems||[]).find(x=>x.id===id); if (!s) return;
  const selVal = document.getElementById('es-cat-sel')?.value;
  const cat = (selVal === '__new__' || !selVal)
    ? (document.getElementById('es-cat-new')?.value.trim() || '')
    : selVal;
  s.cat = cat; s.category = cat;
  s.make          = document.getElementById('es-mk').value;
  s.model         = document.getElementById('es-md').value;
  s.serialNumber  = document.getElementById('es-ser').value;
  s.location      = document.getElementById('es-loc').value;
  s.installDate   = document.getElementById('es-inst').value;
  s.lastService   = document.getElementById('es-svc').value;
  s.warrantyExpiry= document.getElementById('es-war').value;
  s.manualUrl     = document.getElementById('es-url').value;
  s.notes         = document.getElementById('es-nt').value;
  const pusd = document.getElementById('es-pusd')?.value;
  s.purchasePriceUsd      = pusd !== '' && pusd != null ? Number(pusd) : null;
  s.purchasePriceOriginal = document.getElementById('es-porg')?.value || '';
  s.supplier              = document.getElementById('es-sup')?.value  || '';
  s.invoiceRef            = document.getElementById('es-inv')?.value  || '';
  s.partCode              = document.getElementById('es-pcode')?.value || '';
  save(); hideModal(); document.getElementById('mainContent').innerHTML = renderSystems();
}

// ═══════════════════════════════════════════════════════════
//  SECTION 8 — LOGBOOK
// ═══════════════════════════════════════════════════════════

// ═══════════════════════════════════════════════════════════
//  WINTERIZATION
// ═══════════════════════════════════════════════════════════

const WINTER_DEFS = (() => {
  const i = (t, a) => ({t, a:!!a});
  return {
    winterize: { label:'Winterization', icon:'❄️', groups:[
      {title:null,                   items:[i('Submit / freeze transit log')]},
      {title:'General',              items:[i('Anti calcare washing machine'),i('Remove sails'),i('Remove bowsprit'),i('Wash standing rigging'),i('Clean toilets'),i('Wash boat outside'),i('Clean stainless'),i('Wax boat')]},
      {title:'Engine',               items:[i('Change Yanmar engine oil'),i('Change Yanmar gear oil'),i('Flush Yanmar coolant'),i('Flush raw water system'),i('Remove impellers'),i('Clean propellers'),i('Change propeller anodes'),i('Replace SD internal anodes')]},
      {title:'Dinghy',               items:[i('Drop dinghy'),i('Clean dinghy'),i('Change dinghy engine gear oil'),i('Fog dinghy engine'),i('Winterize dinghy engine'),i('Wrap dinghy with cover'),i('Replace anodes Suzuki engine')]},
      {title:'Others',               items:[i('Drop and replace starboard rudder',1),i('Dinghy valve air leak patch',1),i('Drop anchor and anchor chain'),i('Clean anchor locker'),i('Paint anchor'),i('Grease throttle handles'),i('Update Raymarine software',1),i('Fill up diesel tanks'),i('Yanmar inventory'),i('Bring main, jib, sail pack to sail maker'),i('Plug the battery bank hole',1),i('Measure size for duvet cover 240'),i('Empty water heaters'),i('Recreate aft side dodger cover',1),i('Recreate new dinghy cover',1),i('Replace top deck sika',1),i('Order made anodes')]},
      {title:'Right before leaving', items:[i('Place vaseline on hatches'),i('Cover helm station'),i('Defrost freezer'),i('Wash cushions'),i('Pay marina'),i('Place dry powder in wardrobes'),i('Change helm dodger cover'),i('Trickle charge battery'),i('Disconnect engine batteries'),i('International driving license (Maria)'),i('Winterize water maker'),i('Close engine batteries'),i('Empty fridge'),i('Disconnect gas'),i('Disconnect house batteries'),i('Cover front windows'),i('Order Japan sim')]},
    ]},
    needs: { label:'Needs', icon:'🛒', groups:[
      {title:null, items:[i('Gear oil x2 changes + dinghy 10 litre + 170ml'),i('Sail drive antifoul spray'),i('Oil extraction pump'),i('Oroboro logo')]}
    ]},
    backOnBoard: { label:'Back on board', icon:'⛵', groups:[
      {title:null, items:[i('Get flight tickets'),i('Get hotel in Athens'),i('Get Cosmote sim card'),i('Pick up sails and pay (main, jib, sail pack, wash)'),i('Pick up main halyard'),i('Buy bread'),i('Pick up bridal'),i('Get olive oil'),i('Connect house batteries'),i('Reopen toilets, shower stbd, water maker'),i('Reconnect paddle wheel'),i('Paint antifouling',1),i('Paint sail drive'),i('Wash and wax boat'),i('Place Yanmar impellers'),i('Open SD through hole'),i('Raise dinghy up'),i('Place chain and anchor back'),i('Replace solar panels'),i('Hutch windows replace',1),i('Water heater shipping'),i('Marina payment'),i('Change helm dodger cover'),i('Pay eTEPAY'),i('Transit log port police'),i('Gasoline for dinghy'),i('Fill up LPG'),i('Hoist main and jib'),i('Watermaker flush')]}
    ]}
  };
})();

function buildWinterSectionItems(sid, preChecked) {
  const chk = new Set(preChecked || []);
  let fi = 0;
  const items = [];
  (WINTER_DEFS[sid]?.groups || []).forEach(g => {
    g.items.forEach(item => { items.push({id:uid(), text:item.t, asterisk:item.a, checked:chk.has(fi), group:g.title||null}); fi++; });
  });
  return items;
}

function getWinterData() {
  if (!data.winterization) {
    const isOwner = localStorage.getItem(EMAIL_KEY) === OWNER_EMAIL;
    const mk = (text) => ({id:uid(), text, asterisk:false, checked:false, group:null});
    let sections;
    if (isOwner) {
      const BOB_PRE = [0,1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,21,22,23,24,25,26,27,28];
      sections = {
        winterize:  {items: buildWinterSectionItems('winterize',  [])},
        needs:      {items: buildWinterSectionItems('needs',      [0,1,2])},
        backOnBoard:{items: buildWinterSectionItems('backOnBoard', BOB_PRE)}
      };
    } else {
      sections = {
        winterize:  {items: [mk('Remove sails'),        mk('Change engine oil'),    mk('Flush raw water system')]},
        needs:      {items: [mk('Engine oil'),           mk('Fuel filters'),         mk('Impeller kit')]},
        backOnBoard:{items: [mk('Connect house batteries'), mk('Hoist main and jib'), mk('Watermaker flush')]}
      };
    }
    data.winterization = { currentSeason:'w2526', seasons:{ w2526:{
      name:'Winter 2025/26', archived:false, sections
    }}};
  }
  // Migrate old format (season.checked arrays → season.sections item objects)
  Object.values(data.winterization.seasons).forEach(season => {
    if (!season.sections) {
      season.sections = {};
      ['winterize','needs','backOnBoard'].forEach(sid => {
        season.sections[sid] = {items: buildWinterSectionItems(sid, season.checked?.[sid] || [])};
      });
      delete season.checked;
    }
  });
  return data.winterization;
}

function nextWinterName(name) {
  const m = name.match(/(\d{4})\/(\d{2})/);
  if (!m) return '';
  const y1 = parseInt(m[1]) + 1;
  return `${y1}/${String((y1+1)%100).padStart(2,'0')}`;
}

function winterRerender() { document.getElementById('mainContent').innerHTML = renderWinterization(); }

function winDragStart(e, id, sid) {
  if (e.target.closest('button,input,select,label')) { e.preventDefault(); return; }
  _winDragId = id; _winDragSid = sid;
  e.dataTransfer.effectAllowed = 'move';
  e.dataTransfer.setData('text/plain', id);
  setTimeout(() => document.querySelector(`[data-win-id="${id}"]`)?.classList.add('prov-dragging'), 0);
}
function winDragOver(e, id, sid) {
  if (!_winDragId || _winDragId === id || _winDragSid !== sid) return;
  e.preventDefault(); e.dataTransfer.dropEffect = 'move';
  document.querySelectorAll('.prov-drag-over').forEach(el => el.classList.remove('prov-drag-over'));
  e.currentTarget.classList.add('prov-drag-over');
}
function winDragLeave(e) { if (!e.currentTarget.contains(e.relatedTarget)) e.currentTarget.classList.remove('prov-drag-over'); }
function winDrop(e, id, sid) {
  e.preventDefault();
  document.querySelectorAll('.prov-drag-over,.prov-dragging').forEach(el => el.classList.remove('prov-drag-over','prov-dragging'));
  const fromId = _winDragId; _winDragId = null; _winDragSid = null;
  _winDoReorder(fromId, id, sid);
}
function winDragEnd() {
  document.querySelectorAll('.prov-drag-over,.prov-dragging').forEach(el => el.classList.remove('prov-drag-over','prov-dragging'));
  _winDragId = null; _winDragSid = null;
}
function winTouchStart(e, id, sid) {
  e.preventDefault(); e.stopPropagation();
  const touch = e.touches[0], row = e.currentTarget.closest('[data-win-id]'); if (!row) return;
  const rect = row.getBoundingClientRect(), clone = row.cloneNode(true);
  Object.assign(clone.style, {position:'fixed',left:rect.left+'px',top:rect.top+'px',width:rect.width+'px',opacity:'0.85',zIndex:'9999',pointerEvents:'none',outline:'2px dashed var(--blue)',borderRadius:'4px',background:'var(--surface)',boxShadow:'0 4px 16px rgba(0,0,0,.18)',transition:'none'});
  document.body.appendChild(clone); row.style.opacity = '0.3';
  _winTouchState = {id, sid, row, clone, offsetY: touch.clientY - rect.top, over: null};
  document.addEventListener('touchmove', _winTouchMove, {passive:false});
  document.addEventListener('touchend', _winTouchEnd);
}
function _winTouchMove(e) {
  e.preventDefault(); if (!_winTouchState) return;
  const touch = e.touches[0], {clone, offsetY} = _winTouchState;
  clone.style.top = (touch.clientY - offsetY) + 'px';
  clone.style.display = 'none';
  const under = document.elementFromPoint(touch.clientX, touch.clientY);
  clone.style.display = '';
  const targetRow = under?.closest('[data-win-id]');
  document.querySelectorAll('.prov-drag-over').forEach(el => el.classList.remove('prov-drag-over'));
  if (targetRow && targetRow !== _winTouchState.row && targetRow.dataset.winSid === _winTouchState.sid) {
    targetRow.classList.add('prov-drag-over'); _winTouchState.over = targetRow;
  } else { _winTouchState.over = null; }
}
function _winTouchEnd() {
  document.removeEventListener('touchmove', _winTouchMove); document.removeEventListener('touchend', _winTouchEnd);
  if (!_winTouchState) return;
  const {id, sid, row, clone, over} = _winTouchState; _winTouchState = null;
  clone.remove(); row.style.opacity = '';
  document.querySelectorAll('.prov-drag-over').forEach(el => el.classList.remove('prov-drag-over'));
  if (over) _winDoReorder(id, over.dataset.winId, sid);
}
function _winDoReorder(fromId, toId, sid) {
  if (!fromId || !toId || fromId === toId) return;
  const wd = getWinterData();
  const season = wd.seasons[ui.winterSeasonId || wd.currentSeason];
  if (!season) return;
  const items = season.sections?.[sid]?.items;
  if (!items) return;
  const fromIdx = items.findIndex(it => it.id === fromId);
  if (fromIdx === -1 || items.findIndex(it => it.id === toId) === -1) return;
  const [moved] = items.splice(fromIdx, 1);
  items.splice(items.findIndex(it => it.id === toId), 0, moved);
  save(); winterRerender();
}

function renderWinterSection(sid, season, archived) {
  const def  = WINTER_DEFS[sid];
  const sec  = season.sections?.[sid] || {items:[]};
  const items = sec.items;
  const done  = items.filter(x => x.checked).length;
  const total = items.length;
  const pct   = total ? Math.round(done/total*100) : 0;
  const complete = done === total && total > 0;
  const open = complete ? !!(ui.winterOpen?.[sid]) : (ui.winterOpen?.[sid] !== false);
  const badge = complete
    ? `<span style="background:var(--green);color:#fff;font-size:10px;font-weight:700;padding:2px 8px;border-radius:10px;margin-left:8px">✓ Complete</span>` : '';
  const hdr = `<div class="whdr" onclick="if(!ui.winterOpen)ui.winterOpen={};ui.winterOpen['${sid}']=!${open};winterRerender()">
    <div style="display:flex;align-items:center;gap:8px">
      <span style="font-size:17px">${def.icon}</span>
      <span style="font-size:15px;font-weight:700;color:var(--label)">${esc(def.label)}</span>${badge}
    </div>
    <div style="display:flex;align-items:center;gap:8px">
      <span style="font-size:12px;color:var(--label3);font-weight:500">${done}/${total}</span>
      <span style="font-size:11px;color:var(--label3)">${open?'▲':'▼'}</span>
    </div>
  </div>
  <div style="height:3px;background:var(--surface2)">
    <div style="height:3px;background:${complete?'var(--green)':'var(--blue)'};width:${pct}%;transition:width .4s"></div>
  </div>`;
  if (!open) return `<div class="wcard">${hdr}</div>`;
  let lastGrp = '\x00';
  const rows = items.map((item, i) => {
    const grpHdr = item.group !== lastGrp ? (lastGrp = item.group, item.group ? `<div class="wgrp">${esc(item.group)}</div>` : '') : '';
    const isEdit = ui.winterEditItem?.sid === sid && ui.winterEditItem?.idx === i;
    if (isEdit) {
      const isImp = item.text.endsWith(' ⚠️') || !!item.asterisk;
      const editTxt = item.text.replace(/ ⚠️$/, '');
      return grpHdr + `<div class="wrow" style="flex-wrap:wrap;gap:4px">
        <input id="wedit-inp" class="mi" style="flex:1;min-width:120px;margin:0;font-size:14px" value="${esc(editTxt)}"
          onkeydown="if(event.key==='Enter')saveWinterItemEdit('${sid}',${i})" onkeyup="if(event.key==='Escape'){ui.winterEditItem=null;winterRerender()}">
        <label style="display:flex;align-items:center;gap:5px;font-size:13px;cursor:pointer;white-space:nowrap;color:var(--label2)">
          <input type="checkbox" id="wedit-star" ${isImp?'checked':''}> Mark as important ⚠️
        </label>
        <button class="btn btn-p btn-xs" onclick="saveWinterItemEdit('${sid}',${i})">Save</button>
        <button class="wact" onclick="ui.winterEditItem=null;winterRerender()">Cancel</button>
        <button onclick="if(confirm('Remove this item?')){ui.winterEditItem=null;deleteWinterItem('${sid}',${i})}" style="background:#FCEBEB;border:0.5px solid #F09595;color:#A32D2D;border-radius:8px;padding:4px 10px;font-family:var(--font);font-size:12px;font-weight:600;cursor:pointer">🗑</button>
      </div>`;
    }
    const isImp = !!item.asterisk || item.text?.endsWith(' ⚠️');
    const star = (item.asterisk && !item.text?.endsWith(' ⚠️')) ? ` <span style="font-size:11px;opacity:.7">⚠️</span>` : '';
    const ts = item.checked ? 'opacity:0.4' : isImp ? 'color:var(--label2)' : '';
    const acts = archived ? '' : `<div style="display:flex;gap:1px;flex-shrink:0">
      <button style="background:none;border:none;padding:2px 4px;cursor:pointer;font-size:14px;color:var(--label3);line-height:1;flex-shrink:0" onclick="startWinterEdit('${sid}',${i})" title="Edit">✏️</button>
    </div>`;
    const winDragAttrs = archived ? '' : ` data-win-id="${item.id}" data-win-sid="${sid}" draggable="true" ondragstart="winDragStart(event,'${item.id}','${sid}')" ondragover="winDragOver(event,'${item.id}','${sid}')" ondragleave="winDragLeave(event)" ondrop="winDrop(event,'${item.id}','${sid}')" ondragend="winDragEnd()"`;
    const winGrip = archived ? '' : `<span class="prov-grip" ontouchstart="winTouchStart(event,'${item.id}','${sid}')">⠿</span>`;
    return grpHdr + `<div class="wrow"${winDragAttrs}>
      ${winGrip}
      <div class="wbox${item.checked?' on':''}" onclick="toggleWinterItem('${sid}',${i})">
        ${item.checked?'<svg width="11" height="9" viewBox="0 0 11 9"><polyline points="1,4.5 4,7.5 10,1" stroke="#fff" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>':''}
      </div>
      <div style="flex:1;font-size:14px;line-height:1.4;${ts};cursor:pointer" onclick="toggleWinterItem('${sid}',${i})">${esc(item.text)}${star}</div>
      ${acts}
    </div>`;
  }).join('');
  const addRow = archived ? '' : `<div style="padding:10px 16px;border-top:1px solid var(--sep)">
    <button onclick="showAddWinterItem('${sid}')" style="background:none;border:none;padding:0;cursor:pointer;font-size:13px;font-weight:500;color:var(--blue);font-family:var(--font)">+ Add item</button>
  </div>`;
  return `<div class="wcard">${hdr}<div style="border-top:1px solid var(--sep)">${rows}${addRow}</div></div>`;
}

function renderWinterization() {
  const wd = getWinterData();
  if (!ui.winterSeasonId) ui.winterSeasonId = wd.currentSeason;
  if (!ui.winterOpen) ui.winterOpen = {winterize:true, needs:true, backOnBoard:true};
  const season = wd.seasons[ui.winterSeasonId];
  if (!season) return '';
  const archived = season.archived;
  const isCurrent = ui.winterSeasonId === wd.currentSeason;
  const sids = ['winterize','needs','backOnBoard'];
  const allComplete = sids.every(sid => { const items=(season.sections?.[sid]?.items||[]); return items.length>0&&items.every(x=>x.checked); });
  const seasonOpts = Object.keys(wd.seasons).reverse().map(id =>
    `<option value="${id}" ${id===ui.winterSeasonId?'selected':''}>${esc(wd.seasons[id].name)}${wd.seasons[id].archived?' (archived)':''}</option>`
  ).join('');
  const hdr = `<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:16px;gap:8px;flex-wrap:wrap">
    <select onchange="ui.winterSeasonId=this.value;ui.winterOpen=null;ui.winterEditItem=null;winterRerender()"
      style="background:var(--surface);border:0.5px solid var(--sep);border-radius:20px;padding:7px 14px;font-size:14px;font-weight:600;font-family:var(--font);color:var(--label);cursor:pointer;max-width:220px">${seasonOpts}</select>
    ${isCurrent&&!archived?`<button class="btn btn-d btn-sm" onclick="resetWinterSeason()">Reset season</button>`:''}
    ${archived?`<span style="font-size:12px;color:var(--label3);font-weight:500;padding:6px 12px;background:var(--surface2);border-radius:12px">Archived</span>`:''}
  </div>`;
  const congr = allComplete&&!archived ? `<div style="background:rgba(52,199,89,.12);border:2px solid var(--green);border-radius:14px;padding:18px 20px;margin-bottom:16px;text-align:center">
    <div style="font-size:20px;font-weight:700;color:var(--green)">${esc(season.name)} complete! ⚓</div>
    <div style="font-size:13px;color:var(--label3);margin:6px 0 14px">All sections done. Ready to archive.</div>
    <button class="btn btn-p btn-sm" onclick="startNewWinterSeason()">Start Winter ${nextWinterName(season.name)} →</button>
  </div>` : '';
  return hdr + congr + sids.map(sid => renderWinterSection(sid, season, archived)).join('');
}

function toggleWinterItem(sid, idx) {
  const season = getWinterData().seasons[getWinterData().currentSeason];
  if (!season||season.archived) return;
  const item = season.sections?.[sid]?.items?.[idx]; if (!item) return;
  item.checked = !item.checked;
  save(); winterRerender();
}

function startWinterEdit(sid, idx) {
  ui.winterEditItem = {sid, idx};
  winterRerender();
  setTimeout(() => document.getElementById('wedit-inp')?.focus(), 40);
}

function saveWinterItemEdit(sid, idx) {
  const season = getWinterData().seasons[getWinterData().currentSeason];
  const item = season?.sections?.[sid]?.items?.[idx]; if (!item) return;
  let v = document.getElementById('wedit-inp')?.value.trim();
  if (!v) return;
  v = v.replace(/ ⚠️$/, '');
  const important = !!document.getElementById('wedit-star')?.checked;
  if (important) v += ' ⚠️';
  item.text = v;
  item.asterisk = important;
  ui.winterEditItem = null;
  save(); winterRerender();
}

function deleteWinterItem(sid, idx) {
  const season = getWinterData().seasons[getWinterData().currentSeason];
  if (!season||season.archived) return;
  season.sections?.[sid]?.items?.splice(idx, 1);
  save(); winterRerender();
}

function showAddWinterItem(sid) {
  showModal('Add Item', `
    <div class="mi-label">Item text</div>
    <input class="mi" id="m-wadd" placeholder="e.g. Check anchor chain" autofocus>
    <label style="display:flex;align-items:center;gap:8px;font-size:14px;margin:12px 0">
      <input type="checkbox" id="m-wstar"> Mark as important ⚠️
    </label>
    <div class="modal-btns">
      <button class="btn btn-s" onclick="hideModal()">Cancel</button>
      <button class="btn btn-p" onclick="addWinterItem('${sid}')">Add</button>
    </div>`);
}

function addWinterItem(sid) {
  let text = document.getElementById('m-wadd')?.value.trim();
  if (!text) { showToast('Enter item text', true); return; }
  const important = !!document.getElementById('m-wstar')?.checked;
  text = text.replace(/ ⚠️$/, '');
  if (important) text += ' ⚠️';
  const wd = getWinterData();
  const season = wd.seasons[wd.currentSeason];
  if (!season||season.archived) return;
  if (!season.sections[sid]) season.sections[sid] = {items:[]};
  season.sections[sid].items.push({id:uid(), text, asterisk: important, checked:false, group:null});
  save(); hideModal(); winterRerender();
}

function resetWinterSeason() {
  if (!confirm('Reset all checkboxes for this season?')) return;
  const wd = getWinterData();
  const season = wd.seasons[wd.currentSeason];
  if (!season||season.archived) return;
  ['winterize','needs','backOnBoard'].forEach(sid => { (season.sections?.[sid]?.items||[]).forEach(item => item.checked=false); });
  ui.winterOpen = {winterize:true, needs:true, backOnBoard:true};
  ui.winterEditItem = null;
  save(); winterRerender();
}

function startNewWinterSeason() {
  const wd = getWinterData();
  const cur = wd.seasons[wd.currentSeason]; if (!cur) return;
  cur.archived = true;
  const newName = 'Winter ' + nextWinterName(cur.name);
  const newId = 'w' + newName.replace(/[^0-9]/g,'');
  wd.seasons[newId] = { name:newName, archived:false, sections:{
    winterize:  {items: buildWinterSectionItems('winterize',  [])},
    needs:      {items: buildWinterSectionItems('needs',      [])},
    backOnBoard:{items: buildWinterSectionItems('backOnBoard', [])}
  }};
  wd.currentSeason = newId;
  ui.winterSeasonId = newId;
  ui.winterOpen = {winterize:true, needs:true, backOnBoard:true};
  ui.winterEditItem = null;
  save(); winterRerender();
}

// ═══════════════════════════════════════════════════════════
//  PASSAGE LOG (Log Book tab)
// ═══════════════════════════════════════════════════════════

let _lbGpsPos = null, _lbPid = null, _lbWatchId = null, _lbPrevFix = null;

function getPassageLog() {
  if (!data.passageLog || typeof data.passageLog !== 'object' || Array.isArray(data.passageLog))
    data.passageLog = { passages: [] };
  if (!Array.isArray(data.passageLog.passages)) data.passageLog.passages = [];
  return data.passageLog;
}
function findPassage(pid) { return getPassageLog().passages.find(p => p.id === pid) || null; }

function haversineNm(lat1, lon1, lat2, lon2) {
  const R = 3440.065, r = Math.PI / 180;
  const dLat = (lat2 - lat1) * r, dLon = (lon2 - lon1) * r;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * r) * Math.cos(lat2 * r) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}
function bearingDeg(lat1, lon1, lat2, lon2) {
  const r = Math.PI / 180, dLon = (lon2 - lon1) * r;
  const y = Math.sin(dLon) * Math.cos(lat2 * r);
  const x = Math.cos(lat1 * r) * Math.sin(lat2 * r) - Math.sin(lat1 * r) * Math.cos(lat2 * r) * Math.cos(dLon);
  return Math.round(((Math.atan2(y, x) * 180 / Math.PI) + 360) % 360);
}
function fmtLat(v) {
  if (v == null) return '—';
  const a = Math.abs(v), d = Math.floor(a);
  return `${d}°${((a - d) * 60).toFixed(2)}'${v >= 0 ? 'N' : 'S'}`;
}
function fmtLon(v) {
  if (v == null) return '—';
  const a = Math.abs(v), d = Math.floor(a);
  return `${d}°${((a - d) * 60).toFixed(2)}'${v >= 0 ? 'E' : 'W'}`;
}

// ── Offshore stats helpers ──

function lbCalcNmGps(entries) {
  const gps = [...entries].filter(e => e.position?.lat != null && e.timestamp)
    .sort((a, b) => a.timestamp < b.timestamp ? -1 : 1);
  let nm = 0;
  for (let i = 1; i < gps.length; i++)
    nm += haversineNm(gps[i-1].position.lat, gps[i-1].position.lon,
                      gps[i].position.lat,   gps[i].position.lon);
  return nm;
}

function lbCalc24hWindows(entries) {
  const gps = [...entries].filter(e => e.position?.lat != null && e.timestamp)
    .sort((a, b) => a.timestamp < b.timestamp ? -1 : 1);
  if (gps.length < 2) return [];
  const windows = [];
  for (let i = 0; i < gps.length - 1; i++) {
    const t0 = new Date(gps[i].timestamp).getTime();
    let nm = 0, j = i + 1;
    while (j < gps.length) {
      if (new Date(gps[j].timestamp).getTime() - t0 > 86400000) break;
      nm += haversineNm(gps[j-1].position.lat, gps[j-1].position.lon,
                        gps[j].position.lat,   gps[j].position.lon);
      j++;
    }
    if (nm > 0) windows.push(nm);
  }
  return windows;
}

function parseDestCoords(str) {
  if (!str) return null;
  const m = str.match(/(-?\d+\.?\d*)[,\s]+(-?\d+\.?\d*)/);
  if (!m) return null;
  const lat = parseFloat(m[1]), lon = parseFloat(m[2]);
  if (isNaN(lat) || isNaN(lon) || lat < -90 || lat > 90 || lon < -180 || lon > 180) return null;
  return { lat, lon };
}

// ── Render ──

function renderPassageLog() {
  if (!ui.logbookMode) ui.logbookMode = 'coastal';
  const mode = ui.logbookMode;
  const activeStyle = 'background:var(--surface);color:var(--label);box-shadow:0 1px 3px rgba(0,0,0,.12)';
  const inactiveStyle = 'background:transparent;color:var(--label3)';
  const toggle = `<div style="margin:12px 12px 6px;display:flex;background:var(--surface2);border-radius:10px;padding:3px;gap:3px">
    <button onclick="ui.logbookMode='coastal';document.getElementById('mainContent').innerHTML=renderPassageLog()" style="flex:1;padding:7px;border:none;border-radius:8px;font-size:13px;font-weight:600;cursor:pointer;font-family:var(--font);${mode==='coastal'?activeStyle:inactiveStyle}">⛵ Coastal</button>
    <button onclick="ui.logbookMode='offshore';document.getElementById('mainContent').innerHTML=renderPassageLog()" style="flex:1;padding:7px;border:none;border-radius:8px;font-size:13px;font-weight:600;cursor:pointer;font-family:var(--font);${mode==='offshore'?activeStyle:inactiveStyle}">🌊 Offshore</button>
  </div>`;
  return toggle + (mode === 'offshore' ? renderOffshoreLog() : renderCoastalLog());
}

function renderOffshoreLog() {
  const pl = getPassageLog();
  const active    = [...pl.passages].filter(p => !p.completed).reverse();
  const completed = [...pl.passages].filter(p =>  p.completed).reverse();
  const newBtn = `<div style="padding:4px 12px 4px">
    <button onclick="showNewPassage()" style="width:100%;background:var(--blue);color:#fff;border:none;border-radius:12px;padding:12px;font-size:14px;font-weight:600;font-family:var(--font);cursor:pointer">+ New passage</button>
  </div>`;
  if (!active.length && !completed.length) return `<div style="padding-bottom:80px">${newBtn}
    <div style="text-align:center;padding:40px 20px;color:var(--label3);font-size:14px">No passages yet.<br>Tap "+ New passage" to begin logging.</div>
  </div>`;
  const completedSection = completed.length ? `
    <div style="margin:8px 12px 4px;font-size:11px;font-weight:700;color:var(--label3);text-transform:uppercase;letter-spacing:.4px">Completed passages</div>
    ${completed.map(p => renderPassage(p)).join('')}` : '';
  return `<div style="padding-bottom:80px">${newBtn}${active.map(p => renderPassage(p)).join('')}${completedSection}</div>`;
}

function renderPassage(p) {
  if (!ui.logbookOpen) ui.logbookOpen = {};
  const open = ui.logbookOpen[p.id] !== false;
  const entries = [...(p.entries || [])].sort((a, b) => a.timestamp < b.timestamp ? -1 : 1);
  const totalNm = lbCalcNmGps(entries);
  const sogVals = entries.filter(e => e.sog != null).map(e => parseFloat(e.sog));
  const avgSog = sogVals.length ? (sogVals.reduce((a, b) => a + b, 0) / sogVals.length).toFixed(1) : '—';
  let duration = '—';
  if (p.startDate && (p.endDate || p.completed)) {
    const end = p.completedAt ? new Date(p.completedAt) : (p.endDate ? new Date(p.endDate) : new Date());
    const d = Math.round((end - new Date(p.startDate + 'T00:00:00')) / 86400000);
    duration = d === 0 ? '<1d' : `${d}d`;
  } else if (p.startDate && !p.completed) {
    const d = Math.round((Date.now() - new Date(p.startDate + 'T00:00:00')) / 86400000);
    duration = d === 0 ? 'Day 1' : `${d}d`;
  }
  const toggle = `ui.logbookOpen=ui.logbookOpen||{};ui.logbookOpen['${p.id}']=!${open};document.getElementById('mainContent').innerHTML=renderPassageLog()`;
  const completedBadge = p.completed
    ? `<span style="font-size:10px;font-weight:700;color:#639922;background:rgba(99,153,34,.12);border-radius:8px;padding:1px 6px;flex-shrink:0">✓ Done</span>`
    : '';
  const actionBar = p.completed
    ? `<div style="padding:8px 12px;border-bottom:1px solid var(--sep);display:flex;align-items:center;gap:6px">
        <button onclick="event.stopPropagation();exportPassage('${p.id}')" style="background:var(--surface2);color:var(--label);border:0.5px solid var(--sep);border-radius:8px;padding:5px 10px;font-size:11px;font-weight:600;font-family:var(--font);cursor:pointer">🖨 Export</button>
        <button onclick="event.stopPropagation();showDeletePassage('${p.id}')" style="background:none;color:var(--red);border:0.5px solid var(--sep);border-radius:8px;padding:5px 10px;font-size:11px;font-family:var(--font);cursor:pointer">✕ Delete</button>
      </div>`
    : `<div style="padding:8px 12px;border-bottom:1px solid var(--sep);display:flex;align-items:center;gap:6px">
        <button onclick="event.stopPropagation();exportPassage('${p.id}')" style="background:var(--surface2);color:var(--label);border:0.5px solid var(--sep);border-radius:8px;padding:5px 10px;font-size:11px;font-weight:600;font-family:var(--font);cursor:pointer">🖨 Export</button>
        <button onclick="event.stopPropagation();showDeletePassage('${p.id}')" style="background:none;color:var(--red);border:0.5px solid var(--sep);border-radius:8px;padding:5px 8px;font-size:11px;font-family:var(--font);cursor:pointer">✕</button>
        <button onclick="event.stopPropagation();showCompletePassage('${p.id}')" style="background:rgba(99,153,34,.1);color:#639922;border:0.5px solid rgba(99,153,34,.3);border-radius:8px;padding:5px 10px;font-size:11px;font-weight:700;font-family:var(--font);cursor:pointer">✓ Complete</button>
        <button onclick="event.stopPropagation();showNewEntry('${p.id}')" style="margin-left:auto;background:var(--blue);color:#fff;border:none;border-radius:8px;padding:5px 14px;font-size:12px;font-weight:600;font-family:var(--font);cursor:pointer">+ New entry</button>
      </div>`;
  const recap = (open && entries.length) ? (p.completed ? renderCompletedRecap(p) : renderLiveRecap(p)) : '';
  return `<div style="margin:0 12px 12px;background:var(--surface);border:0.5px solid var(--sep);border-radius:14px;overflow:hidden">
    <div onclick="${toggle}" style="padding:12px 14px;cursor:pointer;display:flex;align-items:center;justify-content:space-between;user-select:none;-webkit-user-select:none">
      <div style="min-width:0;flex:1">
        <div style="font-size:14px;font-weight:700;color:var(--label);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;display:flex;align-items:center;gap:6px">
          <span style="overflow:hidden;text-overflow:ellipsis;min-width:0">${esc(p.name || 'Unnamed passage')}</span>${completedBadge}
        </div>
        <div style="font-size:11px;color:var(--label3);margin-top:2px">${esc(p.from || '?')} → ${esc(p.to || '?')} · ${esc(p.startDate || '?')}</div>
      </div>
      <span style="color:var(--label3);font-size:15px;margin-left:8px;flex-shrink:0">${open ? '▲' : '▼'}</span>
    </div>
    ${open ? `
    <div style="display:grid;grid-template-columns:repeat(4,1fr);border-top:1px solid var(--sep);border-bottom:1px solid var(--sep)">
      ${[
        [totalNm.toFixed(1), 'nm total'],
        [avgSog !== '—' ? avgSog + 'kn' : '—', 'avg SOG'],
        [duration, 'duration'],
        [String(entries.length), 'entries']
      ].map(([v, l], i) => `<div style="padding:8px 4px;text-align:center${i < 3 ? ';border-right:1px solid var(--sep)' : ''}">
        <div style="font-size:13px;font-weight:700;color:var(--label)">${esc(v)}</div>
        <div style="font-size:9px;color:var(--label3)">${l}</div>
      </div>`).join('')}
    </div>
    ${actionBar}
    ${recap}
    ${entries.map(e => renderPassageEntryRow(e, p.id)).join('') ||
      '<div style="padding:14px;text-align:center;font-size:12px;color:var(--label3)">No entries yet — tap "+ New entry" to start</div>'}
    ` : ''}
  </div>`;
}

function renderPassageEntryRow(e, pid) {
  const ts = e.timestamp ? new Date(e.timestamp) : null;
  const timeStr = ts
    ? ts.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }) + ' ' +
      ts.toLocaleDateString('en-GB', { day: '2-digit', month: 'short' })
    : '—';
  const posStr = (e.position?.lat != null && e.position?.lon != null)
    ? fmtLat(e.position.lat) + ' ' + fmtLon(e.position.lon) : '';
  const srcBadge = e.positionSource === 'gps'
    ? `<span style="font-size:9px;padding:1px 5px;border-radius:4px;background:rgba(34,197,94,.15);color:#15803d;font-weight:700">GPS</span>` : '';
  const notesSnip = e.notes ? ' · ' + e.notes.slice(0, 35) + (e.notes.length > 35 ? '…' : '') : '';
  const distStr = e.distanceRun ? `<span style="font-size:10px;color:var(--blue);font-weight:600">${(+e.distanceRun).toFixed(1)} nm</span> ` : '';
  return `<div style="padding:8px 12px;border-bottom:1px solid var(--sep);display:flex;align-items:center;gap:6px">
    <div style="flex:1;min-width:0">
      <div style="font-size:11px;font-weight:600;color:var(--label);display:flex;align-items:center;gap:4px;flex-wrap:wrap">
        <span>${esc(timeStr)}</span>${srcBadge}${distStr}
      </div>
      <div style="font-size:10px;color:var(--label3);margin-top:1px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">
        ${posStr ? esc(posStr) : ''}${e.cog != null ? ` · COG ${e.cog}°` : ''}${e.sog != null ? ` · SOG ${e.sog}kn` : ''}${e.windDir != null ? ` · 💨 ${e.windDir}°${e.windSpeed != null ? ' ' + e.windSpeed + 'kn' : ''}` : ''}${e.currentSpeed != null ? ` · 🌊 ${e.currentSpeed}kn` : ''}${esc(notesSnip)}
      </div>
    </div>
    <button onclick="event.stopPropagation();showEditEntry('${pid}','${e.id}')" style="background:none;border:0.5px solid var(--sep);border-radius:8px;padding:3px 8px;font-size:11px;cursor:pointer;color:var(--label3);flex-shrink:0">✏</button>
  </div>`;
}

// ── Passage CRUD ──

function showNewPassage() {
  const today = new Date().toISOString().slice(0, 10);
  showModal('New Passage', `
    <div class="mi-label">Passage name</div><input class="mi" id="lbp-name" placeholder="e.g. Lisbon to Madeira">
    <div class="mi-label">From</div><input class="mi" id="lbp-from" placeholder="Departure port">
    <div class="mi-label">To</div><input class="mi" id="lbp-to" placeholder="Destination port">
    <div class="mi-label">Destination coords (optional)</div><input class="mi" id="lbp-dest" placeholder="e.g. 32.63, -16.90 — for live progress">
    <div class="mi-label">Start date</div><input class="mi" id="lbp-start" type="date" value="${today}">
    <div class="mi-label">End date (optional)</div><input class="mi" id="lbp-end" type="date">
    <div class="modal-btns">
      <button class="btn btn-s" onclick="hideModal()">Cancel</button>
      <button class="btn btn-p" onclick="saveNewPassage()">Create</button>
    </div>`);
}
function saveNewPassage() {
  const name = document.getElementById('lbp-name')?.value.trim();
  if (!name) { showToast('Enter a passage name', true); return; }
  const pl = getPassageLog();
  const p = {
    id: uid(), name,
    from:        document.getElementById('lbp-from')?.value.trim()  || '',
    to:          document.getElementById('lbp-to')?.value.trim()    || '',
    destination: document.getElementById('lbp-dest')?.value.trim()  || '',
    startDate:   document.getElementById('lbp-start')?.value        || '',
    endDate:     document.getElementById('lbp-end')?.value          || '',
    entries: []
  };
  pl.passages.push(p);
  if (!ui.logbookOpen) ui.logbookOpen = {};
  ui.logbookOpen[p.id] = true;
  save(); hideModal();
  document.getElementById('mainContent').innerHTML = renderPassageLog();
}
function showDeletePassage(pid) {
  showModal('Delete passage', `<div style="padding:8px 0 12px;font-size:14px;color:var(--label)">Delete this passage and all its entries? This cannot be undone.</div>
    <div class="modal-btns">
      <button class="btn btn-s" onclick="hideModal()">Cancel</button>
      <button class="btn btn-p" style="background:var(--red);border-color:var(--red)" onclick="deletePassage('${pid}')">Delete</button>
    </div>`);
}
function deletePassage(pid) {
  const pl = getPassageLog();
  pl.passages = pl.passages.filter(p => p.id !== pid);
  save(); hideModal();
  document.getElementById('mainContent').innerHTML = renderPassageLog();
}

function renderLiveRecap(p) {
  const entries = [...(p.entries || [])].filter(e => e.position?.lat != null && e.timestamp)
    .sort((a, b) => a.timestamp < b.timestamp ? -1 : 1);
  // Day of passage
  const dayNum = p.startDate
    ? Math.max(1, Math.ceil((Date.now() - new Date(p.startDate + 'T00:00:00').getTime()) / 86400000))
    : null;
  // nm done from GPS track
  let nmDone = 0;
  for (let i = 1; i < entries.length; i++)
    nmDone += haversineNm(entries[i-1].position.lat, entries[i-1].position.lon,
                          entries[i].position.lat,   entries[i].position.lon);
  // nm to destination
  let nmToDest = null;
  const destCoords = parseDestCoords(p.destination);
  if (destCoords && entries.length) {
    const last = entries[entries.length - 1];
    nmToDest = haversineNm(last.position.lat, last.position.lon, destCoords.lat, destCoords.lon);
  }
  // Progress bar (nm done / straight-line total)
  let progressFrac = null;
  if (destCoords && entries.length && nmDone > 0) {
    const first = entries[0];
    const directDist = haversineNm(first.position.lat, first.position.lon, destCoords.lat, destCoords.lon);
    progressFrac = Math.min(1, nmDone / Math.max(1, nmDone + directDist));
  }
  // 24h windows
  const windows = lbCalc24hWindows(entries);
  const best24h = windows.length ? Math.max(...windows).toFixed(1) + ' nm' : '—';
  // Avg SOG last 24h
  const now = Date.now();
  const last24 = entries.filter(e => now - new Date(e.timestamp).getTime() <= 86400000);
  let last24Nm = 0;
  for (let i = 1; i < last24.length; i++)
    last24Nm += haversineNm(last24[i-1].position.lat, last24[i-1].position.lon,
                            last24[i].position.lat,   last24[i].position.lon);
  const avgSog24 = last24.length >= 2 ? (last24Nm / 24).toFixed(1) + ' kn' : '—';
  const progressBar = progressFrac != null
    ? `<div style="background:var(--sep);border-radius:4px;height:6px;margin:6px 0 10px;overflow:hidden">
        <div style="height:100%;width:${(progressFrac*100).toFixed(1)}%;background:#639922;border-radius:4px"></div>
      </div>` : '';
  const stats = [
    [nmDone > 0 ? nmDone.toFixed(1) + ' nm' : '—', 'nm travelled'],
    [nmToDest != null ? nmToDest.toFixed(1) + ' nm' : '—', 'nm to dest'],
    [best24h, 'best 24h run'],
    [avgSog24, 'avg SOG 24h'],
  ];
  return `<div style="background:rgba(55,138,221,.06);border-bottom:1px solid var(--sep);padding:10px 12px">
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:4px">
      <span style="font-size:10px;font-weight:700;color:var(--blue);text-transform:uppercase;letter-spacing:.4px">Live Recap</span>
      ${dayNum ? `<span style="font-size:10px;font-weight:600;color:var(--label3);background:var(--surface2);border-radius:10px;padding:1px 7px">Day ${dayNum}</span>` : ''}
    </div>
    ${progressBar}
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:6px">
      ${stats.map(([v, l]) => `<div style="background:var(--surface);border-radius:8px;padding:7px 10px">
        <div style="font-size:14px;font-weight:700;color:var(--label)">${esc(v)}</div>
        <div style="font-size:9px;color:var(--label3);margin-top:1px;text-transform:uppercase;letter-spacing:.2px">${l}</div>
      </div>`).join('')}
    </div>
  </div>`;
}

function renderCompletedRecap(p) {
  const entries = [...(p.entries || [])].filter(e => e.timestamp)
    .sort((a, b) => a.timestamp < b.timestamp ? -1 : 1);
  const gpsE = entries.filter(e => e.position?.lat != null);
  const totalNm = lbCalcNmGps(entries);
  let totalTimeStr = '—', avgSpeedStr = '—';
  if (entries.length >= 2) {
    const ms = new Date(entries[entries.length-1].timestamp).getTime() - new Date(entries[0].timestamp).getTime();
    const days = Math.floor(ms / 86400000);
    const hrs  = Math.floor((ms % 86400000) / 3600000);
    const mins = Math.floor((ms % 3600000) / 60000);
    totalTimeStr = days > 0 ? `${days}d ${hrs}h` : `${hrs}h ${mins}m`;
    if (totalNm > 0 && ms > 0) avgSpeedStr = (totalNm / (ms / 3600000)).toFixed(1) + ' kn';
  }
  const windows    = lbCalc24hWindows(gpsE);
  const best24h    = windows.length      ? Math.max(...windows).toFixed(1) + ' nm' : '—';
  const slowest24h = windows.length >= 2 ? Math.min(...windows).toFixed(1) + ' nm' : '—';
  const sogVals    = entries.filter(e => e.sog != null).map(e => parseFloat(e.sog));
  const maxSog     = sogVals.length  ? Math.max(...sogVals).toFixed(1) + ' kn' : '—';
  const windVals   = entries.filter(e => e.windSpeed != null).map(e => parseFloat(e.windSpeed));
  const avgWind    = windVals.length ? (windVals.reduce((a, b) => a + b, 0) / windVals.length).toFixed(1) + ' kn' : '—';
  const fmtUtc = ts => {
    if (!ts) return '—';
    const d = new Date(ts);
    return d.toLocaleDateString('en-GB', { day:'2-digit', month:'short', timeZone:'UTC' }) + ' ' +
           d.toLocaleTimeString('en-GB', { hour:'2-digit', minute:'2-digit', timeZone:'UTC' }) + ' UTC';
  };
  const records = [
    ['Fastest 24h', best24h, '#639922'],
    ['Slowest 24h', slowest24h, null],
    ['Max SOG', maxSog, null],
    ['Avg wind', avgWind, null],
    ['Total entries', String(entries.length), null],
    ['Departed', fmtUtc(entries[0]?.timestamp), null],
    ['Arrived',  fmtUtc(p.completedAt || entries[entries.length-1]?.timestamp), null],
  ];
  return `<div style="background:rgba(99,153,34,.06);border-bottom:1px solid rgba(99,153,34,.2);padding:12px">
    <div style="display:flex;align-items:center;gap:12px;margin-bottom:10px">
      <div style="text-align:center;min-width:64px">
        <div style="font-size:34px;font-weight:800;color:#639922;line-height:1">${totalNm.toFixed(1)}</div>
        <div style="font-size:9px;color:var(--label3);text-transform:uppercase;letter-spacing:.3px;margin-top:1px">nm sailed</div>
      </div>
      <div style="flex:1;display:grid;grid-template-columns:1fr 1fr;gap:5px">
        ${[['Total time', totalTimeStr], ['Avg speed', avgSpeedStr]].map(([l, v]) => `
          <div style="background:var(--surface);border-radius:8px;padding:6px 8px">
            <div style="font-size:12px;font-weight:700;color:var(--label)">${esc(v)}</div>
            <div style="font-size:9px;color:var(--label3)">${l}</div>
          </div>`).join('')}
      </div>
    </div>
    <div style="background:var(--surface);border-radius:8px;overflow:hidden">
      ${records.map(([l, v, c]) => `
        <div style="display:flex;justify-content:space-between;align-items:center;padding:5px 10px;border-bottom:1px solid var(--sep)">
          <span style="font-size:11px;color:var(--label3)">${l}</span>
          <span style="font-size:11px;font-weight:600;color:${c || 'var(--label)'}">${esc(v)}</span>
        </div>`).join('')}
    </div>
  </div>`;
}

function showCompletePassage(pid) {
  showModal('Complete passage', `
    <div style="padding:8px 0 12px;font-size:14px;color:var(--label)">Mark this passage as complete and see final stats?</div>
    <div class="modal-btns">
      <button class="btn btn-s" onclick="hideModal()">Cancel</button>
      <button class="btn btn-p" style="background:#639922;border-color:#639922" onclick="completePassage('${pid}')">Complete</button>
    </div>`);
}

function completePassage(pid) {
  const pl = getPassageLog();
  const p = pl.passages.find(x => x.id === pid);
  if (!p) return;
  p.completed = true;
  p.completedAt = new Date().toISOString();
  if (!p.endDate) p.endDate = new Date().toISOString().slice(0, 10);
  save(); hideModal();
  setTimeout(() => showPassageFinalStats(p), 60);
}

function showPassageFinalStats(p) {
  const entries = [...(p.entries || [])].filter(e => e.timestamp)
    .sort((a, b) => a.timestamp < b.timestamp ? -1 : 1);
  const gpsE = entries.filter(e => e.position?.lat != null);
  const totalNm = lbCalcNmGps(entries);
  // Total time
  let totalTimeStr = '—', avgSpeedStr = '—';
  if (entries.length >= 2) {
    const ms = new Date(entries[entries.length-1].timestamp).getTime() - new Date(entries[0].timestamp).getTime();
    const days = Math.floor(ms / 86400000);
    const hrs  = Math.floor((ms % 86400000) / 3600000);
    const mins = Math.floor((ms % 3600000) / 60000);
    totalTimeStr = days > 0 ? `${days}d ${hrs}h ${mins}m` : `${hrs}h ${mins}m`;
    if (totalNm > 0 && ms > 0) avgSpeedStr = (totalNm / (ms / 3600000)).toFixed(1) + ' kn';
  }
  // 24h records
  const windows = lbCalc24hWindows(gpsE);
  const best24h    = windows.length ? Math.max(...windows).toFixed(1) + ' nm' : '—';
  const slowest24h = windows.length >= 2 ? Math.min(...windows).toFixed(1) + ' nm' : '—';
  // Max SOG
  const sogVals  = entries.filter(e => e.sog != null).map(e => parseFloat(e.sog));
  const maxSog   = sogVals.length ? Math.max(...sogVals).toFixed(1) + ' kn' : '—';
  // Avg wind
  const windVals = entries.filter(e => e.windSpeed != null).map(e => parseFloat(e.windSpeed));
  const avgWind  = windVals.length ? (windVals.reduce((a, b) => a + b, 0) / windVals.length).toFixed(1) + ' kn' : '—';
  // Timestamps
  const fmtUtc = ts => {
    if (!ts) return '—';
    const d = new Date(ts);
    return d.toLocaleDateString('en-GB', { day:'2-digit', month:'short', year:'numeric', timeZone:'UTC' }) +
           ' ' + d.toLocaleTimeString('en-GB', { hour:'2-digit', minute:'2-digit', timeZone:'UTC' }) + ' UTC';
  };
  showModal('Passage complete', `
    <div style="text-align:center;padding:8px 0 16px">
      <div style="font-size:48px;font-weight:800;color:#639922;line-height:1">${totalNm.toFixed(1)}</div>
      <div style="font-size:13px;color:var(--label3);margin-top:2px">nautical miles sailed</div>
      <div style="font-size:14px;font-weight:600;color:var(--label);margin-top:6px">${esc(p.name || '')}</div>
    </div>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:14px">
      ${[['Total time', totalTimeStr], ['Avg speed', avgSpeedStr]].map(([l, v]) => `
        <div style="background:var(--surface2);border-radius:10px;padding:10px 12px;text-align:center">
          <div style="font-size:17px;font-weight:700;color:var(--label)">${esc(v)}</div>
          <div style="font-size:10px;color:var(--label3)">${l}</div>
        </div>`).join('')}
    </div>
    <div style="background:var(--surface2);border-radius:10px;overflow:hidden;margin-bottom:14px">
      <div style="font-size:10px;font-weight:700;color:var(--label2);padding:8px 12px 4px;text-transform:uppercase;letter-spacing:.3px">Records</div>
      ${[
        ['Fastest 24h run', best24h, '#639922'],
        ['Slowest 24h run', slowest24h, null],
        ['Max SOG', maxSog, null],
        ['Avg wind', avgWind, null],
        ['Total entries', String(entries.length), null],
        ['Departed (UTC)', fmtUtc(entries[0]?.timestamp), null],
        ['Arrived (UTC)', fmtUtc(p.completedAt || entries[entries.length-1]?.timestamp), null],
      ].map(([l, v, c]) => `
        <div style="display:flex;justify-content:space-between;align-items:center;padding:8px 12px;border-top:1px solid var(--sep)">
          <span style="font-size:12px;color:var(--label3)">${l}</span>
          <span style="font-size:12px;font-weight:600;color:${c || 'var(--label)'}">${esc(v)}</span>
        </div>`).join('')}
    </div>
    <div class="modal-btns">
      <button class="btn btn-p" onclick="hideModal();document.getElementById('mainContent').innerHTML=renderPassageLog()">Done</button>
    </div>`);
}

// ── Entry form ──

function lbEntryForm(e) {
  const lat = e?.position?.lat != null ? String(e.position.lat.toFixed(5)) : '';
  const lon = e?.position?.lon != null ? String(e.position.lon.toFixed(5)) : '';
  const tsVal = e?.timestamp
    ? new Date(e.timestamp).toISOString().slice(0, 16)
    : new Date().toISOString().slice(0, 16);
  const SEA = ['Calm', 'Slight', 'Moderate', 'Rough', 'Very rough', 'High'];
  const seaSel = SEA.map(s => `<option value="${s}"${e?.seaState === s ? ' selected' : ''}>${s}</option>`).join('');
  const isNew = !e;
  return `
    <div class="mi-label">Date / Time (UTC)</div>
    <input class="mi" id="lb-ts" type="datetime-local" value="${tsVal}">
    <div style="background:rgba(34,197,94,.08);border:0.5px solid rgba(34,197,94,.3);border-radius:10px;padding:10px;margin-bottom:10px">
      <div style="font-size:11px;font-weight:700;color:#15803d;margin-bottom:8px">📍 Position <span id="lb-gps-status" style="font-weight:400;color:#15803d;font-size:10px">${isNew ? 'GPS acquiring…' : ''}</span></div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:6px">
        <div><div class="mi-label" style="font-size:10px">Lat</div><input class="mi" id="lb-lat" value="${esc(lat)}" placeholder="e.g. 36.72134" style="font-size:12px"></div>
        <div><div class="mi-label" style="font-size:10px">Lon</div><input class="mi" id="lb-lon" value="${esc(lon)}" placeholder="e.g. −8.56789" style="font-size:12px"></div>
        <div><div class="mi-label" style="font-size:10px">COG °</div><input class="mi" id="lb-cog" value="${e?.cog != null ? e.cog : ''}" placeholder="—" type="number" min="0" max="359"></div>
        <div><div class="mi-label" style="font-size:10px">SOG kn</div><input class="mi" id="lb-sog" value="${e?.sog != null ? e.sog : ''}" placeholder="—" type="number" step="0.1" min="0"></div>
      </div>
    </div>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:6px;margin-bottom:10px">
      <div><div class="mi-label">Wind dir °</div><input class="mi" id="lb-wind-dir" value="${e?.windDir != null ? e.windDir : ''}" placeholder="e.g. 225" type="number" min="0" max="359"></div>
      <div><div class="mi-label">Wind kn</div><input class="mi" id="lb-wind-speed" value="${e?.windSpeed != null ? e.windSpeed : ''}" placeholder="e.g. 15" type="number" min="0" step="0.1"></div>
      <div><div class="mi-label">Sea state</div><select class="mi" id="lb-sea"><option value="">—</option>${seaSel}</select></div>
      <div><div class="mi-label">Barometer hPa</div><input class="mi" id="lb-baro" value="${e?.barometer != null ? e.barometer : ''}" placeholder="e.g. 1013" type="number"></div>
    </div>
    <div style="margin-bottom:10px">
      <div style="font-size:10px;font-weight:700;color:var(--label2);text-transform:uppercase;letter-spacing:.3px;margin-bottom:4px">Current</div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:6px">
        <div><div class="mi-label" style="font-size:10px">Dir °</div><input class="mi" id="lb-cur-dir" value="${e?.currentDir != null ? e.currentDir : ''}" placeholder="e.g. 045" type="number" min="0" max="359"></div>
        <div><div class="mi-label" style="font-size:10px">Speed kn</div><input class="mi" id="lb-cur-speed" value="${e?.currentSpeed != null ? e.currentSpeed : ''}" placeholder="e.g. 1.5" type="number" min="0" step="0.1"></div>
      </div>
    </div>
    <div class="mi-label">Watch leader</div><input class="mi" id="lb-watch" value="${esc(e?.watchLeader || '')}" placeholder="Optional">
    <div class="mi-label">Notes</div><textarea class="mi" id="lb-notes" rows="2" placeholder="Optional">${esc(e?.notes || '')}</textarea>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:6px;margin-bottom:10px">
      <div><div class="mi-label">Fuel soundings</div><input class="mi" id="lb-fuel" value="${esc(e?.fuelSoundings || '')}" placeholder="e.g. 480L"></div>
      <div><div class="mi-label">Water soundings</div><input class="mi" id="lb-water" value="${esc(e?.waterSoundings || '')}" placeholder="e.g. 200L"></div>
    </div>
    <div style="background:var(--surface2);border-radius:10px;overflow:hidden;margin-bottom:10px">
      <div style="font-size:10px;font-weight:700;color:var(--label2);padding:7px 10px 2px;text-transform:uppercase;letter-spacing:.3px">Calculated</div>
      <div style="display:grid;grid-template-columns:1fr 1fr;border-top:1px solid var(--sep)">
        <div style="padding:7px 10px;text-align:center;border-right:1px solid var(--sep)">
          <div style="font-size:15px;font-weight:700;color:var(--label)" id="lb-calc-dist">${e?.distanceRun ? (+e.distanceRun).toFixed(1) : '—'}</div>
          <div style="font-size:9px;color:var(--label3)">nm since last entry</div>
        </div>
        <div style="padding:7px 10px;text-align:center">
          <div style="font-size:15px;font-weight:700;color:var(--label)" id="lb-calc-time">—</div>
          <div style="font-size:9px;color:var(--label3)">time since last entry</div>
        </div>
      </div>
    </div>`;
}

function lbReadForm() {
  const latV = document.getElementById('lb-lat')?.value;
  const lonV = document.getElementById('lb-lon')?.value;
  const lat = parseFloat(latV), lon = parseFloat(lonV);
  const nv = id => { const v = document.getElementById(id)?.value; return v !== '' && v != null ? Number(v) : null; };
  const calcDistEl = document.getElementById('lb-calc-dist');
  const distN = parseFloat(calcDistEl?.textContent);
  return {
    timestamp:      new Date(document.getElementById('lb-ts')?.value || '').toISOString(),
    position:       (!isNaN(lat) && !isNaN(lon)) ? { lat, lon } : null,
    positionSource: 'gps',
    cog:            nv('lb-cog'),
    sog:            nv('lb-sog'),
    windDir:        nv('lb-wind-dir'),
    windSpeed:      nv('lb-wind-speed'),
    seaState:       document.getElementById('lb-sea')?.value       || '',
    barometer:      nv('lb-baro'),
    currentDir:     nv('lb-cur-dir'),
    currentSpeed:   nv('lb-cur-speed'),
    watchLeader:    document.getElementById('lb-watch')?.value.trim()  || '',
    notes:          document.getElementById('lb-notes')?.value.trim()  || '',
    fuelSoundings:  document.getElementById('lb-fuel')?.value.trim()   || '',
    waterSoundings: document.getElementById('lb-water')?.value.trim()  || '',
    distanceRun:    isNaN(distN) ? 0 : distN,
  };
}

function showNewEntry(pid) {
  _lbPid = pid; _lbGpsPos = null;
  showModal('New Log Entry', lbEntryForm(null) + `
    <div class="modal-btns">
      <button class="btn btn-s" onclick="lbStopGPS();hideModal()">Cancel</button>
      <button class="btn btn-p" onclick="saveLbEntry()">Add entry</button>
    </div>`);
  setTimeout(() => { lbStartGPS(); lbUpdateCalcTime(); }, 80);
}
function showEditEntry(pid, eid) {
  const p = findPassage(pid); if (!p) return;
  const e = (p.entries || []).find(x => x.id === eid); if (!e) return;
  _lbPid = pid;
  _lbGpsPos = (e.position?.lat != null) ? { lat: e.position.lat, lon: e.position.lon } : null;
  showModal('Edit Log Entry', lbEntryForm(e) + `
    <div class="modal-btns">
      <button class="btn btn-s" onclick="hideModal()">Cancel</button>
      <button class="btn btn-p" style="background:var(--red);border-color:var(--red)" onclick="deleteLbEntry('${pid}','${eid}')">Delete</button>
      <button class="btn btn-p" onclick="saveEditEntry('${pid}','${eid}')">Save</button>
    </div>`);
  const statusEl = document.getElementById('lb-gps-status');
  if (statusEl) statusEl.textContent = '';
  setTimeout(() => lbUpdateCalcTime(), 80);
}
function saveLbEntry() {
  lbStopGPS();
  const p = findPassage(_lbPid); if (!p) return;
  if (!p.entries) p.entries = [];
  p.entries.push({ id: uid(), ...lbReadForm() });
  save(); hideModal();
  document.getElementById('mainContent').innerHTML = renderPassageLog();
}
function saveEditEntry(pid, eid) {
  const p = findPassage(pid); if (!p) return;
  const idx = (p.entries || []).findIndex(x => x.id === eid); if (idx < 0) return;
  p.entries[idx] = { id: eid, ...lbReadForm() };
  save(); hideModal();
  document.getElementById('mainContent').innerHTML = renderPassageLog();
}
function deleteLbEntry(pid, eid) {
  const p = findPassage(pid); if (!p) return;
  p.entries = (p.entries || []).filter(x => x.id !== eid);
  save(); hideModal();
  document.getElementById('mainContent').innerHTML = renderPassageLog();
}

// ── GPS helpers ──

function lbStopGPS() {
  if (_lbWatchId != null) { navigator.geolocation?.clearWatch(_lbWatchId); _lbWatchId = null; }
  _lbPrevFix = null;
}

function lbStartGPS() {
  lbStopGPS();
  const statusEl = document.getElementById('lb-gps-status');
  if (!navigator.geolocation) { if (statusEl) statusEl.textContent = ''; return; }
  _lbWatchId = navigator.geolocation.watchPosition(pos => {
    const lat = pos.coords.latitude, lon = pos.coords.longitude;
    const now = pos.timestamp;
    _lbGpsPos = { lat, lon };
    const latEl = document.getElementById('lb-lat'), lonEl = document.getElementById('lb-lon');
    if (latEl && !latEl.value) latEl.value = lat.toFixed(5);
    if (lonEl && !lonEl.value) lonEl.value = lon.toFixed(5);
    if (statusEl) statusEl.textContent = '';
    const cogEl = document.getElementById('lb-cog'), sogEl = document.getElementById('lb-sog');
    if (_lbPrevFix) {
      const dtH = (now - _lbPrevFix.ts) / 3600000;
      if (dtH > 0) {
        const dist = haversineNm(_lbPrevFix.lat, _lbPrevFix.lon, lat, lon);
        const sog = dist / dtH;
        if (sog >= 0.3) {
          if (cogEl) cogEl.value = bearingDeg(_lbPrevFix.lat, _lbPrevFix.lon, lat, lon);
          if (sogEl) sogEl.value = Math.min(30, sog).toFixed(1);
        } else {
          if (cogEl) { cogEl.value = ''; cogEl.placeholder = '—'; }
          if (sogEl) sogEl.value = '0';
        }
      }
    } else {
      const p = findPassage(_lbPid);
      if (p) {
        const sorted = [...(p.entries || [])].sort((a, b) => a.timestamp < b.timestamp ? -1 : 1);
        const last = sorted[sorted.length - 1];
        if (last?.position?.lat != null) {
          const dist = haversineNm(last.position.lat, last.position.lon, lat, lon);
          if (cogEl && !cogEl.value) cogEl.value = bearingDeg(last.position.lat, last.position.lon, lat, lon);
          if (sogEl && !sogEl.value && last.timestamp) {
            const hrs = (Date.now() - new Date(last.timestamp)) / 3600000;
            if (hrs > 0) sogEl.value = Math.min(30, dist / hrs).toFixed(1);
          }
        }
      }
    }
    _lbPrevFix = { lat, lon, ts: now };
    lbUpdateCalcDist(lat, lon);
  }, () => {
    if (statusEl) statusEl.textContent = '(GPS unavailable — enter manually)';
  }, { enableHighAccuracy: true, timeout: 15000, maximumAge: 5000 });
}

function lbUpdateCalcDist(lat, lon) {
  const p = findPassage(_lbPid); if (!p) return;
  const sorted = [...(p.entries || [])].sort((a, b) => a.timestamp < b.timestamp ? -1 : 1);
  const last = sorted[sorted.length - 1];
  const distEl = document.getElementById('lb-calc-dist'); if (!distEl) return;
  distEl.textContent = (last?.position?.lat != null)
    ? haversineNm(last.position.lat, last.position.lon, lat, lon).toFixed(1) : '—';
}

function lbUpdateCalcTime() {
  const p = findPassage(_lbPid); if (!p) return;
  const sorted = [...(p.entries || [])].sort((a, b) => a.timestamp < b.timestamp ? -1 : 1);
  const last = sorted[sorted.length - 1];
  const timeEl = document.getElementById('lb-calc-time'); if (!timeEl) return;
  if (!last?.timestamp) { timeEl.textContent = 'First entry'; return; }
  const ms = Date.now() - new Date(last.timestamp);
  const h = Math.floor(ms / 3600000), m = Math.floor((ms % 3600000) / 60000);
  timeEl.textContent = `${h}h ${m}m`;
}

// ── Export ──

function exportPassage(pid) {
  const p = findPassage(pid); if (!p) return;
  const entries = [...(p.entries || [])].sort((a, b) => a.timestamp < b.timestamp ? -1 : 1);
  const e2 = s => String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const totalNm = entries.reduce((s, e) => s + (parseFloat(e.distanceRun) || 0), 0).toFixed(1);
  const rows = entries.map(e => {
    const ts = e.timestamp ? new Date(e.timestamp) : null;
    const tStr = ts ? ts.toUTCString().replace(/ GMT$/, '') : '—';
    const posStr = (e.position?.lat != null && e.position?.lon != null)
      ? fmtLat(e.position.lat) + ' ' + fmtLon(e.position.lon) : '—';
    return `<tr>
      <td>${e2(tStr)}</td>
      <td>${e2(posStr)}</td>
      <td>${e.cog != null ? e.cog + '°' : '—'}</td>
      <td>${e.sog != null ? e.sog + 'kn' : '—'}</td>
      <td>${e.windDir != null ? e.windDir + '°' : '—'}${e.windSpeed != null ? ' ' + e.windSpeed + 'kn' : ''}</td>
      <td>${e2(e.seaState || '—')}</td>
      <td>${e.barometer != null ? e.barometer + 'hPa' : '—'}</td>
      <td>${e.currentDir != null ? e.currentDir + '°' : '—'}${e.currentSpeed != null ? ' ' + e.currentSpeed + 'kn' : ''}</td>
      <td>${e2(e.watchLeader || '—')}</td>
      <td>${e2(e.notes || '')}</td>
    </tr>`;
  }).join('');
  const html = `<!DOCTYPE html><html><head><meta charset="UTF-8">
<title>${e2(p.name || 'Passage Log')}</title>
<style>
body{font-family:Georgia,serif;font-size:11px;margin:20px}
h1{font-size:16px;margin-bottom:4px}
.meta{color:#555;margin-bottom:16px;font-size:11px}
table{width:100%;border-collapse:collapse;font-size:10px}
th{background:#1a5fa8;color:#fff;padding:5px 6px;text-align:left;white-space:nowrap}
td{padding:5px 6px;border-bottom:1px solid #ddd;vertical-align:top}
tr:nth-child(even)td{background:#f5f7fa}
.no-print{margin-bottom:12px}
@media print{.no-print{display:none}}
</style></head><body>
<h1>📖 ${e2(p.name || 'Passage Log')}</h1>
<div class="meta">${e2(p.from || '?')} → ${e2(p.to || '?')} &nbsp;·&nbsp; ${e2(p.startDate || '')}${p.endDate ? ' – ' + e2(p.endDate) : ''} &nbsp;·&nbsp; Total: ${totalNm} nm &nbsp;·&nbsp; ${entries.length} entries</div>
<div class="no-print"><button onclick="window.print()" style="padding:6px 14px;font-size:12px;cursor:pointer">🖨 Print / Save PDF</button></div>
<table><thead><tr>
  <th>Date/Time (UTC)</th><th>Position</th><th>COG</th><th>SOG</th><th>Wind</th><th>Sea</th><th>Baro</th><th>Current</th><th>Watch</th><th>Notes</th>
</tr></thead><tbody>
${rows || '<tr><td colspan="10" style="text-align:center;color:#999">No entries</td></tr>'}
</tbody></table>
</body></html>`;
  const w = window.open('', '_blank');
  if (w) { w.document.write(html); w.document.close(); }
  else showToast('Allow pop-ups to export', true);
}

// ── Prefill ──

// ── Coastal log ──

function getCoastalLog() {
  if (!Array.isArray(data.coastalLog)) data.coastalLog = [];
  return data.coastalLog;
}

const COASTAL_EVENTS = ['Departed','Arrived','Notable event'];
const COASTAL_ICONS  = {'Departed':'⛵','Arrived':'⚓','Notable event':'⭐'};
const COASTAL_COLORS = {'Departed':'#378ADD','Arrived':'#639922','Notable event':'#BA7517'};

function renderCoastalLog() {
  const all = [...getCoastalLog()].sort((a, b) => a.timestamp < b.timestamp ? -1 : 1);
  const newBtn = `<div style="padding:4px 12px 4px">
    <button onclick="showNewCoastalEntry()" style="width:100%;background:var(--blue);color:#fff;border:none;border-radius:12px;padding:12px;font-size:14px;font-weight:600;font-family:var(--font);cursor:pointer">+ Log event</button>
  </div>`;
  if (!all.length) return `<div style="padding-bottom:80px">${newBtn}
    <div style="text-align:center;padding:40px 20px;color:var(--label3);font-size:14px">No events logged yet.<br>Tap "+ Log event" to start.</div>
  </div>`;

  // Group by passageName, preserve chronological order within group
  const groupMap = {};
  const groupOrder = [];
  all.forEach(e => {
    const key = e.passageName || '';
    if (!groupMap[key]) { groupMap[key] = []; groupOrder.push(key); }
    groupMap[key].push(e);
  });

  // Render newest-first: reverse the group order
  const sections = [...groupOrder].reverse().map(key => {
    const entries = groupMap[key]; // chronological
    const departE  = entries.find(e => e.eventType === 'Departed');
    const arrivedE = [...entries].reverse().find(e => e.eventType === 'Arrived');
    let totalNm = 0;
    for (let i = 1; i < entries.length; i++) {
      const a = entries[i-1], b = entries[i];
      if (a.position?.lat != null && b.position?.lat != null)
        totalNm += haversineNm(a.position.lat, a.position.lon, b.position.lat, b.position.lon);
    }
    let durationStr = '';
    if (departE?.timestamp && arrivedE?.timestamp) {
      const ms = new Date(arrivedE.timestamp) - new Date(departE.timestamp);
      const h = Math.floor(ms / 3600000), m = Math.floor((ms % 3600000) / 60000);
      durationStr = `${h}h ${m}m`;
    }
    const dateStr = entries[0]?.timestamp
      ? new Date(entries[0].timestamp).toLocaleDateString('en-GB', {day:'2-digit', month:'short', year:'numeric'}) : '';
    const nmStr = totalNm > 0.1 ? totalNm.toFixed(1) + ' nm' : '';
    const meta = [dateStr, nmStr, durationStr].filter(Boolean).join(' · ');
    const isNamed = key !== '';
    const badge = arrivedE
      ? `<span style="font-size:10px;font-weight:700;color:#639922;background:rgba(99,153,34,.12);border-radius:8px;padding:1px 7px;flex-shrink:0">Completed</span>`
      : (departE
        ? `<span style="font-size:10px;font-weight:700;color:#BA7517;background:rgba(186,117,23,.1);border-radius:8px;padding:1px 7px;flex-shrink:0">In progress</span>`
        : '');
    const header = isNamed
      ? `<div style="margin:10px 12px 4px;padding:8px 12px;background:var(--surface2);border-radius:10px;border:1px solid var(--sep);display:flex;align-items:center;justify-content:space-between;gap:8px">
          <div style="min-width:0;flex:1">
            <div style="font-size:13px;font-weight:700;color:var(--label)">${esc(key)}</div>
            ${meta ? `<div style="font-size:11px;color:var(--label3);margin-top:2px">${meta}</div>` : ''}
          </div>${badge}
        </div>`
      : `<div style="margin:10px 12px 4px;font-size:11px;font-weight:600;color:var(--label3)">Unlabelled</div>`;
    const summaryCard = arrivedE ? renderCoastalPassageSummaryCard(entries, totalNm, durationStr) : '';
    // Oldest first (chronological) — Departed at top, Arrived at bottom
    return header + summaryCard + entries.map(e => renderCoastalEntryRow(e)).join('');
  }).join('');

  return `<div style="padding-bottom:80px">${newBtn}${sections}</div>`;
}

function lbcParseFromTo(passageName) {
  if (!passageName) return { from: '', to: '' };
  const s = passageName.replace(/\s*\(Example\)\s*$/, '').trim();
  const m = s.match(/^(.+?)\s*→\s*(.+)$/);
  return m ? { from: m[1].trim(), to: m[2].trim() } : { from: s, to: '' };
}

function renderCoastalPassageSummaryCard(entries, totalNm, durationStr) {
  const departE  = entries.find(e => e.eventType === 'Departed');
  const arrivedE = [...entries].reverse().find(e => e.eventType === 'Arrived');
  const fmtUtc = ts => ts
    ? new Date(ts).toLocaleTimeString('en-GB', {hour:'2-digit', minute:'2-digit', timeZone:'UTC'}) + ' UTC'
    : '—';
  let avgSogStr = '—';
  if (departE?.timestamp && arrivedE?.timestamp && totalNm > 0) {
    const ms = new Date(arrivedE.timestamp) - new Date(departE.timestamp);
    if (ms > 0) avgSogStr = (totalNm / (ms / 3600000)).toFixed(1) + ' kts';
  }
  const nmVal = totalNm > 0.1 ? totalNm.toFixed(1) : '—';
  const { from: fromPort, to: toPort } = lbcParseFromTo(entries[0]?.passageName);
  // Top: three stat boxes
  const statBoxes = [
    [nmVal,           'nm sailed',  '#639922'],
    [durationStr||'—','duration',   null],
    [avgSogStr,       'avg speed',  null],
  ].map(([v, l, c], i) => `
    <div style="flex:1;padding:10px 8px;text-align:center${i < 2 ? ';border-right:1px solid var(--sep)' : ''}">
      <div style="font-size:15px;font-weight:700;color:${c || 'var(--label)'}">
        ${esc(String(v).split(' ')[0])}<span style="font-size:11px;font-weight:500;color:var(--label3);margin-left:2px">${esc(String(v).split(' ').slice(1).join(' '))}</span>
      </div>
      <div style="font-size:9px;color:var(--label3);margin-top:1px;text-transform:uppercase;letter-spacing:.3px">${l}</div>
    </div>`).join('');
  // Bottom: two columns
  const col = (dot, label, color, time, place) => `
    <div style="flex:1;padding:9px 10px;display:flex;align-items:flex-start;gap:8px">
      <div style="margin-top:3px;width:8px;height:8px;border-radius:50%;background:${dot};flex-shrink:0"></div>
      <div>
        <div style="font-size:10px;font-weight:700;color:${color};text-transform:uppercase;letter-spacing:.3px">${label}</div>
        <div style="font-size:11px;font-weight:600;color:var(--label);margin-top:1px">${esc(time)}</div>
        ${place ? `<div style="font-size:10px;color:var(--label3);margin-top:1px">${esc(place)}</div>` : ''}
      </div>
    </div>`;
  return `<div style="margin:0 12px 6px;background:var(--surface);border:1px solid var(--sep);border-radius:12px;overflow:hidden">
    <div style="display:flex;border-bottom:1px solid var(--sep)">${statBoxes}</div>
    <div style="display:flex">
      ${col('#378ADD','Departed','#378ADD', fmtUtc(departE?.timestamp), fromPort)}
      <div style="width:1px;background:var(--sep);flex-shrink:0"></div>
      ${col('#639922','Arrived','#639922', fmtUtc(arrivedE?.timestamp), toPort)}
    </div>
  </div>`;
}

function renderCoastalEntryRow(e) {
  const ts = e.timestamp ? new Date(e.timestamp) : null;
  const timeStr = ts
    ? ts.toLocaleTimeString('en-GB', {hour:'2-digit', minute:'2-digit', timeZone:'UTC'}) + ' UTC'
    : '—';
  const color = COASTAL_COLORS[e.eventType] || '#9ca3af';
  const posStr = (e.position?.lat != null && e.position?.lon != null)
    ? fmtLat(e.position.lat) + ' ' + fmtLon(e.position.lon) : '';
  const sogStr = e.sog != null ? ` · ${e.sog} kn` : '';
  return `<div style="margin:0 12px 5px;background:var(--surface);border:1px solid var(--sep);border-radius:12px;padding:8px 12px;display:flex;align-items:flex-start;gap:10px">
    <div style="margin-top:4px;flex-shrink:0;width:9px;height:9px;border-radius:50%;background:${color}"></div>
    <div style="flex:1;min-width:0">
      <div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap">
        <span style="font-size:12px;font-weight:700;color:${color}">${esc(e.eventType || '—')}</span>
        <span style="font-size:11px;color:var(--label3)">${timeStr}${sogStr}</span>
      </div>
      ${posStr ? `<div style="font-size:10px;color:var(--label3);margin-top:2px;font-family:monospace">${esc(posStr)}</div>` : ''}
      ${e.notes ? `<div style="font-size:12px;color:var(--label2);margin-top:3px">${esc(e.notes)}</div>` : ''}
    </div>
    <button onclick="showEditCoastalEntry('${e.id}')" style="background:none;border:1px solid var(--sep);border-radius:8px;padding:3px 8px;font-size:11px;cursor:pointer;color:var(--label3);flex-shrink:0;margin-top:1px">✏</button>
  </div>`;
}

function _coastalEntryForm(e) {
  const tsVal = e?.timestamp ? new Date(e.timestamp).toISOString().slice(0,16) : new Date().toISOString().slice(0,16);
  const evtOpts = COASTAL_EVENTS.map(t =>
    `<option value="${t}"${e?.eventType===t?' selected':''}>${COASTAL_ICONS[t]} ${t}</option>`).join('');
  const lat = e?.position?.lat != null ? String(e.position.lat.toFixed(5)) : '';
  const lon = e?.position?.lon != null ? String(e.position.lon.toFixed(5)) : '';
  // Auto-suggest passage name from last entry (unless last event was Arrived)
  const log = getCoastalLog();
  const lastE = log.length ? log[log.length - 1] : null;
  const autoName = !e && lastE && lastE.eventType !== 'Arrived' ? (lastE.passageName || '') : '';
  const passageVal = e?.passageName ?? autoName;
  return `<div class="mi-label">Passage name</div>
    <input class="mi" id="lbc-passage" value="${esc(passageVal)}" placeholder="e.g. Paros → Naxos">
    <div class="mi-label">Time</div>
    <input class="mi" id="lbc-ts" type="datetime-local" value="${tsVal}">
    <div class="mi-label">Event type</div>
    <select class="mi" id="lbc-evt"><option value="">— select —</option>${evtOpts}</select>
    <div style="background:rgba(34,197,94,.08);border:0.5px solid rgba(34,197,94,.3);border-radius:10px;padding:10px;margin-bottom:10px">
      <div style="font-size:11px;font-weight:700;color:#15803d;margin-bottom:6px">📍 Position <span id="lbc-gps-status" style="font-weight:400;color:#15803d;font-size:10px">${e ? '' : 'Getting GPS…'}</span></div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:6px">
        <div><div class="mi-label" style="font-size:10px">Lat</div><input class="mi" id="lbc-lat" value="${esc(lat)}" placeholder="e.g. 36.72134" style="font-size:12px"></div>
        <div><div class="mi-label" style="font-size:10px">Lon</div><input class="mi" id="lbc-lon" value="${esc(lon)}" placeholder="e.g. −8.56789" style="font-size:12px"></div>
      </div>
      <input type="hidden" id="lbc-pos-source" value="${esc(e?.positionSource || 'gps')}">
    </div>
    <div class="mi-label">Notes</div>
    <textarea class="mi" id="lbc-notes" rows="2" placeholder="Optional">${esc(e?.notes || '')}</textarea>`;
}

function lbcReadForm() {
  const latV = document.getElementById('lbc-lat')?.value;
  const lonV = document.getElementById('lbc-lon')?.value;
  const lat = parseFloat(latV), lon = parseFloat(lonV);
  return {
    passageName:    document.getElementById('lbc-passage')?.value.trim() || '',
    timestamp:      new Date(document.getElementById('lbc-ts')?.value || '').toISOString(),
    eventType:      document.getElementById('lbc-evt')?.value || '',
    position:       (!isNaN(lat) && !isNaN(lon)) ? { lat, lon } : null,
    positionSource: document.getElementById('lbc-pos-source')?.value || 'manual',
    notes:          document.getElementById('lbc-notes')?.value.trim() || '',
  };
}

function lbcFetchGPS() {
  const statusEl = document.getElementById('lbc-gps-status');
  if (!navigator.geolocation) { if (statusEl) statusEl.textContent = ''; return; }
  navigator.geolocation.getCurrentPosition(pos => {
    const lat = pos.coords.latitude, lon = pos.coords.longitude;
    const latEl = document.getElementById('lbc-lat'), lonEl = document.getElementById('lbc-lon');
    if (latEl && !latEl.value) latEl.value = lat.toFixed(5);
    if (lonEl && !lonEl.value) lonEl.value = lon.toFixed(5);
    const srcEl = document.getElementById('lbc-pos-source'); if (srcEl) srcEl.value = 'gps';
    if (statusEl) statusEl.textContent = '';
  }, () => { if (statusEl) statusEl.textContent = '(GPS unavailable — enter manually)'; },
  { timeout: 10000, maximumAge: 30000 });
}

function showNewCoastalEntry() {
  showModal('Log Event', _coastalEntryForm(null) + `
    <div class="modal-btns">
      <button class="btn btn-s" onclick="hideModal()">Cancel</button>
      <button class="btn btn-p" onclick="saveCoastalEntry()">Save</button>
    </div>`);
  setTimeout(() => lbcFetchGPS(), 80);
}
function showEditCoastalEntry(eid) {
  const e = getCoastalLog().find(x => x.id === eid); if (!e) return;
  showModal('Edit Event', _coastalEntryForm(e) + `
    <div class="modal-btns">
      <button class="btn btn-s" onclick="hideModal()">Cancel</button>
      <button class="btn btn-p" style="background:var(--red);border-color:var(--red)" onclick="deleteCoastalEntry('${eid}')">Delete</button>
      <button class="btn btn-p" onclick="saveEditCoastalEntry('${eid}')">Save</button>
    </div>`);
}
function saveCoastalEntry() {
  const evt = document.getElementById('lbc-evt')?.value;
  if (!evt) { showToast('Select an event type', true); return; }
  const entry = { id: uid(), ...lbcReadForm() };
  getCoastalLog().push(entry);
  save(); hideModal();
  if (entry.eventType === 'Arrived' && entry.passageName) {
    setTimeout(() => showCoastalPassageSummary(entry), 60);
  } else {
    document.getElementById('mainContent').innerHTML = renderPassageLog();
  }
}
function saveEditCoastalEntry(eid) {
  const log = getCoastalLog(), idx = log.findIndex(x => x.id === eid); if (idx < 0) return;
  log[idx] = { id: eid, ...lbcReadForm() };
  save(); hideModal();
  document.getElementById('mainContent').innerHTML = renderPassageLog();
}
function deleteCoastalEntry(eid) {
  data.coastalLog = getCoastalLog().filter(x => x.id !== eid);
  save(); hideModal();
  document.getElementById('mainContent').innerHTML = renderPassageLog();
}

function showCoastalPassageSummary(arrivedEntry) {
  const passageEntries = getCoastalLog()
    .filter(e => e.passageName === arrivedEntry.passageName)
    .sort((a, b) => a.timestamp < b.timestamp ? -1 : 1);
  let totalNm = 0;
  for (let i = 1; i < passageEntries.length; i++) {
    const a = passageEntries[i-1], b = passageEntries[i];
    if (a.position?.lat != null && b.position?.lat != null)
      totalNm += haversineNm(a.position.lat, a.position.lon, b.position.lat, b.position.lon);
  }
  const departE = passageEntries.find(e => e.eventType === 'Departed');
  let durationStr = '—';
  if (departE?.timestamp && arrivedEntry.timestamp) {
    const ms = new Date(arrivedEntry.timestamp) - new Date(departE.timestamp);
    const h = Math.floor(ms / 3600000), m = Math.floor((ms % 3600000) / 60000);
    durationStr = `${h}h ${m}m`;
  }
  const card = renderCoastalPassageSummaryCard(passageEntries, totalNm, durationStr);
  showModal('Passage complete', `
    <div style="text-align:center;padding:4px 0 10px">
      <div style="font-size:16px;font-weight:800;color:var(--label)">${esc(arrivedEntry.passageName)}</div>
    </div>
    ${card}
    <div class="modal-btns" style="margin-top:12px">
      <button class="btn btn-p" onclick="hideModal();document.getElementById('mainContent').innerHTML=renderPassageLog()">Done</button>
    </div>`);
}

// ── Prefill ──

function prefillPassageLogData() {
  if (localStorage.getItem(EMAIL_KEY) === OWNER_EMAIL) return false;
  let dirty = false;

  if (!getPassageLog().passages.some(p => p.name)) {
    const hAgoTs   = h => new Date(Date.now() - h * 3600000).toISOString();
    const dAgoDate = n => new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);
    const mkEntry  = r => ({
      id: uid(), timestamp: r.ts,
      position: { lat: r.lat, lon: r.lon }, positionSource: 'gps',
      cog: r.cog, sog: r.sog, windDir: r.wd, windSpeed: r.ws,
      seaState: r.sea, barometer: r.baro,
      watchLeader: r.wl, notes: r.notes,
      fuelSoundings: r.fuel, waterSoundings: r.water
    });

    // ── Offshore 1: In-progress — Paros → Rhodes ──
    // Started 3 days ago, 4 entries every ~18 hours, Meltemi NW 20-28 kts
    getPassageLog().passages.push({
      id: uid(),
      name: 'Paros → Rhodes (Example)', from: 'Paros, Greece', to: 'Rhodes, Greece',
      destination: '36.4417, 28.225', startDate: dAgoDate(3), endDate: '',
      entries: [
        { ts:hAgoTs(72), lat:37.0867, lon:25.1633, cog:128, sog:0.0, wd:335, ws:22, sea:'Slight',   baro:1016, wl:'Captain (Example)',    notes:'Departed Parikia, Meltemi building (Example)',    fuel:'320L', water:'150L' },
        { ts:hAgoTs(54), lat:36.850,  lon:26.150,  cog:125, sog:7.4, wd:330, ws:26, sea:'Rough',    baro:1018, wl:'First mate (Example)', notes:'Meltemi 25kts, 2 reefs in main (Example)',        fuel:'318L', water:'148L' },
        { ts:hAgoTs(36), lat:36.600,  lon:27.080,  cog:130, sog:6.8, wd:325, ws:25, sea:'Moderate', baro:1017, wl:'Captain (Example)',    notes:'Good progress, Karpathos to starboard (Example)', fuel:'316L', water:'146L' },
        { ts:hAgoTs(18), lat:36.400,  lon:27.850,  cog:128, sog:7.2, wd:340, ws:20, sea:'Moderate', baro:1016, wl:'First mate (Example)', notes:'Wind easing, shook out reef (Example)',           fuel:'314L', water:'144L' },
      ].map(mkEntry)
    });

    // ── Offshore 2: Completed — Cape Town → Grenada ──
    // 38-day Atlantic passage Jan–Feb 2019, 6 entries (SE trades → ITCZ → NE trades)
    getPassageLog().passages.push({
      id: uid(),
      name: 'Cape Town → Grenada (Example)', from: 'Cape Town, South Africa', to: "St George's, Grenada",
      destination: '12.0017, -61.7633', startDate: '2019-01-15', endDate: '2019-02-21',
      completed: true, completedAt: '2019-02-21T14:20:00.000Z',
      entries: [
        { ts:'2019-01-15T08:30:00.000Z', lat:-33.9267, lon:18.4250,  cog:340, sog:0.0, wd:100, ws:8,  sea:'Slight',   baro:1016, wl:'Captain (Example)',    notes:'Departed Cape Town, heading NW (Example)',                    fuel:'800L', water:'350L' },
        { ts:'2019-01-21T08:30:00.000Z', lat:-22.5000, lon:8.5000,   cog:295, sog:7.2, wd:115, ws:18, sea:'Moderate', baro:1014, wl:'First mate (Example)', notes:'SE trades established, good progress (Example)',              fuel:'775L', water:'328L' },
        { ts:'2019-01-28T08:30:00.000Z', lat:-2.0000,  lon:-4.0000,  cog:280, sog:6.5, wd:85,  ws:12, sea:'Slight',   baro:1010, wl:'Captain (Example)',    notes:'Crossed equator this morning, NE trades building (Example)', fuel:'748L', water:'305L' },
        { ts:'2019-02-03T08:30:00.000Z', lat:7.5000,   lon:-20.0000, cog:270, sog:7.8, wd:45,  ws:22, sea:'Moderate', baro:1014, wl:'First mate (Example)', notes:'Flying fish on deck (Example)',                               fuel:'722L', water:'281L' },
        { ts:'2019-02-10T08:30:00.000Z', lat:10.5000,  lon:-40.0000, cog:268, sog:6.0, wd:30,  ws:20, sea:'Moderate', baro:1015, wl:'Captain (Example)',    notes:'Squall overnight, back to steady 20kts (Example)',           fuel:'695L', water:'258L' },
        { ts:'2019-02-21T14:20:00.000Z', lat:12.0017,  lon:-61.7633, cog:268, sog:0.0, wd:20,  ws:12, sea:'Slight',   baro:1016, wl:'First mate (Example)', notes:'Landfall Grenada, anchoring in Prickly Bay (Example)',        fuel:'668L', water:'234L' },
      ].map(mkEntry)
    });
    dirty = true;
  }

  if (!getCoastalLog().some(e => e.eventType)) {
    // Coastal 1: Portimão → Ayamonte (completed, fixed Jun 2026 dates)
    // Coastal 2: Ayamonte → Huelva (in progress, departed Jun 8 2026)
    [
      { passageName:'Portimão → Ayamonte (Example)', eventType:'Departed',      timestamp:'2026-06-05T20:17:00.000Z', position:{lat:37.12333,lon:-8.52833}, positionSource:'gps', sog:0,   notes:'Left Portimão marina, heading east (Example)' },
      { passageName:'Portimão → Ayamonte (Example)', eventType:'Notable event', timestamp:'2026-06-06T00:17:00.000Z', position:{lat:37.08500,lon:-8.40667}, positionSource:'gps', sog:5.2, notes:'Passed Cabo de Santa Maria (Example)' },
      { passageName:'Portimão → Ayamonte (Example)', eventType:'Arrived',       timestamp:'2026-06-06T03:17:00.000Z', position:{lat:37.18167,lon:-7.40333}, positionSource:'gps', sog:4.8, notes:'Anchored off Isla Canela (Example)' },
      { passageName:'Ayamonte → Huelva (Example)',   eventType:'Departed',      timestamp:'2026-06-08T04:17:00.000Z', position:{lat:37.18167,lon:-7.40333}, positionSource:'gps', sog:0,   notes:'Departed anchorage, tide-assisted exit (Example)' },
    ].forEach(s => getCoastalLog().push({ id: uid(), ...s }));
    dirty = true;
  }

  return dirty;
}

// ═══════════════════════════════════════════════════════════

function renderLogbook() {
  const log = (data.logbook || []).slice().reverse();
  const totalNm = (data.logbook||[]).reduce((s,e)=>s+(parseFloat(e.distance)||0),0).toFixed(1);
  const totalHr = (data.logbook||[]).reduce((s,e)=>s+(parseFloat(e.engineHours)||0),0).toFixed(1);
  return `
    <div class="btn-row">
      <button class="btn btn-p btn-sm" onclick="showAddLogEntry()">+ New Entry</button>
    </div>
    <div class="card" style="margin-bottom:14px">
      <div class="card-hd">Running Totals</div>
      <div style="display:flex;gap:0">
        <div style="flex:1;padding:14px 16px;text-align:center;border-right:1px solid var(--sep)">
          <div style="font-size:28px;font-weight:700;color:var(--blue)">${totalNm}</div>
          <div style="font-size:12px;color:var(--label3)">Total Nm</div>
        </div>
        <div style="flex:1;padding:14px 16px;text-align:center">
          <div style="font-size:28px;font-weight:700;color:var(--blue)">${totalHr}</div>
          <div style="font-size:12px;color:var(--label3)">Engine Hours</div>
        </div>
      </div>
    </div>
    ${log.map((e,ri) => {
      const i = (data.logbook.length-1)-ri;
      return `<div class="log-card">
        <div class="flex justify-between items-center">
          <div class="log-date">${fmtDate(e.date)}</div>
          <button class="btn btn-d btn-xs no-print" onclick="removeLogEntry(${i})">✕</button>
        </div>
        <div class="log-route">${esc(e.departurePort||'—')} → ${esc(e.arrivalPort||'—')}</div>
        <div class="log-stats">
          ${e.distance?`<div class="log-stat"><b>${e.distance}</b> nm</div>`:''}
          ${e.engineHours?`<div class="log-stat"><b>${e.engineHours}</b>h engine</div>`:''}
          ${e.fuelAdded?`<div class="log-stat"><b>${e.fuelAdded}</b>L fuel</div>`:''}
          ${e.wind?`<div class="log-stat">💨 <b>${esc(e.wind)}</b></div>`:''}
          ${e.seaState?`<div class="log-stat">🌊 <b>${esc(e.seaState)}</b></div>`:''}
        </div>
        ${e.crew?`<div style="font-size:12px;color:var(--label3);margin-top:6px">👥 ${esc(e.crew)}</div>`:''}
        ${e.notes?`<div style="font-size:13px;color:var(--label2);margin-top:8px;line-height:1.5">${esc(e.notes)}</div>`:''}
      </div>`;
    }).join('') || '<div style="text-align:center;padding:40px 0;color:var(--label3)">No log entries yet</div>'}`;
}

function showAddLogEntry() {
  showModal('New Log Entry', `
    <div class="mi-label">Date</div><input class="mi" id="m-ed" type="date" value="${new Date().toISOString().slice(0,10)}">
    <div class="mi-label">Departure Port</div><input class="mi" id="m-dep" placeholder="e.g. Paros">
    <div class="mi-label">Arrival Port</div><input class="mi" id="m-arr" placeholder="e.g. Naxos">
    <div class="mi-label">Distance (nm)</div><input class="mi" id="m-nm" type="number" placeholder="0" step="0.1">
    <div class="mi-label">Engine Hours Used</div><input class="mi" id="m-eh" type="number" placeholder="0" step="0.1">
    <div class="mi-label">Fuel Added (litres)</div><input class="mi" id="m-fl" type="number" placeholder="0">
    <div class="mi-label">Wind (Beaufort / direction)</div><input class="mi" id="m-wd" placeholder="e.g. F4 NW">
    <div class="mi-label">Sea State</div><input class="mi" id="m-ss" placeholder="e.g. Slight">
    <div class="mi-label">Crew on board</div><input class="mi" id="m-cr" placeholder="e.g. Alice, Bob">
    <div class="mi-label">Notes / Incidents</div>
    <textarea class="mi" id="m-nt" rows="3" placeholder="Optional notes…"></textarea>
    <div class="modal-btns">
      <button class="btn btn-s" onclick="hideModal()">Cancel</button>
      <button class="btn btn-p" onclick="saveLogEntry()">Add</button>
    </div>`);
}
function saveLogEntry() {
  if (!data.logbook) data.logbook = [];
  data.logbook.push({
    id:uid(), date:document.getElementById('m-ed').value,
    departurePort:document.getElementById('m-dep').value,
    arrivalPort:document.getElementById('m-arr').value,
    distance:document.getElementById('m-nm').value,
    engineHours:document.getElementById('m-eh').value,
    fuelAdded:document.getElementById('m-fl').value,
    wind:document.getElementById('m-wd').value,
    seaState:document.getElementById('m-ss').value,
    crew:document.getElementById('m-cr').value,
    notes:document.getElementById('m-nt').value
  });
  save(); hideModal(); document.getElementById('mainContent').innerHTML = renderLogbook();
}
function removeLogEntry(i) {
  data.logbook.splice(i,1); save();
  document.getElementById('mainContent').innerHTML = renderLogbook();
}

// ═══════════════════════════════════════════════════════════
//  MODAL
// ═══════════════════════════════════════════════════════════

function showModal(title, bodyHtml) {
  const ov = document.getElementById('modalOv');
  const body = document.getElementById('modalBody');
  if (!ov || !body) {
    alert('Modal error: overlay not found. Please reload the app.\n\nTitle: ' + title);
    console.error('showModal: modalOv=' + ov + ' modalBody=' + body);
    return;
  }
  body.innerHTML = `<div class="modal-title">${esc(title)}</div>${bodyHtml}`;
  ov.classList.remove('hide');
  ov.classList.remove('hidden');
  ov.style.display = 'flex';
}
function hideModal() {
  const ov = document.getElementById('modalOv');
  ov.classList.add('hide');
  ov.style.display = '';
  document.getElementById('modalBody').innerHTML = '';
}
document.addEventListener('click', e => {
  if (e.target === document.getElementById('modalOv')) hideModal();
});

// ═══════════════════════════════════════════════════════════
//  ICON SETUP — uses oroboro-icon.js (real logo, 180×180)
// ═══════════════════════════════════════════════════════════

window.addEventListener('DOMContentLoaded', () => {
  const ico = (typeof OROBORO_ICON !== 'undefined') ? OROBORO_ICON : null;
  if (!ico) return;
  const el  = document.getElementById('appIcon');
  const fav = document.getElementById('favIcon');
  if (el)  { el.href = ico; }
  if (fav) { fav.href = ico; fav.type = 'image/jpeg'; }
});

// ═══════════════════════════════════════════════════════════
//  INIT
// ═══════════════════════════════════════════════════════════

function deepMerge(target, source) {
  for (const key of Object.keys(source)) {
    if (Array.isArray(source[key])) {
      if (!Array.isArray(target[key]) || target[key].length === 0) {
        target[key] = source[key];
      } else {
        const existingIds = new Set(target[key].map(x => x.id).filter(Boolean));
        const newItems = source[key].filter(x => !x.id || !existingIds.has(x.id));
        target[key] = [...target[key], ...newItems];
      }
    } else if (source[key] && typeof source[key] === 'object') {
      if (!target[key] || typeof target[key] !== 'object') target[key] = {};
      deepMerge(target[key], source[key]);
    } else {
      target[key] = source[key];
    }
  }
}

function matchMaintTasks(logTask) {
  const t = logTask.toLowerCase();
  const hits = new Set();
  MAINT_TASKS.forEach(task => {
    if (maintTaskKeywords(task.id).some(k => t.includes(k))) hits.add(task.id);
  });
  if ((t.includes('oil') || t.includes('lube')) && !hits.has('mt_sailoil') && !hits.has('mt_ffuel'))
    hits.add('mt_oil');
  return [...hits];
}

function migrateToSingleLog() {
  if (!data.maintenance) return false;
  if (data.maintenance.log) return false; // already migrated
  const portLog = (data.maintenance?.engines?.port?.log    || []).map(e => ({...e, engines:['port']}));
  const stbdLog = (data.maintenance?.engines?.starboard?.log || []).map(e => ({...e, engines:['starboard']}));
  const merged  = [...portLog];
  stbdLog.forEach(se => {
    const match = merged.find(pe =>
      pe.engines.includes('port') &&
      pe.date === se.date &&
      pe.task.toLowerCase().trim() === se.task.toLowerCase().trim()
    );
    if (match) { if (!match.engines.includes('starboard')) match.engines.push('starboard'); }
    else merged.push(se);
  });
  merged.sort((a, b) => b.date.localeCompare(a.date) || (parseFloat(b.hours)||0) - (parseFloat(a.hours)||0));
  data.maintenance.log = merged;
  return true;
}

// ═══════════════════════════════════════════════════════════
//  TRANSIT LOG
// ═══════════════════════════════════════════════════════════

function getTLData() {
  if (!data.transitLog) data.transitLog = {};
  const tl = data.transitLog;
  // Ensure required properties exist even if cloud returned a partial object
  if (!tl.logs) tl.logs = {};
  if (!tl.currentLog) tl.currentLog = 'tl_2526';
  if (!tl.logs[tl.currentLog]) {
    tl.logs[tl.currentLog] = {
      season:'2025-2026', archived:false, stamps:[],
      docNumber:'', issueDate:'', validFrom:'', validUntil:'',
      customsAuthority:'', validityType:'Limited (Ορισμένη)', prevDocCount:'', otherNotes:'', provisions:'',
      vesselName:'', flag:'', portOfRegistry:'', regNumber:'', callSign:'',
      vesselType:'', gt:'', engine:'', loa:'', yearBuilt:'', yearFirstReg:'',
      ownerName:'', holderName:'', address:'', telephone:'', email:'', afm:'', idNumber:''
    };
  }
  return tl;
}

function nextTLSeason(s) {
  const m = s.match(/(\d{4})-(\d{4})/);
  return m ? `${+m[1]+1}-${+m[2]+1}` : s;
}

function saveTLField(key, value) {
  const wd = getTLData();
  const log = wd.logs[wd.currentLog];
  if (!log || log.archived) return;
  log[key] = value; save();
}

function frTL(label, key, value, type) {
  return `<div class="fr"><div class="fl">${esc(label)}</div>
    <input class="fi" type="${type==='date'?'date':'text'}" value="${esc(value||'')}" onblur="saveTLField('${key}',this.value)" placeholder="—"></div>`;
}
function frTLArea(label, key, value) {
  return `<div class="fr" style="align-items:flex-start;padding-top:12px"><div class="fl">${esc(label)}</div>
    <textarea class="fi-area" onblur="saveTLField('${key}',this.value)" placeholder="—">${esc(value||'')}</textarea></div>`;
}
function frTLSelect(label, key, value, opts) {
  return `<div class="fr"><div class="fl">${esc(label)}</div>
    <select class="fi" onchange="saveTLField('${key}',this.value)">${opts.map(o=>`<option ${o===value?'selected':''}>${esc(o)}</option>`).join('')}</select></div>`;
}

function tlSection(n, title, body) {
  const k = 's'+n, open = ui.tlOpen?.[k] !== false;
  return `<div class="card" style="margin-bottom:12px;overflow:hidden">
    <div onclick="if(!ui.tlOpen)ui.tlOpen={};ui.tlOpen['${k}']=!${open};document.getElementById('mainContent').innerHTML=renderDocuments()"
      style="display:flex;align-items:center;justify-content:space-between;padding:14px 16px;cursor:pointer;user-select:none">
      <span style="font-size:15px;font-weight:700">${title}</span>
      <span style="color:var(--label3);font-size:12px">${open?'▲':'▼'}</span>
    </div>
    ${open?`<div style="border-top:1px solid var(--sep)">${body}</div>`:''}
  </div>`;
}

function renderTLStamps(log, archived) {
  const stamps = (log.stamps||[]).slice().sort((a,b)=>b.date.localeCompare(a.date));
  const addBtn = archived ? '' : `<div class="btn-row"><button class="btn btn-p btn-sm" onclick="showAddTLStamp()">+ Add stamp</button></div>`;
  if (!stamps.length) return addBtn + `<div style="text-align:center;padding:24px;color:var(--label3);font-size:13px">No stamps yet</div>`;
  const rows = stamps.map(s => {
    if (ui.tlEditStampId === s.id) return `<tr style="background:var(--surface2)">
      <td><input id="tles-d" class="fi" style="min-width:90px;font-size:12px;padding:4px 6px" value="${esc(s.date||'')}"></td>
      <td><input id="tles-p" class="fi" style="min-width:80px;font-size:12px;padding:4px 6px" value="${esc(s.port||'')}"></td>
      <td><select id="tles-t" class="fi" style="font-size:12px;padding:4px 6px"><option ${s.type==='Arrival'?'selected':''}>Arrival</option><option ${s.type==='Departure'?'selected':''}>Departure</option><option ${s.type==='Stamp'?'selected':''}>Stamp</option></select></td>
      <td><input id="tles-a" class="fi" style="min-width:80px;font-size:12px;padding:4px 6px" value="${esc(s.authority||'')}"></td>
      <td><input id="tles-n" class="fi" style="min-width:60px;font-size:12px;padding:4px 6px" value="${esc(s.notes||'')}"></td>
      <td style="white-space:nowrap;display:flex;gap:4px;align-items:center"><button class="btn btn-p btn-xs" onclick="saveTLStampEdit('${s.id}')">Save</button> <button class="btn btn-s btn-xs" onclick="ui.tlEditStampId=null;document.getElementById('mainContent').innerHTML=renderDocuments()">Cancel</button><button onclick="if(confirm('Remove this stamp?')){ui.tlEditStampId=null;deleteTLStamp('${s.id}')}" style="background:#FCEBEB;border:0.5px solid #F09595;color:#A32D2D;border-radius:7px;padding:3px 8px;font-family:var(--font);font-size:12px;font-weight:600;cursor:pointer">🗑</button></td></tr>`;
    const typeCls = s.type==='Arrival'?'b-green':s.type==='Departure'?'b-red':'b-orange';
    const acts = archived ? '' : `<button onclick="startTLStampEdit('${s.id}')" style="background:none;border:none;padding:2px 4px;cursor:pointer;font-size:14px;color:var(--label3);line-height:1;flex-shrink:0">✏️</button>`;
    return `<tr><td style="white-space:nowrap;font-size:13px">${esc(fmtDateEU(s.date))}</td><td style="font-size:13px">${esc(s.port)}</td>
      <td><span class="badge ${typeCls}" style="font-size:10px">${esc(s.type)}</span></td>
      <td style="font-size:12px;color:var(--label2)">${esc(s.authority||'')}</td>
      <td style="font-size:12px;color:var(--label2)">${esc(s.notes||'')}</td>
      <td style="white-space:nowrap">${acts}</td></tr>`;
  }).join('');
  return addBtn + `<div style="overflow-x:auto"><table class="tbl">
    <thead><tr><th>Date</th><th>Port</th><th>Type</th><th>Authority</th><th>Notes</th><th></th></tr></thead>
    <tbody>${rows}</tbody></table></div>`;
}

function frTLReadOnly(label, value) {
  if (!value && value !== 0) return '';
  return `<div class="fr"><div class="fl">${esc(label)}</div><div class="fv">${esc(value)}</div></div>`;
}
function showTLDetail(logId) { ui.tlDetailId = logId; document.getElementById('mainContent').innerHTML = renderDocuments(); }
function clearTLDetail() { ui.tlDetailId = null; document.getElementById('mainContent').innerHTML = renderDocuments(); }
function renderTLDetail(logId) {
  const wd = getTLData(), l = wd.logs[logId];
  if (!l) return '';
  const docFields = [
    ['Document Number',l.docNumber],['Issue Date',l.issueDate],['Valid From',l.validFrom],
    ['Valid Until',l.validUntil],['Customs Authority',l.customsAuthority],['Validity Type',l.validityType],
    ['Prev. Documents Count',l.prevDocCount],['Other Notes',l.otherNotes],['Provisions & Bonded Stores',l.provisions],
  ].map(([k,v])=>frTLReadOnly(k,v)).join('');
  const vesselFields = [
    ['Vessel Name',l.vesselName],['Flag',l.flag],['Port of Registry',l.portOfRegistry],
    ['Registration Number',l.regNumber],['Call Sign',l.callSign],['Type of Vessel',l.vesselType],
    ['Gross Tonnage (GT)',l.gt],['Engine',l.engine],['Length (LOA)',l.loa],
    ['Year Built',l.yearBuilt],['Year of First Registration',l.yearFirstReg],
    ['Owner Name',l.ownerName],['Holder/User',l.holderName],['Address',l.address],
    ['Telephone',l.telephone],['Email',l.email],['AFM/TIN',l.afm],['ID / Passport',l.idNumber],
  ].map(([k,v])=>frTLReadOnly(k,v)).join('');
  const docCard = docFields ? `<div class="card" style="margin-bottom:12px"><div class="card-hd">📋 Document Info</div><div class="card-body">${docFields}</div></div>` : '';
  const vesselCard = vesselFields ? `<div class="card" style="margin-bottom:12px"><div class="card-hd">🚢 Vessel & Owner</div><div class="card-body">${vesselFields}</div></div>` : '';
  const stampsCard = `<div class="card" style="margin-bottom:12px"><div class="card-hd">🛂 Port Stamps</div>${renderTLStamps(l,true)}</div>`;
  return `<div style="animation:tl-slide .2s ease;padding:4px 0">
    <div style="display:flex;align-items:center;gap:10px;margin-bottom:14px;flex-wrap:wrap">
      <button onclick="clearTLDetail()" style="background:none;border:none;padding:4px 0;cursor:pointer;font-size:14px;font-weight:600;color:var(--blue);font-family:var(--font)">← Back</button>
      <span style="font-size:15px;font-weight:700">${esc(fmtTLSeason(l.season))}</span>
      <span style="background:var(--label3);color:#fff;font-size:10px;font-weight:700;padding:2px 8px;border-radius:10px">Archived</span>
      <span style="flex:1"></span>
      <button onclick="showEditArchivedTL('${logId}')" style="background:var(--surface2);border:0.5px solid var(--sep);border-radius:10px;padding:5px 12px;font-size:12px;font-weight:600;font-family:var(--font);cursor:pointer;color:var(--label)">✏️ Edit</button>
    </div>
    ${docCard}${vesselCard}${stampsCard}
  </div>`;
}

// ── Transit Log gauge & timeline helpers ───────────────────────
function parseTLDate(str) {
  if (!str) return null;
  const eu = String(str).match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (eu) return new Date(+eu[3], +eu[2]-1, +eu[1]);
  return parseISODate(str);
}
function tlDaysUntil(str) {
  const d = parseTLDate(str);
  if (!d || isNaN(d.getTime())) return null;
  const now = new Date(); now.setHours(0,0,0,0);
  return Math.round((d - now) / 86400000);
}
function tlFmtDate(d) {
  if (!d || isNaN(d.getTime())) return '—';
  return String(d.getDate()).padStart(2,'0') + '/' + String(d.getMonth()+1).padStart(2,'0') + '/' + d.getFullYear();
}
function tlFrozenDays(log) {
  const fl = (log.freezeLog||[]).slice().sort((a,b)=>a.date.localeCompare(b.date));
  let frozen = 0, haulDate = null;
  for (const e of fl) {
    if (e.type==='hauled') { haulDate = e.date; }
    else if (e.type==='relaunched' && haulDate) {
      const h = parseISODate(haulDate), r = parseISODate(e.date);
      if (h && r && r > h) frozen += Math.round((r - h) / 86400000);
      haulDate = null;
    }
  }
  return frozen;
}
function tlCircleGauge(days, maxDays, color) {
  const CL = 101;
  const pct = days === null ? 0 : Math.min(1, Math.max(0, days / maxDays));
  const offset = Math.round(CL * (1 - pct));
  const txt = days === null ? '—' : String(Math.max(0, days));
  const fs = txt.length > 3 ? '11' : '14';
  return `<svg viewBox="0 0 80 44" style="width:100%;display:block">
    <path d="M8,40 A32,32 0 0,1 72,40" fill="none" stroke="#e5e7eb" stroke-width="10" stroke-linecap="round"/>
    <path d="M8,40 A32,32 0 0,1 72,40" fill="none" stroke="${color}" stroke-width="10" stroke-linecap="round" stroke-dasharray="${CL}" stroke-dashoffset="${offset}"/>
    <text x="40" y="28" text-anchor="middle" font-size="${fs}" font-weight="800" fill="${color}" font-family="var(--font)">${esc(txt)}</text>
    <text x="40" y="38" text-anchor="middle" font-size="7" fill="#9ca3af" font-family="var(--font)">days</text>
  </svg>`;
}
function renderTLGauges(cur) {
  function tlCard(title, svgContent, subs) {
    return `<div style="background:var(--surface);border:0.5px solid var(--sep);border-radius:14px;padding:12px 8px 10px;text-align:center">
      <div style="font-size:10px;font-weight:700;color:var(--label2);line-height:1.3;margin-bottom:4px">${title}</div>
      ${svgContent}
      ${(subs||[]).filter(Boolean).map(l=>`<div style="font-size:10px;color:var(--label3);margin-top:3px;word-break:break-all">${l}</div>`).join('')}
    </div>`;
  }

  // Gauge 1 — Boat validity
  const frozen = tlFrozenDays(cur);
  const boatRaw = tlDaysUntil(cur.validUntil);
  const boatDays = boatRaw === null ? null : boatRaw - frozen;
  const boatColor = boatDays===null?'#9ca3af':boatDays>180?'#22C55E':boatDays>90?'#F59E0B':'#EF4444';
  const boatSubs = [cur?.validUntil?`Valid until ${esc(cur.validUntil)}`:'', frozen>0?`${frozen}d frozen`:''];
  const g1 = tlCard('TL — Boat', tlCircleGauge(boatDays,365,boatColor), boatSubs);

  // Gauge 2 — User validity (6 months from userStartDate or validUntil, whichever sooner)
  const startDate = parseTLDate(cur.userStartDate||cur.issueDate||cur.validFrom||'');
  const validUntilDate = parseTLDate(cur.validUntil);
  let userDays=null, userExpStr='—';
  if (startDate) {
    const sixMo = new Date(startDate); sixMo.setDate(sixMo.getDate()+180);
    const userExp = validUntilDate ? (sixMo<validUntilDate?sixMo:validUntilDate) : sixMo;
    const now = new Date(); now.setHours(0,0,0,0);
    userDays = Math.round((userExp-now)/86400000);
    userExpStr = tlFmtDate(userExp);
  }
  const userColor = userDays===null?'#9ca3af':userDays>60?'#22C55E':userDays>30?'#F59E0B':'#EF4444';
  const g2 = tlCard('User', tlCircleGauge(userDays,180,userColor), [esc(cur.holderName||'—'), `Until ${esc(userExpStr)}`, '€30 to change']);

  // Gauge 3 — Schengen (live from data.schengen)
  const holderKey = (cur.holderName||'').trim().toLowerCase();
  const schengenMatch = holderKey ? (data.schengen?.persons||[]).find(p=>(p.name||'').trim().toLowerCase()===holderKey) : null;
  let g3;
  if (!schengenMatch) {
    g3 = `<div style="background:var(--surface);border:0.5px solid var(--sep);border-radius:14px;padding:12px 8px 10px;text-align:center">
      <div style="font-size:10px;font-weight:700;color:var(--label2);line-height:1.3;margin-bottom:4px">Schengen</div>
      <svg viewBox="0 0 80 44" style="width:100%;display:block">
        <path d="M8,40 A32,32 0 0,1 72,40" fill="none" stroke="#e5e7eb" stroke-width="10" stroke-linecap="round"/>
        <text x="40" y="28" text-anchor="middle" font-size="14" font-weight="800" fill="#9ca3af" font-family="var(--font)">—</text>
      </svg>
      <div style="font-size:10px;color:var(--blue);cursor:pointer;margin-top:3px" onclick="showTab('schengen')">Set up in Schengen tab</div>
    </div>`;
  } else {
    const isEU = schengenMatch.passports?.[schengenMatch.activePassport||0]?.eu === true;
    if (isEU) {
      g3 = `<div style="background:var(--surface);border:0.5px solid var(--sep);border-radius:14px;padding:12px 8px 10px;text-align:center">
        <div style="font-size:10px;font-weight:700;color:var(--label2);line-height:1.3;margin-bottom:4px">Schengen</div>
        <svg viewBox="0 0 80 44" style="width:100%;display:block">
          <path d="M8,40 A32,32 0 0,1 72,40" fill="none" stroke="#e5e7eb" stroke-width="10" stroke-linecap="round"/>
          <path d="M8,40 A32,32 0 0,1 72,40" fill="none" stroke="#22C55E" stroke-width="10" stroke-linecap="round" stroke-dasharray="101" stroke-dashoffset="0"/>
          <text x="40" y="28" text-anchor="middle" font-size="14" font-weight="800" fill="#22C55E" font-family="var(--font)">EU</text>
        </svg>
        <div style="font-size:10px;color:#22C55E;font-weight:600;margin-top:3px">No limit</div>
      </div>`;
    } else {
      const {days:schUsed} = calcSchengenDays(schengenMatch.log);
      const schRem = 90 - schUsed;
      const schColor = schRem>45?'#22C55E':schRem>20?'#F59E0B':'#EF4444';
      g3 = tlCard('Schengen', tlCircleGauge(schRem,90,schColor), [`${schUsed}/90 used`]);
    }
  }
  return `<div style="display:grid;grid-template-columns:repeat(3,1fr);gap:10px;margin-bottom:10px">${g1}${g2}${g3}</div>`;
}
function renderTLAlertBar(cur) {
  const issues = [];
  const frozen = tlFrozenDays(cur);
  const boatDays = tlDaysUntil(cur.validUntil) !== null ? tlDaysUntil(cur.validUntil) - frozen : null;
  if (boatDays !== null && boatDays <= 180) issues.push(boatDays<=90?`🔴 Boat TL expires in ${boatDays}d`:`🟡 Boat TL expires in ${boatDays}d`);
  const startDate = parseTLDate(cur.userStartDate||cur.issueDate||cur.validFrom||'');
  if (startDate) {
    const sixMo = new Date(startDate); sixMo.setDate(sixMo.getDate()+180);
    const vud = parseTLDate(cur.validUntil);
    const ue = vud ? (sixMo<vud?sixMo:vud) : sixMo;
    const now = new Date(); now.setHours(0,0,0,0);
    const ud = Math.round((ue-now)/86400000);
    if (ud <= 60) issues.push(ud<=30?`🔴 User validity expires in ${ud}d`:`🟡 User validity expires in ${ud}d`);
  }
  const hk = (cur.holderName||'').trim().toLowerCase();
  const sm = hk ? (data.schengen?.persons||[]).find(p=>(p.name||'').trim().toLowerCase()===hk) : null;
  if (sm && !sm.passports?.[sm.activePassport||0]?.eu) {
    const {days:su} = calcSchengenDays(sm.log);
    const sr = 90-su;
    if (sr <= 45) issues.push(sr<=0?`🔴 Schengen OVERSTAY by ${Math.abs(sr)}d`:sr<=20?`🔴 Schengen ${sr}d remaining`:`🟡 Schengen ${sr}d remaining`);
  }
  if (!issues.length) return '';
  const hasRed = issues.some(i=>i.startsWith('🔴'));
  return `<div style="margin-bottom:10px;padding:10px 14px;background:${hasRed?'rgba(239,68,68,.08)':'rgba(245,158,11,.08)'};border:0.5px solid ${hasRed?'#EF4444':'#F59E0B'};border-radius:10px;font-size:13px;color:${hasRed?'#EF4444':'#D97706'};font-weight:600">${issues.join(' · ')}</div>`;
}
function renderTLCurrentUser(cur) {
  const startDate = parseTLDate(cur.userStartDate||cur.issueDate||cur.validFrom||'');
  const vud = parseTLDate(cur.validUntil);
  let expiryStr = '—', userDays = null;
  if (startDate) {
    const sixMo = new Date(startDate); sixMo.setDate(sixMo.getDate()+180);
    const ue = vud ? (sixMo<vud?sixMo:vud) : sixMo;
    expiryStr = tlFmtDate(ue);
    const now = new Date(); now.setHours(0,0,0,0);
    userDays = Math.round((ue-now)/86400000);
  }
  const bg    = userDays===null?'rgba(245,158,11,.08)':userDays>60?'rgba(34,197,94,.08)':userDays>30?'rgba(245,158,11,.08)':'rgba(239,68,68,.08)';
  const bdr   = userDays===null?'#F59E0B':userDays>60?'#22C55E':userDays>30?'#F59E0B':'#EF4444';
  const lblTx = userDays===null?'#D97706':userDays>60?'#15803d':userDays>30?'#D97706':'#DC2626';
  return `<div style="margin-bottom:10px;background:${bg};border:0.5px solid ${bdr};border-radius:14px;padding:12px 16px;display:flex;align-items:center;gap:12px;flex-wrap:wrap">
    <div style="flex:1;min-width:0">
      <div style="font-size:11px;font-weight:700;color:${lblTx};margin-bottom:2px">Current User</div>
      <div style="font-size:15px;font-weight:700;color:var(--label)">${esc(cur.holderName||'—')}</div>
      <div style="font-size:12px;color:var(--label3);margin-top:2px">Valid until ${esc(expiryStr)}</div>
    </div>
    <button onclick="showTLChangeUser()" style="background:${bdr};color:#fff;border:none;border-radius:10px;padding:8px 14px;font-size:13px;font-weight:600;font-family:var(--font);cursor:pointer;white-space:nowrap">Change user →</button>
  </div>`;
}
function renderTLFreezeLog(cur) {
  const fl = (cur.freezeLog||[]).slice().sort((a,b)=>a.date.localeCompare(b.date));
  const dotColor = {issued:'#9ca3af',hauled:'#3B82F6',relaunched:'#22C55E',userChanged:'#F59E0B'};
  const typeLabel = {issued:'Issued',hauled:'Hauled out',relaunched:'Relaunched',userChanged:'User changed'};
  const rows = fl.map((e,i) => {
    const dot = dotColor[e.type]||'#9ca3af';
    const isLast = i === fl.length-1;
    return `<div style="display:flex;align-items:flex-start;gap:10px">
      <div style="display:flex;flex-direction:column;align-items:center;flex-shrink:0;padding-top:2px">
        <div style="width:11px;height:11px;border-radius:50%;background:${dot}"></div>
        ${isLast?'':'<div style="width:2px;flex:1;min-height:18px;background:var(--sep);margin:2px 0"></div>'}
      </div>
      <div style="flex:1;min-width:0;padding-bottom:${isLast?'0':'10px'}">
        <div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap">
          <span style="font-size:13px;font-weight:700;color:${dot}">${esc(typeLabel[e.type]||e.type)}</span>
          <span style="font-size:12px;color:var(--label3)">${esc(fmtDateEU(e.date))}</span>
          ${e.location?`<span style="font-size:12px;color:var(--label2)">· ${esc(e.location)}</span>`:''}
        </div>
        ${e.notes?`<div style="font-size:12px;color:var(--label3);margin-top:1px">${esc(e.notes)}</div>`:''}
      </div>
      <button onclick="showEditFreezeEntry('${e.id}')" style="background:none;border:none;padding:2px 4px;cursor:pointer;font-size:14px;color:var(--label3);line-height:1;flex-shrink:0">✏️</button>
    </div>`;
  }).join('');
  return `<div class="card" style="margin-bottom:12px">
    <div style="display:flex;align-items:center;justify-content:space-between;padding:12px 16px">
      <span style="font-size:14px;font-weight:700">⏱ Freeze / Relaunch History</span>
      <button class="btn btn-s btn-sm" onclick="showAddFreezeEntry()">+ Add</button>
    </div>
    <div style="border-top:1px solid var(--sep);padding:10px 16px">
      ${fl.length===0?`<div style="text-align:center;padding:12px 0;color:var(--label3);font-size:13px">No entries — add haul-out dates and user changes here</div>`:rows}
    </div>
  </div>`;
}

function renderTransitLog() {
  try { return _renderTransitLog(); } catch(e) { console.error('renderTransitLog:', e); return `<div style="padding:20px;color:var(--red);font-size:13px">Transit Log error: ${esc(e.message)}<br><small style="color:var(--label3)">${esc(e.stack||'')}</small></div>`; }
}
function fmtTLSeason(s) { const m=String(s||'').match(/^(\d{4})-(\d{4})$/); return m?m[1]+'/'+m[2].slice(-2):s; }
function _renderTransitLog() {
  if (ui.tlDetailId) return renderTLDetail(ui.tlDetailId);
  const wd = getTLData();
  if (!ui.tlOpen) ui.tlOpen = {s1:true, s2:true, s3:true};
  const cur = wd.logs[wd.currentLog]; if (!cur) return '';
  const exp = expiryBadge(cur.validUntil, 60);

  const activeHdr = `<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:10px;flex-wrap:wrap;gap:8px">
    <div style="display:flex;align-items:center;gap:8px">
      <span style="font-size:15px;font-weight:700">${esc(fmtTLSeason(cur.season))}</span>
      <span style="background:var(--green);color:#fff;font-size:10px;font-weight:700;padding:2px 8px;border-radius:10px">Active</span>
    </div>
    <button class="btn btn-s btn-sm" onclick="archiveTransitLog()">Archive &amp; New</button>
  </div>`;

  const s1 = `<div class="card-body">
    ${frTL('Document Number (Αρ. Δελτίου)','docNumber',cur.docNumber)}
    ${frTL('Issue Date (Ημερομηνία)','issueDate',cur.issueDate)}
    ${frTL('Valid From (Από)','validFrom',cur.validFrom)}
    <div class="fr"><div class="fl">Valid Until (Μέχρι) ${exp}</div><input class="fi" type="text" value="${esc(cur.validUntil||'')}" onblur="saveTLField('validUntil',this.value)" placeholder="—"></div>
    ${frTL('Customs Authority (Τελ. Αρχή)','customsAuthority',cur.customsAuthority)}
    ${frTLSelect('Validity Type','validityType',cur.validityType||'Limited (Ορισμένη)',['Limited (Ορισμένη)','Unlimited (Αόριστη)'])}
    ${frTL('Previous Documents Count','prevDocCount',cur.prevDocCount)}
    ${frTLArea('Other Notes','otherNotes',cur.otherNotes)}
    ${frTLArea('Vessel Provisions and Bonded Stores','provisions',cur.provisions)}
  </div>`;
  const s2 = `<div class="card-body">
    ${frTL('Vessel Name','vesselName',cur.vesselName)}
    ${frTL('Flag','flag',cur.flag)}
    ${frTL('Port of Registry','portOfRegistry',cur.portOfRegistry)}
    ${frTL('Registration Number','regNumber',cur.regNumber)}
    ${frTL('Call Sign','callSign',cur.callSign)}
    ${frTL('Type of Vessel','vesselType',cur.vesselType)}
    ${frTL('Gross Tonnage (GT)','gt',cur.gt)}
    ${frTL('Engine','engine',cur.engine)}
    ${frTL('Length (LOA)','loa',cur.loa)}
    ${frTL('Year Built','yearBuilt',cur.yearBuilt)}
    ${frTL('Year of First Registration','yearFirstReg',cur.yearFirstReg)}
    ${frTL('Owner Name (Πλοιοκτήτης)','ownerName',cur.ownerName)}
    ${frTL('Holder/User (Κατοχος-Χρηστης)','holderName',cur.holderName)}
    ${frTL('Address','address',cur.address)}
    ${frTL('Telephone','telephone',cur.telephone)}
    ${frTL('Email','email',cur.email)}
    ${frTL('AFM/TIN (ΑΦΜ)','afm',cur.afm)}
    ${frTL('ID / Passport (ΑΔΤ ή Διαβατήριο)','idNumber',cur.idNumber)}
  </div>`;

  const archived = Object.entries(wd.logs)
    .filter(([id,l])=>l.archived)
    .sort((a,b)=>b[1].season.localeCompare(a[1].season));
  const pastRows = archived.map(([id,l])=>{
    const dates = [l.validFrom, l.validUntil].filter(Boolean).join('–');
    const note = (l.otherNotes||l.docNumber||'');
    return `<div style="display:flex;align-items:center;gap:8px;padding:8px 14px;border-bottom:1px solid var(--sep);overflow:hidden;cursor:pointer" onclick="showTLDetail('${id}')">
      <div style="font-size:12px;font-weight:700;flex-shrink:0;width:54px;white-space:nowrap">${esc(fmtTLSeason(l.season))}</div>
      <div style="font-size:12px;flex-shrink:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:120px">${esc(l.docNumber||'—')}</div>
      <div style="font-size:11px;color:var(--label3);flex-shrink:0;white-space:nowrap">${esc(dates)}</div>
      <div style="font-size:11px;color:var(--label3);flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(note.length>40?note.slice(0,40)+'…':note)}</div>
      <button onclick="event.stopPropagation();showEditArchivedTL('${id}')" style="background:none;border:none;padding:2px 4px;cursor:pointer;font-size:14px;color:var(--label3);line-height:1;flex-shrink:0">✏️</button>
    </div>`;
  }).join('');
  const pastSection = archived.length
    ? `<div class="sec-hd">Past transit logs</div><div class="card">${pastRows}</div>`
    : '';

  return activeHdr
    + renderTLGauges(cur)
    + renderTLAlertBar(cur)
    + renderTLCurrentUser(cur)
    + renderTLFreezeLog(cur)
    + tlSection(1,'📋 Document Info',s1)
    + tlSection(2,'🚢 Vessel & Owner',s2)
    + tlSection(3,'🛂 Port Stamps (Δελτίο Κίνησης)',renderTLStamps(cur,false))
    + pastSection;
}

function showAddTLStamp() {
  showModal('Add Port Stamp', `
    <div class="mi-label">Date</div><input class="mi" id="tl-d" type="date" value="${new Date().toISOString().slice(0,10)}">
    <div class="mi-label">Port</div><input class="mi" id="tl-p" placeholder="e.g. Paros">
    <div class="mi-label">Type</div><select class="mi" id="tl-t"><option>Arrival</option><option>Departure</option><option>Stamp</option></select>
    <div class="mi-label">Authority</div><input class="mi" id="tl-a" placeholder="e.g. Syros Coast Guard">
    <div class="mi-label">Notes</div><input class="mi" id="tl-n" placeholder="Optional">
    <div class="modal-btns"><button class="btn btn-s" onclick="hideModal()">Cancel</button><button class="btn btn-p" onclick="saveTLStamp()">Add</button></div>`);
}
function saveTLStamp() {
  const wd=getTLData(), log=wd.logs[wd.currentLog]; if (!log) return;
  if (!log.stamps) log.stamps=[];
  log.stamps.push({id:uid(), date:document.getElementById('tl-d').value, port:document.getElementById('tl-p').value,
    type:document.getElementById('tl-t').value, authority:document.getElementById('tl-a').value, notes:document.getElementById('tl-n').value});
  save(); hideModal(); document.getElementById('mainContent').innerHTML=renderDocuments();
}
function deleteTLStamp(id) {
  const wd=getTLData(), log=wd.logs[wd.currentLog]; if (!log) return;
  log.stamps=(log.stamps||[]).filter(s=>s.id!==id);
  save(); document.getElementById('mainContent').innerHTML=renderDocuments();
}
function startTLStampEdit(id) {
  ui.tlEditStampId=id;
  document.getElementById('mainContent').innerHTML=renderDocuments();
  setTimeout(()=>document.getElementById('tles-d')?.focus(), 40);
}
function saveTLStampEdit(id) {
  const wd=getTLData(), log=wd.logs[wd.currentLog];
  const s=(log?.stamps||[]).find(x=>x.id===id); if (!s) return;
  s.date     =document.getElementById('tles-d')?.value||s.date;
  s.port     =document.getElementById('tles-p')?.value||'';
  s.type     =document.getElementById('tles-t')?.value||s.type;
  s.authority=document.getElementById('tles-a')?.value||'';
  s.notes    =document.getElementById('tles-n')?.value||'';
  ui.tlEditStampId=null;
  save(); document.getElementById('mainContent').innerHTML=renderDocuments();
}
function archiveTransitLog() {
  if (!confirm('Archive this transit log and start a new one for the next season?')) return;
  const wd=getTLData(), cur=wd.logs[wd.currentLog]; if (!cur) return;
  cur.archived=true;
  const ns=nextTLSeason(cur.season), nid='tl'+ns.replace(/[^0-9]/g,'');
  wd.logs[nid]={season:ns, archived:false, stamps:[],
    docNumber:'', issueDate:'', validFrom:'', validUntil:'', customsAuthority:'', validityType:'Limited (Ορισμένη)',
    prevDocCount:'', otherNotes:'', provisions:'', vesselName:'', flag:'', portOfRegistry:'', regNumber:'',
    callSign:'', vesselType:'', gt:'', engine:'', loa:'', yearBuilt:'', yearFirstReg:'',
    ownerName:'', holderName:'', address:'', telephone:'', email:'', afm:'', idNumber:''};
  wd.currentLog=nid; ui.tlOpen={s1:true,s2:true,s3:true}; ui.tlEditStampId=null;
  save(); document.getElementById('mainContent').innerHTML=renderDocuments();
}
function showEditArchivedTL(logId) {
  const wd=getTLData(), l=wd.logs[logId]; if (!l) return;
  showModal(`Edit: ${esc(fmtTLSeason(l.season))}`, `
    <div class="mi-label">Season (e.g. 2024-2025)</div><input class="mi" id="tla-season" value="${esc(l.season||'')}">
    <div class="mi-label">Document Number</div><input class="mi" id="tla-docNumber" value="${esc(l.docNumber||'')}">
    <div class="mi-label">Issue Date</div><input class="mi" id="tla-issueDate" value="${esc(l.issueDate||'')}">
    <div class="mi-label">Valid From</div><input class="mi" id="tla-validFrom" value="${esc(l.validFrom||'')}">
    <div class="mi-label">Valid Until</div><input class="mi" id="tla-validUntil" value="${esc(l.validUntil||'')}">
    <div class="mi-label">Customs Authority</div><input class="mi" id="tla-authority" value="${esc(l.customsAuthority||'')}">
    <div class="mi-label">Notes</div><input class="mi" id="tla-notes" value="${esc(l.otherNotes||'')}">
    <div class="modal-btns">
      <button onclick="if(confirm('Delete this archived transit log?')){hideModal();deleteArchivedTL('${logId}')}" style="background:#FCEBEB;border:0.5px solid #F09595;color:#A32D2D;border-radius:8px;padding:8px 14px;font-family:var(--font);font-size:14px;font-weight:600;cursor:pointer;margin-right:auto">Delete</button>
      <button class="btn btn-s" onclick="hideModal()">Cancel</button>
      <button class="btn btn-p" onclick="saveEditArchivedTL('${logId}')">Save</button>
    </div>`);
}
function saveEditArchivedTL(logId) {
  const wd=getTLData(), l=wd.logs[logId]; if (!l) return;
  l.season            = document.getElementById('tla-season')?.value    || l.season;
  l.docNumber         = document.getElementById('tla-docNumber')?.value || '';
  l.issueDate         = document.getElementById('tla-issueDate')?.value || '';
  l.validFrom         = document.getElementById('tla-validFrom')?.value || '';
  l.validUntil        = document.getElementById('tla-validUntil')?.value|| '';
  l.customsAuthority  = document.getElementById('tla-authority')?.value || '';
  l.otherNotes        = document.getElementById('tla-notes')?.value     || '';
  save(); hideModal(); document.getElementById('mainContent').innerHTML=renderDocuments();
}
function deleteArchivedTL(logId) {
  const wd=getTLData();
  delete wd.logs[logId];
  if (ui.tlDetailId === logId) ui.tlDetailId = null;
  save(); document.getElementById('mainContent').innerHTML=renderDocuments();
}

function showAddFreezeEntry() {
  showModal('Add Entry', `
    <div class="mi-label">Type</div>
    <select class="mi" id="fe-type">
      <option value="issued">Issued</option>
      <option value="hauled">Hauled out</option>
      <option value="relaunched">Relaunched</option>
      <option value="userChanged">User changed</option>
    </select>
    <div class="mi-label">Date</div>
    <input class="mi" id="fe-date" type="date" value="${new Date().toISOString().slice(0,10)}">
    <div class="mi-label">Location</div>
    <input class="mi" id="fe-loc" placeholder="e.g. Kilada Marina">
    <div class="mi-label">Notes</div>
    <input class="mi" id="fe-notes" placeholder="Optional">
    <div class="modal-btns">
      <button class="btn btn-s" onclick="hideModal()">Cancel</button>
      <button class="btn btn-p" onclick="saveFreezeEntry()">Add</button>
    </div>`);
}
function saveFreezeEntry() {
  const wd=getTLData(), log=wd.logs[wd.currentLog]; if (!log) return;
  if (!log.freezeLog) log.freezeLog=[];
  log.freezeLog.push({id:uid(), type:document.getElementById('fe-type').value,
    date:document.getElementById('fe-date').value, location:document.getElementById('fe-loc').value,
    notes:document.getElementById('fe-notes').value});
  save(); hideModal(); document.getElementById('mainContent').innerHTML=renderDocuments();
}
function showEditFreezeEntry(id) {
  const wd=getTLData(), log=wd.logs[wd.currentLog]; if (!log) return;
  const e=(log.freezeLog||[]).find(x=>x.id===id); if (!e) return;
  showModal('Edit Entry', `
    <div class="mi-label">Type</div>
    <select class="mi" id="fe-type">
      <option value="issued" ${e.type==='issued'?'selected':''}>Issued</option>
      <option value="hauled" ${e.type==='hauled'?'selected':''}>Hauled out</option>
      <option value="relaunched" ${e.type==='relaunched'?'selected':''}>Relaunched</option>
      <option value="userChanged" ${e.type==='userChanged'?'selected':''}>User changed</option>
    </select>
    <div class="mi-label">Date</div>
    <input class="mi" id="fe-date" type="date" value="${esc(e.date||'')}">
    <div class="mi-label">Location</div>
    <input class="mi" id="fe-loc" value="${esc(e.location||'')}" placeholder="e.g. Kilada Marina">
    <div class="mi-label">Notes</div>
    <input class="mi" id="fe-notes" value="${esc(e.notes||'')}" placeholder="Optional">
    <div class="modal-btns">
      <button onclick="if(confirm('Delete this entry?')){hideModal();deleteFreezeEntry('${id}')}" style="background:#FCEBEB;border:0.5px solid #F09595;color:#A32D2D;border-radius:8px;padding:8px 14px;font-family:var(--font);font-size:14px;font-weight:600;cursor:pointer;margin-right:auto">Delete</button>
      <button class="btn btn-s" onclick="hideModal()">Cancel</button>
      <button class="btn btn-p" onclick="saveEditFreezeEntry('${id}')">Save</button>
    </div>`);
}
function saveEditFreezeEntry(id) {
  const wd=getTLData(), log=wd.logs[wd.currentLog]; if (!log) return;
  const e=(log.freezeLog||[]).find(x=>x.id===id); if (!e) return;
  e.type=document.getElementById('fe-type').value;
  e.date=document.getElementById('fe-date').value;
  e.location=document.getElementById('fe-loc').value;
  e.notes=document.getElementById('fe-notes').value;
  save(); hideModal(); document.getElementById('mainContent').innerHTML=renderDocuments();
}
function deleteFreezeEntry(id) {
  const wd=getTLData(), log=wd.logs[wd.currentLog]; if (!log) return;
  log.freezeLog=(log.freezeLog||[]).filter(x=>x.id!==id);
  save(); document.getElementById('mainContent').innerHTML=renderDocuments();
}
function showTLChangeUser() {
  showModal('Change User', `
    <div class="mi-label">New Holder / User Name</div>
    <input class="mi" id="cu-name" placeholder="Full name" autofocus>
    <div class="mi-label">Date of Change</div>
    <input class="mi" id="cu-date" type="date" value="${new Date().toISOString().slice(0,10)}">
    <div class="mi-label">Fee Paid</div>
    <input class="mi" id="cu-fee" value="€30" placeholder="€30">
    <div class="mi-label">Notes</div>
    <input class="mi" id="cu-notes" placeholder="Optional">
    <div class="modal-btns">
      <button class="btn btn-s" onclick="hideModal()">Cancel</button>
      <button class="btn btn-p" onclick="saveTLChangeUser()">Save</button>
    </div>`);
}
function saveTLChangeUser() {
  const wd=getTLData(), log=wd.logs[wd.currentLog]; if (!log) return;
  const name=document.getElementById('cu-name').value.trim();
  if (!name) { showToast('Enter the new user name', true); return; }
  const date=document.getElementById('cu-date').value;
  const fee=document.getElementById('cu-fee').value||'€30';
  const notes=document.getElementById('cu-notes').value;
  if (!log.freezeLog) log.freezeLog=[];
  log.freezeLog.push({id:uid(), type:'userChanged', date, location:'',
    notes:`Changed to ${name} · ${fee}${notes?' · '+notes:''}`});
  log.holderName=name;
  log.userStartDate=date;
  save(); hideModal(); document.getElementById('mainContent').innerHTML=renderDocuments();
}

// ═══════════════════════════════════════════════════════════
//  CLEARANCE TAB
// ═══════════════════════════════════════════════════════════
function renderClearance() {
  const FULL_MO = ['January','February','March','April','May','June','July','August','September','October','November','December'];
  const wd  = getTLData();
  const cur = wd.logs[wd.currentLog];
  const C   = data.documents?.customs || {};

  // ── Gauge 1: TL Boat ──
  const frozen   = cur ? tlFrozenDays(cur) : 0;
  const boatRaw  = cur ? tlDaysUntil(cur.validUntil) : null;
  const boatDays = boatRaw !== null ? boatRaw - frozen : null;
  const boatColor= boatDays===null?'#9ca3af':boatDays>180?'#22C55E':boatDays>90?'#F59E0B':'#EF4444';

  // ── Gauge 2: User ──
  const startDate = cur ? parseTLDate(cur.userStartDate||cur.issueDate||cur.validFrom||'') : null;
  const vud       = cur ? parseTLDate(cur.validUntil) : null;
  let userDays = null, userExpStr = '—';
  if (startDate) {
    const sixMo = new Date(startDate); sixMo.setDate(sixMo.getDate()+180);
    const ue = vud ? (sixMo<vud?sixMo:vud) : sixMo;
    const now = new Date(); now.setHours(0,0,0,0);
    userDays = Math.round((ue-now)/86400000);
    userExpStr = tlFmtDate(ue);
  }
  const userColor= userDays===null?'#9ca3af':userDays>60?'#22C55E':userDays>30?'#F59E0B':'#EF4444';

  // ── Gauge 3: eTEPAY ──
  const etYear  = parseInt(C.year) || new Date().getFullYear();
  const covered = Array.isArray(C.monthsCovered)
    ? C.monthsCovered
    : (C.monthsCovered||'').split(',').map(s=>s.trim()).filter(Boolean);
  const now0    = new Date(); now0.setHours(0,0,0,0);
  let etTotal=0, etFuture=0;
  for (const m of covered) {
    const mi = FULL_MO.indexOf(m); if (mi===-1) continue;
    etTotal++;
    if (new Date(etYear, mi+1, 1) > now0) etFuture++;
  }
  const etColor   = etFuture>3?'#22C55E':etFuture>0?'#F59E0B':'#EF4444';
  const validMoIdxs = covered.map(m => FULL_MO.indexOf(m)).filter(i => i !== -1);
  const lastMoIdx   = validMoIdxs.length ? Math.max(...validMoIdxs) : -1;
  const etPaidStr   = lastMoIdx >= 0 ? `${FULL_MO[lastMoIdx].slice(0,3)} ${etYear}` : '—';

  // ── Gauge 4: Schengen ──
  const holderKey = (cur?.holderName||'').trim().toLowerCase();
  const schPersons = (data.schengen?.persons||[]).filter(p=>p.name);
  let schMatch = holderKey ? schPersons.find(p=>(p.name||'').trim().toLowerCase()===holderKey) : null;
  if (!schMatch) {
    if (schPersons.length === 1) { schMatch = schPersons[0]; }
    else if (schPersons.length > 1) { schMatch = schPersons.find(p=>!p.passports?.[p.activePassport||0]?.eu) || null; }
  }
  const isEU      = schMatch ? schMatch.passports?.[schMatch.activePassport||0]?.eu===true : false;
  let schRem=null, schUsed=0, schPassLabel='';
  if (schMatch && !isEU) {
    const {days} = calcSchengenDays(schMatch.log);
    schUsed = days; schRem = 90-days;
    const recentIn = [...(schMatch.log||[])].filter(e=>e.type==='in'&&!e.seamanBook).sort((a,b)=>b.date.localeCompare(a.date))[0];
    const schPassFlag = recentIn?.passport || '';
    const schPassObj  = schPassFlag ? schMatch.passports?.find(pp=>pp.flag===schPassFlag) : schMatch.passports?.[schMatch.activePassport||0];
    schPassLabel = [schPassObj?.flag, schPassObj?.country?.slice(0,3)].filter(Boolean).join(' ');
  }
  const seamanActive = schMatch ? isSeamanBookActive(schMatch.log) : false;
  const schColor = !schMatch?'#9ca3af':isEU?'#22C55E':seamanActive?'#F59E0B':schRem>45?'#22C55E':schRem>20?'#F59E0B':'#EF4444';

  // ── Overall status ──
  const isRed   = (boatDays!==null&&boatDays<=90)||(userDays!==null&&userDays<=30)||etFuture<=0||(!isEU&&schRem!==null&&schRem<=20);
  const isAmber = !isRed&&((boatDays!==null&&boatDays<=180)||(userDays!==null&&userDays<=60)||etFuture<=3||seamanActive||(!isEU&&schRem!==null&&schRem<=45));
  const statusLabel  = isRed?'Alert':isAmber?'Action needed':'All clear';
  const statusBorder = isRed?'#EF4444':isAmber?'#F59E0B':'#22C55E';
  const statusBg     = isRed?'rgba(239,68,68,.1)':isAmber?'rgba(245,158,11,.1)':'rgba(34,197,94,.1)';
  const statusTxt    = isRed?'#EF4444':isAmber?'#D97706':'#15803d';

  // ── Alert bar ──
  const issues=[];
  if (boatDays!==null&&boatDays<=180) issues.push(boatDays<=90?`🔴 Boat TL ${boatDays}d`:`🟡 Boat TL ${boatDays}d`);
  if (userDays!==null&&userDays<=60)  issues.push(userDays<=30?`🔴 User ${userDays}d`:`🟡 User ${userDays}d`);
  if (etFuture<=3) issues.push(etFuture<=0?`🔴 eTEPAY expired`:`🟡 eTEPAY ${etFuture} month${etFuture!==1?'s':''}`);
  if (seamanActive) issues.push(`🟡 Seaman's Book entry detected — visit immigration before flying out of Greece`);
  else if (!isEU&&schRem!==null&&schRem<=45) issues.push(schRem<=0?`🔴 Schengen OVERSTAY ${Math.abs(schRem)}d`:schRem<=20?`🔴 Schengen ${schRem}d`:`🟡 Schengen ${schRem}d`);
  const alertBar = issues.length ? `<div style="margin-bottom:12px;padding:10px 14px;background:${isRed?'rgba(239,68,68,.08)':'rgba(245,158,11,.08)'};border:0.5px solid ${isRed?'#EF4444':'#F59E0B'};border-radius:10px;font-size:13px;color:${isRed?'#EF4444':'#D97706'};font-weight:600">${issues.join(' · ')}</div>` : '';

  // ── Gauge helper ──
  const CL = 101; // π × r(32)
  function gaugeCell(title, value, max, color, subs, cardStyle, sublabel) {
    const pct    = value === null ? 0 : Math.min(1, Math.max(0, value / max));
    const offset = Math.round(CL * (1 - pct));
    const num    = value === null ? '—' : String(Math.max(0, value));
    const fs     = num.length > 3 ? '11' : '14';
    return `<div style="background:var(--surface);border:0.5px solid var(--sep);border-radius:14px;padding:12px 8px 10px;text-align:center;${cardStyle||''}">
      <div style="font-size:10px;font-weight:700;color:var(--label2);line-height:1.3;margin-bottom:4px">${title}</div>
      <svg viewBox="0 0 80 44" style="width:100%;display:block">
        <path d="M8,40 A32,32 0 0,1 72,40" fill="none" stroke="#e5e7eb" stroke-width="10" stroke-linecap="round"/>
        <path d="M8,40 A32,32 0 0,1 72,40" fill="none" stroke="${color}" stroke-width="10" stroke-linecap="round" stroke-dasharray="${CL}" stroke-dashoffset="${offset}"/>
        <text x="40" y="28" text-anchor="middle" font-size="${fs}" font-weight="800" fill="${color}" font-family="var(--font)">${esc(num)}</text>
        <text x="40" y="38" text-anchor="middle" font-size="7" fill="#9ca3af" font-family="var(--font)">${sublabel||'days'}</text>
      </svg>
      ${subs.filter(Boolean).map(l=>`<div style="font-size:10px;color:var(--label3);margin-top:3px;word-break:break-all">${l}</div>`).join('')}
    </div>`;
  }

  const g1subs = [];
  if (cur?.validUntil) g1subs.push(`Valid until ${esc(cur.validUntil)}`);
  if (frozen>0) g1subs.push(`${frozen}d frozen`);

  const g2subs = [esc(cur?.holderName||'—'), `Until ${esc(userExpStr)}`, '€30 to change'];

  const g3subs = [etPaidStr!=='—'?`Paid until ${etPaidStr}`:''];
  if (etFuture>0&&etFuture<=3) g3subs.push('Renew soon');
  else if (etFuture===0) g3subs.push('Expired — renew now');

  let g4;
  if (!schMatch) {
    g4 = `<div style="background:var(--surface);border:0.5px solid var(--sep);border-radius:14px;padding:12px 8px 10px;text-align:center">
      <div style="font-size:10px;font-weight:700;color:var(--label2);line-height:1.3;margin-bottom:4px">Schengen (TL User)</div>
      <svg viewBox="0 0 80 44" style="width:100%;display:block">
        <path d="M8,40 A32,32 0 0,1 72,40" fill="none" stroke="#e5e7eb" stroke-width="10" stroke-linecap="round"/>
        <text x="40" y="28" text-anchor="middle" font-size="14" font-weight="800" fill="#9ca3af" font-family="var(--font)">—</text>
      </svg>
      <div style="font-size:10px;color:var(--blue);cursor:pointer;margin-top:3px" onclick="showTab('schengen')">Set up in Schengen tab</div>
    </div>`;
  } else if (isEU) {
    g4 = `<div style="background:var(--surface);border:0.5px solid var(--sep);border-radius:14px;padding:12px 8px 10px;text-align:center">
      <div style="font-size:10px;font-weight:700;color:var(--label2);line-height:1.3;margin-bottom:4px">Schengen (TL User)</div>
      <svg viewBox="0 0 80 44" style="width:100%;display:block">
        <path d="M8,40 A32,32 0 0,1 72,40" fill="none" stroke="#e5e7eb" stroke-width="10" stroke-linecap="round"/>
        <path d="M8,40 A32,32 0 0,1 72,40" fill="none" stroke="#22C55E" stroke-width="10" stroke-linecap="round" stroke-dasharray="101" stroke-dashoffset="0"/>
        <text x="40" y="28" text-anchor="middle" font-size="14" font-weight="800" fill="#22C55E" font-family="var(--font)">EU</text>
      </svg>
      <div style="font-size:10px;color:#22C55E;font-weight:600;margin-top:3px">No limit</div>
    </div>`;
  } else if (seamanActive) {
    g4 = gaugeCell('Schengen (TL User)', schRem, 90, '#F59E0B',
      [`⚓ Seaman's Book`, `${schPassLabel?schPassLabel+' · ':''}${schUsed}/90 used`],
      'background:rgba(245,158,11,.08);border:0.5px solid #F59E0B;');
  } else {
    g4 = gaugeCell('Schengen (TL User)', schRem, 90, schColor, [`${schPassLabel?schPassLabel+' · ':''}${schUsed}/90 used`]);
  }

  const gaugeGrid = `<div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:16px">
    ${gaugeCell('TL — Boat', boatDays, 365, boatColor, g1subs)}
    ${gaugeCell('User', userDays, 180, userColor, g2subs)}
    ${gaugeCell('eTEPAY', etFuture, Math.max(etTotal,1), etColor, g3subs, undefined, 'months')}
    ${g4}
  </div>`;

  // ── Quick links ──
  function qlRow(dot, label, summary, action) {
    return `<div style="display:flex;align-items:center;gap:12px;padding:11px 16px;border-bottom:1px solid var(--sep);cursor:pointer" onclick="${action}">
      <div style="width:10px;height:10px;border-radius:50%;background:${dot};flex-shrink:0"></div>
      <div style="flex:1;min-width:0">
        <div style="font-size:13px;font-weight:600;color:var(--label)">${label}</div>
        <div style="font-size:11px;color:var(--label3);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${summary}</div>
      </div>
      <div style="color:var(--label3);font-size:18px;line-height:1">›</div>
    </div>`;
  }
  const boatSumm = boatDays!==null?`${Math.max(0,boatDays)}d remaining${frozen>0?' · '+frozen+'d frozen':''}`:cur?.validUntil||'No transit log';
  const userSumm = userDays!==null?`${Math.max(0,userDays)}d · ${esc(cur?.holderName||'')}`:esc(cur?.holderName||'No data');
  const etSumm   = etFuture>0?`${etFuture} month${etFuture!==1?'s':''} remaining`:'No months covered';
  const schSumm  = !schMatch?'Not set up':isEU?'EU passport — no limit':seamanActive?'Seaman\'s Book entry':`${Math.max(0,schRem)}d remaining · ${schUsed}/90 used`;
  const quickLinks = `<div style="font-size:13px;font-weight:700;color:var(--label);margin-bottom:8px">Quick Links</div>
    <div class="card" style="margin-bottom:12px;overflow:hidden">
      ${qlRow(boatColor,'Transit Log — Boat',boatSumm,"ui.docSub='transitlog';showTab('documents')")}
      ${qlRow(userColor,'User',userSumm,"ui.docSub='transitlog';showTab('documents')")}
      ${qlRow(etColor,'eTEPAY',etSumm,"ui.docSub='customs';showTab('documents')")}
      ${qlRow(schColor,'Schengen',schSumm,"showTab('schengen')")}
    </div>`;

  return `<div style="padding-bottom:80px">
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px;flex-wrap:wrap;gap:8px">
      <div style="font-size:17px;font-weight:700">⚓ Clearance</div>
      <span style="background:${statusBg};border:0.5px solid ${statusBorder};color:${statusTxt};font-size:12px;font-weight:700;padding:3px 12px;border-radius:20px">${statusLabel}</span>
    </div>
    ${alertBar}${gaugeGrid}${quickLinks}
  </div>`;
}

function prefillCustomsOwnerData() {
  if (localStorage.getItem(EMAIL_KEY) !== OWNER_EMAIL) return false;
  if (!data.documents?.customs) return false;
  const src = (typeof OROBORO_DATA !== 'undefined') ? (OROBORO_DATA.documents?.customs || {}) : {};
  const C = data.documents.customs;
  let dirty = false;
  const f = (k, v) => { if (!C[k] && v) { C[k] = v; dirty = true; } };
  f('applicationNumber',  src.applicationNumber);
  f('applicationDate',    src.applicationDate);
  f('entryDate',          src.entryDate);
  f('year',               src.year);
  f('monthsCovered',      src.monthsCovered);
  f('amountPaid',         src.amountPaid);
  f('paymentCode',        src.paymentCode);
  f('adminFeeCode',       src.adminFeeCode);
  f('status',             src.status || 'New');
  f('ownerPassportNumber',src.ownerPassportNumber);
  f('ownerPhone',         src.ownerPhone);
  f('ownerAddress',       src.ownerAddress);
  return dirty;
}

function prefillTransitLog() {
  if (localStorage.getItem(EMAIL_KEY) !== OWNER_EMAIL) return false;
  const wd = getTLData();
  const log = wd.logs[wd.currentLog];
  if (!log || log.archived || log.docNumber) return false;
  const src = (typeof OROBORO_DATA !== 'undefined') ? (OROBORO_DATA.transitLog || {}) : {};
  let dirty = false;
  const f = (k,v) => { if (!log[k] && v) { log[k]=v; dirty=true; } };
  f('docNumber',        src.docNumber);        f('issueDate',     src.issueDate);
  f('validFrom',        src.validFrom);        f('validUntil',    src.validUntil);
  f('customsAuthority', src.customsAuthority); f('validityType',  'Limited (Ορισμένη)');
  f('prevDocCount',     '0');
  f('vesselName',       src.vesselName);       f('flag',          src.flag || 'US');
  f('portOfRegistry',   src.portOfRegistry);   f('regNumber',     src.regNumber);
  f('callSign',         src.callSign);         f('vesselType',    src.vesselType || 'Sail Yacht');
  f('gt',               src.gt);              f('engine',         src.engine);
  f('loa',              src.loa);             f('yearBuilt',      src.yearBuilt);
  f('yearFirstReg',     src.yearFirstReg);    f('ownerName',      src.ownerName);
  f('holderName',       src.holderName);      f('address',        src.address);
  f('telephone',        src.telephone || '0'); f('email',         OWNER_EMAIL);
  f('afm',              src.afm);             f('idNumber',       src.idNumber);
  if (!log.stamps.length && src.stamps?.length) {
    log.stamps = src.stamps.map(s => ({...s, id:uid()}));
    dirty = true;
  }
  return dirty;
}


const OROBORO_B1150_SYSTEMS = [
  {
    "cat": "House Bank",
    "category": "House Bank",
    "make": "Victron Energy",
    "model": "LiFePO4 Smart 12.8V/200Ah",
    "serialNumber": "BAT512120610",
    "location": "Starboard hull battery locker",
    "installDate": "2022-01",
    "notes": "House bank battery 1 of 4. All 4 batteries wired in parallel to Lynx Distributor 1000 DC. Equal-length cables mandatory. All negatives through BMV-712 shunt. Price: €2,140 list −20% = €1,712 net. Preventivo 374.",
    "manualUrl": "https://www.victronenergy.com/batteries/lithium-battery-12-8v",
    "purchasePriceUsd": 1934,
    "purchasePriceOriginal": "€1712.00 EUR",
    "invoiceRef": "374 · 17/09/2021",
    "supplier": "Negozio Equo Srl",
    "partCode": "BAT512120610",
    "photos": [],
    "lastService": "",
    "warrantyExpiry": ""
  },
  {
    "cat": "House Bank",
    "category": "House Bank",
    "make": "Victron Energy",
    "model": "LiFePO4 Smart 12.8V/200Ah",
    "serialNumber": "BAT512120610",
    "location": "Starboard hull battery locker",
    "installDate": "2022-01",
    "notes": "House bank battery 2 of 4. Price: €2,140 list −20% = €1,712 net. Preventivo 374.",
    "manualUrl": "https://www.victronenergy.com/batteries/lithium-battery-12-8v",
    "purchasePriceUsd": 1934,
    "purchasePriceOriginal": "€1712.00 EUR",
    "invoiceRef": "374 · 17/09/2021",
    "supplier": "Negozio Equo Srl",
    "partCode": "BAT512120610",
    "photos": [],
    "lastService": "",
    "warrantyExpiry": ""
  },
  {
    "cat": "House Bank",
    "category": "House Bank",
    "make": "Victron Energy",
    "model": "LiFePO4 Smart 12.8V/200Ah",
    "serialNumber": "BAT512120610",
    "location": "Starboard hull battery locker",
    "installDate": "2022-01",
    "notes": "House bank battery 3 of 4. Price: €2,140 list −20% = €1,712 net. Preventivo 374.",
    "manualUrl": "https://www.victronenergy.com/batteries/lithium-battery-12-8v",
    "purchasePriceUsd": 1934,
    "purchasePriceOriginal": "€1712.00 EUR",
    "invoiceRef": "374 · 17/09/2021",
    "supplier": "Negozio Equo Srl",
    "partCode": "BAT512120610",
    "photos": [],
    "lastService": "",
    "warrantyExpiry": ""
  },
  {
    "cat": "House Bank",
    "category": "House Bank",
    "make": "Victron Energy",
    "model": "LiFePO4 Smart 12.8V/200Ah",
    "location": "Starboard hull battery locker",
    "installDate": "2025-04",
    "notes": "House bank battery 4 of 4. Added Apr 2025. ~€1,180. Same model as batteries 1–3. Total bank: 800Ah / 10,240Wh nominal. Usable 640Ah at 80% DoD. Equal-length cable to Lynx Distributor mandatory.",
    "manualUrl": "https://www.victronenergy.com/batteries/lithium-battery-12-8v",
    "purchasePriceUsd": 1285,
    "purchasePriceOriginal": "€1180.00 EUR",
    "invoiceRef": "Negozio Equo Srl (est.)",
    "supplier": "Negozio Equo Srl",
    "photos": [],
    "lastService": "",
    "warrantyExpiry": ""
  },
  {
    "cat": "Distribution & Protection",
    "category": "Distribution & Protection",
    "make": "Victron Energy",
    "model": "Lynx Distributor 1000 DC",
    "location": "Starboard hull battery locker",
    "installDate": "2024",
    "notes": "Passive bus bar only — no BMS, no shunt. Replaced daisy chain when 4th battery added 2024. Mega fuses fitted. 1000A continuous. Photo verified.",
    "manualUrl": "https://www.victronenergy.com/battery-monitors/lynx-distributor",
    "photos": [],
    "lastService": "",
    "warrantyExpiry": ""
  },
  {
    "cat": "Distribution & Protection",
    "category": "Distribution & Protection",
    "make": "Victron Energy",
    "model": "VE.Bus BMS",
    "location": "Starboard hull",
    "installDate": "2022-01",
    "notes": "Manages all 4 LFP banks. Charge Disconnect → BatteryProtect + Orions + MPPTs. Load Disconnect → BatteryProtect load side. VE.Bus to MultiPlus. REMOVE BRIDGE on all BatteryProtect and Orion LOAD AND CHARGER terminals. Signal wires 0.75mm2 only. Price: €120 −15% = €102. Preventivo 374.",
    "manualUrl": "https://www.victronenergy.com/battery-monitors/ve-bus-bms",
    "purchasePriceUsd": 115,
    "purchasePriceOriginal": "€102.00 EUR",
    "invoiceRef": "374 · 17/09/2021",
    "supplier": "Negozio Equo Srl",
    "partCode": "BMS300200000",
    "photos": [],
    "lastService": "",
    "warrantyExpiry": ""
  },
  {
    "cat": "Distribution & Protection",
    "category": "Distribution & Protection",
    "make": "Victron Energy",
    "model": "VE.Bus BMS Mains Detector",
    "location": "Plugged into MultiPlus VE.Bus port",
    "installDate": "2022-01",
    "notes": "Photo confirmed plugged into MultiPlus. Signals BMS when shore power/mains AC present. Essential for correct BMS/MultiPlus coordination.",
    "photos": [],
    "lastService": "",
    "warrantyExpiry": ""
  },
  {
    "cat": "Distribution & Protection",
    "category": "Distribution & Protection",
    "make": "Victron Energy",
    "model": "BatteryProtect 220A",
    "location": "Starboard hull",
    "installDate": "2022-01",
    "notes": "Charge-side disconnect. Controlled by VE.Bus BMS charge disconnect signal. Blocks incoming charge from MPPTs and Orions on cell overvoltage or overtemperature. Bridge removed. Price: €119 −15% = €101.15. Preventivo 374.",
    "manualUrl": "https://www.victronenergy.com/battery-monitors/battery-protect",
    "purchasePriceUsd": 114,
    "purchasePriceOriginal": "€101.15 EUR",
    "invoiceRef": "374 · 17/09/2021",
    "supplier": "Negozio Equo Srl",
    "partCode": "BPR122022000",
    "photos": [],
    "lastService": "",
    "warrantyExpiry": ""
  },
  {
    "cat": "Distribution & Protection",
    "category": "Distribution & Protection",
    "make": "Victron Energy",
    "model": "BatteryProtect 220A",
    "location": "Starboard hull",
    "installDate": "2022-01",
    "notes": "Load-side disconnect. Controlled by VE.Bus BMS load disconnect signal. Disconnects all 12V DC consumers on cell undervoltage or overtemperature. Bridge removed. Price: €119 −15% = €101.15. Preventivo 374.",
    "manualUrl": "https://www.victronenergy.com/battery-monitors/battery-protect",
    "purchasePriceUsd": 114,
    "purchasePriceOriginal": "€101.15 EUR",
    "invoiceRef": "374 · 17/09/2021",
    "supplier": "Negozio Equo Srl",
    "partCode": "BPR122022000",
    "photos": [],
    "lastService": "",
    "warrantyExpiry": ""
  },
  {
    "cat": "Inverter / Charger",
    "category": "Inverter / Charger",
    "make": "Victron Energy",
    "model": "MultiPlus 12/3000/120-50-230V VE.Bus",
    "serialNumber": "HQ1734XK8QT",
    "location": "Starboard hull below deck",
    "installDate": "2018-10",
    "notes": "3000VA / 120A charger / 50A AC transfer / 230V. VE.Bus BMS Mains Detector connected. Communicates with VE.Bus BMS — reduces/stops charging on BMS alarm.",
    "manualUrl": "https://www.victronenergy.com/inverters-chargers/multiplus",
    "purchasePriceUsd": 1287,
    "purchasePriceOriginal": "R23676 ZAR",
    "invoiceRef": "PowerSol PWS06660",
    "photos": [],
    "lastService": "",
    "warrantyExpiry": ""
  },
  {
    "cat": "Inverter / Charger",
    "category": "Inverter / Charger",
    "make": "Victron Energy",
    "model": "Phoenix Inverter 12/375 230V VE.Direct",
    "serialNumber": "HQ1720QBU5U",
    "location": "Separately mounted below deck",
    "installDate": "2018-10",
    "notes": "Emergency backup inverter. 375VA 230V VE.Direct. Suitable for laptop, phones, router, small lights. NOT suitable for A/C or water heater.",
    "manualUrl": "https://www.victronenergy.com/inverters/phoenix-inverter-vedirect",
    "purchasePriceUsd": 102,
    "purchasePriceOriginal": "R1869 ZAR",
    "invoiceRef": "PowerSol PWS06660",
    "photos": [],
    "lastService": "",
    "warrantyExpiry": ""
  },
  {
    "cat": "Alternator Charging",
    "category": "Alternator Charging",
    "make": "Victron Energy",
    "model": "Orion-Tr Smart 12/12-30A Non-Isolated",
    "serialNumber": "HQ2312H4MYJ",
    "location": "Starboard engine room",
    "installDate": "2022-01",
    "notes": "NON-ISOLATED confirmed (ORI121236140). Input: Stbd alternator (125A). Output: 30A into LFP house bank via Lynx. 1 of 4 Orion units. Bridge removed on LOAD AND CHARGER terminal. Price: €224 −15% = €190.40. Preventivo 374.",
    "manualUrl": "https://www.victronenergy.com/dc-dc-converters/orion-tr-smart",
    "purchasePriceUsd": 215,
    "purchasePriceOriginal": "€190.40 EUR",
    "invoiceRef": "374 · 17/09/2021",
    "supplier": "Negozio Equo Srl",
    "partCode": "ORI121236140",
    "photos": [],
    "lastService": "",
    "warrantyExpiry": ""
  },
  {
    "cat": "Alternator Charging",
    "category": "Alternator Charging",
    "make": "Victron Energy",
    "model": "Orion-Tr Smart 12/12-30A Non-Isolated",
    "serialNumber": "HQ2313LMAJ",
    "location": "Starboard engine room",
    "installDate": "2022-01",
    "notes": "NON-ISOLATED confirmed (ORI121236140). Input: Stbd alternator (125A). 2 of 4 Orion units. Bridge removed. Price: €190.40 net. Preventivo 374.",
    "manualUrl": "https://www.victronenergy.com/dc-dc-converters/orion-tr-smart",
    "purchasePriceUsd": 215,
    "purchasePriceOriginal": "€190.40 EUR",
    "invoiceRef": "374 · 17/09/2021",
    "supplier": "Negozio Equo Srl",
    "partCode": "ORI121236140",
    "photos": [],
    "lastService": "",
    "warrantyExpiry": ""
  },
  {
    "cat": "Alternator Charging",
    "category": "Alternator Charging",
    "make": "Victron Energy",
    "model": "Orion-Tr Smart 12/12-30A Non-Isolated",
    "serialNumber": "HQ2251311MAN",
    "location": "Port engine room",
    "installDate": "2022-01",
    "notes": "NON-ISOLATED confirmed (ORI121236140). Input: Port alternator (125A). 3 of 4 Orion units. Bridge removed. Price: €190.40 net. Preventivo 374.",
    "manualUrl": "https://www.victronenergy.com/dc-dc-converters/orion-tr-smart",
    "purchasePriceUsd": 215,
    "purchasePriceOriginal": "€190.40 EUR",
    "invoiceRef": "374 · 17/09/2021",
    "supplier": "Negozio Equo Srl",
    "partCode": "ORI121236140",
    "photos": [],
    "lastService": "",
    "warrantyExpiry": ""
  },
  {
    "cat": "Alternator Charging",
    "category": "Alternator Charging",
    "make": "Victron Energy",
    "model": "Orion-Tr Smart 12/12-30A Non-Isolated",
    "serialNumber": "HQ2213FPQCH",
    "location": "Port engine room",
    "installDate": "2022-01",
    "notes": "NON-ISOLATED confirmed (ORI121236140). Input: Port alternator (125A). 4 of 4 Orion units. Bridge removed. Price: €190.40 net. Preventivo 374.",
    "manualUrl": "https://www.victronenergy.com/dc-dc-converters/orion-tr-smart",
    "purchasePriceUsd": 215,
    "purchasePriceOriginal": "€190.40 EUR",
    "invoiceRef": "374 · 17/09/2021",
    "supplier": "Negozio Equo Srl",
    "partCode": "ORI121236140",
    "photos": [],
    "lastService": "",
    "warrantyExpiry": ""
  },
  {
    "cat": "Monitoring",
    "category": "Monitoring",
    "make": "Victron Energy",
    "model": "Battery Monitor BMV-712 Smart Grey",
    "serialNumber": "HQ1740231B7",
    "location": "Main panel area",
    "installDate": "2018-10",
    "notes": "ALL system negatives must route through this shunt — any bypass makes SOC inaccurate. Connected to Cerbo GX via VE.Direct. Bluetooth for VictronConnect.",
    "manualUrl": "https://www.victronenergy.com/battery-monitors/bmv-712-smart",
    "purchasePriceUsd": 170,
    "purchasePriceOriginal": "R3134 ZAR",
    "invoiceRef": "PowerSol PWS06660",
    "photos": [],
    "lastService": "",
    "warrantyExpiry": ""
  },
  {
    "cat": "Monitoring",
    "category": "Monitoring",
    "make": "Victron Energy",
    "model": "Cerbo GX",
    "location": "Below deck nav station",
    "installDate": "2022-01",
    "notes": "Replaced Venus GX (S/N HQ17383DBWG) in Jan/Feb 2022. PN: BPP900450100. List €330 −15% = €280.50 + PayPal €10.17. Delivered Marina Cala del Sole, Licata AG Sicily. VE.Bus (MultiPlus), VE.Direct ×2 (BMV-712 + MPPT 150/85-Tr), VE.Direct/USB (MPPT 75/15 via adapter), Ethernet → VRM. No GX Touch — display via RPi + LCD (Accessory switch).",
    "manualUrl": "https://www.victronenergy.com/communication-centre/cerbo-gx",
    "purchasePriceUsd": 315,
    "purchasePriceOriginal": "€280.50 EUR",
    "invoiceRef": "90/M · 02/02/2022",
    "supplier": "Negozio Equo Srl",
    "partCode": "BPP900450100",
    "photos": [],
    "lastService": "",
    "warrantyExpiry": ""
  },
  {
    "cat": "Future Projects",
    "category": "Future Projects",
    "make": "Victron Energy",
    "model": "Orion-Tr Smart 12/12-9A Isolated (recommended)",
    "location": "Port engine room",
    "notes": "Status: Planned. NOT YET INSTALLED. Maintains port AGM start battery (engine E14872) from LFP house bank. Prevents flat start battery after long layup. Wire enable pin to BMS load disconnect. Check start battery voltage after 2+ weeks away — target >12.6V.",
    "purchasePriceUsd": 130,
    "photos": [],
    "lastService": "",
    "warrantyExpiry": ""
  },
  {
    "cat": "Future Projects",
    "category": "Future Projects",
    "make": "Victron Energy",
    "model": "Orion-Tr Smart 12/12-9A Isolated (recommended)",
    "location": "Starboard engine room",
    "notes": "Status: Planned. NOT YET INSTALLED. Maintains stbd AGM start battery (engine E14877) from LFP house bank.",
    "purchasePriceUsd": 130,
    "photos": [],
    "lastService": "",
    "warrantyExpiry": ""
  },
  {
    "cat": "Main Engines",
    "category": "Main Engines",
    "make": "Yanmar",
    "model": "3YM30AE",
    "serialNumber": "E14872",
    "location": "Port engine room",
    "installDate": "2018-08",
    "notes": "30HP diesel. Sail drive SD25 S/N O71617. Fuel tank S/N 1805020069. Commissioned 13 Sep 2018 Seascape Marine Services, 0.9hrs delivery. Alternator 125A → 2x Orion 30A (HQ2251311MAN + HQ2213FPQCH). Racor filter fitted.",
    "manualUrl": "https://www.yanmar.com/marine/",
    "photos": [],
    "lastService": "",
    "warrantyExpiry": ""
  },
  {
    "cat": "Main Engines",
    "category": "Main Engines",
    "make": "Yanmar",
    "model": "3YM30AE",
    "serialNumber": "E14877",
    "location": "Starboard engine room",
    "installDate": "2018-08",
    "notes": "30HP diesel. Sail drive SD25 S/N O89717. Fuel tank S/N 8050402 71. Commissioned 13 Sep 2018, 0.9hrs delivery. Alternator 125A → 2x Orion 30A (HQ2312H4MYJ + HQ2313LMAJ). Racor filter fitted.",
    "manualUrl": "https://www.yanmar.com/marine/",
    "photos": [],
    "lastService": "",
    "warrantyExpiry": ""
  },
  {
    "cat": "Start Batteries",
    "category": "Start Batteries",
    "make": "Unknown",
    "model": "AGM 12V/90Ah",
    "location": "Port engine room",
    "installDate": "2018",
    "notes": "Status: Active — no trickle charger fitted. Port engine E14872 starter. Charged by alternator when engine running only. No trickle charger — future project. Check voltage after 2+ weeks: must be >12.6V for cold start.",
    "photos": [],
    "lastService": "",
    "warrantyExpiry": ""
  },
  {
    "cat": "Start Batteries",
    "category": "Start Batteries",
    "make": "Unknown",
    "model": "AGM 12V/90Ah",
    "location": "Starboard engine room",
    "installDate": "2018",
    "notes": "Status: Active — no trickle charger fitted. Stbd engine E14877 starter. Charged by alternator when engine running only. No trickle charger — future project.",
    "photos": [],
    "lastService": "",
    "warrantyExpiry": ""
  },
  {
    "cat": "Fuel System",
    "category": "Fuel System",
    "make": "Robertson & Caine",
    "model": "Built-in tank",
    "serialNumber": "1805020069",
    "location": "Port hull",
    "installDate": "2018-08",
    "photos": [],
    "lastService": "",
    "warrantyExpiry": ""
  },
  {
    "cat": "Fuel System",
    "category": "Fuel System",
    "make": "Robertson & Caine",
    "model": "Built-in tank",
    "serialNumber": "8050402 71",
    "location": "Starboard hull",
    "installDate": "2018-08",
    "photos": [],
    "lastService": "",
    "warrantyExpiry": ""
  },
  {
    "cat": "Fuel System",
    "category": "Fuel System",
    "make": "Parker Racor",
    "model": "Marine fuel filter",
    "location": "One per engine room",
    "installDate": "2018-08",
    "notes": "One fitted to each engine. Check/replace filter element per Yanmar service schedule.",
    "photos": [],
    "lastService": "",
    "warrantyExpiry": ""
  },
  {
    "cat": "Deck Equipment",
    "category": "Deck Equipment",
    "make": "Lewmar",
    "model": "Electric windlass",
    "location": "Bow",
    "installDate": "2018-08",
    "notes": "100A circuit × 2 (control box). Dedicated terminal on B1150 terminal strip.",
    "photos": [],
    "lastService": "",
    "warrantyExpiry": ""
  },
  {
    "cat": "Deck Equipment",
    "category": "Deck Equipment",
    "make": "Lewmar",
    "model": "Electric winch",
    "location": "Cockpit",
    "installDate": "2018-08",
    "photos": [],
    "lastService": "",
    "warrantyExpiry": ""
  },
  {
    "cat": "Deck Equipment",
    "category": "Deck Equipment",
    "make": "Warn",
    "model": "Winch",
    "location": "Deck",
    "installDate": "2018-08",
    "photos": [],
    "lastService": "",
    "warrantyExpiry": ""
  },
  {
    "cat": "Deck Equipment",
    "category": "Deck Equipment",
    "make": "Unknown",
    "model": "Davit winch",
    "location": "Stern davits",
    "installDate": "2018-08",
    "notes": "50A C/breaker, solenoid control, up/down switch, control relay, limit sensor. Circuit documented in schematic pg 169.",
    "photos": [],
    "lastService": "",
    "warrantyExpiry": ""
  },
  {
    "cat": "Fresh Water",
    "category": "Fresh Water",
    "make": "Unknown",
    "model": "Watermaker",
    "location": "Below deck",
    "installDate": "2018-08",
    "notes": "30A direct from service bus. Listed in B1150 terminal strip.",
    "photos": [],
    "lastService": "",
    "warrantyExpiry": ""
  },
  {
    "cat": "Fresh Water",
    "category": "Fresh Water",
    "make": "Sigmar Marine",
    "model": "Compact Water Heater 17851, 22L",
    "location": "Port hull",
    "installDate": "2024",
    "notes": "Replaced Kuuma water heater S/N 71015671543 in 2024. 22L. Dual element: 220V AC + engine cooling coil. Engine coil heats water in 30-45 min motoring — no electrical draw.",
    "photos": [],
    "lastService": "",
    "warrantyExpiry": ""
  },
  {
    "cat": "Fresh Water",
    "category": "Fresh Water",
    "make": "Sigmar Marine",
    "model": "Compact Water Heater 17851, 22L",
    "location": "Starboard hull",
    "installDate": "2024",
    "notes": "Replaced Kuuma water heater S/N 71015671544 in 2024. 22L.",
    "photos": [],
    "lastService": "",
    "warrantyExpiry": ""
  },
  {
    "cat": "Bilge",
    "category": "Bilge",
    "make": "Rulemate / Plastimo",
    "model": "Automatic electric bilge pump",
    "location": "FWD Port/Stbd + AFT Port/Stbd",
    "installDate": "2018-08",
    "notes": "4 pumps: Port FWD, Stbd FWD, Port AFT, Stbd AFT. 10A each. Via GA1 relays (RELAY 1-4 on B1150 terminal strip). Float switches + override CBR 21-24. Alarm panel P14/P16.",
    "photos": [],
    "lastService": "",
    "warrantyExpiry": ""
  },
  {
    "cat": "Bilge",
    "category": "Bilge",
    "make": "Whale",
    "model": "Manual bilge pump",
    "location": "Cockpit",
    "installDate": "2018-08",
    "photos": [],
    "lastService": "",
    "warrantyExpiry": ""
  },
  {
    "cat": "Sanitation",
    "category": "Sanitation",
    "make": "Jabsco",
    "model": "Electric macerator toilet",
    "location": "Port hull head",
    "installDate": "2018-08",
    "notes": "10-15A startup current. Dedicated circuit on B1150 terminal strip (post-launch addition).",
    "photos": [],
    "lastService": "",
    "warrantyExpiry": ""
  },
  {
    "cat": "Sanitation",
    "category": "Sanitation",
    "make": "Jabsco",
    "model": "Electric macerator toilet",
    "location": "Starboard hull head",
    "installDate": "2018-08",
    "notes": "10-15A startup current. Dedicated circuit on B1150 terminal strip.",
    "photos": [],
    "lastService": "",
    "warrantyExpiry": ""
  },
  {
    "cat": "Sanitation",
    "category": "Sanitation",
    "make": "Robertson & Caine",
    "model": "GRP waste tank",
    "serialNumber": "120710",
    "location": "Port hull",
    "installDate": "2018-08",
    "photos": [],
    "lastService": "",
    "warrantyExpiry": ""
  },
  {
    "cat": "Sanitation",
    "category": "Sanitation",
    "make": "Robertson & Caine",
    "model": "GRP waste tank",
    "serialNumber": "120719",
    "location": "Starboard hull",
    "installDate": "2018-08",
    "photos": [],
    "lastService": "",
    "warrantyExpiry": ""
  },
  {
    "cat": "Fuel Transfer",
    "category": "Fuel Transfer",
    "make": "Unknown",
    "model": "Electric fuel transfer pump",
    "location": "Below deck",
    "installDate": "2018+",
    "notes": "Upgraded post-launch from direct wiring to relay-controlled. Dedicated terminal on B1150 terminal strip.",
    "photos": [],
    "lastService": "",
    "warrantyExpiry": ""
  },
  {
    "cat": "Fuel Transfer",
    "category": "Fuel Transfer",
    "make": "Unknown",
    "model": "Fuel solenoid valve",
    "location": "Below deck",
    "installDate": "2018+",
    "notes": "Automatic fuel shutoff relay. Post-launch addition on B1150 terminal strip.",
    "photos": [],
    "lastService": "",
    "warrantyExpiry": ""
  },
  {
    "cat": "Rigid Panels — Stern Arch",
    "category": "Rigid Panels — Stern Arch",
    "make": "SunPower",
    "model": "E20 327W (SPR-E20-327-AR)",
    "serialNumber": "SPR-E20-327-AR × 3",
    "location": "Stern arch / davits",
    "installDate": "2018-10",
    "notes": "3 panels wired in parallel. Voc 65V / Vmp 54.7V / Imp 5.98A per panel. Total: 981W / 17.9A combined. 20%+ efficiency. SunPower Maxeon back-contact cells. → MPPT 150/85-Tr HQ1810WHKIG.",
    "purchasePriceUsd": 1195,
    "purchasePriceOriginal": "R21975 ZAR",
    "invoiceRef": "PowerSol PWS06660",
    "photos": [],
    "lastService": "",
    "warrantyExpiry": ""
  },
  {
    "cat": "Flexible Panels — Cabin Roof",
    "category": "Flexible Panels — Cabin Roof",
    "make": "SUNBEAMsystem",
    "model": "Tough 111",
    "serialNumber": "1520540611100063",
    "location": "Cabin roof — flush mounted",
    "installDate": "2024-2025",
    "notes": "Paired with Panel 2 in parallel → MPPT 75/15 HQ21320J2KCQ. Replaced original 100W (SBM-T100JB Oct 2018). SunPower Maxeon 22.5%+ efficiency. Walkable ETFE. Warranty registered. Replaced under warranty 2024-2025. Original: SBM-T100JB Tough 100W (PowerSol PWS06660).",
    "purchasePriceUsd": 441,
    "purchasePriceOriginal": "R8,126 ZAR (original SBM-T100JB, PowerSol PWS06660)",
    "invoiceRef": "PowerSol PWS06660",
    "photos": [],
    "lastService": "",
    "warrantyExpiry": ""
  },
  {
    "cat": "Flexible Panels — Cabin Roof",
    "category": "Flexible Panels — Cabin Roof",
    "make": "SUNBEAMsystem",
    "model": "Tough 111",
    "serialNumber": "1520540611100067",
    "location": "Cabin roof — flush mounted",
    "installDate": "2024-2025",
    "notes": "Paired with Panel 1 in parallel → MPPT 75/15 HQ21320J2KCQ. Warranty registered. Replaced under warranty 2024-2025. Original: SBM-T100JB Tough 100W (PowerSol PWS06660).",
    "purchasePriceUsd": 441,
    "purchasePriceOriginal": "R8,126 ZAR (original SBM-T100JB, PowerSol PWS06660)",
    "invoiceRef": "PowerSol PWS06660",
    "photos": [],
    "lastService": "",
    "warrantyExpiry": ""
  },
  {
    "cat": "Flexible Panels — Cabin Roof",
    "category": "Flexible Panels — Cabin Roof",
    "make": "SUNBEAMsystem",
    "model": "Tough 111",
    "serialNumber": "1520540611100044",
    "location": "Cabin roof — flush mounted",
    "installDate": "2024-2025",
    "notes": "Paired with Panel 4 in parallel → MPPT 75/15 HQ21120G2CF. Warranty registered. Replaced under warranty 2024-2025. Original: SBM-T100JB Tough 100W (PowerSol PWS06660).",
    "purchasePriceUsd": 441,
    "purchasePriceOriginal": "R8,126 ZAR (original SBM-T100JB, PowerSol PWS06660)",
    "invoiceRef": "PowerSol PWS06660",
    "photos": [],
    "lastService": "",
    "warrantyExpiry": ""
  },
  {
    "cat": "Flexible Panels — Cabin Roof",
    "category": "Flexible Panels — Cabin Roof",
    "make": "SUNBEAMsystem",
    "model": "Tough 111",
    "serialNumber": "1520540611100043",
    "location": "Cabin roof — flush mounted",
    "installDate": "2024-2025",
    "notes": "Paired with Panel 3 in parallel → MPPT 75/15 HQ21120G2CF. Warranty registered. Replaced under warranty 2024-2025. Original: SBM-T100JB Tough 100W (PowerSol PWS06660).",
    "purchasePriceUsd": 441,
    "purchasePriceOriginal": "R8,126 ZAR (original SBM-T100JB, PowerSol PWS06660)",
    "invoiceRef": "PowerSol PWS06660",
    "photos": [],
    "lastService": "",
    "warrantyExpiry": ""
  },
  {
    "cat": "Charge Controllers",
    "category": "Charge Controllers",
    "make": "Victron Energy",
    "model": "SmartSolar MPPT 150/85-Tr",
    "serialNumber": "HQ1810WHKIG",
    "location": "Below deck",
    "installDate": "2018-10",
    "notes": "Zone 1: 3x SunPower E20 327W rigid parallel. Vmp 54.7V / 17.9A / 981W peak. VE.Direct → Cerbo GX. BMS charge disconnect disables on alarm.",
    "manualUrl": "https://www.victronenergy.com/solar-charge-controllers/smartsolar-mppt-150-85",
    "purchasePriceUsd": 603,
    "purchasePriceOriginal": "R11088 ZAR",
    "invoiceRef": "PowerSol PWS06660",
    "photos": [],
    "lastService": "",
    "warrantyExpiry": ""
  },
  {
    "cat": "Charge Controllers",
    "category": "Charge Controllers",
    "make": "Victron Energy",
    "model": "SmartSolar MPPT 75/15",
    "serialNumber": "HQ21320J2KCQ",
    "location": "Below deck",
    "installDate": "2022-01",
    "notes": "Zone 2: Sunbeam Tough 111W panels 1+2 parallel. 18V / 12.4A / 222W peak. VE.Direct → Cerbo GX. 1 of 2 MPPT 75/15 units. Price: €120 −15% = €102. 10% VAT (solar equip). Preventivo 374.",
    "manualUrl": "https://www.victronenergy.com/solar-charge-controllers/smartsolar-mppt-75-15",
    "purchasePriceUsd": 115,
    "purchasePriceOriginal": "€102.00 EUR",
    "invoiceRef": "374 · 17/09/2021",
    "supplier": "Negozio Equo Srl",
    "partCode": "SCC075015060",
    "photos": [],
    "lastService": "",
    "warrantyExpiry": ""
  },
  {
    "cat": "Charge Controllers",
    "category": "Charge Controllers",
    "make": "Victron Energy",
    "model": "SmartSolar MPPT 75/15",
    "serialNumber": "HQ21120G2CF",
    "location": "Below deck",
    "installDate": "2022-01",
    "notes": "Zone 3: Sunbeam Tough 111W panels 3+4 parallel. 18V / 12.4A / 222W peak. VE.Direct/USB adapter → Cerbo GX. 2 of 2 MPPT 75/15 units. Price: €120 −15% = €102. Preventivo 374.",
    "manualUrl": "https://www.victronenergy.com/solar-charge-controllers/smartsolar-mppt-75-15",
    "purchasePriceUsd": 115,
    "purchasePriceOriginal": "€102.00 EUR",
    "invoiceRef": "374 · 17/09/2021",
    "supplier": "Negozio Equo Srl",
    "partCode": "SCC075015060",
    "photos": [],
    "lastService": "",
    "warrantyExpiry": ""
  },
  {
    "cat": "Chartplotter & Displays",
    "category": "Chartplotter & Displays",
    "make": "Raymarine",
    "model": "Axiom 12",
    "serialNumber": "E70368-0790167",
    "location": "Helm station",
    "installDate": "2018-08",
    "notes": "Main chartplotter. SeaTalkng master. Quantum 2 radar via WiFi (not SeaTalkng). Signal K RPi bridges Victron data onto this display.",
    "manualUrl": "https://www.raymarine.com/axiom/",
    "photos": [],
    "lastService": "",
    "warrantyExpiry": ""
  },
  {
    "cat": "Chartplotter & Displays",
    "category": "Chartplotter & Displays",
    "make": "Raymarine",
    "model": "i70s Multifunction Display",
    "serialNumber": "E70327-0280271",
    "location": "Helm station",
    "installDate": "2018-08",
    "manualUrl": "https://www.raymarine.com/i70s/",
    "photos": [],
    "lastService": "",
    "warrantyExpiry": ""
  },
  {
    "cat": "Chartplotter & Displays",
    "category": "Chartplotter & Displays",
    "make": "Raymarine",
    "model": "i70s Multifunction Display",
    "serialNumber": "E70327-0380157",
    "location": "Helm station",
    "installDate": "2018-08",
    "manualUrl": "https://www.raymarine.com/i70s/",
    "photos": [],
    "lastService": "",
    "warrantyExpiry": ""
  },
  {
    "cat": "Radar",
    "category": "Radar",
    "make": "Raymarine",
    "model": "Quantum 2 Doppler",
    "serialNumber": "E70498-0480091",
    "location": "Mast / arch (TBC)",
    "installDate": "2018-08",
    "notes": "WiFi connection — does NOT appear on SeaTalkng. WiFi passcode: 0e50e055. To reconnect: power on radar circuit (B1150 terminal), wait 60s, Axiom 12: Home → Radar → Connect. 17W transmitting. Doppler colour-codes approaching/receding targets.",
    "manualUrl": "https://www.raymarine.com/quantum/",
    "photos": [],
    "lastService": "",
    "warrantyExpiry": ""
  },
  {
    "cat": "AIS & GPS",
    "category": "AIS & GPS",
    "make": "Raymarine",
    "model": "AIS700 Class B Transceiver + Splitter",
    "serialNumber": "E70476-0680424",
    "location": "Below deck",
    "installDate": "2018-10",
    "notes": "Class B transmits every 30s underway. Targets visible on Axiom 12 via SeaTalkng.",
    "manualUrl": "https://www.raymarine.com/ais700/",
    "purchasePriceUsd": 1059,
    "purchasePriceOriginal": "R19490 ZAR",
    "invoiceRef": "PowerSol PWS06660",
    "photos": [],
    "lastService": "",
    "warrantyExpiry": ""
  },
  {
    "cat": "AIS & GPS",
    "category": "AIS & GPS",
    "make": "Raymarine",
    "model": "RS-150 GPS Receiver",
    "serialNumber": "E70310-0780285",
    "location": "External antenna mount",
    "installDate": "2018-08",
    "manualUrl": "https://www.raymarine.com/gps/",
    "photos": [],
    "lastService": "",
    "warrantyExpiry": ""
  },
  {
    "cat": "Autopilot",
    "category": "Autopilot",
    "make": "Raymarine",
    "model": "EV-1 Course Computer",
    "serialNumber": "E70096-0480757",
    "location": "Below deck near steering",
    "installDate": "2018-08",
    "notes": "9-axis sensor autopilot brain. Works with ACU-400 and Rotary Drive T2.",
    "manualUrl": "https://www.raymarine.com/evolution-autopilot/",
    "photos": [],
    "lastService": "",
    "warrantyExpiry": ""
  },
  {
    "cat": "Autopilot",
    "category": "Autopilot",
    "make": "Raymarine",
    "model": "ACU-400 Actuator Control Unit",
    "serialNumber": "E70100-0280329",
    "location": "Below deck",
    "installDate": "2018-08",
    "manualUrl": "https://www.raymarine.com/evolution-autopilot/",
    "photos": [],
    "lastService": "",
    "warrantyExpiry": ""
  },
  {
    "cat": "Autopilot",
    "category": "Autopilot",
    "make": "Raymarine",
    "model": "Rotary Drive Type 2 (T2)",
    "serialNumber": "M81136-0482016",
    "location": "Steering system",
    "installDate": "2018-08",
    "notes": "Physical mechanical autopilot actuator — belt-driven. Controlled by ACU-400.",
    "photos": [],
    "lastService": "",
    "warrantyExpiry": ""
  },
  {
    "cat": "Autopilot",
    "category": "Autopilot",
    "make": "Raymarine",
    "model": "p70s Autopilot Control Head",
    "serialNumber": "E70328-0580853",
    "location": "Helm station",
    "installDate": "2018-08",
    "manualUrl": "https://www.raymarine.com/autopilot-control-heads/",
    "photos": [],
    "lastService": "",
    "warrantyExpiry": ""
  },
  {
    "cat": "Sensors & Network",
    "category": "Sensors & Network",
    "make": "Raymarine",
    "model": "iTC5 Transducer Converter",
    "serialNumber": "E70010-0381039",
    "location": "Below deck",
    "installDate": "2018-08",
    "notes": "Bridges analog transducers to SeaTalkng: depth Airmar 4037193, speed Airmar 4019122, wind sensor 0760516.",
    "manualUrl": "https://www.raymarine.com/itc5/",
    "photos": [],
    "lastService": "",
    "warrantyExpiry": ""
  },
  {
    "cat": "Sensors & Network",
    "category": "Sensors & Network",
    "make": "Raymarine",
    "model": "Wind Sensor STD",
    "serialNumber": "0760516",
    "location": "Mast top",
    "installDate": "2018-08",
    "notes": "Apparent wind. Via iTC5 to SeaTalkng. Used by autopilot wind mode and Axiom 12 / i70s.",
    "photos": [],
    "lastService": "",
    "warrantyExpiry": ""
  },
  {
    "cat": "Sensors & Network",
    "category": "Sensors & Network",
    "make": "Airmar",
    "model": "Depth transducer",
    "serialNumber": "4037193",
    "location": "Hull through-hull",
    "installDate": "2018-08",
    "notes": "Connects to iTC5.",
    "photos": [],
    "lastService": "",
    "warrantyExpiry": ""
  },
  {
    "cat": "Sensors & Network",
    "category": "Sensors & Network",
    "make": "Airmar",
    "model": "Speed transducer",
    "serialNumber": "4019122",
    "location": "Hull through-hull",
    "installDate": "2018-08",
    "notes": "Connects to iTC5.",
    "photos": [],
    "lastService": "",
    "warrantyExpiry": ""
  },
  {
    "cat": "Sensors & Network",
    "category": "Sensors & Network",
    "make": "Raymarine",
    "model": "Ray 60",
    "serialNumber": "A80289-1170884",
    "location": "Helm station",
    "installDate": "2018-08",
    "notes": "2nd handset: Ray Mic 60/70 S/N M81136-0180054.",
    "photos": [],
    "lastService": "",
    "warrantyExpiry": ""
  },
  {
    "cat": "Sensors & Network",
    "category": "Sensors & Network",
    "make": "Raymarine",
    "model": "HSS SeaTalk HS Network Switch",
    "serialNumber": "A80007-0370378",
    "location": "Below deck",
    "installDate": "2018-08",
    "photos": [],
    "lastService": "",
    "warrantyExpiry": ""
  },
  {
    "cat": "Sensors & Network",
    "category": "Sensors & Network",
    "make": "Raymarine",
    "model": "N2K Remote Rev C",
    "serialNumber": "2077128",
    "location": "Cockpit / helm",
    "installDate": "2018-08",
    "notes": "Wireless NMEA 2000 MFD remote keypad.",
    "photos": [],
    "lastService": "",
    "warrantyExpiry": ""
  },
  {
    "cat": "Sensors & Network",
    "category": "Sensors & Network",
    "make": "Plastimo",
    "model": "Horizon 130",
    "location": "Helm station",
    "installDate": "2018-08",
    "notes": "Magnetic compass — Zone A corrected.",
    "photos": [],
    "lastService": "",
    "warrantyExpiry": ""
  },
  {
    "cat": "Air Conditioning",
    "category": "Air Conditioning",
    "make": "Cruisair (Dometic)",
    "model": "~16,000 BTU self-contained (exact model TBC)",
    "location": "Port hull",
    "installDate": "2018-08",
    "notes": "Seawater-cooled. ~1,400-1,600W at 220V AC = ~115-130A from 12V LFP bank via MultiPlus. Confirm model from nameplate (likely SMX16 or STQ16). Raw water cooling circuit with flow indicator and vibration isolators.",
    "photos": [],
    "lastService": "",
    "warrantyExpiry": ""
  },
  {
    "cat": "Air Conditioning",
    "category": "Air Conditioning",
    "make": "Cruisair (Dometic)",
    "model": "~16,000 BTU self-contained (exact model TBC)",
    "location": "Starboard hull",
    "installDate": "2018-08",
    "notes": "Seawater-cooled. Both units running simultaneously at anchor draws ~230-260A from 12V bank via MultiPlus. 1,425W solar partially offsets this in good sun.",
    "photos": [],
    "lastService": "",
    "warrantyExpiry": ""
  },
  {
    "cat": "Galley & Domestic",
    "category": "Galley & Domestic",
    "make": "Vitrifrigo",
    "model": "Unknown",
    "serialNumber": "18221693",
    "location": "Galley",
    "installDate": "2018-08",
    "photos": [],
    "lastService": "",
    "warrantyExpiry": ""
  },
  {
    "cat": "Galley & Domestic",
    "category": "Galley & Domestic",
    "make": "LG",
    "model": "Unknown",
    "serialNumber": "712PNRT2D046",
    "location": "Hull TBC — port or starboard",
    "installDate": "2018-08",
    "notes": "Location (port or starboard hull) not confirmed.",
    "photos": [],
    "lastService": "",
    "warrantyExpiry": ""
  },
  {
    "cat": "Galley & Domestic",
    "category": "Galley & Domestic",
    "make": "ENO",
    "model": "Gas cooker",
    "location": "Galley",
    "installDate": "2018-08",
    "photos": [],
    "lastService": "",
    "warrantyExpiry": ""
  },
  {
    "cat": "Safety",
    "category": "Safety",
    "make": "Unknown",
    "model": "Marine smoke detector",
    "location": "Multiple throughout vessel",
    "installDate": "2018-08",
    "photos": [],
    "lastService": "",
    "warrantyExpiry": ""
  },
  {
    "cat": "Data & Monitoring",
    "category": "Data & Monitoring",
    "make": "Raspberry Pi Foundation",
    "model": "Raspberry Pi + Marine CAN HAT (model TBC)",
    "location": "Main panel — Accessory switch",
    "installDate": "2024",
    "notes": "Signal K server. CAN HAT on GPIO pins connects to SeaTalkng/NMEA 2000. Appears as 'canbusjs Signal K 000001' on Raymarine network. Bridges Victron data (Cerbo GX via MQTT) onto NMEA 2000. LCD screen shows unified dashboard. Switched by Accessory circuit breaker.",
    "photos": [],
    "lastService": "",
    "warrantyExpiry": ""
  },
  {
    "cat": "Data & Monitoring",
    "category": "Data & Monitoring",
    "make": "Uniross",
    "model": "UPS backup",
    "location": "Below deck",
    "installDate": "2022-01",
    "notes": "Keeps Cerbo GX powered during BMS load disconnect event.",
    "photos": [],
    "lastService": "",
    "warrantyExpiry": ""
  },
  {
    "cat": "Entertainment",
    "category": "Entertainment",
    "make": "Fusion",
    "model": "Amp/System",
    "serialNumber": "39676296669",
    "location": "Saloon / helm",
    "installDate": "2018-08",
    "notes": "Multiple speakers throughout. Helm Remote + FWD Remote. Connected to Axiom 12 via SeaTalkng.",
    "photos": [],
    "lastService": "",
    "warrantyExpiry": ""
  },
  {
    "cat": "Other",
    "category": "Other",
    "make": "Cruisair (Dometic)",
    "model": "STQ12CK-410A",
    "serialNumber": "33498976",
    "location": "Starboard hull",
    "installDate": "2018",
    "notes": "Cruisair (Dometic) STQ12CK-410A, 12,000 BTU, 220-240V/50Hz 1-phase, R410A refrigerant (11.5oz/326g). Features: Stowaway Turbo, Q-Logic Control, High Velocity Blower. Factory test passed 08/28/2013 (manufacture date, not install date — installed on Oroboro 2018).",
    "purchasePriceUsd": 0,
    "purchasePriceOriginal": "",
    "supplier": "",
    "invoiceRef": "",
    "partCode": "",
    "photos": [],
    "lastService": "",
    "warrantyExpiry": ""
  },
];

function migrateData() {
  let dirty = false;
  try { (data.spareParts || []).forEach(p => { const n = normCat(p.category); if (n !== p.category) { p.category = n; dirty = true; } }); } catch(e) { console.warn('migrate spareParts', e); }
  try { if (migrateToSingleLog()) dirty = true; } catch(e) { console.warn('migrateToSingleLog', e); }
  try { (data.maintenance?.log||[]).forEach(e => { const n=normalizeMaintTask(e.task); if(n!==e.task){e.task=n;dirty=true;} }); } catch(e) { console.warn('migrateMaintTasks',e); }
  // Remap removed coastal event types → Notable event
  try {
    const removed = new Set(['Waypoint passed','Port entry','Port exit']);
    (data.coastalLog || []).forEach(e => {
      if (removed.has(e.eventType)) { e.eventType = 'Notable event'; dirty = true; }
    });
  } catch(e) { console.warn('migrateCoastalEvents', e); }
  // Seed belt history — owner only
  if (localStorage.getItem(EMAIL_KEY) === OWNER_EMAIL) {
    if (!data.maintenance) data.maintenance = { engines:{}, sched:{}, log:[] };
    if (!data.maintenance.log) data.maintenance.log = [];
    const hasBeltEntry = data.maintenance.log.some(e => e.id === 'seed_belt_920');
    if (!hasBeltEntry) {
      data.maintenance.log.push(
        { id:'seed_belt_920',     date:'2021-07-01', hours:'920', task:'Inspect & adjust belt tension', cost:'', notes:'Mallorca', engines:['port','starboard'] },
        { id:'seed_belt_rep_920', date:'2021-07-01', hours:'920', task:'Replace belts',                 cost:'', notes:'Mallorca', engines:['port','starboard'] }
      );
      data.maintenance.log.sort((a,b) => b.date.localeCompare(a.date) || (parseFloat(b.hours)||0)-(parseFloat(a.hours)||0));
      dirty = true;
    }
  }
  // One-time maintenance log corrections — v2 (owner only)
  try {
    if (localStorage.getItem(EMAIL_KEY) === OWNER_EMAIL && !data._maintLogFixed_v2) {
      if (!data.maintenance) data.maintenance = { engines:{}, sched:{}, log:[] };
      if (!data.maintenance.log) data.maintenance.log = [];
      const log = data.maintenance.log;

      // DELETE: 2025-05-11, 1500h, Oil filter change, Inoussos — incorrect entry
      const delIdx = log.findIndex(e => e.date==='2025-05-11' && String(e.hours)==='1500' && e.task==='Oil filter change' && e.notes==='Inoussos');
      if (delIdx !== -1) { log.splice(delIdx, 1); dirty = true; }

      // ADD: 9 missing Oil filter change entries matching their engine oil change
      const missingOilFilters = [
        { id:'seed_olf_20181219', date:'2018-12-19', hours:'50',   notes:'Cape Town' },
        { id:'seed_olf_20190323', date:'2019-03-23', hours:'200',  notes:'' },
        { id:'seed_olf_20190502', date:'2019-05-02', hours:'250',  notes:'' },
        { id:'seed_olf_20190807', date:'2019-08-07', hours:'350',  notes:'' },
        { id:'seed_olf_20191109', date:'2019-11-09', hours:'450',  notes:'Grenada' },
        { id:'seed_olf_20200627', date:'2020-06-27', hours:'575',  notes:'S. Vicente' },
        { id:'seed_olf_20210310', date:'2021-03-10', hours:'740',  notes:'Bahamas' },
        { id:'seed_olf_20211205', date:'2021-12-05', hours:'1060', notes:'Licata' },
        { id:'seed_olf_20221004', date:'2022-10-04', hours:'1243', notes:'Didim' },
      ];
      for (const s of missingOilFilters) {
        if (!log.some(e => e.id === s.id)) {
          log.push({ id:s.id, date:s.date, hours:s.hours, task:'Oil filter change', cost:'', notes:s.notes, engines:['port','starboard'] });
          dirty = true;
        }
      }

      // FIX: clear "F. Pugliano" incorrectly entered as location
      const pugianoFixes = [
        { date:'2019-03-23', hours:'200', task:'Engine oil change' },
        { date:'2019-03-24', hours:'200', task:'Gear oil change' },
        { date:'2019-05-02', hours:'250', task:'Engine oil change' },
        { date:'2019-05-02', hours:'250', task:'Gear oil change' },
        { date:'2019-08-07', hours:'350', task:'Engine oil change' },
        { date:'2019-08-01', hours:'350', task:'Gear oil change' },
        { date:'2019-07-28', hours:'320', task:'Impeller replacement' },
        { date:'2019-06-08', hours:'300', task:'Diesel fuel filter change' },
        { date:'2019-02-22', hours:'150', task:'Gear oil change' },
        { date:'2018-12-19', hours:'50',  task:'Gear oil change' },
      ];
      for (const s of pugianoFixes) {
        const e = log.find(e => e.date===s.date && String(e.hours)===s.hours && e.task===s.task && e.notes==='F. Pugliano');
        if (e) { e.notes = ''; dirty = true; }
      }

      // FIX: impeller date 2024-04-13 → 2024-10-20 (1460h, Leros haul out)
      const impeller = log.find(e => e.date==='2024-04-13' && String(e.hours)==='1460' && e.task==='Impeller replacement');
      if (impeller) { impeller.date = '2024-10-20'; dirty = true; }

      // FIX: task "Engine oil changePortStbd" → "Engine oil change", append note (2018-12-19, 50h, Cape Town)
      const oilTaskFix = log.find(e => e.date==='2018-12-19' && String(e.hours)==='50' && e.task==='Engine oil changePortStbd');
      if (oilTaskFix) {
        oilTaskFix.task  = 'Engine oil change';
        oilTaskFix.notes = (oilTaskFix.notes ? oilTaskFix.notes + ' — ' : '') + 'Port + Stbd';
        dirty = true;
      }

      // FIX: Coolant change date 2022-12-06 → 2022-01-23 (1060h, Licata — MM/DD entry error)
      const coolantFix = log.find(e => e.date==='2022-12-06' && String(e.hours)==='1060' && e.task==='Coolant change' && e.notes==='Licata');
      if (coolantFix) { coolantFix.date = '2022-01-23'; dirty = true; }

      // RENAME: two duplicate Diesel fuel filter entries at Didim 2022-10-04, 1243h
      const didimFuel = log.filter(e => e.date==='2022-10-04' && String(e.hours)==='1243' && e.task==='Diesel fuel filter change' && e.notes==='Didim');
      if (didimFuel.length >= 2) {
        didimFuel[0].task = 'Diesel fuel filter change — Primary (Racor)';
        didimFuel[1].task = 'Diesel fuel filter change — Secondary';
        dirty = true;
      }

      log.sort((a,b) => b.date.localeCompare(a.date) || (parseFloat(b.hours)||0)-(parseFloat(a.hours)||0));
      data._maintLogFixed_v2 = true;
      dirty = true;
    }
  } catch(e) { console.warn('maintLogFixV2', e); }
  // Split Saildrive service entry at Didim 2023-04-25, 1249h into two entries — v3
  try {
    if (localStorage.getItem(EMAIL_KEY) === OWNER_EMAIL && !data._maintLogFixed_v3) {
      const log = data.maintenance?.log;
      if (log) {
        const idx = log.findIndex(e => e.date==='2023-04-25' && String(e.hours)==='1249' && e.task==='Saildrive service' && e.notes==='Didim');
        const engines = idx !== -1 ? (log[idx].engines || ['port','starboard']) : null;
        if (idx !== -1) { log.splice(idx, 1); dirty = true; }
        if (!log.some(e => e.id==='seed_sd_lip_20230425'))  {
          log.push({ id:'seed_sd_lip_20230425',   date:'2023-04-25', hours:'1249', task:'Saildrive lip seal replacement', cost:'', notes:'Didim', engines });
          dirty = true;
        }
        if (!log.some(e => e.id==='seed_sd_shaft_20230425')) {
          log.push({ id:'seed_sd_shaft_20230425', date:'2023-04-25', hours:'1249', task:'Saildrive shaft replacement',    cost:'', notes:'Didim', engines });
          dirty = true;
        }
        log.sort((a,b) => b.date.localeCompare(a.date) || (parseFloat(b.hours)||0)-(parseFloat(a.hours)||0));
      }
      data._maintLogFixed_v3 = true;
      dirty = true;
    }
  } catch(e) { console.warn('maintLogFixV3', e); }
  // v4: rename task names + merge duplicate fuel filter entries
  try {
    if (!data._maintLogFixed_v4) {
      const log = data.maintenance?.log;
      if (log) {
        // Merge Primary+Secondary on same date → delete Secondary
        const primDates = new Set(
          log.filter(e => e.task==='Diesel fuel filter change — Primary (Racor)').map(e => e.date)
        );
        const toDelete = new Set(
          log.filter(e => e.task==='Diesel fuel filter change — Secondary' && primDates.has(e.date)).map(e => e.id)
        );
        if (toDelete.size) {
          for (let i = log.length - 1; i >= 0; i--) {
            if (toDelete.has(log[i].id)) { log.splice(i, 1); dirty = true; }
          }
        }
        // Rename any remaining Primary or Secondary → Fuel filters
        log.forEach(e => {
          if (e.task==='Diesel fuel filter change — Primary (Racor)' ||
              e.task==='Diesel fuel filter change — Secondary') {
            e.task = 'Fuel filters'; dirty = true;
          }
        });
      }
      data._maintLogFixed_v4 = true;
      dirty = true;
    }
  } catch(e) { console.warn('maintLogFixV4', e); }
  // Backfill second example Schengen person for non-owner accounts that only have one
  try {
    if (localStorage.getItem(EMAIL_KEY) !== OWNER_EMAIL) {
      const persons = data.schengen?.persons;
      if (persons?.length === 1 && persons[0].name === 'Alex Smith') {
        const dAgo = n => { const d = new Date(); d.setDate(d.getDate()-n); return d.toISOString().slice(0,10); };
        persons.push({ name:'Maria Santos', activePassport:0,
          passports:[{flag:'🇬🇧', country:'United Kingdom', eu:false}],
          log:[
            {id:uid(), type:'in',  date:dAgo(90), passport:'🇬🇧', location:'France (Marseille)'},
            {id:uid(), type:'out', date:dAgo(45), passport:'',    location:'Tunisia'}
          ]
        });
        dirty = true;
      }
    }
  } catch(e) { console.warn('migrateSchengenSecondPerson', e); }
  // Move AI-imported provision items out of visible list → history-only — owner only, runs once
  try {
    if (localStorage.getItem(EMAIL_KEY) === OWNER_EMAIL && !data._provHistMigrated) {
      if (!data.provisions) data.provisions = { items: [] };
      if (!data.provisions.items) data.provisions.items = [];
      if (!data.provisions.history) data.provisions.history = [];
      const toMove = [];
      const toKeep = [];
      (data.provisions.items || []).forEach(it => {
        // AI-imported items have at least one priceHistory entry, or lastStore/lastPrice set
        const isAiImported = (Array.isArray(it.priceHistory) && it.priceHistory.length > 0)
          || it.lastStore != null || it.lastPrice != null;
        if (isAiImported) toMove.push(it);
        else toKeep.push(it);
      });
      if (toMove.length) {
        toMove.forEach(it => {
          if (!data.provisions.history.some(h => h.id === it.id)) {
            data.provisions.history.push(it);
          }
        });
        data.provisions.items = toKeep;
      }
      data._provHistMigrated = true;
      dirty = true;
    }
  } catch(e) { console.warn('migrateProvHistory', e); }
  // Seed power spec for owner account — update manually if power system changes
  try {
    if (localStorage.getItem(EMAIL_KEY) === OWNER_EMAIL && !data.meta?.powerSpec) {
      if (!data.meta) data.meta = {};
      data.meta.powerSpec = {
        houseBankAh:    800,   // 4× Victron LFP 200Ah
        houseBankDesc:  '4 × LFP 200Ah',
        solarW:         1425,  // 981W rigid (stern arch) + 444W flex (cabin roof)
        solarDesc:      '981W rigid + 444W flex',
        inverterVA:     3000,
        inverterDesc:   'MultiPlus 12/3000/120',
        alternatorA:    120,   // 4× Orion-Tr Smart 30A DC-DC chargers
        alternatorDesc: '4 × Orion-Tr Smart 30A',
      };
      dirty = true;
    }
  } catch(e) { console.warn('seedPowerSpec', e); }
  // One-time systems import for owner — replaces existing systems with authoritative B1150 spreadsheet data
  // v5: adds Cruisair AC unit (77th item)
  try {
    if (localStorage.getItem(EMAIL_KEY) === OWNER_EMAIL && !data._systemsImportedV5) {
      data.systems = OROBORO_B1150_SYSTEMS.map(s => Object.assign({id: uid()}, s));
      data._systemsImportedV1 = true;
      data._systemsImportedV2 = true;
      data._systemsImportedV3 = true;
      data._systemsImportedV4 = true;
      data._systemsImportedV5 = true;
      dirty = true;
    }
  } catch(e) { console.warn('systemsImportV5', e); }
  if (dirty) save();
}

// ═══════════════════════════════════════════════════════════
//  PIN HELPERS
// ═══════════════════════════════════════════════════════════

function pinBoxesHTML(pfx, autoFn) {
  const fn = autoFn ? `'${autoFn}'` : 'null';
  return `<div class="pin-boxes">
    <input class="pin-box" type="password" inputmode="numeric" maxlength="1" id="${pfx}0" oninput="pinFwd('${pfx}',0,${fn})" onkeydown="pinBk(event,'${pfx}',0)">
    <input class="pin-box" type="password" inputmode="numeric" maxlength="1" id="${pfx}1" oninput="pinFwd('${pfx}',1,${fn})" onkeydown="pinBk(event,'${pfx}',1)">
    <input class="pin-box" type="password" inputmode="numeric" maxlength="1" id="${pfx}2" oninput="pinFwd('${pfx}',2,${fn})" onkeydown="pinBk(event,'${pfx}',2)">
    <input class="pin-box" type="password" inputmode="numeric" maxlength="1" id="${pfx}3" oninput="pinFwd('${pfx}',3,${fn})" onkeydown="pinBk(event,'${pfx}',3)">
  </div>`;
}
function pinFwd(pfx, i, fn) {
  const el = document.getElementById(pfx+i);
  if (!el?.value) return;
  if (!/^\d$/.test(el.value)) { el.value=''; return; }
  if (i < 3) document.getElementById(pfx+(i+1))?.focus();
  else if (fn) window[fn]?.();
}
function pinBk(e, pfx, i) {
  if (e.key==='Backspace' && !document.getElementById(pfx+i)?.value && i>0)
    document.getElementById(pfx+(i-1))?.focus();
}
function getPin(pfx) {
  return [0,1,2,3].map(i => document.getElementById(pfx+i)?.value||'').join('');
}
function clearPin(pfx) {
  [0,1,2,3].forEach(i => { const el=document.getElementById(pfx+i); if(el) el.value=''; });
  document.getElementById(pfx+'0')?.focus();
}

// ═══════════════════════════════════════════════════════════
//  PIN SETUP SCREEN (first launch only)
// ═══════════════════════════════════════════════════════════

function renderPINSetup() {
  const ov = document.getElementById('setupOv');
  ov.classList.remove('hidden');
  ov.innerHTML = `
    <div class="setup-inner">
      <div class="setup-logo"><img src="oroboro-logo-black-transparent-v2.png" alt="Oroboro" style="max-width:220px;height:auto;display:block;margin:0 auto 24px;"></div>
      <div style="font-size:44px;text-align:center;margin-bottom:12px">🔐</div>
      <div class="setup-h">Choose a PIN</div>
      <div class="setup-sub">Your 4-digit PIN encrypts your data with AES-256. Don't forget it — it cannot be recovered.</div>
      <label class="setup-lbl" style="text-align:center;display:block;margin-bottom:4px">Enter PIN</label>
      ${pinBoxesHTML('s', null)}
      <label class="setup-lbl" style="text-align:center;display:block;margin:14px 0 4px">Confirm PIN</label>
      ${pinBoxesHTML('c', null)}
      <label class="setup-lbl" style="margin-top:18px">PIN Hint <span style="color:var(--label3);font-weight:400">(optional but recommended)</span></label>
      <input class="setup-inp" id="pin-hint" type="text" placeholder='e.g. "year of birth" or "boat length"'
        style="margin-bottom:4px">
      <div style="font-size:12px;color:var(--label3);margin-bottom:14px">Stored unencrypted — visible on the Forgot PIN screen to jog your memory.</div>
      <div id="pw-err" style="color:var(--red);font-size:13px;min-height:20px;margin:8px 0;text-align:center"></div>
      <button class="setup-go" id="pw-go" onclick="createPIN()">Create Account →</button>
    </div>`;
  setTimeout(() => document.getElementById('s0')?.focus(), 80);
}

async function createPIN() {
  const pin  = getPin('s');
  const pin2 = getPin('c');
  const err  = document.getElementById('pw-err');
  const go   = document.getElementById('pw-go');
  if (!/^\d{4}$/.test(pin))  { if(err) err.textContent='Enter a 4-digit PIN'; clearPin('s'); return; }
  if (pin !== pin2) { if(err) err.textContent='PINs do not match'; clearPin('c'); return; }
  if (err) err.textContent='';
  if (go) { go.textContent='Creating account…'; go.disabled=true; }
  const hint = document.getElementById('pin-hint')?.value.trim() || '';
  localStorage.setItem(HINT_KEY, hint);
  try {
    const salt = await getOrCreateSalt();
    const key  = await deriveKey(pin, salt);
    cryptoKey  = key;
    localStorage.setItem(VERIFY_KEY, await aesEncrypt(key, 'BM_VERIFIED'));
    try { prefillNewUserSampleData(); } catch(e) { console.warn('prefillNewUser', e); }
    try { prefillCustomsOwnerData();  } catch(e) { console.warn('prefillCustoms', e); }
    try { prefillTransitLog();        } catch(e) { console.warn('prefillTransitLog', e); }
    try { prefillUpgradesData();      } catch(e) { console.warn('prefillUpgrades', e); }
    try { prefillSchengenData();      } catch(e) { console.warn('prefillSchengen', e); }
    try { prefillShipyardData();      } catch(e) { console.warn('prefillShipyard', e); }
    try { prefillWatermakerData();    } catch(e) { console.warn('prefillWatermaker', e); }
    try { prefillLpgData();           } catch(e) { console.warn('prefillLpg', e); }
    try { prefillProvisionsData();    } catch(e) { console.warn('prefillProvisions', e); }
    try { prefillSafetyData();        } catch(e) { console.warn('prefillSafety', e); }
    try { prefillPassageLogData();    } catch(e) { console.warn('prefillPassageLog', e); }
    await save();
    trackAnalytics(true);
    pushToCloud();
    startActivityTracking();
    document.getElementById('setupOv').classList.add('hidden');
    document.getElementById('app').classList.remove('hidden');
    applyHomeTab(); renderApp();
  } catch(e) {
    if (err) err.textContent = 'Setup failed: ' + e.message;
    if (go) { go.textContent='Create Account →'; go.disabled=false; }
  }
}

// ═══════════════════════════════════════════════════════════
//  LOCK / UNLOCK SCREEN
// ═══════════════════════════════════════════════════════════

function getAttemptState() {
  try { return JSON.parse(localStorage.getItem(ATTEMPTS_KEY)) || { count:0, lockUntil:0 }; }
  catch { return { count:0, lockUntil:0 }; }
}
function setAttemptState(s) { localStorage.setItem(ATTEMPTS_KEY, JSON.stringify(s)); }

let _lockCountdown = null;

function renderLockScreen() {
  const ov = document.getElementById('setupOv');
  ov.classList.remove('hidden');
  const at     = getAttemptState();
  const locked = at.lockUntil > Date.now();
  const email  = localStorage.getItem(EMAIL_KEY);
  ov.innerHTML = `
    <div class="setup-inner" style="padding-top:calc(env(safe-area-inset-top) + 20px)">
      <div class="setup-logo"><img src="oroboro-logo-black-transparent-v2.png" alt="Oroboro" style="max-width:220px;height:auto;display:block;margin:0 auto 24px;"></div>
      <div style="font-size:48px;text-align:center;margin-bottom:10px">🔒</div>
      <div class="setup-h" style="text-align:center">Enter PIN</div>
      <div class="setup-sub" style="text-align:center">${email ? esc(email) : ''}</div>
      ${pinBoxesHTML('u', locked ? null : 'attemptUnlock')}
      <div id="unlock-err" style="color:var(--red);font-size:13px;min-height:20px;
        margin:8px 0;text-align:center">
        ${at.count > 0 && !locked ? `${at.count} failed attempt${at.count>1?'s':''} — ${MAX_FAILS-at.count} remaining` : ''}
        ${locked ? `<span id="lock-countdown">Too many attempts — locked</span>` : ''}
      </div>
      <button class="setup-go" id="unlock-btn" onclick="attemptUnlock()" ${locked?'disabled':''}>
        ${locked ? 'Locked…' : 'Unlock'}
      </button>
      <button onclick="renderLoginScreen()"
        style="width:100%;margin-top:14px;border:none;background:none;font-family:var(--font);
          font-size:14px;color:var(--label3);cursor:pointer;padding:8px;text-align:center">
        Use a different account
      </button>
    </div>`;
  if (locked) startLockCountdown(at);
  else setTimeout(() => document.getElementById('u0')?.focus(), 80);
}

function startLockCountdown(at) {
  if (_lockCountdown) clearInterval(_lockCountdown);
  _lockCountdown = setInterval(() => {
    const remaining = Math.ceil((at.lockUntil - Date.now()) / 1000);
    const cd  = document.getElementById('lock-countdown');
    const btn = document.getElementById('unlock-btn');
    if (remaining <= 0) {
      clearInterval(_lockCountdown);
      at.count = 0; at.lockUntil = 0; setAttemptState(at);
      if (cd)  cd.textContent = '';
      if (btn) { btn.textContent = 'Unlock'; btn.disabled = false; }
      document.getElementById('unlock-err').textContent = '';
      document.getElementById('u0')?.focus();
    } else {
      if (cd) cd.textContent = `Too many attempts — wait ${remaining}s`;
    }
  }, 500);
}

async function attemptUnlock() {
  const at = getAttemptState();
  if (at.lockUntil > Date.now()) return;
  const pin = getPin('u');
  const err = document.getElementById('unlock-err');
  const btn = document.getElementById('unlock-btn');
  if (!crypto?.subtle) { if(err) err.textContent='Secure connection required — please open this app via HTTPS (https://boat.sailingoroboro.com)'; return; }
  if (pin.length !== 4) { if(err) err.textContent='Enter your 4-digit PIN'; return; }
  if (btn) { btn.textContent='Checking…'; btn.disabled=true; }
  try {
    const salt = await getOrCreateSalt();
    const key  = await deriveKey(pin, salt);
    const stored = localStorage.getItem(VERIFY_KEY);
    if (!stored) throw new Error('No verification data');
    const result = await aesDecrypt(key, stored);
    if (result !== 'BM_VERIFIED') throw new Error('Wrong PIN');
    cryptoKey = key;
    at.count = 0; at.lockUntil = 0; setAttemptState(at);
    const found = await load();
    if (!found) { data = JSON.parse(JSON.stringify(EMPTY_DEFAULTS)); }
    if (!localStorage.getItem(EMAIL_KEY) && data.meta?.email) localStorage.setItem(EMAIL_KEY, data.meta.email);
    const pulled = await pullFromCloud();
    migrateData();
    if (!pulled) {
      let prefillDirty = false;
      try { if (prefillNewUserSampleData()) prefillDirty = true; } catch(e) { console.warn('prefillNewUser', e); }
      try { if (prefillCustomsOwnerData()) prefillDirty = true; } catch(e) { console.warn('prefillCustoms', e); }
      try { if (prefillTransitLog()) prefillDirty = true; } catch(e) { console.warn('prefillTransitLog', e); }
      try { if (prefillUpgradesData()) prefillDirty = true; } catch(e) { console.warn('prefillUpgrades', e); }
      try { if (prefillSchengenData()) prefillDirty = true; } catch(e) { console.warn('prefillSchengen', e); }
      try { if (prefillShipyardData()) prefillDirty = true; } catch(e) { console.warn('prefillShipyard', e); }
      try { if (prefillWatermakerData()) prefillDirty = true; } catch(e) { console.warn('prefillWatermaker', e); }
      try { if (prefillLpgData()) prefillDirty = true; } catch(e) { console.warn('prefillLpg', e); }
      try { if (prefillProvisionsData()) prefillDirty = true; } catch(e) { console.warn('prefillProvisions', e); }
      try { if (prefillSafetyData()) prefillDirty = true; } catch(e) { console.warn('prefillSafety', e); }
      try { if (prefillPassageLogData()) prefillDirty = true; } catch(e) { console.warn('prefillPassageLog', e); }
      if (prefillDirty) save();
      await pushToCloud();
    }
    startActivityTracking();
    document.getElementById('setupOv').classList.add('hidden');
    document.getElementById('app').classList.remove('hidden');
    applyHomeTab(); renderApp();
  } catch(e) {
    at.count++;
    if (at.count >= MAX_FAILS) { at.lockUntil = Date.now() + LOCKOUT_MS; at.count = MAX_FAILS; }
    setAttemptState(at);
    if (btn) { btn.textContent='Unlock'; btn.disabled=false; }
    if (err) err.textContent = at.lockUntil > Date.now()
      ? `Too many attempts — locked for ${LOCKOUT_MS/1000}s`
      : `Wrong PIN — ${MAX_FAILS-at.count} attempt${MAX_FAILS-at.count===1?'':'s'} remaining`;
    if (at.lockUntil > Date.now()) startLockCountdown(at);
    clearPin('u');
  }
}

// ═══════════════════════════════════════════════════════════
//  LOCK APP / ACTIVITY TRACKING
// ═══════════════════════════════════════════════════════════

function resetActivity() { lastActivity = Date.now(); }

async function silentPull() {
  if (!cryptoKey) return;
  const pulled = await pullFromCloud();
  if (pulled) { migrateData(); renderApp(); }
}

async function onVisibilityChange() {
  if (document.visibilityState !== 'visible' || !cryptoKey) return;
  const rawTs = localStorage.getItem(LAST_SYNC_KEY);
  if (rawTs && Date.now() - new Date(rawTs).getTime() < 60000) return;
  await silentPull();
}

function startAutoSync() {
  if (_autoSyncTimer) clearInterval(_autoSyncTimer);
  _autoSyncTimer = setInterval(silentPull, 3 * 60 * 1000);
  document.removeEventListener('visibilitychange', onVisibilityChange);
  document.addEventListener('visibilitychange', onVisibilityChange);
}

function stopAutoSync() {
  if (_autoSyncTimer) { clearInterval(_autoSyncTimer); _autoSyncTimer = null; }
  document.removeEventListener('visibilitychange', onVisibilityChange);
}

function startActivityTracking() {
  lastActivity = Date.now();
  document.addEventListener('click',      resetActivity, true);
  document.addEventListener('keydown',    resetActivity, true);
  document.addEventListener('touchstart', resetActivity, true);
  if (lockTimer) clearInterval(lockTimer);
  lockTimer = setInterval(() => {
    if (Date.now() - lastActivity > LOCK_MS) lockApp();
  }, 15000);
  startAutoSync();
}

function lockApp() {
  cryptoKey = null; data = {};
  if (lockTimer) { clearInterval(lockTimer); lockTimer = null; }
  stopAutoSync();
  document.removeEventListener('click',      resetActivity, true);
  document.removeEventListener('keydown',    resetActivity, true);
  document.removeEventListener('touchstart', resetActivity, true);
  document.getElementById('app').classList.add('hidden');
  renderLockScreen();
}

// ═══════════════════════════════════════════════════════════
//  INIT
// ═══════════════════════════════════════════════════════════

// ═══════════════════════════════════════════════════════════
//  LOGIN SCREEN
// ═══════════════════════════════════════════════════════════

function renderLoginScreen() {
  const ov = document.getElementById('setupOv');
  ov.classList.remove('hidden');
  document.getElementById('app').classList.add('hidden');
  ov.innerHTML = `
    <div class="setup-inner" style="padding-top:calc(env(safe-area-inset-top) + 20px)">
      <div class="setup-logo"><img src="oroboro-logo-black-transparent-v2.png" alt="Oroboro" style="max-width:220px;height:auto;display:block;margin:0 auto 24px;"></div>
      <div class="setup-h">Boat Manager</div>
      <label class="setup-lbl">Email</label>
      <input class="setup-inp" id="login-email" type="email" placeholder="your@email.com"
        value=""
        onkeydown="if(event.key==='Enter')document.getElementById('l0').focus()">
      <label class="setup-lbl" style="text-align:center;display:block;margin-bottom:4px;margin-top:16px">PIN</label>
      ${pinBoxesHTML('l', 'attemptLogin')}
      <div id="login-err" style="color:var(--red);font-size:13px;min-height:20px;
        margin:8px 0;text-align:center"></div>
      <button class="setup-go" id="login-btn" onclick="attemptLogin()">Login</button>
      <div style="display:flex;justify-content:space-between;margin-top:14px">
        <button onclick="renderForgotPIN()"
          style="border:none;background:none;font-family:var(--font);font-size:14px;
            color:var(--label3);cursor:pointer;padding:8px 4px">
          Forgot PIN?
        </button>
        <button onclick="startNewSetupFromLogin()"
          style="border:none;background:none;font-family:var(--font);font-size:14px;
            color:var(--blue);cursor:pointer;padding:8px 4px">
          New user? Set up your boat →
        </button>
      </div>
    </div>`;
  setTimeout(() => document.getElementById('login-email')?.focus(), 80);
}

async function attemptLogin() {
  const email = document.getElementById('login-email')?.value.trim().toLowerCase();
  const pin   = getPin('l');
  const err   = document.getElementById('login-err');
  const btn   = document.getElementById('login-btn');
  if (!crypto?.subtle) { if(err) err.textContent='Secure connection required — please open this app via HTTPS (https://boat.sailingoroboro.com)'; return; }
  if (!email || !email.includes('@')) { if(err) err.textContent='Enter a valid email'; return; }
  if (pin.length !== 4) { if(err) err.textContent='Enter your 4-digit PIN'; return; }
  if (btn) { btn.textContent='Signing in…'; btn.disabled=true; }
  if (err) err.textContent='';

  // Fast path: same device, same email — try local decrypt
  const storedEmail = localStorage.getItem(EMAIL_KEY);
  const hasSalt     = !!localStorage.getItem(SALT_KEY);
  const hasVerify   = !!localStorage.getItem(VERIFY_KEY);
  if (storedEmail === email && hasSalt && hasVerify) {
    try {
      const salt = await getOrCreateSalt();
      const key  = await deriveKey(pin, salt);
      await aesDecrypt(key, localStorage.getItem(VERIFY_KEY));
      cryptoKey = key;
      await load();
      if (!localStorage.getItem(EMAIL_KEY) && data.meta?.email) localStorage.setItem(EMAIL_KEY, data.meta.email);
      const pulled = await pullFromCloud();
      migrateData();
      if (!pulled) {
        let prefillDirty = false;
        try { if (prefillNewUserSampleData()) prefillDirty = true; } catch(e) { console.warn('prefillNewUser', e); }
        try { if (prefillCustomsOwnerData()) prefillDirty = true; } catch(e) { console.warn('prefillCustoms', e); }
        try { if (prefillTransitLog()) prefillDirty = true; } catch(e) { console.warn('prefillTransitLog', e); }
        try { if (prefillUpgradesData()) prefillDirty = true; } catch(e) { console.warn('prefillUpgrades', e); }
        try { if (prefillSchengenData()) prefillDirty = true; } catch(e) { console.warn('prefillSchengen', e); }
      try { if (prefillShipyardData()) prefillDirty = true; } catch(e) { console.warn('prefillShipyard', e); }
      try { if (prefillWatermakerData()) prefillDirty = true; } catch(e) { console.warn('prefillWatermaker', e); }
      try { if (prefillLpgData()) prefillDirty = true; } catch(e) { console.warn('prefillLpg', e); }
      try { if (prefillProvisionsData()) prefillDirty = true; } catch(e) { console.warn('prefillProvisions', e); }
      try { if (prefillSafetyData()) prefillDirty = true; } catch(e) { console.warn('prefillSafety', e); }
      try { if (prefillPassageLogData()) prefillDirty = true; } catch(e) { console.warn('prefillPassageLog', e); }
        if (prefillDirty) save();
        await pushToCloud();
      }
      startActivityTracking();
      document.getElementById('setupOv').classList.add('hidden');
      document.getElementById('app').classList.remove('hidden');
      applyHomeTab(); renderApp();
      return;
    } catch(e) { /* fall through to cloud */ }
  }

  // Cloud path: new device, different email, or corrupted local data
  try {
    const cloud = await fetchFromCloud(email);
    const salt  = b64ToU8(cloud.salt);
    const key   = await deriveKey(pin, salt);
    await aesDecrypt(key, cloud.verify);
    localStorage.setItem(EMAIL_KEY,  email);
    localStorage.setItem(SALT_KEY,   cloud.salt);
    localStorage.setItem(VERIFY_KEY, cloud.verify);
    localStorage.setItem(ENC_KEY,    cloud.data);
    localStorage.setItem(HINT_KEY,   cloud.hint || '');
    localStorage.removeItem(ATTEMPTS_KEY);
    cryptoKey = key;
    await load();
    migrateData();
    startActivityTracking();
    document.getElementById('setupOv').classList.add('hidden');
    document.getElementById('app').classList.remove('hidden');
    applyHomeTab(); renderApp();
    setSyncStatus('synced');
  } catch(e) {
    if (e.message.includes('404') && !hasSalt && !hasVerify) {
      startNewSetupFromLogin();
      return;
    }
    const msg = e.message.includes('404')
      ? 'No account found. Tap "Set up your boat" to register.'
      : 'Wrong email or PIN.';
    if (err) err.textContent = msg;
    if (btn) { btn.textContent='Login'; btn.disabled=false; }
    clearPin('l');
  }
}

// ── Forgot PIN flow ────────────────────────────────────────

function renderForgotPIN() {
  const ov = document.getElementById('setupOv');
  const savedEmail = localStorage.getItem(EMAIL_KEY) || '';
  ov.innerHTML = `
    <div class="setup-inner">
      <div class="setup-logo"><img src="oroboro-logo-black-transparent-v2.png" alt="Oroboro" style="max-width:220px;height:auto;display:block;margin:0 auto 24px;"></div>
      <div class="setup-h">Forgot PIN?</div>
      <div class="setup-sub">Enter your email to see your PIN hint.</div>
      <label class="setup-lbl">Email</label>
      <input class="setup-inp" id="hint-email" type="email" placeholder="your@email.com"
        value="${esc(savedEmail)}"
        onkeydown="if(event.key==='Enter')loadPINHint()">
      <div id="hint-err" style="color:var(--red);font-size:13px;min-height:20px;margin-bottom:8px;text-align:center"></div>
      <button class="setup-go" id="hint-btn" onclick="loadPINHint()">Show My Hint</button>
      <button onclick="renderLoginScreen()"
        style="width:100%;margin-top:14px;border:none;background:none;font-family:var(--font);
          font-size:15px;color:var(--label3);cursor:pointer;padding:10px">
        ← Back to login
      </button>
    </div>`;
  setTimeout(() => {
    if (savedEmail) document.getElementById('hint-btn')?.focus();
    else document.getElementById('hint-email')?.focus();
  }, 80);
}

async function loadPINHint() {
  const email = document.getElementById('hint-email')?.value.trim().toLowerCase();
  const err   = document.getElementById('hint-err');
  const btn   = document.getElementById('hint-btn');
  if (!crypto?.subtle) { if(err) err.textContent='Secure connection required — please open this app via HTTPS (https://boat.sailingoroboro.com)'; return; }
  if (!email || !email.includes('@')) { if(err) err.textContent='Enter a valid email'; return; }
  if (btn) { btn.textContent='Loading…'; btn.disabled=true; }
  if (err) err.textContent='';
  try {
    const key = await emailToKey(email);
    const r   = await fetch(`${STORAGE_WORKER_URL}/api/hint/${key}`);
    const j   = await r.json();
    if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
    showPINHint(email, j.hint || '');
  } catch(e) {
    if (err) err.textContent = e.message.includes('404') ? 'No account found for this email.'
            : 'Could not load hint: ' + e.message;
    if (btn) { btn.textContent='Show My Hint'; btn.disabled=false; }
  }
}

function showPINHint(email, hint) {
  const ov = document.getElementById('setupOv');
  const hintBlock = hint
    ? `<div style="background:rgba(0,122,255,.08);border:0.5px solid var(--blue);
        border-radius:12px;padding:18px 16px;margin:18px 0;text-align:center">
        <div style="font-size:11px;font-weight:700;color:var(--label3);text-transform:uppercase;
          letter-spacing:.4px;margin-bottom:8px">Your PIN hint</div>
        <div style="font-size:20px;font-weight:600;color:var(--label)">${esc(hint)}</div>
      </div>`
    : `<div style="padding:18px 0;text-align:center;color:var(--label3);font-size:14px">
        No hint was set for this account.
      </div>`;
  ov.innerHTML = `
    <div class="setup-inner">
      <div class="setup-logo"><img src="oroboro-logo-black-transparent-v2.png" alt="Oroboro" style="max-width:220px;height:auto;display:block;margin:0 auto 24px;"></div>
      <div class="setup-h">Forgot PIN?</div>
      <div class="setup-sub" style="text-align:center">${esc(email)}</div>
      ${hintBlock}
      <button onclick="confirmPINReset('${email}')"
        style="width:100%;background:var(--red);color:#fff;border:none;border-radius:8px;
          padding:16px;font-family:var(--font);font-size:16px;font-weight:600;cursor:pointer">
        Reset PIN — This will erase all data
      </button>
      <button onclick="renderLoginScreen()"
        style="width:100%;margin-top:14px;border:none;background:none;font-family:var(--font);
          font-size:15px;color:var(--label3);cursor:pointer;padding:10px">
        ← Back to login
      </button>
    </div>`;
}

function confirmPINReset(email) {
  if (!confirm('Reset PIN?\n\nThis will permanently erase all your boat data on all devices. This cannot be undone.')) return;
  [SALT_KEY, VERIFY_KEY, ENC_KEY, HINT_KEY].forEach(k => localStorage.removeItem(k));
  localStorage.setItem(EMAIL_KEY, email);
  data = JSON.parse(JSON.stringify(EMPTY_DEFAULTS));
  data.meta.email = email;
  renderSetNewPIN();
}

function renderSetNewPIN() {
  const ov = document.getElementById('setupOv');
  ov.innerHTML = `
    <div class="setup-inner">
      <div class="setup-logo"><img src="oroboro-logo-black-transparent-v2.png" alt="Oroboro" style="max-width:220px;height:auto;display:block;margin:0 auto 24px;"></div>
      <div style="font-size:40px;text-align:center;margin-bottom:8px">🔐</div>
      <div class="setup-h">Choose New PIN</div>
      <div class="setup-sub" style="color:var(--orange)">⚠️ Starting fresh — previous data is gone.</div>
      <label class="setup-lbl" style="text-align:center;display:block;margin-bottom:4px;margin-top:16px">New PIN</label>
      ${pinBoxesHTML('s', null)}
      <label class="setup-lbl" style="text-align:center;display:block;margin:14px 0 4px">Confirm PIN</label>
      ${pinBoxesHTML('c', null)}
      <label class="setup-lbl" style="margin-top:18px">PIN Hint <span style="color:var(--label3);font-weight:400">(optional)</span></label>
      <input class="setup-inp" id="pin-hint" type="text" placeholder='e.g. "year of birth"' style="margin-bottom:4px">
      <div id="pw-err" style="color:var(--red);font-size:13px;min-height:20px;margin:8px 0;text-align:center"></div>
      <button class="setup-go" id="pw-go" onclick="createPIN()">Set New PIN →</button>
    </div>`;
  setTimeout(() => document.getElementById('s0')?.focus(), 80);
}

function startNewSetupFromLogin() {
  const email = document.getElementById('login-email')?.value.trim().toLowerCase() || '';
  startNewSetup(email);
}

function startNewSetup(prefillEmail = '') {
  data = JSON.parse(JSON.stringify(EMPTY_DEFAULTS));
  if (typeof OROBORO_DATA !== 'undefined' && prefillEmail === OWNER_EMAIL) deepMerge(data, OROBORO_DATA);
  data.meta.email = '';
  renderSetup(prefillEmail);
}

// ═══════════════════════════════════════════════════════════
//  BACKUP — save & load encrypted backup files
// ═══════════════════════════════════════════════════════════

async function saveBackup() {
  if (!cryptoKey) { showToast('Unlock the app first', true); return; }
  const salt   = localStorage.getItem(SALT_KEY);
  const verify = localStorage.getItem(VERIFY_KEY);
  const enc    = localStorage.getItem(ENC_KEY);
  if (!salt || !verify || !enc) { showToast('Nothing to back up yet', true); return; }
  const backup = {
    format:  'oroboro-boat-backup-v1',
    created: new Date().toISOString(),
    salt, verify, data: enc
  };
  const blob = new Blob([JSON.stringify(backup, null, 2)], { type:'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'oroboro-boat-backup.json';
  a.click();
  localStorage.setItem(BACKUP_TS, Date.now().toString());
  renderBackupBar();
  showToast('Backup saved to Downloads / Files');
}

function loadBackupFile(input) {
  const file = input.files[0]; if (!file) return;
  const reader = new FileReader();
  reader.onload = async e => {
    try {
      const backup = JSON.parse(e.target.result);
      if (backup.format !== 'oroboro-boat-backup-v1') {
        showToast('Not a valid backup file', true); input.value = ''; return;
      }
      if (!backup.salt || !backup.verify || !backup.data) {
        showToast('Backup file is incomplete', true); input.value = ''; return;
      }
      _pendingBackup = backup;
      showModal('Restore Backup', `
        <div style="font-size:14px;color:var(--label2);margin-bottom:6px">
          Enter the PIN from the account that <b>created</b> this backup to decrypt it.
        </div>
        <div style="font-size:12px;color:var(--label3);margin-bottom:12px">Your own PIN and account credentials will not be changed.</div>
        <div style="text-align:center;margin:8px 0 4px">${pinBoxesHTML('bkp', 'applyBackupData')}</div>
        <div id="bkp-err" style="color:var(--red);font-size:13px;min-height:20px;margin:4px 0 8px;text-align:center"></div>
        <div class="modal-btns">
          <button class="btn btn-s" onclick="hideModal()">Cancel</button>
          <button class="btn btn-p" id="bkp-btn" onclick="applyBackupData()">Restore</button>
        </div>`);
      setTimeout(() => document.getElementById('bkp0')?.focus(), 80);
    } catch {
      showToast('Could not read backup file', true);
    }
    input.value = '';
  };
  reader.readAsText(file);
}

async function applyBackupData() {
  const pin   = getPin('bkp');
  const errEl = document.getElementById('bkp-err');
  const btn   = document.getElementById('bkp-btn');
  if (pin.length !== 4) { if (errEl) errEl.textContent = 'Enter the 4-digit backup PIN'; return; }
  if (!_pendingBackup) { if (errEl) errEl.textContent = 'No backup loaded — please try again'; return; }
  if (errEl) errEl.textContent = '';
  if (btn) { btn.textContent = 'Restoring…'; btn.disabled = true; }
  try {
    const backup = _pendingBackup;
    const salt   = b64ToU8(backup.salt);
    const key    = await deriveKey(pin, salt);
    try { await aesDecrypt(key, backup.verify); }
    catch {
      if (errEl) errEl.textContent = 'Wrong PIN — this backup was created with a different PIN';
      if (btn) { btn.textContent = 'Restore'; btn.disabled = false; }
      return;
    }
    let imported;
    try { imported = JSON.parse(await aesDecrypt(key, backup.data)); }
    catch { throw new Error('corrupted'); }
    // Preserve current account credentials before merging
    const keepEmail    = data.meta?.email;
    const keepOwner    = data.meta?.ownerName;
    const keepSetup    = data.meta?.setupComplete;
    deepMerge(data, imported);
    data.meta.email         = keepEmail    || data.meta?.email    || '';
    data.meta.ownerName     = keepOwner    || data.meta?.ownerName || '';
    data.meta.setupComplete = keepSetup    ?? data.meta?.setupComplete;
    localStorage.setItem('bm_just_imported', Date.now());
    await save();
    _pendingBackup = null;
    hideModal();
    if (cryptoKey) {
      migrateData(); renderApp();
      showToast('Backup restored successfully ✓');
    } else {
      renderLockScreen();
      showToast('Backup restored successfully ✓ — use your own PIN to unlock');
    }
  } catch(e) {
    const msg = e.message === 'corrupted' ? 'Backup file appears to be corrupted' : 'Could not restore backup';
    if (errEl) errEl.textContent = msg;
    if (btn) { btn.textContent = 'Restore'; btn.disabled = false; }
  }
}

function renderBackupBar() {
  const el = document.getElementById('backupBar'); if (!el) return;
  const ts  = localStorage.getItem(BACKUP_TS);
  let label;
  if (!ts) {
    label = '<span style="color:var(--orange);font-weight:600">⚠️ Never backed up</span>';
  } else {
    const d = new Date(parseInt(ts));
    const ago = Math.round((Date.now() - d) / 60000);
    const when = ago < 60 ? `${ago}m ago` :
                 ago < 1440 ? `${Math.round(ago/60)}h ago` :
                 d.toLocaleDateString('en-GB',{day:'numeric',month:'short'});
    label = `Last backup: <b>${when}</b>`;
  }
  el.innerHTML = `
    <div class="backup-bar-txt">${label}</div>
    <button class="btn btn-s btn-xs" onclick="saveBackup()">☁️ Backup now</button>`;
}

// ═══════════════════════════════════════════════════════════
//  CLOUD SYNC
// ═══════════════════════════════════════════════════════════

async function emailToKey(email) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(email.toLowerCase().trim()));
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2,'0')).join('');
}

let _analyticsTracked = false;
async function trackAnalytics(isSignup) {
  if (!STORAGE_WORKER_URL) return;
  if (!isSignup && _analyticsTracked) return; // update lastActive once per session
  const email = localStorage.getItem(EMAIL_KEY);
  if (!email) return;
  try {
    const hash  = await emailToKey(email);
    const today = new Date().toISOString().slice(0,10);
    let meta = null;
    try { meta = JSON.parse(localStorage.getItem('bm_analytics_meta') || 'null'); } catch(e) {}
    if (isSignup || !meta) {
      meta = { signupDate: today, boatName: data.meta?.boatName || '', country: data.meta?.flag || '' };
      localStorage.setItem('bm_analytics_meta', JSON.stringify(meta));
    }
    fetch(`${STORAGE_WORKER_URL}/api/analytics/users/${hash}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...meta, lastActive: today })
    }).catch(() => {});
    _analyticsTracked = true;
  } catch(e) {}
}

function setSyncStatus(status) {
  syncStatus = status;
  const dot = document.getElementById('sync-dot');
  if (dot) {
    const colors = {synced:'var(--green)',syncing:'var(--orange)',offline:'var(--red)',idle:'#666'};
    const titles = {synced:'Synced to cloud',syncing:'Syncing…',offline:'Offline — tap to retry',idle:'Not synced'};
    dot.style.color = colors[status] || '#666';
    dot.title = titles[status] || 'Sync';
  }
  if (ui.tab === 'settings') {
    const mc = document.getElementById('mainContent');
    if (mc) mc.innerHTML = renderSettings();
  }
}

async function pushToCloud() {
  const email  = localStorage.getItem(EMAIL_KEY);
  const salt   = localStorage.getItem(SALT_KEY);
  const verify = localStorage.getItem(VERIFY_KEY);
  const enc    = localStorage.getItem(ENC_KEY);
  if (!email || !salt || !verify || !enc) return;
  setSyncStatus('syncing');
  try {
    const key = await emailToKey(email);
    const r = await fetch(`${STORAGE_WORKER_URL}/api/data/${key}`, {
      method: 'PUT',
      headers: {'Content-Type':'application/json'},
      body: JSON.stringify({salt, verify, data: enc, hint: localStorage.getItem(HINT_KEY)||''})
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    localStorage.setItem(LAST_SYNC_KEY, new Date().toISOString());
    localStorage.removeItem('bm_just_imported');
    setSyncStatus('synced');
    trackAnalytics(false);
  } catch(e) {
    setSyncStatus('offline');
    console.warn('Cloud sync failed', e);
  }
}

async function fetchFromCloud(email) {
  const key = await emailToKey(email);
  const r = await fetch(`${STORAGE_WORKER_URL}/api/data/${key}`);
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const j = await r.json();
  if (!j.salt || !j.verify || !j.data) throw new Error('Incomplete cloud data');
  return j;
}

async function pullFromCloud() {
  const email = localStorage.getItem(EMAIL_KEY);
  if (!email || !cryptoKey) return false;
  const importTs = localStorage.getItem('bm_just_imported');
  if (importTs && Date.now() - parseInt(importTs) < 30000) return false;
  try {
    const cloud = await fetchFromCloud(email);
    const decrypted = JSON.parse(await aesDecrypt(cryptoKey, cloud.data));
    data = decrypted;
    localStorage.setItem(ENC_KEY,  cloud.data);
    localStorage.setItem(HINT_KEY, cloud.hint || '');
    localStorage.setItem(LAST_SYNC_KEY, new Date().toISOString());
    setSyncStatus('synced');
    return true;
  } catch(e) {
    console.error('[pullFromCloud ERROR]', e.name, e.message, e.stack?.split('\n')[1]);
    showToast('Sync failed: ' + e.message, true);
    return false;
  }
}

function forceResync() {
  showModal('Reset local data & re-sync', `
    <div style="font-size:14px;color:var(--label2);line-height:1.5;margin-bottom:16px">This will clear local data and reload from cloud.<br>You will need to enter your PIN again.</div>
    <div class="modal-btns">
      <button class="btn btn-s" onclick="hideModal()">Cancel</button>
      <button class="btn btn-p" style="background:var(--red)" onclick="hideModal();localStorage.removeItem('bm_enc');location.reload()">Clear &amp; Reload</button>
    </div>`);
}

async function syncNow() {
  setSyncStatus('syncing');
  if (ui.tab === 'settings') document.getElementById('mainContent').innerHTML = renderSettings();
  const pulled = await pullFromCloud();
  if (pulled) {
    migrateData();
    renderApp();
    showToast('Synced — latest data loaded from cloud');
  } else {
    // Pull failed (offline or error) — push local data so changes made offline are not lost
    await pushToCloud();
    showToast(syncStatus === 'synced' ? 'Pushed local data to cloud' : 'Sync failed — check connection', syncStatus !== 'synced');
  }
  if (ui.tab === 'settings') document.getElementById('mainContent').innerHTML = renderSettings();
}

function showPrivacyPolicy() {
  const existing = document.getElementById('ppOverlay');
  if (existing) { existing.remove(); return; }
  const div = document.createElement('div');
  div.id = 'ppOverlay';
  div.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.6);z-index:99999;display:flex;align-items:flex-end;justify-content:center;';
  div.innerHTML = `<div style="background:#fff;border-radius:16px 16px 0 0;padding:24px;max-height:80vh;overflow-y:auto;width:100%;max-width:500px;">
    <h2 style="margin-bottom:12px;font-size:18px;">Privacy Policy</h2>
    <p style="font-size:13px;line-height:1.7;color:#444;">
      <b>What this app is</b><br>Oroboro Boat Manager is a personal boat management tool for sailors. Not a commercial service. Currently in beta.<br><br>
      <b>What data we collect</b><br>Your email (stored as a hash we cannot read), boat name, maintenance logs, and document details you choose to enter. No tracking, no ads.<br><br>
      <b>How data is stored</b><br>All data is AES-256 encrypted on your device before transmission. The encryption key is derived from your PIN and never leaves your device. Data is stored in a cloud backend managed by the app developer. Because all data is encrypted before leaving your device, it cannot be read by anyone — including us — without your PIN. During the beta period, the developer may access anonymized usage data to improve the app.<br><br>
      <b>Who can access your data</b><br>Only you with your PIN.<br><br>
      <b>Your GDPR rights</b><br>Access, deletion, and portability — all available in Settings.<br><br>
      <b>Disclaimer</b><br>This app is provided as a tool to help you organise your boat management and track your Schengen days. It is not legal advice. Schengen rules are complex and subject to change — always verify your status with official sources before making entry decisions. The developer accepts no liability for overstays, fines, or legal consequences arising from use of this app.<br><br>
      <b>Contact:</b> ${typeof OWNER_EMAIL !== 'undefined' ? OWNER_EMAIL : ''}
    </p>
    <p style="font-size:11px;color:#888;margin-top:8px;text-align:center">© 2024–2026 Francesco Pugliano. All rights reserved.</p>
    <button onclick="document.getElementById('ppOverlay').remove()" style="width:100%;padding:14px;background:#185FA5;color:white;border:none;border-radius:12px;font-size:16px;font-weight:500;margin-top:16px;cursor:pointer;">Close</button>
  </div>`;
  document.body.appendChild(div);
  div.addEventListener('click', function(e) { if(e.target===div) div.remove(); });
}
function showTermsOfUse() {
  const existing = document.getElementById('touOverlay');
  if (existing) { existing.remove(); return; }
  const div = document.createElement('div');
  div.id = 'touOverlay';
  div.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.6);z-index:99999;display:flex;align-items:flex-end;justify-content:center;';
  div.innerHTML = `<div style="background:#fff;border-radius:16px 16px 0 0;padding:24px;max-height:80vh;overflow-y:auto;width:100%;max-width:500px;">
    <h2 style="margin-bottom:12px;font-size:18px;">Terms of Use</h2>
    <p style="font-size:13px;line-height:1.7;color:#444;">
      By using this app you agree to the following:<br><br>
      This app is provided as-is, without warranty of any kind. Use it at your own risk. The developer is not responsible for data loss, inaccuracies, or any consequences arising from use of this app — including but not limited to Schengen overstays, customs fines, or legal issues.<br><br>
      This is a beta product. Features may change, data may be migrated, and the service may be interrupted without notice.<br><br>
      You are responsible for verifying all information with official sources before making legal or financial decisions.<br><br>
      This app is for personal use only. You may not resell, redistribute, or commercialize it in any form.
    </p>
    <p style="font-size:11px;color:#888;margin-top:8px;text-align:center">© 2024–2026 Francesco Pugliano. All rights reserved.</p>
    <button onclick="document.getElementById('touOverlay').remove()" style="width:100%;padding:14px;background:#185FA5;color:white;border:none;border-radius:12px;font-size:16px;font-weight:500;margin-top:16px;cursor:pointer;">Close</button>
  </div>`;
  document.body.appendChild(div);
  div.addEventListener('click', function(e) { if(e.target===div) div.remove(); });
}

async function deleteAccount() {
  const confirmed = confirm('This will permanently delete all your data from the cloud and log you out.\n\nThis cannot be undone. Are you sure?');
  if (!confirmed) return;
  try {
    const email = localStorage.getItem(EMAIL_KEY);
    if (email && cryptoKey) {
      const key = await emailToKey(email);
      await fetch(`${STORAGE_WORKER_URL}/api/data/${key}`, { method: 'DELETE' });
    }
  } catch(e) { console.warn('Delete account cloud error:', e); }
  [SALT_KEY, VERIFY_KEY, ENC_KEY, HINT_KEY, EMAIL_KEY, ATTEMPTS_KEY, LAST_SYNC_KEY, BACKUP_TS].forEach(k => localStorage.removeItem(k));
  cryptoKey = null; data = {};
  stopAutoSync();
  showToast('Account deleted successfully');
  setTimeout(() => renderLoginScreen(), 1200);
}

function logOut() {
  if (!confirm('This will log you out and you may lose access to your data if you forget your PIN.\n\nAre you sure?')) return;
  [SALT_KEY, VERIFY_KEY, ENC_KEY, HINT_KEY].forEach(k => localStorage.removeItem(k));
  renderLoginScreen();
}

function timeAgo(isoStr) {
  if (!isoStr) return 'Never';
  const secs = Math.round((Date.now() - new Date(isoStr).getTime()) / 1000);
  if (secs < 10)   return 'Just now';
  if (secs < 60)   return `${secs}s ago`;
  if (secs < 3600) return `${Math.floor(secs/60)} min ago`;
  if (secs < 86400) return `${Math.floor(secs/3600)} hr ago`;
  return new Date(isoStr).toLocaleDateString();
}

// ── AI Import Assistant ──────────────────────────────────────
let _aiImportText = '', _aiImportParsed = null, _aiImportInProgress = false, _aiImportPhotoData = null;
let _aiSectionDest = null, _aiItemState = null;

function showAiImportModal() {
  _aiImportText = '';
  _aiImportParsed = null;
  _aiImportInProgress = false;
  _aiImportPhotoData = null;
  _aiSectionDest = null;
  _aiItemState = null;
  showModal('AI Import Assistant', _aiStep1Html());
}

function showAiImportTextMode() {
  showAiImportModal();
  setTimeout(() => aiShowTextInput(), 0);
}

function _normProvCat(cat) {
  if (PROV_CAT_ORDER.includes(cat)) return cat;
  if (cat === 'cleaning') return 'toiletries';
  return 'misc';
}
function _aiRefreshStep3() {
  const body = document.getElementById('modalBody');
  if (body && _aiImportParsed) {
    const inner = document.querySelector('.modal-inner');
    if (inner) inner.innerHTML = `<div class="modal-title">AI Import Assistant</div>` + _aiStep3Html(_aiImportParsed);
    else body.innerHTML = _aiStep3Html(_aiImportParsed);
  }
}
function aiRedirectSection(section, dest) {
  if (!_aiSectionDest || !_aiItemState) return;
  _aiSectionDest[section] = dest;
  const defaultCat = dest === 'provisions' ? 'misc' : PART_CATEGORIES[0];
  (_aiItemState[section] || []).forEach(it => { it.category = defaultCat; });
  _aiRefreshStep3();
}
function aiToggleItem(section, idx) {
  if (_aiItemState?.[section]) _aiItemState[section][idx].include = !_aiItemState[section][idx].include;
  const btn = document.getElementById('ai-import-btn');
  if (btn) { const n = _aiCountIncluded(_aiImportParsed); btn.textContent = `Import ${n} ${n===1?'entry':'entries'}`; }
  const row = document.getElementById(`ai-row-${section}-${idx}`);
  if (row) row.style.opacity = _aiItemState[section][idx].include ? '1' : '0.4';
  const cb = document.getElementById(`ai-cb-${section}-${idx}`);
  if (cb) cb.checked = _aiItemState[section][idx].include;
  const hd = document.getElementById(`ai-hd-${section}`);
  if (hd) { const st = _aiItemState[section]; hd.textContent = `${st.filter(s=>s.include).length}/${st.length} selected`; }
}
function aiSetItemCat(section, idx, val) {
  if (_aiItemState?.[section]) _aiItemState[section][idx].category = val;
}
function _aiCountIncluded(parsed) {
  if (!parsed) return 0;
  let n = 0;
  if (_aiItemState?.provisions) n += _aiItemState.provisions.filter(it => it.include).length;
  else if (Array.isArray(parsed.provisions)) n += parsed.provisions.length;
  if (_aiItemState?.spareParts) n += _aiItemState.spareParts.filter(it => it.include).length;
  else if (Array.isArray(parsed.spareParts)) n += parsed.spareParts.length;
  if (Array.isArray(parsed.maintenance) && parsed.maintenance.length) n += parsed.maintenance.length;
  const tl = parsed.documents?.transitLog;
  if (tl && Object.values(tl).some(v => v !== '' && v != null)) n += 1;
  const cu = parsed.documents?.customs;
  if (cu && Object.values(cu).some(v => v !== '' && v != null && !(Array.isArray(v) && !v.length))) n += 1;
  const ins = parsed.documents?.insurance;
  if (ins && Object.values(ins).some(v => v !== '' && v != null)) n += 1;
  if (Array.isArray(parsed.safety?.flares) && parsed.safety.flares.length) n += parsed.safety.flares.length;
  if (Array.isArray(parsed.safety?.lifeRafts) && parsed.safety.lifeRafts.length) n += parsed.safety.lifeRafts.length;
  if (Array.isArray(parsed.systems) && parsed.systems.length) n += parsed.systems.length;
  if (parsed.watermaker) n += 1;
  if (parsed.lpg?.history?.length) n += parsed.lpg.history.length;
  if (parsed.shipyard?.current?.name || parsed.shipyard?.history?.length || parsed.shipyard?.quotes?.length) n += 1;
  if (parsed.upgrades?.seasons?.length) n += parsed.upgrades.seasons.reduce((a, s) => a + (s.items?.length || 0), 0);
  if (parsed.documents?.vessel && Object.values(parsed.documents.vessel).some(v => v)) n += 1;
  return n;
}

function _aiStep1Html() {
  return `
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:12px">
      <label for="ai-photo-input" style="border:0.5px solid var(--sep);border-radius:14px;padding:20px 10px 16px;text-align:center;cursor:pointer;background:var(--surface2);display:block">
        <div style="font-size:30px;margin-bottom:8px">📷</div>
        <div style="font-size:13px;font-weight:600;color:var(--label);margin-bottom:4px">Photo</div>
        <div style="font-size:11px;color:var(--label3)">Take a photo or choose from library</div>
      </label>
      <input type="file" id="ai-photo-input" accept="image/*" style="display:none" onchange="aiImportPhotoSelected(this)">
      <div onclick="aiShowTextInput()" style="border:0.5px solid var(--sep);border-radius:14px;padding:20px 10px 16px;text-align:center;cursor:pointer;background:var(--surface2)">
        <div style="font-size:30px;margin-bottom:8px">📋</div>
        <div style="font-size:13px;font-weight:600;color:var(--label);margin-bottom:4px">Paste text</div>
        <div style="font-size:11px;color:var(--label3)">Copy from spreadsheet or type</div>
      </div>
    </div>
    <div style="font-size:11px;color:var(--label3);margin-bottom:14px;text-align:center">Works with photos of: Transit Log · Insurance · eTEPAY · Victron devices · Spare part boxes · Provisions · Receipts · Maintenance log pages</div>
    <div class="modal-btns">
      <button class="btn btn-s" onclick="hideModal()">Cancel</button>
    </div>`;
}

function aiShowTextInput() {
  const body = document.getElementById('modalBody');
  if (!body) return;
  body.innerHTML = `
    <div class="modal-title">AI Import Assistant</div>
    <div style="font-size:13px;color:var(--label2);margin-bottom:10px">Paste spreadsheet data (Excel, Numbers, Google Sheets) or describe your records.</div>
    <textarea id="ai-import-ta" class="mi" style="height:150px;resize:vertical;font-size:13px;font-family:var(--font)" placeholder="Paste rows here, e.g.:\n2024-10-20  1460  Engine oil  Cape Town\nor describe: 3 oil changes in 2023…">${esc(_aiImportText)}</textarea>
    <div style="font-size:11px;color:var(--label3);margin:6px 0 14px">What can I import? &nbsp;Maintenance log · Provisions · Spare parts · Systems · LPG · Watermaker · Transit Log · eTEPAY · Insurance · Safety</div>
    <div class="modal-btns">
      <button class="btn btn-s" onclick="showAiImportModal()">← Back</button>
      <button class="btn btn-p" onclick="aiImportConvert()">Convert with AI →</button>
    </div>`;
}

function aiImportPhotoSelected(input) {
  const file = input.files?.[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = e => {
    _aiImportPhotoData = e.target.result; // data:[mime];base64,[data]
    const body = document.getElementById('modalBody');
    if (!body) return;
    body.innerHTML = `
      <div class="modal-title">AI Import Assistant</div>
      <div style="text-align:center;margin-bottom:14px">
        <img id="ai-photo-preview" style="max-width:100%;max-height:200px;border-radius:10px;object-fit:contain;border:1px solid var(--sep)">
      </div>
      <div class="modal-btns">
        <button class="btn btn-s" onclick="showAiImportModal()">Retake</button>
        <button class="btn btn-p" onclick="aiImportConvertPhoto(this)">Read with AI →</button>
      </div>`;
    const img = document.getElementById('ai-photo-preview');
    if (img) img.src = _aiImportPhotoData;
  };
  reader.readAsDataURL(file);
}

// Cosmetic progress bar for AI import — stages advance on a fixed timer, not real backend state.
// The AI call is a single request/response with no streaming; the bar is purely heuristic.
function _aiProgressHtml(pct, caption) {
  return `
    <div class="modal-title">AI Import Assistant</div>
    <div style="padding:44px 24px 36px">
      <div style="font-size:13px;font-weight:600;color:var(--label);text-align:center;margin-bottom:16px" id="ai-prog-caption">${esc(caption)}</div>
      <div style="background:var(--surface2);border-radius:99px;height:5px;overflow:hidden">
        <div id="ai-prog-bar" style="height:5px;border-radius:99px;background:var(--blue);width:${pct}%;transition:width .5s ease"></div>
      </div>
    </div>`;
}
// Schedule deferred stage updates; returns a cancel function to clear all pending timers.
function _aiProgressAdvance(stages) {
  const timers = stages.map(({ delay, pct, caption }) =>
    setTimeout(() => {
      const bar = document.getElementById('ai-prog-bar');
      const cap = document.getElementById('ai-prog-caption');
      if (bar) bar.style.width = pct + '%';
      if (cap) cap.textContent = caption;
    }, delay)
  );
  return () => timers.forEach(clearTimeout);
}

async function aiImportConvertPhoto(btn) {
  if (!_aiImportPhotoData) { showToast('No photo selected', true); return; }
  if (btn) { btn.disabled = true; btn.textContent = 'Reading…'; }
  const parts = _aiImportPhotoData.split(',');
  const mediaType = parts[0].match(/data:([^;]+)/)?.[1] || 'image/jpeg';
  const imageData = parts[1] || '';
  const body = document.getElementById('modalBody');
  // Photo path: 4 stages — Uploading / Reading photo / Identifying / Preparing
  // Timings tuned for a typical 5–12 s response; bar caps at 88% until fetch resolves.
  if (body) body.innerHTML = _aiProgressHtml(4, 'Uploading…');
  const cancelProgress = _aiProgressAdvance([
    { delay:  700, pct: 28, caption: 'Reading your photo…' },
    { delay: 2500, pct: 58, caption: 'Identifying items and prices…' },
    { delay: 5000, pct: 88, caption: 'Preparing preview…' },
  ]);
  try {
    const email = localStorage.getItem(EMAIL_KEY);
    const hash  = email ? await emailToKey(email) : '';
    const r = await fetch(`${STORAGE_WORKER_URL}/api/ai-import-photo`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ imageData, mediaType, userHash: hash }),
    });
    if (!r.ok) { const e = await r.json().catch(()=>({})); throw new Error(e.error || `HTTP ${r.status}`); }
    const { result } = await r.json();
    let parsed;
    try { parsed = JSON.parse(result); } catch(e) { throw new Error('Claude returned unparseable JSON — try another photo'); }
    cancelProgress();
    const bar = document.getElementById('ai-prog-bar');
    if (bar) { bar.style.transition = 'width .2s ease'; bar.style.width = '100%'; }
    await new Promise(res => setTimeout(res, 180));
    _aiImportParsed = parsed;
    if (body) body.innerHTML = `<div class="modal-title">AI Import Assistant</div>` + _aiStep3Html(parsed);
  } catch(e) {
    cancelProgress();
    if (body) body.innerHTML = `<div class="modal-title">AI Import Assistant</div>` + _aiStep1Html();
    showToast('Photo import failed: ' + e.message, true);
  }
}

async function aiImportConvert() {
  const ta = document.getElementById('ai-import-ta');
  const text = ta?.value.trim() || '';
  if (!text) { showToast('Paste some data first', true); return; }
  _aiImportText = text;
  const body = document.getElementById('modalBody');
  // Text path: 3 stages — Reading text / Identifying / Preparing (no Upload stage)
  // Timings tuned for a typical 3–8 s response; bar caps at 88% until fetch resolves.
  if (body) body.innerHTML = _aiProgressHtml(4, 'Reading your text…');
  const cancelProgress = _aiProgressAdvance([
    { delay: 1500, pct: 58, caption: 'Identifying items and prices…' },
    { delay: 4000, pct: 88, caption: 'Preparing preview…' },
  ]);
  try {
    const email = localStorage.getItem(EMAIL_KEY);
    const hash  = email ? await emailToKey(email) : '';
    const r = await fetch(`${STORAGE_WORKER_URL}/api/ai-import`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: text, userHash: hash }),
    });
    if (!r.ok) { const e = await r.json().catch(() => ({})); throw new Error(e.error || `HTTP ${r.status}`); }
    const { result } = await r.json();
    let parsed;
    try { parsed = JSON.parse(result); } catch(e) { throw new Error('Claude returned unparseable JSON — try rephrasing your input'); }
    cancelProgress();
    const bar = document.getElementById('ai-prog-bar');
    if (bar) { bar.style.transition = 'width .2s ease'; bar.style.width = '100%'; }
    await new Promise(res => setTimeout(res, 180));
    _aiImportParsed = parsed;
    if (body) body.innerHTML = `<div class="modal-title">AI Import Assistant</div>` + _aiStep3Html(parsed);
  } catch(e) {
    cancelProgress();
    if (body) body.innerHTML = `<div class="modal-title">AI Import Assistant</div>` + _aiStep1Html();
    showToast('AI import failed: ' + e.message, true);
  }
}

function _aiStep3Html(parsed) {
  // Init item state once; preserved across re-renders triggered by aiToggleItem / aiRedirectSection
  if (!_aiSectionDest) _aiSectionDest = { provisions: 'provisions', spareParts: 'spareParts' };
  if (!_aiItemState) _aiItemState = {
    provisions: (parsed.provisions || []).map(e => ({ include: true, category: _normProvCat(e.category) })),
    spareParts: (parsed.spareParts  || []).map(e => ({
      include: true,
      category: PART_CATEGORIES.includes(e.category) ? e.category : PART_CATEGORIES[0],
    })),
  };

  const sections = [];
  const selSty = 'font-size:11px;border:0.5px solid var(--sep);border-radius:6px;padding:2px 6px;background:var(--surface2);color:var(--label2);font-family:var(--font);cursor:pointer;max-width:130px';

  if (Array.isArray(parsed.maintenance) && parsed.maintenance.length) {
    const rows = parsed.maintenance.slice(0, 5).map(e =>
      `<div style="font-size:11px;color:var(--label2);padding:2px 0">✓ ${esc(e.date||'?')} · ${esc(String(e.hours||'?'))}h · ${esc(e.task||'?')}</div>`).join('');
    sections.push(`<div style="margin-bottom:12px">
      <div style="font-size:12px;font-weight:700;color:var(--label);margin-bottom:4px">🔧 Maintenance — ${parsed.maintenance.length} entries <span style="font-weight:400;color:var(--label3)">→ Engine Maintenance tab</span></div>
      ${rows}${parsed.maintenance.length > 5 ? `<div style="font-size:11px;color:var(--label3)">…and ${parsed.maintenance.length - 5} more</div>` : ''}
    </div>`);
  }

  if (Array.isArray(parsed.provisions) && parsed.provisions.length) {
    const states = _aiItemState.provisions;
    const dest   = _aiSectionDest.provisions;
    const inclN  = states.filter(s => s.include).length;
    const destSel = `<select onchange="aiRedirectSection('provisions',this.value)" style="${selSty}">
      <option value="provisions" ${dest==='provisions'?'selected':''}>→ Provisions</option>
      <option value="spareParts" ${dest==='spareParts'?'selected':''}>→ Spare Parts</option>
    </select>`;
    const rows = parsed.provisions.map((e, idx) => {
      const st = states[idx];
      const catOpts = dest === 'provisions'
        ? PROV_CAT_ORDER.map(c => `<option value="${c}" ${st.category===c?'selected':''}>${PROV_CAT_LABELS[c]}</option>`).join('')
        : PART_CATEGORIES.map(c => `<option value="${c}" ${st.category===c?'selected':''}>${esc(c)}</option>`).join('');
      const priceStr = e.price != null ? ` · €${e.price}` : '';
      return `<div id="ai-row-provisions-${idx}" style="display:flex;align-items:center;gap:6px;padding:3px 0;${!st.include?'opacity:0.4;':''}">
        <input id="ai-cb-provisions-${idx}" type="checkbox" ${st.include?'checked':''} onchange="aiToggleItem('provisions',${idx})" style="width:15px;height:15px;cursor:pointer;accent-color:var(--blue);flex-shrink:0">
        <span style="flex:1;font-size:11px;color:var(--label2);overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${esc(e.name||'?')}">${esc(e.name||'?')}${e.qty&&e.qty!==1?` ×${e.qty}`:''}${priceStr}</span>
        <select onchange="aiSetItemCat('provisions',${idx},this.value)" style="${selSty}">${catOpts}</select>
      </div>`;
    }).join('');
    sections.push(`<div style="margin-bottom:12px">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:5px">
        <div style="font-size:12px;font-weight:700;color:var(--label)">🛒 Provisions <span id="ai-hd-provisions" style="font-weight:400;color:var(--label3)">${inclN}/${parsed.provisions.length} selected</span></div>
        ${destSel}
      </div>
      <div style="background:var(--surface2);border-radius:8px;padding:6px 8px">${rows}</div>
    </div>`);
  }

  if (Array.isArray(parsed.spareParts) && parsed.spareParts.length) {
    const states = _aiItemState.spareParts;
    const dest   = _aiSectionDest.spareParts;
    const inclN  = states.filter(s => s.include).length;
    const destSel = `<select onchange="aiRedirectSection('spareParts',this.value)" style="${selSty}">
      <option value="spareParts" ${dest==='spareParts'?'selected':''}>→ Spare Parts</option>
      <option value="provisions" ${dest==='provisions'?'selected':''}>→ Provisions</option>
    </select>`;
    const rows = parsed.spareParts.map((e, idx) => {
      const st = states[idx];
      const catOpts = dest === 'spareParts'
        ? PART_CATEGORIES.map(c => `<option value="${c}" ${st.category===c?'selected':''}>${esc(c)}</option>`).join('')
        : PROV_CAT_ORDER.map(c => `<option value="${c}" ${st.category===c?'selected':''}>${PROV_CAT_LABELS[c]}</option>`).join('');
      return `<div id="ai-row-spareParts-${idx}" style="display:flex;align-items:center;gap:6px;padding:3px 0;${!st.include?'opacity:0.4;':''}">
        <input id="ai-cb-spareParts-${idx}" type="checkbox" ${st.include?'checked':''} onchange="aiToggleItem('spareParts',${idx})" style="width:15px;height:15px;cursor:pointer;accent-color:var(--blue);flex-shrink:0">
        <span style="flex:1;font-size:11px;color:var(--label2);overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${esc(e.name||'?')}">${esc(e.name||'?')} ×${esc(String(e.qty||1))}</span>
        <select onchange="aiSetItemCat('spareParts',${idx},this.value)" style="${selSty}">${catOpts}</select>
      </div>`;
    }).join('');
    sections.push(`<div style="margin-bottom:12px">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:5px">
        <div style="font-size:12px;font-weight:700;color:var(--label)">🔩 Spare Parts <span id="ai-hd-spareParts" style="font-weight:400;color:var(--label3)">${inclN}/${parsed.spareParts.length} selected</span></div>
        ${destSel}
      </div>
      <div style="background:var(--surface2);border-radius:8px;padding:6px 8px">${rows}</div>
    </div>`);
  }

  function docFieldVal(v) { return Array.isArray(v) ? v.join(', ') : String(v); }
  const tlData = parsed.documents?.transitLog;
  const tlFields = tlData ? Object.entries(tlData).filter(([,v]) => v !== '' && v !== null && v !== undefined) : [];
  if (tlFields.length) {
    const TL_DOC_KEYS = {docNumber:'Doc #',issueDate:'Issue Date',validFrom:'Valid From',validUntil:'Valid Until',customsAuthority:'Customs Authority',validityType:'Validity Type',prevDocsCount:'Prev Docs',otherNotes:'Notes',provisions:'Provisions'};
    const TL_VSL_KEYS = {vesselName:'Vessel Name',flag:'Flag',portOfRegistry:'Port of Registry',registrationNumber:'Reg #',callSign:'Call Sign',vesselType:'Type',grossTonnage:'GT',engine:'Engine',lengthLOA:'LOA',yearBuilt:'Year Built',yearFirstReg:'Year First Reg',ownerName:'Owner',holderName:'Holder',address:'Address',telephone:'Tel',email:'Email',afmTin:'AFM/TIN',passportId:'ID/Passport'};
    const docRows = tlFields.filter(([k]) => TL_DOC_KEYS[k]).map(([k,v]) => `<div style="font-size:11px;color:var(--label2);padding:2px 0">✓ ${esc(TL_DOC_KEYS[k])}: ${esc(docFieldVal(v))}</div>`).join('');
    const vslRows = tlFields.filter(([k]) => TL_VSL_KEYS[k]).map(([k,v]) => `<div style="font-size:11px;color:var(--label2);padding:2px 0">✓ ${esc(TL_VSL_KEYS[k])}: ${esc(docFieldVal(v))}</div>`).join('');
    sections.push(`<div style="margin-bottom:12px">
      <div style="font-size:12px;font-weight:700;color:var(--label);margin-bottom:4px">📜 Transit Log — 1 record <span style="font-weight:400;color:var(--label3)">→ Boat Docs → Transit Log</span></div>
      ${docRows?`<div style="font-size:11px;font-weight:600;color:var(--label3);margin:4px 0 2px">Document Info</div>${docRows}`:''}
      ${vslRows?`<div style="font-size:11px;font-weight:600;color:var(--label3);margin:4px 0 2px">Vessel &amp; Owner</div>${vslRows}`:''}
    </div>`);
  }
  const cusData = parsed.documents?.customs;
  const cusFields = cusData ? Object.entries(cusData).filter(([,v]) => v !== '' && v !== null && v !== undefined && !(Array.isArray(v) && !v.length)) : [];
  if (cusFields.length) {
    const CUS_LABELS = {applicationNumber:'App #',applicationDate:'App Date',entryDate:'Entry Date',year:'Year',monthsCovered:'Months',amountPaid:'Amount Paid',paymentCode:'Payment Code',adminFeeCode:'Admin Fee Code',status:'Status',validUntil:'Valid Until',holderName:'Holder',afmTin:'AFM/TIN',customsOffice:'Customs Office',clearanceNumber:'Clearance #',email:'Email',paymentRef:'Payment Ref',passportNumber:'Passport #',phone:'Phone',address:'Address'};
    const preview = cusFields.map(([k,v]) => `<div style="font-size:11px;color:var(--label2);padding:2px 0">✓ ${esc(CUS_LABELS[k]||k)}: ${esc(docFieldVal(v))}</div>`).join('');
    sections.push(`<div style="margin-bottom:12px">
      <div style="font-size:12px;font-weight:700;color:var(--label);margin-bottom:4px">🛃 eTEPAY — 1 record <span style="font-weight:400;color:var(--label3)">→ Boat Docs → eTEPAY</span></div>
      ${preview}
    </div>`);
  }
  const insData = parsed.documents?.insurance;
  const insFields = insData ? Object.entries(insData).filter(([,v]) => v !== '' && v !== null && v !== undefined) : [];
  if (insFields.length) {
    const INS_LABELS = {insurer:'Insurer',certNumber:'Cert #',issueDate:'Issue Date',expiryDate:'Expiry Date',premium:'Premium',personalInjury:'Personal Injury/Death',materialDamage:'Material Damage',pollution:'Pollution',totalSumInsured:'Total Sum Insured',thirdPartyLiability:'Third Party Liability',deductibles:'Deductibles',navigationLimits:'Navigation Limits',specialNotes:'Special Notes'};
    const preview = insFields.map(([k,v]) => `<div style="font-size:11px;color:var(--label2);padding:2px 0">✓ ${esc(INS_LABELS[k]||k)}: ${esc(docFieldVal(v))}</div>`).join('');
    sections.push(`<div style="margin-bottom:12px">
      <div style="font-size:12px;font-weight:700;color:var(--label);margin-bottom:4px">🛡️ Insurance — 1 record <span style="font-weight:400;color:var(--label3)">→ Boat Docs → Insurance</span></div>
      ${preview}
    </div>`);
  }
  const safetyFlares = parsed.safety?.flares;
  if (Array.isArray(safetyFlares) && safetyFlares.length) {
    const rows = safetyFlares.slice(0,5).map(f =>
      `<div style="font-size:11px;color:var(--label2);padding:2px 0">✓ ${esc(f.type||'?')} × ${esc(String(f.qty||1))}${f.expiry?' · '+esc(f.expiry):''}</div>`).join('');
    sections.push(`<div style="margin-bottom:12px">
      <div style="font-size:12px;font-weight:700;color:var(--label);margin-bottom:4px">🛡️ Safety — Flares — ${safetyFlares.length} flare${safetyFlares.length!==1?'s':''} <span style="font-weight:400;color:var(--label3)">→ Safety tab</span></div>
      ${rows}${safetyFlares.length>5?`<div style="font-size:11px;color:var(--label3)">…and ${safetyFlares.length-5} more</div>`:''}
    </div>`);
  }

  const warningsHtml = Array.isArray(parsed._warnings) && parsed._warnings.length
    ? `<div style="margin-bottom:10px;padding:8px 12px;background:rgba(245,158,11,.08);border:0.5px solid #F59E0B;border-radius:8px">
        <div style="font-size:11px;font-weight:700;color:#D97706;margin-bottom:3px">⚠️ Uncertain readings — please verify:</div>
        ${parsed._warnings.map(w=>`<div style="font-size:11px;color:#D97706;padding:1px 0">· ${esc(String(w))}</div>`).join('')}
      </div>`
    : '';

  if (!sections.length) return `
    <div style="text-align:center;padding:24px 0">
      <div style="font-size:28px;margin-bottom:10px">🤔</div>
      <div style="font-size:14px;font-weight:600;color:var(--label)">No data recognised</div>
      <div style="font-size:12px;color:var(--label3);margin-top:6px">Try pasting column headers with your data, or rephrase your description.</div>
    </div>
    <div class="modal-btns"><button class="btn btn-p" onclick="showAiImportModal()">← Try again</button></div>`;

  const total = _aiCountIncluded(parsed);
  return `
    <div style="max-height:300px;overflow-y:auto;margin-bottom:4px">${warningsHtml}${sections.join('')}</div>
    <div class="modal-btns">
      <button class="btn btn-s" onclick="hideModal()">Cancel</button>
      <button id="ai-import-btn" class="btn btn-p" onclick="aiImportApply(this)">Import ${total} ${total===1?'entry':'entries'}</button>
    </div>`;
}

async function aiImportApply(btn) {
  if (_aiImportInProgress || !_aiImportParsed) return;
  _aiImportInProgress = true;
  if (btn) { btn.disabled = true; btn.textContent = 'Importing…'; }
  const p = _aiImportParsed;
  const recStore = p._receiptStore || null;
  const recDate  = p._receiptDate  || null;
  try {
    if (Array.isArray(p.maintenance) && p.maintenance.length) {
      if (!data.maintenance) data.maintenance = { engines:{}, sched:{}, log:[] };
      if (!data.maintenance.log) data.maintenance.log = [];
      p.maintenance.forEach(e => data.maintenance.log.unshift({
        id: uid(), date: e.date||'', hours: String(e.hours||''),
        task: normalizeMaintTask(e.task||''), cost:'',
        notes: e.notes||'', engines: ['port','starboard'],
      }));
    }

    if (!data.provisions) data.provisions = {items:[]};
    if (!data.provisions.items) data.provisions.items = [];
    if (!data.spareParts) data.spareParts = [];

    // Provisions — honour per-item include/category and section-level destination redirect
    const provCounts = { provisions: 0, toSpareParts: 0 };
    if (Array.isArray(p.provisions) && p.provisions.length) {
      const states = _aiItemState?.provisions;
      const dest   = _aiSectionDest?.provisions || 'provisions';
      p.provisions.forEach((e, idx) => {
        if (states && !states[idx]?.include) return;
        const cat = states?.[idx]?.category || _normProvCat(e.category);
        const ph  = (e.price != null || e.store || recStore)
          ? [{ date: e.date||recDate||'', store: e.store||recStore||'', price: e.price!=null ? Number(e.price) : null, qty: Number(e.qty)||1, unit: e.unit||'' }]
          : [];
        if (dest === 'provisions') {
          // AI-imported receipt items go to history-only storage, not the manual planning list
          if (!data.provisions.history) data.provisions.history = [];
          data.provisions.history.push({
            id: uid(), name: e.name||'', qty: Number(e.qty)||0,
            unit: e.unit||'', category: cat,
            lastPrice: e.price!=null ? Number(e.price) : null,
            lastStore: e.store||recStore||null,
            lastPurchaseDate: e.date||recDate||null,
            priceHistory: ph,
            originalText: e.originalText||null,
            importedAt: new Date().toISOString().slice(0,10),
          });
          provCounts.provisions++;
        } else {
          data.spareParts.push({
            id: uid(), desc: e.name||'', pn:'', category: cat,
            qty: Number(e.qty)||1, minQuantity:0,
            unitPrice: e.price!=null ? Number(e.price) : 0,
            location: e.store||recStore||'', notes:'', storeUrl:'',
          });
          provCounts.toSpareParts++;
        }
      });
    }

    // Spare Parts — honour per-item include/category and section-level destination redirect
    const spCounts = { spareParts: 0, toProvisions: 0 };
    if (Array.isArray(p.spareParts) && p.spareParts.length) {
      const states = _aiItemState?.spareParts;
      const dest   = _aiSectionDest?.spareParts || 'spareParts';
      p.spareParts.forEach((e, idx) => {
        if (states && !states[idx]?.include) return;
        const cat = states?.[idx]?.category || (PART_CATEGORIES.includes(e.category) ? e.category : PART_CATEGORIES[0]);
        if (dest === 'spareParts') {
          data.spareParts.push({
            id: uid(), desc: e.name||'', pn:'', category: cat,
            qty: Number(e.qty)||1, minQuantity:0, unitPrice:0,
            location: e.location||'', notes: e.notes||'', storeUrl:'',
          });
          spCounts.spareParts++;
        } else {
          data.provisions.items.push({
            id: uid(), name: e.name||'', qty: Number(e.qty)||0,
            minQty: 0, unit: e.unit||'', category: cat, location: '',
            priceHistory: [], originalText: e.originalText||null,
          });
          spCounts.toProvisions++;
        }
      });
    }

    const tlImport = p.documents?.transitLog;
    if (tlImport && typeof tlImport === 'object') {
      const wd = getTLData(), log = wd.logs[wd.currentLog];
      if (log && !log.archived) {
        ['docNumber','issueDate','validFrom','validUntil','customsAuthority','otherNotes','provisions',
         'vesselName','flag','portOfRegistry','callSign','vesselType','engine','yearBuilt','yearFirstReg',
         'ownerName','holderName','address','telephone','email']
          .forEach(k => { if (tlImport[k] !== undefined && tlImport[k] !== '') log[k] = tlImport[k]; });
        if (tlImport.validityType === 'Unlimited') log.validityType = 'Unlimited (Αόριστη)';
        else if (tlImport.validityType === 'Limited') log.validityType = 'Limited (Ορισμένη)';
        if (tlImport.prevDocsCount != null && tlImport.prevDocsCount !== '') log.prevDocCount = String(tlImport.prevDocsCount);
        if (tlImport.registrationNumber) log.regNumber   = tlImport.registrationNumber;
        if (tlImport.grossTonnage)       log.gt          = tlImport.grossTonnage;
        if (tlImport.lengthLOA)          log.loa         = tlImport.lengthLOA;
        if (tlImport.afmTin)             log.afm         = tlImport.afmTin;
        if (tlImport.passportId)         log.idNumber    = tlImport.passportId;
      }
    }
    const cusImport = p.documents?.customs;
    if (cusImport && typeof cusImport === 'object') {
      if (!data.documents) data.documents = {};
      if (!data.documents.customs) data.documents.customs = {};
      const C = data.documents.customs;
      ['applicationNumber','applicationDate','entryDate','year','amountPaid','paymentCode','adminFeeCode','status','validUntil','holderName','customsOffice','clearanceNumber','email','paymentRef']
        .forEach(k => { if (cusImport[k] !== undefined && cusImport[k] !== '') C[k] = cusImport[k]; });
      if (cusImport.afmTin)         C.afm                 = cusImport.afmTin;
      if (cusImport.passportNumber) C.ownerPassportNumber = cusImport.passportNumber;
      if (cusImport.phone)          C.ownerPhone          = cusImport.phone;
      if (cusImport.address)        C.ownerAddress        = cusImport.address;
      if (Array.isArray(cusImport.monthsCovered) && cusImport.monthsCovered.length) C.monthsCovered = cusImport.monthsCovered.join(',');
      else if (cusImport.monthsCovered) C.monthsCovered = cusImport.monthsCovered;
    }
    const insImport = p.documents?.insurance;
    if (insImport && typeof insImport === 'object') {
      if (!data.documents) data.documents = {};
      if (!data.documents.insurance) data.documents.insurance = {};
      const I = data.documents.insurance;
      if (insImport.insurer)            I.insurer            = insImport.insurer;
      if (insImport.certNumber)         I.certNumber         = insImport.certNumber;
      if (insImport.issueDate)          I.issueDate          = insImport.issueDate;
      if (insImport.expiryDate)         I.expiryDate         = insImport.expiryDate;
      if (insImport.premium != null && insImport.premium !== '') I.premium = String(insImport.premium);
      if (insImport.personalInjury)     I.maxPersonalInjury  = insImport.personalInjury;
      if (insImport.materialDamage)     I.maxMaterial        = insImport.materialDamage;
      if (insImport.pollution)          I.maxPollution       = insImport.pollution;
      if (insImport.totalSumInsured)    I.totalSumInsured    = insImport.totalSumInsured;
      if (insImport.thirdPartyLiability) I.thirdPartyLiability = insImport.thirdPartyLiability;
      if (insImport.deductibles)        I.deductibles        = insImport.deductibles;
      if (insImport.navigationLimits)   I.navigationLimits   = insImport.navigationLimits;
      if (insImport.specialNotes)       I.specialNotes       = insImport.specialNotes;
    }
    if (Array.isArray(p.safety?.flares) && p.safety.flares.length) {
      if (!data.safety) data.safety = {flares:[],lifeRafts:[]};
      if (!data.safety.flares) data.safety.flares = [];
      p.safety.flares.forEach(f => data.safety.flares.push({
        id:uid(), type:f.type||'', qty:Number(f.qty)||1, expiry:f.expiry||'', notes:f.notes||''
      }));
    }
    if (Array.isArray(p.safety?.lifeRafts) && p.safety.lifeRafts.length) {
      if (!data.safety) data.safety = { flares: [], lifeRafts: [] };
      if (!data.safety.lifeRafts) data.safety.lifeRafts = [];
      p.safety.lifeRafts.forEach(r => data.safety.lifeRafts.push({
        id: uid(), brand: r.brand || '', model: r.model || '',
        persons: Number(r.persons) || 0, expiry: r.expiry || '',
        serialNumber: r.serialNumber || '', notes: r.notes || '',
        revisions: Array.isArray(r.revisions) ? r.revisions : []
      }));
    }
    if (Array.isArray(p.systems) && p.systems.length) {
      if (!data.systems) data.systems = [];
      p.systems.forEach(s => data.systems.push({
        id: uid(), cat: s.cat || 'Electronics', category: s.cat || 'Electronics',
        make: s.make || '', model: s.model || '', serialNumber: s.serialNumber || s.serial_no || '',
        location: s.location || '', notes: s.notes || '', installDate: s.installDate || s.install_date || '',
        lastService: '', warrantyExpiry: s.warrantyExpiry || '', manualUrl: s.manualUrl || s.manual_url || '', photos: [],
        purchasePriceUsd:      s.purchasePriceUsd || (s.purchase_price_usd ? Number(s.purchase_price_usd) : null),
        purchasePriceOriginal: s.purchasePriceOriginal || s.purchase_price_original || '',
        invoiceRef:            s.invoiceRef || s.invoice || '',
        supplier:              s.supplier || '',
        partCode:              s.partCode || s.part_code || '',
      }));
    }
    if (p.watermaker && typeof p.watermaker === 'object') {
      if (!data.watermaker) data.watermaker = { currentReading: 0, lastChangeReading: 0, targetHours: 60, charcoalChangedDate: null, inventory: { micron20: 0, micron5: 0, charcoal: 0 } };
      const wm = p.watermaker;
      if (wm.currentReading != null)    data.watermaker.currentReading    = Number(wm.currentReading) || 0;
      if (wm.lastChangeReading != null) data.watermaker.lastChangeReading = Number(wm.lastChangeReading) || 0;
      if (wm.targetHours != null)       data.watermaker.targetHours       = Number(wm.targetHours) || 60;
      if (wm.inventory) {
        if (!data.watermaker.inventory) data.watermaker.inventory = { micron20: 0, micron5: 0, charcoal: 0 };
        if (wm.inventory.micron20 != null) data.watermaker.inventory.micron20 = Number(wm.inventory.micron20) || 0;
        if (wm.inventory.micron5  != null) data.watermaker.inventory.micron5  = Number(wm.inventory.micron5)  || 0;
        if (wm.inventory.charcoal != null) data.watermaker.inventory.charcoal = Number(wm.inventory.charcoal) || 0;
      }
      if (Array.isArray(wm.micronHistory) && wm.micronHistory.length) {
        if (!data.watermaker.micronHistory) data.watermaker.micronHistory = [];
        wm.micronHistory.forEach(h => data.watermaker.micronHistory.push({
          id: uid(), date: h.date || '', location: h.location || '', reading: Number(h.reading) || 0
        }));
      }
    }
    if (Array.isArray(p.lpg?.history) && p.lpg.history.length) {
      if (!data.lpg) data.lpg = { bottles: [], history: [] };
      if (!data.lpg.history) data.lpg.history = [];
      p.lpg.history.forEach(h => data.lpg.history.push({
        id: uid(), date: h.date || '', location: h.location || '',
        bottles: Number(h.bottles) || 0, kg: Number(h.kg) || 0,
        pricePerKg: Number(h.pricePerKg) || 0, notes: h.notes || ''
      }));
    }
    if (p.shipyard && typeof p.shipyard === 'object') {
      if (!data.shipyard) data.shipyard = { current: {}, quotes: [], history: [] };
      if (p.shipyard.current) {
        ['name','location','startDate','endDate','actualCost','depositPaid','balanceDue','notes','contact','website']
          .forEach(k => { if (p.shipyard.current[k]) data.shipyard.current[k] = p.shipyard.current[k]; });
      }
      if (Array.isArray(p.shipyard.history)) p.shipyard.history.forEach(h => data.shipyard.history.push({ ...h, id: uid() }));
      if (Array.isArray(p.shipyard.quotes))  p.shipyard.quotes.forEach(q  => data.shipyard.quotes.push({ ...q,  id: uid() }));
    }
    if (Array.isArray(p.upgrades?.seasons) && p.upgrades.seasons.length) {
      if (!data.upgrades) data.upgrades = { seasons: [] };
      if (!data.upgrades.seasons) data.upgrades.seasons = [];
      p.upgrades.seasons.forEach(s => data.upgrades.seasons.push({
        id: uid(), name: s.name || 'Imported', location: s.location || '',
        items: Array.isArray(s.items)
          ? s.items.map(it => ({ id: uid(), text: it.text || '', cost: it.cost || '', checked: false }))
          : []
      }));
    }
    if (p.documents?.vessel && typeof p.documents.vessel === 'object') {
      if (!data.documents) data.documents = {};
      if (!data.documents.vessel) data.documents.vessel = {};
      ['vesselName','officialNumber','imoNumber','callSign','hailingPort','flagRegistry','hullMaterial',
       'boatType','loa','breadth','depth','grossTonnage','netTonnage','yearCompleted','placeBuilt',
       'engine','owners','managingOwner','issueDate','expiryDate']
        .forEach(k => { if (p.documents.vessel[k]) data.documents.vessel[k] = p.documents.vessel[k]; });
    }

    migrateData();
    await save(); await pushToCloud();
    renderApp();
    _aiImportParsed = null;
    _aiSectionDest  = null;
    _aiItemState    = null;

    // Build accurate success summary using actual destination counts
    const lines = [];
    if (p.maintenance?.length)    lines.push(`${p.maintenance.length} maintenance ${p.maintenance.length===1?'entry':'entries'} → Engine Maintenance`);
    if (provCounts.provisions)    lines.push(`${provCounts.provisions} provision ${provCounts.provisions===1?'item':'items'} → Provisions (Insights)`);
    if (provCounts.toSpareParts)  lines.push(`${provCounts.toSpareParts} provision ${provCounts.toSpareParts===1?'item':'items'} redirected → Spare Parts`);
    if (spCounts.spareParts)      lines.push(`${spCounts.spareParts} spare ${spCounts.spareParts===1?'part':'parts'} → Spare Parts`);
    if (spCounts.toProvisions)    lines.push(`${spCounts.toProvisions} part${spCounts.toProvisions===1?'':'s'} redirected → Provisions`);
    if (tlImport  && Object.values(tlImport).some(v=>v))  lines.push('Transit Log updated → Boat Docs');
    if (cusImport && Object.values(cusImport).some(v=>v)) lines.push('eTEPAY updated → Boat Docs');
    if (insImport && Object.values(insImport).some(v=>v)) lines.push('Insurance updated → Boat Docs');
    if (p.safety?.flares?.length)    lines.push(`${p.safety.flares.length} ${p.safety.flares.length===1?'flare':'flares'} added → Safety`);
    if (p.safety?.lifeRafts?.length) lines.push(`${p.safety.lifeRafts.length} life raft${p.safety.lifeRafts.length!==1?'s':''} → Safety`);
    if (p.systems?.length)           lines.push(`${p.systems.length} system${p.systems.length!==1?'s':''} → Systems`);
    if (p.watermaker)                lines.push('Watermaker updated → Water Maker');
    if (p.lpg?.history?.length)      lines.push(`${p.lpg.history.length} LPG refill${p.lpg.history.length!==1?'s':''} → LPG`);
    if (p.shipyard?.current?.name)   lines.push(`Shipyard: ${p.shipyard.current.name} → Shipyard`);
    if (p.upgrades?.seasons?.length) lines.push(`${p.upgrades.seasons.reduce((n,s)=>n+(s.items?.length||0),0)} repair items → Upgrades`);
    if (p.documents?.vessel?.vesselName) lines.push('Vessel document updated → Boat Docs');

    const modalBody = document.getElementById('modalBody');
    if (modalBody) modalBody.innerHTML = `
      <div style="text-align:center;padding:28px 16px 8px">
        <div style="font-size:52px;margin-bottom:10px">✅</div>
        <div style="font-size:17px;font-weight:700;color:var(--label);margin-bottom:14px">Import successful!</div>
        <div style="text-align:left;background:var(--surface2);border-radius:10px;padding:12px 14px;margin-bottom:4px">
          ${lines.map(l=>`<div style="font-size:13px;color:var(--label2);padding:3px 0">✓ ${esc(l)}</div>`).join('')}
        </div>
      </div>
      <div class="modal-btns">
        <button class="btn btn-p" onclick="hideModal()">Done</button>
      </div>`;
  } catch(e) {
    if (btn) { btn.disabled = false; btn.textContent = 'Import'; }
    showToast('Import failed: ' + e.message, true);
  } finally {
    _aiImportInProgress = false;
  }
}

// ── Tab Settings ──────────────────────────────────────────────
function getTabSettings() {
  if (!data.settings) data.settings = {};
  if (!data.settings.tabs || !data.settings.tabs.length)
    data.settings.tabs = CUSTOMIZABLE_TABS.map((t,i) => ({id:t.id, visible:true, order:i}));
  if (!data.settings.docSubtabs || !data.settings.docSubtabs.length)
    data.settings.docSubtabs = DOC_SUBTAB_DEFS.map(t => ({id:t.id, visible:true}));
  if (!data.settings.homeTab) data.settings.homeTab = 'clearance';
  return data.settings;
}
function getVisibleTabs() {
  const s = getTabSettings();
  const tabMap = Object.fromEntries(s.tabs.map(t=>[t.id,t]));
  const vis = CUSTOMIZABLE_TABS
    .filter(t => tabMap[t.id]?.visible !== false)
    .sort((a,b) => (tabMap[a.id]?.order??999)-(tabMap[b.id]?.order??999));
  return [...vis, TABS.find(t=>t.id==='settings')];
}
function getVisibleDocSubtabs() {
  const s = getTabSettings();
  const subMap = Object.fromEntries(s.docSubtabs.map(t=>[t.id,t]));
  const ALL = {vessel:'🚢 Vessel Doc', insurance:'🛡️ Insurance', customs:'🛃 eTEPAY', transitlog:'📜 Transit Log', photos:'📷 Document Photos'};
  const result = {vessel:'🚢 Vessel Doc'};
  for (const id of ['insurance','customs','transitlog','photos'])
    if (subMap[id]?.visible !== false) result[id] = ALL[id];
  return result;
}
function applyHomeTab() {
  const s = getTabSettings();
  const vis = getVisibleTabs();
  const visIds = new Set(vis.map(t=>t.id));
  ui.tab = (s.homeTab && visIds.has(s.homeTab)) ? s.homeTab : (vis[0]?.id||'documents');
}

// ── Tab Edit Modal ─────────────────────────────────────────────
let _tabEditState = null, _tabEditDragId = null, _tabEditTouchState = null;

function showTabsEditModal() {
  const s = getTabSettings();
  _tabEditState = {
    tabs: s.tabs.map(t=>({...t})),
    docSubtabs: s.docSubtabs.map(t=>({...t})),
    homeTab: s.homeTab,
  };
  showModal('My Tabs', _buildTabEditHtml());
}
function _buildTabEditHtml() {
  const {tabs, docSubtabs, homeTab} = _tabEditState;
  const tabMap = Object.fromEntries(tabs.map(t=>[t.id,t]));
  const subMap = Object.fromEntries(docSubtabs.map(t=>[t.id,t]));
  const sorted = [...CUSTOMIZABLE_TABS].sort((a,b)=>(tabMap[a.id]?.order??999)-(tabMap[b.id]?.order??999));
  const docsVis = tabMap['documents']?.visible !== false;
  const sw = (checked, onchg) => `<label style="position:relative;display:inline-block;width:36px;height:20px;flex-shrink:0;cursor:pointer">
    <input type="checkbox" ${checked?'checked':''} onchange="${onchg}" style="opacity:0;width:0;height:0;position:absolute">
    <span style="position:absolute;inset:0;background:${checked?'var(--blue)':'#d1d5db'};border-radius:10px;transition:background .15s">
      <span style="position:absolute;width:16px;height:16px;background:#fff;border-radius:50%;top:2px;left:${checked?'18':'2'}px;transition:left .15s;box-shadow:0 1px 3px rgba(0,0,0,.2)"></span>
    </span></label>`;
  const rows = sorted.map(t => {
    const ts = tabMap[t.id]||{id:t.id,visible:true,order:999};
    const on = ts.visible !== false;
    const isHome = ts.id === homeTab && on;
    return `<div data-tab-edit-id="${t.id}" draggable="true"
      ondragstart="tabEditDragStart(event,'${t.id}')" ondragover="tabEditDragOver(event,'${t.id}')"
      ondragleave="tabEditDragLeave(event)" ondrop="tabEditDrop(event,'${t.id}')" ondragend="tabEditDragEnd()"
      style="display:flex;align-items:center;gap:10px;padding:10px 12px;border-bottom:0.5px solid var(--sep);background:var(--surface)">
      <span class="prov-grip" ontouchstart="tabEditTouchStart(event,'${t.id}')" style="font-size:16px;color:var(--label3);flex-shrink:0;touch-action:none;cursor:grab;user-select:none;-webkit-user-select:none">⠿</span>
      <span style="font-size:16px;flex-shrink:0">${t.icon}</span>
      <div style="flex:1;display:flex;align-items:center;gap:6px;min-width:0">
        <span style="font-size:13px;font-weight:500;color:var(--label)">${esc(t.label)}</span>
        ${isHome?`<span style="font-size:10px;font-weight:700;color:#fff;background:var(--blue);padding:1px 7px;border-radius:8px">Home</span>`:''}
      </div>
      <div style="display:flex;align-items:center;gap:8px">
        ${on&&!isHome?`<button onclick="tabEditSetHome('${t.id}')" style="font-size:10px;color:var(--blue);background:none;border:1px solid var(--blue);border-radius:8px;padding:2px 7px;font-family:var(--font);cursor:pointer;white-space:nowrap">Set home</button>`:''}
        ${sw(on,`tabEditToggle('${t.id}',this.checked)`)}
      </div>
    </div>
    ${t.id==='documents'&&docsVis ? DOC_SUBTAB_DEFS.map(st=>{
      const sts = subMap[st.id]||{id:st.id,visible:true};
      const son = sts.visible !== false;
      return `<div style="display:flex;align-items:center;gap:10px;padding:8px 12px 8px 46px;border-bottom:0.5px solid var(--sep);background:var(--surface2)">
        <span style="font-size:14px">${st.icon}</span>
        <span style="font-size:12px;color:var(--label2);flex:1">${esc(st.label)}</span>
        ${sw(son,`tabEditToggleSub('${st.id}',this.checked)`)}
      </div>`;
    }).join('') : ''}`;
  }).join('');
  return `
    <div style="font-size:11px;color:var(--label3);margin-bottom:8px">Drag ⠿ to reorder · toggle to show/hide · tap Set home</div>
    <div style="max-height:52vh;overflow-y:auto;border:1px solid var(--sep);border-radius:10px;overflow-x:hidden">${rows}</div>
    <div class="modal-btns">
      <button class="btn btn-s" onclick="hideModal()">Cancel</button>
      <button class="btn btn-p" onclick="saveTabSettings()">Save</button>
    </div>`;
}
function _refreshTabEditModal() {
  const body = document.getElementById('modalBody');
  if (body) body.innerHTML = `<div class="modal-title">My Tabs</div>` + _buildTabEditHtml();
}
function tabEditToggle(id, checked) {
  if (!_tabEditState) return;
  const ts = _tabEditState.tabs.find(t=>t.id===id); if (!ts) return;
  if (!checked) {
    const visCount = _tabEditState.tabs.filter(t=>t.visible!==false).length;
    if (visCount <= 3) { showToast('Keep at least 3 tabs visible', true); _refreshTabEditModal(); return; }
    ts.visible = false;
    if (_tabEditState.homeTab === id) {
      const next = _tabEditState.tabs.find(t=>t.id!==id&&t.visible!==false);
      _tabEditState.homeTab = next?.id || _tabEditState.tabs[0]?.id;
    }
  } else { ts.visible = true; }
  _refreshTabEditModal();
}
function tabEditToggleSub(id, checked) {
  if (!_tabEditState) return;
  const st = _tabEditState.docSubtabs.find(t=>t.id===id); if (st) st.visible = checked;
  _refreshTabEditModal();
}
function tabEditSetHome(id) {
  if (!_tabEditState) return;
  const ts = _tabEditState.tabs.find(t=>t.id===id);
  if (!ts || ts.visible===false) return;
  _tabEditState.homeTab = id;
  _refreshTabEditModal();
}
function saveTabSettings() {
  if (!_tabEditState) return;
  if (!data.settings) data.settings = {};
  data.settings.tabs = _tabEditState.tabs.map(t=>({...t}));
  data.settings.docSubtabs = _tabEditState.docSubtabs.map(t=>({...t}));
  data.settings.homeTab = _tabEditState.homeTab;
  _tabEditState = null;
  save();
  hideModal();
  const vis = getVisibleTabs();
  if (!vis.find(t=>t.id===ui.tab)) ui.tab = data.settings.homeTab || vis[0]?.id || 'documents';
  renderApp();
  document.getElementById('mainContent').innerHTML = renderSettings();
}

// ── Tab Edit Drag ──────────────────────────────────────────────
function tabEditDragStart(e, id) {
  if (e.target.closest('button,input,select,a')) { e.preventDefault(); return; }
  _tabEditDragId = id; e.dataTransfer.effectAllowed='move'; e.dataTransfer.setData('text/plain',id);
  setTimeout(()=>document.querySelector(`[data-tab-edit-id="${id}"]`)?.classList.add('prov-dragging'),0);
}
function tabEditDragOver(e, id) {
  if (!_tabEditDragId||_tabEditDragId===id) return;
  e.preventDefault(); e.dataTransfer.dropEffect='move';
  document.querySelectorAll('.prov-drag-over').forEach(el=>el.classList.remove('prov-drag-over'));
  e.currentTarget.classList.add('prov-drag-over');
}
function tabEditDragLeave(e) { if (!e.currentTarget.contains(e.relatedTarget)) e.currentTarget.classList.remove('prov-drag-over'); }
function tabEditDrop(e, targetId) {
  e.preventDefault();
  document.querySelectorAll('.prov-drag-over,.prov-dragging').forEach(el=>el.classList.remove('prov-drag-over','prov-dragging'));
  const fromId=_tabEditDragId; _tabEditDragId=null; _tabEditDoReorder(fromId, targetId);
}
function tabEditDragEnd() {
  document.querySelectorAll('.prov-drag-over,.prov-dragging').forEach(el=>el.classList.remove('prov-drag-over','prov-dragging'));
  _tabEditDragId=null;
}
function tabEditTouchStart(e, id) {
  e.preventDefault();
  const touch=e.touches[0], row=e.currentTarget.closest('[data-tab-edit-id]'); if (!row) return;
  const rect=row.getBoundingClientRect(), clone=row.cloneNode(true);
  Object.assign(clone.style,{position:'fixed',left:rect.left+'px',top:rect.top+'px',width:rect.width+'px',opacity:'0.85',zIndex:'9999',pointerEvents:'none',outline:'2px dashed var(--blue)',borderRadius:'4px',background:'var(--surface)',boxShadow:'0 4px 16px rgba(0,0,0,.18)',transition:'none'});
  document.body.appendChild(clone); row.style.opacity='0.3';
  _tabEditTouchState={id,row,clone,offsetY:touch.clientY-rect.top,over:null};
  document.addEventListener('touchmove',_tabEditTouchMove,{passive:false});
  document.addEventListener('touchend',_tabEditTouchEnd);
}
function _tabEditTouchMove(e) {
  e.preventDefault(); if (!_tabEditTouchState) return;
  const touch=e.touches[0],{clone,offsetY}=_tabEditTouchState;
  clone.style.top=(touch.clientY-offsetY)+'px'; clone.style.display='none';
  const under=document.elementFromPoint(touch.clientX,touch.clientY); clone.style.display='';
  const targetRow=under?.closest('[data-tab-edit-id]');
  document.querySelectorAll('.prov-drag-over').forEach(el=>el.classList.remove('prov-drag-over'));
  if (targetRow&&targetRow!==_tabEditTouchState.row){targetRow.classList.add('prov-drag-over');_tabEditTouchState.over=targetRow;}
  else{_tabEditTouchState.over=null;}
}
function _tabEditTouchEnd() {
  document.removeEventListener('touchmove',_tabEditTouchMove); document.removeEventListener('touchend',_tabEditTouchEnd);
  if (!_tabEditTouchState) return;
  const{id,row,clone,over}=_tabEditTouchState; _tabEditTouchState=null;
  clone.remove(); row.style.opacity='';
  document.querySelectorAll('.prov-drag-over').forEach(el=>el.classList.remove('prov-drag-over'));
  if (over) _tabEditDoReorder(id, over.dataset.tabEditId);
}
function _tabEditDoReorder(fromId, toId) {
  if (!fromId||!toId||fromId===toId||!_tabEditState) return;
  const tabs = _tabEditState.tabs;
  const sorted = [...CUSTOMIZABLE_TABS]
    .map(t => tabs.find(s=>s.id===t.id)||{id:t.id,visible:true,order:999})
    .sort((a,b)=>a.order-b.order);
  const fi=sorted.findIndex(t=>t.id===fromId), ti=sorted.findIndex(t=>t.id===toId);
  if (fi===-1||ti===-1) return;
  const [moved]=sorted.splice(fi,1); sorted.splice(ti,0,moved);
  sorted.forEach((t,i)=>{ const ts=tabs.find(s=>s.id===t.id); if(ts) ts.order=i; });
  _refreshTabEditModal();
}

function renderSettings() {
  if (!ui.settingsOpen) ui.settingsOpen = {};
  const email    = localStorage.getItem(EMAIL_KEY) || '—';
  const rawTs    = localStorage.getItem(LAST_SYNC_KEY);
  const lastSync = timeAgo(rawTs);
  const dotColor = {synced:'#22C55E',syncing:'#F59E0B',offline:'#EF4444',idle:'#9ca3af'}[syncStatus]||'#9ca3af';
  const dotLabel = {synced:'Synced',syncing:'Syncing…',offline:'Error',idle:'Not synced'}[syncStatus]||'—';

  function settingsRow(id, label, rightHtml, expandedHtml) {
    const open = !!ui.settingsOpen[id];
    const toggle = `ui.settingsOpen=ui.settingsOpen||{};ui.settingsOpen['${id}']=!${open};document.getElementById('mainContent').innerHTML=renderSettings()`;
    return `<div onclick="${toggle}" style="display:flex;align-items:center;justify-content:space-between;padding:12px 14px;border-bottom:0.5px solid var(--sep);cursor:pointer;user-select:none;-webkit-user-select:none">
        <span style="font-size:13px;font-weight:500;color:var(--label)">${label}</span>
        <div style="display:flex;align-items:center;gap:6px">${rightHtml||''}<span style="color:var(--label3);font-size:13px">${open?'▲':'▼'}</span></div>
      </div>
      ${open&&expandedHtml?`<div style="background:var(--surface2);border-bottom:0.5px solid var(--sep)">${expandedHtml}</div>`:''}`;
  }

  const subRow = (content, border=true) =>
    `<div style="padding:10px 14px${border?';border-bottom:0.5px solid var(--sep)':''}">${content}</div>`;

  const syncRight = `<span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${dotColor};flex-shrink:0"></span><span style="font-size:12px;color:var(--label3)">${dotLabel}</span>`;
  const syncExpanded =
    subRow(`<div style="font-size:11px;color:var(--label3);margin-bottom:2px">Account</div><div style="font-size:13px;color:var(--label)">${esc(email)}</div>`) +
    subRow(`<div style="font-size:11px;color:var(--label3);margin-bottom:2px">Last synced</div><div style="font-size:13px;color:var(--label)">${esc(lastSync)}</div>`) +
    subRow(`<button class="btn btn-s btn-sm" onclick="syncNow()">↕ Sync Now</button>`) +
    subRow(`<div style="font-size:11px;color:var(--label3);margin-bottom:6px">Use this if your data looks outdated on this device.</div><button class="btn btn-s btn-sm" onclick="forceResync()" style="color:var(--red)">↺ Reset local data &amp; re-sync</button>`, false);

  const backupExpanded =
    subRow(`<div style="font-size:11px;color:var(--label3);margin-bottom:6px">Save to iCloud Drive. Restore on any device.</div><button class="btn btn-s btn-sm" onclick="saveBackup()">⬇ Export Encrypted Backup</button>`) +
    subRow(`<div style="font-size:11px;color:var(--label3);margin-bottom:6px">Import a previously exported encrypted backup file.</div><button class="btn btn-p btn-sm" onclick="document.getElementById('backupFile').click()">⬆ Restore from Backup</button>`, false);

  const acctRight = `<span style="font-size:12px;color:var(--label3);max-width:150px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(email)}</span>`;
  const acctExpanded =
    subRow(`<button class="btn btn-d btn-sm" onclick="logOut()">Log out / Switch account</button>`) +
    subRow(`<button class="btn btn-d btn-sm" onclick="deleteAccount()">🗑 Delete My Account</button>`, false);

  return `
    <div style="margin-bottom:16px;border-radius:16px;overflow:hidden;background:linear-gradient(135deg,#1a5fa8,#378ADD);padding:20px 16px 16px">
      <div style="font-size:28px;margin-bottom:6px">🤖</div>
      <div style="font-size:16px;font-weight:700;color:#fff;margin-bottom:4px">AI Import Assistant</div>
      <div style="font-size:12px;color:rgba(255,255,255,0.82);margin-bottom:14px;line-height:1.5">Take a photo or paste text — AI reads your documents and imports data automatically</div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:10px">
        <button onclick="showAiImportModal()" style="background:#fff;color:#1a5fa8;border:none;border-radius:10px;padding:10px 8px;font-size:13px;font-weight:600;font-family:var(--font);cursor:pointer">📷 Photo</button>
        <button onclick="showAiImportTextMode()" style="background:rgba(255,255,255,0.18);color:#fff;border:1px solid rgba(255,255,255,0.35);border-radius:10px;padding:10px 8px;font-size:13px;font-weight:600;font-family:var(--font);cursor:pointer">📋 Paste text</button>
      </div>
      <div style="font-size:11px;color:rgba(255,255,255,0.55);text-align:center">Transit Log · Insurance · eTEPAY · Provisions · Spare Parts · Safety · more</div>
    </div>
    <div class="card" style="margin-bottom:16px">
      <div style="display:flex;align-items:center;justify-content:space-between;padding:12px 14px;border-bottom:0.5px solid var(--sep)">
        <div style="display:flex;align-items:center;gap:8px">
          <span style="font-size:20px">⊞</span>
          <div>
            <div style="font-size:13px;font-weight:600;color:var(--label)">My tabs</div>
            <div style="font-size:11px;color:var(--label3)">Choose tabs to show · set home tab · reorder</div>
          </div>
        </div>
        <button onclick="showTabsEditModal()" class="btn btn-s btn-sm">Edit</button>
      </div>
      <div style="padding:10px 14px;display:flex;flex-wrap:wrap;gap:4px;align-items:center">
        ${(()=>{const s=getTabSettings();const tabMap=Object.fromEntries(s.tabs.map(t=>[t.id,t]));const vis=CUSTOMIZABLE_TABS.filter(t=>tabMap[t.id]?.visible!==false).sort((a,b)=>(tabMap[a.id]?.order??999)-(tabMap[b.id]?.order??999));const prev=vis.slice(0,5);const more=vis.length-prev.length;return prev.map(t=>`<span style="font-size:11px;color:var(--label2);background:var(--surface2);border-radius:8px;padding:3px 8px">${t.icon} ${esc(t.label)}</span>`).join('')+(more>0?`<span style="font-size:11px;color:var(--label3)"> · and ${more} more</span>`:'');})()}
      </div>
    </div>
    <div class="card" style="margin-bottom:16px;overflow:hidden">
      ${settingsRow('sync',    'Cloud sync',          syncRight,  syncExpanded)}
      ${settingsRow('backup',  'Backup &amp; restore', '',         backupExpanded)}
      <div onclick="document.getElementById('jsonImportFile').click()" style="display:flex;align-items:center;justify-content:space-between;padding:12px 14px;border-bottom:0.5px solid var(--sep);cursor:pointer;user-select:none;-webkit-user-select:none">
        <span style="font-size:13px;font-weight:500;color:var(--label)">Import from JSON</span>
        <span style="color:var(--label3);font-size:15px">›</span>
      </div>
      ${settingsRow('account', 'Account',             acctRight,  acctExpanded)}
    </div>
    <div style="text-align:center;padding:4px 0 16px">
      <button onclick="showPrivacyPolicy()" style="background:none;border:none;color:var(--label3);font-family:var(--font);font-size:13px;cursor:pointer;text-decoration:underline">Privacy Policy</button>
      <span style="color:var(--label3);font-size:13px"> · </span>
      <button onclick="showTermsOfUse()" style="background:none;border:none;color:var(--label3);font-family:var(--font);font-size:13px;cursor:pointer;text-decoration:underline">Terms of Use</button>
    </div>`;
}

// ═══════════════════════════════════════════════════════════
//  INIT
// ═══════════════════════════════════════════════════════════

async function init() {
  if (new URLSearchParams(window.location.search).has('new')) {
    window.history.replaceState({}, '', window.location.pathname);
    startNewSetup('');
    return;
  }
  const hasSalt   = !!localStorage.getItem(SALT_KEY);
  const hasVerify = !!localStorage.getItem(VERIFY_KEY);
  if (hasSalt && hasVerify) {
    renderLockScreen();   // returning user same device — just password
  } else {
    renderLoginScreen();  // new device or cleared data — email + password
  }
}

if (new URLSearchParams(window.location.search).get('clearcache') === '1') {
  localStorage.removeItem('bm_enc');
  window.history.replaceState({}, '', window.location.pathname);
}
window.addEventListener('DOMContentLoaded', init);
