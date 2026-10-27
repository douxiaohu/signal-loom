package repository

import (
	"testing"
	"time"

	"telegram-radar/internal/model"
)

func TestRepositoriesIntegration(t *testing.T) {
	// 使用 :memory: 内存数据库进行极速集成测试
	db, err := InitDB(":memory:")
	if err != nil {
		t.Fatalf("InitDB failed: %v", err)
	}
	defer db.Close()

	sourceRepo := NewSourceRepository(db)
	msgRepo := NewMessageRepository(db)

	// 1. 测试创建来源
	src := &model.Source{
		ChatID:        -10012345,
		Name:          "测试频道",
		SourceURL:     "https://t.me/test_channel",
		SourceType:    "telegram_public",
		Adapter:       "telegram_public",
		Enabled:       true,
		PublicVisible: true,
	}
	if err := sourceRepo.SaveSource(src); err != nil {
		t.Fatalf("SaveSource failed: %v", err)
	}

	sources, err := sourceRepo.ListSources()
	if err != nil || len(sources) != 1 {
		t.Fatalf("ListSources failed, expected 1 item, got %d, err: %v", len(sources), err)
	}

	// 2. 测试消息插入与游标分页
	nowStr := time.Now().UTC().Format(time.RFC3339)
	msg := &model.StoredMessage{
		ChatID:      src.ChatID,
		ChatTitle:   src.Name,
		MessageID:   1001,
		SenderName:  "Bot",
		MessageTime: nowStr,
		Content:     "Hello Go World!",
		RawJSON:     `{"source_url": "https://t.me/test_channel/1001"}`,
	}
	inserted, err := msgRepo.SaveMessage(msg)
	if err != nil || !inserted {
		t.Fatalf("SaveMessage failed, inserted=%v, err=%v", inserted, err)
	}

	// 3. 分页查询
	page, hasMore, nextCursor, err := msgRepo.ListMessagesPage(QueryFilter{
		OnlyPublic: true,
		Limit:      10,
	})
	if err != nil {
		t.Fatalf("ListMessagesPage failed: %v", err)
	}
	if len(page) != 1 {
		t.Fatalf("expected 1 message in page, got %d", len(page))
	}
	if hasMore || nextCursor != nil {
		t.Fatalf("expected no next page, got hasMore=%v", hasMore)
	}
}
