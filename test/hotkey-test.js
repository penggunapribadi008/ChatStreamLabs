// Tes hotkey per Browser Dock (v1.1.10): server.js asli, tanpa jaringan. Jalankan: node test/hotkey-test.js
// Memeriksa: kunci hotkey 'dock:<id>:<aksi>' tersimpan, dan ikut dibuang (dan dilepas lewat hook setHotkeys) saat dock-nya dihapus.
const fs=require('fs'),os=require('os'),path=require('path'),http=require('http');
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'hk-'));process.env.CG_DATA=dir;
fs.writeFileSync(path.join(dir,'config.json'),JSON.stringify({port:39527,enabled:{youtube:false,tiktok:false,twitch:false,kick:false}}));
try{require.resolve('ws');}catch{const d=path.join(dir,'node_modules','ws');fs.mkdirSync(d,{recursive:true});
  fs.writeFileSync(path.join(d,'index.js'),'class W{on(){return this;}send(){}close(){}}class Sv extends W{constructor(){super();this.clients=new Set();}}W.WebSocketServer=Sv;W.Server=Sv;module.exports=W;');
  process.env.NODE_PATH=path.join(dir,'node_modules');require('module')._initPaths();}
const S=require('../src/server.js');
const calls=[];S.hooks.setHotkeys=m=>{calls.push(JSON.parse(JSON.stringify(m)));return Promise.resolve({});};
let fails=0;const ck=(c,m)=>{if(!c){console.log('GAGAL',m);fails++;}};
const post=(p,o)=>new Promise((res,rej)=>{const r=http.request({host:'127.0.0.1',port:S.port,path:p,method:'POST'},x=>{let b='';x.on('data',d=>b+=d);x.on('end',()=>res(JSON.parse(b||'{}')));});r.on('error',rej);r.end(JSON.stringify(o||{}));});
const saved=()=>JSON.parse(fs.readFileSync(path.join(dir,'settings.json'),'utf8')).global;
(async()=>{
  await S.ready;
  const D=[{id:'d1',name:'Saweria',url:'https://example.com/a'},{id:'d2',name:'Media Share',url:'https://example.com/b'}];
  let r=await post('/donate-docks',{docks:D});ck(r.ok&&r.docks.length===2,'dua dock tersimpan');
  ck(calls.length===0,'menambah dock tidak mendaftar ulang hotkey');
  await post('/hotkeys',{hotkeys:{lock:'Ctrl+Alt+L','dock:d1:pin':'Ctrl+Alt+1','dock:d2:obs':'Ctrl+Alt+2','dock:d2:mute':'Ctrl+Alt+3'}});
  ck(calls.length===1&&calls[0]['dock:d2:obs']==='Ctrl+Alt+2','/hotkeys meneruskan kunci dock ke cangkang');
  ck(saved().hotkeys['dock:d1:pin']==='Ctrl+Alt+1','kunci dock tersimpan di settings.json');
  r=await post('/donate-docks',{docks:[D[0]]});ck(r.ok&&r.docks.length===1,'dock kedua dihapus');
  const hk=saved().hotkeys;
  ck(hk['dock:d1:pin']==='Ctrl+Alt+1'&&hk.lock==='Ctrl+Alt+L','hotkey dock yang masih ada dan hotkey umum tetap');
  ck(!('dock:d2:obs' in hk)&&!('dock:d2:mute' in hk),'hotkey milik dock yang dihapus ikut dibuang');
  ck(calls.length===2&&!('dock:d2:obs' in calls[1])&&calls[1]['dock:d1:pin']==='Ctrl+Alt+1','cangkang diminta mendaftar ulang tanpa hotkey dock yang dihapus');
  r=await post('/donate-docks',{docks:[D[0],{...D[0],id:'d1',name:'Saweria (ganti nama)'}]});
  ck(saved().hotkeys['dock:d1:pin']==='Ctrl+Alt+1','ganti nama dock tidak menghapus hotkey-nya');
  console.log(fails?fails+' tes gagal':'tes hotkey per dock lulus');process.exit(fails?1:0);
})().catch(e=>{console.log('GAGAL',e);process.exit(1);});
