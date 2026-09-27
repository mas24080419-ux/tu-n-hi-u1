const http=require('http');
const crypto=require('crypto');
const {URL}=require('url');

const PORT=process.env.PORT||10000;
const FRONTEND_ORIGIN=process.env.FRONTEND_ORIGIN||'https://energyguard-ai.onrender.com';
const GOOGLE_CLIENT_ID=process.env.GOOGLE_CLIENT_ID||'';
const SESSION_SECRET=process.env.SESSION_SECRET||'';
const SESSION_TTL_SEC=7*24*60*60;
const buckets=new Map();

// Temporary server-side fallback. These maps are intentionally marked non-persistent.
// The API contract mirrors the dedicated Postgres schema so the frontend will not need
// to change when DATABASE_URL is attached to energyguard-auth.
const systemsByUser=new Map();
const runsByUser=new Map();

function cors(req,res){
  const o=req.headers.origin||'';
  const ok=o===FRONTEND_ORIGIN||/^http:\/\/localhost(?::\d+)?$/.test(o)||/^http:\/\/127\.0\.0\.1(?::\d+)?$/.test(o);
  if(ok)res.setHeader('Access-Control-Allow-Origin',o);
  res.setHeader('Vary','Origin');
  res.setHeader('Access-Control-Allow-Methods','GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers','Content-Type,Authorization');
}
function send(res,status,payload){const b=JSON.stringify(payload);res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Content-Length':Buffer.byteLength(b),'Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer'});res.end(b)}
function rate(req){const ip=String(req.headers['x-forwarded-for']||req.socket.remoteAddress||'unknown').split(',')[0].trim();const minute=Math.floor(Date.now()/60000);const k=`${ip}:${minute}`;const n=(buckets.get(k)||0)+1;buckets.set(k,n);if(buckets.size>2000){for(const key of buckets.keys())if(!key.endsWith(`:${minute}`))buckets.delete(key)}return n<=100}
function readJson(req,max=100000){return new Promise((resolve,reject)=>{let raw='';req.on('data',c=>{raw+=c;if(raw.length>max){reject(Object.assign(new Error('Payload too large'),{status:413}));req.destroy()}});req.on('end',()=>{try{resolve(raw?JSON.parse(raw):{})}catch{reject(Object.assign(new Error('Invalid JSON'),{status:400}))}});req.on('error',reject)})}
function b64url(input){return Buffer.from(input).toString('base64url')}
function signPayload(payload){if(!SESSION_SECRET)throw Object.assign(new Error('Session service is not configured.'),{status:503});const body=b64url(JSON.stringify(payload));const sig=crypto.createHmac('sha256',SESSION_SECRET).update(body).digest('base64url');return `${body}.${sig}`}
function verifySession(token){if(!SESSION_SECRET||!token)return null;const parts=token.split('.');if(parts.length!==2)return null;const [body,sig]=parts;const expected=crypto.createHmac('sha256',SESSION_SECRET).update(body).digest('base64url');const a=Buffer.from(sig),b=Buffer.from(expected);if(a.length!==b.length||!crypto.timingSafeEqual(a,b))return null;try{const p=JSON.parse(Buffer.from(body,'base64url').toString('utf8'));if(!p.exp||p.exp<Math.floor(Date.now()/1000))return null;return p}catch{return null}}
function bearer(req){const h=String(req.headers.authorization||'');return h.startsWith('Bearer ')?h.slice(7):''}
function authUser(req){const p=verifySession(bearer(req));if(!p)throw Object.assign(new Error('Invalid or expired session.'),{status:401});return p}
async function fetchJson(url){const ctl=new AbortController();const t=setTimeout(()=>ctl.abort(),12000);try{const r=await fetch(url,{signal:ctl.signal,headers:{'User-Agent':'EnergyGuardAuth/1.1'}});const d=await r.json().catch(()=>({}));if(!r.ok)throw Object.assign(new Error(d.error_description||d.error||`Upstream HTTP ${r.status}`),{status:401});return d}finally{clearTimeout(t)}}
function finite(v,d=0){const n=Number(v);return Number.isFinite(n)?n:d}
function clamp(v,a,b){return Math.max(a,Math.min(b,v))}
function cleanSystem(body={},existing={}){
  return {
    id:String(body.id||existing.id||crypto.randomUUID()),
    name:String(body.name||existing.name||'Hệ thống của tôi').trim().slice(0,80)||'Hệ thống của tôi',
    lat:clamp(finite(body.lat,existing.lat??21.0285),-90,90),
    lon:clamp(finite(body.lon,existing.lon??105.8542),-180,180),
    dailyConsumptionKwh:clamp(finite(body.dailyConsumptionKwh,existing.dailyConsumptionKwh??20),0.1,100000),
    solarKwp:clamp(finite(body.solarKwp,existing.solarKwp??5),0,5000),
    batteryKwh:clamp(finite(body.batteryKwh,existing.batteryKwh??10),0,10000),
    initialSocPct:clamp(finite(body.initialSocPct,existing.initialSocPct??60),0,100),
    evBatteryKwh:clamp(finite(body.evBatteryKwh,existing.evBatteryKwh??60),0,1000),
    evTargetPct:clamp(finite(body.evTargetPct,existing.evTargetPct??80),0,100),
    updatedAt:new Date().toISOString(),
    createdAt:existing.createdAt||new Date().toISOString()
  };
}
function cleanRun(body={}){
  const s=body.summary&&typeof body.summary==='object'?body.summary:{};
  return {
    id:String(body.id||crypto.randomUUID()),
    systemId:body.systemId?String(body.systemId):null,
    systemName:String(body.systemName||'Hệ thống').slice(0,80),
    modelName:String(body.modelName||'unknown').slice(0,120),
    modelVersion:String(body.modelVersion||'').slice(0,120)||null,
    weatherSource:String(body.weatherSource||'').slice(0,120)||null,
    forecastStartedAt:body.forecastStartedAt||new Date().toISOString(),
    horizonHours:clamp(Math.round(finite(body.horizonHours,24)),1,336),
    summary:{
      solarKwh:finite(s.solarKwh,0),loadKwh:finite(s.loadKwh,0),gridImportKwh:finite(s.gridImportKwh,0),gridExportKwh:finite(s.gridExportKwh,0),batteryChargeKwh:finite(s.batteryChargeKwh,0),batteryDischargeKwh:finite(s.batteryDischargeKwh,0),finalSocPct:finite(s.finalSocPct,0),solarCoveragePct:finite(s.solarCoveragePct,0)
    },
    createdAt:new Date().toISOString()
  };
}

async function handler(req,res){
  cors(req,res);if(req.method==='OPTIONS'){res.writeHead(204);return res.end()}
  if(!rate(req))return send(res,429,{error:'Too many requests'});
  const url=new URL(req.url,`http://${req.headers.host||'localhost'}`);const path=url.pathname;
  try{
    if(req.method==='GET'&&path==='/')return send(res,200,{name:'EnergyGuard Auth',version:'1.1.0'});
    if(req.method==='GET'&&path==='/health')return send(res,200,{ok:true,service:'energyguard-auth',googleConfigured:Boolean(GOOGLE_CLIENT_ID),sessionConfigured:Boolean(SESSION_SECRET),storageMode:'memory-fallback'});
    if(req.method==='GET'&&path==='/config')return send(res,200,{googleEnabled:Boolean(GOOGLE_CLIENT_ID),googleClientId:GOOGLE_CLIENT_ID||null,sessionTtlSeconds:SESSION_TTL_SEC});
    if(req.method==='GET'&&path==='/storage/status')return send(res,200,{ok:true,persistent:false,mode:'memory-fallback',database:'energyguard-db',databaseConfigured:false,note:'API contract is ready. Attach DATABASE_URL to enable Postgres persistence.'});
    if(req.method==='POST'&&path==='/google'){
      if(!GOOGLE_CLIENT_ID)return send(res,503,{error:'Google Login is not configured for EnergyGuard yet.'});
      const body=await readJson(req);const credential=String(body.credential||'');if(!credential||credential.length>12000)return send(res,400,{error:'Missing Google credential.'});
      const token=await fetchJson(`https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(credential)}`);
      if(token.aud!==GOOGLE_CLIENT_ID)return send(res,401,{error:'Invalid token audience.'});
      if(!(token.email_verified==='true'||token.email_verified===true))return send(res,401,{error:'Google email is not verified.'});
      const now=Math.floor(Date.now()/1000);const user={sub:token.sub,email:token.email,name:token.name||token.email,picture:token.picture||null};
      const sessionToken=signPayload({iss:'energyguard-auth',sub:user.sub,email:user.email,name:user.name,picture:user.picture,iat:now,exp:now+SESSION_TTL_SEC});
      return send(res,200,{ok:true,user,sessionToken,expiresAt:new Date((now+SESSION_TTL_SEC)*1000).toISOString()});
    }
    if(req.method==='GET'&&path==='/me'){
      const p=authUser(req);return send(res,200,{ok:true,user:{sub:p.sub,email:p.email,name:p.name,picture:p.picture||null},expiresAt:new Date(p.exp*1000).toISOString()});
    }
    if(req.method==='GET'&&path==='/systems'){
      const p=authUser(req);return send(res,200,{ok:true,persistent:false,systems:systemsByUser.get(p.sub)||[]});
    }
    if(req.method==='POST'&&path==='/systems'){
      const p=authUser(req);const body=await readJson(req);const list=[...(systemsByUser.get(p.sub)||[])];
      const idx=list.findIndex(x=>x.id===body.id);const item=cleanSystem(body,idx>=0?list[idx]:{});if(idx>=0)list[idx]=item;else{if(list.length>=20)return send(res,400,{error:'Maximum 20 systems per account in fallback mode.'});list.push(item)}systemsByUser.set(p.sub,list);return send(res,200,{ok:true,persistent:false,system:item});
    }
    if(req.method==='POST'&&path==='/systems/delete'){
      const p=authUser(req);const body=await readJson(req);const id=String(body.id||'');const list=(systemsByUser.get(p.sub)||[]).filter(x=>x.id!==id);systemsByUser.set(p.sub,list);return send(res,200,{ok:true,persistent:false});
    }
    if(req.method==='GET'&&path==='/forecast-runs'){
      const p=authUser(req);const limit=clamp(Math.round(finite(url.searchParams.get('limit'),25)),1,100);return send(res,200,{ok:true,persistent:false,runs:(runsByUser.get(p.sub)||[]).slice(0,limit)});
    }
    if(req.method==='POST'&&path==='/forecast-runs'){
      const p=authUser(req);const item=cleanRun(await readJson(req));const list=[item,...(runsByUser.get(p.sub)||[])].slice(0,100);runsByUser.set(p.sub,list);return send(res,200,{ok:true,persistent:false,run:item});
    }
    if(req.method==='POST'&&path==='/logout')return send(res,200,{ok:true,note:'Session is stateless; client token should be removed. Token expires automatically.'});
    return send(res,404,{error:'Not found'});
  }catch(e){console.error(e);return send(res,e.status||500,{error:e.message||'Internal error'})}
}
http.createServer(handler).listen(PORT,()=>console.log(`EnergyGuard Auth listening on :${PORT}`));
