const MEDS=['Fentanyl 100 mcg','Versed 2 mg','Versed 5 mg','Ketamine 500 mg','Morphine 10 mg'];
// User-specified department cap identifiers are presentation-only.
// Keep canonical medication keys unchanged for inventory, reports and cloud data.
function medicationDisplayName(medication=''){
 const med=String(medication);
 if(med==='Versed 2 mg')return 'Versed 2 mg (orange cap)';
 if(med==='Versed 5 mg')return 'Versed 5 mg (green cap)';
 return med;
}
function medicationDisplayHtml(medication=''){
 const med=String(medication);
 if(med==='Versed 2 mg')return 'Versed 2 mg <span class="vial-cap-label vial-cap-orange">Orange cap</span>';
 if(med==='Versed 5 mg')return 'Versed 5 mg <span class="vial-cap-label vial-cap-green">Green cap</span>';
 return esc(med);
}
function versedStrengthDisplayText(medication='',strength=''){
 const value=String(strength);
 if(String(medication)!=='Versed')return value;
 return value.replace(/\b2 mg\b/g,'2 mg (orange cap)').replace(/\b5 mg\b/g,'5 mg (green cap)');
}

const FINAL_ATTESTATION='I certify that I have personally reviewed this controlled-substance audit, the physical counts and seal records for Medic 1, Medic 2, Medic 3, Safe, and Expired, and each location’s signer and witness Certifications. To the best of my knowledge, this record is complete, accurate, and truthful. All shortages, overages, damaged or missing seals, expired stock, and other discrepancies identified during this audit are documented with corrective actions or escalation in the audit notes. I have not knowingly concealed a discrepancy or falsified any count, signature, or record. Unresolved discrepancies remain subject to investigation and required departmental reporting; this signature does not represent their resolution. By signing, I accept responsibility for this Certification and authorize finalization of this audit record.';
const LOCS=['Medic 1','Medic 2','Medic 3','Safe','Expired'];
const DB_NAME='narcotic-audit-db', DB_VER=2;
const SUPABASE_URL='https://fygyubamdxdfhvteyxyy.supabase.co';
const SUPABASE_KEY='sb_publishable_oDnbAnpzDxJ14Fx1KMNtFA_5vemlptG';
const CLOUD_STORES=new Set(['inventory','transactions','audits','reports','meta','legacyArchive']);
let db, sb, cloudSession=null, realtimeChannel=null;
let activeAuditId=null;
let auditAutosaveTimer=null;
let auditSaveInFlight=false;
let auditFinalizeInFlight=false;
let auditStartInFlight=false;
let auditSavePromise=null;
let auditExitInFlight=false;
let transactionSaveInFlight=false;
let lastCloudWrite='local';

// Heavy PDF tools are loaded on first use, not while opening the audit app.
const optionalScriptPromises=new Map();
function loadOptionalScript(url){
 if(optionalScriptPromises.has(url))return optionalScriptPromises.get(url);
 const task=new Promise((resolve,reject)=>{
   const script=document.createElement('script');
   script.src=url;script.async=true;
   script.onload=()=>resolve();
   script.onerror=()=>reject(new Error('Unable to load the PDF tool. Check your connection and try again.'));
   document.head.appendChild(script);
 });
 optionalScriptPromises.set(url,task);
 task.catch(()=>optionalScriptPromises.delete(url));
 return task;
}
async function ensurePdfReader(){
 if(!window.pdfjsLib)await loadOptionalScript('https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/build/pdf.min.js');
 if(!window.pdfjsLib)throw new Error('PDF reader is unavailable.');
 window.pdfjsLib.GlobalWorkerOptions.workerSrc='https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/build/pdf.worker.min.js';
}
async function ensurePdfWriter(){
 if(!window.html2pdf)await loadOptionalScript('https://cdn.jsdelivr.net/npm/html2pdf.js@0.10.1/dist/html2pdf.bundle.min.js');
 if(!window.html2pdf)throw new Error('PDF generator is unavailable.');
}
async function ensurePdfMerger(){
 if(!window.PDFLib?.PDFDocument)await loadOptionalScript('https://cdn.jsdelivr.net/npm/pdf-lib@1.17.1/dist/pdf-lib.min.js');
 if(!window.PDFLib?.PDFDocument)throw new Error('PDF packet merger is unavailable.');
}

function uid(prefix='id'){return prefix+'_'+Date.now().toString(36)+'_'+Math.random().toString(36).slice(2,8)}
function nowISO(){return new Date().toISOString()}
function esc(s=''){return String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[c]))}
function openDB(){return new Promise((resolve,reject)=>{const r=indexedDB.open(DB_NAME,DB_VER);r.onupgradeneeded=()=>{const d=r.result;['inventory','transactions','audits','reports','meta','legacyArchive'].forEach(n=>{if(!d.objectStoreNames.contains(n))d.createObjectStore(n,{keyPath:'id'})})};r.onsuccess=()=>{db=r.result;resolve(db)};r.onerror=()=>reject(r.error)})}
function store(name,mode='readonly'){return db.transaction(name,mode).objectStore(name)}
// Keep immutable finalized source data intact. A separate administrative
// correction record changes only how the reporting month is presented.
const REPORTING_MONTH_CORRECTION_ID='reporting-month-correction-audit_1';
function getAllRaw(name){return new Promise((res,rej)=>{const r=store(name).getAll();r.onsuccess=()=>res(r.result);r.onerror=()=>rej(r.error)})}
function getOneRaw(name,id){return new Promise((res,rej)=>{const r=store(name).get(id);r.onsuccess=()=>res(r.result);r.onerror=()=>rej(r.error)})}
function applyReportingMonthCorrection(row,correction){
 if(!row||!correction||correction.kind!=='reportingMonthCorrection')return row;
 if(!Array.isArray(correction.targetIds)||!correction.targetIds.includes(row.id))return row;
 if(row.month!==correction.fromMonth||
   row.dateRangeStart!==correction.originalPeriodStart||
   row.dateRangeEnd!==correction.originalPeriodEnd)return row;
 return {...row,month:correction.correctedMonth,monthValue:correction.correctedMonthValue,
   reportingMonthCorrection:{
     fromMonth:correction.fromMonth,toMonth:correction.correctedMonth,
     correctedAt:correction.correctedAt,reason:correction.reason,
     signatureScope:correction.signatureScope
   }};
}
async function getAll(name){
 const records=await getAllRaw(name);
 if((name!=='reports'&&name!=='audits')||!records.some(r=>r.id==='report_audit_1'||r.id==='audit_1'))return records;
 const correction=await getOneRaw('meta',REPORTING_MONTH_CORRECTION_ID);
 return records.map(row=>applyReportingMonthCorrection(row,correction));
}
async function getOne(name,id){
 const record=await getOneRaw(name,id);
 if(!record||(name!=='reports'&&name!=='audits')||(id!=='report_audit_1'&&id!=='audit_1'))return record;
 const correction=await getOneRaw('meta',REPORTING_MONTH_CORRECTION_ID);
 return applyReportingMonthCorrection(record,correction);
}
function putLocal(name,v){return new Promise((res,rej)=>{const r=store(name,'readwrite').put(v);r.onsuccess=()=>res(v);r.onerror=()=>rej(r.error)})}
function delLocal(name,id){return new Promise((res,rej)=>{const r=store(name,'readwrite').delete(id);r.onsuccess=()=>res();r.onerror=()=>rej(r.error)})}
function pendingWrites(){try{return JSON.parse(localStorage.getItem('narcoticPendingWrites')||'[]')}catch{return[]}}
function queueCloudWrite(op,name,id,data=null){
 const q=pendingWrites().filter(x=>!(x.store===name&&x.id===String(id)));
 q.push({op,store:name,id:String(id),data,queuedAt:nowISO()});
 localStorage.setItem('narcoticPendingWrites',JSON.stringify(q));
}
async function cloudUpsert(name,v){
 if(!sb||!cloudSession||!CLOUD_STORES.has(name))return false;
 const {error}=await sb.from('app_records').upsert({store:name,id:String(v.id),data:v,updated_at:v.updatedAt||nowISO()},{onConflict:'store,id'});
 if(error)throw error;return true;
}
async function put(name,v){
 await putLocal(name,v);
 if(!CLOUD_STORES.has(name))return v;
 if(!cloudSession||!navigator.onLine){queueCloudWrite('upsert',name,v.id,v);lastCloudWrite='pending';return v}
 try{await cloudUpsert(name,v);lastCloudWrite='live'}catch(e){queueCloudWrite('upsert',name,v.id,v);lastCloudWrite='pending'}
 return v;
}
async function del(name,id){
 await delLocal(name,id);
 if(!CLOUD_STORES.has(name))return;
 if(!cloudSession||!navigator.onLine){queueCloudWrite('delete',name,id);lastCloudWrite='pending';return}
 try{const {error}=await sb.from('app_records').delete().eq('store',name).eq('id',String(id));if(error)throw error;lastCloudWrite='live'}catch(e){queueCloudWrite('delete',name,id);lastCloudWrite='pending'}
}
async function flushPendingWrites(){
 if(!sb||!cloudSession||!navigator.onLine)return;
 const q=pendingWrites(), keep=[];
 for(const x of q){
   try{
     if(x.op==='delete'){const {error}=await sb.from('app_records').delete().eq('store',x.store).eq('id',x.id);if(error)throw error}
     else await cloudUpsert(x.store,x.data);
   }catch(e){keep.push(x)}
 }
 localStorage.setItem('narcoticPendingWrites',JSON.stringify(keep));
 if(!keep.length)lastCloudWrite='live';
}
function recordVersion(v){return String(v?.updatedAt||v?.finalizedAt||v?.createdAt||'')}
function localRecordIsNewer(local,remote){
 const lv=recordVersion(local),rv=recordVersion(remote);
 return Boolean(local&&lv&&rv&&lv>rv);
}
async function pullCloudRecords(onlyStore=null){
 if(!sb||!cloudSession)return;
 let request=sb.from('app_records').select('store,id,data,updated_at');
 if(onlyStore)request=request.eq('store',onlyStore);
 const {data,error}=await request;
 if(error)throw error;
 for(const r of data||[]){
   if(!CLOUD_STORES.has(r.store)||!r.data)continue;
   const local=await getOne(r.store,r.id);
   if(localRecordIsNewer(local,r.data)){
     queueCloudWrite('upsert',r.store,r.id,local);
     continue;
   }
   await putLocal(r.store,r.data);
 }
}
async function subscribeRealtime(){
 if(!sb||!cloudSession)return;
 if(realtimeChannel)await sb.removeChannel(realtimeChannel);
 realtimeChannel=sb.channel('narcotic-live-records')
   .on('postgres_changes',{event:'*',schema:'public',table:'app_records'},async payload=>{
     const row=payload.new&&payload.new.store?payload.new:payload.old;
     if(!row||!CLOUD_STORES.has(row.store))return;
     if(payload.eventType==='DELETE'){
       await delLocal(row.store,row.id);
     }else if(payload.new?.data){
       const local=await getOne(payload.new.store,payload.new.id);
       if(!localRecordIsNewer(local,payload.new.data))await putLocal(payload.new.store,payload.new.data);
     }
     if(document.getElementById('reportDialog')?.open)return;

     const auditEditorOpen=!!(activeAuditId&&document.getElementById('auditMonth'));
     if(auditEditorOpen){
       // Never tear down an audit form that is actively being completed.
       // Background live changes may update other screens, but Monthly Audit stays mounted.
       await Promise.all([renderInventory(),renderActivity(),renderReports(),renderStats()]);
       return;
     }
     await refreshAll();
   }).subscribe();
}
function digitsOnly(v=''){return String(v??'').replace(/\D+/g,'')}
function validEmployeeNumber(v=''){const raw=String(v??'').trim();return /^\d+$/.test(raw)}
function signedInEmployeeNumber(){return digitsOnly(cloudSession?.user?.user_metadata?.employee_number||'')}
function updateAccountUI(){
 const btn=document.getElementById('accountBtn');
 const logoffBtn=document.getElementById('logoffBtn');
 const emp=signedInEmployeeNumber();
 if(btn)btn.textContent=cloudSession?.user?.email?(cloudSession.user.email+(emp?' · #'+emp:'')):'Sign in';
 if(logoffBtn)logoffBtn.hidden=!cloudSession;
 document.body.classList.toggle('cloud-authenticated',!!cloudSession);
}
async function initCloud(){
 if(!window.supabase)return;
 sb=window.supabase.createClient(SUPABASE_URL,SUPABASE_KEY,{auth:{persistSession:true,autoRefreshToken:true}});
 const {data}=await sb.auth.getSession();cloudSession=data.session||null;
 if(cloudSession&&!signedInEmployeeNumber()){
   await sb.auth.signOut();
   cloudSession=null;
 }
 updateAccountUI();
 sb.auth.onAuthStateChange(async(_event,session)=>{
   cloudSession=session||null;updateAccountUI();
   // getSession() already initializes a persisted login. INITIAL_SESSION events
   // must not trigger another expensive download of every signature/report.
   if(_event==='INITIAL_SESSION'||_event==='TOKEN_REFRESHED')return;
   if(cloudSession){
     await flushPendingWrites();await pullCloudRecords();await flushPendingWrites();await subscribeRealtime();
     if(activeAuditId&&document.getElementById('auditMonth'))await Promise.all([renderInventory(),renderActivity(),renderReports(),renderStats()]);
     else await refreshAll();
   }
 });
 if(cloudSession){await flushPendingWrites();await pullCloudRecords();await flushPendingWrites();await subscribeRealtime()}
}
function requireCloudAuth(){
 if(cloudSession&&signedInEmployeeNumber())return true;
 if(cloudSession&&!signedInEmployeeNumber())sb?.auth?.signOut();
 document.getElementById('authDialog')?.showModal();
 return false;
}

async function seedInventory(){const rows=await getAll('inventory');if(rows.length)return;for(const loc of LOCS)for(const med of MEDS)await put('inventory',{id:loc+'|'+med,location:loc,medication:med,quantity:0,updatedAt:nowISO()})}
function emptyInventoryBalances(){
 const result={};
 for(const loc of LOCS){result[loc]={};for(const med of MEDS)result[loc][med]=0}
 return result;
}
function latestFinalizedPhysicalAudit(reports=[]){
 return [...reports]
   .filter(r=>String(r?.status||'finalized').toLowerCase()==='finalized'
     &&LOCS.every(loc=>MEDS.every(med=>{
       const val=r.counts?.[loc]?.[med];
       return val!==null&&val!==undefined&&val!==''&&Number.isInteger(Number(val))&&Number(val)>=0;
     })))
   .sort((a,b)=>String(b.auditDate||b.finalizedAt||b.createdAt||'').localeCompare(String(a.auditDate||a.finalizedAt||a.createdAt||''))
     ||String(b.finalizedAt||b.updatedAt||b.createdAt||'').localeCompare(String(a.finalizedAt||a.updatedAt||a.createdAt||'')))[0]||null;
}
function recordedInventoryChanges(tx){
 if(tx.status==='draft'||tx.reconciliationMode==='audit_physical_count'||tx.inventoryAdjusted===false)return [];
 if(Array.isArray(tx.inventoryImpact)&&tx.inventoryImpact.length){
   return tx.inventoryImpact.map(row=>({
     location:row.location,medication:row.medication,change:Number(row.change)
   }));
 }
 const items=Array.isArray(tx.items)&&tx.items.length?tx.items:[{medication:tx.medication,quantity:tx.quantity}];
 const changes=[];
 for(const item of items){
   const quantity=Number(item.quantity);
   if(!Number.isFinite(quantity)||quantity<=0)continue;
   if(tx.type==='received')changes.push({location:'Safe',medication:item.medication,change:quantity});
   if(tx.type==='destroyed')changes.push({location:'Expired',medication:item.medication,change:-quantity});
   if(tx.type==='incident'&&tx.fromLocation)changes.push({location:tx.fromLocation,medication:item.medication,change:-quantity});
 }
 return changes;
}
async function inventorySnapshot(){
 const [raw, reports, transactions]=await Promise.all([getAll('inventory'),getAll('reports'),getAll('transactions')]);
 const lastAudit=latestFinalizedPhysicalAudit(reports);
 const result=emptyInventoryBalances();
 if(!lastAudit){
   raw.forEach(r=>{if(result[r.location]&&Object.prototype.hasOwnProperty.call(result[r.location],r.medication))result[r.location][r.medication]=Number(r.quantity||0)});
   return {balances:result,lastAudit:null,adjustedTransactions:0};
 }
 for(const loc of LOCS)for(const med of MEDS)result[loc][med]=Number(lastAudit.counts[loc][med]);
 // Use the final certification time when present. Legacy audits without one use the
 // latest recorded correction timestamp, so their amended physical count remains authoritative.
 const cutoff=lastAudit.finalizedAt||lastAudit.updatedAt||lastAudit.createdAt||(lastAudit.auditDate+'T23:59:59.999Z');
 const cutoffMs=Date.parse(cutoff);
 let adjustedTransactions=0;
 for(const tx of transactions){
   if(String(tx.status||'submitted').toLowerCase()!=='submitted')continue;
   const time=Date.parse(tx.timestamp||tx.createdAt||'');
   if(!Number.isFinite(time)||!Number.isFinite(cutoffMs)||time<=cutoffMs)continue;
   const changes=recordedInventoryChanges(tx);
   let applied=false;
   for(const change of changes){
     if(!result[change.location]||!Object.prototype.hasOwnProperty.call(result[change.location],change.medication)
       ||!Number.isFinite(change.change))continue;
     result[change.location][change.medication]+=change.change;
     applied=true;
   }
   if(applied)adjustedTransactions++;
 }
 return {balances:result,lastAudit,adjustedTransactions};
}
async function balances(){return (await inventorySnapshot()).balances}
async function setBalance(location,medication,quantity){await put('inventory',{id:location+'|'+medication,location,medication,quantity:Number(quantity||0),updatedAt:nowISO()})}
function formatDisplayDate(v){
 if(v===null||v===undefined||v==='')return '';
 const s=String(v).trim();

 let m=s.match(/^(\d{4})-(\d{2})-(\d{2})(?:[T\s].*)?$/);
 if(m)return m[2]+'/'+m[3]+'/'+m[1];

 m=s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})(?:[\sT].*)?$/);
 if(m){
   const y=m[3].length===2?'20'+m[3]:m[3];
   return String(m[1]).padStart(2,'0')+'/'+String(m[2]).padStart(2,'0')+'/'+y;
 }

 const d=v instanceof Date?v:new Date(v);
 if(!Number.isNaN(d.getTime())){
   return String(d.getMonth()+1).padStart(2,'0')+'/'+String(d.getDate()).padStart(2,'0')+'/'+d.getFullYear();
 }
 return s;
}
function fmtDate(v){return formatDisplayDate(v)}
function enforceIntegerInputBehavior(root=document){
 const inputs=root.querySelectorAll?.('input[type="number"],input[inputmode="numeric"],input[data-integer-only]')||[];
 inputs.forEach(input=>{
   input.setAttribute('inputmode','numeric');
   input.setAttribute('data-integer-only','');
   if(input.type==='number')input.setAttribute('step','1');
   else input.setAttribute('pattern','[0-9]*');
 });
}
document.addEventListener('beforeinput',e=>{
 const input=e.target;
 if(!(input instanceof HTMLInputElement)||!input.matches('[data-integer-only]'))return;
 if(e.inputType==='insertText'&&e.data&&!/^\d+$/.test(e.data))e.preventDefault();
});
document.addEventListener('input',e=>{
 const input=e.target;
 if(!(input instanceof HTMLInputElement)||!input.matches('[data-integer-only]'))return;
 const cleaned=digitsOnly(input.value);
 if(input.value!==cleaned)input.value=cleaned;
});
const integerObserver=new MutationObserver(records=>{
 for(const record of records){
   for(const node of record.addedNodes){
     if(node instanceof Element){
       if(node.matches?.('input'))enforceIntegerInputBehavior(node.parentElement||document);
       else enforceIntegerInputBehavior(node);
     }
   }
 }
});
document.addEventListener('DOMContentLoaded',()=>{
 enforceIntegerInputBehavior(document);
 integerObserver.observe(document.body,{childList:true,subtree:true});
});
function monthTextToValue(v=''){
 const m=String(v).trim().match(/^([A-Za-z]+)\s+(\d{4})$/);
 if(!m)return '';
 const idx=['january','february','march','april','may','june','july','august','september','october','november','december'].indexOf(m[1].toLowerCase());
 return idx<0?'':m[2]+'-'+String(idx+1).padStart(2,'0');
}
function monthValueToText(v=''){
 const m=String(v).match(/^(\d{4})-(\d{2})$/);
 if(!m)return '';
 const names=['January','February','March','April','May','June','July','August','September','October','November','December'];
 const i=Number(m[2])-1;
 return names[i]?names[i]+' '+m[1]:'';
}

async function renderInventory(){
 const grid=document.getElementById('inventoryGrid'),totals=document.getElementById('activeTotals');
 if(!grid||!totals)return;
 const {balances:b,lastAudit,adjustedTransactions}=await inventorySnapshot();
 const lastAuditDate=lastAudit?formatDisplayDate(lastAudit.auditDate||lastAudit.finalizedAt||lastAudit.createdAt):'';
 const basisText=lastAuditDate
   ?'Baseline: physical counts from the finalized '+lastAuditDate+' audit.'+
     (adjustedTransactions?' Adjusted by '+adjustedTransactions+' submitted inventory transaction'+(adjustedTransactions===1?'':'s')+' after that audit.':' No later inventory transactions are recorded.')+
     ' Draft audit counts do not change this dashboard until the entire audit is finalized. Reconfirm stock physically before use.'
   :'No finalized physical audit is on file. Displayed balances reflect recorded inventory data only and should not be interpreted as a verified physical count.';
 const totalBasis=document.getElementById('inventoryBalanceAsOf');
 if(totalBasis)totalBasis.textContent=basisText;
 grid.innerHTML=LOCS.map(loc=>'<div class="location-card"><h3><span>'+loc+'</span><span class="pill '+(loc==='Expired'?'expired':'')+'">'+(loc==='Expired'?'Segregated':'Active')+'</span></h3><div class="location-card-meta">'+esc(lastAuditDate?'Last physical audit: '+lastAuditDate:'No finalized physical audit on file')+'</div>'+MEDS.map(m=>'<div class="med-row"><span>'+medicationDisplayHtml(m)+'</span><strong>'+b[loc][m]+'</strong></div>').join('')+'</div>').join('');
 const activeLocations=['Medic 1','Medic 2','Medic 3','Safe'];
 const activeSum=activeLocations.reduce((n,l)=>n+MEDS.reduce((m,med)=>m+Number(b[l]?.[med]||0),0),0);
 const expiredSum=MEDS.reduce((n,med)=>n+Number(b['Expired']?.[med]||0),0);
 totals.innerHTML='<div class="physical-vial-tally dashboard-tally"><div><span>ACTIVE VIALS</span><strong>'+activeSum+'</strong><small>Medic 1 + Medic 2 + Medic 3 + Safe</small></div><div><span>EXPIRED VIALS</span><strong>'+expiredSum+'</strong><small>Expired location only</small></div></div>'+
 MEDS.map(m=>{const t=activeLocations.reduce((a,l)=>a+b[l][m],0);return '<div class="total-row"><div><b>'+medicationDisplayHtml(m)+'</b><small>Medic 1 + Medic 2 + Medic 3 + Safe</small></div><strong>'+t+'</strong></div>'}).join('');
}

async function renderActivity(){
 const q=(document.getElementById('activitySearch')?.value||'').toLowerCase();
 let rows=await getAll('transactions');
 rows.sort((a,b)=>String(b.timestamp||'').localeCompare(String(a.timestamp||'')));
 if(q)rows=rows.filter(r=>JSON.stringify(r).toLowerCase().includes(q));
 document.getElementById('activityList').innerHTML=rows.length?rows.map(r=>{
   const items=Array.isArray(r.items)&&r.items.length?r.items:[{medication:r.medication,quantity:r.quantity}];
   const itemText=items.map(x=>medicationDisplayHtml(x.medication)+' × '+esc(x.quantity)).join(' · ');
   return '<div class="list-item"><strong>'+esc(r.typeLabel||r.type)+(r.status==='draft'?' · DRAFT':'')+'</strong><div>'+itemText+'</div><div>'+esc(r.sourcePharmacy||r.externalSource||r.incidentSourceLocation||r.fromLocation||'—')+' → '+esc(r.toLocation||'—')+'</div><div class="meta">'+fmtDate(r.timestamp)+(r.recordedBy?' · '+esc(r.recordedBy)+(r.recordedByEmployeeNumber?' #'+esc(r.recordedByEmployeeNumber):''):'')+(r.witness?' · Witness '+esc(r.witness)+(r.witnessEmployeeNumber?' #'+esc(r.witnessEmployeeNumber):''):'')+'</div>'+(r.summary?'<div>'+esc(r.summary)+'</div>':'')+(Array.isArray(r.inventoryImpact)&&r.inventoryImpact.length?'<div class="meta">'+r.inventoryImpact.map(x=>esc(x.location+' · '+x.medication+': '+x.before+' → '+x.after)).join('<br>')+'</div>':'')+(r.notes?'<div>'+esc(r.notes)+'</div>':'')+(r.memoDescription?'<div class="meta"><b>Memo description:</b> '+esc(r.memoDescription)+'</div>':'')+(r.supportingDocument?'<div class="meta"><b>'+esc(r.supportingDocument.documentType||'Supporting PDF')+':</b> '+esc(r.supportingDocument.name||'Attached PDF')+'</div>':'')+(r.destructionReceipt?'<div class="meta"><b>Destruction receipt:</b> '+esc(r.destructionReceipt.name||'Attached PDF')+'</div>':'')+(r.type==='incident'&&r.status==='draft'?'<div class="button-row"><button type="button" data-resume-incident="'+esc(r.id)+'">Resume incident</button></div>':'')+'</div>';
 }).join(''):'<div class="empty">No activity recorded yet.</div>';
}

async function saveTransaction(fd,finalSubmit=true){
 if(transactionSaveInFlight)throw new Error('This transaction is already being saved.');
 if(!requireCloudAuth())throw new Error('Sign in is required for live inventory changes.');
 transactionSaveInFlight=true;
 try{

 const type=fd.get('type');
 const auditContextId=String(fd.get('auditContextId')||'').trim();
 const existingTransactionId=String(fd.get('transactionId')||'').trim();
 const existingTx=existingTransactionId?await getOne('transactions',existingTransactionId):null;
 const auditLinkedIncident=type==='incident'&&Boolean(auditContextId);
 const incidentDraft=type==='incident'&&!finalSubmit;
 const from=type==='destroyed'?'Expired':fd.get('fromLocation');
 const to=type==='destroyed'?'':fd.get('toLocation');
 const destination=type==='received'?'Safe':to;
 const sourcePharmacy=String(fd.get('sourcePharmacy')||'').trim();
 const destructionCompany=type==='destroyed'?String(fd.get('destructionCompany')||'').trim():'';
 const memoDescription=type==='incident'?String(fd.get('memoDescription')||'').trim():'';
 const meds=fd.getAll('txMedication');
 const qtys=fd.getAll('txQuantity');
 const rawItems=meds.map((med,i)=>({medication:String(med||''),quantity:Number(qtys[i]||0)})).filter(x=>x.medication&&x.quantity>0);
 const itemTotals=new Map();
 rawItems.forEach(x=>itemTotals.set(x.medication,(itemTotals.get(x.medication)||0)+x.quantity));
 const items=[...itemTotals.entries()].map(([medication,quantity])=>({medication,quantity}));
 if(!items.length)throw new Error('Add at least one medication with a quantity greater than zero.');

 const recordedBy=String(fd.get('recordedBy')||'').trim();
 const recordedByEmployeeNumber=String(fd.get('recordedByEmployeeNumber')||'').trim();
 const witness=String(fd.get('witness')||'').trim();
 const witnessEmployeeNumber=String(fd.get('witnessEmployeeNumber')||'').trim();
 const recordedCanvas=document.getElementById('txRecordedSignature');
 const witnessCanvas=document.getElementById('txWitnessSignature');
 const requireCompletedSignatures=type!=='incident'||finalSubmit;
 if(requireCompletedSignatures){
   if(!recordedBy)throw new Error('Enter the employee recording the transaction.');
   if(!validEmployeeNumber(recordedByEmployeeNumber))throw new Error('Enter a valid recorded-by employee number using digits only.');
   if(!witness)throw new Error('Enter the witness.');
   if(!validEmployeeNumber(witnessEmployeeNumber))throw new Error('Enter a valid witness employee number using digits only.');
   if(recordedCanvas?.dataset.hasSignature!=='true')throw new Error('Recorded-by signature is required.');
   if(witnessCanvas?.dataset.hasSignature!=='true')throw new Error('Witness signature is required.');
 }

 const supportFile=fd.get('supportingPdf');
 const uploadedFile=(supportFile instanceof File&&supportFile.size)?supportFile:null;
 const existingSupport=existingTx?.supportingDocument||null;
 const destructionReceiptFile=fd.get('destructionReceipt');
 const uploadedDestructionReceipt=(destructionReceiptFile instanceof File&&destructionReceiptFile.size)?destructionReceiptFile:null;
 const existingDestructionReceipt=existingTx?.destructionReceipt||null;
 const requires222=type==='received'||type==='destroyed';
 const requiresIncidentMemo=type==='incident'&&finalSubmit;
 if(requires222&&!uploadedFile&&!existingSupport)throw new Error('Attach the required DEA Form 222 PDF before saving this transaction.');
 if(type==='destroyed'&&!uploadedDestructionReceipt&&!existingDestructionReceipt)throw new Error('Attach the destruction company receipt before saving this transaction.');
 if(requiresIncidentMemo&&!uploadedFile&&!existingSupport)throw new Error('Attach the discrepancy / incident memo PDF before submitting this incident.');
 if(uploadedFile&&uploadedFile.type!=='application/pdf'&&!/\.pdf$/i.test(uploadedFile.name))throw new Error('Supporting documents must be PDF files.');
 if(uploadedDestructionReceipt&&uploadedDestructionReceipt.type!=='application/pdf'&&!/\.pdf$/i.test(uploadedDestructionReceipt.name))throw new Error('The destruction receipt must be a PDF file.');

 if(type==='received'&&!sourcePharmacy)throw new Error('Enter the source pharmacy.');
 if(type==='destroyed'&&!destructionCompany)throw new Error('Enter the destruction company.');
 if((type==='destroyed'||type==='incident')&&!from)throw new Error('Choose the source location.');
 if(type==='incident'&&from==='Expired'&&!auditLinkedIncident)throw new Error('Expired inventory can only be reduced through Destroyed / transferred out.');
 if(type==='incident'&&!String(fd.get('notes')||'').trim())throw new Error('Enter an incident / discrepancy explanation.');

 const b=await balances();
 const shouldAdjustIncident=type==='incident'&&!auditLinkedIncident&&!incidentDraft&&!existingTx?.inventoryAdjusted&&from!=='Expired';
 if(type==='destroyed'||shouldAdjustIncident){
   for(const item of items){
     if(Number(b[from]?.[item.medication]||0)<item.quantity)throw new Error(item.medication+' quantity exceeds the current '+from+' balance.');
   }
 }

 const txId=existingTransactionId||uid('tx');
 const inventoryImpact=items.map(item=>{
   if(type==='received'){
     const before=Number(b.Safe?.[item.medication]||0);
     return {location:'Safe',medication:item.medication,before,change:item.quantity,after:before+item.quantity};
   }
   if(type==='destroyed'){
     const before=Number(b.Expired?.[item.medication]||0);
     return {location:'Expired',medication:item.medication,before,change:-item.quantity,after:before-item.quantity};
   }
   if(type==='incident'&&shouldAdjustIncident){
     const before=Number(b[from]?.[item.medication]||0);
     return {location:from,medication:item.medication,before,change:-item.quantity,after:before-item.quantity};
   }
   return null;
 }).filter(Boolean);
 let supportingDocument=existingSupport;
 let destructionReceipt=existingDestructionReceipt;
 if(uploadedFile){
   const buf=await uploadedFile.arrayBuffer();
   const digest=await sha256Buffer(buf);
   const path='transactions/'+txId+'/'+Date.now()+'-'+safeStorageName(uploadedFile.name);
   const {error:uploadError}=await sb.storage.from('audit-supporting-docs').upload(path,uploadedFile,{contentType:'application/pdf',upsert:false});
   if(uploadError)throw uploadError;
   supportingDocument={
     documentType:requires222?'DEA Form 222':(type==='incident'?'Discrepancy / incident memo':'Supporting transaction PDF'),
     name:uploadedFile.name,
     description:type==='incident'?memoDescription:'',
     storageBucket:'audit-supporting-docs',
     storagePath:path,
     mimeType:'application/pdf',
     size:uploadedFile.size,
     sha256:digest,
     uploadedAt:nowISO(),
     uploadedBy:cloudSession?.user?.email||''
   };
 }
 if(uploadedDestructionReceipt){
   const buf=await uploadedDestructionReceipt.arrayBuffer();
   const digest=await sha256Buffer(buf);
   const path='transactions/'+txId+'/'+Date.now()+'-destruction-receipt-'+safeStorageName(uploadedDestructionReceipt.name);
   const {error:receiptUploadError}=await sb.storage.from('audit-supporting-docs').upload(path,uploadedDestructionReceipt,{contentType:'application/pdf',upsert:false});
   if(receiptUploadError)throw receiptUploadError;
   destructionReceipt={
     documentType:'Destruction receipt',
     name:uploadedDestructionReceipt.name,
     destructionCompany,
     storageBucket:'audit-supporting-docs',
     storagePath:path,
     mimeType:'application/pdf',
     size:uploadedDestructionReceipt.size,
     sha256:digest,
     uploadedAt:nowISO(),
     uploadedBy:cloudSession?.user?.email||''
   };
 }

 for(const item of items){
   const med=item.medication,qty=item.quantity;
   if(type==='received'&&!existingTx?.inventoryAdjusted){
     await setBalance('Safe',med,Number(b.Safe?.[med]||0)+qty);
     b.Safe[med]=Number(b.Safe?.[med]||0)+qty;
   }else if(type==='destroyed'&&!existingTx?.inventoryAdjusted){
     await setBalance('Expired',med,Number(b.Expired?.[med]||0)-qty);
     b.Expired[med]=Number(b.Expired?.[med]||0)-qty;
   }else if(shouldAdjustIncident){
     await setBalance(from,med,Number(b[from]?.[med]||0)-qty);
     b[from][med]=Number(b[from]?.[med]||0)-qty;
   }
 }

 const labels={received:'Received / restock',destroyed:'Destroyed / transferred out',incident:'Discrepancy / incident'};
 const transactionSummary=type==='received'
   ?'Received from '+sourcePharmacy+' into Safe: '+items.map(x=>x.medication+' × '+x.quantity).join(', ')+'.'
   :(type==='destroyed'
     ?'Released from Expired inventory to '+destructionCompany+' for destruction: '+items.map(x=>x.medication+' × '+x.quantity).join(', ')+'.'
     :'');
 const txRecord={
   ...(existingTx||{}),
   id:txId,
   timestamp:existingTx?.timestamp||nowISO(),
   updatedAt:nowISO(),
   type,
   typeLabel:labels[type],
   items,
   medications:items,
   medication:items.length===1?items[0].medication:'Multiple medications',
   quantity:items.reduce((n,x)=>n+x.quantity,0),
   fromLocation:type==='received'?'':from,
   incidentSourceLocation:type==='incident'?from:'',
   auditId:auditLinkedIncident?auditContextId:(existingTx?.auditId||''),
   reconciliationMode:auditLinkedIncident?'audit_physical_count':(incidentDraft?'draft_pending':'transaction_adjustment'),
   inventoryAdjusted:type==='incident'?(auditLinkedIncident?false:(incidentDraft?Boolean(existingTx?.inventoryAdjusted):true)):true,
   status:type==='incident'?(finalSubmit?'submitted':'draft'):'submitted',
   externalSource:type==='received'?sourcePharmacy:'',
   sourcePharmacy:type==='received'?sourcePharmacy:'',
   destructionCompany:type==='destroyed'?destructionCompany:'',
   toLocation:(type==='incident'||type==='destroyed')?'':destination,
   notes:(type==='received'||type==='destroyed')?'':(fd.get('notes')||''),
   summary:transactionSummary,
   inventoryImpact,
   memoDescription:type==='incident'?memoDescription:'',
   recordedBy,
   recordedByEmployeeNumber,
   witness,
   witnessEmployeeNumber,
   recordedBySignature:recordedCanvas?.dataset.hasSignature==='true'?recordedCanvas.toDataURL():'',
   witnessSignature:witnessCanvas?.dataset.hasSignature==='true'?witnessCanvas.toDataURL():'',
   supportingDocument,
   destructionReceipt:type==='destroyed'?destructionReceipt:null
 };
 await put('transactions',txRecord);

 if(auditLinkedIncident){
   const audit=await getOne('audits',auditContextId);
   if(audit){
     audit.incidents=Array.isArray(audit.incidents)?audit.incidents:[];
     const incidentRecord={
       transactionId:txId,
       timestamp:txRecord.timestamp,
       updatedAt:txRecord.updatedAt,
       sourceLocation:from,
       items,
       explanation:txRecord.notes,
       memoDescription,
       recordedBy,
       recordedByEmployeeNumber,
       witness,
       witnessEmployeeNumber,
       supportingDocument,
       reconciliationMode:'audit_physical_count',
       status:finalSubmit?'submitted':'draft'
     };
     const ix=audit.incidents.findIndex(x=>x.transactionId===txId);
     if(ix>=0)audit.incidents[ix]=incidentRecord;else audit.incidents.push(incidentRecord);
     audit.supportingDocuments=Array.isArray(audit.supportingDocuments)?audit.supportingDocuments:[];
     audit.supportingDocuments=audit.supportingDocuments.filter(d=>d.linkedTransactionId!==txId);
     if(supportingDocument)audit.supportingDocuments.push({...supportingDocument,linkedTransactionId:txId,documentType:'Discrepancy / incident memo',sourceLocation:from,description:memoDescription});
     audit.updatedAt=nowISO();
     await put('audits',audit);
   }
 }
 await refreshAll();
 return txRecord;
 }finally{
   transactionSaveInFlight=false;
 }
}

function auditSkeleton(a){
 const b=a.counts||{};return '<div class="audit-card"><div class="audit-header"><div><h3>'+esc(a.month||'Draft audit')+'</h3><div class="meta">Status: '+esc(a.status||'draft')+' · Saved '+fmtDate(a.updatedAt)+'</div></div><div class="button-row"><button data-audit-action="open" data-id="'+a.id+'">Open</button><button data-audit-action="delete" data-id="'+a.id+'">Delete</button></div></div></div>'
}
function activateAuditTab(){
 const tab=document.querySelector('.tabs button[data-tab="audit"]');
 if(tab)document.querySelectorAll('.tabs button').forEach(b=>b.classList.toggle('active',b===tab));
 document.querySelectorAll('.tab-panel').forEach(p=>p.classList.toggle('active',p.id==='audit'));
}
function unfinishedAudits(rows){
 return (rows||[]).filter(a=>String(a.status||'draft').toLowerCase()==='draft')
 .sort((a,b)=>String(b.updatedAt||b.createdAt||'').localeCompare(String(a.updatedAt||a.createdAt||'')));
}
async function updateAuditLaunchControls(rows){
 const drafts=unfinishedAudits(rows||await getAll('audits'));
 const editing=Boolean(activeAuditId&&document.getElementById('auditMonth'));
 const exists=drafts.find(a=>a.id===activeAuditId)||drafts[0];
 for(const id of ['startAuditHomeBtn','newAuditBtn']){
   const button=document.getElementById(id);
   if(!button)continue;
   button.textContent=exists?'Continue Audit':'Start Audit';
   button.title=exists?'Resume the existing audit, not a new draft':'Start a new audit';
   button.disabled=auditStartInFlight;
 }
 const monthly=document.getElementById('newAuditBtn');
 if(monthly){monthly.hidden=editing;monthly.style.display=editing?'none':'';}
}
async function renderAudits(){
 const drafts=unfinishedAudits(await getAll('audits'));
 if(activeAuditId&&document.getElementById('auditMonth')){
   // Background inventory/transaction updates must not remove a live edit form.
   await updateAuditLaunchControls(drafts);
   return;
 }
 document.getElementById('auditWorkspace').innerHTML=
 (drafts.length?'<div class="notice">Continue an existing live draft at another location. Do not finalize until all locations are counted and signed.</div>':'')+
 (drafts.length?drafts.map(auditSkeleton).join(''):'<div class="card empty">No monthly audit is currently in progress.</div>');
 await updateAuditLaunchControls(drafts);
}
async function startAudit(){
 if(auditStartInFlight)return;
 if(!requireCloudAuth())return;
 auditStartInFlight=true;
 await updateAuditLaunchControls();
 try{
   if(activeAuditId&&document.getElementById('auditMonth')){
     activateAuditTab();
     return;
   }
   if(navigator.onLine){await flushPendingWrites();await pullCloudRecords('audits');}
   const drafts=unfinishedAudits(await getAll('audits'));
   if(drafts.length){activateAuditTab();await editAudit(drafts[0].id);return;}
   if(!navigator.onLine){
     alert('Go online before creating a new audit so the shared database can be checked. Existing drafts remain available offline.');
     return;
   }
   const b=await balances(),reports=await getAll('reports');
   const d=new Date(),month=d.toLocaleString(undefined,{month:'long',year:'numeric'});
   reports.sort((x,y)=>String(y.finalizedAt||y.updatedAt||y.createdAt||'').localeCompare(String(x.finalizedAt||x.updatedAt||x.createdAt||'')));
   const previous=reports[0]||null;
   const counts={},priorCounts={},openingCounts={};
   LOCS.forEach(loc=>{
     counts[loc]={};priorCounts[loc]={};openingCounts[loc]={};
     MEDS.forEach(med=>{
       counts[loc][med]=null;
       openingCounts[loc][med]=b[loc][med];
       priorCounts[loc][med]=previous?.counts?.[loc]?.[med]??null;
     });
   });
   const localDate=d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0');
   const emp=signedInEmployeeNumber();
   const a={id:uid('audit'),month,status:'draft',createdAt:nowISO(),updatedAt:nowISO(),auditDate:localDate,email:cloudSession?.user?.email||'',counts,priorCounts,openingCounts,countConfirmations:{},dateRangeStart:'',dateRangeEnd:'',notes:'',usageSummary:'',breakawayTags:{},supportingDocuments:[],administrationRows:[],incidents:[],inventoryFindings:[],signatures:{},auditorName:'',auditorEmployeeNumber:emp,attestationText:FINAL_ATTESTATION,attestationName:'',attestationEmployeeNumber:emp,attestationAccepted:false};
   await put('audits',a);
   activateAuditTab();
   await editAudit(a.id);
 }catch(err){console.error('Unable to start or resume audit',err);alert('Unable to open audit: '+(err?.message||String(err)));}
 finally{auditStartInFlight=false;await updateAuditLaunchControls();}
}
function unitAuditSection(a,loc,index){
 const tag=a.breakawayTags?.[loc]||{},savedSig=a.signatures?.[loc]||{};
 const sig={...savedSig,signer:savedSig.signer||a.auditorName||'',employeeNumber:savedSig.employeeNumber||a.auditorEmployeeNumber||''};
 const medRows=MEDS.map(m=>{
   const prior=a.priorCounts?.[loc]?.[m];
   const current=a.counts?.[loc]?.[m];
   const confirmed=a.countConfirmations?.[loc]?.[m];
   const locked=Boolean(confirmed&&current!==null&&current!==undefined&&Number(confirmed.value)===Number(current));
   const l=esc(loc),med=esc(m);
   const issue=loc==='Expired'?'':'<button type="button" class="audit-finding-btn" data-audit-finding data-loc="'+l+'" data-med="'+med+'">Damaged / expired vial</button>';
   return '<div class="unit-med-row compact"><div class="unit-med-name">'+medicationDisplayHtml(m)+'</div><div class="unit-prior"><span>Last</span><strong>'+(prior==null?'—':Number(prior))+'</strong></div>'+
     '<label class="unit-current"><span>Current</span><input aria-label="'+esc(medicationDisplayName(m))+' '+l+' current count" type="number" min="0" step="1" inputmode="numeric" data-count-loc="'+l+'" data-count-med="'+med+'" value="'+(current===null||current===undefined?'':Number(current))+'" '+(locked?'readonly data-confirmed-at="'+esc(confirmed.confirmedAt||'')+'" data-confirmed-by="'+esc(confirmed.confirmedBy||'')+'"':'')+' required></label>'+
     '<div class="unit-med-actions"><button type="button" data-confirm-count data-loc="'+l+'" data-med="'+med+'" '+(locked?'hidden':'')+'>Confirm Count</button>'+
     '<button type="button" data-edit-count data-loc="'+l+'" data-med="'+med+'" '+(!locked?'hidden':'')+'>Edit Count</button>'+
     '<span class="count-confirmed-status" data-count-confirmed="'+l+'|'+med+'" '+(!locked?'hidden':'')+'>✓ Count saved</span>'+
     issue+'<button type="button" class="audit-incident-btn" data-audit-incident data-loc="'+l+'" data-med="'+med+'">Discrepancy / incident</button></div></div>';
 }).join('');
 return '<section class="audit-card unit-audit-card compact-unit" data-unit-section="'+esc(loc)+'">'+
 '<details class="audit-site-details" data-site-loc="'+esc(loc)+'" open>'+
 '<summary class="unit-audit-head compact-head audit-site-summary">'+
 '<div class="audit-site-heading"><span class="kicker">LOCATION '+(index+1)+' OF '+LOCS.length+'</span><h3>'+esc(loc)+'</h3>'+
 '<span class="audit-site-recap" data-site-recap hidden>5/5 counts confirmed · Seals recorded · Both signatures captured</span></div>'+
 '<span class="audit-site-state" data-site-state>In progress</span></summary>'+
 '<div class="unit-compact-grid">'+
 '<div class="unit-compact-panel seal-panel"><h4>Seals</h4><div class="tag-entry-fields seal-pair"><label>Tag found / removed<input inputmode="numeric" autocomplete="off" placeholder="Tag #" data-tag-loc="'+loc+'" data-tag-kind="foundRemoved" aria-label="'+loc+' tag found or removed" value="'+esc(tag.foundRemoved||'')+'"></label><label>New tag installed<input inputmode="numeric" autocomplete="off" placeholder="Tag #" data-tag-loc="'+loc+'" data-tag-kind="newInstalled" aria-label="'+loc+' new tag installed" value="'+esc(tag.newInstalled||'')+'"></label></div></div>'+
 '<div class="unit-compact-panel inventory-panel"><div class="inventory-panel-head"><h4>Physical inventory</h4><span class="inventory-panel-help">Count each vial physically present at this location.</span></div><div class="unit-med-list">'+medRows+'</div></div>'+
 '<div class="unit-compact-panel certification-panel"><h4>Certification</h4>'+sigBlock(loc,sig,true)+'</div>'+
 '</div></details></section>';
}
function sigBlock(loc,s={},embedded=false){return '<div class="signature-box audit-signature-block'+(embedded?' embedded-signature':'')+'" data-sig-loc="'+loc+'">'+(!embedded?'<div class="signature-location">'+loc+'</div>':'')+'<div class="audit-signature-cards">'+
'<section class="audit-signature-card auditor-card"><div class="audit-signature-card-head"><strong>Auditor</strong><span>Certification signature</span></div><div class="audit-signature-fields"><label>Name<input placeholder="Full name" data-signer required value="'+esc(s.signer||'')+'"></label><label>Employee number<input placeholder="Employee #" type="text" inputmode="numeric" pattern="[0-9]*" autocomplete="off" data-integer-only data-employee-number required value="'+esc(s.employeeNumber||'')+'"></label></div><div class="audit-signature-canvas-wrap"><canvas width="500" height="150" data-canvas></canvas></div><div class="audit-signature-actions"><button type="button" class="clear-signature-btn" data-clear-signature="auditor">Clear</button><button type="button" class="expand-signature" data-expand-signature="auditor">Open larger</button></div></section>'+
'<section class="audit-signature-card witness-card"><div class="audit-signature-card-head"><strong>Witness</strong><span>Certification signature</span></div><div class="audit-signature-fields"><label>Name<input placeholder="Full name" data-witness required value="'+esc(s.witness||'')+'"></label><label>Employee number<input placeholder="Employee #" type="text" inputmode="numeric" pattern="[0-9]*" autocomplete="off" data-integer-only data-witness-employee-number required value="'+esc(s.witnessEmployeeNumber||'')+'"></label></div><div class="audit-signature-canvas-wrap"><canvas width="500" height="150" data-witness-canvas></canvas></div><div class="audit-signature-actions"><button type="button" class="clear-signature-btn" data-clear-signature="witness">Clear</button><button type="button" class="expand-signature" data-expand-signature="witness">Open larger</button></div></section>'+
'</div></div>'}
function adminDoseUnit(medication=''){
 const m=String(medication).toLowerCase();
 return m==='fentanyl'?'mcg':'mg';
}
function actualAdministrationPreview(rows=[]){
 if(!Array.isArray(rows)||!rows.length)return '';
 const sorted=[...rows].sort((a,b)=>{
   const da=new Date(formatAdminDate(a.date)),db=new Date(formatAdminDate(b.date));
   return da-db||String(a.report).localeCompare(String(b.report));
 });
 return '<details class="admin-detail-block"><summary>View imported doses</summary><div class="admin-actual-table"><div class="admin-actual-head"><span>Date</span><span>Report</span><span>Provider</span><span>Medication</span><span>Dose</span><span>Unit</span></div>'+
 sorted.map(r=>'<div class="admin-actual-row"><span data-label="Date">'+esc(formatAdminDate(r.date))+'</span><span data-label="Report">'+esc(r.report)+'</span><span data-label="Provider">'+esc(r.provider)+'</span><span data-label="Medication">'+medicationDisplayHtml(r.medication)+'</span><span data-label="Dose"><b>'+esc(r.dose)+' '+esc(adminDoseUnit(r.medication))+'</b></span><span data-label="Unit">'+esc(String(r.unit||'').replace(/^M([123])$/,'M$1'))+'</span></div>').join('')+
 '</div></details>';
}
function administrationGroupKey(row){
 return [row.date,row.report,row.medication,row.unit].join('|');
}
function groupedAdministrations(rows=[]){
 const groups=new Map();
 for(const row of rows||[]){
   const key=administrationGroupKey(row);
   const group=groups.get(key)||{...row,key,totalDose:0,doses:[],providers:[]};
   const dose=Number(row.dose);
   group.totalDose+=Number.isFinite(dose)?dose:0;
   group.doses.push(dose);
   if(row.provider&&!group.providers.includes(row.provider))group.providers.push(row.provider);
   groups.set(key,group);
 }
 return [...groups.values()];
}
function providerVialData(rows=[],overrides={}){
 const byProvider=new Map(),pending=[];
 for(const group of groupedAdministrations(rows)){
   const override=overrides?.[group.key]||null;
   const result=administrationVialCount(group.medication,group.totalDose,group.doses,override);
   const provider=(group.providers.length?group.providers:[group.provider]).filter(Boolean).join(' / ')||'Unknown provider';
   const item={
     key:group.key,date:formatAdminDate(group.date),report:group.report,
     medication:group.medication,dose:group.totalDose,
     doses:group.doses,doseUnit:adminDoseUnit(group.medication),
     unit:String(group.unit||'').replace(/^M([123])$/,'Medic $1'),
     strength:result.strength,vials:result.count,
     pending:result.needsReview,confirmed:result.confirmed,
     vial2:result.vial2??0,vial5:result.vial5??0
   };
   if(result.needsReview)pending.push(item);
   if(!byProvider.has(provider))byProvider.set(provider,[]);
   byProvider.get(provider).push(item);
 }
 const providers=[...byProvider.entries()].sort((a,b)=>a[0].localeCompare(b[0]));
 const allItems=providers.flatMap(([,items])=>items);
 return {providers,total:pending.length?null:allItems.reduce((n,item)=>n+item.vials,0),pending,items:allItems};
}
function providerVialSummary(rows=[],overrides={}){
 const data=providerVialData(rows,overrides);
 if(!data.providers.length)return '';
 const content=data.providers.map(([provider,items])=>{
   const unresolved=items.some(item=>item.pending);
   const total=unresolved?null:items.reduce((n,item)=>n+item.vials,0);
   const medTotals=new Map();
   const add=(med,strength,n)=>{
     if(!n)return;
     const k=med+'|'+strength;
     medTotals.set(k,(medTotals.get(k)||0)+n);
   };
   for(const item of items){
     if(item.pending){add(item.medication,'Needs confirmation',1);continue;}
     if(item.medication==='Versed'){add('Versed','2 mg',item.vial2);add('Versed','5 mg',item.vial5);}
     else add(item.medication,item.strength,item.vials);
   }
   const medSummary=[...medTotals.entries()].map(([key,n])=>{
     const [med,strength]=key.split('|');
     return strength==='Needs confirmation'?med+': needs confirmation':med+' '+versedStrengthDisplayText(med,strength)+': '+n+' vial'+(n===1?'':'s');
   }).join(' · ');
   const details=items.slice().sort((a,b)=>a.date.localeCompare(b.date)||String(a.report).localeCompare(String(b.report))).map(item=>
     '<div class="provider-vial-detail-row">'+
       '<div><strong>'+esc(item.date)+'</strong><span>'+esc(item.report)+' · '+esc(item.unit)+'</span></div>'+
       '<div><strong>'+esc(item.medication)+' — '+esc(item.dose)+' '+esc(item.doseUnit)+' given</strong><span>'+
       (item.pending?'Needs manual vial confirmation':esc(versedStrengthDisplayText(item.medication,item.strength))+' · '+item.vials+' vial'+(item.vials===1?'':'s'))+'</span></div>'+
       '<div class="provider-vial-calc">'+(item.pending?'Review':item.vials+' vial'+(item.vials===1?'':'s'))+'</div></div>'
   ).join('');
   return '<details class="provider-vial-provider"><summary><div><strong>'+esc(provider)+'</strong><span>'+
     esc(medSummary)+
     '</span></div><div class="provider-vial-total">'+(total===null?'Review':total+' vial'+(total===1?'':'s'))+
     '</div></summary><div class="provider-vial-detail-list">'+details+'</div></details>';
 }).join('');
 return '<details class="admin-detail-block"><summary>View vials by provider</summary><div class="provider-vial-list">'+content+'</div></details>';
}
function administrationImportStats(rows=[],overrides={}){
 const data=providerVialData(rows,overrides);
 const providers=new Set((rows||[]).map(r=>String(r.provider||'').trim()).filter(Boolean));
 return {administrations:(rows||[]).length,vials:data.total,providers:providers.size,pending:data.pending.length};
}
function versedReviewHtml(rows=[],overrides={}){
 const data=providerVialData(rows,overrides);
 const versed=data.items.filter(item=>item.medication==='Versed');
 if(!versed.length)return '';
 const groups=versed.map(item=>{
   const key=esc(item.key),pending=item.pending;
   return '<div class="versed-review-row" data-versed-key="'+key+'">'+
     '<div class="versed-review-head"><strong>'+esc(item.report)+' · '+esc(item.unit)+'</strong><span>'+
     esc(item.date)+' · '+esc(item.doses.join(' + '))+' mg = '+item.dose+' mg</span></div>'+
     '<div class="versed-review-current">'+
     (pending?'Needs confirmation':item.vials+' vial'+(item.vials===1?'':'s')+' · '+esc(versedStrengthDisplayText(item.medication,item.strength))+(item.confirmed?' · Manually confirmed':' · Derived from dose entries'))+'</div>'+
     '<div class="versed-review-actions">'+
     '<label class="vial-label-orange">2 mg vials (orange cap)<input type="number" min="0" step="1" inputmode="numeric" data-versed-2="'+key+'" value="'+(pending?'':item.vial2)+'"></label>'+
     '<label class="vial-label-green">5 mg vials (green cap)<input type="number" min="0" step="1" inputmode="numeric" data-versed-5="'+key+'" value="'+(pending?'':item.vial5)+'"></label>'+
     '<button type="button" data-versed-confirm="'+key+'">Confirm vials</button></div>'+
     '</div>';
 }).join('');
 return '<div class="versed-reconciliation"><h4>Versed vial reconciliation</h4>'+
 '<p>Default vial calculation follows each recorded 2 mg (orange cap) or 5 mg (green cap) dose. If a dose was drawn from another vial size, confirm the actual vials used below. This does not change physical inventory.</p>'+
 (data.pending.length?'<div class="versed-reconciliation-warning">Some vial counts need confirmation before finalizing.</div>':'')+
 groups+'</div>';
}
function administrationImportSection(a){
 const docs=Array.isArray(a.supportingDocuments)?a.supportingDocuments:[];
 const latest=[...docs].reverse().find(d=>Array.isArray(d.administrationRows));
 const rows=Array.isArray(a.administrationRows)?a.administrationRows:latest?.administrationRows||[];
 const overrides=a.vialOverrides||{};
 const stats=administrationImportStats(rows,overrides);
 if(latest?.transcript)a.usageSummary=buildAdministrationSummary(latest.transcript,latest.name||'PDF',overrides);
 return '<details class="audit-card admin-import-card compact-admin-import mobile-collapsible-admin" open>'+
 '<summary class="admin-import-summarybar"><div><span class="kicker">ADMINISTRATION RECORDS</span><h3>Administration import</h3></div><span class="admin-collapse-label">Show / hide</span></summary>'+
 '<div class="admin-import-body">'+
 '<div class="admin-import-top"><div id="adminImportStatus" class="admin-import-status">'+(latest?'Imported: '+esc(latest.name||'PDF'):'No administration PDF imported yet.')+'</div><div class="admin-import-actions"><button type="button" id="uploadAdminPdf" class="primary">'+(latest?'Replace Administration PDF':'Import Administration PDF')+'</button>'+
 (latest?'<button type="button" id="undoAdminImport">Undo last import</button>':'')+
 '<input id="adminPdfFile" type="file" accept="application/pdf,.pdf" hidden></div></div>'+
 (rows.length?'<div class="admin-import-summary"><div><strong>'+stats.administrations+'</strong><span>Dose entries</span></div><div class="admin-total-vials"><strong>'+(stats.vials===null?'Pending confirmation':stats.vials)+'</strong><span>TOTAL VIALS ADMINISTERED · ENTIRE AUDIT</span></div><div><strong>'+stats.providers+'</strong><span>Providers</span></div></div>':'')+
 (stats.pending?'<p class="admin-review-banner">'+stats.pending+' Versed administration group'+(stats.pending===1?'':'s')+' need vial confirmation. Provider totals and the overall count will remain pending until reviewed.</p>':'')+
 actualAdministrationPreview(rows)+versedReviewHtml(rows,overrides)+providerVialSummary(rows,overrides)+
 (rows.length?'<div class="admin-import-grand-total"><span>All providers combined — total vials administered</span><strong>'+(stats.vials===null?'Pending confirmation':stats.vials+' vials')+'</strong></div>':'')+
 '<textarea id="usageSummary" hidden>'+esc(a.usageSummary||'')+'</textarea>'+
 '</div></details>';
}
async function sha256Buffer(buf){const hash=await crypto.subtle.digest('SHA-256',buf);return [...new Uint8Array(hash)].map(b=>b.toString(16).padStart(2,'0')).join('')}
function safeStorageName(name='document.pdf'){return String(name).replace(/[^a-zA-Z0-9._-]+/g,'_').slice(-120)||'document.pdf'}
async function extractPdfTranscript(file){
 await ensurePdfReader();
 const buf=await file.arrayBuffer();
 const pdf=await window.pdfjsLib.getDocument({data:buf}).promise;
 const pages=[];
 for(let p=1;p<=pdf.numPages;p++){
   const page=await pdf.getPage(p),content=await page.getTextContent();
   const rows=[];
   for(const item of content.items||[]){
     const y=Math.round((item.transform?.[5]||0)*2)/2,x=item.transform?.[4]||0,s=String(item.str||'').trim();
     if(!s)continue;
     let row=rows.find(r=>Math.abs(r.y-y)<=1.5);
     if(!row){row={y,items:[]};rows.push(row)}
     row.items.push({x,s});
   }
   rows.sort((a,b)=>b.y-a.y);
   const lines=rows.map(r=>r.items.sort((a,b)=>a.x-b.x).map(i=>i.s).join(' ').replace(/\s+/g,' ').trim()).filter(Boolean);
   pages.push(lines.join('\n'));
 }
 return {text:pages.map((t,i)=>'--- Page '+(i+1)+' ---\n'+t).join('\n\n'),arrayBuffer:buf,pageCount:pdf.numPages};
}
function parseAdministrationRows(transcript){
 const lines=String(transcript||'').split(/\r?\n/).map(x=>x.replace(/\s+/g,' ').trim()).filter(Boolean);
 const meds=['Fentanyl','Versed','Midazolam','Ketamine','Morphine'];
 const rows=[];
 for(const line of lines){
   const dateMatch=line.match(/^(\d{1,2}\/\d{1,2}\/\d{2,4})\s+(GFD\d+)\s+(.+?)\s+(Fentanyl|Versed|Midazolam|Ketamine|Morphine)\s+([0-9.]+)\s+(M[123])$/i);
   if(!dateMatch)continue;
   const [,date,report,provider,medRaw,doseRaw,unitRaw]=dateMatch;
   const med=medRaw.toLowerCase()==='midazolam'?'Versed':medRaw.charAt(0).toUpperCase()+medRaw.slice(1).toLowerCase();
   rows.push({date,report,provider:provider.replace(/\s+/g,' ').trim(),medication:med,dose:Number(doseRaw),unit:unitRaw.toUpperCase(),raw:line});
 }
 return rows;
}
function administrationVialCount(medication,totalDose,doses=[],override=null){
 if(medication==='Versed'){
   if(override&&Number.isInteger(override.vial2)&&Number.isInteger(override.vial5)
     &&override.vial2>=0&&override.vial5>=0
     &&override.vial2+override.vial5>0
     &&override.vial2*2+override.vial5*5>=totalDose){
     return {count:override.vial2+override.vial5,vial2:override.vial2,vial5:override.vial5,
       strength:override.vial2+' × 2 mg + '+override.vial5+' × 5 mg',needsReview:false,confirmed:true};
   }
   const exact=doses.length&&doses.every(d=>d===2||d===5);
   if(!exact)return {count:null,strength:'Unconfirmed 2 mg / 5 mg vial mix',needsReview:true,confirmed:false};
   const vial2=doses.filter(d=>d===2).length,vial5=doses.filter(d=>d===5).length;
   return {count:vial2+vial5,vial2,vial5,
     strength:vial2+' × 2 mg + '+vial5+' × 5 mg',needsReview:false,confirmed:false};
 }
 if(medication==='Fentanyl')return {count:Math.max(1,Math.ceil(totalDose/100)),strength:'100 mcg',needsReview:false};
 if(medication==='Ketamine')return {count:Math.max(1,Math.ceil(totalDose/500)),strength:'500 mg',needsReview:false};
 if(medication==='Morphine')return {count:Math.max(1,Math.ceil(totalDose/10)),strength:'10 mg',needsReview:false};
 return {count:1,strength:'',needsReview:false};
}
function formatAdminDate(v){return formatDisplayDate(v)}
function buildAdministrationSummary(transcript,fileName,overrides={}){
 const rows=parseAdministrationRows(transcript);
 if(!rows.length)return 'Narcotic administration summary — '+fileName+'\nNo administration rows could be reliably identified from the PDF. Reference only; manual inventory counts unchanged.';
 const groups=groupedAdministrations(rows).sort((a,b)=>String(a.date).localeCompare(String(b.date))||String(a.report).localeCompare(String(b.report)));
 let total=0,pending=0;
 const lines=groups.map(g=>{
   const vial=administrationVialCount(g.medication,g.totalDose,g.doses,overrides[g.key]);
   const provider=g.providers.filter(Boolean).join(' / ');
   const location=String(g.unit||'').replace(/^M([123])$/,'Medic $1');
   if(vial.needsReview)pending++;else total+=vial.count;
   return '• '+formatAdminDate(g.date)+' | Report '+g.report+' | '+g.medication+
     ' '+(vial.needsReview?'VIAL COUNT NEEDS CONFIRMATION':versedStrengthDisplayText(g.medication,vial.strength)+': '+vial.count+' vials')+
     ' | '+location+(provider?' | By '+provider:'');
 });
 const period=String(transcript).match(/Months in Treatment Date Timestamp\s+(\d{2}\/\d{4})/i);
 return 'Narcotic administration summary'+(period?' ('+period[1]+')':'')+' — '+fileName+
   '\n\n'+lines.join('\n\n')+'\n\nTotal: '+(pending?'Pending confirmation ('+pending+' entry group(s))':total+' vials')+
   '. Versed vial size is derived from individual 2 mg and 5 mg dose entries or manually confirmed when ambiguous. This is a reconciliation reference only; physical counts remain unchanged.';
}
async function handleAdministrationPdf(auditId,file){
 if(!file)return;
 if(!requireCloudAuth())return;
 if(file.type!=='application/pdf'&&!/\.pdf$/i.test(file.name))return alert('Choose a PDF file.');
 const status=document.getElementById('adminImportStatus');
 if(status)status.textContent='Reading and transcribing PDF…';
 try{
   const extracted=await extractPdfTranscript(file);
   const cleanText=extracted.text.trim();
   if(!cleanText||cleanText.replace(/--- Page \d+ ---/g,'').trim().length<20)throw new Error('This PDF does not contain enough extractable text. Use the text-based administration export rather than a scanned image PDF.');
   if(status)status.textContent='Saving current audit before import…';
   if(!(await flushAuditAutosave()))throw new Error('Save the audit before replacing its administration PDF.');
   if(status)status.textContent='Uploading private supporting PDF…';
   const audit=await getOne('audits',auditId);if(!audit||audit.status!=='draft')throw new Error('An editable audit draft was not found.');
   const digest=await sha256Buffer(extracted.arrayBuffer);
   const path=String(auditId)+'/'+Date.now()+'-'+safeStorageName(file.name);
   const {error:uploadError}=await sb.storage.from('audit-supporting-docs').upload(path,file,{contentType:'application/pdf',upsert:false});
   if(uploadError)throw uploadError;
   const administrationRows=parseAdministrationRows(cleanText);
   const summary=buildAdministrationSummary(cleanText,file.name);
   const previousUsageSummary=audit.usageSummary||'';
   const previousVialOverrides=structuredClone(audit.vialOverrides||{});
   audit.vialOverrides={};
   audit.administrationRows=administrationRows;
   audit.supportingDocuments=Array.isArray(audit.supportingDocuments)?audit.supportingDocuments:[];
   audit.supportingDocuments.push({name:file.name,storageBucket:'audit-supporting-docs',storagePath:path,mimeType:'application/pdf',size:file.size,pageCount:extracted.pageCount,sha256:digest,uploadedAt:nowISO(),uploadedBy:cloudSession?.user?.email||'',transcript:cleanText,administrationRows,
      previousUsageSummary,previousVialOverrides});
   audit.usageSummary=summary;
   audit.updatedAt=nowISO();
   await put('audits',audit);
   const ta=document.getElementById('usageSummary');if(ta)ta.value=summary;
   const pending=pendingWrites().some(x=>x.store==='audits'&&x.id===auditId);
   if(status)status.textContent=(pending?'PDF imported; cloud sync pending · ':'PDF imported · ')+file.name+' · '+extracted.pageCount+' page'+(extracted.pageCount===1?'':'s');
   setAutosaveStatus(pending?'Saved locally · sync pending':'Saved live '+new Date().toLocaleTimeString([], {hour:'numeric',minute:'2-digit',second:'2-digit'}));
   await editAudit(auditId);
 }catch(err){
   if(status)status.textContent='Import failed: '+(err?.message||String(err));
 }
}

// Removes only the latest administration import from the editable audit.
// Storage objects are retained for historical recovery; physical counts and
// certification signatures are never changed by this operation.
async function undoAdministrationImport(auditId){
 if(!requireCloudAuth())return;
 const latest=await getOne('audits',auditId);
 if(!latest||latest.status!=='draft')return alert('Only an unfinished audit can undo an import.');
 const docs=Array.isArray(latest.supportingDocuments)?latest.supportingDocuments:[];
 const index=docs.findLastIndex(d=>Array.isArray(d.administrationRows));
 if(index<0)return alert('There is no administration import to undo.');
 const removed=docs[index];
 if(!confirm('Undo the last administration import ('+(removed.name||'PDF')+')? Imported dose rows and vial confirmations from that file will be replaced with the previous import, if any. All counts, seals and signatures remain unchanged.'))return;
 const saved=await flushAuditAutosave();
 if(!saved)return alert('The audit could not be saved. Import was not removed.');
 const audit=await getOne('audits',auditId);
 if(!audit||audit.status!=='draft')return alert('The draft is not available.');
 const currentDocs=Array.isArray(audit.supportingDocuments)?audit.supportingDocuments:[];
 const currentIndex=currentDocs.findLastIndex(d=>Array.isArray(d.administrationRows));
 if(currentIndex<0)return alert('No administration import is available.');
 const deleted=currentDocs[currentIndex];
 audit.supportingDocuments=currentDocs.filter((_,i)=>i!==currentIndex);
 const previous=[...audit.supportingDocuments].reverse().find(d=>Array.isArray(d.administrationRows));
 audit.administrationRows=previous?.administrationRows||[];
 audit.vialOverrides=deleted.previousVialOverrides&&typeof deleted.previousVialOverrides==='object'?deleted.previousVialOverrides:{};
 audit.usageSummary=deleted.previousUsageSummary??(previous?.transcript?buildAdministrationSummary(previous.transcript,previous.name||'PDF',audit.vialOverrides):'');
 audit.administrationImportHistory=Array.isArray(audit.administrationImportHistory)?audit.administrationImportHistory:[];
 audit.administrationImportHistory.push({action:'undo',fileName:deleted.name||'PDF',storagePath:deleted.storagePath||'',at:nowISO(),by:cloudSession?.user?.email||''});
 audit.updatedAt=nowISO();
 await put('audits',audit);
 await editAudit(auditId);
 const pending=pendingWrites().some(x=>x.store==='audits'&&x.id===auditId);
 setAutosaveStatus(pending?'Saved locally · sync pending':'Saved live');
}

// All audit sections stay in the normal document flow on phones so staff can
// scroll from one site to the next, or jump directly using the section links.
// Single-section audit workflow on phones, with a stable native page scroll.
// Sections switch only when the user explicitly navigates; keyboard and Safari
// toolbar viewport changes must never cause the page to jump.
// Visual-only progress indicators. Never mutate counts or signatures here.
function updateAuditPhysicalTotals(){
 const root=document.querySelector('.audit-workspace-shell');
 if(!root)return;
 const counts=[...root.querySelectorAll('[data-count-loc][data-count-med]')];
 const sumFor=locations=>{
   const selected=counts.filter(c=>locations.includes(c.dataset.countLoc));
   const filled=selected.filter(c=>c.value!==''&&Number.isFinite(Number(c.value))&&Number(c.value)>=0);
   return {total:filled.reduce((n,c)=>n+Number(c.value),0),complete:selected.length===MEDS.length*locations.length&&filled.length===selected.length,filled:filled.length,expected:MEDS.length*locations.length};
 };
 const active=sumFor(['Medic 1','Medic 2','Medic 3','Safe']),expired=sumFor(['Expired']);
 const display=(id,data)=>{
   const el=document.getElementById(id);
   if(!el)return;
   el.textContent=data.complete?data.total+' vials':data.total+' counted · '+data.filled+'/'+data.expected+' entered';
   el.dataset.complete=data.complete?'true':'false';
 };
 display('auditActiveVialTotal',active);
 display('auditExpiredVialTotal',expired);
}
function updateAuditRouteProgress(){
 updateAuditPhysicalTotals();
 const shell=document.querySelector('.audit-workspace-shell');
 if(!shell)return;
 shell.querySelectorAll('[data-route-loc]').forEach(link=>{
   const loc=link.dataset.routeLoc;
   const section=[...shell.querySelectorAll('[data-unit-section]')]
     .find(node=>node.dataset.unitSection===loc);
   if(!section)return;
   const counts=[...section.querySelectorAll('[data-count-loc]')];
   const allConfirmed=counts.length===MEDS.length&&
     counts.every(input=>input.value!==''&&input.readOnly&&Number.isInteger(Number(input.value))&&Number(input.value)>=0);
   const signatures=section.querySelector('.signature-box');
   const signed=Boolean(signatures?.querySelector('[data-canvas]')?.dataset.hasSignature==='true'
     &&signatures?.querySelector('[data-witness-canvas]')?.dataset.hasSignature==='true');
   const identified=Boolean(signatures?.querySelector('[data-signer]')?.value.trim()
     &&signatures?.querySelector('[data-witness]')?.value.trim()
     &&validEmployeeNumber(signatures?.querySelector('[data-employee-number]')?.value)
     &&validEmployeeNumber(signatures?.querySelector('[data-witness-employee-number]')?.value));
   const seals=[...section.querySelectorAll('[data-tag-loc]')];
   const sealed=seals.length>=2&&seals.every(input=>input.value.trim());
   const complete=Boolean(allConfirmed&&signed&&identified&&sealed);
   link.classList.toggle('complete',complete);
   const indicator=link.querySelector('.route-status-mark');
   if(indicator)indicator.textContent=complete?'✓':'';
   const details=section.querySelector('.audit-site-details');
   if(details){
     const previouslyComplete=details.dataset.complete==='true';
     details.dataset.complete=complete?'true':'false';
     const status=details.querySelector('[data-site-state]');
     const recap=details.querySelector('[data-site-recap]');
     if(status)status.textContent=complete?'✓ Complete':'In progress';
     if(recap)recap.hidden=!complete;
     if(complete){
       // Collapse on completion, but do not interrupt review of a
       // manually reopened completed location.
       if(!previouslyComplete&&details.dataset.manuallyOpened!=='true')details.open=false;
     }else{
       // Any removed signature, seal or count confirmation restores
       // the full location form for completion.
       details.dataset.manuallyOpened='false';
       details.open=true;
     }
   }
 });
}
function setupMobileAuditCards(auditId){
 const shell=document.querySelector('.audit-workspace-shell');
 if(!shell)return;
 const steps=[...shell.querySelectorAll('[data-audit-step]')];
 const links=[...shell.querySelectorAll('[data-step-target]')];
 shell.querySelectorAll('.audit-site-details').forEach(details=>{
   const summary=details.querySelector('summary');
   if(!summary)return;
   summary.addEventListener('click',event=>{
     // Only completed locations can be manually collapsed or reopened.
     if(details.dataset.complete!=='true'){event.preventDefault();return}
     details.dataset.manuallyOpened=details.open?'false':'true';
   });
 });
 const prev=document.getElementById('auditStepPrev');
 const next=document.getElementById('auditStepNext');
 const title=document.getElementById('auditStepTitle');
 const count=document.getElementById('auditStepCount');
 if(!steps.length)return;
 const mq=window.matchMedia('(max-width:700px)');
 let current=Number(sessionStorage.getItem('narcoticAuditStep:'+auditId)||0);
 if(!Number.isFinite(current)||current<0||current>=steps.length)current=0;
 const show=(index,scroll=false)=>{
   current=Math.max(0,Math.min(Number(index)||0,steps.length-1));
   // Keep desktop's full-page audit; show one location at a time on mobile.
   steps.forEach((section,i)=>section.classList.toggle('active-step',!mq.matches||i===current));
   links.forEach(link=>link.classList.toggle('current-step',Number(link.dataset.stepTarget)===current));
   if(title)title.textContent=steps[current]?.dataset.stepTitle||'Audit';
   if(count)count.textContent='Section '+(current+1)+' of '+steps.length;
   if(prev)prev.textContent='Sections';
   if(next)next.textContent=current===steps.length-1?'Back to details':'Next section';
   sessionStorage.setItem('narcoticAuditStep:'+auditId,String(current));
   if(scroll){
     const destination=steps[current];
     // Wait until the newly selected mobile card becomes visible before scrolling.
     // On desktop/landscape, all sections remain visible and scroll directly.
     requestAnimationFrame(()=>destination?.scrollIntoView({behavior:'auto',block:'start'}));
   }
 };
 if(prev)prev.onclick=()=>shell.querySelector('.audit-route')?.scrollIntoView({behavior:'auto',block:'start'});
 if(next)next.onclick=()=>{
   show((current+1)%steps.length,true);
   scheduleAuditAutosave(auditId,true);
 };
 links.forEach(link=>link.addEventListener('click',e=>{
   // Section navigation applies to desktop and landscape too: href="#"
   // formerly jumped to the top instead of opening Notes or Final.
   e.preventDefault();
   const index=Number(link.dataset.stepTarget);
   if(!Number.isInteger(index)||index<0||index>=steps.length)return;
   show(index,true);
   scheduleAuditAutosave(auditId,true);
 }));
 // Only a change between desktop and mobile layouts triggers a redraw.
 // No resize/keyboard listener and no scroll during initialization.
 if(mq.addEventListener)mq.addEventListener('change',()=>show(current,false));
 else if(mq.addListener)mq.addListener(()=>show(current,false));
 show(current,false);
}

async function editAudit(id){
 const a=await getOne('audits',id);if(!a)return;
 if(String(a.status||'').toLowerCase()!=='draft'){
   activeAuditId=null;
   const active=await getOne('meta','activeAudit');
   if(active?.auditId===id)await del('meta','activeAudit');
   await renderAudits();
   return;
 }
 activeAuditId=id;
 await put('meta',{id:'activeAudit',auditId:id,updatedAt:nowISO()});
 document.getElementById('auditWorkspace').innerHTML='<div class="audit-workspace-shell">'+
 '<div class="audit-route"><div class="audit-route-title">Audit sections</div><button type="button" class="audit-save-exit-top" id="saveExitAuditTop">Save &amp; Exit</button>'+
 '<a href="#audit-details-section" data-step-target="0" data-route-section="details"><span class="route-label">Details</span></a>'+
 '<a href="#audit-admin-section" data-step-target="1" data-route-section="admin"><span class="route-label">Admin</span></a>'+
 LOCS.map((l,i)=>'<a href="#unit-'+i+'" data-jump-unit="'+i+'" data-route-loc="'+esc(l)+'" data-step-target="'+(i+2)+'"><span class="route-status-mark"></span><span class="route-label">'+esc(l)+'</span></a>').join('')+
 '<a href="#audit-notes-section" data-step-target="'+(LOCS.length+2)+'" data-route-section="notes"><span class="route-label">Notes</span></a>'+
 '<a href="#audit-final-section" data-step-target="'+(LOCS.length+3)+'" data-route-section="final"><span class="route-label">Final</span></a>'+
 '</div>'+
 '<div class="audit-step-card active-step" id="audit-details-section" data-audit-step="0" data-step-title="Audit details"><div class="audit-card audit-hero"><div class="audit-header"><div><span class="kicker">DRAFT AUDIT</span><h2>'+esc(a.month)+'</h2><div class="audit-header-meta"><span id="autosaveStatus" class="autosave-status">Saved '+fmtDate(a.updatedAt)+'</span><span class="audit-status-chip">'+esc(a.status||'draft')+'</span></div></div><button id="backAudits" class="audit-back-btn">Back to drafts</button></div><div class="form-grid audit-meta-grid"><label>Audit month / year<input id="auditMonthPicker" type="month" value="'+esc((a.monthValue||'')||monthTextToValue(a.month||''))+'"><input id="auditMonth" type="hidden" value="'+esc(a.month||'')+'"></label><label>Date of audit<input id="auditDate" type="date" value="'+esc(a.auditDate||'')+'"></label><label>Auditor email<input id="auditEmail" type="email" value="'+esc(a.email||cloudSession?.user?.email||'')+'"></label><label class="audit-primary-auditor">Auditor name<input id="auditAuditorName" placeholder="Full name" autocomplete="name" value="'+esc(a.auditorName||a.attestationName||'')+'"></label><label class="audit-primary-auditor">Employee number<input id="auditAuditorEmployeeNumber" placeholder="Employee #" type="text" inputmode="numeric" pattern="[0-9]*" autocomplete="off" data-integer-only required value="'+esc(a.auditorEmployeeNumber||a.attestationEmployeeNumber||signedInEmployeeNumber()||'')+'"></label><div class="audit-period-heading"><strong>Audit period</strong><span>Enter the exact date range covered by this audit.</span></div><label>Period start<input id="auditStart" type="date" value="'+esc(a.dateRangeStart||'')+'"></label><label>Period end<input id="auditEnd" type="date" value="'+esc(a.dateRangeEnd||'')+'"></label></div></div></div>'+
 '<div class="audit-step-card" id="audit-admin-section" data-audit-step="1" data-step-title="Administration import"><div class="physical-vial-tally audit-tally"><div><span>ACTIVE VIALS · PHYSICAL AUDIT</span><strong id="auditActiveVialTotal">Calculating…</strong><small>Medic 1 + Medic 2 + Medic 3 + Safe</small></div><div><span>EXPIRED VIALS · PHYSICAL AUDIT</span><strong id="auditExpiredVialTotal">Calculating…</strong><small>Expired location only</small></div></div>'+administrationImportSection(a)+'</div>'+
 LOCS.map((l,i)=>'<div class="audit-step-card" data-audit-step="'+(i+2)+'" data-step-title="'+esc(l)+'" id="unit-'+i+'">'+unitAuditSection(a,l,i)+'</div>').join('')+
 '<div class="audit-step-card" id="audit-notes-section" data-audit-step="'+(LOCS.length+2)+'" data-step-title="Audit notes"><div class="audit-card audit-section-card"><span class="kicker">DOCUMENTATION</span><h3>Overall audit notes</h3><textarea id="auditNotes" rows="6" placeholder="Document discrepancies, corrective actions, or other audit notes.">'+esc(a.notes||'')+'</textarea></div></div>'+
 '<div class="audit-step-card" id="audit-final-section" data-audit-step="'+(LOCS.length+3)+'" data-step-title="Final Certification"><div class="audit-card audit-section-card attestation-card"><span class="kicker">FINAL CERTIFICATION</span><h3>Final attestation</h3><p>'+esc(a.attestationText||FINAL_ATTESTATION)+'</p><label class="attest-check"><input id="attestCheck" type="checkbox" '+(a.attestationAccepted?'checked':'')+'> <span>I certify this audit.</span></label><div class="final-auditor-grid"><label class="final-signer-label">Final auditor name<input id="attestName" placeholder="Full name" value="'+esc(a.attestationName||a.auditorName||'')+'"></label><label class="final-signer-label">Employee number<input id="attestEmployeeNumber" placeholder="Employee #" type="text" inputmode="numeric" pattern="[0-9]*" data-integer-only required value="'+esc(a.attestationEmployeeNumber||a.auditorEmployeeNumber||signedInEmployeeNumber()||'')+'"></label></div><div class="final-signature-block"><div class="signature-label-row"><div class="signature-label">Final auditor signature</div><div class="button-row"><button type="button" id="clearFinalSignature">Clear</button><button type="button" class="expand-signature" id="expandFinalSignature">Open larger</button></div></div><canvas id="finalSignatureCanvas" width="500" height="150"></canvas></div><div class="audit-actions"><button id="saveAudit">Save draft</button><button class="primary" id="finalizeAudit">Finalize audit</button></div></div></div>'+
 '<div class="mobile-card-nav" aria-label="Audit section navigation"><button type="button" id="auditStepPrev">Sections</button><div class="mobile-card-progress"><strong id="auditStepTitle"></strong><span id="auditStepCount"></span></div><button type="button" id="saveExitAuditBottom">Save &amp; Exit</button><button type="button" class="primary" id="auditStepNext">Next section</button></div>'+
 '</div>';
 for(const id of ['backAudits','saveExitAuditTop','saveExitAuditBottom']){
   const btn=document.getElementById(id);
   if(btn)btn.onclick=()=>saveAndExitAudit(a.id);
 }
 await updateAuditLaunchControls();
 const adminOuter=document.querySelector('.mobile-collapsible-admin');
 if(adminOuter&&window.matchMedia('(max-width:650px)').matches)adminOuter.removeAttribute('open');
 const adminUploadBtn=document.getElementById('uploadAdminPdf'),adminPdfFile=document.getElementById('adminPdfFile');
 if(adminUploadBtn&&adminPdfFile){adminUploadBtn.onclick=()=>adminPdfFile.click();adminPdfFile.onchange=async e=>{const file=e.target.files?.[0];if(file)await handleAdministrationPdf(a.id,file);e.target.value=''}};
 const undoImportBtn=document.getElementById('undoAdminImport');
 if(undoImportBtn)undoImportBtn.onclick=()=>undoAdministrationImport(a.id);
 document.querySelectorAll('[data-versed-confirm]').forEach(button=>button.onclick=async()=>{
   const key=button.dataset.versedConfirm;
   const groupHost=button.closest('[data-versed-key]');
   const value2=groupHost?.querySelector('[data-versed-2]')?.value;
   const value5=groupHost?.querySelector('[data-versed-5]')?.value;
   const vial2=Number(value2),vial5=Number(value5);
   if(value2===''||value5===''||!Number.isInteger(vial2)||!Number.isInteger(vial5)
      ||vial2<0||vial5<0||vial2+vial5===0){
     return alert('Enter whole-number quantities of 2 mg (orange cap) and 5 mg (green cap) vials. Use 0 when none were used.');
   }
   const group=groupedAdministrations(a.administrationRows||[]).find(g=>g.key===key);
   if(!group||group.medication!=='Versed')return alert('This administration group is no longer available.');
   if(vial2*2+vial5*5<group.totalDose){
     return alert('The selected vials contain less medication than the documented '+group.totalDose+' mg administered. Check both quantities.');
   }
   if(!(await flushAuditAutosave()))return alert('Save the audit before confirming vial quantities.');
   const draft=await getOne('audits',a.id);
   if(!draft||draft.status!=='draft')return alert('The audit draft is no longer editable.');
   draft.vialOverrides??={};
   draft.vialOverrides[key]={vial2,vial5,confirmedAt:nowISO(),confirmedBy:cloudSession?.user?.email||''};
   const doc=[...(draft.supportingDocuments||[])].reverse().find(d=>Array.isArray(d.administrationRows));
   if(doc?.transcript)draft.usageSummary=buildAdministrationSummary(doc.transcript,doc.name||'PDF',draft.vialOverrides);
   draft.updatedAt=nowISO();
   await put('audits',draft);
   await editAudit(a.id);
 });
 document.querySelectorAll('[data-count-loc][data-count-med]').forEach(input=>input.addEventListener('input',updateAuditPhysicalTotals));
 document.querySelectorAll('.signature-box').forEach(box=>setupSignature(box,a.signatures?.[box.dataset.sigLoc]||{},()=>scheduleAuditAutosave(a.id,true)));
 const primaryAuditorName=document.getElementById('auditAuditorName');
 const primaryAuditorEmployee=document.getElementById('auditAuditorEmployeeNumber');
 const carryPrimaryAuditor=()=>{
   const name=primaryAuditorName?.value.trim()||'';
   const emp=primaryAuditorEmployee?.value.trim()||'';
   document.querySelectorAll('[data-signer]').forEach(x=>x.value=name);
   document.querySelectorAll('[data-employee-number]').forEach(x=>x.value=emp);
   const finalName=document.getElementById('attestName'),finalEmp=document.getElementById('attestEmployeeNumber');
   if(finalName)finalName.value=name;
   if(finalEmp)finalEmp.value=emp;
   updateAuditRouteProgress();
 };
 if(primaryAuditorName)primaryAuditorName.addEventListener('input',carryPrimaryAuditor);
 if(primaryAuditorEmployee)primaryAuditorEmployee.addEventListener('input',carryPrimaryAuditor);
 const finalSigCanvas=document.getElementById('finalSignatureCanvas');
 if(finalSigCanvas){
   setupCanvas(finalSigCanvas,a.attestationSignature||'',()=>scheduleAuditAutosave(a.id,true));
   const btn=document.getElementById('expandFinalSignature');
   const clearBtn=document.getElementById('clearFinalSignature');
   if(btn)btn.onclick=()=>openStandaloneSignatureCapture(finalSigCanvas,'Final auditor signature',()=>scheduleAuditAutosave(a.id,true));
   if(clearBtn)clearBtn.onclick=()=>{
     finalSigCanvas.resetSignatureStroke?.();
     finalSigCanvas.getContext('2d').clearRect(0,0,finalSigCanvas.width,finalSigCanvas.height);
     finalSigCanvas.dataset.hasSignature='false';
     finalSigCanvas.dataset.signatureEdited='true';
     updateAuditRouteProgress();
     a.attestationSignature='';
     scheduleAuditAutosave(a.id,true);
   };
 }
 const findingDialog=document.getElementById('auditFindingDialog');
 const findingType=document.getElementById('auditFindingType');
 const findingRetainedLabel=document.getElementById('auditFindingRetainedLabel');
 const findingRetained=document.getElementById('auditFindingRetained');
 const findingNoteLabel=document.getElementById('auditFindingNoteLabel');
 const findingNote=document.getElementById('auditFindingNote');
 const findingQty=document.getElementById('auditFindingQty');
 const findingImpact=document.getElementById('auditFindingImpact');
 const findingContext=document.getElementById('auditFindingContext');
 const findingChoices=[...document.querySelectorAll('[data-finding-choice]')];

 const updateFindingDialog=()=>{
   const kind=findingType?.value||'expired';
   const retained=kind!=='damaged'||findingRetained?.value!=='no';
   if(findingRetainedLabel)findingRetainedLabel.hidden=kind!=='damaged';
   if(findingNoteLabel)findingNoteLabel.hidden=kind!=='damaged';
   if(findingNote)findingNote.required=kind==='damaged'&&!retained;
   findingChoices.forEach(btn=>btn.classList.toggle('selected',btn.dataset.findingChoice===kind));

   const loc=document.getElementById('auditFindingLoc')?.value||'';
   const med=document.getElementById('auditFindingMed')?.value||'';
   const qty=Math.max(1,Number(findingQty?.value||1));
   const sourceInput=loc&&med?document.querySelector('[data-count-loc="'+CSS.escape(loc)+'"][data-count-med="'+CSS.escape(med)+'"]'):null;
   const expiredInput=med?document.querySelector('[data-count-loc="Expired"][data-count-med="'+CSS.escape(med)+'"]'):null;
   const sourceEntered=sourceInput&&sourceInput.value!=='';
   const expiredEntered=expiredInput&&expiredInput.value!=='';
   const sourceBefore=sourceEntered?Number(sourceInput.value):null;
   const expiredBefore=expiredEntered?Number(expiredInput.value):null;
   const sourceAfter=sourceEntered?Math.max(0,sourceBefore-qty):null;
   const expiredAfter=expiredEntered?(expiredBefore+(retained?qty:0)):null;

   if(findingContext)findingContext.innerHTML='<strong>'+esc(loc)+' · '+medicationDisplayHtml(med)+'</strong><span>'+(sourceEntered?'Current audit count: '+sourceBefore+' vial'+(sourceBefore===1?'':'s'):'Enter the current physical count first')+'</span>';
   if(findingImpact){
     findingImpact.innerHTML=
       '<div><span>'+esc(loc)+'</span><strong>'+(sourceEntered?(sourceBefore+' → '+sourceAfter):'Not entered')+'</strong></div>'+
       '<div><span>Expired inventory</span><strong>'+(expiredEntered?(expiredBefore+' → '+expiredAfter):'Not entered')+'</strong></div>'+
       '<p>'+(kind==='expired'
         ?'Expired vial(s) are physically moved into Expired inventory.'
         :(retained
           ?'Damaged vial(s) remain physically present and are moved into Expired inventory.'
           :'No physical vial remains, so Expired inventory does not increase. The disposition explanation is required.'))+'</p>';
   }
 };
 findingChoices.forEach(btn=>btn.addEventListener('click',()=>{
   if(findingType)findingType.value=btn.dataset.findingChoice||'expired';
   if(findingType?.value==='expired'&&findingRetained)findingRetained.value='yes';
   updateFindingDialog();
 }));
 if(findingType)findingType.onchange=updateFindingDialog;
 if(findingRetained)findingRetained.onchange=updateFindingDialog;
 if(findingQty)findingQty.oninput=updateFindingDialog;
 document.getElementById('closeAuditFinding')?.addEventListener('click',()=>findingDialog?.close());
 document.getElementById('cancelAuditFinding')?.addEventListener('click',()=>findingDialog?.close());

 const findCountInput=(loc,med)=>document.querySelector('[data-count-loc="'+CSS.escape(loc)+'"][data-count-med="'+CSS.escape(med)+'"]');
 const setCountLocked=(loc,med,locked)=>{
   const input=findCountInput(loc,med);
   if(input){
     input.readOnly=locked;
     if(!locked){delete input.dataset.confirmedAt;delete input.dataset.confirmedBy;}
   }
   const selector='[data-loc="'+CSS.escape(loc)+'"][data-med="'+CSS.escape(med)+'"]';
   const confirm=document.querySelector('[data-confirm-count]'+selector);
   const edit=document.querySelector('[data-edit-count]'+selector);
   const status=document.querySelector('[data-count-confirmed="'+CSS.escape(loc+'|'+med)+'"]');
   if(confirm)confirm.hidden=locked;
   if(edit)edit.hidden=!locked;
   if(status)status.hidden=!locked;
 };
 document.querySelectorAll('[data-confirm-count]').forEach(button=>button.onclick=()=>{
   const loc=button.dataset.loc,med=button.dataset.med;
   const input=findCountInput(loc,med),val=input?.value;
   if(val===''||val===undefined||!Number.isInteger(Number(val))||Number(val)<0)
     return alert('Enter a valid whole-vial physical count before confirming.');
   a.countConfirmations??={};
   a.countConfirmations[loc]??={};
   a.countConfirmations[loc][med]={value:Number(val),confirmedAt:nowISO(),confirmedBy:cloudSession?.user?.email||''};
   input.dataset.confirmedAt=a.countConfirmations[loc][med].confirmedAt;
   input.dataset.confirmedBy=a.countConfirmations[loc][med].confirmedBy;
   setCountLocked(loc,med,true);
   updateAuditRouteProgress();
   scheduleAuditAutosave(a.id,true);
 });
 document.querySelectorAll('[data-edit-count]').forEach(button=>button.onclick=()=>{
   const loc=button.dataset.loc,med=button.dataset.med;
   if(a.countConfirmations?.[loc])delete a.countConfirmations[loc][med];
   setCountLocked(loc,med,false);
   findCountInput(loc,med)?.focus();
   updateAuditRouteProgress();
   scheduleAuditAutosave(a.id,true);
 });
 document.querySelectorAll('[data-audit-finding]').forEach(btn=>btn.onclick=()=>{
   if(!findingDialog)return;
   const loc=btn.dataset.loc||'';
   const med=btn.dataset.med||'';
   if(!loc||loc==='Expired'||!med)return;
   document.getElementById('auditFindingLoc').value=loc;
   document.getElementById('auditFindingMed').value=med;
   if(findingType)findingType.value='expired';
   if(findingRetained)findingRetained.value='yes';
   if(findingQty)findingQty.value='1';
   if(findingNote)findingNote.value='';
   updateFindingDialog();
   findingDialog.showModal();
 });

 const saveFindingBtn=document.getElementById('saveAuditFinding');
 if(saveFindingBtn)saveFindingBtn.onclick=async()=>{
   const loc=document.getElementById('auditFindingLoc')?.value||'';
   const med=document.getElementById('auditFindingMed')?.value||'';
   const kind=findingType?.value||'expired';
   const qty=Number(findingQty?.value||0);
   const physicalRetained=kind!=='damaged'||findingRetained?.value!=='no';
   const note=String(findingNote?.value||'').trim();

   if(!Number.isInteger(qty)||qty<1)return alert('Enter a whole-vial quantity of 1 or greater.');
   if(kind==='damaged'&&!physicalRetained&&!note)return alert('Explain why the damaged vial cannot be physically retained and what happened to it.');

   const sourceInput=document.querySelector('[data-count-loc="'+CSS.escape(loc)+'"][data-count-med="'+CSS.escape(med)+'"]');
   const expiredInput=document.querySelector('[data-count-loc="Expired"][data-count-med="'+CSS.escape(med)+'"]');
   if(!sourceInput||!expiredInput)return alert('Unable to locate the audit inventory fields.');

   if(sourceInput.value==='')return alert('Enter the physical count for '+med+' at '+loc+' before recording this finding.');
   if(expiredInput.value==='')return alert('Enter the physical count for '+med+' at Expired before recording this finding.');
   const available=Number(sourceInput.value);
   const expiredAvailable=Number(expiredInput.value);
   if(qty>available)return alert('Quantity exceeds the current '+loc+' audit count for '+med+'.');

   sourceInput.value=String(available-qty);
   if(physicalRetained)expiredInput.value=String(expiredAvailable+qty);
   if(a.countConfirmations?.[loc])delete a.countConfirmations[loc][med];
   setCountLocked(loc,med,false);
   if(physicalRetained){
     if(a.countConfirmations?.Expired)delete a.countConfirmations.Expired[med];
     setCountLocked('Expired',med,false);
   }
   collectAuditFromUI(a);
   a.inventoryFindings=Array.isArray(a.inventoryFindings)?a.inventoryFindings:[];
   a.inventoryFindings.push({
     id:uid('finding'),
     type:kind,
     typeLabel:kind==='damaged'?'Damaged vial found during audit':'Expired medication found during audit',
     sourceLocation:loc,
     destinationLocation:physicalRetained?'Expired':'Not physically retained',
     physicalRetained,
     medication:med,
     quantity:qty,
     note,
     recordedAt:nowISO(),
     recordedBy:a.auditorName||''
   });
   a.updatedAt=nowISO();
   await put('audits',a);
   await put('meta',{id:'activeAudit',auditId:a.id,updatedAt:a.updatedAt});
   updateAuditRouteProgress();
   scheduleAuditAutosave(a.id,true);
   findingDialog.close();
 };
 document.querySelectorAll('[data-audit-incident]').forEach(btn=>btn.onclick=()=>{
   const txForm=document.getElementById('txForm');
   const txDialog=document.getElementById('txDialog');
   if(!txForm||!txDialog)return;
   txForm.reset();
   const type=txForm.querySelector('select[name=type]');
   const from=txForm.querySelector('select[name=fromLocation]');
   const auditCtx=document.getElementById('txAuditContextId');
   if(type)type.value='incident';
   if(from)from.value=btn.dataset.loc||'';
   if(auditCtx)auditCtx.value=a.id;
   const rows=document.getElementById('txMedicationRows');
   if(rows){rows.innerHTML='';addTxMedicationRow(btn.dataset.med||'',1);}
   const currentInput=document.querySelector('[data-count-loc="'+CSS.escape(btn.dataset.loc||'')+'"][data-count-med="'+CSS.escape(btn.dataset.med||'')+'"]');
   const currentCount=currentInput?Number(currentInput.value||0):0;
   const expected=Number(a.openingCounts?.[btn.dataset.loc]?.[btn.dataset.med]??a.counts?.[btn.dataset.loc]?.[btn.dataset.med]??currentCount);
   const notes=document.getElementById('txNotes');
   if(notes&&!notes.value)notes.placeholder='Describe what happened. Expected '+expected+'; current physical count '+currentCount+'.';
   const txTypeSelect=document.querySelector('#txForm select[name=type]');
   if(txTypeSelect)txTypeSelect.dispatchEvent(new Event('change'));
   txDialog.showModal();
 });
 document.getElementById('saveAudit').onclick=()=>saveAuditFromUI(a.id,false);
 document.getElementById('finalizeAudit').onclick=()=>saveAuditFromUI(a.id,true);
 const monthPicker=document.getElementById('auditMonthPicker');
 if(monthPicker)monthPicker.addEventListener('change',()=>{const hidden=document.getElementById('auditMonth');if(hidden)hidden.value=monthValueToText(monthPicker.value)});
 document.querySelectorAll('#auditWorkspace input,#auditWorkspace textarea,#auditWorkspace select').forEach(el=>{
   if(el.disabled)return;
   el.addEventListener('input',()=>{updateAuditRouteProgress();scheduleAuditAutosave(a.id)});
   el.addEventListener('change',()=>{updateAuditRouteProgress();scheduleAuditAutosave(a.id,true)});
   el.addEventListener('blur',()=>{updateAuditRouteProgress();scheduleAuditAutosave(a.id,true)});
 });
 setupMobileAuditCards(a.id);
 updateAuditPhysicalTotals();
 updateAuditRouteProgress();
 setAutosaveStatus('Saved '+fmtDate(a.updatedAt));
}
// The modal already fills the mobile viewport through CSS. Native fullscreen and
// screen-orientation locks are unreliable on iOS and can trap the Save button.
function enterSignatureLandscape(dialog){
 if(!dialog||!window.matchMedia('(max-width:900px)').matches)return;
 dialog.classList.add('signature-landscape-mode');
 const syncLandscapeState=()=>{
   if(!dialog.open)return;
   const landscape=window.innerWidth>window.innerHeight;
   dialog.classList.toggle('is-landscape',landscape);
   dialog.classList.toggle('is-portrait',!landscape);
   const hint=dialog.querySelector('.signature-capture-hint');
   if(hint)hint.textContent=landscape
     ?'Landscape signing mode'
     :'Rotate phone to landscape for the full signing area.';
 };
 dialog._signatureOrientationHandler=syncLandscapeState;
 window.addEventListener('resize',syncLandscapeState,{passive:true});
 window.addEventListener('orientationchange',syncLandscapeState,{passive:true});
 if(window.visualViewport)window.visualViewport.addEventListener('resize',syncLandscapeState,{passive:true});
 syncLandscapeState();
}
function exitSignatureLandscape(dialog){
 if(!dialog)return;
 dialog.classList.remove('signature-landscape-mode','is-landscape','is-portrait');
 const handler=dialog._signatureOrientationHandler;
 if(!handler)return;
 window.removeEventListener('resize',handler);
 window.removeEventListener('orientationchange',handler);
 if(window.visualViewport)window.visualViewport.removeEventListener('resize',handler);
 delete dialog._signatureOrientationHandler;
}
// Direct signing uses Pointer Events for finger, pencil and mouse input.
// No global mouse listeners and no scroll-blocking overlay over the canvas.
function bindSignatureInk(canvas,lineWidth,onDraw){
 if(!canvas)return;
 const ctx=canvas.getContext('2d');if(!ctx)return;
 ctx.lineWidth=lineWidth;ctx.lineCap='round';ctx.lineJoin='round';
 let active=false,pointerId=null,last=null,stroked=false;
 const point=e=>{
   const rect=canvas.getBoundingClientRect();
   if(!rect.width||!rect.height)return null;
   return {x:(e.clientX-rect.left)*canvas.width/rect.width,
           y:(e.clientY-rect.top)*canvas.height/rect.height};
 };
 const down=e=>{
   if(active||e.isPrimary===false||e.button>0)return;
   const p=point(e);if(!p)return;
   active=true;stroked=false;last=p;pointerId=e.pointerId??null;
   canvas.dataset.signatureEdited='true';
   if(e.cancelable)e.preventDefault();
   if(pointerId!==null&&canvas.setPointerCapture){
     try{canvas.setPointerCapture(pointerId)}catch(_){}
   }
 };
 const move=e=>{
   if(!active||(pointerId!==null&&e.pointerId!==pointerId))return;
   const p=point(e);if(!p||!last)return;
   if(Math.abs(p.x-last.x)+Math.abs(p.y-last.y)<.5)return;
   ctx.beginPath();ctx.moveTo(last.x,last.y);ctx.lineTo(p.x,p.y);ctx.stroke();
   last=p;stroked=true;
   if(e.cancelable)e.preventDefault();
 };
 const resetStroke=()=>{
   const id=pointerId;
   active=false;last=null;pointerId=null;stroked=false;
   if(id!==null&&canvas.hasPointerCapture?.(id)){
     try{canvas.releasePointerCapture(id)}catch(_){}
   }
 };
 // Clear buttons can reset an interrupted iPhone gesture so the next finger
 // stroke always begins a fresh signature, even after pointercancel.
 canvas.resetSignatureStroke=resetStroke;
 const up=e=>{
   if(!active||(pointerId!==null&&e.pointerId!==pointerId))return;
   const completed=stroked;
   resetStroke(); // Finish FIRST so an onDraw error cannot lock the canvas.
   if(completed){
     canvas.dataset.hasSignature='true';
     try{if(onDraw)onDraw()}catch(err){
       console.error('Unable to refresh signature status; the drawn ink is retained',err);
     }
   }
 };
 if(window.PointerEvent){
   canvas.addEventListener('pointerdown',down);
   canvas.addEventListener('pointermove',move);
   canvas.addEventListener('pointerup',up);
   canvas.addEventListener('pointercancel',up);
   canvas.addEventListener('lostpointercapture',up);
 }else{
   const eventForTouch=e=>{
     const touch=e.touches?.[0]||e.changedTouches?.[0];
     return touch?{clientX:touch.clientX,clientY:touch.clientY,pointerId:1,
       button:0,cancelable:e.cancelable,preventDefault:()=>e.preventDefault()}:e;
   };
   canvas.addEventListener('touchstart',e=>down(eventForTouch(e)),{passive:false});
   canvas.addEventListener('touchmove',e=>move(eventForTouch(e)),{passive:false});
   canvas.addEventListener('touchend',e=>up(eventForTouch(e)),{passive:false});
   canvas.addEventListener('touchcancel',e=>up(eventForTouch(e)),{passive:false});
   canvas.addEventListener('mousedown',down);
   canvas.addEventListener('mousemove',move);
   canvas.addEventListener('mouseup',up);
   canvas.addEventListener('mouseleave',up);
 }
}
function finishSignatureCapture(dialog,apply){
 if(!dialog?.open)return;
 const live=dialog.querySelector('#signatureCaptureCanvas');
 // Preserve any existing source signature if the enlarged signing area is blank.
 if(!live||live.dataset.hasSignature!=='true'){
   alert('Please sign in the white area before selecting Use signature. No signature was changed.');
   return;
 }
 try{
   apply();
   dialog.close();
   exitSignatureLandscape(dialog);
 }catch(err){
   console.error('Unable to use signature',err);
   alert('Unable to apply signature. The signing window remains open.');
 }
}
function openSignatureCapture(box,kind,onChange){
 const source=kind==='witness'
   ?box?.querySelector('[data-witness-canvas]')
   :box?.querySelector('[data-canvas]');
 if(!source)return;
 openStandaloneSignatureCapture(source,kind==='witness'?'Witness signature':'Auditor signature',()=>{
   updateAuditRouteProgress();
   if(onChange)onChange();
 });
}
function openStandaloneSignatureCapture(source,titleText,onChange){
 if(!source)return;
 let dialog=document.getElementById('signatureCaptureDialog');
 if(!dialog){
   dialog=document.createElement('dialog');
   dialog.id='signatureCaptureDialog';
   dialog.className='signature-capture-dialog';
   dialog.innerHTML='<div class="signature-capture-shell"><div class="signature-capture-head"><div><span class="kicker">SIGNATURE CAPTURE</span><h2 id="signatureCaptureTitle">Signature</h2></div><button type="button" id="signatureCaptureClose">Cancel</button></div><div class="signature-capture-hint">Sign in the white area. Turn sideways for more room.</div><canvas id="signatureCaptureCanvas" width="1200" height="500"></canvas><div class="signature-capture-actions"><button type="button" id="signatureCaptureClear">Clear</button><button type="button" class="primary" id="signatureCaptureSave">Use signature</button></div></div>';
   document.body.appendChild(dialog);
 }
 dialog.querySelector('#signatureCaptureTitle').textContent=titleText||'Signature';
 dialog.querySelector('#signatureCaptureClose').textContent='Cancel';
 const original=dialog.querySelector('#signatureCaptureCanvas');
 const live=original.cloneNode(true);
 original.replaceWith(live);
 live.width=1200;live.height=500;
 const ctx=live.getContext('2d');
 if(!ctx)return alert('Signature canvas is unavailable on this device.');
 const exists=source.dataset.hasSignature==='true';
 live.dataset.hasSignature=exists?'true':'false';
 if(exists){
   const img=new Image();
   img.onload=()=>{if(live.dataset.signatureEdited!=='true')ctx.drawImage(img,0,0,live.width,live.height)};
   img.src=source.toDataURL('image/png');
 }
 bindSignatureInk(live,5);
 const apply=()=>{
   const dst=source.getContext('2d');
   if(!dst)throw new Error('Unable to update the original signature');
   dst.clearRect(0,0,source.width,source.height);
   dst.drawImage(live,0,0,source.width,source.height);
   source.dataset.hasSignature='true';
   if(onChange)onChange();
 };
 dialog.querySelector('#signatureCaptureClear').onclick=()=>{
   live.resetSignatureStroke?.();
   ctx.clearRect(0,0,live.width,live.height);
   live.dataset.hasSignature='false';
   live.dataset.signatureEdited='true';
 };
 dialog.querySelector('#signatureCaptureSave').onclick=()=>finishSignatureCapture(dialog,apply);
 dialog.querySelector('#signatureCaptureClose').onclick=()=>{dialog.close();exitSignatureLandscape(dialog)};
 dialog.showModal();
 enterSignatureLandscape(dialog);
}
document.addEventListener('cancel',e=>{
 if(e.target?.id==='signatureCaptureDialog')exitSignatureLandscape(e.target);
},true);
document.addEventListener('close',e=>{
 if(e.target?.id==='signatureCaptureDialog')exitSignatureLandscape(e.target);
},true);
function setupCanvas(canvas,data,onChange){
 if(!canvas)return;
 const ctx=canvas.getContext('2d');if(!ctx)return;
 canvas.dataset.hasSignature=data?'true':'false';
 if(data){
   const img=new Image();
   img.onload=()=>{if(canvas.dataset.signatureEdited!=='true')ctx.drawImage(img,0,0,canvas.width,canvas.height)};
   img.src=data;
 }
 bindSignatureInk(canvas,2,onChange);
}
function setupSignature(box,s,onChange){
 const c=box.querySelector('[data-canvas]'),w=box.querySelector('[data-witness-canvas]');
 const changed=()=>{updateAuditRouteProgress();if(onChange)onChange()};
 setupCanvas(c,s.signature||'',changed);setupCanvas(w,s.witnessSignature||'',changed);
 box.querySelectorAll('[data-expand-signature]').forEach(btn=>btn.onclick=()=>openSignatureCapture(box,btn.dataset.expandSignature,changed));
 box.querySelectorAll('[data-clear-signature]').forEach(btn=>btn.onclick=()=>{
   const target=btn.dataset.clearSignature==='witness'?w:c;
   if(!target)return;
   target.resetSignatureStroke?.();
   target.getContext('2d').clearRect(0,0,target.width,target.height);
   target.dataset.hasSignature='false';
   target.dataset.signatureEdited='true';
   updateAuditRouteProgress();
   if(onChange)onChange();
 });
}
function setAutosaveStatus(msg){const el=document.getElementById('autosaveStatus');if(el)el.textContent=msg}
function collectAuditFromUI(a){
 if(!document.getElementById('auditMonth'))return a;
 const monthPicker=document.getElementById('auditMonthPicker');
 a.month=monthPicker?.value?monthValueToText(monthPicker.value):document.getElementById('auditMonth').value;
 a.monthValue=monthPicker?.value||monthTextToValue(a.month);
 a.auditDate=document.getElementById('auditDate')?.value||a.auditDate||'';
 a.email=document.getElementById('auditEmail')?.value||a.email||'';
 a.auditorName=document.getElementById('auditAuditorName')?.value.trim()||a.auditorName||'';
 a.auditorEmployeeNumber=document.getElementById('auditAuditorEmployeeNumber')?.value.trim()||a.auditorEmployeeNumber||'';
 a.dateRangeStart=document.getElementById('auditStart').value;
 a.dateRangeEnd=document.getElementById('auditEnd').value;
 a.usageSummary=document.getElementById('usageSummary').value;
 a.notes=document.getElementById('auditNotes').value;
 document.querySelectorAll('[data-count-loc]').forEach(input=>{
   const loc=input.dataset.countLoc,med=input.dataset.countMed;
   a.counts??={};a.counts[loc]??={};
   a.counts[loc][med]=input.value===''?null:Number(input.value);
   a.countConfirmations??={};a.countConfirmations[loc]??={};
   if(input.readOnly&&input.dataset.confirmedAt&&input.value!==''){
     a.countConfirmations[loc][med]={value:Number(input.value),confirmedAt:input.dataset.confirmedAt,confirmedBy:input.dataset.confirmedBy||''};
   }else delete a.countConfirmations[loc][med];
 });
 a.breakawayTags??={};document.querySelectorAll('[data-tag-loc]').forEach(i=>{a.breakawayTags[i.dataset.tagLoc]??={};a.breakawayTags[i.dataset.tagLoc][i.dataset.tagKind]=i.value.trim()});
 a.attestationText=a.attestationText||FINAL_ATTESTATION;
 a.signatures={};
 document.querySelectorAll('.signature-box').forEach(box=>{const loc=box.dataset.sigLoc,c=box.querySelector('[data-canvas]'),w=box.querySelector('[data-witness-canvas]');a.signatures[loc]={signer:box.querySelector('[data-signer]').value,employeeNumber:box.querySelector('[data-employee-number]')?.value.trim()||'',witness:box.querySelector('[data-witness]').value,witnessEmployeeNumber:box.querySelector('[data-witness-employee-number]')?.value.trim()||'',signature:c?.dataset.hasSignature==='true'?c.toDataURL():'',witnessSignature:w?.dataset.hasSignature==='true'?w.toDataURL():''}});
 a.attestationAccepted=document.getElementById('attestCheck').checked;
 a.attestationName=document.getElementById('attestName').value;
 a.attestationEmployeeNumber=document.getElementById('attestEmployeeNumber')?.value.trim()||'';
 const finalSig=document.getElementById('finalSignatureCanvas');
 a.attestationSignature=finalSig?.dataset.hasSignature==='true'?finalSig.toDataURL():'';
 return a;
}
function scheduleAuditAutosave(id,immediate=false){
 activeAuditId=id;
 setAutosaveStatus(cloudSession&&navigator.onLine?'Saving live…':'Saving locally…');
 clearTimeout(auditAutosaveTimer);
 auditAutosaveTimer=setTimeout(()=>autosaveAudit(id),immediate?0:150);
}
async function autosaveAudit(id){
 if(!id)return false;
 if(auditSavePromise)await auditSavePromise;
 const task=(async()=>{
   auditSaveInFlight=true;
   try{
     const draft=await getOne('audits',id);if(!draft)return false;
     collectAuditFromUI(draft);
     draft.updatedAt=nowISO();draft.lastAutosaveAt=draft.updatedAt;
     await put('audits',draft);
     await put('meta',{id:'activeAudit',auditId:id,updatedAt:draft.updatedAt});
     const time=new Date(draft.updatedAt).toLocaleTimeString([],{hour:'numeric',minute:'2-digit',second:'2-digit'});
     setAutosaveStatus(lastCloudWrite==='live'?'Saved live '+time:'Saved locally · sync pending '+time);
     return true;
   }catch(err){
     console.error('Audit autosave failed',err);
     setAutosaveStatus('Save failed — keep this screen open');
     return false;
   }finally{auditSaveInFlight=false;}
 })();
 auditSavePromise=task;
 try{return await task}finally{if(auditSavePromise===task)auditSavePromise=null;}
}
async function flushAuditAutosave(){
 clearTimeout(auditAutosaveTimer);
 if(activeAuditId&&document.getElementById('auditMonth'))return autosaveAudit(activeAuditId);
 return true;
}
async function saveAndExitAudit(id){
 if(!id||auditExitInFlight)return;
 auditExitInFlight=true;
 const buttons=['saveExitAuditTop','saveExitAuditBottom','backAudits'].map(x=>document.getElementById(x)).filter(Boolean);
 const labels=buttons.map(b=>b.textContent);
 buttons.forEach(b=>{b.disabled=true;b.textContent='Saving…';});
 try{
   const ok=await flushAuditAutosave();
   if(!ok)throw new Error('Could not save the draft. Keep the audit open and try again.');
   if(cloudSession&&navigator.onLine)await flushPendingWrites();
   const pending=pendingWrites().some(w=>w.store==='audits'&&w.id===id);
   if(pending||!navigator.onLine||!cloudSession){
     const allowed=confirm('Draft saved on this device, but cloud sync is pending. Do not resume from another device until it says Saved live. Leave this screen anyway?');
     if(!allowed)return;
   }
   activeAuditId=null;
   await put('meta',{id:'activeAudit',auditId:'',updatedAt:nowISO()});
   await renderAudits();
 }catch(err){console.error('Save & Exit failed',err);alert(err?.message||String(err));}
 finally{
   auditExitInFlight=false;
   buttons.forEach((b,i)=>{b.disabled=false;b.textContent=labels[i];});
 }
}

async function saveAuditFromUI(id,finalize){
 if(finalize&&auditFinalizeInFlight)return;
 const a=await getOne('audits',id);
 if(!a)return alert('Audit draft was not found.');
 if(String(a.status||'draft').toLowerCase()==='finalized')return alert('This audit is already finalized.');
 collectAuditFromUI(a);a.updatedAt=nowISO();
 if(finalize){
   if(!cloudSession)return alert('Sign in is required before finalizing an audit.');
   if(!navigator.onLine)return alert('A live connection is required to finalize. Save the draft and finalize when the device is online.');
   auditFinalizeInFlight=true;
   const finalizeBtn=document.getElementById('finalizeAudit');
   const saveBtn=document.getElementById('saveAudit');
   if(finalizeBtn){finalizeBtn.disabled=true;finalizeBtn.textContent='Finalizing…'}
   if(saveBtn)saveBtn.disabled=true;
   try{
     await flushPendingWrites();
     if(pendingWrites().length)throw new Error('Pending offline changes must finish syncing before finalization.');
     // Read the current correction and finalized records from the cloud
     // before checking duplicates; older devices may have the legacy label.
     await pullCloudRecords('meta');
     await pullCloudRecords('reports');
     const finalizedReports=await getAll('reports');
     const thisMonth=a.monthValue||monthTextToValue(a.month||'');
     const duplicate=finalizedReports.find(r=>r.auditId!==a.id&&(r.monthValue||monthTextToValue(r.month||''))===thisMonth);
     if(duplicate)throw new Error('A finalized audit already exists for '+(a.month||thisMonth)+'. Open the existing report instead of creating a second finalized monthly audit.');

   const docs=Array.isArray(a.supportingDocuments)?a.supportingDocuments:[];
   const hasAdminImport=docs.some(d=>String(d.mimeType||'').toLowerCase()==='application/pdf'&&d.storagePath&&Array.isArray(d.administrationRows)&&d.administrationRows.length);
   if(hasAdminImport&&providerVialData(a.administrationRows||[],a.vialOverrides||{}).pending.length)
     return alert('Some Versed administrations need vial confirmation. Open Administration Import to review the 2 mg and 5 mg vial counts before finalizing.');
   if(!hasAdminImport){
     const admin=document.querySelector('.mobile-collapsible-admin');
     if(admin){admin.setAttribute('open','');const adminStep=admin.closest('[data-audit-step]');if(adminStep&&window.matchMedia('(max-width:700px)').matches){document.querySelectorAll('[data-audit-step]').forEach(s=>s.classList.remove('active-step'));adminStep.classList.add('active-step')}admin.scrollIntoView({behavior:'smooth',block:'start'})}
     return alert('Administration PDF import is required before finalizing this audit.');
   }
   const auditIncidents=Array.isArray(a.incidents)?a.incidents:[];
   const incompleteIncident=auditIncidents.find(x=>x.status!=='submitted'||!x.supportingDocument?.storagePath);
   if(incompleteIncident)return alert('All audit discrepancies / incidents must be submitted with an attached memo before the audit can be finalized.');
   for(const loc of LOCS){
     for(const med of MEDS){
       const count=a.counts?.[loc]?.[med];
       if(count===null||count===undefined||count==='')return alert('Enter the physical count for '+med+' at '+loc+' before finalizing.');
       if(!Number.isInteger(Number(count))||Number(count)<0)return alert('Enter a whole-vial physical count of zero or greater for '+med+' at '+loc+'.');
     }
   }
   for(const loc of LOCS)for(const med of MEDS){
     const confirmed=a.countConfirmations?.[loc]?.[med];
     if(!confirmed||Number(confirmed.value)!==Number(a.counts?.[loc]?.[med]))
       return alert('Confirm the physical count for '+med+' at '+loc+' before finalizing.');
   }
   if(!a.dateRangeStart||!a.dateRangeEnd)return alert('Audit period start and end dates are required before finalizing.');
   if(a.dateRangeStart>a.dateRangeEnd)return alert('Audit period start date cannot be after the end date.');
   if(!a.auditorName?.trim())return alert('Auditor name is required in Audit Details.');
   if(!validEmployeeNumber(a.auditorEmployeeNumber))return alert('A valid auditor employee number using digits only is required in Audit Details.');
   if(!a.attestationAccepted||!a.attestationName.trim())return alert('Final attestation and auditor name are required.');
   if(!validEmployeeNumber(a.attestationEmployeeNumber))return alert('A valid final auditor employee number using digits only is required.');
   if(!a.attestationSignature) return alert('Final auditor signature is required.');
   for(const loc of LOCS){
     if(!a.signatures[loc]?.signer?.trim())return alert('Auditor name is required for '+loc+'.');
     if(!validEmployeeNumber(a.signatures[loc]?.employeeNumber))return alert('A valid auditor employee number using digits only is required for '+loc+'.');
     if(!a.signatures[loc]?.witness?.trim())return alert('Witness name is required for '+loc+'.');
     if(!validEmployeeNumber(a.signatures[loc]?.witnessEmployeeNumber))return alert('A valid witness employee number using digits only is required for '+loc+'.');
     if(!a.signatures[loc]?.signature)return alert('Auditor signature is required for '+loc+'.');
     if(!a.signatures[loc]?.witnessSignature)return alert('Witness signature is required for '+loc+'.');
   }
   a.status='finalized';a.finalizedAt=nowISO();
   for(const loc of LOCS){
     for(const med of MEDS){
       await setBalance(loc,med,Number(a.counts?.[loc]?.[med]||0));
     }
   }
   const allTx=await getAll('transactions');
   const inRange=allTx.filter(t=>{
     if(t.auditId===a.id)return true;
     if(t.status==='draft')return false;
     const d=String(t.timestamp||'').slice(0,10);
     return (!a.dateRangeStart||d>=a.dateRangeStart)&&(!a.dateRangeEnd||d<=a.dateRangeEnd);
   });
   a.transactions=inRange;
   a.supportingDocuments=Array.isArray(a.supportingDocuments)?a.supportingDocuments:[];
   const txDocs=inRange.flatMap(t=>[t.supportingDocument,t.destructionReceipt]).filter(d=>d?.storagePath);
   const mergedDocs=[...a.supportingDocuments,...txDocs];
   const seenDocs=new Set();
   a.supportingDocuments=mergedDocs.filter(d=>{const k=d.storageBucket+'|'+d.storagePath;if(!d.storagePath||seenDocs.has(k))return false;seenDocs.add(k);return true;});
   await put('reports',{...a,id:'report_'+a.id,auditId:a.id});
   await put('audits',a);
   activeAuditId=null;
   await put('meta',{id:'activeAudit',auditId:'',updatedAt:nowISO()});
   await refreshAll();
   showReport('report_'+a.id);
   }catch(err){
     alert(err?.message||String(err));
   }finally{
     auditFinalizeInFlight=false;
     const finalizeBtn=document.getElementById('finalizeAudit');
     const saveBtn=document.getElementById('saveAudit');
     if(finalizeBtn){finalizeBtn.disabled=false;finalizeBtn.textContent='Finalize audit'}
     if(saveBtn)saveBtn.disabled=false;
   }
   return;
 }
 await put('audits',a);await refreshAll();editAudit(a.id);
}

function buildTestAuditReport(){
 const testCounts={},testPrior={},testTags={},testSigs={};
 LOCS.forEach((loc,li)=>{
   testCounts[loc]={};testPrior[loc]={};
   MEDS.forEach((med,mi)=>{testPrior[loc][med]=mi+1;testCounts[loc][med]=mi+2+li});
   testTags[loc]={foundRemoved:'TEST-'+(100+li),newInstalled:'TEST-'+(200+li)};
   testSigs[loc]={
     signer:'TEST AUDITOR',
     employeeNumber:'0000',
     witness:'TEST WITNESS '+(li+1),
     witnessEmployeeNumber:'900'+li,
     signature:'',
     witnessSignature:''
   };
 });
 return {
   id:'test_report_preview',
   auditId:'test_audit_preview',
   isTest:true,
   month:'TEST AUDIT — September 2026',
   status:'test',
   createdAt:nowISO(),
   updatedAt:nowISO(),
   finalizedAt:nowISO(),
   auditDate:'2026-09-25',
   email:'test@example.invalid',
   auditorName:'TEST AUDITOR',
   auditorEmployeeNumber:'0000',
   dateRangeStart:'2026-09-01',
   dateRangeEnd:'2026-09-25',
   counts:testCounts,
   priorCounts:testPrior,
   breakawayTags:testTags,
   supportingDocuments:[{name:'August 2026 Narcotic Administration Export.pdf',uploadedAt:'TEST PREVIEW',uploadedBy:'Imported source data'}],
   administrationRows:[
     {date:'8/31/26',report:'GFD202603409',provider:'SAM SMITH',medication:'Fentanyl',dose:50,unit:'M2'},
     {date:'8/31/26',report:'GFD202603409',provider:'SAM SMITH',medication:'Fentanyl',dose:50,unit:'M2'},
     {date:'8/30/26',report:'GFD202603382',provider:'Cheyenne Best',medication:'Fentanyl',dose:50,unit:'M2'},
     {date:'8/27/26',report:'GFD202603345',provider:'Zach Mattox',medication:'Versed',dose:5,unit:'M2'},
     {date:'8/27/26',report:'GFD202603339',provider:'Zach Mattox',medication:'Fentanyl',dose:25,unit:'M2'},
     {date:'8/24/26',report:'GFD202603287',provider:'Zach Mattox',medication:'Fentanyl',dose:50,unit:'M2'},
     {date:'8/24/26',report:'GFD202603287',provider:'Zach Mattox',medication:'Fentanyl',dose:50,unit:'M2'},
     {date:'8/19/26',report:'GFD202603237',provider:'Corrina Sandoval Ceja',medication:'Fentanyl',dose:20,unit:'M2'},
     {date:'8/15/26',report:'GFD202603175',provider:'Kelly Hoffman',medication:'Fentanyl',dose:50,unit:'M1'},
     {date:'8/15/26',report:'GFD202603175',provider:'Kelly Hoffman',medication:'Fentanyl',dose:50,unit:'M1'},
     {date:'8/13/26',report:'GFD202603144',provider:'Nick Estrada',medication:'Fentanyl',dose:50,unit:'M2'},
     {date:'8/1/26',report:'GFD202602967',provider:'Samuel Rieger',medication:'Versed',dose:5,unit:'M1'}
   ],
   usageSummary:'Imported administration source data: 12 dose rows · calculated vial use: 9 vials · 7 providers.',
   notes:'TEST AUDIT ONLY. This record contains synthetic data and is not a controlled-substance audit.',
   signatures:testSigs,
   attestationText:FINAL_ATTESTATION,
   attestationAccepted:true,
   attestationName:'TEST AUDITOR',
   attestationEmployeeNumber:'0000',
   attestationSignature:'data:image/svg+xml;utf8,'+encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="900" height="260" viewBox="0 0 900 260"><path d="M65 172 C135 72 170 220 235 132 C285 68 310 200 365 128 C420 62 450 210 510 122 C570 56 610 192 665 118 C715 76 760 126 825 108" fill="none" stroke="#172838" stroke-width="8" stroke-linecap="round"/><text x="60" y="225" font-family="cursive" font-size="34" fill="#172838">TEST AUDITOR</text></svg>')
 };
}

function reportShareDate(v){return formatDisplayDate(v)}

function reportYear(r){
 const m=String(r.month||'').match(/\b(20\d{2})\b/);
 if(m)return Number(m[1]);
 const d=new Date(r.auditDate||r.finalizedAt||r.createdAt||0);
 return Number.isNaN(d.getTime())?null:d.getFullYear();
}
function annualSummaryHtml(year,reports){
 const activeLocs=['Medic 1','Medic 2','Medic 3','Safe'];
 const sorted=[...reports].sort((a,b)=>String(a.auditDate||a.finalizedAt||'').localeCompare(String(b.auditDate||b.finalizedAt||'')));
 const first=sorted[0]||null,last=sorted[sorted.length-1]||null;

 const medSummary=MEDS.map(m=>{
   const firstTotal=first?activeLocs.reduce((n,l)=>n+Number(first.counts?.[l]?.[m]||0),0):0;
   const lastTotal=last?activeLocs.reduce((n,l)=>n+Number(last.counts?.[l]?.[m]||0),0):0;
   return {m,first:firstTotal,last:lastTotal,diff:lastTotal-firstTotal};
 });

 let adminRows=[],amendments=0,certifiedSites=0,totalSites=0,inventoryFindings=[];
 reports.forEach(r=>{
   if(Array.isArray(r.administrationRows))adminRows.push(...r.administrationRows);
   if(Array.isArray(r.inventoryFindings))inventoryFindings.push(...r.inventoryFindings.map(x=>({...x,auditMonth:r.month||''})));
   amendments+=Array.isArray(r.amendments)?r.amendments.length:0;
   LOCS.forEach(loc=>{
     totalSites++;
     const x=r.signatures?.[loc]||{};
     if(x.signer&&x.employeeNumber&&x.witness&&x.witnessEmployeeNumber&&x.signature&&x.witnessSignature)certifiedSites++;
   });
 });
 let vialTotal=null;
 try{
   const values=reports.map(r=>providerVialData(r.administrationRows||[],r.vialOverrides||{}).total);
   vialTotal=values.some(v=>v===null)?null:values.reduce((n,v)=>n+v,0);
 }catch(e){vialTotal=null}
 const providerCount=new Set(adminRows.map(x=>String(x.provider||'').trim()).filter(Boolean)).size;

 return '<div class="report-sheet report-finalized annual-report">'+
 '<div class="report-toolbar"><button id="closeReport">Close</button><button id="previewPdfReport">Generate PDF Preview</button><button id="shareReport">Share PDF</button><button id="printReport" class="primary">Print / Save PDF</button></div>'+
 '<section class="report-cover-page annual-cover">'+
 '<div class="report-cover-brand"><img src="gfd-patch.jpg" alt="Gladstone Fire Department patch"><div class="report-cover-dept">GLADSTONE FIRE DEPARTMENT</div></div>'+
 '<div class="report-cover-main"><div class="report-cover-kicker">YEAR-END CONTROLLED-SUBSTANCE REVIEW</div><h1>Narcotic Inventory / Audit<br>Annual Summary</h1><div class="report-cover-month">'+year+'</div></div>'+
 '<div class="report-cover-meta"><div><span>Monthly reports included</span><strong>'+reports.length+'</strong></div><div><span>First audit</span><strong>'+esc(reportShareDate(first?.auditDate||first?.finalizedAt)||'—')+'</strong></div><div><span>Last audit</span><strong>'+esc(reportShareDate(last?.auditDate||last?.finalizedAt)||'—')+'</strong></div><div><span>Generated</span><strong>'+esc(formatDisplayDate(new Date()))+'</strong></div></div>'+
 '<div class="report-cover-footer">Gladstone Fire Department · Year-End Narcotic Inventory / Audit Summary</div></section>'+
 '<section class="report-executive-summary"><h2>Year-end audit summary</h2>'+
 '<p>This summary is calculated from finalized monthly audit reports stored for '+year+'. It does not infer missing months or values.</p>'+
 '<ul>'+
 '<li><b>Finalized monthly audits:</b> '+reports.length+'.</li>'+
 '<li><b>Imported administration activity:</b> '+adminRows.length+' source dose row'+(adminRows.length===1?'':'s')+' across '+providerCount+' provider'+(providerCount===1?'':'s')+(vialTotal!==null?', calculating to '+vialTotal+' vial'+(vialTotal===1?'':'s'):'; vial count pending confirmation')+'.</li>'+
 '<li><b>Certification coverage:</b> '+certifiedSites+' of '+totalSites+' location Certification blocks contain auditor/witness identification and both signatures.</li>'+
 '<li><b>Recorded amendments:</b> '+amendments+'.</li>'+
 '</ul></section>'+
 '<section><h2>Year-start to year-end active inventory</h2><table class="report-table"><thead><tr><th>Medication</th><th>First finalized audit</th><th>Last finalized audit</th><th>Net change</th></tr></thead><tbody>'+
 medSummary.map(x=>'<tr><td>'+medicationDisplayHtml(x.m)+'</td><td>'+x.first+'</td><td><b>'+x.last+'</b></td><td><b>'+(x.diff>0?'+':'')+x.diff+'</b></td></tr>').join('')+
 '</tbody></table><p class="report-note">Active inventory includes Medic 1, Medic 2, Medic 3, and Safe; Expired inventory is excluded from active totals.</p></section>'+
 '<section><h2>Monthly audit register</h2><table class="report-table"><thead><tr><th>Month</th><th>Audit date</th><th>Auditor</th><th>Administration rows</th><th>Amendments</th></tr></thead><tbody>'+
 sorted.map(r=>'<tr><td>'+esc(r.month||'')+(r.reportingMonthCorrection?' <small>(administrative correction)</small>':'')+'</td><td>'+esc(reportShareDate(r.auditDate||r.finalizedAt)||'—')+'</td><td>'+esc(r.attestationName||r.auditorName||'—')+'</td><td>'+((r.administrationRows||[]).length)+'</td><td>'+((r.amendments||[]).length)+'</td></tr>').join('')+
 '</tbody></table></section>'+
 (inventoryFindings.length?'<section><h2>Expired / damaged medications found during audits</h2><p class="report-note">These findings were recorded within the live monthly audits. Retained items moved into Expired inventory; damaged vials that could not be physically retained were documented without increasing the Expired physical count. No separate inventory transactions were created.</p><table class="report-table"><thead><tr><th>Month</th><th>Date</th><th>Finding</th><th>Source</th><th>Medication</th><th>Qty</th><th>Notes</th></tr></thead><tbody>'+inventoryFindings.map(x=>'<tr><td>'+esc(x.auditMonth||'')+'</td><td>'+esc(formatDisplayDate(x.recordedAt)||'')+'</td><td>'+esc(x.typeLabel||x.type||'')+'</td><td>'+esc(x.sourceLocation||'')+' → '+esc(x.destinationLocation||'Expired')+'</td><td>'+medicationDisplayHtml(x.medication||'')+'</td><td>'+esc(x.quantity||'')+'</td><td>'+esc((x.physicalRetained===false?'No physical vial retained. ':'')+(x.note||''))+'</td></tr>').join('')+'</tbody></table></section>':'')+
 '<section><h2>Medication detail by month</h2><table class="report-table"><thead><tr><th>Month</th>'+MEDS.map(m=>'<th>'+medicationDisplayHtml(m)+'</th>').join('')+'</tr></thead><tbody>'+
 sorted.map(r=>'<tr><td>'+esc(r.month||'')+'</td>'+MEDS.map(m=>'<td>'+activeLocs.reduce((n,l)=>n+Number(r.counts?.[l]?.[m]||0),0)+'</td>').join('')+'</tr>').join('')+
 '</tbody></table></section>'+
 '<footer class="report-footer">Year-end summary · '+year+'</footer></div>';
}

function reportingMonthCorrectionHtml(record){
 const correction=record?.reportingMonthCorrection;
 if(!correction)return '';
 return '<section class="report-month-administrative-correction"><strong>Administrative reporting-month correction</strong>'+
   '<p>Originally labeled '+esc(correction.fromMonth)+'. Displayed as '+esc(correction.toMonth)+
   ' to match the recorded audit period. The finalized signed record, original source PDF, counts, seals and signatures remain unchanged.</p></section>';
}
function reportMonthKey(r){
 const direct=String(r?.monthValue||'').trim();
 if(/^\d{4}-(0[1-9]|1[0-2])$/.test(direct))return direct;
 const named=monthTextToValue(r?.month||'');
 if(named)return named;
 const iso=String(r?.auditDate||r?.finalizedAt||r?.createdAt||'').slice(0,7);
 return /^\d{4}-(0[1-9]|1[0-2])$/.test(iso)?iso:'';
}
function monthlySummaryHtml(key,report,multipleCount=1){
 const activeLocs=['Medic 1','Medic 2','Medic 3','Safe'];
 const title=monthValueToText(key)||report.month||key;
 const allLocations=LOCS;
 const num=(loc,med,source)=>source?.[loc]?.[med];
 const count=(loc,med)=>{const v=num(loc,med,report.counts);return v===null||v===undefined||v===''?'—':Number(v)};
 const sumKnown=(locs,med,source)=>{
   const vals=locs.map(l=>num(l,med,source));
   return vals.some(v=>v===null||v===undefined||v===''||!Number.isFinite(Number(v)))?null:vals.reduce((n,v)=>n+Number(v),0);
 };
 const display=n=>n===null?'—':n;
 const diff=(a,b)=>a===null||b===null?'—':(b-a>0?'+':'')+(b-a);
 const admin=Array.isArray(report.administrationRows)?report.administrationRows:[];
 const docs=Array.isArray(report.supportingDocuments)?report.supportingDocuments:[];
 const findings=Array.isArray(report.inventoryFindings)?report.inventoryFindings:[];
 const incidents=Array.isArray(report.incidents)?report.incidents:[];
 const amendments=Array.isArray(report.amendments)?report.amendments:[];
 const transactions=Array.isArray(report.transactions)?report.transactions:[];
 const providers=new Set(admin.map(a=>String(a.provider||'').trim()).filter(Boolean));
 const verifiedLocs=allLocations.filter(loc=>{
   const sig=report.signatures?.[loc]||{};
   return Boolean(sig.signer&&sig.employeeNumber&&sig.witness&&sig.witnessEmployeeNumber&&sig.signature&&sig.witnessSignature);
 });
 let vialData=null;
 try{if(admin.length)vialData=providerVialData(admin,report.vialOverrides||{})}catch(err){console.warn('Unable to calculate vial use',err)}
 const medRows=MEDS.map(m=>{
   const prior=sumKnown(activeLocs,m,report.priorCounts);
   const current=sumKnown(activeLocs,m,report.counts);
   const expired=count('Expired',m);
   return '<tr><td>'+medicationDisplayHtml(m)+'</td><td>'+display(prior)+'</td><td><b>'+display(current)+'</b></td><td>'+diff(prior,current)+'</td><td>'+expired+'</td></tr>';
 }).join('');
 const currentActive=MEDS.reduce((n,m)=>{
   const value=sumKnown(activeLocs,m,report.counts);
   return value===null?null:n===null?null:n+value;
 },0);
 const expiredTotal=MEDS.reduce((n,m)=>{
   const v=num('Expired',m,report.counts);
   return n===null||v===null||v===undefined||v===''?null:n+Number(v);
 },0);
 const physicalTotal=currentActive===null||expiredTotal===null?null:currentActive+expiredTotal;
 const locRows=allLocations.map(loc=>{
   const sig=report.signatures?.[loc]||{};
   const tags=report.breakawayTags?.[loc]||{};
   const vals=MEDS.map(m=>num(loc,m,report.counts));
   const total=vals.some(v=>v===null||v===undefined||v==='')?'—':vals.reduce((n,v)=>n+Number(v),0);
   return '<tr><td>'+esc(loc)+'</td><td>'+total+'</td><td>'+esc(tags.foundRemoved||'—')+'</td><td>'+esc(tags.newInstalled||'—')+'</td><td>'+(verifiedLocs.includes(loc)?'Complete':'Incomplete / not verified')+'</td></tr>';
 }).join('');
 const providerRows=vialData?.providers?.length?vialData.providers.map(([provider,items])=>
   '<tr><td>'+esc(provider)+'</td><td>'+(items.some(item=>item.pending)?'Pending':items.reduce((n,item)=>n+Number(item.vials||0),0))+'</td><td>'+
   esc(items.map(item=>item.medication+' '+item.strength+': '+item.vials).join('; '))+'</td></tr>').join(''):'';
 const findingRows=findings.map(x=>
   '<tr><td>'+esc(x.sourceLocation||'—')+'</td><td>'+esc(x.medication||'—')+'</td><td>'+esc(x.quantity??'—')+'</td><td>'+esc(x.typeLabel||x.type||'—')+'</td><td>'+esc(x.note||'—')+'</td></tr>').join('');
 const incidentRows=incidents.map(x=>
   '<tr><td>'+esc(x.sourceLocation||x.fromLocation||'—')+'</td><td>'+esc((x.items||[]).map(i=>i.medication+' × '+i.quantity).join(', ')||'—')+'</td><td>'+esc(x.status||'—')+'</td><td>'+esc(x.memoDescription||x.explanation||'—')+'</td></tr>').join('');
 const amendRows=amendments.map(x=>
   '<tr><td>'+esc(x.location||'—')+'</td><td>'+esc(x.medication||'—')+'</td><td>'+esc(x.from??'—')+' → '+esc(x.to??'—')+'</td><td>'+esc(x.reason||'—')+'</td></tr>').join('');
 const auditor=report.attestationName||report.auditorName||'—';
 return '<div class="report-sheet report-finalized annual-report monthly-summary-report">'+
 '<div class="report-toolbar"><button id="closeReport">Close</button><button id="previewPdfReport">Generate PDF Preview</button><button id="shareReport">Share PDF</button><button id="printReport" class="primary">Print / Save PDF</button></div>'+
 '<section class="report-cover-page annual-cover">'+
 '<div class="report-cover-brand"><img src="gfd-patch.jpg" alt="Gladstone Fire Department patch"><div class="report-cover-dept">GLADSTONE FIRE DEPARTMENT</div></div>'+
 '<div class="report-cover-main"><div class="report-cover-kicker">MONTHLY CONTROLLED-SUBSTANCE REVIEW</div><h1>Narcotic Inventory / Audit<br>Monthly Summary</h1><div class="report-cover-month">'+esc(title)+'</div></div>'+
 '<div class="report-cover-meta"><div><span>Audit date</span><strong>'+esc(reportShareDate(report.auditDate||report.finalizedAt)||'—')+'</strong></div>'+
 '<div><span>Audit period</span><strong>'+esc(reportShareDate(report.dateRangeStart)||'—')+' – '+esc(reportShareDate(report.dateRangeEnd)||'—')+'</strong></div>'+
 '<div><span>Certifying auditor</span><strong>'+esc(auditor)+'</strong></div>'+
 '<div><span>Generated</span><strong>'+esc(formatDisplayDate(new Date()))+'</strong></div></div>'+
 '<div class="report-cover-footer">Gladstone Fire Department · Monthly Narcotic Inventory / Audit Summary</div></section>'+
 reportingMonthCorrectionHtml(report)+
 '<section class="report-executive-summary"><h2>Monthly audit summary</h2>'+
 '<p>Generated from the finalized '+esc(title)+' audit. Physical counts are those documented at the audit, not a live stock verification. This summary is not a substitute for the signed audit packet.</p><ul>'+
 '<li><b>Physical inventory at audit:</b> '+display(currentActive)+' active, '+display(expiredTotal)+' Expired, '+display(physicalTotal)+' across all locations.</li>'+
 '<li><b>Administration source:</b> '+(admin.length?admin.length+' recorded dose row'+(admin.length===1?'':'s')+' from '+providers.size+' provider'+(providers.size===1?'':'s')+(vialData?.total!==null&&vialData?.total!==undefined?', '+vialData.total+' calculated vial'+(vialData.total===1?'':'s')+' used':'; vial count pending confirmation')+'.':'No administration dose rows included in the stored report; use cannot be estimated.')+'</li>'+
 '<li><b>Certification:</b> '+verifiedLocs.length+' of '+LOCS.length+' locations have auditor and witness identification and both signature images.</li>'+
 '<li><b>Documentation:</b> '+findings.length+' damaged/expired finding'+(findings.length===1?'':'s')+', '+incidents.length+' incident'+(incidents.length===1?'':'s')+', '+amendments.length+' amendment'+(amendments.length===1?'':'s')+', and '+transactions.length+' recorded transaction'+(transactions.length===1?'':'s')+'.</li>'+
 '</ul>'+
 (multipleCount>1?'<p><b>Record selection:</b> '+multipleCount+' finalized records were found for this month; this summary uses the most recently finalized record only to avoid double-counting.</p>':'')+
 (amendments.length?'<p><b>Amended audit:</b> Corrections recorded after original signatures may not have been separately certified. See the amendment history and original signed packet.</p>':'')+
 '</section>'+
 '<section><h2>Active inventory comparison</h2><table class="report-table"><thead><tr><th>Medication</th><th>Previous audit</th><th>Current audit</th><th>Net change</th><th>Expired</th></tr></thead><tbody>'+medRows+'</tbody></table>'+
 '<p class="report-note">Active counts include Medic 1, Medic 2, Medic 3, and Safe. Expired is shown separately. An em dash indicates missing prior data, not zero.</p></section>'+
 '<section><h2>Location counts, seals &amp; certification</h2><table class="report-table"><thead><tr><th>Location</th><th>Count</th><th>Tag removed</th><th>Tag installed</th><th>Signatures</th></tr></thead><tbody>'+locRows+'</tbody></table></section>'+
 '<section><h2>Administration reconciliation</h2>'+
 (providerRows?'<p class="report-note">'+admin.length+' source dose rows; estimated '+vialData.total+' vials from the department calculation rules. This is a reconciliation reference only.</p><table class="report-table"><thead><tr><th>Provider</th><th>Vials</th><th>Medication / vial detail</th></tr></thead><tbody>'+providerRows+'</tbody></table>':'<p>No administration details were available in this finalized record. This does not establish that no medications were administered.</p>')+
 (docs.length?'<p class="report-note">Supporting documents referenced: '+esc(docs.map(d=>d.name||'PDF attachment').join('; '))+'.</p>':'')+
 '</section>'+
 (findings.length?'<section><h2>Damaged / expired medication findings</h2><table class="report-table"><thead><tr><th>Source</th><th>Medication</th><th>Qty</th><th>Finding</th><th>Notes</th></tr></thead><tbody>'+findingRows+'</tbody></table></section>':'')+
 (incidents.length?'<section><h2>Recorded discrepancies / incidents</h2><table class="report-table"><thead><tr><th>Location</th><th>Items</th><th>Status</th><th>Memo</th></tr></thead><tbody>'+incidentRows+'</tbody></table></section>':'')+
 (amendments.length?'<section><h2>Correction / amendment history</h2><table class="report-table"><thead><tr><th>Location</th><th>Medication</th><th>Change</th><th>Reason</th></tr></thead><tbody>'+amendRows+'</tbody></table></section>':'')+
 '<section><h2>Auditor notes</h2><p class="audit-notes-text">'+esc(report.notes||'No overall notes entered.').replace(/\n/g,'<br>')+'</p></section>'+
 '<footer class="report-footer">Monthly summary · '+esc(title)+' · Based on finalized audit record</footer></div>';
}
async function showMonthlySummary(month,year){
 const yr=String(year||'').trim(),m=String(month||'').padStart(2,'0');
 if(!/^\d{4}$/.test(yr)||!/^(0[1-9]|1[0-2])$/.test(m))return alert('Select a valid month and year.');
 const key=yr+'-'+m;
 // Fetch current finalized reports only when a report is requested; the
 // dashboard itself stays fast and offline-capable.
 if(cloudSession&&navigator.onLine){
   try{await pullCloudRecords('reports')}catch(err){console.warn('Using locally saved reports',err)}
 }
 const matches=(await getAll('reports')).filter(r=>String(r.status||'finalized').toLowerCase()==='finalized'&&reportMonthKey(r)===key)
   .sort((a,b)=>String(b.finalizedAt||b.updatedAt||b.auditDate||'').localeCompare(String(a.finalizedAt||a.updatedAt||a.auditDate||'')));
 if(!matches.length)return alert('No finalized monthly audit is available for '+monthValueToText(key)+'. Save or finalize the audit before generating a summary.');
 const record=matches[0],d=document.getElementById('reportDialog'),preview=document.getElementById('reportPreview');
 if(d.open)d.close();
 preview.innerHTML=monthlySummaryHtml(key,record,matches.length);
 preview._packetSupportingDocuments=uniqueSupportingDocuments(record.supportingDocuments||[]);
 d.showModal();document.body.classList.add('report-open');
 d.scrollTop=0;preview.scrollTop=0;
 const title='Gladstone FD Narcotic Inventory Audit Monthly Summary — '+monthValueToText(key);
 const close=document.getElementById('closeReport'),pdfPreview=document.getElementById('previewPdfReport'),share=document.getElementById('shareReport'),print=document.getElementById('printReport');
 if(close)close.onclick=()=>d.close();
 if(pdfPreview)pdfPreview.onclick=()=>previewRenderedReportPdf(preview,title);
 if(share)share.onclick=()=>shareRenderedReport(preview,title);
 if(print)print.onclick=()=>shareRenderedReport(preview,title);
 d.onclose=()=>{document.body.classList.remove('report-open');preview.innerHTML='';setTimeout(refreshAll,0)};
}

async function showAnnualReport(year){
 let rows=await getAll('reports');
 rows=rows.filter(r=>reportYear(r)===Number(year));
 if(!rows.length)return alert('No finalized reports are available for '+year+'.');
 const d=document.getElementById('reportDialog'),preview=document.getElementById('reportPreview');
 if(d.open)d.close();
 preview.innerHTML=annualSummaryHtml(year,rows);
 preview._packetSupportingDocuments=uniqueSupportingDocuments(rows.flatMap(r=>r.supportingDocuments||[]));
 d.showModal();document.body.classList.add('report-open');
 const title='Gladstone FD Narcotic Inventory Audit Annual Summary — '+year;
 const close=document.getElementById('closeReport'),pdfPreview=document.getElementById('previewPdfReport'),share=document.getElementById('shareReport'),print=document.getElementById('printReport');
 if(close)close.onclick=()=>d.close();
 if(pdfPreview)pdfPreview.onclick=()=>previewRenderedReportPdf(preview,title);
 if(share)share.onclick=()=>shareRenderedReport(preview,title);
 if(print)print.onclick=()=>shareRenderedReport(preview,title);
 d.onclose=()=>{document.body.classList.remove('report-open');preview.innerHTML='';setTimeout(refreshAll,0)};
}

async function renderReports(){
 let rows=await getAll('reports');
 rows=rows.filter(r=>String(r.status||'finalized').toLowerCase()==='finalized');
 rows.sort((a,b)=>String(b.finalizedAt||b.auditDate||'').localeCompare(String(a.finalizedAt||a.auditDate||'')));
 const years=[...new Set(rows.map(reportYear).filter(Boolean))].sort((a,b)=>b-a);
 const annual=years.length?'<div class="annual-report-card"><div><span class="kicker">YEAR-END REVIEW</span><h3>Annual summary report</h3><div class="meta">Generate a data-backed summary from finalized monthly audits.</div></div><div class="annual-report-controls"><select id="annualReportYear" aria-label="Annual report year">'+years.map(y=>'<option value="'+y+'">'+y+'</option>').join('')+'</select><button id="generateAnnualReport">Generate annual report</button></div></div>':'';
 // Native select controls display as wheel pickers on iPhone Safari.
 // Report month is the audit's reporting month, NOT the calendar month in
 // which the physical audit was completed or finalized.
 const monthNames=['January','February','March','April','May','June','July','August','September','October','November','December'];
 const previousMonth=document.getElementById('monthlyReportMonth')?.value;
 const previousYear=document.getElementById('monthlyReportYear')?.value;
 const latestKey=rows.map(reportMonthKey).filter(Boolean).sort().pop();
 const now=new Date();
 const initial=latestKey||String(now.getFullYear())+'-'+String(now.getMonth()+1).padStart(2,'0');
 const selectedMonth=previousMonth||initial.slice(5,7);
 const selectedYear=previousYear||initial.slice(0,4);
 const monthYears=new Set(rows.map(reportMonthKey).filter(Boolean).map(key=>key.slice(0,4)));
 [now.getFullYear()-1,now.getFullYear(),now.getFullYear()+1,Number(selectedYear)].forEach(y=>monthYears.add(String(y)));
 const selectableYears=[...monthYears].filter(v=>/^\d{4}$/.test(v)).sort((a,b)=>b.localeCompare(a));
 const monthly='<div class="annual-report-card monthly-summary-card"><div><span class="kicker">MONTHLY REVIEW</span><h3>Monthly summary report</h3><div class="meta">Choose a reporting month and year. Available for finalized audits; the original signed audit report remains unchanged.</div></div>'+
 '<div class="monthly-summary-controls">'+
 '<label for="monthlyReportMonth">Month<select id="monthlyReportMonth" aria-label="Select report month">'+
 monthNames.map((m,i)=>{const val=String(i+1).padStart(2,'0');return '<option value="'+val+'" '+(val===selectedMonth?'selected':'')+'>'+m+'</option>'}).join('')+'</select></label>'+
 '<label for="monthlyReportYear">Year<select id="monthlyReportYear" aria-label="Select report year">'+
 selectableYears.map(y=>'<option value="'+y+'" '+(y===selectedYear?'selected':'')+'>'+y+'</option>').join('')+'</select></label>'+
 '<button type="button" id="generateMonthlyReport" class="primary">Generate monthly report</button></div></div>';
 const testCard='<div class="list-item test-report-card"><div><span class="test-badge">TEST</span><strong>Test audit report</strong><div class="meta">Synthetic data · safe report-layout preview</div></div><div class="button-row"><button data-test-report="1">View test report</button></div></div>';
 const real=rows.length?rows.map(r=>'<div class="list-item"><strong>'+esc(r.month||monthValueToText(reportMonthKey(r))||'Monthly audit')+'</strong><div class="meta">Finalized '+fmtDate(r.finalizedAt)+' · '+esc(r.attestationName||'')+(r.reportingMonthCorrection?' · Reporting-month correction recorded':'')+'</div><div class="button-row"><button data-report="'+esc(r.id)+'">View / print original audit</button></div></div>').join(''):'<div class="card empty">No finalized audits yet.</div>';
 document.getElementById('reportsList').innerHTML=monthly+annual+testCard+real;
 const annualBtn=document.getElementById('generateAnnualReport');
 if(annualBtn)annualBtn.onclick=()=>showAnnualReport(document.getElementById('annualReportYear')?.value);
 const monthlyBtn=document.getElementById('generateMonthlyReport');
 if(monthlyBtn)monthlyBtn.onclick=()=>showMonthlySummary(document.getElementById('monthlyReportMonth')?.value,document.getElementById('monthlyReportYear')?.value);
}

async function sharePdfFile(file,title){
 if(!(file instanceof File)||file.type!=='application/pdf'||!file.name.toLowerCase().endsWith('.pdf')){
   throw new Error('Only PDF files may be shared from this app.');
 }
 if(navigator.share&&(!navigator.canShare||navigator.canShare({files:[file]}))){
   await navigator.share({title,text:title,files:[file]});
   return true;
 }
 return false;
}

function uniqueSupportingDocuments(docs=[]){
 const seen=new Set();
 return (docs||[]).filter(d=>{
   if(!d?.storagePath)return false;
   const k=(d.storageBucket||'audit-supporting-docs')+'|'+d.storagePath;
   if(seen.has(k))return false;seen.add(k);return true;
 });
}
// For imported ESO administration PDFs, include only pages with actual
// dated medication rows and crop out source report headers/filter banners.
// No stored attachment is edited or replaced.
async function administrationAppendixPageRanges(bytes,expectedRows=0){
 await ensurePdfReader();
 const reader=await window.pdfjsLib.getDocument({data:bytes.slice()}).promise;
 const selected=[];
 try{
  for(let index=0;index<reader.numPages;index++){
   const page=await reader.getPage(index+1);
   const content=await page.getTextContent();
   const items=(content.items||[]).map(item=>({
    text:String(item.str||'').trim(),
    x:Number(item.transform?.[4]),y:Number(item.transform?.[5])
   })).filter(item=>item.text&&Number.isFinite(item.x)&&Number.isFinite(item.y));
   const full=items.map(item=>item.text).join(' ');
   const incidents=items.filter(item=>/\bGFD\s*\d{6,}\b/i.test(item.text));
   const hasDrug=/\b(Fentanyl|Versed|Midazolam|Morphine|Ketamine)\b/i.test(full);
   const hasDate=/\b\d{1,2}\/\d{1,2}\/\d{2,4}\b/.test(full);
   // Ignore the original blank/filter-title page. Never treat a 09/2026
   // filter line by itself as an actual administration record.
   if(!incidents.length||!hasDrug||!hasDate)continue;
   const firstY=Math.max(...incidents.map(item=>item.y));
   const lastY=Math.min(...incidents.map(item=>item.y));
   const heads=items.filter(item=>item.y>=firstY-2&&item.y<=firstY+36&&
    /Incident|Date|Number|Provider|Treatment|Dose|Unit/i.test(item.text));
   const headY=heads.length?Math.max(...heads.map(item=>item.y)):firstY+11;
   const cells=items.filter(item=>item.y>=lastY-2&&item.y<=headY+4);
   const left=Math.max(0,Math.min(...cells.map(item=>item.x))-12);
   const rightText=Math.max(...cells.map(item=>item.x+Math.max(12,item.text.length*5.3)));
   const size=page.getViewport({scale:1,rotation:0});
   const right=Math.min(size.width,rightText+11);
   const bottom=Math.max(0,lastY-3);
   const top=Math.min(size.height,headY+8);
   const crop=right-left>size.width*.4&&top-bottom>45?
    {x:left,y:bottom,width:right-left,height:top-bottom}:null;
   selected.push({index,crop,incidentCount:incidents.length});
  }
 }finally{await reader.destroy();}
 if(!selected.length)throw new Error('The imported ESO PDF has no recognizable dated medication rows. Verify the source file before creating the data-only appendix.');
 if(expectedRows>0){
  const found=selected.reduce((n,p)=>n+p.incidentCount,0);
  if(found<expectedRows)throw new Error('The imported ESO PDF has fewer visible medication rows than the saved audit import. Check the source file before exporting.');
 }
 return selected;
}
async function appendSupportingPdfs(baseBlob,docs=[],options={}){
 const unique=uniqueSupportingDocuments(docs);
 if(!unique.length)return baseBlob;
 await ensurePdfMerger();
 const merged=await window.PDFLib.PDFDocument.load(await baseBlob.arrayBuffer());
 for(const doc of unique){
  const bucket=doc.storageBucket||'audit-supporting-docs';
  const {data,error}=await sb.storage.from(bucket).download(doc.storagePath);
  if(error||!data)throw new Error('Unable to retrieve supporting document: '+(doc.name||'PDF'));
  const bytes=new Uint8Array(await data.arrayBuffer());
  const src=await window.PDFLib.PDFDocument.load(bytes);
  const isESO=options.dataOnlyAdministrationAppendix&&
   Array.isArray(doc.administrationRows)&&doc.administrationRows.length>0;
  if(isESO){
   const selected=await administrationAppendixPageRanges(bytes,doc.administrationRows.length);
   for(const entry of selected){
    const [copy]=await merged.copyPages(src,[entry.index]);
    if(entry.crop&&(copy.getRotation()?.angle||0)===0){
     const crop=entry.crop;
     copy.setCropBox(crop.x,crop.y,crop.width,crop.height);
    }
    merged.addPage(copy);
   }
  }else{
   const pages=await merged.copyPages(src,src.getPageIndices());
   pages.forEach(p=>merged.addPage(p));
  }
 }
 return new Blob([await merged.save()],{type:'application/pdf'});
}
async function generateRenderedReportPdf(preview,title='Narcotic Inventory Audit Report'){
  // All finalized report families use the same searchable August 2026
  // PDF layout engine. Monthly and annual summaries retain their own figures,
  // terminology, and summary-only certification status. Do not route them to
  // the legacy screenshot/html2canvas PDF exporter.
  const finalizedSheet=preview?.querySelector('.report-sheet.report-finalized');
  if(finalizedSheet){
    if(typeof generateVectorAuditPacketPdf!=='function')
      throw new Error('Audit packet PDF renderer was not loaded. Reload the app and try again.');
    return generateVectorAuditPacketPdf(preview,title);
  }
 const sheet=preview?.querySelector('.report-sheet');
 if(!sheet)throw new Error('Report preview is not ready yet.');
 // Prevent a valid-looking PDF from being generated from an empty report.
 if((sheet.textContent||'').trim().length<60)
   throw new Error('The report content is empty. Reopen the monthly report and try again.');
 await ensurePdfWriter();

 const clone=sheet.cloneNode(true);
 clone.querySelector('.report-toolbar')?.remove();
 clone.querySelector('.test-report-banner')?.remove();
 // html2pdf moves this element into its own container. Preserve the PDF
 // styling ancestor on the element it actually clones so patch sizes,
 // page-break rules and compact report tables survive the move.
 clone.classList.add('pdf-clean-report','pdf-clean-stage');
 clone.style.width='7.55in';
 clone.style.maxWidth='7.55in';
 clone.style.margin='0';
 clone.style.padding='0';
 clone.style.overflow='visible';

 const clearPdfBreaks=node=>{
   if(!node)return;
   [node,...node.querySelectorAll('*')].forEach(el=>{
     el.classList?.remove(
       'pdf-section-page','pdf-break-before','pdf-break-after','pdf-keep-together',
       'pdf-standalone-section','pdf-report-section'
     );
     if(el.style){
       el.style.breakBefore='auto';
       el.style.pageBreakBefore='auto';
       el.style.breakAfter='auto';
       el.style.pageBreakAfter='auto';
       el.style.breakInside='auto';
       el.style.pageBreakInside='auto';
     }
   });
 };

 clearPdfBreaks(clone);

 // On phones, force the PDF clone to the same geometry used by the working desktop output.
 // Inline !important styles intentionally bypass responsive media-query rules during capture.
 if(window.matchMedia('(max-width:700px)').matches){
   const imp=(el,prop,val)=>el&&el.style.setProperty(prop,val,'important');
   imp(clone,'width','7.55in');
   imp(clone,'min-width','7.55in');
   imp(clone,'max-width','7.55in');
   imp(clone,'margin','0');
   imp(clone,'padding','0');
   imp(clone,'overflow','visible');

   const top=clone.querySelector('.report-top');
   if(top){
     imp(top,'display','flex');
     imp(top,'align-items','center');
     imp(top,'gap','18px');
     imp(top,'width','100%');
     const logo=top.querySelector('img');
     if(logo){imp(logo,'width','88px');imp(logo,'height','88px');imp(logo,'flex','0 0 88px');}
     const h1=top.querySelector('h1');
     if(h1){imp(h1,'font-size','1.55rem');imp(h1,'line-height','1.12');}
   }

   const meta=clone.querySelector('.report-meta-grid');
   if(meta){
     imp(meta,'display','grid');
     imp(meta,'grid-template-columns','1fr 1fr');
     imp(meta,'column-gap','28px');
     imp(meta,'row-gap','4px');
     meta.querySelectorAll('.wide').forEach(el=>imp(el,'grid-column','1 / -1'));
   }

   clone.querySelectorAll('.report-cover-meta').forEach(el=>{
     imp(el,'display','grid');
     imp(el,'grid-template-columns','1fr 1fr');
   });

   clone.querySelectorAll('.report-table').forEach(el=>{
     imp(el,'width','100%');
     imp(el,'min-width','0');
     imp(el,'max-width','100%');
   });
   clone.querySelectorAll('.report-inventory,.report-transactions,.report-imported-admin .report-table').forEach(el=>imp(el,'min-width','0'));

   clone.querySelectorAll('.report-signature-grid').forEach(el=>{
     imp(el,'display','grid');
     imp(el,'grid-template-columns','1fr 1fr');
     imp(el,'gap','8px');
   });

   clone.querySelectorAll('.pdf-medic1-medic2-wrap,.pdf-medic3-safe-wrap').forEach(el=>{
     imp(el,'display','flex');
     imp(el,'flex-direction','row');
     imp(el,'flex-wrap','nowrap');
     imp(el,'gap','7px');
     imp(el,'width','100%');
     imp(el,'align-items','stretch');
     [...el.children].forEach(card=>{
       imp(card,'flex','1 1 0');
       imp(card,'width','calc(50% - 3.5px)');
       imp(card,'max-width','calc(50% - 3.5px)');
       imp(card,'min-width','0');
       imp(card,'margin','0');
     });
   });
 }

 // Explicit descriptor hooks for PDF styling.
 clone.querySelectorAll('.report-meta-grid > div').forEach(el=>{
   if(!el.textContent.trim()){ el.classList.add('pdf-meta-empty'); return; }
   el.classList.add('pdf-descriptor-row');
   const label=el.querySelector(':scope > b');
   if(label)label.classList.add('pdf-descriptor-label');
 });
 clone.querySelectorAll(
   '.report-note,.report-vial-explainer,.pdf-medic3-explainer,.pdf-expired-explainer,.report-cert-statement'
 ).forEach(el=>el.classList.add('pdf-descriptor-callout'));
 clone.querySelectorAll('.report-signature-label,.report-signature-site,.report-cert-site').forEach(el=>
   el.classList.add('pdf-descriptor-chip')
 );
 clone.querySelectorAll('.report-eso-source p').forEach(el=>el.classList.add('pdf-descriptor-callout'));

 clone.querySelectorAll('.report-table').forEach(table=>{
   table.style.width='100%';
   table.style.minWidth='0';
 });
 clone.querySelectorAll('.report-table thead').forEach(el=>el.style.display='table-header-group');
 clone.querySelectorAll('.report-table tr').forEach(el=>{
   el.style.breakInside='avoid';
   el.style.pageBreakInside='avoid';
 });

 const cover=clone.querySelector('.report-cover-page');
 const reportTop=clone.querySelector('.report-top');
 const metaGrid=clone.querySelector('.report-meta-grid');
 const blueRule=clone.querySelector('.report-blue-rule');
 const executive=clone.querySelector('.report-executive-summary');

 const isMonthlyPacket=!!(cover&&reportTop&&metaGrid&&executive);
 let packetMonth='';
 let packetDateRange='';
 let packetLogoSrc='';
 let runningHeaderLogoData='';

 if(isMonthlyPacket){
   packetMonth=(cover.querySelector('.report-cover-month')?.textContent||'Monthly Audit').trim();
   const rangeCell=[...cover.querySelectorAll('.cover-meta-cell')].find(cell=>
     (cell.querySelector('span')?.textContent||'').trim().toLowerCase()==='audit date range'
   );
   packetDateRange=(rangeCell?.querySelector('strong')?.textContent||'').trim();
   packetLogoSrc=cover.querySelector('.report-cover-brand img')?.src||reportTop.querySelector('img')?.src||'';
   if(packetLogoSrc){
     try{
       const logoResponse=await fetch(packetLogoSrc,{mode:'cors',cache:'force-cache'});
       if(logoResponse.ok){
         const logoBlob=await logoResponse.blob();
         runningHeaderLogoData=await new Promise((resolve,reject)=>{
           const reader=new FileReader();
           reader.onload=()=>resolve(String(reader.result||''));
           reader.onerror=()=>reject(reader.error);
           reader.readAsDataURL(logoBlob);
         });
       }
     }catch(err){
       console.warn('PDF running-header logo could not be embedded.',err);
     }
   }

   const findSection=label=>[...clone.querySelectorAll('section')].find(s=>
     (s.querySelector(':scope > h2')?.textContent||'').trim().toLowerCase()===label.toLowerCase()
   );
   const makePage=(pageTitle,className,nodes=[])=>{
     const page=document.createElement('section');
     page.className='pdf-packet-page '+className;
     page.innerHTML=
       '<div class="pdf-packet-header">'+
         '<div class="pdf-packet-header-brand">'+
           // Running headers already get the small department patch.
           // An unconstrained second image split every interior report page.
           '<div><strong>Gladstone Fire Department</strong><span>Narcotic Inventory / Audit Report</span></div>'+
         '</div>'+
         '<div class="pdf-packet-header-meta"><strong>'+esc(packetMonth||'Monthly Audit')+'</strong><span>'+esc(packetDateRange||'')+'</span></div>'+
       '</div>'+
       '<h2 class="pdf-packet-title">'+pageTitle+'</h2>';
     nodes.filter(Boolean).forEach(node=>{
       clearPdfBreaks(node);
       page.appendChild(node);
     });
     return page;
   };
   const removeOwnHeading=node=>{
     const h=node?.querySelector(':scope > h2');
     if(h)h.remove();
   };

   const amendment=clone.querySelector('.report-amendment');
   const inventory=findSection('Inventory comparison');
   const tags=findSection('Breakaway tag record');
   const esoSource=clone.querySelector('.report-eso-source');
   const importedAdmin=clone.querySelector('.report-imported-admin');
   const transactions=clone.querySelector('.report-transactions-section') ||
     [...clone.querySelectorAll('section')].find(s=>
       (s.querySelector(':scope > h2')?.textContent||'').trim().toLowerCase().startsWith('transactions in the audit reporting period')
     );
   const signatures=clone.querySelector('.report-signature-section');
   const attestation=clone.querySelector('.report-attestation');
   const notes=clone.querySelector('.report-notes');
   const incidents=clone.querySelector('.report-incidents');
   const finalRecordFooter=clone.querySelector('.report-footer');

   clearPdfBreaks(cover);
   cover.classList.add('pdf-packet-cover');
   // Protect the cover image dimensions inside independently cloned PDF DOM.
   const coverPatch=cover.querySelector('.report-cover-brand img');
   if(coverPatch){
     coverPatch.style.setProperty('width','30px','important');
     coverPatch.style.setProperty('height','30px','important');
     coverPatch.style.setProperty('min-width','30px','important');
     coverPatch.style.setProperty('max-width','30px','important');
     coverPatch.style.setProperty('object-fit','contain','important');
   }

   if(executive){
     executive.classList.remove('pdf-executive-page');
     executive.style.breakBefore='auto';
     executive.style.pageBreakBefore='auto';
     executive.style.breakAfter='auto';
     executive.style.pageBreakAfter='auto';
     executive.style.minHeight='0';
   }

   // Compact front matter: the cover and summary share the first PDF page.
   const pages=[];
   pages.push(makePage('Monthly Audit Overview',
     'pdf-monthly-summary-page pdf-front-page',
     [cover,metaGrid,blueRule,executive]));

      if(amendment){
     removeOwnHeading(amendment);
     pages.push(makePage(
       'Amended Inventory Record / Correction History',
       'pdf-amendment-page',
       [amendment]
     ));
   }

   pages.push(makePage(
     'Inventory Comparison / Breakaway Tag Record',
     'pdf-inventory-tags-page',
     [inventory,tags]
   ));

   if(esoSource||importedAdmin){
     removeOwnHeading(esoSource);
     pages.push(makePage(
       'ESO Narcotic Administration Record',
       'pdf-eso-record-page',
       [esoSource,importedAdmin]
     ));
   }

   if(transactions){
     removeOwnHeading(transactions);
     pages.push(makePage(
       'Transactions in the Audit Reporting Period',
       'pdf-transactions-page',
       [transactions]
     ));
   }

   if(signatures){
     const cards=[...signatures.querySelectorAll('.report-cert')];
     const byTitle=t=>cards.find(card=>
       (card.querySelector('h2')?.textContent||'').trim().toLowerCase()===t.toLowerCase()
     );

     const addCertPage=(loc,extraNodes=[])=>{
       const card=byTitle(loc+' Certification');
       if(!card)return;
       clearPdfBreaks(card);
       card.classList.add('pdf-single-cert-card');
       pages.push(makePage(
         loc+' Audit Site Certification',
         'pdf-certifications-page pdf-single-certification-page pdf-cert-'+loc.toLowerCase().replace(/[^a-z0-9]+/g,'-'),
         [...extraNodes,card]
       ));
     };

     const medic1=byTitle('Medic 1 Certification');
     const medic2=byTitle('Medic 2 Certification');
     if(medic1||medic2){
       if(medic1){clearPdfBreaks(medic1);medic1.classList.add('pdf-single-cert-card');}
       if(medic2){clearPdfBreaks(medic2);medic2.classList.add('pdf-single-cert-card');}
       const wrap=document.createElement('div');
       wrap.className='pdf-medic1-medic2-wrap';
       [medic1,medic2].filter(Boolean).forEach(card=>wrap.appendChild(card));
       pages.push(makePage(
         'Medic 1 / Medic 2 Audit Site Certifications',
         'pdf-certifications-page pdf-medic1-medic2-page',
         [wrap]
       ));
     }

     const medic3Intro=document.createElement('p');
     medic3Intro.className='pdf-medic3-explainer';
     medic3Intro.textContent='Medic 3 is a reserve, semi-dynamic unit. Its narcotics are normally secured in the Safe and moved to Medic 3 when placed in service.';
     const medic3=byTitle('Medic 3 Certification');
     const safe=byTitle('Safe Certification');
     if(medic3||safe){
       const wrap=document.createElement('div');
       wrap.className='pdf-medic3-safe-wrap';
       [medic3,safe].filter(Boolean).forEach(card=>{
         clearPdfBreaks(card);card.classList.add('pdf-single-cert-card');wrap.appendChild(card);
       });
       pages.push(makePage('Medic 3 / Safe Site Certifications',
         'pdf-certifications-page pdf-medic3-safe-page',[medic3Intro,wrap]));
     }

          const expiredIntro=document.createElement('p');
     expiredIntro.className='pdf-expired-explainer';
     expiredIntro.textContent='This page documents the physical count, seal verification, auditor certification, and witness certification for controlled substances placed in the Expired inventory location during this audit.';
     addCertPage('Expired',[expiredIntro]);
   }

   if(notes||incidents||finalRecordFooter){
     removeOwnHeading(incidents);
     removeOwnHeading(notes);
     pages.push(makePage(
       'Audit Notes / Discrepancies / Final Record',
       'pdf-notes-page',
       [incidents,notes,finalRecordFooter]
     ));
   }

   if(attestation){
     removeOwnHeading(attestation);
     pages.push(makePage(
       'Final Controlled-Substance Audit Attestation',
       'pdf-attestation-page pdf-final-packet-page',
       [attestation]
     ));
   }

   clone.replaceChildren(...pages.filter(Boolean));
 }else{
   // Use natural pagination for annual/monthly executive summaries.
   const condensed=/\b(annual|monthly) summary\b/i.test(title);
   if(condensed)clone.classList.add('report-summary-condensed');
   const sections=[...clone.querySelectorAll(':scope > section')];
   sections.forEach((section,index)=>{
     clearPdfBreaks(section);
     section.classList.add('pdf-generic-section');
     if(!condensed&&index>0)section.classList.add('pdf-page-start');
   });
 }

  const stage=document.createElement('div');
 stage.className='pdf-render-stage pdf-clean-stage';
 // Avoid the far-offscreen capture that can produce blank pages in iOS Safari.
 // The report dialog sits in the browser top layer, above the capture stage.
 stage.style.position='fixed';
 stage.style.left='0';
 stage.style.top='0';
 stage.style.width='8.5in';
 stage.style.padding='0.35in';
 stage.style.background='#fff';
 stage.style.zIndex='0';
 stage.style.pointerEvents='none';
 stage.appendChild(clone);
 document.body.appendChild(stage);

 try{
   await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));

   const safeName=String(title||'Narcotic Audit Report')
     .replace(/[\\/:*?"<>|]+/g,'-')
     .replace(/\s+/g,' ')
     .trim()||'Narcotic Audit Report';

   const pageCapacityPx=9.72*96;
   const sectionStartPages=new Set([1]);
   if(isMonthlyPacket){
     let startPage=1;
     const packet=[...clone.children];
     packet.forEach((pageEl,index)=>{
       if(index===0){
         sectionStartPages.add(1);
         startPage=1+Math.max(1,Math.ceil((pageEl.getBoundingClientRect().height||pageCapacityPx)/pageCapacityPx));
         return;
       }
       sectionStartPages.add(startPage);
       const span=Math.max(1,Math.ceil((pageEl.getBoundingClientRect().height||1)/pageCapacityPx));
       startPage+=span;
     });
   }

   const worker=window.html2pdf()
     .set({
       margin:[0.35,0.35,0.52,0.35],
       filename:safeName+'.pdf',
       image:{type:'jpeg',quality:0.98},
       html2canvas:{
         scale:1.6,
         useCORS:true,
         backgroundColor:'#ffffff',
         logging:false,
         scrollX:0,
         scrollY:0
       },
       jsPDF:{unit:'in',format:'letter',orientation:'portrait'},
       pagebreak:{
         mode:['css','legacy'],
         // Front cover is page 1 already. Never insert a blank lead page.
         before:['.pdf-packet-page:not(.pdf-front-page)','.pdf-page-start'],
         avoid:[
           '.pdf-certifications-secondary-wrap',
           '.report-final-signature',
           '.report-vial-summary',
           '.report-vial-row',
           '.report-meta-grid',
           '.report-top'
         ]
       }
     })
     .from(clone)
     .toPdf();

   const pdf=await worker.get('pdf');
   const totalPages=pdf.internal.getNumberOfPages();
   const isAnnual=/annual summary/i.test(title);
   const isMonthlySummary=/monthly summary/i.test(title);
   const isTest=/^TEST\b/i.test(title);
   const footerTitle=(isTest?'TEST - ':'')+
     (isAnnual
       ?'Gladstone Fire Department - Narcotic Inventory / Audit Annual Summary'
       :isMonthlySummary
         ?'Gladstone Fire Department - Narcotic Inventory / Audit Monthly Summary'
         :'Gladstone Fire Department - Narcotic Inventory / Audit Report');

   for(let page=1;page<=totalPages;page++){
     pdf.setPage(page);
     if(page===1&&isMonthlyPacket)continue;

     if(isMonthlyPacket&&page>1){
       if(runningHeaderLogoData){
         try{pdf.addImage(runningHeaderLogoData,'JPEG',0.35,0.09,0.11,0.11);}catch(err){}
       }
       pdf.setFont('helvetica','bold');
       pdf.setTextColor(18,58,90);
       pdf.setFontSize(6.8);
       pdf.text('GLADSTONE FIRE DEPARTMENT · NARCOTIC INVENTORY / AUDIT REPORT',0.62,0.13);
       pdf.setFont('helvetica','normal');
       pdf.setTextColor(74,94,108);
       pdf.setFontSize(5.8);
       if(packetMonth)pdf.text(packetMonth,0.62,0.23);
       if(packetDateRange)pdf.text(packetDateRange,8.15,0.18,{align:'right'});
       pdf.setDrawColor(217,227,234);
       pdf.setLineWidth(0.006);
       pdf.line(0.35,0.31,8.15,0.31);
     }

     const y=10.78;
     pdf.setDrawColor(217,227,234);
     pdf.setLineWidth(0.006);
     pdf.line(0.35,10.62,8.15,10.62);

     pdf.setFont('helvetica','normal');
     pdf.setTextColor(74,94,108);
     pdf.setFontSize(7.2);
     pdf.text(footerTitle,0.35,y);
     pdf.text('Page '+page+' of '+totalPages,8.15,y,{align:'right'});

     if(isMonthlyPacket&&page>1&&!sectionStartPages.has(page)){
       pdf.setFont('helvetica','bold');
       pdf.setTextColor(31,96,142);
       pdf.setFontSize(7);
       pdf.text('CONTINUED',4.25,y,{align:'center'});
     }
   }

   const baseBlob=pdf.output('blob');
   const blob=await appendSupportingPdfs(baseBlob,preview?._packetSupportingDocuments||[]);
   return {
     blob,
     file:new File([blob],safeName+'.pdf',{type:'application/pdf'}),
     safeName
   };
 }finally{
   stage.remove();
 }
}

async function previewRenderedReportPdf(preview,title){
 const btn=document.getElementById('previewPdfReport');
 const original=btn?.textContent||'Generate PDF Preview';
 let url='';
 try{
   if(btn){btn.disabled=true;btn.textContent='Generating Preview…';}
   const result=await generateRenderedReportPdf(preview,title);
   const d=document.getElementById('pdfPreviewDialog');
   const frame=document.getElementById('pdfPreviewFrame');
   const pages=document.getElementById('pdfPreviewPages');
   const name=document.getElementById('pdfPreviewTitle');
   const openLink=document.getElementById('openPdfPreview');
   const shareBtn=document.getElementById('savePdfPreview');
   if(!d||!frame||!pages)throw new Error('PDF preview window is unavailable.');
   if(name)name.textContent=result.safeName+'.pdf';
   // Always expose the actual generated file as a fallback. A PDF can be
   // valid even when a device's inline browser viewer refuses to display it.
   url=URL.createObjectURL(result.blob);
   d.dataset.objectUrl=url;
   if(openLink){openLink.href=url;openLink.removeAttribute('download');openLink.hidden=false;}
   if(shareBtn){
     shareBtn.hidden=false;
     shareBtn.onclick=async()=>{
       try{
         if(await sharePdfFile(result.file,title))return;
         const link=document.createElement('a');
         link.href=url;link.download=result.file.name;
         document.body.appendChild(link);link.click();link.remove();
       }catch(err){console.error('PDF share failed',err);alert('Unable to share the PDF. Try Open PDF instead.');}
     };
   }
   const mobile=window.matchMedia('(max-width:700px)').matches;
   if(mobile){
     frame.hidden=true;
     frame.removeAttribute('src');
     pages.hidden=false;
     pages.innerHTML='<div class="pdf-preview-loading">Preparing PDF pages…</div>';
   }else{
     pages.hidden=true;
     pages.innerHTML='';
     frame.hidden=false;
     frame.src=url;
   }
   // Open the dialog BEFORE rendering PDF.js canvases. Rendering may take
   // time on iPhones; the user should never stare at an empty report window.
   if(!d.open)d.showModal();
   if(mobile){
     let readerReady=false;
     try{await ensurePdfReader();readerReady=!!window.pdfjsLib;}catch(error){
       console.warn('Inline PDF renderer unavailable',error);
     }
     if(!d.open)return;
     if(!readerReady){
       pages.innerHTML='<div class="pdf-preview-loading">Inline preview unavailable on this device. Use Open PDF or Share / Save above.</div>';
       return;
     }
     try{
       const bytes=new Uint8Array(await result.blob.arrayBuffer());
       const pdf=await window.pdfjsLib.getDocument({data:bytes}).promise;
       if(!pdf.numPages)throw new Error('Generated PDF contains no pages.');
       pages.innerHTML='';
       const targetWidth=Math.max(280,Math.min(window.innerWidth-16,760));
       for(let pageNum=1;pageNum<=pdf.numPages;pageNum++){
         if(!d.open)return; // The preview was closed during rendering.
         const page=await pdf.getPage(pageNum);
         const base=page.getViewport({scale:1});
         const viewport=page.getViewport({scale:targetWidth/base.width});
         const wrap=document.createElement('div');
         wrap.className='pdf-preview-page';
         const canvas=document.createElement('canvas');
         // Lower-resolution canvas avoids out-of-memory blank previews in
         // iOS Safari when a monthly packet contains many pages.
         const ratio=Math.min(window.devicePixelRatio||1,1.4);
         canvas.width=Math.floor(viewport.width*ratio);
         canvas.height=Math.floor(viewport.height*ratio);
         canvas.style.width=viewport.width+'px';
         canvas.style.height=viewport.height+'px';
         wrap.appendChild(canvas);
         pages.appendChild(wrap);
         await page.render({canvasContext:canvas.getContext('2d'),viewport,
           transform:ratio!==1?[ratio,0,0,ratio,0,0]:null}).promise;
         if(page.cleanup)page.cleanup();
         if(pageNum===1)pages.scrollTop=0;
         // Allow a frame for the rendered canvas to become visible.
         if(pageNum%3===0)await new Promise(resolve=>requestAnimationFrame(resolve));
       }
     }catch(err){
       console.error('Inline PDF rendering failed',err);
       pages.innerHTML='<div class="pdf-preview-loading">The inline preview could not render. The PDF is ready: use Open PDF or Share / Save above.</div>';
     }
   }
 }catch(err){
   if(url)URL.revokeObjectURL(url);
   console.error('PDF generation failed',err);
   alert('Unable to generate the PDF preview: '+(err?.message||'Please try again.'));
 }finally{
   if(btn){btn.disabled=false;btn.textContent=original;}
 }
}
async function shareRenderedReport(preview,title='Narcotic Inventory Audit Report'){
 const shareBtn=document.getElementById('shareReport');
 const originalLabel=shareBtn?.textContent||'Share PDF';
 try{
   if(shareBtn){shareBtn.disabled=true;shareBtn.textContent='Generating PDF…';}
   const result=await generateRenderedReportPdf(preview,title);
   if(await sharePdfFile(result.file,title))return;

   const url=URL.createObjectURL(result.blob);
   const a=document.createElement('a');
   a.href=url;a.download=result.file.name;document.body.appendChild(a);a.click();a.remove();
   setTimeout(()=>URL.revokeObjectURL(url),1500);
   alert('This browser cannot open the native share sheet for files, so the PDF was saved instead.');
 }catch(err){
   if(err?.name==='AbortError')return;
   alert('Unable to generate the PDF for sharing. Please try again.');
   console.error(err);
 }finally{
   if(shareBtn){shareBtn.disabled=false;shareBtn.textContent=originalLabel;}
 }
}

async function showTestReport(){
 const r=buildTestAuditReport();
 const d=document.getElementById('reportDialog'),preview=document.getElementById('reportPreview');
 if(d.open)d.close();
 preview.innerHTML='<div class="report-loading">Opening test report…</div>';
 d.showModal();document.body.classList.add('report-open');
 try{
   preview.innerHTML=reportHtml(r);
   const sheet=preview.querySelector('.report-sheet');
   if(sheet)sheet.insertAdjacentHTML('afterbegin','<div class="test-report-banner">TEST REPORT · SYNTHETIC DATA · NOT AN OFFICIAL CONTROLLED-SUBSTANCE RECORD</div>');
   const close=document.getElementById('closeReport'),pdfPreview=document.getElementById('previewPdfReport'),share=document.getElementById('shareReport'),print=document.getElementById('printReport');
   const shareTitle='TEST — Gladstone FD Narcotic Inventory Audit Report — '+(r.month||'Test Month')+' — '+reportShareDate(r.auditDate||r.finalizedAt);
   if(close)close.onclick=()=>d.close();
   if(pdfPreview)pdfPreview.onclick=()=>previewRenderedReportPdf(preview,shareTitle);
   if(share)share.onclick=()=>shareRenderedReport(preview,shareTitle);
   if(print)print.onclick=()=>shareRenderedReport(preview,shareTitle);
 }catch(err){
   preview.innerHTML='<div class="report-loading"><b>Unable to render the test report.</b><br><span>'+esc(err?.message||String(err))+'</span></div>';
   console.error(err);
 }
 d.onclose=()=>{document.body.classList.remove('report-open');preview.innerHTML=''};
}
async function showReport(id){
 const r=await getOne('reports',id);
 if(!r){alert('This finalized report could not be loaded. Refresh Reports and try again.');return;}
 const d=document.getElementById('reportDialog'),preview=document.getElementById('reportPreview');
 if(d.open)d.close();
 preview.innerHTML='<div class="report-loading">Opening finalized audit…</div>';
 d.showModal();
 document.body.classList.add('report-open');
 try{
   const b=reportHtml(r);
   preview.innerHTML=b;
   preview._packetSupportingDocuments=uniqueSupportingDocuments(r.supportingDocuments||[]);
   d.scrollTop=0;
   const close=document.getElementById('closeReport'),pdfPreview=document.getElementById('previewPdfReport'),share=document.getElementById('shareReport'),print=document.getElementById('printReport');
   const shareTitle='Gladstone FD Narcotic Inventory Audit Report — '+(r.month||'Monthly')+' — '+reportShareDate(r.auditDate||r.finalizedAt);
   if(close)close.onclick=()=>d.close();
   if(pdfPreview)pdfPreview.onclick=()=>previewRenderedReportPdf(preview,shareTitle);
   if(share)share.onclick=()=>shareRenderedReport(preview,shareTitle);
   if(print)print.onclick=()=>shareRenderedReport(preview,shareTitle);
   requestAnimationFrame(()=>{d.scrollTop=0;preview.scrollTop=0});
 }catch(err){
   preview.innerHTML='<div class="report-loading">Unable to render this report. Close and try again.</div>';
   console.error(err);
 }
 d.onclose=()=>{document.body.classList.remove('report-open');preview.innerHTML='';setTimeout(refreshAll,0)};
}
function reportCoverPageHtml(r){
 const auditDate=reportShareDate(r.auditDate||r.finalizedAt);
 const finalized=reportShareDate(r.finalizedAt||r.auditDate);
 const auditor=r.attestationName||r.auditorName||'';
 return '<section class="report-cover-page">'+
   '<div class="report-cover-brand"><img src="gfd-patch.jpg" alt="Gladstone Fire Department patch">'+
   '<div class="report-cover-dept">GLADSTONE FIRE DEPARTMENT</div></div>'+
   '<div class="report-cover-main"><div class="report-cover-kicker">CONTROLLED-SUBSTANCE AUDIT</div>'+
   '<h1>Narcotic Inventory / Audit Report</h1>'+
   '<div class="report-cover-month">'+esc(r.month||'Monthly Audit')+'</div>'+
   (r.isTest?'<div class="report-cover-test">TEST REPORT · SYNTHETIC DATA</div>':'')+
   '</div>'+
   '<div class="report-cover-meta balanced-cover-meta" style="display:grid;grid-template-columns:1fr 1.4fr 1fr;gap:18px 24px;border:0;border-radius:0;overflow:visible;background:transparent;padding:0;">'+
   '<div class="cover-meta-cell" style="border:0;background:transparent;text-align:center;align-items:center;justify-content:center;padding:8px 10px;"><span style="text-align:center;width:100%;">Audit date</span><strong style="text-align:center;width:100%;">'+esc(auditDate||'—')+'</strong></div>'+
   '<div class="cover-meta-cell" style="border:0;background:transparent;text-align:center;align-items:center;justify-content:center;padding:8px 10px;"><span style="text-align:center;width:100%;">Audit date range</span><strong style="text-align:center;width:100%;">'+esc(formatDisplayDate(r.dateRangeStart)||'—')+' through '+esc(formatDisplayDate(r.dateRangeEnd)||'—')+'</strong></div>'+
   '<div class="cover-meta-cell" style="border:0;background:transparent;text-align:center;align-items:center;justify-content:center;padding:8px 10px;"><span style="text-align:center;width:100%;">Finalized date</span><strong style="text-align:center;width:100%;">'+esc(finalized||'—')+'</strong></div>'+
   '<div class="cover-auditor-row" style="grid-column:1/-1;display:grid;grid-template-columns:1fr 180px 1fr;align-items:center;gap:22px;margin-top:10px;">'+
     '<div style="text-align:center;"><span style="display:block;text-align:center;">Certifying auditor</span><strong style="display:block;text-align:center;">'+esc(auditor||'—')+'</strong></div>'+
     '<div class="cover-auditor-signature" style="text-align:center;border:0;background:transparent;margin:0;padding:0;">'+
       (r.attestationSignature?'<img src="'+r.attestationSignature+'" alt="Final certifying auditor signature" style="display:block;max-width:170px;max-height:48px;margin:0 auto 2px;object-fit:contain;">':'<div class="report-signature-placeholder" style="width:170px;height:36px;margin:0 auto 2px;border:0;border-bottom:1px solid #aab9c4;"></div>')+
       '<small style="display:block;text-align:center;">Signature</small>'+
     '</div>'+
     '<div style="text-align:center;"><span style="display:block;text-align:center;">Employee number</span><strong style="display:block;text-align:center;">'+esc(r.attestationEmployeeNumber||r.auditorEmployeeNumber||'—')+'</strong></div>'+
   '</div>'+
   '</div>'+
   '<div class="report-cover-footer">Gladstone Fire Department · Monthly Narcotic Inventory / Audit</div>'+
   '</section>';
}

function executiveSummaryHtml(r){
 const activeLocs=['Medic 1','Medic 2','Medic 3','Safe'];
 const isActiveLoc=l=>activeLocs.includes(String(l||''));
 const medRows=MEDS.map(m=>{
   const current=activeLocs.reduce((n,l)=>n+Number(r.counts?.[l]?.[m]||0),0);
   const priorValues=activeLocs.map(l=>r.priorCounts?.[l]?.[m]);
   const priorKnown=priorValues.every(v=>v!==null&&v!==undefined&&v!=='');
   const prior=priorKnown?priorValues.reduce((n,v)=>n+Number(v||0),0):null;
   return {m,current,prior,diff:priorKnown?current-prior:null};
 });
 const changed=medRows.filter(x=>x.diff!==null&&x.diff!==0);
 const comparisonsKnown=medRows.every(x=>x.diff!==null);

 const adminRows=Array.isArray(r.administrationRows)?r.administrationRows:[];
 const txs=Array.isArray(r.transactions)?r.transactions:[];
 let vialData=null;
 try{vialData=adminRows.length?providerVialData(adminRows,r.vialOverrides||{}):null}catch(e){vialData=null}
 const vialTotal=vialData?.total??null;

 function medBaseName(label=''){
   const s=String(label);
   if(/^Fentanyl/i.test(s))return 'Fentanyl';
   if(/^Versed/i.test(s))return 'Versed';
   if(/^Ketamine/i.test(s))return 'Ketamine';
   if(/^Morphine/i.test(s))return 'Morphine';
   return s;
 }
 function administeredVialsFor(med){
   if(!vialData)return 0;
   const base=medBaseName(med);
   let total=0;
   for(const [,items] of vialData.providers||[]){
     for(const item of items||[]){
       if(medBaseName(item.medication)!==base)continue;
       if(item.pending)return null;
       // A Versed vial belongs to ONE strength category, never both.
       if(base==='Versed')total+=/2 mg/i.test(med)?Number(item.vial2||0):Number(item.vial5||0);
       else total+=Number(item.vials||0);
     }
   }
   return total;
 }
 function reasonsForChange(med,diff){
   const base=medBaseName(med);
   const reasons=[];
   let received=0,expired=0,destroyed=0,waste=0,transferIn=0,transferOut=0,adjustUp=0,adjustDown=0;

   for(const t of txs){
     if(medBaseName(t.medication)!==base)continue;
     const q=Math.abs(Number(t.quantity||0));
     if(!q)continue;
     const type=String(t.type||t.action||'').toLowerCase();
     const from=String(t.fromLocation||'');
     const to=String(t.toLocation||'');

     if(type==='received'||type.includes('restock'))received+=q;
     else if(type==='expired'||type.includes('expire'))expired+=q;
     else if(type==='destroyed'||type.includes('destroy'))destroyed+=q;
     else if(type==='waste'||type.includes('waste'))waste+=q;
     else if(type==='transfer'||type.includes('transfer')){
       if(!isActiveLoc(from)&&isActiveLoc(to))transferIn+=q;
       else if(isActiveLoc(from)&&!isActiveLoc(to))transferOut+=q;
     }else if(type==='adjustment'||type.includes('adjust')){
       const signed=Number(t.quantity||0);
       if(signed>0)adjustUp+=Math.abs(signed);
       else if(signed<0)adjustDown+=Math.abs(signed);
     }
   }

   if(diff<0){
     const administered=administeredVialsFor(med);
     if(administered)reasons.push(administered+' vial'+(administered===1?'':'s')+' administered');
     if(expired)reasons.push(expired+' vial'+(expired===1?'':'s')+' moved to expired');
     if(destroyed)reasons.push(destroyed+' vial'+(destroyed===1?'':'s')+' destroyed/transferred out');
     if(waste)reasons.push(waste+' vial'+(waste===1?'':'s')+' documented as waste');
     if(transferOut)reasons.push(transferOut+' vial'+(transferOut===1?'':'s')+' transferred out of active stock');
     if(adjustDown)reasons.push(adjustDown+' vial'+(adjustDown===1?'':'s')+' removed by adjustment');
   }else if(diff>0){
     if(received)reasons.push(received+' vial'+(received===1?'':'s')+' received/restocked');
     if(transferIn)reasons.push(transferIn+' vial'+(transferIn===1?'':'s')+' transferred into active stock');
     if(adjustUp)reasons.push(adjustUp+' vial'+(adjustUp===1?'':'s')+' added by adjustment');
   }
   return reasons;
 }

 let inventorySentence='';
 if(changed.length){
   const parts=[];
   let missingReason=false;
   for(const x of changed){
     const amount=Math.abs(x.diff);
     const direction=x.diff>0?'increased':'decreased';
     const reasons=reasonsForChange(x.m,x.diff);
     parts.push(medicationDisplayName(x.m)+' '+direction+' by '+amount+' vial'+(amount===1?'':'s')+(reasons.length?' ('+reasons.join('; ')+')':''));
     if(!reasons.length)missingReason=true;
   }
   inventorySentence='The physical inventory changed from the prior audit: '+parts.join('; ')+'.'+(missingReason?' No specific reason was documented for one or more of these inventory changes.':'');
 }else if(comparisonsKnown){
   inventorySentence='The active physical inventory did not show a net change from the prior audit.';
 }else{
   inventorySentence='A full comparison with the prior audit was not available for every medication.';
 }

 let usageSentence='';
 if(adminRows.length){
   usageSentence=' The imported administration record shows '+adminRows.length+' dose entr'+(adminRows.length===1?'y':'ies')+
     (vialTotal!==null?', which calculates to '+vialTotal+' vial'+(vialTotal===1?'':'s')+' used':'')+'.';
 }else{
   usageSentence=' No administration records were available in this report for vial-use calculation.';
 }

 const amendmentCount=Array.isArray(r.amendments)?r.amendments.length:0;
 const certComplete=LOCS.every(loc=>{
   const x=r.signatures?.[loc]||{};
   return !!(x.signer&&x.employeeNumber&&x.witness&&x.witnessEmployeeNumber&&x.signature&&x.witnessSignature);
 });
 const certSentence=certComplete
   ?' All audit locations were fully certified by the auditor and witness.'
   :' One or more audit locations were missing complete Certification information.';
 const amendmentSentence=amendmentCount
   ?' '+amendmentCount+' amendment'+(amendmentCount===1?' was':'s were')+' recorded after the original audit entry.'
   :' No amendments were recorded.';

 return '<section class="report-executive-summary simple-summary paragraph-summary pdf-executive-page">'+
 '<h2>Audit Summary</h2>'+
 '<p>'+esc(inventorySentence+usageSentence+certSentence+amendmentSentence)+'</p>'+
 '</section>';
}

function newReportFrontMatterHtml(r){
 let cover='';
 try{cover=reportCoverPageHtml(r)}catch(err){console.error('Report cover failed',err)}
 return cover;
}
function isInitialImplementationAudit(r){
 const month=String(r?.month||'').trim().toLowerCase();
 if(month==='august 2026')return true;
 const raw=String(r?.auditDate||r?.finalizedAt||r?.createdAt||'');
 return /^2026-08(?:-|T|$)/.test(raw);
}
function initialImplementationExplainerHtml(r){
 if(!isInitialImplementationAudit(r))return '';
 return '<div class="report-implementation-note"><strong>Implementation note — August 2026:</strong> This was the first audit completed in this application. Because the application was implemented after prior audit activity had already occurred, it could not reliably reconstruct or account for audits and inventory counts completed before implementation. Prior-audit comparison values may therefore be unavailable or incomplete in this report. This August 2026 audit establishes the application baseline for subsequent monthly comparisons.</div>';
}
function newReportSummaryHtml(r){
 try{
   const summary=executiveSummaryHtml(r);
   const note=initialImplementationExplainerHtml(r);
   return note?summary.replace('</section>',note+'</section>'):summary;
 }catch(err){
   console.error('Executive summary failed',err);
   return '<section class="report-executive-summary simple-summary paragraph-summary pdf-executive-page"><h2>Audit Summary</h2><p>The summary could not be calculated from this preview. The detailed audit sections below remain available and unchanged.</p>'+initialImplementationExplainerHtml(r)+'</section>';
 }
}

function reportHtml(r){
 const logo='gfd-patch.jpg';
 const recordNo=r.legacyRecordNumber||String(r.auditId||r.id||'').match(/\d+/)?.[0]||'';
 const activeTotal=m=>['Medic 1','Medic 2','Medic 3','Safe'].reduce((n,l)=>n+Number(r.counts?.[l]?.[m]||0),0);
 const amendment=(r.amendments||[]).map(a=>'<div class="report-amendment-row"><b>'+esc(a.location)+' · '+esc(a.medication)+':</b> '+esc(a.from)+' → '+esc(a.to)+' '+esc(a.unit||'')+'. '+esc(a.reason||'')+(a.recordedAt?' Recorded '+esc(formatDisplayDate(a.recordedAt)):'')+(a.recordedBy?' by '+esc(a.recordedBy):'')+'.</div>').join('');
 const tagRows=LOCS.map(l=>{const t=r.breakawayTags?.[l]||{};return '<tr><td>'+esc(l)+'</td><td>'+esc(t.foundRemoved||'—')+'</td><td><b>'+esc(t.newInstalled||'—')+'</b></td></tr>'}).join('');
 const txs=Array.isArray(r.transactions)?r.transactions:[];
 const txRows=txs.length?txs.map(t=>{
   const docs=[t.supportingDocument?.name,t.destructionReceipt?.name].filter(Boolean).join(' · ');
   const impact=Array.isArray(t.inventoryImpact)?t.inventoryImpact.map(x=>x.location+' '+x.medication+': '+x.before+' → '+x.after).join(' · '):'';
   const detail=t.destructionCompany||t.sourcePharmacy||t.notes||t.reference||t.vendor||t.incident||t.lot||'';
   return '<tr><td>'+esc(formatDisplayDate(t.date||t.timestamp)||'')+'</td><td>'+esc(t.typeLabel||t.type||t.action||'')+'</td><td>'+esc(t.medication||'')+'</td><td>'+esc(t.quantity||'')+'</td><td>'+esc((t.fromLocation||'')+(t.toLocation?' → '+t.toLocation:''))+(impact?'<br><small>'+esc(impact)+'</small>':'')+'</td><td>'+esc(detail)+(docs?'<br><small>'+esc(docs)+'</small>':'')+'</td></tr>';
 }).join(''):'<tr><td colspan="6" class="report-empty">No transactions recorded during this month.</td></tr>';
 const sigCard=(loc)=>{
   const x=r.signatures?.[loc]||{};
   const explicit=r.isTest;
   return '<section class="report-cert'+(explicit?' report-cert-explicit':'')+'"><h2>'+esc(loc)+' Certification</h2>'+
   (explicit?'<div class="report-cert-site"><span>AUDIT SITE</span><strong>'+esc(loc)+'</strong></div><p class="report-cert-statement">These signatures certify the <b>'+esc(loc)+'</b> physical inventory count and seal record documented in this audit.</p>':'<p>Auditor: physical count and seal entries certified. Witness: personally observed and verified this count and seal record.</p>')+
   '<div class="report-signature-grid"><div class="report-signature-box">'+
   (explicit?'<div class="report-signature-site">'+esc(loc)+' — Auditor Certification</div>':'')+
   '<div class="report-signature-label">AUDITOR SIGNATURE</div>'+(x.signature?'<img src="'+x.signature+'" alt="'+esc(loc)+' auditor signature">':'<div class="report-signature-placeholder"></div>')+'<div class="report-signature-name">'+esc(x.signer||'')+(x.employeeNumber?' · Employee #'+esc(x.employeeNumber):'')+'</div></div><div class="report-signature-box">'+
   (explicit?'<div class="report-signature-site">'+esc(loc)+' — Witness Certification</div>':'')+
   '<div class="report-signature-label">WITNESS SIGNATURE</div>'+(x.witnessSignature?'<img src="'+x.witnessSignature+'" alt="'+esc(loc)+' witness signature">':'<div class="report-signature-placeholder"></div>')+'<div class="report-signature-name">'+esc(x.witness||'')+(x.witnessEmployeeNumber?' · Employee #'+esc(x.witnessEmployeeNumber):'')+'</div></div></div></section>';
 };
 const sourceDoc=(r.supportingDocuments||[])[0];
 return '<div class="report-sheet report-finalized">'+
 '<div class="report-toolbar"><button id="closeReport">Close</button><button id="previewPdfReport">Generate PDF Preview</button><button id="shareReport">Share PDF</button><button id="printReport" class="primary">Print / Save PDF</button></div>'+
 ((r.isTest||!r.legacyRecordNumber)?newReportFrontMatterHtml(r):'')+
 '<header class="report-top"><img src="'+logo+'" alt="Gladstone Fire Department patch"><div><div class="report-kicker">FINALIZED MONTHLY RECORD</div><h1>Gladstone Fire Department Narcotic<br>Inventory / Audit Form</h1></div></header>'+
 '<div class="report-meta-grid"><div><b>Audit month:</b> '+esc(r.month||'')+'</div><div><b>Created:</b> '+esc(formatDisplayDate(r.createdDisplay||r.createdAt)||'')+'</div><div><b>Email:</b> '+esc(r.email||'travisw@gladstone.mo.us')+'</div><div></div><div><b>Date of audit:</b> '+esc(formatDisplayDate(r.auditDate)||'')+'</div><div></div><div class="wide"><b>Audit period:</b> '+esc(formatDisplayDate(r.dateRangeStart)||'—')+' through '+esc(formatDisplayDate(r.dateRangeEnd)||'—')+' (both dates included)</div></div>'+
 '<hr class="report-blue-rule">'+
 reportingMonthCorrectionHtml(r)+
 ((r.isTest||!r.legacyRecordNumber)?newReportSummaryHtml(r):'')+
 (amendment?'<section class="report-amendment"><h2>Amended inventory record — correction history</h2><p>The table below includes these corrections. Signatures were recorded before these amendments and certify the original record, not the corrected entries.</p>'+amendment+'</section>':'')+
 '<section><h2>Inventory comparison</h2><table class="report-table report-inventory"><thead><tr><th>Medication</th>'+LOCS.map(l=>'<th>'+esc(l)+'<small>Last / Current</small></th>').join('')+'<th>Active total</th></tr></thead><tbody>'+MEDS.map(m=>'<tr><td>'+medicationDisplayHtml(m)+'</td>'+LOCS.map(l=>{const p=r.priorCounts?.[l]?.[m];return '<td>'+(p==null?'—':Number(p))+' / <b>'+Number(r.counts?.[l]?.[m]||0)+'</b></td>'}).join('')+'<td><b>'+activeTotal(m)+'</b></td></tr>').join('')+'</tbody></table></section>'+
 '<section><h2>Breakaway tag record</h2><table class="report-table"><thead><tr><th>Location</th><th>Tag found / removed</th><th>New tag installed</th></tr></thead><tbody>'+tagRows+'</tbody></table></section>'+
 (Array.isArray(r.inventoryFindings)&&r.inventoryFindings.length?'<section class="report-audit-findings"><h2>Expired / damaged medications found during audit</h2><p class="report-note">These items were identified during the physical audit. Retained items were moved from the source location into Expired inventory; damaged vials that could not be physically retained were removed from the source count and documented without increasing the Expired physical count. No separate inventory transaction was created.</p><table class="report-table"><thead><tr><th>Date</th><th>Finding</th><th>Source</th><th>Medication</th><th>Qty</th><th>Notes</th></tr></thead><tbody>'+r.inventoryFindings.map(x=>'<tr><td>'+esc(formatDisplayDate(x.recordedAt)||'')+'</td><td>'+esc(x.typeLabel||x.type||'')+'</td><td>'+esc(x.sourceLocation||'')+' → '+esc(x.destinationLocation||'Expired')+'</td><td>'+medicationDisplayHtml(x.medication||'')+'</td><td>'+esc(x.quantity||'')+'</td><td>'+esc((x.physicalRetained===false?'No physical vial retained. ':'')+(x.note||''))+'</td></tr>').join('')+'</tbody></table></section>':'')+
 '<section class="report-eso-source"><h2>ESO Narcotic Administration Record</h2><p>Administration activity was imported from the ESO software PDF for this audit period. Physical inventory totals remain based on the manually verified count.</p>'+(sourceDoc?'<p><b>Imported ESO PDF:</b> <u>'+esc(sourceDoc.name)+'</u> — imported '+esc(formatDisplayDate(sourceDoc.uploadedAt)||'')+(sourceDoc.uploadedBy?' by '+esc(sourceDoc.uploadedBy):'')+'</p>':'')+'<p class="report-note">The imported record and calculated vial-use reconciliation are included below.</p></section>'+
 (r.isTest&&Array.isArray(r.administrationRows)&&r.administrationRows.length?
 '<section class="report-imported-admin"><h2>Administration Detail</h2><p class="report-note">Source doses are preserved as imported. Calculated vial use is derived separately using department vial rules.</p>'+
 '<table class="report-table"><thead><tr><th>Date</th><th>Report</th><th>Provider</th><th>Medication</th><th>Dose</th><th>Unit</th></tr></thead><tbody>'+
 r.administrationRows.map(x=>'<tr><td>'+esc(formatAdminDate(x.date))+'</td><td>'+esc(x.report)+'</td><td>'+esc(x.provider)+'</td><td>'+medicationDisplayHtml(x.medication)+'</td><td><b>'+esc(x.dose)+' '+esc(adminDoseUnit(x.medication))+'</b></td><td>'+esc(String(x.unit||'').replace(/^M([123])$/,'Medic $1'))+'</td></tr>').join('')+
 '</tbody></table>'+
 '<div class="report-usage-summary report-vial-summary pdf-vial-section"><div class="report-vial-summary-title">Calculated Vial Use</div><p class="report-vial-explainer">Calculated vial use converts the imported ESO administration doses into whole-vial usage using the department vial-size rules. This reconciliation reference does not change the manually verified physical inventory count.</p>'+
 providerVialData(r.administrationRows,r.vialOverrides||{}).providers.map(([provider,items])=>{
   const pending=items.some(item=>item.pending);
   const total=pending?null:items.reduce((n,x)=>n+x.vials,0);
   const breakdown=new Map();
   const add=(med,strength,count)=>{
     if(!count)return;
     const key=med+'|'+strength;
     breakdown.set(key,(breakdown.get(key)||0)+count);
   };
   for(const x of items){
     if(x.pending){add(x.medication,'Pending confirmation',1);continue;}
     if(x.medication==='Versed'){add('Versed','2 mg',x.vial2);add('Versed','5 mg',x.vial5);}
     else add(x.medication,x.strength,x.vials);
   }
   const detail=[...breakdown.entries()].map(([key,n])=>{
     const [med,strength]=key.split('|');
     return strength==='Pending confirmation'?esc(med)+' — pending vial confirmation':
       esc(med)+' — '+n+' × '+esc(versedStrengthDisplayText(med,strength))+' vial'+(n===1?'':'s');
   }).join('<br>');
   return '<div class="report-vial-row report-vial-row-detailed"><div class="report-vial-provider"><strong>'+esc(provider)+'</strong><span>'+detail+'</span></div><div class="report-vial-count">'+(total===null?'Pending':total+' vial'+(total===1?'':'s'))+'</div></div>';
 }).join('')+
 '<div class="report-vial-total"><span>Total vials administered · all providers</span><strong>'+(providerVialData(r.administrationRows,r.vialOverrides||{}).total??'Pending confirmation')+'</strong></div></div></section>':'')+'<section class="report-transactions-section"><h2>Transactions in the audit reporting period</h2><p class="report-note">This table lists recorded controlled-substance movements or adjustments during the audit period, such as receipts, transfers, waste, destruction, or other documented inventory activity. These entries provide context for inventory changes but do not replace the physical count.</p><table class="report-table report-transactions"><thead><tr><th>Date</th><th>Action</th><th>Medication</th><th>Qty</th><th>Movement</th><th>Vendor / incident / lot</th></tr></thead><tbody>'+txRows+'</tbody></table></section>'+
 '<section class="report-signature-section"><h2>Audit site Certifications</h2><div class="report-signature-section-grid">'+
 sigCard('Medic 1')+sigCard('Medic 2')+sigCard('Medic 3')+sigCard('Safe')+sigCard('Expired')+
 '</div></section>'+
 '<section class="report-attestation"><h2>Final overall controlled-substance audit attestation</h2><p>'+esc(r.attestationText||FINAL_ATTESTATION).replace(/\n/g,'<br>')+'</p><div class="report-final-signature'+(r.isTest?' report-final-signature-explicit':'')+'"><div class="report-signature-label">FINAL CERTIFYING AUDITOR SIGNATURE</div>'+(r.isTest?'<div class="report-final-signature-capture">'+(r.attestationSignature?'<img src="'+r.attestationSignature+'" alt="Final certifying auditor signature">':'<div class="report-signature-placeholder"></div>')+'</div>':(r.attestationSignature?'<img src="'+r.attestationSignature+'" alt="Final certifying auditor signature">':''))+'<div class="report-signature-name">'+esc(r.attestationName||'')+(r.attestationEmployeeNumber?' · Employee #'+esc(r.attestationEmployeeNumber):'')+'</div></div></section>'+
 (Array.isArray(r.incidents)&&r.incidents.length?'<section class="report-incidents"><h2>Discrepancies / incidents</h2>'+r.incidents.map(x=>'<div class="report-amendment-row"><b>'+esc(x.sourceLocation||'Unknown source')+'</b> · '+esc((x.items||[]).map(i=>i.medication+' × '+i.quantity).join(', '))+' · '+esc(x.explanation||'')+(x.memoDescription?' · Memo description: '+esc(x.memoDescription):'')+(x.supportingDocument?.name?' · Memo: '+esc(x.supportingDocument.name):'')+'</div>').join('')+'</section>':'')+
 '<section class="report-notes"><h2>Audit notes</h2><p class="audit-notes-text">'+esc(r.notes||'').replace(/\n/g,'<br>')+'</p>'+(r.usageSummary?'<div class="report-usage-summary">'+esc(r.usageSummary||'').replace(/\n/g,'<br>')+'</div>':'')+'</section>'+
 '<footer class="report-footer">Finalized inventory snapshot'+(recordNo?' · Record #'+esc(recordNo):'')+'</footer>'+
 '</div>';
}

async function exportBackup(){const payload={schemaVersion:2,exportedAt:nowISO(),inventory:await getAll('inventory'),transactions:await getAll('transactions'),audits:await getAll('audits'),reports:await getAll('reports'),meta:await getAll('meta'),legacyArchive:await getAll('legacyArchive')};download('narcotic-audit-backup-'+new Date().toISOString().slice(0,10)+'.json',JSON.stringify(payload,null,2),'application/json')}
async function sha256(text){const buf=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(text));return [...new Uint8Array(buf)].map(b=>b.toString(16).padStart(2,'0')).join('')}
async function importBackup(file){
 const raw=await file.text(), hash=await sha256(raw);let data;
 try{data=JSON.parse(raw)}catch(e){throw new Error('The selected file is not valid JSON.')}
 if(!data||typeof data!=='object')throw new Error('Invalid migration file.');
 await put('legacyArchive',{id:'legacy_'+Date.now(),importedAt:nowISO(),fileName:file.name||'migration.json',sha256:hash,raw});
 const imported={inventory:0,transactions:0,audits:0,reports:0,signatures:0,legacyObjects:0};

 function countSignatures(row){
   const sigs=[];
   const walk=v=>{
     if(!v||typeof v!=='object')return;
     for(const [k,x] of Object.entries(v)){
       if(typeof x==='string' && /signature/i.test(k) && (x.startsWith('data:image/')||x.length>150))sigs.push(x);
       else if(x&&typeof x==='object')walk(x);
     }
   };
   walk(row);imported.signatures+=sigs.length;
 }
 async function add(storeName,row,prefix){
   if(!row||typeof row!=='object')return;
   const copy=structuredClone(row);
   if(copy.id==null)copy.id=(prefix||storeName)+'_'+Date.now().toString(36)+'_'+Math.random().toString(36).slice(2,8);
   await put(storeName,copy);
   if(imported[storeName]!=null)imported[storeName]++;
   if(storeName==='audits'||storeName==='reports')countSignatures(copy);
 }
 function parseMaybe(v){
   if(typeof v!=='string')return v;
   const t=v.trim();
   if(!t||(!t.startsWith('{')&&!t.startsWith('[')))return v;
   try{return JSON.parse(t)}catch(e){return v}
 }
 function allObjects(root,out=[],seen=new WeakSet()){
   root=parseMaybe(root);
   if(!root||typeof root!=='object')return out;
   if(seen.has(root))return out;seen.add(root);
   if(Array.isArray(root)){root.forEach(x=>allObjects(x,out,seen));return out}
   out.push(root);
   Object.values(root).forEach(x=>allObjects(parseMaybe(x),out,seen));
   return out;
 }
 function looksInventory(r){
   const keys=Object.keys(r).join(' ').toLowerCase();
   return (r.location||r.unit||r.storageLocation) && (r.medication||r.drug||r.medicationName) && (r.quantity!=null||r.count!=null||r.balance!=null) && !/audit|signature/.test(keys);
 }
 function normalizeInventory(r){
   const location=r.location||r.unit||r.storageLocation;
   const medication=r.medication||r.drug||r.medicationName;
   const quantity=Number(r.quantity??r.count??r.balance??0);
   return {id:String(location)+'|'+String(medication),location:String(location),medication:String(medication),quantity,updatedAt:r.updatedAt||r.updated_at||r.timestamp||nowISO(),legacySource:r};
 }
 function looksAudit(r){
   const keys=Object.keys(r).join(' ').toLowerCase();
   return /audit|auditor|attestation|auditmonth|signatures/.test(keys) && (/month|counts|inventory|signature|attestation/.test(keys));
 }
 function looksTransaction(r){
   const keys=Object.keys(r).join(' ').toLowerCase();
   return /transaction|movement|waste|received|transfer|activity/.test(keys) && (r.medication||r.drug||r.type||r.action);
 }
 function looksReport(r){
   const keys=Object.keys(r).join(' ').toLowerCase();
   return /finalized|finalizedat|report|Certification/.test(keys) && /audit|signature|inventory|attestation/.test(keys);
 }

 const recognized=['inventory','transactions','audits','reports','meta','legacyArchive'];
 for(const name of recognized){
   if(Array.isArray(data[name]))for(const row of data[name])await add(name,row,name);
 }
 const roots=[data.data||{},data.db||{},data.state||{}];
 for(const root of roots){
   if(Array.isArray(root.inventory))for(const row of root.inventory)await add('inventory',row,'inventory');
   if(Array.isArray(root.transactions))for(const row of root.transactions)await add('transactions',row,'tx');
   if(Array.isArray(root.audits))for(const row of root.audits)await add('audits',row,'audit');
   if(Array.isArray(root.reports))for(const row of root.reports)await add('reports',row,'report');
 }

 // Legacy browser-storage exports: parse localStorage JSON strings and every IndexedDB store.
 const legacyRoots=[];
 if(data.localStorage&&typeof data.localStorage==='object')Object.values(data.localStorage).forEach(v=>legacyRoots.push(parseMaybe(v)));
 if(Array.isArray(data.indexedDB))for(const d of data.indexedDB)if(d?.stores)Object.values(d.stores).forEach(v=>legacyRoots.push(v));
 for(const root of legacyRoots){
   for(const r of allObjects(root)){
     imported.legacyObjects++;
     if(looksInventory(r)){await add('inventory',normalizeInventory(r),'inventory');continue}
     if(looksReport(r)){await add('reports',r,'report');continue}
     if(looksAudit(r)){await add('audits',r,'audit');continue}
     if(looksTransaction(r)){await add('transactions',r,'tx');continue}
   }
 }

 const importedActive=await getOne('meta','activeAudit');
 if(importedActive?.auditId){
   const importedAudit=await getOne('audits',importedActive.auditId);
   if(!importedAudit||String(importedAudit.status||'').toLowerCase()!=='draft')await del('meta','activeAudit');
 }
 await put('meta',{id:'migration',importedAt:nowISO(),sourceExportedAt:data.exportedAt||'',schemaVersion:data.schemaVersion||data.exportType||'legacy-browser-storage',sourceFile:file.name||'',sha256:hash,counts:imported,validationRequired:true});
 await refreshAll();
 document.getElementById('migrationStatus').textContent='Migration source archived intact. SHA-256 '+hash.slice(0,16)+'… · mapped '+imported.inventory+' inventory rows · '+imported.transactions+' activity rows · '+imported.audits+' audits · '+imported.reports+' reports · '+imported.signatures+' signature payloads. Original source remains retained for reconciliation.';
}
function download(name,text,type){const a=document.createElement('a');a.href=URL.createObjectURL(new Blob([text],{type}));a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(a.href),1000)}
async function exportActivity(){let rows=await getAll('transactions');const cols=['timestamp','type','medication','quantity','fromLocation','toLocation','reference','recordedBy','witness','notes'];const csv=[cols.join(','),...rows.map(r=>cols.map(c=>'"'+String(r[c]??'').replace(/"/g,'""')+'"').join(','))].join('\n');download('narcotic-activity.csv',csv,'text/csv')}

async function renderStats(){const [tx,aud,rep,arc]=await Promise.all(['transactions','audits','reports','legacyArchive'].map(getAll));document.getElementById('storageStats').innerHTML=[['Activity entries',tx.length],['Audit drafts',aud.filter(x=>x.status!=='finalized').length],['Finalized reports',rep.length],['Migration archives',arc.length]].map(x=>'<div class="stat"><strong>'+x[1]+'</strong>'+x[0]+'</div>').join('');const m=await getOne('meta','migration');if(m)document.getElementById('migrationStatus').textContent='Last migration import: '+fmtDate(m.importedAt)}
async function refreshAll(){await Promise.all([renderInventory(),renderActivity(),renderAudits(),renderReports(),renderStats()])}
function txMedicationRowHtml(med='',qty=''){
 const options=MEDS.map(x=>'<option value="'+esc(x)+'" '+(x===med?'selected':'')+'>'+esc(medicationDisplayName(x))+'</option>').join('');
 return '<div class="tx-med-row"><label>Medication<select name="txMedication" required>'+options+'</select></label><label>Quantity<input name="txQuantity" type="number" step="1" min="1" inputmode="numeric" data-integer-only required value="'+esc(qty)+'"></label><button type="button" class="remove-tx-med">Remove</button></div>';
}
function addTxMedicationRow(med='',qty=''){
 const host=document.getElementById('txMedicationRows');
 if(host)host.insertAdjacentHTML('beforeend',txMedicationRowHtml(med,qty));
}
function fillSelects(){
 ['fromLocation','toLocation'].forEach(n=>{
   const el=document.querySelector('select[name='+n+']');
   if(el)el.innerHTML='<option value="">—</option>'+LOCS.map(x=>'<option>'+x+'</option>').join('');
 });
}
function bind(){
 document.querySelectorAll('.tabs button').forEach(b=>b.onclick=async()=>{
   const leavingOpenAudit=activeAuditId&&document.getElementById('auditMonth')&&b.dataset.tab!=='audit';
   if(leavingOpenAudit){
     await flushAuditAutosave();
     activeAuditId=null;
     await put('meta',{id:'activeAudit',auditId:'',updatedAt:nowISO()});
     await renderAudits();
   }
   document.querySelectorAll('.tabs button').forEach(x=>x.classList.toggle('active',x===b));
   document.querySelectorAll('.tab-panel').forEach(x=>x.classList.toggle('active',x.id===b.dataset.tab));
   if(b.dataset.tab==='audit'&&!activeAuditId)await renderAudits();
   if(b.dataset.tab==='reports')await renderReports();
 });
 const txTypeSelect=document.querySelector('#txForm select[name=type]');
 const txPdfInput=document.getElementById('txSupportingPdf');
 const txPdfHint=document.getElementById('txSupportingPdfHint');
 const txPdfTitle=document.getElementById('txSupportingPdfTitle');
 const txPdfRequiredBadge=document.getElementById('txPdfRequiredBadge');
 const txDestructionReceiptLabel=document.getElementById('txDestructionReceiptLabel');
 const txDestructionReceipt=document.getElementById('txDestructionReceipt');
 const txMemoDescriptionLabel=document.getElementById('txMemoDescriptionLabel');
 const txMemoDescription=document.getElementById('txMemoDescription');
 const txDraftBtn=document.getElementById('saveTxDraftBtn');
 const txSubmitBtn=document.getElementById('saveTxBtn');
 const txNotesLabel=document.getElementById('txNotesLabel');
 const txNotesField=document.getElementById('txNotesField');
 const txNotes=document.getElementById('txNotes');
 const txPdfLabel=document.getElementById('txSupportingPdfLabel');
 const txFromLocationLabel=document.getElementById('txFromLocationLabel');
 const txFromLocationText=document.getElementById('txFromLocationText');
 const txPharmacySourceLabel=document.getElementById('txPharmacySourceLabel');
 const txFromLocationSelect=document.querySelector('#txForm select[name=fromLocation]');
 const txToLocationText=document.getElementById('txToLocationText');
 const txToLocationLabel=document.getElementById('txToLocationLabel');
 const txToLocationSelect=document.querySelector('#txForm select[name=toLocation]');
 const txSourcePharmacy=document.getElementById('txSourcePharmacy');
 const txDestructionCompanyLabel=document.getElementById('txDestructionCompanyLabel');
 const txDestructionCompany=document.getElementById('txDestructionCompany');
 const syncTxPdfRequirement=()=>{
   const selectedType=txTypeSelect?.value||'';
   const received=selectedType==='received';
   const destroyed=selectedType==='destroyed';
   const incident=selectedType==='incident';
   const auditIncident=incident&&Boolean(document.getElementById('txAuditContextId')?.value);
   const required=received||selectedType==='destroyed';
   if(txFromLocationText)txFromLocationText.textContent=incident?'Vial source location':(destroyed?'Source location':'From');
   if(txFromLocationLabel){
     txFromLocationLabel.hidden=received;
     txFromLocationLabel.style.display=received?'none':'';
   }
   if(txFromLocationSelect){
     txFromLocationSelect.disabled=received||destroyed;
     if(received)txFromLocationSelect.value='';
     if(destroyed)txFromLocationSelect.value='Expired';
     const auditIncident=incident&&Boolean(document.getElementById('txAuditContextId')?.value);
     const expiredOption=[...txFromLocationSelect.options].find(o=>o.value==='Expired'||o.textContent==='Expired');
     if(expiredOption)expiredOption.disabled=incident&&!auditIncident;
     if(incident&&!auditIncident&&txFromLocationSelect.value==='Expired')txFromLocationSelect.value='';
   }
   if(txPharmacySourceLabel){
     txPharmacySourceLabel.hidden=!received;
     txPharmacySourceLabel.style.display=received?'':'none';
   }
   if(txToLocationText)txToLocationText.textContent='To';
   if(txToLocationLabel){
     const hideTo=received||incident||destroyed;
     txToLocationLabel.hidden=hideTo;
     txToLocationLabel.style.display=hideTo?'none':'';
   }
   if(txToLocationSelect){
     txToLocationSelect.disabled=incident||destroyed;
     if(received)txToLocationSelect.value='Safe';
     if(incident||destroyed)txToLocationSelect.value='';
   }
   if(txSourcePharmacy){
     txSourcePharmacy.required=received;
     txSourcePharmacy.disabled=!received;
     if(received&&!txSourcePharmacy.value.trim())txSourcePharmacy.value='NKCH Pharmacy';
     if(!received)txSourcePharmacy.value='';
   }
   if(txDestructionCompanyLabel){
     txDestructionCompanyLabel.hidden=!destroyed;
     txDestructionCompanyLabel.style.display=destroyed?'':'none';
   }
   if(txDestructionCompany){
     txDestructionCompany.required=destroyed;
     txDestructionCompany.disabled=!destroyed;
     if(!destroyed)txDestructionCompany.value='';
   }
   if(txNotesField)txNotesField.hidden=received||destroyed;
   if(txNotesLabel)txNotesLabel.textContent=incident?'Incident / discrepancy explanation':'Reason / notes';
   if(txMemoDescriptionLabel){
     txMemoDescriptionLabel.hidden=!incident;
     txMemoDescriptionLabel.style.display=incident?'':'none';
   }
   if(txMemoDescription){
     txMemoDescription.required=false;
     txMemoDescription.disabled=!incident;
     if(!incident)txMemoDescription.value='';
   }
   if(txDraftBtn)txDraftBtn.hidden=!incident;
   if(txSubmitBtn)txSubmitBtn.textContent=incident?'Submit incident':'Save transaction';
   if(txNotes){
     txNotes.required=incident;
     txNotes.placeholder=incident?'Describe what happened, including broken/damaged vial details and circumstances.':'';
   }
   if(txPdfLabel){
     txPdfLabel.hidden=false;
     txPdfLabel.classList.toggle('tx-pdf-required',required);
   }
   if(txPdfRequiredBadge)txPdfRequiredBadge.hidden=!required;
   if(txPdfTitle)txPdfTitle.textContent=required?'DEA Form 222':'Supporting PDF';
   if(txPdfInput){
     txPdfInput.required=required;
   }
   if(txPdfHint)txPdfHint.textContent=incident
     ?'Memo PDF is optional while saving a draft, but required before final incident submission. DEA Form 222 is not required.'
     :(required
       ?'REQUIRED: Attach the DEA Form 222 PDF before this transaction can be submitted.'
       :'Attach supporting documentation when applicable.');
   if(txDestructionReceiptLabel){
     txDestructionReceiptLabel.hidden=!destroyed;
     txDestructionReceiptLabel.style.display=destroyed?'':'none';
     txDestructionReceiptLabel.classList.toggle('tx-pdf-required',destroyed);
   }
   if(txDestructionReceipt){
     txDestructionReceipt.required=destroyed;
     txDestructionReceipt.disabled=!destroyed;
     if(!destroyed)txDestructionReceipt.value='';
   }
 };
 if(txTypeSelect){txTypeSelect.addEventListener('change',syncTxPdfRequirement);syncTxPdfRequirement();}
 document.getElementById('newTxBtn').onclick=()=>{
   const auditCtx=document.getElementById('txAuditContextId');if(auditCtx)auditCtx.value='';
   const txId=document.getElementById('txTransactionId');if(txId)txId.value='';
   const recordedEmp=document.getElementById('txRecordedByEmployeeNumber');
   if(recordedEmp&&!recordedEmp.value)recordedEmp.value=signedInEmployeeNumber();
   syncTxPdfRequirement();document.getElementById('txDialog').showModal();
 };
 const txDialog=document.getElementById('txDialog');
 const txForm=document.getElementById('txForm');
 const closeTx=()=>{
   if(txDialog?.open)txDialog.close('cancel');
   txForm?.reset();
   const auditCtx=document.getElementById('txAuditContextId');if(auditCtx)auditCtx.value='';
   const txId=document.getElementById('txTransactionId');if(txId)txId.value='';
   if(txRowsHost){txRowsHost.innerHTML='';addTxMedicationRow();}
   [txRecordedSig,txWitnessSig].forEach(c=>{if(c){c.getContext('2d').clearRect(0,0,c.width,c.height);c.dataset.hasSignature='false';}});
   syncTxPdfRequirement();
 };
 const closeTxBtn=document.getElementById('closeTxDialog');
 const cancelTxBtn=document.getElementById('cancelTxDialog');
 if(closeTxBtn)closeTxBtn.onclick=closeTx;
 if(cancelTxBtn)cancelTxBtn.onclick=closeTx;
 if(txDialog)txDialog.addEventListener('cancel',e=>{e.preventDefault();closeTx();});
 const txRowsHost=document.getElementById('txMedicationRows');
 const addTxMedBtn=document.getElementById('addTxMedication');
 const txRecordedSig=document.getElementById('txRecordedSignature');
 const txWitnessSig=document.getElementById('txWitnessSignature');
 if(addTxMedBtn)addTxMedBtn.onclick=()=>addTxMedicationRow();
 if(txRowsHost)txRowsHost.onclick=e=>{
   const remove=e.target.closest('.remove-tx-med');
   if(!remove)return;
   const rows=txRowsHost.querySelectorAll('.tx-med-row');
   if(rows.length<=1)return;
   remove.closest('.tx-med-row')?.remove();
 };
 if(txRecordedSig){
   setupCanvas(txRecordedSig,'');
   const b=document.getElementById('expandTxRecordedSignature');
   const clear=document.getElementById('clearTxRecordedSignature');
   if(b)b.onclick=()=>openStandaloneSignatureCapture(txRecordedSig,'Recorded-by signature');
   if(clear)clear.onclick=()=>{txRecordedSig.resetSignatureStroke?.();txRecordedSig.getContext('2d').clearRect(0,0,txRecordedSig.width,txRecordedSig.height);txRecordedSig.dataset.hasSignature='false';txRecordedSig.dataset.signatureEdited='true';};
 }
 if(txWitnessSig){
   setupCanvas(txWitnessSig,'');
   const b=document.getElementById('expandTxWitnessSignature');
   const clear=document.getElementById('clearTxWitnessSignature');
   if(b)b.onclick=()=>openStandaloneSignatureCapture(txWitnessSig,'Witness signature');
   if(clear)clear.onclick=()=>{txWitnessSig.resetSignatureStroke?.();txWitnessSig.getContext('2d').clearRect(0,0,txWitnessSig.width,txWitnessSig.height);txWitnessSig.dataset.hasSignature='false';txWitnessSig.dataset.signatureEdited='true';};
 }
 if(txRowsHost&&!txRowsHost.children.length)addTxMedicationRow();

 const resetTxAfterSave=()=>{txDialog.close();txForm.reset();const txId=document.getElementById('txTransactionId');if(txId)txId.value='';if(txRowsHost){txRowsHost.innerHTML='';addTxMedicationRow();}[txRecordedSig,txWitnessSig].forEach(c=>{if(c){c.getContext('2d').clearRect(0,0,c.width,c.height);c.dataset.hasSignature='false';}});syncTxPdfRequirement();};
 document.getElementById('saveTxBtn').onclick=async e=>{e.preventDefault();try{await saveTransaction(new FormData(txForm),true);resetTxAfterSave()}catch(err){alert(err.message)}};
 if(txDraftBtn)txDraftBtn.onclick=async e=>{e.preventDefault();try{await saveTransaction(new FormData(txForm),false);resetTxAfterSave()}catch(err){alert(err.message)}};
 document.getElementById('activitySearch').oninput=renderActivity;
 document.getElementById('activityList').onclick=async e=>{
   const btn=e.target.closest('[data-resume-incident]');if(!btn)return;
   const tx=await getOne('transactions',btn.dataset.resumeIncident);if(!tx)return;
   txForm.reset();
   const type=txForm.querySelector('select[name=type]');if(type)type.value='incident';
   const txId=document.getElementById('txTransactionId');if(txId)txId.value=tx.id;
   const auditCtx=document.getElementById('txAuditContextId');if(auditCtx)auditCtx.value=tx.auditId||'';
   const from=txForm.querySelector('select[name=fromLocation]');if(from)from.value=tx.incidentSourceLocation||tx.fromLocation||'';
   const notes=document.getElementById('txNotes');if(notes)notes.value=tx.notes||'';
   const memo=document.getElementById('txMemoDescription');if(memo)memo.value=tx.memoDescription||tx.supportingDocument?.description||'';
   document.getElementById('txRecordedBy').value=tx.recordedBy||'';
   document.getElementById('txRecordedByEmployeeNumber').value=tx.recordedByEmployeeNumber||'';
   document.getElementById('txWitness').value=tx.witness||'';
   document.getElementById('txWitnessEmployeeNumber').value=tx.witnessEmployeeNumber||'';
   if(txRowsHost){txRowsHost.innerHTML='';(tx.items||[]).forEach(x=>addTxMedicationRow(x.medication,x.quantity));if(!txRowsHost.children.length)addTxMedicationRow();}
   const restore=(canvas,data)=>{canvas.getContext('2d').clearRect(0,0,canvas.width,canvas.height);canvas.dataset.hasSignature='false';if(!data)return;const img=new Image();img.onload=()=>{canvas.getContext('2d').drawImage(img,0,0,canvas.width,canvas.height);canvas.dataset.hasSignature='true';};img.src=data;};
   restore(txRecordedSig,tx.recordedBySignature);restore(txWitnessSig,tx.witnessSignature);
   syncTxPdfRequirement();txDialog.showModal();
 };document.getElementById('exportActivityBtn').onclick=exportActivity;document.getElementById('newAuditBtn').onclick=startAudit;const startAuditHomeBtn=document.getElementById('startAuditHomeBtn');if(startAuditHomeBtn)startAuditHomeBtn.onclick=startAudit;
 document.getElementById('auditWorkspace').onclick=async e=>{const b=e.target.closest('[data-audit-action]');if(!b)return;if(b.dataset.auditAction==='open'){activateAuditTab();await editAudit(b.dataset.id)}if(b.dataset.auditAction==='delete'&&confirm('Delete this audit draft?')){await del('audits',b.dataset.id);await renderAudits()}};
 document.getElementById('reportsList').onclick=async e=>{
   const test=e.target.closest('[data-test-report]');
   if(test){await showTestReport();return}
   const b=e.target.closest('[data-report]');
   if(b)await showReport(b.dataset.report);
 };
 document.getElementById('exportBtn').onclick=exportBackup;document.getElementById('importBtn').onclick=()=>{if(requireCloudAuth())document.getElementById('importFile').click()};document.getElementById('importFile').onchange=async e=>{if(!e.target.files[0])return;try{await importBackup(e.target.files[0]);await flushPendingWrites()}catch(err){alert(err.message)}};
 const authDialog=document.getElementById('authDialog'),authForm=document.getElementById('authForm'),authMsg=document.getElementById('authMessage');
 const authEmployee=document.getElementById('authEmployeeNumber');
 document.getElementById('accountBtn').onclick=async()=>{if(!cloudSession)authDialog.showModal()};
 const logoffBtn=document.getElementById('logoffBtn');
 if(logoffBtn)logoffBtn.onclick=async()=>{
   if(!cloudSession)return;
   if(!confirm('Log off of the narcotic inventory app? Saved audit data will not be deleted.'))return;
   if(activeAuditId)await flushAuditAutosave();
   if(realtimeChannel){try{await sb.removeChannel(realtimeChannel)}catch(e){}realtimeChannel=null}
   await sb.auth.signOut();
   cloudSession=null;
   updateAccountUI();
   if(activeAuditId){
     activeAuditId=null;
     await putLocal('meta',{id:'activeAudit',auditId:'',updatedAt:nowISO()});
   }
   await renderAudits();
   authDialog.showModal();
 };
 authForm.onsubmit=async e=>{
   e.preventDefault();authMsg.hidden=true;
   const email=document.getElementById('authEmail').value.trim();
   const password=document.getElementById('authPassword').value;
   const employeeNumber=digitsOnly(authEmployee?.value||'');
   if(!employeeNumber){authMsg.textContent='Employee number is required.';authMsg.hidden=false;return}
   const {data,error}=await sb.auth.signInWithPassword({email,password});
   if(error){authMsg.textContent=error.message;authMsg.hidden=false;return}
   const stored=digitsOnly(data.user?.user_metadata?.employee_number||'');
   if(stored&&stored!==employeeNumber){
     await sb.auth.signOut();
     authMsg.textContent='Employee number does not match this account.';
     authMsg.hidden=false;
     return;
   }
   if(!stored){
     const {error:updateError}=await sb.auth.updateUser({data:{employee_number:employeeNumber}});
     if(updateError){
       await sb.auth.signOut();
       authMsg.textContent='Could not associate the employee number with this account. '+updateError.message;
       authMsg.hidden=false;
       return;
     }
   }
   authDialog.close();
 };
 document.getElementById('createAccountBtn').onclick=async()=>{
   authMsg.hidden=true;
   const email=document.getElementById('authEmail').value.trim();
   const password=document.getElementById('authPassword').value;
   const employeeNumber=digitsOnly(authEmployee?.value||'');
   if(!email||password.length<8||!employeeNumber){
     authMsg.textContent='Enter a valid email, employee number, and a password of at least 8 characters.';
     authMsg.hidden=false;return;
   }
   const {data,error}=await sb.auth.signUp({email,password,options:{data:{employee_number:employeeNumber}}});
   authMsg.textContent=error?error.message:(data.session?'Account created and signed in.':'Account created. Check your email if confirmation is required, then sign in.');
   authMsg.hidden=false;if(data.session)setTimeout(()=>authDialog.close(),700);
 };
 const status=async()=>{const el=document.getElementById('offlineBadge');if(navigator.onLine){el.textContent=cloudSession?'Live sync':'Online · sign in';el.style.background=cloudSession?'#1f6e4d':'#31566f';await flushPendingWrites()}else{el.textContent='Offline · queued';el.style.background='#7a4a1f'}};window.addEventListener('online',status);window.addEventListener('offline',status);status()
}
window.addEventListener('pagehide',()=>{if(activeAuditId)scheduleAuditAutosave(activeAuditId)});
document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='hidden'&&activeAuditId)flushAuditAutosave()});
(async()=>{
 await openDB();
 fillSelects();bind();
 // Present the cached dashboard and available drafts immediately while the
 // latest live cloud records synchronize. No audit data is mutated.
 await Promise.all([renderInventory(),renderAudits()]);
 await initCloud();
 await seedInventory();
 await refreshAll();
 if(!cloudSession)setTimeout(()=>document.getElementById('authDialog')?.showModal(),300);
 const active=await getOne('meta','activeAudit');
 if(active?.auditId){await put('meta',{id:'activeAudit',auditId:'',updatedAt:nowISO()});activeAuditId=null;await renderAudits()}
 if('serviceWorker'in navigator){
  try{
    const reg=await navigator.serviceWorker.register('./sw.js?v=20261018-247',{updateViaCache:'none'});
    await reg.update();
    let reloading=false;
    navigator.serviceWorker.addEventListener('controllerchange',()=>{
      if(reloading)return;
      if(activeAuditId&&document.getElementById('auditMonth')){
        setAutosaveStatus('App update available. Save your draft before reopening to update.');
        return; // Preserve any unfinished work during a service worker update.
      }
      reloading=true;
      location.reload();
    });
    if(reg.waiting)reg.waiting.postMessage({type:'SKIP_WAITING'});
    reg.addEventListener('updatefound',()=>{
      const worker=reg.installing;
      if(!worker)return;
      worker.addEventListener('statechange',()=>{
        if(worker.state==='installed'&&navigator.serviceWorker.controller){
          worker.postMessage({type:'SKIP_WAITING'});
        }
      });
    });
  }catch(err){console.warn('Service worker update failed',err);}
}})();
document.addEventListener('DOMContentLoaded',()=>{
 const d=document.getElementById('pdfPreviewDialog');
 const close=document.getElementById('closePdfPreview');
 if(close&&d)close.onclick=()=>d.close();
 if(d)d.addEventListener('close',()=>{
   const frame=document.getElementById('pdfPreviewFrame');
   if(frame)frame.src='about:blank';
   const openLink=document.getElementById('openPdfPreview');
   if(openLink){openLink.removeAttribute('href');openLink.hidden=true;}
   const shareBtn=document.getElementById('savePdfPreview');
   if(shareBtn){shareBtn.onclick=null;shareBtn.hidden=true;}
   if(d.dataset.objectUrl){URL.revokeObjectURL(d.dataset.objectUrl);delete d.dataset.objectUrl;}
 });
});
