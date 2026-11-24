-- 公园打卡地图：云同步用的表
-- 在 Supabase 后台的 SQL Editor 里整段粘贴，点 Run。重复运行也没问题。

create table if not exists public.checkins (
  user_id    uuid        not null default auth.uid() references auth.users (id) on delete cascade,
  park_id    text        not null,             -- 页面里的公园 id，例如 "p|和田堀公園"
  name       text,                             -- 公园名，方便在后台直接看
  date       date,                             -- 打卡日期，可以为空
  note       text        not null default '',
  deleted    boolean     not null default false, -- 取消打卡时为 true，让其他设备也知道
  updated_at timestamptz not null default now(), -- 在设备上修改的时间，新的覆盖旧的
  primary key (user_id, park_id)
);

-- 每个人只能读写自己的记录
alter table public.checkins enable row level security;

drop policy if exists "read own checkins"   on public.checkins;
drop policy if exists "insert own checkins" on public.checkins;
drop policy if exists "update own checkins" on public.checkins;
drop policy if exists "delete own checkins" on public.checkins;

create policy "read own checkins"   on public.checkins for select to authenticated using ((select auth.uid()) = user_id);
create policy "insert own checkins" on public.checkins for insert to authenticated with check ((select auth.uid()) = user_id);
create policy "update own checkins" on public.checkins for update to authenticated using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
create policy "delete own checkins" on public.checkins for delete to authenticated using ((select auth.uid()) = user_id);

-- 只给登录用户开放这张表，未登录的访问者什么都读不到
revoke all on public.checkins from anon;
grant select, insert, update, delete on public.checkins to authenticated;

-- ===== 一生足迹的足迹文件（2026-11 新增） =====
-- 私有存储桶：每个账号只能读写自己文件夹（文件夹名 = 账号 id）里的足迹文件。
insert into storage.buckets (id, name, public)
values ('footprints', 'footprints', false)
on conflict (id) do nothing;

drop policy if exists "read own footprint"   on storage.objects;
drop policy if exists "insert own footprint" on storage.objects;
drop policy if exists "update own footprint" on storage.objects;
drop policy if exists "delete own footprint" on storage.objects;

create policy "read own footprint" on storage.objects for select to authenticated
  using (bucket_id = 'footprints' and (storage.foldername(name))[1] = (select auth.uid())::text);
create policy "insert own footprint" on storage.objects for insert to authenticated
  with check (bucket_id = 'footprints' and (storage.foldername(name))[1] = (select auth.uid())::text);
create policy "update own footprint" on storage.objects for update to authenticated
  using (bucket_id = 'footprints' and (storage.foldername(name))[1] = (select auth.uid())::text)
  with check (bucket_id = 'footprints' and (storage.foldername(name))[1] = (select auth.uid())::text);
create policy "delete own footprint" on storage.objects for delete to authenticated
  using (bucket_id = 'footprints' and (storage.foldername(name))[1] = (select auth.uid())::text);
