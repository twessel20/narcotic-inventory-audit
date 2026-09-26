const MEDS=['Fentanyl 100 mcg','Versed 2 mg','Versed 5 mg','Ketamine 500 mg','Morphine 10 mg'];
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
 const [b,reports]=await Promise.all([balances(),getAll('reports')]);
 const finalized=[...(reports||[])].filter(r=>String(r.status||'finalized').toLowerCase()==='finalized');
 finalized.sort((a,b)=>String(b.finalizedAt||b.auditDate||b.createdAt||'').localeCompare(String(a.finalizedAt||a.auditDate||a.createdAt||'')));
 const lastAudit=finalized[0]||null;
 const lastAuditDate=lastAudit?formatDisplayDate(lastAudit.auditDate||lastAudit.finalizedAt||lastAudit.createdAt):'';
 const basisText=lastAuditDate
   ?'Physical inventory was last verified '+lastAuditDate+'. Active stock may have changed since that physical audit. Displayed balances reflect the last finalized audit adjusted only by inventory transactions recorded in this system after that date.'
   :'No finalized physical audit is on file. Displayed balances reflect recorded inventory data only and should not be interpreted as a verified physical count.';
 const totalBasis=document.getElementById('inventoryBalanceAsOf');
 if(totalBasis)totalBasis.textContent=basisText;
 grid.innerHTML=LOCS.map(loc=>'<div class="location-card"><h3><span>'+loc+'</span><span class="pill '+(loc==='Expired'?'expired':'')+'">'+(loc==='Expired'?'Segregated':'Active')+'</span></h3><div class="location-card-meta">'+esc(lastAuditDate?'Last physical audit: '+lastAuditDate:'No finalized physical audit on file')+'</div>'+MEDS.map(m=>'<div class="med-row"><span>'+m+'</span><strong>'+b[loc][m]+'</strong></div>').join('')+'</div>').join('');
 totals.innerHTML=MEDS.map(m=>{const t=['Medic 1','Medic 2','Medic 3','Safe'].reduce((a,l)=>a+b[l][m],0);return '<div class="total-row"><div><b>'+m+'</b><small>Medic 1 + Medic 2 + Medic 3 + Safe</small></div><strong>'+t+'</strong></div>'}).join('');
}

async function renderActivity(){
 const q=(document.getElementById('activitySearch')?.value||'').toLowerCase();
 let rows=await getAll('transactions');
 rows.sort((a,b)=>String(b.timestamp||'').localeCompare(String(a.timestamp||'')));
 if(q)rows=rows.filter(r=>JSON.stringify(r).toLowerCase().includes(q));
 document.getElementById('activityList').innerHTML=rows.length?rows.map(r=>{
   const items=Array.isArray(r.items)&&r.items.length?r.items:[{medication:r.medication,quantity:r.quantity}];
   const itemText=items.map(x=>esc(x.medication)+' × '+esc(x.quantity)).join(' · ');
   return '<div class="list-item"><strong>'+esc(r.typeLabel||r.type)+(r.status==='draft'?' · DRAFT':'')+'</strong><div>'+itemText+'</div><div>'+esc(r.sourcePharmacy||r.externalSource||r.incidentSourceLocation||r.fromLocation||'—')+' → '+esc(r.toLocation||'—')+'</div><div class="meta">'+fmtDate(r.timestamp)+(r.recordedBy?' · '+esc(r.recordedBy)+(r.recordedByEmployeeNumber?' #'+esc(r.recordedByEmployeeNumber):''):'')+(r.witness?' · Witness '+esc(r.witness)+(r.witnessEmployeeNumber?' #'+esc(r.witnessEmployeeNumber):''):'')+'</div>'+(r.summary?'<div>'+esc(r.summary)+'</div>':'')+(Array.isArray(r.inventoryImpact)&&r.inventoryImpact.length?'<div class="meta">'+r.inventoryImpact.map(x=>esc(x.location+' · '+x.medication+': '+x.before+' → '+x.after)).join('<br>')+'</div>':'')+(r.notes?'<div>'+esc(r.notes)+'</div>':'')+(r.memoDescription?'<div class="meta"><b>Memo description:</b> '+esc(r.memoDescription)+'</div>':'')+(r.supportingDocument?'<div class="meta"><b>'+esc(r.supportingDocument.documentType||'Supporting PDF')+':</b> '+esc(r.supportingDocument.name||'Attached PDF')+'</div>':'')+(r.destructionReceipt?'<div class="meta"><b>Destruction receipt:</b> '+esc(r.destructionReceipt.name||'Attached PDF')+'</div>':'')+(r.type==='incident'&&r.status==='draft'?'<div class="button-row"><button type="button" data-resume-incident="'+esc(r.id)+'">Resume incident</button></div>':'')+'</div>';
 }).join(''):'<div class="empty">No activity recorded yet.</div>';
}

async function saveTransaction(fd,finalSubmit=true){
 if(!requireCloudAuth())throw new Error('Sign in is required for live inventory changes.');

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
   if(!recordedByEmployeeNumber)throw new Error('Enter the recorded-by employee number.');
   if(!witness)throw new Error('Enter the witness.');
   if(!witnessEmployeeNumber)throw new Error('Enter the witness employee number.');
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
 const counts={},priorCounts={},openingCounts={};LOCS.forEach(l=>{counts[l]={};priorCounts[l]={};openingCounts[l]={};MEDS.forEach(m=>{counts[l][m]=null;openingCounts[l][m]=b[l][m];priorCounts[l][m]=previous?.counts?.[l]?.[m]??null})});
 const localDate=d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0');
 const a={id:uid('audit'),month,status:'draft',createdAt:nowISO(),updatedAt:nowISO(),auditDate:localDate,email:cloudSession?.user?.email||'',counts,priorCounts,openingCounts,dateRangeStart:'',dateRangeEnd:'',notes:'',usageSummary:'',breakawayTags:{},supportingDocuments:[],administrationRows:[],incidents:[],inventoryFindings:[],signatures:{},auditorName:'',auditorEmployeeNumber:'',attestationText:FINAL_ATTESTATION,attestationName:'',attestationEmployeeNumber:'',attestationAccepted:false};
 await put('audits',a);await put('meta',{id:'activeAudit',auditId:a.id,updatedAt:nowISO()});await editAudit(a.id)
}
function unitAuditSection(a,loc,index){
 const tag=a.breakawayTags?.[loc]||{},savedSig=a.signatures?.[loc]||{};
 const sig={...savedSig,signer:savedSig.signer||a.auditorName||'',employeeNumber:savedSig.employeeNumber||a.auditorEmployeeNumber||''};
 const medRows=MEDS.map(m=>{const p=a.priorCounts?.[loc]?.[m];const findingBtn=loc==='Expired'?'':'<button type="button" class="audit-finding-btn" data-audit-finding data-loc="'+esc(loc)+'" data-med="'+esc(m)+'">Record audit finding</button>';return '<div class="unit-med-row compact"><div class="unit-med-name">'+esc(m)+'</div><div class="unit-prior"><span>Last</span><strong>'+(p==null?'—':Number(p))+'</strong></div><label class="unit-current"><span>Current</span><input aria-label="'+m+' '+loc+' current count" type="number" min="0" step="1" inputmode="numeric" data-count-loc="'+loc+'" data-count-med="'+m+'" value="'+((a.counts?.[loc]?.[m]===null||a.counts?.[loc]?.[m]===undefined)?'':Number(a.counts[loc][m]))+'" required></label><div class="unit-med-actions">'+findingBtn+'<button type="button" class="audit-incident-btn" data-audit-incident data-loc="'+esc(loc)+'" data-med="'+esc(m)+'">Discrepancy / incident</button></div></div>'}).join('');
 return '<section class="audit-card unit-audit-card compact-unit" data-unit-section="'+esc(loc)+'">'+
 '<div class="unit-audit-head compact-head"><div><span class="kicker">LOCATION '+(index+1)+' OF '+LOCS.length+'</span><h3>'+esc(loc)+'</h3></div><span class="unit-step-badge">'+esc(loc)+'</span></div>'+
 '<div class="unit-compact-grid">'+
 '<div class="unit-compact-panel seal-panel"><h4>Seals</h4><div class="tag-entry-fields seal-pair"><label>Tag found / removed<input inputmode="numeric" autocomplete="off" placeholder="Tag #" data-tag-loc="'+loc+'" data-tag-kind="foundRemoved" aria-label="'+loc+' tag found or removed" value="'+esc(tag.foundRemoved||'')+'"></label><label>New tag installed<input inputmode="numeric" autocomplete="off" placeholder="Tag #" data-tag-loc="'+loc+'" data-tag-kind="newInstalled" aria-label="'+loc+' new tag installed" value="'+esc(tag.newInstalled||'')+'"></label></div></div>'+
 '<div class="unit-compact-panel inventory-panel"><div class="inventory-panel-head"><h4>Physical inventory</h4><span class="inventory-panel-help">Count each vial physically present at this location.</span></div><div class="unit-med-list">'+medRows+'</div></div>'+
 '<div class="unit-compact-panel certification-panel"><h4>Certification</h4>'+sigBlock(loc,sig,true)+'</div>'+
 '</div></section>';
}
function sigBlock(loc,s={},embedded=false){return '<div class="signature-box audit-signature-block'+(embedded?' embedded-signature':'')+'" data-sig-loc="'+loc+'">'+(!embedded?'<div class="signature-location">'+loc+'</div>':'')+'<div class="audit-signature-cards">'+
'<section class="audit-signature-card auditor-card"><div class="audit-signature-card-head"><strong>Auditor</strong><span>Certification signature</span></div><div class="audit-signature-fields"><label>Name<input placeholder="Full name" data-signer value="'+esc(s.signer||'')+'"></label><label>Employee number<input placeholder="Employee #" inputmode="numeric" autocomplete="off" data-employee-number value="'+esc(s.employeeNumber||'')+'"></label></div><div class="audit-signature-canvas-wrap"><canvas width="500" height="150" data-canvas></canvas></div><div class="audit-signature-actions"><button type="button" class="clear-signature-btn" data-clear-signature="auditor">Clear</button><button type="button" class="expand-signature" data-expand-signature="auditor">Open larger</button></div></section>'+
'<section class="audit-signature-card witness-card"><div class="audit-signature-card-head"><strong>Witness</strong><span>Certification signature</span></div><div class="audit-signature-fields"><label>Name<input placeholder="Full name" data-witness value="'+esc(s.witness||'')+'"></label><label>Employee number<input placeholder="Employee #" inputmode="numeric" autocomplete="off" data-witness-employee-number value="'+esc(s.witnessEmployeeNumber||'')+'"></label></div><div class="audit-signature-canvas-wrap"><canvas width="500" height="150" data-witness-canvas></canvas></div><div class="audit-signature-actions"><button type="button" class="clear-signature-btn" data-clear-signature="witness">Clear</button><button type="button" class="expand-signature" data-expand-signature="witness">Open larger</button></div></section>'+
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
function formatAdminDate(v){return formatDisplayDate(v)}
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
 '<div class="audit-step-card active-step" data-audit-step="0" data-step-title="Audit details"><div class="audit-card audit-hero"><div class="audit-header"><div><span class="kicker">DRAFT AUDIT</span><h2>'+esc(a.month)+'</h2><div class="audit-header-meta"><span id="autosaveStatus" class="autosave-status">Saved '+fmtDate(a.updatedAt)+'</span><span class="audit-status-chip">'+esc(a.status||'draft')+'</span></div></div><button id="backAudits" class="audit-back-btn">Back to drafts</button></div><div class="form-grid audit-meta-grid"><label>Audit month / year<input id="auditMonthPicker" type="month" value="'+esc((a.monthValue||'')||monthTextToValue(a.month||''))+'"><input id="auditMonth" type="hidden" value="'+esc(a.month||'')+'"></label><label>Date of audit<input id="auditDate" type="date" value="'+esc(a.auditDate||'')+'"></label><label>Auditor email<input id="auditEmail" type="email" value="'+esc(a.email||cloudSession?.user?.email||'')+'"></label><label class="audit-primary-auditor">Auditor name<input id="auditAuditorName" placeholder="Full name" autocomplete="name" value="'+esc(a.auditorName||a.attestationName||'')+'"></label><label class="audit-primary-auditor">Employee number<input id="auditAuditorEmployeeNumber" placeholder="Employee #" inputmode="numeric" autocomplete="off" value="'+esc(a.auditorEmployeeNumber||a.attestationEmployeeNumber||'')+'"></label><div class="audit-period-heading"><strong>Audit period</strong><span>Enter the exact date range covered by this audit.</span></div><label>Period start<input id="auditStart" type="date" value="'+esc(a.dateRangeStart||'')+'"></label><label>Period end<input id="auditEnd" type="date" value="'+esc(a.dateRangeEnd||'')+'"></label></div></div></div>'+
 '<div class="audit-step-card" data-audit-step="1" data-step-title="Administration import">'+administrationImportSection(a)+'</div>'+
 LOCS.map((l,i)=>'<div class="audit-step-card" data-audit-step="'+(i+2)+'" data-step-title="'+esc(l)+'" id="unit-'+i+'">'+unitAuditSection(a,l,i)+'</div>').join('')+
 '<div class="audit-step-card" data-audit-step="'+(LOCS.length+2)+'" data-step-title="Audit notes"><div class="audit-card audit-section-card"><span class="kicker">DOCUMENTATION</span><h3>Overall audit notes</h3><textarea id="auditNotes" rows="6" placeholder="Document discrepancies, corrective actions, or other audit notes.">'+esc(a.notes||'')+'</textarea></div></div>'+
 '<div class="audit-step-card" data-audit-step="'+(LOCS.length+3)+'" data-step-title="Final Certification"><div class="audit-card audit-section-card attestation-card"><span class="kicker">FINAL CERTIFICATION</span><h3>Final attestation</h3><p>'+esc(a.attestationText||FINAL_ATTESTATION)+'</p><label class="attest-check"><input id="attestCheck" type="checkbox" '+(a.attestationAccepted?'checked':'')+'> <span>I certify this audit.</span></label><div class="final-auditor-grid"><label class="final-signer-label">Final auditor name<input id="attestName" placeholder="Full name" value="'+esc(a.attestationName||a.auditorName||'')+'"></label><label class="final-signer-label">Employee number<input id="attestEmployeeNumber" placeholder="Employee #" inputmode="numeric" value="'+esc(a.attestationEmployeeNumber||a.auditorEmployeeNumber||'')+'"></label></div><div class="final-signature-block"><div class="signature-label-row"><div class="signature-label">Final auditor signature</div><div class="button-row"><button type="button" id="clearFinalSignature">Clear</button><button type="button" class="expand-signature" id="expandFinalSignature">Open larger</button></div></div><canvas id="finalSignatureCanvas" width="500" height="150"></canvas></div><div class="audit-actions"><button id="saveAudit">Save draft</button><button class="primary" id="finalizeAudit">Finalize audit</button></div></div></div>'+
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
   const clearBtn=document.getElementById('clearFinalSignature');
   if(btn)btn.onclick=()=>openStandaloneSignatureCapture(finalSigCanvas,'Final auditor signature',()=>scheduleAuditAutosave(a.id,true));
   if(clearBtn)clearBtn.onclick=()=>{
     finalSigCanvas.getContext('2d').clearRect(0,0,finalSigCanvas.width,finalSigCanvas.height);
     finalSigCanvas.dataset.hasSignature='false';
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
   const sourceBefore=Number(sourceInput?.value||0);
   const expiredBefore=Number(expiredInput?.value||0);
   const sourceAfter=Math.max(0,sourceBefore-qty);
   const expiredAfter=expiredBefore+(retained?qty:0);

   if(findingContext)findingContext.innerHTML='<strong>'+esc(loc)+' · '+esc(med)+'</strong><span>Current audit count: '+sourceBefore+' vial'+(sourceBefore===1?'':'s')+'</span>';
   if(findingImpact){
     findingImpact.innerHTML=
       '<div><span>'+esc(loc)+'</span><strong>'+sourceBefore+' → '+sourceAfter+'</strong></div>'+
       '<div><span>Expired inventory</span><strong>'+expiredBefore+' → '+expiredAfter+'</strong></div>'+
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

   const available=Number(sourceInput.value||0);
   if(qty>available)return alert('Quantity exceeds the current '+loc+' audit count for '+med+'.');

   sourceInput.value=String(available-qty);
   if(physicalRetained)expiredInput.value=String(Number(expiredInput.value||0)+qty);

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
 updateAuditRouteProgress();
 setAutosaveStatus('Saved '+fmtDate(a.updatedAt));
}
async function enterSignatureLandscape(dialog){
 const mobile=window.matchMedia('(max-width:900px)').matches;
 if(!mobile||!dialog)return;
 dialog.classList.add('signature-landscape-mode');

 const syncLandscapeState=()=>{
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

 try{
   if(document.fullscreenElement!==dialog&&dialog.requestFullscreen)await dialog.requestFullscreen({navigationUI:'hide'});
 }catch(e){}
 try{
   if(screen.orientation?.lock)await screen.orientation.lock('landscape');
 }catch(e){}
 setTimeout(syncLandscapeState,120);
}
async function exitSignatureLandscape(dialog){
 if(dialog){
   dialog.classList.remove('signature-landscape-mode','is-landscape','is-portrait');
   const handler=dialog._signatureOrientationHandler;
   if(handler){
     window.removeEventListener('resize',handler);
     window.removeEventListener('orientationchange',handler);
     if(window.visualViewport)window.visualViewport.removeEventListener('resize',handler);
     delete dialog._signatureOrientationHandler;
   }
 }
 try{if(screen.orientation?.unlock)screen.orientation.unlock();}catch(e){}
 try{if(document.fullscreenElement===dialog&&document.exitFullscreen)await document.exitFullscreen();}catch(e){}
}

function openSignatureCapture(box,kind,onChange){
 const source=kind==='witness'?box.querySelector('[data-witness-canvas]'):box.querySelector('[data-canvas]');
 if(!source)return;
 let dialog=document.getElementById('signatureCaptureDialog');
 if(!dialog){
   dialog=document.createElement('dialog');
   dialog.id='signatureCaptureDialog';
   dialog.className='signature-capture-dialog';
   dialog.innerHTML='<div class="signature-capture-shell"><div class="signature-capture-head"><div><span class="kicker">SIGNATURE CAPTURE</span><h2 id="signatureCaptureTitle">Signature</h2></div><button type="button" id="signatureCaptureClose">Done</button></div><div class="signature-capture-hint">Opening landscape signing mode…</div><canvas id="signatureCaptureCanvas" width="1200" height="500"></canvas><div class="signature-capture-actions"><button type="button" id="signatureCaptureClear">Clear</button><button type="button" class="primary" id="signatureCaptureSave">Use signature</button></div></div>';
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
 dialog.querySelector('#signatureCaptureSave').onclick=async()=>{apply();await exitSignatureLandscape(dialog);dialog.close()};
 dialog.querySelector('#signatureCaptureClose').onclick=async()=>{apply();await exitSignatureLandscape(dialog);dialog.close()};
 dialog.showModal();
 enterSignatureLandscape(dialog);
 setTimeout(()=>dialog.scrollTop=0,0);
}
function openStandaloneSignatureCapture(source,titleText,onChange){
 if(!source)return;
 let dialog=document.getElementById('signatureCaptureDialog');
 if(!dialog){
   dialog=document.createElement('dialog');
   dialog.id='signatureCaptureDialog';
   dialog.className='signature-capture-dialog';
   dialog.innerHTML='<div class="signature-capture-shell"><div class="signature-capture-head"><div><span class="kicker">SIGNATURE CAPTURE</span><h2 id="signatureCaptureTitle">Signature</h2></div><button type="button" id="signatureCaptureClose">Done</button></div><div class="signature-capture-hint">Opening landscape signing mode…</div><canvas id="signatureCaptureCanvas" width="1200" height="500"></canvas><div class="signature-capture-actions"><button type="button" id="signatureCaptureClear">Clear</button><button type="button" class="primary" id="signatureCaptureSave">Use signature</button></div></div>';
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
 dialog.querySelector('#signatureCaptureSave').onclick=async()=>{apply();await exitSignatureLandscape(dialog);dialog.close()};
 dialog.querySelector('#signatureCaptureClose').onclick=async()=>{apply();await exitSignatureLandscape(dialog);dialog.close()};
 dialog.showModal();
 enterSignatureLandscape(dialog);
}
document.addEventListener('cancel',e=>{
 const d=e.target;
 if(d?.id==='signatureCaptureDialog')exitSignatureLandscape(d);
},true);
document.addEventListener('close',e=>{
 const d=e.target;
 if(d?.id==='signatureCaptureDialog')exitSignatureLandscape(d);
},true);

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
 box.querySelectorAll('[data-clear-signature]').forEach(btn=>btn.onclick=()=>{
   const target=btn.dataset.clearSignature==='witness'?w:c;
   if(!target)return;
   target.getContext('2d').clearRect(0,0,target.width,target.height);
   target.dataset.hasSignature='false';
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
 document.querySelectorAll('[data-count-loc]').forEach(i=>{a.counts??={};a.counts[i.dataset.countLoc]??={};a.counts[i.dataset.countLoc][i.dataset.countMed]=i.value===''?null:Number(i.value)});
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
   if(!a.dateRangeStart||!a.dateRangeEnd)return alert('Audit period start and end dates are required before finalizing.');
   if(a.dateRangeStart>a.dateRangeEnd)return alert('Audit period start date cannot be after the end date.');
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
 try{vialTotal=adminRows.length?providerVialData(adminRows).total:0}catch(e){vialTotal=null}
 const providerCount=new Set(adminRows.map(x=>String(x.provider||'').trim()).filter(Boolean)).size;

 return '<div class="report-sheet report-finalized annual-report">'+
 '<div class="report-toolbar"><button id="closeReport">Close</button><button id="previewPdfReport">Generate PDF Preview</button><button id="shareReport">Share PDF</button><button id="printReport" class="primary">Print / Save PDF</button></div>'+
 '<section class="report-cover-page annual-cover">'+
 '<div class="report-cover-brand"><img src="https://raw.githubusercontent.com/twessel20/Gladstone-AED-Inventory/main/gfd-patch.jpg" alt="Gladstone Fire Department patch"><div class="report-cover-dept">GLADSTONE FIRE DEPARTMENT</div></div>'+
 '<div class="report-cover-main"><div class="report-cover-kicker">YEAR-END CONTROLLED-SUBSTANCE REVIEW</div><h1>Narcotic Inventory / Audit<br>Annual Summary</h1><div class="report-cover-month">'+year+'</div></div>'+
 '<div class="report-cover-meta"><div><span>Monthly reports included</span><strong>'+reports.length+'</strong></div><div><span>First audit</span><strong>'+esc(reportShareDate(first?.auditDate||first?.finalizedAt)||'—')+'</strong></div><div><span>Last audit</span><strong>'+esc(reportShareDate(last?.auditDate||last?.finalizedAt)||'—')+'</strong></div><div><span>Generated</span><strong>'+esc(formatDisplayDate(new Date()))+'</strong></div></div>'+
 '<div class="report-cover-footer">Gladstone Fire Department · Year-End Narcotic Inventory / Audit Summary</div></section>'+
 '<section class="report-executive-summary"><h2>Year-end audit summary</h2>'+
 '<p>This summary is calculated from finalized monthly audit reports stored for '+year+'. It does not infer missing months or values.</p>'+
 '<ul>'+
 '<li><b>Finalized monthly audits:</b> '+reports.length+'.</li>'+
 '<li><b>Imported administration activity:</b> '+adminRows.length+' source dose row'+(adminRows.length===1?'':'s')+' across '+providerCount+' provider'+(providerCount===1?'':'s')+(vialTotal!==null?', calculating to '+vialTotal+' vial'+(vialTotal===1?'':'s'):'')+'.</li>'+
 '<li><b>Certification coverage:</b> '+certifiedSites+' of '+totalSites+' location Certification blocks contain auditor/witness identification and both signatures.</li>'+
 '<li><b>Recorded amendments:</b> '+amendments+'.</li>'+
 '</ul></section>'+
 '<section><h2>Year-start to year-end active inventory</h2><table class="report-table"><thead><tr><th>Medication</th><th>First finalized audit</th><th>Last finalized audit</th><th>Net change</th></tr></thead><tbody>'+
 medSummary.map(x=>'<tr><td>'+esc(x.m)+'</td><td>'+x.first+'</td><td><b>'+x.last+'</b></td><td><b>'+(x.diff>0?'+':'')+x.diff+'</b></td></tr>').join('')+
 '</tbody></table><p class="report-note">Active inventory includes Medic 1, Medic 2, Medic 3, and Safe; Expired inventory is excluded from active totals.</p></section>'+
 '<section><h2>Monthly audit register</h2><table class="report-table"><thead><tr><th>Month</th><th>Audit date</th><th>Auditor</th><th>Administration rows</th><th>Amendments</th></tr></thead><tbody>'+
 sorted.map(r=>'<tr><td>'+esc(r.month||'')+'</td><td>'+esc(reportShareDate(r.auditDate||r.finalizedAt)||'—')+'</td><td>'+esc(r.attestationName||r.auditorName||'—')+'</td><td>'+((r.administrationRows||[]).length)+'</td><td>'+((r.amendments||[]).length)+'</td></tr>').join('')+
 '</tbody></table></section>'+
 (inventoryFindings.length?'<section><h2>Expired / damaged medications found during audits</h2><p class="report-note">These findings were recorded within the live monthly audits. Retained items moved into Expired inventory; damaged vials that could not be physically retained were documented without increasing the Expired physical count. No separate inventory transactions were created.</p><table class="report-table"><thead><tr><th>Month</th><th>Date</th><th>Finding</th><th>Source</th><th>Medication</th><th>Qty</th><th>Notes</th></tr></thead><tbody>'+inventoryFindings.map(x=>'<tr><td>'+esc(x.auditMonth||'')+'</td><td>'+esc(formatDisplayDate(x.recordedAt)||'')+'</td><td>'+esc(x.typeLabel||x.type||'')+'</td><td>'+esc(x.sourceLocation||'')+' → '+esc(x.destinationLocation||'Expired')+'</td><td>'+esc(x.medication||'')+'</td><td>'+esc(x.quantity||'')+'</td><td>'+esc((x.physicalRetained===false?'No physical vial retained. ':'')+(x.note||''))+'</td></tr>').join('')+'</tbody></table></section>':'')+
 '<section><h2>Medication detail by month</h2><table class="report-table"><thead><tr><th>Month</th>'+MEDS.map(m=>'<th>'+esc(m)+'</th>').join('')+'</tr></thead><tbody>'+
 sorted.map(r=>'<tr><td>'+esc(r.month||'')+'</td>'+MEDS.map(m=>'<td>'+activeLocs.reduce((n,l)=>n+Number(r.counts?.[l]?.[m]||0),0)+'</td>').join('')+'</tr>').join('')+
 '</tbody></table></section>'+
 '<footer class="report-footer">Year-end summary · '+year+'</footer></div>';
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
 if(print)print.onclick=()=>shareRenderedReport(preview,shareTitle);
 d.onclose=()=>{document.body.classList.remove('report-open');preview.innerHTML='';setTimeout(refreshAll,0)};
}

async function renderReports(){
 let rows=await getAll('reports');
 rows.sort((a,b)=>(b.finalizedAt||b.auditDate||'').localeCompare(a.finalizedAt||a.auditDate||''));
 const years=[...new Set(rows.map(reportYear).filter(Boolean))].sort((a,b)=>b-a);
 const annual=years.length?'<div class="annual-report-card"><div><span class="kicker">YEAR-END REVIEW</span><h3>Annual summary report</h3><div class="meta">Generate a data-backed summary from finalized monthly audits.</div></div><div class="annual-report-controls"><select id="annualReportYear">'+years.map(y=>'<option value="'+y+'">'+y+'</option>').join('')+'</select><button id="generateAnnualReport">Generate annual report</button></div></div>':'';
 const testCard='<div class="list-item test-report-card"><div><span class="test-badge">TEST</span><strong>Test audit report</strong><div class="meta">Synthetic data · safe report-layout preview</div></div><div class="button-row"><button data-test-report="1">View test report</button></div></div>';
 const real=rows.length?rows.map(r=>'<div class="list-item"><strong>'+esc(r.month)+'</strong><div class="meta">Finalized '+fmtDate(r.finalizedAt)+' · '+esc(r.attestationName||'')+'</div><div class="button-row"><button data-report="'+r.id+'">View / print</button></div></div>').join(''):'<div class="card empty">No finalized audits yet.</div>';
 document.getElementById('reportsList').innerHTML=annual+testCard+real;
 const btn=document.getElementById('generateAnnualReport');
 if(btn)btn.onclick=()=>showAnnualReport(document.getElementById('annualReportYear')?.value);
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
async function appendSupportingPdfs(baseBlob,docs=[]){
 const unique=uniqueSupportingDocuments(docs);
 if(!unique.length)return baseBlob;
 if(!window.PDFLib?.PDFDocument)throw new Error('PDF packet merger is not available.');
 const merged=await window.PDFLib.PDFDocument.load(await baseBlob.arrayBuffer());
 for(const doc of unique){
   const bucket=doc.storageBucket||'audit-supporting-docs';
   const {data,error}=await sb.storage.from(bucket).download(doc.storagePath);
   if(error||!data)throw new Error('Unable to retrieve supporting document: '+(doc.name||'PDF'));
   const src=await window.PDFLib.PDFDocument.load(await data.arrayBuffer());
   const pages=await merged.copyPages(src,src.getPageIndices());
   pages.forEach(p=>merged.addPage(p));
 }
 return new Blob([await merged.save()],{type:'application/pdf'});
}

async function generateRenderedReportPdf(preview,title='Narcotic Inventory Audit Report'){
 const sheet=preview?.querySelector('.report-sheet');
 if(!sheet)throw new Error('Report preview is not ready yet.');
 if(!window.html2pdf)throw new Error('PDF generator is not available.');

 const clone=sheet.cloneNode(true);
 clone.querySelector('.report-toolbar')?.remove();
 clone.querySelector('.test-report-banner')?.remove();
 clone.classList.add('pdf-clean-report');
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

 if(isMonthlyPacket){
   const findSection=label=>[...clone.querySelectorAll('section')].find(s=>
     (s.querySelector(':scope > h2')?.textContent||'').trim().toLowerCase()===label.toLowerCase()
   );
   const makePage=(pageTitle,className,nodes=[])=>{
     const page=document.createElement('section');
     page.className='pdf-packet-page '+className;
     page.innerHTML='<h2 class="pdf-packet-title">'+pageTitle+'</h2>';
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
   const finalRecordFooter=clone.querySelector('.report-footer');

   clearPdfBreaks(cover);
   cover.classList.add('pdf-packet-cover');

   if(executive){
     executive.classList.remove('pdf-executive-page');
     executive.style.breakBefore='auto';
     executive.style.pageBreakBefore='auto';
     executive.style.breakAfter='auto';
     executive.style.pageBreakAfter='auto';
     executive.style.minHeight='0';
   }

   const pages=[cover];

   pages.push(makePage(
     'Finalized Monthly Record / Audit Summary',
     'pdf-monthly-summary-page',
     [reportTop,metaGrid,blueRule,executive]
   ));

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

     addCertPage('Medic 3',[medic3Intro]);
     addCertPage('Safe');

     const expiredIntro=document.createElement('p');
     expiredIntro.className='pdf-expired-explainer';
     expiredIntro.textContent='This page documents the physical count, seal verification, auditor certification, and witness certification for controlled substances placed in the Expired inventory location during this audit.';
     addCertPage('Expired',[expiredIntro]);
   }

   if(attestation){
     removeOwnHeading(attestation);
     pages.push(makePage(
       'Final Controlled-Substance Audit Attestation',
       'pdf-attestation-page',
       [attestation]
     ));
   }

   if(notes||finalRecordFooter){
     removeOwnHeading(notes);
     pages.push(makePage(
       'Audit Notes / Final Record',
       'pdf-notes-page',
       [notes,finalRecordFooter]
     ));
   }

   clone.replaceChildren(...pages.filter(Boolean));
 }else{
   // Annual/legacy output: keep report content intact, but use one clean break system.
   const sections=[...clone.querySelectorAll(':scope > section')];
   sections.forEach((section,index)=>{
     clearPdfBreaks(section);
     section.classList.add('pdf-generic-section');
     if(index>0)section.classList.add('pdf-page-start');
   });
 }

 const stage=document.createElement('div');
 stage.className='pdf-render-stage pdf-clean-stage';
 stage.style.position='fixed';
 stage.style.left='-10000px';
 stage.style.top='0';
 stage.style.width='8.5in';
 stage.style.padding='0.35in';
 stage.style.background='#fff';
 stage.style.zIndex='-1';
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
         before:['.pdf-packet-page','.pdf-page-start'],
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
   const isTest=/^TEST\b/i.test(title);
   const footerTitle=(isTest?'TEST - ':'')+
     (isAnnual
       ?'Gladstone Fire Department - Narcotic Inventory / Audit Annual Summary'
       :'Gladstone Fire Department - Narcotic Inventory / Audit Report');

   for(let page=1;page<=totalPages;page++){
     pdf.setPage(page);
     if(page===1&&isMonthlyPacket)continue;

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
   if(!d||!frame||!pages)throw new Error('PDF preview window is unavailable.');
   if(name)name.textContent=result.safeName+'.pdf';

   const mobile=window.matchMedia('(max-width:700px)').matches;
   pages.innerHTML='';
   if(mobile&&window.pdfjsLib){
     frame.hidden=true;
     frame.removeAttribute('src');
     pages.hidden=false;
     pages.innerHTML='<div class="pdf-preview-loading">Rendering PDF pages…</div>';
     const bytes=new Uint8Array(await result.blob.arrayBuffer());
     const pdf=await window.pdfjsLib.getDocument({data:bytes}).promise;
     pages.innerHTML='';
     const targetWidth=Math.max(280,Math.min(window.innerWidth-16,760));
     for(let pageNum=1;pageNum<=pdf.numPages;pageNum++){
       const page=await pdf.getPage(pageNum);
       const base=page.getViewport({scale:1});
       const scale=targetWidth/base.width;
       const viewport=page.getViewport({scale});
       const wrap=document.createElement('div');
       wrap.className='pdf-preview-page';
       const canvas=document.createElement('canvas');
       const ratio=Math.min(window.devicePixelRatio||1,2);
       canvas.width=Math.floor(viewport.width*ratio);
       canvas.height=Math.floor(viewport.height*ratio);
       canvas.style.width=viewport.width+'px';
       canvas.style.height=viewport.height+'px';
       wrap.appendChild(canvas);
       pages.appendChild(wrap);
       await page.render({canvasContext:canvas.getContext('2d'),viewport,transform:ratio!==1?[ratio,0,0,ratio,0,0]:null}).promise;
     }
     pages.scrollTop=0;
   }else{
     pages.hidden=true;
     frame.hidden=false;
     url=URL.createObjectURL(result.blob);
     frame.src=url;
     d.dataset.objectUrl=url;
   }
   d.showModal();
 }catch(err){
   if(url)URL.revokeObjectURL(url);
   alert('Unable to generate the PDF preview. Please try again.');
   console.error(err);
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
   '<div class="report-cover-brand"><img src="https://raw.githubusercontent.com/twessel20/Gladstone-AED-Inventory/main/gfd-patch.jpg" alt="Gladstone Fire Department patch">'+
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
 try{vialData=adminRows.length?providerVialData(adminRows):null}catch(e){vialData=null}
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
       if(medBaseName(item.medication)===base)total+=Number(item.vials||0);
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
     parts.push(x.m+' '+direction+' by '+amount+' vial'+(amount===1?'':'s')+(reasons.length?' ('+reasons.join('; ')+')':''));
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
function newReportSummaryHtml(r){
 try{return executiveSummaryHtml(r)}catch(err){
   console.error('Executive summary failed',err);
   return '<section class="report-executive-summary simple-summary paragraph-summary pdf-executive-page"><h2>Audit Summary</h2><p>The summary could not be calculated from this preview. The detailed audit sections below remain available and unchanged.</p></section>';
 }
}

function reportHtml(r){
 const logo='https://raw.githubusercontent.com/twessel20/Gladstone-AED-Inventory/main/gfd-patch.jpg';
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
 ((r.isTest||!r.legacyRecordNumber)?newReportSummaryHtml(r):'')+
 (amendment?'<section class="report-amendment"><h2>Amended inventory record — correction history</h2><p>The table below includes these corrections. Signatures were recorded before these amendments and certify the original record, not the corrected entries.</p>'+amendment+'</section>':'')+
 '<section><h2>Inventory comparison</h2><table class="report-table report-inventory"><thead><tr><th>Medication</th>'+LOCS.map(l=>'<th>'+esc(l)+'<small>Last / Current</small></th>').join('')+'<th>Active total</th></tr></thead><tbody>'+MEDS.map(m=>'<tr><td>'+esc(m)+'</td>'+LOCS.map(l=>{const p=r.priorCounts?.[l]?.[m];return '<td>'+(p==null?'—':Number(p))+' / <b>'+Number(r.counts?.[l]?.[m]||0)+'</b></td>'}).join('')+'<td><b>'+activeTotal(m)+'</b></td></tr>').join('')+'</tbody></table></section>'+
 '<section><h2>Breakaway tag record</h2><table class="report-table"><thead><tr><th>Location</th><th>Tag found / removed</th><th>New tag installed</th></tr></thead><tbody>'+tagRows+'</tbody></table></section>'+
 (Array.isArray(r.inventoryFindings)&&r.inventoryFindings.length?'<section class="report-audit-findings"><h2>Expired / damaged medications found during audit</h2><p class="report-note">These items were identified during the physical audit. Retained items were moved from the source location into Expired inventory; damaged vials that could not be physically retained were removed from the source count and documented without increasing the Expired physical count. No separate inventory transaction was created.</p><table class="report-table"><thead><tr><th>Date</th><th>Finding</th><th>Source</th><th>Medication</th><th>Qty</th><th>Notes</th></tr></thead><tbody>'+r.inventoryFindings.map(x=>'<tr><td>'+esc(formatDisplayDate(x.recordedAt)||'')+'</td><td>'+esc(x.typeLabel||x.type||'')+'</td><td>'+esc(x.sourceLocation||'')+' → '+esc(x.destinationLocation||'Expired')+'</td><td>'+esc(x.medication||'')+'</td><td>'+esc(x.quantity||'')+'</td><td>'+esc((x.physicalRetained===false?'No physical vial retained. ':'')+(x.note||''))+'</td></tr>').join('')+'</tbody></table></section>':'')+
 '<section class="report-eso-source"><h2>ESO Narcotic Administration Record</h2><p>Administration activity was imported from the ESO software PDF for this audit period. Physical inventory totals remain based on the manually verified count.</p>'+(sourceDoc?'<p><b>Imported ESO PDF:</b> <u>'+esc(sourceDoc.name)+'</u> — imported '+esc(formatDisplayDate(sourceDoc.uploadedAt)||'')+(sourceDoc.uploadedBy?' by '+esc(sourceDoc.uploadedBy):'')+'</p>':'')+'<p class="report-note">The imported record and calculated vial-use reconciliation are included below.</p></section>'+
 (r.isTest&&Array.isArray(r.administrationRows)&&r.administrationRows.length?
 '<section class="report-imported-admin"><h2>Administration Detail</h2><p class="report-note">Source doses are preserved as imported. Calculated vial use is derived separately using department vial rules.</p>'+
 '<table class="report-table"><thead><tr><th>Date</th><th>Report</th><th>Provider</th><th>Medication</th><th>Dose</th><th>Unit</th></tr></thead><tbody>'+
 r.administrationRows.map(x=>'<tr><td>'+esc(formatAdminDate(x.date))+'</td><td>'+esc(x.report)+'</td><td>'+esc(x.provider)+'</td><td>'+esc(x.medication)+'</td><td><b>'+esc(x.dose)+' '+esc(adminDoseUnit(x.medication))+'</b></td><td>'+esc(String(x.unit||'').replace(/^M([123])$/,'Medic $1'))+'</td></tr>').join('')+
 '</tbody></table>'+
 '<div class="report-usage-summary report-vial-summary pdf-vial-section"><div class="report-vial-summary-title">Calculated Vial Use</div><p class="report-vial-explainer">Calculated vial use converts the imported ESO administration doses into whole-vial usage using the department vial-size rules. This reconciliation reference does not change the manually verified physical inventory count.</p>'+
 providerVialData(r.administrationRows).providers.map(([provider,items])=>{
   const total=items.reduce((n,x)=>n+x.vials,0);
   const breakdown=new Map();
   items.forEach(x=>{
     const key=x.medication+'|'+x.strength;
     const cur=breakdown.get(key)||{medication:x.medication,strength:x.strength,vials:0};
     cur.vials+=x.vials;breakdown.set(key,cur);
   });
   const detail=[...breakdown.values()].map(x=>esc(x.medication)+' — '+x.vials+' × '+esc(x.strength)+' vial'+(x.vials===1?'':'s')).join('<br>');
   return '<div class="report-vial-row report-vial-row-detailed"><div class="report-vial-provider"><strong>'+esc(provider)+'</strong><span>'+detail+'</span></div><div class="report-vial-count">'+total+' vial'+(total===1?'':'s')+'</div></div>';
 }).join('')+
 '<div class="report-vial-total"><span>Total calculated vials</span><strong>'+providerVialData(r.administrationRows).total+'</strong></div></div></section>':'')+'<section class="report-transactions-section"><h2>Transactions in the audit reporting period</h2><p class="report-note">This table lists recorded controlled-substance movements or adjustments during the audit period, such as receipts, transfers, waste, destruction, or other documented inventory activity. These entries provide context for inventory changes but do not replace the physical count.</p><table class="report-table report-transactions"><thead><tr><th>Date</th><th>Action</th><th>Medication</th><th>Qty</th><th>Movement</th><th>Vendor / incident / lot</th></tr></thead><tbody>'+txRows+'</tbody></table></section>'+
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
 const options=MEDS.map(x=>'<option value="'+esc(x)+'" '+(x===med?'selected':'')+'>'+esc(x)+'</option>').join('');
 return '<div class="tx-med-row"><label>Medication<select name="txMedication" required>'+options+'</select></label><label>Quantity<input name="txQuantity" type="number" step="1" min="1" inputmode="numeric" required value="'+esc(qty)+'"></label><button type="button" class="remove-tx-med">Remove</button></div>';
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
   if(clear)clear.onclick=()=>{txRecordedSig.getContext('2d').clearRect(0,0,txRecordedSig.width,txRecordedSig.height);txRecordedSig.dataset.hasSignature='false';};
 }
 if(txWitnessSig){
   setupCanvas(txWitnessSig,'');
   const b=document.getElementById('expandTxWitnessSignature');
   const clear=document.getElementById('clearTxWitnessSignature');
   if(b)b.onclick=()=>openStandaloneSignatureCapture(txWitnessSig,'Witness signature');
   if(clear)clear.onclick=()=>{txWitnessSig.getContext('2d').clearRect(0,0,txWitnessSig.width,txWitnessSig.height);txWitnessSig.dataset.hasSignature='false';};
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
(async()=>{await openDB();await initCloud();await seedInventory();fillSelects();bind();await refreshAll();if(!cloudSession)setTimeout(()=>document.getElementById('authDialog')?.showModal(),300);const active=await getOne('meta','activeAudit');if(active?.auditId){await put('meta',{id:'activeAudit',auditId:'',updatedAt:nowISO()});activeAuditId=null;await renderAudits()}if('serviceWorker'in navigator){
  try{
    const reg=await navigator.serviceWorker.register('./sw.js?v=20260926-218',{updateViaCache:'none'});
    await reg.update();
    let reloading=false;
    navigator.serviceWorker.addEventListener('controllerchange',()=>{
      if(reloading)return;
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
   if(d.dataset.objectUrl){URL.revokeObjectURL(d.dataset.objectUrl);delete d.dataset.objectUrl;}
 });
});
