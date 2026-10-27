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

// SiteVisitStats 访问统计聚合 DTO
type SiteVisitStats struct {
	TotalVisits int64 `json:"total_visits"`
	UniqueIPs   int64 `json:"unique_ips"`
	TodayVisits int64 `json:"today_visits"`
	TodayIPs    int64 `json:"today_ips"`
}

// Feedback 用户反馈
type Feedback struct {
	ID        int64  `json:"id"`
	Message   string `json:"message"`
	IP        string `json:"ip"`
	Status    string `json:"status"` // new, resolved
	CreatedAt string `json:"created_at"`
	UpdatedAt string `json:"updated_at"`
}
