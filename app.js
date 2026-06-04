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
  photoSub:'vesselDoc', crewOpen:null, sysOpen:null, sysTab:'All',
  partsSearch:'', partsFilter:'All', alertsOpen:false, maintShowAll:false, maintTaskFilter:'All',
  provisionsSub:'all', tlDetailId:null
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
      const KNOWN = ['documents','crew','transitLog','spareParts','maintenance','maintenance2','shipyard','systems','watermaker','lpg','provisions','schengen','winterization','upgrades'];
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
  // Maintenance — only overdue tasks
  getEngines().forEach(eid => {
    MAINT_TASKS.forEach(task => {
      const s = calcMaintStatus(task, eid);
      if (s.color === 'red') {
        alerts.push({color:'red', days: task.intHrs ? -(parseFloat(s.label)||0) : -1, text:`${engLabel(eid)}: ${task.task} — ${s.label}`});
      }
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
      <div style="display:flex;align-items:center;gap:12px;margin-bottom:20px;padding:14px;background:var(--surface);border-radius:12px;border:0.5px solid var(--sep);"><input type="checkbox" id="privacyConsent" onchange="var b=document.getElementById('setupSubmitBtn');if(b)b.disabled=!this.checked;" style="width:22px;height:22px;flex-shrink:0;cursor:pointer;display:inline-block!important;visibility:visible!important;appearance:checkbox!important;-webkit-appearance:checkbox!important;"><span style="font-size:14px;color:var(--label);line-height:1.4;">I have read and agree to the <button type="button" ontouchstart="event.preventDefault();showPrivacyPolicy();" onclick="showPrivacyPolicy();" style="background:none;border:none;color:#185FA5;font-family:var(--font);font-size:14px;cursor:pointer;padding:0;line-height:inherit;vertical-align:baseline;">Privacy Policy</button></span></div>
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
  {id:'provisions', icon:'🛒', label:'Provisions'},
  {id:'watermaker', icon:'💧', label:'Water Maker'},
  {id:'lpg',        icon:'🔥', label:'LPG'},
  {id:'maint',      icon:'🔧', label:'Engine Maintenance'},
  {id:'schengen',   icon:'🛂', label:'Schengen'},
  {id:'shipyard',   icon:'⚓', label:'Shipyard'},
  {id:'winter',     icon:'❄️', label:'Winterize'},
  {id:'upgrades',   icon:'🔧', label:'Upgrades & Repairs'},
  {id:'parts',      icon:'🔩', label:'Spare Parts'},
  {id:'systems',    icon:'🔌', label:'Systems'},
  {id:'settings',   icon:'⚙️', label:'Settings'},
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
      ${TABS.map(t=>`<button class="tab-btn ${ui.tab===t.id?'active':''}" onclick="showTab('${t.id}')">${t.icon} ${t.label}</button>`).join('')}
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
      case 'crew':       mc.innerHTML = renderCrew(); break;
      case 'shipyard':    mc.innerHTML = renderShipyard(); break;
      case 'watermaker':  mc.innerHTML = renderWatermaker(); break;
      case 'lpg':         mc.innerHTML = renderLpg(); break;
      case 'provisions':  mc.innerHTML = renderProvisions(); break;
      case 'maint':       mc.innerHTML = renderMaintenance(); break;
      case 'upgrades':  mc.innerHTML = renderUpgrades(); break;
      case 'schengen':  mc.innerHTML = renderSchengen(); break;
      case 'parts':     mc.innerHTML = renderParts(); break;
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
  const SUBS = {vessel:'🚢 Vessel Doc', insurance:'🛡️ Insurance', customs:'🛃 eTEPAY', transitlog:'📜 Transit Log', photos:'📷 Document Photos'};
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
          <td style="white-space:nowrap"><button class="btn btn-s btn-xs" onclick="editVesselDocHistory(${i})">✏️</button> <button class="btn btn-d btn-xs" onclick="removeVesselDocHistory(${i})">✕</button></td></tr>`
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
          <td>${esc(fmtDateEU(r.expiry)||r.expiry||'')}</td><td style="white-space:nowrap"><button class="btn btn-s btn-xs" onclick="editInsuranceHistory(${i})">✏️</button> <button class="btn btn-d btn-xs" onclick="removeInsuranceRenewal(${i})">✕</button></td></tr>`
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
            <td style="white-space:nowrap"><button class="btn btn-s btn-xs" onclick="editCustomsHistory(${i})">✏️</button> <button class="btn btn-d btn-xs" onclick="removeCustomsRenewal(${i})">✕</button></td>
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
          : 'background:var(--surface2);color:var(--label2);border:1.5px solid var(--sep);border-radius:10px;padding:3px 10px;font-size:11px;font-weight:600;font-family:var(--font);cursor:pointer'}">${q.selected ? '✓ Selected' : 'Select'}</button>
        <button onclick="editQuote(${i})" style="background:none;border:none;padding:4px 5px;cursor:pointer;font-size:13px;color:var(--label3)">✏️</button>
      </div>
    </div>`).join('') : `<div style="padding:18px 14px;color:var(--label3);font-size:13px">No quotes yet — tap + Add quote</div>`;

  const card2 = `
    <div class="sec-hd" style="display:flex;align-items:center;justify-content:space-between">
      Quote comparison
      <button onclick="showAddQuote()" style="background:var(--surface);border:1.5px solid var(--sep);border-radius:16px;padding:4px 12px;font-size:12px;font-weight:600;font-family:var(--font);cursor:pointer;color:var(--label)">+ Add quote</button>
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
        <button onclick="editShipyardHistory(${i})" style="background:none;border:none;padding:4px 5px;cursor:pointer;font-size:13px;color:var(--label3);flex-shrink:0">✏️</button>
      </div>
    </div>`;
  }).join('') : `<div style="padding:18px 14px;color:var(--label3);font-size:13px">No past seasons yet</div>`;

  const card3 = `
    <div class="sec-hd" style="display:flex;align-items:center;justify-content:space-between">
      Past seasons
      <button onclick="showAddShipyardHistory()" style="background:var(--surface);border:1.5px solid var(--sep);border-radius:16px;padding:4px 12px;font-size:12px;font-weight:600;font-family:var(--font);cursor:pointer;color:var(--label)">+ Add</button>
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
      <button onclick="if(confirm('Remove this quote?')){hideModal();removeQuote(${i})}" style="background:#FCEBEB;border:1.5px solid #F09595;color:#A32D2D;border-radius:10px;padding:8px 14px;font-family:var(--font);font-size:14px;font-weight:600;cursor:pointer;margin-right:auto">🗑 Delete</button>
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
      <button onclick="if(confirm('Remove this season?')){hideModal();removeShipyardHistory(${i})}" style="background:#FCEBEB;border:1.5px solid #F09595;color:#A32D2D;border-radius:10px;padding:8px 14px;font-family:var(--font);font-size:14px;font-weight:600;cursor:pointer;margin-right:auto">🗑 Delete</button>
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
  { id:'mt_oil',      task:'Engine oil & filter',                intHrs:150,  intDays:null, intLabel:'Every 150h' },
  { id:'mt_sailoil',  task:'Sail drive gear oil',                intHrs:150,  intDays:null, intLabel:'Every 150h' },
  { id:'mt_ffuel',    task:'Fuel filters (primary & secondary)', intHrs:250,  intDays:null, intLabel:'Every 250h' },
  { id:'mt_impeller', task:'Impeller',                           intHrs:250,  intDays:null, intLabel:'Every 250h' },
  { id:'mt_belts_ins', task:'Inspect & adjust belt tension',      intHrs:250,  intDays:null, intLabel:'Every 250h' },
  { id:'mt_belts_rep', task:'Replace belts',                      intHrs:1000, intDays:null, intLabel:'Every 1000h' },
  { id:'mt_coolant',  task:'Yanmar coolant',                     intHrs:null, intDays:365,  intLabel:'Every 12 months' },
  { id:'mt_hex',      task:'Heat exchanger service',             intHrs:1000, intDays:null, intLabel:'Every 1000h' },
  { id:'mt_valve',    task:'Valve clearance',                    intHrs:1000, intDays:null, intLabel:'Every 1000h' },
  { id:'mt_rawpump',  task:'Raw water pump',                     intHrs:1000, intDays:null, intLabel:'Every 1000h' },
  { id:'mt_sdseals',  task:'Sail drive oil seals',               intHrs:1000, intDays:null, intLabel:'Every 1000h' },
];

function maintTaskKeywords(taskId) {
  return {
    mt_oil:      ['oil filter','lube filter','engine oil','oil change','lube oil','crankcase'],
    mt_sailoil:  ['sail drive oil','saildrive oil','gear oil','saildrive','sail drive'],
    mt_ffuel:    ['fuel filter'],
    mt_impeller: ['impeller'],
    mt_belts_ins: ['inspect belt','adjust belt','belt tension','belt inspect','belt adjust'],
    mt_belts_rep: ['replace belt','belt replace','new belt'],
    mt_coolant:  ['coolant','antifreeze','fresh water coolant'],
    mt_hex:      ['heat exchanger'],
    mt_valve:    ['valve clearance','valve'],
    mt_rawpump:  ['raw water pump','sea water pump','cooling water pump'],
    mt_sdseals:  ['oil seal','saildrive seal','sail drive seal'],
  }[taskId] || [];
}

const MAINT_CANONICAL_TASKS = [
  'Engine oil change','Oil filter change','Gear oil change','Impeller replacement',
  'Diesel fuel filter change','Coolant change','Belt inspection / tensioning','Belt replacement',
  'Raw water pump replacement','Heat exchanger service','Saildrive service',
  'Valve clearance','Cleaned raw water strainer',
];
const MAINT_TASK_MAP = {
  'Engine oil PT/STBD + filter':'Engine oil change',
  'Engine oil PT/STBD':'Engine oil change',
  'Engine oil & filter PT/STBD':'Engine oil change',
  'Engine oil & filter - winterising':'Engine oil change',
  '50hr service PT/STBD':'Engine oil change',
  'Engine filters PT/STBD':'Oil filter change',
  'First & second fuel filters PT/STBD':'Oil filter change',
  'Gear oil PT/STBD':'Gear oil change',
  'Gear oil - whole exchange':'Gear oil change',
  'Changed gear oil PT/STBD':'Gear oil change',
  'Gear oil STBD/Port':'Gear oil change',
  'Gear oil PT/STBD - 2 times full':'Gear oil change',
  'Impeller PT/STBD':'Impeller replacement',
  'Impeller only STBD':'Impeller replacement',
  'Replaced impeller both sides - both were good':'Impeller replacement',
  'Impeller changed PT/STBD':'Impeller replacement',
  'Diesel fuel filters PT/STBD':'Diesel fuel filter change',
  'Diesel fuel filters':'Diesel fuel filter change',
  'Secondary diesel filters':'Diesel fuel filter change',
  'Racor fuel water filter Separ':'Diesel fuel filter change',
  'Seaform filter priming':'Diesel fuel filter change',
  'Yanmar coolant':'Coolant change',
  'New Yanmar coolant':'Coolant change',
  'Yanmar coolant - whole change':'Coolant change',
  'Inspect and adjust belt tensioning':'Belt inspection / tensioning',
  'Inspect & adjust belt tension':'Belt inspection / tensioning',
  'Belt replacement PT':'Belt replacement',
  'Belts changed PT/STBD':'Belt replacement',
  'Replace belts':'Belt replacement',
  'Water pump replacement - leak in port engine':'Raw water pump replacement',
  'New STBD water pump':'Raw water pump replacement',
  'Replaced STBD raw water pump':'Raw water pump replacement',
  'Water pump lip seal PT/STBD':'Raw water pump replacement',
  'Clean heat exchanger':'Heat exchanger service',
  'Heat exchanger service':'Heat exchanger service',
  'New saildrive shafts PT/STBD':'Saildrive service',
  'Exchange new saildrive thru hulls':'Saildrive service',
  'Saildrive internal anodes':'Saildrive service',
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
  const engHours = data.maintenance?.engines?.[eid]?.hours || 0;
  const entry    = lastMaintEntry(task.id, eid);
  if (task.intDays) {
    if (!entry) return { color:'red', label:'Never done' };
    const daysLeft = Math.ceil(((parseISODate(entry.date)||new Date(entry.date)).getTime() + task.intDays*86400000 - Date.now()) / 86400000);
    const color = daysLeft <= 0 ? 'red' : daysLeft <= task.intDays*0.25 ? 'orange' : 'green';
    return { color, label: daysLeft <= 0 ? `${Math.abs(daysLeft)}d overdue` : `${daysLeft}d left` };
  }
  const lastHrs  = entry ? (parseFloat(entry.hours)||0) : 0;
  const remaining = lastHrs === 0 ? (task.intHrs - engHours) : (lastHrs + task.intHrs - engHours);
  const color = remaining <= 0 ? 'red' : remaining <= task.intHrs*0.25 ? 'orange' : 'green';
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

function renderMaintenance() {
  const isCat = data.meta.hullType === 'catamaran';
  const eids  = getEngines();
  const eLbl  = {port:'Port', starboard:'Stbd', main:'Engine'};
  // ── Hours ──
  const hoursHtml = `<div class="maint-hours-grid ${isCat?'cat':''}">
    ${eids.map(eid => {
      const h = data.maintenance?.engines?.[eid]?.hours || 0;
      return `<div class="card">
        <div class="card-hd">${isCat?eLbl[eid]+' ':''}Engine Hours</div>
        <div class="hours-box">
          <div class="hours-num" id="hnum-${eid}">${h}</div><div class="hours-lbl">hours</div>
          <div class="hours-edit">
            <input class="h-input" type="number" value="${h}" min="0"
              oninput="var el=document.getElementById('hnum-${eid}');if(el)el.textContent=this.value||0"
              onblur="setHours('${eid}',this.value)">
          </div>
        </div>
      </div>`;
    }).join('')}
  </div>`;
  // ── Coming up ──
  const colorRank = {red:2, orange:1, green:0};
  const taskRows = MAINT_TASKS.map(task => {
    const statuses = eids.map(eid => ({eid, ...calcMaintStatus(task, eid)}));
    const worst = statuses.reduce((a,b) => (colorRank[b.color]||0) > (colorRank[a.color]||0) ? b : a);
    return {task, statuses, worstColor: worst.color};
  });
  const showAll = ui.maintShowAll;
  const visible = showAll ? taskRows : taskRows.filter(r => r.worstColor !== 'green');
  const hiddenN = taskRows.filter(r => r.worstColor === 'green').length;
  const comingRows = visible.map(({task, statuses}) =>
    `<div class="maint-row2">
      <div class="maint-task-name">${esc(task.task)}<span class="maint-int-lbl">${esc(task.intLabel)}</span></div>
      <div style="display:flex;gap:6px;flex-wrap:wrap">
        ${statuses.map(s => `<span class="msb msb-${s.color}">${isCat?eLbl[s.eid]+' ':''}${esc(s.label)}</span>`).join('')}
      </div>
    </div>`
  ).join('');
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
  const logRows = filtered.map(({e, origIdx}, fi) => {
    const engBadges = isCat ? (e.engines||[]).map(eid =>
      `<span style="font-size:10px;font-weight:700;padding:1px 5px;border-radius:4px;background:var(--surface2);color:var(--label3);margin-left:4px">${eLbl[eid]||eid}</span>`
    ).join('') : '';
    return `<tr>
      <td style="color:var(--label3);font-size:11px;white-space:nowrap">${fi+1}</td>
      <td style="white-space:nowrap">${esc(e.date)}</td>
      <td style="white-space:nowrap">${esc(String(e.hours))}</td>
      <td>${esc(e.task)}${engBadges}</td>
      <td>${esc(e.cost||'')}</td>
      <td>${esc(e.notes||'')}</td>
      <td style="white-space:nowrap">
        <button class="btn btn-s btn-xs" onclick="editMaintEntry(${origIdx})" style="margin-right:4px">✏</button>
        <button class="btn btn-d btn-xs" onclick="removeMaintEntry(${origIdx})">✕</button>
      </td>
    </tr>`;
  }).join('') || `<tr><td colspan="7" style="color:var(--label3);padding:12px">${logFilter==='All'?'No entries yet':'No entries for this task'}</td></tr>`;
  const logHtml = `
    <div class="sec-hd">Maintenance Log</div>
    <div class="btn-row">
      <button class="btn btn-p btn-sm" onclick="showAddMaintEntry()">+ Add entry</button>
    </div>
    ${filterPills}
    <div class="card"><div style="overflow-x:auto">
      <table class="tbl"><thead><tr><th>#</th><th>Date</th><th>Hours</th><th>Task</th><th>Cost</th><th>Notes</th><th></th></tr></thead>
      <tbody>${logRows}</tbody></table>
    </div></div>`;
  return hoursHtml + comingUpHtml + logHtml;
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
    <div style="margin:0 12px 10px;padding:10px 14px;background:rgba(255,59,48,.1);border:1.5px solid var(--red);border-radius:10px;font-size:13px;color:var(--red);font-weight:600">
      ⚠️ ${warnings.join(' · ')}
    </div>` : '';
  const emptyMsg = !hasData ? `
    <div style="margin:20px 12px;padding:16px;background:var(--surface);border:1.5px solid var(--sep);border-radius:12px;text-align:center;color:var(--label3);font-size:14px">
      Tap ⚙ Edit travellers to set up
    </div>` : '';
  const statusCard = hasData ? `
    <div style="margin:0 12px 10px;background:var(--surface);border:1.5px solid var(--sep);border-radius:14px;overflow:hidden">
      <div style="display:grid;grid-template-columns:1fr 1fr;min-width:0;width:100%">
        ${sd.persons.map((p,i)=>renderSchengenPersonStatus(p,i)).join('')}
      </div>
    </div>` : '';
  const logCard = hasData ? renderSchengenLog(sd) : '';
  return `<div style="background:#f2f2f7;min-height:100%;padding-bottom:80px">
    <div style="display:flex;align-items:center;justify-content:space-between;padding:12px 12px 8px">
      <div style="font-size:17px;font-weight:700">🛂 Schengen</div>
      <button onclick="showSchengenEdit()" style="background:var(--surface);border:1.5px solid var(--sep);border-radius:20px;padding:6px 14px;font-size:13px;font-weight:600;font-family:var(--font);color:var(--label);cursor:pointer">⚙ Edit travellers</button>
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
    const CC = {'European Union':'EU','United States':'US','Japan':'JP','United Kingdom':'GB','Australia':'AU'};
    const label = [pp.flag, pp.country ? (CC[pp.country] || pp.country.slice(0,2).toUpperCase()) : ''].filter(Boolean).join(' ') || '?';
    const active = pi === activePassIdx;
    return `<button onclick="setSchengenPassport(${idx},${pi})" style="background:${active?'var(--blue)':'var(--surface2)'};color:${active?'#fff':'var(--label)'};border:1.5px solid ${active?'var(--blue)':'var(--sep)'};border-radius:8px;padding:3px 6px;font-size:11px;cursor:pointer;line-height:1.4;font-family:var(--font);white-space:nowrap">${label}</button>`;
  }).join('');
  const statusBadge = seamanActive
    ? `<span style="background:#F59E0B;color:#fff;font-size:10px;font-weight:700;padding:2px 7px;border-radius:10px">Seaman's Book — Greece</span>`
    : `<span style="background:${inStatus?'var(--green)':'var(--sep)'};color:${inStatus?'#fff':'var(--label2)'};font-size:10px;font-weight:700;padding:2px 7px;border-radius:10px">${inStatus?'In Schengen':'Outside'}</span>`;
  const seamanWarning = seamanActive ? `<div style="margin:6px 0 8px;padding:8px 10px;background:rgba(245,158,11,.12);border:1px solid #F59E0B;border-radius:8px">
    <div style="font-size:11px;font-weight:700;color:#D97706;margin-bottom:2px">Register passport entry before flying</div>
    <div style="font-size:11px;color:#D97706">You entered Greece on a Seaman's Book. Visit customs/immigration to add a passport entry stamp before departing by air.</div>
  </div>` : '';
  return `<div style="padding:14px 10px;min-width:0;overflow:hidden;${borderRight}">
    <div style="font-size:13px;font-weight:700;margin-bottom:6px">${esc(p.name||'—')}</div>
    <div style="margin-bottom:${seamanActive?'0':'8px'}">${statusBadge}</div>
    ${seamanWarning}
    ${isEU ? `<div style="font-size:11px;color:var(--green);font-weight:600;margin-bottom:10px">🇪🇺 EU Passport · No limit</div>` : `
      <div style="display:flex;justify-content:center;margin-bottom:8px">
        <div style="width:60px;height:60px;border-radius:50%;border:4px solid ${circleColor};display:flex;flex-direction:column;align-items:center;justify-content:center">
          <div style="font-size:17px;font-weight:800;color:${circleColor};line-height:1">${Math.abs(remaining)}</div>
          <div style="font-size:9px;color:${overstayed?'var(--red)':'var(--label3)'};line-height:1.2">${overstayed?'over!':'days left'}</div>
        </div>
      </div>
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
      <button onclick="showSchengenCheckOut(${idx})" style="flex:1;background:var(--surface2);color:var(--label);border:1.5px solid var(--sep);border-radius:8px;padding:7px 2px;font-size:11px;font-weight:600;font-family:var(--font);cursor:pointer">Check Out</button>
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
      <button onclick="showSchengenEditEntry(${idx},'${e.id}')" style="background:none;border:none;padding:2px 3px;cursor:pointer;font-size:12px;color:var(--label3);flex-shrink:0">✏️</button>
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
  return `<div style="margin:0 12px 16px;background:var(--surface);border:1.5px solid var(--sep);border-radius:14px;overflow:hidden">
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
  const inInactive = activeStyle+'background:var(--surface2);color:var(--label);border:1.5px solid var(--sep)';
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
      <div id="sch-seaman-warn" style="display:none;margin-top:8px;padding:8px 10px;background:rgba(245,158,11,.12);border:1px solid #F59E0B;border-radius:8px;font-size:12px;color:#D97706;font-weight:500">⚠ Before flying out of Greece, visit customs/immigration to register a passport entry stamp.</div>
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
      <button onclick="if(confirm('Delete this entry?')){hideModal();deleteSchengenEntry(${personIdx},'${entryId}')}" style="background:#FCEBEB;border:1.5px solid #F09595;color:#A32D2D;border-radius:10px;padding:8px 14px;font-family:var(--font);font-size:14px;font-weight:600;cursor:pointer;margin-right:auto">🗑 Delete</button>
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
      <div style="background:var(--surface);border:1.5px solid var(--sep);border-radius:14px;padding:16px;margin-bottom:12px;overflow:hidden">
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
    ${personsHtml}
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
    ? `<div style="margin:0 0 10px;padding:10px 14px;background:rgba(255,149,0,.1);border:1.5px solid var(--orange);border-radius:10px;font-size:13px;color:var(--orange);font-weight:600">⚠ 5 &amp; 20 micron filters — change recommended in ${Math.max(0,target-hoursUsed)}h</div>` : '';
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
            <button onclick="wmUpdateReading()" style="background:var(--surface2);border:1.5px solid var(--sep);border-radius:14px;padding:3px 10px;font-size:12px;font-weight:600;font-family:var(--font);cursor:pointer;color:var(--label)">Update</button>
          </div>
        </div>
        <div style="padding:8px 0;border-top:1px solid var(--sep)">
          <div style="display:flex;align-items:center;justify-content:space-between">
            <div style="font-size:13px;color:var(--label2)">Reading at last filter change</div>
            <div style="display:flex;align-items:center;gap:8px">
              <span style="font-size:14px;font-weight:600">${wm.lastChangeReading||0}h</span>
              <button onclick="wmUpdateLastChange()" style="background:var(--surface2);border:1.5px solid var(--sep);border-radius:14px;padding:3px 10px;font-size:12px;font-weight:600;font-family:var(--font);cursor:pointer;color:var(--label)">Update</button>
            </div>
          </div>
          ${!(wm.lastChangeReading) ? `<div style="font-size:11px;color:var(--label3);margin-top:3px">Tap Update to set the reading from your last filter change</div>` : ''}
        </div>
        <div style="display:flex;gap:8px;margin-top:8px">
          <button onclick="wmEditTarget()" style="flex:1;background:var(--surface2);border:1.5px solid var(--sep);border-radius:10px;padding:9px 8px;font-size:12px;font-weight:600;font-family:var(--font);cursor:pointer;color:var(--label)">Edit target (${target}h)</button>
          <button onclick="wmChangeFilters()" style="flex:1;background:var(--blue);border:none;border-radius:10px;padding:9px 8px;font-size:12px;font-weight:700;font-family:var(--font);cursor:pointer;color:#fff">Change Filters</button>
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
          <span>Changed ${charChangedStr} <button onclick="wmEditCharcoalDate()" style="background:none;border:none;padding:0 2px;cursor:pointer;font-size:12px;color:var(--label3);vertical-align:middle">✏️</button></span><span>Due ${charDueStr}</span>
        </div>
        <button onclick="wmChangeCharcoal()" style="width:100%;background:var(--surface2);border:1.5px solid var(--sep);border-radius:10px;padding:9px;font-size:13px;font-weight:600;font-family:var(--font);cursor:pointer;color:var(--label)">Change Charcoal Filter</button>
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
          // Deduplicate by reading and date, exclude currentReading as a history row
          const seen = new Set();
          const clean = (wm.micronHistory||[]).filter(r => {
            const key = `${r.reading}|${r.date}`;
            if (seen.has(key) || r.reading === (wm.currentReading||0)) return false;
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
          // Most recent: lasted = currentReading - its reading
          const mostRecent = byReading[byReading.length-1];
          if (mostRecent) lastedMap[mostRecent.reading] = Math.max(0, (wm.currentReading||0) - (mostRecent.reading||0));
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
              <button onclick="wmEditMicronHistory(${origIdx})" style="background:none;border:none;padding:2px 4px;cursor:pointer;font-size:12px;color:var(--label3)">✏️</button>
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
              <button onclick="wmEditCharcoalHistory(${i})" style="background:none;border:none;padding:2px 4px;cursor:pointer;font-size:12px;color:var(--label3)">✏️</button>
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
      <button onclick="if(confirm('Delete this filter change record?')){hideModal();wmDeleteMicronHistory(${i})}" style="background:#FCEBEB;border:1.5px solid #F09595;color:#A32D2D;border-radius:10px;padding:8px 14px;font-family:var(--font);font-size:14px;font-weight:600;cursor:pointer;margin-right:auto">🗑 Delete</button>
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
      <button onclick="if(confirm('Delete this charcoal change record?')){hideModal();wmDeleteCharcoalHistory(${i})}" style="background:#FCEBEB;border:1.5px solid #F09595;color:#A32D2D;border-radius:10px;padding:8px 14px;font-family:var(--font);font-size:14px;font-weight:600;cursor:pointer;margin-right:auto">🗑 Delete</button>
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
  const warn = full <= 1 ? `<div style="margin:0 0 10px;padding:10px 14px;background:rgba(255,59,48,.1);border:1.5px solid var(--red);border-radius:10px;font-size:13px;color:var(--red);font-weight:600">⚠ Only ${full} bottle${full===1?'':'s'} remaining — consider refilling soon</div>` : '';

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
      <button onclick="lpgEditHistory(${origIdx})" style="background:none;border:none;padding:2px 4px;cursor:pointer;font-size:12px;color:var(--label3)">✏️</button>
    </div>`;
  }).join('');

  return `<div style="padding:12px">
    <div style="display:flex;justify-content:flex-end;margin-bottom:8px">
      <button onclick="lpgAddFill()" style="background:var(--blue);color:#fff;border:none;border-radius:14px;padding:5px 14px;font-size:13px;font-weight:600;font-family:var(--font);cursor:pointer">+ New Fill</button>
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
          <button onclick="lpgEditBottles()" style="flex:1;background:var(--surface2);border:1.5px solid var(--sep);border-radius:10px;padding:9px 8px;font-size:12px;font-weight:600;font-family:var(--font);cursor:pointer;color:var(--label)">Edit bottles</button>
          <button onclick="lpgUseBottle()" style="flex:1;background:var(--blue);border:none;border-radius:10px;padding:9px 8px;font-size:12px;font-weight:700;font-family:var(--font);cursor:pointer;color:#fff">Used a bottle</button>
        </div>
      </div>
    </div>
    ${priceCard}
    <div class="card">
      <div style="display:flex;align-items:center;justify-content:space-between;padding:10px 14px 6px">
        <span style="font-size:14px;font-weight:700">Refill history</span>
        <button onclick="lpgAddFill()" style="background:var(--blue);color:#fff;border:none;border-radius:14px;padding:4px 12px;font-size:12px;font-weight:600;font-family:var(--font);cursor:pointer">+ Add entry</button>
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
      ${isEdit?`<button onclick="if(confirm('Delete this refill entry?')){hideModal();lpgDeleteHistory(${idx})}" style="background:#FCEBEB;border:1.5px solid #F09595;color:#A32D2D;border-radius:10px;padding:8px 14px;font-family:var(--font);font-size:14px;font-weight:600;cursor:pointer;margin-right:auto">🗑 Delete</button>`:''}
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
      <button onclick="lpgBottleToggle(${i})" style="background:${b.full?'rgba(52,199,89,.15)':'var(--surface2)'};color:${b.full?'var(--green)':'var(--label3)'};border:1.5px solid ${b.full?'var(--green)':'var(--sep)'};border-radius:14px;padding:3px 10px;font-size:12px;font-weight:600;font-family:var(--font);cursor:pointer">${b.full?'Full':'Empty'}</button>
      <button onclick="lpgBottleRemove(${i})" style="background:none;border:none;padding:2px 6px;cursor:pointer;font-size:14px;color:var(--label3)">✕</button>
    </div>`).join('');
  showModal('Edit Bottles', `
    <div>${rows}</div>
    <div style="display:flex;align-items:center;gap:8px;margin-top:10px">
      <input class="mi" id="lpg-new-kg" type="number" min="1" placeholder="kg size" style="flex:1">
      <button onclick="lpgBottleAdd()" style="background:var(--blue);color:#fff;border:none;border-radius:14px;padding:6px 12px;font-size:12px;font-weight:600;font-family:var(--font);cursor:pointer">+ Add bottle</button>
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
    <button onclick="lpgMarkUsed(${b.i})" style="display:flex;align-items:center;gap:10px;width:100%;background:var(--surface2);border:1.5px solid var(--sep);border-radius:10px;padding:10px 12px;margin-bottom:8px;cursor:pointer;font-family:var(--font)">
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

  // Shopping list — items below min, across all categories
  const needed = items.filter(it => it.minQty > 0 && it.qty < it.minQty)
    .sort((a,b) => PROV_CAT_ORDER.indexOf(a.category) - PROV_CAT_ORDER.indexOf(b.category));
  const shoppingCard = needed.length ? `
    <div style="background:rgba(251,146,60,.12);border:1.5px solid #fb923c;border-radius:14px;padding:10px 14px;margin-bottom:12px">
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:8px">
        <span style="font-size:14px;font-weight:700">🛍 Shopping list</span>
        <span style="background:#fb923c;color:#fff;border-radius:10px;padding:1px 8px;font-size:11px;font-weight:700">${needed.length}</span>
      </div>
      ${needed.map(it=>`
        <div style="display:flex;align-items:center;gap:8px;padding:4px 0">
          <input type="checkbox" onchange="provMarkBought('${it.id}',this.checked)" style="width:16px;height:16px;cursor:pointer;accent-color:#fb923c">
          <span style="flex:1;font-size:13px">${esc(it.name)}</span>
          <span style="font-size:12px;color:#fb923c;font-weight:600">need ${it.minQty - it.qty} more</span>
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
      const low = it.minQty > 0 && it.qty < it.minQty;
      const badge = it.minQty > 0
        ? (low ? `<span style="background:rgba(239,68,68,.12);color:#ef4444;border-radius:6px;padding:1px 6px;font-size:10px;font-weight:600">Low</span>`
                : `<span style="background:rgba(34,197,94,.12);color:#22c55e;border-radius:6px;padding:1px 6px;font-size:10px;font-weight:600">OK</span>`)
        : '';
      const qtyColor = low ? '#ef4444' : '#22c55e';
      const unitLabel = it.unit ? ` ${esc(it.unit)}` : '';
      const dimmed = it.bought ? 'opacity:0.4;' : '';
      return `<div data-prov-id="${it.id}" draggable="true" ondragstart="provDragStart(event,'${it.id}')" ondragover="provDragOver(event,'${it.id}')" ondragleave="provDragLeave(event)" ondrop="provDrop(event,'${it.id}')" ondragend="provDragEnd()" style="display:flex;align-items:center;gap:6px;padding:8px 14px;border-top:1px solid var(--sep);${dimmed}">
        <span class="prov-grip" ontouchstart="provTouchStart(event,'${it.id}')">⠿</span>
        <input type="checkbox" ${it.bought?'checked':''} onchange="provToggleBought(${origIdx},this.checked)" style="width:17px;height:17px;flex-shrink:0;cursor:pointer;accent-color:var(--blue)">
        <div style="flex:1;min-width:0">
          <div style="font-size:13px;font-weight:600;${it.bought?'color:var(--label3);':'color:var(--label);'}">${esc(it.name)}</div>
          <div style="font-size:11px;color:var(--label3)">${it.location?esc(it.location)+' · ':''}min ${it.minQty}${unitLabel}</div>
        </div>
        <div style="display:flex;align-items:center;gap:4px;flex-shrink:0">
          <button onclick="provAdj(${origIdx},-1)" style="background:var(--surface2);border:1.5px solid var(--sep);border-radius:8px;width:26px;height:26px;font-size:16px;line-height:1;cursor:pointer;color:var(--label);font-family:var(--font)">−</button>
          <span style="font-size:15px;font-weight:700;color:${qtyColor};min-width:22px;text-align:center">${it.qty}</span>
          <button onclick="provAdj(${origIdx},1)" style="background:var(--surface2);border:1.5px solid var(--sep);border-radius:8px;width:26px;height:26px;font-size:16px;line-height:1;cursor:pointer;color:var(--label);font-family:var(--font)">+</button>
        </div>
        ${badge}
        <button onclick="provEdit(${origIdx})" style="background:none;border:none;padding:2px 4px;cursor:pointer;font-size:12px;color:var(--label3)">✏️</button>
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
    <div style="display:flex;justify-content:flex-end;gap:8px;margin-bottom:8px">
      <button onclick="provUncheckAll()" style="background:var(--surface2);color:var(--label);border:1.5px solid var(--sep);border-radius:14px;padding:5px 14px;font-size:13px;font-weight:600;font-family:var(--font);cursor:pointer">Uncheck All</button>
      <button onclick="provAddModal()" style="background:var(--blue);color:#fff;border:none;border-radius:14px;padding:5px 14px;font-size:13px;font-weight:600;font-family:var(--font);cursor:pointer">+ Add item</button>
    </div>
    ${exampleBanner}
    <div class="subtab-bar" style="margin-bottom:10px">${subtabs}</div>
    ${shoppingCard}
    ${catCards}${emptyMsg}
  </div>`;
}

function setProvSub(s) {
  ui.provisionsSub = s;
  document.getElementById('mainContent').innerHTML = renderProvisions();
}

function provAdj(idx, delta) {
  const prov = getProvisionsData();
  if (!prov.items[idx]) return;
  prov.items[idx].qty = Math.max(0, (prov.items[idx].qty || 0) + delta);
  save(); document.getElementById('mainContent').innerHTML = renderProvisions();
}
function provToggleBought(idx, checked) {
  const prov = getProvisionsData();
  if (!prov.items[idx]) return;
  prov.items[idx].bought = checked;
  save(); document.getElementById('mainContent').innerHTML = renderProvisions();
}
function provUncheckAll() {
  const prov = getProvisionsData();
  prov.items.forEach(it => { it.bought = false; });
  save(); document.getElementById('mainContent').innerHTML = renderProvisions();
}

function provMarkBought(id, checked) {
  if (!checked) return;
  const prov = getProvisionsData();
  const it = prov.items.find(x => x.id === id);
  if (it) { it.qty = it.minQty; save(); document.getElementById('mainContent').innerHTML = renderProvisions(); }
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
    <div class="mi-label">Current quantity</div><input class="mi" id="pv-qty" type="number" min="0" value="${e.qty||0}">
    <div class="mi-label">Minimum quantity</div><input class="mi" id="pv-min" type="number" min="0" value="${e.minQty||0}">
    <div class="mi-label">Unit (optional)</div><input class="mi" id="pv-unit" placeholder="bottles, cans, rolls…" value="${esc(e.unit||'')}">
    <div class="modal-btns">
      ${isEdit?`<button onclick="if(confirm('Delete this item?')){hideModal();provDelete(${idx})}" style="background:#FCEBEB;border:1.5px solid #F09595;color:#A32D2D;border-radius:10px;padding:8px 14px;font-family:var(--font);font-size:14px;font-weight:600;cursor:pointer;margin-right:auto">🗑 Delete</button>`:''}
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
  const qty     = Math.max(0, parseInt(document.getElementById('pv-qty')?.value) || 0);
  const minQty  = Math.max(0, parseInt(document.getElementById('pv-min')?.value) || 0);
  const unit    = document.getElementById('pv-unit')?.value.trim() || '';
  if (idx != null && idx !== 'null') {
    prov.items[idx] = {...prov.items[idx], name, category, location, qty, minQty, unit};
  } else {
    prov.items.push({id:uid(), name, category, location, qty, minQty, unit});
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
  if (prov && prov.items?.length > 0) return false;
  if (!data.provisions) data.provisions = {};
  data.provisions = {exampleDismissed:false, items:[
    {id:'pv_ex1', name:'Pasta (Example)',            category:'food',       location:'Galley locker', qty:2,  minQty:6, unit:'packs'},
    {id:'pv_ex2', name:'Canned tomatoes (Example)',  category:'food',       location:'Galley locker', qty:8,  minQty:4, unit:'cans'},
    {id:'pv_ex3', name:'Olive oil (Example)',        category:'food',       location:'Galley',        qty:1,  minQty:3, unit:'bottles'},
    {id:'pv_ex4', name:'Sunscreen SPF50 (Example)', category:'toiletries', location:'Nav station',   qty:1,  minQty:3, unit:'bottles'},
    {id:'pv_ex5', name:'Toilet paper (Example)',     category:'toiletries', location:'Aft cabin',     qty:2,  minQty:8, unit:'rolls'},
    {id:'pv_ex6', name:'Dish soap (Example)',        category:'toiletries', location:'Galley',        qty:0,  minQty:2, unit:'bottles'},
  ]};
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
      {id:uid(), date:dAgo(90),  hours:'300', task:'Engine oil change',    cost:'€85',  notes:'Example entry', engines:['port','starboard']},
      {id:uid(), date:dAgo(180), hours:'250', task:'Impeller replacement', cost:'€120', notes:'Example entry', engines:['port','starboard']},
      {id:uid(), date:dAgo(90),  hours:'300', task:'Gear oil change',      cost:'€60',  notes:'Example entry', engines:['port','starboard']},
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
      {id:uid(), cat:'Solar',      category:'Solar',      make:'Example', model:'Solar Panels 400W', serialNumber:'', location:'Coachroof',  notes:'Example — update with your own details', installDate:'', lastService:'', warrantyExpiry:'', manualUrl:'', photos:[]},
      {id:uid(), cat:'Watermaker', category:'Watermaker', make:'Example', model:'Watermaker 12V',    serialNumber:'', location:'Engine bay', notes:'Example — update with your own details', installDate:'', lastService:'', warrantyExpiry:'', manualUrl:'', photos:[]},
      {id:uid(), cat:'Navigation', category:'Navigation', make:'Example', model:'Autopilot',         serialNumber:'', location:'Helm',       notes:'Example — update with your own details', installDate:'', lastService:'', warrantyExpiry:'', manualUrl:'', photos:[]},
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
  const sy = data.shipyard;
  if (sy && (sy.history?.length || sy.quotes?.length)) return false;
  if (!data.shipyard) data.shipyard = {};
  data.shipyard.history = [
    {id:uid(), year:'2023/2024', name:'Example Boatyard',         location:'Example Port',   start:'2023-10-01', end:'2024-04-01', cost:'€3,200', notes:'Antifouling and hull inspection (Example)'},
    {id:uid(), year:'2022/2023', name:'Another Example Boatyard', location:'Example Marina', start:'2022-10-01', end:'2023-03-01', cost:'€4,800', notes:'Full haul out and keel repaint (Example)'},
    {id:uid(), year:'2021/2022', name:'Example Yard',             location:'Example City',   start:'2021-11-01', end:'2022-04-01', cost:'€5,500', notes:'Engine service and osmosis treatment (Example)'},
  ];
  data.shipyard.quotes = [
    {id:uid(), name:'Example Boatyard',         location:'Example Port',   price:'€3,200', notes:'Includes pressure wash and antifouling (Example)', selected:false},
    {id:uid(), name:'Another Example Boatyard', location:'Example Marina', price:'€2,950', notes:'No travel lift fee (Example)',                     selected:false},
    {id:uid(), name:'Example Yard',             location:'Example City',   price:'€3,800', notes:'Premium yard, full refit available (Example)',     selected:false},
  ];
  if (!data.shipyard.current) data.shipyard.current = {};
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
            <button class="btn btn-s btn-xs no-print" onclick="showEditPart(${idx})" style="margin-right:4px">✏️</button>
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
      <button onclick="if(confirm('Remove this part?')){hideModal();removePart(${idx})}" style="background:#FCEBEB;border:1.5px solid #F09595;color:#A32D2D;border-radius:10px;padding:8px 14px;font-family:var(--font);font-size:14px;font-weight:600;cursor:pointer;margin-right:auto">🗑 Delete</button>
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
  const summary = grandTotal > 0 ? `<div style="margin:4px 12px 16px;padding:12px 16px;background:var(--surface);border:1.5px solid var(--sep);border-radius:12px;font-size:13px;color:var(--label3)">All seasons total: <b style="color:var(--label)">€${grandTotal.toLocaleString('en',{minimumFractionDigits:0,maximumFractionDigits:2})}</b></div>` : '';
  const exMsg = !isOwner ? `<div style="margin:0 12px 12px;font-size:12px;color:var(--label3);font-style:italic">Replace these examples with your own upgrades and repairs</div>` : '';

  return `<div style="display:flex;align-items:center;justify-content:space-between;padding:12px 12px 8px">
    <div style="font-size:17px;font-weight:700">🔧 Upgrades &amp; Repairs</div>
    <button onclick="showAddUpgradeSeason()" style="background:var(--surface);border:1.5px solid var(--sep);border-radius:20px;padding:6px 14px;font-size:13px;font-weight:600;font-family:var(--font);color:var(--label);cursor:pointer">+ Add season</button>
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

  return `<div style="background:var(--surface);border:1.5px solid var(--sep);border-radius:14px;margin:0 12px 10px;overflow:hidden">${hdr}${body}</div>`;
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
      <button onclick="if(confirm('Remove this item?')){ui.upgEdit=null;deleteUpgradeItem('${sid}','${iid}')}" style="background:#FCEBEB;border:1.5px solid #F09595;color:#A32D2D;border-radius:8px;padding:4px 10px;font-family:var(--font);font-size:12px;font-weight:600;cursor:pointer">🗑</button>
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
        style="background:none;border:none;padding:4px 5px;cursor:pointer;font-size:13px;color:var(--label3);border-radius:4px;line-height:1">✏️</button>
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
  {id:'Victron',  label:'⚡ Victron',        cats:['Battery Storage','Distribution','Charge Controllers','Protection & Management','Inverter / Charger','Monitoring']},
  {id:'Engines',  label:'🔧 Engines',        cats:['Engines','Propulsion','Sail Drive']},
  {id:'Sails',    label:'⛵ Sails & Rigging', cats:['Main sail','Genoa','Standing rigging','Sails','Rigging','Halyards']},
  {id:'Water',    label:'💧 Water & Fuel',    cats:['Watermaker','Fresh Water','Diesel','Water']},
  {id:'Solar',    label:'☀️ Solar',           cats:['Solar','Flexible solar']},
  {id:'Raymarine',label:'📡 Raymarine',       cats:['Raymarine','Navigation','Electronics']},
  {id:'Other',    label:'➕ Other'},
];
const SYS_ALL_CATS = SYS_GROUPS.filter(g=>g.cats).flatMap(g=>g.cats);

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
    <div class="subtab-bar" style="margin-bottom:10px">${pills}</div>
    <div class="btn-row">
      <button class="btn btn-p btn-sm" onclick="showAddSystem()">+ Add System</button>
    </div>
    ${body}`;
}

function renderSystemCard(s) {
  const open = ui.sysOpen === s.id;
  const wExp = expiryBadge(s.warrantyExpiry, 90);
  return `
    <div class="sys-card" data-sys-id="${s.id}" draggable="true" ondragstart="sysDragStart(event,'${s.id}')" ondragover="sysDragOver(event,'${s.id}')" ondragleave="sysDragLeave(event)" ondrop="sysDrop(event,'${s.id}')" ondragend="sysDragEnd()">
      <div class="sys-hdr" onclick="ui.sysOpen=ui.sysOpen==='${s.id}'?null:'${s.id}';document.getElementById('mainContent').innerHTML=renderSystems()">
        <span class="prov-grip" ontouchstart="sysTouchStart(event,'${s.id}')" style="margin-right:4px">⠿</span>
        <div class="sys-icon">⚡</div>
        <div style="flex:1">
          <div style="font-size:15px;font-weight:600">${esc(s.make?s.make+' ':'')}${esc(s.model)}</div>
          <div style="font-size:12px;color:var(--label3)">${esc(s.notes||'')} ${s.location?'· '+esc(s.location):''}</div>
        </div>
        <div style="display:flex;align-items:center;gap:4px">
          <button onclick="event.stopPropagation();editSystem('${s.id}')" style="background:none;border:none;padding:5px;cursor:pointer;font-size:14px;color:var(--label3);border-radius:6px;line-height:1" title="Edit">✏️</button>
          <span style="color:var(--label3);margin-left:2px">${open?'▲':'▼'}</span>
        </div>
      </div>
      <div class="sys-body ${open?'open':''}">
        ${fr('Make','systems.'+data.systems.indexOf(s)+'.make',s.make)}
        ${fr('Model','systems.'+data.systems.indexOf(s)+'.model',s.model)}
        ${fr('Serial No.','systems.'+data.systems.indexOf(s)+'.serialNumber',s.serialNumber)}
        ${fr('Location','systems.'+data.systems.indexOf(s)+'.location',s.location)}
        ${fr('Install Date','systems.'+data.systems.indexOf(s)+'.installDate',s.installDate,'date')}
        ${fr('Last Service','systems.'+data.systems.indexOf(s)+'.lastService',s.lastService,'date')}
        ${frExpiry('systems.'+data.systems.indexOf(s)+'.warrantyExpiry',s.warrantyExpiry,wExp,'Warranty Expiry')}
        ${fr('Manual URL','systems.'+data.systems.indexOf(s)+'.manualUrl',s.manualUrl)}
        <div class="fr" style="align-items:flex-start;padding-top:12px">
          <div class="fl">Notes</div>
          <textarea class="fi-area" onblur="saveField('systems.${data.systems.indexOf(s)}.notes',this.value)">${esc(s.notes||'')}</textarea>
        </div>
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
    <div class="modal-btns">
      <button onclick="if(confirm('Remove this system?')){hideModal();removeSystem('${id}')}" style="background:#FCEBEB;border:1.5px solid #F09595;color:#A32D2D;border-radius:10px;padding:8px 14px;font-family:var(--font);font-size:14px;font-weight:600;cursor:pointer;margin-right:auto">🗑 Delete</button>
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
        <button onclick="if(confirm('Remove this item?')){ui.winterEditItem=null;deleteWinterItem('${sid}',${i})}" style="background:#FCEBEB;border:1.5px solid #F09595;color:#A32D2D;border-radius:8px;padding:4px 10px;font-family:var(--font);font-size:12px;font-weight:600;cursor:pointer">🗑</button>
      </div>`;
    }
    const isImp = !!item.asterisk || item.text?.endsWith(' ⚠️');
    const star = (item.asterisk && !item.text?.endsWith(' ⚠️')) ? ` <span style="font-size:11px;opacity:.7">⚠️</span>` : '';
    const ts = item.checked ? 'opacity:0.4' : isImp ? 'color:var(--label2)' : '';
    const acts = archived ? '' : `<div style="display:flex;gap:1px;flex-shrink:0">
      <button class="wact" onclick="startWinterEdit('${sid}',${i})" title="Edit">✏️</button>
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
      style="background:var(--surface);border:1.5px solid var(--sep);border-radius:20px;padding:7px 14px;font-size:14px;font-weight:600;font-family:var(--font);color:var(--label);cursor:pointer;max-width:220px">${seasonOpts}</select>
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
      <td style="white-space:nowrap;display:flex;gap:4px;align-items:center"><button class="btn btn-p btn-xs" onclick="saveTLStampEdit('${s.id}')">Save</button> <button class="btn btn-s btn-xs" onclick="ui.tlEditStampId=null;document.getElementById('mainContent').innerHTML=renderDocuments()">Cancel</button><button onclick="if(confirm('Remove this stamp?')){ui.tlEditStampId=null;deleteTLStamp('${s.id}')}" style="background:#FCEBEB;border:1.5px solid #F09595;color:#A32D2D;border-radius:7px;padding:3px 8px;font-family:var(--font);font-size:12px;font-weight:600;cursor:pointer">🗑</button></td></tr>`;
    const typeCls = s.type==='Arrival'?'b-green':s.type==='Departure'?'b-red':'b-orange';
    const acts = archived ? '' : `<button onclick="startTLStampEdit('${s.id}')" style="background:none;border:none;padding:4px;cursor:pointer;font-size:13px;color:var(--label3)">✏️</button>`;
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
      <button onclick="showEditArchivedTL('${logId}')" style="background:var(--surface2);border:1.5px solid var(--sep);border-radius:10px;padding:5px 12px;font-size:12px;font-weight:600;font-family:var(--font);cursor:pointer;color:var(--label)">✏️ Edit</button>
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
  const r = 28, cx = 36, cy = 36, circ = Math.round(2 * Math.PI * r);
  const pct = days === null ? 0 : Math.min(1, Math.max(0, days / maxDays));
  const dashoffset = Math.round(circ * (1 - pct));
  const txt = days === null ? '—' : String(Math.max(0, days));
  const fs = txt.length > 3 ? '11' : '17';
  return `<svg width="72" height="72" viewBox="0 0 72 72" style="display:block;margin:0 auto">
    <circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="#e5e7eb" stroke-width="7"/>
    <circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${color}" stroke-width="7"
      stroke-linecap="round" stroke-dasharray="${circ}" stroke-dashoffset="${dashoffset}"
      transform="rotate(-90 ${cx} ${cy})"/>
    <text x="${cx}" y="${cy}" text-anchor="middle" dominant-baseline="middle"
      font-size="${fs}" font-weight="800" fill="${color}" font-family="var(--font)">${esc(txt)}</text>
    <text x="${cx}" y="${cy+15}" text-anchor="middle" font-size="8" fill="#9ca3af" font-family="var(--font)">days</text>
  </svg>`;
}
function renderTLGauges(cur) {
  // Gauge 1 — Boat validity
  const frozen = tlFrozenDays(cur);
  const boatRaw = tlDaysUntil(cur.validUntil);
  const boatDays = boatRaw === null ? null : boatRaw - frozen;
  const boatColor = boatDays===null?'#9ca3af':boatDays>180?'#22C55E':boatDays>90?'#F59E0B':'#EF4444';
  const frozenNote = frozen>0 ? `<div style="font-size:10px;color:var(--label3);text-align:center;margin-top:3px">${frozen}d frozen deducted</div>` : '';
  const g1 = `<div style="padding:10px 4px;text-align:center">
    <div style="font-size:11px;font-weight:700;color:var(--label2);margin-bottom:5px">Boat</div>
    ${tlCircleGauge(boatDays,365,boatColor)}${frozenNote}</div>`;

  // Gauge 2 — User validity (6 months from userStartDate or validUntil, whichever sooner)
  const startDate = parseTLDate(cur.userStartDate||cur.issueDate||cur.validFrom||'');
  const validUntilDate = parseTLDate(cur.validUntil);
  let userDays = null;
  if (startDate) {
    const sixMo = new Date(startDate); sixMo.setDate(sixMo.getDate()+180);
    const userExp = validUntilDate ? (sixMo < validUntilDate ? sixMo : validUntilDate) : sixMo;
    const now = new Date(); now.setHours(0,0,0,0);
    userDays = Math.round((userExp - now)/86400000);
  }
  const userColor = userDays===null?'#9ca3af':userDays>60?'#22C55E':userDays>30?'#F59E0B':'#EF4444';
  const g2 = `<div style="padding:10px 4px;text-align:center;border-left:1px solid var(--sep);border-right:1px solid var(--sep)">
    <div style="font-size:11px;font-weight:700;color:var(--label2);margin-bottom:5px">User</div>
    ${tlCircleGauge(userDays,180,userColor)}
    <div style="font-size:10px;color:var(--label3);margin-top:3px">€30 to change</div></div>`;

  // Gauge 3 — Schengen (live from data.schengen)
  const holderKey = (cur.holderName||'').trim().toLowerCase();
  const schengenMatch = holderKey ? (data.schengen?.persons||[]).find(p=>(p.name||'').trim().toLowerCase()===holderKey) : null;
  let g3;
  if (!schengenMatch) {
    g3 = `<div style="padding:10px 4px;text-align:center">
      <div style="font-size:11px;font-weight:700;color:var(--label2);margin-bottom:5px">Schengen</div>
      <div style="height:72px;display:flex;align-items:center;justify-content:center;font-size:22px;font-weight:800;color:#9ca3af">—</div>
      <div style="font-size:10px;color:var(--blue);cursor:pointer;margin-top:3px" onclick="showTab('schengen')">Set up in Schengen tab</div></div>`;
  } else {
    const isEU = schengenMatch.passports?.[schengenMatch.activePassport||0]?.eu === true;
    if (isEU) {
      g3 = `<div style="padding:10px 4px;text-align:center">
        <div style="font-size:11px;font-weight:700;color:var(--label2);margin-bottom:5px">Schengen</div>
        <svg width="72" height="72" viewBox="0 0 72 72" style="display:block;margin:0 auto">
          <circle cx="36" cy="36" r="28" fill="none" stroke="#22C55E" stroke-width="7"/>
          <text x="36" y="36" text-anchor="middle" dominant-baseline="middle" font-size="10" font-weight="700" fill="#22C55E" font-family="var(--font)">EU</text>
        </svg>
        <div style="font-size:10px;color:#22C55E;font-weight:600;margin-top:3px">No limit</div></div>`;
    } else {
      const {days:schUsed} = calcSchengenDays(schengenMatch.log);
      const schRem = 90 - schUsed;
      const schColor = schRem>45?'#22C55E':schRem>20?'#F59E0B':'#EF4444';
      g3 = `<div style="padding:10px 4px;text-align:center">
        <div style="font-size:11px;font-weight:700;color:var(--label2);margin-bottom:5px">Schengen</div>
        ${tlCircleGauge(schRem,90,schColor)}
        <div style="font-size:10px;color:var(--label3);margin-top:3px">${schUsed}/90 used</div></div>`;
    }
  }
  return `<div style="display:grid;grid-template-columns:1fr 1fr 1fr;background:var(--surface);border:1.5px solid var(--sep);border-radius:14px;overflow:hidden;margin-bottom:10px">${g1}${g2}${g3}</div>`;
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
  return `<div style="margin-bottom:10px;padding:10px 14px;background:${hasRed?'rgba(239,68,68,.08)':'rgba(245,158,11,.08)'};border:1.5px solid ${hasRed?'#EF4444':'#F59E0B'};border-radius:10px;font-size:13px;color:${hasRed?'#EF4444':'#D97706'};font-weight:600">${issues.join(' · ')}</div>`;
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
  return `<div style="margin-bottom:10px;background:${bg};border:1.5px solid ${bdr};border-radius:14px;padding:12px 16px;display:flex;align-items:center;gap:12px;flex-wrap:wrap">
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
      <button onclick="showEditFreezeEntry('${e.id}')" style="background:none;border:none;padding:4px 2px;cursor:pointer;font-size:13px;color:var(--label3);flex-shrink:0">✏️</button>
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
      <button onclick="event.stopPropagation();showEditArchivedTL('${id}')" style="background:none;border:none;padding:4px 5px;cursor:pointer;font-size:13px;color:var(--label3);flex-shrink:0">✏️</button>
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
      <button onclick="if(confirm('Delete this archived transit log?')){hideModal();deleteArchivedTL('${logId}')}" style="background:#FCEBEB;border:1.5px solid #F09595;color:#A32D2D;border-radius:10px;padding:8px 14px;font-family:var(--font);font-size:14px;font-weight:600;cursor:pointer;margin-right:auto">🗑 Delete</button>
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
      <button onclick="if(confirm('Delete this entry?')){hideModal();deleteFreezeEntry('${id}')}" style="background:#FCEBEB;border:1.5px solid #F09595;color:#A32D2D;border-radius:10px;padding:8px 14px;font-family:var(--font);font-size:14px;font-weight:600;cursor:pointer;margin-right:auto">🗑 Delete</button>
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
    if (new Date(etYear, mi, 1) > now0) etFuture++;
  }
  const etColor   = etFuture>3?'#22C55E':etFuture>0?'#F59E0B':'#EF4444';
  const etPaidStr = tlFmtDate(parseTLDate(C.validUntil));

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
  if (seamanActive) issues.push(`🟡 Seaman's Book entry detected — visit customs before flying out of Greece`);
  else if (!isEU&&schRem!==null&&schRem<=45) issues.push(schRem<=0?`🔴 Schengen OVERSTAY ${Math.abs(schRem)}d`:schRem<=20?`🔴 Schengen ${schRem}d`:`🟡 Schengen ${schRem}d`);
  const alertBar = issues.length ? `<div style="margin-bottom:12px;padding:10px 14px;background:${isRed?'rgba(239,68,68,.08)':'rgba(245,158,11,.08)'};border:1.5px solid ${isRed?'#EF4444':'#F59E0B'};border-radius:10px;font-size:13px;color:${isRed?'#EF4444':'#D97706'};font-weight:600">${issues.join(' · ')}</div>` : '';

  // ── Gauge helper ──
  function gaugeCell(title, days, max, color, subs, cardStyle) {
    return `<div style="background:var(--surface);border:1.5px solid var(--sep);border-radius:14px;padding:12px 8px;text-align:center;${cardStyle||''}">
      <div style="font-size:11px;font-weight:700;color:var(--label2);margin-bottom:6px">${title}</div>
      ${tlCircleGauge(days,max,color)}
      ${subs.map(l=>`<div style="font-size:10px;color:var(--label3);margin-top:3px;word-break:break-all">${l}</div>`).join('')}
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
    g4 = `<div style="background:var(--surface);border:1.5px solid var(--sep);border-radius:14px;padding:12px 8px;text-align:center">
      <div style="font-size:11px;font-weight:700;color:var(--label2);margin-bottom:6px">Schengen (TL User)</div>
      <div style="height:72px;display:flex;align-items:center;justify-content:center;font-size:22px;font-weight:800;color:#9ca3af">—</div>
      <div style="font-size:10px;color:var(--blue);cursor:pointer;margin-top:3px" onclick="showTab('schengen')">Set up in Schengen tab</div>
    </div>`;
  } else if (isEU) {
    g4 = `<div style="background:var(--surface);border:1.5px solid var(--sep);border-radius:14px;padding:12px 8px;text-align:center">
      <div style="font-size:11px;font-weight:700;color:var(--label2);margin-bottom:6px">Schengen (TL User)</div>
      <svg width="72" height="72" viewBox="0 0 72 72" style="display:block;margin:0 auto">
        <circle cx="36" cy="36" r="28" fill="none" stroke="#22C55E" stroke-width="7"/>
        <text x="36" y="36" text-anchor="middle" dominant-baseline="middle" font-size="10" font-weight="700" fill="#22C55E" font-family="var(--font)">EU</text>
      </svg>
      <div style="font-size:10px;color:#22C55E;font-weight:600;margin-top:3px">No limit</div>
    </div>`;
  } else if (seamanActive) {
    g4 = `<div style="background:rgba(245,158,11,.08);border:1.5px solid #F59E0B;border-radius:14px;padding:12px 8px;text-align:center">
      <div style="font-size:11px;font-weight:700;color:var(--label2);margin-bottom:6px">Schengen (TL User)</div>
      ${tlCircleGauge(schRem,90,'#F59E0B')}
      <div style="font-size:10px;color:#D97706;font-weight:700;margin-top:4px">⚓ Seaman's Book</div>
      <div style="font-size:10px;color:var(--label3);margin-top:2px">${schPassLabel?schPassLabel+' · ':''}${schUsed}/90 used</div>
    </div>`;
  } else {
    g4 = gaugeCell('Schengen (TL User)', schRem, 90, schColor, [`${schPassLabel?schPassLabel+' · ':''}${schUsed}/90 used`]);
  }

  const gaugeGrid = `<div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:16px">
    ${gaugeCell('TL — Boat', boatDays, 365, boatColor, g1subs)}
    ${gaugeCell('User', userDays, 180, userColor, g2subs)}
    ${gaugeCell('eTEPAY', etFuture, Math.max(etTotal,1), etColor, g3subs)}
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
      <span style="background:${statusBg};border:1.5px solid ${statusBorder};color:${statusTxt};font-size:12px;font-weight:700;padding:3px 12px;border-radius:20px">${statusLabel}</span>
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

function migrateData() {
  let dirty = false;
  try { (data.spareParts || []).forEach(p => { const n = normCat(p.category); if (n !== p.category) { p.category = n; dirty = true; } }); } catch(e) { console.warn('migrate spareParts', e); }
  try { if (migrateToSingleLog()) dirty = true; } catch(e) { console.warn('migrateToSingleLog', e); }
  try { (data.maintenance?.log||[]).forEach(e => { const n=normalizeMaintTask(e.task); if(n!==e.task){e.task=n;dirty=true;} }); } catch(e) { console.warn('migrateMaintTasks',e); }
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
    await save();
    pushToCloud();
    startActivityTracking();
    document.getElementById('setupOv').classList.add('hidden');
    document.getElementById('app').classList.remove('hidden');
    renderApp();
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
      if (prefillDirty) save();
      await pushToCloud();
    }
    migrateData();
    startActivityTracking();
    document.getElementById('setupOv').classList.add('hidden');
    document.getElementById('app').classList.remove('hidden');
    renderApp();
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
        if (prefillDirty) save();
        await pushToCloud();
      }
      migrateData();
      startActivityTracking();
      document.getElementById('setupOv').classList.add('hidden');
      document.getElementById('app').classList.remove('hidden');
      renderApp();
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
    renderApp();
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
    ? `<div style="background:rgba(0,122,255,.08);border:1.5px solid var(--blue);
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
        style="width:100%;background:var(--red);color:#fff;border:none;border-radius:14px;
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
      <b>What this app is</b><br>Oroboro Boat Manager is a personal boat management tool for sailors. Not a commercial service.<br><br>
      <b>What data we collect</b><br>Your email (stored as a hash we cannot read), boat info, maintenance logs. No tracking, no ads.<br><br>
      <b>How data is stored</b><br>All data is AES-256 encrypted on your device before transmission. The encryption key is derived from your PIN and never leaves your device. Data is stored in a cloud backend managed by the app developer. Because all data is encrypted before leaving your device, it cannot be read by anyone — including us — without your PIN.<br><br>
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

function renderSettings() {
  const email = localStorage.getItem(EMAIL_KEY) || '—';
  const syncColors = {synced:'var(--green)',syncing:'var(--orange)',offline:'var(--red)',idle:'var(--label3)'};
  const syncLabels = {synced:'Synced ✓',syncing:'Syncing…',offline:'Offline / error',idle:'Not synced yet'};
  const rawTs = localStorage.getItem(LAST_SYNC_KEY);
  const lastSync = timeAgo(rawTs);
  return `
    <div class="sec-hd">Cloud Sync</div>
    <div class="card">
      <div class="fr">
        <div class="fl">Account</div>
        <div class="fv" style="font-size:13px">${esc(email)}</div>
      </div>
      <div class="fr">
        <div class="fl">Status</div>
        <div class="fv" style="color:${syncColors[syncStatus]||'var(--label3)'}">${syncLabels[syncStatus]||'—'}</div>
      </div>
      <div class="fr">
        <div class="fl">Last synced</div>
        <div class="fv" style="font-size:12px;color:var(--label3)">${esc(lastSync)}</div>
      </div>
      <div class="btn-row">
        <button class="btn btn-s btn-sm" onclick="syncNow()">↕ Sync Now</button>
      </div>
      <div class="fr" style="border-top:1px solid var(--sep)">
        <div class="fl">Reset &amp; re-sync</div>
        <div class="fv" style="font-size:12px;color:var(--label3)">Use this if your data looks outdated on this device.</div>
      </div>
      <div class="btn-row">
        <button class="btn btn-s btn-sm" onclick="forceResync()" style="color:var(--red)">↺ Reset local data &amp; re-sync</button>
      </div>
    </div>
    <div class="sec-hd">Backup &amp; Restore</div>
    <div class="card">
      <div class="fr">
        <div class="fl">Export Encrypted Backup</div>
        <div class="fv" style="font-size:12px;color:var(--label3)">Save this file to iCloud Drive. Use it to restore your data on any device.</div>
      </div>
      <div class="btn-row">
        <button class="btn btn-s btn-sm" onclick="saveBackup()">⬇ Export Encrypted Backup</button>
      </div>
      <div class="fr" style="border-top:1px solid var(--sep)">
        <div class="fl">Restore from Backup</div>
        <div class="fv" style="font-size:12px;color:var(--label3)">Import a previously exported encrypted backup file</div>
      </div>
      <div class="btn-row">
        <button class="btn btn-p btn-sm" onclick="document.getElementById('backupFile').click()">⬆ Restore from Backup</button>
      </div>
    </div>
    <div class="sec-hd">Import Data</div>
    <div class="card">
      <div class="fr">
        <div class="fl">Import from JSON</div>
        <div class="fv" style="font-size:12px;color:var(--label3)">Merge plain JSON into app data</div>
      </div>
      <div class="btn-row">
        <button class="btn btn-s btn-sm" onclick="document.getElementById('jsonImportFile').click()">⬆ Import Data from JSON</button>
      </div>
    </div>
    <div class="sec-hd">Account</div>
    <div class="card">
      <div class="btn-row">
        <button class="btn btn-d btn-sm" onclick="logOut()">Log out / Switch account</button>
      </div>
      <div class="btn-row" style="border-top:1px solid var(--sep);padding-top:10px;margin-top:4px">
        <button class="btn btn-d btn-sm" onclick="deleteAccount()">🗑 Delete My Account</button>
      </div>
    </div>
    <div style="text-align:center;padding:16px 0 8px">
      <button onclick="showPrivacyPolicy()" style="background:none;border:none;color:var(--label3);font-family:var(--font);font-size:13px;cursor:pointer;text-decoration:underline">Privacy Policy</button>
    </div>`;
}

// ═══════════════════════════════════════════════════════════
//  INIT
// ═══════════════════════════════════════════════════════════

async function init() {
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
