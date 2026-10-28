package model

// SiteVisit 记录网站访问流水
type SiteVisit struct {
	ID        int64  `json:"id"`
	VisitedAt string `json:"visited_at"`
	IP        string `json:"ip"`
	Path      string `json:"path"`
	Method    string `json:"method"`
	UserAgent string `json:"user_agent"`
	Referer   string `json:"referer"`
}

// SiteVisitStats 访问统计聚合 DTO。字段名与前端 VisitStats 类型、旧 Python 接口保持一致。
type SiteVisitStats struct {
	Total        int64 `json:"total"`
	UniqueIPs    int64 `json:"unique_ips"`
	Today        int64 `json:"today"`
	TodayUnique  int64 `json:"today_unique"`
	Last24h      int64 `json:"last_24h"`
	Last7dUnique int64 `json:"last_7d_unique"`
}

// Feedback 用户反馈
type Feedback struct {
	ID        int64  `json:"id"`
	Message   string `json:"message"`
	IP        string `json:"ip"`
	Status    string `json:"status"` // new, reviewed, resolved, dismissed
	CreatedAt string `json:"created_at"`
	UpdatedAt string `json:"updated_at"`
}
