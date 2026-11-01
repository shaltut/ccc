-- Projects: every session, task and question belongs to one. Rows from before land in 'default'.
update ccc.sessions set project = 'default'
  where project is null or project !~ '^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$';
alter table ccc.sessions
  alter column project set default 'default',
  alter column project set not null,
  add constraint sessions_project_name check (project ~ '^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$');

alter table ccc.tasks add column project text not null default 'default';
alter table ccc.questions add column project text not null default 'default';

-- At most one live orchestrator per project.
drop index ccc.sessions_one_orchestrator;
create unique index sessions_one_orchestrator on ccc.sessions (project)
  where role = 'orchestrator' and retired_at is null;

create index tasks_project on ccc.tasks (project, id desc);
create index questions_project on ccc.questions (project);
