create table if not exists public.portfolio_ai_advice_cache (
  cache_key text primary key,
  payload jsonb not null,
  text text not null,
  generated_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.portfolio_ai_advice_cache enable row level security;

revoke all on table public.portfolio_ai_advice_cache from anon, authenticated;
grant select, insert, update on table public.portfolio_ai_advice_cache to service_role;

create or replace function public.set_portfolio_ai_advice_cache_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

revoke all on function public.set_portfolio_ai_advice_cache_updated_at() from public, anon, authenticated;

drop trigger if exists set_portfolio_ai_advice_cache_updated_at on public.portfolio_ai_advice_cache;
create trigger set_portfolio_ai_advice_cache_updated_at
before update on public.portfolio_ai_advice_cache
for each row
execute function public.set_portfolio_ai_advice_cache_updated_at();
