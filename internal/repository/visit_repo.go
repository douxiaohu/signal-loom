package repository

import (
	"database/sql"
	"time"

	"telegram-radar/internal/model"
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
		VALUES (?, ?, ?, ?, ?, ?)
	`, now, ip, path, method, userAgent, referer)
	return err
}

// GetStats 获取访问统计
func (r *VisitRepository) GetStats() (*model.SiteVisitStats, error) {
	var stats model.SiteVisitStats
	_ = r.db.QueryRow("SELECT COUNT(*), COUNT(DISTINCT ip) FROM site_visits").Scan(&stats.TotalVisits, &stats.UniqueIPs)

	today := time.Now().UTC().Format("2006-01-02")
	_ = r.db.QueryRow(
		"SELECT COUNT(*), COUNT(DISTINCT ip) FROM site_visits WHERE visited_at >= ?",
		today,
	).Scan(&stats.TodayVisits, &stats.TodayIPs)

	return &stats, nil
}

// ListRecentVisits 获取最近访问列表
func (r *VisitRepository) ListRecentVisits(limit int) ([]model.SiteVisit, error) {
	if limit <= 0 {
		limit = 100
	}
	rows, err := r.db.Query(`
		SELECT id, visited_at, ip, path, method, user_agent, referer
		FROM site_visits
		ORDER BY id DESC
		LIMIT ?
	`, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var list []model.SiteVisit
	for rows.Next() {
		var v model.SiteVisit
		if err := rows.Scan(&v.ID, &v.VisitedAt, &v.IP, &v.Path, &v.Method, &v.UserAgent, &v.Referer); err != nil {
			return nil, err
		}
		list = append(list, v)
	}
	return list, nil
}
