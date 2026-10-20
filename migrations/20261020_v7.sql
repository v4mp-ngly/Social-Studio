-- Social Studio V7: execute after schema_v5.sql
create extension if not exists pgcrypto;
create table if not exists public.studio_meta_connections (
 id uuid primary key default gen_random_uuid(), user_id uuid not null references auth.users(id) on delete cascade,
 brand_id uuid not null references public.studio_brands(id) on delete cascade,
 platform text not null check(platform in ('Facebook','Instagram')),
 page_id text not null, page_name text not null,
 ig_user_id text, token_ciphertext text not null,
 created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
 unique(user_id,brand_id,platform,page_id)
);
create table if not exists public.studio_meta_jobs (
 id uuid primary key default gen_random_uuid(), user_id uuid not null references auth.users(id) on delete cascade,
 brand_id uuid not null references public.studio_brands(id) on delete cascade,
 connection_id uuid not null references public.studio_meta_connections(id) on delete cascade,
 local_post_id text not null, title text not null, caption text not null default '',
 media_url text, media_kind text not null default 'image' check(media_kind in ('image','reel')),
 scheduled_at timestamptz not null,
 status text not null default 'queued' check(status in ('queued','processing','published','failed','cancelled')),
 attempts int not null default 0, locked_at timestamptz, published_id text, last_error text,
 created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create index if not exists studio_meta_jobs_due on public.studio_meta_jobs(scheduled_at) where status='queued';
alter table public.studio_meta_connections enable row level security;
alter table public.studio_meta_jobs enable row level security;
-- Never expose encrypted tokens to client through direct table SELECT.
revoke all on public.studio_meta_connections from anon, authenticated;
revoke all on public.studio_meta_jobs from anon, authenticated;
-- Atomic job claiming by worker (service_role only)
create or replace function public.studio_meta_claim_jobs(batch_size int default 5)
returns setof public.studio_meta_jobs language sql security definer set search_path=public
as $$
 update public.studio_meta_jobs j set status='processing',locked_at=now(),attempts=j.attempts+1,updated_at=now()
 where j.id in (select id from public.studio_meta_jobs where status='queued' and scheduled_at<=now() order by scheduled_at limit least(greatest(batch_size,1),10) for update skip locked)
 returning j.*;
$$;
revoke all on function public.studio_meta_claim_jobs(int) from public, anon, authenticated;
grant execute on function public.studio_meta_claim_jobs(int) to service_role;
