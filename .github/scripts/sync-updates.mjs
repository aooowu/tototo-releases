import {verify,createHash} from 'node:crypto';
import fs from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
const publicKey='-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEAFpDwszO9/jPwdCNjS2lGAz/6Okhgo32wmKE8pFjrMrs=\n-----END PUBLIC KEY-----\n';
export function manifest(bytes,version){
 const e=JSON.parse(bytes.toString()),payload=Buffer.from(e.payload,'base64');
 if(!verify(null,payload,publicKey,Buffer.from(e.signature,'base64')))throw Error('Invalid update signature');
 const m=JSON.parse(payload);if(m.appId!=='com.wotoutoutou.client'||(m.version!==version&&!(m.schema===1&&m.version==='0.1.57-alpha.'+m.build&&m.notes?.includes('Tototo '+version+' ')))||!Number.isSafeInteger(m.build)||m.build<1||![1,2].includes(m.schema)||!/^https:\/\/github\.com\/aooowu\/tototo-releases\/releases\/download\/v[0-9.]+\/[A-Za-z0-9._-]+$/.test(m.archive?.url)||!Number.isSafeInteger(m.archive.size)||m.archive.size<=0||!/^[a-f0-9]{64}$/.test(m.archive.sha256))throw Error('Invalid update manifest');return m;
}
export async function downloadAsset(url,limit,repo,request=fetch,pause=ms=>new Promise(resolve=>setTimeout(resolve,ms))){
 if(!url.startsWith('https://github.com/'+repo+'/releases/download/'))throw Error('Unexpected download host');
 for(let attempt=0;attempt<3;attempt++){
  let response;
  try{response=await request(url+'?sync='+Date.now(),{signal:AbortSignal.timeout(120000)})}
  catch(error){if(attempt===2)throw error;await pause(1000*(attempt+1));continue}
  if((response.status===429||response.status>=500)&&attempt<2){await response.body?.cancel();await pause(1000*(attempt+1));continue}
  if(!response.ok)throw Error('Download '+response.status);
  const chunks=[];let n=0;for await(const chunk of response.body){n+=chunk.length;if(n>limit)throw Error('Asset too large');chunks.push(chunk)}return Buffer.concat(chunks);
 }
}
export async function sync(tag,repo,api,download){
 if(!/^v\d+\.\d+\.\d+$/.test(tag)||repo!=='aooowu/tototo-releases')throw Error('Invalid release');
 const version=tag.slice(1),release=await api(`/releases/tags/${tag}`);
 if(release.draft||release.prerelease)throw Error('Release must be published and stable');
 const plans=[['client-updates-v3','latest.json',2],['client-updates-v2','latest-legacy-modern.json',2],['client-updates','latest-legacy-alpha.json',1]];
 const ready=[];
 // Verify every signed feed and its archive before changing any old entry point.
 for(const [feed,name,schema]of plans){
  const asset=release.assets.find(a=>a.name===name&&a.state==='uploaded');if(!asset)throw Error('Missing '+name);
  const bytes=await download(asset.browser_download_url,3*1024*1024),m=manifest(bytes,version);
  if(m.schema!==schema||ready.length&&ready[0].m.build!==m.build)throw Error('Wrong feed schema or build');
  const archive=release.assets.find(a=>a.browser_download_url===m.archive.url&&a.state==='uploaded');
  if(!archive||archive.size!==m.archive.size)throw Error('Missing archive');
  if(archive.digest){if(archive.digest!=='sha256:'+m.archive.sha256)throw Error('Archive digest mismatch')}
  else if(createHash('sha256').update(await download(archive.browser_download_url,128*1024*1024)).digest('hex')!==m.archive.sha256)throw Error('Archive digest mismatch');
  const target=await api(`/releases/tags/${feed}`),old=target.assets.find(a=>a.name==='latest.json'&&a.state==='uploaded');
  let oldBytes;if(old){oldBytes=await download(old.browser_download_url,3*1024*1024);const envelope=JSON.parse(oldBytes.toString()),prior=JSON.parse(Buffer.from(envelope.payload,'base64'));manifest(oldBytes,prior.version);if(prior.build>m.build)throw Error('Refusing downgrade');if(prior.build===m.build&&!oldBytes.equals(bytes))throw Error('Build identity conflict')}
  ready.push({feed,target,old,oldBytes,bytes,m});
 }
 for(const row of ready){
  if(row.oldBytes?.equals(row.bytes)){console.log(row.feed+' already current');continue}
  let renamed=false;
  try{
   if(row.old){await api(`/releases/assets/${row.old.id}`,'PATCH',{name:`latest-before-${version}-${row.old.id}.json`});renamed=true}
   const created=await api(`/releases/${row.target.id}/assets?name=latest.json`,'UPLOAD',row.bytes);
   const actual=await download(created.browser_download_url,3*1024*1024);
   if(!actual.equals(row.bytes))throw Error('Published manifest differs');
   console.log(row.feed+' -> '+row.m.version);
  }catch(error){if(renamed){const target=await api(`/releases/tags/${row.feed}`);if(!target.assets.some(a=>a.name==='latest.json'))await api(`/releases/assets/${row.old.id}`,'PATCH',{name:'latest.json'})}throw error}
 }
 return {version,feeds:ready.map(r=>r.feed)};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 const repo=process.env.GITHUB_REPOSITORY,event=JSON.parse(await fs.readFile(process.env.GITHUB_EVENT_PATH,'utf8')),tag=event.release?.tag_name??event.inputs?.tag;
 const assets=new Map();
 const api=async(path,method='GET',body)=>{const upload=method==='UPLOAD',url=(upload?'https://uploads.github.com':'https://api.github.com')+'/repos/'+repo+path;
  const response=await fetch(url,{method:upload?'POST':method,signal:AbortSignal.timeout(30000),headers:{Authorization:'Bearer '+process.env.GH_TOKEN,Accept:'application/vnd.github+json','X-GitHub-Api-Version':'2022-11-28',...(body?{'Content-Type':upload?'application/octet-stream':'application/json'}:{})},body:body?(upload?body:JSON.stringify(body)):undefined});if(!response.ok)throw Error('GitHub '+response.status+' for '+path);
  const data=await response.json();for(const asset of data.assets??[data])if(Number.isSafeInteger(asset.id)&&asset.browser_download_url)assets.set(asset.browser_download_url,asset);return data};
 // Use GitHub's official asset API; new browser download routes can lag behind publication.
 const download=(url,limit)=>{const asset=assets.get(url);if(!asset)throw Error('Missing asset metadata');return downloadAsset(url,limit,repo,(_url,options)=>fetch('https://api.github.com/repos/'+repo+'/releases/assets/'+asset.id+'?sync='+Date.now(),{...options,headers:{Authorization:'Bearer '+process.env.GH_TOKEN,Accept:'application/octet-stream','X-GitHub-Api-Version':'2022-11-28'}}))};
 await sync(tag,repo,api,download);
}
