package repository

import (
	"database/sql"
	"errors"
	"strings"
	"time"

	"telegram-radar/internal/model"
)

type AlertRepository struct {
	db *sql.DB
}

func NewAlertRepository(db *sql.DB) *AlertRepository {
	return &AlertRepository{db: db}
}

func (r *AlertRepository) ListRules() ([]model.AlertRule, error) {
	rows, err := r.db.Query(`
		SELECT id, name, keyword, media_type, quiet_start, quiet_end, cooldown_minutes, enabled, created_at, updated_at
		FROM alert_rules
		ORDER BY id DESC
	`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var rules []model.AlertRule
	for rows.Next() {
		var rule model.AlertRule
		var enabledInt int
		err := rows.Scan(
			&rule.ID, &rule.Name, &rule.Keyword, &rule.MediaType,
			&rule.QuietStart, &rule.QuietEnd, &rule.CooldownMinutes,
			&enabledInt, &rule.CreatedAt, &rule.UpdatedAt,
		)
		if err != nil {
			return nil, err
		}
		rule.Enabled = enabledInt == 1
		rule.SourceIDs, _ = r.getRuleSourceIDs(rule.ID)
		rules = append(rules, rule)
	}
	return rules, nil
}

func (r *AlertRepository) getRuleSourceIDs(ruleID int64) ([]int64, error) {
	rows, err := r.db.Query(`SELECT chat_id FROM alert_rule_sources WHERE rule_id = ?`, ruleID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var ids []int64
	for rows.Next() {
		var id int64
		if err := rows.Scan(&id); err == nil {
			ids = append(ids, id)
		}
	}
	return ids, nil
}

func (r *AlertRepository) SaveRule(rule *model.AlertRule) error {
	now := time.Now().UTC().Format(time.RFC3339)
	var enabledInt int
	if rule.Enabled {
		enabledInt = 1
	}

	if rule.ID == 0 {
		res, err := r.db.Exec(`
			INSERT INTO alert_rules (name, keyword, media_type, quiet_start, quiet_end, cooldown_minutes, enabled, created_at, updated_at)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
		`, rule.Name, rule.Keyword, rule.MediaType, rule.QuietStart, rule.QuietEnd, rule.CooldownMinutes, enabledInt, now, now)
		if err != nil {
			return err
		}
		rule.ID, _ = res.LastInsertId()
	} else {
		_, err := r.db.Exec(`
			UPDATE alert_rules
			SET name = ?, keyword = ?, media_type = ?, quiet_start = ?, quiet_end = ?, cooldown_minutes = ?, enabled = ?, updated_at = ?
			WHERE id = ?
		`, rule.Name, rule.Keyword, rule.MediaType, rule.QuietStart, rule.QuietEnd, rule.CooldownMinutes, enabledInt, now, rule.ID)
		if err != nil {
			return err
		}
		_, _ = r.db.Exec(`DELETE FROM alert_rule_sources WHERE rule_id = ?`, rule.ID)
	}

	for _, cid := range rule.SourceIDs {
		_, _ = r.db.Exec(`INSERT INTO alert_rule_sources (rule_id, chat_id) VALUES (?, ?)`, rule.ID, cid)
	}
	return nil
}

func (r *AlertRepository) DeleteRule(id int64) error {
	_, err := r.db.Exec(`DELETE FROM alert_rules WHERE id = ?`, id)
	return err
}

func (r *AlertRepository) ListMatches(status string, limit int) ([]model.AlertMatch, error) {
	if limit <= 0 {
		limit = 100
	}
	query := `
		SELECT am.id, am.rule_id, ar.name, ar.keyword, am.status, am.matched_at,
		       m.chat_title, m.sender_name, m.message_time, m.content, m.media_type
		FROM alert_matches am
		JOIN alert_rules ar ON ar.id = am.rule_id
		JOIN messages m ON m.id = am.message_id
	`
	var args []any
	if status != "" && status != "all" {
		query += " WHERE am.status = ?"
		args = append(args, status)
	}
	query += " ORDER BY am.id DESC LIMIT ?"
	args = append(args, limit)

	rows, err := r.db.Query(query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var matches []model.AlertMatch
	for rows.Next() {
		var m model.AlertMatch
		err := rows.Scan(
			&m.ID, &m.RuleID, &m.RuleName, &m.Keyword, &m.Status, &m.MatchedAt,
			&m.ChatTitle, &m.SenderName, &m.MessageTime, &m.Content, &m.MediaType,
		)
		if err != nil {
			return nil, err
		}
		matches = append(matches, m)
	}
	return matches, nil
}

func (r *AlertRepository) UpdateMatchStatus(id int64, newStatus string) error {
	now := time.Now().UTC().Format(time.RFC3339)
	var err error
	if newStatus == "acknowledged" {
		_, err = r.db.Exec(`UPDATE alert_matches SET status = ?, acknowledged_at = ? WHERE id = ?`, newStatus, now, id)
	} else if newStatus == "resolved" {
		_, err = r.db.Exec(`UPDATE alert_matches SET status = ?, resolved_at = ? WHERE id = ?`, newStatus, now, id)
	} else {
		_, err = r.db.Exec(`UPDATE alert_matches SET status = ? WHERE id = ?`, newStatus, id)
	}
	return err
}

func (r *AlertRepository) MatchAndRecord(msg *model.StoredMessage) error {
	rules, err := r.ListRules()
	if err != nil {
		return err
	}
	now := time.Now().UTC().Format(time.RFC3339)
	for _, rule := range rules {
		if !rule.Enabled {
			continue
		}
		// 校验来源是否在规则指定列表内（如果不为空）
		if len(rule.SourceIDs) > 0 {
			matchedSource := false
			for _, cid := range rule.SourceIDs {
				if cid == msg.ChatID {
					matchedSource = true
					break
				}
			}
			if !matchedSource {
				continue
			}
		}
		// 关键词匹配
		if rule.Keyword != "" && !strings.Contains(strings.ToLower(msg.Content), strings.ToLower(rule.Keyword)) {
			continue
		}
		// 媒体类型匹配
		if rule.MediaType != nil && *rule.MediaType != "" {
			if msg.MediaType == nil || *msg.MediaType != *rule.MediaType {
				continue
			}
		}

		// 命中！插入 alert_matches
		_, _ = r.db.Exec(`
			INSERT INTO alert_matches (rule_id, message_id, status, matched_at)
			VALUES (?, ?, 'new', ?)
			ON CONFLICT(rule_id, message_id) DO NOTHING
		`, rule.ID, msg.ID, now)
	}
	return nil
}

var ErrNotFound = errors.New("record not found")
