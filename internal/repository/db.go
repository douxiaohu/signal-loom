package repository

import (
	"database/sql"
	"fmt"
	"os"
	"path/filepath"

	_ "modernc.org/sqlite" // 注册纯 Go 实现的 SQLite 驱动
)

// InitDB 初始化 SQLite 数据库连接并自动建表
// 相当于 Java 中 DataSource + Flyway / Liquibase 的建表逻辑
func InitDB(dbPath string) (*sql.DB, error) {
	if dbPath != ":memory:" {
		dir := filepath.Dir(dbPath)
		if err := os.MkdirAll(dir, 0755); err != nil {
			return nil, fmt.Errorf("failed to create db directory: %w", err)
		}
	}

	// 纯 Go sqlite 驱动连接串：配置 WAL 模式提升并发读写性能
	dsn := fmt.Sprintf("%s?_pragma=journal_mode(WAL)&_pragma=busy_timeout(5000)&_pragma=synchronous(NORMAL)", dbPath)
	db, err := sql.Open("sqlite", dsn)
	if err != nil {
		return nil, fmt.Errorf("failed to open sqlite: %w", err)
	}

	// SQLite 在 WAL 模式下支持并发多读，配置连接池容量
	db.SetMaxOpenConns(10)
	db.SetMaxIdleConns(5)

	if err := db.Ping(); err != nil {
		return nil, fmt.Errorf("failed to ping sqlite: %w", err)
	}

	if err := createTables(db); err != nil {
		db.Close()
		return nil, fmt.Errorf("failed to create tables: %w", err)
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
	`
	_, err := db.Exec(schema)
	return err
}
