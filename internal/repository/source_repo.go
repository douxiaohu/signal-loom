package repository

import (
	"database/sql"
	"errors"
	"strings"
	"time"

	"telegram-radar/internal/model"
)

// SourceRepository 封装对 sources 和 source_runs 表的操作
// 对应 Java 中的 SourceDAO / SourceRepository
type SourceRepository struct {
	db *sql.DB
}

// NewSourceRepository 是工厂函数（相当于 Spring 的构造器注入）
func NewSourceRepository(db *sql.DB) *SourceRepository {
	return &SourceRepository{db: db}
}

// ListSources 查询所有来源（供管理端）
func (r *SourceRepository) ListSources() ([]model.Source, error) {
	query := `
		SELECT chat_id, name, source_url, source_type, adapter, locator, enabled, public_visible, created_at, updated_at
		FROM sources
		ORDER BY created_at ASC
	`
	rows, err := r.db.Query(query)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var result []model.Source
	for rows.Next() {
		var s model.Source
		var enabledInt, publicVisibleInt int
		var createdAtStr, updatedAtStr string

		err := rows.Scan(
			&s.ChatID, &s.Name, &s.SourceURL, &s.SourceType, &s.Adapter, &s.Locator,
			&enabledInt, &publicVisibleInt, &createdAtStr, &updatedAtStr,
		)
		if err != nil {
			return nil, err
		}
		s.Enabled = enabledInt == 1
		s.PublicVisible = publicVisibleInt == 1
		s.CreatedAt, _ = time.Parse(time.RFC3339, createdAtStr)
		s.UpdatedAt, _ = time.Parse(time.RFC3339, updatedAtStr)
		result = append(result, s)
	}
	return result, rows.Err()
}

// ListPublicSources 查询所有已公开并启用的来源（供公共端展示）
func (r *SourceRepository) ListPublicSources(staleAfterSeconds int) ([]model.PublicSource, error) {
	query := `
		SELECT s.chat_id, s.name, s.source_url,
		       COUNT(m.id) as message_count,
		       MAX(m.message_time) as last_message_time
		FROM sources s
		LEFT JOIN messages m ON m.chat_id = s.chat_id
		WHERE s.enabled = 1 AND s.public_visible = 1
		GROUP BY s.chat_id
		ORDER BY s.name ASC
	`
	rows, err := r.db.Query(query)
	if err != nil {
		return nil, err
	}

	var list []model.PublicSource
	for rows.Next() {
		var ps model.PublicSource
		var lastMsgTime sql.NullString
		if err := rows.Scan(&ps.ChatID, &ps.Name, &ps.SourceURL, &ps.MessageCount, &lastMsgTime); err != nil {
			rows.Close()
			return nil, err
		}
		if lastMsgTime.Valid {
			ps.LastMessageTime = &lastMsgTime.String
		}
		list = append(list, ps)
	}
	rows.Close() // 关键：先释放 rows 占用的连接，再进入后续业务查询

	for i := range list {
		health := r.GetSourceHealth(list[i].ChatID, staleAfterSeconds)
		list[i].HealthStatus = health.HealthStatus
	}

	return list, nil
}

// GetSourceHealth 获取单个来源的最新健康状态
func (r *SourceRepository) GetSourceHealth(chatID int64, staleAfterSeconds int) model.SourceHealth {
	health := model.SourceHealth{
		ChatID:       chatID,
		HealthStatus: "unknown",
	}

	var latestRun model.SourceRun
	var latestErr sql.NullString
	row := r.db.QueryRow(`
		SELECT id, finished_at, fetched_count, saved_count, error
		FROM source_runs
		WHERE chat_id = ?
		ORDER BY finished_at DESC, id DESC
		LIMIT 1
	`, chatID)

	err := row.Scan(&latestRun.ID, &latestRun.FinishedAt, &latestRun.FetchedCount, &latestRun.SavedCount, &latestErr)
	if errors.Is(err, sql.ErrNoRows) {
		return health
	} else if err != nil {
		return health
	}

	health.LastRunAt = &latestRun.FinishedAt
	health.FetchedCount = latestRun.FetchedCount
	health.SavedCount = latestRun.SavedCount

	if latestErr.Valid && strings.TrimSpace(latestErr.String) != "" {
		errStr := latestErr.String
		health.LastError = &errStr
		health.HealthStatus = "error"
		return health
	}

	var lastSuccessAt string
	err = r.db.QueryRow(`
		SELECT finished_at FROM source_runs
		WHERE chat_id = ? AND (error IS NULL OR TRIM(error) = '')
		ORDER BY finished_at DESC, id DESC
		LIMIT 1
	`, chatID).Scan(&lastSuccessAt)

	if err != nil {
		health.HealthStatus = "unknown"
		return health
	}

	health.LastSuccessAt = &lastSuccessAt
	successTime, err := time.Parse(time.RFC3339, lastSuccessAt)
	if err != nil {
		health.HealthStatus = "healthy"
		return health
	}

	age := time.Since(successTime).Seconds()
	if age > float64(staleAfterSeconds) {
		health.HealthStatus = "stale"
	} else {
		health.HealthStatus = "healthy"
	}

	return health
}

// RecordSourceRun 记录一次爬虫采集执行日志并只保留最近 200 条
func (r *SourceRepository) RecordSourceRun(chatID int64, source, startedAt, finishedAt string, fetched, saved int, runErr *string) error {
	_, err := r.db.Exec(`
		INSERT INTO source_runs(chat_id, source, started_at, finished_at, fetched_count, saved_count, error)
		VALUES (?, ?, ?, ?, ?, ?, ?)
	`, chatID, source, startedAt, finishedAt, fetched, saved, runErr)
	if err != nil {
		return err
	}

	_, _ = r.db.Exec(`
		DELETE FROM source_runs
		WHERE chat_id = ? AND id NOT IN (
			SELECT id FROM source_runs
			WHERE chat_id = ?
			ORDER BY finished_at DESC, id DESC
			LIMIT 200
		)
	`, chatID, chatID)

	return nil
}

// SaveSource 创建或更新来源
func (r *SourceRepository) SaveSource(s *model.Source) error {
	now := time.Now().UTC().Format(time.RFC3339)
	var enabledInt, publicInt int
	if s.Enabled {
		enabledInt = 1
	}
	if s.PublicVisible {
		publicInt = 1
	}

	_, err := r.db.Exec(`
		INSERT INTO sources(chat_id, name, source_url, source_type, adapter, locator, enabled, public_visible, created_at, updated_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT(chat_id) DO UPDATE SET
			name = excluded.name,
			source_url = excluded.source_url,
			source_type = excluded.source_type,
			adapter = excluded.adapter,
			locator = excluded.locator,
			enabled = excluded.enabled,
			public_visible = excluded.public_visible,
			updated_at = excluded.updated_at
	`, s.ChatID, s.Name, s.SourceURL, s.SourceType, s.Adapter, s.Locator, enabledInt, publicInt, now, now)
	return err
}

// GetSource 根据 chatID 查询单个来源
func (r *SourceRepository) GetSource(chatID int64) (*model.Source, error) {
	var s model.Source
	var enabledInt, publicVisibleInt int
	var createdAtStr, updatedAtStr string

	err := r.db.QueryRow(`
		SELECT chat_id, name, source_url, source_type, adapter, locator, enabled, public_visible, created_at, updated_at
		FROM sources
		WHERE chat_id = ?
	`, chatID).Scan(
		&s.ChatID, &s.Name, &s.SourceURL, &s.SourceType, &s.Adapter, &s.Locator,
		&enabledInt, &publicVisibleInt, &createdAtStr, &updatedAtStr,
	)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	s.Enabled = enabledInt == 1
	s.PublicVisible = publicVisibleInt == 1
	s.CreatedAt, _ = time.Parse(time.RFC3339, createdAtStr)
	s.UpdatedAt, _ = time.Parse(time.RFC3339, updatedAtStr)
	return &s, nil
}

// DeleteSource 删除来源以及关联数据
func (r *SourceRepository) DeleteSource(chatID int64) error {
	_, err := r.db.Exec(`DELETE FROM sources WHERE chat_id = ?`, chatID)
	return err
}
