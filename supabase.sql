-- Zombies Den player accounts: one username per account, no duplicates (ignoring case).
-- Paste this whole file into Supabase > SQL Editor > New query, then press Run.  (Safe to run twice.)

create table if not exists public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  username text not null,
  username_lc text generated always as (lower(username)) stored,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index if not exists profiles_username_lc_key on public.profiles (username_lc);

alter table public.profiles enable row level security;

-- players can read only their own row (the game loads its username with this)
drop policy if exists "own profile" on public.profiles;
create policy "own profile" on public.profiles for select using (auth.uid() = id);

-- the username rules, shared by both functions
create or replace function public.username_valid(name text) returns boolean
language sql immutable as $$
  select name ~ '^[A-Za-z0-9_]{3,14}$';
$$;

-- "is this name free?" - anyone may ask, nobody can list names
create or replace function public.username_available(name text) returns boolean
language sql security definer set search_path = public stable as $$
  select public.username_valid(name)
     and not exists (select 1 from public.profiles p where p.username_lc = lower(name));
$$;

-- take (or change to) a name for the signed-in player; errors with 'taken' if someone has it
create or replace function public.claim_username(name text) returns text
language plpgsql security definer set search_path = public as $$
declare
  uid uuid := auth.uid();
begin
  if uid is null then
    raise exception 'not signed in';
  end if;
  if not public.username_valid(name) then
    raise exception 'invalid name';
  end if;
  insert into public.profiles (id, username) values (uid, name)
    on conflict (id) do update set username = excluded.username, updated_at = now();
  return name;
exception
  when unique_violation then
    raise exception 'taken';
end;
$$;

revoke all on function public.claim_username(text) from public;
grant execute on function public.claim_username(text) to authenticated;
grant execute on function public.username_available(text) to anon, authenticated;
grant execute on function public.username_valid(text) to anon, authenticated;
