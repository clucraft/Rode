# Rode — developer and operator entry points.
# `make` with no target prints this list.

.DEFAULT_GOAL := help
SHELL := /bin/sh
COMPOSE ?= docker compose
SCENARIO ?= quiet-night
SPEED ?= 60
HOST ?= 192.168.1.100
PORT ?= 39150

.PHONY: help install up down dev test lint typecheck check build sim record backup logs clean

help: ## Show this help
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | sort | awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-12s\033[0m %s\n", $$1, $$2}'

install: ## Install dependencies (pnpm)
	pnpm install --frozen-lockfile

up: ## Start the production stack (detached)
	$(COMPOSE) -f docker-compose.yml up -d

down: ## Stop the stack
	$(COMPOSE) down

dev: ## Run server + web from source with hot reload (no Docker)
	pnpm dev

test: ## Run the full test suite
	pnpm test

lint: ## Lint + format check
	pnpm lint && pnpm format:check

typecheck: ## Type-check every package
	pnpm typecheck

check: lint typecheck test ## Everything CI runs

build: ## Build server bundle and web app
	pnpm build

sim: ## Play a simulator scenario as a fake Cortex on :39150 (SCENARIO=slow-drag SPEED=60)
	pnpm --filter @rode/ingest sim serve --scenario $(SCENARIO) --speed $(SPEED)

record: ## Record the live NMEA stream from the Cortex to recordings/ (HOST=... PORT=...)
	pnpm --filter @rode/ingest sim record --host $(HOST) --port $(PORT)

backup: ## Consistent SQLite snapshot of the running database into ./backups
	@echo "backup tooling arrives in phase 10 (uses VACUUM INTO for a consistent copy)"; exit 1

logs: ## Tail the stack logs
	$(COMPOSE) logs -f --tail=200

clean: ## Remove build output and node_modules
	pnpm clean
