import { createClient } from 'npm:@supabase/supabase-js@2';
const SUPABASE_URL=Deno.env.get('SUPABASE_URL')!;
const SERVICE=Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const APP_ID=Deno.env.get('META_APP_ID')!;
const APP_SECRET=Deno.env.get('META_APP_SECRET')!;
const STATE_SECRET=Deno.env.get('META_STATE_SECRET')!;
const TOKEN_KEY=Deno.env.get('META_TOKEN_KEY')!; // base64 32-byte AES key
const FRONTEND=Deno.env.get('FRONTEND_URL')!;
const GRAPH=Deno.env.get('META_GRAPH_VERSION')||'v23.0';
const REDIRECT=`${SUPABASE_URL}/functions/v1/meta-api/callback`;
const admin=createClient(SUPABASE_URL,SERVICE,{auth:{persistSession:false}});
const encoder=new TextEncoder();
const b64=(bytes:Uint8Array)=>btoa(String.fromCharCode(...bytes)).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
const unb64=(value:string)=>Uint8Array.from(atob(value.replace(/-/g,'+').replace(/_/g,'/')+'='.repeat((4-value.length%4)%4)),c=>c.charCodeAt(0));
const key=async(usage:KeyUsage[],algo:'HMAC'|'AES-GCM')=>crypto.subtle.importKey('raw',algo==='HMAC'?encoder.encode(STATE_SECRET):unb64(TOKEN_KEY),algo==='HMAC'?{name:'HMAC',hash:'SHA-256'}:{name:'AES-GCM'},false,usage);
async function sign(data:string){return b64(new Uint8Array(await crypto.subtle.sign('HMAC',await key(['sign'],'HMAC'),encoder.encode(data))))}
async function verify(state:string){const [payload,sig]=state.split('.');if(!payload||!sig)throw Error('Estado inválido');const ok=await crypto.subtle.verify('HMAC',await key(['verify'],'HMAC'),unb64(sig),encoder.encode(payload));if(!ok)throw Error('Estado inválido');const obj=JSON.parse(new TextDecoder().decode(unb64(payload)));if(Date.now()>obj.exp||obj.exp-Date.now()>12*60*1000)throw Error('Estado caducado');return obj as {uid:string;brand:string;exp:number}}
async function encrypt(value:string){const iv=crypto.getRandomValues(new Uint8Array(12));const cipher=new Uint8Array(await crypto.subtle.encrypt({name:'AES-GCM',iv},await key(['encrypt'],'AES-GCM'),encoder.encode(value)));return `${b64(iv)}.${b64(cipher)}`}
async function graph(path:string,params:Record<string,string>){const u=new URL(`https://graph.facebook.com/${GRAPH}/${path}`);Object.entries(params).forEach(([k,v])=>u.searchParams.set(k,v));const r=await fetch(u);const data=await r.json();if(!r.ok||data.error)throw Error(data.error?.message||`Meta HTTP ${r.status}`);return data}
const cors={'Access-Control-Allow-Origin':FRONTEND.replace(/\/$/,''),'Access-Control-Allow-Headers':'authorization, apikey, content-type','Access-Control-Allow-Methods':'GET, POST, OPTIONS'};
const json=(obj:unknown,status=200)=>new Response(JSON.stringify(obj),{status,headers:{...cors,'Content-Type':'application/json'}});
async function getUser(req:Request){const auth=req.headers.get('authorization')||'';if(!auth.startsWith('Bearer '))throw Error('Debes iniciar sesión');const client=createClient(SUPABASE_URL,Deno.env.get('SUPABASE_ANON_KEY')!,{global:{headers:{Authorization:auth}}});const {data,error}=await client.auth.getUser();if(error||!data.user)throw Error('Sesión inválida');return data.user.id}
async function checkBrand(uid:string,brand:string){const {data}=await admin.from('studio_brands').select('id').eq('id',brand).eq('user_id',uid).single();if(!data)throw Error('Marca no encontrada')}
Deno.serve(async(req)=>{
 if(req.method==='OPTIONS')return new Response(null,{headers:cors});
 try{
  const url=new URL(req.url),route=url.pathname.split('/').pop();
  if(route==='callback'){
   const state=await verify(url.searchParams.get('state')||'');
   if(url.searchParams.get('error'))throw Error('Meta no autorizó la conexión');
   await checkBrand(state.uid,state.brand);
   const code=url.searchParams.get('code');if(!code)throw Error('Falta código OAuth');
   const short=await graph('oauth/access_token',{client_id:APP_ID,client_secret:APP_SECRET,redirect_uri:REDIRECT,code});
   const long=await graph('oauth/access_token',{grant_type:'fb_exchange_token',client_id:APP_ID,client_secret:APP_SECRET,fb_exchange_token:short.access_token});
   const pages=await graph('me/accounts',{fields:'id,name,access_token,instagram_business_account{id,username}',limit:'100',access_token:long.access_token});
   let count=0;
   for(const page of pages.data||[]){
    const base={user_id:state.uid,brand_id:state.brand,page_id:page.id,page_name:page.name,updated_at:new Date().toISOString()};
    for(const platform of (page.instagram_business_account?['Facebook','Instagram']:['Facebook'])){
     const {error}=await admin.from('studio_meta_connections').upsert({...base,platform,ig_user_id:platform==='Instagram'?page.instagram_business_account.id:null,token_ciphertext:await encrypt(page.access_token)},{onConflict:'user_id,brand_id,platform,page_id'});
     if(error)throw error;count++;
    }
   }
   const back=new URL(FRONTEND);back.searchParams.set('meta',count?'connected':'no-pages');return Response.redirect(back.toString(),302);
  }
  const uid=await getUser(req);
  if(route==='start'){
   const {brand_id}=await req.json();await checkBrand(uid,brand_id);
   const payload=b64(encoder.encode(JSON.stringify({uid,brand:brand_id,exp:Date.now()+10*60*1000,nonce:crypto.randomUUID()})));
   const state=`${payload}.${await sign(payload)}`;
   const u=new URL(`https://www.facebook.com/${GRAPH}/dialog/oauth`);
   Object.entries({client_id:APP_ID,redirect_uri:REDIRECT,state,response_type:'code',scope:'pages_show_list,pages_read_engagement,pages_manage_posts,instagram_basic,instagram_content_publish'}).forEach(([k,v])=>u.searchParams.set(k,v));
   return json({url:u.toString()});
  }
  const brand=url.searchParams.get('brand_id');if(!brand)throw Error('Falta brand_id');await checkBrand(uid,brand);
  if(route==='accounts'){
   const {data,error}=await admin.from('studio_meta_connections').select('id,platform,page_name,ig_user_id').eq('user_id',uid).eq('brand_id',brand);
   if(error)throw error;return json({accounts:data});
  }
  if(route==='jobs'){
   const {data,error}=await admin.from('studio_meta_jobs').select('id,title,scheduled_at,status,last_error,published_id,platform:studio_meta_connections(platform,page_name)').eq('user_id',uid).eq('brand_id',brand).order('created_at',{ascending:false}).limit(50);
   if(error)throw error;return json({jobs:data});
  }
  if(route==='schedule'&&req.method==='POST'){
   const body=await req.json();const {connection_id,local_post_id,title,caption,media_url,media_kind,scheduled_at}=body;
   const {data:conn}=await admin.from('studio_meta_connections').select('id,platform').eq('id',connection_id).eq('user_id',uid).eq('brand_id',brand).single();if(!conn)throw Error('Cuenta no autorizada para esta marca');
   const date=new Date(scheduled_at);if(!Number.isFinite(date.getTime())||date.getTime()<Date.now()+60000)throw Error('Programa con al menos un minuto de anticipación');
   if(!String(title||'').trim()||String(title).length>150||String(caption||'').length>2200)throw Error('Título o copy inválido');
   if(!['image','reel'].includes(media_kind))throw Error('Tipo de medio inválido');
   if(conn.platform==='Instagram'&&!media_url)throw Error('Instagram requiere URL pública HTTPS de imagen o video');
   if(media_url){const u=new URL(media_url);if(u.protocol!=='https:'||['localhost','127.0.0.1'].includes(u.hostname))throw Error('El medio debe tener una URL HTTPS pública');}
   const {data,error}=await admin.from('studio_meta_jobs').insert({user_id:uid,brand_id:brand,connection_id,local_post_id:String(local_post_id||''),title:String(title).slice(0,150),caption:String(caption||''),media_url:media_url||null,media_kind,scheduled_at:date.toISOString()}).select('id,status').single();
   if(error)throw error;return json({job:data});
  }
  if(route==='cancel'&&req.method==='POST'){
   const {job_id}=await req.json();const {data,error}=await admin.from('studio_meta_jobs').update({status:'cancelled',updated_at:new Date().toISOString()}).eq('id',job_id).eq('user_id',uid).eq('brand_id',brand).eq('status','queued').select('id').maybeSingle();if(error)throw error;return json({cancelled:!!data});
  }
  return json({error:'Ruta no encontrada'},404);
 }catch(e){console.error(e);return json({error:e instanceof Error?e.message:'Error inesperado'},400)}
});
