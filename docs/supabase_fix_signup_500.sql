-- =========================================================
-- CREATORHUB: AUTH + DB FOUNDATION (v2)
-- Fixes: signup/login blocking, profiles schema matches frontend,
-- sane RLS, robust trigger.
-- Safe to run multiple times.
-- =========================================================

create extension if not exists "pgcrypto";

-- PROFILES (match app.js fields)
create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  display_name text not null default 'User',
  city text not null default 'Los Angeles',
  role text not null default 'client', -- client | creator
  onboarded boolean not null default false,
  approved boolean not null default false,
  bio text not null default '',
  portfolio_url text not null default '',
  resume_url text not null default '',
  phone text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Ensure columns exist even if table pre-existed (idempotent)
alter table public.profiles add column if not exists display_name text;
alter table public.profiles add column if not exists city text;
alter table public.profiles add column if not exists role text;
alter table public.profiles add column if not exists onboarded boolean;
alter table public.profiles add column if not exists approved boolean;
alter table public.profiles add column if not exists bio text;
alter table public.profiles add column if not exists portfolio_url text;
alter table public.profiles add column if not exists resume_url text;
alter table public.profiles add column if not exists phone text;
alter table public.profiles add column if not exists created_at timestamptz;
alter table public.profiles add column if not exists updated_at timestamptz;

-- WALLET
create table if not exists public.credits_wallet (
  user_id uuid primary key references auth.users(id) on delete cascade,
  balance bigint not null default 0,
  updated_at timestamptz not null default now()
);

-- updated_at trigger helper
create or replace function public._touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists trg_profiles_touch on public.profiles;
create trigger trg_profiles_touch
before update on public.profiles
for each row execute function public._touch_updated_at();

drop trigger if exists trg_wallet_touch on public.credits_wallet;
create trigger trg_wallet_touch
before update on public.credits_wallet
for each row execute function public._touch_updated_at();

-- Robust new-user handler (never blocks signup)
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  begin
    insert into public.profiles (id, display_name, city, role, onboarded, approved, bio, portfolio_url, resume_url, phone)
    values (
      new.id,
      coalesce(nullif(split_part(coalesce(new.email,''), '@', 1), ''), 'User'),
      'Los Angeles',
      'client',
      false,
      false,
      '',
      '',
      '',
      ''
    )
    on conflict (id) do nothing;
  exception when others then
    null;
  end;

  begin
    insert into public.credits_wallet (user_id, balance)
    values (new.id, 0)
    on conflict (user_id) do nothing;
  exception when others then
    null;
  end;

  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
after insert on auth.users
for each row execute function public.handle_new_user();

-- RLS
alter table public.profiles enable row level security;
alter table public.credits_wallet enable row level security;

drop policy if exists profiles_select_self on public.profiles;
create policy profiles_select_self
on public.profiles
for select
using (id = auth.uid());

drop policy if exists profiles_insert_self on public.profiles;
create policy profiles_insert_self
on public.profiles
for insert
with check (id = auth.uid());

drop policy if exists profiles_update_self on public.profiles;
create policy profiles_update_self
on public.profiles
for update
using (id = auth.uid())
with check (id = auth.uid());

drop policy if exists wallet_select_self on public.credits_wallet;
create policy wallet_select_self
on public.credits_wallet
for select
using (user_id = auth.uid());

drop policy if exists wallet_insert_self on public.credits_wallet;
create policy wallet_insert_self
on public.credits_wallet
for insert
with check (user_id = auth.uid());

drop policy if exists wallet_update_self on public.credits_wallet;
create policy wallet_update_self
on public.credits_wallet
for update
using (user_id = auth.uid())
with check (user_id = auth.uid());

-- Grants (RLS still applies)
grant usage on schema public to anon, authenticated;
grant select, insert, update on public.profiles to anon, authenticated;
grant select, insert, update on public.credits_wallet to anon, authenticated;
