#!/bin/zsh
cd /Users/jakewatson/src/agent-crm
until pnpm tsx scripts/_chk_sudden_schedule.ts 2>/dev/null | grep -qE "research_completed.*results_created.:[1-9]|signals last 72h === [1-9]"; do sleep 20; done
echo "research produced results"
