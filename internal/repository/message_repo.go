package repository

import (
	"database/sql"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"strings"

	"telegram-radar/internal/model"
)

// displayableSQL hides rows the UI should never show: polls and posts without
// text or media. It is the same predicate the Python service applied.
const displayableSQL = `(TRIM(COALESCE(content, '')) <> '' OR media_type IS NOT NULL) AND COALESCE(media_type, '') <> 'poll'`

const likeClause = `(content LIKE ? ESCAPE '\' OR sender_name LIKE ? ESCAPE '\' OR chat_title LIKE ? ESCAPE '\')`

const messageColumns = `id, chat_id, chat_title, message_id, sender_name, message_time,
	content, media_type, raw_json, forwarded_at, content_version`

// MessageRepository 负责 messages 表的持久化与分页检索
type MessageRepository struct {
	db *sql.DB
}

func NewMessageRepository(db *sql.DB) *MessageRepository {
	return &MessageRepository{db: db}
}

type CursorData struct {
	MessageTime string `json:"message_time"`
	ID          int64  `json:"id"`
}

// EncodeCursor 将时间与ID序列化为无填充 url-safe base64 字符串
func EncodeCursor(msgTime string, id int64) string {
	data, _ := json.Marshal(CursorData{MessageTime: msgTime, ID: id})
	return base64.RawURLEncoding.EncodeToString(data)
}

// DecodeCursor 解析游标
func DecodeCursor(cursorStr string) (string, int64, error) {
	if cursorStr == "" {
		return "", 0, nil
	}
	raw, err := base64.RawURLEncoding.DecodeString(strings.TrimRight(cursorStr, "="))
	if err != nil {
		return "", 0, err
	}
	var data CursorData
	if err := json.Unmarshal(raw, &data); err != nil {
		return "", 0, err
	}
	return data.MessageTime, data.ID, nil
}

// SaveResult says what SaveMessage did to the row.
type SaveResult struct {
	ID       int64 // database id of the row (always set on success)
	Inserted bool  // the message was not stored before
	Changed  bool  // the message existed and its payload differs from what we stored
}

// SaveMessage inserts a message or refreshes an existing one (keyed by
// chat_id + message_id). The row is only rewritten, and content_version only
// bumped, when something actually differs, so re-crawling an unchanged page is
// a no-op. msg.ID is filled in on success.
func (r *MessageRepository) SaveMessage(msg *model.StoredMessage) (SaveResult, error) {
	const upsert = `
		INSERT INTO messages (
			chat_id, chat_title, message_id, sender_name, message_time,
			content, media_type, raw_json, content_version
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)
		ON CONFLICT(chat_id, message_id) DO UPDATE SET
			chat_title = excluded.chat_title,
			sender_name = excluded.sender_name,
			message_time = excluded.message_time,
			content = excluded.content,
			media_type = excluded.media_type,
			raw_json = excluded.raw_json,
			content_version = messages.content_version + 1
		WHERE messages.content IS NOT excluded.content
		   OR messages.media_type IS NOT excluded.media_type
		   OR messages.raw_json IS NOT excluded.raw_json
		   OR messages.chat_title IS NOT excluded.chat_title
		   OR messages.sender_name IS NOT excluded.sender_name
		   OR messages.message_time IS NOT excluded.message_time
		RETURNING id, content_version`

	var id int64
	var version int
	err := r.db.QueryRow(upsert,
		msg.ChatID, msg.ChatTitle, msg.MessageID, msg.SenderName, msg.MessageTime,
		msg.Content, msg.MediaType, msg.RawJSON,
	).Scan(&id, &version)

	switch {
	case err == nil:
		msg.ID, msg.ContentVersion = id, version
		if version <= 1 {
			return SaveResult{ID: id, Inserted: true}, nil
		}
		return SaveResult{ID: id, Changed: true}, nil
	case errors.Is(err, sql.ErrNoRows):
		// Existing row, identical payload: the conflict update was skipped.
		if err := r.db.QueryRow(
			`SELECT id, content_version FROM messages WHERE chat_id = ? AND message_id = ?`,
			msg.ChatID, msg.MessageID,
		).Scan(&id, &version); err != nil {
			return SaveResult{}, err
		}
		msg.ID, msg.ContentVersion = id, version
		return SaveResult{ID: id}, nil
	default:
		return SaveResult{}, err
	}
}

// GetMessageByID 按主键 id 查询
func (r *MessageRepository) GetMessageByID(id int64) (*model.StoredMessage, error) {
	var m model.StoredMessage
	err := r.db.QueryRow(`SELECT `+messageColumns+` FROM messages WHERE id = ?`, id).Scan(
		&m.ID, &m.ChatID, &m.ChatTitle, &m.MessageID, &m.SenderName, &m.MessageTime,
		&m.Content, &m.MediaType, &m.RawJSON, &m.ForwardedAt, &m.ContentVersion,
	)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &m, nil
}

// ChatStats summarises the displayable messages of one source.
type ChatStats struct {
	MessageCount    int
	LastMessageTime *string
}

// StatsByChat returns message counts per source in a single query.
func (r *MessageRepository) StatsByChat() (map[int64]ChatStats, error) {
	rows, err := r.db.Query(`
		SELECT chat_id, COUNT(*), MAX(message_time)
		FROM messages
		WHERE ` + displayableSQL + `
		GROUP BY chat_id`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	stats := make(map[int64]ChatStats)
	for rows.Next() {
		var (
			chatID int64
			s      ChatStats
			last   sql.NullString
		)
		if err := rows.Scan(&chatID, &s.MessageCount, &last); err != nil {
			return nil, err
		}
		if last.Valid {
			v := last.String
			s.LastMessageTime = &v
		}
		stats[chatID] = s
	}
	return stats, rows.Err()
}

// QueryFilter 分页检索入参
type QueryFilter struct {
	ChatID     *int64
	Query      string // 关键词检索（内容 / 发送者 / 频道名）
	MediaType  string // all, text, photo, video ...
	Cursor     string
	Limit      int
	MaxLimit   int // upper bound for Limit (default 100)
	OnlyPublic bool
}

func likePattern(q string) string {
	escaped := strings.NewReplacer(`\`, `\\`, `%`, `\%`, `_`, `\_`).Replace(q)
	return "%" + escaped + "%"
}

// ListMessagesPage 游标分页查询。返回的切片永不为 nil。
func (r *MessageRepository) ListMessagesPage(f QueryFilter) ([]model.StoredMessage, bool, *string, error) {
	maxLimit := f.MaxLimit
	if maxLimit <= 0 {
		maxLimit = 100
	}
	limit := f.Limit
	if limit <= 0 {
		limit = 20
	}
	if limit > maxLimit {
		limit = maxLimit
	}

	conditions := []string{displayableSQL}
	var args []any

	if f.OnlyPublic {
		conditions = append(conditions, "chat_id IN (SELECT chat_id FROM sources WHERE enabled = 1 AND public_visible = 1)")
	}
	if f.ChatID != nil {
		conditions = append(conditions, "chat_id = ?")
		args = append(args, *f.ChatID)
	}
	if q := strings.TrimSpace(f.Query); q != "" {
		pattern := likePattern(q)
		conditions = append(conditions, likeClause)
		args = append(args, pattern, pattern, pattern)
	}
	switch f.MediaType {
	case "", "all":
	case "text":
		conditions = append(conditions, "(media_type IS NULL OR media_type = '')")
	default:
		conditions = append(conditions, "media_type = ?")
		args = append(args, f.MediaType)
	}
	if cursorTime, cursorID, err := DecodeCursor(f.Cursor); err == nil && cursorTime != "" && cursorID > 0 {
		conditions = append(conditions, "(message_time < ? OR (message_time = ? AND id < ?))")
		args = append(args, cursorTime, cursorTime, cursorID)
	}

	// Fetch limit+1 rows to learn whether another page exists.
	query := fmt.Sprintf(`
		SELECT %s
		FROM messages
		WHERE %s
		ORDER BY message_time DESC, id DESC
		LIMIT ?`, messageColumns, strings.Join(conditions, " AND "))
	args = append(args, limit+1)

	rows, err := r.db.Query(query, args...)
	if err != nil {
		return nil, false, nil, err
	}
	defer rows.Close()

	list := make([]model.StoredMessage, 0, limit+1)
	for rows.Next() {
		var m model.StoredMessage
		if err := rows.Scan(
			&m.ID, &m.ChatID, &m.ChatTitle, &m.MessageID, &m.SenderName, &m.MessageTime,
			&m.Content, &m.MediaType, &m.RawJSON, &m.ForwardedAt, &m.ContentVersion,
		); err != nil {
			return nil, false, nil, err
		}
		list = append(list, m)
	}
	if err := rows.Err(); err != nil {
		return nil, false, nil, err
	}

	hasMore := len(list) > limit
	if hasMore {
		list = list[:limit]
	}
	var nextCursor *string
	if hasMore && len(list) > 0 {
		last := list[len(list)-1]
		c := EncodeCursor(last.MessageTime, last.ID)
		nextCursor = &c
	}
	return list, hasMore, nextCursor, nil
}
