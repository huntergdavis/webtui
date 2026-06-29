# /etc/profile.d/vault.sh — wire interactive shells to the vault (PLAN §8.1).
# Sourced at login by /bin/bash --login. Keep it quiet and side-effect-light.

umask 077

# If a vault-unlock session is live, every shell should find the agent on the fixed socket.
SOCK="$HOME/.ssh-agent.sock"
if [ -S "$SOCK" ]; then
  export SSH_AUTH_SOCK="$SOCK"
fi

# One-line status hint at login (no secrets printed).
if [ -f "$HOME/.ssh.age" ]; then
  if [ -n "${SSH_AUTH_SOCK:-}" ] && ssh-add -l >/dev/null 2>&1; then
    echo "vault: unlocked (ssh-agent active). 'vault-lock' to clear."
  else
    echo "vault: locked. 'vault-unlock' to load your SSH key."
  fi
else
  echo "vault: not initialised. 'vault-init' to create an encrypted SSH key."
fi
