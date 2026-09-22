create table if not exists schema_migrations (
  version text primary key,
  checksum text not null,
  applied_at timestamptz not null default now()
);

-- 환경 표지: 테스트·초기화 스크립트가 운영 DB를 건드리지 않게 막는다
create table if not exists app_environment (
  singleton boolean primary key default true check (singleton),
  name text not null check (name in ('development','production'))
);

create table events (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique,
  title text not null default 'KANT Mingle',
  phase text not null default 'SETUP' check (phase in ('SETUP','BLOCK','BREAK','ENDED')),
  current_block smallint not null default 0 check (current_block between 0 and 3),
  host_participant_id uuid,
  config_json jsonb not null,
  content_version text not null,
  session_version integer not null default 0,
  teams_published_at timestamptz,
  next_block_plan jsonb,             -- BREAK 중 편성안(비밀 아님)
  started_at timestamptz,
  ended_at timestamptz,
  created_at timestamptz not null default now()
);

create table participants (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references events(id) on delete cascade,
  display_name text not null,
  role text not null check (role in ('student','operator')),
  roster_order smallint not null,
  attendance text not null default 'unknown' check (attendance in ('unknown','present','absent')),
  operator_code_hash text,
  profile_completed_at timestamptz,
  profile_locked_at timestamptz,
  owner_count smallint not null default 0,
  created_at timestamptz not null default now(),
  unique (event_id, roster_order),
  unique (event_id, display_name),
  check (role = 'operator' or operator_code_hash is null)
);
alter table events add constraint events_host_fk
  foreign key (host_participant_id) references participants(id);

create table sessions (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references events(id) on delete cascade,
  token_hash text not null unique,
  participant_id uuid references participants(id) on delete cascade,
  created_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  expires_at timestamptz not null,
  revoked_at timestamptz
);
create unique index sessions_one_active_per_participant
  on sessions(participant_id) where participant_id is not null and revoked_at is null;
create index sessions_event_idx on sessions(event_id);

create table auth_attempts (
  event_id uuid not null references events(id) on delete cascade,
  key_hash text not null,
  window_start timestamptz not null,
  attempts integer not null default 0,
  primary key (event_id, key_hash, window_start)
);

create table profile_answers (
  event_id uuid not null references events(id) on delete cascade,
  participant_id uuid not null references participants(id) on delete cascade,
  question_id text not null check (question_id ~ '^Q(0[1-9]|1[0-9]|20)$'),
  option char(1) not null check (option in ('A','B')),
  revision integer not null,
  updated_at timestamptz not null default now(),
  primary key (participant_id, question_id)
);

create table teams (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references events(id) on delete cascade,
  team_key text not null check (team_key ~ '^[A-Z]$'),
  operator_participant_id uuid references participants(id),
  unique (event_id, team_key)
);

create table block_assignments (
  event_id uuid not null references events(id) on delete cascade,
  block_no smallint not null check (block_no between 1 and 3),
  participant_id uuid not null references participants(id) on delete cascade,
  team_id uuid not null references teams(id) on delete cascade,
  seat_no smallint not null,
  primary key (event_id, block_no, participant_id),
  unique (event_id, block_no, team_id, seat_no)
);

create table pair_history (
  event_id uuid not null references events(id) on delete cascade,
  a_id uuid not null references participants(id) on delete cascade,
  b_id uuid not null references participants(id) on delete cascade,
  count smallint not null default 0,
  primary key (event_id, a_id, b_id),
  check (a_id < b_id)
);

create table team_blocks (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references events(id) on delete cascade,
  block_no smallint not null check (block_no between 1 and 3),
  team_id uuid not null references teams(id) on delete cascade,
  phase text not null check (phase in ('SEATING','IN_GAME','REVEAL','BLOCK_DONE')),
  current_game_id uuid,
  team_version integer not null default 0,
  settings_json jsonb not null,      -- 다음 GAME을 만들 때 스냅샷할 조 설정
  paused_at timestamptz,
  started_at timestamptz,
  done_at timestamptz,
  unique (event_id, block_no, team_id)
);

create table games (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references events(id) on delete cascade,
  team_id uuid not null references teams(id),
  team_block_id uuid not null references team_blocks(id) on delete cascade,
  block_no smallint not null check (block_no between 1 and 3),
  game_no smallint not null check (game_no between 1 and 9),
  config_snapshot jsonb not null,
  owner_participant_id uuid not null references participants(id),   -- PRIVATE
  noise_slots smallint[] not null default '{}',                     -- PRIVATE
  rng_seed text not null check (rng_seed ~ '^[0-9a-f]{32}$'),        -- PRIVATE, hex 32자
  phase text not null check (phase in ('TURN','ENSEMBLE_SHARE','ENSEMBLE_VOTE','ENSEMBLE_DISCUSS','REVEALED')),
  turn_lead_participant_id uuid references participants(id),
  guess_locked boolean not null default false,
  exhausted boolean not null default false,
  ensemble_trigger_no smallint,       -- null이면 이번 GAME은 Ensemble 없음
  ensemble_sharer_id uuid references participants(id),
  ensemble_done boolean not null default false,
  vote_deadline timestamptz,
  vote_remaining_ms integer,          -- 일시정지 중 남은 시간
  gt_status text not null default 'none' check (gt_status in ('none','pending','announced','skipped')),
  gt_real_cards_needed smallint not null default 0, -- 어려움 프리셋: Ensemble 뒤 필요한 실제 카드 수
  game_version integer not null default 0,
  paused_ms_total integer not null default 0,
  started_at timestamptz not null default now(),
  revealed_at timestamptz,
  end_reason text check (end_reason in ('correct','forced','session_end')),
  unique (team_id, game_no)
);
alter table team_blocks add constraint team_blocks_game_fk
  foreign key (current_game_id) references games(id);

create table game_members (
  game_id uuid not null references games(id) on delete cascade,
  participant_id uuid not null references participants(id),
  primary key (game_id, participant_id)
);

create table data_cards (
  id uuid primary key default gen_random_uuid(),
  game_id uuid not null references games(id) on delete cascade,
  card_no smallint not null check (card_no between 1 and 20),
  question_id text not null,
  displayed_option char(1) not null check (displayed_option in ('A','B')),
  true_option char(1) not null check (true_option in ('A','B')),   -- PRIVATE
  is_noise boolean not null,                                        -- PRIVATE
  created_at timestamptz not null default now(),
  unique (game_id, card_no),
  unique (game_id, question_id),
  check (is_noise = (displayed_option <> true_option))
);

create table card_deliveries (
  card_id uuid not null references data_cards(id) on delete cascade,
  participant_id uuid not null references participants(id),
  reason text not null check (reason in ('initial','resend')),
  delivered_at timestamptz not null default now(),
  primary key (card_id, participant_id)
);
create index card_deliveries_participant_idx on card_deliveries(participant_id);

create table guess_attempts (
  id uuid primary key default gen_random_uuid(),
  game_id uuid not null references games(id) on delete cascade,
  attempt_no smallint not null,
  submitted_by uuid not null references participants(id),
  owner_pick uuid not null references participants(id),
  noise_picks smallint[] not null default '{}',
  revealed_count smallint not null,
  correct boolean not null,
  created_at timestamptz not null default now(),
  unique (game_id, attempt_no)
);

create table ensemble_votes (
  game_id uuid not null references games(id) on delete cascade,
  voter_id uuid not null references participants(id),
  pick_id uuid not null references participants(id),
  revision integer not null default 1,
  updated_at timestamptz not null default now(),
  primary key (game_id, voter_id)
);

create table ground_truths (
  game_id uuid primary key references games(id) on delete cascade,
  card_id uuid not null references data_cards(id),
  announced_at timestamptz not null default now()
);

create table intro_seen (
  participant_id uuid not null references participants(id) on delete cascade,
  intro_key text not null check (intro_key in ('tutorial','noise','ensemble','ground_truth')),
  seen_at timestamptz not null default now(),
  primary key (participant_id, intro_key)
);

create table command_receipts (
  event_id uuid not null references events(id) on delete cascade,
  actor_session_id uuid not null references sessions(id) on delete cascade,
  request_id uuid not null,
  command text not null,
  payload_hash text not null,
  result_json jsonb not null,        -- 결과 코드와 id만. 정답·프로필 금지
  created_at timestamptz not null default now(),
  primary key (event_id, actor_session_id, request_id)
);

create table operation_logs (
  id bigserial primary key,
  event_id uuid not null references events(id) on delete cascade,
  actor_participant_id uuid references participants(id),
  command text not null,
  target text,
  detail_json jsonb,                 -- 정답·프로필·코드 금지
  created_at timestamptz not null default now()
);
