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
  const PW=612,PH=792,L=40,R=572,TOP=681,BOTTOM=63,W=R-L;
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
  // August 2026 signed-packet header: department patch and report title at
  // left, audit period and date at right, single navy rule beneath.
  function newPage(label='Audit Details'){
    sectionLabel=label;
    page=doc.addPage([PW,PH]);
    pageInfo.push({page,label});
    imageFit(page,patch,L,PH-61,31,31);
    page.drawText('NARCOTIC INVENTORY AUDIT REPORT',
      {x:L+39,y:PH-35,size:9.0,font:bold,color:colors.ink});
    page.drawText('Gladstone Fire Department  |  Record #'+safeText(recordNumber||'--'),
      {x:L+39,y:PH-48,size:7.6,font:regular,color:colors.muted});
    const right1=safeText(auditPeriod||auditMonth),right2='Audit: '+safeText(auditDate||'Not recorded');
    const rr=wrap(right1,bold,7.7,180)[0];
    page.drawText(rr,{x:R-bold.widthOfTextAtSize(rr,7.7),y:PH-35,size:7.7,font:bold,color:colors.ink});
    page.drawText(right2,{x:R-regular.widthOfTextAtSize(right2,7.5),y:PH-47,
      size:7.5,font:regular,color:colors.ink});
    page.drawLine({start:{x:L,y:PH-71},end:{x:R,y:PH-71},thickness:1.8,color:colors.navy});
    y=TOP;
    if(label){
      page.drawText(safeText(label),{x:L,y,size:10.2,font:bold,color:colors.blue});
      y-=35;
    }
  }
  function ensure(height,label='Audit Details'){
    if(!page || y-height<BOTTOM)newPage(label);
  }
  function heading(label,size=13,opts={}){
    const lines=wrap(label,bold,size,W);
    const h=lines.length*(size+3)+14;
    if(!opts.skipCheck)ensure(h+20,label+' (continued)');
    for(const line of lines){
      page.drawText(line,{x:L,y,size,font:bold,color:colors.ink});
      y-=size+4;
    }
    y-=9;
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
        color:isHeader?colors.navy:index%2===0?colors.white:rgb(.965,.976,.99)});
      let x=L;
      const highlightNewSeal=/breakaway tag/i.test(label);
      rowLines(cells,isHeader).forEach((lines,i)=>{
        if(i)page.drawLine({start:{x,y:y-height},end:{x,y},thickness:.45,color:colors.rule});
        let yy=y-pad-fontSize;
        lines.forEach(line=>{if(line)page.drawText(line,{x:x+pad,y:yy,size:fontSize,
          font:isHeader||(highlightNewSeal&&i===2)?bold:regular,
          color:isHeader?colors.white:colors.ink});yy-=lead;});
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
  // August certification spread: two locations per page, each with two
  // spacious side-by-side signature panels. Never split a site certification.
  async function certification(card){
    const name=txt(card.querySelector(':scope > h2'))||'Location Certification';
    const boxes=[...card.querySelectorAll('.report-signature-box')];
    const statement=txt(card.querySelector(':scope > p'))||
      txt(card.querySelector('.report-cert-statement'));
    const desc=wrap(statement,regular,9,W);
    const h=225+Math.max(0,desc.length-2)*12;
    ensure(h+12,'Audit Site Certifications (continued)');
    page.drawText(safeText(name.charAt(0).toUpperCase()+name.slice(1)),
      {x:L,y,size:14,font:bold,color:colors.ink});
    let sy=y-24;
    desc.forEach(line=>{if(line)page.drawText(line,{x:L,y:sy,size:9,font:regular,color:colors.ink});sy-=13;});
    const boxesTop=y-44-Math.max(0,desc.length-2)*12;
    const gap=21,boxW=(W-gap)/2,boxH=150;
    for(let i=0;i<2;i++){
      const box=boxes[i],x=L+i*(boxW+gap);
      const base=boxesTop-boxH;
      page.drawRectangle({x,y:base,width:boxW,height:boxH,
        borderColor:colors.navy,borderWidth:.8,color:colors.white});
      const label=i?'WITNESS SIGNATURE':'SIGNER SIGNATURE';
      page.drawText(label,{x:x+12,y:boxesTop-20,size:8.2,font:bold,color:colors.blue});
      const sign=await signatureFor(box?.querySelector('img'));
      if(sign)imageFit(page,sign,x+13,base+52,boxW-26,68);
      page.drawLine({start:{x:x+12,y:base+49},end:{x:x+boxW-12,y:base+49},
        thickness:.6,color:colors.navy});
      const identity=txt(box?.querySelector('.report-signature-name'))||'Not recorded';
      const lines=wrap(identity,regular,8.5,boxW-24);
      lines.slice(0,3).forEach((line,j)=>page.drawText(line,
        {x:x+12,y:base+35-j*11,size:8.5,font:regular,color:colors.ink}));
    }
    y-=h;
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

  // Match the original August 2026 signed report: full standalone cover.
  newPage('Report cover');
  imageFit(page,patch,241,478,130,130);
  const centered=(value,yPos,size,font=bold,color=colors.ink)=>{
    const lines=wrap(value,font,size,W-40);
    for(const line of lines){
      page.drawText(line,{x:(PW-font.widthOfTextAtSize(line,size))/2,
        y:yPos,size,font,color});
      yPos-=size+5;
    }
  };
  centered('FINALIZED MONTHLY AUDIT',456,11,regular,colors.ink);
  centered('Narcotic Inventory',415,25,bold,colors.ink);
  centered('Audit Report',385,25,bold,colors.ink);
  centered('Gladstone Fire Department',344,13,regular,colors.ink);
  const frontFields=[
    ['Reporting period',auditPeriod||auditMonth||'Not recorded'],
    ['Date of audit',auditDate||'Not recorded'],
    ['Certifying auditor',auditor||'Not recorded'],
    ['Employee number',employee||'Not recorded'],
    ['Certified',finalizedDate||'Finalized audit'],
    ['Contact',meta.match(/Email:\\s*(\\S+)/i)?.[1]||'Not recorded']
  ];
  let fieldY=294;
  for(const [label,value] of frontFields){
    page.drawText(label,{x:82,y:fieldY,size:9,font:regular,color:colors.ink});
    const lines=wrap(value,regular,9,250);
    lines.slice(0,2).forEach((line,j)=>page.drawText(line,
      {x:300,y:fieldY-j*11,size:9,font:regular,color:colors.ink}));
    fieldY-=29;
  }

  // August's executive summary occupies its own page.
  newPage('Executive summary');
  paragraph('This packet documents the physical inventory audit for '+safeText(auditPeriod||auditMonth)+
    '. Locations covered: Medic 1, Medic 2, Medic 3, Safe, Expired. It includes inventory comparisons, tag records, activity, signatures, notes, and referenced supporting documents.',{size:9.3});
  heading('Inventory and recorded activity',11.4);
  const invTable=sheet.querySelector('.report-inventory');
  const invData=tableData(invTable);
  const countCurrent=()=>{
    if(!invData)return null;
    let total=0,active=0,expired=0,ok=false;
    for(const row of invData.rows){
      for(let j=1;j<=5;j++){
        const v=String(row[j]||'').split('/').pop().trim();
        if(/^\\d+$/.test(v)){
          total+=Number(v);if(j===5)expired+=Number(v);else active+=Number(v);ok=true;
        }
      }
    }
    return ok?{total,active,expired}:null;
  };
  const c=countCurrent();
  const txn=sheet.querySelector('.report-transactions-section table');
  const transactionRows=tableData(txn)?.rows||[];
  const facts=[
    ['Current physical inventory (all locations)',c?c.total+' vials':'See signed inventory comparison'],
    ['Active inventory (Medic 1, 2, 3 and Safe)',c?c.active+' vials':'See signed inventory comparison'],
    ['Expired stock',c?c.expired+' vials':'See signed inventory comparison'],
    ['Recorded transactions',transactionRows.length?String(transactionRows.length):'None recorded'],
    ['Seals', 'Five locations - original and replacement tags documented']
  ];
  const factRows=facts.map(([label,value])=>[label,value]);
  const factTable={
    querySelectorAll(q){
      if(q==='thead tr:last-child th')return [ {innerText:'Inventory and audit evidence'},{innerText:'Finalized values'} ];
      if(q==='tbody tr')return factRows.map(row=>({children:row.map(value=>({tagName:'TD',innerText:value}))}));
      return [];
    }
  };
  renderTable(factTable,'Executive summary');
  const execSummary=sheet.querySelector('.report-executive-summary');
  if(execSummary){
    for(const p of execSummary.querySelectorAll('p')){
      if(txt(p))paragraph(txt(p),{size:9.1,continuation:'Executive summary (continued)'});
    }
  }
  paragraph('Physical counts are the verified audit inventory. Source documents and administration calculations are supporting evidence and do not replace the final signed physical count.',
    {size:8.7,muted:true});
  // Data tables follow August's standalone summary page.
  newPage('Audit data and supporting records');
  for(const section of [...sheet.children]){
    if(section===execSummary||section.matches('.report-cover-page'))continue;
    // Only audit report sections contain printable evidence. Rendering the
    // header, toolbar, metadata grid and footer as extra "Audit Details"
    // sections duplicated content and made the previous export cluttered.
    if(!section.matches('section,.report-month-administrative-correction'))continue;
    if(section.matches('.report-signature-section,.report-attestation,.report-notes'))continue;
    await renderSection(section);
  }
  const certCards=[...sheet.querySelectorAll('.report-signature-section .report-cert')];
  if(certCards.length){
    for(let i=0;i<certCards.length;i++){
      if(i%2===0)newPage('Audit site certifications');
      await certification(certCards[i]);
    }
  }
  const notes=sheet.querySelector('.report-notes');
  if(notes){
    newPage('Audit notes / discrepancies');
    const typed=multiline(notes.querySelector('.audit-notes-text'));
    const summary=notes.querySelector('.report-usage-summary');
    if(typed||summary){
      heading('Audit Notes / Discrepancies');
      if(typed)notePanel('Auditor Notes',typed);
      if(summary)notePanel('Imported Administration / Usage Notes',multiline(summary));
    }
  }
  if(attestation){
    newPage('Final audit attestation');
    heading('Final audit attestation');
    for(const p of attestation.querySelectorAll(':scope > p'))notePanel('Certification Statement',txt(p));
    const sign=await signatureFor(attestation.querySelector('.report-final-signature img'));
    ensure(150,'Final Audit Attestation (continued)');
    page.drawRectangle({x:L,y:y-135,width:W,height:135,borderColor:colors.rule,borderWidth:.8,color:colors.pale});
    page.drawText('FINAL CERTIFYING AUDITOR SIGNATURE',{x:L+14,y:y-24,size:9,font:bold,color:colors.blue});
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
    const {page:p}=pageInfo[i];
    const textFooter='Gladstone Fire/EMS  |  Record #'+safeText(recordNumber||'--')+
      '  |  '+safeText(auditPeriod||auditMonth);
    p.drawLine({start:{x:L,y:55},end:{x:R,y:55},color:colors.rule,thickness:.55});
    p.drawText(textFooter,{x:(PW-regular.widthOfTextAtSize(textFooter,7))/2,y:42,
      size:7,font:regular,color:colors.muted});
    const label='Page '+(i+1)+' of '+pageInfo.length;
    p.drawText(label,{x:R-regular.widthOfTextAtSize(label,7),y:24,
      size:7,font:regular,color:colors.muted});
  }
  const baseBlob=new Blob([await doc.save()],{type:'application/pdf'});
  const blob=await appendSupportingPdfs(baseBlob,docs);
  return {blob,file:new File([blob],fileName,{type:'application/pdf'}),safeName:fileName.slice(0,-4)};
}
