echo "os=$( . /etc/os-release 2>/dev/null; echo "${PRETTY_NAME:-unknown}" )"
echo "arch=$(uname -m)"
echo "user=$(id -un)"
echo "ram_total_mb=$(free -m | awk '/^Mem:/{print $2}')"
echo "ram_avail_mb=$(free -m | awk '/^Mem:/{print $7}')"
echo "swap_total_mb=$(free -m | awk '/^Swap:/{print $2}')"
echo "disk_free_gb=$(df -BG / | awk 'NR==2{gsub("G","",$4); print $4}')"
echo "disk_total_gb=$(df -BG / | awk 'NR==2{gsub("G","",$2); print $2}')"
echo "node=$(node -v 2>/dev/null || echo none)"
echo "git=$(git --version 2>/dev/null | awk '{print $3}')"
if command -v tmux >/dev/null 2>&1; then echo "tmux=yes"; else echo "tmux=no"; fi
if [ -f "$HOME/.mhcloud/setup-v1" ]; then echo "setup=done"; else echo "setup=missing"; fi
if (ss -ltn 2>/dev/null || netstat -ltn 2>/dev/null) | grep -q ':20128 '; then echo "omniroute=running"; else echo "omniroute=stopped"; fi
echo "omniroute_bin=$(command -v omniroute 2>/dev/null || echo none)"
echo "projects=$(ls -1 "$HOME/mobile-harness/projects" 2>/dev/null | wc -l)"
