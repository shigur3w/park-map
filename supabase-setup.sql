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
