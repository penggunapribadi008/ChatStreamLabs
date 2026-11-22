const http=require('http'),fs=require('fs'),path=require('path');
const SEEDS=require('./seeds.json');
const base=process.env.CG_DATA||__dirname;
const CF=path.join(base,'config.json'),SF=path.join(base,'settings.json');
const stats=require('./stats.js')(path.join(base,'analytics.json'));
const read=(f,d)=>{try{return JSON.parse(fs.readFileSync(f,'utf8'))}catch{return d}};
let cfg=read(CF,{port:3000,youtube:'',tiktok:'',twitch:'',kick:'',kickRoom:''});
// Platform yang dinyalakan (switch di Koneksi). Pertama kali: YouTube & TikTok nyala; Twitch/Kick nyala hanya kalau username-nya sudah pernah diisi.
const PF4=['youtube','tiktok','twitch','kick'];
{const e=cfg.enabled||{};cfg.enabled={};PF4.forEach(p=>{cfg.enabled[p]=e[p]!=null?!!e[p]:(p==='youtube'||p==='tiktok'||!!cfg[p]);});}
const isEn=p=>cfg.enabled[p]!==false;
const saveCfg=()=>{try{fs.writeFileSync(CF,JSON.stringify(cfg,null,1));}catch{}};
let settings=read(SF,{});settings.dock=settings.dock||{};settings.overlay=settings.overlay||{};settings.global=settings.global||{};
if(!settings.global.tplSeeded){settings.global.templates=[...SEEDS,...(settings.global.templates||[]).filter(t=>!SEEDS.some(x=>x.id===t.id))];settings.global.tplSeeded=true;try{fs.writeFileSync(SF,JSON.stringify(settings));}catch{}}
{const MARK='/* twitch-kick */';let ch=false;
  (settings.global.templates||[]).forEach(t=>{const sd=SEEDS.find(x=>x.id===t.id);if(!sd||String(t.css||'').includes(MARK))return;const i=sd.css.indexOf(MARK);if(i>=0){t.css=String(t.css||'')+'\n'+sd.css.slice(i);ch=true;}});
  if(ch)try{fs.writeFileSync(SF,JSON.stringify(settings));}catch{}}
// pindahan dari versi lama (satu URL) ke daftar dock
if(!Array.isArray(settings.global.donateDocks)){
  const u=cleanDonateUrl(settings.global.donateUrl);
  settings.global.donateDocks=u?[{id:'d1',name:'Browser Dock 1',url:u,mute:!!settings.global.donateMute,refW:1280,refH:720}]:[];
  try{fs.writeFileSync(SF,JSON.stringify(settings));}catch{}
}
// v1.0.2: Donate Dock berganti nama jadi Browser Dock; nama bawaan lama ikut diganti (nama buatan sendiri tidak disentuh)
{let ch=false;settings.global.donateDocks.forEach(d=>{if(d&&/^Donate Dock( \d+)?$/.test(String(d.name||''))){d.name=String(d.name).replace('Donate Dock','Browser Dock');ch=true;}});
  if(ch)try{fs.writeFileSync(SF,JSON.stringify(settings));}catch{}}
const P=require('./platforms.js');
const CONN=require('./connectors.js'); // v15.4.2: konektor YouTube/TikTok (dijalankan di proses terpisah; cadangan di proses ini)
let PORT=cfg.port||3000,joinN=0;const clients=new Set(),history=[],status={youtube:'',tiktok:'',twitch:'',kick:''},viewers={youtube:null,tiktok:null,twitch:null,kick:null},likes={tiktok:null}; // v15.6.3: likes.tiktok = TOTAL like TikTok di live ini (dari totalLikeCount payload like); ditampilkan di header Dock
let seq=0;const crypto=require('crypto');const hooks={};let ytLive='';let _ready;const ready=new Promise(r=>_ready=r);let autoStarted=false;
function autoStart(){if(autoStarted)return;autoStarted=true;
  // v1.1.0: bawaan TIDAK menyambung sendiri saat aplikasi dibuka (pengaturan "Sambung otomatis saat aplikasi dibuka"); sambungkan lewat tombol Sambungkan di Koneksi
  if(settings.global.autoConn!==true){PF4.forEach(p=>setStatus(p,isEn(p)?'terputus':'nonaktif'));return;}
  setTimeout(()=>{startYT();setTimeout(startTT,600);setTimeout(startTW,1000);setTimeout(startKK,1400);},2500);}
// v15.4.2: konektor YouTube/TikTok berjalan di PROSES TERPISAH (src/conn-worker.js lewat hooks.spawnConn = utilityProcess di main.js).
// Dulu `require('youtube-chat')`/`require('tiktok-live-connector')` (berat dan SINKRON) serta pengurai payload live berjalan di proses utama Electron, tempat server
// ini hidup, sehingga semua jendela (termasuk tombol gembok) ikut macet, tepat saat pengguna membuka chat dock. Sekarang beban itu ada di proses lain.
// Kalau proses itu tidak bisa dibuat / tidak menjawab / berulang mati, server memakai CADANGAN: konektor yang sama dijalankan di proses ini (CONN.*).
// Pesan dari worker membawa `my` (generasi sambungan); yang basi (genY/genT sudah naik karena stop/ganti username) dibuang.
let cw=null,cwBad=false,cwReadyT=null,cwCrash=[];
function connWorker(){
  if(cw)return cw;
  if(cwBad||!hooks.spawnConn)return null;
  let w=null;try{w=hooks.spawnConn();}catch(e){console.log('[konektor] gagal membuat proses: '+(e&&e.message||e));}
  if(!w){cwBad=true;return null;}
  let ready=false;cw=w;
  cwReadyT=setTimeout(()=>{if(cw===w&&!ready)connFail(w,'proses konektor tidak menjawab dalam 30 dtk',false);},30000); // v1.1.1: dulu 8 dtk. Saat boot dingin proses ini bisa lambat; kalau dianggap gagal, pustaka TikTok/YouTube dimuat di proses utama (memblokir semua jendela = Not Responding)
  w.on('message',m=>{if(cw!==w||!m)return;if(m.t==='ready'){ready=true;clearTimeout(cwReadyT);return;}onConnMsg(m);});
  w.on('exit',code=>{if(cw!==w)return;clearTimeout(cwReadyT);connFail(w,'proses konektor berhenti (kode '+code+')',ready);});
  return w;
}
function connFail(w,why,wasReady){
  console.log('[konektor] '+why);
  if(cw===w)cw=null;
  try{if(w.kill)w.kill();}catch{}
  const now=Date.now();cwCrash=cwCrash.filter(t=>now-t<120000);cwCrash.push(now);
  if(!wasReady||cwCrash.length>=3){cwBad=true;console.log('[konektor] memakai cadangan di proses utama');}
  if(stopY)setStatus('youtube','konektor dimulai ulang...');if(stopT)setStatus('tiktok','konektor dimulai ulang...');
  setTimeout(()=>{if(stopY)startYT();if(stopT)startTT();},cwBad?0:2000); // stopY/stopT bukan null = platform itu sedang aktif
}
function onConnMsg(m){
  if(m.my!==(m.k==='youtube'?genY:genT))return; // sambungan basi
  if(m.t==='status')setStatus(m.p,m.v);
  else if(m.t==='push')push(m.m);
  else if(m.t==='viewers')setViewers(m.p,m.n);
  else if(m.t==='like')stats.like(m.n);
  else if(m.t==='likes')setLikes(m.p,m.n);
  else if(m.t==='live'){ytLive=m.id;pollYT(m.id,m.my);}
  else if(m.t==='error')console.log('[konektor] '+m.msg);
  else if(m.t==='note')noteLog(m.msg);
}
// v15.6.5: catatan diagnosa konektor (asal total like) ditulis ke log.txt
function noteLog(msg){try{fs.appendFileSync(path.join(base,'log.txt'),new Date().toISOString()+' '+String(msg).slice(0,800)+'\n');}catch{}}
const localApi=(alive,live)=>({alive,status:setStatus,push,viewers:setViewers,likes:setLikes,like:n=>stats.like(n),note:noteLog,live});
process.on('exit',()=>{try{if(cw&&cw.kill)cw.kill();}catch{}});
// dipanggil main.js saat splash: siapkan proses konektor dan minta ia memuat pustakanya DI SANA (tidak memblokir apa pun di sini).
// Tanpa proses terpisah (cadangan), pustaka dimuat di proses ini satu per satu dengan jeda supaya HTTP/SSE tetap dilayani.
let preloadP=null;
function preload(){
  if(preloadP)return preloadP;
  const yt=isEn('youtube')&&ytTarget(cfg.youtube),tt=isEn('tiktok')&&ttTarget(cfg.tiktok);
  const w=(yt||tt)?connWorker():null;
  if(w){w.post({cmd:'warm',yt:!!yt,tt:!!tt});return preloadP=Promise.resolve();}
  const steps=[];
  if(yt)steps.push(()=>require('youtube-chat'));
  if(tt)steps.push(()=>require('tiktok-live-connector'));
  preloadP=steps.reduce((p,f)=>p.then(()=>new Promise(r=>setTimeout(()=>{const t0=Date.now();try{f();}catch(e){console.log('[preload] '+(e&&e.message||e));}console.log('[preload] '+(Date.now()-t0)+' ms');r();},40))),Promise.resolve());
  return preloadP;
}
function chatUrl(p){
  if(p==='youtube'){const t=ytTarget(cfg.youtube);if(!t)return '';if(t.liveId)return 'https://www.youtube.com/watch?v='+t.liveId;if(t.handle)return 'https://www.youtube.com/'+t.handle+'/live';if(t.channelId)return 'https://www.youtube.com/channel/'+t.channelId+'/live';return '';}
  if(p==='twitch'){const u=twTarget(cfg.twitch);return u?'https://www.twitch.tv/popout/'+u+'/chat?popout=':'';}
  if(p==='kick'){const u=kkTarget(cfg.kick);return u?'https://kick.com/'+u:'';}
  const u=ttTarget(cfg.tiktok);return u?'https://www.tiktok.com/@'+u+'/live':'';}
function cmd(name){if(name==='clear'){history.length=0;joinN=0;}emit('cmd',{name});}
// URL widget Donate Dock: kosong = fitur diam (''), hanya http/https yang diterima, selain itu null (ditolak)
function cleanDonateUrl(u){const v=String(u==null?'':u).trim();if(!v)return '';let x;try{x=new URL(v);}catch{return null;}return(x.protocol==='http:'||x.protocol==='https:')?x.href:null;}
// Browser Dock (dulu Donate Dock; bisa lebih dari satu): [{id,name,url,mute,fit,opacity,dockOp,refW,refH}]. dockOp (v1.0.2) = Opacity Dock 0-100 (latar jendela saat tidak terkunci, bawaan 100); opacity = Opacity URL (isi widget). fit = isi widget diskalakan mengikuti jendela (bawaan: nyala). auto (v1.0.0) = ukuran acuan skala diukur dari isi halaman URL-nya (bukan 1280x720 tetap). opacity = 10-100 (persen). refW/refH = ukuran acuan (px) untuk skala isi widget supaya muat di jendela.
const DOCK_MAX=5;
function cleanDocks(a){
  const out=[],seen=new Set(),n=(v,d)=>{v=Math.round(+v);return v>=200&&v<=7680?v:d;};
  for(const d of Array.isArray(a)?a:[]){
    if(out.length>=DOCK_MAX)break;
    let id=String((d&&d.id)||'').replace(/[^\w-]/g,'').slice(0,24);if(!id||seen.has(id))id='d'+Date.now().toString(36)+out.length;seen.add(id);
    const name=String((d&&d.name)||'').trim().slice(0,40)||'Browser Dock '+(out.length+1),url=cleanDonateUrl(d&&d.url);
    if(url===null)return{error:'URL "'+name+'" tidak valid. Awali dengan http:// atau https://.'};
    out.push({id,name,url,mute:!!(d&&d.mute),fit:!(d&&d.fit===false),auto:!!(d&&d.auto),opacity:Math.min(100,Math.max(10,Math.round(+(d&&d.opacity))||100)),dockOp:(d&&d.dockOp!=null&&isFinite(+d.dockOp))?Math.min(100,Math.max(0,Math.round(+d.dockOp))):100,refW:n(d&&d.refW,1280),refH:n(d&&d.refH,720)});
  }
  return{docks:out};
}
function setGlobal(v){settings.global={...settings.global,...v};fs.writeFileSync(SF,JSON.stringify(settings));emit('settings',settings);if(v.protect!==undefined&&hooks.protect)hooks.protect(settings.global.protect!==false);if(hooks.global)hooks.global(settings.global);}
module.exports={hooks,ready,preload,cmd,setGlobal,cleanDonateUrl,endSession:()=>stats.end(),flush:()=>stats.flush(),get port(){return PORT;}};
process.on('exit',()=>{try{stats.flush();}catch{}});
const AVOID=[[3306,'MySQL'],[3389,'Remote Desktop Windows'],[4200,'Angular'],[4455,'OBS WebSocket (dipakai tombol Tambahkan overlay ke OBS)'],[5000,'Flask / AirPlay'],[5173,'Vite'],[5432,'PostgreSQL'],[5500,'Live Server VS Code'],[5900,'VNC'],[6379,'Redis'],[8000,'server web lokal'],[8080,'server web / proxy'],[8888,'Jupyter'],[27017,'MongoDB']].map(([port,name])=>({port,name}));
const BOTS=['nightbot','streamelements','streamlabs','moobot','fossabot','wizebot','soundalerts','restreambot','botrix','sery_bot','pretzelrocks','coebot','deepbot','phantombot','ankhbot','vivbot'];
const isBot=n=>{n=(n||'').toLowerCase().trim();const c=(settings.global.botNames||'').toLowerCase().split(',').map(s=>s.trim()).filter(Boolean);return BOTS.includes(n)||c.includes(n);};
// v15.5.5 (chat ramai jangan ngelag): event 'msg' yang datang berdekatan digabung jadi SATU tulisan per klien tiap MSG_BATCH_MS (dulu satu tulisan per pesan per klien).
//   Tiap event SSE tetap terpisah (klien memprosesnya satu per satu seperti biasa), jadi hanya jumlah tulisan/IPC jaringan yang turun. Event jenis lain (status, viewers, settings, cmd, sampleclear, ...)
//   menguras antrean dulu supaya urutan antar-event tidak berubah; klien baru juga menguras dulu sebelum menerima 'init' (kalau tidak, pesan yang sudah ada di riwayat terkirim dua kali).
const MSG_BATCH_MS=25;let pend='',pendT=null;
function flushPend(){if(pendT){clearTimeout(pendT);pendT=null;}if(!pend)return;const s=pend;pend='';clients.forEach(r=>r.write(s));}
function emit(type,data){const s=`data: ${JSON.stringify({type,data})}\n\n`;
  if(type==='msg'){pend+=s;if(pend.length>262144)flushPend();else if(!pendT)pendT=setTimeout(flushPend,MSG_BATCH_MS);return;}
  flushPend();clients.forEach(r=>r.write(s));}
// v15.5.5: riwayat (maks 300) hanya menyimpan JOIN_KEEP kejadian "bergabung" terakhir. Saat live ramai, ratusan join memenuhi riwayat dan menggeser chat asli keluar,
//   dan setiap jendela yang dibuka (apalagi saat gembok) harus menerima + memproses semuanya padahal Dock tidak menggambar join dari riwayat.
const JOIN_KEEP=30;
function push(m){m.t=Date.now();m.id=++seq;if(!m.kind)m.bot=isBot(m.name);history.push(m);
  if(m.kind==='join'){joinN++;if(joinN>JOIN_KEEP){const i=history.findIndex(x=>x.kind==='join');if(i>=0){history.splice(i,1);joinN--;}}}
  if(history.length>300){const o=history.shift();if(o&&o.kind==='join')joinN--;}
  emit('msg',m);if(m.kind!=='like'){try{stats.add(m);syncSince();}catch{}}}
function setStatus(k,v){status[k]=v;console.log(`[${k}] ${v}`);emit('status',status);if(v==='terhubung')setTimeout(()=>autoOpen(k),600);}
// v15.6.3: total like datang tiap ada like (bisa puluhan per detik saat ramai): emit digabung, paling cepat sekali per 500 ms; reset ke null dikirim langsung
let likesT=null;function emitLikes(){if(likesT){clearTimeout(likesT);likesT=null;}emit('likes',likes);}
function setLikes(k,n){n=n==null?null:Number(n);if(n!=null&&!(n>=0))return;if(likes[k]===n)return;likes[k]=n;if(n==null)emitLikes();else if(!likesT)likesT=setTimeout(emitLikes,500);}
// v1.0.2: awal sesi live (sesi laporan yang sedang berjalan) dikirim ke Dock untuk penunjuk "Lama live"; hanya dikirim kalau berubah (sesi mulai / berakhir)
let sinceLast=null;
function syncSince(){const v=stats.since();if(v===sinceLast)return;sinceLast=v;emit('since',{since:v});}
function setViewers(k,n){viewers[k]=n;emit('viewers',viewers);if(n!=null&&!stats.active())stats.tick(viewers.youtube,viewers.tiktok,viewers.twitch,viewers.kick);syncSince();}
setInterval(()=>{try{stats.tick(viewers.youtube,viewers.tiktok,viewers.twitch,viewers.kick);syncSince();}catch{}},15000).unref();

let indexHtml=null;const miniHtml={};
const FILES={'/yt.png':'image/png','/tt.png':'image/png','/tw.png':'image/png','/kick.png':'image/png','/icon.png':'image/png'};
const srv=http.createServer((req,res)=>{
  const u=new URL(req.url,'http://x');
  if(req.method==='POST'){const o=req.headers.origin;if(o&&o!==`http://localhost:${PORT}`&&o!==`http://127.0.0.1:${PORT}`){res.writeHead(403);return res.end('forbidden');}}
  const body=cb=>{let b='';req.on('data',c=>b+=c);req.on('end',()=>{try{cb(b?JSON.parse(b):{})}catch(e){console.log(e)}res.end('ok')});};
  if(u.pathname==='/events'){
    res.writeHead(200,{'Content-Type':'text/event-stream','Cache-Control':'no-cache',Connection:'keep-alive'});
    flushPend();
    res.write(`data: ${JSON.stringify({type:'init',data:{history:history.filter(m=>isEn(m.p)),settings,cfg:{enabled:cfg.enabled,youtube:cfg.youtube,tiktok:cfg.tiktok,twitch:cfg.twitch||'',kick:cfg.kick||'',kickRoom:cfg.kickRoom||'',port:PORT,wanted:cfg.port||3000,avoid:AVOID},status,viewers,likes,since:stats.since()}})}\n\n`);
    clients.add(res);req.on('close',()=>clients.delete(res));return;
  }
  if(req.method==='POST'){
    const json=async fn=>{let b='';await new Promise(r=>{req.on('data',c=>b+=c);req.on('end',r);});let out;try{out=await fn(b?JSON.parse(b):{});}catch(e){out={error:String(e&&e.message||e)};}res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify(out));};
    if(u.pathname==='/port-set')return json(async({port})=>{const p=Number(port);
      if(!Number.isInteger(p)||p<1024||p>65535)return{error:'Port harus angka bulat antara 1024 dan 65535.'};
      if(p!==PORT){const av=AVOID.find(x=>x.port===p);if(av)return{error:'localhost:'+p+' telah digunakan oleh '+av.name+'. Pilih port lain (tombol Hindari menampilkan daftarnya).'};
        const free=await new Promise(r=>{const t=require('net').createServer();t.once('error',()=>r(false));t.once('listening',()=>t.close(()=>r(true)));t.listen(p);});
        if(!free)return{error:'localhost:'+p+' telah digunakan oleh program lain. Pilih port lain.'};}
      cfg.port=p;fs.writeFileSync(CF,JSON.stringify(cfg,null,1));return{ok:true,restart:p!==PORT};});
    if(u.pathname==='/export-css')return json(async({name,css})=>{if(!hooks.saveCss)return{error:'hanya di aplikasi desktop'};const n=String(name||'gaya-overlay').replace(/[\\/:*?"<>|]+/g,'-').slice(0,80)||'gaya-overlay';return await hooks.saveCss(n,String(css||'').slice(0,400000));});
    if(u.pathname==='/platform')return json(async({platform,on,user})=>{
      if(!PF4.includes(platform))return{error:'platform tidak dikenal'};
      const was=cfg[platform];cfg.enabled[platform]=!!on;if(on&&typeof user==='string'&&user.trim())cfg[platform]=user.trim();
      if(was&&cfg[platform]!==was)cmd('clear'); // v15.6.6: pindah akun/live = isi chat direset
      saveCfg();({youtube:startYT,tiktok:startTT,twitch:startTW,kick:startKK})[platform]();
      emit('cfg',{enabled:cfg.enabled});return{ok:true,enabled:cfg.enabled};});
    // chat contoh dari Dashboard (tombol "Kirim Chat ke Dock / Overlay"): hanya ditampilkan di tujuannya, tidak masuk riwayat dan tidak masuk statistik
    if(u.pathname==='/sample')return body(({m,target})=>{if(!m||typeof m!=='object'||!PF4.includes(m.p)||!isEn(m.p)||(target!=='dock'&&target!=='overlay'))return;
      emit('msg',{...m,t:Date.now(),id:++seq,sample:true,target});});
    if(u.pathname==='/sample-clear')return body(()=>emit('sampleclear',{}));
    // alert hadiah TikTok: dock meneruskan datanya, main.js memunculkannya di jendela alert di luar jendela chat
    if(u.pathname==='/galert')return body(({m})=>{if(!m||typeof m!=='object'||!hooks.galert)return;
      const t=(v,n)=>typeof v==='string'?v.slice(0,n):'';
      hooks.galert({kind:'gift',name:t(m.name,60),gift:t(m.gift,60),n:Math.max(1,Math.min(99999,Number(m.n)||1)),coins:Math.max(0,Math.min(1e9,Math.round(Number(m.coins)||0))),others:Math.max(0,Math.min(99999,Number(m.others)||0)),img:/^https?:\/\//i.test(m.img||'')?t(m.img,500):'',t:Number(m.t)||Date.now(),dur:Math.max(2,Math.min(60,Number(m.dur)||6)),max:Math.max(1,Math.min(10,Number(m.max)||3)),size:Math.max(50,Math.min(200,Number(m.size)||100)),order:m.order==='top'?'top':'bottom'});});
    if(u.pathname==='/analytics-new')return body(()=>{stats.end();syncSince();});
    if(u.pathname==='/analytics-del')return body(({id})=>stats.remove(String(id||'')));
    if(u.pathname==='/restart')return body(()=>{if(hooks.relaunch)setTimeout(()=>hooks.relaunch(),300);});
    // Kirim PARALEL (Promise.all): platform yang lambat (mis. membuka tab, timeout 9 dtk) tidak menahan platform lain.
    if(u.pathname==='/send')return json(async({text,targets})=>{const out={},tx=String(text||'').slice(0,190),ts=[...new Set((Array.isArray(targets)?targets:[]).filter(t=>PF4.includes(t)))];
      await Promise.all(ts.map(async t=>{try{out[t]=await extSend(t,tx);}catch(e){out[t]=String(e&&e.message||e);}}));return out;});
    if(u.pathname==='/update-check')return json(async()=>({status:hooks.checkUpdate?await hooks.checkUpdate():'dev'}));
    if(u.pathname==='/win')return body(({which,act})=>{if(hooks.winCtl)hooks.winCtl(which,act);});
    if(u.pathname==='/draft')return body(d=>emit('draft',d));
    if(u.pathname==='/draft-clear')return body(()=>emit('draftclear',{}));
    if(u.pathname==='/hotkeys')return json(async({hotkeys})=>{settings.global={...settings.global,hotkeys};fs.writeFileSync(SF,JSON.stringify(settings));emit('settings',settings);return hooks.setHotkeys?hooks.setHotkeys(hotkeys||{}):{};});
    if(u.pathname==='/templates-restore')return body(()=>{const have=new Set((settings.global.templates||[]).map(t=>t.id));settings.global.templates=[...SEEDS.filter(x=>!have.has(x.id)),...(settings.global.templates||[])];fs.writeFileSync(SF,JSON.stringify(settings));emit('settings',settings);});
    if(u.pathname==='/send-set')return body(({on})=>setGlobal({sendOn:on===true})); // v15.3.2: bawaan MATI (eksperimental); hanya nyala kalau sendOn === true
    if(u.pathname==='/autoconn-set')return body(({on})=>setGlobal({autoConn:on===true}));
    if(u.pathname==='/autoopen-set')return body(({on})=>setGlobal({autoOpen:on!==false}));
    if(u.pathname==='/donate-docks')return json(async({docks})=>{const r=cleanDocks(docks);if(r.error)return r;setGlobal({donateDocks:r.docks});return{ok:true,docks:r.docks};});
    if(u.pathname==='/donate')return json(async({act,id})=>{if(!hooks.donate)return{error:'hanya di aplikasi desktop'};return(await hooks.donate(String(act||''),id?String(id):''))||{ok:true};});
    if(u.pathname==='/protect-toggle')return body(()=>setGlobal({protect:settings.global.protect===false}));
    if(u.pathname==='/shape')return body(({rects,list})=>{if(hooks.shape)hooks.shape(Array.isArray(rects)?rects:[],list&&typeof list==='object'?list:null);});
    if(u.pathname==='/ready')return body(()=>autoStart());
    if(u.pathname==='/log')return body(({msg})=>{try{fs.appendFileSync(path.join(base,'log.txt'),new Date().toISOString()+' '+String(msg).slice(0,800)+'\n');}catch{}});
    if(u.pathname==='/drag')return body(({on,id})=>{if(hooks.drag)hooks.drag(!!on,id?String(id):'');});
    if(u.pathname==='/resize')return body(({on,edge,id})=>{if(hooks.resize)hooks.resize(!!on,edge?String(edge):'',id?String(id):'');}); // v15.6.1: pegangan resize jendela chat yang tidak terpin
    if(u.pathname==='/lock')return body(({on,id})=>{if(hooks.lock)hooks.lock(!!on,id?String(id):'');});
    if(u.pathname==='/chat-focus')return body(({on})=>{if(hooks.chatFocus)hooks.chatFocus(!!on);}); // v15.6.0: kolom ketik di jendela chat terkunci butuh fokus keyboard
    if(u.pathname==='/settings-window')return body(()=>{if(hooks.openSettings)hooks.openSettings();});
    if(u.pathname==='/open')return json(async({what,id})=>{if(!hooks.open)return{error:'hanya di aplikasi desktop'};
      if(what==='chat'){if(hooks.openChat)hooks.openChat();return{ok:true};}
      if(what==='ext'){hooks.open('ext');return{ok:true};}
      if(what==='tpladd'){hooks.window('/?view=tpladd'+(id?'&id='+encodeURIComponent(id):''),{width:980,height:600,title:'Gaya baru'});return{ok:true};}
      if(what==='templates'){hooks.window('/?view=tpl',{width:980,height:820,title:'Kelola gaya overlay'});return{ok:true};}
      if(what==='report'){if(hooks.openReport)hooks.openReport();else hooks.window('/?view=report',{width:1040,height:840,title:'Laporan penonton'});return{ok:true};}
      if(what==='preview'){hooks.window('/?view=overlay&preview=1',{width:480,height:760,title:'Pratinjau overlay OBS'});return{ok:true};}
      if(['youtube','tiktok','twitch','kick'].includes(what)){const u2=extUrl(what)||chatUrl(what);if(!u2)return{error:'Isi username '+({youtube:'YouTube',tiktok:'TikTok',twitch:'Twitch',kick:'Kick'})[what]+' dulu di Koneksi.'};hooks.open(u2);return{ok:true};}
      return{error:'tidak dikenal'};});
    if(u.pathname==='/obs-add')return json(async o=>{await obsAdd({...o,url:`http://localhost:${PORT}/?view=overlay`});return{ok:true};});
    if(u.pathname==='/settings')return body(({view,values})=>{settings[view]=view==='global'?{...settings.global,...values}:values;fs.writeFileSync(SF,JSON.stringify(settings));emit('settings',settings);if(view==='global'){if(hooks.protect)hooks.protect(settings.global.protect!==false);if(hooks.global)hooks.global(settings.global);}});
    if(u.pathname==='/connect')return body(({youtube,tiktok,twitch,kick,kickRoom})=>{
      // v15.6.6: akun/live yang dihubungkan berubah (pindah dari live A ke live B) = isi chat direset semua
      const chg=(cfg.youtube||'')!==(youtube||'')||(cfg.tiktok||'')!==(tiktok||'')||(cfg.twitch||'')!==(twitch||'')||(cfg.kick||'')!==(kick||'')||String(cfg.kickRoom||'')!==String(kickRoom||'').replace(/\D/g,'');
      if(chg)cmd('clear');
      cfg.youtube=youtube||'';cfg.tiktok=tiktok||'';cfg.twitch=twitch||'';cfg.kick=kick||'';cfg.kickRoom=String(kickRoom||'').replace(/\D/g,'');fs.writeFileSync(CF,JSON.stringify(cfg,null,1));startYT();startTT();startTW();startKK();
      // Hubungkan ditekan: kalau platform sudah "terhubung" sebelum status berubah lagi, tetap pastikan halaman chat-nya terbuka.
      setTimeout(()=>PF4.forEach(p=>{if(status[p]==='terhubung')autoOpen(p);}),4000);});
    if(u.pathname==='/disconnect')return body(()=>stopAll());
    if(u.pathname==='/test')return body(()=>{
      [['tiktok','dewi.anggraini','kak main game apa hari ini?'],['youtube','Budi Santoso','mantap bang, gas terus!'],['youtube','Nightbot','Jangan lupa subscribe dan follow ya!'],['youtube','Andi Pratama','selamat datang semuanya',{mod:true}],['tiktok','rizkyy_','seru banget live-nya!!'],['youtube','Sinta_Rahma','Terima kasih banyak kak, semangat terus!',{sc:{amount:'Rp50.000',color:'#ffca28'}}],
        ['tiktok','rizkyy_',undefined,{kind:'join'}],['tiktok','Budi',undefined,{kind:'gift',gift:'Rose',n:5,coins:5}],['tiktok','dewi.anggraini',undefined,{kind:'follow'}],['tiktok','Sinta_Rahma',undefined,{kind:'like',others:3,n:48}],['tiktok','Andi',undefined,{kind:'share'}],['tiktok','Rina',undefined,{kind:'sub'}],
        ['twitch','gamer_jaya','gas terus bang Kappa',{emo:[[19,24,'https://static-cdn.jtvnw.net/emoticons/v2/25/default/dark/2.0']],vip:true}],['twitch','Rina_K','nonton dari tadi, seru!',{member:true}],['twitch','BudiBits','mantap kontennya',{sc:{amount:'500 bits',color:'#9c3ee8',bits:500}}],
        ['twitch','Joko',undefined,{kind:'sub',plan:'1000',months:12,text:'makasih bang!'}],['twitch','Sari',undefined,{kind:'gift',n:5,plan:'1000'}],['twitch','StreamerBesar',undefined,{kind:'raid',n:120}],['twitch','Mod1','Giveaway mulai jam 8 malam!',{kind:'announce'}],
        ['kick','kick_fans','halo semuanya dari Kick!',{owner:false,mod:true}],['kick','Dimas','sini kak, GG',{member:true}],['kick','Putri','semangat live-nya',{sc:{amount:'100 Kicks',color:'#53fc18',kicks:100}}],
        ['kick','Andre',undefined,{kind:'follow'}],['kick','Wulan',undefined,{kind:'sub',months:3}],['kick','Bayu',undefined,{kind:'gift',n:3}],['kick','Tono',undefined,{kind:'raid',n:80}],['kick','Lia',undefined,{kind:'reward',title:'Pilih lagu',text:'Dewa 19 - Pupus'}]]
        .forEach(([p,name,text,x],i)=>setTimeout(()=>push({p,name,text,test:true,...(x||{})}),i*400));
    });
  }
  if(u.pathname==='/analytics'){res.writeHead(200,{'Content-Type':'application/json','Cache-Control':'no-store'});return res.end(JSON.stringify(stats.get(u.searchParams.get('id')||'cur',viewers)));}
  if(u.pathname==='/dash-state'){res.writeHead(200,{'Content-Type':'application/json','Cache-Control':'no-store'});return res.end(JSON.stringify({protect:settings.global.protect!==false,...(hooks.dashState?hooks.dashState():{chat:{},docks:{}})}));}
  if(u.pathname==='/state'){res.writeHead(200,{'Content-Type':'application/json'});return res.end(JSON.stringify({protect:settings.global.protect!==false}));}
  if(u.pathname==='/account'){res.writeHead(200,{'Content-Type':'application/json'});const has=p=>hasExt(p);return res.end(JSON.stringify({youtube:has('youtube'),tiktok:has('tiktok'),twitch:has('twitch'),kick:has('kick')}));}
  if(u.pathname==='/urls'){res.writeHead(200,{'Content-Type':'application/json'});return res.end(JSON.stringify({youtube:extUrl('youtube')||chatUrl('youtube'),tiktok:extUrl('tiktok')||chatUrl('tiktok'),twitch:extUrl('twitch')||chatUrl('twitch'),kick:extUrl('kick')||chatUrl('kick')}));}
  if(FILES[u.pathname]){res.writeHead(200,{'Content-Type':FILES[u.pathname],'Cache-Control':'max-age=3600'});return res.end(fs.readFileSync(path.join(__dirname,u.pathname)));}
  if(u.pathname==='/'){res.writeHead(200,{'Content-Type':'text/html; charset=utf-8'});
    const v=u.searchParams.get('view');
    if(v==='ctl'||v==='galert'){ // v15.5.0: jendela tombol dan jendela alert memakai halaman mungil sendiri (bukan index.html penuh) -> proses tampilannya jauh lebih ringan
      if(!miniHtml[v])miniHtml[v]=fs.readFileSync(path.join(__dirname,v+'.html'),'utf8');
      return res.end(miniHtml[v]);}
    if(indexHtml===null)indexHtml=fs.readFileSync(path.join(__dirname,'index.html'),'utf8'); // v15.4.2: dibaca sekali saja (dulu tiap halaman/jendela membaca ulang ±190 KB dari disk)
    let h=indexHtml;
    if(v!=='overlay'&&v!=='ctl'&&v!=='galert'&&!u.searchParams.get('locked')&&!u.searchParams.get('preview'))h=h.replace('<body class="dock p-polos">','<body class="dock p-polos th-spatial">'); // tema satu-satunya: Spatial UI
    return res.end(h);}
  res.writeHead(404);res.end();
});
function tryListen(p,left){
  const onErr=e=>{srv.removeListener('listening',onOk);
    if(e.code==='EADDRINUSE'&&left>0)return tryListen(p+1,left-1);
    throw new Error(e.code==='EADDRINUSE'?'Port 3000 sampai 3010 sedang dipakai program lain. Tutup program itu lalu buka ulang ChatStream Labs.':String(e&&e.message||e));};
  const onOk=()=>{srv.removeListener('error',onErr);PORT=p;console.log(`ChatStream Labs jalan di http://localhost:${PORT}`);_ready();setTimeout(autoStart,12000);};
  srv.once('error',onErr);srv.once('listening',onOk);srv.listen(p);
}
tryListen(PORT,10);


function ytTarget(s){s=(s||'').trim();let m;
  if(m=s.match(/(?:v=|youtu\.be\/|\/live\/|\/shorts\/)([\w-]{11})/))return{liveId:m[1]};
  if(m=s.match(/youtube\.com\/(@[\w.\-]+)/)||s.match(/^(@[\w.\-]+)$/))return{handle:m[1]};
  if(m=s.match(/youtube\.com\/channel\/(UC[\w-]+)/))return{channelId:m[1]};
  if(/^[\w.\-]{3,30}$/.test(s))return{handle:'@'+s};return null;}
function ttTarget(s){const m=(s||'').trim().match(/tiktok\.com\/@([\w.]+)/)||(s||'').trim().match(/^@?([\w.]+)$/);return m?m[1]:null;}

function twTarget(s){s=(s||'').trim();const m=s.match(/twitch\.tv\/([A-Za-z0-9_]{3,25})/)||s.match(/^@?([A-Za-z0-9_]{3,25})$/);return m?m[1].toLowerCase():null;}
// slug Kick = nama pengguna huruf kecil dengan garis bawah diganti tanda hubung
function kkTarget(s){s=(s||'').trim();const m=s.match(/kick\.com\/([A-Za-z0-9_\-]{3,25})/)||s.match(/^@?([A-Za-z0-9_\-]{3,25})$/);return m?m[1].toLowerCase().replace(/_/g,'-'):null;}

let genY=0,genT=0,genW=0,genK=0,stopY=null,stopT=null,stopW=null,stopK=null,vyTimer=null,vwTimer=null,vkTimer=null;
function stopAll(){
  genY++;genT++;genW++;genK++;
  if(stopY){stopY();stopY=null;} if(stopT){stopT();stopT=null;} if(stopW){stopW();stopW=null;} if(stopK){stopK();stopK=null;}
  ytLive='';clearTimeout(vyTimer);clearTimeout(vwTimer);clearTimeout(vkTimer);['youtube','tiktok','twitch','kick'].forEach(k=>setViewers(k,null));
  ['youtube','tiktok','twitch','kick'].forEach(k=>setStatus(k,isEn(k)?'terputus':'nonaktif'));
}
// v15.3.3: jumlah penonton YouTube dari endpoint internal "updated_metadata" (yang dipakai halaman live YouTube sendiri). live_stats lama sering kosong, jadi hanya jadi cadangan.
// ytViewsFrom: cari videoViewCountRenderer di balasan; teks seperti "1,234 watching now" / "1.234 orang menonton" -> 1234; "No one is watching" -> 0; tidak ketemu -> null.
function ytViewsFrom(j){
  let r=null;
  const walk=o=>{if(r!==null||!o||typeof o!=='object')return;
    const v=o.videoViewCountRenderer&&o.videoViewCountRenderer.viewCount;
    if(v){const tx=v.simpleText||(Array.isArray(v.runs)?v.runs.map(x=>x.text||'').join(''):'');
      if(/^\s*(no one|tidak ada|belum ada)/i.test(tx))r=0;else{const d=tx.replace(/\D/g,'');if(d)r=parseInt(d,10);}
      return;}
    for(const k in o){walk(o[k]);if(r!==null)return;}};
  walk(j);return r;}
async function ytWatching(id){
  try{
    const ac=new AbortController(),to=setTimeout(()=>ac.abort(),8000);
    try{
      const res=await fetch('https://www.youtube.com/youtubei/v1/updated_metadata?prettyPrint=false',{method:'POST',signal:ac.signal,headers:{'Content-Type':'application/json','User-Agent':KUA},body:JSON.stringify({context:{client:{clientName:'WEB',clientVersion:'2.20250101.00.00',hl:'en',gl:'US'}},videoId:id})});
      return ytViewsFrom(await res.json());
    }finally{clearTimeout(to);}
  }catch{return null;}
}
function pollYT(id,my){
  clearTimeout(vyTimer);
  const run=async()=>{
    if(my!==genY)return;
    let n=await ytWatching(id);
    if(n==null){try{const t=(await(await fetch('https://www.youtube.com/live_stats?v='+id)).text()).trim(),x=/^\d+$/.test(t)?parseInt(t,10):NaN;n=isNaN(x)?null:x;}catch{n=null;}} // cadangan: cara lama
    if(my!==genY)return;
    setViewers('youtube',n);
    vyTimer=setTimeout(run,20000);
  };run();
}
function startYT(){
  const my=++genY;if(stopY){stopY();stopY=null;}clearTimeout(vyTimer);setViewers('youtube',null);
  if(!isEn('youtube'))return setStatus('youtube','nonaktif');
  if(!cfg.youtube)return setStatus('youtube','belum diisi');
  const t=ytTarget(cfg.youtube);if(!t)return setStatus('youtube','username tidak dikenali');
  const w=connWorker();
  if(w){const myStop=()=>w.post({cmd:'stop',k:'youtube'});stopY=myStop;w.post({cmd:'yt',target:t,my});return;}
  // cadangan: di proses ini (proses konektor terpisah tidak tersedia / gagal)
  stopY=CONN.startYT(t,localApi(()=>my===genY,id=>{ytLive=id;pollYT(id,my);}))||null;
}
function startTT(){
  const my=++genT;if(stopT){stopT();stopT=null;}setViewers('tiktok',null);setLikes('tiktok',null);
  if(!isEn('tiktok'))return setStatus('tiktok','nonaktif');
  if(!cfg.tiktok)return setStatus('tiktok','belum diisi');
  const user=ttTarget(cfg.tiktok);if(!user)return setStatus('tiktok','username tidak dikenali');
  const w=connWorker();
  if(w){const myStop=()=>w.post({cmd:'stop',k:'tiktok'});stopT=myStop;w.post({cmd:'tt',user,my});return;}
  stopT=CONN.startTT(user,localApi(()=>my===genT,()=>{}))||null;
}

// ===== Twitch: IRC lewat WebSocket tanpa login (akun anonim "justinfan", hanya bisa membaca) =====
function pollTW(login,my){
  clearTimeout(vwTimer);
  const run=async()=>{
    if(my!==genW)return;
    try{
      const r=await fetch('https://gql.twitch.tv/gql',{method:'POST',headers:{'Client-ID':'kimne78kx3ncx6brgo4mv6wki5h1ko','Content-Type':'application/json'},body:JSON.stringify({query:'query{user(login:"'+login+'"){stream{viewersCount}}}'})});
      const j=await r.json(),st=j&&j.data&&j.data.user&&j.data.user.stream;setViewers('twitch',st?Number(st.viewersCount)||0:null);
    }catch{setViewers('twitch',null);}
    vwTimer=setTimeout(run,30000);
  };run();
}
function startTW(){
  const my=++genW;if(stopW){stopW();stopW=null;}clearTimeout(vwTimer);setViewers('twitch',null);
  if(!isEn('twitch'))return setStatus('twitch','nonaktif');
  if(!cfg.twitch)return setStatus('twitch','belum diisi');
  const login=twTarget(cfg.twitch);if(!login)return setStatus('twitch','username tidak dikenali');
  let WS;try{WS=require('ws');}catch(e){return setStatus('twitch','modul gagal dimuat: '+String(e&&e.message||e).split('\n')[0]);}
  const attempt=()=>{
    if(my!==genW)return;
    let ws=null,dead=false;
    const retry=msg=>{if(dead)return;dead=true;try{ws&&ws.close()}catch{}if(my!==genW)return;setViewers('twitch',null);setStatus('twitch',msg+' - coba lagi 10 detik');setTimeout(attempt,10000);};
    stopW=()=>{dead=true;try{ws&&ws.close()}catch{}};
    setStatus('twitch','menyambung...');
    try{ws=new WS('wss://irc-ws.chat.twitch.tv:443');}catch(e){return retry('gagal: '+(e&&e.message||e));}
    ws.on('open',()=>{ws.send('CAP REQ :twitch.tv/tags twitch.tv/commands');ws.send('PASS SCHMOOPIIE');ws.send('NICK justinfan'+(10000+Math.floor(Math.random()*80000)));ws.send('JOIN #'+login);});
    ws.on('message',raw=>{
      for(const line of String(raw).split('\r\n')){
        if(!line)continue;
        if(line.startsWith('PING')){try{ws.send('PONG'+line.slice(4));}catch{}continue;}
        const m=P.parseIrc(line);if(!m)continue;
        if(m.cmd==='JOIN'){setStatus('twitch','terhubung');pollTW(login,my);continue;}
        if(m.cmd==='RECONNECT'){retry('Twitch meminta sambung ulang');return;}
        try{P.twitchLine(m).forEach(push);}catch(e){console.log('[twitch] '+(e&&e.message||e));}
      }
    });
    ws.on('error',e=>retry('gagal: '+(e&&e.message||e)));
    ws.on('close',()=>retry('terputus'));
  };attempt();
}

// ===== Kick: Pusher WebSocket (resmi dipakai situs Kick). Butuh ID chatroom, yang diambil dari API publik Kick =====
const KUA='Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
async function kickGet(url){
  let err='';
  try{const r=await fetch(url,{headers:{'User-Agent':KUA,Accept:'application/json','Accept-Language':'en-US,en;q=0.9'}});if(r.ok)return await r.json();err='HTTP '+r.status;}catch(e){err=String(e&&e.message||e);}
  // Kick dilindungi Cloudflare: cadangan lewat mesin jaringan Chromium milik Electron (lebih sering lolos daripada fetch Node)
  if(hooks.netFetch){try{const r=await hooks.netFetch(url);if(r.status===200)return JSON.parse(r.text);err='HTTP '+r.status;}catch(e){err=String(e&&e.message||e);}}
  throw new Error(err);
}
async function kickInfo(slug){
  let j;try{j=await kickGet('https://kick.com/api/v2/channels/'+slug);}catch{j=await kickGet('https://kick.com/api/v1/channels/'+slug);}
  return{room:j&&j.chatroom&&Number(j.chatroom.id)||0,channel:Number(j&&(j.id||(j.user&&j.user.id)))||0,viewers:j&&j.livestream?(Number(j.livestream.viewer_count)||0):null};
}
function pollKK(slug,my){
  clearTimeout(vkTimer);
  const run=async()=>{if(my!==genK)return;try{setViewers('kick',(await kickInfo(slug)).viewers);}catch{setViewers('kick',null);}vkTimer=setTimeout(run,30000);};
  vkTimer=setTimeout(run,3000);
}
function startKK(){
  const my=++genK;if(stopK){stopK();stopK=null;}clearTimeout(vkTimer);setViewers('kick',null);
  if(!isEn('kick'))return setStatus('kick','nonaktif');
  if(!cfg.kick)return setStatus('kick','belum diisi');
  const slug=kkTarget(cfg.kick);if(!slug)return setStatus('kick','username tidak dikenali');
  let WS;try{WS=require('ws');}catch(e){return setStatus('kick','modul gagal dimuat: '+String(e&&e.message||e).split('\n')[0]);}
  const attempt=async()=>{
    if(my!==genK)return;
    let ws=null,dead=false,room=Number(cfg.kickRoom)||0,chan=0;
    const retry=msg=>{if(dead)return;dead=true;try{ws&&ws.close()}catch{}if(my!==genK)return;setViewers('kick',null);setStatus('kick',msg+' - coba lagi 15 detik');setTimeout(attempt,15000);};
    stopK=()=>{dead=true;try{ws&&ws.close()}catch{}};
    setStatus('kick','menyambung...');
    try{const i=await kickInfo(slug);if(!room)room=i.room;chan=i.channel;}
    catch(e){if(!room)return retry('gagal ambil info channel ('+(e&&e.message||e)+'); isi "ID chatroom Kick" manual di Koneksi bila terus begini');}
    if(my!==genK||dead)return;
    if(!room)return retry('channel Kick tidak ditemukan');
    try{ws=new WS('wss://ws-us2.pusher.com/app/32cbd69e4b950bf97679?protocol=7&client=js&version=8.4.0&flash=false');}catch(e){return retry('gagal: '+(e&&e.message||e));}
    const seen=new Set();
    ws.on('message',raw=>{
      let f;try{f=JSON.parse(String(raw));}catch{return;}
      const ev=String(f.event||'');
      if(ev==='pusher:connection_established'){
        ['chatrooms.'+room+'.v2',...(chan?['channel.'+chan,'channel_'+chan]:[])].forEach(c=>ws.send(JSON.stringify({event:'pusher:subscribe',data:{auth:'',channel:c}})));
      }else if(ev==='pusher_internal:subscription_succeeded'){if(/^chatrooms\.\d+\.v2$/.test(f.channel||'')){setStatus('kick','terhubung');pollKK(slug,my);}}
      else if(ev==='pusher:ping'){try{ws.send(JSON.stringify({event:'pusher:pong',data:{}}));}catch{}}
      else if(ev&&!ev.startsWith('pusher')){
        const key=ev+'|'+f.data;if(seen.has(key))return;seen.add(key);if(seen.size>200)seen.delete(seen.values().next().value);
        try{P.kickEvent(ev,f.data).forEach(push);}catch(e){console.log('[kick] '+(e&&e.message||e));}
      }
    });
    ws.on('error',e=>retry('gagal: '+(e&&e.message||e)));
    ws.on('close',()=>retry('terputus'));
  };attempt();
}

function obsAdd({password,port,width,height,url}){
  return new Promise((resolve,reject)=>{
    const WS=require('ws');let ws;try{ws=new WS('ws://127.0.0.1:'+(port||4455));}catch(e){return reject(e);}
    let n=0,done=false;const pend={};
    const fin=(f,v)=>{if(done)return;done=true;clearTimeout(timer);try{ws.close()}catch{}f(v);};
    const timer=setTimeout(()=>fin(reject,new Error('OBS tidak merespons. Pastikan OBS sedang terbuka.')),9000);
    const req=(type,data)=>new Promise((res,rej)=>{const id='r'+(++n);pend[id]={res,rej};ws.send(JSON.stringify({op:6,d:{requestType:type,requestId:id,requestData:data||{}}}));});
    ws.on('error',()=>fin(reject,new Error('Tidak bisa terhubung ke OBS. Di OBS buka Tools > WebSocket Server Settings, lalu centang Enable WebSocket server.')));
    ws.on('close',c=>{if(c===4009)fin(reject,new Error('Password WebSocket OBS salah.'));});
    ws.on('message',async raw=>{
      const m=JSON.parse(raw);
      if(m.op===0){
        const a=m.d.authentication,idt={rpcVersion:1,eventSubscriptions:0};
        if(a){if(!password)return fin(reject,new Error('OBS meminta password WebSocket. Isi kolom password OBS.'));
          const s1=crypto.createHash('sha256').update(password+a.salt).digest('base64');idt.authentication=crypto.createHash('sha256').update(s1+a.challenge).digest('base64');}
        ws.send(JSON.stringify({op:1,d:idt}));
      }else if(m.op===2){
        try{
          const sc=await req('GetCurrentProgramScene');const scene=sc.currentProgramSceneName||sc.sceneName;
          const NAME='ChatStream Overlay',st={url,width:+width||500,height:+height||900,fps:30,css:'body { background-color: rgba(0, 0, 0, 0); margin: 0px auto; overflow: hidden; }'};
          try{await req('CreateInput',{sceneName:scene,inputName:NAME,inputKind:'browser_source',inputSettings:st,sceneItemEnabled:true});}
          catch(e){if(e.code!==601)throw e;await req('SetInputSettings',{inputName:NAME,inputSettings:st,overlay:true});try{await req('CreateSceneItem',{sceneName:scene,sourceName:NAME,sceneItemEnabled:true});}catch{}}
          fin(resolve,{scene});
        }catch(e){fin(reject,e);}
      }else if(m.op===7){
        const p=pend[m.d.requestId];if(!p)return;delete pend[m.d.requestId];
        m.d.requestStatus.result?p.res(m.d.responseData||{}):p.rej(Object.assign(new Error(m.d.requestStatus.comment||'permintaan ke OBS gagal'),{code:m.d.requestStatus.code}));
      }
    });
  });
}

// ===== jembatan ke ekstensi Chrome (kirim chat) =====
// v1.1.0: data YouTube yang tidak dibaca modul youtube-chat, dikirim ekstensi dari halaman chat YouTube di Chrome.
//  gift = item chat bukan teks (mis. hadiah) -> alert / baris chat hadiah;
//  diag = contoh bentuk data yang belum dikenal -> log.txt (sekali per jenis tiap halaman dibuka).
function ytRecv(m){
  if(m.k==='gift'&&m.name&&m.text){const img=String(m.img||'');
    // v1.1.0: hadiah YouTube = alert di samping dock (jalur yang sama dengan hadiah TikTok), bukan baris chat; tidak masuk riwayat / statistik. "mengirimkan Go team!" -> hadiah "Go team!"
    const gift=String(m.text).replace(/^\s*(mengirimkan|mengirim|sent|sends?)\s+/i,'').trim().slice(0,60)||'hadiah';
    emit('msg',{p:'youtube',kind:'gift',name:String(m.name).slice(0,60),gift,n:1,img:/^https:\/\//.test(img)?img:'',t:Date.now(),id:++seq});}
  else if(m.k==='diag'&&m.msg)noteLog(String(m.msg).slice(0,780));}
const {WebSocketServer}=require('ws');
const wss=new WebSocketServer({noServer:true}),ext=new Set(),pendingExt={};
srv.on('upgrade',(req,sock,head)=>{
  const u=new URL(req.url,'http://x'),o=req.headers.origin||'';
  const okO=!o||/^https:\/\/(www\.)?(youtube\.com|tiktok\.com|twitch\.tv|kick\.com)$/.test(o)||o.startsWith('chrome-extension://');
  if(u.pathname!=='/ext'||!okO){sock.destroy();return;}
  wss.handleUpgrade(req,sock,head,w=>wss.emit('connection',w,req));
});
wss.on('connection',ws=>{
  const c={ws,platform:'',bg:false};ext.add(c);
  ws.on('message',raw=>{try{const m=JSON.parse(raw);
    if(m.type==='hello'&&PF4.includes(m.platform)){c.platform=m.platform;c.page=String(m.page||'').slice(0,500);c.key=pageKey(c.page);}
    else if(m.type==='bg'){c.bg=true; // service worker ekstensi (pembuka tab latar); bukan content script platform
      // v15.2.0: beri tahu versi aplikasi supaya ekstensi yang versinya beda memuat ulang dirinya (lihat extension/bg.js). Ekstensi lama (<=15.1.7) mengabaikan pesan ini.
      const v=appVer();if(v){try{ws.send(JSON.stringify({type:'ver',version:v}));}catch{}}}
    else if(m.type==='ping'){try{ws.send('{"type":"pong"}');}catch{}}
    else if(m.type==='yt'&&c.platform==='youtube'&&isEn('youtube'))ytRecv(m); // v1.1.0: reaksi / hadiah / contoh data dari extension/ytx.js
    else if(m.type==='result'&&pendingExt[m.id]){pendingExt[m.id](m);delete pendingExt[m.id];}}catch{}});
  ws.on('close',()=>ext.delete(c));ws.on('error',()=>ext.delete(c));
});
// Versi aplikasi untuk pesan 'ver'. Diisi main.js lewat hooks.appVersion (server tidak boleh mengimpor electron); kosong = jangan kirim (mis. folder ekstensi gagal disalin).
// CG_VERSION hanya cadangan untuk menjalankan server sendirian (tes), main.js tidak memakainya.
const appVer=()=>{try{return String((hooks.appVersion&&hooks.appVersion())||process.env.CG_VERSION||'').trim();}catch{return '';}};
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const PNAME={youtube:'YouTube',tiktok:'TikTok',twitch:'Twitch',kick:'Kick'};
// v15.3.1: tab chat yang terhubung HARUS halaman milik username yang diisi. Dulu platform saja yang dicocokkan, jadi tab Twitch/Kick/YouTube/TikTok milik channel LAIN
// (mis. channel yang sedang kamu tonton) ikut dipakai dan pesan terkirim ke channel yang salah. Kunci halaman SAMA dengan key() di extension/bg.js.
function pageKey(u){try{const x=new URL(u),h=x.hostname.replace(/^www\./,''),p=x.pathname.toLowerCase();
  if(h==='youtube.com'){const v=x.searchParams.get('v');return v&&/^\/(live_chat|watch)/.test(p)?'yt:'+v:'';}
  if(h==='tiktok.com'){const m=p.match(/^\/(@[^/]+)\/live/);return m?'tt:'+m[1]:'';}
  if(h==='twitch.tv'){const m=p.match(/^\/(?:popout\/)?([a-z0-9_]+)/);return m?'tw:'+m[1]:'';}
  if(h==='kick.com'){const m=p.match(/^\/(?:popout\/)?([a-z0-9_-]+)/);return m?'kk:'+m[1]:'';}
}catch{}return '';}
const wantKey=p=>{try{return pageKey(extUrl(p));}catch{return '';}}; // '' = alamat belum diketahui (mis. YouTube belum tersambung): tidak bisa dicocokkan
// Cocok kalau: platform sama, koneksi hidup, dan (ekstensi lama tanpa info halaman ATAU alamat belum diketahui ATAU kunci halaman sama dengan yang diminta).
const okConn=(c,p,w)=>c.platform===p&&c.ws.readyState===1&&(!c.page||!w||c.key===w);
const hasExt=p=>{const w=wantKey(p);return [...ext].some(c=>okConn(c,p,w));};
// Ada tab chat platform ini yang terhubung tetapi milik username LAIN (untuk pesan error yang jelas).
const wrongTab=p=>{const w=wantKey(p);return !!w&&[...ext].some(c=>c.platform===p&&c.ws.readyState===1&&c.page&&c.key!==w);};
const bgConn=()=>[...ext].filter(c=>c.bg&&c.ws.readyState===1).pop();
async function waitUntil(fn,ms,step=250){const end=Date.now()+ms;while(Date.now()<end){if(fn())return true;await sleep(step);}return !!fn();}
// Alamat yang dibuka di tab latar. HARUS cocok dengan pola content script di extension/manifest.json (YouTube: live_chat*, TikTok: */live*, Twitch: twitch.tv/*, Kick: kick.com/*).
// YouTube butuh ID video: dari cfg (kalau diisi link video) atau ytLive (diisi konektor YouTube begitu tersambung, termasuk kalau pengguna hanya mengisi @handle). Kosong = belum diketahui.
function extUrl(p){
  if(p==='youtube'){const t=ytTarget(cfg.youtube),id=(t&&t.liveId)||ytLive;return id?'https://www.youtube.com/live_chat?is_popout=1&v='+encodeURIComponent(id):'';}
  if(p==='tiktok'){const u=ttTarget(cfg.tiktok);return u?'https://www.tiktok.com/@'+u+'/live':'';}
  if(p==='twitch'){const u=twTarget(cfg.twitch);return u?'https://www.twitch.tv/popout/'+u+'/chat?popout=':'';}
  if(p==='kick'){const u=kkTarget(cfg.kick);return u?'https://kick.com/'+u:'';}
  return '';}
// Buka-otomatis hanya jalan kalau saklar nyala DAN kirim chat dinyalakan (kalau kirim chat mati, tab tidak perlu dibuka).
// v15.3.2: Kirim Chat bawaannya MATI, jadi harus sendOn === true (dulu !== false).
const autoOpenOn=()=>settings.global.autoOpen!==false&&settings.global.sendOn===true;
const OPEN_COOLDOWN=15000,OPEN_WAIT=10000,BG_WAIT=3000,lastOpen={},opening={};
// Pastikan content script platform terhubung: kalau belum, minta service worker membuka tab latar lalu tunggu. Hasil: '' = terhubung, selain itu = pesan error (bahasa Indonesia).
function ensureExt(p){
  if(hasExt(p))return Promise.resolve('');
  if(opening[p])return opening[p]; // panggilan bersamaan (mis. kirim berulang) berbagi satu proses buka
  return opening[p]=(async()=>{try{return await doEnsure(p);}finally{delete opening[p];}})();
}
async function doEnsure(p){
  const nm=PNAME[p],manual='Buka halaman chat '+nm+' di Chrome sendiri (lihat Dashboard > Koneksi).';
  if(!autoOpenOn())return 'ekstensi Chrome belum terhubung. '+manual;
  const url=extUrl(p);
  if(!url)return 'ekstensi Chrome belum terhubung dan alamat chat '+nm+' belum diketahui'+(p==='youtube'?' (tunggu YouTube tersambung ke live yang sedang berjalan)':' (isi username dulu di Koneksi)')+'. '+manual;
  await waitUntil(bgConn,BG_WAIT);
  const bg=bgConn();
  if(!bg)return 'ekstensi Chrome belum terhubung. Pastikan Chrome terbuka dan sudah login, ekstensi sudah dimuat ulang di chrome://extensions, lalu coba lagi. '+manual;
  if(Date.now()-(lastOpen[p]||0)>OPEN_COOLDOWN){lastOpen[p]=Date.now();try{bg.ws.send(JSON.stringify({type:'open',platform:p,url}));}catch{}}
  if(await waitUntil(()=>hasExt(p),OPEN_WAIT))return '';
  if(wrongTab(p))return 'tab chat '+nm+' yang terbuka di Chrome bukan milik username yang kamu isi di Koneksi, jadi pesan tidak dikirim ke sana (supaya tidak salah channel). Halaman yang benar sudah diminta dibuka: tunggu sebentar lalu kirim lagi.';
  return 'halaman chat '+nm+' sudah dibuka di Chrome tetapi belum terhubung ke aplikasi (mungkin masih memuat atau belum login). Coba kirim lagi sebentar lagi.';
}
function autoOpen(p){if(!autoOpenOn()||!isEn(p)||hasExt(p)||!extUrl(p))return;ensureExt(p).catch(()=>{});}
// v15.3.2: akun yang diharapkan mengirim (content script TikTok membandingkannya dengan akun yang login). Platform lain: undefined (tidak ikut terkirim).
const asOf=p=>{if(p!=='tiktok')return undefined;const u=ttTarget(cfg.tiktok);return u?u.toLowerCase():undefined;};
function extSendRaw(platform,text){return new Promise(resolve=>{
  const w=wantKey(platform),c=[...ext].find(x=>okConn(x,platform,w));
  if(!c)return resolve('ekstensi Chrome belum terhubung. Buka halaman chat '+PNAME[platform]+' di Chrome (lihat Dashboard > Koneksi).');
  const id=String(++seq),t=setTimeout(()=>{delete pendingExt[id];resolve('halaman chat tidak merespons');},9000);
  pendingExt[id]=m=>{clearTimeout(t);resolve(m.ok?'ok':(m.error||'gagal'));};
  c.ws.send(JSON.stringify({type:'send',id,text,as:asOf(platform)}));});}
// Kirim lewat ekstensi. Kalau content script platform belum terhubung -> buka tab latar dulu (ensureExt), baru kirim.
// Kalau tab baru dibuka dan kolom chat belum sempat tampil ("tidak ditemukan"), coba SEKALI lagi setelah jeda, baru menyerah.
async function extSend(platform,text){
  let fresh=false;
  if(!hasExt(platform)){const e=await ensureExt(platform);if(e)return e;fresh=true;await sleep(800);}
  let r=await extSendRaw(platform,text);
  if(r!=='ok'&&fresh&&/tidak ditemukan/i.test(r)){await sleep(2500);r=await extSendRaw(platform,text);}
  return r;}
