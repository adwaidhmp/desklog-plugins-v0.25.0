---
name: status
description: Show the user's own Desklog bot, what it is working on and what is waiting, and offer to start the next waiting task if the bot is free. Use when the user invokes /desklog-dev:status or asks whether their bot is free.
---

1. Call `get_my_bot_users`. If it returns no bot, say no Desklog bot is linked to
   this account and stop. If it returns more than one, ask which one to use.
2. Each bot in the reply has `open_tasks` (to do / in progress / paused, oldest
   first). Use that list. If `open_tasks_has_more` is true, say there are more.
   Only if the reply has no `open_tasks` at all (older server): call
   `get_task_list` filtered by the bot's user id and open statuses. Never fetch the
   task list unfiltered — it is very large. Never guess a task id.
3. Show the bot's name, the task it is working on (if any) and its waiting tasks,
   oldest first. Use Desklog's data plus the plugin's note about tasks started from
   this computer. Quote Desklog's data; never compute times yourself.
4. If the bot is free and has a waiting task, ask about ONE — the oldest:
   "Your bot is free. Should I start Task #<id> — <title>?"
   On a clear yes, start it as the `run` skill describes in "Step 6 — Starting a task". Otherwise do
   nothing — the task keeps waiting.
