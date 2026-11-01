# Use cases

Real situations CCC is built for, with what each person or agent does. "Owner" means you, Ahmed, in the UI. CLI commands are written as `ccc …`. Agents run them as `node "<path>/ccc.mjs" …` or use the matching MCP tool.

## 1. Start a team for a piece of work

1. On the VPS, run `CCC_SESSION=orch claude` and paste the orchestrator prompt from [agent-prompts.md](agent-prompts.md).
2. On the Windows box, run `$env:CCC_SESSION='W1'; claude` and paste the worker prompt. On the Mac, do the same with `W2`.
3. In the UI, open **Controls → Sessions**, set `orch` to the orchestrator role and save.
4. Tell `orch` the goal in its terminal. It splits the goal into tasks with `assign_task`. Each worker gets a "Task T<n>" in its inbox and starts.

On the board you see three cards. Each shows the session's status, what it is working on, and its current task.

## 2. A worker needs a decision

- `W1` runs `ccc ask orchestrator "Use the existing migration slot 0014 or take 0015?" --options "a=0014,b=0015"`.
- The orchestrator answers with `answer_question`. `W1` gets "Answer to Q3: [0015] …" when its turn ends, or straight away if it is waiting.
- If only you can decide (policy, permissions, anything irreversible), the orchestrator asks `owner` with `isBlocking`. The question shows on the **Questions** tab with choice buttons. A blocking question that is still open after 30 min is marked overdue.

## 3. You answer from your phone

1. Open the UI. The board banner shows how many questions are waiting.
2. On **Questions**, tap a choice, or type an answer and tap **Send answer**.
3. The asker gets the answer as an inbox message. Anything you are halfway through typing survives live updates.

## 4. Switching accounts on a usage limit

1. `W1` hits a limit. Close it, switch accounts, and start Claude again with `CCC_SESSION=W1`.
2. The SessionStart hook re-registers it as `W1`. If the old process is idle, the new one takes over; if the old process is still active, the new one becomes `W1-2`. The hook prints the resume context: role, unread count, open tasks and the standing rules.
3. Paste the re-entry prompt. The agent picks up its tasks from the board.
4. If the old process wakes up, every CCC call it makes is refused with "taken over". Its Stop hook tells it once to stop.

## 5. Pause everyone before a risky operation

- In **Controls**, use **Pause all**, or `ccc pause all` from the orchestrator.
- Each session finishes its current step and stops when its turn ends. Its card shows *pause pending* until then, and *Paused* after.
- **Resume all** (`ccc resume all`) lets them continue.
- The orchestrator is never paused by "all".

## 6. A session goes quiet

- **After 15 min with no heartbeat,** the card turns *Unreachable*, and the orchestrator gets "W2 is unreachable … It needs a nudge in its terminal." Go to that terminal. The orchestrator can `reassign_task` anything urgent.
- **After an hour with no activity,** CCC pings the session to report its status. It answers when it next wakes.

## 7. Permission prompts

- When Claude Code shows a permission prompt, the Notification hook sets the card to *Waiting for permission* and shows the prompt text.
- You see which machine needs you without checking every terminal.
- The card clears once the session moves on.

## 8. Hand an instruction to one session

Open the session's card. Under **Message W1**, choose **Instruction** or **Note**, type, and send. It lands when the session's current turn ends. The card's timeline shows what happened.

## 9. Add a machine or lose one

- **New machine:**
  1. **Controls → Devices → Create token.**
  2. On the machine: download `/cli/ccc.mjs`, then run `ccc setup <url> <token>` and `ccc install-hooks --yes`.
  3. Run the printed `claude mcp add-json` command.
- **Lost or retired machine:** revoke its token. All its sessions immediately get 401.

## 10. Audit what happened

Each session's timeline (in the detail dialog) and `GET /api/events` show:

- registrations and takeovers
- status changes
- tasks created, assigned, updated and cancelled
- questions asked and answered
- messages sent

They show who did each one, and when.

## 11. Two projects at once

1. Launch `CCC_PROJECT=ihop CCC_SESSION=orch-ihop claude` and `CCC_PROJECT=kiosk CCC_SESSION=orch-kiosk claude`.
2. Grant each the orchestrator role.
3. Start workers with the matching `CCC_PROJECT`.
4. Use the header picker to watch one project, or **All**.
