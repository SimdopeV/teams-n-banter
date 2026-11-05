-- Teams & Banter Live Quiz: Supabase setup
-- Paste this whole file into the Supabase SQL editor and run it once.
--
-- WARNING: running it again drops and recreates every quiz table, which wipes
-- players, answers and the host PIN. Run it before the event, not during.
--
-- After it finishes:
--   1. Run questions.local.sql. It holds the questions and answers and is kept
--      off GitHub, because this repo is public.
--   2. Set the host PIN in a separate query (do not save it in any file):
--        select public.set_host_pin('TNB', 'your-pin-here');
--
-- Design notes
-- * anon can only SELECT the public games row (for realtime). Everything else
--   goes through security definer functions, so the browser never touches
--   questions, answers, players or game_secrets directly.
-- * The correct index lives only in questions until host_reveal copies it to
--   games.revealed_index.
-- * The player id (a random uuid kept in the phone's localStorage) acts as the
--   player's private token for player_sync and submit_answer.
-- * Host functions return jsonb. A wrong PIN returns {"error": "bad_pin"}
--   instead of raising, so the failed-attempt counter is saved.

create extension if not exists pgcrypto with schema extensions;

-- ---------------------------------------------------------------- reset
drop table if exists public.card_awards cascade;
drop table if exists public.answers cascade;
drop table if exists public.players cascade;
drop table if exists public.questions cascade;
drop table if exists public.game_secrets cascade;
drop table if exists public.games cascade;

-- ---------------------------------------------------------------- tables
create table public.games (
  id              uuid primary key default gen_random_uuid(),
  join_code       text not null unique,
  status          text not null default 'lobby'
                  check (status in ('lobby', 'question', 'reveal', 'leaderboard', 'final')),
  current_index   int  not null default -1,
  total_questions int  not null default 0,
  duration_s      int  not null default 20,
  category        text,
  question_text   text,
  options         jsonb,
  started_at      timestamptz,
  paused_at       timestamptz,
  revealed_index  int,
  explanation     text,
  card_mode       boolean not null default false,
  updated_at      timestamptz not null default now()
);

-- Kept apart from games so no column-level trick is needed to hide it.
create table public.game_secrets (
  game_id       uuid primary key references public.games (id) on delete cascade,
  host_pin_hash text,
  fail_count    int not null default 0,
  locked_until  timestamptz
);

create table public.questions (
  game_id       uuid not null references public.games (id) on delete cascade,
  idx           int  not null,
  category      text not null,
  text          text not null,
  options       jsonb not null check (jsonb_typeof(options) = 'array' and jsonb_array_length(options) between 2 and 4),
  correct_index int  not null check (correct_index between 0 and 3),
  check (correct_index < jsonb_array_length(options)),
  explanation   text not null,
  primary key (game_id, idx)
);

create table public.players (
  id         uuid primary key default gen_random_uuid(),
  game_id    uuid not null references public.games (id) on delete cascade,
  name       text not null check (char_length(name) between 1 and 20),
  group_name text not null check (group_name in ('Rumuola', 'Rumuokoro', 'Mile 1', 'Mile 2', 'Slaughter', 'Eleme', 'Airforce', 'Agip', 'Waterlines', 'Rumukurushi', 'Artillery')),
  joined_at  timestamptz not null default now()
);
create index players_game_idx on public.players (game_id);

create table public.answers (
  id           bigint generated always as identity primary key,
  game_id      uuid not null references public.games (id) on delete cascade,
  player_id    uuid not null references public.players (id) on delete cascade,
  question_idx int  not null,
  choice       int  not null check (choice between 0 and 3),
  answered_at  timestamptz not null default now(),
  elapsed_ms   int  not null,
  is_correct   boolean not null,
  points       int  not null,
  unique (player_id, question_idx)
);
create index answers_game_q_idx on public.answers (game_id, question_idx);

-- Card mode backup: one row per group that held up the right card.
create table public.card_awards (
  game_id      uuid not null references public.games (id) on delete cascade,
  question_idx int  not null,
  group_name   text not null check (group_name in ('Rumuola', 'Rumuokoro', 'Mile 1', 'Mile 2', 'Slaughter', 'Eleme', 'Airforce', 'Agip', 'Waterlines', 'Rumukurushi', 'Artillery')),
  primary key (game_id, question_idx, group_name)
);

-- ---------------------------------------------------------------- row level security
alter table public.games        enable row level security;
alter table public.game_secrets enable row level security;
alter table public.questions    enable row level security;
alter table public.players      enable row level security;
alter table public.answers      enable row level security;
alter table public.card_awards  enable row level security;

revoke all on public.games, public.game_secrets, public.questions,
              public.players, public.answers, public.card_awards
  from anon, authenticated;

-- The only direct table access: read the public game row (needed for realtime).
grant select on public.games to anon, authenticated;
create policy games_public_read on public.games
  for select to anon, authenticated using (true);
-- No policies on the other tables: with RLS on and no grants, anon sees nothing.

-- Realtime: phones listen to UPDATEs on their one games row.
do $$
begin
  if not exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    create publication supabase_realtime;
  end if;
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'games'
  ) then
    alter publication supabase_realtime add table public.games;
  end if;
end $$;

-- ---------------------------------------------------------------- internal helpers
-- These start with an underscore and are not executable by anon.

create or replace function public._groups()
returns text[] language sql immutable as $$
  select array['Rumuola', 'Rumuokoro', 'Mile 1', 'Mile 2', 'Slaughter', 'Eleme', 'Airforce', 'Agip', 'Waterlines', 'Rumukurushi', 'Artillery']
$$;

create or replace function public._name_is_blocked(p_name text)
returns boolean language plpgsql immutable as $$
declare
  n text;
  w text;
  -- Matched anywhere in the name.
  inside text[] := array['fuck', 'fuk', 'shit', 'cunt', 'nigger', 'nigga', 'bitch', 'whore',
                         'pussy', 'faggot', 'fagot', 'motherf', 'asshole', 'bastard', 'wanker',
                         'retard', 'ashawo', 'pornhub'];
  -- Matched only as a whole word, so names like Dickson or Cassandra pass.
  whole text[] := array['ass', 'dick', 'cock', 'sex', 'porn', 'rape', 'rapist', 'penis',
                        'vagina', 'boobs', 'tits', 'slut', 'hoe', 'fag', 'nude', 'nudes',
                        'hitler', 'nazi'];
begin
  n := lower(coalesce(p_name, ''));
  n := translate(n, '0134578@$!|', 'oieastbasii');
  foreach w in array inside loop
    if position(w in regexp_replace(n, '[^a-z]', '', 'g')) > 0 then return true; end if;
  end loop;
  foreach w in array whole loop
    if n ~ ('(^|[^a-z])' || w || '([^a-z]|$)') then return true; end if;
  end loop;
  return false;
end $$;

create or replace function public._public_game(g public.games)
returns jsonb language sql stable as $$
  select jsonb_build_object(
    'id', g.id, 'join_code', g.join_code, 'status', g.status,
    'current_index', g.current_index, 'total_questions', g.total_questions,
    'duration_s', g.duration_s, 'category', g.category,
    'question_text', g.question_text, 'options', g.options,
    'started_at', g.started_at, 'paused_at', g.paused_at,
    'revealed_index', g.revealed_index, 'explanation', g.explanation,
    'card_mode', g.card_mode, 'updated_at', g.updated_at)
$$;

-- Player totals with leaderboard labels ("Ada (2)") and rank.
create or replace function public._player_totals(p_game uuid)
returns table (player_id uuid, name text, group_name text, total int, correct int,
               answered int, joined_at timestamptz, label text, rank int)
language sql stable as $$
  with t as (
    select p.id, p.name, p.group_name, p.joined_at,
           coalesce(sum(a.points), 0)::int as total,
           count(a.id) filter (where a.is_correct)::int as correct,
           count(a.id)::int as answered
    from public.players p
    left join public.answers a on a.player_id = p.id
    where p.game_id = p_game
    group by p.id
  ), n as (
    select t.*,
           row_number() over (partition by lower(t.name) order by t.joined_at, t.id) as dup
    from t
  )
  select n.id, n.name, n.group_name, n.total, n.correct, n.answered, n.joined_at,
         case when n.dup > 1 then n.name || ' (' || n.dup || ')' else n.name end,
         (rank() over (order by n.total desc))::int
  from n
$$;

-- Group score = average of members' totals (members who never answered count
-- as 0) plus 100 per card-mode award. Tie-break: more correct answers.
create or replace function public._group_scores(p_game uuid)
returns table (group_name text, members int, avg_total numeric, card_points int,
               score numeric, correct int, rank int)
language sql stable as $$
  with gs as (
    select x.group_name, x.ord from unnest(public._groups()) with ordinality as x(group_name, ord)
  ), pt as (
    select * from public._player_totals(p_game)
  ), agg as (
    select gs.group_name, gs.ord,
           count(pt.player_id)::int as members,
           coalesce(avg(pt.total), 0)::numeric as avg_total,
           coalesce(sum(pt.correct), 0)::int as phone_correct
    from gs left join pt on pt.group_name = gs.group_name
    group by gs.group_name, gs.ord
  ), cards as (
    select ca.group_name, count(*)::int as n
    from public.card_awards ca where ca.game_id = p_game
    group by ca.group_name
  )
  select agg.group_name, agg.members, round(agg.avg_total, 2),
         coalesce(cards.n, 0) * 100,
         round(agg.avg_total + coalesce(cards.n, 0) * 100, 2),
         agg.phone_correct + coalesce(cards.n, 0),
         (rank() over (order by agg.avg_total + coalesce(cards.n, 0) * 100 desc,
                                agg.phone_correct + coalesce(cards.n, 0) desc))::int
  from agg left join cards on cards.group_name = agg.group_name
  order by agg.ord
$$;

-- Checks the host PIN. Returns the game id, or null on any failure (with the
-- reason in p_err). Never raises, so the failure counter update is kept.
create or replace function public._host_auth(p_code text, p_pin text, out p_game uuid, out p_err text)
language plpgsql security definer set search_path = public, extensions as $$
declare
  s public.game_secrets;
begin
  select g.id into p_game from public.games g where g.join_code = upper(trim(p_code));
  if p_game is null then p_err := 'game_not_found'; return; end if;

  select * into s from public.game_secrets where game_id = p_game for update;
  if s.host_pin_hash is null then p_game := null; p_err := 'pin_not_set'; return; end if;
  if s.locked_until is not null and s.locked_until > now() then
    p_game := null; p_err := 'locked'; return;
  end if;

  if extensions.crypt(coalesce(p_pin, ''), s.host_pin_hash) = s.host_pin_hash then
    if s.fail_count > 0 or s.locked_until is not null then
      update public.game_secrets set fail_count = 0, locked_until = null where game_id = p_game;
    end if;
    return;
  end if;

  -- 10 wrong PINs in a row lock host actions for 60 seconds.
  update public.game_secrets
     set fail_count   = case when fail_count + 1 >= 10 then 0 else fail_count + 1 end,
         locked_until = case when fail_count + 1 >= 10 then now() + interval '60 seconds' else null end
   where game_id = p_game;
  p_game := null;
  p_err := 'bad_pin';
end $$;

-- Moves the game to a status and question, loading the question fields from
-- questions. The correct index is copied only for reveal, leaderboard, final.
create or replace function public._apply(p_game uuid, p_status text, p_index int)
returns void language plpgsql security definer set search_path = public as $$
declare
  q public.questions;
  g public.games;
begin
  select * into g from public.games where id = p_game for update;
  if p_status = 'lobby' or p_index < 0 then
    update public.games set status = 'lobby', current_index = -1, category = null,
           question_text = null, options = null, started_at = null, paused_at = null,
           revealed_index = null, explanation = null, updated_at = now()
     where id = p_game;
    return;
  end if;

  select * into q from public.questions where game_id = p_game and idx = p_index;
  if q.idx is null then raise exception 'question % not found', p_index; end if;

  update public.games set
    status         = p_status,
    current_index  = p_index,
    category       = q.category,
    question_text  = q.text,
    options        = q.options,
    started_at     = case
                       when p_status = 'question' and (g.status <> 'question' or g.current_index <> p_index) then now()
                       when p_status = 'question' then g.started_at
                       else coalesce(case when g.current_index = p_index then g.started_at end, now())
                     end,
    paused_at      = case when p_status = 'question' and g.status = 'question' and g.current_index = p_index
                          then g.paused_at end,
    revealed_index = case when p_status in ('reveal', 'leaderboard', 'final') then q.correct_index end,
    explanation    = case when p_status in ('reveal', 'leaderboard', 'final') then q.explanation end,
    updated_at     = now()
  where id = p_game;
end $$;

-- Full host view: game row, players, groups, answer count (in total and per team), distribution.
create or replace function public._host_view(p_game uuid, p_note text default null)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  g public.games;
  dist jsonb := null;
  n_in int := 0;
  by_team jsonb := '{}'::jsonb;
begin
  select * into g from public.games where id = p_game;
  if g.current_index >= 0 then
    select count(*) into n_in from public.answers
     where game_id = p_game and question_idx = g.current_index;
    select coalesce(jsonb_object_agg(t.group_name, t.n), '{}'::jsonb) into by_team
      from (select p.group_name, count(*)::int n
              from public.answers a join public.players p on p.id = a.player_id
             where a.game_id = p_game and a.question_idx = g.current_index
             group by p.group_name) t;
    if g.status in ('reveal', 'leaderboard', 'final') then
      select jsonb_agg(coalesce(c.n, 0) order by s.i) into dist
        from generate_series(0, coalesce(jsonb_array_length(g.options), 4) - 1) s(i)
        left join (select choice, count(*)::int n from public.answers
                    where game_id = p_game and question_idx = g.current_index
                    group by choice) c on c.choice = s.i;
    end if;
  end if;

  return jsonb_build_object(
    'game', public._public_game(g),
    'server_now', now(),
    'answers_in', n_in,
    'team_answers', by_team,
    'distribution', dist,
    'note', p_note,
    'players', coalesce((select jsonb_agg(jsonb_build_object(
        'id', t.player_id, 'name', t.name, 'label', t.label, 'group', t.group_name,
        'total', t.total, 'correct', t.correct, 'answered', t.answered, 'rank', t.rank)
        order by t.total desc, t.correct desc, t.joined_at)
      from public._player_totals(p_game) t), '[]'::jsonb),
    'groups', (select jsonb_agg(jsonb_build_object(
        'name', s.group_name, 'members', s.members, 'avg', s.avg_total,
        'card_points', s.card_points, 'score', s.score, 'correct', s.correct, 'rank', s.rank))
      from public._group_scores(p_game) s),
    'card_awards', coalesce((select jsonb_object_agg(x.question_idx, x.groups) from (
        select question_idx, jsonb_agg(group_name order by group_name) groups
        from public.card_awards where game_id = p_game group by question_idx) x), '{}'::jsonb)
  );
end $$;

-- ---------------------------------------------------------------- admin (SQL editor only)
create or replace function public.set_host_pin(p_code text, p_pin text)
returns text language plpgsql security definer set search_path = public, extensions as $$
declare g_id uuid;
begin
  if p_pin is null or char_length(p_pin) < 6 then
    raise exception 'Use a PIN of at least 6 characters.';
  end if;
  select id into g_id from public.games where join_code = upper(trim(p_code));
  if g_id is null then raise exception 'No game with code %', p_code; end if;
  insert into public.game_secrets (game_id, host_pin_hash)
  values (g_id, extensions.crypt(p_pin, extensions.gen_salt('bf', 8)))
  on conflict (game_id) do update
    set host_pin_hash = excluded.host_pin_hash, fail_count = 0, locked_until = null;
  return 'Host PIN set for ' || upper(trim(p_code));
end $$;

-- ---------------------------------------------------------------- player functions

create or replace function public.player_join(p_code text, p_name text, p_group text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  g public.games;
  v_name text := regexp_replace(trim(coalesce(p_name, '')), '\s+', ' ', 'g');
  v_id uuid;
begin
  select * into g from public.games where join_code = upper(trim(p_code));
  if g.id is null then return jsonb_build_object('error', 'game_not_found'); end if;
  if char_length(v_name) < 1 then return jsonb_build_object('error', 'name_required'); end if;
  if char_length(v_name) > 20 then return jsonb_build_object('error', 'name_too_long'); end if;
  if public._name_is_blocked(v_name) then return jsonb_build_object('error', 'name_blocked'); end if;
  if not (p_group = any (public._groups())) then return jsonb_build_object('error', 'bad_group'); end if;
  if (select count(*) from public.players where game_id = g.id) >= 300 then
    return jsonb_build_object('error', 'game_full');
  end if;

  insert into public.players (game_id, name, group_name) values (g.id, v_name, p_group)
  returning id into v_id;
  return jsonb_build_object('player_id', v_id, 'name', v_name, 'group', p_group);
end $$;

-- One call to catch up: player, game row, server time, this question's answer
-- state, and (only once revealed) this question's result and the rankings.
create or replace function public.player_sync(p_player uuid)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  p public.players;
  g public.games;
  a public.answers;
  me record;
  grp record;
  n_players int;
  res jsonb := null;
  fin jsonb := null;
begin
  select * into p from public.players where id = p_player;
  if p.id is null then
    return jsonb_build_object('player', null, 'server_now', now());
  end if;
  select * into g from public.games where id = p.game_id;

  if g.current_index >= 0 then
    select * into a from public.answers where player_id = p.id and question_idx = g.current_index;
  end if;

  select * into me from public._player_totals(g.id) t where t.player_id = p.id;

  if g.status in ('reveal', 'leaderboard', 'final') and g.current_index >= 0 then
    res := jsonb_build_object(
      'question_idx', g.current_index,
      'answered', a.id is not null,
      'choice', a.choice,
      'is_correct', coalesce(a.is_correct, false),
      'points', coalesce(a.points, 0));
  end if;

  if g.status = 'final' then
    select count(*) into n_players from public.players where game_id = g.id;
    select * into grp from public._group_scores(g.id) s where s.group_name = p.group_name;
    fin := jsonb_build_object(
      'rank', me.rank, 'players', n_players,
      'group_rank', grp.rank, 'groups', array_length(public._groups(), 1),
      'group_score', round(grp.score));
  end if;

  return jsonb_build_object(
    'player', jsonb_build_object('id', p.id, 'name', p.name, 'group', p.group_name),
    'game', public._public_game(g),
    'server_now', now(),
    'choice', a.choice,
    'total', me.total,
    'result', res,
    'final', fin);
end $$;

-- Scores the answer with server time. The client never sees the correct index.
create or replace function public.submit_answer(p_player uuid, p_question_idx int, p_choice int)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  p public.players;
  g public.games;
  q public.questions;
  v_elapsed numeric;
  v_correct boolean;
  v_points int;
begin
  if p_choice is null or p_choice not between 0 and 3 then
    return jsonb_build_object('error', 'bad_choice');
  end if;
  select * into p from public.players where id = p_player;
  if p.id is null then return jsonb_build_object('error', 'player_not_found'); end if;
  select * into g from public.games where id = p.game_id;

  if g.card_mode then return jsonb_build_object('error', 'card_mode'); end if;
  if g.status <> 'question' or g.current_index <> p_question_idx then
    return jsonb_build_object('error', 'not_open');
  end if;

  -- Time stands still while the host has paused the timer.
  v_elapsed := extract(epoch from (coalesce(g.paused_at, now()) - g.started_at));
  if v_elapsed > g.duration_s + 1 then
    return jsonb_build_object('error', 'too_late');
  end if;
  v_elapsed := least(greatest(v_elapsed, 0), g.duration_s);

  select * into q from public.questions where game_id = g.id and idx = g.current_index;
  if p_choice >= jsonb_array_length(q.options) then
    return jsonb_build_object('error', 'bad_choice');
  end if;
  v_correct := (p_choice = q.correct_index);
  v_points := case when v_correct
                   then 500 + round(500 * (1 - v_elapsed / g.duration_s))::int
                   else 0 end;

  insert into public.answers (game_id, player_id, question_idx, choice, elapsed_ms, is_correct, points)
  values (g.id, p.id, g.current_index, p_choice, round(v_elapsed * 1000)::int, v_correct, v_points)
  on conflict (player_id, question_idx) do nothing;

  if not found then return jsonb_build_object('error', 'duplicate'); end if;
  return jsonb_build_object('ok', true);
end $$;

-- ---------------------------------------------------------------- host functions
-- Each takes the join code and PIN. Transition functions also take the status
-- and index the host page is showing, so a double press cannot skip ahead.

create or replace function public.host_login(p_code text, p_pin text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare a record;
begin
  a := public._host_auth(p_code, p_pin);
  if a.p_game is null then return jsonb_build_object('error', a.p_err); end if;
  return public._host_view(a.p_game);
end $$;

create or replace function public.host_state(p_code text, p_pin text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare a record;
begin
  a := public._host_auth(p_code, p_pin);
  if a.p_game is null then return jsonb_build_object('error', a.p_err); end if;
  return public._host_view(a.p_game);
end $$;

-- Full question list with answers, for the host's offline card mode cache.
create or replace function public.host_questions(p_code text, p_pin text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare a record;
begin
  a := public._host_auth(p_code, p_pin);
  if a.p_game is null then return jsonb_build_object('error', a.p_err); end if;
  return jsonb_build_object('questions', (
    select jsonb_agg(jsonb_build_object(
      'idx', q.idx, 'category', q.category, 'text', q.text, 'options', q.options,
      'correct_index', q.correct_index, 'explanation', q.explanation) order by q.idx)
    from public.questions q where q.game_id = a.p_game));
end $$;

create or replace function public.host_open_question(p_code text, p_pin text, p_from_status text,
                                                     p_from_index int, p_index int)
returns jsonb language plpgsql security definer set search_path = public as $$
declare a record; g public.games;
begin
  a := public._host_auth(p_code, p_pin);
  if a.p_game is null then return jsonb_build_object('error', a.p_err); end if;
  select * into g from public.games where id = a.p_game for update;
  if g.status <> p_from_status or g.current_index <> p_from_index then
    return public._host_view(a.p_game, 'stale');
  end if;
  if p_index < 0 or p_index >= g.total_questions then
    return public._host_view(a.p_game, 'no_such_question');
  end if;
  perform public._apply(a.p_game, 'question', p_index);
  return public._host_view(a.p_game);
end $$;

create or replace function public.host_start(p_code text, p_pin text)
returns jsonb language sql security definer set search_path = public as $$
  select public.host_open_question(p_code, p_pin, 'lobby', -1, 0)
$$;

create or replace function public.host_reveal(p_code text, p_pin text, p_index int)
returns jsonb language plpgsql security definer set search_path = public as $$
declare a record; g public.games;
begin
  a := public._host_auth(p_code, p_pin);
  if a.p_game is null then return jsonb_build_object('error', a.p_err); end if;
  select * into g from public.games where id = a.p_game for update;
  if g.status <> 'question' or g.current_index <> p_index then
    return public._host_view(a.p_game, 'stale');
  end if;
  perform public._apply(a.p_game, 'reveal', p_index);
  return public._host_view(a.p_game);
end $$;

-- lobby -> Q1, question -> reveal, reveal -> leaderboard,
-- leaderboard -> next question (or final after the last one).
create or replace function public.host_next(p_code text, p_pin text, p_from_status text, p_from_index int)
returns jsonb language plpgsql security definer set search_path = public as $$
declare a record; g public.games;
begin
  a := public._host_auth(p_code, p_pin);
  if a.p_game is null then return jsonb_build_object('error', a.p_err); end if;
  select * into g from public.games where id = a.p_game for update;
  if g.status <> p_from_status or g.current_index <> p_from_index then
    return public._host_view(a.p_game, 'stale');
  end if;

  if g.status = 'lobby' then
    perform public._apply(a.p_game, 'question', 0);
  elsif g.status = 'question' then
    perform public._apply(a.p_game, 'reveal', g.current_index);
  elsif g.status = 'reveal' then
    perform public._apply(a.p_game, 'leaderboard', g.current_index);
  elsif g.status = 'leaderboard' then
    if g.current_index + 1 < g.total_questions then
      perform public._apply(a.p_game, 'question', g.current_index + 1);
    else
      perform public._apply(a.p_game, 'final', g.current_index);
    end if;
  end if;
  return public._host_view(a.p_game);
end $$;

-- leaderboard -> reveal, final -> leaderboard. An open question is cancelled
-- (its answers are deleted) and the game goes back to the previous
-- leaderboard, or the lobby. A reveal cannot be undone.
create or replace function public.host_back(p_code text, p_pin text, p_from_status text, p_from_index int)
returns jsonb language plpgsql security definer set search_path = public as $$
declare a record; g public.games;
begin
  a := public._host_auth(p_code, p_pin);
  if a.p_game is null then return jsonb_build_object('error', a.p_err); end if;
  select * into g from public.games where id = a.p_game for update;
  if g.status <> p_from_status or g.current_index <> p_from_index then
    return public._host_view(a.p_game, 'stale');
  end if;

  if g.status = 'leaderboard' then
    perform public._apply(a.p_game, 'reveal', g.current_index);
  elsif g.status = 'final' then
    perform public._apply(a.p_game, 'leaderboard', greatest(g.current_index, 0));
  elsif g.status = 'question' then
    delete from public.answers where game_id = a.p_game and question_idx = g.current_index;
    delete from public.card_awards where game_id = a.p_game and question_idx = g.current_index;
    if g.current_index = 0 then
      perform public._apply(a.p_game, 'lobby', -1);
    else
      perform public._apply(a.p_game, 'leaderboard', g.current_index - 1);
    end if;
  elsif g.status = 'reveal' then
    return public._host_view(a.p_game, 'cannot_unreveal');
  end if;
  return public._host_view(a.p_game);
end $$;

-- Pause or resume the timer of the open question.
create or replace function public.host_pause(p_code text, p_pin text, p_index int, p_paused boolean)
returns jsonb language plpgsql security definer set search_path = public as $$
declare a record; g public.games;
begin
  a := public._host_auth(p_code, p_pin);
  if a.p_game is null then return jsonb_build_object('error', a.p_err); end if;
  select * into g from public.games where id = a.p_game for update;
  if g.status <> 'question' or g.current_index <> p_index then
    return public._host_view(a.p_game, 'stale');
  end if;
  if p_paused and g.paused_at is null then
    update public.games set paused_at = now(), updated_at = now() where id = a.p_game;
  elsif not p_paused and g.paused_at is not null then
    update public.games set started_at = started_at + (now() - paused_at), paused_at = null,
           updated_at = now() where id = a.p_game;
  end if;
  return public._host_view(a.p_game);
end $$;

create or replace function public.host_end(p_code text, p_pin text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare a record; g public.games;
begin
  a := public._host_auth(p_code, p_pin);
  if a.p_game is null then return jsonb_build_object('error', a.p_err); end if;
  select * into g from public.games where id = a.p_game for update;
  if g.current_index < 0 then
    update public.games set status = 'final', updated_at = now() where id = a.p_game;
  else
    perform public._apply(a.p_game, 'final', g.current_index);
  end if;
  return public._host_view(a.p_game);
end $$;

-- Wipes players, answers and card awards and returns to the lobby.
create or replace function public.host_reset(p_code text, p_pin text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare a record;
begin
  a := public._host_auth(p_code, p_pin);
  if a.p_game is null then return jsonb_build_object('error', a.p_err); end if;
  delete from public.card_awards where game_id = a.p_game;
  delete from public.answers where game_id = a.p_game;
  delete from public.players where game_id = a.p_game;
  update public.games set card_mode = false where id = a.p_game;
  perform public._apply(a.p_game, 'lobby', -1);
  return public._host_view(a.p_game);
end $$;

create or replace function public.host_remove_player(p_code text, p_pin text, p_player uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare a record;
begin
  a := public._host_auth(p_code, p_pin);
  if a.p_game is null then return jsonb_build_object('error', a.p_err); end if;
  delete from public.players where id = p_player and game_id = a.p_game;
  return public._host_view(a.p_game);
end $$;

create or replace function public.host_set_card_mode(p_code text, p_pin text, p_on boolean)
returns jsonb language plpgsql security definer set search_path = public as $$
declare a record;
begin
  a := public._host_auth(p_code, p_pin);
  if a.p_game is null then return jsonb_build_object('error', a.p_err); end if;
  update public.games set card_mode = coalesce(p_on, false), updated_at = now()
   where id = a.p_game and card_mode is distinct from coalesce(p_on, false);
  return public._host_view(a.p_game);
end $$;

-- Card mode: replace the list of groups that answered question p_index right.
create or replace function public.host_card_set(p_code text, p_pin text, p_index int, p_groups text[])
returns jsonb language plpgsql security definer set search_path = public as $$
declare a record;
begin
  a := public._host_auth(p_code, p_pin);
  if a.p_game is null then return jsonb_build_object('error', a.p_err); end if;
  delete from public.card_awards where game_id = a.p_game and question_idx = p_index;
  insert into public.card_awards (game_id, question_idx, group_name)
  select a.p_game, p_index, x from unnest(coalesce(p_groups, '{}')) x
  where x = any (public._groups())
  on conflict do nothing;
  return public._host_view(a.p_game);
end $$;

-- Card mode: the host page runs the flow locally and pushes its position here
-- so phones follow whenever the internet is up.
create or replace function public.host_goto(p_code text, p_pin text, p_status text, p_index int)
returns jsonb language plpgsql security definer set search_path = public as $$
declare a record; g public.games;
begin
  a := public._host_auth(p_code, p_pin);
  if a.p_game is null then return jsonb_build_object('error', a.p_err); end if;
  select * into g from public.games where id = a.p_game for update;
  if p_status not in ('lobby', 'question', 'reveal', 'leaderboard', 'final') then
    return public._host_view(a.p_game, 'bad_status');
  end if;
  if p_status <> 'lobby' and (p_index < 0 or p_index >= g.total_questions) then
    return public._host_view(a.p_game, 'no_such_question');
  end if;
  if g.status is distinct from p_status or g.current_index is distinct from p_index then
    perform public._apply(a.p_game, p_status, p_index);
  end if;
  return public._host_view(a.p_game);
end $$;

-- ---------------------------------------------------------------- execute grants
revoke execute on all functions in schema public from public, anon, authenticated;

grant execute on function
  public.player_join(text, text, text),
  public.player_sync(uuid),
  public.submit_answer(uuid, int, int),
  public.host_login(text, text),
  public.host_state(text, text),
  public.host_questions(text, text),
  public.host_start(text, text),
  public.host_open_question(text, text, text, int, int),
  public.host_reveal(text, text, int),
  public.host_next(text, text, text, int),
  public.host_back(text, text, text, int),
  public.host_pause(text, text, int, boolean),
  public.host_end(text, text),
  public.host_reset(text, text),
  public.host_remove_player(text, text, uuid),
  public.host_set_card_mode(text, text, boolean),
  public.host_card_set(text, text, int, text[]),
  public.host_goto(text, text, text, int)
to anon, authenticated;

-- ---------------------------------------------------------------- the game
-- The questions live in questions.local.sql, which is kept off GitHub.
insert into public.games (join_code, total_questions) values ('TNB', 0);



insert into public.game_secrets (game_id) select id from public.games where join_code = 'TNB';

-- Done. Next:
--   1. Run questions.local.sql (the questions and answers, not in the repo).
--   2. In a new query: select public.set_host_pin('TNB', 'your-pin-here');
