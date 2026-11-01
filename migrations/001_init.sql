create table ccc.devices (
  id uuid primary key default gen_random_uuid(),
  label text not null unique,
  token_hash text not null unique,
  created_at timestamptz not null default now(),
  revoked_at timestamptz
);

create table ccc.sessions (
  id uuid primary key default gen_random_uuid(),
  name text not null unique check (name ~ '^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$'),
  role text not null default 'worker'
    check (role in ('orchestrator', 'worker', 'helper', 'auditor', 'other')),
  device_id uuid references ccc.devices(id),
  claude_session_id text,
  superseded_claude_session_ids text[] not null default '{}',
  cwd text,
  project text,
  branch text,
  status text not null default 'idle'
    check (status in ('working', 'idle', 'waiting_permission', 'blocked', 'paused', 'unreachable', 'offline')),
  working_on text,
  blocker text,
  paused boolean not null default false,
  last_heartbeat_at timestamptz,
  last_activity_at timestamptz,
  last_wait_at timestamptz,
  last_ping_at timestamptz,
  retired_at timestamptz,
  created_at timestamptz not null default now()
);

-- At most one live orchestrator.
create unique index sessions_one_orchestrator on ccc.sessions ((true))
  where role = 'orchestrator' and retired_at is null;

create table ccc.tasks (
  id bigint generated always as identity primary key,
  title text not null,
  body text not null default '',
  assignee_id uuid references ccc.sessions(id),
  created_by text not null,
  status text not null default 'open'
    check (status in ('open', 'in_progress', 'blocked', 'done', 'cancelled')),
  blocker text,
  result text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- addressed_to: 'owner' | 'role:orchestrator' | a session name.
create table ccc.questions (
  id bigint generated always as identity primary key,
  asked_by text not null,
  addressed_to text not null,
  body text not null,
  context text,
  options jsonb,
  is_blocking boolean not null default false,
  status text not null default 'open' check (status in ('open', 'answered', 'withdrawn')),
  answer_choice text,
  answer_text text,
  answered_by text,
  answered_at timestamptz,
  created_at timestamptz not null default now()
);

-- Delivering a message is reading it, so read_at doubles as delivered_at.
create table ccc.messages (
  id bigint generated always as identity primary key,
  from_name text not null,
  to_session_id uuid not null references ccc.sessions(id),
  kind text not null check (kind in ('instruction', 'task', 'answer', 'question', 'control', 'note', 'ping')),
  control_action text check (control_action in ('pause', 'resume')),
  body text not null,
  ref_task_id bigint references ccc.tasks(id),
  ref_question_id bigint references ccc.questions(id),
  created_at timestamptz not null default now(),
  read_at timestamptz
);
create index messages_unread on ccc.messages (to_session_id, id) where read_at is null;

create table ccc.events (
  id bigint generated always as identity primary key,
  session_id uuid references ccc.sessions(id),
  actor text not null,
  type text not null,
  payload jsonb not null default '{}',
  created_at timestamptz not null default now()
);
create index events_session on ccc.events (session_id, id desc);
