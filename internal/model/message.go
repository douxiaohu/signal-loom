package model

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
	MediaItems  []MediaItem `json:"media_items,omitempty"`
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
