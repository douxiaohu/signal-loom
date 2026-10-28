package repository

import (
	"database/sql"
	"errors"
	"strings"
	"time"

	"telegram-radar/internal/model"
)

const sourceColumns = `chat_id, name, source_url, source_type, adapter, locator, enabled, public_visible, created_at, updated_at`

// maxRunErrorLen mirrors the Python service, which stored at most 1000
// characters of a crawl error.
const maxRunErrorLen = 1000

// SourceRepository 封装对 sources 和 source_runs 表的操作
type SourceRepository struct {
	db *sql.DB
}

func NewSourceRepository(db *sql.DB) *SourceRepository {
	return &SourceRepository{db: db}
}

type rowScanner interface{ Scan(dest ...any) error }

func scanSource(sc rowScanner) (model.Source, error) {
	var (
		s                      model.Source
		enabled, publicVisible int
		createdAt, updatedAt   string
	)
	if err := sc.Scan(&s.ChatID, &s.Name, &s.SourceURL, &s.SourceType, &s.Adapter, &s.Locator,
		&enabled, &publicVisible, &createdAt, &updatedAt); err != nil {
		return s, err
	}
	s.Enabled = enabled == 1
	s.PublicVisible = publicVisible == 1
	s.CreatedAt, _ = time.Parse(time.RFC3339, createdAt)
	s.UpdatedAt, _ = time.Parse(time.RFC3339, updatedAt)
	return s, nil
}

// ListSources 查询所有来源（供管理端）。返回的切片永不为 nil。
func (r *SourceRepository) ListSources() ([]model.Source, error) {
	rows, err := r.db.Query(`SELECT ` + sourceColumns + ` FROM sources ORDER BY created_at ASC, chat_id ASC`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	result := make([]model.Source, 0)
	for rows.Next() {
		s, err := scanSource(rows)
		if err != nil {
			return nil, err
		}
		result = append(result, s)
	}
	return result, rows.Err()
}

// SourceCount returns the number of configured sources.
func (r *SourceRepository) SourceCount() (int, error) {
	var n int
	err := r.db.QueryRow(`SELECT COUNT(*) FROM sources`).Scan(&n)
	return n, err
}

// GetSource 根据 chatID 查询单个来源，不存在时返回 (nil, nil)。
func (r *SourceRepository) GetSource(chatID int64) (*model.Source, error) {
	s, err := scanSource(r.db.QueryRow(`SELECT `+sourceColumns+` FROM sources WHERE chat_id = ?`, chatID))
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &s, nil
}

// IsPubliclyVisible reports whether a source is enabled and published, i.e.
// whether anonymous visitors may see anything that belongs to it.
func (r *SourceRepository) IsPubliclyVisible(chatID int64) (bool, error) {
	var one int
	err := r.db.QueryRow(
		`SELECT 1 FROM sources WHERE chat_id = ? AND enabled = 1 AND public_visible = 1`, chatID,
	).Scan(&one)
	if errors.Is(err, sql.ErrNoRows) {
		return false, nil
	}
	return err == nil, err
}

// CreateSource inserts a new source. An existing chat_id or URL yields
// ErrConflict; existing rows are never overwritten.
func (r *SourceRepository) CreateSource(s *model.Source) error {
	now := time.Now().UTC().Truncate(time.Second)
	stamp := now.Format(time.RFC3339)
	_, err := r.db.Exec(`
		INSERT INTO sources(`+sourceColumns+`)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		s.ChatID, s.Name, s.SourceURL, s.SourceType, s.Adapter, s.Locator,
		boolInt(s.Enabled), boolInt(s.PublicVisible), stamp, stamp)
	if err != nil {
		if isConstraintError(err) {
			return ErrConflict
		}
		return err
	}
	s.CreatedAt, s.UpdatedAt = now, now
	return nil
}

// SourcePatch lists the fields an admin may change. Nil means "leave as is".
type SourcePatch struct {
	Name          *string
	Enabled       *bool
	PublicVisible *bool
}

// UpdateSource applies a partial update and returns the stored row.
func (r *SourceRepository) UpdateSource(chatID int64, p SourcePatch) (*model.Source, error) {
	sets := []string{"updated_at = ?"}
	args := []any{time.Now().UTC().Format(time.RFC3339)}
	if p.Name != nil {
		sets = append(sets, "name = ?")
		args = append(args, *p.Name)
	}
	if p.Enabled != nil {
		sets = append(sets, "enabled = ?")
		args = append(args, boolInt(*p.Enabled))
	}
	if p.PublicVisible != nil {
		sets = append(sets, "public_visible = ?")
		args = append(args, boolInt(*p.PublicVisible))
	}
	args = append(args, chatID)

	res, err := r.db.Exec(`UPDATE sources SET `+strings.Join(sets, ", ")+` WHERE chat_id = ?`, args...)
	if err != nil {
		return nil, err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return nil, ErrNotFound
	}
	s, err := r.GetSource(chatID)
	if err != nil {
		return nil, err
	}
	if s == nil {
		return nil, ErrNotFound
	}
	return s, nil
}

// ListPublicSources 查询所有已公开并启用的来源（供公共端展示）。返回的切片永不为 nil。
func (r *SourceRepository) ListPublicSources(staleAfterSeconds int) ([]model.PublicSource, error) {
	rows, err := r.db.Query(`
		SELECT s.chat_id, s.name, s.source_url, COALESCE(c.n, 0), c.last_time
		FROM sources s
		LEFT JOIN (
			SELECT chat_id, COUNT(*) AS n, MAX(message_time) AS last_time
			FROM messages
			WHERE ` + displayableSQL + `
			GROUP BY chat_id
		) c ON c.chat_id = s.chat_id
		WHERE s.enabled = 1 AND s.public_visible = 1
		ORDER BY s.name COLLATE NOCASE ASC, s.chat_id ASC`)
	if err != nil {
		return nil, err
	}

	list := make([]model.PublicSource, 0)
	for rows.Next() {
		var ps model.PublicSource
		var last sql.NullString
		if err := rows.Scan(&ps.ChatID, &ps.Name, &ps.SourceURL, &ps.MessageCount, &last); err != nil {
			_ = rows.Close()
			return nil, err
		}
		if last.Valid {
			v := last.String
			ps.LastMessageTime = &v
		}
		list = append(list, ps)
	}
	err = rows.Err()
	_ = rows.Close() // release the connection before the per-source health queries
	if err != nil {
		return nil, err
	}

	for i := range list {
		list[i].HealthStatus = r.GetSourceHealth(list[i].ChatID, staleAfterSeconds).HealthStatus
	}
	return list, nil
}

// GetSourceHealth 获取单个来源的最新健康状态
func (r *SourceRepository) GetSourceHealth(chatID int64, staleAfterSeconds int) model.SourceHealth {
	health := model.SourceHealth{ChatID: chatID, HealthStatus: "unknown"}

	var (
		finishedAt string
		fetched    int
		saved      int
		latestErr  sql.NullString
	)
	err := r.db.QueryRow(`
		SELECT finished_at, fetched_count, saved_count, error
		FROM source_runs
		WHERE chat_id = ?
		ORDER BY finished_at DESC, id DESC
		LIMIT 1`, chatID).Scan(&finishedAt, &fetched, &saved, &latestErr)
	if err != nil {
		return health // no runs yet (or unreadable): status stays "unknown"
	}

	health.LastRunAt = &finishedAt
	health.FetchedCount = fetched
	health.SavedCount = saved

	if latestErr.Valid && strings.TrimSpace(latestErr.String) != "" {
		msg := strings.TrimSpace(latestErr.String)
		health.LastError = &msg
		health.HealthStatus = "error"
		return health
	}

	var lastSuccess string
	if err := r.db.QueryRow(`
		SELECT finished_at FROM source_runs
		WHERE chat_id = ? AND (error IS NULL OR TRIM(error) = '')
		ORDER BY finished_at DESC, id DESC
		LIMIT 1`, chatID).Scan(&lastSuccess); err != nil {
		return health
	}
	health.LastSuccessAt = &lastSuccess

	successTime, err := time.Parse(time.RFC3339, lastSuccess)
	if err != nil {
		health.HealthStatus = "healthy"
		return health
	}
	if staleAfterSeconds < 1 {
		staleAfterSeconds = 1
	}
	if time.Since(successTime).Seconds() > float64(staleAfterSeconds) {
		health.HealthStatus = "stale"
	} else {
		health.HealthStatus = "healthy"
	}
	return health
}

// AnomalyStats reports how many of the latest runs failed in a row and how many
// messages the latest run saved. The operations view uses it to flag sources.
func (r *SourceRepository) AnomalyStats(chatID int64) (consecutiveFailures, newMessageVolume int, err error) {
	rows, err := r.db.Query(`
		SELECT saved_count, error FROM source_runs
		WHERE chat_id = ?
		ORDER BY finished_at DESC, id DESC
		LIMIT 30`, chatID)
	if err != nil {
		return 0, 0, err
	}
	defer rows.Close()

	first, streak := true, true
	for rows.Next() {
		var saved int
		var errText sql.NullString
		if err := rows.Scan(&saved, &errText); err != nil {
			return 0, 0, err
		}
		if first {
			newMessageVolume = saved
			first = false
		}
		if streak && strings.TrimSpace(errText.String) != "" {
			consecutiveFailures++
		} else {
			streak = false
		}
	}
	return consecutiveFailures, newMessageVolume, rows.Err()
}

// RecordSourceRun 记录一次爬虫采集执行日志并只保留最近 200 条
func (r *SourceRepository) RecordSourceRun(chatID int64, source, startedAt, finishedAt string, fetched, saved int, runErr *string) error {
	var errText *string
	if runErr != nil && strings.TrimSpace(*runErr) != "" {
		t := truncate(*runErr, maxRunErrorLen)
		errText = &t
	}

	tx, err := r.db.Begin()
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()

	if _, err := tx.Exec(`
		INSERT INTO source_runs(chat_id, source, started_at, finished_at, fetched_count, saved_count, error)
		VALUES (?, ?, ?, ?, ?, ?, ?)`,
		chatID, source, startedAt, finishedAt, fetched, saved, errText); err != nil {
		return err
	}
	if _, err := tx.Exec(`
		DELETE FROM source_runs
		WHERE chat_id = ? AND id NOT IN (
			SELECT id FROM source_runs
			WHERE chat_id = ?
			ORDER BY finished_at DESC, id DESC
			LIMIT 200
		)`, chatID, chatID); err != nil {
		return err
	}
	return tx.Commit()
}

func boolInt(b bool) int {
	if b {
		return 1
	}
	return 0
}
