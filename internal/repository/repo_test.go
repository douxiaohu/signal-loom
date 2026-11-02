package repository

import (
	"database/sql"
	"errors"
	"fmt"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"telegram-radar/internal/config"
	"telegram-radar/internal/model"
)

func newTestDB(t *testing.T) *sql.DB {
	t.Helper()
	db, err := InitDB(filepath.Join(t.TempDir(), "test.db"))
	if err != nil {
		t.Fatalf("InitDB: %v", err)
	}
	t.Cleanup(func() { _ = db.Close() })
	return db
}

func strPtr(s string) *string { return &s }

func addSource(t *testing.T, repo *SourceRepository, chatID int64, name string, enabled, public bool) *model.Source {
	t.Helper()
	src := &model.Source{
		ChatID:        chatID,
		Name:          name,
		SourceURL:     fmt.Sprintf("https://t.me/%s", strings.ToLower(name)),
		SourceType:    "telegram_public",
		Adapter:       "telegram_public",
		Enabled:       enabled,
		PublicVisible: public,
	}
	src.Locator = src.SourceURL
	if err := repo.CreateSource(src); err != nil {
		t.Fatalf("CreateSource(%s): %v", name, err)
	}
	return src
}

func newMessage(chatID, messageID int64, content string, mediaType *string, when string) *model.StoredMessage {
	return &model.StoredMessage{
		ChatID:      chatID,
		ChatTitle:   "chan",
		MessageID:   messageID,
		SenderName:  "chan",
		MessageTime: when,
		Content:     content,
		MediaType:   mediaType,
		RawJSON:     fmt.Sprintf(`{"source_url":"https://t.me/chan/%d"}`, messageID),
	}
}

func TestRepositoriesIntegration(t *testing.T) {
	db, err := InitDB(":memory:")
	if err != nil {
		t.Fatalf("InitDB failed: %v", err)
	}
	defer db.Close()

	sourceRepo := NewSourceRepository(db)
	msgRepo := NewMessageRepository(db)

	src := addSource(t, sourceRepo, -10012345, "test_channel", true, true)
	sources, err := sourceRepo.ListSources()
	if err != nil || len(sources) != 1 {
		t.Fatalf("ListSources failed, expected 1 item, got %d, err: %v", len(sources), err)
	}

	msg := newMessage(src.ChatID, 1001, "Hello Go World!", nil, time.Now().UTC().Format(time.RFC3339))
	res, err := msgRepo.SaveMessage(msg)
	if err != nil || !res.Inserted {
		t.Fatalf("SaveMessage failed, res=%+v err=%v", res, err)
	}

	page, hasMore, nextCursor, err := msgRepo.ListMessagesPage(QueryFilter{OnlyPublic: true, Limit: 10})
	if err != nil {
		t.Fatalf("ListMessagesPage failed: %v", err)
	}
	if len(page) != 1 || hasMore || nextCursor != nil {
		t.Fatalf("unexpected page: len=%d hasMore=%v next=%v", len(page), hasMore, nextCursor)
	}
}

func TestSaveMessageReportsRealChanges(t *testing.T) {
	db := newTestDB(t)
	repo := NewMessageRepository(db)

	m := newMessage(-1, 10, "first version", nil, "2026-10-28T00:00:00+00:00")
	res, err := repo.SaveMessage(m)
	if err != nil || !res.Inserted || res.Changed || res.ID == 0 || m.ID != res.ID {
		t.Fatalf("first save: %+v err=%v msg.ID=%d", res, err, m.ID)
	}
	firstID := res.ID

	// The crawler hands us an identical post on every cycle: that is not news.
	same := *m
	same.ID = 0
	res, err = repo.SaveMessage(&same)
	if err != nil || res.Inserted || res.Changed || res.ID != firstID || same.ID != firstID {
		t.Fatalf("identical re-save: %+v err=%v same.ID=%d", res, err, same.ID)
	}
	if got, _ := repo.GetMessageByID(firstID); got.ContentVersion != 1 {
		t.Fatalf("content_version must not move for identical content, got %d", got.ContentVersion)
	}

	edited := *m
	edited.Content = "edited version"
	res, err = repo.SaveMessage(&edited)
	if err != nil || res.Inserted || !res.Changed || res.ID != firstID {
		t.Fatalf("edit: %+v err=%v", res, err)
	}
	got, _ := repo.GetMessageByID(firstID)
	if got.ContentVersion != 2 || got.Content != "edited version" {
		t.Fatalf("after edit: version=%d content=%q", got.ContentVersion, got.Content)
	}

	// Saving the edited text again is again a no-op.
	again := edited
	if res, _ = repo.SaveMessage(&again); res.Changed || res.Inserted {
		t.Fatalf("second identical save of the edit: %+v", res)
	}
	if got, _ = repo.GetMessageByID(firstID); got.ContentVersion != 2 {
		t.Fatalf("content_version = %d, want 2", got.ContentVersion)
	}
}

func TestForeignKeysAreEnforcedAndCascade(t *testing.T) {
	db := newTestDB(t)
	var fk int
	if err := db.QueryRow("PRAGMA foreign_keys").Scan(&fk); err != nil || fk != 1 {
		t.Fatalf("PRAGMA foreign_keys = %d (err %v), want 1", fk, err)
	}

	alerts := NewAlertRepository(db, time.UTC)
	msgs := NewMessageRepository(db)

	rule := &model.AlertRule{Name: "r", Keyword: "foo", Enabled: true, SourceIDs: []int64{-1}}
	if err := alerts.CreateRule(rule); err != nil {
		t.Fatal(err)
	}
	m := newMessage(-1, 1, "foo bar", nil, "2026-10-28T00:00:00Z")
	if _, err := msgs.SaveMessage(m); err != nil {
		t.Fatal(err)
	}
	if n, err := alerts.MatchAndRecord(m); err != nil || n != 1 {
		t.Fatalf("MatchAndRecord = %d, %v", n, err)
	}

	// A match pointing at a message that does not exist must be rejected.
	if _, err := db.Exec(`INSERT INTO alert_matches (rule_id, message_id, status, matched_at) VALUES (?, 99999, 'new', 'x')`, rule.ID); err == nil {
		t.Fatal("foreign key on alert_matches.message_id is not enforced")
	}

	if err := alerts.DeleteRule(rule.ID); err != nil {
		t.Fatal(err)
	}
	for table, query := range map[string]string{
		"alert_matches":      `SELECT COUNT(*) FROM alert_matches`,
		"alert_rule_sources": `SELECT COUNT(*) FROM alert_rule_sources`,
	} {
		var n int
		if err := db.QueryRow(query).Scan(&n); err != nil || n != 0 {
			t.Errorf("%s: %d rows survive the rule delete (err %v)", table, n, err)
		}
	}
}

func TestAlertMatchingUsesRealMessageIDs(t *testing.T) {
	db := newTestDB(t)
	msgs := NewMessageRepository(db)
	alerts := NewAlertRepository(db, time.UTC)

	rule := &model.AlertRule{Name: "btc", Keyword: "Bitcoin", Enabled: true}
	if err := alerts.CreateRule(rule); err != nil {
		t.Fatal(err)
	}

	first := newMessage(-1, 1, "BITCOIN hits a new high", nil, "2026-10-28T00:00:00Z")
	second := newMessage(-1, 2, "more bitcoin news", nil, "2026-10-28T00:05:00Z")
	third := newMessage(-1, 3, "nothing relevant", nil, "2026-10-28T00:06:00Z")
	for _, m := range []*model.StoredMessage{first, second, third} {
		if _, err := msgs.SaveMessage(m); err != nil {
			t.Fatal(err)
		}
		if _, err := alerts.MatchAndRecord(m); err != nil {
			t.Fatal(err)
		}
	}

	matches, err := alerts.ListMatches("", 100)
	if err != nil {
		t.Fatal(err)
	}
	if len(matches) != 2 {
		t.Fatalf("want 2 matches (one per matching message), got %d: %+v", len(matches), matches)
	}
	if matches[0].Content != "more bitcoin news" || matches[0].RuleName != "btc" || matches[0].Status != "new" {
		t.Errorf("match payload not joined correctly: %+v", matches[0])
	}

	// Matching the same message again must not duplicate anything.
	if n, err := alerts.MatchAndRecord(first); err != nil || n != 0 {
		t.Errorf("re-match created %d rows, err %v", n, err)
	}

	if _, err := alerts.MatchAndRecord(&model.StoredMessage{Content: "bitcoin"}); err == nil {
		t.Error("matching a message without a database id must fail loudly")
	}
}

func TestAlertRuleConditions(t *testing.T) {
	db := newTestDB(t)
	msgs := NewMessageRepository(db)
	shanghai, err := time.LoadLocation("Asia/Shanghai")
	if err != nil {
		t.Skip("tzdata unavailable")
	}
	alerts := NewAlertRepository(db, shanghai)

	count := func(rule *model.AlertRule, m *model.StoredMessage) int {
		t.Helper()
		if _, err := msgs.SaveMessage(m); err != nil {
			t.Fatal(err)
		}
		n, err := alerts.MatchAndRecord(m)
		if err != nil {
			t.Fatal(err)
		}
		return n
	}
	mustRule := func(r model.AlertRule) *model.AlertRule {
		t.Helper()
		if err := alerts.CreateRule(&r); err != nil {
			t.Fatal(err)
		}
		return &r
	}

	t.Run("empty keyword never matches", func(t *testing.T) {
		r := mustRule(model.AlertRule{Name: "all", Keyword: "", Enabled: true})
		if n := count(r, newMessage(-1, 100, "anything", nil, "2026-10-28T00:00:00Z")); n != 0 {
			t.Fatalf("an empty keyword matched %d times", n)
		}
	})
	t.Run("disabled rules are ignored", func(t *testing.T) {
		r := mustRule(model.AlertRule{Name: "off", Keyword: "disabledkw", Enabled: false})
		if n := count(r, newMessage(-1, 101, "disabledkw", nil, "2026-10-28T00:00:00Z")); n != 0 {
			t.Fatalf("disabled rule matched")
		}
	})
	t.Run("source restriction", func(t *testing.T) {
		r := mustRule(model.AlertRule{Name: "src", Keyword: "srckw", Enabled: true, SourceIDs: []int64{-7}})
		if n := count(r, newMessage(-1, 102, "srckw", nil, "2026-10-28T00:00:00Z")); n != 0 {
			t.Fatal("matched a source outside the rule's list")
		}
		if n := count(r, newMessage(-7, 103, "srckw", nil, "2026-10-28T00:00:00Z")); n != 1 {
			t.Fatal("did not match a source inside the rule's list")
		}
	})
	t.Run("media restriction", func(t *testing.T) {
		photo := mustRule(model.AlertRule{Name: "photo", Keyword: "mediakw", Enabled: true, MediaType: strPtr("photo")})
		if n := count(photo, newMessage(-2, 104, "mediakw", nil, "2026-10-28T00:00:00Z")); n != 0 {
			t.Fatal("text message matched a photo-only rule")
		}
		if n := count(photo, newMessage(-2, 105, "mediakw", strPtr("photo"), "2026-10-28T00:00:00Z")); n < 1 {
			t.Fatal("photo message did not match the photo rule")
		}
		textOnly := mustRule(model.AlertRule{Name: "textonly", Keyword: "textkw", Enabled: true, MediaType: strPtr("text")})
		if n := count(textOnly, newMessage(-3, 106, "textkw", strPtr("photo"), "2026-10-28T00:00:00Z")); n != 0 {
			t.Fatal("photo message matched a text-only rule")
		}
		if n := count(textOnly, newMessage(-3, 107, "textkw", nil, "2026-10-28T00:00:00Z")); n != 1 {
			t.Fatal("text message did not match the text-only rule")
		}
	})
	t.Run("quiet hours use the configured zone", func(t *testing.T) {
		r := mustRule(model.AlertRule{Name: "quiet", Keyword: "quietkw", Enabled: true, QuietStart: strPtr("22:00"), QuietEnd: strPtr("07:00")})
		// 15:00Z is 23:00 in Shanghai: inside the quiet window.
		if n := count(r, newMessage(-4, 108, "quietkw", nil, "2026-10-28T15:00:00Z")); n != 0 {
			t.Fatal("matched during quiet hours")
		}
		// 02:00Z is 10:00 in Shanghai: outside.
		if n := count(r, newMessage(-4, 109, "quietkw", nil, "2026-10-28T02:00:00Z")); n != 1 {
			t.Fatal("did not match outside quiet hours")
		}
	})
	t.Run("cooldown", func(t *testing.T) {
		r := mustRule(model.AlertRule{Name: "cool", Keyword: "coolkw", Enabled: true, CooldownMinutes: 30, SourceIDs: []int64{-5}})
		if n := count(r, newMessage(-5, 110, "coolkw", nil, "2026-10-28T10:00:00Z")); n != 1 {
			t.Fatal("first message should match")
		}
		if n := count(r, newMessage(-5, 111, "coolkw", nil, "2026-10-28T10:10:00Z")); n != 0 {
			t.Fatal("message inside the cooldown window matched")
		}
		if n := count(r, newMessage(-5, 112, "coolkw", nil, "2026-10-28T10:31:00Z")); n != 1 {
			t.Fatal("message after the cooldown should match")
		}
	})
}

func TestInsideQuietHours(t *testing.T) {
	at := func(h, m int) time.Time { return time.Date(2026, 10, 28, h, m, 0, 0, time.UTC) }
	cases := []struct {
		start, end string
		t          time.Time
		want       bool
	}{
		{"09:00", "17:00", at(9, 0), true},
		{"09:00", "17:00", at(16, 59), true},
		{"09:00", "17:00", at(17, 0), false},
		{"22:00", "07:00", at(23, 30), true},
		{"22:00", "07:00", at(3, 0), true},
		{"22:00", "07:00", at(12, 0), false},
		{"10:00", "10:00", at(10, 0), false},
		{"", "07:00", at(3, 0), false},
		{"bad", "07:00", at(3, 0), false},
		{"25:00", "07:00", at(3, 0), false},
	}
	for _, c := range cases {
		if got := InsideQuietHours(c.t, c.start, c.end); got != c.want {
			t.Errorf("InsideQuietHours(%s, %q, %q) = %v, want %v", c.t.Format("15:04"), c.start, c.end, got, c.want)
		}
	}
}

func TestUpdateRuleIsPartialAndAtomic(t *testing.T) {
	db := newTestDB(t)
	alerts := NewAlertRepository(db, time.UTC)

	rule := &model.AlertRule{
		Name: "Bitcoin watch", Keyword: "bitcoin", Enabled: false, CooldownMinutes: 30,
		MediaType: strPtr("photo"), QuietStart: strPtr("22:00"), QuietEnd: strPtr("07:00"),
		SourceIDs: []int64{-2, -1, -2},
	}
	if err := alerts.CreateRule(rule); err != nil {
		t.Fatal(err)
	}
	if len(rule.SourceIDs) != 2 || rule.SourceIDs[0] != -2 {
		t.Fatalf("source ids should be de-duplicated and sorted: %v", rule.SourceIDs)
	}

	// This is exactly what the UI sends when the toggle is clicked.
	updated, err := alerts.UpdateRule(rule.ID, func(r *model.AlertRule) error {
		r.Enabled = true
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	if !updated.Enabled || updated.Name != "Bitcoin watch" || updated.Keyword != "bitcoin" || updated.CooldownMinutes != 30 ||
		updated.MediaType == nil || *updated.MediaType != "photo" || updated.QuietStart == nil || len(updated.SourceIDs) != 2 {
		t.Fatalf("toggling enabled changed other fields: %+v", updated)
	}
	stored, err := alerts.GetRule(rule.ID)
	if err != nil || stored.Name != "Bitcoin watch" || len(stored.SourceIDs) != 2 || !stored.Enabled {
		t.Fatalf("stored rule diverged: %+v err=%v", stored, err)
	}

	// A mutate error rolls everything back.
	boom := errors.New("rejected")
	if _, err := alerts.UpdateRule(rule.ID, func(r *model.AlertRule) error {
		r.Name = "should not persist"
		r.SourceIDs = nil
		return boom
	}); !errors.Is(err, boom) {
		t.Fatalf("mutate error not propagated: %v", err)
	}
	stored, _ = alerts.GetRule(rule.ID)
	if stored.Name != "Bitcoin watch" || len(stored.SourceIDs) != 2 {
		t.Fatalf("rejected update leaked into the database: %+v", stored)
	}

	if _, err := alerts.UpdateRule(424242, func(*model.AlertRule) error { return nil }); !errors.Is(err, ErrNotFound) {
		t.Fatalf("missing rule: %v", err)
	}

	list, err := alerts.ListRules()
	if err != nil || len(list) != 1 || len(list[0].SourceIDs) != 2 {
		t.Fatalf("ListRules = %+v, %v", list, err)
	}
	empty := newTestDB(t)
	if rules, err := NewAlertRepository(empty, nil).ListRules(); err != nil || rules == nil {
		t.Fatalf("ListRules on an empty table must return an empty slice, got %#v, %v", rules, err)
	}
}

func TestMatchStatusTransitions(t *testing.T) {
	db := newTestDB(t)
	msgs := NewMessageRepository(db)
	alerts := NewAlertRepository(db, time.UTC)

	rule := &model.AlertRule{Name: "r", Keyword: "kw", Enabled: true}
	if err := alerts.CreateRule(rule); err != nil {
		t.Fatal(err)
	}
	m := newMessage(-1, 1, "kw", nil, "2026-10-28T00:00:00Z")
	_, _ = msgs.SaveMessage(m)
	_, _ = alerts.MatchAndRecord(m)
	matches, _ := alerts.ListMatches("new", 10)
	if len(matches) != 1 {
		t.Fatalf("setup: %v", matches)
	}
	id := matches[0].ID

	got, err := alerts.SetMatchStatus(id, "acknowledged")
	if err != nil || got.Status != "acknowledged" {
		t.Fatalf("acknowledge: %+v %v", got, err)
	}
	var ack, res sql.NullString
	_ = db.QueryRow(`SELECT acknowledged_at, resolved_at FROM alert_matches WHERE id = ?`, id).Scan(&ack, &res)
	if !ack.Valid || res.Valid {
		t.Fatalf("after acknowledge: ack=%v resolved=%v", ack, res)
	}
	if got, err = alerts.SetMatchStatus(id, "resolved"); err != nil || got.Status != "resolved" {
		t.Fatalf("resolve: %+v %v", got, err)
	}
	_ = db.QueryRow(`SELECT acknowledged_at, resolved_at FROM alert_matches WHERE id = ?`, id).Scan(&ack, &res)
	if !ack.Valid || !res.Valid {
		t.Fatalf("after resolve both timestamps are expected: ack=%v resolved=%v", ack, res)
	}
	if _, err := alerts.SetMatchStatus(id, "bogus"); err == nil {
		t.Error("an unknown status must be rejected")
	}
	if _, err := alerts.SetMatchStatus(9999, "resolved"); !errors.Is(err, ErrNotFound) {
		t.Errorf("missing match: %v", err)
	}

	stats, err := alerts.Stats()
	if err != nil || stats.Resolved != 1 || stats.New != 0 || stats.RuleCount != 1 || stats.EnabledRuleCount != 1 {
		t.Fatalf("stats = %+v, %v", stats, err)
	}
}

func TestListMessagesPage(t *testing.T) {
	db := newTestDB(t)
	sources := NewSourceRepository(db)
	repo := NewMessageRepository(db)

	pub := addSource(t, sources, -1, "Pub", true, true)
	priv := addSource(t, sources, -2, "Priv", true, false)
	off := addSource(t, sources, -3, "Off", false, true)

	for i := 1; i <= 5; i++ {
		_, _ = repo.SaveMessage(newMessage(pub.ChatID, int64(i), fmt.Sprintf("pub post %d", i), nil, fmt.Sprintf("2026-10-28T00:0%d:00Z", i)))
	}
	_, _ = repo.SaveMessage(newMessage(priv.ChatID, 1, "private post", nil, "2026-10-28T00:10:00Z"))
	_, _ = repo.SaveMessage(newMessage(off.ChatID, 1, "disabled post", nil, "2026-10-28T00:11:00Z"))
	_, _ = repo.SaveMessage(newMessage(pub.ChatID, 6, "100% sure_thing", strPtr("photo"), "2026-10-28T00:12:00Z"))
	_, _ = repo.SaveMessage(newMessage(pub.ChatID, 7, "", strPtr("poll"), "2026-10-28T00:13:00Z"))  // never shown
	_, _ = repo.SaveMessage(newMessage(pub.ChatID, 8, "   ", nil, "2026-10-28T00:14:00Z"))          // empty
	_, _ = repo.SaveMessage(newMessage(pub.ChatID, 9, "", strPtr("photo"), "2026-10-28T00:15:00Z")) // media only

	t.Run("public hides private and disabled sources", func(t *testing.T) {
		list, _, _, err := repo.ListMessagesPage(QueryFilter{OnlyPublic: true, Limit: 100})
		if err != nil {
			t.Fatal(err)
		}
		for _, m := range list {
			if m.ChatID != pub.ChatID {
				t.Errorf("public listing leaked chat %d: %q", m.ChatID, m.Content)
			}
			if m.MediaType != nil && *m.MediaType == "poll" || (strings.TrimSpace(m.Content) == "" && m.MediaType == nil) {
				t.Errorf("non-displayable row listed: %+v", m)
			}
		}
		if len(list) != 7 { // 5 text + "100% sure_thing" + media-only
			t.Errorf("got %d rows", len(list))
		}
	})
	t.Run("admin sees every source", func(t *testing.T) {
		list, _, _, _ := repo.ListMessagesPage(QueryFilter{Limit: 100, MaxLimit: 200})
		if len(list) != 9 {
			t.Errorf("admin listing has %d rows, want 9", len(list))
		}
	})
	t.Run("cursor pagination walks everything exactly once", func(t *testing.T) {
		seen := map[int64]bool{}
		cursor := ""
		for page := 0; page < 10; page++ {
			list, hasMore, next, err := repo.ListMessagesPage(QueryFilter{OnlyPublic: true, Limit: 3, Cursor: cursor})
			if err != nil {
				t.Fatal(err)
			}
			for _, m := range list {
				if seen[m.ID] {
					t.Fatalf("message %d returned twice", m.ID)
				}
				seen[m.ID] = true
			}
			if !hasMore {
				if next != nil {
					t.Fatal("next cursor without more data")
				}
				break
			}
			cursor = *next
		}
		if len(seen) != 7 {
			t.Fatalf("pagination visited %d rows, want 7", len(seen))
		}
	})
	t.Run("limit is clamped", func(t *testing.T) {
		list, _, _, _ := repo.ListMessagesPage(QueryFilter{OnlyPublic: true, Limit: 1_000_000})
		if len(list) > 100 {
			t.Fatalf("limit not clamped: %d", len(list))
		}
		list, hasMore, _, _ := repo.ListMessagesPage(QueryFilter{Limit: 2, MaxLimit: 2})
		if len(list) != 2 || !hasMore {
			t.Fatalf("MaxLimit not honoured: %d %v", len(list), hasMore)
		}
	})
	t.Run("search treats wildcards literally", func(t *testing.T) {
		list, _, _, _ := repo.ListMessagesPage(QueryFilter{OnlyPublic: true, Query: "100%"})
		if len(list) != 1 {
			t.Fatalf("'100%%' matched %d rows, want 1", len(list))
		}
		list, _, _, _ = repo.ListMessagesPage(QueryFilter{OnlyPublic: true, Query: "%"})
		if len(list) != 1 {
			t.Fatalf("a lone '%%' must only match literal percent signs, got %d rows", len(list))
		}
		list, _, _, _ = repo.ListMessagesPage(QueryFilter{OnlyPublic: true, Query: "sure_thing"})
		if len(list) != 1 {
			t.Fatalf("underscore search matched %d rows", len(list))
		}
	})
	t.Run("search also covers sender and channel title", func(t *testing.T) {
		list, _, _, _ := repo.ListMessagesPage(QueryFilter{OnlyPublic: true, Query: "chan"})
		if len(list) != 7 {
			t.Fatalf("title search matched %d rows", len(list))
		}
	})
	t.Run("media filters", func(t *testing.T) {
		photos, _, _, _ := repo.ListMessagesPage(QueryFilter{OnlyPublic: true, MediaType: "photo"})
		texts, _, _, _ := repo.ListMessagesPage(QueryFilter{OnlyPublic: true, MediaType: "text"})
		if len(photos) != 2 || len(texts) != 5 {
			t.Fatalf("photo=%d text=%d", len(photos), len(texts))
		}
	})
	t.Run("empty result is an empty slice", func(t *testing.T) {
		list, _, _, err := repo.ListMessagesPage(QueryFilter{Query: "no such text anywhere"})
		if err != nil || list == nil {
			t.Fatalf("got %#v, %v", list, err)
		}
	})
	t.Run("stats per chat", func(t *testing.T) {
		stats, err := repo.StatsByChat()
		if err != nil || stats[pub.ChatID].MessageCount != 7 || stats[priv.ChatID].MessageCount != 1 {
			t.Fatalf("stats = %+v, %v", stats, err)
		}
		if last := stats[pub.ChatID].LastMessageTime; last == nil || *last != "2026-10-28T00:15:00Z" {
			t.Fatalf("last message time = %v", last)
		}
	})
}

func TestSourceLifecycle(t *testing.T) {
	db := newTestDB(t)
	sources := NewSourceRepository(db)

	a := addSource(t, sources, -10, "Alpha", true, false)

	dup := *a
	dup.Name = "overwrite attempt"
	dup.PublicVisible = true
	if err := sources.CreateSource(&dup); !errors.Is(err, ErrConflict) {
		t.Fatalf("duplicate chat_id: %v", err)
	}
	sameURL := &model.Source{ChatID: -11, Name: "x", SourceURL: a.SourceURL, SourceType: "telegram_public", Adapter: "telegram_public", Enabled: true}
	if err := sources.CreateSource(sameURL); !errors.Is(err, ErrConflict) {
		t.Fatalf("duplicate url: %v", err)
	}
	got, _ := sources.GetSource(a.ChatID)
	if got.Name != "Alpha" || got.PublicVisible {
		t.Fatalf("a rejected create modified the existing row: %+v", got)
	}

	if ok, _ := sources.IsPubliclyVisible(a.ChatID); ok {
		t.Fatal("private source reported as public")
	}
	name := "Alpha 2"
	yes := true
	updated, err := sources.UpdateSource(a.ChatID, SourcePatch{Name: &name, PublicVisible: &yes})
	if err != nil || updated.Name != "Alpha 2" || !updated.PublicVisible || !updated.Enabled {
		t.Fatalf("UpdateSource = %+v, %v", updated, err)
	}
	if ok, _ := sources.IsPubliclyVisible(a.ChatID); !ok {
		t.Fatal("source should be public now")
	}
	no := false
	if _, err := sources.UpdateSource(a.ChatID, SourcePatch{Enabled: &no}); err != nil {
		t.Fatal(err)
	}
	if ok, _ := sources.IsPubliclyVisible(a.ChatID); ok {
		t.Fatal("a disabled source must not be public")
	}
	if _, err := sources.UpdateSource(-999, SourcePatch{Name: &name}); !errors.Is(err, ErrNotFound) {
		t.Fatalf("missing source: %v", err)
	}
	if missing, err := sources.GetSource(-999); err != nil || missing != nil {
		t.Fatalf("GetSource(missing) = %v, %v", missing, err)
	}
}

func TestSourceHealthAndAnomalies(t *testing.T) {
	db := newTestDB(t)
	sources := NewSourceRepository(db)
	src := addSource(t, sources, -20, "Health", true, true)
	rfc := func(d time.Duration) string { return time.Now().UTC().Add(d).Format(time.RFC3339) }

	if h := sources.GetSourceHealth(src.ChatID, 900); h.HealthStatus != "unknown" || h.LastRunAt != nil {
		t.Fatalf("no runs yet: %+v", h)
	}

	_ = sources.RecordSourceRun(src.ChatID, src.SourceURL, rfc(-time.Hour), rfc(-time.Hour), 20, 3, nil)
	if h := sources.GetSourceHealth(src.ChatID, 900); h.HealthStatus != "stale" || h.SavedCount != 3 {
		t.Fatalf("old success should be stale: %+v", h)
	}
	_ = sources.RecordSourceRun(src.ChatID, src.SourceURL, rfc(-time.Minute), rfc(-time.Minute), 20, 5, nil)
	if h := sources.GetSourceHealth(src.ChatID, 900); h.HealthStatus != "healthy" || h.LastSuccessAt == nil {
		t.Fatalf("recent success should be healthy: %+v", h)
	}

	long := strings.Repeat("e", 5000)
	_ = sources.RecordSourceRun(src.ChatID, src.SourceURL, rfc(-30*time.Second), rfc(-30*time.Second), 0, 0, &long)
	_ = sources.RecordSourceRun(src.ChatID, src.SourceURL, rfc(-10*time.Second), rfc(-10*time.Second), 0, 0, strPtr("boom"))
	h := sources.GetSourceHealth(src.ChatID, 900)
	if h.HealthStatus != "error" || h.LastError == nil || *h.LastError != "boom" {
		t.Fatalf("latest failure should win: %+v", h)
	}
	var stored string
	_ = db.QueryRow(`SELECT error FROM source_runs WHERE error LIKE 'eee%'`).Scan(&stored)
	if len(stored) != maxRunErrorLen {
		t.Fatalf("stored error length %d, want %d", len(stored), maxRunErrorLen)
	}

	failures, volume, err := sources.AnomalyStats(src.ChatID)
	if err != nil || failures != 2 || volume != 0 {
		t.Fatalf("AnomalyStats = %d, %d, %v", failures, volume, err)
	}

	public, err := sources.ListPublicSources(900)
	if err != nil || len(public) != 1 || public[0].HealthStatus != "error" {
		t.Fatalf("ListPublicSources = %+v, %v", public, err)
	}
}

func TestRunHistoryIsCapped(t *testing.T) {
	db := newTestDB(t)
	sources := NewSourceRepository(db)
	for i := 0; i < 230; i++ {
		ts := time.Unix(1_800_000_000+int64(i), 0).UTC().Format(time.RFC3339)
		if err := sources.RecordSourceRun(-1, "s", ts, ts, 1, 1, nil); err != nil {
			t.Fatal(err)
		}
	}
	var n int
	_ = db.QueryRow(`SELECT COUNT(*) FROM source_runs WHERE chat_id = -1`).Scan(&n)
	if n != 200 {
		t.Fatalf("kept %d runs, want 200", n)
	}
}

func TestVisitStatsRetentionAndTruncation(t *testing.T) {
	db := newTestDB(t)
	visits := NewVisitRepository(db)
	shanghai, err := time.LoadLocation("Asia/Shanghai")
	if err != nil {
		t.Skip("tzdata unavailable")
	}

	insert := func(at, ip string) {
		t.Helper()
		if _, err := db.Exec(`INSERT INTO site_visits (visited_at, ip, path, method, user_agent, referer) VALUES (?, ?, '/', 'GET', '', '')`, at, ip); err != nil {
			t.Fatal(err)
		}
	}
	now := time.Date(2026, 10, 28, 10, 0, 0, 0, time.UTC) // 18:00 in Shanghai
	insert("2026-10-27T15:59:59Z", "1.1.1.1")             // 23:59:59 yesterday, local
	insert("2026-10-27T16:00:00Z", "2.2.2.2")             // 00:00:00 today, local
	insert("2026-10-28T09:30:00.123456+00:00", "2.2.2.2") // Python-era format
	insert("2026-10-23T11:00:00Z", "4.4.4.4")             // 5 days ago
	insert("2026-10-20T09:00:00Z", "3.3.3.3")             // 8 days ago

	s, err := visits.GetStats(now, shanghai)
	if err != nil {
		t.Fatal(err)
	}
	want := model.SiteVisitStats{Total: 5, UniqueIPs: 4, Today: 2, TodayUnique: 1, Last24h: 3, Last7dUnique: 3}
	if s != want {
		t.Fatalf("stats = %+v\nwant   %+v", s, want)
	}

	if removed, err := visits.PruneVisits(now.AddDate(0, 0, -7)); err != nil || removed != 1 {
		t.Fatalf("PruneVisits removed %d, %v", removed, err)
	}

	huge := strings.Repeat("x", 100_000)
	if err := visits.RecordVisit(huge, "/"+huge, "GET"+huge, huge, huge); err != nil {
		t.Fatal(err)
	}
	list, err := visits.ListRecentVisits(1, 0)
	if err != nil || len(list) != 1 {
		t.Fatal(err, list)
	}
	v := list[0]
	if len(v.IP) > maxVisitIPLen || len(v.Path) > maxVisitPathLen || len(v.UserAgent) > maxVisitUALen ||
		len(v.Referer) > maxVisitRefererLen || len(v.Method) > maxVisitMethodLen {
		t.Fatalf("fields not truncated: ip=%d path=%d ua=%d ref=%d method=%d", len(v.IP), len(v.Path), len(v.UserAgent), len(v.Referer), len(v.Method))
	}
	if all, _ := visits.ListRecentVisits(100000, -5); len(all) == 0 || len(all) > 500 {
		t.Fatalf("limit/offset sanitising failed: %d rows", len(all))
	}
}

func TestVisitDailyTrend(t *testing.T) {
	db := newTestDB(t)
	visits := NewVisitRepository(db)
	shanghai, err := time.LoadLocation("Asia/Shanghai")
	if err != nil {
		t.Skip("tzdata unavailable")
	}
	insert := func(at, ip string) {
		t.Helper()
		if _, err := db.Exec(`INSERT INTO site_visits (visited_at, ip, path, method, user_agent, referer) VALUES (?, ?, '/', 'GET', '', '')`, at, ip); err != nil {
			t.Fatal(err)
		}
	}
	now := time.Date(2026, 10, 28, 10, 0, 0, 0, time.UTC) // 18:00 in Shanghai
	insert("2026-10-27T15:59:59Z", "1.1.1.1")             // 23:59:59 local 10-27
	insert("2026-10-27T16:00:00Z", "2.2.2.2")             // 00:00:00 local 10-28
	insert("2026-10-28T09:30:00.123456+00:00", "2.2.2.2") // 17:30 local 10-28, same IP
	insert("2026-10-23T11:00:00Z", "4.4.4.4")             // 19:00 local 10-23
	insert("2026-10-20T09:00:00Z", "3.3.3.3")             // 17:00 local 10-20, 8 days ago

	trend, err := visits.DailyTrend(now, shanghai, 7)
	if err != nil {
		t.Fatal(err)
	}
	if len(trend) != 7 {
		t.Fatalf("len(trend) = %d, want 7", len(trend))
	}
	if first := trend[0]; first.Date != "2026-10-22" || first.Count != 0 {
		t.Fatalf("earliest point = %+v, want 2026-10-22 with count 0", first)
	}
	if d23 := trend[1]; d23.Date != "2026-10-23" || d23.Count != 1 || d23.Unique != 1 {
		t.Fatalf("10-23 point = %+v, want count 1 unique 1", d23)
	}
	if d27 := trend[5]; d27.Date != "2026-10-27" || d27.Count != 1 {
		t.Fatalf("10-27 point = %+v, want count 1", d27)
	}
	if today := trend[6]; today.Date != "2026-10-28" || today.Count != 2 || today.Unique != 1 {
		t.Fatalf("today point = %+v, want 2026-10-28 count 2 unique 1", today)
	}
	// The visit from 8 days ago must fall outside the 7-day window.
	total := 0
	for _, p := range trend {
		total += p.Count
	}
	if total != 4 {
		t.Fatalf("total counted = %d, want 4 (the 10-20 visit is excluded)", total)
	}
}

func TestTruncateKeepsValidUTF8(t *testing.T) {
	s := strings.Repeat("频", 100) // 3 bytes per rune
	for n := 1; n < 20; n++ {
		out := truncate(s, n)
		if len(out) > n || !strings.HasPrefix(s, out) {
			t.Fatalf("truncate(%d) = %d bytes", n, len(out))
		}
		for _, r := range out {
			if r == '�' {
				t.Fatalf("truncate(%d) split a rune", n)
			}
		}
	}
}

func TestFeedbackRepository(t *testing.T) {
	db := newTestDB(t)
	repo := NewFeedbackRepository(db)

	f, err := repo.CreateFeedback("hello", strings.Repeat("9", 200))
	if err != nil || f.Status != "new" || len(f.IP) != maxFeedbackIPLen {
		t.Fatalf("CreateFeedback = %+v, %v", f, err)
	}
	updated, err := repo.UpdateFeedbackStatus(f.ID, "resolved")
	if err != nil || updated.Status != "resolved" {
		t.Fatalf("UpdateFeedbackStatus = %+v, %v", updated, err)
	}
	if _, err := repo.UpdateFeedbackStatus(f.ID, "weird"); err == nil {
		t.Error("invalid status accepted")
	}
	if _, err := repo.UpdateFeedbackStatus(12345, "new"); !errors.Is(err, ErrNotFound) {
		t.Errorf("missing feedback: %v", err)
	}
	list, err := repo.ListFeedback(10)
	if err != nil || len(list) != 1 {
		t.Fatalf("ListFeedback = %+v, %v", list, err)
	}
}

func TestSeedSourcesFromGroups(t *testing.T) {
	db := newTestDB(t)
	sources := NewSourceRepository(db)
	botID := int64(-1001234567890)
	groups := []config.Group{
		{Source: "https://t.me/zaihuapd", Name: "zaihuapd", SourceType: "telegram_public"},
		{Source: "https://t.me/s/tnews365", Name: "竹新社", SourceType: "telegram_public"},
		{Source: "https://t.me/zaihuapd", Name: "duplicate", SourceType: "telegram_public"},
		{Source: "https://evil.example/x", Name: "evil", SourceType: "telegram_public"},
		{ChatID: &botID, Name: "bot group", SourceType: "telegram_bot"},
	}
	created, skipped, err := SeedSourcesFromGroups(sources, groups)
	if err != nil || created != 2 || len(skipped) != 3 {
		t.Fatalf("seed = %d created, skipped=%v, err=%v", created, skipped, err)
	}
	list, _ := sources.ListSources()
	for _, s := range list {
		if !s.PublicVisible || !s.Enabled || s.Adapter != "telegram_public" || !strings.HasPrefix(s.SourceURL, "https://t.me/") {
			t.Errorf("seeded source looks wrong: %+v", s)
		}
	}
	// Seeding is one-shot: a populated table is left alone.
	if created, _, err := SeedSourcesFromGroups(sources, groups); err != nil || created != 0 {
		t.Fatalf("second seed created %d, %v", created, err)
	}
}

func TestInitDBUpgradesLegacySchema(t *testing.T) {
	path := filepath.Join(t.TempDir(), "legacy.db")
	legacy, err := sql.Open("sqlite", path)
	if err != nil {
		t.Fatal(err)
	}
	// The schema an early Python release created: no adapter / locator /
	// content_version columns yet.
	_, err = legacy.Exec(`
		CREATE TABLE sources (
			chat_id INTEGER PRIMARY KEY, name TEXT NOT NULL, source_url TEXT NOT NULL UNIQUE,
			source_type TEXT NOT NULL DEFAULT 'telegram_public', enabled INTEGER NOT NULL DEFAULT 1,
			public_visible INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
		CREATE TABLE messages (
			id INTEGER PRIMARY KEY AUTOINCREMENT, chat_id INTEGER NOT NULL, chat_title TEXT NOT NULL DEFAULT '',
			message_id INTEGER NOT NULL, sender_name TEXT NOT NULL DEFAULT '', message_time TEXT NOT NULL,
			content TEXT NOT NULL DEFAULT '', media_type TEXT, raw_json TEXT NOT NULL,
			created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, forwarded_at TEXT, UNIQUE(chat_id, message_id));
		INSERT INTO sources VALUES (-5, 'Old', 'https://t.me/old', 'telegram_public', 1, 1, '2026-01-01T00:00:00+00:00', '2026-01-01T00:00:00+00:00');
		INSERT INTO messages (chat_id, message_id, message_time, content, raw_json)
			VALUES (-5, 1, '2026-01-01T00:00:00+00:00', 'legacy text', '{"media_urls":["https://cdn1.telesco.pe/a.jpg"]}');`)
	if err != nil {
		t.Fatal(err)
	}
	_ = legacy.Close()

	db, err := InitDB(path)
	if err != nil {
		t.Fatalf("InitDB on legacy database: %v", err)
	}
	defer db.Close()

	src, err := NewSourceRepository(db).GetSource(-5)
	if err != nil || src == nil || src.Adapter != "telegram_public" || src.Locator != "https://t.me/old" {
		t.Fatalf("legacy source not upgraded: %+v, %v", src, err)
	}
	msgs := NewMessageRepository(db)
	m, err := msgs.GetMessageByID(1)
	if err != nil || m == nil || m.ContentVersion != 1 {
		t.Fatalf("legacy message unreadable: %+v, %v", m, err)
	}
	// Re-running the migration is harmless.
	if err := migrateLegacy(db); err != nil {
		t.Fatalf("second migration: %v", err)
	}
	// And the upgraded table accepts the new upsert.
	res, err := msgs.SaveMessage(newMessage(-5, 1, "legacy text", nil, "2026-01-01T00:00:00+00:00"))
	if err != nil || res.Inserted {
		t.Fatalf("upsert on legacy row: %+v, %v", res, err)
	}
}

func TestCursorRoundTrip(t *testing.T) {
	c := EncodeCursor("2026-10-28T00:00:00Z", 42)
	ts, id, err := DecodeCursor(c)
	if err != nil || ts != "2026-10-28T00:00:00Z" || id != 42 {
		t.Fatalf("round trip: %q %d %v", ts, id, err)
	}
	if _, _, err := DecodeCursor(c + "="); err != nil {
		t.Errorf("padded cursor should still decode: %v", err)
	}
	if _, _, err := DecodeCursor("!!!not-base64!!!"); err == nil {
		t.Error("garbage cursor accepted")
	}
}
