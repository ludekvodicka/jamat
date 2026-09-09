# Recognised by FILENAME. Recipe lines need real tabs, so this file also proves that a tab
# survives the reader, the highlighter and the raw view unchanged.
NODE ?= node
OUT  ?= out

.PHONY: all clean check

all: $(OUT)/start.js

$(OUT)/start.js: src/app.ts
	pnpm build

check:
	pnpm typecheck && pnpm test

clean:
	rm -rf $(OUT)
