# Database setup

The categorizer's local database is SQLite. `SqliteStorage.init()` creates the schema on first start, and the CLI uses `CATEGORISER_DB` or defaults to `~/.local/share/avi-categoriser/{mock,live}.db`.

Neon is optional. Set `DATABASE_URL` to a Neon Postgres connection string to select `NeonStorage` in live mode. Its `init()` creates the required tables and indexes. `--mock` always stays on SQLite and does not connect to Neon.

```powershell
# Local, offline database
corepack pnpm cli --mock health
corepack pnpm cli --mock save -

# Neon-backed live database (configure DATABASE_URL in your environment first)
corepack pnpm cli save -
```

Do not commit connection strings. The adapter cannot provision a Neon account or database; Neon must provide the database URL first. The browser UI currently uses its separate local browser store and is not wired to this categorizer database.
