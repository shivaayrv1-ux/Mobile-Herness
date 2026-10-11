if (ss -ltn 2>/dev/null || netstat -ltn 2>/dev/null) | grep -q ':20128 '; then
  echo "OmniRoute is already running on port 20128"
  exit 0
fi
if ! command -v omniroute >/dev/null 2>&1; then
  echo "##FAIL omniroute command not found on this VPS"
  exit 1
fi
if ! command -v tmux >/dev/null 2>&1; then
  echo "##FAIL tmux is missing - run VPS setup first"
  exit 1
fi
mkdir -p "$HOME/.mhcloud"
cat > "$HOME/.mhcloud/omniroute-run.sh" <<'EOS'
#!/bin/bash
export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"
export PATH="$HOME/.local/bin:/usr/local/bin:$PATH"
exec omniroute
EOS
chmod +x "$HOME/.mhcloud/omniroute-run.sh"
tmux kill-session -t omniroute 2>/dev/null
tmux new-session -d -s omniroute "bash $HOME/.mhcloud/omniroute-run.sh"
echo "Starting OmniRoute (tmux session: omniroute) ..."
for i in $(seq 1 60); do
  if (ss -ltn 2>/dev/null || netstat -ltn 2>/dev/null) | grep -q ':20128 '; then
    echo "OmniRoute is running on port 20128"
    exit 0
  fi
  sleep 1
done
echo "##FAIL OmniRoute did not open port 20128 within 60s (it may still be starting - check again)"
exit 1
