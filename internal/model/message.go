package model

import (
	"encoding/json"
	"strings"
)

// MediaItem 媒体项详细信息
type MediaItem struct {
	URL         string `json:"url"`
	OriginalURL string `json:"original_url,omitempty"`
	Kind        string `json:"kind"`
	Role        string `json:"role"`
}

// RawMessageData 对应 raw_json 解析出来的业务对象
type RawMessageData struct {
	SourceURL  string      `json:"source_url,omitempty"`
	MediaURLs  []string    `json:"media_urls,omitempty"`
	MediaItems []MediaItem `json:"media_items,omitempty"`
}

// ParseRawMessage decodes raw_json leniently: rows written by the old Python
// service may carry slightly different shapes, and a field of the wrong type
// must not hide the fields that are fine.
func ParseRawMessage(rawJSON string) RawMessageData {
	var raw RawMessageData
	if strings.TrimSpace(rawJSON) == "" {
		return raw
	}
	_ = json.Unmarshal([]byte(rawJSON), &raw) // partial results are kept on type errors
	return raw
}

// Items returns the media entries of a message. Rows that only carry
// "media_urls" (older crawler output) are expanded into items, exactly as the
// Python service did. The slice index is the media index used in URLs, so the
// feed formatter and the media endpoints must both go through this method.
func (r RawMessageData) Items(mediaType *string) []MediaItem {
	items := make([]MediaItem, 0, len(r.MediaItems))
	for _, item := range r.MediaItems {
		if item.URL == "" {
			continue
		}
		if item.Kind == "" {
			item.Kind = fallbackMediaKind(mediaType)
		}
		if item.Role == "" {
			item.Role = fallbackMediaRole(mediaType)
		}
		items = append(items, MediaItem{URL: item.URL, Kind: item.Kind, Role: item.Role})
	}
	if len(items) > 0 {
		return items
	}
	for _, u := range r.MediaURLs {
		if u == "" {
			continue
		}
		items = append(items, MediaItem{URL: u, Kind: fallbackMediaKind(mediaType), Role: fallbackMediaRole(mediaType)})
	}
	return items
}

func fallbackMediaKind(mediaType *string) string {
	if mediaType == nil {
		return "file"
	}
	switch *mediaType {
	case "photo", "video":
		return "image"
	case "animation":
		return "video"
	case "":
		return "file"
	}
	return *mediaType
}

func fallbackMediaRole(mediaType *string) string {
	if mediaType != nil && *mediaType == "video" {
		return "poster"
	}
	return "media"
}

// StoredMessage 对应 messages 表的原始持久化结构
type StoredMessage struct {
	ID             int64   `json:"id"`
	ChatID         int64   `json:"chat_id"`
	ChatTitle      string  `json:"chat_title"`
	MessageID      int64   `json:"message_id"`
	SenderName     string  `json:"sender_name"`
	MessageTime    string  `json:"message_time"`
	Content        string  `json:"content"`
	MediaType      *string `json:"media_type"`
	RawJSON        string  `json:"raw_json"`
	ForwardedAt    *string `json:"forwarded_at"`
	ContentVersion int     `json:"content_version"`
}

// Displayable mirrors the Python rule: a post needs text or media, and polls
// are never shown.
func (m *StoredMessage) Displayable() bool {
	if m.MediaType != nil && *m.MediaType == "poll" {
		return false
	}
	return strings.TrimSpace(m.Content) != "" || (m.MediaType != nil && *m.MediaType != "")
}

// APIMessage 对应前端渲染所需的 Message DTO
type APIMessage struct {
	ID          int64       `json:"id"`
	ChatID      int64       `json:"chat_id"`
	ChatTitle   string      `json:"chat_title"`
	MessageID   int64       `json:"message_id"`
	SenderName  string      `json:"sender_name"`
	MessageTime string      `json:"message_time"`
	Content     string      `json:"content"`
	MediaType   *string     `json:"media_type"`
	MediaURLs   []string    `json:"media_urls"`
	MediaItems  []MediaItem `json:"media_items"`
	SourceURL   string      `json:"source_url"`
	ForwardedAt *string     `json:"forwarded_at,omitempty"`
}

// MessagePage 游标分页结构
type MessagePage struct {
	Items      []APIMessage `json:"items"`
	HasMore    bool         `json:"has_more"`
	NextCursor *string      `json:"next_cursor"`
	Total      *int         `json:"total"`
}

// AlertRule 告警监控规则
type AlertRule struct {
	ID              int64   `json:"id"`
	Name            string  `json:"name"`
	Keyword         string  `json:"keyword"`
	MediaType       *string `json:"media_type"`
	QuietStart      *string `json:"quiet_start"`
	QuietEnd        *string `json:"quiet_end"`
	CooldownMinutes int     `json:"cooldown_minutes"`
	Enabled         bool    `json:"enabled"`
	SourceIDs       []int64 `json:"source_ids"`
	CreatedAt       string  `json:"created_at"`
	UpdatedAt       string  `json:"updated_at"`
}

// AlertMatch 命中告警的记录
type AlertMatch struct {
	ID          int64   `json:"id"`
	RuleID      int64   `json:"rule_id"`
	RuleName    string  `json:"rule_name"`
	Keyword     string  `json:"keyword"`
	Status      string  `json:"status"` // new, acknowledged, resolved
	MatchedAt   string  `json:"matched_at"`
	ChatTitle   string  `json:"chat_title"`
	SenderName  string  `json:"sender_name"`
	MessageTime string  `json:"message_time"`
	Content     string  `json:"content"`
	MediaType   *string `json:"media_type"`
}
