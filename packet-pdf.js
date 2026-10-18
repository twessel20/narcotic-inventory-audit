/* Gladstone FD audit packet PDF renderer.
 * September 2026-style audit layout, with PDFLib vector text, compact
 * page flow and atomic evidence blocks. Never edits finalized records.
 */
async function generateVectorAuditPacketPdf(preview,title='Narcotic Inventory Audit Report'){
  const sheet=preview?.querySelector('.report-sheet.report-finalized');
  if(!sheet || (sheet.textContent||'').trim().length<60)
    throw new Error('The finalized report is empty. Reopen the report before exporting.');
  await ensurePdfMerger();
  const {PDFDocument,StandardFonts,rgb}=window.PDFLib;
  const doc=await PDFDocument.create();
  const regular=await doc.embedFont(StandardFonts.Helvetica);
  const bold=await doc.embedFont(StandardFonts.HelveticaBold);
  const colors={
    navy:rgb(.07,.22,.35),blue:rgb(.12,.38,.56),ink:rgb(.10,.16,.23),
    muted:rgb(.31,.39,.46),rule:rgb(.82,.87,.91),pale:rgb(.95,.97,.985),
    white:rgb(1,1,1)
  };
  const PW=612,PH=792,L=44,R=568,TOP=711,BOTTOM=56,W=R-L;
  const safeText=value=>String(value??'').normalize('NFKD').replace(/[\u0300-\u036f]/g,'')
    .replace(/[\u2018\u2019]/g,"'").replace(/[\u201c\u201d]/g,'"')
    .replace(/[\u2013\u2014\u2212]/g,'-').replace(/\u2192/g,' -> ')
    .replace(/\u2022/g,'*').replace(/\u2026/g,'...').replace(/\u2265/g,'>=')
    .replace(/\u2264/g,'<=').replace(/\u00b5/g,'mc').replace(/\u00d7/g,'x')
    .replace(/\u00a0/g,' ').replace(/[^\x20-\x7e\n]/g,' ');
  const txt=el=>String(el?.innerText||el?.textContent||'').replace(/\s+/g,' ').trim();
  const multiline=el=>String(el?.innerText||el?.textContent||'').replace(/\r/g,'').replace(/[ \t]+\n/g,'\n').trim();
  const docs=Array.isArray(preview._packetSupportingDocuments)?preview._packetSupportingDocuments:[];
  const metaGrid=sheet.querySelector('.report-meta-grid');
  const meta=txt(metaGrid);
  const coverEl=sheet.querySelector('.report-cover-page');
  const auditMonth=txt(coverEl?.querySelector('.report-cover-month'))||
    (meta.match(/Audit month:\s*(.+?)\s*Created:/i)?.[1]||'Monthly Audit');
  const metaValue=label=>{
    const cells=[...(coverEl?.querySelectorAll('.cover-meta-cell')||[])];
    return txt(cells.find(c=>txt(c.querySelector('span')).toLowerCase()===label.toLowerCase())?.querySelector('strong'));
  };
  const auditDate=metaValue('Audit date')||(meta.match(/Date of audit:\s*(.+?)(?:Audit period:|$)/i)?.[1]||'').trim();
  const auditPeriod=metaValue('Audit date range')||(meta.match(/Audit period:\s*(.+?)\s*\(both dates/i)?.[1]||'').trim();
  const finalizedDate=metaValue('Finalized date')||'';
  const attestation=sheet.querySelector('.report-attestation');
  const finalName=txt(attestation?.querySelector('.report-signature-name'));
  const auditor=txt(coverEl?.querySelector('.cover-auditor-row > div:first-child strong'))||
    finalName.split(/\s+[\u00b7#]/)[0]||'Not recorded';
  const employee=txt(coverEl?.querySelector('.cover-auditor-row > div:last-child strong'))||
    finalName.match(/Employee\s*#?\s*(\d+)/i)?.[1]||'Not recorded';
  const recordNumber=txt(sheet.querySelector('.report-footer')).match(/Record\s*#\s*([A-Za-z0-9-]+)/i)?.[1]||'';
  const isTest=!!sheet.querySelector('.report-cover-test')||/^TEST\b/i.test(title);
  const fileName=(String(title||'Narcotic Inventory Audit Report')
    .replace(/[\\/:*?"<>|]+/g,'-').replace(/\s+/g,' ').trim()||'Narcotic Inventory Audit Report')+'.pdf';

  async function imageFromSrc(src){
    if(!src)return null;
    let bytes;
    if(/^data:/i.test(src)){
      const parts=src.split(',');
      const raw=parts[0].includes(';base64')?atob(parts.slice(1).join(',')):
        decodeURIComponent(parts.slice(1).join(','));
      bytes=Uint8Array.from(raw,c=>c.charCodeAt(0));
    }else{
      const res=await fetch(src,{cache:'force-cache'});
      if(!res.ok)throw new Error('Cannot load an audit image used in the PDF: '+res.status);
      bytes=new Uint8Array(await res.arrayBuffer());
    }
    if(bytes[0]===0xff && bytes[1]===0xd8)return doc.embedJpg(bytes);
    if(bytes[0]===0x89 && bytes[1]===0x50)return doc.embedPng(bytes);
    throw new Error('Unsupported audit signature or patch image format.');
  }
  const patch=await imageFromSrc(sheet.querySelector('.report-top img')?.src ||
    coverEl?.querySelector('.report-cover-brand img')?.src ||
    new URL('gfd-patch.jpg',document.baseURI).href);
  if(!patch)throw new Error('The Gladstone Fire Department patch is unavailable.');
  const signatureCache=new Map();
  async function signatureFor(element){
    const src=element?.getAttribute('src');
    if(!src)return null;
    if(!signatureCache.has(src))signatureCache.set(src,await imageFromSrc(src));
    return signatureCache.get(src);
  }
  function imageFit(page,image,x,y,width,height){
    if(!image)return;
    const k=Math.min(width/image.width,height/image.height);
    const w=image.width*k,h=image.height*k;
    page.drawImage(image,{x:x+(width-w)/2,y:y+(height-h)/2,width:w,height:h});
  }
  function wrap(text,font=regular,size=9,maxWidth=W){
    const lines=[];
    String(safeText(text)).split('\n').forEach(paragraph=>{
      if(!paragraph.trim()){lines.push('');return;}
      let line='';
      for(let word of paragraph.trim().split(/\s+/)){
        const candidate=line?line+' '+word:word;
        if(font.widthOfTextAtSize(candidate,size)<=maxWidth){line=candidate;continue;}
        if(line){lines.push(line);line='';}
        // An unbroken identifier should wrap rather than escape a cell.
        while(word && font.widthOfTextAtSize(word,size)>maxWidth){
          let n=1;
          while(n<word.length && font.widthOfTextAtSize(word.slice(0,n+1),size)<=maxWidth)n++;
          lines.push(word.slice(0,n));word=word.slice(n);
        }
        line=word;
      }
      if(line)lines.push(line);
    });
    return lines.length?lines:[''];
  }
  const pageInfo=[];
  let page,y,sectionLabel='';
  function newPage(label='Audit Details'){
    sectionLabel=label;
    page=doc.addPage([PW,PH]);
    pageInfo.push({page,label});
    page.drawRectangle({x:0,y:PH-8,width:PW,height:8,color:colors.navy});
    imageFit(page,patch,L,PH-61,34,34);
    page.drawText('GLADSTONE FIRE DEPARTMENT',{x:L+43,y:PH-34,size:11.4,font:bold,color:colors.navy});
    page.drawText('NARCOTIC INVENTORY / AUDIT REPORT',{x:L+43,y:PH-49,size:8.1,font:regular,color:colors.muted});
    const m=wrap(auditMonth,bold,8,170)[0];
    page.drawText(m,{x:R-bold.widthOfTextAtSize(m,8),y:PH-34,size:8,font:bold,color:colors.blue});
    page.drawLine({start:{x:L,y:PH-69},end:{x:R,y:PH-69},thickness:1,color:colors.rule});
    y=TOP;
    if(label)heading(label,14,{skipCheck:true});
  }
  function ensure(height,label='Audit Details'){
    if(!page || y-height<BOTTOM)newPage(label);
  }
  function heading(label,size=12,opts={}){
    const lines=wrap(label,bold,size,W);
    const h=lines.length*(size+3)+15;
    if(!opts.skipCheck)ensure(h+20,label+' (continued)');
    for(const line of lines){page.drawText(line,{x:L,y,size,font:bold,color:colors.navy});y-=size+3;}
    page.drawLine({start:{x:L,y:y+1},end:{x:R,y:y+1},thickness:.65,color:colors.rule});
    y-=13;
  }
  function paragraph(value,opts={}){
    const size=opts.size||9.3,lead=opts.leading||size*1.42;
    const width=opts.width||W;
    const font=opts.bold?bold:regular;
    const lines=wrap(value,font,size,width-((opts.indent||0)));
    // Text panels are indivisible if they fit on a fresh page.
    const height=lines.length*lead+(opts.gap??10);
    const wholeCap=TOP-BOTTOM-42;
    if(height<=wholeCap)ensure(height,opts.continuation||'Audit Details (continued)');
    for(const line of lines){
      if(y-lead<BOTTOM)newPage(opts.continuation||'Audit Details (continued)');
      if(line)page.drawText(line,{x:L+(opts.indent||0),y,size,font,color:opts.muted?colors.muted:colors.ink});
      y-=lead;
    }
    y-=opts.gap??10;
  }
  function notePanel(label,value){
    const size=9.1,lead=13.5;
    const lines=wrap(value,regular,size,W-26);
    const h=lines.length*lead+39;
    // If a note is longer than one page, render it as consecutive labeled
    // paragraphs; no bordered visual panel is allowed to cross pages.
    if(h>TOP-BOTTOM-40){
      heading(label);
      paragraph(value,{size,leading:lead,continuation:label+' (continued)'});
      return;
    }
    ensure(h+8,label);
    page.drawRectangle({x:L,y:y-h+6,width:W,height:h,borderColor:colors.rule,borderWidth:.8,color:colors.pale});
    page.drawText(safeText(label),{x:L+12,y:y-17,size:9.5,font:bold,color:colors.navy});
    let rowY=y-35;
    for(const line of lines){if(line)page.drawText(line,{x:L+12,y:rowY,size,font:regular,color:colors.ink});rowY-=lead;}
    y-=h+12;
  }
  function tableData(table){
    if(!table)return null;
    const headers=[...table.querySelectorAll('thead tr:last-child th')].map(txt);
    const rows=[...table.querySelectorAll('tbody tr')].map(tr=>[...tr.children]
      .filter(cell=>['TD','TH'].includes(cell.tagName)).map(txt));
    return {headers,rows};
  }
  function renderTable(table,label){
    const data=tableData(table);if(!data)return;
    const cols=Math.max(data.headers.length,...data.rows.map(r=>r.length),1);
    // Preserve the August form's side-by-side location comparison.
    let weights=cols===7?[1.55,1.08,1.08,1.08,1.08,1.08,.90]:
      cols===6?[1.05,1.10,1.0,.72,1.2,1.8]:cols===3?[1.0,1.9,1.9]:
      Array(cols).fill(1);
    const totalWeight=weights.reduce((a,b)=>a+b,0);
    const widths=weights.map(v=>W*v/totalWeight);
    const fontSize=cols>=7?7.05:cols>=6?7.45:8.25,lead=fontSize*1.3,pad=5;
    const rowLines=(cells,header=false)=>widths.map((width,i)=>
      wrap(cells[i]||'',header?bold:regular,fontSize,width-2*pad));
    const rowHeight=cells=>Math.max(20,...rowLines(cells).map(x=>x.length*lead+2*pad));
    const headLines=rowLines(data.headers,true);
    const headH=data.headers.length?Math.max(25,...headLines.map(x=>x.length*lead+2*pad)):0;
    const rowHeights=data.rows.map(rowHeight);
    const fullH=headH+rowHeights.reduce((a,b)=>a+b,0)+24;
    const fullCap=TOP-BOTTOM-55;
    if(fullH<fullCap&&y-fullH<BOTTOM)newPage(label+' (continued)');
    const drawRow=(cells,height,isHeader,index)=>{
      page.drawRectangle({x:L,y:y-height,width:W,height,borderColor:colors.rule,borderWidth:.55,
        color:isHeader?rgb(.91,.95,.97):index%2===0?colors.white:rgb(.985,.992,.997)});
      let x=L;
      const highlightNewSeal=/breakaway tag/i.test(label);
      rowLines(cells,isHeader).forEach((lines,i)=>{
        if(i)page.drawLine({start:{x,y:y-height},end:{x,y},thickness:.45,color:colors.rule});
        let yy=y-pad-fontSize;
        lines.forEach(line=>{if(line)page.drawText(line,{x:x+pad,y:yy,size:fontSize,
          font:isHeader||(highlightNewSeal&&i===2)?bold:regular,
          color:isHeader?colors.navy:colors.ink});yy-=lead;});
        x+=widths[i];
      });
      y-=height;
    };
    let index=0;
    const header=()=>{
      if(headH)drawRow(data.headers,headH,true,-1);
    };
    if(y-headH-(rowHeights[0]||20)<BOTTOM)newPage(label+' (continued)');
    header();
    for(const cells of data.rows){
      const h=rowHeights[index];
      if(h>TOP-BOTTOM-64)throw new Error('Audit table contains a record too tall to print without splitting.');
      if(y-h<BOTTOM){newPage(label+' (continued)');header();}
      drawRow(cells,h,false,index);
      index++;
    }
    y-=15;
  }
  async function certification(card){
    const name=txt(card.querySelector(':scope > h2'))||'Location Certification';
    const boxes=[...card.querySelectorAll('.report-signature-box')];
    const statement=txt(card.querySelector(':scope > p'))||txt(card.querySelector('.report-cert-statement'));
    const detailLines=wrap(statement,regular,8.8,W-28);
    const h=64+Math.max(0,detailLines.length-1)*13+96;
    ensure(h+12,'Audit Site Certifications (continued)');
    page.drawRectangle({x:L,y:y-h,width:W,height:h,borderColor:colors.rule,borderWidth:.8,color:colors.white});
    page.drawRectangle({x:L,y:y-29,width:W,height:29,color:colors.pale});
    page.drawText(safeText(name),{x:L+13,y:y-19,size:11,font:bold,color:colors.navy});
    let yy=y-45;
    detailLines.forEach(line=>{if(line)page.drawText(line,{x:L+13,y:yy,size:8.8,font:regular,color:colors.muted});yy-=13;});
    const colW=(W-39)/2;
    const baseY=y-h+19;
    for(let i=0;i<2;i++){
      const box=boxes[i],x=L+13+i*(colW+13);
      page.drawRectangle({x,y:baseY,width:colW,height:90,borderColor:colors.rule,borderWidth:.8});
      const label=txt(box?.querySelector('.report-signature-label'))||(i?'WITNESS SIGNATURE':'AUDITOR SIGNATURE');
      page.drawText(safeText(label).slice(0,40),{x:x+8,y:baseY+72,size:8,font:bold,color:colors.blue});
      const sign=await signatureFor(box?.querySelector('img'));
      if(sign)imageFit(page,sign,x+8,baseY+28,colW-16,40);
      else page.drawLine({start:{x:x+9,y:baseY+34},end:{x:x+colW-9,y:baseY+34},
        color:colors.rule,thickness:1});
      const identity=wrap(txt(box?.querySelector('.report-signature-name'))||'Not recorded',regular,7.5,colW-16);
      identity.slice(0,2).forEach((line,j)=>page.drawText(line,{x:x+8,y:baseY+16-j*9,size:7.5,font:regular,color:colors.ink}));
    }
    y-=h+16;
  }
  async function renderSection(section){
    const name=txt(section.querySelector(':scope > h2'))||
      (section.classList.contains('report-month-administrative-correction')
        ? txt(section.querySelector(':scope > strong'))
        : 'Audit Details');
    if(section.classList.contains('report-signature-section'))return;
    if(section.classList.contains('report-attestation'))return;
    if(section.classList.contains('report-cover-page'))return;
    if(section.classList.contains('report-notes'))return;
    // The breakaway-seal register is a single audit evidence block. Measure
    // all five rows plus the heading BEFORE drawing anything; otherwise a
    // near-full preceding inventory page can orphan the heading or split the
    // found/removed and installed tag numbers across PDF pages.
    if(/^breakaway tag record$/i.test(name)){
      const tagTable=section.querySelector('table');
      if(!tagTable){heading(name);return;}
      const data=tableData(tagTable);
      const fontSize=8.25,leading=fontSize*1.3,pad=5;
      const widths=[W/4.8,W*1.9/4.8,W*1.9/4.8];
      const rowHeight=(cells,isHeader)=>Math.max(20,...widths.map((width,i)=>
        wrap(cells[i]||'',isHeader?bold:regular,fontSize,width-2*pad).length*leading+2*pad));
      const tableHeight=(data.headers.length?Math.max(25,rowHeight(data.headers,true)):0)+
        data.rows.reduce((sum,cells)=>sum+rowHeight(cells,false),0);
      // A fresh PDF sheet must contain this complete small register. Never
      // scale away or omit any seal numbers to make it fit.
      const required=tableHeight+56;
      if(required>TOP-BOTTOM-48)
        throw new Error('The breakaway tag record cannot fit on one report page.');
      if(y-required<BOTTOM)newPage('Breakaway Tag Record');
      else heading('Breakaway Tag Record');
      renderTable(tagTable,'Breakaway Tag Record');
      return;
    }
    heading(name);
    for(const child of [...section.children]){
      if(child.matches('h2'))continue;
      if(child.matches('table')){renderTable(child,name);continue;}
      if(child.matches('.report-vial-summary')){
        const intro=child.querySelector('.report-vial-explainer');
        if(intro)paragraph(txt(intro),{size:8.7,muted:true,continuation:name+' (continued)'});
        for(const row of child.querySelectorAll('.report-vial-row,.report-vial-total'))
          notePanel('Calculated Vial Use',txt(row));
        continue;
      }
      if(child.matches('.report-amendment-row')){notePanel('Amendment / Incident',txt(child));continue;}
      if(child.matches('.report-implementation-note')){notePanel('Implementation Note',txt(child));continue;}
      if(child.matches('p,li')){paragraph(txt(child),{continuation:name+' (continued)'});continue;}
      if(child.matches('div')&&txt(child))paragraph(txt(child),{continuation:name+' (continued)'});
    }
  }

  // September 2026 report style: no oversized patch and no separate,
  // largely empty cover or executive-summary page.
  newPage('Monthly Audit Overview');
  const introH=95;
  page.drawRectangle({x:L,y:y-introH,width:W,height:introH,borderColor:colors.rule,
    borderWidth:.9,color:colors.pale});
  page.drawRectangle({x:L,y:y-introH,width:3.5,height:introH,color:colors.blue});
  imageFit(page,patch,L+14,y-introH+17,66,61);
  page.drawText('CONTROLLED-SUBSTANCE AUDIT',{x:L+92,y:y-20,size:8.3,font:bold,color:colors.blue});
  page.drawText('Narcotic Inventory / Audit Report',{x:L+92,y:y-44,size:16.4,font:bold,color:colors.ink});
  page.drawText(safeText(auditMonth),{x:L+92,y:y-67,size:12,font:bold,color:colors.blue});
  if(isTest)page.drawText('TEST - SYNTHETIC DATA',{x:L+92,y:y-82,size:8,font:bold,color:colors.blue});
  y-=introH+14;
  const metaEntries=[
    ['AUDIT PERIOD',auditPeriod||'Not recorded'],
    ['AUDIT DATE',auditDate||'Not recorded'],
    ['FINALIZED',finalizedDate||'Finalized record'],
    ['CERTIFYING AUDITOR',auditor||'Not recorded'],
    ['EMPLOYEE NUMBER',employee||'Not recorded'],
    ['RECORD NUMBER',recordNumber||'Finalized snapshot']
  ];
  // Match the September report's compact two-column metadata arrangement.
  const metaRowH=36,metaH=metaRowH*3+10;
  ensure(metaH+9,'Monthly Audit Overview (continued)');
  page.drawRectangle({x:L,y:y-metaH,width:W,height:metaH,borderColor:colors.rule,borderWidth:.7,color:colors.white});
  for(let i=0;i<metaEntries.length;i++){
    const [label,value]=metaEntries[i],col=i%2,row=Math.floor(i/2);
    const x=L+13+col*(W/2),yy=y-18-row*metaRowH;
    page.drawText(label,{x,y:yy,size:7.2,font:bold,color:colors.muted});
    const lines=wrap(value,regular,9.3,W/2-29);
    lines.slice(0,2).forEach((line,j)=>{if(line)page.drawText(line,{x,y:yy-14-j*10,size:9.3,font:regular,color:colors.ink});});
  }
  y-=metaH+16;
  const finalSign=await signatureFor(coverEl?.querySelector('.cover-auditor-signature img')||
    attestation?.querySelector('.report-final-signature img'));
  if(finalSign){
    ensure(56,'Monthly Audit Overview (continued)');
    page.drawText('CERTIFYING AUDITOR SIGNATURE',{x:L,y:y-13,size:7.6,font:bold,color:colors.muted});
    imageFit(page,finalSign,L+202,y-39,160,39);
    y-=52;
  }
  heading('Audit Summary');
  paragraph('Finalized physical inventory snapshot for '+auditMonth+'. Supporting administration records and signed site certifications follow.',{size:9.1,gap:8});
  const executive=sheet.querySelector('.report-executive-summary');
  if(executive){
    for(const child of [...executive.children]){
      if(child.matches('h2'))continue;
      if(child.matches('p'))notePanel('Audit Summary',txt(child));
      else if(txt(child))notePanel('Audit Context',txt(child));
    }
  }else paragraph('No calculated executive summary was included in the historical audit record.');
  for(const section of [...sheet.children]){
    if(section===executive||section.matches('.report-cover-page'))continue;
    // Only audit report sections contain printable evidence. Rendering the
    // header, toolbar, metadata grid and footer as extra "Audit Details"
    // sections duplicated content and made the previous export cluttered.
    if(!section.matches('section,.report-month-administrative-correction'))continue;
    if(section.matches('.report-signature-section,.report-attestation,.report-notes'))continue;
    await renderSection(section);
  }
  const certCards=[...sheet.querySelectorAll('.report-signature-section .report-cert')];
  if(certCards.length){
    ensure(210,'Location Certifications');
    heading('Audit Site Certifications');
    for(const card of certCards)await certification(card);
  }
  const notes=sheet.querySelector('.report-notes');
  if(notes){
    const typed=multiline(notes.querySelector('.audit-notes-text'));
    const summary=notes.querySelector('.report-usage-summary');
    if(typed||summary){
      heading('Audit Notes / Discrepancies');
      if(typed)notePanel('Auditor Notes',typed);
      if(summary)notePanel('Imported Administration / Usage Notes',multiline(summary));
    }
  }
  if(attestation){
    ensure(230,'Final Audit Attestation');
    heading('Final Audit Attestation');
    for(const p of attestation.querySelectorAll(':scope > p'))notePanel('Certification Statement',txt(p));
    const sign=await signatureFor(attestation.querySelector('.report-final-signature img'));
    ensure(150,'Final Audit Attestation (continued)');
    page.drawRectangle({x:L,y:y-135,width:W,height:135,borderColor:colors.rule,borderWidth:.8,color:colors.pale});
    page.drawText('FINAL CERTIFYING AUDITOR SIGNATURE',{x:L+14,y:y-24,size:9,font:bold,color:colors.navy});
    if(sign)imageFit(page,sign,L+130,y-95,266,67);
    else page.drawLine({start:{x:L+125,y:y-85},end:{x:R-125,y:y-85},thickness:.8,color:colors.rule});
    page.drawText(safeText(finalName||auditor),{x:L+15,y:y-119,size:9.5,font:regular,color:colors.ink});
    y-=155;
  }
  if(docs.length){
    heading('Supporting Documents / Appendix');
    paragraph('Original supporting PDFs are appended without alteration. The certified physical inventory remains the primary audit record.',{size:9.1});
    docs.forEach((entry,index)=>paragraph('Appendix '+String.fromCharCode(65+index%26)+': '+String(entry.name||'Supporting PDF'),{size:9.2,bold:true,gap:5}));
  }
  for(let i=0;i<pageInfo.length;i++){
    const {page:p,label}=pageInfo[i];
    p.drawLine({start:{x:L,y:44},end:{x:R,y:44},color:colors.rule,thickness:.65});
    const foot='Gladstone Fire Department  |  '+safeText(auditMonth)+(isTest?'  |  TEST':'');
    p.drawText(foot,{x:L,y:30,size:7.6,font:regular,color:colors.muted});
    const num='Report page '+(i+1)+' of '+pageInfo.length;
    p.drawText(num,{x:R-regular.widthOfTextAtSize(num,7.6),y:30,size:7.6,font:regular,color:colors.muted});
  }
  const baseBlob=new Blob([await doc.save()],{type:'application/pdf'});
  const blob=await appendSupportingPdfs(baseBlob,docs);
  return {blob,file:new File([blob],fileName,{type:'application/pdf'}),safeName:fileName.slice(0,-4)};
}
