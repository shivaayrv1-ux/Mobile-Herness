# MH Cloud - one-time VPS setup (safe to run again)
SUDO=""
if [ "$(id -u)" != "0" ]; then SUDO="sudo"; fi
step() { echo; echo "##STEP $1"; }
fail() { echo "##FAIL $1"; exit 1; }

step "Checking your VPS"
. /etc/os-release 2>/dev/null
echo "OS: ${PRETTY_NAME:-unknown}  |  CPU: $(uname -m)  |  user: $(id -un)"
case "${ID:-}${ID_LIKE:-}" in
  *ubuntu*|*debian*) echo "Ubuntu/Debian detected - OK" ;;
  *) fail "Only Ubuntu or Debian is supported" ;;
esac
if [ -n "$SUDO" ] && ! sudo -n true 2>/dev/null; then
  fail "This user needs passwordless sudo (or log in as root)"
fi
echo "RAM: $(free -m | awk '/^Mem:/{print $2}') MB   Swap: $(free -m | awk '/^Swap:/{print $2}') MB   Free disk: $(df -BG / | awk 'NR==2{print $4}')"

step "Installing base tools (git, curl, tmux, unzip)"
export DEBIAN_FRONTEND=noninteractive
$SUDO apt-get update -y -qq || fail "apt-get update failed"
$SUDO apt-get install -y -qq --no-install-recommends git curl ca-certificates tmux unzip zip procps openssh-client || fail "Could not install base tools"
echo "git $(git --version | awk '{print $3}'), tmux $(tmux -V | awk '{print $2}')"

step "Preparing extra swap (helps on low RAM)"
SWAP_MB=$(free -m | awk '/^Swap:/{print $2}')
FREE_GB=$(df -BG / | awk 'NR==2{gsub("G","",$4); print $4}')
if [ "$SWAP_MB" -ge 4000 ]; then
  echo "Swap is already ${SWAP_MB} MB - nothing to do"
elif [ "$FREE_GB" -le 10 ]; then
  echo "Only ${FREE_GB} GB disk free - skipping extra swap"
else
  if [ ! -f /swapfile-mh ]; then
    echo "Creating 3 GB swap file..."
    $SUDO fallocate -l 3072M /swapfile-mh 2>/dev/null || $SUDO dd if=/dev/zero of=/swapfile-mh bs=1M count=3072 status=none || fail "Could not create swap file"
    $SUDO chmod 600 /swapfile-mh
    $SUDO mkswap /swapfile-mh >/dev/null || fail "mkswap failed"
  fi
  $SUDO swapon /swapfile-mh 2>/dev/null || true
  grep -q '/swapfile-mh' /etc/fstab || echo '/swapfile-mh none swap sw 0 0' | $SUDO tee -a /etc/fstab >/dev/null
  echo "Swap now: $(free -m | awk '/^Swap:/{print $2}') MB"
fi

step "Creating workspace folders"
mkdir -p "$HOME/mobile-harness/projects" "$HOME/.mhcloud" || fail "Could not create folders"
echo "Projects folder: $HOME/mobile-harness/projects"

step "Checking Node.js and OmniRoute"
if command -v node >/dev/null 2>&1; then echo "Node.js $(node -v)"; else echo "Node.js not found (needed for Claude Code in Phase 2)"; fi
if command -v omniroute >/dev/null 2>&1; then echo "OmniRoute found: $(command -v omniroute)"; else echo "OmniRoute not found in PATH"; fi

echo "v1 $(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$HOME/.mhcloud/setup-v1"
echo "##DONE"
