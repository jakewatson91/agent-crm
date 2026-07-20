#!/bin/zsh
cd /Users/jakewatson/src/agent-crm
deadline=$(( $(date +%s) + 5400 ))
while [ $(date +%s) -lt $deadline ]; do
  n=$(pnpm tsx scripts/_chk_sudden_facts_count.ts 2>/dev/null | grep -o '[0-9]*' | head -1)
  if [ -n "$n" ] && [ "$n" -gt 0 ]; then echo "enricher landed $n facts on Sudden from the research signals"; exit 0; fi
  sleep 120
done
echo "TIMEOUT: no enricher facts on Sudden within 90 min of research signals — check subscription matching / coalesce window"
