package repository

import (
	"database/sql"
	"fmt"
	"os"
	"path/filepath"

	_ "modernc.org/sqlite" // 注册纯 Go 实现的 SQLite 驱动
)

// InitDB opens (and if necessary creates) the SQLite database.
//
// Connection settings worth knowing about:
//   - WAL + busy_timeout let readers run alongside the single writer.
//   - foreign_keys must be switched on per connection; without it the
//     ON DELETE CASCADE clauses in the schema are silently ignored.
//   - _txlock=immediate makes every transaction take the write lock up front,
//     so a read-then-write transaction cannot fail with SQLITE_BUSY halfway.
func InitDB(dbPath string) (*sql.DB, error) {
	memory := dbPath == ":memory:"
	if !memory {
		if err := os.MkdirAll(filepath.Dir(dbPath), 0o755); err != nil {
			return nil, fmt.Errorf("failed to create db directory: %w", err)
		}
	}

	dsn := dbPath + "?_pragma=journal_mode(WAL)&_pragma=busy_timeout(5000)&_pragma=synchronous(NORMAL)" +
		"&_pragma=foreign_keys(1)&_txlock=immediate"
	db, err := sql.Open("sqlite", dsn)
	if err != nil {
		return nil, fmt.Errorf("failed to open sqlite: %w", err)
	}

	if memory {
		// Every connection to ":memory:" is a separate empty database.
		db.SetMaxOpenConns(1)
		db.SetMaxIdleConns(1)
	} else {
		db.SetMaxOpenConns(10)
		db.SetMaxIdleConns(5)
	}

	if err := db.Ping(); err != nil {
		_ = db.Close()
		return nil, fmt.Errorf("failed to ping sqlite: %w", err)
	}
	if err := createTables(db); err != nil {
		_ = db.Close()
		return nil, fmt.Errorf("failed to create tables: %w", err)
	}
	if err := migrateLegacy(db); err != nil {
		_ = db.Close()
		return nil, fmt.Errorf("failed to migrate legacy schema: %w", err)
	}
	return db, nil
}

func createTables(db *sql.DB) error {
	schema := `
	CREATE TABLE IF NOT EXISTS sources (
		chat_id INTEGER PRIMARY KEY,
		name TEXT NOT NULL,
		source_url TEXT NOT NULL UNIQUE,
		source_type TEXT NOT NULL DEFAULT 'telegram_public',
		adapter TEXT NOT NULL DEFAULT 'telegram_public',
		locator TEXT NOT NULL DEFAULT '',
		enabled INTEGER NOT NULL DEFAULT 1,
		public_visible INTEGER NOT NULL DEFAULT 0,
		created_at TEXT NOT NULL,
		updated_at TEXT NOT NULL
	);

	CREATE INDEX IF NOT EXISTS idx_sources_visibility
		ON sources(enabled, public_visible, name);

	CREATE TABLE IF NOT EXISTS messages (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		chat_id INTEGER NOT NULL,
		chat_title TEXT NOT NULL DEFAULT '',
		message_id INTEGER NOT NULL,
		sender_name TEXT NOT NULL DEFAULT '',
		message_time TEXT NOT NULL,
		content TEXT NOT NULL DEFAULT '',
		media_type TEXT,
		raw_json TEXT NOT NULL,
		created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
		forwarded_at TEXT,
		content_version INTEGER NOT NULL DEFAULT 1,
		UNIQUE(chat_id, message_id)
	);

	CREATE INDEX IF NOT EXISTS idx_messages_feed
		ON messages(message_time DESC, id DESC);

	CREATE INDEX IF NOT EXISTS idx_messages_chat_feed
		ON messages(chat_id, message_time DESC, id DESC);

	CREATE TABLE IF NOT EXISTS source_runs (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		chat_id INTEGER NOT NULL,
		source TEXT NOT NULL DEFAULT '',
		started_at TEXT NOT NULL,
		finished_at TEXT NOT NULL,
		fetched_count INTEGER NOT NULL DEFAULT 0,
		saved_count INTEGER NOT NULL DEFAULT 0,
		error TEXT
	);

	CREATE INDEX IF NOT EXISTS idx_source_runs_chat_finished
		ON source_runs(chat_id, finished_at DESC, id DESC);

	CREATE TABLE IF NOT EXISTS site_visits (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		visited_at TEXT NOT NULL,
		ip TEXT NOT NULL,
		path TEXT NOT NULL,
		method TEXT NOT NULL DEFAULT 'GET',
		user_agent TEXT NOT NULL DEFAULT '',
		referer TEXT NOT NULL DEFAULT ''
	);

	CREATE INDEX IF NOT EXISTS idx_site_visits_visited_at ON site_visits(visited_at DESC);
	CREATE INDEX IF NOT EXISTS idx_site_visits_ip ON site_visits(ip);

	CREATE TABLE IF NOT EXISTS feedback (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		message TEXT NOT NULL,
		ip TEXT NOT NULL DEFAULT '',
		status TEXT NOT NULL DEFAULT 'new',
		created_at TEXT NOT NULL,
		updated_at TEXT NOT NULL
	);

	CREATE TABLE IF NOT EXISTS alert_rules (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		name TEXT NOT NULL,
		keyword TEXT NOT NULL,
		media_type TEXT,
		quiet_start TEXT,
		quiet_end TEXT,
		cooldown_minutes INTEGER NOT NULL DEFAULT 0,
		enabled INTEGER NOT NULL DEFAULT 0,
		created_at TEXT NOT NULL,
		updated_at TEXT NOT NULL
	);

	CREATE TABLE IF NOT EXISTS alert_rule_sources (
		rule_id INTEGER NOT NULL REFERENCES alert_rules(id) ON DELETE CASCADE,
		chat_id INTEGER NOT NULL,
		PRIMARY KEY(rule_id, chat_id)
	);

	CREATE TABLE IF NOT EXISTS alert_matches (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		rule_id INTEGER NOT NULL REFERENCES alert_rules(id) ON DELETE CASCADE,
		message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
		status TEXT NOT NULL DEFAULT 'new',
		matched_at TEXT NOT NULL,
		acknowledged_at TEXT,
		resolved_at TEXT,
		UNIQUE(rule_id, message_id)
	);

	CREATE INDEX IF NOT EXISTS idx_alert_matches_status
		ON alert_matches(status, matched_at DESC);
	`
	_, err := db.Exec(schema)
	return err
}

// migrateLegacy brings databases created by older versions of the service (the
// Python one added these columns over time) up to the shape this code reads.
// All steps are idempotent.
func migrateLegacy(db *sql.DB) error {
	steps := []struct{ table, column, definition string }{
		{"sources", "adapter", "TEXT NOT NULL DEFAULT ''"},
		{"sources", "locator", "TEXT NOT NULL DEFAULT ''"},
		{"messages", "content_version", "INTEGER NOT NULL DEFAULT 1"},
	}
	for _, s := range steps {
		if err := ensureColumn(db, s.table, s.column, s.definition); err != nil {
			return err
		}
	}
	if _, err := db.Exec(`UPDATE sources SET adapter = source_type WHERE adapter = '' OR adapter IS NULL`); err != nil {
		return err
	}
	_, err := db.Exec(`UPDATE sources SET locator = source_url WHERE locator = '' OR locator IS NULL`)
	return err
}

func ensureColumn(db *sql.DB, table, column, definition string) error {
	rows, err := db.Query(fmt.Sprintf("PRAGMA table_info(%s)", table))
	if err != nil {
		return err
	}
	found := false
	for rows.Next() {
		var (
			cid        int
			name, typ  string
			notNull    int
			defaultVal sql.NullString
			pk         int
		)
		if err := rows.Scan(&cid, &name, &typ, &notNull, &defaultVal, &pk); err != nil {
			_ = rows.Close()
			return err
		}
		if name == column {
			found = true
		}
	}
	if err := rows.Err(); err != nil {
		_ = rows.Close()
		return err
	}
	_ = rows.Close()
	if found {
		return nil
	}
	_, err = db.Exec(fmt.Sprintf("ALTER TABLE %s ADD COLUMN %s %s", table, column, definition))
	return err
}
