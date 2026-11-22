// Tes "mata" per jendela (v1.1.9): server.js asli, tanpa jaringan. Jalankan: node test/protect-test.js
// Memeriksa: /protect-toggle (Chat Dock vs Browser Dock), argumen hook `protect`, /dash-state, dan simpanan di settings.json.
const fs=require('fs'),os=require('os'),path=require('path'),http=require('http');
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'pt-'));process.env.CG_DATA=dir;
fs.writeFileSync(path.join(dir,'config.json'),JSON.stringify({port:39517,enabled:{youtube:false,tiktok:false,twitch:false,kick:false}}));
// server.js memuat 'ws' saat start; kalau belum di-npm install, pakai tiruan kosong supaya tes tetap jalan
try{require.resolve('ws');}catch{const d=path.join(dir,'node_modules','ws');fs.mkdirSync(d,{recursive:true});
  fs.writeFileSync(path.join(d,'index.js'),'class W{on(){return this;}send(){}close(){}}class Sv extends W{constructor(){super();this.clients=new Set();}}W.WebSocketServer=Sv;W.Server=Sv;module.exports=W;');
  process.env.NODE_PATH=path.join(dir,'node_modules');require('module')._initPaths();}
const S=require('../src/server.js');
const calls=[];S.hooks.protect=(chat,docks)=>calls.push([chat,JSON.parse(JSON.stringify(docks))]);
let fails=0;const ck=(c,m)=>{if(!c){console.log('GAGAL',m);fails++;}};
const req=(method,p)=>new Promise((res,rej)=>{const r=http.request({host:'127.0.0.1',port:S.port,path:p,method},x=>{let b='';x.on('data',d=>b+=d);x.on('end',()=>res(b));});r.on('error',rej);r.end(method==='POST'?'{}':undefined);});
const last=()=>calls[calls.length-1];
(async()=>{
  await S.ready;
  await req('POST','/protect-toggle');
  ck(last()&&last()[0]===false&&Object.keys(last()[1]).length===0,'tanpa t = Chat Dock saja: protect jadi false, Browser Dock tidak disentuh');
  await req('POST','/protect-toggle?t=abc');
  ck(last()[0]===false&&last()[1].abc===false,'t=abc: hanya Browser Dock abc yang terlihat, Chat Dock tetap');
  await req('POST','/protect-toggle?t=xyz');
  ck(last()[1].abc===false&&last()[1].xyz===false,'dock kedua bebas dari dock pertama');
  await req('POST','/protect-toggle?t=abc');
  ck(last()[1].abc===true&&last()[1].xyz===false,'abc kembali tersembunyi, xyz tidak ikut');
  const ds=JSON.parse(await req('GET','/dash-state'));
  ck(ds.protect===false&&ds.dockProtect.abc===true&&ds.dockProtect.xyz===false,'/dash-state membawa mata Chat Dock dan tiap Browser Dock');
  await req('POST','/protect-toggle?t=chat');
  ck(last()[0]===true&&last()[1].xyz===false,'t=chat: Chat Dock tersembunyi lagi, Browser Dock xyz tidak ikut');
  const saved=JSON.parse(fs.readFileSync(path.join(dir,'settings.json'),'utf8')).global;
  ck(saved.protect===true&&saved.dockProtect.abc===true&&saved.dockProtect.xyz===false,'tersimpan di settings.json (dibaca Rust saat start)');
  console.log(fails?fails+' tes gagal':'tes mata per jendela lulus');process.exit(fails?1:0);
})().catch(e=>{console.log('GAGAL',e);process.exit(1);});
