# Scheduler (P8)

> Implementation: `backend/app/scheduler.py`, `app/api/scheduled_jobs.py`, the `scheduled_jobs` table.

## Architecture

`AsyncIOScheduler` (apscheduler) runs inside the dedicated `scheduler` container (post-R3). On startup:

1. `seed_default_jobs` — creates the built-in jobs if missing.
2. `reload_jobs` — reads every `enabled=true` row from the DB and registers it with the scheduler.
3. When a job is mutated via `/api/scheduled-jobs` (POST/PATCH/DELETE), `reload_jobs` runs again.

The container holds the Postgres advisory lock `8723452`. If multiple scheduler instances run, only the lock holder is active; the others sleep+retry — providing automatic failover.

## Job kinds

| kind | Trigger | Fields |
|------|---------|--------|
| cron | `CronTrigger.from_crontab(cron_expr)` | cron_expr |
| interval | `IntervalTrigger(seconds=interval_seconds)` | interval_seconds |
| once | `DateTrigger(run_date=fire_at)` | fire_at; the job is auto-disabled (`enabled=false`) after firing |

## Built-in jobs

Seeded by `seed_default_jobs` on startup if missing (matched by name):

### daily_cost_rollup

- kind: `cron`, expr: `0 0 * * *` (midnight UTC).
- Computes `sum(cost_usd)` / `count(tasks)` for tasks completed yesterday.
- Writes an `agent_events` row with `event_type=daily_cost_summary`.

### agent_progress_check

- kind: `interval`, 60 seconds.
- For every active container it calls `runtime.health(...)` (P1) and writes `agent_events` with `event_type=agent_health` and the `current_step`.

## Manual jobs

`POST /api/scheduled-jobs`:

```json
{
  "name": "string",
  "kind": "cron|interval|once",
  "cron_expr": "0 */6 * * *",
  "interval_seconds": null,
  "fire_at": null,
  "payload": {"action": "test"},
  "enabled": true
}
```

If `payload.action` is unknown (`daily_cost_rollup` / `agent_progress_check`), the fallback writes an `agent_events` row with `event_type=scheduled_job_fired` and the original `name` + `action` + `payload`.

## Extension

To add a new built-in action:

1. Add an `elif action == "my_action": …` branch in `_job_runner` (`app/scheduler.py`).
2. If you want the job created automatically, add a seed entry in `seed_default_jobs`.
3. Document it here.

After R5 these actions will live as plugins (e.g. `Notifier` or similar) without touching `_job_runner`.

## Known limitations

- Time-once jobs whose `fire_at` is already in the past will **not** fire on the next restart (APScheduler skips them by design).
- Built-in jobs live in the default workspace; user-created jobs are scoped to the creator's workspace (post-R1).
