import { createClient } from 'npm:@supabase/supabase-js@2';
const env=(k:string)=>{const v=Deno.env.get(k);if(!v)throw Error(`Falta ${k}`);return v};
const sb=createClient(env('SUPABASE_URL'),env('SUPABASE_SERVICE_ROLE_KEY'));
const GRAPH=Deno.env.get('META_GRAPH_VERSION')||'v23.0';
const b64=(s:string)=>Uint8Array.from(atob(s.replace(/-/g,'+').replace(/_/g,'/')+'='.repeat((4-s.length%4)%4)),c=>c.charCodeAt(0));
async function decrypt(cipher:string){const [iv,data]=cipher.split('.');const key=await crypto.subtle.importKey('raw',b64(env('META_TOKEN_KEY')),{name:'AES-GCM'},false,['decrypt']);return new TextDecoder().decode(await crypto.subtle.decrypt({name:'AES-GCM',iv:b64(iv)},key,b64(data)))}
async function graph(id:string,method:'GET'|'POST',token:string,params:Record<string,string>){const url=new URL(`https://graph.facebook.com/${GRAPH}/${id}`);const body=new URLSearchParams({...params,access_token:token});let res:Response;if(method==='GET'){url.search=body.toString();res=await fetch(url)}else{res=await fetch(url,{method:'POST',body})}const data=await res.json();if(!res.ok||data.error)throw Error(data.error?.message||`Meta HTTP ${res.status}`);return data}
async function publish(job:any,conn:any){const token=await decrypt(conn.token_ciphertext);
 if(conn.platform==='Facebook'){
  if(job.media_kind==='reel')throw Error('Reels de Facebook aún no habilitados en esta versión; usa imagen o texto');
  if(job.media_url){const data=await graph(`${conn.page_id}/photos`,'POST',token,{url:job.media_url,caption:job.caption||job.title,published:'true'});return data.post_id||data.id}
  const data=await graph(`${conn.page_id}/feed`,'POST',token,{message:job.caption||job.title});return data.id;
 }
 if(!job.media_url||!conn.ig_user_id)throw Error('Instagram requiere cuenta profesional vinculada y medio público');
 const params:Record<string,string>={caption:job.caption||job.title};
 if(job.media_kind==='reel'){params.media_type='REELS';params.video_url=job.media_url;params.share_to_feed='true'}else params.image_url=job.media_url;
 const container=await graph(`${conn.ig_user_id}/media`,'POST',token,params);
 if(job.media_kind==='reel'){
  let ready=false;
  for(let n=0;n<12;n++){await new Promise(r=>setTimeout(r,5000));const check=await graph(container.id,'GET',token,{fields:'status_code'});if(check.status_code==='FINISHED'){ready=true;break}if(check.status_code==='ERROR'||check.status_code==='EXPIRED')throw Error('Meta no pudo procesar el video')}
  if(!ready)throw Error('Video aún procesándose: revisa el contenedor antes de reintentar para evitar duplicados');
 }
 const result=await graph(`${conn.ig_user_id}/media_publish`,'POST',token,{creation_id:container.id});return result.id;
}
Deno.serve(async(req)=>{
 if(req.method!=='POST')return new Response('Method not allowed',{status:405});
 const supplied=req.headers.get('x-cron-secret')||'';
 if(!supplied||supplied!==env('META_CRON_SECRET'))return new Response('Unauthorized',{status:401});
 const {data:jobs,error}=await sb.rpc('studio_meta_claim_jobs',{batch_size:5});if(error)return Response.json({error:error.message},{status:500});
 const results=[];
 for(const job of jobs||[]){
  try{
   const {data:conn,error:ce}=await sb.from('studio_meta_connections').select('*').eq('id',job.connection_id).single();if(ce||!conn)throw Error('Cuenta desconectada');
   const id=await publish(job,conn);
   await sb.from('studio_meta_jobs').update({status:'published',published_id:id,last_error:null,updated_at:new Date().toISOString()}).eq('id',job.id);
   results.push({id:job.id,status:'published'});
  }catch(e){const message=String(e instanceof Error?e.message:e).slice(0,500);
   // Fail closed. Never auto-retry uncertain network failures: duplicate posts are possible.
   await sb.from('studio_meta_jobs').update({status:'failed',last_error:message,updated_at:new Date().toISOString()}).eq('id',job.id);
   results.push({id:job.id,status:'failed',error:message});
  }
 }
 return Response.json({results});
});
