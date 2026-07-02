#!/bin/bash

CLAUDE_HOME="/home/claude"

# Fix ownership of mounted volumes
chown -R claude:claude "$CLAUDE_HOME/.claude" 2>/dev/null
chown claude:claude /workspace 2>/dev/null

# Symlink ~/.claude.json → ~/.claude/.claude.json (Claude expects it in home root)
if [ -f "$CLAUDE_HOME/.claude.json" ] && [ ! -L "$CLAUDE_HOME/.claude.json" ]; then
  # Move existing file into the persistent volume
  cp "$CLAUDE_HOME/.claude.json" "$CLAUDE_HOME/.claude/.claude.json"
  rm "$CLAUDE_HOME/.claude.json"
  ln -s "$CLAUDE_HOME/.claude/.claude.json" "$CLAUDE_HOME/.claude.json"
elif [ -f "$CLAUDE_HOME/.claude/.claude.json" ]; then
  ln -sf "$CLAUDE_HOME/.claude/.claude.json" "$CLAUDE_HOME/.claude.json"
elif ls "$CLAUDE_HOME/.claude/backups/.claude.json.backup."* 1>/dev/null 2>&1; then
  latest_backup=$(ls -t "$CLAUDE_HOME/.claude/backups/.claude.json.backup."* | head -1)
  cp "$latest_backup" "$CLAUDE_HOME/.claude/.claude.json"
  ln -sf "$CLAUDE_HOME/.claude/.claude.json" "$CLAUDE_HOME/.claude.json"
fi
chown -h claude:claude "$CLAUDE_HOME/.claude.json" 2>/dev/null

# Sync credentials from host (always, to keep tokens fresh)
if [ -f /host-claude/.credentials.json ]; then
  cp -f /host-claude/.credentials.json "$CLAUDE_HOME/.claude/.credentials.json"
  chown claude:claude "$CLAUDE_HOME/.claude/.credentials.json"
fi


# Copy only known_hosts from host SSH (no private keys in the container)
if [ -f /host-ssh/known_hosts ]; then
  mkdir -p "$CLAUDE_HOME/.ssh"
  cp /host-ssh/known_hosts "$CLAUDE_HOME/.ssh/known_hosts"
  chown -R claude:claude "$CLAUDE_HOME/.ssh"
  chmod 700 "$CLAUDE_HOME/.ssh"
  chmod 644 "$CLAUDE_HOME/.ssh/known_hosts"
fi

# Rewrite GitHub SSH URLs to HTTPS (no SSH keys needed)
gosu claude git config --global url."https://github.com/".insteadOf "git@github.com:"

# Drop to non-root user and exec the command
exec gosu claude "$@"
