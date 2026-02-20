.PHONY: install build build-node build-python build-dashboard test test-node test-python clean dev

# ── Install ──────────────────────────────────────────────
install:
	npm install
	cd python && uv sync

# ── Build ────────────────────────────────────────────────
build: build-node build-dashboard

build-node:
	npm run build --workspace=node

build-dashboard:
	npm run build --workspace=dashboard

build-python-dashboard:
	cd dashboard && python build.py

# ── Test ─────────────────────────────────────────────────
test: test-node test-python

test-node:
	npm run typecheck --workspace=node

test-python:
	cd python && uv run pytest

# ── Clean ────────────────────────────────────────────────
clean:
	npm run clean
	cd python && rm -rf dist/ build/ *.egg-info/

# ── Dev ──────────────────────────────────────────────────
dev-dashboard:
	npm run watch --workspace=dashboard
