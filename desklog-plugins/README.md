# Desklog plugins for Claude Code — v0.25.1

Run Desklog tasks from Claude Code on **your own Desklog bot**. Claude asks before
starting a task, keeps corrections and testing feedback on the same task, and
completes a task only when you say yes. Token usage is measured automatically.

## Two plugins, one marketplace
    desklog       live → https://app.desklog.io/api/v2/mcp      /desklog:run, /desklog:status
    desklog-dev   dev  → https://appdev.desklog.io/api/v2/mcp   /desklog-dev:run, /desklog-dev:status
Fully separate: own login, own commands, own token records.

## Install / update (from inside this folder)
    claude plugin uninstall desklog@desklog-plugins
    claude plugin uninstall desklog-dev@desklog-plugins
    claude plugin marketplace remove desklog-plugins
    claude plugin marketplace add ./
    claude plugin install desklog@desklog-plugins
    claude plugin install desklog-dev@desklog-plugins
Then in Claude Code: /mcp → choose the server → Authenticate.

## Desklog tools used
    get_my_bot_users      find my own bot and its open tasks (open_tasks, oldest first)
    get_project_list      my own projects — the user picks which one the task goes in
    create_task           create a task, assigned to my bot
    change_task_status    In Progress to start; Completed to finish
    get_task_list         fallback only, if a server does not return open_tasks
    get_task_details      read a task (status, times, usage)
    update_task           not used by the plugin

## desklog.config.json — edit this when your tool parameters are confirmed
    fields.task_id / fields.status   the parameter names in change_task_status
    status_values.completed          the value(s) that mean Completed  (triggers the gate + usage)
    status_values.in_progress        the value(s) that mean In Progress
    fields.assignee                  the parameter name(s) in create_task that assign the bot
    usage.field                      the parameter the measured usage is sent in (default "ai_usage")
    usage.max_agent_ids              how many round ids to send (default 50, matches the server)
    usage.partial_ack_field          the flag Claude adds once the user approves closing an
                                     unfinished task (default "ai_partial_confirmed"); it is
                                     stripped before the call reaches Desklog
    data_dir                         where measurements are kept — OUTSIDE the plugin folder, so an
                                     upgrade or reinstall cannot delete an in-progress task's tokens
                                     (live: ~/.desklog-claude-code, dev: ~/.desklog-claude-code-dev)
    usage.include_claude_seconds     send how long Claude worked (Desklog still owns task time)
    usage.inject_into_status_call    set false if Desklog rejects the extra field (usage is then
                                     kept only in the local completed-tasks.jsonl)
The same file exists in both plugins; edit both, then reinstall.

## Requirements
Node 18+ on the PATH Claude Code runs hooks with. No npm packages, no build step, no
shell scripts. Every hook is one command — `node "<plugin>/scripts/hook.js" <name>` —
which Claude Code runs through sh on Linux/macOS and Git Bash or PowerShell on Windows,
so the same file serves all three. Run `/desklog:check` to confirm.

## If the hooks do not run
Hooks run in a bare shell. If Node came from nvm, fnm, asdf, volta or Homebrew it is
often not on PATH there, and the hooks fail silently — nothing measured, nothing gated.
`scripts/run-node.sh` looks for Node in those places. To pin it yourself, set
`DESKLOG_NODE=/full/path/to/node` in the environment Claude Code starts from.
Signs the hooks are not running: no "Desklog plugin: hooks active" line when a task is
created, and a completion that is allowed even though no work was measured.

## What the hooks do
    record-usage.js   a work round ends → measure its tokens → add to the task's local record
    status-pre.js     setting Completed → refuse unless the last round ended DONE; add measured usage
    status-post.js    Desklog accepted In Progress → remember the task as running here;
                      accepted Completed → write the local ledger, clear the record
    bots-post.js      after get_my_bot_users → remember my bot ids; tell Claude what is running here
    create-guard.js   before create_task → refuse any assignee that is not my bot

## Checks
    node --test test/hooks.test.js    57 tests, no network, no model (in each plugin folder)
    claude plugin validate .          passes

## Where the usage ends up
Desklog stores it on the task itself, in the `settings` JSON column under `ai_usage`
(merged with whatever else that column holds), only on a completion status, and only
once per `completion_key`. `get_task_details` returns it. The plugin also keeps its own
copy in `completed-tasks.jsonl` under the plugin's data folder.
