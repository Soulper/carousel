-- Carousel Studio schema. Run in Supabase → SQL editor.

create extension if not exists pgcrypto;

-- One row per Instagram page. `brand` holds the whole brand config
-- (logo, colours, fonts, type sizes) — the same object the template reads.
create table if not exists pages (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  handle      text,
  brand       jsonb not null default '{}'::jsonb,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

-- One row per story. `slides` is the slide array the template renders.
create table if not exists stories (
  id            uuid primary key default gen_random_uuid(),
  page_id       uuid not null references pages(id) on delete cascade,
  title         text not null default 'Untitled story',
  status        text not null default 'draft'
                check (status in ('draft','ready','rendered','approved','posted','rejected')),
  hero_variant  text not null default 'depth',
  slides        jsonb not null default '[]'::jsonb,
  source_url    text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
-- What the image sourcer found (filled slots, low-res warning, candidate counts)
alter table stories add column if not exists sourced_at  timestamptz;
alter table stories add column if not exists source_meta jsonb;
-- Where a long job got to, when the host can't keep the request open for it
-- (Netlify): { kind, started_at, finished_at, result } or { ..., error }.
-- The browser polls this while it waits.
alter table stories add column if not exists job         jsonb;
create index if not exists stories_status_idx on stories(status, updated_at desc);
create index if not exists stories_page_idx on stories(page_id, created_at desc);

-- Each render run; `files` = [{ slide, url }]
create table if not exists renders (
  id          uuid primary key default gen_random_uuid(),
  story_id    uuid not null references stories(id) on delete cascade,
  variant     text not null,
  files       jsonb not null,
  created_at  timestamptz not null default now()
);
create index if not exists renders_story_idx on renders(story_id, created_at desc);

create or replace function touch_updated_at() returns trigger as $$
begin new.updated_at = now(); return new; end $$ language plpgsql;
drop trigger if exists pages_touch on pages;
create trigger pages_touch before update on pages for each row execute function touch_updated_at();
drop trigger if exists stories_touch on stories;
create trigger stories_touch before update on stories for each row execute function touch_updated_at();

-- RLS on with no policies: only the server (service role key) can read/write.
alter table pages   enable row level security;
alter table stories enable row level security;
alter table renders enable row level security;

-- Public storage bucket for logos, fonts, story images, cutouts and renders.
-- Public URLs send CORS headers, which the cutout overlap check needs.
insert into storage.buckets (id, name, public)
values ('studio', 'studio', true)
on conflict (id) do nothing;
