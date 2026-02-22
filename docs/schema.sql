-- =========================================================
-- CREATORHUB: FULL MVP SCHEMA (v3)
-- Includes: profiles + wallet + packages + bookings/projects + messages + deliveries + posts
-- Safe to run multiple times.
-- =========================================================

create extension if not exists "pgcrypto";

-- ------------------------- PROFILES -------------------------
create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  display_name text not null default 'User',
  city text not null default 'Los Angeles',
  role text not null default 'client', -- client | creator
  onboarded boolean not null default false,
  approved boolean not null default false,
  avatar_url text not null default '',
  bio text not null default '',
  portfolio_url text not null default '',
  resume_url text not null default '',
  phone text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.profiles add column if not exists display_name text;
alter table public.profiles add column if not exists city text;
alter table public.profiles add column if not exists role text;
alter table public.profiles add column if not exists onboarded boolean;
alter table public.profiles add column if not exists approved boolean;
alter table public.profiles add column if not exists avatar_url text;
alter table public.profiles add column if not exists bio text;
alter table public.profiles add column if not exists portfolio_url text;
alter table public.profiles add column if not exists resume_url text;
alter table public.profiles add column if not exists phone text;
alter table public.profiles add column if not exists created_at timestamptz;
alter table public.profiles add column if not exists updated_at timestamptz;

-- ------------------------- WALLET -------------------------
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
    insert into public.profiles (id, display_name, city, role, onboarded, approved, avatar_url, bio, portfolio_url, resume_url, phone)
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

-- ------------------------- PACKAGES (Creators) -------------------------
create table if not exists public.packages (
  id uuid primary key default gen_random_uuid(),
  creator_id uuid not null references public.profiles(id) on delete cascade,
  service text not null,
  tier text not null,
  title text not null,
  price_credits bigint not null default 0,
  delivery_days int,
  hours text not null default '',
  locations text not null default '',
  revisions text not null default '',
  includes text not null default '',
  addons text not null default '',
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (creator_id, service, tier)
);

drop trigger if exists trg_packages_touch on public.packages;
create trigger trg_packages_touch
before update on public.packages
for each row execute function public._touch_updated_at();

-- ------------------------- BOOKINGS (Projects) -------------------------
create table if not exists public.bookings (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references public.profiles(id) on delete cascade,
  status text not null default 'requested',
  requested_date timestamptz,
  notes text not null default '',
  total_credits bigint not null default 0,
  funded boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  delivered_at timestamptz,
  approved_at timestamptz
);

drop trigger if exists trg_bookings_touch on public.bookings;
create trigger trg_bookings_touch
before update on public.bookings
for each row execute function public._touch_updated_at();

-- One booking can target one creator/package for MVP
create table if not exists public.booking_creators (
  booking_id uuid primary key references public.bookings(id) on delete cascade,
  creator_id uuid not null references public.profiles(id) on delete cascade,
  package_id uuid references public.packages(id) on delete set null,
  price_credits bigint not null default 0,
  created_at timestamptz not null default now()
);

-- Convenience views expected by app.js
create or replace view public.booking_lines as
select
  bc.booking_id,
  bc.creator_id,
  bc.package_id,
  bc.price_credits,
  p.service,
  p.tier,
  p.title as package_title,
  pr.display_name as creator_name
from public.booking_creators bc
left join public.packages p on p.id = bc.package_id
left join public.profiles pr on pr.id = bc.creator_id;

create or replace view public.booking_card_client as
select
  b.id,
  b.client_id,
  b.status,
  b.requested_date,
  b.total_credits,
  b.created_at,
  b.notes,
  bl.service,
  bl.tier,
  bl.package_title as title_line,
  bl.creator_name as counterparty_name
from public.bookings b
left join public.booking_lines bl on bl.booking_id = b.id;

create or replace view public.booking_card_creator as
select
  b.id,
  bc.creator_id,
  b.status,
  b.requested_date,
  b.total_credits,
  b.created_at,
  b.notes,
  bl.service,
  bl.tier,
  bl.package_title as title_line,
  (select display_name from public.profiles pr where pr.id = b.client_id) as counterparty_name
from public.bookings b
join public.booking_creators bc on bc.booking_id = b.id
left join public.booking_lines bl on bl.booking_id = b.id;

-- Messages + deliveries
create table if not exists public.messages (
  id uuid primary key default gen_random_uuid(),
  booking_id uuid not null references public.bookings(id) on delete cascade,
  sender_id uuid not null references public.profiles(id) on delete cascade,
  body text not null,
  created_at timestamptz not null default now()
);

create table if not exists public.deliveries (
  id uuid primary key default gen_random_uuid(),
  booking_id uuid not null references public.bookings(id) on delete cascade,
  link text not null,
  note text not null default '',
  created_at timestamptz not null default now()
);

-- ------------------------- POSTS (Global community feed) -------------------------
create table if not exists public.posts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  title text not null default '',
  body text not null,
  created_at timestamptz not null default now()
);

create or replace view public.posts_public as
select
  p.id,
  p.user_id,
  p.title,
  p.body,
  p.created_at,
  pr.display_name,
  pr.city,
  pr.avatar_url,
  0::bigint as likes_count
from public.posts p
join public.profiles pr on pr.id = p.user_id;

-- =========================================================
-- RLS POLICIES
-- =========================================================

-- PROFILES
alter table public.profiles enable row level security;

-- Self access
drop policy if exists profiles_select_self on public.profiles;
create policy profiles_select_self on public.profiles
for select using (id = auth.uid());

drop policy if exists profiles_insert_self on public.profiles;
create policy profiles_insert_self on public.profiles
for insert with check (id = auth.uid());

drop policy if exists profiles_update_self on public.profiles;
create policy profiles_update_self on public.profiles
for update using (id = auth.uid()) with check (id = auth.uid());

-- Public creator profiles (for feeds/search)
drop policy if exists profiles_select_public_creators on public.profiles;
create policy profiles_select_public_creators on public.profiles
for select
using (approved = true and role = 'creator');

-- WALLET
alter table public.credits_wallet enable row level security;

drop policy if exists wallet_select_self on public.credits_wallet;
create policy wallet_select_self on public.credits_wallet
for select using (user_id = auth.uid());

drop policy if exists wallet_insert_self on public.credits_wallet;
create policy wallet_insert_self on public.credits_wallet
for insert with check (user_id = auth.uid());

drop policy if exists wallet_update_self on public.credits_wallet;
create policy wallet_update_self on public.credits_wallet
for update using (user_id = auth.uid()) with check (user_id = auth.uid());

-- PACKAGES
alter table public.packages enable row level security;

drop policy if exists packages_select_public on public.packages;
create policy packages_select_public on public.packages
for select
using (
  active = true
  and exists (
    select 1 from public.profiles pr
    where pr.id = creator_id and pr.approved = true and pr.role = 'creator'
  )
);

drop policy if exists packages_select_self on public.packages;
create policy packages_select_self on public.packages
for select using (creator_id = auth.uid());

drop policy if exists packages_insert_self on public.packages;
create policy packages_insert_self on public.packages
for insert with check (creator_id = auth.uid());

drop policy if exists packages_update_self on public.packages;
create policy packages_update_self on public.packages
for update using (creator_id = auth.uid()) with check (creator_id = auth.uid());

-- BOOKINGS
alter table public.bookings enable row level security;

-- Client can insert their own booking
drop policy if exists bookings_insert_client on public.bookings;
create policy bookings_insert_client on public.bookings
for insert with check (client_id = auth.uid());

-- Participants can read
drop policy if exists bookings_select_participants on public.bookings;
create policy bookings_select_participants on public.bookings
for select using (
  client_id = auth.uid()
  or exists (select 1 from public.booking_creators bc where bc.booking_id = id and bc.creator_id = auth.uid())
);

-- Participants can update (simple MVP)
drop policy if exists bookings_update_participants on public.bookings;
create policy bookings_update_participants on public.bookings
for update using (
  client_id = auth.uid()
  or exists (select 1 from public.booking_creators bc where bc.booking_id = id and bc.creator_id = auth.uid())
) with check (
  client_id = (select client_id from public.bookings b2 where b2.id = id)
);

-- BOOKING_CREATORS
alter table public.booking_creators enable row level security;

drop policy if exists booking_creators_insert_client on public.booking_creators;
create policy booking_creators_insert_client on public.booking_creators
for insert with check (
  exists (select 1 from public.bookings b where b.id = booking_id and b.client_id = auth.uid())
);

drop policy if exists booking_creators_select_participants on public.booking_creators;
create policy booking_creators_select_participants on public.booking_creators
for select using (
  creator_id = auth.uid()
  or exists (select 1 from public.bookings b where b.id = booking_id and b.client_id = auth.uid())
);

-- MESSAGES
alter table public.messages enable row level security;

drop policy if exists messages_select_participants on public.messages;
create policy messages_select_participants on public.messages
for select using (
  exists (select 1 from public.bookings b where b.id = booking_id and (b.client_id = auth.uid() or exists (select 1 from public.booking_creators bc where bc.booking_id = b.id and bc.creator_id = auth.uid())))
);

drop policy if exists messages_insert_sender on public.messages;
create policy messages_insert_sender on public.messages
for insert with check (
  sender_id = auth.uid()
  and exists (select 1 from public.bookings b where b.id = booking_id and (b.client_id = auth.uid() or exists (select 1 from public.booking_creators bc where bc.booking_id = b.id and bc.creator_id = auth.uid())))
);

-- DELIVERIES
alter table public.deliveries enable row level security;

drop policy if exists deliveries_select_participants on public.deliveries;
create policy deliveries_select_participants on public.deliveries
for select using (
  exists (select 1 from public.bookings b where b.id = booking_id and (b.client_id = auth.uid() or exists (select 1 from public.booking_creators bc where bc.booking_id = b.id and bc.creator_id = auth.uid())))
);

drop policy if exists deliveries_insert_creator on public.deliveries;
create policy deliveries_insert_creator on public.deliveries
for insert with check (
  exists (select 1 from public.booking_creators bc where bc.booking_id = booking_id and bc.creator_id = auth.uid())
);

-- POSTS
alter table public.posts enable row level security;

drop policy if exists posts_select_public on public.posts;
create policy posts_select_public on public.posts
for select using (true);

drop policy if exists posts_insert_self on public.posts;
create policy posts_insert_self on public.posts
for insert with check (user_id = auth.uid());

drop policy if exists posts_delete_self on public.posts;
create policy posts_delete_self on public.posts
for delete using (user_id = auth.uid());

-- Grants (RLS still applies)
grant usage on schema public to anon, authenticated;
grant select, insert, update, delete on public.posts to anon, authenticated;
grant select, insert, update on public.profiles to anon, authenticated;
grant select, insert, update on public.credits_wallet to anon, authenticated;
grant select, insert, update on public.packages to anon, authenticated;
grant select, insert, update on public.bookings to anon, authenticated;
grant select, insert on public.booking_creators to anon, authenticated;
grant select, insert on public.messages to anon, authenticated;
grant select, insert on public.deliveries to anon, authenticated;

