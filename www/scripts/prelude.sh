# MH Cloud prelude: makes node/npm (nvm) and ~/.local/bin visible to non-interactive SSH commands
export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh" >/dev/null 2>&1
export PATH="$HOME/.local/bin:/usr/local/bin:$PATH"
