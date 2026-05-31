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
const STORAGE_WORKER_URL = 'https://boat-manager-storage.[WORKER-URL].workers.dev';
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
  photoSub:'vesselDoc', crewOpen:null, sysOpen:null,
  partsSearch:'', partsFilter:'All', alertsOpen:false, maintShowAll:false
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

function daysUntil(dateStr) {
  if (!dateStr) return 9999;
  const d = new Date(dateStr); const now = new Date();
  now.setHours(0,0,0,0); d.setHours(0,0,0,0);
  return Math.round((d - now) / 86400000);
}

function fmtDate(dateStr) {
  if (!dateStr) return '';
  const d = new Date(dateStr);
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

function maintStatus(task, currentHours) {
  const nextDue = task.lastDoneAt + task.interval;
  const remaining = nextDue - currentHours;
  if (remaining <= 0) return {color:'red', label:`${Math.abs(remaining)}h overdue`};
  if (remaining <= task.interval * 0.2) return {color:'orange', label:`${remaining}h remaining`};
  return {color:'green', label:`${remaining}h remaining`};
}

function calcSchengen(log) {
  const now = new Date(); now.setHours(23,59,59,999);
  const win = new Date(now); win.setDate(win.getDate()-180); win.setHours(0,0,0,0);
  let days = 0;
  (log||[]).forEach(e => {
    const entry = new Date(e.entryDate); const exit = e.exitDate ? new Date(e.exitDate) : now;
    const s = entry < win ? win : entry;
    const end = exit > now ? now : exit;
    if (s <= end) days += Math.ceil((end-s)/86400000)+1;
  });
  return days;
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
async function exportSection(section) {
  if (!cryptoKey) return;
  const payload = section === 'all' ? data : { [section]: data[section], meta: data.meta };
  // Embed salt so import works cross-device with same password
  const exportSalt = u8ToB64(b64ToU8(localStorage.getItem(SALT_KEY)));
  const plaintext = JSON.stringify({ salt: exportSalt, payload });
  const iv  = crypto.getRandomValues(new Uint8Array(12));
  const ct  = await crypto.subtle.encrypt({ name:'AES-GCM', iv }, cryptoKey, new TextEncoder().encode(plaintext));
  const blob = new Blob([JSON.stringify({ iv: u8ToB64(iv), data: u8ToB64(new Uint8Array(ct)) })], { type:'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `BM_${section}_${new Date().toISOString().slice(0,10)}_enc.json`;
  a.click();
}

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
      const KNOWN = ['documents','crew','transitLog','spareParts','maintenance','maintenance2','shipyard'];
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

      // Merge everything else (documents, crew, transitLog, spareParts, etc.)
      const rest = Object.assign({}, json);
      delete rest.maintenance;
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
      <div class="setup-logo">${logoSrc ? `<img src="${logoSrc}" alt="Oroboro">` : '<div style="font-size:32px;font-weight:800">⚓</div>'}</div>
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
      <div style="display:flex;align-items:flex-start;gap:10px;margin:18px 0 12px;font-size:14px;color:var(--label2);line-height:1.4">
        <input type="checkbox" id="s-consent" onchange="document.getElementById('s-go').disabled=!this.checked" style="margin-top:3px;flex-shrink:0;cursor:pointer;width:18px;height:18px">
        <div style="line-height:1.5">
          <label for="s-consent" style="cursor:pointer">I have read and agree to the </label><button onclick="showPrivacyPolicy()" style="background:none;border:none;color:var(--blue);font-family:var(--font);font-size:14px;cursor:pointer;padding:0;text-decoration:underline;vertical-align:baseline">Privacy Policy</button>
        </div>
      </div>
      <button class="setup-go" id="s-go" onclick="completeSetup()" disabled>Set Up My Boat →</button>
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
  {id:'documents', icon:'📄', label:'Documents'},
  {id:'shipyard',  icon:'⚓', label:'Shipyard'},
  {id:'maint',     icon:'🔧', label:'Maintenance'},
  {id:'upgrades',  icon:'🔧', label:'Upgrades & Repairs'},
  {id:'schengen',  icon:'🛂', label:'Schengen'},
  {id:'parts',     icon:'🔩', label:'Spare Parts'},
  {id:'systems',   icon:'🔌', label:'Systems'},
  {id:'winter',    icon:'❄️', label:'Winterize'},
  {id:'settings',  icon:'⚙️', label:'Settings'},
];

function renderApp() {
  const app = document.getElementById('app');
  app.innerHTML = `
    <div class="hdr">
      <div class="hdr-content">
        ${logoSrc ? `<img src="${logoSrc}" alt="Oroboro">` : '<div style="font-size:24px">⚓</div>'}
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
      case 'documents': mc.innerHTML = renderDocuments(); break;
      case 'crew':      mc.innerHTML = renderCrew(); break;
      case 'shipyard':  mc.innerHTML = renderShipyard(); break;
      case 'maint':     mc.innerHTML = renderMaintenance(); break;
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
    <div class="btn-row no-print">
      <button class="btn btn-s btn-sm" onclick="window.print()">🖨 Print</button>
    </div>
    <div class="sec-hd">Vessel Identification</div>
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
    </div></div>`;
}

function renderInsurance() {
  const I = data.documents?.insurance || {};
  const exp = expiryBadge(I.expiryDate, 60);
  return `
    <div class="sec-hd">Policy Details</div>
    <div class="card"><div class="card-body">
      ${fr('Insurer','documents.insurance.insurer',I.insurer)}
      ${fr('Certificate No.','documents.insurance.certNumber',I.certNumber)}
      ${fr('Issue Date','documents.insurance.issueDate',I.issueDate,'date')}
      ${frExpiry('documents.insurance.expiryDate',I.expiryDate,exp)}
      ${fr('Annual Premium','documents.insurance.premium',I.premium)}
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
          <td>${esc(r.expiry)}</td><td><button class="btn btn-d btn-xs" onclick="removeInsuranceRenewal(${i})">✕</button></td></tr>`
        ).join('') || '<tr><td colspan="5" style="color:var(--label3);padding:12px">No history yet</td></tr>'}</tbody>
        </table>
      </div>
    </div>`;
}

function renderCustoms() {
  const C = data.documents?.customs || {};
  const exp = expiryBadge(C.validUntil, 60);
  return `
    <div class="sec-hd">eTEPAY Application</div>
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
            <td><button class="btn btn-d btn-xs" onclick="removeCustomsRenewal(${i})">✕</button></td>
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
  const sd = calcSchengen(p.schengenLog);
  const sdColor = sd >= 90 ? 'red' : sd >= 75 ? 'orange' : 'green';
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
          <span class="badge b-${sdColor}">${sd}d SCH</span>
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
        <div class="sec-hd" style="padding:0 16px">Schengen Log
          <span class="badge b-${sdColor}" style="margin-left:8px">${sd} days used (180-day window)</span>
        </div>
        ${sd>=75?`<div class="tip" style="margin:0 16px 8px">⚠️ ${sd} Schengen days used. Limit is 90 in any 180-day rolling window. ${sd>=90?'<b>LIMIT REACHED.</b>':''}</div>`:''}
        <div class="card" style="margin:0;border-radius:0;box-shadow:none">
          <div class="card-hd" style="border-radius:0">Schengen Entries
            <button class="card-hd-btn" onclick="showAddSchengen(${i})">+ Add</button>
          </div>
          <div style="overflow-x:auto">
            <table class="tbl"><thead><tr><th>Entry</th><th>Exit</th><th>Country</th><th>Days</th><th></th></tr></thead>
            <tbody>${(p.schengenLog||[]).map((e,j)=>`
              <tr>
                <td>${esc(e.entryDate)}</td><td>${esc(e.exitDate||'—')}</td>
                <td>${esc(e.country)}</td>
                <td>${e.exitDate?Math.ceil((new Date(e.exitDate)-new Date(e.entryDate))/86400000)+1:'ongoing'}</td>
                <td><button class="btn btn-d btn-xs" onclick="removeSchengen(${i},${j})">✕</button></td>
              </tr>`).join('') || '<tr><td colspan="5" style="color:var(--label3);padding:12px">No entries</td></tr>'}
            </tbody></table>
          </div>
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
    seamanBookExpiry: '', schengenLog: []
  });
  save(); hideModal(); document.getElementById('mainContent').innerHTML = renderCrew();
}
function removeCrew(i) {
  if (!confirm('Remove this crew member?')) return;
  data.crew.splice(i,1); save();
  document.getElementById('mainContent').innerHTML = renderCrew();
}

function showAddSchengen(crewIdx) {
  showModal('Add Schengen Entry', `
    <div class="mi-label">Entry Date</div><input class="mi" id="m-en" type="date">
    <div class="mi-label">Exit Date (leave blank if still in Schengen)</div>
    <input class="mi" id="m-ex" type="date">
    <div class="mi-label">Country</div><input class="mi" id="m-co" placeholder="e.g. Greece">
    <div class="modal-btns">
      <button class="btn btn-s" onclick="hideModal()">Cancel</button>
      <button class="btn btn-p" onclick="saveSchengen(${crewIdx})">Add</button>
    </div>`);
}
function saveSchengen(i) {
  const entry = document.getElementById('m-en').value;
  if (!entry) { showToast('Entry date required',true); return; }
  if (!data.crew[i].schengenLog) data.crew[i].schengenLog = [];
  data.crew[i].schengenLog.push({
    entryDate: entry,
    exitDate: document.getElementById('m-ex').value || '',
    country: document.getElementById('m-co').value
  });
  save(); hideModal(); document.getElementById('mainContent').innerHTML = renderCrew();
}
function removeSchengen(ci, si) {
  data.crew[ci].schengenLog.splice(si,1); save();
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
      ${PHOTO_SUBS.map(s=>`<div class="pill ${sub===s?'active':''}" onclick="ui.photoSub='${s}';document.getElementById('mainContent').innerHTML=renderPhotos()">
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
          </div>`).join('')}
      </div>
    </div>`;
}

function handlePhotoUpload(input) {
  const file = input.files[0]; if (!file) return;
  const reader = new FileReader();
  reader.onload = e => {
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement('canvas');
      const MAX = 900;
      const ratio = Math.min(1, MAX / Math.max(img.width, img.height));
      canvas.width = img.width * ratio; canvas.height = img.height * ratio;
      canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
      const section = _photoCtx?.section || ui.photoSub;
      if (!data.photos) data.photos = {};
      if (!data.photos[section]) data.photos[section] = [];
      data.photos[section].push({id:uid(), data:canvas.toDataURL('image/jpeg',0.75), caption:''});
      save(); document.getElementById('mainContent').innerHTML = renderPhotos();
    };
    img.src = e.target.result;
  };
  reader.readAsDataURL(file);
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
  console.log('[shipyard debug] data.shipyard:', JSON.stringify(data.shipyard));
  console.log('[shipyard debug] data keys:', JSON.stringify(Object.keys(data)));
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
        <button onclick="removeQuote(${i})" style="background:none;border:none;padding:4px 5px;cursor:pointer;font-size:13px;color:var(--label3)">✕</button>
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
    return `<div style="display:flex;align-items:center;gap:8px;padding:8px 14px;border-bottom:1px solid var(--sep);overflow:hidden">
      <div style="font-size:12px;font-weight:700;flex-shrink:0;width:60px;white-space:nowrap">${esc(yr)}</div>
      <div style="font-size:13px;flex-shrink:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:110px">${esc(h.location||h.name||'')}</div>
      <div style="font-size:11px;color:var(--label3);flex-shrink:0;white-space:nowrap">${esc(dateRange)}</div>
      <div style="font-size:11px;color:var(--label3);flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(h.notes||'')}</div>
      <div style="font-size:12px;font-weight:600;flex-shrink:0;white-space:nowrap">${fmtCost(h.cost)}</div>
      <button onclick="editShipyardHistory(${i})" style="background:none;border:none;padding:4px 5px;cursor:pointer;font-size:13px;color:var(--label3);flex-shrink:0">✏️</button>
      <button onclick="removeShipyardHistory(${i})" style="background:none;border:none;padding:4px 5px;cursor:pointer;font-size:13px;color:var(--label3);flex-shrink:0">✕</button>
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
  if (!confirm('Remove this quote?')) return;
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
  if (!confirm('Remove this season?')) return;
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
    const daysLeft = Math.ceil((new Date(entry.date).getTime() + task.intDays*86400000 - Date.now()) / 86400000);
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

function renderSchedItemRow(item, eids, isCat, eLbl) {
  const cols = eids.map(eid => {
    const s = calcSchedStatus(item, eid);
    const history = _schedHistory(eid, item.id);
    const histHtml = history.slice().reverse().map(h =>
      `<div class="maint-last-done">${fmtSchedDate(h.date)}${h.hours ? ' · '+h.hours+'h' : ''}</div>`
    ).join('');
    return `<div class="maint-eng-col">
      ${isCat ? `<div class="maint-eng-lbl">${eLbl[eid]}</div>` : ''}
      <button class="msb msb-${s.color}" onclick="markSchedDone('${item.id}','${eid}')">${esc(s.label)}</button>
      ${histHtml}
    </div>`;
  }).join('');
  return `<div class="maint-row2">
    <div class="maint-task-name">${esc(item.task)}<span class="maint-int-lbl">${esc(item.intLabel)}</span></div>
    <div style="display:flex;gap:6px;align-items:flex-end">${cols}
      <button class="btn btn-s btn-xs" onclick="showEditSchedItem('${item.id}')" style="flex-shrink:0;margin-bottom:2px">✏</button>
    </div>
  </div>`;
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
          <div class="hours-num">${h}</div><div class="hours-lbl">hours</div>
          <div class="hours-edit">
            <button class="h-btn" onclick="adjustHours('${eid}',-10)">−10</button>
            <button class="h-btn" onclick="adjustHours('${eid}',-1)">−</button>
            <input class="h-input" type="number" value="${h}" min="0" onblur="setHours('${eid}',this.value)">
            <button class="h-btn" onclick="adjustHours('${eid}',1)">+</button>
            <button class="h-btn" onclick="adjustHours('${eid}',10)">+10</button>
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
  const logRows = log.map((e,i) => {
    const num = i + 1;
    const engBadges = isCat ? (e.engines||[]).map(eid =>
      `<span style="font-size:10px;font-weight:700;padding:1px 5px;border-radius:4px;background:var(--surface2);color:var(--label3);margin-left:4px">${eLbl[eid]||eid}</span>`
    ).join('') : '';
    return `<tr>
      <td style="color:var(--label3);font-size:11px;white-space:nowrap">${num}</td>
      <td style="white-space:nowrap">${esc(e.date)}</td>
      <td style="white-space:nowrap">${esc(String(e.hours))}</td>
      <td>${esc(e.task)}${engBadges}</td>
      <td>${esc(e.cost||'')}</td>
      <td>${esc(e.notes||'')}</td>
      <td style="white-space:nowrap">
        <button class="btn btn-s btn-xs" onclick="editMaintEntry(${i})" style="margin-right:4px">✏</button>
        <button class="btn btn-d btn-xs" onclick="removeMaintEntry(${i})">✕</button>
      </td>
    </tr>`;
  }).join('') || '<tr><td colspan="7" style="color:var(--label3);padding:12px">No entries yet</td></tr>';
  const logHtml = `
    <div class="sec-hd">Maintenance Log</div>
    <div class="btn-row">
      <button class="btn btn-p btn-sm" onclick="showAddMaintEntry()">+ Add entry</button>
    </div>
    <div class="card"><div style="overflow-x:auto">
      <table class="tbl"><thead><tr><th>#</th><th>Date</th><th>Hours</th><th>Task</th><th>Cost</th><th>Notes</th><th></th></tr></thead>
      <tbody>${logRows}</tbody></table>
    </div></div>`;
  return hoursHtml + comingUpHtml + logHtml;
}

function showAddMaintEntry() {
  const isCat = data.meta.hullType === 'catamaran';
  const portH = data.maintenance?.engines?.port?.hours || 0;
  const stbdH = data.maintenance?.engines?.starboard?.hours || 0;
  const defH  = isCat ? Math.max(portH, stbdH) : portH;
  showModal('Add Maintenance Entry', `
    <div class="mi-label">Date</div><input class="mi" id="m-ld" type="date" value="${new Date().toISOString().slice(0,10)}">
    <div class="mi-label">Engine Hours</div><input class="mi" id="m-lh" type="number" value="${defH}" placeholder="Engine hours">
    <div class="mi-label">Task Performed</div><input class="mi" id="m-lt" placeholder="e.g. Oil change, Impeller">
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
    task:  document.getElementById('m-lt').value,
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
    <div class="mi-label">Task Performed</div><input class="mi" id="me-lt" value="${esc(e.task||'')}">
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
  e.task    = document.getElementById('me-lt').value;
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
  const today = new Date(); today.setHours(23,59,59,999);
  const windowStart = new Date(today); windowStart.setDate(windowStart.getDate()-179); windowStart.setHours(0,0,0,0);
  const sorted = [...(log||[])].sort((a,b)=>a.date.localeCompare(b.date));
  let days = 0, inDate = null;
  for (const e of sorted) {
    if (e.type==='in') { inDate = new Date(e.date); }
    else if (e.type==='out' && inDate) {
      const out = new Date(e.date);
      const s = inDate < windowStart ? windowStart : inDate;
      const end = out > today ? today : out;
      if (s <= end) days += Math.round((end-s)/86400000)+1;
      inDate = null;
    }
  }
  if (inDate) { const s = inDate < windowStart ? windowStart : inDate; days += Math.round((today-s)/86400000)+1; }
  return { days, inSchengen: inDate !== null };
}

function isCurrentlyInSchengen(log) {
  const sorted = [...(log||[])].sort((a,b)=>a.date.localeCompare(b.date));
  let inside = false;
  for (const e of sorted) { if (e.type==='in') inside=true; else if (e.type==='out') inside=false; }
  return inside;
}

function schengenRerender() { document.getElementById('mainContent').innerHTML = renderSchengen(); }

function renderSchengen() {
  const sd = getSchengenData();
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
    if (rem < 20) warnings.push(`${p.name}: ${rem} days remaining`);
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
  const remaining = Math.max(0, 90 - days);
  const inStatus = isCurrentlyInSchengen(p.log);
  const circleColor = remaining > 30 ? 'var(--green)' : remaining > 10 ? 'var(--orange)' : 'var(--red)';
  const exitBy = new Date(); exitBy.setDate(exitBy.getDate() + remaining);
  const exitByStr = exitBy.toLocaleDateString('en-GB', {day:'numeric', month:'short', year:'numeric'});
  const exitByColor = remaining < 30 ? 'var(--red)' : 'var(--green)';
  const borderRight = idx === 0 ? 'border-right:1px solid var(--sep);' : '';
  const passportBtns = (p.passports||[]).map((pp, pi) => {
    const label = [pp.flag, pp.country ? pp.country.slice(0,3) : ''].filter(Boolean).join(' ') || '?';
    const active = pi === activePassIdx;
    return `<button onclick="setSchengenPassport(${idx},${pi})" style="background:${active?'var(--blue)':'var(--surface2)'};color:${active?'#fff':'var(--label)'};border:1.5px solid ${active?'var(--blue)':'var(--sep)'};border-radius:8px;padding:3px 6px;font-size:11px;cursor:pointer;line-height:1.4;font-family:var(--font);white-space:nowrap">${label}</button>`;
  }).join('');
  return `<div style="padding:14px 10px;min-width:0;overflow:hidden;${borderRight}">
    <div style="font-size:13px;font-weight:700;margin-bottom:6px">${esc(p.name||'—')}</div>
    <div style="margin-bottom:8px"><span style="background:${inStatus?'var(--green)':'var(--sep)'};color:${inStatus?'#fff':'var(--label2)'};font-size:10px;font-weight:700;padding:2px 7px;border-radius:10px">${inStatus?'In Schengen':'Outside'}</span></div>
    ${isEU ? `<div style="font-size:11px;color:var(--green);font-weight:600;margin-bottom:10px">🇪🇺 EU Passport · No limit</div>` : `
      <div style="display:flex;justify-content:center;margin-bottom:8px">
        <div style="width:60px;height:60px;border-radius:50%;border:4px solid ${circleColor};display:flex;flex-direction:column;align-items:center;justify-content:center">
          <div style="font-size:17px;font-weight:800;color:${circleColor};line-height:1">${remaining}</div>
          <div style="font-size:9px;color:var(--label3);line-height:1.2">days left</div>
        </div>
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:4px;margin-bottom:6px">
        <div style="background:var(--surface2);border-radius:8px;padding:5px;text-align:center">
          <div style="font-size:14px;font-weight:700">${days}</div>
          <div style="font-size:9px;color:var(--label3)">Used</div>
        </div>
        <div style="background:var(--surface2);border-radius:8px;padding:5px;text-align:center">
          <div style="font-size:14px;font-weight:700;color:${circleColor}">${remaining}</div>
          <div style="font-size:9px;color:var(--label3)">Left</div>
        </div>
      </div>
      <div style="font-size:10px;color:var(--label3);margin-bottom:8px;text-align:center">Exit by <span style="color:${exitByColor};font-weight:600">${exitByStr}</span></div>`}
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
  const rows = sorted.map(e => {
    const typeColor = e.type==='in' ? 'var(--green)' : 'var(--label2)';
    const typeLabel = e.type==='in' ? '↓ In' : '↑ Out';
    const passFlag = e.passport ? `${e.passport} ` : '';
    return `<div style="padding:8px 10px;border-bottom:1px solid var(--sep)">
      <div style="display:flex;align-items:flex-start;gap:4px">
        <div style="flex:1;min-width:0">
          <div style="font-size:12px;font-weight:600;color:${typeColor}">${typeLabel} ${passFlag}</div>
          <div style="font-size:11px;color:var(--label3);line-height:1.3">${esc(e.date)}</div>
          <div style="font-size:11px;color:var(--label3);line-height:1.3;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(e.location||'')}</div>
        </div>
        <div style="display:flex;gap:0;flex-shrink:0">
          <button onclick="showSchengenEditEntry(${idx},'${e.id}')" style="background:none;border:none;padding:3px 4px;cursor:pointer;font-size:12px;color:var(--label3)">✏️</button>
          <button onclick="deleteSchengenEntry(${idx},'${e.id}')" style="background:none;border:none;padding:3px 4px;cursor:pointer;font-size:12px;color:var(--label3)">✕</button>
        </div>
      </div>
    </div>`;
  }).join('') || `<div style="padding:14px 10px;text-align:center;color:var(--label3);font-size:12px">No entries</div>`;
  return `<div style="min-width:0;overflow:hidden;${borderRight}">
    <div style="padding:10px 10px 6px;font-size:12px;font-weight:700;color:var(--label);border-bottom:1px solid var(--sep)">${esc(p.name||'Person '+(idx+1))}</div>
    ${rows}
    <div style="padding:8px 10px">
      <button onclick="showSchengenCheckIn(${idx})" style="font-size:11px;color:var(--blue);background:none;border:none;cursor:pointer;font-family:var(--font);padding:0">+ Add entry</button>
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

function showSchengenCheckIn(personIdx) {
  const sd = getSchengenData();
  const p = sd.persons[personIdx];
  const activeIdx = p.activePassport || 0;
  const passOpts = (p.passports||[]).map((pp,i)=>`<option value="${i}" ${i===activeIdx?'selected':''}>${[pp.flag, pp.country].filter(Boolean).join(' ') || 'Passport '+(i+1)}</option>`).join('');
  showModal(`Check In — ${esc(p.name||'Person '+(personIdx+1))}`, `
    <div class="mi-label">Date</div><input class="mi" id="sch-date" type="date" value="${new Date().toISOString().slice(0,10)}" autofocus>
    <div class="mi-label">Passport</div><select class="mi" id="sch-pass">${passOpts}</select>
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
  p.log.push({id:uid(), type:'in', date, passport, location});
  p.activePassport = passIdx;
  save(); hideModal(); schengenRerender();
}

function showSchengenCheckOut(personIdx) {
  const sd = getSchengenData();
  const p = sd.persons[personIdx];
  showModal(`Check Out — ${esc(p?.name||'Person '+(personIdx+1))}`, `
    <div class="mi-label">Date</div><input class="mi" id="sch-date" type="date" value="${new Date().toISOString().slice(0,10)}" autofocus>
    <div class="mi-label">Destination</div><input class="mi" id="sch-loc" placeholder="e.g. Turkey (Istanbul)">
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
  const location = document.getElementById('sch-loc')?.value.trim()||'';
  p.log.push({id:uid(), type:'out', date, location});
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
  if (!confirm('Delete this entry?')) return;
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

function showSchengenEdit() {
  const sd = getSchengenData();
  _schPi = sd.persons.map(p => (p.passports||[]).length);
  const personsHtml = sd.persons.map((p,i) => {
    const passHtml = (p.passports||[]).map((pp,pi) => schPassportRow(i,pi,pp)).join('');
    return `
      <div style="background:var(--surface);border:1.5px solid var(--sep);border-radius:14px;padding:16px;margin-bottom:12px;overflow:hidden">
        <div id="sch-namerow-${i}" style="display:flex;align-items:center;gap:8px;margin-bottom:12px">
          <span id="sch-namedisplay-${i}" style="font-size:16px;font-weight:700;flex:1;color:var(--label)">${esc(p.name||'Person '+(i+1))}</span>
          <button onclick="schEditName(${i})" style="background:none;border:none;cursor:pointer;font-size:15px;color:var(--label3);padding:2px 4px;font-family:var(--font)">✏️</button>
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
  save(); hideModal(); schengenRerender();
}

function prefillShipyardData() {
  if (localStorage.getItem(EMAIL_KEY) === OWNER_EMAIL) return false;
  const sy = data.shipyard;
  if (sy && (sy.history?.length || sy.quotes?.length)) return false;
  if (!data.shipyard) data.shipyard = {};
  data.shipyard.history = [
    {id:uid(), year:'2023/2024', name:'Marina del Rey Boatyard', location:'Los Angeles', start:'2023-10-01', end:'2024-04-01', cost:'€3,200', notes:'Antifouling and hull inspection'},
    {id:uid(), year:'2022/2023', name:'Palma Boat Services',     location:'Mallorca',    start:'2022-10-01', end:'2023-03-01', cost:'€4,800', notes:'Full haul out and keel repaint'},
    {id:uid(), year:'2021/2022', name:'Porto Montenegro Yard',   location:'Montenegro',  start:'2021-11-01', end:'2022-04-01', cost:'€5,500', notes:'Engine service and osmosis treatment'},
  ];
  data.shipyard.quotes = [
    {id:uid(), name:'Marina del Rey Boatyard', location:'Los Angeles',    price:'€3,200', notes:'Includes pressure wash and antifouling', selected:false},
    {id:uid(), name:'Pacific Yacht Services',  location:'San Diego',      price:'€2,950', notes:'No travel lift fee',                     selected:false},
    {id:uid(), name:'Bay Marine Works',        location:'San Francisco',  price:'€3,800', notes:'Premium yard, full refit available',     selected:false},
  ];
  if (!data.shipyard.current) data.shipyard.current = {};
  return true;
}

function prefillSchengenData() {
  const email = localStorage.getItem(EMAIL_KEY);
  if (email === OWNER_EMAIL) {
    // Owner: seed Francesco + Yuka with real data
    const fp = data.schengen?.persons?.[0];
    const euOk = fp?.passports?.some(pp => pp.flag === '🇪🇺' && pp.eu === true);
    const usOk = fp?.passports?.some(pp => pp.flag === '🇺🇸' && pp.eu === false);
    if (fp?.name && euOk && usOk) return false;
    data.schengen = { persons: [
      { name:'Francesco', activePassport:0,
        passports:[
          {flag:'🇺🇸', country:'United States',  eu:false},
          {flag:'🇪🇺', country:'European Union', eu:true},
          {flag:'🇯🇵', country:'Japan',          eu:false}
        ],
        log:[
          {id:uid(), type:'in',  date:'2025-10-15', passport:'🇺🇸', location:'Greece (Kilada)'},
          {id:uid(), type:'out', date:'2026-01-26', passport:'',    location:'Turkey (Didim)'},
          {id:uid(), type:'in',  date:'2026-04-24', passport:'🇺🇸', location:'Greece (Syros)'}
        ]
      },
      { name:'Yuka', activePassport:0,
        passports:[
          {flag:'🇺🇸', country:'United States', eu:false},
          {flag:'🇯🇵', country:'Japan',         eu:false}
        ],
        log:[]
      }
    ]};
    return true;
  }
  // Non-owner: seed example travellers if empty
  if (data.schengen?.persons?.some(p => p.name)) return false;
  data.schengen = { persons: [
    { name:'Alex Smith', activePassport:0,
      passports:[
        {flag:'🇺🇸', country:'United States', eu:false},
        {flag:'🇦🇺', country:'Australia',     eu:false}
      ],
      log:[
        {id:uid(), type:'in',  date:'2026-03-15', passport:'🇺🇸', location:'Greece (Athens)'},
        {id:uid(), type:'out', date:'2026-05-20', passport:'',    location:'Turkey (Bodrum)'},
        {id:uid(), type:'in',  date:'2025-10-01', passport:'🇺🇸', location:'Spain (Barcelona)'},
        {id:uid(), type:'out', date:'2025-12-10', passport:'',    location:'UK'}
      ]
    },
    { name:'Maria Santos', activePassport:0,
      passports:[
        {flag:'🇬🇧', country:'United Kingdom', eu:false}
      ],
      log:[
        {id:uid(), type:'in',  date:'2026-04-01', passport:'🇬🇧', location:'France (Marseille)'},
        {id:uid(), type:'out', date:'2026-05-15', passport:'',    location:'Morocco'},
        {id:uid(), type:'in',  date:'2025-09-15', passport:'🇬🇧', location:'Italy (Palermo)'},
        {id:uid(), type:'out', date:'2025-11-20', passport:'',    location:'Tunisia'}
      ]
    }
  ]};
  return true;
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
          return `<div class="part-row">
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
            <button class="btn btn-d btn-xs no-print" onclick="removePart(${idx})">✕</button>
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
  if (!confirm('Remove this part?')) return;
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
      data.upgrades = { version: UPGRADES_DATA_VERSION, seasons:[
        {id:uid(), name:'2022/2023', location:'Didim', items:[
          mk('Flexible solar panel replaced','',true),
          mk('Fixed gelcoat under soft solar panel','',true),
          mk('Painted antifouling on hulls','',true)
        ]},
        {id:uid(), name:'2023/2024', location:'Kilada', items:[
          mk('Saloon big stbd window panel replaced','',true),
          mk('Anchor winch motor rebuild','',true),
          mk('Yanmar engine alternators rebuild','',true),
          mk('New helm station dodger cover','',true),
          mk('New jib sheets green and red','',true),
          mk('New anchor chain from Italy','',true),
          mk('Saildrive shafts stbd and port replaced','',true)
        ]},
        {id:uid(), name:'2024/2025', location:'Leros', items:[
          mk('Upgraded saloon cushions sponges','',true),
          mk('Placed a new water inlet/outlet port','',true),
          mk('Replaced trampoline line','',true),
          mk('Placed new water tank gauges','',true),
          mk('Replaced the water heaters','',true),
          mk('Fixed stbd hull gelcoat from the accident Nisiros','',true),
          mk('Fixed small gelcoat holes','',true),
          mk('Replaced saloon small port window panel','',true),
          mk('Fixed some stitches on the jib','',true),
          mk('Repainted keel with sika','',true),
          mk('Stainless solar panel scratch brushed up','',true),
          mk('Saildrive paint','',true),
          mk('Changed solenoid Lewmar winch port side','',true),
          mk('Changed foot step of Lewmar winch port side','',true),
          mk('Added extra 200Ah lithium battery and hub','',true),
          mk('Painted the bathroom door frame (humidity damage from winter in marina)','',true)
        ]},
        {id:uid(), name:'2025/2026', location:'Kilada', items:[
          mk('Watermaker cylinder replaced','',false),
          mk('Port head door squeaking issue fixed','',false),
          mk('Port rudder housing and ball replaced','',false),
          mk('Repainted antifouling on hulls','',false),
          mk('New bridal','',false),
          mk('All hatch frames sandblasting and repainted','',false),
          mk('Dinghy air hole leak patched','',false),
          mk('Sailpack zipper replaced','',false),
          mk('New fridge and housing structure added','',false),
          mk('Stern shore line reels rebuilt and painted','',false),
          mk('Dinghy davit motor cleaned','',false),
          mk('Top starboard deck sika patched','',false),
          mk('Flexible solar panels replaced (warranty)','',false),
          mk('Flexible solar panel gelcoat patched','',false),
          mk('Regluing the starboard aft window panel','',false),
          mk('Engine gauge replaced','',false),
          mk('Water heaters replaced under warranty','',false)
        ]},
        {id:uid(), name:'2026/2027', location:'', items:[
          mk('Top deck sika replaced','',false),
          mk('Aft dodger cover replaced','',false)
        ]}
      ]};
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
      <button class="btn btn-s btn-xs" onclick="ui.upgEdit=null;upgRerender()">✕</button>
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
      <button onclick="ui.upgConfirmDel='${iid}';upgRerender()"
        style="background:none;border:none;padding:4px 5px;cursor:pointer;font-size:13px;color:var(--label3);border-radius:4px;line-height:1">✕</button>
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

function renderSystems() {
  const systems = data.systems || [];
  const cats = [...new Set(systems.map(s=>s.cat||s.category).filter(Boolean))];
  return `
    <div class="btn-row">
      <button class="btn btn-p btn-sm" onclick="showAddSystem()">+ Add System</button>
    </div>
    ${cats.map(cat => `
      <div class="sec-hd">${esc(cat)}</div>
      ${systems.filter(s=>(s.cat||s.category)===cat).map(s => renderSystemCard(s)).join('')}
    `).join('')}`;
}

function renderSystemCard(s) {
  const open = ui.sysOpen === s.id;
  const wExp = expiryBadge(s.warrantyExpiry, 90);
  return `
    <div class="sys-card">
      <div class="sys-hdr" onclick="ui.sysOpen=ui.sysOpen==='${s.id}'?null:'${s.id}';document.getElementById('mainContent').innerHTML=renderSystems()">
        <div class="sys-icon">⚡</div>
        <div style="flex:1">
          <div style="font-size:15px;font-weight:600">${esc(s.make?s.make+' ':'')}${esc(s.model)}</div>
          <div style="font-size:12px;color:var(--label3)">${esc(s.notes||'')} ${s.location?'· '+esc(s.location):''}</div>
        </div>
        <div style="display:flex;align-items:center;gap:4px">
          <button onclick="event.stopPropagation();editSystem('${s.id}')" style="background:none;border:none;padding:5px;cursor:pointer;font-size:14px;color:var(--label3);border-radius:6px;line-height:1" title="Edit">✏️</button>
          <button onclick="event.stopPropagation();removeSystem('${s.id}')" style="background:none;border:none;padding:5px;cursor:pointer;font-size:14px;color:var(--label3);border-radius:6px;line-height:1" title="Delete">✕</button>
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
  const existingCats = [...new Set((data.systems||[]).map(s=>s.cat||s.category).filter(Boolean))];
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
  if (!confirm('Remove this system?')) return;
  data.systems = data.systems.filter(s=>s.id!==id); save();
  document.getElementById('mainContent').innerHTML = renderSystems();
}
function editSystem(id) {
  const s = (data.systems||[]).find(x=>x.id===id); if (!s) return;
  showModal('Edit System', `
    <div class="mi-label">Category</div><input class="mi" id="es-cat" value="${esc(s.cat||s.category||'')}">
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
      <button class="btn btn-s" onclick="hideModal()">Cancel</button>
      <button class="btn btn-p" onclick="saveEditSystem('${id}')">Save</button>
    </div>`);
}
function saveEditSystem(id) {
  const s = (data.systems||[]).find(x=>x.id===id); if (!s) return;
  const cat = document.getElementById('es-cat').value;
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
    if (isEdit) return grpHdr + `<div class="wrow">
      <input id="wedit-inp" class="mi" style="flex:1;margin:0;font-size:14px" value="${esc(item.text)}"
        onkeydown="if(event.key==='Enter')saveWinterItemEdit('${sid}',${i})" onkeyup="if(event.key==='Escape'){ui.winterEditItem=null;winterRerender()}">
      <button class="btn btn-p btn-xs" onclick="saveWinterItemEdit('${sid}',${i})">Save</button>
      <button class="wact" onclick="ui.winterEditItem=null;winterRerender()">✕</button>
    </div>`;
    const star = item.asterisk ? ` <span style="font-size:11px;opacity:.7">⚠️</span>` : '';
    const ts = item.checked ? 'text-decoration:line-through;color:var(--label3)' : item.asterisk ? 'color:var(--label2)' : '';
    const acts = archived ? '' : `<div style="display:flex;gap:1px;flex-shrink:0">
      <button class="wact" onclick="startWinterEdit('${sid}',${i})" title="Edit">✏️</button>
      <button class="wact" onclick="deleteWinterItem('${sid}',${i})" title="Delete">✕</button>
    </div>`;
    return grpHdr + `<div class="wrow">
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
  const v = document.getElementById('wedit-inp')?.value.trim();
  if (v) item.text = v;
  ui.winterEditItem = null;
  save(); winterRerender();
}

function deleteWinterItem(sid, idx) {
  if (!confirm('Remove this item?')) return;
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
      <input type="checkbox" id="m-wstar"> Mark as ⚠️ (needs a decision)
    </label>
    <div class="modal-btns">
      <button class="btn btn-s" onclick="hideModal()">Cancel</button>
      <button class="btn btn-p" onclick="addWinterItem('${sid}')">Add</button>
    </div>`);
}

function addWinterItem(sid) {
  const text = document.getElementById('m-wadd')?.value.trim();
  if (!text) { showToast('Enter item text', true); return; }
  const wd = getWinterData();
  const season = wd.seasons[wd.currentSeason];
  if (!season||season.archived) return;
  if (!season.sections[sid]) season.sections[sid] = {items:[]};
  season.sections[sid].items.push({id:uid(), text, asterisk:!!document.getElementById('m-wstar')?.checked, checked:false, group:null});
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
  document.getElementById('modalBody').innerHTML = `<div class="modal-title">${esc(title)}</div>${bodyHtml}`;
  document.getElementById('modalOv').classList.remove('hide');
}
function hideModal() {
  document.getElementById('modalOv').classList.add('hide');
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
    if (source[key] && typeof source[key] === 'object' && !Array.isArray(source[key])) {
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
      <td style="white-space:nowrap"><button class="btn btn-p btn-xs" onclick="saveTLStampEdit('${s.id}')">Save</button> <button class="btn btn-s btn-xs" onclick="ui.tlEditStampId=null;document.getElementById('mainContent').innerHTML=renderDocuments()">✕</button></td></tr>`;
    const typeCls = s.type==='Arrival'?'b-green':s.type==='Departure'?'b-red':'b-orange';
    const acts = archived ? '' : `<button onclick="startTLStampEdit('${s.id}')" style="background:none;border:none;padding:4px;cursor:pointer;font-size:13px;color:var(--label3)">✏️</button><button onclick="deleteTLStamp('${s.id}')" style="background:none;border:none;padding:4px;cursor:pointer;font-size:13px;color:var(--label3)">✕</button>`;
    return `<tr><td style="white-space:nowrap;font-size:13px">${esc(s.date)}</td><td style="font-size:13px">${esc(s.port)}</td>
      <td><span class="badge ${typeCls}" style="font-size:10px">${esc(s.type)}</span></td>
      <td style="font-size:12px;color:var(--label2)">${esc(s.authority||'')}</td>
      <td style="font-size:12px;color:var(--label2)">${esc(s.notes||'')}</td>
      <td style="white-space:nowrap">${acts}</td></tr>`;
  }).join('');
  return addBtn + `<div style="overflow-x:auto"><table class="tbl">
    <thead><tr><th>Date</th><th>Port</th><th>Type</th><th>Authority</th><th>Notes</th><th></th></tr></thead>
    <tbody>${rows}</tbody></table></div>`;
}

function renderTransitLog() {
  try { return _renderTransitLog(); } catch(e) { console.error('renderTransitLog:', e); return `<div style="padding:20px;color:var(--red);font-size:13px">Transit Log error: ${esc(e.message)}<br><small style="color:var(--label3)">${esc(e.stack||'')}</small></div>`; }
}
function _renderTransitLog() {
  const wd = getTLData();
  if (!ui.tlSeasonId) ui.tlSeasonId = wd.currentLog;
  if (!ui.tlOpen) ui.tlOpen = {s1:true, s2:true, s3:true};
  const log = wd.logs[ui.tlSeasonId]; if (!log) return '';
  const archived = log.archived, isCurrent = ui.tlSeasonId === wd.currentLog;
  const opts = Object.keys(wd.logs).reverse().map(id=>
    `<option value="${id}" ${id===ui.tlSeasonId?'selected':''}>${esc(wd.logs[id].season)}${wd.logs[id].archived?' 🔒':''}</option>`
  ).join('');
  const hdr = `<div style="display:flex;gap:8px;align-items:center;margin-bottom:14px;flex-wrap:wrap">
    <select onchange="ui.tlSeasonId=this.value;ui.tlOpen={s1:true,s2:true,s3:true};ui.tlEditStampId=null;document.getElementById('mainContent').innerHTML=renderDocuments()"
      style="flex:1;background:var(--surface);border:1.5px solid var(--sep);border-radius:20px;padding:7px 14px;font-size:14px;font-weight:600;font-family:var(--font);color:var(--label);cursor:pointer;min-width:140px">${opts}</select>
    ${isCurrent&&!archived?`<button class="btn btn-s btn-sm" onclick="archiveTransitLog()">Archive &amp; New</button>`:''}
    ${archived?`<span style="font-size:12px;font-weight:500;padding:6px 10px;background:var(--surface2);border-radius:12px;color:var(--label3)">🔒 Archived</span>`:''}
  </div>`;
  const exp = expiryBadge(log.validUntil, 60);
  const s1 = `<div class="card-body">
    ${frTL('Document Number (Αρ. Δελτίου)','docNumber',log.docNumber)}
    ${frTL('Issue Date (Ημερομηνία)','issueDate',log.issueDate)}
    ${frTL('Valid From (Από)','validFrom',log.validFrom)}
    <div class="fr"><div class="fl">Valid Until (Μέχρι) ${exp}</div><input class="fi" type="text" value="${esc(log.validUntil||'')}" onblur="saveTLField('validUntil',this.value)" placeholder="—"></div>
    ${frTL('Customs Authority (Τελ. Αρχή)','customsAuthority',log.customsAuthority)}
    ${frTLSelect('Validity Type','validityType',log.validityType||'Limited (Ορισμένη)',['Limited (Ορισμένη)','Unlimited (Αόριστη)'])}
    ${frTL('Previous Documents Count','prevDocCount',log.prevDocCount)}
    ${frTLArea('Other Notes','otherNotes',log.otherNotes)}
    ${frTLArea('Vessel Provisions and Bonded Stores','provisions',log.provisions)}
  </div>`;
  const s2 = `<div class="card-body">
    ${frTL('Vessel Name','vesselName',log.vesselName)}
    ${frTL('Flag','flag',log.flag)}
    ${frTL('Port of Registry','portOfRegistry',log.portOfRegistry)}
    ${frTL('Registration Number','regNumber',log.regNumber)}
    ${frTL('Call Sign','callSign',log.callSign)}
    ${frTL('Type of Vessel','vesselType',log.vesselType)}
    ${frTL('Gross Tonnage (GT)','gt',log.gt)}
    ${frTL('Engine','engine',log.engine)}
    ${frTL('Length (LOA)','loa',log.loa)}
    ${frTL('Year Built','yearBuilt',log.yearBuilt)}
    ${frTL('Year of First Registration','yearFirstReg',log.yearFirstReg)}
    ${frTL('Owner Name (Πλοιοκτήτης)','ownerName',log.ownerName)}
    ${frTL('Holder/User (Κατοχος-Χρηστης)','holderName',log.holderName)}
    ${frTL('Address','address',log.address)}
    ${frTL('Telephone','telephone',log.telephone)}
    ${frTL('Email','email',log.email)}
    ${frTL('AFM/TIN (ΑΦΜ)','afm',log.afm)}
    ${frTL('ID / Passport (ΑΔΤ ή Διαβατήριο)','idNumber',log.idNumber)}
  </div>`;
  return hdr + tlSection(1,'📋 Document Info',s1) + tlSection(2,'🚢 Vessel & Owner',s2) + tlSection(3,'🛂 Port Stamps (Δελτίο Κίνησης)',renderTLStamps(log,archived));
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
  if (!confirm('Remove this stamp?')) return;
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
  wd.currentLog=nid; ui.tlSeasonId=nid; ui.tlOpen={s1:true,s2:true,s3:true}; ui.tlEditStampId=null;
  save(); document.getElementById('mainContent').innerHTML=renderDocuments();
}

function prefillCustomsOwnerData() {
  if (localStorage.getItem(EMAIL_KEY) !== OWNER_EMAIL) return false;
  if (!data.documents?.customs) return false;
  const C = data.documents.customs;
  let dirty = false;
  const f = (k, v) => { if (!C[k]) { C[k] = v; dirty = true; } };
  f('applicationNumber', '795910');
  f('applicationDate',   '20/04/2026');
  f('entryDate',         '24/04/2026');
  f('year',              '2026');
  f('monthsCovered',     'April,May,June,July,August,September,October');
  f('amountPaid',        '€231.00');
  f('paymentCode',       '[PAYCODE-REMOVED]');
  f('adminFeeCode',      '[FEECODE-REMOVED]');
  f('status',            'New');
  f('ownerPassportNumber','[PASSPORT-REMOVED]');
  f('ownerPhone',        '[PHONE-REMOVED]');
  f('ownerAddress',      '[ADDRESS-REMOVED]');
  return dirty;
}

function prefillTransitLog() {
  if (localStorage.getItem(EMAIL_KEY) !== OWNER_EMAIL) return false;
  const wd = getTLData();
  const log = wd.logs[wd.currentLog];
  if (!log || log.archived || log.docNumber) return false;
  let dirty = false;
  const f = (k,v) => { if (!log[k]) { log[k]=v; dirty=true; } };
  f('docNumber','[DOCNUM-REMOVED]'); f('issueDate','05/05/2025');
  f('validFrom','05/05/2025');         f('validUntil','04/11/2026');
  f('customsAuthority','GR001236 PATMOS'); f('validityType','Limited (Ορισμένη)');
  f('prevDocCount','0');
  f('vesselName','OROBORO');           f('flag','US');
  f('portOfRegistry','San Francisco'); f('regNumber','1290676');
  f('callSign','[CALLSIGN-REMOVED]');            f('vesselType','Sail Yacht');
  f('gt','28');                        f('engine','Yanmar 30hp Diesel');
  f('loa','11.9m');                    f('yearBuilt','2018');
  f('yearFirstReg','2018');            f('ownerName','[NAME-REMOVED]');
  f('holderName','[NAME-REMOVED]'); f('address','[ADDRESS-REMOVED]');
  f('telephone','0');                  f('email',OWNER_EMAIL);
  f('afm','[AFM-REMOVED]');          f('idNumber','30');
  if (!log.stamps.length) {
    log.stamps = [
      {id:uid(), date:'2026-05-07', port:'Porto Heli', type:'Arrival',   authority:'Syros Coast Guard', notes:''},
      {id:uid(), date:'2026-05-09', port:'Paros',      type:'Departure', authority:'Syros Coast Guard', notes:''},
      {id:uid(), date:'2026-05-27', port:'Syros',      type:'Departure', authority:'Syros Coast Guard', notes:'To Didim/Turkey'}
    ];
    dirty = true;
  }
  return dirty;
}

function migrateData() {
  let dirty = false;
  try { (data.spareParts || []).forEach(p => { const n = normCat(p.category); if (n !== p.category) { p.category = n; dirty = true; } }); } catch(e) { console.warn('migrate spareParts', e); }
  try { if (migrateToSingleLog()) dirty = true; } catch(e) { console.warn('migrateToSingleLog', e); }
  // Seed belt history if not already present
  if (!data.maintenance) data.maintenance = { engines:{}, sched:{}, log:[] };
  if (!data.maintenance.log) data.maintenance.log = [];
  const hasBeltEntry = data.maintenance.log.some(e => e.id === 'seed_belt_920');
  if (!hasBeltEntry) {
    data.maintenance.log.push(
      { id:'seed_belt_920', date:'2021-07-01', hours:'920', task:'Inspect & adjust belt tension', cost:'', notes:'Mallorca', engines:['port','starboard'] },
      { id:'seed_belt_rep_920', date:'2021-07-01', hours:'920', task:'Replace belts', cost:'', notes:'Mallorca', engines:['port','starboard'] }
    );
    data.maintenance.log.sort((a,b) => b.date.localeCompare(a.date) || (parseFloat(b.hours)||0)-(parseFloat(a.hours)||0));
    dirty = true;
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
      <div class="setup-logo">${logoSrc ? `<img src="${logoSrc}" alt="Oroboro">` : '<div style="font-size:32px">⚓</div>'}</div>
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
      <div class="setup-logo"><img src="oroboro-logo-15.jpg" alt="Oroboro" style="max-width:220px;height:auto;display:block;margin:0 auto 24px;mix-blend-mode:multiply;"></div>
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
      try { if (prefillCustomsOwnerData()) prefillDirty = true; } catch(e) { console.warn('prefillCustoms', e); }
      try { if (prefillTransitLog()) prefillDirty = true; } catch(e) { console.warn('prefillTransitLog', e); }
      try { if (prefillUpgradesData()) prefillDirty = true; } catch(e) { console.warn('prefillUpgrades', e); }
      try { if (prefillSchengenData()) prefillDirty = true; } catch(e) { console.warn('prefillSchengen', e); }
      try { if (prefillShipyardData()) prefillDirty = true; } catch(e) { console.warn('prefillShipyard', e); }
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
      <div class="setup-logo"><img src="oroboro-logo-15.jpg" alt="Oroboro" style="max-width:220px;height:auto;display:block;margin:0 auto 24px;mix-blend-mode:multiply;"></div>
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
        try { if (prefillCustomsOwnerData()) prefillDirty = true; } catch(e) { console.warn('prefillCustoms', e); }
        try { if (prefillTransitLog()) prefillDirty = true; } catch(e) { console.warn('prefillTransitLog', e); }
        try { if (prefillUpgradesData()) prefillDirty = true; } catch(e) { console.warn('prefillUpgrades', e); }
        try { if (prefillSchengenData()) prefillDirty = true; } catch(e) { console.warn('prefillSchengen', e); }
      try { if (prefillShipyardData()) prefillDirty = true; } catch(e) { console.warn('prefillShipyard', e); }
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
      <div class="setup-logo">${logoSrc ? `<img src="${logoSrc}" alt="Oroboro">` : '<div style="font-size:32px;font-weight:800">⚓</div>'}</div>
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
      <div class="setup-logo">${logoSrc ? `<img src="${logoSrc}" alt="Oroboro">` : '<div style="font-size:32px;font-weight:800">⚓</div>'}</div>
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
      <div class="setup-logo">${logoSrc ? `<img src="${logoSrc}" alt="Oroboro">` : '<div style="font-size:32px;font-weight:800">⚓</div>'}</div>
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
  console.log('[pushToCloud] email:', email?.slice(0,10)||'NULL', 'salt:', salt?.slice(0,10)||'NULL', 'verify:', verify?.slice(0,10)||'NULL', 'enc:', enc?.slice(0,10)||'NULL');
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
  console.log('[pullFromCloud] email:', email?.slice(0,10)||'NULL', 'cryptoKey:', cryptoKey?'SET':'NULL');
  if (!email || !cryptoKey) { console.warn('pullFromCloud: no email or key'); return false; }
  const importTs = localStorage.getItem('bm_just_imported');
  if (importTs && Date.now() - parseInt(importTs) < 30000) {
    console.log('[pullFromCloud] skipping — recent import detected');
    return false;
  }
  try {
    const cloud = await fetchFromCloud(email);
    const decrypted = JSON.parse(await aesDecrypt(cryptoKey, cloud.data));
    console.log('[pullFromCloud] decrypted keys:', Object.keys(decrypted));
    console.log('[pullFromCloud] shipyard:', JSON.stringify(decrypted.shipyard));
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
  showModal('Privacy Policy', `
    <div style="font-size:13px;color:var(--label2);line-height:1.6;max-height:60vh;overflow-y:auto;padding-right:4px">
      <div style="font-size:15px;font-weight:700;color:var(--label);margin-bottom:4px">Privacy Policy — Oroboro Boat Manager</div>
      <div style="font-size:11px;color:var(--label3);margin-bottom:14px">Last updated: May 31, 2026</div>

      <b>What this app is</b><br>
      Oroboro Boat Manager is a personal boat management tool for sailors. It is not a commercial service open to the general public.<br><br>

      <b>What data we collect</b><br>
      Your email address (stored as an irreversible hash — we cannot read it), boat and vessel information, maintenance logs, documents and other data you enter manually. No location data, no tracking, no analytics, no advertising.<br><br>

      <b>How data is stored</b><br>
      All data is encrypted on your device using AES-256 before being transmitted. The encryption key is derived from your PIN and never leaves your device — not even the app developer can read your data. Encrypted data is stored on Cloudflare global infrastructure which may include servers outside the European Union. Since all data is end-to-end encrypted and unreadable without your PIN, this storage location does not affect the confidentiality of your information.<br><br>

      <b>Who can access your data</b><br>
      Only you with your PIN. Nobody else — not the app developer, not Cloudflare.<br><br>

      <b>Your rights under GDPR</b><br>
      • Right to access: your data is always accessible to you<br>
      • Right to deletion: delete your account and all data permanently from Settings<br>
      • Right to portability: export your data as JSON from Settings at any time<br><br>

      <b>Data breach</b><br>
      In the unlikely event of a security breach we will notify affected users within 72 hours.<br><br>

      <b>Contact:</b> [EMAIL-REMOVED]@gmail.com
    </div>
    <div class="modal-btns" style="margin-top:12px">
      <button class="btn btn-p" onclick="hideModal()">Close</button>
    </div>`);
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

window.addEventListener('DOMContentLoaded', init);
