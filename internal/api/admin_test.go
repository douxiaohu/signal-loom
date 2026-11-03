package api

import (
	"fmt"
	"net/http"
	"strings"
	"testing"
	"time"

	"telegram-radar/internal/config"
	"telegram-radar/internal/model"
	"telegram-radar/internal/scheduler"
)

// ---- sources ------------------------------------------------------------------------

func TestAdminSourceListCarriesStatsHealthAndNoServerPaths(t *testing.T) {
	h := newHarness(t)
	cookie := h.login()

	empty := h.do("GET", "/api/admin/sources", nil, withCookie(cookie))
	expectStatus(t, empty, 200)
	if got := items(t, empty); len(got) != 0 {
		t.Fatalf("expected [] on an empty table, got %v", got)
	}

	src := h.addSource(-1, "Pub", true, true)
	h.addSource(-2, "Quiet", true, false)
	h.addMessage(src.ChatID, 1, "one", nil, "", "2026-10-28T00:01:00+00:00")
	h.addMessage(src.ChatID, 2, "two", nil, "", "2026-10-28T00:02:00+00:00")
	failed := "open /app/data/telegram_forwarder.db: unable to open; see https://t.me/s/pub"
	if err := h.sources.RecordSourceRun(src.ChatID, src.SourceURL, "2026-10-28T00:00:00Z", "2026-10-28T00:00:01Z", 0, 0, &failed); err != nil {
		t.Fatal(err)
	}

	rec := h.do("GET", "/api/admin/sources", nil, withCookie(cookie))
	expectStatus(t, rec, 200)
	var pub map[string]any
	for _, it := range items(t, rec) {
		if m := it.(map[string]any); m["chat_id"] == float64(-1) {
			pub = m
		}
	}
	if pub == nil {
		t.Fatalf("source missing: %s", rec.Body.String())
	}
	for _, key := range []string{"chat_id", "name", "source_url", "source_type", "adapter", "enabled", "public_visible",
		"health_status", "last_run_at", "last_success_at", "last_error", "fetched_count", "saved_count",
		"message_count", "last_message_time", "created_at", "updated_at"} {
		if _, ok := pub[key]; !ok {
			t.Errorf("source JSON lacks %q (the UI reads it)", key)
		}
	}
	if pub["message_count"] != float64(2) || pub["last_message_time"] != "2026-10-28T00:02:00+00:00" {
		t.Errorf("stats: count=%v last=%v (the admin UI showed 0 for every source before)", pub["message_count"], pub["last_message_time"])
	}
	if pub["health_status"] != "error" {
		t.Errorf("health = %v", pub["health_status"])
	}
	lastErr, _ := pub["last_error"].(string)
	if strings.Contains(lastErr, "/app/data") || !strings.Contains(lastErr, "https://t.me/s/pub") {
		t.Errorf("last_error should hide server paths but keep URLs: %q", lastErr)
	}
}

func TestAdminCreateSource(t *testing.T) {
	h := newHarness(t)
	cookie := h.login()
	create := func(body any, opts ...reqOpt) *httpRecorder {
		return h.do("POST", "/api/admin/sources", body, append([]reqOpt{withCookie(cookie)}, opts...)...)
	}

	rec := create(map[string]string{"name": "News", "source_url": "https://t.me/s/NewsChannel"})
	expectStatus(t, rec, 201)
	body := decodeMap(t, rec)
	if body["source_url"] != "https://t.me/NewsChannel" || body["public_visible"] != false || body["enabled"] != true ||
		body["adapter"] != "telegram_public" || body["name"] != "News" {
		t.Fatalf("created source = %v", body)
	}
	if want := float64(config.PublicSourceChatID("newschannel")); body["chat_id"] != want {
		t.Fatalf("chat_id = %v, want %v", body["chat_id"], want)
	}
	if calls := h.crawls.asyncCalls(); len(calls) != 1 || calls[0].SourceURL != "https://t.me/NewsChannel" {
		t.Fatalf("the first crawl was not triggered: %+v", calls)
	}

	// Publishing the source, then adding it again, must not undo anything.
	chatID := int64(body["chat_id"].(float64))
	expectStatus(t, h.do("PATCH", fmt.Sprintf("/api/admin/sources/%d", chatID), map[string]any{"public_visible": true, "name": "Renamed"}, withCookie(cookie)), 200)
	for _, again := range []string{"https://t.me/NewsChannel", "https://t.me/newschannel", "@NEWSCHANNEL", "newschannel"} {
		dup := create(map[string]string{"name": "Overwrite!", "source_url": again})
		if dup.Code != 409 {
			t.Errorf("re-adding %q = %d, want 409", again, dup.Code)
		}
	}
	got, _ := h.sources.GetSource(chatID)
	if got == nil || !got.PublicVisible || !got.Enabled || got.Name != "Renamed" {
		t.Fatalf("a duplicate create changed the stored source: %+v", got)
	}
	if len(h.crawls.asyncCalls()) != 1 {
		t.Fatal("a rejected duplicate triggered a crawl")
	}

	invalid := map[string]any{
		"foreign host":     map[string]string{"name": "x", "source_url": "https://evil.example/channel"},
		"internal address": map[string]string{"name": "x", "source_url": "http://127.0.0.1:8000/admin"},
		"script url":       map[string]string{"name": "x", "source_url": "javascript:alert(1)"},
		"path traversal":   map[string]string{"name": "x", "source_url": "https://t.me/../../etc/passwd"},
		"empty url":        map[string]string{"name": "x", "source_url": ""},
		"url too long":     map[string]string{"name": "x", "source_url": "https://t.me/" + strings.Repeat("a", 300)},
		"name too long":    map[string]string{"name": strings.Repeat("n", 81), "source_url": "https://t.me/ok_channel"},
		"other adapter":    map[string]string{"name": "x", "source_url": "https://t.me/ok_channel", "adapter": "telegram_bot"},
	}
	for name, payload := range invalid {
		if rec := create(payload); rec.Code != 422 {
			t.Errorf("%s: status %d, want 422 (%s)", name, rec.Code, truncateForLog(rec.Body.String()))
		}
	}
	expectStatus(t, create(map[string]string{"name": "x", "source_url": "https://t.me/ok_channel"}, withoutHeader("Origin")), 403)
	expectStatus(t, create(`{"source_url":"https://t.me/ok_channel"}`, withHeader("Content-Type", "text/plain")), 415)
	expectStatus(t, create(`{"name":"`+strings.Repeat("a", 70<<10)+`"}`), 413)

	// A missing name falls back to the channel's username.
	rec = create(map[string]string{"source_url": "https://t.me/unnamed_one"})
	expectStatus(t, rec, 201)
	if decodeMap(t, rec)["name"] != "unnamed_one" {
		t.Fatalf("default name: %s", rec.Body.String())
	}
}

func TestAdminPatchSource(t *testing.T) {
	h := newHarness(t)
	cookie := h.login()
	src := h.addSource(-7, "Orig", true, true)
	path := fmt.Sprintf("/api/admin/sources/%d", src.ChatID)
	patch := func(body any, p string, opts ...reqOpt) *httpRecorder {
		return h.do("PATCH", p, body, append([]reqOpt{withCookie(cookie)}, opts...)...)
	}

	rec := patch(map[string]any{"enabled": false}, path)
	expectStatus(t, rec, 200)
	body := decodeMap(t, rec)
	if body["enabled"] != false || body["public_visible"] != true || body["name"] != "Orig" {
		t.Fatalf("a partial update changed other fields: %v", body)
	}
	rec = patch(map[string]any{"name": "  Renamed  ", "unknown_field": 1}, path)
	expectStatus(t, rec, 200)
	if decodeMap(t, rec)["name"] != "Renamed" {
		t.Fatalf("name not trimmed: %s", rec.Body.String())
	}

	expectStatus(t, patch(map[string]any{"name": ""}, path), 422)
	expectStatus(t, patch(map[string]any{"name": "   "}, path), 422)
	expectStatus(t, patch(map[string]any{"name": strings.Repeat("n", 81)}, path), 422)
	expectStatus(t, patch(map[string]any{"enabled": "yes"}, path), 422)
	expectStatus(t, patch(map[string]any{"enabled": true}, "/api/admin/sources/-424242"), 404)
	expectStatus(t, patch(map[string]any{"enabled": true}, "/api/admin/sources/abc"), 400)
	expectStatus(t, patch(map[string]any{"enabled": true}, path, withoutHeader("Origin")), 403)
	if s, _ := h.sources.GetSource(src.ChatID); s.Name != "Renamed" || s.Enabled {
		t.Fatalf("rejected patches modified the source: %+v", s)
	}
}

func TestAdminCrawlNowRunsSynchronouslyAndReportsTheResult(t *testing.T) {
	h := newHarness(t)
	cookie := h.login()
	src := h.addSource(-1, "Pub", true, true)
	off := h.addSource(-2, "Off", false, false)

	rec := h.do("POST", fmt.Sprintf("/api/admin/sources/%d/crawl-now", src.ChatID), nil, withCookie(cookie))
	expectStatus(t, rec, 200)
	body := decodeMap(t, rec)
	if fmt.Sprint(keysOf(body)) != "[chat_id error fetched saved source]" || body["fetched"] != float64(20) || body["saved"] != float64(2) {
		t.Fatalf("crawl result = %v", body)
	}
	if len(h.crawls.crawled) != 1 || len(h.crawls.asyncCalls()) != 0 {
		t.Fatalf("crawl-now must wait for the crawl (sync=%d async=%d)", len(h.crawls.crawled), len(h.crawls.asyncCalls()))
	}

	failure := "status 502 from https://t.me/s/pub"
	h.crawls.result = func(s model.Source) scheduler.CrawlResult {
		return scheduler.CrawlResult{Source: s.SourceURL, ChatID: s.ChatID, Error: &failure}
	}
	rec = h.do("POST", fmt.Sprintf("/api/admin/sources/%d/crawl-now", src.ChatID), nil, withCookie(cookie))
	expectStatus(t, rec, 200)
	if decodeMap(t, rec)["error"] != failure {
		t.Fatalf("a failed crawl should still report its error: %s", rec.Body.String())
	}

	expectStatus(t, h.do("POST", fmt.Sprintf("/api/admin/sources/%d/crawl-now", off.ChatID), nil, withCookie(cookie)), 404)
	expectStatus(t, h.do("POST", "/api/admin/sources/-999/crawl-now", nil, withCookie(cookie)), 404)
	expectStatus(t, h.do("POST", "/api/admin/sources/abc/crawl-now", nil, withCookie(cookie)), 400)
	expectStatus(t, h.do("POST", fmt.Sprintf("/api/admin/sources/%d/crawl-now", src.ChatID), nil, withCookie(cookie), withoutHeader("Origin")), 403)
}

// ---- messages ----------------------------------------------------------------------

func TestAdminMessageListing(t *testing.T) {
	h := newHarness(t)
	cookie := h.login()
	priv := h.addSource(-2, "Priv", true, false)
	for i := int64(1); i <= 210; i++ {
		h.addMessage(priv.ChatID, i, fmt.Sprintf("secret %d", i), nil, "", fmt.Sprintf("2026-10-28T%02d:%02d:00+00:00", i/60, i%60))
	}

	rec := h.do("GET", "/api/admin/messages", nil, withCookie(cookie))
	expectStatus(t, rec, 200)
	if got := len(items(t, rec)); got != 30 {
		t.Fatalf("default page = %d, want 30", got)
	}
	for limit, want := range map[string]int{"200": 200, "5000": 200, "1": 1, "0": 1} {
		if got := len(items(t, h.do("GET", "/api/admin/messages?limit="+limit, nil, withCookie(cookie)))); got != want {
			t.Errorf("limit=%s returned %d, want %d", limit, got, want)
		}
	}
	for _, bad := range []string{"limit=abc", "chat_id=abc", "media=zip", "query=" + strings.Repeat("q", 201)} {
		expectStatus(t, h.do("GET", "/api/admin/messages?"+bad, nil, withCookie(cookie)), 400)
	}
	// Admins see hidden sources; chat_id=all means no filter.
	expectStatus(t, h.do("GET", "/api/admin/messages?chat_id=all&media=text", nil, withCookie(cookie)), 200)
	filtered := h.do("GET", fmt.Sprintf("/api/admin/messages?chat_id=%d&query=secret%%20209", priv.ChatID), nil, withCookie(cookie))
	if got := items(t, filtered); len(got) != 1 {
		t.Fatalf("filtered = %d rows", len(got))
	}
}

// ---- alert rules -------------------------------------------------------------------

func TestAlertRulesCreatePatchAndTheToggleRegression(t *testing.T) {
	h := newHarness(t)
	cookie := h.login()
	post := func(body any, opts ...reqOpt) *httpRecorder {
		return h.do("POST", "/api/admin/rules", body, append([]reqOpt{withCookie(cookie)}, opts...)...)
	}
	patch := func(id float64, body any, opts ...reqOpt) *httpRecorder {
		return h.do("PATCH", fmt.Sprintf("/api/admin/rules/%d", int(id)), body, append([]reqOpt{withCookie(cookie)}, opts...)...)
	}

	empty := h.do("GET", "/api/admin/rules", nil, withCookie(cookie))
	if got := items(t, empty); len(got) != 0 {
		t.Fatal("rules should be [] on a fresh database")
	}

	rec := post(map[string]any{
		"id": 999, "created_at": "1999", // not the client's to choose
		"name": "  Bitcoin watch ", "keyword": " bitcoin ", "media_type": "photo",
		"quiet_start": "22:00", "quiet_end": "07:00", "cooldown_minutes": 30,
		"enabled": false, "source_ids": []int{-1, -2},
	})
	expectStatus(t, rec, 201)
	created := decodeMap(t, rec)
	id := created["id"].(float64)
	if id == 999 || created["created_at"] == "1999" || created["name"] != "Bitcoin watch" || created["keyword"] != "bitcoin" {
		t.Fatalf("created = %v", created)
	}

	// What the UI's switch sends. Before the fix this erased the rule.
	rec = patch(id, map[string]any{"enabled": true})
	expectStatus(t, rec, 200)
	toggled := decodeMap(t, rec)
	if toggled["enabled"] != true || toggled["name"] != "Bitcoin watch" || toggled["keyword"] != "bitcoin" ||
		toggled["media_type"] != "photo" || toggled["quiet_start"] != "22:00" || toggled["cooldown_minutes"] != float64(30) ||
		fmt.Sprint(toggled["source_ids"]) != "[-2 -1]" {
		t.Fatalf("toggling the rule damaged it: %v", toggled)
	}
	listed := items(t, h.do("GET", "/api/admin/rules", nil, withCookie(cookie)))
	if len(listed) != 1 || listed[0].(map[string]any)["keyword"] != "bitcoin" || listed[0].(map[string]any)["enabled"] != true {
		t.Fatalf("stored rule: %v", listed)
	}

	// Explicit null clears optional fields; absent fields stay.
	rec = patch(id, map[string]any{"media_type": nil, "quiet_start": nil, "quiet_end": nil, "source_ids": []int{}})
	expectStatus(t, rec, 200)
	cleared := decodeMap(t, rec)
	if cleared["media_type"] != nil || cleared["quiet_start"] != nil || cleared["quiet_end"] != nil ||
		fmt.Sprint(cleared["source_ids"]) != "[]" || cleared["name"] != "Bitcoin watch" || cleared["cooldown_minutes"] != float64(30) {
		t.Fatalf("clearing fields: %v", cleared)
	}
	if renamed := decodeMap(t, patch(id, map[string]any{"name": "Renamed", "cooldown_minutes": 0})); renamed["name"] != "Renamed" || renamed["cooldown_minutes"] != float64(0) {
		t.Fatalf("rename: %v", renamed)
	}

	// Rejected patches change nothing.
	for name, body := range map[string]any{
		"empty name":       map[string]any{"name": ""},
		"null name":        map[string]any{"name": nil},
		"blank keyword":    map[string]any{"keyword": "   "},
		"null keyword":     map[string]any{"keyword": nil},
		"null enabled":     map[string]any{"enabled": nil},
		"enabled string":   map[string]any{"enabled": "true"},
		"bad clock":        map[string]any{"quiet_start": "25:00", "quiet_end": "07:00"},
		"clock format":     map[string]any{"quiet_start": "9:00", "quiet_end": "10:00"},
		"half quiet":       map[string]any{"quiet_start": "22:00"},
		"cooldown too big": map[string]any{"cooldown_minutes": 1441},
		"negative":         map[string]any{"cooldown_minutes": -1},
		"bad media type":   map[string]any{"media_type": "all"},
		"101 sources":      map[string]any{"source_ids": make([]int, 101)},
		"name too long":    map[string]any{"name": strings.Repeat("n", 81)},
		"keyword too long": map[string]any{"keyword": strings.Repeat("k", 201)},
	} {
		if rec := patch(id, body); rec.Code != 422 {
			t.Errorf("%s: status %d, want 422 (%s)", name, rec.Code, truncateForLog(rec.Body.String()))
		}
	}
	after := items(t, h.do("GET", "/api/admin/rules", nil, withCookie(cookie)))[0].(map[string]any)
	if after["name"] != "Renamed" || after["keyword"] != "bitcoin" || after["enabled"] != true {
		t.Fatalf("rejected patches modified the rule: %v", after)
	}

	expectStatus(t, patch(424242, map[string]any{"enabled": true}), 404)
	expectStatus(t, h.do("PATCH", "/api/admin/rules/abc", map[string]any{}, withCookie(cookie)), 400)
	expectStatus(t, patch(id, map[string]any{"enabled": true}, withoutHeader("Origin")), 403)
}

func TestAlertRuleCreationValidation(t *testing.T) {
	h := newHarness(t)
	cookie := h.login()
	good := func() map[string]any { return map[string]any{"name": "n", "keyword": "k"} }
	mutate := func(k string, v any) map[string]any { m := good(); m[k] = v; return m }

	for name, body := range map[string]map[string]any{
		"missing keyword (would match everything)": {"name": "n"},
		"blank keyword":    mutate("keyword", "  "),
		"missing name":     {"keyword": "k"},
		"media all":        mutate("media_type", "all"),
		"media junk":       mutate("media_type", "exe"),
		"half quiet hours": mutate("quiet_end", "07:00"),
		"bad clock":        {"name": "n", "keyword": "k", "quiet_start": "24:00", "quiet_end": "07:00"},
		"cooldown":         mutate("cooldown_minutes", 5000),
		"too many sources": mutate("source_ids", make([]int, 101)),
		"keyword type":     mutate("keyword", 5),
	} {
		if rec := h.do("POST", "/api/admin/rules", body, withCookie(cookie)); rec.Code != 422 {
			t.Errorf("%s: status %d, want 422 (%s)", name, rec.Code, truncateForLog(rec.Body.String()))
		}
	}
	// New rules start disabled unless asked otherwise (the UI relies on it).
	rec := h.do("POST", "/api/admin/rules", good(), withCookie(cookie))
	expectStatus(t, rec, 201)
	if decodeMap(t, rec)["enabled"] != false {
		t.Fatalf("a new rule must start disabled: %s", rec.Body.String())
	}
}

// ---- alert matches ------------------------------------------------------------------

func TestAlertMatchesEndToEnd(t *testing.T) {
	h := newHarness(t)
	cookie := h.login()

	none := h.do("GET", "/api/admin/matches", nil, withCookie(cookie))
	expectStatus(t, none, 200)
	if got := items(t, none); len(got) != 0 {
		t.Fatal("matches must be [] when there are none (the UI calls .filter on it)")
	}

	src := h.addSource(-1, "Pub", true, true)
	rec := h.do("POST", "/api/admin/rules", map[string]any{"name": "btc", "keyword": "bitcoin", "enabled": true}, withCookie(cookie))
	expectStatus(t, rec, 201)
	id := h.addMessage(src.ChatID, 1, "Bitcoin is up", nil, "", "")
	msg, _ := h.messages.GetMessageByID(id)
	if n, err := h.alerts.MatchAndRecord(msg); err != nil || n != 1 {
		t.Fatalf("MatchAndRecord = %d, %v", n, err)
	}

	list := items(t, h.do("GET", "/api/admin/matches", nil, withCookie(cookie)))
	if len(list) != 1 {
		t.Fatalf("matches = %v", list)
	}
	m := list[0].(map[string]any)
	matchPath := fmt.Sprintf("/api/admin/matches/%d", int(m["id"].(float64)))
	if m["rule_name"] != "btc" || m["content"] != "Bitcoin is up" || m["status"] != "new" {
		t.Fatalf("match = %v", m)
	}

	if rec := h.do("POST", matchPath+"/acknowledge", nil, withCookie(cookie)); rec.Code != 200 || decodeMap(t, rec)["status"] != "acknowledged" {
		t.Fatalf("acknowledge: %d %s", rec.Code, rec.Body.String())
	}
	if got := items(t, h.do("GET", "/api/admin/matches?status=new", nil, withCookie(cookie))); len(got) != 0 {
		t.Fatalf("status filter: %v", got)
	}
	if got := items(t, h.do("GET", "/api/admin/matches?status=acknowledged", nil, withCookie(cookie))); len(got) != 1 {
		t.Fatalf("status filter: %v", got)
	}
	if rec := h.do("POST", matchPath+"/resolve", nil, withCookie(cookie)); rec.Code != 200 || decodeMap(t, rec)["status"] != "resolved" {
		t.Fatalf("resolve: %d %s", rec.Code, rec.Body.String())
	}

	expectStatus(t, h.do("GET", "/api/admin/matches?status=bogus", nil, withCookie(cookie)), 400)
	expectStatus(t, h.do("POST", "/api/admin/matches/9999/resolve", nil, withCookie(cookie)), 404)
	expectStatus(t, h.do("POST", "/api/admin/matches/abc/resolve", nil, withCookie(cookie)), 400)
	expectStatus(t, h.do("POST", matchPath+"/resolve", nil, withCookie(cookie), withoutHeader("Origin")), 403)
}

// ---- the contract with the frontend --------------------------------------------------

func TestOverviewMatchesTheFrontendContract(t *testing.T) {
	h := newHarness(t)
	cookie := h.login()
	healthy := h.addSource(-1, "Healthy", true, true)
	broken := h.addSource(-2, "Broken", true, false)
	h.addSource(-3, "Idle", false, false)
	now := time.Now().UTC().Format(time.RFC3339)
	_ = h.sources.RecordSourceRun(healthy.ChatID, healthy.SourceURL, now, now, 20, 3, nil)
	oops := "status 502"
	_ = h.sources.RecordSourceRun(broken.ChatID, broken.SourceURL, now, now, 0, 0, &oops)
	h.addMessage(healthy.ChatID, 1, "hello", nil, "", "")
	_ = h.visits.RecordVisit("203.0.113.5", "/", "GET", "UA", "")
	_ = h.visits.RecordVisit("203.0.113.6", "/", "GET", "UA", "")
	_ = h.visits.RecordVisit("203.0.113.5", "/", "GET", "UA", "")

	rec := h.do("GET", "/api/admin/overview", nil, withCookie(cookie))
	expectStatus(t, rec, 200)
	body := decodeMap(t, rec)

	// frontend/src/types.ts: AdminOverview = { visits, sources, alerts }
	if got := fmt.Sprint(keysOf(body)); got != "[alerts sources visits]" {
		t.Fatalf("top-level keys = %s", got)
	}
	visits := body["visits"].(map[string]any)
	if got := fmt.Sprint(keysOf(visits)); got != "[last_24h last_7d_unique today today_unique total trend unique_ips]" {
		t.Fatalf("visits keys = %s (VisitStats in types.ts)", got)
	}
	if visits["total"] != float64(3) || visits["unique_ips"] != float64(2) || visits["today"] != float64(3) || visits["today_unique"] != float64(2) {
		t.Fatalf("visit numbers: %v", visits)
	}
	trend, ok := visits["trend"].([]any)
	if !ok || len(trend) != 7 {
		t.Fatalf("visits.trend = %v (one point per recent day, for the frontend chart)", visits["trend"])
	}
	today := trend[len(trend)-1].(map[string]any)
	if got := fmt.Sprint(keysOf(today)); got != "[count date unique]" {
		t.Fatalf("trend point keys = %s (VisitTrendPoint in types.ts)", got)
	}
	if today["count"] != float64(3) || today["unique"] != float64(2) {
		t.Fatalf("today trend point = %v (3 visits, 2 IPs recorded above)", today)
	}
	sources := body["sources"].(map[string]any)
	if got := fmt.Sprint(keysOf(sources)); got != "[enabled items public total unhealthy]" {
		t.Fatalf("sources keys = %s", got)
	}
	if sources["total"] != float64(3) || sources["enabled"] != float64(2) || sources["public"] != float64(1) || sources["unhealthy"] != float64(2) {
		t.Fatalf("source counts: %v (unhealthy = error + never-run, as in Python)", sources)
	}
	if list, ok := sources["items"].([]any); !ok || len(list) != 3 {
		t.Fatalf("sources.items = %v", sources["items"])
	}
	alerts := body["alerts"].(map[string]any)
	for _, key := range []string{"new_count", "pending_count", "acknowledged_count", "resolved_count", "rule_count", "enabled_rule_count"} {
		if _, ok := alerts[key].(float64); !ok {
			t.Errorf("alerts.%s missing or not a number: %v", key, alerts)
		}
	}
}

func TestVisitsEndpointContract(t *testing.T) {
	h := newHarness(t)
	cookie := h.login()
	for i := 0; i < 5; i++ {
		_ = h.visits.RecordVisit(fmt.Sprintf("203.0.113.%d", i), "/", "GET", "UA", "")
	}
	rec := h.do("GET", "/api/admin/visits?limit=2&offset=1", nil, withCookie(cookie))
	expectStatus(t, rec, 200)
	body := decodeMap(t, rec)
	if len(body["items"].([]any)) != 2 {
		t.Fatalf("items = %v", body["items"])
	}
	if got := fmt.Sprint(keysOf(body["stats"].(map[string]any))); got != "[last_24h last_7d_unique today today_unique total unique_ips]" {
		t.Fatalf("stats keys = %s", got)
	}
	first := body["items"].([]any)[0].(map[string]any)
	if got := fmt.Sprint(keysOf(first)); got != "[id ip method path referer user_agent visited_at]" {
		t.Fatalf("visit keys = %s (VisitRecord in types.ts)", got)
	}
	for q, want := range map[string]int{"limit=100000": 5, "limit=1": 1, "offset=100000": 0, "offset=-3": 5} {
		if got := len(items(t, h.do("GET", "/api/admin/visits?"+q, nil, withCookie(cookie)))); got != want {
			t.Errorf("%s -> %d items, want %d", q, got, want)
		}
	}
	expectStatus(t, h.do("GET", "/api/admin/visits?limit=abc", nil, withCookie(cookie)), 400)
	expectStatus(t, h.do("GET", "/api/admin/visits?offset=x", nil, withCookie(cookie)), 400)
}

func TestOperationsSummaryContract(t *testing.T) {
	h := newHarness(t)
	cookie := h.login()
	flaky := h.addSource(-1, "Flaky", true, true)
	quiet := h.addSource(-2, "Quiet", true, true)
	fine := h.addSource(-3, "Fine", true, false)
	ts := func(n int) string { return time.Now().UTC().Add(time.Duration(-n) * time.Minute).Format(time.RFC3339) }
	boom := "status 502"
	_ = h.sources.RecordSourceRun(flaky.ChatID, "s", ts(5), ts(5), 20, 4, nil)
	_ = h.sources.RecordSourceRun(flaky.ChatID, "s", ts(3), ts(3), 0, 0, &boom)
	_ = h.sources.RecordSourceRun(flaky.ChatID, "s", ts(1), ts(1), 0, 0, &boom)
	_ = h.sources.RecordSourceRun(quiet.ChatID, "s", ts(1), ts(1), 20, 0, nil)
	_ = h.sources.RecordSourceRun(fine.ChatID, "s", ts(1), ts(1), 20, 7, nil)

	rec := h.do("GET", "/api/admin/operations/summary", nil, withCookie(cookie))
	expectStatus(t, rec, 200)
	body := decodeMap(t, rec)
	if got := fmt.Sprint(keysOf(body)); got != "[generated_at public_source_count source_count sources unhealthy_sources]" {
		t.Fatalf("keys = %s", got)
	}
	if body["source_count"] != float64(3) || body["public_source_count"] != float64(2) {
		t.Fatalf("counts: %v", body)
	}
	byName := map[string]map[string]any{}
	for _, s := range body["sources"].([]any) {
		m := s.(map[string]any)
		byName[m["name"].(string)] = m // "name" is what the operations table renders
	}
	if byName["Flaky"]["consecutive_failures"] != float64(2) || byName["Fine"]["new_message_volume"] != float64(7) ||
		byName["Quiet"]["new_message_volume"] != float64(0) || byName["Flaky"]["health_status"] != "error" {
		t.Fatalf("per-source stats: %v", byName)
	}
	if un := body["unhealthy_sources"].([]any); len(un) != 1 || un[0].(map[string]any)["name"] != "Flaky" {
		t.Fatalf("unhealthy = %v", un)
	}

	failures := decodeMap(t, h.do("GET", "/api/admin/operations/summary?anomaly=failures", nil, withCookie(cookie)))
	if list := failures["sources"].([]any); len(list) != 1 || list[0].(map[string]any)["name"] != "Flaky" {
		t.Fatalf("anomaly=failures: %v", list)
	}
	volume := decodeMap(t, h.do("GET", "/api/admin/operations/summary?anomaly=volume", nil, withCookie(cookie)))
	if list := volume["sources"].([]any); len(list) != 2 { // Flaky's last run saved 0 as well
		t.Fatalf("anomaly=volume: %v", list)
	}
	expectStatus(t, h.do("GET", "/api/admin/operations/summary?anomaly=bogus", nil, withCookie(cookie)), 400)

	empty := newHarness(t)
	rec = empty.do("GET", "/api/admin/operations/summary", nil, withCookie(empty.login()))
	body = decodeMap(t, rec)
	if list, ok := body["sources"].([]any); !ok || len(list) != 0 {
		t.Fatalf("empty summary must use [] not null: %s", rec.Body.String())
	}
}

// ---- cross-cutting -------------------------------------------------------------------

func TestSecurityHeadersAreOnEveryKindOfResponse(t *testing.T) {
	h := newHarness(t)
	cookie := h.login()
	responses := map[string]*httpRecorder{
		"200 public":    h.do("GET", "/api/public/sources", nil),
		"401 admin":     h.do("GET", "/api/admin/sources", nil),
		"200 admin":     h.do("GET", "/api/admin/sources", nil, withCookie(cookie)),
		"404 unknown":   h.do("GET", "/api/nope", nil),
		"405 wrong":     h.do("DELETE", "/api/public/sources", nil),
		"403 origin":    h.do("POST", "/api/auth/login", nil, withHeader("Origin", "https://evil.example")),
		"429 throttled": nil,
	}
	for i := 0; i < 6; i++ {
		responses["429 throttled"] = h.do("POST", "/api/auth/login", map[string]string{"api_key": "x"}, withPeer("198.51.100.77:1"))
	}
	for name, rec := range responses {
		hdr := rec.Header()
		csp := hdr.Get("Content-Security-Policy")
		if !strings.Contains(csp, "default-src 'self'") || strings.Contains(csp, "https:") ||
			hdr.Get("X-Content-Type-Options") != "nosniff" || hdr.Get("X-Frame-Options") != "DENY" || hdr.Get("Referrer-Policy") != "no-referrer" {
			t.Errorf("%s: security headers missing or weakened: %v", name, hdr)
		}
	}
	for name, want := range map[string]int{"404 unknown": 404, "405 wrong": 405, "429 throttled": 429, "403 origin": 403} {
		rec := responses[name]
		if rec.Code != want || !strings.HasPrefix(rec.Header().Get("Content-Type"), "application/json") || detailOf(t, rec) == "" {
			t.Errorf("%s: %d %q %q, want %d with a JSON detail", name, rec.Code, rec.Header().Get("Content-Type"), rec.Body.String(), want)
		}
	}
	if cc := responses["200 admin"].Header().Get("Cache-Control"); cc != "private, no-store" {
		t.Errorf("admin responses must not be cached: %q", cc)
	}
}

func TestInternalErrorsDoNotLeakDetails(t *testing.T) {
	h := newHarness(t)
	cookie := h.login()
	// Break the database underneath the handlers.
	if _, err := h.db.Exec(`DROP TABLE alert_rule_sources`); err != nil {
		t.Fatal(err)
	}
	rec := h.do("GET", "/api/admin/rules", nil, withCookie(cookie))
	expectStatus(t, rec, 500)
	if detailOf(t, rec) != "Internal server error" {
		t.Fatalf("detail = %q", detailOf(t, rec))
	}
	for _, leak := range []string{"alert_rule_sources", "no such table", "sqlite", "SELECT", ".go"} {
		if strings.Contains(rec.Body.String(), leak) {
			t.Fatalf("500 response leaks %q: %s", leak, rec.Body.String())
		}
	}

	if _, err := h.db.Exec(`DROP TABLE messages`); err != nil {
		t.Fatal(err)
	}
	pub := h.do("GET", "/api/public/messages", nil)
	expectStatus(t, pub, 500)
	if strings.Contains(pub.Body.String(), "messages") || strings.Contains(pub.Body.String(), "sqlite") {
		t.Fatalf("public 500 leaks details: %s", pub.Body.String())
	}
}

func TestDevelopmentModeToleratesMissingOriginButNotForeignOnes(t *testing.T) {
	h := newHarness(t, func(c *configT) {
		c.AppEnv = config.EnvDevelopment
		c.SessionCookieSecure = false
	})
	expectStatus(t, h.do("POST", "/api/auth/login", map[string]string{"api_key": testAdminKey}, withoutHeader("Origin")), 200)
	expectStatus(t, h.do("POST", "/api/auth/login", map[string]string{"api_key": testAdminKey}, withHeader("Origin", "https://evil.example")), 403)
	if rec := h.do("POST", "/api/auth/login", map[string]string{"api_key": testAdminKey}); rec.Code != http.StatusOK {
		t.Fatalf("same-origin login in development: %d", rec.Code)
	}
}
