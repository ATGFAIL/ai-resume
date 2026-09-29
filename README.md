# ai-resume

Auto-resume AI coding CLIs (**Claude Code**, **Codex**, **Antigravity `agy`**) after a usage-quota limit resets, so an overnight / unattended run doesn't sit dead until you come back.

A quota-limited agent can't schedule its own wake-up (it's already stopped), so this is a small **supervisor outside the agent**: it runs the CLI non-interactively, watches for the limit, sleeps until the reset time + a grace period (default 3 min), then resumes the **same session**. Single file, Node 18+, no dependencies. Works on Windows, macOS, Linux, and over SSH.

> อ่านภาษาไทยด้านล่าง / Thai notes at the bottom.

## Status

| CLI | Run + resume | Limit detection |
|---|---|---|
| Claude Code | verified | uses the `rate_limit_event` (`resetsAt`) from `--output-format stream-json`; simulated end-to-end, **not yet verified against a real rejection** |
| Codex (`codex exec`) | verified | best-effort (regex + reads `rate_limits.resets_at` from `~/.codex/sessions`) |
| Antigravity (`agy`) | verified | best-effort (regex; falls back to waiting 5h) |

Issues / PRs with real limit-hit logs are very welcome.

## Usage

```bash
node ai-resume.mjs --tool claude --prompt "Do the task. Keep PROGRESS.md updated." \
  --cwd ./my-project --state ./run.state.json \
  -- --permission-mode acceptEdits
```

- Everything after `--` is passed to the CLI. **Unattended runs need a permission mode/flags**, otherwise the CLI stalls waiting for approval.
- `--tool claude|codex|agy`, `--grace 180` (seconds), `--max-resumes 20`, `--webhook <url>` (Discord-style `{content}` POST on limit/finish), `--bin <path>` (CLI path if not on PATH), `--resume-prompt "..."`.
- Status: `node ai-resume.mjs status --state ./run.state.json` (shows wake-up time).
- Set `AI_RESUME_ECHO=1` to echo the CLI's JSON stream.

### Detached over SSH (Linux/macOS)
```bash
./bg.sh night --tool claude --prompt "..." -- --permission-mode acceptEdits
tmux attach -t ai-night        # watch; detach with Ctrl+B D
```
On Windows use Task Scheduler or `Start-Process` so the job isn't tied to your terminal.

## Install as a Claude Code plugin (recommended)
```
/plugin marketplace add ATGFAIL/ai-resume
/plugin install ai-resume@atgfail-tools
```
The bundled skill then tells the agent how to launch long tasks through the supervisor.

## Install manually as a skill
Copy `skills/ai-resume` into `~/.claude/skills/` (also works in `~/.codex/skills/`) and put `ai-resume.mjs` in `~/.claude/ai-resume/` — the skill tells the agent how to launch long tasks through the supervisor. Tell your agent to keep a `PROGRESS.md` so a resumed session knows where to continue.

## Checking quota manually
- Claude: `claude -p ok --output-format stream-json --verbose --no-session-persistence` → `rate_limit_event.rate_limit_info.unifiedWindows.{five_hour,seven_day}.{utilization,resetsAt}`.
- Codex: `rate_limits.{primary,secondary}.{used_percent,resets_at}` in `~/.codex/sessions/**/rollout-*.jsonl`.

## Caveats
- Quota is per **account**: several machines on one login share it.
- The machine must stay awake. The wait loop polls every 30 s so it recovers after suspend.
- `--max-resumes` stops runaway loops. Use restrictive permissions and a dedicated `--cwd`; running with bypassed permissions unattended is risky.
- Not affiliated with Anthropic, OpenAI or Google. Check each provider's terms before automating.

## ภาษาไทย
สคริปต์ครอบ CLI (Claude Code / Codex / Agy) ที่รันงานแบบไม่โต้ตอบ พอชนลิมิตโควต้ามันจะอ่านเวลารีเซ็ต รอ + เผื่อ 3 นาที แล้ว resume session เดิมให้เอง เหมาะกับปล่อยงานทิ้งไว้ข้ามคืน (ใช้ผ่าน ssh + tmux ได้) อย่าลืมใส่ `--permission-mode` และให้ AI อัปเดต `PROGRESS.md` เป็นระยะ

## License
MIT
