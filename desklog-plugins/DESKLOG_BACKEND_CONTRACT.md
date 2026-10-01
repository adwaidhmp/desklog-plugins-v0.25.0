# Desklog backend contract for the Claude Code plugin (v0.5.0)

The plugin now uses your existing tools:
`get_my_bot_users`, `create_task`, `change_task_status`, `start_timer`, `get_task_details`.
The rules below are what those tools must enforce on the server. The plugin's hooks add
a local first check for some of them, but none of them is safe without the server check.

## What each existing tool must guarantee
- `get_my_bot_users` — only the logged-in user's own bot(s), only their company.
  Ideally also returns the bot's task In Progress and its waiting tasks, so Claude can
  tell whether the bot is busy. (If it does not, the plugin falls back to tasks started
  from the same computer.)
- `create_task` — refuse an assignee that is not the caller's own bot. Create the task
  NOT started.
- `change_task_status` → In Progress — refuse if the bot already has another task In
  Progress (check and set inside one lock/transaction).
- `start_timer` — server clock only.
- `change_task_status` → Completed:
  - accept the extra `ai_usage` field the plugin adds (result, summary, usage totals,
    usage_complete, source.completion_key) and store it on the task;
  - refuse the call if `ai_usage` is missing (the plugin's hook did not run);
  - refuse if `ai_usage.result` is not "done";
  - same `completion_key` twice → return the original success, change nothing;
  - stop the timer and set the end time from the server clock.
- `get_task_details` — only the caller's own tasks; return status, times, duration and
  stored usage.

---

The sections below are the original contract, kept for reference. Where they name
`get_my_bot`, `create_and_assign_tasks`, `start_task`, `get_task` or `complete_task`,
read them as the existing tools above.


The plugin only orchestrates. Every rule below must be enforced by Desklog on the
server, because the model's inputs are never trusted. The plugin's hooks add a second
line of defence for some of them, but none of them is safe without the server check.

Company, user and bot are always derived from the OAuth login — never from a tool
argument.

## Tools

### get_my_bot()  — new
Returns the logged-in user's associated bot and its queue:

    { "bot": { "id": 41, "name": "John's bot" } | null,
      "running_task": { "id": 100, "title": "...", "started_at": "..." } | null,
      "waiting_tasks": [ { "id": 101, "title": "...", "created_at": "..." }, ... ] }

- `bot: null` when no bot is linked. The plugin then stops and says so.
- `waiting_tasks` in the order they should be offered (oldest first).
- Only this user's bot, only this company.

Open question before building it: where does the user → bot link live today? If
it needs a new column or table, that is a schema decision for you, not something to
add as part of this work.

### create_and_assign_tasks(tasks[])
- Each task: `title`, `description`. No bot, assignee or user field — reject the
  request if one is present (the plugin also blocks this before sending).
- Assign every task to the caller's own bot. No fallback to another bot, ever.
- New tasks are NOT started: status is the existing assigned/waiting state; no
  `started_at`.
- Usual permission checks (project access, etc.) apply exactly as in the web UI.

### start_task(task_id)
- Task must belong to the caller's company and be assigned to the caller's bot.
- **Refuse if the bot already has a task In Progress.** Check and set inside one
  lock/transaction, so two terminals approving at the same moment cannot both start.
- Set `started_at` from the server clock. Never accept a time from the client.
- Refusal messages are plain sentences; the plugin shows them to the user verbatim.

### get_task(task_id)
Ownership and company checks as above. Return status, `started_at`, `completed_at`,
duration and recorded usage, so Claude can quote Desklog's figures.

### complete_task(task_id, result, summary, usage, usage_complete, source)
Sent by the plugin only after the user approved completion. The plugin fills in
`result`, `summary`, `usage`, `usage_complete` and `source`; Claude supplies only
`task_id`.

    usage:  input_tokens, output_tokens, cache_creation_input_tokens,
            cache_read_input_tokens, total_tokens, api_calls
            (totals across every work round of the task)
    source: channel ("claude_code"), session_id, agent_ids[], rounds,
            completion_key

Rules:
- **Reject a call with no `usage` or no `source.completion_key`.** The plugin's hook adds
  both; if they are missing, the hook did not run, and completing anyway would record a
  task with no tokens. Refuse with a plain sentence instead.
- Only `result = "done"` may complete a task. Reject `"failed"` and `"incomplete"`.
- Task must be In Progress, owned by the caller's bot and company.
- Set `completed_at` from the server clock; duration = `completed_at − started_at`.
  Time spent waiting before `start_task` is not counted.
- **Idempotency by `source.completion_key`:**
  - same key again → return the original success, change nothing, count nothing
    twice;
  - task already completed with a different key → refuse.
- `usage_complete = false` means the last transcript write had not landed when the
  round was measured, so the figures may be slightly low. Store the flag; don't reject.
- Record the channel in the activity log the same way AI-chat writes are marked, so
  a Claude Code completion is distinguishable from a browser one.

## Backend tests to write (deterministic, no model calls)
- user → own bot; user with no bot → `bot: null`
- company A user cannot read or act on company B tasks or bots
- `create_and_assign_tasks` assigns to own bot; rejects bot/assignee fields;
  created tasks are not started
- `start_task` refused while the bot has a task In Progress; two concurrent starts →
  exactly one succeeds
- `start_task` sets `started_at` from the server clock
- `complete_task` rejects failed/incomplete; completes done; duration from server
  timestamps
- same `completion_key` twice → one completion, usage stored once
- different key on an already-completed task → refused
- every tool respects existing permissions exactly as the web UI does

## Server address check (the "Protected resource does not match" error)
Each server's OAuth metadata (`/.well-known/oauth-protected-resource`) must report
ITS OWN MCP address as `resource`:
- app.desklog.io    → `https://app.desklog.io/api/v2/mcp`
- appdev.desklog.io → `https://appdev.desklog.io/api/v2/mcp`
If app.desklog.io reports the appdev address, Claude Code refuses to log in to the live
plugin. That is a configuration value on the live server, not a plugin problem.
