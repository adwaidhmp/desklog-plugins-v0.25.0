# End-to-end checklist (run by you, in a real Claude Code session)

The automated tests prove the hook scripts and plugin files. They do NOT prove the
OAuth login, the real MCP tools, real subagents, real transcripts or Desklog's server
rules. Those need this run. It uses real Claude Code usage, so it is kept to three
scenarios.

For each step, check Desklog itself (UI, or a read-only DB query) — not only what
Claude says. Use a test company with one test user who has a linked bot.

## 0. Install and login
1. `claude --plugin-dir ./plugins/desklog` (or install from the marketplace).
2. `/mcp` → desklog → Authenticate → log in as the test user.
3. `/desklog:status` → shows the test user's own bot, and no other bot.

## 1. Bot free — continuation and repeated completion questions
1. `/desklog:run build a simple settings page` → exactly ONE task is created, on
   your bot, not started (no start time in Desklog).
2. Claude asks "Should I start Task #…?" → answer **No**. Task stays waiting.
3. Ask Claude to start it → it asks again → **Yes**. Desklog shows a start time.
4. When the round finishes, Claude asks "Should I mark Task #… as completed?" →
   **No, I want to test it.** Task stays In Progress.
5. Send "the button is too big" → no new task in Desklog; Claude runs another round.
6. Completion question again → **No, also fix the spacing** → still no new task.
7. Completion question again → **Yes**. Desklog shows: Completed, a completion time,
   duration = completion − start, token usage present.
8. The usage should cover all rounds: the local record shows `rounds: 3` in the
   `source` sent (visible in the `complete_task` call in the transcript).

## 2. Bot busy — waiting task
1. With Task A In Progress on your bot, `/desklog:run fix the dashboard chart`.
2. Task B is created on YOUR bot, not started; Claude says it will wait. Task A is
   untouched.
3. Complete Task A (answer Yes).
4. Claude says the bot is free and asks "Should I start Task B?" → **Yes** → Task B
   starts.
5. Extra check: with Task A running, try starting Task B from a second terminal →
   Desklog refuses; nothing starts.

## 3. Several queued tasks
1. `/desklog:run build the login page, fix the dashboard chart, update the
   notification settings` → three tasks, all on your bot.
2. Start the first → the other two stay waiting.
3. Complete the first → Claude asks about the second only. **Yes.**
4. The third is still waiting. After the second is completed, Claude asks about the
   third.

## Also confirm
- Claude never mentions another user's bot.
- Claude never states a token count or duration of its own; it quotes Desklog.
- Refusing completion while a round ended FAILED: ask Claude to complete → refused
  with a clear reason, task stays In Progress.
