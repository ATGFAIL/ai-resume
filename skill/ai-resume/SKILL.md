---
name: ai-resume
description: Run a long unattended AI task (Claude Code / Codex / Agy) so it auto-resumes after a usage-quota limit resets, instead of stalling until the user returns. Use when the user says they are going to sleep/leave, wants an overnight or long autonomous run, or asks about quota/limit reset/auto-resume.
---

# ai-resume

A supervisor (`~/.claude/ai-resume/ai-resume.mjs`, Node, no deps) runs an AI CLI non-interactively. If the run stops on a quota limit it reads the reset time, sleeps until reset + 3 min grace, then resumes the SAME session. State is written to a JSON file.

## Why a skill alone is not enough
Once the quota is hit the agent is dead and cannot schedule anything. So the long task must be launched THROUGH the supervisor (outside the agent), not by the agent promising to wake itself.

## Launch
```
node ~/.claude/ai-resume/ai-resume.mjs --tool claude --prompt "<task>" --cwd <project> \
  --state ./run.state.json [--grace 180] [--max-resumes 20] [--webhook <discord url>] \
  -- --permission-mode acceptEdits
```
- Everything after `--` is passed to the CLI (permission flags are REQUIRED for unattended runs, otherwise it stalls waiting for approval).
- `--tool codex` (uses `codex exec --json`, resume via `codex exec resume`) and `--tool agy` (`-p`, `--conversation`) are best-effort: limit detection is regex + fallbacks, not yet verified against a real limit.
- On Linux/VPS use `~/.claude/ai-resume/bg.sh <name> <same args>` to run detached in tmux (survives ssh disconnect). On Windows use `Start-Process` detached.
- Check on it: `node ~/.claude/ai-resume/ai-resume.mjs status --state <file>` (shows wake-up time).

## Rules for the task itself
- Tell the agent to keep `PROGRESS.md` updated (done / next) so a resumed session knows where to continue.
- Claude quota is per ACCOUNT: PC and VPS on the same login share one quota.
- Claude exposes reset times via `rate_limit_event` in `--output-format stream-json --verbose` (`resetsAt` epoch, `unifiedWindows.five_hour|seven_day.utilization`). To check quota quickly run `claude -p "ok" --output-format stream-json --verbose --no-session-persistence` and read that event. Codex writes `rate_limits.resets_at` in `~/.codex/sessions/**/rollout-*.jsonl`.
