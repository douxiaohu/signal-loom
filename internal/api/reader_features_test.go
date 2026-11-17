package api

import (
	"fmt"
	"strings"
	"telegram-radar/internal/config"
	"testing"
)

func TestPublicSettingsOnlyExposePublicFields(t *testing.T) {
	h := newHarness(t, func(c *config.Config) {
		c.SiteName = "My room"
		c.SiteDescription = "A reading room"
		c.PublicBaseURL = "https://reader.example"
	})
	response := h.do("GET", "/api/public/config", nil)
	expectStatus(t, response, 200)
	body := decodeMap(t, response)
	if len(body) != 3 || body["name"] != "My room" || body["base_url"] != "https://reader.example" {
		t.Fatalf("Unexpected public fields: %v", body)
	}
	for _, secret := range []string{testAdminKey, testSecret, "DATABASE_URL", "SessionSecret"} {
		if strings.Contains(response.Body.String(), secret) {
			t.Fatal("Public settings leaked runtime data")
		}
	}
}

func TestPermalinkRechecksPublicationEveryTime(t *testing.T) {
	h := newHarness(t)
	source := h.addSource(-1, "Source", true, true)
	id := h.addMessage(source.ChatID, 1, "Public story", nil, "", "")
	path := fmt.Sprintf("/api/public/messages/%d", id)
	response := h.do("GET", path, nil)
	expectStatus(t, response, 200)
	if response.Header().Get("Cache-Control") != "no-store" {
		t.Fatal("Permalinks must revalidate permissions")
	}
	if _, err := h.db.Exec("UPDATE sources SET public_visible=0 WHERE chat_id=?", source.ChatID); err != nil {
		t.Fatal(err)
	}
	expectStatus(t, h.do("GET", path, nil), 404)
	if _, err := h.db.Exec("UPDATE sources SET public_visible=1,enabled=0 WHERE chat_id=?", source.ChatID); err != nil {
		t.Fatal(err)
	}
	expectStatus(t, h.do("GET", path, nil), 404)
	expectStatus(t, h.do("GET", "/api/public/messages/999999", nil), 404)
	expectStatus(t, h.do("GET", "/api/public/messages/invalid", nil), 404)
}

func TestCacheMaintenanceRequiresSessionAndSameOrigin(t *testing.T) {
	h := newHarness(t)
	expectStatus(t, h.do("GET", "/api/admin/cache", nil), 401)
	expectStatus(t, h.do("POST", "/api/admin/cache/prune", map[string]any{}), 401)
	cookie := h.login()
	response := h.do("GET", "/api/admin/cache", nil, withCookie(cookie))
	expectStatus(t, response, 200)
	if strings.Contains(response.Body.String(), "Path") || strings.Contains(response.Body.String(), "/private/") {
		t.Fatal("Cache usage leaks host paths")
	}
	expectStatus(t, h.do("POST", "/api/admin/cache/prune", map[string]any{}, withCookie(cookie), withoutHeader("Origin")), 403)
	expectStatus(t, h.do("POST", "/api/admin/cache/prune", map[string]any{}, withCookie(cookie)), 200)
}
