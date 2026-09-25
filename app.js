const MEDS=['Fentanyl 100 mcg','Versed 2 mg','Versed 5 mg','Ketamine 500 mg','Morphine 10 mg'];
const LOCS=['Medic 1','Medic 2','Medic 3','Safe','Expired'];
const DB_NAME='narcotic-audit-db', DB_VER=2;
let db;
let activeAuditId=null;
let auditAutosaveTimer=null;
let auditSaveInFlight=false;

function uid(prefix='id'){return prefix+'_'+Date.now().toString(36)+'_'+Math.random().toString(36).slice(2,8)}
function nowISO(){return new Date().toISOString()}
function esc(s=''){return String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[c]))}
function openDB(){return new Promise((resolve,reject)=>{const r=indexedDB.open(DB_NAME,DB_VER);r.onupgradeneeded=()=>{const d=r.result;['inventory','transactions','audits','reports','meta','legacyArchive'].forEach(n=>{if(!d.objectStoreNames.contains(n))d.createObjectStore(n,{keyPath:'id'})})};r.onsuccess=()=>{db=r.result;resolve(db)};r.onerror=()=>reject(r.error)})}
function store(name,mode='readonly'){return db.transaction(name,mode).objectStore(name)}
function getAll(name){return new Promise((res,rej)=>{const r=store(name).getAll();r.onsuccess=()=>res(r.result);r.onerror=()=>rej(r.error)})}
function getOne(name,id){return new Promise((res,rej)=>{const r=store(name).get(id);r.onsuccess=()=>res(r.result);r.onerror=()=>rej(r.error)})}
function put(name,v){return new Promise((res,rej)=>{const r=store(name,'readwrite').put(v);r.onsuccess=()=>res(v);r.onerror=()=>rej(r.error)})}
function del(name,id){return new Promise((res,rej)=>{const r=store(name,'readwrite').delete(id);r.onsuccess=()=>res();r.onerror=()=>rej(r.error)})}

async function seedInventory(){const rows=await getAll('inventory');if(rows.length)return;for(const loc of LOCS)for(const med of MEDS)await put('inventory',{id:loc+'|'+med,location:loc,medication:med,quantity:0,updatedAt:nowISO()})}
async function balances(){const rows=await getAll('inventory');const map={};for(const l of LOCS){map[l]={};for(const m of MEDS)map[l][m]=0}rows.forEach(r=>{if(map[r.location])map[r.location][r.medication]=Number(r.quantity||0)});return map}
async function setBalance(location,medication,quantity){await put('inventory',{id:location+'|'+medication,location,medication,quantity:Number(quantity||0),updatedAt:nowISO()})}
function fmtDate(v){if(!v)return'';return new Date(v).toLocaleString()}

async function renderInventory(){const b=await balances();const grid=document.getElementById('inventoryGrid');grid.innerHTML=LOCS.map(loc=>'<div class="location-card"><h3><span>'+loc+'</span><span class="pill '+(loc==='Expired'?'expired':'')+'">'+(loc==='Expired'?'Segregated':'Active')+'</span></h3>'+MEDS.map(m=>'<div class="med-row"><span>'+m+'</span><strong>'+b[loc][m]+'</strong></div>').join('')+'</div>').join('');
document.getElementById('activeTotals').innerHTML=MEDS.map(m=>{const t=['Medic 1','Medic 2','Medic 3','Safe'].reduce((a,l)=>a+b[l][m],0);return '<div class="total-row"><div><b>'+m+'</b><small>Medic 1 + Medic 2 + Medic 3 + Safe</small></div><strong>'+t+'</strong></div>'}).join('')}

async function renderActivity(){const q=(document.getElementById('activitySearch')?.value||'').toLowerCase();let rows=await getAll('transactions');rows.sort((a,b)=>b.timestamp.localeCompare(a.timestamp));if(q)rows=rows.filter(r=>JSON.stringify(r).toLowerCase().includes(q));document.getElementById('activityList').innerHTML=rows.length?rows.map(r=>'<div class="list-item"><strong>'+esc(r.typeLabel||r.type)+' · '+esc(r.medication)+' · '+esc(r.quantity)+'</strong><div>'+esc(r.fromLocation||'—')+' → '+esc(r.toLocation||'—')+'</div><div class="meta">'+fmtDate(r.timestamp)+(r.recordedBy?' · '+esc(r.recordedBy):'')+(r.reference?' · Ref '+esc(r.reference):'')+'</div>'+(r.notes?'<div>'+esc(r.notes)+'</div>':'')+'</div>').join(''):'<div class="empty">No activity recorded yet.</div>'}

async function saveTransaction(fd){
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
async function renderAudits(){let rows=await getAll('audits');rows.sort((a,b)=>b.updatedAt.localeCompare(a.updatedAt));const drafts=rows.filter(a=>a.status!=='finalized');document.getElementById('auditWorkspace').innerHTML=(drafts.length?'<div class="notice">Audit drafts save automatically on this device. Reopen any draft and continue exactly where you stopped.</div>':'')+(rows.length?rows.map(auditSkeleton).join(''):'<div class="card empty">No monthly audit drafts yet.</div>')}

async function startAudit(){
 const b=await balances();const d=new Date();const month=d.toLocaleString(undefined,{month:'long',year:'numeric'});
 const counts={};LOCS.forEach(l=>{counts[l]={};MEDS.forEach(m=>counts[l][m]=b[l][m])});
 const a={id:uid('audit'),month,status:'draft',createdAt:nowISO(),updatedAt:nowISO(),counts,priorCounts:{},dateRangeStart:'',dateRangeEnd:'',notes:'',usageSummary:'',signatures:{},attestationName:'',attestationAccepted:false};
 await put('audits',a);await put('meta',{id:'activeAudit',auditId:a.id,updatedAt:nowISO()});await editAudit(a.id)
}
function countTable(a){
 return '<div class="audit-card"><h3>Physical inventory</h3><div class="audit-grid"><div></div>'+LOCS.map(l=>'<b>'+l+'</b>').join('')+MEDS.map(m=>'<b>'+m+'</b>'+LOCS.map(l=>'<input type="number" min="0" step="1" data-count-loc="'+l+'" data-count-med="'+m+'" value="'+Number(a.counts?.[l]?.[m]||0)+'">').join('')).join('')+'</div></div>'
}
function sigBlock(loc,s={}){return '<div class="signature-box" data-sig-loc="'+loc+'"><strong>'+loc+'</strong><input placeholder="Signer name" data-signer value="'+esc(s.signer||'')+'"><canvas width="500" height="150" data-canvas></canvas><input placeholder="Witness name" data-witness value="'+esc(s.witness||'')+'"><canvas width="500" height="150" data-witness-canvas></canvas><button type="button" data-clear-sig>Clear signatures</button></div>'}
async function editAudit(id){
 const a=await getOne('audits',id);if(!a)return;
 activeAuditId=id;
 await put('meta',{id:'activeAudit',auditId:id,updatedAt:nowISO()});
 document.getElementById('auditWorkspace').innerHTML='<div class="audit-card"><div class="audit-header"><div><span class="kicker">DRAFT AUDIT</span><h2>'+esc(a.month)+'</h2><div id="autosaveStatus" class="meta">Saved '+fmtDate(a.updatedAt)+'</div></div><button id="backAudits">Back</button></div><div class="form-grid"><label>Audit month / year<input id="auditMonth" value="'+esc(a.month||'')+'"></label><label>Audit status<input value="'+esc(a.status)+'" disabled></label><label>Period start<input id="auditStart" type="date" value="'+esc(a.dateRangeStart||'')+'"></label><label>Period end<input id="auditEnd" type="date" value="'+esc(a.dateRangeEnd||'')+'"></label></div></div>'+countTable(a)+'<div class="audit-card"><h3>Administration import summary</h3><p class="meta">Paste or import the concise usage summary here. Imported usage documents are supporting evidence and do not subtract from the manually counted physical inventory.</p><textarea id="usageSummary" rows="6" style="width:100%">'+esc(a.usageSummary||'')+'</textarea></div><div class="audit-card"><h3>Audit notes</h3><textarea id="auditNotes" rows="5" style="width:100%">'+esc(a.notes||'')+'</textarea></div><div class="audit-card"><h3>Location verification signatures</h3><div class="sig-grid">'+LOCS.map(l=>sigBlock(l,a.signatures?.[l]||{})).join('')+'</div></div><div class="audit-card"><h3>Final attestation</h3><p>I attest that the controlled-substance inventory documented in this audit reflects the physical count performed, that discrepancies have been documented and escalated as required, and that supporting records have been reviewed to the extent indicated in this report.</p><label><input id="attestCheck" type="checkbox" '+(a.attestationAccepted?'checked':'')+'> I certify this audit.</label><input id="attestName" style="width:100%;margin-top:8px" placeholder="Final signer name" value="'+esc(a.attestationName||'')+'"><div class="button-row" style="margin-top:14px"><button id="saveAudit">Save draft</button><button class="primary" id="finalizeAudit">Finalize audit</button></div></div>';
 document.getElementById('backAudits').onclick=async()=>{await flushAuditAutosave();activeAuditId=null;await put('meta',{id:'activeAudit',auditId:'',updatedAt:nowISO()});renderAudits()};
 document.querySelectorAll('.signature-box').forEach(box=>setupSignature(box,a.signatures?.[box.dataset.sigLoc]||{},()=>scheduleAuditAutosave(a.id)));
 document.getElementById('saveAudit').onclick=()=>saveAuditFromUI(a.id,false);
 document.getElementById('finalizeAudit').onclick=()=>saveAuditFromUI(a.id,true);
 document.querySelectorAll('#auditWorkspace input,#auditWorkspace textarea,#auditWorkspace select').forEach(el=>{
   if(el.disabled)return;
   el.addEventListener('input',()=>scheduleAuditAutosave(a.id));
   el.addEventListener('change',()=>scheduleAuditAutosave(a.id));
 });
 setAutosaveStatus('Saved '+fmtDate(a.updatedAt));
}
function setupCanvas(canvas,data,onChange){const ctx=canvas.getContext('2d');ctx.lineWidth=2;ctx.lineCap='round';if(data){const img=new Image();img.onload=()=>ctx.drawImage(img,0,0,canvas.width,canvas.height);img.src=data}let down=false,last=null,changed=false;const pos=e=>{const r=canvas.getBoundingClientRect(),p=e.touches?e.touches[0]:e;return{x:(p.clientX-r.left)*canvas.width/r.width,y:(p.clientY-r.top)*canvas.height/r.height}};const start=e=>{down=true;changed=false;last=pos(e);e.preventDefault()};const move=e=>{if(!down)return;const p=pos(e);ctx.beginPath();ctx.moveTo(last.x,last.y);ctx.lineTo(p.x,p.y);ctx.stroke();last=p;changed=true;e.preventDefault()};const end=()=>{if(down&&changed&&onChange)onChange();down=false;last=null;changed=false};canvas.addEventListener('mousedown',start);canvas.addEventListener('mousemove',move);window.addEventListener('mouseup',end);canvas.addEventListener('touchstart',start,{passive:false});canvas.addEventListener('touchmove',move,{passive:false});canvas.addEventListener('touchend',end)}
function setupSignature(box,s,onChange){const c=box.querySelector('[data-canvas]'),w=box.querySelector('[data-witness-canvas]');setupCanvas(c,s.signature||'',onChange);setupCanvas(w,s.witnessSignature||'',onChange);box.querySelector('[data-clear-sig]').onclick=()=>{[c,w].forEach(x=>x.getContext('2d').clearRect(0,0,x.width,x.height));if(onChange)onChange()}}
function setAutosaveStatus(msg){const el=document.getElementById('autosaveStatus');if(el)el.textContent=msg}
function collectAuditFromUI(a){
 if(!document.getElementById('auditMonth'))return a;
 a.month=document.getElementById('auditMonth').value;
 a.dateRangeStart=document.getElementById('auditStart').value;
 a.dateRangeEnd=document.getElementById('auditEnd').value;
 a.usageSummary=document.getElementById('usageSummary').value;
 a.notes=document.getElementById('auditNotes').value;
 document.querySelectorAll('[data-count-loc]').forEach(i=>{a.counts??={};a.counts[i.dataset.countLoc]??={};a.counts[i.dataset.countLoc][i.dataset.countMed]=Number(i.value||0)});
 a.signatures={};
 document.querySelectorAll('.signature-box').forEach(box=>{const loc=box.dataset.sigLoc,c=box.querySelector('[data-canvas]'),w=box.querySelector('[data-witness-canvas]');a.signatures[loc]={signer:box.querySelector('[data-signer]').value,witness:box.querySelector('[data-witness]').value,signature:c.toDataURL(),witnessSignature:w.toDataURL()}});
 a.attestationAccepted=document.getElementById('attestCheck').checked;
 a.attestationName=document.getElementById('attestName').value;
 return a;
}
function scheduleAuditAutosave(id){
 activeAuditId=id;
 setAutosaveStatus('Saving…');
 clearTimeout(auditAutosaveTimer);
 auditAutosaveTimer=setTimeout(()=>autosaveAudit(id),450);
}
async function autosaveAudit(id){
 if(auditSaveInFlight||!id)return;
 auditSaveInFlight=true;
 try{
   const a=await getOne('audits',id);if(!a)return;
   collectAuditFromUI(a);a.updatedAt=nowISO();a.lastAutosaveAt=a.updatedAt;
   await put('audits',a);
   await put('meta',{id:'activeAudit',auditId:id,updatedAt:a.updatedAt});
   setAutosaveStatus('Saved '+new Date(a.updatedAt).toLocaleTimeString([], {hour:'numeric',minute:'2-digit',second:'2-digit'}));
 }catch(e){setAutosaveStatus('Save failed — keep this screen open');}
 finally{auditSaveInFlight=false}
}
async function flushAuditAutosave(){
 clearTimeout(auditAutosaveTimer);
 if(activeAuditId&&document.getElementById('auditMonth'))await autosaveAudit(activeAuditId);
}

async function saveAuditFromUI(id,finalize){
 const a=await getOne('audits',id);collectAuditFromUI(a);a.updatedAt=nowISO();
 if(finalize){if(!a.attestationAccepted||!a.attestationName.trim())return alert('Final attestation and signer name are required.');for(const loc of LOCS){if(!a.signatures[loc]?.signer?.trim()||!a.signatures[loc]?.witness?.trim())return alert('Signer and witness names are required for '+loc+'.')}a.status='finalized';a.finalizedAt=nowISO();await put('reports',{...a,id:'report_'+a.id,auditId:a.id});}
 await put('audits',a);if(finalize){activeAuditId=null;await put('meta',{id:'activeAudit',auditId:'',updatedAt:nowISO()});}await refreshAll();if(finalize)showReport('report_'+a.id);else editAudit(a.id)
}

async function renderReports(){let rows=await getAll('reports');rows.sort((a,b)=>(b.finalizedAt||'').localeCompare(a.finalizedAt||''));document.getElementById('reportsList').innerHTML=rows.length?rows.map(r=>'<div class="list-item"><strong>'+esc(r.month)+'</strong><div class="meta">Finalized '+fmtDate(r.finalizedAt)+' · '+esc(r.attestationName||'')+'</div><div class="button-row"><button data-report="'+r.id+'">View / print</button></div></div>').join(''):'<div class="card empty">No finalized audits yet.</div>'}
async function showReport(id){const r=await getOne('reports',id);if(!r)return;const d=document.getElementById('reportDialog'),b=await reportHtml(r);document.getElementById('reportPreview').innerHTML=b;d.showModal();document.getElementById('closeReport').onclick=()=>d.close();document.getElementById('printReport').onclick=()=>window.print()}
async function reportHtml(r){return '<div class="report-sheet"><button id="closeReport" class="close-report">Close</button><button id="printReport">Print</button><h1>Gladstone Fire Department</h1><h2>Narcotic Inventory / Audit Report</h2><p><b>Audit:</b> '+esc(r.month)+'<br><b>Period:</b> '+esc(r.dateRangeStart||'—')+' through '+esc(r.dateRangeEnd||'—')+'<br><b>Finalized:</b> '+fmtDate(r.finalizedAt)+'</p><h3>Physical inventory</h3><table><thead><tr><th>Medication</th>'+LOCS.map(l=>'<th>'+l+'</th>').join('')+'</tr></thead><tbody>'+MEDS.map(m=>'<tr><td>'+m+'</td>'+LOCS.map(l=>'<td>'+Number(r.counts?.[l]?.[m]||0)+'</td>').join('')+'</tr>').join('')+'</tbody></table><h3>Administration import summary</h3><p>'+esc(r.usageSummary||'None').replace(/\n/g,'<br>')+'</p><h3>Audit notes</h3><p>'+esc(r.notes||'None').replace(/\n/g,'<br>')+'</p><h3>Verification</h3>'+LOCS.map(l=>'<p><b>'+l+':</b> '+esc(r.signatures?.[l]?.signer||'')+' / witness '+esc(r.signatures?.[l]?.witness||'')+'</p>').join('')+'<h3>Final attestation</h3><p>Certified by '+esc(r.attestationName||'')+'.</p></div>'}

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
 const roots=[data,data.data||{},data.db||{},data.state||{}];
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
 document.querySelectorAll('.tabs button').forEach(b=>b.onclick=()=>{document.querySelectorAll('.tabs button').forEach(x=>x.classList.toggle('active',x===b));document.querySelectorAll('.tab-panel').forEach(x=>x.classList.toggle('active',x.id===b.dataset.tab))});
 document.getElementById('newTxBtn').onclick=()=>document.getElementById('txDialog').showModal();
 document.getElementById('saveTxBtn').onclick=async e=>{e.preventDefault();try{await saveTransaction(new FormData(document.getElementById('txForm')));document.getElementById('txDialog').close();document.getElementById('txForm').reset()}catch(err){alert(err.message)}};
 document.getElementById('activitySearch').oninput=renderActivity;document.getElementById('exportActivityBtn').onclick=exportActivity;document.getElementById('newAuditBtn').onclick=startAudit;
 document.getElementById('auditWorkspace').onclick=async e=>{const b=e.target.closest('[data-audit-action]');if(!b)return;if(b.dataset.auditAction==='open')editAudit(b.dataset.id);if(b.dataset.auditAction==='delete'&&confirm('Delete this audit draft?')){await del('audits',b.dataset.id);renderAudits()}};
 document.getElementById('reportsList').onclick=e=>{const b=e.target.closest('[data-report]');if(b)showReport(b.dataset.report)};
 document.getElementById('exportBtn').onclick=exportBackup;document.getElementById('importBtn').onclick=()=>document.getElementById('importFile').click();document.getElementById('importFile').onchange=async e=>{if(!e.target.files[0])return;try{await importBackup(e.target.files[0])}catch(err){alert(err.message)}};
 const status=()=>{const el=document.getElementById('offlineBadge');el.textContent=navigator.onLine?'Connected':'Offline';el.style.background=navigator.onLine?'#1f6e4d':'#7a4a1f'};window.addEventListener('online',status);window.addEventListener('offline',status);status()
}
window.addEventListener('pagehide',()=>{if(activeAuditId)scheduleAuditAutosave(activeAuditId)});
document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='hidden'&&activeAuditId)flushAuditAutosave()});
(async()=>{await openDB();await seedInventory();fillSelects();bind();await refreshAll();const active=await getOne('meta','activeAudit');if(active?.auditId&&await getOne('audits',active.auditId)){document.querySelector('[data-tab="audit"]').click();await editAudit(active.auditId)}if('serviceWorker'in navigator)navigator.serviceWorker.register('./sw.js')})();