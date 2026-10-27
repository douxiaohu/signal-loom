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
	data := CursorData{
		MessageTime: msgTime,
		ID:          id,
	}
	bytes, _ := json.Marshal(data)
	return base64.RawURLEncoding.EncodeToString(bytes)
}

// DecodeCursor 解析游标
func DecodeCursor(cursorStr string) (string, int64, error) {
	if cursorStr == "" {
		return "", 0, nil
	}
	bytes, err := base64.RawURLEncoding.DecodeString(cursorStr)
	if err != nil {
		// 容错：尝试带填充的解析
		bytes, err = base64.URLEncoding.DecodeString(cursorStr)
		if err != nil {
			return "", 0, err
		}
	}
	var data CursorData
	if err := json.Unmarshal(bytes, &data); err != nil {
		return "", 0, err
	}
	return data.MessageTime, data.ID, nil
}

// SaveMessage 保存或更新一条消息（基于 chat_id + message_id 唯一约束）
// 返回是否新增 inserted
func (r *MessageRepository) SaveMessage(msg *model.StoredMessage) (bool, error) {
	query := `
		INSERT INTO messages (
			chat_id, chat_title, message_id, sender_name, message_time,
			content, media_type, raw_json, content_version
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT(chat_id, message_id) DO UPDATE SET
			chat_title = excluded.chat_title,
			sender_name = excluded.sender_name,
			message_time = excluded.message_time,
			content = excluded.content,
			media_type = excluded.media_type,
			raw_json = excluded.raw_json,
			content_version = messages.content_version + 1
	`
	res, err := r.db.Exec(
		query,
		msg.ChatID, msg.ChatTitle, msg.MessageID, msg.SenderName, msg.MessageTime,
		msg.Content, msg.MediaType, msg.RawJSON, 1,
	)
	if err != nil {
		return false, err
	}
	rowsAffected, _ := res.RowsAffected()
	return rowsAffected == 1, nil
}

// GetMessageByID 按主键 id 查询
func (r *MessageRepository) GetMessageByID(id int64) (*model.StoredMessage, error) {
	query := `
		SELECT id, chat_id, chat_title, message_id, sender_name, message_time,
		       content, media_type, raw_json, forwarded_at, content_version
		FROM messages
		WHERE id = ?
	`
	var m model.StoredMessage
	err := r.db.QueryRow(query, id).Scan(
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

// QueryFilter 分页检索入参
type QueryFilter struct {
	ChatID      *int64
	AllowedIDs  []int64 // 限制公开来源范围
	Query       string  // 关键词检索
	MediaType   string  // all, photo, video, text 等
	Cursor      string
	Limit       int
	OnlyPublic  bool
}

// ListMessagesPage 游标分页查询
func (r *MessageRepository) ListMessagesPage(filter QueryFilter) ([]model.StoredMessage, bool, *string, error) {
	limit := filter.Limit
	if limit <= 0 {
		limit = 20
	}
	if limit > 100 {
		limit = 100
	}

	var conditions []string
	var args []any

	if filter.OnlyPublic {
		conditions = append(conditions, "chat_id IN (SELECT chat_id FROM sources WHERE enabled = 1 AND public_visible = 1)")
	}

	if filter.ChatID != nil {
		conditions = append(conditions, "chat_id = ?")
		args = append(args, *filter.ChatID)
	} else if len(filter.AllowedIDs) > 0 {
		placeholders := make([]string, len(filter.AllowedIDs))
		for i, id := range filter.AllowedIDs {
			placeholders[i] = "?"
			args = append(args, id)
		}
		conditions = append(conditions, fmt.Sprintf("chat_id IN (%s)", strings.Join(placeholders, ",")))
	}

	if filter.Query != "" {
		conditions = append(conditions, "content LIKE ?")
		args = append(args, "%"+filter.Query+"%")
	}

	if filter.MediaType != "" && filter.MediaType != "all" {
		if filter.MediaType == "text" {
			conditions = append(conditions, "(media_type IS NULL OR media_type = '')")
		} else {
			conditions = append(conditions, "media_type = ?")
			args = append(args, filter.MediaType)
		}
	}

	// 游标过滤 (message_time < ? OR (message_time = ? AND id < ?))
	cursorTime, cursorID, _ := DecodeCursor(filter.Cursor)
	if cursorTime != "" && cursorID > 0 {
		conditions = append(conditions, "(message_time < ? OR (message_time = ? AND id < ?))")
		args = append(args, cursorTime, cursorTime, cursorID)
	}

	whereClause := "WHERE 1=1"
	if len(conditions) > 0 {
		whereClause += " AND " + strings.Join(conditions, " AND ")
	}

	// 抓取 limit + 1 条，用来判断是否还有下一页 (has_more)
	query := fmt.Sprintf(`
		SELECT id, chat_id, chat_title, message_id, sender_name, message_time,
		       content, media_type, raw_json, forwarded_at, content_version
		FROM messages
		%s
		ORDER BY message_time DESC, id DESC
		LIMIT ?
	`, whereClause)
	args = append(args, limit+1)

	rows, err := r.db.Query(query, args...)
	if err != nil {
		return nil, false, nil, err
	}
	defer rows.Close()

	var list []model.StoredMessage
	for rows.Next() {
		var m model.StoredMessage
		err := rows.Scan(
			&m.ID, &m.ChatID, &m.ChatTitle, &m.MessageID, &m.SenderName, &m.MessageTime,
			&m.Content, &m.MediaType, &m.RawJSON, &m.ForwardedAt, &m.ContentVersion,
		)
		if err != nil {
			return nil, false, nil, err
		}
		list = append(list, m)
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
