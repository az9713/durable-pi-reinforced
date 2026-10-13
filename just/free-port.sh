#!/usr/bin/env sh
# Stop whatever listens on a TCP port so a server can take it: SIGTERM, then SIGKILL after 5s.
port="$1"
pids=$(lsof -ti "tcp:$port" -sTCP:LISTEN 2>/dev/null)
[ -z "$pids" ] && exit 0
echo "port $port in use; stopping pid $(echo $pids)" >&2
kill $pids 2>/dev/null
i=0
while [ $i -lt 10 ]; do
  sleep 0.5
  lsof -ti "tcp:$port" -sTCP:LISTEN >/dev/null 2>&1 || exit 0
  i=$((i + 1))
done
kill -9 $(lsof -ti "tcp:$port" -sTCP:LISTEN 2>/dev/null) 2>/dev/null
exit 0
