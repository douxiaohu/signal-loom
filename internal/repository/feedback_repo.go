package repository

import (
	"database/sql"
	"errors"
	"time"

	"telegram-radar/internal/model"
)

// maxFeedbackIPLen mirrors the Python service (it stored str(ip)[:64]).
const maxFeedbackIPLen = 64

type FeedbackRepository struct {
	db *sql.DB
}

func NewFeedbackRepository(db *sql.DB) *FeedbackRepository {
	return &FeedbackRepository{db: db}
}

// ValidFeedbackStatus lists the states a feedback entry can be in.
func ValidFeedbackStatus(s string) bool {
	switch s {
	case "new", "reviewed", "resolved", "dismissed":
		return true
	}
	return false
}

func (r *FeedbackRepository) CreateFeedback(message, ip string) (*model.Feedback, error) {
	now := time.Now().UTC().Format(time.RFC3339)
	ip = truncate(ip, maxFeedbackIPLen)
	res, err := r.db.Exec(`
		INSERT INTO feedback (message, ip, status, created_at, updated_at)
		VALUES (?, ?, 'new', ?, ?)`, message, ip, now, now)
	if err != nil {
		return nil, err
	}
	id, err := res.LastInsertId()
	if err != nil {
		return nil, err
	}
	return &model.Feedback{ID: id, Message: message, IP: ip, Status: "new", CreatedAt: now, UpdatedAt: now}, nil
}

// ListFeedback returns the newest entries first. Never nil.
func (r *FeedbackRepository) ListFeedback(limit int) ([]model.Feedback, error) {
	if limit <= 0 {
		limit = 100
	}
	rows, err := r.db.Query(`
		SELECT id, message, ip, status, created_at, updated_at
		FROM feedback
		ORDER BY id DESC
		LIMIT ?`, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	list := make([]model.Feedback, 0)
	for rows.Next() {
		var f model.Feedback
		if err := rows.Scan(&f.ID, &f.Message, &f.IP, &f.Status, &f.CreatedAt, &f.UpdatedAt); err != nil {
			return nil, err
		}
		list = append(list, f)
	}
	return list, rows.Err()
}

func (r *FeedbackRepository) UpdateFeedbackStatus(id int64, status string) (*model.Feedback, error) {
	if !ValidFeedbackStatus(status) {
		return nil, errors.New("invalid feedback status")
	}
	now := time.Now().UTC().Format(time.RFC3339)
	res, err := r.db.Exec(`UPDATE feedback SET status = ?, updated_at = ? WHERE id = ?`, status, now, id)
	if err != nil {
		return nil, err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return nil, ErrNotFound
	}
	var f model.Feedback
	err = r.db.QueryRow(`SELECT id, message, ip, status, created_at, updated_at FROM feedback WHERE id = ?`, id).
		Scan(&f.ID, &f.Message, &f.IP, &f.Status, &f.CreatedAt, &f.UpdatedAt)
	if err != nil {
		return nil, err
	}
	return &f, nil
}
