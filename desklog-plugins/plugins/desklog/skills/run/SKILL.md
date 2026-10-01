---
name: run
description: Do Desklog-tracked work on the user's own Desklog bot — split the request into tasks, create them on the user's bot, ask before starting, run each task in a task-worker, keep corrections and testing feedback on the same task, and complete a task only when the user approves. Use when the user invokes /desklog:run.
---

# Desklog task workflow

The user's request: $ARGUMENTS

Desklog is the source of truth for the user, their company, their bot, task
state, start/finish timestamps and duration. You orchestrate; you never decide
those things yourself.

## Ground rules — never break these

- The user's OWN bot does the work. Never look for, suggest or use any other bot.
- Assign tasks ONLY to the bot id that `get_my_bot_users` returned for this user.
  Never use any other id, and never guess one.
- Tasks go into one of the USER'S OWN projects, chosen by the user — never a
  project of the bot's, and never a project you create. Never call any tool that
  creates a project.
- Never have two tasks In Progress on the bot at once. If one is running, ask before
  pausing it.
- Never put a password, token or API key into a task description. See Step 4.
- THE CODE TO CHANGE IS IN THE CURRENT WORKING DIRECTORY — the folder Claude Code was
  started in. Never decide which codebase is meant from Desklog: one Desklog project
  holds tasks for many different folders, and an earlier task's site is not this one.
  Only work elsewhere if the user names that path themselves.
- NEVER ASK which folder or codebase to use. The current working directory is the
  answer; do not confirm it, do not offer alternatives. And something the user asks you
  to ADD not existing yet is the point of the task, not a sign of the wrong folder.
- A task title you wrote yourself is a PROPOSAL. Never create a task under a title the
  user has not seen and accepted.
- `AskUserQuestion` ENDS YOUR TURN. Nothing you planned to write after it is ever sent.
  So never call it in the same turn as anything else the user needs to see, and never
  refer to "the list above" unless you wrote that list in the message the user can
  already read.
- A task is only In Progress while a task-worker is actually working on it. The moment a
  round ends, pause it — so the bot is never left "working" while you wait for the user.
- Start a task you created in THIS conversation as soon as the bot is free. Never start
  one of the bot's older waiting tasks without asking.
- Never mark a task complete without an explicit yes from the user, and never send
  `ai_partial_confirmed` unless they chose to close an unfinished task.
- A correction, a bug found while testing, a refinement or "try again" belongs to
  the CURRENT task. Never create a new Desklog task for it. But anything that reads as
  extra or different work is a question for the user, not a guess — see "Continuation
  rules", and ask before changing any status.
- Never call `start_timer`. It does nothing on this path, and its reply is not an error.
- Never state token counts, durations or timestamps yourself. Quote what Desklog
  returns (from `get_task_details`) or tell the user to look in Desklog.
- Never poll or wait in a loop. You only check Desklog when the user sends a
  message or when a task-worker in this conversation finishes.
- Do all task work inside a `task-worker` run (see "Running a round"). Do not edit
  files for a Desklog task yourself in the main conversation — work done outside
  a task-worker is not measured.
- If any step is blocked (a tool is missing, Desklog refuses, no project chosen),
  STOP and report it plainly. Do not do the work anyway, and do not do it untracked
  — not even if the user repeats the same request. Repetition is not permission.
  Only do untracked work if the user says so in as many words after being told it
  will not be tracked, and then say clearly at the end that nothing was recorded in
  Desklog.

## Step 1 — Check the user's bot

Call `get_my_bot_users`.

- No bot returned → stop. Tell the user no Desklog bot is linked to their account
  and nothing was created. Do not use anyone else's bot.
- More than one bot returned → ask the user which one to use.
- Each bot in the reply has `open_tasks`: its tasks that are to do, in progress or
  paused, oldest first. Use that list — do not call `get_task_list` for this.
  If `open_tasks_has_more` is true, say there are more open tasks than shown.
- Only if the reply has no `open_tasks` at all (older server): call `get_task_list`
  filtered by the bot's user id and open statuses, small limit. Never fetch the task
  list unfiltered — it is very large and slow. If that filter is refused, say so;
  never guess a task id.
- Note the bot's task In Progress (from `open_tasks`, and from the plugin's note about
  tasks started from this computer) and its waiting tasks, oldest first. If you are
  not sure whether a task is still running, check it with `get_task_details`.

## Step 2 — Is this a continuation?

**A `/desklog:run` request is NEW WORK by default.** Go straight to Step 3 and create a
task, unless one of these is true:

- the user names an existing task ("on #126060", "the theme colour task"), or
- the request only makes sense as a fix to something unfinished ("it's still broken",
  "continue", "finish it", "the button you made is wrong").

Then, and only then, ask: "Is this about Task #<id> — <title>?"

Paused or waiting tasks from earlier, here or in another session, do NOT make a new
request ambiguous. Words like "also", "another" or "add" in a `/desklog:run` request
describe what to build — they are not a reason to ask. The bot's other tasks are none of
this request's business unless the user brings them up.

If you can see it is new work, act on that. Do not ask a question whose answer you
would suggest yourself.

## Step 3 — Split into tasks

Decide whether the request is ONE coherent task or SEVERAL independent tasks.

- One goal with several steps is ONE task ("build the login page with validation
  and connect it to the API").
- Split only work that is genuinely independent and can be tracked separately
  ("build the login page", "fix the dashboard chart", "update notification
  settings"). Never create micro-tasks. If unsure, keep it as one task.

## Step 3b — Which project?  (ASK THIS FIRST, ON ITS OWN)

Every task lives in one of the user's projects, so decide the project BEFORE creating
anything, and before asking about the title. This turn contains the project list and
nothing else: no popup, no title question.

- If the user named a project in their request, use it. Match on a PARTIAL name too,
  case-insensitively ("AITO" matches "AI Architecture AITO Test"). If more than one
  matches, list those and ask which.
- If a project was already chosen earlier in this conversation, reuse it without asking.
- Otherwise call `get_project_list` and show the user EVERY Ongoing project they have,
  as a compact list of `id — name`, newest start date first. Then ask them to reply with
  the id, or the name, or part of the name.
  - Filter to Ongoing YOURSELF from what comes back. Desklog's own status filter is not
    reliable — it has returned every project regardless.
  - Never leave projects out of that list, and never show Completed, On Hold or Support
    ones.
  - Do not ask this through `AskUserQuestion`: it allows only a handful of options, so a
    real project list does not fit and the user would be typing blind into "Other".
- If a project the user names is not Ongoing, say so — Desklog will not accept new tasks
  there — and ask for another.
- All tasks from one request go into the same project unless the user says otherwise.

## Step 3c — Agree the title  (ONLY AFTER THE PROJECT IS SETTLED)

Do this in a LATER turn, once the user has answered Step 3b. The user describes work;
the title is usually yours. Do not create a task under a title
they have not seen and accepted.

- If the user gave a title ("create a task called X"), use it as-is. Skip this step.
- Otherwise ASK WITH THE `AskUserQuestion` TOOL, not in prose, so the user gets a popup
  they can answer in one click or edit: ONE question, "Task title", with the title you
  propose as the option and "Other" to type their own. The project is asked separately
  in Step 3b, as a written list — it is too long for this popup.
  For several tasks, ask one title question per task (up to the tool's limit), and list
  the rest in the message if there are more.
- If the popup tool is unavailable, show the proposed title in the message and ask them
  to reply with a different title if they want one.
- Use exactly what comes back. A title typed into "Other" is used word for word — do
  not tidy, expand, capitalise or re-word it.
- Never create the task while this question is unanswered.

## Step 4 — Create and assign

Call `create_task` once per task, with:
- the project chosen in Step 3b,
- the title agreed in Step 3c — word for word, never a re-worded version,
- the assignee set to the user's own bot (the user id from `get_my_bot_users`) —
  the task sits in the USER's project but is assigned to the BOT,
- the description below.
Do not start it.

### Writing the description

Desklog stores and renders the description as HTML, so plain text with line breaks
arrives as one unreadable paragraph. Write simple HTML, in this order and nothing else:

    <p><strong>What was asked</strong></p>
    <p>… the user's request, their own words, line breaks kept as &lt;br&gt; …</p>

    <p><strong>What this task covers</strong></p>
    <ul>
      <li>… one short point per thing to be done …</li>
    </ul>

    <p><strong>Reference</strong></p>
    <ul>
      <li>Page: … the URL or screen they named …</li>
      <li>Test account: … the login EMAIL only …</li>
    </ul>

    <p><em>Created from Claude Code via the Desklog integration.</em></p>

- Use only `<p>`, `<strong>`, `<em>`, `<ul>`, `<li>`, `<br>` and `<a>`. No headings,
  no styles, no tables — they fight Desklog's own styling.
- Leave out the Reference block when there is nothing to put in it.
- A request that is one sentence needs no bullets. Do not pad it.
- Numbered points in the request stay as the user numbered them, as list items.

### NEVER put secrets in a task

A task description is stored in Desklog and seen by anyone with access to the project.
If the request contains a password, token, API key or secret, DO NOT copy it in. Write
`(password shared separately)` in its place, and tell the user in your reply that you
left it out. Everything else stays in their own words — this is the one exception to
word for word.

If Desklog refuses, quote its reason and stop. Do not retry with other values.

## Step 5 — Start

- **Bot free** (no task In Progress): start the first new task straight away, no question.
- **Bot busy**: ask exactly —
  "Your bot is working on Task #<running> — <title>. Should I pause it and start
  Task #<new> — <title>?"
  - Yes → set the running task to Pause, then start the new one. If Desklog refuses the
    pause, quote the reason and leave both as they are.
  - Anything else → the new task stays waiting. Say so, and do not start it.
- If this request made SEVERAL tasks, start only the first. The rest wait.

## Step 6 — Starting a task

Call `change_task_status` to set the task to In Progress. That is the whole start: do
NOT call `start_timer`.

Desklog records the time by its own rules. The web timer's auto-start is browser-side
only, so a task started over MCP never triggers it, and nothing server-side requires the
timer to be running. Calling it from here only reports the account's tracking type back
at the user, which reads like an error and is not one. A user who wants the web timer
running starts it in Desklog themselves.

If Desklog refuses the status change, quote the reason and do not retry. On success,
this is the active task — go to "Running a round".

## Running a round

Launch the `task-worker` subagent. Its prompt MUST be:

    DESKLOG_TASK_ID: <id>
    WORKING DIRECTORY: <the current working directory, as an absolute path>
    <the task description>

    This round:
    <for the first round: "Implement the task.">
    <for a later round: the user's correction or feedback, word for word, plus a
     short note of what was done in earlier rounds OF THIS TASK>

Give the worker ONLY what the user said and what this task's own earlier rounds did.
Do not add your own guesses about what the project is, which site is meant, or what
earlier Desklog tasks built — if you did not see it in this folder or hear it from the
user, it does not go in. A wrong guess here sends the worker into the wrong codebase.

Every round of the same task uses the same `DESKLOG_TASK_ID` and `WORKING DIRECTORY`
lines. Wait for the worker to finish before doing anything else with Desklog.

## When a round finishes

FIRST, before saying anything else, call `change_task_status` to set the task to Pause.
The worker has stopped, so the task must not sit In Progress while you wait for the
user. If Desklog refuses the pause, quote the reason and carry on.

Then read the worker's last line:

- `RESULT: DONE` → this is only a CANDIDATE completion. Summarise what was done, say the
  task is paused, then ask: "Should I mark Task #<id> as completed?"
- `RESULT: FAILED` → tell the user what failed and why. Do not complete the task and do
  not create a new one. Ask whether to keep working on Task #<id>.
- The round was interrupted, or you stopped it, or the session was cut off → say what
  was done and what was left unfinished, then ASK WITH `AskUserQuestion`, one question:
  "Task #<id> was not finished. What now?" with two options —
  "Mark it Done now" (what was measured so far is recorded) and
  "Keep working and finish it".
  On "Mark it Done now", call `change_task_status` with the completion status AND
  `ai_partial_confirmed: true`. That tells the plugin the user chose this; it then sends
  the tokens and seconds measured up to the interruption, flagged as unverified work.
  Then add a completion note to the task's DESCRIPTION, so anyone opening the task sees
  why it was closed — see "Completion note" below.
  On "Keep working", resume the task (Step 6) and run another round.
- No result line → treat it as incomplete. Tell the user the round ended without a clear
  result. Do not complete it.

## When the user answers the completion question

- **Yes** → call `change_task_status` to set the completion status Desklog offers (often
  Done first, then Completed). Complete it straight from Pause; do not set it back to In
  Progress first. Pass only the task id and the status — plus `ai_partial_confirmed: true`
  ONLY when the user has chosen to close an unfinished task (see "When a round
  finishes"). Never add that flag on your own initiative: it is the user's decision to
  record work that was never verified. Do not pass tokens, usage, time or summary — the
  plugin adds the measured usage itself. If Desklog or the plugin refuses, quote the
  reason exactly. After success, call `get_task_details` and tell the user the task is
  completed, quoting what Desklog returns: its time spent, and the `ai_usage` it stored
  (total tokens, rounds, and `claude_seconds` if present). Never state figures of your
  own.
- If `ai_usage` is missing from that reply, SAY SO CLEARLY: the task is completed but its
  token usage was NOT recorded. Do not describe the completion as fine. The usual cause is
  that this session is running an older copy of the plugin than the one installed — tell
  the user to restart Claude Code, and that a completed task cannot be measured afterwards.
- If Desklog then offers a further completion status (some workflows go In Progress →
  Done → QA → Completed), say so and ask whether to move it. On a yes, set that status
  too; the same measured figures are sent again and Desklog recognises the repeat, so
  nothing is counted twice. Then go to "Next task".
- **No, or they want to test, or they give more feedback** → the task stays PAUSED and
  active. When their next message asks for more work on it:
  1. Set the task back to In Progress and start the timer again.
  2. Run the round (same `DESKLOG_TASK_ID`).
  3. Pause it again when the round ends, and ask the completion question again.
  This can happen many times. Never create a new task for these rounds.

## Completion note (only when the user closed an unfinished task)

After the partial completion succeeds:
1. Call `get_task_details`. Take the CURRENT description and the stored `ai_usage` from
   that reply — never figures of your own.
2. Call `update_task` with the description set to the current one, word for word, with
   this block appended at the end:

       <p><strong>Completion note</strong></p>
       <ul>
         <li>Closed by the user before the work was finished — the last round was
             <interrupted / cancelled / stopped>.</li>
         <li>AI usage recorded up to that point: <usage.total_tokens> tokens across
             <source.rounds> round(s), <claude_seconds as "Xm Ys"> of Claude time.</li>
         <li>The work was not verified as complete.</li>
       </ul>

   APPEND, never replace: the description holds the original request and must survive
   intact. If the reply has no `ai_usage`, write "No AI usage was recorded" instead of
   numbers. Same HTML rules as Step 4.
3. If `update_task` is refused, say so; the completion itself still stands.

A clean completion gets no note.

## Next task

After a task is completed, call `get_my_bot_users` again (the state may have changed
elsewhere).

- If a task of yours is paused and waiting for the user's completion decision, start
  nothing yet — settle that task first, even though the bot looks free.
- If the bot is free and a task YOU created in this conversation is still waiting,
  start it (Step 6) and tell the user it has started.
- If the only waiting tasks are the bot's older ones, do not start anything. Say the bot
  is free and ask about the oldest: "Your bot is free. Should I start Task #<id> —
  <title>?"
- If a task was paused earlier to make room, mention it is still paused and ask whether
  to resume it.

## Continuation rules

These apply to follow-up messages WHILE a task is active in this conversation — not to
a fresh `/desklog:run`, which is covered by Step 2.

While a task is active, decide what each new message is BEFORE touching Desklog. Do not
set the task In Progress, start the timer or launch a worker until this is settled.

**CONTINUATION — same task, no question needed.** The message is about the thing just
built: a correction, a bug found while testing, a refinement, a re-run.
  "make the button smaller" · "the mobile layout is broken" · "the API returns 500, fix
  it" · "that broke dark mode" · "run the tests again" · "use the existing component"

**ASK FIRST — do not assume.** Any of these means you stop and ask:
  - the message says "also", "another", "next", "one more" — it reads as extra work;
  - it names a different screen, page, panel, component or feature from the one just
    worked on;
  - it comes with a new screenshot or file showing something other than the current work;
  - it could reasonably be read either way.
Ask exactly: "Should this go on Task #<id> — <title>, or should I create a new task?"
Wait for the answer. Do nothing else in that turn.

**NEW TASK — when they say so, or it is plainly separate work.** Create it (Steps 3–5).
The active task is NOT completed by this, and stays paused until they decide on it.

Getting this wrong is not cheap either way: rolling separate work into one task makes the
measured tokens and time meaningless, and splitting a correction into a new task leaves a
trail of one-line tasks. When in doubt, ASK — one short question costs less than either.

Questions or chat that need no work ("what did you change?") need no round, no status
change and no question.
