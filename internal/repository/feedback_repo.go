package repository

import (
	"database/sql"
	"time"

	"telegram-radar/internal/model"
)

type FeedbackRepository struct {
	db *sql.DB
}

func NewFeedbackRepository(db *sql.DB) *FeedbackRepository {
	return &FeedbackRepository{db: db}
}

func (r *FeedbackRepository) CreateFeedback(message, ip string) error {
	now := time.Now().UTC().Format(time.RFC3339)
	_, err := r.db.Exec(`
		INSERT INTO feedback (message, ip, status, created_at, updated_at)
		VALUES (?, ?, 'new', ?, ?)
	`, message, ip, now, now)
	return err
}

func (r *FeedbackRepository) ListFeedback(limit int) ([]model.Feedback, error) {
	if limit <= 0 {
		limit = 100
	}
	rows, err := r.db.Query(`
		SELECT id, message, ip, status, created_at, updated_at
		FROM feedback
		ORDER BY id DESC
		LIMIT ?
	`, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var list []model.Feedback
	for rows.Next() {
		var f model.Feedback
		if err := rows.Scan(&f.ID, &f.Message, &f.IP, &f.Status, &f.CreatedAt, &f.UpdatedAt); err != nil {
			return nil, err
		}
		list = append(list, f)
	}
	return list, nil
}
