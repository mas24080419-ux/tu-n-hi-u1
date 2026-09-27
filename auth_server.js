const http=require('http');
const crypto=require('crypto');
const {URL}=require('url');

const PORT=process.env.PORT||10000;
const FRONTEND_ORIGIN=process.env.FRONTEND_ORIGIN||'https://energyguard-ai.onrender.com';
const GOOGLE_CLIENT_ID=process.env.GOOGLE_CLIENT_ID||'';
const SESSION_SECRET=process.env.SESSION_SECRET||'';
const SESSION_TTL_SEC=7*24*60*60;
const buckets=new Map();

function cors(req,res){
  const o=req.headers.origin||'';
  const ok=o===FRONTEND_ORIGIN||/^http:\/\/localhost(?::\d+)?$/.test(o)||/^http:\/\/127\.0\.0\.1(?::\d+)?$/.test(o);
  if(ok)res.setHeader('Access-Control-Allow-Origin',o);
  res.setHeader('Vary','Origin');
  res.setHeader('Access-Control-Allow-Methods','GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers','Content-Type,Authorization');
}
function send(res,status,payload){const b=JSON.stringify(payload);res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Content-Length':Buffer.byteLength(b),'Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer'});res.end(b)}
function rate(req){const ip=String(req.headers['x-forwarded-for']||req.socket.remoteAddress||'unknown').split(',')[0].trim();const minute=Math.floor(Date.now()/60000);const k=`${ip}:${minute}`;const n=(buckets.get(k)||0)+1;buckets.set(k,n);if(buckets.size>2000){for(const key of buckets.keys())if(!key.endsWith(`:${minute}`))buckets.delete(key)}return n<=80}
function readJson(req,max=32000){return new Promise((resolve,reject)=>{let raw='';req.on('data',c=>{raw+=c;if(raw.length>max){reject(Object.assign(new Error('Payload too large'),{status:413}));req.destroy()}});req.on('end',()=>{try{resolve(raw?JSON.parse(raw):{})}catch{reject(Object.assign(new Error('Invalid JSON'),{status:400}))}});req.on('error',reject)})}
function b64url(input){return Buffer.from(input).toString('base64url')}
function signPayload(payload){if(!SESSION_SECRET)throw Object.assign(new Error('Session service is not configured.'),{status:503});const body=b64url(JSON.stringify(payload));const sig=crypto.createHmac('sha256',SESSION_SECRET).update(body).digest('base64url');return `${body}.${sig}`}
function verifySession(token){if(!SESSION_SECRET||!token)return null;const parts=token.split('.');if(parts.length!==2)return null;const [body,sig]=parts;const expected=crypto.createHmac('sha256',SESSION_SECRET).update(body).digest('base64url');const a=Buffer.from(sig),b=Buffer.from(expected);if(a.length!==b.length||!crypto.timingSafeEqual(a,b))return null;try{const p=JSON.parse(Buffer.from(body,'base64url').toString('utf8'));if(!p.exp||p.exp<Math.floor(Date.now()/1000))return null;return p}catch{return null}}
function bearer(req){const h=String(req.headers.authorization||'');return h.startsWith('Bearer ')?h.slice(7):''}
async function fetchJson(url){const ctl=new AbortController();const t=setTimeout(()=>ctl.abort(),12000);try{const r=await fetch(url,{signal:ctl.signal,headers:{'User-Agent':'EnergyGuardAuth/1.0'}});const d=await r.json().catch(()=>({}));if(!r.ok)throw Object.assign(new Error(d.error_description||d.error||`Upstream HTTP ${r.status}`),{status:401});return d}finally{clearTimeout(t)}}

async function handler(req,res){
  cors(req,res);if(req.method==='OPTIONS'){res.writeHead(204);return res.end()}
  if(!rate(req))return send(res,429,{error:'Too many requests'});
  const url=new URL(req.url,`http://${req.headers.host||'localhost'}`);const path=url.pathname;
  try{
    if(req.method==='GET'&&path==='/')return send(res,200,{name:'EnergyGuard Auth',version:'1.0.0'});
    if(req.method==='GET'&&path==='/health')return send(res,200,{ok:true,service:'energyguard-auth',googleConfigured:Boolean(GOOGLE_CLIENT_ID),sessionConfigured:Boolean(SESSION_SECRET)});
    if(req.method==='GET'&&path==='/config')return send(res,200,{googleEnabled:Boolean(GOOGLE_CLIENT_ID),googleClientId:GOOGLE_CLIENT_ID||null,sessionTtlSeconds:SESSION_TTL_SEC});
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
      const p=verifySession(bearer(req));if(!p)return send(res,401,{error:'Invalid or expired session.'});
      return send(res,200,{ok:true,user:{sub:p.sub,email:p.email,name:p.name,picture:p.picture||null},expiresAt:new Date(p.exp*1000).toISOString()});
    }
    if(req.method==='POST'&&path==='/logout')return send(res,200,{ok:true,note:'Session is stateless; client token should be removed. Token expires automatically.'});
    return send(res,404,{error:'Not found'});
  }catch(e){console.error(e);return send(res,e.status||500,{error:e.message||'Internal error'})}
}
http.createServer(handler).listen(PORT,()=>console.log(`EnergyGuard Auth listening on :${PORT}`));
