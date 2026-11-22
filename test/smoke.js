// Tes asap (smoke test) tanpa Electron dan tanpa internet:
//  1) server hasil build dijalankan dan endpoint pentingnya dicek
//  2) halaman build/index.html dimuat di jsdom untuk tiap ?view= dan perilaku utamanya dicek
// Jalankan: npm test   (otomatis membangun dulu)
const fs=require('fs'),os=require('os'),path=require('path'),{spawn}=require('child_process');
const {JSDOM,VirtualConsole}=require('jsdom');
const root=path.join(__dirname,'..'),build=path.join(root,'build');
let fail=0;const ok=(c,m)=>{console.log((c?'  ok   ':'  GAGAL ')+m);if(!c)fail++;};
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const PKG=JSON.parse(fs.readFileSync(path.join(root,'package.json'),'utf8'));

async function serverTests(){
  console.log('\n[server]');
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'cgs-'));
  fs.writeFileSync(path.join(dir,'settings.json'),JSON.stringify({dock:{theme:'spatial'},overlay:{},global:{}}));
  const p=spawn(process.execPath,[path.join(build,'server.js')],{env:{...process.env,CG_DATA:dir,CG_VERSION:PKG.version},stdio:process.env.CG_DEBUG?'inherit':'ignore'});
  await sleep(2500);
  try{
    const base='http://localhost:3000',raw=async(u,b)=>(await fetch(base+u,{method:'POST',body:JSON.stringify(b||{})})).text(),j=async(u,b)=>(await fetch(base+u,{method:'POST',body:JSON.stringify(b||{})})).json();
    const html=await(await fetch(base+'/?view=dock')).text();
    ok(/<body class="dock p-polos th-spatial">/.test(html),'halaman dock sudah memakai tema tersimpan sejak render pertama');
    ok(!/th-spatial/.test(await(await fetch(base+'/?view=overlay')).text().then(t=>t.match(/<body[^>]*>/)[0])),'overlay tidak ikut tema aplikasi');
    const st=JSON.parse(fs.readFileSync(path.join(dir,'settings.json'),'utf8'));
    ok((st.global.templates||[]).map(t=>t.id).join()==='kartu,persona,neon,retro,cozy','gaya bawaan di-seed saat pertama jalan');
    await raw('/settings',{view:'global',values:{templates:[]}});await raw('/templates-restore',{});await sleep(250);
    ok(JSON.parse(fs.readFileSync(path.join(dir,'settings.json'),'utf8')).global.templates.length===5,'Pulihkan gaya bawaan bekerja');
    const pl=await j('/platform',{platform:'kick',on:true,user:'abc'});
    ok(pl.enabled&&pl.enabled.kick===true&&JSON.parse(fs.readFileSync(path.join(dir,'config.json'),'utf8')).kick==='abc','switch platform tersimpan (/platform)');
    await raw('/sample',{m:{p:'youtube',name:'a',text:'b'},target:'dock'});
    const s=await j('/send',{text:'halo',targets:['youtube','tiktok']});
    ok(/ekstensi/i.test(s.youtube)&&/ekstensi/i.test(s.tiktok),'kirim chat tanpa ekstensi memberi pesan jelas');
    await sendDefaultOffTests(base,dir,j,raw);
    await extTests(base,dir,j,raw);
    const o=await j('/obs-add',{});ok(/OBS/.test(o.error||''),'tambah ke OBS memberi pesan jelas bila OBS tidak aktif');
    const forbidden=await fetch(base+'/send',{method:'POST',headers:{Origin:'https://evil.example'},body:'{}'});
    ok(forbidden.status===403,'POST dari origin asing ditolak');
    // Donate Dock (multi-dock): pengaturan lewat /donate-docks (tanpa Electron, jadi hooks.donate kosong)
    const rd=()=>JSON.parse(fs.readFileSync(path.join(dir,'settings.json'),'utf8')).global;
    const dd=(url,extra)=>j('/donate-docks',{docks:[{id:'a',name:'Widget',url,...(extra||{})}]});
    ok(/tidak valid/i.test((await dd('javascript:alert(1)')).error||''),'Donate Dock menolak URL javascript:');
    ok(/tidak valid/i.test((await dd('file:///C:/rahasia.txt')).error||'')&&/tidak valid/i.test((await dd('bukan url')).error||''),'Donate Dock menolak file: dan teks biasa');
    const d3=await dd('  https://saweria.co/widgets/alert?streamKey=abc  ');await sleep(250);
    ok(d3.ok&&rd().donateDocks[0].url==='https://saweria.co/widgets/alert?streamKey=abc','Donate Dock menyimpan URL https (spasi dipangkas) di settings.global.donateDocks');
    await dd('http://localhost:9999/w');await sleep(150);
    ok(rd().donateDocks[0].url==='http://localhost:9999/w','Donate Dock menerima http');
    await dd('http://localhost:9999/w',{mute:true});await sleep(250);ok(rd().donateDocks[0].mute===true,'saklar bisu Donate Dock tersimpan (mute)');
    ok(/desktop/i.test((await j('/donate',{act:'open'})).error||''),'/donate di luar aplikasi desktop memberi pesan jelas');
    const d6=await dd('');await sleep(150);ok(d6.ok&&rd().donateDocks[0].url==='','URL kosong diterima (fitur diam)');
    ok((rd().templates||[]).length>0&&rd().autoOpen===true,'menyimpan pengaturan Donate Dock tidak menghapus pengaturan global lain');
    await extOnlyTests(base,dir,j,raw);
  }catch(e){ok(false,'server error: '+e.message);}
  p.kill();
}

// ---- v15.2.0: ekstensi memperbarui dirinya + kirim chat instan (tanpa Chrome asli: chrome.* dan DOM dipalsukan, kode asli extension/*.js dijalankan di vm) ----
async function extensionTests(){
  console.log('\n[ekstensi v15.2.0: salin folder tetap, muat ulang sendiri, kirim instan]');
  const vm=require('vm'),extDir=path.join(root,'extension');
  // -- extsync: salin folder ekstensi tetap
  const {syncDir}=require(path.join(root,'src/extsync.js')),tmp=fs.mkdtempSync(path.join(os.tmpdir(),'cgx-')),src=path.join(tmp,'src'),dst=path.join(tmp,'dst');
  fs.mkdirSync(src);fs.writeFileSync(path.join(src,'manifest.json'),'{"v":1}');fs.writeFileSync(path.join(src,'a.js'),'A1');fs.writeFileSync(path.join(src,'b.js'),'B1');
  let ch=syncDir(src,dst);
  ok(ch.length===3&&ch[ch.length-1]==='manifest.json'&&fs.readFileSync(path.join(dst,'a.js'),'utf8')==='A1','extsync: salinan pertama menyalin semua berkas, manifest.json PALING AKHIR');
  ok(syncDir(src,dst).length===0,'extsync: tidak ada yang berubah = tidak ada yang ditulis');
  fs.writeFileSync(path.join(src,'a.js'),'A2');fs.rmSync(path.join(src,'b.js'));fs.writeFileSync(path.join(dst,'sisa.tmp'),'x');
  ch=syncDir(src,dst);
  ok(ch.includes('a.js')&&ch.includes('-b.js')&&ch.includes('-sisa.tmp')&&!ch.includes('manifest.json')&&fs.readFileSync(path.join(dst,'a.js'),'utf8')==='A2'&&!fs.existsSync(path.join(dst,'b.js')),'extsync: hanya berkas yang beda ditulis, berkas usang dihapus');
  fs.rmSync(path.join(src,'manifest.json'));let thrown=false;try{syncDir(src,dst);}catch{thrown=true;}
  ok(thrown&&fs.existsSync(path.join(dst,'manifest.json')),'extsync: sumber tanpa manifest.json = error dan folder tujuan tidak dirusak');
  const real=path.join(tmp,'real');syncDir(extDir,real);
  ok(JSON.parse(fs.readFileSync(path.join(real,'manifest.json'),'utf8')).version===PKG.version&&fs.existsSync(path.join(real,'bg.js')),'extsync: extension/ asli tersalin lengkap, versi manifest = package.json');
  ok(JSON.stringify(JSON.parse(fs.readFileSync(path.join(extDir,'manifest.json'),'utf8')).permissions)==='["storage","tabs","alarms"]','izin ekstensi tidak bertambah (menambah izin pada update bisa meminta persetujuan Chrome)');
  fs.rmSync(tmp,{recursive:true,force:true});

  // -- bg.js: pesan ver -> chrome.runtime.reload() sekali per versi
  const glob=p=>new RegExp('^'+p.replace(/[.+?^${}()|[\]\\]/g,'\\$&').replace(/\*/g,'.*')+'$');
  async function loadBg({mine,store,failSet,tabs}){
    const st={...(store||{})},calls={reload:0,tabs:[]},socks=[];let onInst=null;
    class WS{constructor(u){this.url=u;this.readyState=0;socks.push(this);}send(){}close(){}}
    const chrome={runtime:{getManifest:()=>({version:mine}),reload:()=>{calls.reload++;},onStartup:{addListener(){}},onInstalled:{addListener:f=>{onInst=f;}}},
      storage:{local:{get:async k=>{const o={};[].concat(k).forEach(x=>{if(x in st)o[x]=st[x];});return o;},set:async o=>{if(failSet)throw new Error('gagal');Object.assign(st,o);}},onChanged:{addListener(){}}},
      alarms:{create(){},onAlarm:{addListener(){}}},
      tabs:{query:async q=>(tabs||[]).filter(t=>q.url.some(u=>glob(u).test(t.url))),reload:async id=>{calls.tabs.push(id);},create:async()=>({})},windows:{getAll:async()=>[],create:async()=>({})}};
    const ctx={chrome,WebSocket:WS,console:{info(){},log(){}},setTimeout:()=>0,clearTimeout(){},setInterval:()=>0,clearInterval(){},URL,JSON,Date};
    vm.createContext(ctx);vm.runInContext(fs.readFileSync(path.join(extDir,'bg.js'),'utf8'),ctx);await sleep(20);
    const w=socks[0];w.onopen();
    return{st,calls,msg:async m=>{w.onmessage({data:typeof m==='string'?m:JSON.stringify(m)});await sleep(20);},inst:async d=>{onInst&&onInst(d);await sleep(20);},bgHello:()=>true};
  }
  let B=await loadBg({mine:'15.2.0'});await B.msg({type:'ver',version:'15.2.0'});
  ok(B.calls.reload===0&&!('reloadedFor' in B.st),'bg: versi aplikasi = versi ekstensi -> tidak memuat ulang');
  B=await loadBg({mine:'15.1.7'});await B.msg({type:'ver',version:'15.2.0'});
  ok(B.calls.reload===1&&B.st.reloadedFor==='15.2.0'&&/15\.2\.0/.test(B.st.lastReload.reason)&&/15\.1\.7/.test(B.st.lastReload.reason),'bg: versi beda -> chrome.runtime.reload() sekali, penanda reloadedFor + alasan (lastReload) tersimpan');
  await B.msg({type:'ver',version:'15.2.0'});ok(B.calls.reload===1,'bg: pesan ver kedua untuk versi yang sama di sesi yang sama tidak memuat ulang lagi');
  B=await loadBg({mine:'15.1.7',store:{reloadedFor:'15.2.0'}});await B.msg({type:'ver',version:'15.2.0'});
  ok(B.calls.reload===0,'bg: sudah pernah reload untuk versi ini tetapi versi manifest tetap beda (dipasang dari folder lain) -> TIDAK loop');
  await B.msg({type:'ver',version:'15.2.1'});ok(B.calls.reload===1&&B.st.reloadedFor==='15.2.1','bg: versi aplikasi baru lagi (15.2.1) -> reload sekali lagi untuk versi itu');
  B=await loadBg({mine:'15.1.7',failSet:true});await B.msg({type:'ver',version:'15.2.0'});
  ok(B.calls.reload===0,'bg: penanda gagal disimpan -> tidak reload (mencegah loop)');
  B=await loadBg({mine:'15.1.7'});await B.msg({type:'ver',version:'bukan versi'});await B.msg({type:'ver'});await B.msg({type:'tidak-dikenal',x:1});await B.msg('bukan json');await B.msg({type:'open',platform:'tiktok',url:'https://evil.example/'});
  ok(B.calls.reload===0&&B.calls.tabs.length===0,'bg: versi tidak valid, tipe tidak dikenal, bukan JSON, dan open ke alamat asing diabaikan tanpa error');
  const T=[{id:1,url:'https://www.youtube.com/live_chat?is_popout=1&v=abc',active:false},{id:2,url:'https://www.youtube.com/live_chat?is_popout=1&v=abc',active:true},{id:3,url:'https://www.twitch.tv/directory',active:false},{id:4,url:'https://www.twitch.tv/popout/abc/chat?popout=',active:false},{id:5,url:'https://www.tiktok.com/@u/live',active:false}];
  B=await loadBg({mine:'15.2.0',tabs:T});await B.inst({reason:'update'});
  ok(JSON.stringify(B.calls.tabs)==='[1,4,5]','bg: sesudah ekstensi diperbarui, tab chat di latar dimuat ulang (content script lama yatim); tab aktif dan halaman biasa (twitch.tv/directory) dilewati');
  B=await loadBg({mine:'15.2.0',tabs:T});await B.inst({reason:'install'});await B.inst({reason:'chrome_update'});
  ok(B.calls.tabs.length===0,'bg: pasang baru / pembaruan Chrome tidak memuat ulang tab');

  // -- content script: tanpa jeda tetap, polling sampai kolom kosong, satu klik
  const CFG={'yt.js':{i:'yt-live-chat-text-input-field-renderer #input',b:'yt-live-chat-message-input-renderer #send-button button',plat:'youtube'},
    'tt.js':{i:'[data-e2e="comment-input"] [contenteditable]',b:'[data-e2e="comment-post"]',plat:'tiktok'},
    'tw.js':{i:'[data-a-target="chat-input"]',b:'[data-a-target="chat-send-button"]',plat:'twitch'},
    'kk.js':{i:'[data-testid="chat-input"]',b:'#send-message-button',plat:'kick'}};
  async function runCs(file,mode,opt){opt=opt||{};
    const c=CFG[file],box={textContent:'',tagName:'DIV',focus(){},dispatchEvent(){return true;},getBoundingClientRect:()=>({width:10})};
    const btn={disabled:mode==='late',clicks:0,getAttribute:()=>null,getBoundingClientRect:()=>({width:10}),click(){this.clicks++;if(mode==='ok'||mode==='late')setTimeout(()=>{box.textContent='';},120);}};
    if(mode==='late')setTimeout(()=>{btn.disabled=false;},150);
    const map={[c.i]:box,[c.b]:btn},sent=[];if(opt.href)map['[data-e2e="profile-icon"]']={getAttribute:()=>opt.href,closest:()=>null};
    class WS{constructor(){this.readyState=1;setTimeout(()=>{WSI=this;this.onopen&&this.onopen();},0);}send(x){sent.push(JSON.parse(x));}close(){}}let WSI=null;
    const document={querySelector:q=>map[q]||null,querySelectorAll:q=>map[q]?[map[q]]:[],execCommand:(cmd,_,t)=>{if(cmd==='insertText'&&mode!=='noinsert')box.textContent=t;else if(cmd==='selectAll'){}return true;}};
    const chrome={storage:{local:{get:(k,cb)=>cb({})},onChanged:{addListener(){}}}};
    const ctx={document,location:{href:'https://www.twitch.tv/popout/streamer/chat?popout='},chrome,WebSocket:WS,MutationObserver:class{observe(){}disconnect(){}},Event:class{},KeyboardEvent:class{},HTMLTextAreaElement:{prototype:{}},setTimeout,clearTimeout,setInterval,clearInterval,JSON,String,Object,Promise,console};
    vm.createContext(ctx);vm.runInContext(fs.readFileSync(path.join(extDir,file),'utf8'),ctx);await sleep(30);
    const t0=Date.now();WSI.onmessage({data:JSON.stringify({type:'send',id:'1',text:'halo dunia',as:opt.as})});
    let r=null;for(let n=0;n<150&&!r;n++){await sleep(20);r=sent.find(x=>x.type==='result');}
    return{r,ms:Date.now()-t0,clicks:btn.clicks,hello:sent.find(x=>x.type==='hello')};
  }
  const location_fake='https://www.twitch.tv/popout/streamer/chat?popout=';
  // v15.3.2: TikTok membandingkan akun yang login di Chrome dengan username di aplikasi (hanya memblokir kalau nama TERBACA dan BEDA)
  {const a=await runCs('tt.js','ok',{href:'/@tono',as:'dewi'});
   ok(a.r&&a.r.ok===false&&/@tono/.test(a.r.error)&&/@dewi/.test(a.r.error)&&a.clicks===0,'tt.js: akun login (tono) beda dengan username (dewi): ditolak dengan pesan jelas, tombol kirim TIDAK diklik');
   const b=await runCs('tt.js','ok',{href:'/@Tono',as:'tono'});ok(b.r&&b.r.ok===true&&b.clicks===1,'tt.js: akun login sama dengan username (beda huruf besar/kecil): terkirim');
   const c=await runCs('tt.js','ok',{as:'dewi'});ok(c.r&&c.r.ok===true&&c.clicks===1,'tt.js: nama akun login tidak terbaca: pengiriman tetap berjalan (tidak memblokir karena tebakan)');
   const d=await runCs('yt.js','ok',{href:'/@tono',as:'dewi'});ok(d.r&&d.r.ok===true,'platform lain mengabaikan pemeriksaan akun');}
  for(const f of Object.keys(CFG)){
    let o=await runCs(f,'ok');
    ok(o.hello&&o.hello.platform===CFG[f].plat&&o.r&&o.r.ok===true&&o.clicks===1&&o.ms<500,f+': kolom kosong 120 ms setelah klik -> hasil ok dilaporkan segera ('+o.ms+' ms, jeda lama minimal 1000 ms), tepat 1 klik');
    ok(o.hello&&o.hello.page===location_fake,f+': hello membawa alamat halaman (location.href) supaya server bisa mencocokkan tab dengan username (v15.3.1)');
    o=await runCs(f,'late');
    ok(o.r&&o.r.ok===true&&o.clicks===1&&o.ms>=140&&o.ms<700,f+': menunggu tombol kirim aktif lalu klik SEKALI ('+o.ms+' ms), tidak mengklik tombol yang masih nonaktif');
    o=await runCs(f,'stuck');
    ok(o.r&&o.r.ok===false&&/tidak terkirim/.test(o.r.error)&&o.clicks===1&&o.ms>=600&&o.ms<1500,f+': kolom tidak pernah kosong -> gagal setelah batas pengaman (~0,7-0,9 dtk, '+o.ms+' ms), tetap 1 klik (tidak ada pesan ganda)');
    o=await runCs(f,'noinsert');
    ok(o.r&&o.r.ok===false&&/tidak bisa dimasukkan/.test(o.r.error)&&o.clicks===0&&o.ms<300,f+': teks gagal masuk ke kolom -> error jelas, tidak mengklik, tidak lapor ok palsu');
  }
}

// ---- v15.1.7: buka tab chat otomatis lewat service worker (bg), kirim paralel, saklar ----
// Memakai klien WebSocket palsu: "bg" = service worker ekstensi, "cs" = content script platform. Perilaku Chrome asli TIDAK diuji di sini.
async function extTests(base,dir,j,raw){
  console.log('\n[ekstensi: buka tab otomatis & kirim paralel]');
  const WS=require('ws'),conn=(hello,onMsg)=>new Promise((res,rej)=>{const w=new WS('ws://127.0.0.1:3000/ext');w.on('open',()=>{w.send(JSON.stringify(hello));res(w);});w.on('message',d=>onMsg&&onMsg(JSON.parse(String(d)),w));w.on('error',rej);});
  const opens=[],vers=[],bg=await conn({type:'bg'},m=>{if(m.type==='open')opens.push(m);if(m.type==='ver')vers.push(m);});
  // v15.2.0: setelah koneksi 'bg', server memberi tahu versi aplikasi (ekstensi yang beda versi memuat ulang dirinya). Content script tidak menerimanya.
  await sleep(150);
  ok(vers.length===1&&vers[0].version===PKG.version,'server mengirim {type:\'ver\',version} = versi package.json ke service worker ('+PKG.version+') segera setelah koneksi bg');
  const csGot=[],csV=await conn({type:'hello',platform:'kick'},m=>csGot.push(m.type));await sleep(150);
  ok(!csGot.includes('ver'),'content script (hello platform) tidak menerima pesan ver');csV.close();
  const cs=(platform,delay)=>conn({type:'hello',platform},(m,w)=>{if(m.type==='send')setTimeout(()=>w.send(JSON.stringify({type:'result',id:m.id,ok:true})),delay||0);});
  const rdG=()=>JSON.parse(fs.readFileSync(path.join(dir,'settings.json'),'utf8')).global;
  await raw('/send-set',{on:true});await sleep(150); // v15.3.2: Kirim Chat bawaannya MATI; buka-tab otomatis butuh sendOn=true
  await j('/platform',{platform:'tiktok',on:true,user:'@abc.def'});
  await j('/platform',{platform:'youtube',on:true,user:'https://www.youtube.com/watch?v=abcdefghijk'});
  await sleep(200);
  // ekstensi platform belum terhubung -> server minta service worker membuka tab; content script terhubung -> pesan terkirim
  let csT=null;const pr=j('/send',{text:'halo',targets:['tiktok']});
  await sleep(700);csT=await cs('tiktok');
  const r1=await pr;
  ok(r1.tiktok==='ok','kirim: ekstensi belum terhubung -> tab dibuka otomatis -> lalu terkirim (ok)');
  ok(opens.length===1&&opens[0].platform==='tiktok'&&opens[0].url==='https://www.tiktok.com/@abc.def/live','server mengirim {type:open} ke service worker dengan alamat live TikTok');
  // sudah terhubung: tidak membuka tab lagi
  const r2=await j('/send',{text:'lagi',targets:['tiktok']});
  ok(r2.tiktok==='ok'&&opens.length===1,'ekstensi sudah terhubung: tidak ada perintah buka tab lagi');
  // YouTube: alamat live_chat popout dari ID video
  const pY=j('/send',{text:'yt',targets:['youtube']});await sleep(500);
  ok(opens.length===2&&opens[1].url==='https://www.youtube.com/live_chat?is_popout=1&v=abcdefghijk','YouTube: alamat live_chat?is_popout=1&v=<id> (cocok dengan pola content script)');
  const csY=await cs('youtube');ok((await pY).youtube==='ok','YouTube: terkirim setelah content script terhubung');
  // paralel: dua platform lambat (1,2 dtk) selesai ~1,2 dtk, bukan 2,4 dtk
  const csW=await cs('twitch',1200);csT.close();await sleep(150);const csT2=await cs('tiktok',1200);
  await j('/platform',{platform:'twitch',on:true,user:'streamer'});
  const t0=Date.now(),r3=await j('/send',{text:'p',targets:['tiktok','twitch']}),dt=Date.now()-t0;
  ok(r3.tiktok==='ok'&&r3.twitch==='ok'&&dt<2100,'/send paralel: dua platform lambat selesai bersamaan ('+dt+' ms, bukan berurutan)');
  // saklar mati: tidak membuka tab, pesan lama dipertahankan
  csT2.close();csY.close();await sleep(200);
  await raw('/autoopen-set',{on:false});await sleep(250);
  ok(rdG().autoOpen===false,'saklar "Buka halaman chat otomatis" tersimpan di settings.global.autoOpen');
  const n=opens.length,r4=await j('/send',{text:'x',targets:['tiktok']});
  ok(/ekstensi Chrome belum terhubung/.test(r4.tiktok)&&opens.length===n,'saklar mati: tidak membuka tab, pesan error lama dipertahankan');
  await raw('/autoopen-set',{on:true});await sleep(250);
  // service worker tidak ada: pesan jelas (setelah menunggu singkat), tidak menggantung
  bg.close();await sleep(250);const t1=Date.now(),r5=await j('/send',{text:'x',targets:['tiktok']});
  ok(/Chrome terbuka/.test(r5.tiktok)&&Date.now()-t1<5000,'tanpa service worker: pesan jelas "pastikan Chrome terbuka..." dan tidak menggantung');
  // ping bg dijawab pong (jaga service worker tetap hidup)
  const got=[];const bg2=await conn({type:'bg'},m=>got.push(m.type));bg2.send(JSON.stringify({type:'ping'}));await sleep(150);ok(got.includes('pong'),'ping dari service worker dijawab pong');
  // v15.3.1: tab chat yang terhubung HARUS milik username yang diisi (dulu cukup platform yang sama -> pesan bisa terkirim ke channel lain)
  csW.close();await sleep(150);
  const opens3=[],bg3=await conn({type:'bg'},m=>{if(m.type==='open')opens3.push(m);});
  const pg=(platform,page,hit)=>conn({type:'hello',platform,page},(m,w)=>{if(m.type==='send'){hit.n++;w.send(JSON.stringify({type:'result',id:m.id,ok:true}));}});
  const hitW={n:0},hitR={n:0},acc=async()=>(await fetch(base+'/account')).json();
  const wrongTw=await pg('twitch','https://www.twitch.tv/popout/orang_lain/chat?popout=',hitW);
  ok((await acc()).twitch===false,'tab Twitch milik channel lain: status \"belum terhubung\" (bukan terhubung)');
  const rW=await j('/send',{text:'x',targets:['twitch']});
  ok(/bukan milik username/.test(rW.twitch)&&hitW.n===0,'tab Twitch milik channel lain TIDAK dipakai: pesan tidak dikirim ke sana, error jelas ('+rW.twitch+')');
  ok(opens3.some(o=>o.platform==='twitch'&&o.url==='https://www.twitch.tv/popout/streamer/chat?popout='),'... dan halaman channel yang benar diminta dibuka lewat service worker');
  const rightTw=await pg('twitch','https://www.twitch.tv/popout/Streamer/chat?popout=',hitR);
  ok((await acc()).twitch===true,'tab milik username yang benar (beda huruf besar/kecil): status terhubung');
  const rR=await j('/send',{text:'y',targets:['twitch']});
  ok(rR.twitch==='ok'&&hitR.n===1&&hitW.n===0,'dua tab Twitch terbuka: pesan hanya ke tab username yang benar');
  // YouTube: dicocokkan lewat ID video (username yang diisi = link video abcdefghijk)
  const wrongYt=await pg('youtube','https://www.youtube.com/live_chat?is_popout=1&v=zzzzzzzzzzz',{n:0});
  ok((await acc()).youtube===false,'tab YouTube milik video lain: status belum terhubung');
  const rightYt=await pg('youtube','https://www.youtube.com/live_chat?is_popout=1&v=abcdefghijk',{n:0});
  ok((await acc()).youtube===true,'tab YouTube dengan video yang benar: status terhubung');
  const gotT=[],ttc=await conn({type:'hello',platform:'tiktok',page:'https://www.tiktok.com/@abc.def/live'},(m,w)=>{if(m.type==='send'){gotT.push(m);w.send(JSON.stringify({type:'result',id:m.id,ok:true}));}});
  await j('/send',{text:'z',targets:['tiktok']});
  ok(gotT.length===1&&gotT[0].as==='abc.def','server: pesan ke TikTok membawa akun yang diharapkan (as=abc.def)');
  const gotY=[];wrongYt.close();rightYt.close();await sleep(100);const ytc=await conn({type:'hello',platform:'youtube',page:'https://www.youtube.com/live_chat?is_popout=1&v=abcdefghijk'},(m,w)=>{if(m.type==='send'){gotY.push(m);w.send(JSON.stringify({type:'result',id:m.id,ok:true}));}});
  await j('/send',{text:'z',targets:['youtube']});ok(gotY.length===1&&!('as' in gotY[0]),'server: pesan ke YouTube tidak membawa as');
  [ttc,ytc].forEach(w=>{try{w.close();}catch{}});
  [wrongTw,rightTw,wrongYt,rightYt,bg3].forEach(w=>{try{w.close();}catch{}});
  [bg2,csW].forEach(w=>{try{w.close();}catch{}});
}

const html=()=>fs.readFileSync(path.join(build,'index.html'),'utf8');
// v15.5.0: jendela tombol (?view=ctl) dan jendela alert (?view=galert) punya halaman mungil sendiri
const pageHtml=q=>/^\?view=galert/.test(q)?fs.readFileSync(path.join(build,'galert.html'),'utf8'):/^\?view=ctl/.test(q)?fs.readFileSync(path.join(build,'ctl.html'),'utf8'):html();
const seeds=JSON.parse(fs.readFileSync(path.join(root,'src/seeds.json'),'utf8'));
const rivals=fs.readFileSync(path.join(root,'examples/rivals-chat-kiri.css'),'utf8');
const cozy=fs.readFileSync(path.join(root,'examples/cozy-multichat-earthy.css'),'utf8');
const TPL=[...seeds,{id:'c_riv',name:'rivals',css:rivals,struct:'std'},{id:'c_cozy',name:'cozy-multichat-earthy',css:cozy,struct:'cozy'}];
const mk=(ov,dock)=>({settings:{dock:{...(dock||{})},overlay:{...ov},global:{templates:TPL,hotkeys:{}}},cfg:{youtube:'@a',tiktok:'@b',enabled:{youtube:true,tiktok:true,twitch:true,kick:true}},status:{},viewers:{},
  history:[{p:'tiktok',name:'dewi anggraini',text:'halo teman',t:Date.now(),id:1},{p:'youtube',name:'Andi',text:'hai semua',mod:true,t:Date.now(),id:2},{p:'youtube',name:'Sinta_Rahma',text:'Terima kasih kak!',sc:{amount:'Rp50.000',color:'#ffca28'},t:Date.now(),id:3},
  {p:'tiktok',kind:'join',name:'rizkyy_',t:Date.now(),id:4},{p:'tiktok',kind:'gift',name:'Budi',gift:'Rose',n:5,coins:5,t:Date.now(),id:5},{p:'tiktok',kind:'like',name:'Sinta',others:3,n:48,t:Date.now(),id:6}]});
// ---- v15.3.2: login resmi Twitch DIHAPUS. Semua kirim chat lewat ekstensi Chrome; Kirim Chat bawaannya MATI. ----
async function extOnlyTests(base,dir,j,raw){
  console.log('\n[server: tanpa login Twitch, kirim chat hanya lewat ekstensi]');
  const WS=require('ws'),has=f=>fs.existsSync(path.join(root,f));
  ok(!has('src/twitch.js')&&!has('src/tokenstore.js')&&!has('src/oauth-config.js'),'berkas login resmi Twitch (twitch.js, tokenstore.js, oauth-config.js) sudah dihapus');
  const bundle=fs.readFileSync(path.join(build,'server.js'),'utf8');
  ok(!/id\.twitch\.tv|helix\/chat\/messages|auth\.dat|device_code/.test(bundle),'bundel server tidak lagi memuat kode login/Helix Twitch');
  for(const r of ['/auth-state','/auth-login','/auth-logout']){const x=await fetch(base+r,r==='/auth-state'?{}:{method:'POST',body:'{}'});const t=await x.text();ok(!/loggedIn|pending|configured/.test(t),r+' sudah tidak ada (tidak membalas status login)');}
  const conn=(platform,got,reply)=>new Promise((res,rej)=>{const w=new WS('ws://127.0.0.1:3000/ext');w.on('open',()=>{w.send(JSON.stringify({type:'hello',platform}));res(w);});w.on('message',d=>{const m=JSON.parse(String(d));if(m.type==='send'){got.push(platform+':'+m.text);w.send(JSON.stringify({type:'result',id:m.id,ok:reply!==false,error:'ekstensi gagal'}));}});w.on('error',rej);});
  await raw('/autoopen-set',{on:false}); // tidak ada service worker palsu di tes ini: jangan menunggu buka-tab
  await j('/platform',{platform:'twitch',on:true,user:'streamerx'});await j('/platform',{platform:'kick',on:true,user:'kickerx'});
  const got=[],csT=await conn('twitch',got),csK=await conn('kick',got);await sleep(150);
  let r=await j('/send',{text:'halo tw',targets:['twitch']});
  ok(r.twitch==='ok'&&got.join()==='twitch:halo tw','Twitch: pesan dikirim lewat ekstensi Chrome');
  got.length=0;r=await j('/send',{text:'campur',targets:['twitch','kick']});
  ok(r.twitch==='ok'&&r.kick==='ok'&&got.sort().join()==='kick:campur,twitch:campur','Twitch dan Kick: dua-duanya lewat ekstensi, paralel, hasil per platform seperti biasa');
  csT.close();await sleep(150);
  r=await j('/send',{text:'tanpa ekstensi',targets:['twitch']});
  ok(/ekstensi Chrome belum terhubung/.test(r.twitch)&&!/cadangan/.test(r.twitch),'Twitch tanpa ekstensi: pesan error ekstensi yang jelas (tidak ada lagi \"cadangan\")');
  csK.close();
  ok(!fs.existsSync(path.join(dir,'auth.dat')),'tidak ada berkas token (auth.dat) di folder data');
}
// ---- v15.3.2: Kirim Chat bawaannya MATI ----
async function sendDefaultOffTests(base,dir,j,raw){
  console.log('\n[server: Kirim Chat bawaan mati (eksperimental)]');
  const rdG=()=>JSON.parse(fs.readFileSync(path.join(dir,'settings.json'),'utf8')).global;
  const WS=require('ws');
  const opens=[],bg=await new Promise((res,rej)=>{const w=new WS('ws://127.0.0.1:3000/ext');w.on('open',()=>{w.send(JSON.stringify({type:'bg'}));res(w);});w.on('message',d=>{const m=JSON.parse(String(d));if(m.type==='open')opens.push(m);});w.on('error',rej);});
  await j('/platform',{platform:'kick',on:true,user:'kickerx'});await sleep(150);
  ok(rdG().sendOn===undefined,'pengaturan baru: sendOn belum ada (dianggap MATI)');
  await raw('/autoopen-set',{on:true});await sleep(250);
  const r1=await j('/send',{text:'x',targets:['kick']});
  ok(/ekstensi Chrome belum terhubung/.test(r1.kick)&&opens.length===0,'Kirim Chat belum dinyalakan: tab chat TIDAK dibuka otomatis walau saklar "Buka halaman chat otomatis" nyala');
  await raw('/send-set',{on:true});await sleep(250);
  ok(rdG().sendOn===true,'/send-set on:true menyimpan sendOn=true');
  const pr=j('/send',{text:'y',targets:['kick']});await sleep(600);
  ok(opens.length===1&&opens[0].platform==='kick'&&opens[0].url==='https://kick.com/kickerx','Kirim Chat dinyalakan: tab chat dibuka otomatis lagi');
  const cs=await new Promise((res,rej)=>{const w=new WS('ws://127.0.0.1:3000/ext');w.on('open',()=>{w.send(JSON.stringify({type:'hello',platform:'kick'}));res(w);});w.on('message',d=>{const m=JSON.parse(String(d));if(m.type==='send')w.send(JSON.stringify({type:'result',id:m.id,ok:true}));});w.on('error',rej);});
  ok((await pr).kick==='ok','... lalu pesan terkirim lewat ekstensi');cs.close();
  await raw('/send-set',{on:false});await sleep(250);ok(rdG().sendOn===false,'/send-set on:false menyimpan sendOn=false');
  await raw('/send-set',{});await sleep(250);ok(rdG().sendOn===false,'/send-set tanpa nilai = mati (bukan nyala)');
  bg.close();await sleep(150);
}
async function page(q,ov,dock,after,raw){
  const errs=[],posts=[],vc=new VirtualConsole();vc.on('jsdomError',e=>errs.push(e.message));
  const dom=new JSDOM(pageHtml(q),{url:'http://localhost:3000/'+q,runScripts:'dangerously',pretendToBeVisual:true,virtualConsole:vc,beforeParse(w){
    w.fetch=(u,o)=>{posts.push([u,o&&o.body]);return Promise.resolve({json:()=>Promise.resolve({}),text:()=>Promise.resolve('')});};
    w.confirm=()=>true;w.alert=()=>{};w.HTMLElement.prototype.scrollIntoView=()=>{};
    w.EventSource=class{constructor(){setTimeout(()=>this.onmessage&&this.onmessage({data:JSON.stringify({type:'init',data:mk(ov,dock)})}),20);}};}});
  const W=dom.window;if(!raw&&W.add&&W.flushB){const oa=W.add;W.add=function(m,re,B){const r=oa.call(this,m,re,B);if(!B)W.flushB();return r;};} // pengujian lama mengharapkan add() langsung menggambar; jalur gabung-per-frame diuji terpisah (raw=true)
  await sleep(350);const d=dom.window.document;
  await after(d,dom,posts);ok(errs.length===0,q+' tanpa error JavaScript'+(errs.length?': '+errs[0]:''));
}
function parserTests(){
  console.log('\n[Twitch & Kick: pengurai pesan]');
  const P=require(path.join(root,'src/platforms.js'));
  const a=P.twitchLine('@badges=moderator/1,subscriber/6;bits=100;display-name=Rina\\sK;emotes=25:0-4;first-msg=1 :r!r@r.tmi.twitch.tv PRIVMSG #k :Kappa Cheer100 mantap');
  ok(a.length===2&&a[0].kind==='first'&&a[1].text==='Kappa mantap'&&a[1].mod&&a[1].member&&a[1].sc.amount==='100 bits'&&a[1].emo[0][2].includes('/25/'),'Twitch: chat, badge, emote, Bits (cheermote dibuang), chatter baru');
  ok(P.twitchLine('@msg-id=subgift;display-name=J;msg-param-community-gift-id=1 :tmi.twitch.tv USERNOTICE #k').length===0,'Twitch: subgift bagian hadiah massal tidak membanjiri baris');
  const g=P.twitchLine('@msg-id=submysterygift;display-name=J;msg-param-mass-gift-count=10 :tmi.twitch.tv USERNOTICE #k')[0];ok(g.kind==='gift'&&g.n===10,'Twitch: hadiah massal = satu baris');
  const r=P.twitchLine('@msg-id=raid;msg-param-displayName=Besar;msg-param-viewerCount=250 :tmi.twitch.tv USERNOTICE #k')[0];ok(r.kind==='raid'&&r.n===250&&r.name==='Besar','Twitch: raid');
  const k=P.kickEvent('App\\Events\\ChatMessageEvent',JSON.stringify({content:'halo [emote:37226:KEKW] ya',sender:{username:'b',identity:{badges:[{type:'moderator'}]}}}))[0];
  ok(k.text==='halo KEKW ya'&&k.mod&&k.emo[0][0]===5&&/37226/.test(k.emo[0][2]),'Kick: chat, badge, emote');
  ok(P.kickEvent('KicksGifted',JSON.stringify({sender:{username:'z'},gift:{amount:100}}))[0].sc.amount==='100 Kicks','Kick: Kicks disorot seperti Super Chat');
  ok(['GiftedSubscriptionsEvent','SubscriptionEvent','StreamHostEvent','RewardRedeemedEvent','FollowersUpdated'].every(n=>P.kickEvent('App\\Events\\'+n,JSON.stringify({username:'u',gifter_username:'u',gifted_usernames:['a'],host_username:'u',followed:true})).length===1),'Kick: sub, gift sub, raid, reward, follow dikenali');
}
async function uiTests(){
  // v15.5.0: dock menggambar pesan sekali per frame, DOM lebih ramping
  await page('?view=dock',{},{},async(d,dom)=>{
    const w=dom.window,n0=d.querySelectorAll('#msgs>.m').length;
    w.eval("add({p:'tiktok',name:'Ana Maria',text:'a',t:Date.now()});add({p:'youtube',name:'Bob',text:'b',t:Date.now(),mod:true});add({p:'youtube',name:'Cici',text:'c',t:Date.now()});");
    ok(d.querySelectorAll('#msgs>.m').length===n0,'v15.5.0: add() di dock menampung dulu, belum menyentuh DOM');
    await sleep(160);
    ok(d.querySelectorAll('#msgs>.m').length===n0+3,'v15.5.0: tampungan digambar otomatis (rAF atau cadangan timer 100 ms)');
    const nm=[...d.querySelectorAll('.nm')].find(x=>/Ana/.test(x.textContent));
    ok(!!nm&&!d.querySelector('.nm i')&&nm.textContent==='Ana\u00a0Maria','v15.5.0: nama di dock satu teks (tanpa <i> per huruf), spasi tetap non-breaking');
    const mods=[...d.querySelectorAll('.m')].filter(x=>/Bob/.test(x.textContent));
    ok(mods.length===1&&mods[0].querySelectorAll('.bd').length===1&&!!mods[0].querySelector('.bd.mod'),'v15.5.0: lencana hanya dibuat untuk status yang dimiliki (MOD saja)');
    const biasa=[...d.querySelectorAll('.m')].find(x=>/Cici/.test(x.textContent));
    ok(!!biasa&&biasa.querySelectorAll('.bd').length===0,'v15.5.0: pesan biasa tanpa lencana tersembunyi');
    ok(d.documentElement.classList.contains('prot'),'v15.5.0: ikon mata dibaca dari pengaturan SSE (Sembunyikan dari OBS bawaan aktif)');},true);
  await page('?view=overlay',{},{},async(d,dom)=>{
    dom.window.eval("add({p:'tiktok',name:'Ana Maria',text:'a',t:Date.now()})");
    ok(!!d.querySelector('.nm i'),'v15.5.0: overlay tetap membuat nama per huruf (CSS gaya pengguna bisa menyasar .nm i) dan tetap menggambar langsung');});
  await page('?view=dock&locked=1',{},{},async(d,dom,posts)=>{
    dom.window.eval("for(let i=0;i<5;i++)add({p:'tiktok',name:'U'+i,text:'x',t:Date.now()})");
    await sleep(700);
    await sleep(100);
    ok(posts.some(x=>x[0]==='/shape'),'v15.6.0: dock terkunci (pin) melaporkan /shape (area klik = tombol bilah kontrol; chat dan kotak penonton tembus klik)');
    ok(!posts.some(x=>x[0]==='/state'),'v15.5.0: dock tidak polling /state');
    dom.window.eval("S.global.lockScroll=true;applyStyle()");
    await sleep(500);
    ok(posts.some(x=>x[0]==='/shape'),'v15.5.0: begitu scroll-saat-gembok dinyalakan, /shape dilaporkan lagi');},true);
  // v15.6.0: bilah kontrol di dalam window chat (bulatan chat -> kolom ketik + kirim + filter; tombol hanya ikon)
  await page('?view=dock&locked=1',{},{},async(d,dom,posts)=>{
    ok(!!d.querySelector('#cbar #cb_chat')&&!!d.querySelector('#cbar #cmp #msg')&&!!d.querySelector('#cbar #cmp #send')&&!!d.querySelector('#cbar #fwrap #fltb')&&!!d.querySelector('#cbar #fwrap #fltp'),'v15.6.2: bulatan chat, kolom ketik + kirim, bulatan filter (+ pilihannya) ada di bilah kanan bawah');
    ok(!d.getElementById('cb_pin')&&!d.getElementById('cb_eye')&&!d.getElementById('cb_move')&&!d.getElementById('cb_close')&&!d.getElementById('cgrp'),'v15.6.2: mata, pin, pindah, tutup TIDAK ada di dalam halaman chat (ada di jendela tombol di luar)');
    const ids=[...d.querySelectorAll('#cbar>*')].map(e=>e.id);
    ok(ids.indexOf('cb_chat')>=0&&ids.indexOf('fwrap')===ids.indexOf('cb_chat')+1&&d.getElementById('cbar').previousElementSibling.id==='lw','v15.6.2: bulatan filter tepat di sebelah kanan bulatan chat, dan bilah ada tepat di bawah daftar chat (dasar jendela)');
    ok(!d.getElementById('foot')&&!d.getElementById('flt')&&!d.getElementById('cb_lock'),'v15.6.0: kolom bawah lama (#foot, <select> filter) dan tombol gembok hilang');
    ok(d.getElementById('send').textContent.trim()===''&&!!d.querySelector('#send svg')&&d.getElementById('fltb').textContent.trim()==='','v15.6.0: tombol kirim dan filter hanya ikon, tanpa tulisan');
    ok(!d.getElementById('cbar').classList.contains('open'),'v15.6.0: kolom ketik tertutup bawaan');
    dom.window.eval("S.global.sendOn=true;applyStyle()");
    d.getElementById('cb_chat').click();
    ok(d.getElementById('cbar').classList.contains('open')&&posts.some(x=>x[0]==='/chat-focus'&&JSON.parse(x[1]).on===true),'v15.6.0: menekan bulatan chat membuka kolom ketik dan meminta fokus keyboard (jendela terkunci)');
    d.getElementById('fltb').click();
    ok(d.getElementById('cbar').classList.contains('fo')&&d.querySelectorAll('#fltp [data-f]').length>=2&&d.querySelector('#fltp [data-f=all]').textContent.trim()==='','v15.6.0: menekan tombol filter menampilkan pilihan (Semua + platform) berupa ikon');
    d.querySelector('#fltp [data-f=tiktok]').click();
    ok(/\bf-tiktok\b/.test(d.body.className)&&!d.getElementById('cbar').classList.contains('fo'),'v15.6.0: memilih filter dari ikon mengubah filter chat dan menutup pilihan');
    d.getElementById('cb_chat').click();
    ok(!d.getElementById('cbar').classList.contains('open')&&posts.some(x=>x[0]==='/chat-focus'&&JSON.parse(x[1]).on===false),'v15.6.0: menutup kolom ketik mengembalikan fokus ke game');
    const css=fs.readFileSync(path.join(root,'src/ui/style.css'),'utf8');
    ok(/body\.locked #app\{border-radius:\d+px;overflow:hidden\}/.test(css),'v15.6.0: mode gembok (pin) bersudut membulat');
    ok(/#fltp\{display:none;position:absolute;right:0;bottom:100%;[^}]*flex-direction:column-reverse/.test(css)&&/#cbar\{[^}]*justify-content:flex-end/.test(css)&&!/body\.dock:not\(\.cb-bot\) #cbar\{order:-1\}/.test(css),'v15.6.2: pilihan filter muncul KE ATAS dari bulatan filter; bilah rata kanan dan tidak dipindah ke atas');
    d.getElementById('fltb').click();
    ok(d.getElementById('cbar').classList.contains('fo'),'v15.6.2: bulatan filter membuka pilihan');
    d.getElementById('cb_chat').click();
    ok(!d.getElementById('cbar').classList.contains('fo')&&d.getElementById('cbar').classList.contains('open'),'v15.6.2: menekan bulatan chat menutup pilihan filter dan membuka kotak ketik');
    d.getElementById('cb_chat').click();},true);
  // v15.6.1: satu mode; keadaan pin dibawa kelas "pinned" dan diganti lewat window.__pin tanpa memuat ulang halaman
  await page('?view=dock&locked=1',{},{},(d,dom,posts)=>{
    const ev=(el,t)=>el.dispatchEvent(new dom.window.MouseEvent(t,{bubbles:true}));
    ok(d.body.classList.contains('locked')&&!d.body.classList.contains('pinned')&&!!d.getElementById('cb_chat'),'v15.6.1: tanpa &pin=1 jendela dimuat tidak terpin tetapi tetap tampilan locked (satu-satunya mode) dengan bilah bulatan yang sama');
    ok(JSON.stringify([...d.querySelectorAll('#rz [data-e]')].map(e=>e.dataset.e).sort())===JSON.stringify(['e','n','ne','nw','s','se','sw','w']),'v15.6.3: delapan pegangan resize (sisi bawah boleh lagi)');
    ev(d.querySelector('#rz [data-e=ne]'),'pointerdown');
    ok(posts.some(x=>x[0]==='/resize'&&JSON.parse(x[1]).on===true&&JSON.parse(x[1]).edge==='ne'),'v15.6.1: tidak terpin: menahan pegangan sudut atas meminta resize (/resize on=true edge=ne)');
    ev(d.querySelector('#rz [data-e=ne]'),'pointerup');
    ok(posts.some(x=>x[0]==='/resize'&&JSON.parse(x[1]).on===false),'v15.6.1: melepas pegangan menghentikan resize');
    dom.window.__pin(true);
    ok(d.body.classList.contains('pinned'),'v15.6.1: __pin(true): kelas pinned tanpa memuat ulang halaman');
    dom.window.eval("S.global.lockScroll=false;applyStyle()");
    ok(d.body.classList.contains('pinned'),'v15.6.1: kelas pinned bertahan saat applyStyle menimpa className');
    posts.length=0;ev(d.querySelector('#rz [data-e=n]'),'pointerdown');
    ok(!posts.some(x=>x[0]==='/resize'),'v15.6.1: terpin: pegangan resize tidak melakukan apa-apa');
    dom.window.__pin(false);
    ok(!d.body.classList.contains('pinned'),'v15.6.1: __pin(false): kelas pinned hilang');});
  await page('?view=dock&locked=1&pin=1',{},{},(d,dom,posts)=>{
    ok(d.body.classList.contains('locked')&&d.body.classList.contains('pinned'),'v15.6.1: &pin=1 = dimuat dalam keadaan terpin');});
  // v15.6.2: kotak tombol jendela chat (ctl.html?t=chat) = mata, pin (terisi = terpin), pindah, tutup; berubah lewat window.__st tanpa memuat ulang
  await page('?view=ctl&t=chat&prot=1&lk=0',{},{},(d,dom,posts)=>{
    ok(!!d.getElementById('eye')&&!!d.getElementById('unlock')&&!!d.getElementById('mover')&&!!d.getElementById('cclose')&&d.body.classList.contains('pinmode')&&!d.body.classList.contains('islocked'),'v15.6.2: kotak tombol chat: mata, pin, pindah, tutup; mode pin; awalnya tidak terpin');
    ok(/Pin jendela/.test(d.getElementById('unlock').title),'v15.6.2: kotak tombol chat tidak terpin: judul "Pin jendela"');
    d.getElementById('unlock').click();
    ok(posts.some(x=>x[0]==='/lock'&&JSON.parse(x[1]).on===true&&!('id' in JSON.parse(x[1]))),'v15.6.2: tombol pin di kotak tombol meminta pin jendela chat (/lock on=true tanpa id)');
    dom.window.__st({lk:true});
    ok(d.body.classList.contains('islocked')&&/Lepas pin/.test(d.getElementById('unlock').title),'v15.6.2: window.__st({lk:true}) = terpin: ikon terisi + judul "Lepas pin"');
    d.getElementById('mover').dispatchEvent(new dom.window.MouseEvent('pointerdown',{bubbles:true}));
    ok(posts.some(x=>x[0]==='/drag'&&JSON.parse(x[1]).on===true),'v15.6.2: tombol pindah memanggil /drag');
    d.getElementById('cclose').click();
    ok(posts.some(x=>x[0]==='/win'&&JSON.parse(x[1]).which==='main'&&JSON.parse(x[1]).act==='close'),'v15.6.2: tombol tutup menutup jendela chat');});
  await page('?view=ctl&t=abc&prot=1&lk=1',{},{},(d)=>{
    ok(d.body.classList.contains('pinmode')&&/Lepas pin/.test(d.getElementById('unlock').title)&&!d.getElementById('rsz'),'v1.0.2: kotak tombol Browser Dock memakai pin seperti chat, tanpa tombol ubah ukuran');});
  console.log('\n[tampilan]');
  await page('?view=dock',{},{theme:'neo'},(d,dom)=>{
    const m=d.querySelector('#msgs .m');ok(m&&m.querySelector('.tx').textContent==='halo teman','isi chat tampil (bukan hanya nama)');
    ok(/th-neo/.test(d.body.className),'tema dock diterapkan');ok(dom.window.__ready===true,'halaman menandai siap (window.__ready)');});
  await page('?view=overlay',{preset:'persona'},{},(d)=>{ok(!!d.querySelector('.p5-head')&&!!d.querySelector('.p5-text'),'Persona 5 memakai struktur .p5-msg');});
  await page('?view=overlay',{preset:'c_riv',fsName:30,fsText:26,gap:30,align:'right',order:'top'},{},(d)=>{
    ok(!!d.querySelector('#log .msg .badge svg'),'CSS bergaya rivals dikenali (struktur #log/.msg/.badge)');
    ok(/\bzm\b/.test(d.body.className)&&/gap-set/.test(d.body.className)&&/al-right/.test(d.body.className)&&/\bot\b/.test(d.body.className),'ukuran nama/teks, jarak, kanan dan arah-atas ikut berlaku untuk CSS buatan sendiri');
    ok(/an-tpl/.test(d.body.className),'animasi "otomatis" mengikuti animasi bawaan CSS');});
  { const h=html();
    ok(/body\.al-right\.s-rv \.msg\{[^}]*scale:var\(--sx\) 1/.test(h)&&/@keyframes aBounce\{[^@]*--sx/.test(h)&&/@keyframes aZoom\{[^@]*--sx/.test(h),'mirror kanan (rv) tidak tertimpa animasi masuk bounce/zoom (keyframes ikut --sx)'); }
  await page('?view=overlay',{},{},(d)=>{const sc=d.querySelector('#msgs .m.sc');ok(!!sc&&sc.querySelector('.amt').textContent==='Rp50.000'&&/ffca28/i.test(sc.style.getPropertyValue('--sc')),'Super Chat contoh tampil di pratinjau overlay (nominal + warna)');});
  await page('?view=overlay',{preset:'persona'},{},(d)=>{ok(d.querySelector('.p5-msg.sc .p5-amt')&&d.querySelector('.p5-msg.sc .p5-amt').textContent==='Rp50.000','Super Chat di gaya Persona 5');});
  await page('?view=overlay',{preset:'c_riv'},{},(d)=>{const h=d.querySelector('#log .msg.hl');ok(!!h&&/Rp50\.000/.test(h.querySelector('.tag').textContent),'Super Chat di gaya rivals memakai kelas .hl dan label nominal');});
  await page('?view=overlay',{preset:'kartu'},{},(d)=>{ok(!/\bzm\b/.test(d.body.className),'gaya yang sudah memakai variabel ukuran tidak digandakan skalanya');});
  await page('?view=settings',{},{theme:'clay'},(d)=>{
    ok(!!d.querySelector('#panes')&&!!d.querySelector('#ph .bar'),'pengaturan: tombol aksi tab Hotkey berada di bar bawah');
    ok(d.querySelectorAll('#hkl .hk').length===17,'17 aksi hotkey tampil (10 lama + 7 tambahan v15.3.4, yang baru kosong)');ok(/th-clay/.test(d.body.className),'tema tetap di jendela pengaturan');});
  await page('?view=tpl',{},{},(d)=>{ok(d.querySelectorAll('.tcard').length===8,'kelola gaya: Default + 5 bawaan + 2 buatan');});
  await page('?view=tpladd&id=persona',{},{},(d)=>{ok(d.getElementById('tn').value==='Persona 5','edit gaya bawaan terisi otomatis');});
  // ---- perbaikan: CSS buatan pengguna harus tampil apa adanya di overlay ----
  {const css=html(),bad=(css.match(/[^{}]*\{[^{}]*outline:\s*none\s*!important[^{}]*\}/g)||[]).filter(r=>!/body:not\(\.overlay\)/.test(r));
   ok(bad.length===0,'outline:none!important hanya untuk jendela aplikasi (overlay tidak boleh, supaya jahitan/outline CSS pengguna tampil)');
   ok(!/:is\(#msgs,#chat\)\{[^}]*gap:/.test(css),'wadah #chat (struktur cozy) tidak diberi gap bawaan');}
  await page('?view=overlay',{preset:'c_cozy'},{},(d)=>{
    ok(!!d.querySelector('#chat[data-mode="person"] .msg[data-color][data-platform]'),'CSS bergaya cozy dikenali (struktur #chat/.msg[data-color])');
    ok(d.querySelectorAll('#chat .msg').length===3,'riwayat tampil sebagai pesan cozy');
    const tg=d.querySelector('#chat .msg[data-type="event"] .tag');ok(!!tg&&tg.textContent==='Rp50.000','Super Chat di gaya cozy: data-type=event + label nominal');
    const im=d.querySelector('#chat .avatar img');im.onerror&&im.onerror();ok(!/<rect/.test(decodeURIComponent(im.src)),'foto cadangan (inisial) tanpa latar, warna latar ditentukan CSS gaya');});
  // ---- perbaikan: jendela "Gaya baru" dengan CSS kosong = pratinjau kosong ----
  await page('?view=overlay&preview=1&static=1&force=__draft',{},{},async(d,dom)=>{
    dom.window.postMessage({type:'tpldraft',css:''},'*');await sleep(1000);
    ok(d.querySelectorAll('.msg,.m').length===0,'Gaya baru: CSS kosong, pratinjau tidak menampilkan tampilan bawaan');
    dom.window.postMessage({type:'tpldraft',css:cozy},'*');await sleep(1600);
    ok(d.querySelectorAll('#chat .msg').length>=2,'Gaya baru: setelah CSS diisi, pratinjau muncul');
    dom.window.postMessage({type:'tpldraft',css:'  \n '},'*');await sleep(1000);
    ok(d.querySelectorAll('.msg,.m').length===0,'Gaya baru: CSS dikosongkan lagi, pratinjau ikut kosong');});
  // ---- aktivitas per platform, Total penonton, laporan ----
  await page('?view=dock',{},{},(d)=>{
    ok(d.querySelectorAll('#msgs .cs-act').length===2,'dock: join & gift tampil sebagai baris aktivitas, like (bawaan mati) tidak');
    ok(d.querySelectorAll('#msgs .m').length===3,'aktivitas tidak dihitung sebagai chat (.m)');
    ok(!!d.querySelector('#top #tot.vchip')&&!d.getElementById('anBtn')&&!d.getElementById('gear'),'Total penonton ada; tombol laporan dan pengaturan sudah dihapus dari dock');});
  await page('?view=dock',{},{},(d,dom)=>{dom.window.eval("EN.twitch=false;applyEnabled();add({p:'twitch',name:'x',text:'y',t:Date.now()})");
    ok(!d.querySelector('#msgs .m.tw')&&d.getElementById('cw').classList.contains('off'),'platform yang dimatikan: chat dan kotak header tidak tampil');});
  await page('?view=dock',{},{ttJoin:true,ttJoinBg:true,ttJoinBgC:'#112233',ttJoinBgOp:100,ttJoinFc:'#ff0000',ttLike:true,ttLikeSide:false},(d)=>{
    const j=d.querySelector('.cs-act.cs-join');ok(j&&/17, 34, 51/.test(j.style.background)&&/255, 0, 0/.test(j.style.color),'latar & warna font aktivitas mengikuti pengaturan');
    ok(!!d.querySelector('.cs-act.cs-like'),'jenis aktivitas yang dicentang (like) ikut tampil (kalau "like di samping" dimatikan)');});
  // v15.3.3: like di Dock bawaannya pindah ke samping (jendela alert), jadi tidak ada baris like di dalam chat
  await page('?view=dock',{},{ttLike:true},(d)=>{ok(!d.querySelector('.cs-act.cs-like'),'v15.3.3: like di Dock tampil di samping, tidak di dalam chat');
    ok(!d.getElementById('gat')&&!d.getElementById('glk')&&!d.getElementById('ctl'),'v15.5.0: halaman dock tidak lagi membawa wadah alert / kotak tombol (pindah ke galert.html / ctl.html)');});
  // v15.3.4: alert dan "tampil di chat" (Gift & Like) dicentang sendiri-sendiri; kalau dua-duanya dicentang, dua-duanya muncul. Pengaturan v15.3.3 dimigrasi (dua tes di atas = migrasi like).
  const galerts=posts=>posts.filter(p=>p[0]==='/galert').map(p=>JSON.parse(p[1]).m);
  // v15.5.5: alert like DIHAPUS. Like hanya notif di bawah total penonton (ttLike); pengaturan lama ttLikeAl tersimpan di komputer pengguna harus diabaikan, tidak ada alert like terkirim.
  await page('?view=dock',{},{ttLike:true,ttLikeAl:true},(d,dom,posts)=>{
    ok(!galerts(posts).some(m=>m.kind==='like'),'v15.5.5: like tidak pernah mengirim alert (ttLikeAl lama diabaikan)');});
  await page('?view=dock',{},{ttLike:false,ttLikeAl:true},(d,dom,posts)=>{
    ok(!d.querySelector('.cs-act.cs-like')&&!galerts(posts).some(m=>m.kind==='like'),'v15.5.5: like dimatikan + ttLikeAl lama = tidak tampil dan tidak ada alert');});
  await page('?view=dock',{},{ttGift:true,ttGiftAl:false},(d,dom,posts)=>{
    ok(!!d.querySelector('.cs-act.cs-gift')&&!galerts(posts).some(m=>m.kind==='gift'),'v15.3.4: gift hanya chat -> tanpa alert');});
  await page('?view=dock',{},{ttGift:false,ttGiftAl:true},(d,dom,posts)=>{
    ok(!d.querySelector('.cs-act.cs-gift')&&galerts(posts).some(m=>m.kind==='gift'),'v15.3.4: gift hanya alert -> tidak di chat, alert terkirim');});
  await page('?view=dock',{},{ttGift:true,ttGiftAl:true,ttGiftAlSz:130,ttGiftAlOrder:'top',ttGiftAlDur:9,ttGiftAlMax:4},(d,dom,posts)=>{
    const g=galerts(posts).find(m=>m.kind==='gift');ok(!!g&&g.size===130&&g.order==='top'&&g.dur===9&&g.max===4,'v15.3.4: alert membawa ukuran, arah, lama, dan jumlah milik jenisnya');});
  await page('?view=dock',{},{ttGift:true,ttGaDur:11,ttGaMax:5},(d,dom,posts)=>{
    const g=galerts(posts).find(m=>m.kind==='gift');ok(!!g&&g.dur===11&&g.max===5,'v15.3.4: pengaturan lama ttGaDur/ttGaMax dibawa ke alert baru');});
  await page('?view=galert',{},{},(d,dom)=>{
    ok(!!d.getElementById('gat')&&!d.getElementById('glk'),'v15.5.5: halaman alert hanya punya wadah alert hadiah (#gat); wadah like (#glk) sudah dihapus');
    dom.window.eval("['A','B','C','D'].forEach(n=>giftAlert({kind:'gift',name:n,gift:'Rose',n:1,t:Date.now(),dur:30,max:3,size:150,order:'top'}))");
    const e=d.querySelector('#gat .ga');
    ok([...d.querySelectorAll('#gat .ga b')].map(x=>x.textContent).join('')==='DCB','v15.3.4: arah "atas" = alert baru di atas, maksimal 3');
    ok(e.style.getPropertyValue('--gs')==='1.5'&&e.classList.contains('wrap'),'v15.3.4: ukuran alert 150% memberi --gs dan boleh turun baris');
    dom.window.eval("giftAlert({kind:'gift',name:'Z',gift:'Rose',n:1,t:Date.now(),dur:30,max:3})");
    ok([...d.querySelectorAll('#gat .ga')].pop().style.getPropertyValue('--gs')==='1','v15.3.4: tanpa ukuran = bawaan 100%');});
  await page('?view=dock',{},{ttShare:true},(d,dom)=>{
    dom.window.eval("add({p:'tiktok',kind:'share',name:'Sari',t:Date.now()})");
    const a=d.querySelector('.cs-act.cs-share .ai');ok(!!a&&!!a.querySelector('svg.pln')&&a.textContent==='','v15.3.4: "Membagikan live" memakai ikon pesawat kertas (SVG)');});
  await page('?view=settings',{},{},(d,dom)=>{
    ok(!d.getElementById('dock_ttLikeAl')&&!d.getElementById('dock_ttLikeAlSz')&&!!d.getElementById('dock_ttGiftAl')&&!!d.getElementById('dock_ttGiftAlSz')&&!!d.getElementById('dock_ttGiftAlOrder'),'v15.5.5: pengaturan alert hanya ada di Gift (alert Like dihapus)');
    ok(!!d.getElementById('dock_ttJoinMax')&&!d.getElementById('overlay_ttJoinMax')&&+d.getElementById('dock_ttJoinMax').value===1&&+d.getElementById('dock_ttJoinMax').max===3&&+d.getElementById('dock_ttJoinMax').min===1,'v15.5.5: slider jumlah notif bergabung ada di Pribadi (bawaan 1, 1-3) dan tidak ada di Overlay');
    ok(!d.getElementById('dock_ttLikeSide')&&!d.getElementById('dock_ttGaDur')&&!d.getElementById('dock_ttGaMax'),'v15.3.4: kartu lama \"Alert di samping chat\" sudah tidak ada');
    ok(!d.getElementById('overlay_ttLikeAl')&&!d.getElementById('overlay_ttGiftAl')&&!!d.getElementById('overlay_ttLike'),'v15.3.4: Overlay tidak punya alert, kotak centang Like tetap ada');
    ok(!!d.querySelector('#pgdock_tt .pln')&&!!d.querySelector('#pgoverlay_tt .pln'),'v15.3.4: ikon pesawat kertas di pengaturan Share (Pribadi dan Overlay)');
    ok(!!d.getElementById('apv_ttGift')&&!d.getElementById('apv_ttLike')&&!d.getElementById('pvA')&&!d.getElementById('overlay_apv_ttGift')&&!d.querySelector('#pgb_overlay_tt .apv'),'v15.4.0: pratinjau alert ada di dalam pengaturan Gift (hanya Pribadi; Like tidak punya alert sejak v15.5.5), bukan lagi di panel chat kanan');
    ok(dom.window.eval("pendingChanges('p').length")===0&&dom.window.eval("pendingChanges('o').length")===0,'v15.4.0: baru dibuka = tidak ada perubahan belum diterapkan');
    { // v15.6.5: pengaturan TikTok dikotak-kotakkan (Pribadi dan Overlay); Gift Pribadi: "tampil di chat" dan "alert" masing-masing satu kotak
      const bx=id=>{const e=d.getElementById(id);return e?e.closest('.actbox'):null;},up=b=>b&&b.parentElement?b.parentElement.closest('.actbox'):null;
      const dTop=[...d.querySelectorAll('#pgb_dock_tt .actbox')].filter(b=>!up(b)),oTop=[...d.querySelectorAll('#pgb_overlay_tt .actbox')].filter(b=>!up(b));
      ok(dTop.length===7&&oTop.length===7,'v15.6.5: pengaturan TikTok (Pribadi dan Overlay) = 7 kotak, satu per jenis aktivitas');
      const gc=bx('dock_ttGift'),ga=bx('dock_ttGiftAl');
      ok(!!gc&&!!ga&&gc!==ga&&up(gc)&&up(gc)===up(ga),'v15.6.5: Gift Pribadi: "Tampilkan di chat" dan "Aktifkan alert" masing-masing satu kotak di dalam kotak Hadiah');
      ok(!!bx('overlay_ttGift')&&!up(bx('overlay_ttGift'))&&!d.querySelector('#pgb_overlay_tt .actbox .actbox'),'v15.6.5: Gift Overlay tetap satu kotak (tanpa kotak di dalam kotak)');
      ok(!!d.getElementById('dock_ttGiftMin')&&!!d.getElementById('overlay_ttGiftMin')&&!!d.getElementById('dock_ttGiftBg')&&!!d.getElementById('overlay_ttGiftBg')&&!!d.getElementById('dock_ttGiftFc')&&!!d.getElementById('overlay_ttGiftFc'),'v15.6.5: semua pengaturan Gift tetap ada di Pribadi dan Overlay (batas koin, latar, warna font)');
      const ck=dom.window.eval("Object.keys(collect('dock'))"),ck2=dom.window.eval("Object.keys(collect('overlay'))");
      ok(['ttGift','ttGiftAl','ttGiftAlSz','ttGiftBg','ttGiftBgC','ttGiftBgOp','ttGiftFc','ttGiftMin','ttLike','ttLikeBg','ttLikeFc','ttJoinMax','ttLikeTot'].every(k=>ck.includes(k))&&['ttGift','ttGiftBg','ttGiftMin','ttLike','ttLikeBg'].every(k=>ck2.includes(k)),'v15.6.5: collect() tetap membaca semua kunci pengaturan TikTok');
      ok(!!d.querySelector('#pgb_dock_tt .actbox .acttl')&&!d.querySelector('#pgb_overlay_tt .acttl'),'v15.6.5: judul kotak hanya di Pribadi (seperti sebelumnya)');
    }
    dom.window.eval("(()=>{const e=document.getElementById('dock_fsText');e.value=30;const c=document.getElementById('dock_ttGiftAl');c.checked=false;})()");
    const pc=dom.window.eval("JSON.stringify(pendingChanges('p').map(x=>[x.g,x.label,x.from.t,x.to.t]))");
    ok(/Ukuran chat/.test(pc)&&/Aktifkan alert/.test(pc)&&dom.window.eval("pendingChanges('p').length")===2&&dom.window.eval("pendingChanges('o').length")===0,'v15.4.0: perubahan belum diterapkan terdeteksi dan diberi nama (Ukuran chat, Aktifkan alert)');
    dom.window.eval("discardSec('p')");
    ok(dom.window.eval("pendingChanges('p').length")===0&&d.getElementById('dock_fsText').value==='16'&&d.getElementById('dock_ttGiftAl').checked===true,'v15.4.0: Buang mengembalikan kotak ke nilai tersimpan');});
  await page('?view=dock',{},{ttAct:false},(d)=>{ok(d.querySelectorAll('.cs-act').length>0,'v1.1.8: Monitor > TikTok tidak punya kotak \"Tampilkan aktivitas\" lagi; ttAct lama (false) diabaikan di Monitor');});
  await page('?view=dock',{},{joins:false},(d)=>{ok(!d.querySelector('.cs-join'),'pengaturan lama joins:false tetap dihormati');});
  await page('?view=dock',{},{ytSc:false},(d)=>{ok(!d.querySelector('.m.sc'),'Super Chat bisa disembunyikan');});
  await page('?view=dock',{},{ytScBg:'custom',ytScBgC:'#00ff00',ytScFcOn:true,ytScFc:'#123456',ytScAmt:false},(d)=>{const m=d.querySelector('.m.sc');
    ok(m&&m.style.getPropertyValue('--sc')==='#00ff00'&&/hasfc/.test(m.className)&&/noamt/.test(m.className),'gaya Super Chat (latar, font, nominal) diterapkan');});
  await page('?view=overlay',{},{},(d)=>{ok(!d.querySelector('.cs-join')&&!!d.querySelector('.cs-gift'),'overlay: join mati bawaan, gift hidup bawaan');});
  await page('?view=settings',{},{},(d)=>{
    ok(['dock','overlay'].every(v=>['yt','tt','tw','kk'].every(p=>d.getElementById('pg'+v+'_'+p)&&d.getElementById('pgb_'+v+'_'+p).children.length>0)),'pengaturan: halaman YouTube, TikTok, Twitch & Kick ada di Pribadi dan Overlay');
    d.querySelector('[data-pg="overlay_tt"]').click();ok(d.getElementById('pgoverlay_tt').classList.contains('on')&&d.querySelector('.tab[data-t="o"]').classList.contains('on'),'tombol platform membuka halamannya, tab Overlay tetap menyala');
    const dep=d.querySelector('[data-dep="overlay_ttJoin"]'),cb=d.getElementById('overlay_ttJoin');ok(dep.style.display==='none','pilihan latar/warna font tersembunyi sebelum dicentang');
    cb.checked=true;cb.dispatchEvent(new d.defaultView.Event('input',{bubbles:true}));ok(dep.style.display==='','pilihan muncul setelah dicentang');
    d.querySelector('[data-back="o"]').click();ok(d.getElementById('po').classList.contains('on'),'tombol Kembali');});
  // ---- Twitch & Kick ----
  await page('?view=dock',{},{},(d,dom)=>{
    dom.window.eval("add({p:'twitch',name:'a',text:'x',t:Date.now(),vip:true});add({p:'kick',name:'b',text:'y',t:Date.now(),member:true});add({p:'twitch',kind:'raid',name:'c',n:5,t:Date.now()});add({p:'kick',kind:'follow',name:'d',t:Date.now()})");
    ok(!!d.querySelector('#msgs .m.w.tw[data-platform="twitch"].isvip')&&!!d.querySelector('#msgs .m.k.kk[data-platform="kick"].ismem'),'dock: chat Twitch (.w) dan Kick (.k) punya kelas, data-platform dan badge sendiri');
    ok(!!d.querySelector('.cs-act.cs-tw.cs-raid')&&!!d.querySelector('.cs-act.cs-kk.cs-follow'),'aktivitas Twitch (raid) dan Kick (follow) tampil');
    ok(!!d.querySelector('#top #cw')&&!!d.querySelector('#top #ck'),'header penonton punya kotak Twitch dan Kick');});
  await page('?view=overlay&preview=1&static=1&force=kartu',{},{},async(d)=>{await sleep(5200);
    ok(d.querySelectorAll('#msgs .m,#msgs .cs-act').length>=4,'pratinjau overlay terus menerima pesan acak');
    const pf=new Set([...d.querySelectorAll('#msgs [data-platform]')].map(x=>x.dataset.platform));ok(pf.size>=2,'pesan acak berasal dari beberapa platform');});
  await page('?view=report',{},{},async(d,dom)=>{await sleep(200);ok(/reportwin/.test(d.body.className)&&!!d.getElementById('rbody'),'jendela laporan dimuat');});
  // ---- v15.3.2: Kirim Chat bawaan MATI (sendOn belum ada = mati); baru tampil kalau sendOn===true ----
  await page('?view=dock',{},{},(d,dom)=>{
    ok(/\bnosend\b/.test(d.body.className),'bawaan (sendOn belum ada): body punya kelas nosend, kotak isi chat tersembunyi');
    dom.window.eval("S.global.sendOn=true;applyStyle()");
    ok(!/\bnosend\b/.test(d.body.className),'sendOn=true: kelas nosend hilang, kotak isi chat tampil');
    dom.window.eval("delete S.global.sendOn;applyStyle()");
    ok(/\bnosend\b/.test(d.body.className),'sendOn dihapus lagi: kembali tersembunyi');});
  // ---- Kirim Chat dimatikan: hanya kotak isi chat dan tombol kirim yang hilang ----
  await page('?view=dock',{},{},(d,dom)=>{
    dom.window.eval("S.global.sendOn=false;applyStyle()");
    ok(/\bnosend\b/.test(d.body.className),'Kirim Chat mati: body diberi kelas nosend');
    const css=fs.readFileSync(path.join(root,'src/ui/style.css'),'utf8');
    ok(/body\.nosend #msg,body\.nosend #send\{display:none!important\}/.test(css)&&!/body\.nosend #cbar/.test(css),'Kirim Chat mati: CSS hanya menyembunyikan #msg dan #send (bukan seluruh bilah kontrol)');
    ok(!!d.querySelector('#fwrap #fltb'),'v15.6.2: bulatan filter tetap ada walau Kirim Chat mati');
    ok(/body\.nosend #cb_chat\{display:none!important\}/.test(css),'v15.6.2: Kirim Chat mati: bulatan chat (pembuka kotak ketik) ikut disembunyikan, bulatan filter tetap');});
  // ---- v15.1.7: filter "Semua" hanya mengirim ke platform yang dinyalakan DAN terhubung ----
  await page('?view=dock',{},{},async(d,dom,posts)=>{
    const w=dom.window,T=(f,en,st)=>JSON.stringify(w.eval('sendTargets')(f,en,st));
    const EN4={youtube:true,tiktok:true,twitch:false,kick:true};
    ok(T('all',EN4,{youtube:'gagal: x',tiktok:'terhubung',twitch:'terhubung',kick:'Terhubung'})==='["tiktok","kick"]','Semua: hanya yang dinyalakan + Terhubung (Twitch mati dilewati, YouTube gagal dilewati)');
    ok(T('all',EN4,{})==='[]'&&T('all',EN4,{youtube:'belum diisi',tiktok:'terputus'})==='[]','Semua: tidak ada yang tersambung -> daftar kosong');
    ok(T('youtube',EN4,{})==='["youtube"]','filter satu platform yang belum tersambung: tetap dipakai apa adanya (error eksplisit dari server)');
    // doSend end-to-end (fetch palsu mencatat POST)
    w.eval("filt='all';status={youtube:'gagal: x',tiktok:'terhubung',twitch:'',kick:''};");
    d.getElementById('msg').value='halo';d.getElementById('send').click();await sleep(80);
    const sent=posts.filter(x=>x[0]==='/send').map(x=>JSON.parse(x[1]));
    ok(sent.length===1&&JSON.stringify(sent[0].targets)==='["tiktok"]','doSend "Semua": POST /send hanya berisi platform yang tersambung');
    w.eval("status={youtube:'terputus'};");d.getElementById('msg').value='halo';d.getElementById('send').click();
    ok(posts.filter(x=>x[0]==='/send').length===1&&d.getElementById('msg').placeholder==='Belum ada platform yang tersambung.','doSend "Semua" tanpa yang tersambung: flash "Belum ada platform yang tersambung." dan tidak ada POST');
    w.eval("filt='youtube'");d.getElementById('send').click();
    ok(posts.filter(x=>x[0]==='/send').length===2&&JSON.parse(posts.filter(x=>x[0]==='/send')[1][1]).targets[0]==='youtube','filter YouTube yang belum tersambung tetap mengirim (perilaku lama)');
    ok(!!d.getElementById('autoOpen'),'Koneksi punya saklar "Buka halaman chat otomatis di Chrome"');});
  // ---- v15.2.0: kirim optimistis (kolom langsung kosong; kembali kalau SEMUA target gagal) ----
  await page('?view=dock',{},{},async(d,dom)=>{
    const w=dom.window,msg=d.getElementById('msg');let res=null,calls=[];
    const hold=()=>{calls=[];w.fetch=(u,o)=>{calls.push([u,o&&o.body]);return new Promise((ok2,no)=>{res={yes:v=>ok2({json:()=>Promise.resolve(v)}),no};});};};
    const send=t=>{msg.value=t;d.getElementById('send').click();};
    w.eval("filt='all';status={tiktok:'terhubung'};");
    hold();send('halo');
    ok(msg.value===''&&calls.length===1,'optimistis: kolom pesan kosong LANGSUNG saat kirim, sebelum server menjawab');
    res.yes({tiktok:'ekstensi Chrome belum terhubung'});await sleep(30);
    ok(msg.value==='halo'&&/TikTok: ekstensi Chrome belum terhubung/.test(msg.placeholder),'semua target gagal: teks kembali ke kolom dan error tampil');
    hold();send('halo');res.yes({tiktok:'ok'});await sleep(30);
    ok(msg.value==='','berhasil: kolom tetap kosong');
    w.eval("status={youtube:'terhubung',tiktok:'terhubung'};");
    hold();send('halo');res.yes({youtube:'gagal x',tiktok:'ok'});await sleep(30);
    ok(msg.value===''&&/YouTube: gagal x/.test(msg.placeholder),'minimal satu berhasil: tetap kosong, error platform yang gagal tetap tampil');
    hold();send('a');msg.value='b';res.yes({youtube:'gagal x',tiktok:'gagal y'});await sleep(30);
    ok(msg.value==='a b','gagal total saat pengguna sudah mengetik pesan baru: teks yang gagal ditaruh di depan, tidak menimpa pesan baru');
    hold();send('halo');res.no(new Error('jaringan putus'));await sleep(30);
    ok(msg.value==='halo'&&/Gagal: jaringan putus/.test(msg.placeholder),'request gagal (jaringan): teks kembali dan error tampil');
    hold();send('satu');send('dua');ok(calls.length===2&&msg.value==='','beberapa pesan beruntun boleh berjalan bersamaan (tombol kirim tidak dikunci)');
  });
  // ---- v15.3.2: tanpa login Twitch; Twitch/Kick dan Kirim Chat berlabel (eksperimental); Kirim Chat bawaan MATI ----
  await page('?view=dashboard',{},{},async(d,dom,posts)=>{
    const w=dom.window,exp=el=>!!el&&/\(eksperimental\)/.test(el.textContent);
    ok(!d.getElementById('au_twitch')&&!d.getElementById('aus_twitch')&&!d.getElementById('aub_twitch')&&!d.querySelector('.cau')&&!/Masuk dengan Twitch/.test(d.body.textContent),'Koneksi: tidak ada lagi baris/tombol login Twitch');
    ok(w.eval('typeof auRender')==='undefined'&&w.eval('typeof authRefresh')==='undefined','kode login Twitch di app.js sudah dihapus (auRender/authRefresh)');
    await sleep(80);ok(!posts.some(x=>/auth-/.test(x[0])),'halaman tidak lagi memanggil /auth-state, /auth-login, atau /auth-logout');
    ok(exp(d.querySelector('#cn_twitch .cnh b'))&&exp(d.querySelector('#cn_kick .cnh b')),'kartu Koneksi Twitch dan Kick berlabel (eksperimental)');
    ok(!exp(d.querySelector('#cn_youtube .cnh b'))&&!exp(d.querySelector('#cn_tiktok .cnh b')),'YouTube dan TikTok TIDAK berlabel eksperimental');
    ok(exp(d.querySelector('h3.h3sw'))&&/Kirim Chat/.test(d.querySelector('h3.h3sw').textContent),'judul kartu Kirim Chat berlabel (eksperimental)');
    ok(exp(d.querySelector('.chip2[data-pf="twitch"]'))&&exp(d.querySelector('.chip2[data-pf="kick"]'))&&!exp(d.querySelector('.chip2[data-pf="youtube"]')),'status Kirim Chat: Twitch dan Kick berlabel (eksperimental), YouTube tidak');
    ok(['dock_tw','dock_kk','overlay_tw','overlay_kk'].every(g=>exp(d.querySelector('.plat[data-pg="'+g+'"] b')))&&!['dock_yt','dock_tt','overlay_yt','overlay_tt'].some(g=>exp(d.querySelector('.plat[data-pg="'+g+'"] b'))),'tombol pengaturan Twitch & Kick (Pribadi dan Overlay) berlabel (eksperimental)');
    ok(d.getElementById('sendOn').checked===false,'saklar Kirim Chat bawaan MATI (sendOn belum ada di pengaturan)');
    w.eval("S.global.sendOn=true;fillGlobal()");ok(d.getElementById('sendOn').checked===true,'sendOn=true: saklar menyala');
    w.eval("S.global.sendOn=false;fillGlobal()");ok(d.getElementById('sendOn').checked===false,'sendOn=false: saklar mati');
    d.getElementById('sendOn').checked=true;d.getElementById('sendOn').dispatchEvent(new w.Event('change',{bubbles:true}));await sleep(40);
    ok(posts.some(x=>x[0]==='/send-set'&&/"on":true/.test(x[1]||'')),'menyalakan saklar memanggil /send-set on:true');});
  // ---- Donate Dock ----
  await page('?view=donatebar',{},{},(d,dom,posts)=>{
    ok(/donatewin/.test(d.body.className)&&d.getElementById('tbt').textContent==='Browser Dock'&&dom.window.__ready===true,'bilah judul Donate Dock dimuat dan menandai siap');
    d.getElementById('wclose').click();ok(posts.some(x=>x[0]==='/win'&&/"which":"donate"/.test(x[1])&&/"act":"close"/.test(x[1])),'tombol tutup bilah judul memanggil /win which=donate');});
  await page('?view=dashboard',{},{},async(d,dom,posts)=>{
    ok(!!d.getElementById('pn')&&!!d.querySelector('.sbi[data-t="n"]'),'Dashboard punya tab Donate Dock');
    d.getElementById('dDockAdd').click();ok(!d.getElementById('dnModal').hidden,'tombol Tambah Donate Dock membuka dialog');
    d.getElementById('dnmUrl').value='https://saweria.co/widgets/alert?streamKey=x';d.getElementById('dnmMute').checked=true;d.getElementById('dnmSave').click();await sleep(80);
    ok(posts.some(x=>x[0]==='/donate-docks'&&/saweria/.test(x[1]||'')&&/"mute":true/.test(x[1]||'')),'tombol Simpan di dialog memanggil /donate-docks dengan URL dan pilihan bisu');
    ok(/Browser Dock/.test(d.getElementById('hkl').textContent),'hotkey Buka / tutup Donate Dock muncul di tab Hotkey');});
  await page('?view=ctl&t=chat&prot=1&lk=0',{},{},(d,dom,posts)=>{
    ok(!!d.getElementById('eye')&&!!d.getElementById('unlock')&&!!d.getElementById('mover')&&!!d.getElementById('cclose'),'jendela kecil gembok punya 4 kotak (mata, gembok, pindah, tutup)');
    ok(d.body.classList.contains('prot')&&!d.body.classList.contains('islocked'),'v15.5.0: keadaan awal tombol dibaca dari alamat (prot=1, lk=0), bukan polling');
    dom.window.__st({prot:false,lk:true});
    ok(!d.body.classList.contains('prot')&&d.body.classList.contains('islocked'),'v15.5.0: main.js bisa mendorong keadaan baru lewat window.__st');
    d.getElementById('cclose').click();
    ok(posts.some(x=>x[0]==='/win'&&/"act":"close"/.test(x[1]||'')&&/"which":"main"/.test(x[1]||'')),'tombol tutup memanggil /win close');
    ok(!posts.some(x=>x[0]==='/dash-state'||x[0]==='/state'),'v15.5.0: halaman tombol tidak memanggil /dash-state saat alamat sudah membawa keadaan');});
  await page('?view=ctl&t=d1',{},{},(d,dom,posts)=>{
    ok(posts.some(x=>x[0]==='/dash-state'),'v15.5.0: kalau dibuka tanpa parameter keadaan, ambil /dash-state satu kali');});
}
// v15.4.2: pemeriksaan statis performa buka aplikasi / gembok (membaca kode sumber; Electron tidak bisa dijalankan di sini)
function perfTests(){
  const M=fs.readFileSync(path.join(root,'src/main.js'),'utf8'),S=fs.readFileSync(path.join(root,'src/server.js'),'utf8');
  const a=M.indexOf('function attachAlert'),mk=M.indexOf('const make=',a);
  ok(a>0&&mk>a&&!/new BrowserWindow/.test(M.slice(a,mk)),'v15.4.2: jendela alert tidak dibuat langsung saat chat dibuka/digembok (dibuat malas di make())');
  ok(!/ALERT_WARM_MS/.test(M)&&!/warmT/.test(M),'v15.5.0: tidak ada lagi pemanasan jendela alert (dibuat hanya saat alert datang)');
  ok(/ALERT_IDLE_MS\s*=\s*\d+/.test(M)&&/const release=/.test(M)&&/st\.idleT=setTimeout\(release,ALERT_IDLE_MS\)/.test(M)&&/cc\.destroy\(\)/.test(M.slice(M.indexOf('const release='),M.indexOf('const stop='))),'v15.5.0: jendela alert dilepas (destroy) ALERT_IDLE_MS sesudah alert terakhir');
  ok(/if\(!st\.poll&&useHole\(\)\)st\.poll=setInterval\(input,400\)/.test(M),'v15.5.0: polling bentuk jendela alert 400 ms hanya di mode lubang');
  ok(/function pushCtl\(\)/.test(M)&&/pushCtl\(\);applyLockedInput/.test(M)&&/&prot='\+\(protect\?1:0\)\+'&lk='\+\(L\?1:0\)/.test(M),'v15.5.0: keadaan jendela tombol diberi lewat alamat dan didorong saat Sembunyikan dari OBS diganti');
  ok(/near\?33:70/.test(M)&&/if\(!PROTECT_PASSTHRU\)D\.scanT=setInterval/.test(M),'v15.5.0: lsTick 33/70 ms dan dockScan hanya dijadwalkan di mode lubang');
  ok(/miniHtml\[v\]/.test(S)&&/v==='ctl'\|\|v==='galert'/.test(S)&&/\['ctl\.html','galert\.html'\]/.test(fs.readFileSync(path.join(root,'scripts/build.js'),'utf8')),'v15.5.0: server menyajikan ctl.html / galert.html, dan build.js menulisnya');
  ok(fs.statSync(path.join(build,'ctl.html')).size<8000&&fs.statSync(path.join(build,'galert.html')).size<8000&&!/EventSource/.test(fs.readFileSync(path.join(build,'ctl.html'),'utf8')+fs.readFileSync(path.join(build,'galert.html'),'utf8')),'v15.5.0: halaman jendela tombol dan alert kurang dari 8 KB dan tanpa SSE');
  ok(/module\.exports=\{[^}]*\bpreload\b/.test(S)&&/require\('youtube-chat'\)/.test(S.slice(S.indexOf('function preload'),S.indexOf('function chatUrl')))&&/require\('tiktok-live-connector'\)/.test(S.slice(S.indexOf('function preload'),S.indexOf('function chatUrl'))),'v15.4.2: server mengekspor preload() yang memuat pustaka YouTube dan TikTok');
  const su=M.slice(M.indexOf('function startUp'),M.indexOf('// ===== Donate Dock'));
  ok(/srv\.preload/.test(su)&&/srvP\.then\(\(\)=>makeDash\(\)\)/.test(su),'v15.4.2: splash memuat pustaka konektor dan memulai Dashboard paralel dengan cek update');
  const sm=+(M.match(/const SPLASH_MIN=(\d+)/)||[])[1],ut=+(M.match(/const UPD_TIMEOUT=(\d+)/)||[])[1];
  ok(sm>0&&sm<=3000&&ut>0&&ut<=6000,'v15.4.2: lantai splash <= 3 dtk dan batas cek update <= 6 dtk');
  ok(/indexHtml===null/.test(S),'v15.4.2: index.html dibaca sekali (cache), bukan tiap permintaan');
  const CN=fs.readFileSync(path.join(root,'src/connectors.js'),'utf8'),W=fs.readFileSync(path.join(root,'src/conn-worker.js'),'utf8'),B=fs.readFileSync(path.join(root,'scripts/build.js'),'utf8');
  ok(/spawnConn:\(\)=>/.test(M)&&/utilityProcess\.fork\(path\.join\(__dirname,'conn-worker\.js'\)/.test(M),'v15.4.2: main.js menyediakan hooks.spawnConn (utilityProcess.fork conn-worker.js)');
  ok(/entryPoints:\[path\.join\(root,'src\/conn-worker\.js'\)\]/.test(B),'v15.4.2: build.js membundel conn-worker.js ke build/');
  ok(!/\b(genY|genT|stopY|stopT|setStatus|setViewers|stats\.)/.test(CN)&&/require\('youtube-chat'\)/.test(CN)&&/require\('tiktok-live-connector'\)/.test(CN),'v15.4.2: connectors.js murni (tanpa ketergantungan ke server) dan memuat kedua pustaka');
  ok(/process\.parentPort/.test(W)&&/\{t:'ready'\}/.test(W),'v15.4.2: conn-worker.js memakai parentPort dan mengirim ready');
  ok(!/require\('youtube-chat'\)|require\('tiktok-live-connector'\)/.test(S.replace(S.slice(S.indexOf('function preload'),S.indexOf('function chatUrl')),'').split('\n').filter(l=>!/^\s*\/\//.test(l)).join('\n')),'v15.4.2: server.js tidak memuat pustaka konektor di luar jalur cadangan preload');
  ok(/function connWorker/.test(S)&&/function connFail/.test(S)&&/CONN\.startYT/.test(S)&&/CONN\.startTT/.test(S),'v15.4.2: server punya cadangan di proses utama (CONN.startYT/startTT) kalau worker gagal');
  ok(/function lsStart\(\)\{if\(lockScroll&&!hk&&!hkDelayT\)hkDelayT=setTimeout/.test(M)&&/function hkStop\(\)\{\s*clearTimeout\(hkDelayT\)/.test(M),'v15.5.1: hook roda (PowerShell) dimulai tertunda, bukan tepat saat menggembok');
  const CT=fs.readFileSync(path.join(root,'src/ui/ctl.html'),'utf8');
  ok(/lkBusy/.test(CT)&&/body\.busy #unlock/.test(CT),'v15.5.1: tombol gembok langsung terlihat ditekan dan klik kedua diabaikan sementara');
  // v15.5.3: notif bergabung/like TikTok di bawah "Total penonton" (Dock)
  const AP=fs.readFileSync(path.join(root,'src/ui/app.js'),'utf8'),BH=fs.readFileSync(path.join(root,'src/ui/body.html'),'utf8'),CS=fs.readFileSync(path.join(root,'src/ui/style.css'),'utf8');
  ok(/<div id="lw"><div id="nt"><div id="ntj"><\/div><div id="ntl"><\/div><\/div>/.test(BH)&&/body\.dock #nt\{[^}]*pointer-events:none/.test(CS),'v15.5.3: wadah notif #nt (bergabung #ntj, like #ntl) ada di bawah kotak total penonton dan tembus klik');
  ok(/view==='dock'&&m\.p==='tiktok'&&\(m\.kind==='join'\|\|m\.kind==='like'\)\)\{if\(!re\)ntNotify\(m,s\);return;\}/.test(AP)&&/const NT_JMAX=3/.test(AP)&&/NT_LGAP=\d+/.test(AP),'v15.5.3: bergabung & like TikTok di Dock masuk ntNotify (bukan daftar chat); maks 3 baris bergabung; jeda nama like');
  ok(/likeTot/.test(CN)&&/list:a\.slice\(0,8\)\.map/.test(CN)&&/likeTot=new Map\(\);[^\n]*\n\s*let lib/.test(CN),'v15.5.3: pesan like membawa daftar [nama,jumlah,total]; total per orang direset tiap startTT');
  // v15.5.4: geser chat dock lebih ringan + notif jadi bar selebar jendela
  ok(/const workAreaOf=wb=>/.test(M)&&!/screen\.getDisplayMatching\(wb\)\.workArea/.test(M.replace(/const workAreaOf=[^\n]*/,''))&&/if\(\(dragT\|\|rzT\)&&waC&&n-waT<250\)return waC/.test(M),'v15.5.4: layar tempat jendela berada dicari lewat workAreaOf (di-cache 250 ms selama chat dock digeser)');
  ok((M.match(/if\(!w\.__dragging\)pos\(\)/g)||[]).length===2&&/main\.__dragging=true/.test(M)&&/main\.__dragging=false/.test(M),'v15.5.4: event move tidak menghitung posisi kotak tombol/alert dua kali selama digeser');
  ok(/if\(w\.isDestroyed\(\)\|\|!c\|\|c\.isDestroyed\(\)\)return;const r=galertBounds/.test(M),'v15.5.4: tanpa jendela alert, pos() alert tidak menghitung apa pun');
  ok(/body\.dock #nt\{[^}]*left:0;right:0/.test(CS)&&/#nt \.cs-act\{width:100%/.test(CS),'v15.5.4: notif bar selebar jendela (kiri sampai kanan)');
  // v15.5.5: alert like dihapus, jumlah notif bergabung bisa diatur, chat ramai + gembok/geser jangan ngelag
  const GH=fs.readFileSync(path.join(root,'src/ui/galert.html'),'utf8');
  ok(!/ttLikeAl/.test(AP.replace(/\/\/[^\n]*/g,''))&&!/alertlike/.test((AP+M).replace(/\/\/[^\n]*/g,''))&&!/glk/.test(GH)&&/hooks\.galert\(\{kind:'gift',/.test(S),'v15.5.5: alert like (ttLikeAl, hotkey alertlike, wadah #glk, kind like di /galert) sudah tidak ada; yang tersisa hanya komentar');
  ok(/o\.ttJoinMax=1/.test(AP)&&/'ttJoinMax','Jumlah notif bergabung tampil sekaligus',1,3/.test(AP)&&/Math\.min\(NT_JMAX,Math\.round\(Number\(s\.ttJoinMax\)\|\|1\)\)/.test(AP),'v15.5.5: ttJoinMax bawaan 1, slider 1-3, dan dipakai ntJoinShow (dibatasi NT_JMAX=3)');
  ok(/NT_JGAP=\d+/.test(AP)&&/NT_JQ=\d+/.test(AP)&&/while\(ntJQ\.length>NT_JQ\)ntJQ\.shift\(\)/.test(AP),'v15.5.5: join beruntun diantre pelan (NT_JGAP) dengan antrean terbatas (NT_JQ), bukan digambar satu per satu');
  ok(/FRAME_MAX=\d+/.test(AP)&&/BQ\.splice\(0,FRAME_MAX\)/.test(AP)&&/function flushB\(all\)/.test(AP)&&/flushB\(true\);toLatest\(\);\}bootDone\(\)/.test(AP)&&/window\.__pause=/.test(AP),'v15.5.5: dock menggambar paling banyak FRAME_MAX pesan per frame, riwayat digambar sebelum bootDone, dan ada window.__pause');
  ok(/const MSG_BATCH_MS=\d+/.test(S)&&/function flushPend\(\)/.test(S)&&/flushPend\(\);clients\.forEach/.test(S)&&/flushPend\(\);\s*res\.write\(`data: \$\{JSON\.stringify\(\{type:'init'/.test(S),'v15.5.5: server menggabung event msg (MSG_BATCH_MS), menguras antrean sebelum event lain dan sebelum init');
  ok(/const JOIN_KEEP=\d+/.test(S)&&/joinN>JOIN_KEEP/.test(S)&&/joinN=0;\}emit\('cmd'/.test(S),'v15.5.5: riwayat hanya menyimpan JOIN_KEEP join terakhir (hitungan direset saat clear)');
  ok(/const pausePage=/.test(M)&&/main\.__dragging=true;pausePage\(main,true\)/.test(M)&&/pausePage\(main,false\);if\(!locked/.test(M),'v15.5.5: halaman dock dijeda selama jendela digeser dan dilanjutkan begitu dilepas');
  // v15.5.6: jeda dikirim ke WebContentsView (w.__view), bukan w.webContents (halaman kosong); jendela lama dijeda saat serah-terima gembok; animasi masuk mati saat chat ramai
  ok(/const pausePage=\(w,on\)=>\{try\{const c=w&&!w\.isDestroyed\(\)&&\(w\.__view\|\|w\)\.webContents;/.test(M)&&!/w\.webContents\.executeJavaScript\('window\.__pause/.test(M),'v15.5.6: pausePage menarget WebContentsView (w.__view), bukan w.webContents');
  ok(/function busyAnim\(n\)/.test(AP)&&/busyAnim\(q\.length\)/.test(AP)&&/cl\.add\('noanim'\)/.test(AP)&&/bCnt<8/.test(AP),'v15.5.6: animasi masuk dimatikan sementara saat dock menerima >=8 pesan per detik');
  // v15.6.1: SATU mode jendela chat (transparan); pin / lepas pin di jendela yang sama; resize lewat pegangan di tepi/sudut
  const SL=M.slice(M.indexOf('function setLock'),M.indexOf('async function askQuit')),NC=t=>t.replace(/\/\/[^\n]*/g,'');
  ok(/function makeMain\(bounds\)\{/.test(M)&&!/retireOld|HANDOVER_MAX|__quiet|switching|outerAtLock|lockStart/.test(NC(M)),'v15.6.1: tidak ada lagi jendela biasa pengganti / serah-terima jendela (retireOld, HANDOVER_MAX, quiet, switching)');
  ok(!/makeMain\(/.test(SL)&&/w\.setFocusable\(false\)/.test(SL)&&/w\.setFocusable\(true\)/.test(SL)&&/__pin\(true\)/.test(SL)&&/__pin\(false\)/.test(SL)&&/hkStop\(\);\s*setIgn\(w,false\)/.test(SL),'v15.6.1: setLock tidak membuat jendela baru; pin / lepas pin mengubah jendela yang sama (fokus, klik tembus, halaman)');
  ok(!/lastRects=\[\]/.test(NC(SL)),'v15.6.1: daftar area klik tidak dikosongkan saat pin / lepas pin (halaman hanya melapor kalau berubah)');
  ok(/transparent:true/.test(M.slice(M.indexOf('function makeMain'),M.indexOf('const pageJS')))&&/loadURL\(base\(\)\+'\/\?view=dock&locked=1'\+\(locked\?'&pin=1':''\)\)/.test(M),'v15.6.1: jendela chat selalu transparan dan memuat tampilan locked=1; keadaan pin awal lewat &pin=1');
  const RZ=M.slice(M.indexOf('function resizeOn'),M.indexOf('// ===== jendela utama'));
  ok(/\^\(n\|s\|e\|w\|ne\|nw\|se\|sw\)\$/.test(RZ)&&/E\.includes\('s'\)/.test(RZ)&&/w\.setBounds\(\{x,y,width:wd,height:ht\}\)/.test(RZ)&&/setShpIf\(w,\[\{x:0,y:0,width:wd,height:ht\}\]\)/.test(RZ)&&/RZ_MINW=\d+,RZ_MINH=\d+/.test(M)&&/if\(rzT\|\|!main\|\|main\.isDestroyed\(\)\|\|locked/.test(RZ),'v15.6.3: resizeOn menerima n,s,e,w,ne,nw,se,sw, setBounds + bentuk jendela ikut membesar, ukuran minimum, tidak jalan saat terpin');
  ok(/resize:\(on,edge\)=>resizeOn\(on,edge\)/.test(M)&&/u\.pathname==='\/resize'/.test(S),'v15.6.1: /resize tersambung ke resizeOn');
  ok((BH.match(/class="rz (n|s|e|w|ne|nw|se|sw)" data-e="\1"/g)||[]).length===8&&/body\.locked:not\(\.pinned\) #rz\{display:block\}/.test(CS),'v15.6.3: delapan pegangan resize (#rz) hanya tampil saat tidak terpin');
  // v15.6.2: kotak tombol (mata, pin, pindah, tutup) kembali di luar jendela chat; pin diteruskan ke sana lewat pushPin
  ok(/attachCtl\(w,'chat',true\);\s*attachAlert\(w,true\)/.test(M.slice(M.indexOf('function makeMain'),M.indexOf('const pageJS')))&&/function pushPin\(\)/.test(M)&&/pushPin\(\);\s*saveB\(\{outer:w\.getBounds\(\)\}\);/.test(SL)&&/const lkNow=\(\)=>t==='chat'\?\(locked\?1:0\):\(\(docks\.get\(t\)\|\|\{\}\)\.locked\?1:0\)/.test(M),'v15.6.2: makeMain memasang kotak tombol chat di luar jendela (sebelum alert); setLock memanggil pushPin; keadaan pin awal dibaca dari `locked`');
  ok(!/id="cb_(pin|eye|move|close)"|id="cgrp"/.test(BH)&&!/cb-bot/.test(CS+AP)&&!/\.gl\b|\.gc\b/.test(CS.slice(CS.indexOf('v15.6.2: bulatan chat'),CS.indexOf('#msg.err'))),'v15.6.2: tombol mata/pin/pindah/tutup dan pengaturan posisi bilah dalam jendela (cb-bot, gl, gc) sudah dihapus dari halaman chat');
  ok(/window\.__pin=on=>/.test(AP)&&/post\('\/resize',\{on:true,edge:h\.dataset\.e\}\)/.test(AP)&&/window\.__rqf=/.test(AP),'v15.6.1: halaman punya window.__pin (dipanggil main.js), pegangan memanggil /resize, dan bisa memaksa laporan /shape');
  // v15.6.3: lag + cursor berat, glow, preview TikTok, total like
  const NC3=t=>t.replace(/\/\/[^\n]*/g,''),LA=M.slice(M.indexOf('function lsApply'),M.indexOf('function lsTick'));
  ok(/disable-features','CalculateNativeWinOcclusion'/.test(M)&&!/setIgn\(main,[^)]*,true\)/.test(NC3(LA)),'v15.6.3: pelacak oklusi dimatikan dan jendela chat tidak memakai forward:true (hook mouse global)');
  ok(/const protAt=new WeakMap\(\)/.test(M)&&/prot\(w,true\)/.test(M)&&/PRIORITY_NORMAL/.test(M),'v15.6.3: prot() tidak menjadwalkan ulang berkali-kali; hook roda kembali berprioritas normal');
  ok(!/body\.locked #list,body\.locked #top\{text-shadow/.test(CS)&&/else if\(view!=='dock'\)d\.style\.textShadow/.test(AP),'v15.6.3: dock tanpa text-shadow (glow)');
  ok(/pre==='tt'&&\(k==='Join'\|\|k==='Like'\)\)\?\[\]:\[\['pv','act',pre\+k\]\]/.test(AP),'v15.6.3: pratinjau Bergabung dan Like di pengaturan TikTok dihapus');
  ok(/id="chl"/.test(BH)&&/type==='likes'/.test(AP)&&/m\.t==='likes'/.test(S)&&/totalLikeCount/.test(fs.readFileSync(path.join(root,'src/connectors.js'),'utf8'))&&/likes:\(p,n\)=>/.test(fs.readFileSync(path.join(root,'src/conn-worker.js'),'utf8')),'v15.6.3: total like TikTok (konektor -> worker -> server -> chip dock)');
  // v15.6.4: dashboard tidak macet saat dock dibuka, total like dari info room, deskripsi panjang dihapus
  const CN4=fs.readFileSync(path.join(root,'src/connectors.js'),'utf8'),MK=M.slice(M.indexOf('function makeMain'),M.indexOf('const pageJS'));
  ok(/const mark=s=>/.test(M)&&/proses utama terhenti/.test(M)&&/const mkCtl=\(\)=>\{[^\n]*mark\('ctl'\);attachCtl\(w,'chat',true\);attachAlert\(w,true\)/.test(MK)&&/wc\.once\('did-finish-load',\(\)=>setTimeout\(mkCtl,300\)\)/.test(MK)&&/setTimeout\(mkCtl,15000\)/.test(MK),'v15.6.4 / v1.1.1: pencatat proses utama terhenti; jendela tombol dibuat sesudah halaman chat selesai dimuat (bukan timer 150 ms), cadangan 15 dtk');
  ok(/const setShpIf=/.test(M)&&!/[^f]setShp\(main,/.test(M)&&/setTimeout\(f,900\)/.test(M)&&!/\[150,600,2000\]/.test(M),'v15.6.4: jendela chat tidak diberi setShape penuh; setContentProtection hanya 3 kali per jendela');
  const lm4=CN4.match(/(const numOf=[\s\S]*?const likesOf=r=>\{[^\n]*\});\n/),lo4=lm4?new Function(lm4[1]+';return likesOf;')():()=>'x'; // v15.6.5: likesOf sekarang memakai numOf/findLikes, jadi seluruh blok dimuat
  ok(!!lm4&&lo4({like_count:1423})===1423&&lo4({stats:{like_count:'1400'}})===1400&&lo4({data:{likeCount:7}})===7&&lo4({})===null&&lo4(null)===null&&lo4({like_count:''})===null&&/fetchRoomInfo/.test(CN4)&&/takeLikes\(\(st&&st\.roomInfo\)\|\|c\.roomInfo\)/.test(CN4),'v15.6.4: total like dibaca dari info room TikTok (awal + tiap 45 dtk), bentuk field beragam');
  ok(/<div id="chl"/.test(BH)&&!/<div id="top">[^\n]*id="chl"/.test(BH)&&/#chl\{display:none;position:absolute;left:16px;bottom:19px/.test(CS)&&/#cbar\.open~#chl/.test(CS),'v15.6.4: total like = tulisan kecil polos di kiri bawah (di luar #top)');
  ok(!/\['hint','[^']{20,}'\]/.test(AP)&&!/Developer mode|Folder <code>resources|Pesan hanya terkirim|Aplikasi berjalan di port ini|Kick dilindungi Cloudflare|Port 3000 \(bawaan\)/.test(BH),'v15.6.4: deskripsi statis yang panjang dihapus (hint DSL, langkah, catatan port, Kick)');
  // v15.6.5: total like harus angka asli live (bukan mulai dari 0); pengaturan TikTok dikotak-kotakkan
  ok(/else if\(synced\)\{roomLikes\+=n/.test(CN4)&&!/else roomLikes\+=n/.test(CN4)&&/api\.note/.test(CN4)&&/t:'note'/.test(fs.readFileSync(path.join(root,'src/conn-worker.js'),'utf8'))&&/m\.t==='note'/.test(S),'v15.6.5: like yang masuk hanya ditambahkan ke angka asli (tidak dijumlahkan dari 0); catatan diagnosa sumber angka ke log.txt');
  ok(/#pgb_dock_tt \.actbox,#pgb_overlay_tt \.actbox\{[^}]*border:1px solid/.test(CS)&&!/\n\.actbox\{[^}]*border-radius/.test(CS),'v15.6.5: gaya kotak hanya untuk halaman TikTok (Twitch/Kick tidak berubah)');
}
async function likeTests(){ // v15.6.5: perilaku startTT dengan pustaka TikTok palsu
  const Module=require('module'),EE=require('events');let mode='info',last=null;
  class Conn extends EE{constructor(){super();last=this;}
    async connect(){return {roomInfo:mode==='info'?{data:{status:2,stats:{like_count:'48213'}}}:{data:{status:2}}};}
    async fetchRoomInfo(){return mode==='info'?{data:{status:2,stats:{like_count:'48990'}}}:{data:{status:2}};}
    disconnect(){}}
  const fake={TikTokLiveConnection:Conn,WebcastEvent:{CHAT:'chat',MEMBER:'member',FOLLOW:'follow',SHARE:'share',SOCIAL:'social',SUBSCRIBE:'subscribe',GIFT:'gift',LIKE:'like',ROOM_USER:'roomUser'},ControlEvent:{DISCONNECTED:'disconnected'}};
  const ol=Module._load;Module._load=function(r,...a){return r==='tiktok-live-connector'?fake:ol.call(this,r,...a);};
  try{
    delete require.cache[require.resolve(path.join(root,'src/connectors.js'))];const C=require(path.join(root,'src/connectors.js'));
    const sleep=ms=>new Promise(r=>setTimeout(r,ms));
    const run=async m=>{mode=m;const out={likes:[],notes:[]};const stop=C.startTT('u',{alive:()=>true,status:()=>{},push:()=>{},viewers:()=>{},like:()=>{},likes:(p,n)=>out.likes.push(n),note:t=>out.notes.push(t)});await sleep(60);return{out,stop,c:last};};
    let r=await run('info');
    ok(r.out.likes[0]===48213,'v15.6.5: sesudah tersambung, total like = angka asli dari info room (bukan 0)');
    r.c.emit('like',{likeCount:15,totalLikeCount:48300,user:{nickname:'A'}});ok(r.out.likes.at(-1)===48300,'v15.6.5: event like dengan totalLikeCount: angka mengikuti TikTok');
    r.c.emit('like',{likeCount:5,totalLikeCount:0,user:{nickname:'B'}});ok(r.out.likes.at(-1)===48305,'v15.6.5: event tanpa total (sudah sinkron): ditambahkan ke angka asli');r.stop();
    r=await run('event');ok(r.out.likes.length===0,'v15.6.5: tanpa sumber angka asli: tidak ada angka palsu');
    r.c.emit('like',{likeCount:3,totalLikeCount:0,user:{nickname:'A'}});ok(r.out.likes.length===0,'v15.6.5: event tanpa total dan belum sinkron: tidak menampilkan angka dari 0');
    r.c.emit('like',{likeCount:3,totalLikeCount:120045,user:{nickname:'A'}});ok(r.out.likes.at(-1)===120045,'v15.6.5: event pertama dengan total langsung memakai angka asli');r.stop();
  }finally{Module._load=ol;}
}

(async()=>{parserTests();perfTests();await likeTests();await serverTests();await extensionTests();await uiTests();console.log(fail?'\n'+fail+' pemeriksaan GAGAL':'\nsemua pemeriksaan lulus');process.exit(fail?1:0);})();
