// Tes updater.js dengan server GitHub PALSU (tanpa internet). Jalankan: node test/updater-test.js
const http=require('http'),crypto=require('crypto'),fs=require('fs'),os=require('os'),path=require('path'),{spawnSync,spawn}=require('child_process');
const exe=Buffer.concat([Buffer.from('MZ'),crypto.randomBytes(200*1024)]);
const sha=crypto.createHash('sha256').update(exe).digest('hex');
let mode='digest',repoPublic=true;
const RURL='/repos/o/r/releases?per_page=15';
const srv=http.createServer((q,s)=>{
  const base='http://127.0.0.1:'+srv.address().port;
  if(q.url==='/repos/o/priv/releases?per_page=15'){s.writeHead(404);return s.end('{}');}
  if(q.url===RURL){
    const assets=[{name:'x.zip',browser_download_url:base+'/dl/x.zip'},{name:'ChatStream.Labs_2.0.0_x64-setup.exe',size:exe.length,browser_download_url:base+'/dl/setup.exe',digest:mode==='digest'?'sha256:'+sha:undefined}];
    if(mode==='shafile')assets.push({name:'ChatStream.Labs_2.0.0_x64-setup.exe.sha256',browser_download_url:base+'/dl/setup.sha'});
    if(mode==='nosha'||mode==='bad'||mode==='body')assets[1].digest=mode==='bad'?'sha256:'+'0'.repeat(64):undefined;
    // v1.1.8: rilis dibuat sebagai PRA-RILIS; daftar juga memuat draf (harus dilewati) dan rilis lama (harus kalah)
    const body=mode==='body'?'Catatan.\n\nSHA-256: '+sha+'\n':'';
    const list=[{tag_name:'v9.9.9',draft:true,prerelease:false,assets},{tag_name:'v2.0.0',draft:false,prerelease:true,body,assets},{tag_name:'v1.0.0',draft:false,prerelease:false,assets:[]}];
    s.writeHead(200,{'content-type':'application/json'});return s.end(JSON.stringify(list));
  }
  if(q.url==='/dl/setup.exe'){s.writeHead(200,{'content-length':exe.length});return s.end(exe);}
  if(q.url==='/dl/setup.sha'){s.writeHead(200);return s.end(sha+'  ChatStream.Labs_2.0.0_x64-setup.exe\n');}
  s.writeHead(404);s.end();
});
let fails=0;const ck=(c,m)=>{if(!c){console.log('GAGAL',m);fails++;}};
const run=(args)=>new Promise(res=>{const p=spawn(process.execPath,[path.join(__dirname,'../src/updater.js'),...args],{env:{...process.env,CSL_GH_API:'http://127.0.0.1:'+srv.address().port}});let o='';p.stdout.on('data',d=>o+=d);p.on('exit',()=>res(o.trim().split('\n').filter(Boolean).map(l=>JSON.parse(l))));});
srv.listen(0,'127.0.0.1',async()=>{
  const tmp=path.join(fs.mkdtempSync(path.join(os.tmpdir(),'up-')),'setup.exe');
  let r=await run(['check','o/r','1.1.1']);ck(r[0].status==='available'&&r[0].version==='2.0.0','check: ada versi baru');
  r=await run(['check','o/r','2.0.0']);ck(r[0].status==='none','check: sudah terbaru');
  r=await run(['check','o/r','2.0.1']);ck(r[0].status==='none','check: lokal lebih baru');
  r=await run(['check','o/priv','1.0.0']);ck(r[0].status==='none','check: repo private/404 = none');
  r=await run(['check','bukan repo','1.0.0']);ck(r[0].status==='error','check: nama repo tidak sah');
  mode='digest';r=await run(['check','o/r','1.1.7']);ck(r[0].status==='available'&&r[0].version==='2.0.0'&&r[0].tag==='v2.0.0','check: pra-rilis terbaru terbaca, draf v9.9.9 dilewati');
  mode='digest';r=await run(['download','o/r',tmp]);ck(r.some(x=>x.p>0&&x.p<100)||r.some(x=>x.p===100),'download: ada progres');
  ck(r[r.length-1].status==='done'&&fs.readFileSync(tmp).equals(exe),'download: digest cocok, berkas utuh');fs.unlinkSync(tmp);
  mode='shafile';r=await run(['download','o/r',tmp]);ck(r[r.length-1].status==='done','download: lewat berkas .sha256');fs.unlinkSync(tmp);
  mode='body';r=await run(['download','o/r',tmp]);ck(r[r.length-1].status==='done'&&fs.readFileSync(tmp).equals(exe),'download: tanpa .sha256 dan tanpa digest, checksum dari catatan rilis');fs.unlinkSync(tmp);
  mode='bad';r=await run(['download','o/r',tmp]);ck(r[r.length-1].status==='error'&&!fs.existsSync(tmp)&&!fs.existsSync(tmp+'.part'),'download: checksum salah ditolak, tidak ada sisa');
  mode='nosha';r=await run(['download','o/r',tmp]);ck(r[r.length-1].status==='error'&&!fs.existsSync(tmp),'download: tanpa checksum ditolak');
  srv.close();console.log(fails?fails+' tes gagal':'tes updater lulus');process.exit(fails?1:0);
});
