
-- Creator Hub (creatorhub) — Supabase SQL baseline
-- Run this in Supabase SQL editor.
-- Then enable Email auth provider in Auth settings.

-- 1) Extensions
create extension if not exists "pgcrypto";

-- 2) Utility: updated_at
create or replace function public._touch_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end $$;

-- 3) Profiles
create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  username text unique,
  bio text,
  avatar_url text,
  featured_reel_url text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

drop trigger if exists _profiles_updated_at on public.profiles;
create trigger _profiles_updated_at
before update on public.profiles
for each row execute function public._touch_updated_at();

-- Auto-create profile row on signup
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, username)
  values (new.id, null)
  on conflict (id) do nothing;
  return new;
end $$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
after insert on auth.users
for each row execute function public.handle_new_user();

-- 4) Packages
create table if not exists public.packages (
  id uuid primary key default gen_random_uuid(),
  owner uuid not null references public.profiles(id) on delete cascade,
  category text not null,
  service text not null,
  title text not null,
  equipment text,
  delivery_days int not null default 7,
  included text,
  addons jsonb,
  price_cents int not null default 0,
  image_urls text[],
  video_url text,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

drop trigger if exists _packages_updated_at on public.packages;
create trigger _packages_updated_at
before update on public.packages
for each row execute function public._touch_updated_at();

-- limit: max 8 packages per owner
create or replace function public.enforce_package_limit()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  n int;
begin
  select count(*) into n from public.packages where owner = new.owner;
  if n >= 8 then
    raise exception 'package limit reached (max 8)';
  end if;
  return new;
end $$;

drop trigger if exists _packages_limit on public.packages;
create trigger _packages_limit
before insert on public.packages
for each row execute function public.enforce_package_limit();

-- 5) Bookings (projects)
create table if not exists public.bookings (
  id uuid primary key default gen_random_uuid(),
  package_id uuid references public.packages(id) on delete set null,
  requester uuid not null references public.profiles(id) on delete cascade,
  creator uuid not null references public.profiles(id) on delete cascade,
  status text not null default 'requested'
    check (status in ('requested','accepted','in_progress','delivered','completed','cancelled')),
  budget_cents int not null default 0,
  message text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

drop trigger if exists _bookings_updated_at on public.bookings;
create trigger _bookings_updated_at
before update on public.bookings
for each row execute function public._touch_updated_at();

-- 6) Follows
create table if not exists public.follows (
  follower uuid not null references public.profiles(id) on delete cascade,
  following uuid not null references public.profiles(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (follower, following)
);

-- 7) Posts (community) - only from completed bookings
create table if not exists public.posts (
  id uuid primary key default gen_random_uuid(),
  author uuid not null references public.profiles(id) on delete cascade,
  booking_id uuid not null references public.bookings(id) on delete cascade,
  body text not null,
  media_url text,
  created_at timestamptz not null default now()
);

create or replace view public.posts_public as
select
  p.id,
  p.author,
  pr.username,
  pr.avatar_url,
  p.booking_id,
  p.body,
  p.media_url,
  p.created_at
from public.posts p
join public.bookings b on b.id = p.booking_id
join public.profiles pr on pr.id = p.author
where b.status = 'completed';

-- 8) RLS
alter table public.profiles enable row level security;
alter table public.packages enable row level security;
alter table public.bookings enable row level security;
alter table public.follows enable row level security;
alter table public.posts enable row level security;

-- Profiles
drop policy if exists "profiles_select_public" on public.profiles;
create policy "profiles_select_public" on public.profiles
for select using (true);

drop policy if exists "profiles_update_self" on public.profiles;
create policy "profiles_update_self" on public.profiles
for update using (auth.uid() = id) with check (auth.uid() = id);

-- Packages
drop policy if exists "packages_select_public_active" on public.packages;
create policy "packages_select_public_active" on public.packages
for select using (is_active = true);

drop policy if exists "packages_insert_owner" on public.packages;
create policy "packages_insert_owner" on public.packages
for insert with check (auth.uid() = owner);

drop policy if exists "packages_update_owner" on public.packages;
create policy "packages_update_owner" on public.packages
for update using (auth.uid() = owner) with check (auth.uid() = owner);

drop policy if exists "packages_delete_owner" on public.packages;
create policy "packages_delete_owner" on public.packages
for delete using (auth.uid() = owner);

-- Bookings
drop policy if exists "bookings_select_participant" on public.bookings;
create policy "bookings_select_participant" on public.bookings
for select using (auth.uid() = requester or auth.uid() = creator);

drop policy if exists "bookings_insert_requester" on public.bookings;
create policy "bookings_insert_requester" on public.bookings
for insert with check (auth.uid() = requester);

drop policy if exists "bookings_update_participant" on public.bookings;
create policy "bookings_update_participant" on public.bookings
for update using (auth.uid() = requester or auth.uid() = creator)
with check (auth.uid() = requester or auth.uid() = creator);

-- Follows
drop policy if exists "follows_select_self" on public.follows;
create policy "follows_select_self" on public.follows
for select using (auth.uid() = follower);

drop policy if exists "follows_insert_self" on public.follows;
create policy "follows_insert_self" on public.follows
for insert with check (auth.uid() = follower);

drop policy if exists "follows_delete_self" on public.follows;
create policy "follows_delete_self" on public.follows
for delete using (auth.uid() = follower);

-- Posts: only author can insert, and only for completed booking they participated in
drop policy if exists "posts_insert_author_completed" on public.posts;
create policy "posts_insert_author_completed" on public.posts
for insert
with check (
  auth.uid() = author
  and exists (
    select 1 from public.bookings b
    where b.id = booking_id
      and b.status = 'completed'
      and (b.requester = auth.uid() or b.creator = auth.uid())
  )
);

drop policy if exists "posts_select_own" on public.posts;
create policy "posts_select_own" on public.posts
for select using (auth.uid() = author);

-- Posts public view is readable if underlying tables allow it.
-- Since packages/profiles are public-select, and posts are only select-own,
-- we rely on the view being read via SECURITY INVOKER. For public feed,
-- read the view. Supabase requires policies on base tables. We'll add:
drop policy if exists "posts_select_public_if_completed" on public.posts;
create policy "posts_select_public_if_completed" on public.posts
for select using (
  exists (select 1 from public.bookings b where b.id = booking_id and b.status = 'completed')
);

-- 9) Helpful indexes
create index if not exists idx_packages_lookup on public.packages (category, service) where is_active = true;
create index if not exists idx_bookings_participants on public.bookings (requester, creator);
create index if not exists idx_posts_created_at on public.posts (created_at desc);


-- 10) Storage (optional but recommended for uploads)
-- Create a PUBLIC bucket for Creator Hub uploads (avatars + package media)
insert into storage.buckets (id, name, public)
values ('creatorhub', 'creatorhub', true)
on conflict (id) do update set public = true;

-- Storage policies (run once)
-- Public can read from the bucket
drop policy if exists "creatorhub_public_read" on storage.objects;
create policy "creatorhub_public_read" on storage.objects
for select using (bucket_id = 'creatorhub');

-- Authenticated users can upload
drop policy if exists "creatorhub_auth_upload" on storage.objects;
create policy "creatorhub_auth_upload" on storage.objects
for insert with check (bucket_id = 'creatorhub' and auth.role() = 'authenticated');

-- Users can update/delete only their own uploads
drop policy if exists "creatorhub_owner_update" on storage.objects;
create policy "creatorhub_owner_update" on storage.objects
for update using (bucket_id = 'creatorhub' and owner = auth.uid())
with check (bucket_id = 'creatorhub' and owner = auth.uid());

drop policy if exists "creatorhub_owner_delete" on storage.objects;
create policy "creatorhub_owner_delete" on storage.objects
for delete using (bucket_id = 'creatorhub' and owner = auth.uid());



-- ===============================
-- Creator Hub v16 patch (messages + calendar + booking wizard fields)
-- Run AFTER your baseline schema.
-- Safe to re-run.
-- ===============================

-- 1) Bookings extra fields (wizard + confirm flow)
alter table public.bookings add column if not exists vision text;
alter table public.bookings add column if not exists addons_selected jsonb;
alter table public.bookings add column if not exists requested_date date;
alter table public.bookings add column if not exists total_cents int;
alter table public.bookings add column if not exists requester_confirmed boolean not null default false;
alter table public.bookings add column if not exists creator_confirmed boolean not null default false;

-- 2) Booking messages
create table if not exists public.booking_messages (
  id uuid primary key default gen_random_uuid(),
  booking_id uuid not null references public.bookings(id) on delete cascade,
  sender uuid not null references public.profiles(id) on delete cascade,
  body text not null,
  is_system boolean not null default false,
  created_at timestamptz not null default now()
);

alter table public.booking_messages enable row level security;

drop policy if exists "booking_messages_select_participant" on public.booking_messages;
create policy "booking_messages_select_participant" on public.booking_messages
for select using (
  exists (
    select 1 from public.bookings b
    where b.id = booking_id
      and (b.requester = auth.uid() or b.creator = auth.uid())
  )
);

drop policy if exists "booking_messages_insert_participant" on public.booking_messages;
create policy "booking_messages_insert_participant" on public.booking_messages
for insert with check (
  auth.uid() = sender
  and exists (
    select 1 from public.bookings b
    where b.id = booking_id
      and (b.requester = auth.uid() or b.creator = auth.uid())
  )
);

-- 3) Availability calendar (simple date list)
create table if not exists public.availability_dates (
  user_id uuid not null references public.profiles(id) on delete cascade,
  day date not null,
  created_at timestamptz not null default now(),
  primary key (user_id, day)
);

alter table public.availability_dates enable row level security;

drop policy if exists "availability_select_public" on public.availability_dates;
create policy "availability_select_public" on public.availability_dates
for select using (true);

drop policy if exists "availability_upsert_self" on public.availability_dates;
create policy "availability_upsert_self" on public.availability_dates
for insert with check (auth.uid() = user_id);

drop policy if exists "availability_delete_self" on public.availability_dates;
create policy "availability_delete_self" on public.availability_dates
for delete using (auth.uid() = user_id);

create index if not exists idx_booking_messages_booking on public.booking_messages (booking_id, created_at);
create index if not exists idx_availability_user_day on public.availability_dates (user_id, day);
