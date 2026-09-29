#!/usr/bin/env bash
# Start ai-resume detached in tmux so it survives ssh disconnects.
# usage: bg.sh <session-name> <ai-resume args...>
set -e
name="$1"; shift
export PATH="$HOME/.local/bin:$PATH"
dir="$(cd "$(dirname "$0")" && pwd)"
tmux new-session -d -s "ai-$name" "cd '$PWD' && node '$dir/ai-resume.mjs' --state '$dir/$name.state.json' $(printf '%q ' "$@") 2>&1 | tee '$dir/$name.log'; echo '[finished - press enter]'; read"
echo "started tmux session ai-$name  (attach: tmux attach -t ai-$name | status: node $dir/ai-resume.mjs status --state $dir/$name.state.json)"
