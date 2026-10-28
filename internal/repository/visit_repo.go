package repository

import (
	"database/sql"
	"time"

	"telegram-radar/internal/model"
)

// Field limits match the Python service. Without them a single request with a
// huge header could write megabytes into the database.
const (
	maxVisitIPLen      = 64
	maxVisitPathLen    = 300
	maxVisitMethodLen  = 16
	maxVisitUALen      = 300
	maxVisitRefererLen = 300
)

type VisitRepository struct {
	db *sql.DB
}

func NewVisitRepository(db *sql.DB) *VisitRepository {
	return &VisitRepository{db: db}
}

// RecordVisit 记录一次网站页面或接口访问
func (r *VisitRepository) RecordVisit(ip, path, method, userAgent, referer string) error {
	now := time.Now().UTC().Format(time.RFC3339)
	_, err := r.db.Exec(`
		INSERT INTO site_visits (visited_at, ip, path, method, user_agent, referer)
		VALUES (?, ?, ?, ?, ?, ?)`,
		now,
		truncate(ip, maxVisitIPLen),
		truncate(path, maxVisitPathLen),
		truncate(method, maxVisitMethodLen),
		truncate(userAgent, maxVisitUALen),
		truncate(referer, maxVisitRefererLen))
	return err
}

// PruneVisits deletes visits older than the cutoff and returns how many went.
func (r *VisitRepository) PruneVisits(before time.Time) (int64, error) {
	res, err := r.db.Exec(`DELETE FROM site_visits WHERE visited_at < ?`, before.UTC().Format(time.RFC3339))
	if err != nil {
		return 0, err
	}
	return res.RowsAffected()
}

// GetStats 获取访问统计。"今天"按给定时区的自然日计算。
func (r *VisitRepository) GetStats(now time.Time, loc *time.Location) (model.SiteVisitStats, error) {
	if loc == nil {
		loc = time.UTC
	}
	local := now.In(loc)
	dayStart := time.Date(local.Year(), local.Month(), local.Day(), 0, 0, 0, 0, loc).UTC()

	const layout = time.RFC3339
	var s model.SiteVisitStats
	err := r.db.QueryRow(`
		SELECT COUNT(*),
		       COUNT(DISTINCT ip),
		       COALESCE(SUM(CASE WHEN visited_at >= ?1 THEN 1 ELSE 0 END), 0),
		       COUNT(DISTINCT CASE WHEN visited_at >= ?1 THEN ip END),
		       COALESCE(SUM(CASE WHEN visited_at >= ?2 THEN 1 ELSE 0 END), 0),
		       COUNT(DISTINCT CASE WHEN visited_at >= ?3 THEN ip END)
		FROM site_visits`,
		dayStart.Format(layout),
		now.UTC().Add(-24*time.Hour).Format(layout),
		now.UTC().Add(-7*24*time.Hour).Format(layout),
	).Scan(&s.Total, &s.UniqueIPs, &s.Today, &s.TodayUnique, &s.Last24h, &s.Last7dUnique)
	return s, err
}

// ListRecentVisits 获取最近访问列表（limit 1..500）。返回的切片永不为 nil。
func (r *VisitRepository) ListRecentVisits(limit, offset int) ([]model.SiteVisit, error) {
	if limit <= 0 {
		limit = 100
	}
	if limit > 500 {
		limit = 500
	}
	if offset < 0 {
		offset = 0
	}
	rows, err := r.db.Query(`
		SELECT id, visited_at, ip, path, method, user_agent, referer
		FROM site_visits
		ORDER BY id DESC
		LIMIT ? OFFSET ?`, limit, offset)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	list := make([]model.SiteVisit, 0)
	for rows.Next() {
		var v model.SiteVisit
		if err := rows.Scan(&v.ID, &v.VisitedAt, &v.IP, &v.Path, &v.Method, &v.UserAgent, &v.Referer); err != nil {
			return nil, err
		}
		list = append(list, v)
	}
	return list, rows.Err()
}
