package model

import "time"

// Source 对应数据库中的 sources 表
// 在 Java 中这相当于一个 @Entity 类
type Source struct {
	ChatID        int64     `json:"chat_id"`
	Name          string    `json:"name"`
	SourceURL     string    `json:"source_url"`
	SourceType    string    `json:"source_type"`
	Adapter       string    `json:"adapter"`
	Locator       string    `json:"locator"`
	Enabled       bool      `json:"enabled"`
	PublicVisible bool      `json:"public_visible"`
	CreatedAt     time.Time `json:"created_at"`
	UpdatedAt     time.Time `json:"updated_at"`
}

// SourceHealth 来源健康状态
type SourceHealth struct {
	ChatID        int64   `json:"chat_id"`
	HealthStatus  string  `json:"health_status"`
	LastRunAt     *string `json:"last_run_at"`
	LastSuccessAt *string `json:"last_success_at"`
	LastError     *string `json:"last_error"`
	FetchedCount  int     `json:"fetched_count"`
	SavedCount    int     `json:"saved_count"`
}

// PublicSource 是公开接口返回的来源摘要（脱敏后的 DTO）
// 对应 Java 中的 PublicSourceDTO / VO (View Object)
type PublicSource struct {
	ChatID          int64   `json:"chat_id"`
	Name            string  `json:"name"`
	SourceURL       string  `json:"source_url"`
	MessageCount    int     `json:"message_count"`
	LastMessageTime *string `json:"last_message_time"`
	HealthStatus    string  `json:"health_status"`
}

// SourceWithHealth 是管理端展示的来源详情（带健康状态）
type SourceWithHealth struct {
	ChatID          int64   `json:"chat_id"`
	Name            string  `json:"name"`
	Source          *string `json:"source"`
	SourceURL       string  `json:"source_url"`
	SourceType      string  `json:"source_type"`
	Adapter         string  `json:"adapter"`
	Enabled         bool    `json:"enabled"`
	PublicVisible   bool    `json:"public_visible"`
	HealthStatus    string  `json:"health_status"`
	LastRunAt       *string `json:"last_run_at"`
	LastSuccessAt   *string `json:"last_success_at"`
	LastError       *string `json:"last_error"`
	FetchedCount    int     `json:"fetched_count"`
	SavedCount      int     `json:"saved_count"`
	MessageCount    int     `json:"message_count"`
	LastMessageTime *string `json:"last_message_time"`
}

// SourceRun 采集执行记录
type SourceRun struct {
	ID           int64   `json:"id"`
	ChatID       int64   `json:"chat_id"`
	Source       string  `json:"source"`
	StartedAt    string  `json:"started_at"`
	FinishedAt   string  `json:"finished_at"`
	FetchedCount int     `json:"fetched_count"`
	SavedCount   int     `json:"saved_count"`
	Error        *string `json:"error"`
}
