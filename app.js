const MEDS=['Fentanyl 100 mcg','Versed 2 mg','Versed 5 mg','Ketamine 500 mg','Morphine 10 mg'];
const FINAL_ATTESTATION='I certify that I have personally reviewed this controlled-substance audit, the physical counts and seal records for Medic 1, Medic 2, Medic 3, Safe, and Expired, and each location’s signer and witness certifications. To the best of my knowledge, this record is complete, accurate, and truthful. All shortages, overages, damaged or missing seals, expired stock, and other discrepancies identified during this audit are documented with corrective actions or escalation in the audit notes. I have not knowingly concealed a discrepancy or falsified any count, signature, or record. Unresolved discrepancies remain subject to investigation and required departmental reporting; this signature does not represent their resolution. By signing, I accept responsibility for this certification and authorize finalization of this audit record.';
const LOCS=['Medic 1','Medic 2','Medic 3','Safe','Expired'];
const DB_NAME='narcotic-audit-db', DB_VER=2;
const SUPABASE_URL='https://fygyubamdxdfhvteyxyy.supabase.co';
const SUPABASE_KEY='sb_publishable_oDnbAnpzDxJ14Fx1KMNtFA_5vemlptG';
const CLOUD_STORES=new Set(['inventory','transactions','audits','reports','meta','legacyArchive']);
let db, sb, cloudSession=null, realtimeChannel=null;
let activeAuditId=null;
let auditAutosaveTimer=null;
let auditSaveInFlight=false;
let lastCloudWrite='local';

function uid(prefix='id'){return prefix+'_'+Date.now().toString(36)+'_'+Math.random().toString(36).slice(2,8)}
function nowISO(){return new Date().toISOString()}
function esc(s=''){return String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[c]))}
function openDB(){return new Promise((resolve,reject)=>{const r=indexedDB.open(DB_NAME,DB_VER);r.onupgradeneeded=()=>{const d=r.result;['inventory','transactions','audits','reports','meta','legacyArchive'].forEach(n=>{if(!d.objectStoreNames.contains(n))d.createObjectStore(n,{keyPath:'id'})})};r.onsuccess=()=>{db=r.result;resolve(db)};r.onerror=()=>reject(r.error)})}
function store(name,mode='readonly'){return db.transaction(name,mode).objectStore(name)}
function getAll(name){return new Promise((res,rej)=>{const r=store(name).getAll();r.onsuccess=()=>res(r.result);r.onerror=()=>rej(r.error)})}
function getOne(name,id){return new Promise((res,rej)=>{const r=store(name).get(id);r.onsuccess=()=>res(r.result);r.onerror=()=>rej(r.error)})}
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
async function pullCloudRecords(){
 if(!sb||!cloudSession)return;
 const {data,error}=await sb.from('app_records').select('store,id,data,updated_at');
 if(error)throw error;
 for(const r of data||[]){
   if(!CLOUD_STORES.has(r.store)||!r.data)continue;
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
     if(payload.eventType==='DELETE')await delLocal(row.store,row.id);else if(payload.new?.data)await putLocal(payload.new.store,payload.new.data);
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
function updateAccountUI(){
 const btn=document.getElementById('accountBtn');if(!btn)return;
 btn.textContent=cloudSession?.user?.email||'Sign in';
 document.body.classList.toggle('cloud-authenticated',!!cloudSession);
}
async function initCloud(){
 if(!window.supabase)return;
 sb=window.supabase.createClient(SUPABASE_URL,SUPABASE_KEY,{auth:{persistSession:true,autoRefreshToken:true}});
 const {data}=await sb.auth.getSession();cloudSession=data.session||null;updateAccountUI();
 sb.auth.onAuthStateChange(async(_event,session)=>{
   cloudSession=session||null;updateAccountUI();
   if(cloudSession){
     await pullCloudRecords();await flushPendingWrites();await subscribeRealtime();
     if(activeAuditId&&document.getElementById('auditMonth'))await Promise.all([renderInventory(),renderActivity(),renderReports(),renderStats()]);
     else await refreshAll();
   }
 });
 if(cloudSession){await pullCloudRecords();await flushPendingWrites();await subscribeRealtime()}
}
function requireCloudAuth(){
 if(cloudSession)return true;
 document.getElementById('authDialog')?.showModal();
 return false;
}

async function seedInventory(){const rows=await getAll('inventory');if(rows.length)return;for(const loc of LOCS)for(const med of MEDS)await put('inventory',{id:loc+'|'+med,location:loc,medication:med,quantity:0,updatedAt:nowISO()})}
async function balances(){const rows=await getAll('inventory');const map={};for(const l of LOCS){map[l]={};for(const m of MEDS)map[l][m]=0}rows.forEach(r=>{if(map[r.location])map[r.location][r.medication]=Number(r.quantity||0)});return map}
async function setBalance(location,medication,quantity){await put('inventory',{id:location+'|'+medication,location,medication,quantity:Number(quantity||0),updatedAt:nowISO()})}
function fmtDate(v){if(!v)return'';return new Date(v).toLocaleString()}
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

async function renderInventory(){const b=await balances();const grid=document.getElementById('inventoryGrid');grid.innerHTML=LOCS.map(loc=>'<div class="location-card"><h3><span>'+loc+'</span><span class="pill '+(loc==='Expired'?'expired':'')+'">'+(loc==='Expired'?'Segregated':'Active')+'</span></h3>'+MEDS.map(m=>'<div class="med-row"><span>'+m+'</span><strong>'+b[loc][m]+'</strong></div>').join('')+'</div>').join('');
document.getElementById('activeTotals').innerHTML=MEDS.map(m=>{const t=['Medic 1','Medic 2','Medic 3','Safe'].reduce((a,l)=>a+b[l][m],0);return '<div class="total-row"><div><b>'+m+'</b><small>Medic 1 + Medic 2 + Medic 3 + Safe</small></div><strong>'+t+'</strong></div>'}).join('')}

async function renderActivity(){const q=(document.getElementById('activitySearch')?.value||'').toLowerCase();let rows=await getAll('transactions');rows.sort((a,b)=>b.timestamp.localeCompare(a.timestamp));if(q)rows=rows.filter(r=>JSON.stringify(r).toLowerCase().includes(q));document.getElementById('activityList').innerHTML=rows.length?rows.map(r=>'<div class="list-item"><strong>'+esc(r.typeLabel||r.type)+' · '+esc(r.medication)+' · '+esc(r.quantity)+'</strong><div>'+esc(r.fromLocation||'—')+' → '+esc(r.toLocation||'—')+'</div><div class="meta">'+fmtDate(r.timestamp)+(r.recordedBy?' · '+esc(r.recordedBy):'')+(r.reference?' · Ref '+esc(r.reference):'')+'</div>'+(r.notes?'<div>'+esc(r.notes)+'</div>':'')+'</div>').join(''):'<div class="empty">No activity recorded yet.</div>'}

async function saveTransaction(fd){
 if(!requireCloudAuth())throw new Error('Sign in is required for live inventory changes.');
 const type=fd.get('type'), med=fd.get('medication'), qty=Number(fd.get('quantity')||0), from=fd.get('fromLocation'), to=fd.get('toLocation');
 const b=await balances();
 if(type==='adjustment'){
   if(!to)throw new Error('Choose the location being counted.');
   await setBalance(to,med,qty);
 }else if(type==='received'){
   if(!to)throw new Error('Choose the receiving location.');
   await setBalance(to,med,b[to][med]+qty);
 }else if(type==='transfer'||type==='expired'){
   const dest=type==='expired'?'Expired':to;
   if(!from||!dest)throw new Error('Choose source and destination.');
   if(b[from][med]<qty)throw new Error('Quantity exceeds current source balance.');
   await setBalance(from,med,b[from][med]-qty);await setBalance(dest,med,b[dest][med]+qty);
 }else if(type==='destroyed'||type==='waste'){
   if(!from)throw new Error('Choose the source location.');
   if(b[from][med]<qty)throw new Error('Quantity exceeds current source balance.');
   await setBalance(from,med,b[from][med]-qty);
 }
 const labels={adjustment:'Physical count / adjustment',transfer:'Transfer',received:'Received / restock',expired:'Moved to expired',destroyed:'Destroyed / transferred out',waste:'Waste'};
 await put('transactions',{id:uid('tx'),timestamp:nowISO(),type,typeLabel:labels[type],medication:med,quantity:qty,fromLocation:from,toLocation:type==='expired'?'Expired':to,reference:fd.get('reference')||'',notes:fd.get('notes')||'',recordedBy:fd.get('recordedBy')||'',witness:fd.get('witness')||''});
 await refreshAll();
}

function auditSkeleton(a){
 const b=a.counts||{};return '<div class="audit-card"><div class="audit-header"><div><h3>'+esc(a.month||'Draft audit')+'</h3><div class="meta">Status: '+esc(a.status||'draft')+' · Saved '+fmtDate(a.updatedAt)+'</div></div><div class="button-row"><button data-audit-action="open" data-id="'+a.id+'">Open</button><button data-audit-action="delete" data-id="'+a.id+'">Delete</button></div></div></div>'
}
async function renderAudits(){
 let rows=await getAll('audits');
 const drafts=rows.filter(a=>String(a.status||'draft').toLowerCase()==='draft');
 drafts.sort((a,b)=>String(b.updatedAt||'').localeCompare(String(a.updatedAt||'')));
 document.getElementById('auditWorkspace').innerHTML=(drafts.length?'<div class="notice">Audit drafts autosave to the live department database. You can leave this location and resume the same audit from another authorized device.</div>':'')+(drafts.length?drafts.map(auditSkeleton).join(''):'<div class="card empty">No monthly audit is currently in progress.</div>')
}

async function startAudit(){
 if(!requireCloudAuth())return;
 const b=await balances(),reports=await getAll('reports');const d=new Date(),month=d.toLocaleString(undefined,{month:'long',year:'numeric'});
 reports.sort((x,y)=>String(y.finalizedAt||y.updatedAt||y.createdAt||'').localeCompare(String(x.finalizedAt||x.updatedAt||x.createdAt||'')));
 const previous=reports[0]||null;
 const counts={},priorCounts={};LOCS.forEach(l=>{counts[l]={};priorCounts[l]={};MEDS.forEach(m=>{counts[l][m]=b[l][m];priorCounts[l][m]=previous?.counts?.[l]?.[m]??null})});
 const localDate=d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0');
 const a={id:uid('audit'),month,status:'draft',createdAt:nowISO(),updatedAt:nowISO(),auditDate:localDate,email:cloudSession?.user?.email||'',counts,priorCounts,dateRangeStart:'',dateRangeEnd:'',notes:'',usageSummary:'',breakawayTags:{},supportingDocuments:[],administrationRows:[],signatures:{},auditorName:'',auditorEmployeeNumber:'',attestationText:FINAL_ATTESTATION,attestationName:'',attestationEmployeeNumber:'',attestationAccepted:false};
 await put('audits',a);await put('meta',{id:'activeAudit',auditId:a.id,updatedAt:nowISO()});await editAudit(a.id)
}
function unitAuditSection(a,loc,index){
 const tag=a.breakawayTags?.[loc]||{},savedSig=a.signatures?.[loc]||{};
 const sig={...savedSig,signer:savedSig.signer||a.auditorName||'',employeeNumber:savedSig.employeeNumber||a.auditorEmployeeNumber||''};
 const medRows=MEDS.map(m=>{const p=a.priorCounts?.[loc]?.[m];return '<div class="unit-med-row compact"><div class="unit-med-name">'+esc(m)+'</div><div class="unit-prior"><span>Last</span><strong>'+(p==null?'—':Number(p))+'</strong></div><label class="unit-current">Current<input aria-label="'+m+' '+loc+' current count" type="number" min="0" step="1" inputmode="numeric" data-count-loc="'+loc+'" data-count-med="'+m+'" value="'+Number(a.counts?.[loc]?.[m]||0)+'"></label></div>'}).join('');
 return '<section class="audit-card unit-audit-card compact-unit" data-unit-section="'+esc(loc)+'">'+
 '<div class="unit-audit-head compact-head"><div><span class="kicker">LOCATION '+(index+1)+' OF '+LOCS.length+'</span><h3>'+esc(loc)+'</h3></div><span class="unit-step-badge">'+esc(loc)+'</span></div>'+
 '<div class="unit-compact-grid">'+
 '<div class="unit-compact-panel seal-panel"><h4>Seals</h4><div class="tag-entry-fields seal-pair"><label>Tag found / removed<input inputmode="numeric" autocomplete="off" placeholder="Tag #" data-tag-loc="'+loc+'" data-tag-kind="foundRemoved" aria-label="'+loc+' tag found or removed" value="'+esc(tag.foundRemoved||'')+'"></label><label>New tag installed<input inputmode="numeric" autocomplete="off" placeholder="Tag #" data-tag-loc="'+loc+'" data-tag-kind="newInstalled" aria-label="'+loc+' new tag installed" value="'+esc(tag.newInstalled||'')+'"></label></div></div>'+
 '<div class="unit-compact-panel inventory-panel"><h4>Physical inventory</h4><div class="unit-med-list">'+medRows+'</div></div>'+
 '<div class="unit-compact-panel certification-panel"><h4>Certification</h4>'+sigBlock(loc,sig,true)+'</div>'+
 '</div></section>';
}
function sigBlock(loc,s={},embedded=false){return '<div class="signature-box'+(embedded?' embedded-signature':'')+'" data-sig-loc="'+loc+'">'+(!embedded?'<div class="signature-location">'+loc+'</div>':'')+'<div class="signature-person-grid"><div><div class="auditor-id-grid"><label>Auditor name<input placeholder="Full name" data-signer value="'+esc(s.signer||'')+'"></label><label>Employee number<input placeholder="Employee #" inputmode="numeric" autocomplete="off" data-employee-number value="'+esc(s.employeeNumber||'')+'"></label></div><div class="signature-label-row"><div class="signature-label">Auditor signature</div><button type="button" class="expand-signature" data-expand-signature="auditor">Open larger</button></div><canvas width="500" height="150" data-canvas></canvas></div><div><div class="auditor-id-grid"><label>Witness name<input placeholder="Full name" data-witness value="'+esc(s.witness||'')+'"></label><label>Employee number<input placeholder="Employee #" inputmode="numeric" autocomplete="off" data-witness-employee-number value="'+esc(s.witnessEmployeeNumber||'')+'"></label></div><div class="signature-label-row"><div class="signature-label">Witness signature</div><button type="button" class="expand-signature" data-expand-signature="witness">Open larger</button></div><canvas width="500" height="150" data-witness-canvas></canvas></div></div><button type="button" class="clear-signatures" data-clear-sig>Clear signatures</button></div>'}
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
 sorted.map(r=>'<div class="admin-actual-row"><span data-label="Date">'+esc(formatAdminDate(r.date))+'</span><span data-label="Report">'+esc(r.report)+'</span><span data-label="Provider">'+esc(r.provider)+'</span><span data-label="Medication">'+esc(r.medication)+'</span><span data-label="Dose"><b>'+esc(r.dose)+' '+esc(adminDoseUnit(r.medication))+'</b></span><span data-label="Unit">'+esc(String(r.unit||'').replace(/^M([123])$/,'M$1'))+'</span></div>').join('')+
 '</div></details>';
}
function providerVialData(rows=[]){
 const groups=new Map();
 for(const r of rows||[]){
   const key=[r.date,r.report,r.medication,r.unit].join('|');
   const g=groups.get(key)||{...r,totalDose:0,providers:[]};
   g.totalDose+=Number(r.dose||0);
   if(r.provider&&!g.providers.includes(r.provider))g.providers.push(r.provider);
   groups.set(key,g);
 }
 const byProvider=new Map();
 for(const g of groups.values()){
   const vial=administrationVialCount(g.medication,g.totalDose);
   const provider=(g.providers?.length?g.providers:[g.provider]).filter(Boolean).join(' / ')||'Unknown provider';
   if(!byProvider.has(provider))byProvider.set(provider,[]);
   byProvider.get(provider).push({
     date:formatAdminDate(g.date),
     report:g.report,
     medication:g.medication,
     dose:g.totalDose,
     doseUnit:adminDoseUnit(g.medication),
     unit:String(g.unit||'').replace(/^M([123])$/,'Medic $1'),
     strength:vial.strength,
     vials:vial.count
   });
 }
 const providers=[...byProvider.entries()].sort((a,b)=>a[0].localeCompare(b[0]));
 const total=providers.reduce((n,[,items])=>n+items.reduce((s,x)=>s+x.vials,0),0);
 return {providers,total};
}
function providerVialSummary(rows=[]){
 const data=providerVialData(rows);
 if(!data.providers.length)return '';
 const content=data.providers.map(([provider,items])=>{
   const total=items.reduce((n,x)=>n+x.vials,0);
   const medTotals=new Map();
   for(const x of items){
     const key=x.medication+'|'+x.strength;
     medTotals.set(key,(medTotals.get(key)||0)+x.vials);
   }
   const medSummary=[...medTotals.entries()].map(([key,count])=>{
     const [med,strength]=key.split('|');
     return med+' '+strength+': '+count;
   }).join(' · ');
   const detailRows=items.sort((a,b)=>a.date.localeCompare(b.date)||String(a.report).localeCompare(String(b.report))).map(x=>
     '<div class="provider-vial-detail-row">'+
       '<div><strong>'+esc(x.date)+'</strong><span>'+esc(x.report)+' · '+esc(x.unit)+'</span></div>'+
       '<div><strong>'+esc(x.medication)+' — '+esc(x.dose)+' '+esc(x.doseUnit)+' given</strong><span>'+x.vials+' vial'+(x.vials===1?'':'s')+' used · '+esc(x.strength)+' vial</span></div>'+
       '<div class="provider-vial-calc">'+x.vials+' vial'+(x.vials===1?'':'s')+'</div>'+
     '</div>'
   ).join('');
   return '<details class="provider-vial-provider">'+
     '<summary><div><strong>'+esc(provider)+'</strong><span>'+esc(medSummary)+'</span></div><div class="provider-vial-total">'+total+' vial'+(total===1?'':'s')+'</div></summary>'+
     '<div class="provider-vial-detail-list">'+detailRows+'</div>'+
   '</details>';
 }).join('');
 return '<details class="admin-detail-block"><summary>View vials by provider</summary><div class="provider-vial-list">'+content+'</div></details>';
}
function administrationImportStats(rows=[]){
 const vialData=providerVialData(rows);
 const providers=new Set((rows||[]).map(r=>String(r.provider||'').trim()).filter(Boolean));
 return {administrations:(rows||[]).length,vials:vialData.total,providers:providers.size};
}
function administrationImportSection(a){
 const docs=Array.isArray(a.supportingDocuments)?a.supportingDocuments:[];
 const latest=docs.length?docs[docs.length-1]:null;
 const rows=a.administrationRows||latest?.administrationRows||[];
 const stats=administrationImportStats(rows);
 return '<details class="audit-card admin-import-card compact-admin-import mobile-collapsible-admin" open>'+
 '<summary class="admin-import-summarybar"><div><span class="kicker">ADMINISTRATION RECORDS</span><h3>Administration import</h3></div><span class="admin-collapse-label">Show / hide</span></summary>'+
 '<div class="admin-import-body">'+
 '<div class="admin-import-top"><div id="adminImportStatus" class="admin-import-status">'+(latest?'Imported: '+esc(latest.name||'PDF'):'No administration PDF imported yet.')+'</div><div class="admin-import-actions"><button type="button" id="uploadAdminPdf" class="primary">Import Administration PDF</button><input id="adminPdfFile" type="file" accept="application/pdf,.pdf" hidden></div></div>'+
 (rows.length?'<div class="admin-import-summary"><div><strong>'+stats.administrations+'</strong><span>Administrations</span></div><div><strong>'+stats.vials+'</strong><span>Calculated vials</span></div><div><strong>'+stats.providers+'</strong><span>Providers</span></div></div>':'')+
 actualAdministrationPreview(rows)+providerVialSummary(rows)+
 '<textarea id="usageSummary" hidden>'+esc(a.usageSummary||'')+'</textarea>'+
 '</div></details>';
}
async function sha256Buffer(buf){const hash=await crypto.subtle.digest('SHA-256',buf);return [...new Uint8Array(hash)].map(b=>b.toString(16).padStart(2,'0')).join('')}
function safeStorageName(name='document.pdf'){return String(name).replace(/[^a-zA-Z0-9._-]+/g,'_').slice(-120)||'document.pdf'}
async function extractPdfTranscript(file){
 if(!window.pdfjsLib)throw new Error('PDF reader is still loading. Refresh the app and try again.');
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
function administrationVialCount(medication,totalDose){
 if(medication==='Fentanyl')return {count:Math.max(1,Math.ceil(totalDose/100)),strength:'100 mcg'};
 if(medication==='Versed'){
   if(totalDose>0&&totalDose%5===0)return {count:Math.max(1,totalDose/5),strength:'5 mg'};
   if(totalDose>0&&totalDose%2===0)return {count:Math.max(1,totalDose/2),strength:'2 mg'};
   return {count:Math.max(1,Math.ceil(totalDose/2)),strength:'2 mg'};
 }
 if(medication==='Ketamine')return {count:Math.max(1,Math.ceil(totalDose/500)),strength:'500 mg'};
 if(medication==='Morphine')return {count:Math.max(1,Math.ceil(totalDose/10)),strength:'10 mg'};
 return {count:1,strength:''};
}
function formatAdminDate(v){
 const m=String(v).match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
 if(!m)return v;
 const y=m[3].length===2?'20'+m[3]:m[3];
 return y+'-'+m[1].padStart(2,'0')+'-'+m[2].padStart(2,'0');
}
function buildAdministrationSummary(transcript,fileName){
 const rows=parseAdministrationRows(transcript);
 if(!rows.length){
   return 'Narcotic administration summary — '+fileName+'\nNo administration rows could be reliably identified from this PDF. Review the extracted transcription below before finalizing the audit.\n\nReference only; manual inventory counts unchanged.';
 }
 const groups=new Map();
 for(const r of rows){
   const key=[r.date,r.report,r.medication,r.unit].join('|');
   const g=groups.get(key)||{...r,totalDose:0,doseCount:0,providers:[]};
   g.totalDose+=Number(r.dose||0);g.doseCount++;
   if(r.provider&&!g.providers.includes(r.provider))g.providers.push(r.provider);
   groups.set(key,g);
 }
 const entries=[...groups.values()].sort((a,b)=>{
   const da=new Date(formatAdminDate(a.date)),db=new Date(formatAdminDate(b.date));
   return da-db||String(a.report).localeCompare(String(b.report));
 });
 let totalVials=0;
 const lines=entries.map(g=>{
   const vial=administrationVialCount(g.medication,g.totalDose);totalVials+=vial.count;
   const location=g.unit.replace(/^M([123])$/,'Medic $1');
   const providerText=(g.providers?.length?g.providers:[g.provider]).filter(Boolean).join(' / ');
   return '• '+formatAdminDate(g.date)+' | Report '+g.report+' | '+g.medication+' '+vial.strength+': '+vial.count+' vial'+(vial.count===1?'':'s')+' | '+location+(providerText?' | By '+providerText:'');
 });
 const monthMatch=String(transcript).match(/Months in Treatment Date Timestamp\s+(\d{2}\/\d{4})/i);
 const heading='Narcotic administration summary'+(monthMatch?' ('+monthMatch[1]+')':'')+' — '+fileName;
 return heading+'\n\n'+lines.join('\n\n')+'\n\nTotal: '+totalVials+' vial'+(totalVials===1?'':'s')+'. Combined doses per report, medication, and source location; vial use is calculated from the department vial strengths.\nReference only; manual inventory counts unchanged.';
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
   if(status)status.textContent='Uploading private supporting PDF…';
   const audit=await getOne('audits',auditId);if(!audit)throw new Error('Audit draft was not found.');
   const digest=await sha256Buffer(extracted.arrayBuffer);
   const path=String(auditId)+'/'+Date.now()+'-'+safeStorageName(file.name);
   const {error:uploadError}=await sb.storage.from('audit-supporting-docs').upload(path,file,{contentType:'application/pdf',upsert:false});
   if(uploadError)throw uploadError;
   const administrationRows=parseAdministrationRows(cleanText);
   const summary=buildAdministrationSummary(cleanText,file.name);
   audit.administrationRows=administrationRows;
   audit.supportingDocuments=Array.isArray(audit.supportingDocuments)?audit.supportingDocuments:[];
   audit.supportingDocuments.push({name:file.name,storageBucket:'audit-supporting-docs',storagePath:path,mimeType:'application/pdf',size:file.size,pageCount:extracted.pageCount,sha256:digest,uploadedAt:nowISO(),uploadedBy:cloudSession?.user?.email||'',transcript:cleanText,administrationRows});
   audit.usageSummary=summary;
   audit.updatedAt=nowISO();
   await put('audits',audit);
   const ta=document.getElementById('usageSummary');if(ta)ta.value=summary;
   if(status)status.textContent='PDF transcribed and saved live · '+file.name+' · '+extracted.pageCount+' page'+(extracted.pageCount===1?'':'s');
   setAutosaveStatus('Saved live '+new Date().toLocaleTimeString([], {hour:'numeric',minute:'2-digit',second:'2-digit'}));
   await editAudit(auditId);
 }catch(err){
   if(status)status.textContent='Import failed: '+(err?.message||String(err));
 }
}

function setupMobileAuditCards(auditId){
 const shell=document.querySelector('.audit-workspace-shell');
 if(!shell)return;
 const steps=[...shell.querySelectorAll('[data-audit-step]')];
 const prev=document.getElementById('auditStepPrev'),next=document.getElementById('auditStepNext');
 const title=document.getElementById('auditStepTitle'),count=document.getElementById('auditStepCount');
 if(!steps.length||!prev||!next)return;
 const isMobile=()=>window.matchMedia('(max-width:700px)').matches;
 let current=Number(sessionStorage.getItem('narcoticAuditStep:'+auditId)||0);
 if(!Number.isFinite(current)||current<0||current>=steps.length)current=0;
 const show=index=>{
   current=Math.max(0,Math.min(Number(index)||0,steps.length-1));
   steps.forEach((s,i)=>s.classList.toggle('active-step',!isMobile()||i===current));
   shell.querySelectorAll('[data-step-target]').forEach(x=>x.classList.toggle('current-step',Number(x.dataset.stepTarget)===current));
   if(title)title.textContent=steps[current]?.dataset.stepTitle||'Audit';
   if(count)count.textContent='Section '+(current+1)+' of '+steps.length;
   prev.textContent='Sections';
   prev.disabled=false;
   next.textContent='Next section';
   next.disabled=false;
   sessionStorage.setItem('narcoticAuditStep:'+auditId,String(current));
   if(isMobile())window.scrollTo({top:Math.max(0,(document.querySelector('.audit-route')?.offsetTop||0)-8),behavior:'smooth'});
 };
 prev.onclick=()=>{
   const route=document.querySelector('.audit-route');
   if(route)route.scrollIntoView({behavior:'smooth',block:'start'});
 };
 next.onclick=()=>show((current+1)%steps.length);
 document.querySelectorAll('[data-step-target]').forEach(link=>{
   link.addEventListener('click',e=>{if(!isMobile())return;e.preventDefault();show(Number(link.dataset.stepTarget)||0)});
 });
 show(current);
 window.addEventListener('resize',()=>show(current));
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
 '<div class="audit-route"><div class="audit-route-title">Audit sections</div>'+
 '<a href="#" data-step-target="0" data-route-section="details"><span class="route-label">Details</span></a>'+
 '<a href="#" data-step-target="1" data-route-section="admin"><span class="route-label">Admin</span></a>'+
 LOCS.map((l,i)=>'<a href="#unit-'+i+'" data-jump-unit="'+i+'" data-route-loc="'+esc(l)+'" data-step-target="'+(i+2)+'"><span class="route-status-mark"></span><span class="route-label">'+esc(l)+'</span></a>').join('')+
 '<a href="#" data-step-target="'+(LOCS.length+2)+'" data-route-section="notes"><span class="route-label">Notes</span></a>'+
 '<a href="#" data-step-target="'+(LOCS.length+3)+'" data-route-section="final"><span class="route-label">Final</span></a>'+
 '</div>'+
 '<div class="audit-step-card active-step" data-audit-step="0" data-step-title="Audit details"><div class="audit-card audit-hero"><div class="audit-header"><div><span class="kicker">DRAFT AUDIT</span><h2>'+esc(a.month)+'</h2><div id="autosaveStatus" class="autosave-status">Saved '+fmtDate(a.updatedAt)+'</div></div><button id="backAudits">Back to drafts</button></div><div class="form-grid audit-meta-grid"><label>Audit month / year<input id="auditMonthPicker" type="month" value="'+esc((a.monthValue||'')||monthTextToValue(a.month||''))+'"><input id="auditMonth" type="hidden" value="'+esc(a.month||'')+'"></label><label>Status<input value="'+esc(a.status)+'" disabled></label><label>Date of audit<input id="auditDate" type="date" value="'+esc(a.auditDate||'')+'"></label><label>Auditor email<input id="auditEmail" type="email" value="'+esc(a.email||cloudSession?.user?.email||'')+'"></label><label class="audit-primary-auditor">Auditor name<input id="auditAuditorName" placeholder="Full name" autocomplete="name" value="'+esc(a.auditorName||a.attestationName||'')+'"></label><label class="audit-primary-auditor">Employee number<input id="auditAuditorEmployeeNumber" placeholder="Employee #" inputmode="numeric" autocomplete="off" value="'+esc(a.auditorEmployeeNumber||a.attestationEmployeeNumber||'')+'"></label><label>Period start<input id="auditStart" type="date" value="'+esc(a.dateRangeStart||'')+'"></label><label>Period end<input id="auditEnd" type="date" value="'+esc(a.dateRangeEnd||'')+'"></label></div></div></div>'+
 '<div class="audit-step-card" data-audit-step="1" data-step-title="Administration import">'+administrationImportSection(a)+'</div>'+
 LOCS.map((l,i)=>'<div class="audit-step-card" data-audit-step="'+(i+2)+'" data-step-title="'+esc(l)+'" id="unit-'+i+'">'+unitAuditSection(a,l,i)+'</div>').join('')+
 '<div class="audit-step-card" data-audit-step="'+(LOCS.length+2)+'" data-step-title="Audit notes"><div class="audit-card audit-section-card"><span class="kicker">DOCUMENTATION</span><h3>Overall audit notes</h3><textarea id="auditNotes" rows="6" placeholder="Document discrepancies, corrective actions, or other audit notes.">'+esc(a.notes||'')+'</textarea></div></div>'+
 '<div class="audit-step-card" data-audit-step="'+(LOCS.length+3)+'" data-step-title="Final certification"><div class="audit-card audit-section-card attestation-card"><span class="kicker">FINAL CERTIFICATION</span><h3>Final attestation</h3><p>'+esc(a.attestationText||FINAL_ATTESTATION)+'</p><label class="attest-check"><input id="attestCheck" type="checkbox" '+(a.attestationAccepted?'checked':'')+'> <span>I certify this audit.</span></label><div class="final-auditor-grid"><label class="final-signer-label">Final auditor name<input id="attestName" placeholder="Full name" value="'+esc(a.attestationName||a.auditorName||'')+'"></label><label class="final-signer-label">Employee number<input id="attestEmployeeNumber" placeholder="Employee #" inputmode="numeric" value="'+esc(a.attestationEmployeeNumber||a.auditorEmployeeNumber||'')+'"></label></div><div class="final-signature-block"><div class="signature-label-row"><div class="signature-label">Final auditor signature</div><button type="button" class="expand-signature" id="expandFinalSignature">Open larger</button></div><canvas id="finalSignatureCanvas" width="500" height="150"></canvas></div><div class="audit-actions"><button id="saveAudit">Save draft</button><button class="primary" id="finalizeAudit">Finalize audit</button></div></div></div>'+
 '<div class="mobile-card-nav" aria-label="Audit section navigation"><button type="button" id="auditStepPrev">Sections</button><div class="mobile-card-progress"><strong id="auditStepTitle"></strong><span id="auditStepCount"></span></div><button type="button" class="primary" id="auditStepNext">Next section</button></div>'+
 '</div>';
 document.getElementById('backAudits').onclick=async()=>{
   await flushAuditAutosave();
   activeAuditId=null;
   await put('meta',{id:'activeAudit',auditId:'',updatedAt:nowISO()});
   await renderAudits();
 };
 const adminOuter=document.querySelector('.mobile-collapsible-admin');
 if(adminOuter&&window.matchMedia('(max-width:650px)').matches)adminOuter.removeAttribute('open');
 const adminUploadBtn=document.getElementById('uploadAdminPdf'),adminPdfFile=document.getElementById('adminPdfFile');
 if(adminUploadBtn&&adminPdfFile){adminUploadBtn.onclick=()=>adminPdfFile.click();adminPdfFile.onchange=async e=>{const file=e.target.files?.[0];if(file)await handleAdministrationPdf(a.id,file);e.target.value=''}};
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
   if(btn)btn.onclick=()=>openStandaloneSignatureCapture(finalSigCanvas,'Final auditor signature',()=>scheduleAuditAutosave(a.id,true));
 }
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
 updateAuditRouteProgress();
 setAutosaveStatus('Saved '+fmtDate(a.updatedAt));
}
function openSignatureCapture(box,kind,onChange){
 const source=kind==='witness'?box.querySelector('[data-witness-canvas]'):box.querySelector('[data-canvas]');
 if(!source)return;
 let dialog=document.getElementById('signatureCaptureDialog');
 if(!dialog){
   dialog=document.createElement('dialog');
   dialog.id='signatureCaptureDialog';
   dialog.className='signature-capture-dialog';
   dialog.innerHTML='<div class="signature-capture-shell"><div class="signature-capture-head"><div><span class="kicker">SIGNATURE CAPTURE</span><h2 id="signatureCaptureTitle">Signature</h2></div><button type="button" id="signatureCaptureClose">Done</button></div><div class="signature-capture-hint">Rotate your phone to landscape for the largest signing area.</div><canvas id="signatureCaptureCanvas" width="1200" height="500"></canvas><div class="signature-capture-actions"><button type="button" id="signatureCaptureClear">Clear</button><button type="button" class="primary" id="signatureCaptureSave">Use signature</button></div></div>';
   document.body.appendChild(dialog);
 }
 const title=dialog.querySelector('#signatureCaptureTitle');
 title.textContent=(kind==='witness'?'Witness':'Auditor')+' signature';
 const old=dialog.querySelector('#signatureCaptureCanvas');
 const live=old.cloneNode(true);
 old.replaceWith(live);
 live.width=1200;live.height=500;
 const lctx=live.getContext('2d');lctx.lineWidth=5;lctx.lineCap='round';
 if(source.dataset.hasSignature==='true'){
   const img=new Image();img.onload=()=>lctx.drawImage(img,0,0,live.width,live.height);img.src=source.toDataURL();
 }
 live.dataset.hasSignature=source.dataset.hasSignature||'false';
 let down=false,last=null,moved=false;
 const pos=e=>{const r=live.getBoundingClientRect(),p=e.touches?e.touches[0]:e;return{x:(p.clientX-r.left)*live.width/r.width,y:(p.clientY-r.top)*live.height/r.height}};
 const start=e=>{down=true;moved=false;last=pos(e);e.preventDefault()};
 const move=e=>{if(!down)return;const p=pos(e);lctx.beginPath();lctx.moveTo(last.x,last.y);lctx.lineTo(p.x,p.y);lctx.stroke();last=p;moved=true;e.preventDefault()};
 const end=()=>{if(down&&moved)live.dataset.hasSignature='true';down=false;last=null;moved=false};
 live.addEventListener('mousedown',start);live.addEventListener('mousemove',move);window.addEventListener('mouseup',end);
 live.addEventListener('touchstart',start,{passive:false});live.addEventListener('touchmove',move,{passive:false});live.addEventListener('touchend',end);
 const apply=()=>{
   const sctx=source.getContext('2d');sctx.clearRect(0,0,source.width,source.height);
   sctx.drawImage(live,0,0,source.width,source.height);
   source.dataset.hasSignature=live.dataset.hasSignature||'false';
   updateAuditRouteProgress();if(onChange)onChange();
 };
 dialog.querySelector('#signatureCaptureClear').onclick=()=>{lctx.clearRect(0,0,live.width,live.height);live.dataset.hasSignature='false'};
 dialog.querySelector('#signatureCaptureSave').onclick=()=>{apply();dialog.close()};
 dialog.querySelector('#signatureCaptureClose').onclick=()=>{apply();dialog.close()};
 dialog.showModal();
 setTimeout(()=>dialog.scrollTop=0,0);
}
function openStandaloneSignatureCapture(source,titleText,onChange){
 if(!source)return;
 let dialog=document.getElementById('signatureCaptureDialog');
 if(!dialog){
   dialog=document.createElement('dialog');
   dialog.id='signatureCaptureDialog';
   dialog.className='signature-capture-dialog';
   dialog.innerHTML='<div class="signature-capture-shell"><div class="signature-capture-head"><div><span class="kicker">SIGNATURE CAPTURE</span><h2 id="signatureCaptureTitle">Signature</h2></div><button type="button" id="signatureCaptureClose">Done</button></div><div class="signature-capture-hint">Rotate your phone to landscape for the largest signing area.</div><canvas id="signatureCaptureCanvas" width="1200" height="500"></canvas><div class="signature-capture-actions"><button type="button" id="signatureCaptureClear">Clear</button><button type="button" class="primary" id="signatureCaptureSave">Use signature</button></div></div>';
   document.body.appendChild(dialog);
 }
 dialog.querySelector('#signatureCaptureTitle').textContent=titleText||'Signature';
 const old=dialog.querySelector('#signatureCaptureCanvas');
 const live=old.cloneNode(true);old.replaceWith(live);live.width=1200;live.height=500;
 const lctx=live.getContext('2d');lctx.lineWidth=5;lctx.lineCap='round';
 if(source.dataset.hasSignature==='true'){
   const img=new Image();img.onload=()=>lctx.drawImage(img,0,0,live.width,live.height);img.src=source.toDataURL();
 }
 live.dataset.hasSignature=source.dataset.hasSignature||'false';
 let down=false,last=null,moved=false;
 const pos=e=>{const r=live.getBoundingClientRect(),p=e.touches?e.touches[0]:e;return{x:(p.clientX-r.left)*live.width/r.width,y:(p.clientY-r.top)*live.height/r.height}};
 const start=e=>{down=true;moved=false;last=pos(e);e.preventDefault()};
 const move=e=>{if(!down)return;const p=pos(e);lctx.beginPath();lctx.moveTo(last.x,last.y);lctx.lineTo(p.x,p.y);lctx.stroke();last=p;moved=true;e.preventDefault()};
 const end=()=>{if(down&&moved)live.dataset.hasSignature='true';down=false;last=null;moved=false};
 live.addEventListener('mousedown',start);live.addEventListener('mousemove',move);window.addEventListener('mouseup',end);
 live.addEventListener('touchstart',start,{passive:false});live.addEventListener('touchmove',move,{passive:false});live.addEventListener('touchend',end);
 const apply=()=>{const sctx=source.getContext('2d');sctx.clearRect(0,0,source.width,source.height);sctx.drawImage(live,0,0,source.width,source.height);source.dataset.hasSignature=live.dataset.hasSignature||'false';if(onChange)onChange()};
 dialog.querySelector('#signatureCaptureClear').onclick=()=>{lctx.clearRect(0,0,live.width,live.height);live.dataset.hasSignature='false'};
 dialog.querySelector('#signatureCaptureSave').onclick=()=>{apply();dialog.close()};
 dialog.querySelector('#signatureCaptureClose').onclick=()=>{apply();dialog.close()};
 dialog.showModal();
}
function setupCanvas(canvas,data,onChange){
 const ctx=canvas.getContext('2d');ctx.lineWidth=2;ctx.lineCap='round';canvas.dataset.hasSignature=data?'true':'false';
 if(data){const img=new Image();img.onload=()=>ctx.drawImage(img,0,0,canvas.width,canvas.height);img.src=data}
 let down=false,last=null,changed=false;
 const pos=e=>{const r=canvas.getBoundingClientRect(),p=e.touches?e.touches[0]:e;return{x:(p.clientX-r.left)*canvas.width/r.width,y:(p.clientY-r.top)*canvas.height/r.height}};
 const start=e=>{down=true;changed=false;last=pos(e);e.preventDefault()};
 const move=e=>{if(!down)return;const p=pos(e);ctx.beginPath();ctx.moveTo(last.x,last.y);ctx.lineTo(p.x,p.y);ctx.stroke();last=p;changed=true;e.preventDefault()};
 const end=()=>{if(down&&changed){canvas.dataset.hasSignature='true';if(onChange)onChange()}down=false;last=null;changed=false};
 canvas.addEventListener('mousedown',start);canvas.addEventListener('mousemove',move);window.addEventListener('mouseup',end);
 canvas.addEventListener('touchstart',start,{passive:false});canvas.addEventListener('touchmove',move,{passive:false});canvas.addEventListener('touchend',end);
}
function setupSignature(box,s,onChange){
 const c=box.querySelector('[data-canvas]'),w=box.querySelector('[data-witness-canvas]');
 const changed=()=>{updateAuditRouteProgress();if(onChange)onChange()};
 setupCanvas(c,s.signature||'',changed);setupCanvas(w,s.witnessSignature||'',changed);
 box.querySelectorAll('[data-expand-signature]').forEach(btn=>btn.onclick=()=>openSignatureCapture(box,btn.dataset.expandSignature,changed));
 box.querySelector('[data-clear-sig]').onclick=()=>{[c,w].forEach(x=>{x.getContext('2d').clearRect(0,0,x.width,x.height);x.dataset.hasSignature='false'});updateAuditRouteProgress();if(onChange)onChange()};
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
 document.querySelectorAll('[data-count-loc]').forEach(i=>{a.counts??={};a.counts[i.dataset.countLoc]??={};a.counts[i.dataset.countLoc][i.dataset.countMed]=Number(i.value||0)});
 a.breakawayTags??={};document.querySelectorAll('[data-tag-loc]').forEach(i=>{a.breakawayTags[i.dataset.tagLoc]??={};a.breakawayTags[i.dataset.tagLoc][i.dataset.tagKind]=i.value.trim()});
 a.attestationText=a.attestationText||FINAL_ATTESTATION;
 a.signatures={};
 document.querySelectorAll('.signature-box').forEach(box=>{const loc=box.dataset.sigLoc,c=box.querySelector('[data-canvas]'),w=box.querySelector('[data-witness-canvas]');a.signatures[loc]={signer:box.querySelector('[data-signer]').value,employeeNumber:box.querySelector('[data-employee-number]')?.value.trim()||'',witness:box.querySelector('[data-witness]').value,witnessEmployeeNumber:box.querySelector('[data-witness-employee-number]')?.value.trim()||'',signature:c.toDataURL(),witnessSignature:w.toDataURL()}});
 a.attestationAccepted=document.getElementById('attestCheck').checked;
 a.attestationName=document.getElementById('attestName').value;
 a.attestationEmployeeNumber=document.getElementById('attestEmployeeNumber')?.value.trim()||'';
 const finalSig=document.getElementById('finalSignatureCanvas');
 a.attestationSignature=finalSig?.dataset.hasSignature==='true'?finalSig.toDataURL():(a.attestationSignature||'');
 return a;
}
function scheduleAuditAutosave(id,immediate=false){
 activeAuditId=id;
 setAutosaveStatus(cloudSession&&navigator.onLine?'Saving live…':'Saving locally…');
 clearTimeout(auditAutosaveTimer);
 auditAutosaveTimer=setTimeout(()=>autosaveAudit(id),immediate?0:150);
}
async function autosaveAudit(id){
 if(auditSaveInFlight||!id)return;
 auditSaveInFlight=true;
 try{
   const a=await getOne('audits',id);if(!a)return;
   collectAuditFromUI(a);a.updatedAt=nowISO();a.lastAutosaveAt=a.updatedAt;
   await put('audits',a);
   await put('meta',{id:'activeAudit',auditId:id,updatedAt:a.updatedAt});
   const t=new Date(a.updatedAt).toLocaleTimeString([], {hour:'numeric',minute:'2-digit',second:'2-digit'});
   setAutosaveStatus(lastCloudWrite==='live'?'Saved live '+t:'Saved locally · sync pending '+t);
 }catch(e){setAutosaveStatus('Save failed — keep this screen open');}
 finally{auditSaveInFlight=false}
}
async function flushAuditAutosave(){
 clearTimeout(auditAutosaveTimer);
 if(activeAuditId&&document.getElementById('auditMonth'))await autosaveAudit(activeAuditId);
}

async function saveAuditFromUI(id,finalize){
 const a=await getOne('audits',id);collectAuditFromUI(a);a.updatedAt=nowISO();
 if(finalize){
   const docs=Array.isArray(a.supportingDocuments)?a.supportingDocuments:[];
   const hasAdminImport=docs.some(d=>String(d.mimeType||'').toLowerCase()==='application/pdf'&&d.storagePath&&Array.isArray(d.administrationRows)&&d.administrationRows.length);
   if(!hasAdminImport){
     const admin=document.querySelector('.mobile-collapsible-admin');
     if(admin){admin.setAttribute('open','');const adminStep=admin.closest('[data-audit-step]');if(adminStep&&window.matchMedia('(max-width:700px)').matches){document.querySelectorAll('[data-audit-step]').forEach(s=>s.classList.remove('active-step'));adminStep.classList.add('active-step')}admin.scrollIntoView({behavior:'smooth',block:'start'})}
     return alert('Administration PDF import is required before finalizing this audit.');
   }
   if(!a.auditorName?.trim())return alert('Auditor name is required in Audit Details.');
   if(!a.auditorEmployeeNumber?.trim())return alert('Auditor employee number is required in Audit Details.');
   if(!a.attestationAccepted||!a.attestationName.trim())return alert('Final attestation and auditor name are required.');
   if(!a.attestationEmployeeNumber?.trim())return alert('Final auditor employee number is required.');
   if(!a.attestationSignature) return alert('Final auditor signature is required.');
   for(const loc of LOCS){
     if(!a.signatures[loc]?.signer?.trim())return alert('Auditor name is required for '+loc+'.');
     if(!a.signatures[loc]?.employeeNumber?.trim())return alert('Auditor employee number is required for '+loc+'.');
     if(!a.signatures[loc]?.witness?.trim())return alert('Witness name is required for '+loc+'.');
     if(!a.signatures[loc]?.witnessEmployeeNumber?.trim())return alert('Witness employee number is required for '+loc+'.');
   }
   a.status='finalized';a.finalizedAt=nowISO();await put('reports',{...a,id:'report_'+a.id,auditId:a.id});
 }
 await put('audits',a);if(finalize){activeAuditId=null;await put('meta',{id:'activeAudit',auditId:'',updatedAt:nowISO()});}await refreshAll();if(finalize)showReport('report_'+a.id);else editAudit(a.id)
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

async function renderReports(){
 let rows=await getAll('reports');
 rows.sort((a,b)=>(b.finalizedAt||'').localeCompare(a.finalizedAt||''));
 const testCard='<div class="list-item test-report-card"><div><span class="test-badge">TEST</span><strong>Test audit report</strong><div class="meta">Synthetic data · safe report-layout preview</div></div><div class="button-row"><button data-test-report="1">View test report</button></div></div>';
 const real=rows.length?rows.map(r=>'<div class="list-item"><strong>'+esc(r.month)+'</strong><div class="meta">Finalized '+fmtDate(r.finalizedAt)+' · '+esc(r.attestationName||'')+'</div><div class="button-row"><button data-report="'+r.id+'">View / print</button></div></div>').join(''):'<div class="card empty">No finalized audits yet.</div>';
 document.getElementById('reportsList').innerHTML=testCard+real;
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
   const close=document.getElementById('closeReport'),print=document.getElementById('printReport');
   if(close)close.onclick=()=>d.close();
   if(print)print.onclick=()=>window.print();
 }catch(err){
   preview.innerHTML='<div class="report-loading">Unable to render the test report.</div>';
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
   d.scrollTop=0;
   const close=document.getElementById('closeReport'),print=document.getElementById('printReport');
   if(close)close.onclick=()=>d.close();
   if(print)print.onclick=()=>window.print();
   requestAnimationFrame(()=>{d.scrollTop=0;preview.scrollTop=0});
 }catch(err){
   preview.innerHTML='<div class="report-loading">Unable to render this report. Close and try again.</div>';
   console.error(err);
 }
 d.onclose=()=>{document.body.classList.remove('report-open');preview.innerHTML='';setTimeout(refreshAll,0)};
}
function reportHtml(r){
 const logo='https://raw.githubusercontent.com/twessel20/Gladstone-AED-Inventory/main/gfd-patch.jpg';
 const recordNo=r.legacyRecordNumber||String(r.auditId||r.id||'').match(/\d+/)?.[0]||'';
 const activeTotal=m=>['Medic 1','Medic 2','Medic 3','Safe'].reduce((n,l)=>n+Number(r.counts?.[l]?.[m]||0),0);
 const amendment=(r.amendments||[]).map(a=>'<div class="report-amendment-row"><b>'+esc(a.location)+' · '+esc(a.medication)+':</b> '+esc(a.from)+' → '+esc(a.to)+' '+esc(a.unit||'')+'. '+esc(a.reason||'')+(a.recordedAt?' Recorded '+esc(a.recordedAt):'')+(a.recordedBy?' by '+esc(a.recordedBy):'')+'.</div>').join('');
 const tagRows=LOCS.map(l=>{const t=r.breakawayTags?.[l]||{};return '<tr><td>'+esc(l)+'</td><td>'+esc(t.foundRemoved||'—')+'</td><td><b>'+esc(t.newInstalled||'—')+'</b></td></tr>'}).join('');
 const txs=Array.isArray(r.transactions)?r.transactions:[];
 const txRows=txs.length?txs.map(t=>'<tr><td>'+esc(t.date||t.timestamp||'')+'</td><td>'+esc(t.typeLabel||t.type||t.action||'')+'</td><td>'+esc(t.medication||'')+'</td><td>'+esc(t.quantity||'')+'</td><td>'+esc((t.fromLocation||'')+(t.toLocation?' → '+t.toLocation:''))+'</td><td>'+esc(t.reference||t.vendor||t.incident||t.lot||'')+'</td></tr>').join(''):'<tr><td colspan="6" class="report-empty">No transactions recorded during this month.</td></tr>';
 const sigCard=(loc)=>{
   const x=r.signatures?.[loc]||{};
   const explicit=r.isTest;
   return '<section class="report-cert'+(explicit?' report-cert-explicit':'')+'"><h2>'+esc(loc)+' certification</h2>'+
   (explicit?'<div class="report-cert-site"><span>AUDIT SITE</span><strong>'+esc(loc)+'</strong></div><p class="report-cert-statement">These signatures certify the <b>'+esc(loc)+'</b> physical inventory count and seal record documented in this audit.</p>':'<p>Auditor: physical count and seal entries certified. Witness: personally observed and verified this count and seal record.</p>')+
   '<div class="report-signature-grid"><div class="report-signature-box">'+
   (explicit?'<div class="report-signature-site">'+esc(loc)+' — Auditor certification</div>':'')+
   '<div class="report-signature-label">AUDITOR SIGNATURE</div>'+(x.signature?'<img src="'+x.signature+'" alt="'+esc(loc)+' auditor signature">':'<div class="report-signature-placeholder"></div>')+'<div class="report-signature-name">'+esc(x.signer||'')+(x.employeeNumber?' · Employee #'+esc(x.employeeNumber):'')+'</div></div><div class="report-signature-box">'+
   (explicit?'<div class="report-signature-site">'+esc(loc)+' — Witness certification</div>':'')+
   '<div class="report-signature-label">WITNESS SIGNATURE</div>'+(x.witnessSignature?'<img src="'+x.witnessSignature+'" alt="'+esc(loc)+' witness signature">':'<div class="report-signature-placeholder"></div>')+'<div class="report-signature-name">'+esc(x.witness||'')+(x.witnessEmployeeNumber?' · Employee #'+esc(x.witnessEmployeeNumber):'')+'</div></div></div></section>';
 };
 const sourceDoc=(r.supportingDocuments||[])[0];
 return '<div class="report-sheet report-finalized">'+
 '<div class="report-toolbar"><button id="closeReport">Close</button><button id="printReport" class="primary">Print / Save PDF</button></div>'+
 '<header class="report-top"><img src="'+logo+'" alt="Gladstone Fire Department patch"><div><div class="report-kicker">FINALIZED MONTHLY RECORD</div><h1>Gladstone Fire Department Narcotic<br>Inventory / Audit Form</h1></div></header>'+
 '<div class="report-meta-grid"><div><b>Audit month:</b> '+esc(r.month||'')+'</div><div><b>Created:</b> '+esc(r.createdDisplay||fmtDate(r.createdAt)||'')+'</div><div><b>Email:</b> '+esc(r.email||'travisw@gladstone.mo.us')+'</div><div></div><div><b>Date of audit:</b> '+esc(r.auditDate||'')+'</div><div></div><div class="wide"><b>Audit period:</b> '+esc(r.dateRangeStart||'—')+' through '+esc(r.dateRangeEnd||'—')+' (both dates included)</div></div>'+
 '<hr class="report-blue-rule">'+
 (amendment?'<section class="report-amendment"><h2>Amended inventory record — correction history</h2><p>The table below includes these corrections. Signatures were recorded before these amendments and certify the original record, not the corrected entries.</p>'+amendment+'</section>':'')+
 '<section><h2>Inventory comparison</h2><table class="report-table report-inventory"><thead><tr><th>Medication</th>'+LOCS.map(l=>'<th>'+esc(l)+'<small>Last / Current</small></th>').join('')+'<th>Active total</th></tr></thead><tbody>'+MEDS.map(m=>'<tr><td>'+esc(m)+'</td>'+LOCS.map(l=>{const p=r.priorCounts?.[l]?.[m];return '<td>'+(p==null?'—':Number(p))+' / <b>'+Number(r.counts?.[l]?.[m]||0)+'</b></td>'}).join('')+'<td><b>'+activeTotal(m)+'</b></td></tr>').join('')+'</tbody></table></section>'+
 '<section><h2>Breakaway tag record</h2><table class="report-table"><thead><tr><th>Location</th><th>Tag found / removed</th><th>New tag installed</th></tr></thead><tbody>'+tagRows+'</tbody></table></section>'+
 '<section><h2>Narcotic usage exports</h2><p>Reference documents only. Monthly inventory totals are the manually verified physical counts; usage exports do not calculate expected counts or variances.</p>'+(sourceDoc?'<p><u>'+esc(sourceDoc.name)+'</u> — uploaded '+esc(sourceDoc.uploadedAt||'')+(sourceDoc.uploadedBy?' by '+esc(sourceDoc.uploadedBy):'')+'</p>':'')+'<p class="report-note">Uploaded PDFs are separate supporting documents; open each attachment to print its contents.</p></section>'+
 (r.isTest&&Array.isArray(r.administrationRows)&&r.administrationRows.length?
 '<section class="report-imported-admin"><h2>Imported narcotic administrations</h2><p class="report-note">Source doses are shown as imported. Vial use below is calculated from the department vial rules for reconciliation.</p>'+
 '<table class="report-table"><thead><tr><th>Date</th><th>Report</th><th>Provider</th><th>Medication</th><th>Dose</th><th>Unit</th></tr></thead><tbody>'+
 r.administrationRows.map(x=>'<tr><td>'+esc(formatAdminDate(x.date))+'</td><td>'+esc(x.report)+'</td><td>'+esc(x.provider)+'</td><td>'+esc(x.medication)+'</td><td><b>'+esc(x.dose)+' '+esc(adminDoseUnit(x.medication))+'</b></td><td>'+esc(String(x.unit||'').replace(/^M([123])$/,'Medic $1'))+'</td></tr>').join('')+
 '</tbody></table>'+
 '<div class="report-usage-summary report-vial-summary"><div class="report-vial-summary-title">Calculated vial use by provider</div>'+
 providerVialData(r.administrationRows).providers.map(([provider,items])=>{const total=items.reduce((n,x)=>n+x.vials,0);return '<div class="report-vial-row"><span>'+esc(provider)+'</span><strong>'+total+' vial'+(total===1?'':'s')+'</strong></div>'}).join('')+
 '<div class="report-vial-total"><span>Total calculated vials</span><strong>'+providerVialData(r.administrationRows).total+'</strong></div></div></section>':'')+'<section><h2>Transactions in the audit reporting period</h2><table class="report-table report-transactions"><thead><tr><th>Date</th><th>Action</th><th>Medication</th><th>Qty</th><th>Movement</th><th>Vendor / incident / lot</th></tr></thead><tbody>'+txRows+'</tbody></table></section>'+
 sigCard('Medic 1')+sigCard('Medic 2')+sigCard('Medic 3')+sigCard('Safe')+sigCard('Expired')+
 '<section class="report-attestation"><h2>Final overall controlled-substance audit attestation</h2><p>'+esc(r.attestationText||FINAL_ATTESTATION).replace(/\n/g,'<br>')+'</p><div class="report-final-signature"><div class="report-signature-label">FINAL CERTIFYING AUDITOR SIGNATURE</div>'+(r.attestationSignature?'<img src="'+r.attestationSignature+'" alt="Final certifying auditor signature">':'')+'<div class="report-signature-name">'+esc(r.attestationName||'')+(r.attestationEmployeeNumber?' · Employee #'+esc(r.attestationEmployeeNumber):'')+'</div></div></section>'+
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
   return /finalized|finalizedat|report|certification/.test(keys) && /audit|signature|inventory|attestation/.test(keys);
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
function fillSelects(){document.querySelector('select[name=medication]').innerHTML=MEDS.map(x=>'<option>'+x+'</option>').join('');['fromLocation','toLocation'].forEach(n=>document.querySelector('select[name='+n+']').innerHTML='<option value="">—</option>'+LOCS.map(x=>'<option>'+x+'</option>').join(''))}
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
 document.getElementById('newTxBtn').onclick=()=>document.getElementById('txDialog').showModal();
 document.getElementById('saveTxBtn').onclick=async e=>{e.preventDefault();try{await saveTransaction(new FormData(document.getElementById('txForm')));document.getElementById('txDialog').close();document.getElementById('txForm').reset()}catch(err){alert(err.message)}};
 document.getElementById('activitySearch').oninput=renderActivity;document.getElementById('exportActivityBtn').onclick=exportActivity;document.getElementById('newAuditBtn').onclick=startAudit;
 document.getElementById('auditWorkspace').onclick=async e=>{const b=e.target.closest('[data-audit-action]');if(!b)return;if(b.dataset.auditAction==='open')editAudit(b.dataset.id);if(b.dataset.auditAction==='delete'&&confirm('Delete this audit draft?')){await del('audits',b.dataset.id);renderAudits()}};
 document.getElementById('reportsList').onclick=async e=>{
   const test=e.target.closest('[data-test-report]');
   if(test){await showTestReport();return}
   const b=e.target.closest('[data-report]');
   if(b)await showReport(b.dataset.report);
 };
 document.getElementById('exportBtn').onclick=exportBackup;document.getElementById('importBtn').onclick=()=>{if(requireCloudAuth())document.getElementById('importFile').click()};document.getElementById('importFile').onchange=async e=>{if(!e.target.files[0])return;try{await importBackup(e.target.files[0]);await flushPendingWrites()}catch(err){alert(err.message)}};
 const authDialog=document.getElementById('authDialog'),authForm=document.getElementById('authForm'),authMsg=document.getElementById('authMessage');
 document.getElementById('accountBtn').onclick=async()=>{if(cloudSession){if(confirm('Sign out of the live narcotic database?'))await sb.auth.signOut()}else authDialog.showModal()};
 authForm.onsubmit=async e=>{e.preventDefault();authMsg.hidden=true;const email=document.getElementById('authEmail').value.trim(),password=document.getElementById('authPassword').value;const {error}=await sb.auth.signInWithPassword({email,password});if(error){authMsg.textContent=error.message;authMsg.hidden=false}else authDialog.close()};
 document.getElementById('createAccountBtn').onclick=async()=>{authMsg.hidden=true;const email=document.getElementById('authEmail').value.trim(),password=document.getElementById('authPassword').value;if(!email||password.length<8){authMsg.textContent='Enter a valid email and a password of at least 8 characters.';authMsg.hidden=false;return}const {data,error}=await sb.auth.signUp({email,password});authMsg.textContent=error?error.message:(data.session?'Account created and signed in.':'Account created. Check your email if confirmation is required, then sign in.');authMsg.hidden=false;if(data.session)setTimeout(()=>authDialog.close(),700)};
 const status=async()=>{const el=document.getElementById('offlineBadge');if(navigator.onLine){el.textContent=cloudSession?'Live sync':'Online · sign in';el.style.background=cloudSession?'#1f6e4d':'#31566f';await flushPendingWrites()}else{el.textContent='Offline · queued';el.style.background='#7a4a1f'}};window.addEventListener('online',status);window.addEventListener('offline',status);status()
}
window.addEventListener('pagehide',()=>{if(activeAuditId)scheduleAuditAutosave(activeAuditId)});
document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='hidden'&&activeAuditId)flushAuditAutosave()});
(async()=>{await openDB();await initCloud();await seedInventory();fillSelects();bind();await refreshAll();if(!cloudSession)setTimeout(()=>document.getElementById('authDialog')?.showModal(),300);const active=await getOne('meta','activeAudit');if(active?.auditId){await put('meta',{id:'activeAudit',auditId:'',updatedAt:nowISO()});activeAuditId=null;await renderAudits()}if('serviceWorker'in navigator)navigator.serviceWorker.register('./sw.js')})();