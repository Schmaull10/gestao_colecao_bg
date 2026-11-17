(()=>{
'use strict';

const STORAGE='gestao_colecao_bg_portable_v1'; // compatível com versões anteriores
const BGG_TOKEN_STORAGE='gestao_colecao_bg_bgg_token';
const COLLECTION_SORT_STORAGE='gestao_colecao_bg_collection_sort';
const GH_TOKEN_STORAGE='gestao_colecao_bg_github_token';
const GITHUB_OWNER='Schmaull10';
const GITHUB_DATA_REPO='gestao_colecao_bg_data';
const GITHUB_DATA_PATH='colecao.json';
const GITHUB_BRANCH='main';
const HELPER='http://127.0.0.1:8766';
const HOSTED_MODE=location.hostname.endsWith('github.io');
const APP_VERSION='1.4.3';
const clone=x=>JSON.parse(JSON.stringify(x));
const $=s=>document.querySelector(s), $$=s=>[...document.querySelectorAll(s)];
let data=loadLocal();
let view='dashboard', editItemId=null, sellItemId=null, editWishId=null, priceWishId=null, bggItemId=null, bggTargetKind='item', editDateItemId=null, editDateType=null;
let expansionBaseId=null, manualRankWishId=null;
let batchRunning=false;
let syncState={mode:'a iniciar',modified:null,path:GITHUB_DATA_PATH,error:null,sha:null,localMirror:false};
let saveTimer=null, githubSha=null, lastSyncedRaw=null, saveInFlight=false, saveQueued=false, conflictAlerted=false;
let deferredInstallPrompt=null, lastBggCall=0;


function normalize(){
  for(const k of ['items','wishlist','wishlist_prices','movements','app_meta','wishlist_ranking','wishlist_comparisons']) if(!Array.isArray(data[k])) data[k]=[];
  data.items.forEach(i=>{
    if(!i.item_type) i.item_type='base';
    if(i.item_type!=='expansion') i.item_type='base';
    i.base_game_id=i.item_type==='expansion' && i.base_game_id!==null && i.base_game_id!==undefined && i.base_game_id!=='' ? Number(i.base_game_id) : null;
  });
  data.wishlist.forEach(w=>{
    if(!w.item_type) w.item_type='base';
    if(w.item_type!=='expansion') w.item_type='base';
    w.base_game_id=w.item_type==='expansion' && w.base_game_id!==null && w.base_game_id!==undefined && w.base_game_id!=='' ? Number(w.base_game_id) : null;
  });
  const validWishIds=new Set(data.wishlist.map(w=>Number(w.id)));
  const seenRank=new Set();
  data.wishlist_ranking=data.wishlist_ranking.map(Number).filter(id=>validWishIds.has(id)&&!seenRank.has(id)&&(seenRank.add(id),true));
  data.wishlist_comparisons=data.wishlist_comparisons.filter(c=>validWishIds.has(Number(c.left_id))&&validWishIds.has(Number(c.right_id)));
  if(data.wishlist_rank_session&&typeof data.wishlist_rank_session==='object'){
    const sid=Number(data.wishlist_rank_session.item_id);
    if(!validWishIds.has(sid))data.wishlist_rank_session=null;
  }else data.wishlist_rank_session=null;
}
function loadLocal(){
  try{const x=localStorage.getItem(STORAGE); if(x) return JSON.parse(x);}catch(e){}
  return clone(window.INITIAL_BG_DATA);
}
normalize();
function getGithubToken(){return (localStorage.getItem(GH_TOKEN_STORAGE)||'').trim()}
function utf8ToB64(str){const bytes=new TextEncoder().encode(str);let bin='';for(let i=0;i<bytes.length;i+=0x8000)bin+=String.fromCharCode(...bytes.subarray(i,i+0x8000));return btoa(bin)}
function b64ToUtf8(b64){const bin=atob(String(b64||'').replace(/\n/g,''));const bytes=new Uint8Array(bin.length);for(let i=0;i<bin.length;i++)bytes[i]=bin.charCodeAt(i);return new TextDecoder().decode(bytes)}
async function githubApi(path,{method='GET',body=null,token=getGithubToken()}={}){
  if(!token)throw new Error('Token GitHub em falta.');
  const res=await fetch('https://api.github.com'+path,{method,headers:{'Accept':'application/vnd.github+json','Authorization':`Bearer ${token}`,'X-GitHub-Api-Version':'2022-11-28','Content-Type':'application/json'},body:body?JSON.stringify(body):null});
  let obj=null;try{obj=await res.json()}catch(e){}
  if(!res.ok){const err=new Error(obj?.message||`GitHub HTTP ${res.status}`);err.status=res.status;err.payload=obj;throw err}
  return obj;
}
function githubContentPath(path=GITHUB_DATA_PATH){return `/repos/${encodeURIComponent(GITHUB_OWNER)}/${encodeURIComponent(GITHUB_DATA_REPO)}/contents/${path.split('/').map(encodeURIComponent).join('/')}?ref=${encodeURIComponent(GITHUB_BRANCH)}`}
async function loadGithubData(){
  let obj;
  try{obj=await githubApi(githubContentPath())}catch(e){if(e.status===404)return {exists:false};throw e}
  // Em ficheiros maiores, a Contents API pode devolver metadata sem o campo content.
  // Nesses casos, lemos o conteúdo pelo Git Blob API usando o SHA devolvido.
  let encoded=String(obj.content||'').replace(/\n/g,'');
  if(!encoded&&obj.sha){
    const blob=await githubApi(`/repos/${GITHUB_OWNER}/${GITHUB_DATA_REPO}/git/blobs/${encodeURIComponent(obj.sha)}`);
    encoded=String(blob.content||'').replace(/\n/g,'');
  }
  if(!encoded)throw new Error('O colecao.json existe no GitHub, mas não foi possível ler o conteúdo.');
  const raw=b64ToUtf8(encoded);
  return {exists:true,raw,sha:obj.sha,modified:null,path:GITHUB_DATA_PATH};
}
async function createDailyGithubBackup(previousRaw){
  if(!previousRaw)return;
  const day=today(),key='gestao_colecao_bg_last_cloud_backup';
  if(localStorage.getItem(key)===day)return;
  const path=`backups/colecao_${day}.json`;
  try{
    let existing=null;try{existing=await githubApi(githubContentPath(path))}catch(e){if(e.status!==404)throw e}
    if(!existing)await githubApi(`/repos/${GITHUB_OWNER}/${GITHUB_DATA_REPO}/contents/${path}`,{method:'PUT',body:{message:`Backup automático ${day}`,content:utf8ToB64(previousRaw),branch:GITHUB_BRANCH}});
    localStorage.setItem(key,day);
  }catch(e){console.warn('Backup cloud não criado:',e)}
}
async function saveGithubData({force=false}={}){
  const raw=JSON.stringify(data);
  if(saveInFlight){saveQueued=true;return}
  saveInFlight=true;
  try{
    let currentSha=githubSha, previousRaw=null;
    const cur=await loadGithubData();
    if(cur.exists){
      previousRaw=cur.raw;
      // Se o SHA remoto avançou mas o conteúdo é exatamente a última versão
      // que este dispositivo sincronizou, trata-se de continuação da nossa
      // própria fila de gravações (ou de outro separador com o mesmo estado).
      if(!force&&currentSha&&cur.sha!==currentSha){
        if(lastSyncedRaw!==null&&cur.raw===lastSyncedRaw){
          githubSha=cur.sha;
          currentSha=cur.sha;
        }else if(cur.raw===raw){
          githubSha=cur.sha;
          lastSyncedRaw=cur.raw;
          syncState={mode:'sincronizada · GitHub',modified:new Date().toISOString(),path:`${GITHUB_DATA_REPO}/${GITHUB_DATA_PATH}`,error:null,sha:githubSha,localMirror:syncState.localMirror};
          conflictAlerted=false;
          localStorage.setItem(STORAGE,raw);updateSyncBadge();mirrorToLocalHelper(raw).catch(()=>{});
          return;
        }else{
          const err=new Error('Os dados foram alterados noutro dispositivo. Recarrega do GitHub antes de continuar.');
          err.conflict=true;throw err;
        }
      }else{
        currentSha=cur.sha;
      }
    }else{
      currentSha=null;
    }

    await createDailyGithubBackup(previousRaw);
    const body={message:`Atualização Gestão Coleção BG · ${new Date().toLocaleString('pt-PT')}`,content:utf8ToB64(raw),branch:GITHUB_BRANCH};
    if(currentSha)body.sha=currentSha;

    let res;
    try{
      res=await githubApi(`/repos/${GITHUB_OWNER}/${GITHUB_DATA_REPO}/contents/${GITHUB_DATA_PATH}`,{method:'PUT',body});
    }catch(e){
      if(e.status===409||e.status===422){
        // Uma única recuperação automática: volta a ler o ficheiro e só
        // continua se a versão remota for a nossa última versão conhecida.
        const latest=await loadGithubData();
        if(!force&&latest.exists&&lastSyncedRaw!==null&&latest.raw===lastSyncedRaw){
          body.sha=latest.sha;
          res=await githubApi(`/repos/${GITHUB_OWNER}/${GITHUB_DATA_REPO}/contents/${GITHUB_DATA_PATH}`,{method:'PUT',body});
        }else{
          const er=new Error('Conflito de sincronização: existe uma versão mais recente no GitHub.');
          er.conflict=true;throw er;
        }
      }else throw e;
    }

    githubSha=res?.content?.sha||null;
    if(!githubSha){
      const confirmed=await loadGithubData();
      githubSha=confirmed.exists?confirmed.sha:null;
    }
    lastSyncedRaw=raw;
    syncState={mode:'sincronizada · GitHub',modified:new Date().toISOString(),path:`${GITHUB_DATA_REPO}/${GITHUB_DATA_PATH}`,error:null,sha:githubSha,localMirror:syncState.localMirror};
    conflictAlerted=false;
    localStorage.setItem(STORAGE,raw);updateSyncBadge();
    mirrorToLocalHelper(raw).catch(()=>{});
  }catch(e){
    syncState={...syncState,mode:e.conflict?'conflito · não gravado':'erro de sincronização',error:e.message};updateSyncBadge();
    if(e.conflict&&!conflictAlerted){
      conflictAlerted=true;
      alert('Há alterações realmente diferentes no GitHub. As tuas alterações continuam guardadas neste dispositivo, mas não foram enviadas. Vai a Definições para recarregar ou, se tiveres a certeza, forçar a gravação.');
    }
    throw e;
  }finally{
    saveInFlight=false;
    if(saveQueued){saveQueued=false;setTimeout(()=>persistSharedData().catch(()=>{}),300)}
  }
}
function save(){
  localStorage.setItem(STORAGE,JSON.stringify(data));
  clearTimeout(saveTimer);
  saveTimer=setTimeout(()=>{persistSharedData().catch(()=>{})},1200);
}
async function persistSharedData(){
  if(HOSTED_MODE||getGithubToken())return saveGithubData();
  const r=await helperPostLocal('/api/data/save',{raw:JSON.stringify(data)});
  syncState={mode:'sincronizada · pasta local',modified:r.modified||null,path:r.path||'data/colecao.json',error:null,sha:null,localMirror:true};updateSyncBadge();return r;
}
async function mirrorToLocalHelper(raw){
  try{const r=await helperPostLocal('/api/data/save',{raw},900);syncState.localMirror=true;return r}catch(e){syncState.localMirror=false;return null}
}
async function initializeSharedData(){
  if(HOSTED_MODE||getGithubToken()){
    const token=getGithubToken();
    if(!token){data=loadLocal();normalize();syncState={mode:'configurar GitHub',modified:null,path:`${GITHUB_DATA_REPO}/${GITHUB_DATA_PATH}`,error:null,sha:null,localMirror:false};setTimeout(showCloudSetup,50);return}
    try{
      const r=await loadGithubData();
      if(r.exists&&r.raw){const parsed=JSON.parse(r.raw);if(!Array.isArray(parsed.items)||!Array.isArray(parsed.wishlist))throw new Error('O colecao.json remoto não contém uma base válida.');data=parsed;normalize();githubSha=r.sha;lastSyncedRaw=r.raw;localStorage.setItem(STORAGE,JSON.stringify(data));syncState={mode:'sincronizada · GitHub',modified:null,path:`${GITHUB_DATA_REPO}/${GITHUB_DATA_PATH}`,error:null,sha:githubSha,localMirror:false};mirrorToLocalHelper(JSON.stringify(data)).catch(()=>{})}
      else {data=loadLocal();normalize();syncState={mode:'GitHub ligado · falta importar base',modified:null,path:`${GITHUB_DATA_REPO}/${GITHUB_DATA_PATH}`,error:null,sha:null,localMirror:false};setTimeout(()=>showCloudSetup(true),50)}
    }catch(e){data=loadLocal();normalize();syncState={mode:'erro de ligação GitHub',modified:null,path:`${GITHUB_DATA_REPO}/${GITHUB_DATA_PATH}`,error:e.message,sha:null,localMirror:false};setTimeout(showCloudSetup,50)}
    return;
  }
  try{
    let r=null,lastErr=null;for(let n=0;n<8;n++){try{r=await helperPostLocal('/api/data/load',{});break}catch(e){lastErr=e;await new Promise(res=>setTimeout(res,300))}}
    if(!r)throw lastErr||new Error('Não foi possível iniciar o helper local.');
    if(r.exists&&r.raw){const parsed=JSON.parse(r.raw);if(!Array.isArray(parsed.items)||!Array.isArray(parsed.wishlist))throw new Error('O ficheiro data/colecao.json não contém uma base válida.');data=parsed;normalize();localStorage.setItem(STORAGE,JSON.stringify(data));syncState={mode:'sincronizada · pasta local',modified:r.modified||null,path:r.path||'data/colecao.json',error:null,sha:null,localMirror:true}}
    else{normalize();const saved=await persistSharedData();syncState={mode:'sincronizada · pasta local',modified:saved.modified||null,path:saved.path||'data/colecao.json',error:null,sha:null,localMirror:true}}
  }catch(e){data=loadLocal();normalize();syncState={mode:'apenas neste dispositivo',modified:null,path:'localStorage',error:e.message,sha:null,localMirror:false}}
}
async function reloadSharedData(){
  try{
    if(HOSTED_MODE||getGithubToken()){
      const r=await loadGithubData();if(!r.exists||!r.raw)throw new Error('Ainda não existe colecao.json no repositório privado.');const parsed=JSON.parse(r.raw);if(!Array.isArray(parsed.items)||!Array.isArray(parsed.wishlist))throw new Error('Base remota inválida.');data=parsed;normalize();githubSha=r.sha;lastSyncedRaw=r.raw;localStorage.setItem(STORAGE,JSON.stringify(data));syncState={mode:'sincronizada · GitHub',modified:null,path:`${GITHUB_DATA_REPO}/${GITHUB_DATA_PATH}`,error:null,sha:githubSha,localMirror:syncState.localMirror};render();updateSyncBadge();mirrorToLocalHelper(JSON.stringify(data)).catch(()=>{});alert('Dados recarregados do GitHub.');return;
    }
    const r=await helperPostLocal('/api/data/load',{});if(!r.exists||!r.raw)throw new Error('Ainda não existe data/colecao.json.');const parsed=JSON.parse(r.raw);if(!Array.isArray(parsed.items)||!Array.isArray(parsed.wishlist))throw new Error('Base partilhada inválida.');data=parsed;normalize();localStorage.setItem(STORAGE,JSON.stringify(data));syncState={mode:'sincronizada · pasta local',modified:r.modified||null,path:r.path||'data/colecao.json',error:null,sha:null,localMirror:true};render();alert('Dados recarregados da pasta sincronizada.');
  }catch(e){alert('Não foi possível recarregar os dados: '+e.message)}
}
function updateSyncBadge(){const el=$('#syncBadge');if(!el)return;const ok=String(syncState.mode||'').includes('sincronizada');el.textContent=ok?'● Sync':'● '+(syncState.mode||'offline');el.className='syncBadge '+(ok?'ok':String(syncState.mode).includes('conflito')?'warn':'off')}
function showCloudSetup(needsImport=false){const d=$('#cloudSetupDialog');if(!d)return;$('#cloudToken').value=getGithubToken();$('#cloudSetupStatus').textContent=needsImport?'Ligação feita. Agora importa o colecao.json atual para iniciar a base partilhada.':(syncState.error||'Cola o token GitHub criado para este repositório privado.');$('#cloudImportBox').hidden=!needsImport;try{d.showModal()}catch(e){}}
async function testAndSaveGithubToken(){const t=$('#cloudToken').value.trim(),st=$('#cloudSetupStatus');if(!t){st.textContent='Cola primeiro o token.';return}st.textContent='A testar…';try{await githubApi(`/repos/${GITHUB_OWNER}/${GITHUB_DATA_REPO}`,{token:t});localStorage.setItem(GH_TOKEN_STORAGE,t);st.textContent='Token válido. A verificar a base…';const r=await loadGithubData();if(r.exists&&r.raw){const parsed=JSON.parse(r.raw);if(!Array.isArray(parsed.items)||!Array.isArray(parsed.wishlist))throw new Error('colecao.json remoto inválido.');data=parsed;normalize();githubSha=r.sha;lastSyncedRaw=r.raw;localStorage.setItem(STORAGE,JSON.stringify(data));syncState={mode:'sincronizada · GitHub',modified:null,path:`${GITHUB_DATA_REPO}/${GITHUB_DATA_PATH}`,error:null,sha:githubSha,localMirror:false};$('#cloudSetupDialog').close();nav('dashboard');updateSyncBadge()}else{$('#cloudImportBox').hidden=false;st.textContent='Token válido. O repositório ainda não tem colecao.json — importa o ficheiro atual.'}}catch(e){st.textContent='Erro: '+e.message}}
async function importBaseToGithub(file){const st=$('#cloudSetupStatus');if(!getGithubToken()){st.textContent='Guarda/testa primeiro o token GitHub.';return}const txt=await file.text();let parsed;try{parsed=JSON.parse(txt);if(!Array.isArray(parsed.items)||!Array.isArray(parsed.wishlist))throw 0}catch(e){st.textContent='O ficheiro selecionado não é uma base válida.';return}if(!confirm(`Importar esta base para o GitHub privado?\n\n${parsed.items.length} exemplares · ${parsed.wishlist.length} itens na wishlist`))return;data=parsed;normalize();githubSha=null;localStorage.setItem(STORAGE,JSON.stringify(data));st.textContent='A enviar para o GitHub…';try{await saveGithubData({force:true});$('#cloudSetupDialog').close();nav('dashboard');alert('Base importada. A partir de agora PC e telemóvel usam o mesmo colecao.json privado.')}catch(e){st.textContent='Erro ao importar: '+e.message}}

function nextId(arr){return arr.length?Math.max(...arr.map(x=>+x.id||0))+1:1}
function esc(v=''){return String(v??'').replace(/[&<>"']/g,m=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]))}
function num(v){const n=Number(v);return Number.isFinite(n)?n:0}
function money(v){if(v===null||v===undefined||v==='')return '—';return new Intl.NumberFormat('pt-PT',{style:'currency',currency:'EUR'}).format(num(v))}
function date(v){if(!v)return '—';const p=String(v).slice(0,10).split('-');return p.length===3?`${p[2]}/${p[1]}/${p[0]}`:v}
function today(){return new Date().toISOString().slice(0,10)}
function isCurrent(i){return ['Coleção','À venda'].includes(i.status)}
function isBase(i){return (i.item_type||'base')==='base'}
function isExpansion(i){return i.item_type==='expansion'}
function baseGame(id){return data.items.find(i=>i.id===Number(id)&&isBase(i))||null}
function baseGames(){return data.items.filter(isBase).sort((a,b)=>(a.title||'').localeCompare(b.title||'','pt'))}
function wishById(id){return data.wishlist.find(w=>Number(w.id)===Number(id))||null}
function wishPriority(w){const p=Number(w?.priority);return Number.isFinite(p)&&p>0?p:null}
function rankableWishes(){return data.wishlist.filter(Boolean)}
function wishRankIndex(id){const n=data.wishlist_ranking.indexOf(Number(id));return n>=0?n:null}
function wishRankLabel(id){const n=wishRankIndex(id);return n===null?'—':`#${n+1}`}
function cleanWishlistRanking(){
  const valid=new Set(data.wishlist.map(w=>Number(w.id))),seen=new Set();
  data.wishlist_ranking=(data.wishlist_ranking||[]).map(Number).filter(id=>valid.has(id)&&!seen.has(id)&&(seen.add(id),true));
}
function removeWishFromRanking(id){
  id=Number(id);data.wishlist_ranking=(data.wishlist_ranking||[]).filter(x=>Number(x)!==id);
  if(data.wishlist_rank_session&&(Number(data.wishlist_rank_session.item_id)===id||(data.wishlist_rank_session.candidate_ids||[]).map(Number).includes(id)))data.wishlist_rank_session=null;
}
function relevantRankCandidates(w){
  cleanWishlistRanking();
  return data.wishlist_ranking.filter(id=>Number(id)!==Number(w?.id)&&!!wishById(id));
}
function fallbackRankInsertIndex(w){return data.wishlist_ranking.length}
function recordWishComparison(leftId,rightId,result,winnerId=null){
  data.wishlist_comparisons.push({id:nextId(data.wishlist_comparisons),left_id:Number(leftId),right_id:Number(rightId),result,winner_id:winnerId?Number(winnerId):null,created_at:new Date().toISOString()});
}
function playerText(i){const out=[];[['players_1','1'],['players_2','2'],['players_3','3'],['players_4','4'],['players_5','5'],['players_6plus','6+']].forEach(([k,l])=>{if(['sim','yes','1','true'].includes(String(i[k]||'').toLowerCase()))out.push(l)});return out.join(', ')||'—'}
function summary(){
  const current=data.items.filter(isCurrent), sold=data.items.filter(i=>i.status==='Vendido');
  const currentBases=current.filter(isBase), currentExp=current.filter(isExpansion);
  const soldBases=sold.filter(isBase), soldExp=sold.filter(isExpansion);
  const wishExp=data.wishlist.filter(w=>w.item_type==='expansion');
  return {
    baseCollection:currentBases.length, expansionCollection:currentExp.length, totalCollection:current.length,
    sold:sold.length, soldBases:soldBases.length, soldExpansions:soldExp.length,
    wish:data.wishlist.length, wishExpansions:wishExp.length,
    invested:current.reduce((s,i)=>s+num(i.purchase_cost),0), sales:sold.reduce((s,i)=>s+num(i.sale_price),0),
    profit:sold.reduce((s,i)=>s+num(i.sale_price)-num(i.purchase_cost),0), bgg:data.items.filter(i=>i.bgg_id).length
  };
}
function bggUrl(i){return i?.bgg_id?`https://boardgamegeek.com/boardgame/${encodeURIComponent(i.bgg_id)}`:null}
function cover(i){const local=i?.cover_path||'',remote=i?.bgg_image_url||'';let src=HOSTED_MODE?(remote||(/^https?:/i.test(local)?local:'')):(local||remote);if(!src)return `<div class="cover"></div>`;const fallback=remote&&remote!==src?remote:'';return `<img class="cover ${i.bgg_cover?'bggCover':''}" src="${esc(src)}" data-fallback="${esc(fallback)}" loading="lazy" onerror="if(this.dataset.fallback){this.src=this.dataset.fallback;this.dataset.fallback=''}else{this.style.visibility='hidden'}">`}
function typeBadge(i){return isExpansion(i)?'<span class="typePill expansion">Expansão</span>':'<span class="typePill base">Jogo base</span>'}
function titleFor(v){return {dashboard:['Início','Visão geral da tua coleção'],collection:['Coleção','Jogos base e respetivas expansões'],purchases:['Compras','Histórico de aquisições'],sales:['Vendas','Histórico e resultados'],movements:['Movimentos','Cronologia de operações'],wishlist:['Wishlist','Jogos e expansões que tens debaixo de olho'],stats:['Estatísticas','Análise financeira, compras, vendas e evolução da coleção'],settings:['Definições','Backups, dados e integração BGG']}[v]}
function nav(v){view=v;$$('#nav button').forEach(b=>b.classList.toggle('active',b.dataset.view===v));const [t,s]=titleFor(v);$('#pageTitle').textContent=t;$('#pageSubtitle').textContent=s;$('#addItemBtn').style.display=['collection','purchases','dashboard'].includes(v)?'inline-block':'none';render()}
function render(){({dashboard,collection,purchases,sales,movements,wishlist,stats,settings}[view])()}
function card(label,val,sub=''){return `<div class="card metric"><small>${esc(label)}</small><strong>${val}</strong>${sub?`<div class="delta">${sub}</div>`:''}</div>`}
function group(items,key,amountKey=null){const m={};items.forEach(i=>{const raw=i[key];const k=(typeof raw==='string'&&raw.trim())?raw.trim():'Sem indicação';m[k]=(m[k]||0)+(amountKey?num(i[amountKey]):1)});return Object.entries(m).sort((a,b)=>b[1]-a[1])}
function bars(entries,formatter=x=>x){if(!entries.length)return '<div class="empty">Sem dados.</div>';const max=Math.max(...entries.map(x=>x[1]),1);return `<div class="barList">${entries.slice(0,8).map(([k,v])=>`<div class="barRow"><span title="${esc(k)}">${esc(k)}</span><div class="barTrack"><div class="barFill" style="width:${v/max*100}%"></div></div><b>${formatter(v)}</b></div>`).join('')}</div>`}
function statusPill(s){let c=s==='Vendido'?'red':s==='À venda'?'orange':'green';if(s==='Trocado')c='red';return `<span class="pill ${c}">${esc(s||'—')}</span>`}
function expansionStatePill(kind,status){
  if(kind==='wishlist') return '<span class="pill wish">Wishlist</span>';
  if(status==='Vendido') return '<span class="pill red">Vendida</span>';
  if(status==='Trocado') return '<span class="pill red">Trocada</span>';
  if(status==='À venda') return '<span class="pill orange">Tenho · À venda</span>';
  return '<span class="pill green">Tenho</span>';
}
function bggBadge(i){return i?.bgg_id?`<a class="bggLinked" href="${bggUrl(i)}" target="_blank" rel="noopener">BGG #${esc(i.bgg_id)}</a>`:`<span class="bggMissing">Sem BGG</span>`}
function itemLabel(i){const b=isExpansion(i)?baseGame(i.base_game_id):null;return `${i.title||''}${b?` · expansão de ${b.title}`:''}`}
function collectionSnapshot(i){
  const keys=['id','title','item_type','base_game_id','condition','players_1','players_2','players_3','players_4','players_5','players_6plus','mechanisms','language_dep','acquisition_type','deal_ref','purchase_platform','purchase_cost','purchase_country','purchase_date','comments','bgg_id','bgg_url','bgg_name','bgg_year','bgg_type','cover_path','bgg_cover'];
  const snap={};keys.forEach(k=>snap[k]=i[k]??null);snap.captured_at=new Date().toISOString();return snap;
}
function soldSnapshot(i){return i.sale_snapshot&&typeof i.sale_snapshot==='object'?i.sale_snapshot:i}
function sameSaleGroupCount(i){return i?.sale_group_id?data.items.filter(x=>x.status==='Vendido'&&x.sale_group_id===i.sale_group_id).length:1}
function soldFamilyRows(){
  const sold=data.items.filter(i=>i.status==='Vendido');
  const bases=sold.filter(isBase);
  const linkedExpansionIds=new Set();
  const groups=bases.map(b=>{
    const exps=sold.filter(x=>isExpansion(x)&&Number(x.base_game_id)===Number(b.id)).sort((a,c)=>String(c.sale_date||'').localeCompare(String(a.sale_date||''))||(a.title||'').localeCompare(c.title||'','pt'));
    exps.forEach(x=>linkedExpansionIds.add(x.id));
    const sortDate=[b,...exps].map(x=>x.sale_date||'').sort().pop()||'';
    return {base:b,expansions:exps,sortDate};
  });
  sold.filter(x=>isExpansion(x)&&!linkedExpansionIds.has(x.id)).forEach(x=>groups.push({base:null,expansions:[x],sortDate:x.sale_date||''}));
  return groups.sort((a,b)=>String(b.sortDate).localeCompare(String(a.sortDate)));
}

function dashboard(){
  const s=summary(), recent=[...data.movements].sort((a,b)=>String(b.movement_date||b.created_at).localeCompare(String(a.movement_date||a.created_at))).slice(0,7);
  const platforms=group(data.items.filter(isCurrent),'purchase_platform');
  $('#content').innerHTML=`
    <div class="cards sixCards">
      ${card('Jogos base',s.baseCollection)}
      ${card('Expansões',s.expansionCollection,`${s.totalCollection} itens no total`)}
      ${card('Investido',money(s.invested))}
      ${card('Itens vendidos',s.sold,`${s.soldBases} jogos · ${s.soldExpansions} expansões`)}
      ${card('Total de vendas',money(s.sales))}
      ${card('Resultado',`<span class="${s.profit>=0?'positive':'negative'}">${money(s.profit)}</span>`,`BGG associado: ${s.bgg}/${data.items.length}`)}
    </div>
    <div class="grid2">
      <div class="card"><h3 class="sectionTitle">Compras por plataforma</h3>${bars(platforms,v=>Math.round(v))}</div>
      <div class="card"><h3 class="sectionTitle">Movimentos recentes</h3><div class="recentList">${recent.map(m=>{const it=data.items.find(i=>i.id===m.item_id);return `<div class="recentItem"><div>${it?`<button class="itemTitleBtn openItemSheet" data-id="${it.id}">${esc(it.title)}</button>`:`<b>${esc(m.notes||'Movimento')}</b>`}<small>${esc(m.kind)} · ${date(m.movement_date)} · ${esc(m.platform||'—')}</small></div><span class="${String(m.kind).toLowerCase().includes('venda')?'positive':''}">${money(m.amount)}</span></div>`}).join('')||'<div class="empty">Sem movimentos.</div>'}</div></div>
    </div>`;
}

function linkedExpansionEntries(baseId){
  const items=data.items.filter(i=>isExpansion(i)&&Number(i.base_game_id)===Number(baseId)).map(i=>({kind:'item',id:i.id,title:i.title,status:i.status,bgg_id:i.bgg_id,bgg_year:i.bgg_year,cover_path:i.cover_path,bgg_image_url:i.bgg_image_url,bgg_cover:i.bgg_cover,purchase_cost:i.purchase_cost,item:i}));
  const wishes=data.wishlist.filter(w=>w.item_type==='expansion'&&Number(w.base_game_id)===Number(baseId)).map(w=>({kind:'wishlist',id:w.id,title:w.title,status:'Wishlist',bgg_id:w.bgg_id,bgg_year:w.bgg_year,cover_path:w.cover_path,bgg_image_url:w.bgg_image_url,bgg_cover:w.bgg_cover,wish:w}));
  return [...items,...wishes].sort((a,b)=>(a.title||'').localeCompare(b.title||'','pt'));
}
function collectionExpansionEntries(baseId){
  // A vista Coleção mostra apenas expansões atuais; vendidas/trocadas ficam no histórico.
  // Mantemos expansões da wishlist agrupadas no jogo base, como nas versões anteriores.
  return linkedExpansionEntries(baseId).filter(e=>e.kind==='wishlist'||(e.kind==='item'&&isCurrent(e.item)));
}

function collectionSortValue(){
  return localStorage.getItem(COLLECTION_SORT_STORAGE)||'title_asc';
}
function sortCollectionBases(rows,sortKey){
  const titleCmp=(a,b)=>(a.title||'').localeCompare(b.title||'','pt',{sensitivity:'base',numeric:true});
  const cmpText=(va,vb,dir=1)=>{va=String(va||'');vb=String(vb||'');if(!va&&!vb)return 0;if(!va)return 1;if(!vb)return -1;return va.localeCompare(vb)*dir};
  const cmpNum=(va,vb,dir=1)=>{const aMissing=va===null||va===undefined||va==='',bMissing=vb===null||vb===undefined||vb==='';if(aMissing&&bMissing)return 0;if(aMissing)return 1;if(bMissing)return -1;return (num(va)-num(vb))*dir};
  const createdVal=i=>i.created_at||i.purchase_date||'';
  return [...rows].sort((a,b)=>{
    let c=0;
    switch(sortKey){
      case 'title_desc': c=-titleCmp(a,b); break;
      case 'purchase_date_desc': c=cmpText(a.purchase_date,b.purchase_date,-1); break;
      case 'purchase_date_asc': c=cmpText(a.purchase_date,b.purchase_date,1); break;
      case 'purchase_cost_desc': c=cmpNum(a.purchase_cost,b.purchase_cost,-1); break;
      case 'purchase_cost_asc': c=cmpNum(a.purchase_cost,b.purchase_cost,1); break;
      case 'added_desc': c=cmpText(createdVal(a),createdVal(b),-1); break;
      case 'added_asc': c=cmpText(createdVal(a),createdVal(b),1); break;
      case 'bgg_year_desc': c=cmpNum(a.bgg_year,b.bgg_year,-1); break;
      case 'bgg_year_asc': c=cmpNum(a.bgg_year,b.bgg_year,1); break;
      case 'title_asc': default: c=titleCmp(a,b); break;
    }
    return c||titleCmp(a,b);
  });
}
function collection(){
  const currentBases=data.items.filter(i=>isBase(i)&&isCurrent(i));
  const currentAll=data.items.filter(isCurrent);
  const missing=currentAll.filter(i=>!i.bgg_id).length;
  const s=summary();
  const sortValue=collectionSortValue();
  $('#content').innerHTML=`<div class="toolbar"><input id="q" placeholder="Pesquisar jogo ou expansão…"><select id="statusFilter"><option value="">Todos os estados</option><option>Coleção</option><option>À venda</option></select><select id="platformFilter"><option value="">Todas as plataformas</option>${[...new Set(currentAll.map(i=>i.purchase_platform).filter(Boolean))].sort().map(x=>`<option>${esc(x)}</option>`).join('')}</select><select id="collectionSort" title="Ordenar coleção"><option value="title_asc">Título · A → Z</option><option value="title_desc">Título · Z → A</option><option value="purchase_date_desc">Aquisição · mais recente</option><option value="purchase_date_asc">Aquisição · mais antiga</option><option value="purchase_cost_desc">Custo · maior primeiro</option><option value="purchase_cost_asc">Custo · menor primeiro</option><option value="added_desc">Adicionado · mais recente</option><option value="added_asc">Adicionado · mais antigo</option><option value="bgg_year_desc">Ano BGG · mais recente</option><option value="bgg_year_asc">Ano BGG · mais antigo</option></select><button class="btn secondary" id="batchBgg">BGG automático (${missing})</button><span class="spacer"></span><b>${s.baseCollection} jogos · ${s.expansionCollection} expansões</b></div><div id="batchStatus"></div><div id="collectionTable"></div>`;
  $('#collectionSort').value=sortValue;
  const refresh=()=>{
    const q=$('#q').value.toLowerCase(),st=$('#statusFilter').value,pf=$('#platformFilter').value,sortKey=$('#collectionSort').value;
    localStorage.setItem(COLLECTION_SORT_STORAGE,sortKey);
    let rows=currentBases.filter(base=>{
      const exps=collectionExpansionEntries(base.id);
      const text=[base.title,...exps.map(e=>e.title)].join(' ').toLowerCase();
      const familyStatus=!st||base.status===st||exps.some(e=>e.kind==='item'&&e.item.status===st);
      const familyPlatform=!pf||base.purchase_platform===pf||exps.some(e=>e.kind==='item'&&e.item.purchase_platform===pf);
      return text.includes(q)&&familyStatus&&familyPlatform;
    });
    rows=sortCollectionBases(rows,sortKey);
    $('#collectionTable').innerHTML=familyTable(rows);
  };
  ['q','statusFilter','platformFilter','collectionSort'].forEach(id=>$('#'+id).addEventListener('input',refresh));
  $('#batchBgg').onclick=()=>startBatchBgg(currentAll.filter(i=>!i.bgg_id));
  refresh();
}

function familyTable(bases){
  if(!bases.length)return '<div class="tableWrap"><div class="empty">Nenhum registo encontrado.</div></div>';
  const body=[];
  bases.forEach(i=>{
    const exps=collectionExpansionEntries(i.id);
    body.push(`<tr class="baseRow"><td><div class="gameCell">${cover(i)}<div><button class="itemTitleBtn openItemSheet" data-id="${i.id}">${esc(i.title)}</button><div class="sub">${typeBadge(i)} ${esc(i.condition||'—')}${i.bgg_year?` · ${esc(i.bgg_year)}`:''}${exps.length?` · ${exps.length} expansão(ões)`:''}</div></div></div></td><td>${bggBadge(i)}</td><td>${statusPill(i.status)}</td><td>${playerText(i)}</td><td>${esc(i.language_dep||'—')}</td><td>${money(i.purchase_cost)}</td><td>${esc(i.purchase_platform||'—')}</td><td>${esc(i.purchase_country||'—')}</td><td><div class="actions"><button class="linkBtn manageExp" data-id="${i.id}">Expansões</button><button class="linkBtn editItem" data-id="${i.id}">Ficha</button><button class="linkBtn bggItem" data-id="${i.id}">${i.bgg_id?'Alterar BGG':'Associar BGG'}</button><button class="linkBtn sellItem" data-id="${i.id}">Vender</button><button class="linkBtn dangerLink removeItem" data-id="${i.id}">Remover</button></div></td></tr>`);
    exps.forEach(e=>{
      if(e.kind==='item'){
        const x=e.item;
        body.push(`<tr class="expansionRow"><td><div class="gameCell expansionCell"><div class="treeBranch">↳</div>${cover(x)}<div><button class="itemTitleBtn openItemSheet" data-id="${x.id}">${esc(x.title)}</button><div class="sub">${typeBadge(x)} ${esc(x.condition||'—')}${x.bgg_year?` · ${esc(x.bgg_year)}`:''}</div></div></div></td><td>${bggBadge(x)}</td><td>${expansionStatePill('item',x.status)}</td><td>${playerText(x)}</td><td>${esc(x.language_dep||'—')}</td><td>${money(x.purchase_cost)}</td><td>${esc(x.purchase_platform||'—')}</td><td>${esc(x.purchase_country||'—')}</td><td><div class="actions"><button class="linkBtn editItem" data-id="${x.id}">Ficha</button><button class="linkBtn bggItem" data-id="${x.id}">${x.bgg_id?'Alterar BGG':'Associar BGG'}</button>${isCurrent(x)?`<button class="linkBtn sellItem" data-id="${x.id}">Vender</button><button class="linkBtn dangerLink removeItem" data-id="${x.id}">Remover</button>`:''}</div></td></tr>`);
      } else {
        const w=e.wish;
        body.push(`<tr class="expansionRow wishlistRow"><td><div class="gameCell expansionCell"><div class="treeBranch">↳</div>${cover(w)}<div><b>${esc(w.title)}</b><div class="sub"><span class="typePill expansion">Expansão</span> ligada a ${esc(i.title)}</div></div></div></td><td>${bggBadge(w)}</td><td>${expansionStatePill('wishlist')}</td><td>—</td><td>—</td><td>—</td><td>—</td><td>—</td><td><div class="actions"><button class="linkBtn addPrice" data-id="${w.id}">+ preço</button><button class="linkBtn editWish" data-id="${w.id}">Editar</button><button class="linkBtn delWish" data-id="${w.id}">Apagar</button></div></td></tr>`);
      }
    });
  });
  return `<div class="tableWrap"><table><thead><tr><th>Jogo / expansão</th><th>BGG</th><th>Estado</th><th>Jogadores</th><th>Idioma</th><th>Compra</th><th>Plataforma</th><th>País</th><th></th></tr></thead><tbody>${body.join('')}</tbody></table></div>`;
}

function tableItems(rows,actions=false){
  return `<div class="tableWrap"><table><thead><tr><th>Item</th><th>Tipo</th><th>BGG</th><th>Estado</th><th>Jogadores</th><th>Idioma</th><th>Compra</th><th>Plataforma</th><th>País</th>${actions?'<th></th>':''}</tr></thead><tbody>${rows.map(i=>`<tr><td><div class="gameCell">${cover(i)}<div><b>${esc(i.title)}</b><div class="sub">${isExpansion(i)&&baseGame(i.base_game_id)?`Expansão de ${esc(baseGame(i.base_game_id).title)} · `:''}${esc(i.condition||'—')}${i.bgg_year?` · ${esc(i.bgg_year)}`:''}</div></div></div></td><td>${typeBadge(i)}</td><td>${bggBadge(i)}</td><td>${statusPill(i.status)}</td><td>${playerText(i)}</td><td>${esc(i.language_dep||'—')}</td><td>${money(i.purchase_cost)}</td><td>${esc(i.purchase_platform||'—')}</td><td>${esc(i.purchase_country||'—')}</td>${actions?`<td><div class="actions">${isBase(i)?`<button class="linkBtn manageExp" data-id="${i.id}">Expansões</button>`:''}<button class="linkBtn editItem" data-id="${i.id}">Ficha</button><button class="linkBtn bggItem" data-id="${i.id}">${i.bgg_id?'Alterar BGG':'Associar BGG'}</button>${isCurrent(i)?`<button class="linkBtn sellItem" data-id="${i.id}">Vender</button>`:''}</div></td>`:''}</tr>`).join('')}</tbody></table>${rows.length?'':'<div class="empty">Nenhum registo encontrado.</div>'}</div>`;
}

function purchases(){
  const getItems=()=>[...data.items].filter(i=>i.purchase_cost!==null||i.purchase_platform||i.acquisition_type).sort((a,b)=>String(b.purchase_date||'').localeCompare(String(a.purchase_date||'')));
  $('#content').innerHTML=`<div class="toolbar"><input id="q" placeholder="Pesquisar…"><span class="spacer"></span><b id="purchaseCount"></b></div><div id="purchaseTable"></div>`;
  const r=()=>{const items=getItems(),q=$('#q').value.toLowerCase(),x=items.filter(i=>itemLabel(i).toLowerCase().includes(q));$('#purchaseCount').textContent=`${items.length} aquisições`;$('#purchaseTable').innerHTML=`<div class="tableWrap"><table><thead><tr><th>Item</th><th>Tipo</th><th>BGG</th><th>Tipo aquisição</th><th>Data</th><th>Plataforma</th><th>País</th><th>Custo</th><th>Estado atual</th><th></th></tr></thead><tbody>${x.map(i=>`<tr><td><button class="itemTitleBtn openItemSheet" data-id="${i.id}">${esc(i.title)}</button>${isExpansion(i)&&baseGame(i.base_game_id)?`<div class="sub">Expansão de ${esc(baseGame(i.base_game_id).title)}</div>`:''}</td><td>${typeBadge(i)}</td><td>${bggBadge(i)}</td><td>${esc(i.acquisition_type||'Compra')}</td><td>${date(i.purchase_date)}</td><td>${esc(i.purchase_platform||'—')}</td><td>${esc(i.purchase_country||'—')}</td><td>${money(i.purchase_cost)}</td><td>${statusPill(i.status)}</td><td><div class="actions"><button class="linkBtn openItemSheet" data-id="${i.id}">Abrir ficha</button><button class="linkBtn editOperationDate" data-id="${i.id}" data-operation="purchase">Editar data</button></div></td></tr>`).join('')}</tbody></table></div>`};
  $('#q').addEventListener('input',r);r();
}

function sales(){
  const items=data.items.filter(i=>i.status==='Vendido'), profit=items.reduce((s,i)=>s+num(i.sale_price)-num(i.purchase_cost),0), groups=soldFamilyRows();
  const body=[];
  const row=(i,{nested=false}={})=>{
    const p=num(i.sale_price)-num(i.purchase_cost),snap=soldSnapshot(i),b=isExpansion(i)?baseGame(i.base_game_id):null,groupCount=sameSaleGroupCount(i);
    const familyNote=nested&&b?`Expansão de ${esc(b.title)}`:isExpansion(i)&&b?`Expansão de ${esc(b.title)}`:'';
    const groupNote=groupCount>1?`${familyNote?familyNote+' · ':''}Venda conjunta · ${groupCount} itens`:familyNote;
    body.push(`<tr class="${nested?'expansionRow saleExpansionRow':'saleBaseRow'}"><td><div class="gameCell ${nested?'expansionCell':''}">${nested?'<div class="treeBranch">↳</div>':''}${cover(snap)}<div><button class="itemTitleBtn openItemSheet" data-id="${i.id}">${esc(snap.title||i.title)}</button>${groupNote?`<div class="sub">${groupNote}</div>`:''}</div></div></td><td>${typeBadge(i)}</td><td>${bggBadge(snap)}</td><td>${date(i.sale_date)}</td><td>${money(snap.purchase_cost)}</td><td>${money(i.sale_price)}</td><td>${esc(i.sale_platform||'—')}</td><td>${esc(i.sale_country||'—')}</td><td class="${p>=0?'positive':'negative'}">${money(p)}</td><td><div class="actions"><button class="linkBtn openItemSheet" data-id="${i.id}">Abrir ficha</button><button class="linkBtn editOperationDate" data-id="${i.id}" data-operation="sale">Editar data</button></div></td></tr>`);
  };
  groups.forEach(g=>{if(g.base){row(g.base);g.expansions.forEach(x=>row(x,{nested:true}))}else g.expansions.forEach(x=>row(x))});
  $('#content').innerHTML=`<div class="cards">${card('Vendas',items.length)}${card('Receita',money(items.reduce((s,i)=>s+num(i.sale_price),0)))}${card('Custo dos vendidos',money(items.reduce((s,i)=>s+num(i.purchase_cost),0)))}${card('Resultado',`<span class="${profit>=0?'positive':'negative'}">${money(profit)}</span>`)}</div><div style="height:16px"></div><div class="tableWrap"><table><thead><tr><th>Item</th><th>Tipo</th><th>BGG</th><th>Data</th><th>Comprado por</th><th>Vendido por</th><th>Plataforma</th><th>País</th><th>Resultado</th><th></th></tr></thead><tbody>${body.join('')}</tbody></table>${items.length?'':'<div class="empty">Ainda não existem vendas.</div>'}</div>`;
}

function movements(){
  const rows=[...data.movements].sort((a,b)=>String(b.movement_date||b.created_at).localeCompare(String(a.movement_date||a.created_at)));
  $('#content').innerHTML=`<div class="toolbar"><input id="q" placeholder="Pesquisar jogo, expansão, plataforma…"><select id="kind"><option value="">Todos os tipos</option>${[...new Set(rows.map(x=>x.kind).filter(Boolean))].sort().map(x=>`<option>${esc(x)}</option>`).join('')}</select><span class="spacer"></span><b>${rows.length} movimentos</b></div><div id="moveTable"></div>`;
  const r=()=>{const q=$('#q').value.toLowerCase(),k=$('#kind').value,x=rows.filter(m=>{const it=data.items.find(i=>i.id===m.item_id);return(!k||m.kind===k)&&(`${it?.title||''} ${m.platform||''} ${m.country||''}`).toLowerCase().includes(q)});$('#moveTable').innerHTML=`<div class="tableWrap"><table><thead><tr><th>Data</th><th>Item</th><th>Tipo</th><th>Operação</th><th>Plataforma</th><th>País</th><th>Valor</th></tr></thead><tbody>${x.map(m=>{const it=data.items.find(i=>i.id===m.item_id);return `<tr><td>${date(m.movement_date)}</td><td>${it?`<button class="itemTitleBtn openItemSheet" data-id="${it.id}">${esc(it.title)}</button>`:'—'}</td><td>${it?typeBadge(it):'—'}</td><td>${esc(m.kind||'—')}</td><td>${esc(m.platform||'—')}</td><td>${esc(m.country||'—')}</td><td>${money(m.amount)}</td></tr>`}).join('')}</tbody></table></div>`};
  $('#q').addEventListener('input',r);$('#kind').addEventListener('change',r);r();
}

function wishlist(){
  cleanWishlistRanking();
  const expCount=data.wishlist.filter(w=>w.item_type==='expansion').length;
  const rankable=rankableWishes(),ranked=rankable.filter(w=>wishRankIndex(w.id)!==null).length;
  const comparisons=(data.wishlist_comparisons||[]).length;
  const completed=rankable.length>0&&ranked===rankable.length;
  const missingBgg=data.wishlist.filter(w=>!w.bgg_id).length;
  const linkedBgg=data.wishlist.length-missingBgg;
  $('#content').innerHTML=`
    <div class="wishlistRankIntro card">
      <div><h3>Ranking global por escolhas</h3><p>O ranking é construído pelas tuas respostas a comparações “this or that”. As comparações podem ser entre quaisquer jogos da Wishlist, independentemente da prioridade. A prioridade fica apenas como referência. A inserção binária elimina cerca de metade das posições a cada escolha; podes parar e retomar quando quiseres.</p></div>
      <div class="wishlistRankStats"><div><small>Classificados</small><b>${ranked}/${rankable.length}</b></div><div><small>Comparações</small><b>${comparisons}</b></div><div><small>BGG associado</small><b>${linkedBgg}/${data.wishlist.length}</b></div><div><small>Sem prioridade</small><b>${data.wishlist.filter(w=>wishPriority(w)===null).length}</b></div></div>
      <div class="wishlistRankButtons"><button class="btn primary" id="buildWishRank">${completed?'Ranking concluído':'▶ '+(ranked?'Continuar ranking':'Construir ranking')}</button>${ranked?'<button class="btn secondary" id="showRankOnly">Ver ranking</button>':''}${(ranked||comparisons)?'<button class="btn danger" id="resetWishRank">Reavaliar toda a Wishlist</button>':''}</div>
    </div>
    <div class="toolbar"><input id="q" placeholder="Pesquisar wishlist…"><select id="wishSort"><option value="ranking">Ranking</option><option value="priority">Prioridade</option><option value="az">A → Z</option></select><button class="btn primary" id="addWishBtn">+ Adicionar jogo</button><button class="btn secondary" id="batchWishBgg">BGG automático (${missingBgg})</button><span class="spacer"></span><b>${data.wishlist.length} itens · ${expCount} expansões</b></div><div id="wishBggBatchStatus"></div><div id="wishTable"></div>`;
  const r=()=>{
    const q=$('#q').value.toLowerCase(),sort=$('#wishSort').value;
    let rows=[...data.wishlist].filter(w=>{const b=baseGame(w.base_game_id);return `${w.title||''} ${w.bgg_name||''} ${b?.title||''}`.toLowerCase().includes(q)});
    const rankMap=new Map(data.wishlist_ranking.map((id,n)=>[Number(id),n]));
    if(sort==='ranking')rows.sort((a,b)=>{const ra=rankMap.has(Number(a.id))?rankMap.get(Number(a.id)):999999,rb=rankMap.has(Number(b.id))?rankMap.get(Number(b.id)):999999;return ra-rb||(num(a.priority)||99)-(num(b.priority)||99)||(a.title||'').localeCompare(b.title||'','pt')});
    else if(sort==='priority')rows.sort((a,b)=>(num(a.priority)||99)-(num(b.priority)||99)||(a.title||'').localeCompare(b.title||'','pt'));
    else rows.sort((a,b)=>(a.title||'').localeCompare(b.title||'','pt'));
    $('#wishTable').innerHTML=`<div class="tableWrap"><table><thead><tr><th>Rank</th><th>Item</th><th>Tipo</th><th>BGG</th><th>Jogadores</th><th>Prioridade</th><th>Último</th><th>Mínimo</th><th>Média</th><th>Máximo</th><th>Observações</th><th></th></tr></thead><tbody>${rows.map(w=>{const ps=data.wishlist_prices.filter(p=>p.wishlist_id===w.id).sort((a,b)=>String(a.observed_date||'').localeCompare(String(b.observed_date||''))),vals=ps.map(p=>num(p.price)),last=ps.length?ps[ps.length-1].price:null,min=vals.length?Math.min(...vals):null,max=vals.length?Math.max(...vals):null,avg=vals.length?vals.reduce((a,b)=>a+b,0)/vals.length:null;const b=baseGame(w.base_game_id),rank=wishRankIndex(w.id);return `<tr class="${rank!==null?'rankedWishRow':'unrankedWishRow'}"><td><b class="wishRankNumber">${rank!==null?'#'+(rank+1):'<span class="tiny">Por classificar</span>'}</b></td><td><div class="gameCell">${cover(w)}<div><b>${esc(w.title)}</b>${w.bgg_name&&w.bgg_name!==w.title?`<div class="sub">${esc(w.bgg_name)}${w.bgg_year?' · '+esc(w.bgg_year):''}</div>`:w.bgg_year?`<div class="sub">${esc(w.bgg_year)}</div>`:''}${w.item_type==='expansion'&&b?`<div class="sub">Expansão de ${esc(b.title)}</div>`:''}</div></div></td><td>${w.item_type==='expansion'?'<span class="typePill expansion">Expansão</span>':'<span class="typePill base">Jogo base</span>'}</td><td>${bggBadge(w)}</td><td>${playerText(w)}</td><td>${w.priority??'—'}</td><td>${money(last)}</td><td>${money(min)}</td><td>${money(avg)}</td><td>${money(max)}</td><td>${esc(w.notes||'—')}</td><td><div class="actions"><button class="linkBtn wishBgg" data-id="${w.id}">${w.bgg_id?'Alterar BGG':'Associar BGG'}</button><button class="linkBtn addPrice" data-id="${w.id}">+ preço</button><button class="linkBtn editWish" data-id="${w.id}">Editar</button><button class="linkBtn ${rank!==null?'reRankWish':'rankWish'}" data-id="${w.id}">${rank!==null?'Reavaliar':'Classificar agora'}</button><button class="linkBtn manualRankWish" data-id="${w.id}">Mover manualmente</button><button class="linkBtn delWish" data-id="${w.id}">Apagar</button></div></td></tr>`}).join('')}</tbody></table></div>`;
  };
  $('#q').addEventListener('input',r);$('#wishSort').addEventListener('change',r);$('#addWishBtn').onclick=()=>openWish();
  $('#buildWishRank').onclick=()=>continueWishlistRanking();
  $('#batchWishBgg').onclick=()=>startBatchBggWishlist(data.wishlist.filter(w=>!w.bgg_id));
  if($('#showRankOnly'))$('#showRankOnly').onclick=()=>{$('#wishSort').value='ranking';r()};
  if($('#resetWishRank'))$('#resetWishRank').onclick=()=>resetEntireWishlistRanking();
  r();
}

function resetEntireWishlistRanking(){
  const ranked=(data.wishlist_ranking||[]).length,comparisons=(data.wishlist_comparisons||[]).length;
  if(!ranked&&!comparisons){alert('Ainda não existe ranking nem histórico de comparações para reavaliar.');return}
  const first=confirm(`REAVALIAR TODA A WISHLIST

Isto vai apagar a ordem atual do ranking e ${comparisons} comparação(ões) guardada(s).

NÃO serão apagados jogos, prioridades, preços, capas, BGG IDs ou notas.

Queres continuar?`);
  if(!first)return;
  const second=confirm(`Segunda confirmação:

O ranking atual será reiniciado do zero e terás de voltar a posicionar os jogos através do “This or That”.

Esta ação será gravada no ficheiro sincronizado do OneDrive. Continuar?`);
  if(!second)return;
  const code=String(Math.floor(100000+Math.random()*900000));
  const typed=prompt(`Confirmação final

Para autorizar a reavaliação total, escreve exatamente este código:

${code}

(Cancelar fecha sem alterar nada.)`);
  if(typed===null)return;
  if(String(typed).trim()!==code){alert('Código incorreto. O ranking não foi alterado.');return}
  data.wishlist_ranking=[];
  data.wishlist_comparisons=[];
  data.wishlist_rank_session=null;
  save();
  if(view==='wishlist')wishlist();else render();
  alert('Ranking da Wishlist reiniciado. Os itens, prioridades, preços e dados BGG foram mantidos. Podes começar novamente em “Construir ranking”.');
}

function nextUnrankedWish(){
  cleanWishlistRanking();
  const ranked=new Set(data.wishlist_ranking.map(Number));
  return rankableWishes().filter(w=>!ranked.has(Number(w.id))).sort((a,b)=>(a.title||'').localeCompare(b.title||'','pt'))[0]||null;
}
function continueWishlistRanking(){
  if(data.wishlist_rank_session){showWishRankComparison();return}
  let w=nextUnrankedWish();
  if(!w){alert(rankableWishes().length?'O ranking global está completo. Podes reavaliar ou mover manualmente qualquer jogo.':'Ainda não há jogos na Wishlist para classificar.');return}
  startWishPositioning(w.id,'build');
}
function startWishPositioning(id,source='single'){
  const w=wishById(id);if(!w){alert('Item da Wishlist não encontrado.');return}
  removeWishFromRanking(id);cleanWishlistRanking();
  const candidates=relevantRankCandidates(w);
  if(!candidates.length){
    data.wishlist_ranking.splice(fallbackRankInsertIndex(w),0,Number(w.id));
    data.wishlist_rank_session=null;save();if(view==='wishlist')wishlist();
    if(source==='build')setTimeout(continueWishlistRanking,0);
    else alert(`“${w.title}” foi colocado no ranking. Ainda não havia outros jogos classificados para comparar.`);
    return;
  }
  data.wishlist_rank_session={item_id:Number(w.id),candidate_ids:candidates.map(Number),low:0,high:candidates.length,source,started_at:new Date().toISOString()};
  save();showWishRankComparison();
}
function currentWishRankOpponent(session){
  const ids=(session.candidate_ids||[]).filter(id=>data.wishlist_ranking.includes(Number(id))&&wishById(id));session.candidate_ids=ids;
  if(session.low<0)session.low=0;if(session.high>ids.length)session.high=ids.length;
  if(session.low>=session.high)return null;
  const mid=Math.floor((session.low+session.high)/2);return {mid,id:Number(ids[mid]),wish:wishById(ids[mid])};
}
function showWishRankComparison(){
  const s=data.wishlist_rank_session;if(!s){continueWishlistRanking();return}
  const w=wishById(s.item_id);if(!w){data.wishlist_rank_session=null;save();return}
  const opp=currentWishRankOpponent(s);if(!opp){finalizeWishPositioning();return}
  $('#rankDialogTitle').textContent='Qual queres mais?';
  $('#rankDialogSubtitle').textContent=`A posicionar “${w.title}” no ranking global · prioridade ${w.priority??'—'} (apenas referência)`;
  $('#rankLeft').innerHTML=rankChoiceHtml(w,'Este');$('#rankRight').innerHTML=rankChoiceHtml(opp.wish,'Este');
  $('#rankLeft').dataset.id=w.id;$('#rankRight').dataset.id=opp.wish.id;$('#rankDialog').dataset.mid=opp.mid;
  const remaining=Math.max(1,Math.ceil(Math.log2(Math.max(1,s.high-s.low))));
  $('#rankProgress').textContent=`Aproximadamente ${remaining} escolha(s) para posicionar este jogo · ${data.wishlist_ranking.length}/${rankableWishes().length} já classificados`;
  $('#rankDialog').showModal();
}
function rankChoiceHtml(w,label){
  const b=w.item_type==='expansion'?baseGame(w.base_game_id):null;
  return `<div class="rankChoiceCover">${cover(w)}</div><div class="rankChoiceText"><span class="typePill ${w.item_type==='expansion'?'expansion':'base'}">${w.item_type==='expansion'?'Expansão':'Jogo base'}</span><h3>${esc(w.title)}</h3>${b?`<p>Expansão de ${esc(b.title)}</p>`:''}${w.bgg_year?`<p>${esc(w.bgg_year)}${w.bgg_id?' · BGG #'+esc(w.bgg_id):''}</p>`:''}<div>Jogadores <b>${playerText(w)}</b></div><div>Prioridade <b>${w.priority??'—'}</b> <span class="tiny">(referência)</span>${wishRankIndex(w.id)!==null?` · atual ${wishRankLabel(w.id)}`:''}</div></div><button class="btn primary chooseRankItem" data-id="${w.id}">Prefiro ${esc(label.toLowerCase())}</button>`;
}
function answerWishRank(choice){
  const s=data.wishlist_rank_session;if(!s)return;const w=wishById(s.item_id),opp=currentWishRankOpponent(s);if(!w||!opp)return;
  if(choice==='new'){recordWishComparison(w.id,opp.wish.id,'left',w.id);s.high=opp.mid}
  else if(choice==='existing'){recordWishComparison(w.id,opp.wish.id,'right',opp.wish.id);s.low=opp.mid+1}
  else {recordWishComparison(w.id,opp.wish.id,'tie',null);s.force_after_id=opp.wish.id;s.low=s.high;}
  save();
  if(s.low>=s.high||s.force_after_id){finalizeWishPositioning();return}
  showWishRankComparison();
}
function finalizeWishPositioning(){
  const s=data.wishlist_rank_session;if(!s)return;const w=wishById(s.item_id);if(!w){data.wishlist_rank_session=null;save();return}
  cleanWishlistRanking();removeWishFromRanking(w.id);
  const ids=(s.candidate_ids||[]).map(Number).filter(id=>data.wishlist_ranking.includes(id));
  let idx=fallbackRankInsertIndex(w);
  if(s.force_after_id&&data.wishlist_ranking.includes(Number(s.force_after_id)))idx=data.wishlist_ranking.indexOf(Number(s.force_after_id))+1;
  else if(ids.length){
    if(s.low<=0)idx=data.wishlist_ranking.indexOf(ids[0]);
    else if(s.low>=ids.length)idx=data.wishlist_ranking.indexOf(ids[ids.length-1])+1;
    else idx=data.wishlist_ranking.indexOf(ids[s.low]);
    if(idx<0)idx=fallbackRankInsertIndex(w);
  }
  data.wishlist_ranking.splice(Math.max(0,Math.min(idx,data.wishlist_ranking.length)),0,Number(w.id));
  const source=s.source;data.wishlist_rank_session=null;save();if($('#rankDialog').open)$('#rankDialog').close();if(view==='wishlist')wishlist();
  if(source==='build')setTimeout(continueWishlistRanking,80);
}
function stopWishRanking(){if($('#rankDialog').open)$('#rankDialog').close();if(view==='wishlist')wishlist()}
function openManualWishRank(id){
  cleanWishlistRanking();const w=wishById(id);if(!w)return;manualRankWishId=Number(id);const current=wishRankIndex(id);
  $('#manualRankTitle').textContent=`Mover “${w.title}”`;
  $('#manualRankSubtitle').textContent=current===null?'Ainda não tem posição no ranking.':`Posição atual: #${current+1}`;
  const f=$('#manualRankForm');f.elements.rank_position.min=1;f.elements.rank_position.max=Math.max(1,data.wishlist_ranking.length+(current===null?1:0));f.elements.rank_position.value=current===null?Math.max(1,data.wishlist_ranking.length+1):current+1;
  $('#manualRankDialog').showModal();
}
function saveManualWishRank(){
  const w=wishById(manualRankWishId);if(!w)return;const f=$('#manualRankForm'),raw=Number(f.elements.rank_position.value);if(!Number.isFinite(raw)||raw<1){alert('Indica uma posição válida.');return}
  removeWishFromRanking(w.id);data.wishlist_rank_session=null;const pos=Math.max(1,Math.min(Math.round(raw),data.wishlist_ranking.length+1));data.wishlist_ranking.splice(pos-1,0,Number(w.id));
  data.wishlist_comparisons.push({id:nextId(data.wishlist_comparisons),left_id:Number(w.id),right_id:Number(w.id),result:'manual',winner_id:Number(w.id),manual_position:pos,created_at:new Date().toISOString()});
  save();$('#manualRankDialog').close();if(view==='wishlist')wishlist();
}

function stats(){
  const monthNames=['Jan','Fev','Mar','Abr','Mai','Jun','Jul','Ago','Set','Out','Nov','Dez'];
  const years=[...new Set(data.items.flatMap(i=>[String(i.purchase_date||'').slice(0,4),String(i.sale_date||'').slice(0,4)]).filter(y=>/^\d{4}$/.test(y)))].sort((a,b)=>b.localeCompare(a));
  const platforms=[...new Set(data.items.flatMap(i=>[i.purchase_platform,i.sale_platform]).filter(Boolean).map(x=>String(x).trim()).filter(Boolean))].sort((a,b)=>a.localeCompare(b,'pt'));
  const countries=[...new Set(data.items.flatMap(i=>[i.purchase_country,i.sale_country]).filter(Boolean).map(x=>String(x).trim()).filter(Boolean))].sort((a,b)=>a.localeCompare(b,'pt'));
  let saved={period:'all',from:'',to:'',type:'all',platform:'',country:''};
  try{saved={...saved,...JSON.parse(localStorage.getItem('gestao_colecao_bg_stats_filters')||'{}')}}catch(e){}
  if(saved.period.startsWith('year:')&&!years.includes(saved.period.slice(5)))saved.period='all';
  const periodOptions=['<option value="all">Todo o histórico</option>',...years.map(y=>`<option value="year:${y}">${y}</option>`),'<option value="custom">Personalizado</option>'].join('');
  $('#content').innerHTML=`
    <div class="statsFilters card">
      <label>Período<select id="statsPeriod">${periodOptions}</select></label>
      <label class="statsCustomDate" id="statsFromWrap">De<input type="date" id="statsFrom"></label>
      <label class="statsCustomDate" id="statsToWrap">Até<input type="date" id="statsTo"></label>
      <label>Tipo<select id="statsType"><option value="all">Jogos + expansões</option><option value="base">Só jogos base</option><option value="expansion">Só expansões</option></select></label>
      <label>Plataforma<select id="statsPlatform"><option value="">Todas</option>${platforms.map(x=>`<option value="${esc(x)}">${esc(x)}</option>`).join('')}</select></label>
      <label>País<select id="statsCountry"><option value="">Todos</option>${countries.map(x=>`<option value="${esc(x)}">${esc(x)}</option>`).join('')}</select></label>
      <button class="btn secondary statsReset" id="statsReset">Limpar filtros</button>
    </div>
    <div class="statsFilterNote">O período é aplicado à data da operação: data de compra nas compras e data de venda nas vendas. Na coleção atual, filtra pela data de aquisição.</div>
    <div id="statsBody"></div>`;
  $('#statsPeriod').value=saved.period;$('#statsFrom').value=saved.from||'';$('#statsTo').value=saved.to||'';$('#statsType').value=saved.type||'all';$('#statsPlatform').value=saved.platform||'';$('#statsCountry').value=saved.country||'';

  const median=arr=>{const x=arr.filter(Number.isFinite).sort((a,b)=>a-b);if(!x.length)return 0;const m=Math.floor(x.length/2);return x.length%2?x[m]:(x[m-1]+x[m])/2};
  const avg=arr=>arr.length?arr.reduce((a,b)=>a+b,0)/arr.length:0;
  const pct=(a,b)=>b?`${(a/b*100).toFixed(1).replace('.',',')}%`:'—';
  const change=(now,prev)=>{if(!prev)return now?'novo':'0,0%';const v=(now-prev)/Math.abs(prev)*100;return `${v>=0?'+':''}${v.toFixed(1).replace('.',',')}%`};
  const daysBetween=(a,b)=>{if(!a||!b)return null;const da=new Date(String(a).slice(0,10)+'T00:00:00'),db=new Date(String(b).slice(0,10)+'T00:00:00');const d=Math.round((db-da)/86400000);return Number.isFinite(d)&&d>=0?d:null};
  const daysText=d=>{if(d===null||d===undefined||!Number.isFinite(d))return '—';if(d<60)return `${Math.round(d)} dias`;if(d<730)return `${(d/30.4375).toFixed(1).replace('.',',')} meses`;return `${(d/365.25).toFixed(1).replace('.',',')} anos`};
  const fmtInt=v=>new Intl.NumberFormat('pt-PT',{maximumFractionDigits:0}).format(v);
  const typeOk=(i,type)=>type==='all'||(type==='base'&&isBase(i))||(type==='expansion'&&isExpansion(i));
  const strEq=(a,b)=>!b||String(a||'').trim()===b;
  const hasPurchase=i=>i.purchase_date||i.purchase_platform||i.purchase_country||i.purchase_cost!==null&&i.purchase_cost!==undefined||i.acquisition_type;
  const dateInPeriod=(d,f)=>{if(!d)return f.period==='all';const x=String(d).slice(0,10);if(f.period==='all')return true;if(f.period.startsWith('year:'))return x.startsWith(f.period.slice(5)+'-');if(f.period==='custom'){if(f.from&&x<f.from)return false;if(f.to&&x>f.to)return false;return true}return true};
  const purchaseDims=(i,f)=>typeOk(i,f.type)&&strEq(i.purchase_platform,f.platform)&&strEq(i.purchase_country,f.country);
  const saleDims=(i,f)=>typeOk(i,f.type)&&strEq(i.sale_platform,f.platform)&&strEq(i.sale_country,f.country);
  const generalDims=(i,f)=>typeOk(i,f.type)&&(!f.platform||strEq(i.purchase_platform,f.platform)||strEq(i.sale_platform,f.platform))&&(!f.country||strEq(i.purchase_country,f.country)||strEq(i.sale_country,f.country));

  const dualChart=(labels,a,b,aName,bName,formatter=money)=>{
    if(!labels.length)return '<div class="empty">Sem datas suficientes para construir o gráfico.</div>';
    const max=Math.max(1,...a,...b);
    return `<div class="dualChart">${labels.map((l,idx)=>{const av=a[idx]||0,bv=b[idx]||0;return `<div class="dualCol"><div class="dualBars"><div class="dualBar purchaseBar" style="height:${Math.max(av?3:0,av/max*150)}px" title="${esc(aName)}: ${esc(formatter(av))}"></div><div class="dualBar saleBar" style="height:${Math.max(bv?3:0,bv/max*150)}px" title="${esc(bName)}: ${esc(formatter(bv))}"></div></div><small>${esc(l)}</small></div>`}).join('')}</div><div class="statsLegend"><span><i class="legendPurchase"></i>${esc(aName)}</span><span><i class="legendSale"></i>${esc(bName)}</span></div>`;
  };
  const singleChart=(labels,vals,formatter=v=>fmtInt(v))=>{
    if(!labels.length)return '<div class="empty">Sem datas suficientes para construir o gráfico.</div>';
    const max=Math.max(1,...vals);
    return `<div class="singleChart">${labels.map((l,idx)=>`<div class="singleCol"><div class="singleBar" style="height:${Math.max(vals[idx]?3:0,(vals[idx]||0)/max*150)}px" title="${esc(formatter(vals[idx]||0))}"></div><small>${esc(l)}</small></div>`).join('')}</div>`;
  };
  const tableItem=(i,label=null)=>`<button class="itemTitleBtn openItemSheet" data-id="${i.id}">${esc(label||i.title)}</button>${isExpansion(i)&&baseGame(i.base_game_id)?`<div class="sub">Expansão de ${esc(baseGame(i.base_game_id).title)}</div>`:''}`;

  const renderBody=()=>{
    const f={period:$('#statsPeriod').value,from:$('#statsFrom').value,to:$('#statsTo').value,type:$('#statsType').value,platform:$('#statsPlatform').value,country:$('#statsCountry').value};
    localStorage.setItem('gestao_colecao_bg_stats_filters',JSON.stringify(f));
    const custom=f.period==='custom';$('#statsFromWrap').style.display=custom?'grid':'none';$('#statsToWrap').style.display=custom?'grid':'none';
    const purchases=data.items.filter(i=>hasPurchase(i)&&purchaseDims(i,f)&&dateInPeriod(i.purchase_date,f));
    const sold=data.items.filter(i=>i.status==='Vendido'&&saleDims(i,f)&&dateInPeriod(i.sale_date,f));
    const current=data.items.filter(i=>isCurrent(i)&&purchaseDims(i,f)&&dateInPeriod(i.purchase_date,f));
    const spend=purchases.reduce((s,i)=>s+num(i.purchase_cost),0),revenue=sold.reduce((s,i)=>s+num(i.sale_price),0),soldCost=sold.reduce((s,i)=>s+num(i.purchase_cost),0),profit=revenue-soldCost,netOutflow=spend-revenue,currentCost=current.reduce((s,i)=>s+num(i.purchase_cost),0);
    const pPrices=purchases.filter(i=>i.purchase_cost!==null&&i.purchase_cost!==undefined).map(i=>num(i.purchase_cost)),sPrices=sold.filter(i=>i.sale_price!==null&&i.sale_price!==undefined).map(i=>num(i.sale_price));
    const profitRows=sold.map(i=>({i,profit:num(i.sale_price)-num(i.purchase_cost),roi:num(i.purchase_cost)?(num(i.sale_price)-num(i.purchase_cost))/num(i.purchase_cost)*100:null,days:daysBetween(i.purchase_date,i.sale_date)}));
    const positives=profitRows.filter(x=>x.profit>0).length,evens=profitRows.filter(x=>Math.abs(x.profit)<0.005).length,negatives=profitRows.filter(x=>x.profit<0).length,hold=profitRows.map(x=>x.days).filter(x=>x!==null);
    const roiRows=profitRows.filter(x=>x.roi!==null),overallRoi=soldCost?profit/soldCost*100:0,margin=revenue?profit/revenue*100:0;
    const currentLabel=f.period==='all'?'Itens atuais':'Itens atuais adquiridos no período';

    const allDated=[...purchases.map(i=>i.purchase_date),...sold.map(i=>i.sale_date)].filter(Boolean).map(x=>String(x).slice(0,10)).sort();
    let granularity='year',rangeStart=null,rangeEnd=null,keys=[];
    if(f.period.startsWith('year:')){const y=Number(f.period.slice(5));granularity='month';rangeStart=`${y}-01-01`;rangeEnd=`${y}-12-31`;keys=Array.from({length:12},(_,m)=>`${y}-${String(m+1).padStart(2,'0')}`)}
    else if(f.period==='custom'&&(f.from||f.to)){
      rangeStart=f.from||allDated[0]||today();rangeEnd=f.to||allDated[allDated.length-1]||rangeStart;
      const ds=new Date(rangeStart+'T00:00:00'),de=new Date(rangeEnd+'T00:00:00'),span=(de-ds)/86400000;
      granularity=span<=740?'month':'year';
      if(granularity==='month'){let y=ds.getFullYear(),m=ds.getMonth(),ey=de.getFullYear(),em=de.getMonth();while(y<ey||(y===ey&&m<=em)){keys.push(`${y}-${String(m+1).padStart(2,'0')}`);m++;if(m>11){m=0;y++}}}
      else{for(let y=ds.getFullYear();y<=de.getFullYear();y++)keys.push(String(y))}
    }else{
      const ys=[...new Set(allDated.map(d=>d.slice(0,4)))].sort();if(ys.length){for(let y=Number(ys[0]);y<=Number(ys[ys.length-1]);y++)keys.push(String(y));rangeStart=`${keys[0]}-01-01`;rangeEnd=`${keys[keys.length-1]}-12-31`}
    }
    const bucket=d=>granularity==='month'?String(d||'').slice(0,7):String(d||'').slice(0,4);
    const labels=keys.map(k=>granularity==='month'?`${monthNames[Number(k.slice(5,7))-1]} ${k.slice(2,4)}`:k);
    const pMap={},sMap={};purchases.forEach(i=>{if(i.purchase_date){const k=bucket(i.purchase_date);pMap[k]=(pMap[k]||0)+num(i.purchase_cost)}});sold.forEach(i=>{if(i.sale_date){const k=bucket(i.sale_date);sMap[k]=(sMap[k]||0)+num(i.sale_price)}});
    const pSeries=keys.map(k=>pMap[k]||0),sSeries=keys.map(k=>sMap[k]||0);

    const evolutionItems=data.items.filter(i=>generalDims(i,f));
    let active=0;
    if(rangeStart){evolutionItems.forEach(i=>{const p=String(i.purchase_date||'').slice(0,10),sd=String(i.sale_date||'').slice(0,10);if(p&&p<rangeStart&&(!sd||sd>=rangeStart))active++})}
    const evSeries=[];keys.forEach(k=>{const purchasesK=evolutionItems.filter(i=>i.purchase_date&&bucket(i.purchase_date)===k).length;const salesK=evolutionItems.filter(i=>i.status==='Vendido'&&i.sale_date&&bucket(i.sale_date)===k).length;active+=purchasesK-salesK;evSeries.push(Math.max(0,active))});

    const pPlatforms=group(purchases,'purchase_platform','purchase_cost'),sPlatforms=group(sold,'sale_platform','sale_price'),pCountries=group(purchases,'purchase_country'),playerEntries=[['1 jogador',current.filter(i=>String(i.players_1||'').toLowerCase()==='sim').length],['2 jogadores',current.filter(i=>String(i.players_2||'').toLowerCase()==='sim').length],['3 jogadores',current.filter(i=>String(i.players_3||'').toLowerCase()==='sim').length],['4 jogadores',current.filter(i=>String(i.players_4||'').toLowerCase()==='sim').length],['5 jogadores',current.filter(i=>String(i.players_5||'').toLowerCase()==='sim').length],['6+ jogadores',current.filter(i=>String(i.players_6plus||'').toLowerCase()==='sim').length]].sort((a,b)=>b[1]-a[1]);
    const best=[...profitRows].sort((a,b)=>b.profit-a.profit).slice(0,6),worst=[...profitRows].sort((a,b)=>a.profit-b.profit).slice(0,6),invested=[...current].sort((a,b)=>num(b.purchase_cost)-num(a.purchase_cost)).slice(0,8);
    const withHold=[...profitRows].filter(x=>x.days!==null).sort((a,b)=>a.days-b.days),fastest=withHold[0],longest=withHold[withHold.length-1];

    const latest=years.length?Number(years[0]):null,prev=latest?latest-1:null;
    const annual=(y)=>{const pf={...f,period:`year:${y}`};const ps=data.items.filter(i=>hasPurchase(i)&&purchaseDims(i,pf)&&dateInPeriod(i.purchase_date,pf)),ss=data.items.filter(i=>i.status==='Vendido'&&saleDims(i,pf)&&dateInPeriod(i.sale_date,pf));return {pcount:ps.length,spend:ps.reduce((a,i)=>a+num(i.purchase_cost),0),scount:ss.length,revenue:ss.reduce((a,i)=>a+num(i.sale_price),0),profit:ss.reduce((a,i)=>a+num(i.sale_price)-num(i.purchase_cost),0)}};
    const annualNow=latest?annual(latest):null,annualPrev=prev?annual(prev):null;

    $('#statsBody').innerHTML=`
      <div class="statsSectionHead"><div><h2>Visão financeira</h2><p>Quanto entrou, saiu e ficou investido.</p></div></div>
      <div class="cards statsCards">${card(currentLabel,current.length,`${money(currentCost)} ao custo`)}${card('Compras no período',purchases.length,`${money(spend)} gastos`)}${card('Vendas no período',sold.length,`${money(revenue)} recebidos`)}${card('Saldo líquido do hobby',money(netOutflow),netOutflow>=0?'saída líquida de dinheiro':'recebeste mais do que gastaste')}${card('Resultado realizado',`<span class="${profit>=0?'positive':'negative'}">${money(profit)}</span>`,`ROI ${overallRoi.toFixed(1).replace('.',',')}%`)}${card('Custo ainda na coleção',money(currentCost),`${current.filter(isBase).length} jogos · ${current.filter(isExpansion).length} expansões`)}</div>

      <div class="grid2 statsGrid"><div class="card"><h3 class="sectionTitle">Compras vs. vendas</h3>${dualChart(labels,pSeries,sSeries,'Compras','Vendas',money)}</div><div class="card"><h3 class="sectionTitle">Evolução do nº de itens</h3>${singleChart(labels,evSeries,v=>`${fmtInt(v)} itens`)}<p class="statsFootnote">Evolução estimada a partir das datas de compra e venda disponíveis.</p></div></div>

      <div class="statsSectionHead"><div><h2>Compras e vendas</h2><p>Preços, rentabilidade e qualidade das vendas.</p></div></div>
      <div class="cards statsCards compactStats">${card('Compra média',money(avg(pPrices)),`mediana ${money(median(pPrices))}`)}${card('Venda média',money(avg(sPrices)),`mediana ${money(median(sPrices))}`)}${card('Margem sobre vendas',`${margin.toFixed(1).replace('.',',')}%`,`ROI sobre custo ${overallRoi.toFixed(1).replace('.',',')}%`)}${card('Vendas com lucro',pct(positives,sold.length),`${positives} lucro · ${evens} empate · ${negatives} prejuízo`)}${card('Resultado médio/venda',money(sold.length?profit/sold.length:0),`mediana ${money(median(profitRows.map(x=>x.profit)))}`)}${card('Custo dos itens vendidos',money(soldCost),`${sold.length} itens vendidos`)}</div>

      <div class="grid3 statsGrid">
        <div class="card"><h3 class="sectionTitle">Tempo até à venda</h3><div class="kpiLine"><span>Média</span><b>${hold.length?daysText(avg(hold)):'—'}</b></div><div class="kpiLine"><span>Mediana</span><b>${hold.length?daysText(median(hold)):'—'}</b></div><div class="kpiLine"><span>Venda mais rápida</span><b>${fastest?daysText(fastest.days):'—'}</b></div>${fastest?`<div class="statsLinkedItem">${tableItem(fastest.i)}</div>`:''}<div class="kpiLine"><span>Maior permanência</span><b>${longest?daysText(longest.days):'—'}</b></div>${longest?`<div class="statsLinkedItem">${tableItem(longest.i)}</div>`:''}<p class="statsFootnote">Calculado apenas quando existem as duas datas.</p></div>
        <div class="card"><h3 class="sectionTitle">Resultado das vendas</h3><div class="resultSplit"><div><strong class="positive">${positives}</strong><small>Lucro</small></div><div><strong>${evens}</strong><small>Empate</small></div><div><strong class="negative">${negatives}</strong><small>Prejuízo</small></div></div><div class="kpiLine"><span>Melhor resultado</span><b class="positive">${best[0]?money(best[0].profit):'—'}</b></div><div class="kpiLine"><span>Pior resultado</span><b class="negative">${worst[0]?money(worst[0].profit):'—'}</b></div></div>
        <div class="card"><h3 class="sectionTitle">${latest&&annualNow&&annualPrev?`${latest} vs. ${prev}`:'Comparação anual'}</h3>${latest&&annualNow&&annualPrev?`<div class="kpiLine"><span>Compras</span><b>${annualNow.pcount} <small>${change(annualNow.pcount,annualPrev.pcount)}</small></b></div><div class="kpiLine"><span>Gasto</span><b>${money(annualNow.spend)} <small>${change(annualNow.spend,annualPrev.spend)}</small></b></div><div class="kpiLine"><span>Vendas</span><b>${annualNow.scount} <small>${change(annualNow.scount,annualPrev.scount)}</small></b></div><div class="kpiLine"><span>Receita</span><b>${money(annualNow.revenue)} <small>${change(annualNow.revenue,annualPrev.revenue)}</small></b></div><div class="kpiLine"><span>Resultado</span><b class="${annualNow.profit>=0?'positive':'negative'}">${money(annualNow.profit)}</b></div>`:'<div class="empty compactEmpty">São necessários pelo menos dois anos com datas registadas.</div>'}</div>
      </div>

      <div class="statsSectionHead"><div><h2>Onde compras e vendes</h2><p>Plataformas, países e perfil da coleção atual.</p></div></div>
      <div class="grid2 statsGrid"><div class="card"><h3 class="sectionTitle">Valor comprado por plataforma</h3>${bars(pPlatforms,money)}</div><div class="card"><h3 class="sectionTitle">Receita por plataforma de venda</h3>${bars(sPlatforms,money)}</div></div>
      <div class="grid2 statsGrid"><div class="card"><h3 class="sectionTitle">Nº de compras por país</h3>${bars(pCountries,v=>fmtInt(v))}</div><div class="card"><h3 class="sectionTitle">Jogadores suportados · coleção atual</h3>${bars(playerEntries,v=>fmtInt(v))}</div></div>

      <div class="statsSectionHead"><div><h2>Itens em destaque</h2><p>Os negócios e itens que mais pesam nos números.</p></div></div>
      <div class="grid2 statsGrid"><div class="card"><h3 class="sectionTitle">Melhores resultados</h3>${best.length?best.map(x=>`<div class="statsRankRow"><span>${tableItem(x.i)}</span><b class="positive">${money(x.profit)}</b></div>`).join(''):'<div class="empty compactEmpty">Sem vendas.</div>'}</div><div class="card"><h3 class="sectionTitle">Maiores prejuízos</h3>${worst.filter(x=>x.profit<0).length?worst.filter(x=>x.profit<0).map(x=>`<div class="statsRankRow"><span>${tableItem(x.i)}</span><b class="negative">${money(x.profit)}</b></div>`).join(''):'<div class="empty compactEmpty">Sem vendas com prejuízo.</div>'}</div></div>
      <div class="card statsFullCard"><h3 class="sectionTitle">Maior capital atualmente investido</h3><div class="statsInvestmentGrid">${invested.length?invested.map((i,idx)=>`<div class="statsInvestment"><span class="statsRankNo">${idx+1}</span>${cover(i)}<div>${tableItem(i)}<small>${typeBadge(i)} ${esc(i.purchase_platform||'—')} · ${date(i.purchase_date)}</small></div><b>${money(i.purchase_cost)}</b></div>`).join(''):'<div class="empty compactEmpty">Sem itens no filtro atual.</div>'}</div></div>`;
  };

  const controls=['#statsPeriod','#statsFrom','#statsTo','#statsType','#statsPlatform','#statsCountry'];
  controls.forEach(sel=>$(sel).addEventListener('change',renderBody));
  $('#statsReset').onclick=()=>{$('#statsPeriod').value='all';$('#statsFrom').value='';$('#statsTo').value='';$('#statsType').value='all';$('#statsPlatform').value='';$('#statsCountry').value='';renderBody()};
  renderBody();
}

function settings(){
  const raw=JSON.stringify(data),kb=(new Blob([raw]).size/1024).toFixed(0),token=localStorage.getItem(BGG_TOKEN_STORAGE)||'',ghToken=getGithubToken(),s=summary(),wishBgg=data.wishlist.filter(w=>w.bgg_id).length;
  const syncOk=String(syncState.mode||'').includes('sincronizada');const modified=syncState.modified?new Date(syncState.modified).toLocaleString('pt-PT'):'—';
  $('#content').innerHTML=`<div class="note"><b>V1.4:</b> a interface e os dados continuam iguais, mas a base principal passa a ser <b>${esc(GITHUB_DATA_REPO)}/colecao.json</b> num repositório GitHub privado. O token GitHub e o token BGG ficam apenas neste dispositivo.</div><div class="settingsGrid">
  <div class="card"><h3>Sincronização multi-dispositivo</h3><div class="kpiLine"><span>Estado</span><b class="${syncOk?'positive':'negative'}">${esc(syncState.mode)}</b></div><div class="kpiLine"><span>Base</span><b>${esc(syncState.path)}</b></div><div class="kpiLine"><span>Espelho OneDrive neste PC</span><b>${syncState.localMirror?'ativo':'não detetado'}</b></div>${syncState.error?`<p class="tiny negative">${esc(syncState.error)}</p>`:''}<p>No PC e no telemóvel usa-se o mesmo ficheiro privado. O histórico de commits do GitHub mantém versões anteriores. Se abrires pelo launcher do PC, a app tenta ainda espelhar os dados para a pasta local/OneDrive.</p><div class="row"><button class="btn secondary" id="reloadShared">Recarregar do GitHub</button><button class="btn secondary" id="openCloudSetup">Configurar token GitHub</button><button class="btn danger" id="forceCloudSave">Forçar gravação atual</button></div><p class="tiny">Token GitHub: ${ghToken?'guardado neste dispositivo':'não configurado'}.</p></div>
  <div class="card"><h3>BoardGameGeek</h3><p>O token fica apenas neste dispositivo. Na versão web, os pedidos são feitos diretamente ao BGG; no launcher de PC, o helper local continua disponível como alternativa.</p><div class="settingsToken"><input id="bggToken" type="password" value="${esc(token)}" placeholder="Application Token BGG"><div class="row"><button class="btn primary" id="saveToken">Guardar token</button><button class="btn secondary" id="testBgg">Testar ligação</button><button class="btn secondary" id="openBggApps">Aplicações BGG</button></div><div class="row"><button class="btn secondary" id="refreshWebBgg">Restaurar capas na versão web</button></div><div id="tokenStatus" class="tiny">${token?'Token guardado neste dispositivo.':'Ainda não há token guardado neste dispositivo.'}</div></div><div class="kpiLine"><span>Coleção associada</span><b>${s.bgg}/${data.items.length}</b></div><div class="kpiLine"><span>Wishlist associada</span><b>${wishBgg}/${data.wishlist.length}</b></div><p class="tiny"><a href="https://boardgamegeek.com" target="_blank" rel="noopener">Powered by BoardGameGeek</a> · Data provided by BoardGameGeek.</p></div>
  <div class="card"><h3>Instalar no dispositivo</h3><p>Podes adicionar esta app ao ecrã principal para abrir como uma aplicação.</p><button class="btn primary" id="installPwaBtn">Instalar / instruções</button><p class="tiny">Android/Chrome: instalar app. iPhone/Safari: Partilhar → Adicionar ao ecrã principal.</p></div>
  <div class="card"><h3>Backup manual</h3><p>Exporta toda a base para JSON. Além disso, o GitHub guarda o histórico de versões e a app tenta criar um backup diário no repo privado.</p><button class="btn primary" id="backupBtn">Criar backup JSON</button></div>
  <div class="card"><h3>Restaurar</h3><p>Importa um backup JSON e grava-o na base partilhada.</p><button class="btn secondary" id="restoreBtn">Importar backup</button></div>
  <div class="card"><h3>Exportar para CSV</h3><p>Cria um CSV com todos os exemplares e relações.</p><button class="btn secondary" id="csvBtn">Exportar coleção CSV</button></div>
  <div class="card"><h3>Base atual</h3><div class="kpiLine"><span>Jogos base atuais</span><b>${s.baseCollection}</b></div><div class="kpiLine"><span>Expansões atuais</span><b>${s.expansionCollection}</b></div><div class="kpiLine"><span>Exemplares totais</span><b>${data.items.length}</b></div><div class="kpiLine"><span>Wishlist</span><b>${data.wishlist.length}</b></div><div class="kpiLine"><span>Movimentos</span><b>${data.movements.length}</b></div><div class="kpiLine"><span>Tamanho dos dados</span><b>${kb} KB</b></div></div></div>`;
  $('#reloadShared').onclick=reloadSharedData;$('#openCloudSetup').onclick=()=>showCloudSetup(false);$('#forceCloudSave').onclick=()=>{if(confirm('Forçar a gravação desta versão no GitHub? Usa isto apenas se tens a certeza de que esta é a versão que queres manter.'))saveGithubData({force:true}).then(()=>{alert('Versão atual gravada no GitHub.');settings()}).catch(e=>alert(e.message))};
  $('#saveToken').onclick=()=>{localStorage.setItem(BGG_TOKEN_STORAGE,$('#bggToken').value.trim());$('#tokenStatus').textContent='Token guardado localmente neste dispositivo.'};
  $('#testBgg').onclick=async()=>{const st=$('#tokenStatus');st.textContent='A testar…';try{await helperPost('/api/search',{query:'Carcassonne',token:$('#bggToken').value.trim()});st.textContent='Ligação ao BGG efetuada com sucesso.'}catch(e){st.textContent='Erro: '+e.message}};
  $('#openBggApps').onclick=()=>window.open('https://boardgamegeek.com/applications','_blank','noopener');$('#refreshWebBgg').onclick=refreshBggWebMetadata;$('#installPwaBtn').onclick=async()=>{if(deferredInstallPrompt){deferredInstallPrompt.prompt();await deferredInstallPrompt.userChoice;deferredInstallPrompt=null}else alert('Se não aparecer instalação automática: Android/Chrome → menu ⋮ → Instalar app. iPhone/Safari → Partilhar → Adicionar ao ecrã principal.')};
  $('#backupBtn').onclick=backup;$('#restoreBtn').onclick=()=>$('#importFile').click();$('#csvBtn').onclick=exportCsv;
}

function populateBaseGameSelect(selected=null,excludeId=null){
  const sel=$('#baseGameSelect');
  sel.innerHTML='<option value="">— selecionar jogo base —</option>'+baseGames().filter(b=>b.id!==Number(excludeId)).map(b=>`<option value="${b.id}">${esc(b.title)}</option>`).join('');
  if(selected!==null&&selected!==undefined)sel.value=String(selected);
}
function updateItemTypeUi(){
  const type=$('#itemType').value;
  $('#baseGameLabel').style.display=type==='expansion'?'block':'none';
  const canManage=!!editItemId&&type==='base';
  $('#itemManageExpansions').style.display=canManage?'inline-block':'none';
}
function openItem(id=null,presetBaseId=null){
  editItemId=id;const f=$('#itemForm');f.reset();$('#itemDialogTitle').textContent=id?(isExpansion(data.items.find(x=>x.id===id)||{})?'Ficha da expansão':'Ficha do jogo'):presetBaseId?'Adicionar expansão':'Adicionar jogo';
  populateBaseGameSelect(presetBaseId,id);
  f.elements.item_type.value=presetBaseId?'expansion':'base';
  if(presetBaseId)f.elements.base_game_id.value=String(presetBaseId);
  if(id){const i=data.items.find(x=>x.id===id);Object.keys(i).forEach(k=>{const el=f.elements[k];if(!el)return;if(el.type==='checkbox')el.checked=String(i[k]||'').toLowerCase()==='sim';else el.value=i[k]??''});populateBaseGameSelect(i.base_game_id,id);f.elements.item_type.value=i.item_type||'base';if(i.base_game_id)f.elements.base_game_id.value=String(i.base_game_id)}
  updateItemTypeUi();updateItemBggButton();
  const danger=$('#itemDangerZone');if(danger)danger.hidden=!id;
  $('#itemDialog').showModal();
}
function updateItemBggButton(){const id=$('#itemForm').elements.bgg_id.value.trim();$('#itemBggOpen').style.display=id?'inline-block':'none';$('#itemBggLoadId').textContent=id?'Atualizar dados BGG':'Associar pelo ID'}
function readMoney(v){v=String(v||'').trim().replace(/€/g,'').replace(/\s/g,'');if(!v)return null;if(v.includes(',')&&v.includes('.'))v=v.replace(/\./g,'').replace(',','.');else v=v.replace(',','.');const n=Number(v);return Number.isFinite(n)?n:null}
function saveItem(){
  const f=$('#itemForm'),fd=new FormData(f),old=editItemId?data.items.find(x=>x.id===editItemId):null,i=old?{...old}:{id:nextId(data.items),created_at:new Date().toISOString()};
  ['title','status','condition','mechanisms','language_dep','acquisition_type','deal_ref','purchase_platform','purchase_country','purchase_date','sale_type','sale_platform','sale_country','sale_date','comments','bgg_id','bgg_year','bgg_name','item_type'].forEach(k=>i[k]=fd.get(k)||null);
  i.item_type=i.item_type==='expansion'?'expansion':'base';
  i.base_game_id=i.item_type==='expansion'&&fd.get('base_game_id')?Number(fd.get('base_game_id')):null;
  if(i.item_type==='expansion'&&!i.base_game_id){alert('Escolhe o jogo base desta expansão.');return}
  if(i.bgg_id)i.bgg_url=bggUrl(i);else{i.bgg_url=null;i.bgg_name=null;i.bgg_year=null;i.bgg_cover=false}
  i.purchase_cost=readMoney(fd.get('purchase_cost'));i.sale_price=readMoney(fd.get('sale_price'));['players_1','players_2','players_3','players_4','players_5','players_6plus'].forEach(k=>i[k]=f.elements[k].checked?'Sim':'Não');i.updated_at=new Date().toISOString();
  if(!i.title?.trim()){alert('Indica o título.');return}
  if(!old){data.items.push(i);if(i.purchase_cost!==null||i.purchase_platform)addMove(i,'Compra',i.purchase_date,i.purchase_platform,i.purchase_country,i.purchase_cost,i.comments)}
  else{
    const purchaseChanged=['purchase_cost','purchase_platform','purchase_country','purchase_date'].some(k=>(old[k]??null)!==(i[k]??null)),saleChanged=['sale_price','sale_platform','sale_country','sale_date','status'].some(k=>(old[k]??null)!==(i[k]??null));Object.assign(old,i);if(purchaseChanged)addMove(i,'Ajuste compra',i.purchase_date,i.purchase_platform,i.purchase_country,i.purchase_cost,'Dados de compra atualizados');if(saleChanged&&i.status==='Vendido')addMove(i,'Venda',i.sale_date,i.sale_platform,i.sale_country,i.sale_price,'Venda registada/atualizada')
  }
  save();$('#itemDialog').close();render();
}
function addMove(i,kind,d,p,c,a,n){data.movements.push({id:nextId(data.movements),item_id:i.id,kind,movement_date:d||today(),platform:p||null,country:c||null,amount:a,notes:n||null,created_at:new Date().toISOString()})}

function openOperationDate(id,type){
  const i=data.items.find(x=>x.id===Number(id));if(!i)return;
  editDateItemId=i.id;editDateType=type;
  const isSale=type==='sale',f=$('#operationDateForm');f.reset();
  $('#operationDateTitle').textContent=isSale?'Alterar data da venda':'Alterar data da compra';
  $('#operationDateSubtitle').textContent=i.title;
  $('#operationDateLabel').firstChild.textContent=isSale?'Data de venda':'Data de compra';
  f.elements.operation_date.value=(isSale?i.sale_date:i.purchase_date)||'';
  $('#operationDateDialog').showModal();
}
function updateOperationMovementDate(itemId,type,newDate){
  const isSale=type==='sale';
  let matched=0;
  data.movements.forEach(m=>{
    if(Number(m.item_id)!==Number(itemId))return;
    const kind=String(m.kind||'').toLocaleLowerCase('pt-PT');
    const relevant=isSale ? kind==='venda' : kind.includes('compra');
    if(relevant){m.movement_date=newDate;matched++;}
  });
  return matched;
}
function saveOperationDate(){
  const i=data.items.find(x=>x.id===Number(editDateItemId));if(!i)return;
  const f=$('#operationDateForm'),newDate=f.elements.operation_date.value;
  if(!newDate){alert('Indica uma data válida.');return}
  const isSale=editDateType==='sale';
  if(isSale&&i.status!=='Vendido'){alert('Este item não está registado como vendido.');return}
  if(isSale)i.sale_date=newDate;else i.purchase_date=newDate;
  updateOperationMovementDate(i.id,editDateType,newDate);
  i.updated_at=new Date().toISOString();
  save();$('#operationDateDialog').close();render();
}
function updateSaleBundleTotal(){
  const f=$('#sellForm');let total=num(readMoney(f.elements.sale_price.value));
  $$('#saleBundleItems .saleExpansionCheck').forEach(ch=>{if(ch.checked){const inp=$(`#sale-exp-price-${ch.dataset.id}`);total+=num(readMoney(inp?.value))}});
  $('#saleBundleTotal').textContent=money(total);
}
function openSell(id){
  sellItemId=id;const i=data.items.find(x=>x.id===id),f=$('#sellForm');f.reset();if(!i)return;
  $('#sellTitle').textContent=i.title;f.elements.sale_date.value=today();
  const sec=$('#saleBundleSection'),box=$('#saleBundleItems');box.innerHTML='';
  const exps=isBase(i)?data.items.filter(x=>isExpansion(x)&&Number(x.base_game_id)===Number(i.id)&&isCurrent(x)).sort((a,b)=>(a.title||'').localeCompare(b.title||'','pt')):[];
  sec.hidden=!exps.length;$('#saleBasePriceLabel').firstChild.textContent=exps.length?'Preço atribuído ao jogo base (€)':'Preço de venda (€)';
  if(exps.length){box.innerHTML=exps.map(x=>`<label class="saleBundleRow"><span><input type="checkbox" class="saleExpansionCheck" data-id="${x.id}"> <b>${esc(x.title)}</b><small>${x.bgg_year?esc(x.bgg_year)+' · ':''}${money(x.purchase_cost)} de custo</small></span><input id="sale-exp-price-${x.id}" class="saleExpansionPrice" data-id="${x.id}" inputmode="decimal" value="0" disabled aria-label="Preço de ${esc(x.title)}"></label>`).join('');}
  updateSaleBundleTotal();$('#sellDialog').showModal();
}
function markSold(i,price,common,groupId){
  if(!i.sale_snapshot)i.sale_snapshot=collectionSnapshot(i);
  i.status='Vendido';i.sale_price=price;i.sale_platform=common.platform;i.sale_country=common.country;i.sale_date=common.date;i.sale_type='Venda';i.sale_group_id=groupId;i.updated_at=new Date().toISOString();
  addMove(i,'Venda',i.sale_date,i.sale_platform,i.sale_country,i.sale_price,groupId?'Venda conjunta':'Venda registada');
}
function confirmSale(){
  const i=data.items.find(x=>x.id===sellItemId),f=$('#sellForm'),fd=new FormData(f),price=readMoney(fd.get('sale_price'));if(!i)return;if(price===null){alert('Indica o preço de venda.');return}
  const selected=$$('#saleBundleItems .saleExpansionCheck:checked').map(ch=>({item:data.items.find(x=>x.id===Number(ch.dataset.id)),price:readMoney($(`#sale-exp-price-${ch.dataset.id}`)?.value)})).filter(x=>x.item);
  if(selected.some(x=>x.price===null)){alert('Indica o valor atribuído a cada expansão selecionada (pode ser 0).');return}
  const groupId=selected.length?`sale_${Date.now()}_${i.id}`:null,common={platform:fd.get('sale_platform')||null,country:fd.get('sale_country')||null,date:fd.get('sale_date')||today()};
  markSold(i,price,common,groupId);selected.forEach(x=>markSold(x.item,x.price,common,groupId));
  save();$('#sellDialog').close();render();
}
function openSoldDetail(id){
  const i=data.items.find(x=>x.id===Number(id));if(!i||i.status!=='Vendido')return;const s=soldSnapshot(i),b=isExpansion(i)?baseGame(i.base_game_id):null,groupCount=sameSaleGroupCount(i);
  $('#soldDetailTitle').textContent=s.title||i.title;$('#soldDetailSubtitle').textContent=isExpansion(i)&&b?`Expansão de ${b.title} · vendida em ${date(i.sale_date)}`:`Vendida em ${date(i.sale_date)}`;
  const details=[['Tipo',isExpansion(i)?'Expansão':'Jogo base'],['Estado físico',s.condition||'—'],['Jogadores',playerText(s)],['Dependência de idioma',s.language_dep||'—'],['Mecanismos',s.mechanisms||'—'],['BGG',s.bgg_id?`#${s.bgg_id}${s.bgg_year?' · '+s.bgg_year:''}`:'—']];
  const purchase=[['Tipo de aquisição',s.acquisition_type||'Compra'],['Data de compra',date(s.purchase_date)],['Plataforma',s.purchase_platform||'—'],['País',s.purchase_country||'—'],['Custo',money(s.purchase_cost)],['Referência do negócio',s.deal_ref||'—']];
  const sale=[['Data de venda',date(i.sale_date)],['Plataforma',i.sale_platform||'—'],['País',i.sale_country||'—'],['Preço',money(i.sale_price)],['Resultado',money(num(i.sale_price)-num(s.purchase_cost))],['Venda conjunta',groupCount>1?`${groupCount} itens`:'Não']];
  const grid=arr=>arr.map(([k,v])=>`<div class="detailField"><small>${esc(k)}</small><b>${typeof v==='string'?esc(v):v}</b></div>`).join('');
  $('#soldDetailContent').innerHTML=`<div class="soldHero">${cover(s)}<div><h3>${esc(s.title||i.title)}</h3><div>${typeBadge(i)} ${statusPill('Vendido')}</div>${s.bgg_name?`<p>${esc(s.bgg_name)}${s.bgg_year?' · '+esc(s.bgg_year):''}</p>`:''}</div></div><div class="detailSection"><h4>Informação da coleção no momento da venda</h4><div class="detailGrid">${grid(details)}</div></div><div class="detailSection"><h4>Compra</h4><div class="detailGrid">${grid(purchase)}</div></div><div class="detailSection"><h4>Venda</h4><div class="detailGrid">${grid(sale)}</div></div><div class="detailSection"><h4>Comentários</h4><p class="detailComments">${esc(s.comments||'Sem comentários.')}</p></div>`;
  $('#soldDetailBgg').style.display=s.bgg_id?'inline-block':'none';$('#soldDetailBgg').dataset.bggid=s.bgg_id||'';$('#soldDetailDialog').showModal();
}

function removeItem(id){
  const i=data.items.find(x=>x.id===Number(id));if(!i)return;
  if(isBase(i)){
    const linkedItems=data.items.filter(x=>isExpansion(x)&&Number(x.base_game_id)===Number(i.id));
    const linkedWishes=data.wishlist.filter(w=>w.item_type==='expansion'&&Number(w.base_game_id)===Number(i.id));
    const linkedCount=linkedItems.length+linkedWishes.length;
    if(linkedCount){
      alert(`Não é possível remover "${i.title}" porque tem ${linkedCount} expansão(ões) ligada(s).\n\nRemove ou altera primeiro essas expansões para evitar deixar registos sem jogo base.`);
      return;
    }
  }
  const extra=isExpansion(i)&&baseGame(i.base_game_id)?`\nJogo base: ${baseGame(i.base_game_id).title}`:'';
  if(!confirm(`Remover permanentemente "${i.title}" da aplicação?${extra}\n\nUsa esta opção apenas para registos inseridos por engano. Isto NÃO conta como venda e o item será apagado, juntamente com os movimentos associados.`))return;
  data.items=data.items.filter(x=>x.id!==i.id);
  data.movements=data.movements.filter(m=>Number(m.item_id)!==Number(i.id));
  save();
  if($('#itemDialog').open)$('#itemDialog').close();
  if($('#expansionDialog').open)renderExpansionsModal();
  render();
}
function openWish(id=null){
  editWishId=id;const f=$('#wishForm');f.reset();const w=id?data.wishlist.find(x=>x.id===id):null;
  $('#wishDialogTitle').textContent=id?'Editar wishlist':'Adicionar à wishlist';
  $('#wishDialogSubtitle').textContent=w?.item_type==='expansion'&&baseGame(w.base_game_id)?`Expansão de ${baseGame(w.base_game_id).title}`:'';
  if(w){f.elements.title.value=w.title;f.elements.priority.value=w.priority??'';f.elements.notes.value=w.notes??''}
  $('#wishDialog').showModal();
}
function saveWish(){
  const f=$('#wishForm'),fd=new FormData(f),title=String(fd.get('title')||'').trim();if(!title){alert('Indica o título.');return}
  let target=null;
  if(editWishId){
    const w=data.wishlist.find(x=>x.id===editWishId);w.title=title;w.priority=fd.get('priority')?num(fd.get('priority')):null;w.notes=fd.get('notes')||null;w.updated_at=new Date().toISOString();target=w;
  }else{
    target={id:nextId(data.wishlist),title,priority:fd.get('priority')?num(fd.get('priority')):null,notes:fd.get('notes')||null,item_type:'base',base_game_id:null,created_at:new Date().toISOString(),updated_at:new Date().toISOString()};data.wishlist.push(target);
  }
  save();$('#wishDialog').close();if($('#expansionDialog').open)renderExpansionsModal();render();
}
function openPrice(id){priceWishId=id;const w=data.wishlist.find(x=>x.id===id),f=$('#priceForm');f.reset();$('#priceWishTitle').textContent=w.title;f.elements.observed_date.value=today();$('#priceDialog').showModal()}
function savePrice(){const f=$('#priceForm'),fd=new FormData(f),p=readMoney(fd.get('price'));if(p===null){alert('Indica um preço válido.');return}data.wishlist_prices.push({id:nextId(data.wishlist_prices),wishlist_id:priceWishId,observed_date:fd.get('observed_date')||today(),price:p});save();$('#priceDialog').close();if($('#expansionDialog').open)renderExpansionsModal();render()}

function openExpansions(baseId){
  const b=baseGame(baseId);if(!b)return;expansionBaseId=b.id;$('#expansionBaseTitle').textContent=b.title;$('#bggExpansionResults').innerHTML='';$('#expansionStatus').textContent='';renderExpansionsModal();$('#expansionDialog').showModal();
}
function renderExpansionsModal(){
  const b=baseGame(expansionBaseId);if(!b)return;
  const entries=linkedExpansionEntries(b.id),owned=entries.filter(e=>e.kind==='item'&&isCurrent(e.item)).length,wish=entries.filter(e=>e.kind==='wishlist').length,sold=entries.filter(e=>e.kind==='item'&&['Vendido','Trocado'].includes(e.item.status)).length;
  $('#expansionCounts').textContent=`${owned} tenho · ${wish} wishlist · ${sold} vendida(s)`;
  $('#discoverBggExpansions').disabled=!b.bgg_id;
  $('#discoverBggExpansions').title=b.bgg_id?'Consultar expansões ligadas no BGG':'Associa primeiro o jogo base ao BGG';
  $('#expansionList').innerHTML=entries.length?entries.map(e=>{
    if(e.kind==='item'){
      const x=e.item;return `<div class="expansionCard"><div class="expansionCardMain">${cover(x)}<div><b>${esc(x.title)}</b><div class="expansionMeta">${expansionStatePill('item',x.status)} ${bggBadge(x)} ${x.purchase_cost!==null&&x.purchase_cost!==undefined?`<span>${money(x.purchase_cost)}</span>`:''}</div></div></div><div class="actions"><button class="linkBtn editItem" data-id="${x.id}">Ficha</button>${isCurrent(x)?`<button class="linkBtn sellItem" data-id="${x.id}">Vender</button><button class="linkBtn dangerLink removeItem" data-id="${x.id}">Remover</button>`:''}${x.bgg_id?`<button class="linkBtn bggItem" data-id="${x.id}">BGG</button>`:`<button class="linkBtn bggItem" data-id="${x.id}">Associar BGG</button>`}</div></div>`;
    }
    const w=e.wish;return `<div class="expansionCard wishlistCard"><div class="expansionCardMain">${cover(w)}<div><b>${esc(w.title)}</b><div class="expansionMeta">${expansionStatePill('wishlist')} ${bggBadge(w)}</div></div></div><div class="actions"><button class="linkBtn addPrice" data-id="${w.id}">+ preço</button><button class="linkBtn editWish" data-id="${w.id}">Editar</button><button class="linkBtn acquireWishExpansion" data-id="${w.id}">Passei a ter</button><button class="linkBtn delWish" data-id="${w.id}">Apagar</button></div></div>`;
  }).join(''):'<div class="empty compactEmpty">Ainda não registaste expansões para este jogo.</div>';
}
function openAddExpansion(){
  const b=baseGame(expansionBaseId);if(!b)return;const f=$('#expansionForm');f.reset();f.elements.purchase_date.value=today();f.elements.sale_date.value=today();$('#addExpansionBaseTitle').textContent=`Jogo base: ${b.title}`;toggleExpansionSaleFields();$('#addExpansionDialog').showModal();
}
function toggleExpansionSaleFields(){const sold=$('#expansionForm').elements.expansion_state.value==='sold';$$('.expansionSaleFields').forEach(el=>el.style.display=sold?'block':'none')}
async function saveExpansion(){
  const b=baseGame(expansionBaseId);if(!b)return;const f=$('#expansionForm'),fd=new FormData(f),title=String(fd.get('title')||'').trim(),state=fd.get('expansion_state'),bggId=String(fd.get('bgg_id')||'').replace(/\D/g,'');if(!title){alert('Indica o título da expansão.');return}
  if(state==='wishlist'){
    const w={id:nextId(data.wishlist),title,priority:null,notes:fd.get('comments')||null,item_type:'expansion',base_game_id:b.id,bgg_id:bggId||null,bgg_url:bggId?`https://boardgamegeek.com/boardgame/${bggId}`:null,created_at:new Date().toISOString(),updated_at:new Date().toISOString()};data.wishlist.push(w);save();
    if(bggId){try{await enrichWishFromBgg(w,bggId)}catch(e){alert('A expansão foi guardada na wishlist, mas não consegui obter os dados BGG: '+e.message)}}
  }else{
    const i={id:nextId(data.items),title,item_type:'expansion',base_game_id:b.id,status:state==='sold'?'Vendido':'Coleção',condition:null,mechanisms:null,language_dep:null,acquisition_type:'Compra',deal_ref:null,purchase_platform:fd.get('purchase_platform')||null,purchase_cost:readMoney(fd.get('purchase_cost')),purchase_country:fd.get('purchase_country')||null,purchase_date:fd.get('purchase_date')||null,sale_type:state==='sold'?'Venda':null,sale_platform:state==='sold'?(fd.get('sale_platform')||null):null,sale_price:state==='sold'?readMoney(fd.get('sale_price')):null,sale_country:state==='sold'?(fd.get('sale_country')||null):null,sale_date:state==='sold'?(fd.get('sale_date')||today()):null,comments:fd.get('comments')||null,bgg_id:bggId||null,bgg_url:bggId?`https://boardgamegeek.com/boardgame/${bggId}`:null,bgg_name:null,bgg_year:null,bgg_cover:false,players_1:'Não',players_2:'Não',players_3:'Não',players_4:'Não',players_5:'Não',players_6plus:'Não',created_at:new Date().toISOString(),updated_at:new Date().toISOString()};data.items.push(i);if(i.purchase_cost!==null||i.purchase_platform)addMove(i,'Compra',i.purchase_date,i.purchase_platform,i.purchase_country,i.purchase_cost,i.comments);if(i.status==='Vendido')addMove(i,'Venda',i.sale_date,i.sale_platform,i.sale_country,i.sale_price,'Venda registada');save();if(bggId){try{await associateBgg(i.id,bggId,{silent:true})}catch(e){alert('A expansão foi guardada, mas não consegui obter os dados BGG: '+e.message)}}
  }
  save();$('#addExpansionDialog').close();renderExpansionsModal();if(view==='collection')collection();
}
async function enrichWishFromBgg(w,bggId){
  const token=requireToken();if(!token)throw new Error('Sem token BGG.');const r=await helperPost('/api/thing',{id:String(bggId),token}),d=parseThingXml(r.xml);let cached=null;if(d.image||d.thumbnail){try{const c=await helperPost('/api/cache-image',{id:d.id,url:d.image||d.thumbnail});cached=c.path||null}catch(e){}}
  w.bgg_id=d.id;w.bgg_url=`https://boardgamegeek.com/boardgame/${d.id}`;w.bgg_name=d.name;w.bgg_year=d.year||null;w.bgg_type=d.type||null;w.bgg_image_url=d.thumbnail||d.image||null;applyBggPlayers(w,d);if(cached){w.cover_path=cached;w.bgg_cover=true}w.updated_at=new Date().toISOString();save();return w;
}
async function discoverBggExpansions(){
  const b=baseGame(expansionBaseId);if(!b?.bgg_id){$('#expansionStatus').textContent='Associa primeiro o jogo base ao BGG.';return}const token=requireToken();if(!token)return;$('#expansionStatus').textContent='A consultar as expansões ligadas no BGG…';$('#bggExpansionResults').innerHTML='';
  try{
    const r=await helperPost('/api/thing',{id:String(b.bgg_id),token}),d=parseThingXml(r.xml),links=d.expansions||[];
    const existingIds=new Set(linkedExpansionEntries(b.id).map(e=>String(e.bgg_id||'')).filter(Boolean));
    $('#expansionStatus').textContent=links.length?`${links.length} expansão(ões) encontrada(s) no BGG.`:'O BGG não devolveu expansões ligadas a este jogo.';
    $('#bggExpansionResults').innerHTML=links.map(x=>`<div class="bggResult"><div><b>${esc(x.name)}</b><div class="bggMeta"><span class="bggTag">BGG #${esc(x.id)}</span>${existingIds.has(String(x.id))?'<span class="bggTag linkedTag">Já registada</span>':''}</div></div>${existingIds.has(String(x.id))?'<span class="tiny">—</span>':`<div class="actions"><button class="btn smallBtn primary addBggExpansion" data-bggid="${esc(x.id)}" data-state="owned">Tenho</button><button class="btn smallBtn secondary addBggExpansion" data-bggid="${esc(x.id)}" data-state="wishlist">Wishlist</button></div>`}</div>`).join('');
  }catch(e){$('#expansionStatus').textContent='Erro: '+e.message}
}
async function addExpansionFromBgg(bggId,state){
  const b=baseGame(expansionBaseId);if(!b)return;const token=requireToken();if(!token)return;$('#expansionStatus').textContent='A obter dados da expansão…';
  try{
    const r=await helperPost('/api/thing',{id:String(bggId),token}),d=parseThingXml(r.xml);let cached=null;if(d.image||d.thumbnail){try{const c=await helperPost('/api/cache-image',{id:d.id,url:d.image||d.thumbnail});cached=c.path||null}catch(e){}}
    if(state==='wishlist'){
      const newWish={id:nextId(data.wishlist),title:d.name||`BGG #${d.id}`,priority:null,notes:null,item_type:'expansion',base_game_id:b.id,bgg_id:d.id,bgg_url:`https://boardgamegeek.com/boardgame/${d.id}`,bgg_name:d.name,bgg_year:d.year||null,bgg_type:d.type||'boardgameexpansion',bgg_image_url:d.thumbnail||d.image||null,cover_path:cached||null,bgg_cover:!!cached,created_at:new Date().toISOString(),updated_at:new Date().toISOString()};applyBggPlayers(newWish,d);data.wishlist.push(newWish);
    }else{
      const newItem={id:nextId(data.items),title:d.name||`BGG #${d.id}`,item_type:'expansion',base_game_id:b.id,status:'Coleção',condition:null,mechanisms:null,language_dep:null,acquisition_type:'Compra',deal_ref:null,purchase_platform:null,purchase_cost:null,purchase_country:null,purchase_date:null,sale_type:null,sale_platform:null,sale_price:null,sale_country:null,sale_date:null,comments:null,bgg_id:d.id,bgg_url:`https://boardgamegeek.com/boardgame/${d.id}`,bgg_name:d.name,bgg_year:d.year||null,bgg_type:d.type||'boardgameexpansion',bgg_image_url:d.thumbnail||d.image||null,cover_path:cached||null,bgg_cover:!!cached,players_1:'Não',players_2:'Não',players_3:'Não',players_4:'Não',players_5:'Não',players_6plus:'Não',created_at:new Date().toISOString(),updated_at:new Date().toISOString()};applyBggPlayers(newItem,d);data.items.push(newItem);
    }
    save();$('#expansionStatus').textContent=`${d.name||'Expansão'} adicionada.`;renderExpansionsModal();await discoverBggExpansions();if(view==='collection')collection();
  }catch(e){$('#expansionStatus').textContent='Erro: '+e.message}
}
function acquireWishExpansion(wishId){
  const w=data.wishlist.find(x=>x.id===wishId);if(!w||w.item_type!=='expansion')return;const b=baseGame(w.base_game_id);if(!b)return;
  const i={id:nextId(data.items),title:w.title,item_type:'expansion',base_game_id:b.id,status:'Coleção',condition:null,mechanisms:null,language_dep:null,acquisition_type:'Compra',deal_ref:null,purchase_platform:null,purchase_cost:null,purchase_country:null,purchase_date:today(),sale_type:null,sale_platform:null,sale_price:null,sale_country:null,sale_date:null,comments:w.notes||null,bgg_id:w.bgg_id||null,bgg_url:w.bgg_url||null,bgg_name:w.bgg_name||null,bgg_year:w.bgg_year||null,bgg_type:w.bgg_type||null,cover_path:w.cover_path||null,bgg_cover:!!w.bgg_cover,players_1:w.players_1||'Não',players_2:w.players_2||'Não',players_3:w.players_3||'Não',players_4:w.players_4||'Não',players_5:w.players_5||'Não',players_6plus:w.players_6plus||'Não',bgg_minplayers:w.bgg_minplayers||null,bgg_maxplayers:w.bgg_maxplayers||null,created_at:new Date().toISOString(),updated_at:new Date().toISOString()};
  i.wishlist_price_history=data.wishlist_prices.filter(x=>x.wishlist_id===wishId).map(x=>({observed_date:x.observed_date,price:x.price}));data.items.push(i);removeWishFromRanking(wishId);data.wishlist=data.wishlist.filter(x=>x.id!==wishId);data.wishlist_prices=data.wishlist_prices.filter(x=>x.wishlist_id!==wishId);save();renderExpansionsModal();if(view==='collection')collection();
}

function download(name,content,type){const a=document.createElement('a');a.href=URL.createObjectURL(new Blob([content],{type}));a.download=name;document.body.appendChild(a);a.click();setTimeout(()=>{URL.revokeObjectURL(a.href);a.remove()},1000)}
function backup(){download(`Colecao_BG_backup_${today()}.json`,JSON.stringify(data,null,2),'application/json')}
function exportCsv(){
  const fields=['id','title','item_type','base_game_id','base_game_title','bgg_id','bgg_url','bgg_name','bgg_year','status','condition','players_1','players_2','players_3','players_4','players_5','players_6plus','mechanisms','language_dep','acquisition_type','deal_ref','purchase_platform','purchase_cost','purchase_country','purchase_date','sale_type','sale_platform','sale_price','sale_country','sale_date','comments'];
  const q=v=>'"'+String(v??'').replace(/"/g,'""')+'"';
  const txt='\uFEFF'+fields.join(';')+'\n'+data.items.map(i=>fields.map(k=>q(k==='base_game_title'?(baseGame(i.base_game_id)?.title||''):i[k])).join(';')).join('\n');download(`Colecao_BG_${today()}.csv`,txt,'text/csv;charset=utf-8')
}
function restoreFile(file){const r=new FileReader();r.onload=()=>{try{const x=JSON.parse(r.result);if(!Array.isArray(x.items)||!Array.isArray(x.wishlist))throw 0;if(confirm('Substituir os dados atuais pelos dados deste backup?')){data=x;normalize();save();render();alert('Backup restaurado.')}}catch(e){alert('Este ficheiro não é um backup válido da aplicação.')}};r.readAsText(file)}

async function helperPostLocal(path,payload,timeoutMs=3500){
  const ctrl=new AbortController(),tm=setTimeout(()=>ctrl.abort(),timeoutMs);let res;
  try{res=await fetch(HELPER+path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload),signal:ctrl.signal})}catch(e){clearTimeout(tm);throw new Error('Helper local não disponível.')}clearTimeout(tm);
  let obj={};try{obj=await res.json()}catch(e){throw new Error('Resposta inválida do helper local.')}
  if(!res.ok||obj.ok===false)throw new Error(obj.error||`Erro HTTP ${res.status}`);return obj;
}
async function waitBggClientRate(){const min=5200,elapsed=Date.now()-lastBggCall;if(elapsed<min)await new Promise(r=>setTimeout(r,min-elapsed));lastBggCall=Date.now()}
async function bggDirect(path,payload){
  const token=String(payload?.token||getToken()).trim();if(!token)throw new Error('Application Token BGG em falta.');await waitBggClientRate();let url='';
  if(path==='/api/search'){const q=encodeURIComponent(String(payload.query||''));url=`https://boardgamegeek.com/xmlapi2/search?query=${q}&type=boardgame,boardgameexpansion`}
  else if(path==='/api/thing'){const id=String(payload.id||'').replace(/[^0-9]/g,'');url=`https://boardgamegeek.com/xmlapi2/thing?id=${id}&stats=1`}
  else if(path==='/api/cache-image')return {ok:true,path:String(payload.url||''),remote:true};
  else throw new Error('Endpoint BGG desconhecido.');
  let res;try{res=await fetch(url,{headers:{'Authorization':`Bearer ${token}`,'Accept':'application/xml,text/xml;q=0.9,*/*;q=0.8'}})}catch(e){throw new Error('O navegador não conseguiu contactar diretamente o BGG. Se o BGG bloquear pedidos no browser, usa o launcher de PC para esta operação.')}
  if(res.status===401||res.status===403)throw new Error('Token BGG inválido ou não autorizado.');if([429,500,503].includes(res.status))throw new Error('O BGG está a limitar pedidos neste momento. Tenta novamente mais tarde.');if(!res.ok)throw new Error(`BGG HTTP ${res.status}`);return {ok:true,xml:await res.text()};
}
async function helperPost(path,payload){
  if(path.startsWith('/api/data/'))return helperPostLocal(path,payload);
  if(HOSTED_MODE){try{return await bggDirect(path,payload)}catch(webErr){try{return await helperPostLocal(path,payload,1200)}catch(e){throw webErr}}}
  try{return await helperPostLocal(path,payload)}catch(e){return bggDirect(path,payload)}
}
function getToken(){return (localStorage.getItem(BGG_TOKEN_STORAGE)||'').trim()}
function requireToken(){const t=getToken();if(!t){alert('Ainda não configuraste o Application Token do BGG. Vai a Definições > BoardGameGeek.');nav('settings');return null}return t}
function parseSearchXml(xmlText){const doc=new DOMParser().parseFromString(xmlText,'application/xml');if(doc.querySelector('parsererror'))throw new Error('O BGG devolveu XML inválido.');return [...doc.querySelectorAll('item')].map(n=>({id:n.getAttribute('id'),type:n.getAttribute('type'),name:n.querySelector('name')?.getAttribute('value')||'',year:n.querySelector('yearpublished')?.getAttribute('value')||''}))}
function parseThingXml(xmlText){
  const doc=new DOMParser().parseFromString(xmlText,'application/xml');if(doc.querySelector('parsererror'))throw new Error('O BGG devolveu XML inválido.');const n=doc.querySelector('item');if(!n)throw new Error('O item não foi encontrado no BGG.');
  const name=[...n.querySelectorAll('name')].find(x=>x.getAttribute('type')==='primary')?.getAttribute('value')||'';
  const expansionLinks=[...n.querySelectorAll('link[type="boardgameexpansion"]')];let exps=expansionLinks.filter(x=>x.getAttribute('inbound')==='true');if(!exps.length)exps=expansionLinks;
  return {id:n.getAttribute('id'),type:n.getAttribute('type')||'',name,year:n.querySelector('yearpublished')?.getAttribute('value')||'',image:n.querySelector('image')?.textContent?.trim()||'',thumbnail:n.querySelector('thumbnail')?.textContent?.trim()||'',minplayers:n.querySelector('minplayers')?.getAttribute('value')||'',maxplayers:n.querySelector('maxplayers')?.getAttribute('value')||'',expansions:exps.map(x=>({id:x.getAttribute('id'),name:x.getAttribute('value')||'',inbound:x.getAttribute('inbound')}))};
}
function parseThingsXml(xmlText){
  const doc=new DOMParser().parseFromString(xmlText,'application/xml');if(doc.querySelector('parsererror'))throw new Error('O BGG devolveu XML inválido.');
  return [...doc.querySelectorAll('item')].map(n=>{const name=[...n.querySelectorAll('name')].find(x=>x.getAttribute('type')==='primary')?.getAttribute('value')||'';return {id:n.getAttribute('id'),type:n.getAttribute('type')||'',name,year:n.querySelector('yearpublished')?.getAttribute('value')||'',image:n.querySelector('image')?.textContent?.trim()||'',thumbnail:n.querySelector('thumbnail')?.textContent?.trim()||'',minplayers:n.querySelector('minplayers')?.getAttribute('value')||'',maxplayers:n.querySelector('maxplayers')?.getAttribute('value')||''}})
}
async function refreshBggWebMetadata(){
  const token=requireToken();if(!token)return;
  const all=[...data.items,...data.wishlist].filter(x=>x.bgg_id&&!x.bgg_image_url),ids=[...new Set(all.map(x=>String(x.bgg_id)))];
  if(!ids.length){alert('Todos os itens associados ao BGG já têm os dados necessários para a versão web.');return}
  if(!confirm(`Atualizar capas e jogadores de ${ids.length} BGG ID(s) para a versão web?\n\nOs pedidos são feitos em lotes e respeitam o intervalo do BGG. Podes continuar a usar a app enquanto o processo decorre.`))return;
  const btn=$('#refreshWebBgg');if(btn)btn.disabled=true;let done=0,errors=0;
  for(let n=0;n<ids.length;n+=20){const batch=ids.slice(n,n+20);if(btn)btn.textContent=`A preparar… ${Math.min(n+20,ids.length)}/${ids.length}`;try{await waitBggClientRate();const url=`https://boardgamegeek.com/xmlapi2/thing?id=${batch.join(',')}&stats=1`;const res=await fetch(url,{headers:{'Authorization':`Bearer ${token}`,'Accept':'application/xml,text/xml;q=0.9,*/*;q=0.8'}});if(!res.ok)throw new Error(`BGG HTTP ${res.status}`);const things=parseThingsXml(await res.text());for(const d of things){for(const target of [...data.items,...data.wishlist].filter(x=>String(x.bgg_id)===String(d.id))){target.bgg_image_url=d.thumbnail||d.image||target.bgg_image_url||null;if(!HOSTED_MODE&&target.bgg_image_url&&!target.cover_path)target.cover_path=target.bgg_image_url;applyBggPlayers(target,d);target.updated_at=new Date().toISOString()}done++}save();}catch(e){errors++}}
  if(btn){btn.disabled=false;btn.textContent='Restaurar capas na versão web'}render();alert(`Preparação concluída: ${done} BGG ID(s) atualizados${errors?` · ${errors} lote(s) com erro`:''}.`)
}
function applyBggPlayers(target,d){
  const min=parseInt(d?.minplayers,10),max=parseInt(d?.maxplayers,10);
  if(!Number.isFinite(min)||!Number.isFinite(max)||min<1||max<min)return false;
  for(let p=1;p<=5;p++)target[`players_${p}`]=(p>=min&&p<=max)?'Sim':'Não';
  target.players_6plus=max>=6?'Sim':'Não';
  target.bgg_minplayers=min;target.bgg_maxplayers=max;
  return true;
}
function syncPlayerChecksToForm(i){
  const f=$('#itemForm');if(!f)return;['players_1','players_2','players_3','players_4','players_5','players_6plus'].forEach(k=>{if(f.elements[k])f.elements[k].checked=String(i[k]||'').toLowerCase()==='sim'});
}
function openBggDialog(id,kind='item'){
  bggItemId=Number(id);bggTargetKind=kind==='wish'?'wish':'item';
  const i=bggTargetKind==='wish'?wishById(id):data.items.find(x=>x.id===Number(id));
  $('#bggQuery').value=i?.title||'';$('#bggResults').innerHTML='';
  $('#bggStatus').textContent=i?.bgg_id?`Atualmente associado ao BGG #${i.bgg_id}${i.bgg_name?' · '+i.bgg_name:''}. Pesquisa e escolhe outro resultado para substituir a associação, ou atualiza os dados atuais.`:'Pesquisa pelo título e escolhe o resultado correto.';
  const refresh=$('#bggRefreshCurrent');if(refresh)refresh.style.display=i?.bgg_id?'inline-flex':'none';
  $('#bggDialog').showModal();
}
async function searchBgg(){
  const token=requireToken();if(!token)return;const q=$('#bggQuery').value.trim();if(!q)return;$('#bggStatus').textContent='A pesquisar no BGG…';$('#bggResults').innerHTML='';
  try{const r=await helperPost('/api/search',{query:q,token}),results=parseSearchXml(r.xml).slice(0,25);$('#bggStatus').textContent=results.length?`${results.length} resultado(s). Escolhe o correto.`:'Não encontrei resultados.';$('#bggResults').innerHTML=results.map(x=>`<div class="bggResult"><div><b>${esc(x.name)}</b><div class="bggMeta"><span class="bggTag">${esc(x.year||'ano ?')}</span><span class="bggTag">${x.type==='boardgameexpansion'?'Expansão':'Jogo base'}</span><span class="bggTag">BGG #${esc(x.id)}</span></div></div><button class="btn primary chooseBgg" data-bggid="${esc(x.id)}">Associar</button></div>`).join('')}catch(e){$('#bggStatus').textContent='Erro: '+e.message}
}
async function associateBgg(itemId,bggId,{silent=false}={}){
  const token=requireToken();if(!token)throw new Error('Sem token BGG.');const i=data.items.find(x=>x.id===itemId);if(!i)throw new Error('Item não encontrado.');if(!silent)$('#bggStatus').textContent='A obter dados e capa…';
  const r=await helperPost('/api/thing',{id:String(bggId),token}),d=parseThingXml(r.xml);let cached=null;if(d.image||d.thumbnail){try{const c=await helperPost('/api/cache-image',{id:d.id,url:d.image||d.thumbnail});cached=c.path||null}catch(e){if(!silent)$('#bggStatus').textContent='Dados BGG associados; não foi possível guardar a capa automaticamente.'}}
  i.bgg_id=d.id;i.bgg_url=bggUrl(i);i.bgg_name=d.name;i.bgg_year=d.year||null;i.bgg_type=d.type||null;i.bgg_image_url=d.thumbnail||d.image||null;i.bgg_cover=!!cached;if(cached)i.cover_path=cached;const playersImported=applyBggPlayers(i,d);i.updated_at=new Date().toISOString();save();
  if(editItemId===i.id&&$('#itemDialog').open){const f=$('#itemForm');f.elements.bgg_id.value=i.bgg_id;f.elements.bgg_name.value=i.bgg_name||'';f.elements.bgg_year.value=i.bgg_year||'';syncPlayerChecksToForm(i);updateItemBggButton()}
  if(!silent){const p=playersImported?` · jogadores ${d.minplayers}${d.minplayers!==d.maxplayers?'–'+d.maxplayers:''}`:'';$('#bggStatus').textContent=`Associado: ${i.bgg_name||i.title}${i.bgg_year?' ('+i.bgg_year+')':''}${p}.`;setTimeout(()=>{$('#bggDialog').close();render()},650)}return i;
}
async function associateWishBgg(wishId,bggId,{silent=false}={}){
  const token=requireToken();if(!token)throw new Error('Sem token BGG.');
  const w=wishById(wishId);if(!w)throw new Error('Item da wishlist não encontrado.');
  if(!silent)$('#bggStatus').textContent='A obter dados, capa e jogadores…';
  const r=await helperPost('/api/thing',{id:String(bggId),token}),d=parseThingXml(r.xml);
  let cached=null;
  if(d.image||d.thumbnail){
    try{const c=await helperPost('/api/cache-image',{id:d.id,url:d.image||d.thumbnail});cached=c.path||null}
    catch(e){if(!silent)$('#bggStatus').textContent='Dados BGG associados; não foi possível guardar a capa automaticamente.'}
  }
  w.bgg_id=d.id;w.bgg_url=bggUrl(w);w.bgg_name=d.name;w.bgg_year=d.year||null;w.bgg_type=d.type||null;w.bgg_image_url=d.thumbnail||d.image||null;
  if(cached){w.cover_path=cached;w.bgg_cover=true}else if(!w.cover_path)w.bgg_cover=false;
  const playersImported=applyBggPlayers(w,d);w.updated_at=new Date().toISOString();save();
  if(!silent){
    const p=playersImported?` · jogadores ${d.minplayers}${d.minplayers!==d.maxplayers?'–'+d.maxplayers:''}`:'';
    $('#bggStatus').textContent=`Associado à wishlist: ${w.bgg_name||w.title}${w.bgg_year?' ('+w.bgg_year+')':''}${p}.`;
    setTimeout(()=>{$('#bggDialog').close();if(view==='wishlist')wishlist();else render()},650)
  }
  return w;
}
async function associateCurrentBggTarget(bggId,{silent=false}={}){
  return bggTargetKind==='wish'?associateWishBgg(bggItemId,bggId,{silent}):associateBgg(bggItemId,bggId,{silent});
}
async function associateByIdFromForm(){const id=$('#itemForm').elements.bgg_id.value.trim();if(!id){alert('Indica primeiro o BGG ID.');return}let target=editItemId;if(!target){alert('Guarda primeiro o item e depois associa-o ao BGG.');return}try{openBggDialog(target,'item');await associateBgg(target,id)}catch(e){$('#bggStatus').textContent='Erro: '+e.message}}
async function autoFindOne(i){
  const token=getToken();if(!token)throw new Error('Sem token BGG.');const r=await helperPost('/api/search',{query:i.title,token}),all=parseSearchXml(r.xml),expected=isExpansion(i)?'boardgameexpansion':'boardgame',rs=all.filter(x=>x.type===expected);if(!rs.length)return {status:'none'};
  const norm=s=>String(s||'').toLocaleLowerCase('pt-PT').normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/[^a-z0-9]+/g,' ').trim();const wanted=norm(i.title);let hit=rs.find(x=>norm(x.name)===wanted);if(!hit)return {status:'ambiguous',count:rs.length};await associateBgg(i.id,hit.id,{silent:true});return {status:'ok',hit};
}
async function autoFindWishOne(w){
  const token=getToken();if(!token)throw new Error('Sem token BGG.');
  const r=await helperPost('/api/search',{query:w.title,token}),all=parseSearchXml(r.xml),expected=w.item_type==='expansion'?'boardgameexpansion':'boardgame',rs=all.filter(x=>x.type===expected);
  if(!rs.length)return {status:'none'};
  const norm=s=>String(s||'').toLocaleLowerCase('pt-PT').normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/[^a-z0-9]+/g,' ').trim();
  const wanted=norm(w.title);let hit=rs.find(x=>norm(x.name)===wanted);
  if(!hit)return {status:'ambiguous',count:rs.length};
  await associateWishBgg(w.id,hit.id,{silent:true});return {status:'ok',hit};
}
async function startBatchBggWishlist(items){
  if(batchRunning)return;
  const token=requireToken();if(!token)return;
  items=(items||[]).filter(w=>w&&!w.bgg_id);
  if(!items.length){alert('Todos os itens da wishlist já têm associação BGG.');return}
  if(!confirm(`Tentar associar automaticamente ${items.length} item(ns) da wishlist em falta?\n\nA app procura correspondências exatas/inequívocas, descarrega a capa e importa o número de jogadores. Casos ambíguos ficam por associar para revisão manual.\n\nO BGG limita a frequência dos pedidos, por isso uma wishlist grande pode demorar bastante. Podes fechar a app e continuar mais tarde; os itens já concluídos ficam guardados.`))return;
  batchRunning=true;let ok=0,amb=0,none=0,err=0;const box=$('#wishBggBatchStatus');
  for(let idx=0;idx<items.length;idx++){
    const w=items[idx];if(!w||w.bgg_id)continue;
    if(box)box.innerHTML=`<div class="progressBox"><b>BGG automático · Wishlist</b><div>${idx+1}/${items.length} · ${esc(w.title)}</div><div class="progressLine"><div style="width:${(idx/items.length)*100}%"></div></div><div>${ok} associados · ${amb} ambíguos · ${none} sem resultado · ${err} erros</div></div>`;
    try{const r=await autoFindWishOne(w);if(r.status==='ok')ok++;else if(r.status==='ambiguous')amb++;else none++}
    catch(e){err++;if(/token|401|403/i.test(e.message)){alert('A ligação ao BGG foi interrompida: '+e.message);break}}
  }
  batchRunning=false;save();
  if(box)box.innerHTML=`<div class="progressBox"><b>Concluído.</b> ${ok} associados · ${amb} ambíguos · ${none} sem resultado · ${err} erros.</div>`;
  if(view==='wishlist')setTimeout(wishlist,1000);
}
async function startBatchBgg(items){
  if(batchRunning)return;const token=requireToken();if(!token)return;if(!items.length){alert('Todos os itens atuais já têm associação BGG.');return}if(!confirm(`Tentar associar automaticamente ${items.length} item(ns) em falta?\n\nJogos base são comparados apenas com jogos base e expansões apenas com expansões. O BGG limita a frequência dos pedidos, por isso o helper respeita esse intervalo.`))return;
  batchRunning=true;let ok=0,amb=0,none=0,err=0;const box=$('#batchStatus');
  for(let idx=0;idx<items.length;idx++){
    const i=items[idx];box.innerHTML=`<div class="progressBox"><b>BGG automático</b><div>${idx+1}/${items.length} · ${esc(i.title)}</div><div class="progressLine"><div style="width:${(idx/items.length)*100}%"></div></div><div>${ok} associados · ${amb} ambíguos · ${none} sem resultado · ${err} erros</div></div>`;
    try{const r=await autoFindOne(i);if(r.status==='ok')ok++;else if(r.status==='ambiguous')amb++;else none++}catch(e){err++;if(/token|401|403/i.test(e.message)){alert('A ligação ao BGG foi interrompida: '+e.message);break}}
  }
  batchRunning=false;save();box.innerHTML=`<div class="progressBox"><b>Concluído.</b> ${ok} associados · ${amb} ambíguos · ${none} sem resultado · ${err} erros.</div>`;setTimeout(()=>{if(view==='collection')collection()},1200);
}

$('#nav').addEventListener('click',e=>{const b=e.target.closest('button[data-view]');if(b)nav(b.dataset.view)});
$('#addItemBtn').onclick=()=>openItem();$('#saveItem').onclick=saveItem;$('#deleteItemFromSheet').onclick=()=>{if(editItemId)removeItem(editItemId)};$('#confirmSale').onclick=confirmSale;$('#saveOperationDate').onclick=saveOperationDate;$('#saveWish').onclick=saveWish;$('#savePrice').onclick=savePrice;$('#quickBackup').onclick=backup;
$('#rankLeft').onclick=()=>answerWishRank('new');$('#rankRight').onclick=()=>answerWishRank('existing');$('#rankTie').onclick=()=>answerWishRank('tie');$('#rankStop').onclick=stopWishRanking;$('#saveManualRank').onclick=saveManualWishRank;
$('#importFile').addEventListener('change',e=>{if(e.target.files[0])restoreFile(e.target.files[0]);e.target.value='' });
$('#itemType').addEventListener('change',updateItemTypeUi);
$('#itemBggSearch').onclick=()=>{if(!editItemId){alert('Guarda primeiro o item. Depois podes associá-lo ao BGG.');return}openBggDialog(editItemId,'item')};
$('#itemBggLoadId').onclick=associateByIdFromForm;
$('#itemBggOpen').onclick=()=>{const id=$('#itemForm').elements.bgg_id.value.trim();if(id)window.open(`https://boardgamegeek.com/boardgame/${encodeURIComponent(id)}`,'_blank','noopener')};
$('#itemManageExpansions').onclick=()=>{if(!editItemId)return;const i=data.items.find(x=>x.id===editItemId);if(!i||!isBase(i))return;$('#itemDialog').close();openExpansions(i.id)};
$('#bggSearchBtn').onclick=searchBgg;$('#bggQuery').addEventListener('keydown',e=>{if(e.key==='Enter'){e.preventDefault();searchBgg()}});
$('#closeBggDialog').onclick=()=>$('#bggDialog').close();$('#closeBggDialog2').onclick=()=>$('#bggDialog').close();
$('#bggSearchWebsite').onclick=()=>window.open(`https://boardgamegeek.com/geeksearch.php?action=search&objecttype=boardgame&q=${encodeURIComponent($('#bggQuery').value.trim())}`,'_blank','noopener');
$('#bggRefreshCurrent').onclick=()=>{const t=bggTargetKind==='wish'?wishById(bggItemId):data.items.find(x=>x.id===Number(bggItemId));if(!t?.bgg_id){$('#bggStatus').textContent='Este item ainda não tem uma associação BGG.';return}associateCurrentBggTarget(t.bgg_id).catch(err=>{$('#bggStatus').textContent='Erro: '+err.message})};
$('#closeExpansionDialog').onclick=()=>$('#expansionDialog').close();$('#closeExpansionDialog2').onclick=()=>$('#expansionDialog').close();
$('#addExpansionManual').onclick=openAddExpansion;$('#discoverBggExpansions').onclick=discoverBggExpansions;$('#saveExpansion').onclick=saveExpansion;$('#expansionForm').elements.expansion_state.addEventListener('change',toggleExpansionSaleFields);
$('#sellForm').addEventListener('input',e=>{if(e.target.matches('[name="sale_price"],.saleExpansionPrice'))updateSaleBundleTotal()});
$('#saleBundleItems').addEventListener('change',e=>{const ch=e.target.closest('.saleExpansionCheck');if(!ch)return;const inp=$(`#sale-exp-price-${ch.dataset.id}`);if(inp)inp.disabled=!ch.checked;updateSaleBundleTotal()});
$('#closeSoldDetail').onclick=()=>$('#soldDetailDialog').close();$('#closeSoldDetail2').onclick=()=>$('#soldDetailDialog').close();
$('#soldDetailBgg').onclick=()=>{const id=$('#soldDetailBgg').dataset.bggid;if(id)window.open(`https://boardgamegeek.com/boardgame/${encodeURIComponent(id)}`,'_blank','noopener')};

document.addEventListener('click',e=>{
  const choose=e.target.closest('.chooseBgg');if(choose){const current=bggTargetKind==='wish'?wishById(bggItemId):data.items.find(x=>x.id===Number(bggItemId));const nextId=String(choose.dataset.bggid);if(current?.bgg_id&&String(current.bgg_id)!==nextId&&!confirm(`Substituir a associação atual (${current.bgg_name||'BGG #'+current.bgg_id}) pelo BGG #${nextId}? A capa e os dados BGG serão atualizados.`))return;associateCurrentBggTarget(nextId).catch(err=>{$('#bggStatus').textContent='Erro: '+err.message});return}
  const addBgg=e.target.closest('.addBggExpansion');if(addBgg){addExpansionFromBgg(addBgg.dataset.bggid,addBgg.dataset.state);return}
  const b=e.target.closest('[data-id]');if(!b)return;const id=+b.dataset.id;
  if(b.classList.contains('openItemSheet')){if($('#soldDetailDialog').open)$('#soldDetailDialog').close();openItem(id);return}
  if(b.classList.contains('openSoldItem')){openSoldDetail(id);return}
  if(b.classList.contains('editOperationDate')){openOperationDate(id,b.dataset.operation);return}
  if(b.classList.contains('manageExp')){openExpansions(id);return}
  if(b.classList.contains('editItem')){if($('#expansionDialog').open)$('#expansionDialog').close();openItem(id);return}
  if(b.classList.contains('sellItem')){if($('#expansionDialog').open)$('#expansionDialog').close();openSell(id);return}
  if(b.classList.contains('removeItem')){removeItem(id);return}
  if(b.classList.contains('bggItem')){if($('#expansionDialog').open)$('#expansionDialog').close();openBggDialog(id,'item');return}
  if(b.classList.contains('wishBgg')){
    const w=wishById(id);if(!w)return;
    if($('#expansionDialog').open)$('#expansionDialog').close();
    openBggDialog(id,'wish');
    return;
  }
  if(b.classList.contains('addPrice')){if($('#expansionDialog').open)$('#expansionDialog').close();openPrice(id);return}
  if(b.classList.contains('editWish')){if($('#expansionDialog').open)$('#expansionDialog').close();openWish(id);return}
  if(b.classList.contains('rankWish')){startWishPositioning(id,'single');return}
  if(b.classList.contains('reRankWish')){if(confirm('Reavaliar este jogo? A posição atual será removida e a app volta a fazer comparações para o reposicionar.'))startWishPositioning(id,'single');return}
  if(b.classList.contains('manualRankWish')){openManualWishRank(id);return}
  if(b.classList.contains('acquireWishExpansion')){if(confirm('Passar esta expansão da wishlist para “Tenho”?'))acquireWishExpansion(id);return}
  if(b.classList.contains('delWish')){const w=data.wishlist.find(x=>x.id===id);if(confirm(`Apagar "${w.title}" da wishlist?`)){removeWishFromRanking(id);data.wishlist=data.wishlist.filter(x=>x.id!==id);data.wishlist_prices=data.wishlist_prices.filter(x=>x.wishlist_id!==id);save();if($('#expansionDialog').open)renderExpansionsModal();render()}return}
});


window.addEventListener('beforeinstallprompt',e=>{e.preventDefault();deferredInstallPrompt=e});
if('serviceWorker' in navigator&&HOSTED_MODE)window.addEventListener('load',()=>navigator.serviceWorker.register('./sw.js').catch(()=>{}));
$('#cloudSaveToken').onclick=testAndSaveGithubToken;
$('#cloudImportBtn').onclick=()=>$('#cloudImportFile').click();
$('#cloudImportFile').addEventListener('change',e=>{if(e.target.files[0])importBaseToGithub(e.target.files[0]);e.target.value=''});
$('#cloudUseLocalBtn').onclick=()=>{$('#cloudSetupDialog').close();nav('settings')};

initializeSharedData().then(()=>{nav('dashboard');updateSyncBadge()});
})();
