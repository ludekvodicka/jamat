FROM node:24

RUN npm install -g @anthropic-ai/claude-code

# Install gosu for dropping privileges
RUN apt-get update && apt-get install -y --no-install-recommends gosu && rm -rf /var/lib/apt/lists/*

# Create non-root user (Claude refuses --dangerously-skip-permissions as root)
RUN useradd -m -s /bin/bash claude
RUN mkdir -p /home/claude/.claude /workspace && chown -R claude:claude /home/claude /workspace

COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

ENV DISABLE_AUTOUPDATER=1
ENV CLAUDE_CODE_SKIP_NATIVE_INSTALL_CHECK=1

WORKDIR /workspace
ENTRYPOINT ["/entrypoint.sh"]
CMD ["claude", "--dangerously-skip-permissions"]
