package repository

import (
	"database/sql"
	"errors"
	"sort"
	"strconv"
	"strings"
	"time"

	"telegram-radar/internal/model"
)

const ruleColumns = `id, name, keyword, media_type, quiet_start, quiet_end, cooldown_minutes, enabled, created_at, updated_at`

const matchSelect = `
	SELECT am.id, am.rule_id, ar.name, ar.keyword, am.status, am.matched_at,
	       m.chat_title, m.sender_name, m.message_time, m.content, m.media_type
	FROM alert_matches am
	JOIN alert_rules ar ON ar.id = am.rule_id
	JOIN messages m ON m.id = am.message_id`

// AlertRepository stores alert rules and their matches.
type AlertRepository struct {
	db  *sql.DB
	loc *time.Location // zone in which quiet hours are interpreted
}

func NewAlertRepository(db *sql.DB, loc *time.Location) *AlertRepository {
	if loc == nil {
		loc = time.UTC
	}
	return &AlertRepository{db: db, loc: loc}
}

func scanRule(sc rowScanner) (model.AlertRule, error) {
	var rule model.AlertRule
	var enabled int
	err := sc.Scan(&rule.ID, &rule.Name, &rule.Keyword, &rule.MediaType, &rule.QuietStart, &rule.QuietEnd,
		&rule.CooldownMinutes, &enabled, &rule.CreatedAt, &rule.UpdatedAt)
	rule.Enabled = enabled == 1
	rule.SourceIDs = []int64{}
	return rule, err
}

// ListRules returns every rule, newest first. Never nil.
func (r *AlertRepository) ListRules() ([]model.AlertRule, error) { return r.listRules("") }

func (r *AlertRepository) listRules(where string) ([]model.AlertRule, error) {
	rows, err := r.db.Query(`SELECT ` + ruleColumns + ` FROM alert_rules ` + where + ` ORDER BY id DESC`)
	if err != nil {
		return nil, err
	}
	rules := make([]model.AlertRule, 0)
	for rows.Next() {
		rule, err := scanRule(rows)
		if err != nil {
			_ = rows.Close()
			return nil, err
		}
		rules = append(rules, rule)
	}
	err = rows.Err()
	_ = rows.Close() // free the connection before the second query
	if err != nil {
		return nil, err
	}

	sources, err := r.db.Query(`SELECT rule_id, chat_id FROM alert_rule_sources ORDER BY rule_id, chat_id`)
	if err != nil {
		return nil, err
	}
	defer sources.Close()
	byRule := map[int64][]int64{}
	for sources.Next() {
		var ruleID, chatID int64
		if err := sources.Scan(&ruleID, &chatID); err != nil {
			return nil, err
		}
		byRule[ruleID] = append(byRule[ruleID], chatID)
	}
	if err := sources.Err(); err != nil {
		return nil, err
	}
	for i := range rules {
		if ids, ok := byRule[rules[i].ID]; ok {
			rules[i].SourceIDs = ids
		}
	}
	return rules, nil
}

// GetRule loads one rule or returns ErrNotFound.
func (r *AlertRepository) GetRule(id int64) (*model.AlertRule, error) {
	rule, err := scanRule(r.db.QueryRow(`SELECT `+ruleColumns+` FROM alert_rules WHERE id = ?`, id))
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	ids, err := r.sourceIDs(id)
	if err != nil {
		return nil, err
	}
	rule.SourceIDs = ids
	return &rule, nil
}

func (r *AlertRepository) sourceIDs(ruleID int64) ([]int64, error) {
	rows, err := r.db.Query(`SELECT chat_id FROM alert_rule_sources WHERE rule_id = ? ORDER BY chat_id`, ruleID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	ids := []int64{}
	for rows.Next() {
		var id int64
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		ids = append(ids, id)
	}
	return ids, rows.Err()
}

// CreateRule inserts a rule together with its source list atomically and fills
// in ID and timestamps.
func (r *AlertRepository) CreateRule(rule *model.AlertRule) error {
	now := time.Now().UTC().Format(time.RFC3339)
	tx, err := r.db.Begin()
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()

	res, err := tx.Exec(`
		INSERT INTO alert_rules (name, keyword, media_type, quiet_start, quiet_end, cooldown_minutes, enabled, created_at, updated_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		rule.Name, rule.Keyword, rule.MediaType, rule.QuietStart, rule.QuietEnd,
		rule.CooldownMinutes, boolInt(rule.Enabled), now, now)
	if err != nil {
		return err
	}
	id, err := res.LastInsertId()
	if err != nil {
		return err
	}
	if err := replaceRuleSources(tx, id, rule.SourceIDs); err != nil {
		return err
	}
	if err := tx.Commit(); err != nil {
		return err
	}
	rule.ID, rule.CreatedAt, rule.UpdatedAt = id, now, now
	rule.SourceIDs = sortedUnique(rule.SourceIDs)
	return nil
}

// UpdateRule loads the rule inside a write transaction, lets mutate change it
// (and reject the result by returning an error), then stores every column and
// the source list in one step. A missing rule yields ErrNotFound.
func (r *AlertRepository) UpdateRule(id int64, mutate func(*model.AlertRule) error) (*model.AlertRule, error) {
	tx, err := r.db.Begin()
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback() }()

	rule, err := scanRule(tx.QueryRow(`SELECT `+ruleColumns+` FROM alert_rules WHERE id = ?`, id))
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	rows, err := tx.Query(`SELECT chat_id FROM alert_rule_sources WHERE rule_id = ? ORDER BY chat_id`, id)
	if err != nil {
		return nil, err
	}
	for rows.Next() {
		var cid int64
		if err := rows.Scan(&cid); err != nil {
			_ = rows.Close()
			return nil, err
		}
		rule.SourceIDs = append(rule.SourceIDs, cid)
	}
	err = rows.Err()
	_ = rows.Close()
	if err != nil {
		return nil, err
	}

	if err := mutate(&rule); err != nil {
		return nil, err
	}

	now := time.Now().UTC().Format(time.RFC3339)
	if _, err := tx.Exec(`
		UPDATE alert_rules
		SET name = ?, keyword = ?, media_type = ?, quiet_start = ?, quiet_end = ?,
		    cooldown_minutes = ?, enabled = ?, updated_at = ?
		WHERE id = ?`,
		rule.Name, rule.Keyword, rule.MediaType, rule.QuietStart, rule.QuietEnd,
		rule.CooldownMinutes, boolInt(rule.Enabled), now, id); err != nil {
		return nil, err
	}
	if err := replaceRuleSources(tx, id, rule.SourceIDs); err != nil {
		return nil, err
	}
	if err := tx.Commit(); err != nil {
		return nil, err
	}
	rule.UpdatedAt = now
	rule.SourceIDs = sortedUnique(rule.SourceIDs)
	return &rule, nil
}

func replaceRuleSources(tx *sql.Tx, ruleID int64, ids []int64) error {
	if _, err := tx.Exec(`DELETE FROM alert_rule_sources WHERE rule_id = ?`, ruleID); err != nil {
		return err
	}
	for _, cid := range sortedUnique(ids) {
		if _, err := tx.Exec(`INSERT INTO alert_rule_sources (rule_id, chat_id) VALUES (?, ?)`, ruleID, cid); err != nil {
			return err
		}
	}
	return nil
}

func sortedUnique(ids []int64) []int64 {
	out := make([]int64, 0, len(ids))
	seen := map[int64]bool{}
	for _, id := range ids {
		if !seen[id] {
			seen[id] = true
			out = append(out, id)
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i] < out[j] })
	return out
}

// DeleteRule removes a rule; its sources and matches go with it (ON DELETE CASCADE).
func (r *AlertRepository) DeleteRule(id int64) error {
	res, err := r.db.Exec(`DELETE FROM alert_rules WHERE id = ?`, id)
	if err != nil {
		return err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return ErrNotFound
	}
	return nil
}

// ListMatches returns matches newest first, optionally filtered by status.
func (r *AlertRepository) ListMatches(status string, limit int) ([]model.AlertMatch, error) {
	if limit <= 0 {
		limit = 100
	}
	query := matchSelect
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

	matches := make([]model.AlertMatch, 0)
	for rows.Next() {
		m, err := scanMatch(rows)
		if err != nil {
			return nil, err
		}
		matches = append(matches, m)
	}
	return matches, rows.Err()
}

func scanMatch(sc rowScanner) (model.AlertMatch, error) {
	var m model.AlertMatch
	err := sc.Scan(&m.ID, &m.RuleID, &m.RuleName, &m.Keyword, &m.Status, &m.MatchedAt,
		&m.ChatTitle, &m.SenderName, &m.MessageTime, &m.Content, &m.MediaType)
	return m, err
}

// GetMatch loads one match or returns ErrNotFound.
func (r *AlertRepository) GetMatch(id int64) (*model.AlertMatch, error) {
	m, err := scanMatch(r.db.QueryRow(matchSelect+" WHERE am.id = ?", id))
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	return &m, nil
}

// SetMatchStatus moves a match to new / acknowledged / resolved. Timestamps
// follow the Python rules: acknowledging stamps acknowledged_at once, and
// resolving also stamps resolved_at.
func (r *AlertRepository) SetMatchStatus(id int64, status string) (*model.AlertMatch, error) {
	if status != "new" && status != "acknowledged" && status != "resolved" {
		return nil, errors.New("invalid alert status")
	}
	now := time.Now().UTC().Format(time.RFC3339)
	var ackAt, resolvedAt *string
	if status == "acknowledged" || status == "resolved" {
		ackAt = &now
	}
	if status == "resolved" {
		resolvedAt = &now
	}
	res, err := r.db.Exec(`
		UPDATE alert_matches
		SET status = ?, acknowledged_at = COALESCE(acknowledged_at, ?), resolved_at = ?
		WHERE id = ?`, status, ackAt, resolvedAt, id)
	if err != nil {
		return nil, err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return nil, ErrNotFound
	}
	return r.GetMatch(id)
}

// AlertStats feeds the admin overview.
type AlertStats struct {
	New              int
	Acknowledged     int
	Resolved         int
	RuleCount        int
	EnabledRuleCount int
}

func (r *AlertRepository) Stats() (AlertStats, error) {
	var s AlertStats
	rows, err := r.db.Query(`SELECT status, COUNT(*) FROM alert_matches GROUP BY status`)
	if err != nil {
		return s, err
	}
	for rows.Next() {
		var status string
		var n int
		if err := rows.Scan(&status, &n); err != nil {
			_ = rows.Close()
			return s, err
		}
		switch status {
		case "new":
			s.New = n
		case "acknowledged":
			s.Acknowledged = n
		case "resolved":
			s.Resolved = n
		}
	}
	err = rows.Err()
	_ = rows.Close()
	if err != nil {
		return s, err
	}
	err = r.db.QueryRow(`SELECT COUNT(*), COALESCE(SUM(enabled), 0) FROM alert_rules`).Scan(&s.RuleCount, &s.EnabledRuleCount)
	return s, err
}

// MatchAndRecord evaluates every enabled rule against a stored message and
// records the hits. msg.ID must be the database id (SaveMessage fills it in);
// the number of newly created matches is returned.
func (r *AlertRepository) MatchAndRecord(msg *model.StoredMessage) (int, error) {
	if msg.ID <= 0 {
		return 0, errors.New("alert matching needs the stored message id")
	}
	rules, err := r.listRules("WHERE enabled = 1")
	if err != nil {
		return 0, err
	}

	content := strings.ToLower(msg.Content)
	msgTime, timeOK := parseMessageTime(msg.MessageTime)
	now := time.Now().UTC().Format(time.RFC3339)
	created := 0

	for i := range rules {
		rule := &rules[i]
		keyword := strings.ToLower(strings.TrimSpace(rule.Keyword))
		if keyword == "" || !strings.Contains(content, keyword) {
			continue // an empty keyword never matches
		}
		if !mediaMatches(rule.MediaType, msg.MediaType) {
			continue
		}
		if len(rule.SourceIDs) > 0 && !containsID(rule.SourceIDs, msg.ChatID) {
			continue
		}
		if timeOK && rule.QuietStart != nil && rule.QuietEnd != nil &&
			InsideQuietHours(msgTime.In(r.loc), *rule.QuietStart, *rule.QuietEnd) {
			continue
		}
		if timeOK && rule.CooldownMinutes > 0 {
			prev, ok, err := r.previousMatchTime(rule.ID)
			if err != nil {
				return created, err
			}
			if ok && msgTime.Before(prev.Add(time.Duration(rule.CooldownMinutes)*time.Minute)) {
				continue
			}
		}
		res, err := r.db.Exec(`
			INSERT INTO alert_matches (rule_id, message_id, status, matched_at)
			VALUES (?, ?, 'new', ?)
			ON CONFLICT(rule_id, message_id) DO NOTHING`, rule.ID, msg.ID, now)
		if err != nil {
			return created, err
		}
		if n, _ := res.RowsAffected(); n > 0 {
			created++
		}
	}
	return created, nil
}

func (r *AlertRepository) previousMatchTime(ruleID int64) (time.Time, bool, error) {
	var text string
	err := r.db.QueryRow(`
		SELECT m.message_time
		FROM alert_matches am
		JOIN messages m ON m.id = am.message_id
		WHERE am.rule_id = ?
		ORDER BY am.id DESC
		LIMIT 1`, ruleID).Scan(&text)
	if errors.Is(err, sql.ErrNoRows) {
		return time.Time{}, false, nil
	}
	if err != nil {
		return time.Time{}, false, err
	}
	t, ok := parseMessageTime(text)
	return t, ok, nil
}

func mediaMatches(required, actual *string) bool {
	if required == nil || *required == "" {
		return true
	}
	has := actual != nil && *actual != ""
	if *required == "text" {
		return !has
	}
	return has && *actual == *required
}

func containsID(ids []int64, id int64) bool {
	for _, v := range ids {
		if v == id {
			return true
		}
	}
	return false
}

// parseMessageTime accepts RFC 3339 with or without fractional seconds and a
// bare local-less timestamp (treated as UTC), like the Python parser did.
func parseMessageTime(s string) (time.Time, bool) {
	s = strings.TrimSpace(s)
	if t, err := time.Parse(time.RFC3339Nano, s); err == nil {
		return t, true
	}
	if t, err := time.Parse("2006-01-02T15:04:05", s); err == nil {
		return t.UTC(), true
	}
	return time.Time{}, false
}

// InsideQuietHours reports whether the wall-clock time of t falls into the
// [start, end) window given as "HH:MM". Windows may wrap around midnight; an
// empty or zero-length window never matches.
func InsideQuietHours(t time.Time, start, end string) bool {
	s, ok1 := clockMinutes(start)
	e, ok2 := clockMinutes(end)
	if !ok1 || !ok2 || s == e {
		return false
	}
	cur := t.Hour()*60 + t.Minute()
	if s < e {
		return s <= cur && cur < e
	}
	return cur >= s || cur < e
}

func clockMinutes(text string) (int, bool) {
	h, m, ok := strings.Cut(strings.TrimSpace(text), ":")
	if !ok {
		return 0, false
	}
	hh, err1 := strconv.Atoi(h)
	mm, err2 := strconv.Atoi(m)
	if err1 != nil || err2 != nil || hh < 0 || hh > 23 || mm < 0 || mm > 59 {
		return 0, false
	}
	return hh*60 + mm, true
}
