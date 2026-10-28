package config

import (
	"bufio"
	"net/netip"
	"strings"
	"testing"
	"time"
)

// TestPublicSourceChatID 验证生成的 ChatID 与 Python 原逻辑 100% 吻合
func TestPublicSourceChatID(t *testing.T) {
	// Python: zlib.crc32(b"tnews365") & 0x7FFFFFFF -> 91411552
	// 结果应为 -900091411552
	source := "https://t.me/s/tnews365"
	expected := int64(-900091411552)

	got := PublicSourceChatID(source)
	if got != expected {
		t.Errorf("PublicSourceChatID(%q) = %d; want %d", source, got, expected)
	}
}

func TestNormalizeTelegramPublicSource(t *testing.T) {
	cases := []struct {
		input    string
		expected string
	}{
		{"https://t.me/s/channel_a", "channel_a"},
		{"https://t.me/channel_b", "channel_b"},
		{"@channel_c", "channel_c"},
		{"channel_d", "channel_d"},
	}

	for _, c := range cases {
		got := NormalizeTelegramPublicSource(c.input)
		if got != c.expected {
			t.Errorf("NormalizeTelegramPublicSource(%q) = %q; want %q", c.input, got, c.expected)
		}
	}
}

func TestCanonicalTelegramPublicURLRejectsForeignHosts(t *testing.T) {
	for _, bad := range []string{
		"https://evil.example/foo",
		"http://127.0.0.1:8080/x",
		"https://t.me/../etc",
		"https://t.me/a b",
		"",
		"javascript:alert(1)",
	} {
		if got, err := CanonicalTelegramPublicURL(bad); err == nil {
			t.Errorf("CanonicalTelegramPublicURL(%q) = %q, want an error", bad, got)
		}
	}
	got, err := CanonicalTelegramPublicURL("https://www.t.me/s/Some_Channel/")
	if err != nil || got != "https://t.me/Some_Channel" {
		t.Errorf("canonical URL = %q, %v", got, err)
	}
}

func lookupFrom(m map[string]string) func(string) (string, bool) {
	return func(k string) (string, bool) {
		v, ok := m[k]
		return v, ok
	}
}

func mustBuild(t *testing.T, env map[string]string) *Config {
	t.Helper()
	cfg, err := buildConfig(lookupFrom(env))
	if err != nil {
		t.Fatalf("buildConfig: %v", err)
	}
	return cfg
}

func TestNormalizeEnvIsCaseInsensitiveAndRejectsTypos(t *testing.T) {
	for in, want := range map[string]string{
		"":             EnvProduction,
		"production":   EnvProduction,
		"Production":   EnvProduction,
		" PRODUCTION ": EnvProduction,
		"prod":         EnvProduction,
		"staging":      EnvStaging,
		"development":  EnvDevelopment,
		"Dev":          EnvDevelopment,
		"test":         EnvTest,
		"testing":      EnvTest,
	} {
		got, err := NormalizeEnv(in)
		if err != nil || got != want {
			t.Errorf("NormalizeEnv(%q) = %q, %v; want %q", in, got, err, want)
		}
	}
	for _, bad := range []string{"prd", "produciton", "live", "dev-ish"} {
		if _, err := NormalizeEnv(bad); err == nil {
			t.Errorf("NormalizeEnv(%q) should fail so a typo cannot select a weaker mode", bad)
		}
	}
	if _, err := buildConfig(lookupFrom(map[string]string{"APP_ENV": "prd"})); err == nil {
		t.Error("buildConfig must refuse an unknown APP_ENV")
	}
}

func TestMisCasedProductionDoesNotEnableDevDefaults(t *testing.T) {
	// Previously "Production" fell into the development branch and enabled the
	// well-known admin123 key.
	cfg := mustBuild(t, map[string]string{"APP_ENV": "Production"})
	if got := cfg.FillDevelopmentDefaults(); got != "" || cfg.AdminAPIKey != "" || cfg.SessionSecret != "" {
		t.Fatalf("production-like env must not receive default credentials (key=%q secret=%q)", cfg.AdminAPIKey, cfg.SessionSecret)
	}
	if err := cfg.Validate(); err == nil {
		t.Fatal("a production config without credentials must not validate")
	}
}

func TestValidateProductionRules(t *testing.T) {
	good := map[string]string{
		"APP_ENV":        "production",
		"ADMIN_API_KEY":  "0123456789abcdef",
		"SESSION_SECRET": "0123456789abcdef0123456789abcdef",
	}
	if err := mustBuild(t, good).Validate(); err != nil {
		t.Fatalf("valid production config rejected: %v", err)
	}

	cases := map[string]map[string]string{
		"missing admin key":   {"ADMIN_API_KEY": ""},
		"short admin key":     {"ADMIN_API_KEY": "short"},
		"15 char admin key":   {"ADMIN_API_KEY": "local-admin-key"},
		"missing secret":      {"SESSION_SECRET": ""},
		"short secret":        {"SESSION_SECRET": "0123456789abcdef"},
		"insecure cookie":     {"SESSION_COOKIE_SECURE": "false"},
		"insecure cookie (0)": {"SESSION_COOKIE_SECURE": "0"},
	}
	for name, override := range cases {
		env := map[string]string{}
		for k, v := range good {
			env[k] = v
		}
		for k, v := range override {
			if v == "" {
				delete(env, k)
			} else {
				env[k] = v
			}
		}
		if err := mustBuild(t, env).Validate(); err == nil {
			t.Errorf("%s: Validate() should fail", name)
		}
	}
}

func TestSessionCookieSecureAcceptsPythonSpellings(t *testing.T) {
	for _, v := range []string{"True", "TRUE", "1", "yes", "on", "y"} {
		if !mustBuild(t, map[string]string{"SESSION_COOKIE_SECURE": v}).SessionCookieSecure {
			t.Errorf("SESSION_COOKIE_SECURE=%q should be true", v)
		}
	}
	for _, v := range []string{"false", "False", "0", "no", "off"} {
		if mustBuild(t, map[string]string{"SESSION_COOKIE_SECURE": v}).SessionCookieSecure {
			t.Errorf("SESSION_COOKIE_SECURE=%q should be false", v)
		}
	}
	// Garbage must fail closed (secure), not open.
	if !mustBuild(t, map[string]string{"SESSION_COOKIE_SECURE": "maybe"}).SessionCookieSecure {
		t.Error("unrecognised SESSION_COOKIE_SECURE must default to secure")
	}
}

func TestStagingDoesNotRequireSecureCookieButRequiresKeys(t *testing.T) {
	env := map[string]string{"APP_ENV": "staging", "SESSION_COOKIE_SECURE": "false"}
	if err := mustBuild(t, env).Validate(); err == nil {
		t.Fatal("staging still needs credentials")
	}
	env["ADMIN_API_KEY"] = "0123456789abcdef"
	env["SESSION_SECRET"] = "0123456789abcdef0123456789abcdef"
	if err := mustBuild(t, env).Validate(); err != nil {
		t.Fatalf("staging with credentials and http cookies should pass: %v", err)
	}
}

func TestDevelopmentGeneratesRandomCredentials(t *testing.T) {
	a := mustBuild(t, map[string]string{"APP_ENV": "development", "SESSION_COOKIE_SECURE": "false"})
	keyA := a.FillDevelopmentDefaults()
	if keyA == "" || a.AdminAPIKey != keyA || a.SessionSecret == "" {
		t.Fatalf("development should receive generated credentials, got key=%q", keyA)
	}
	if err := a.Validate(); err != nil {
		t.Fatalf("generated development credentials must satisfy Validate: %v", err)
	}
	if keyA == "admin123" {
		t.Fatal("there must be no fixed default key")
	}
	b := mustBuild(t, map[string]string{"APP_ENV": "development"})
	if keyB := b.FillDevelopmentDefaults(); keyB == keyA {
		t.Fatal("generated keys must be random per start")
	}

	// A key supplied by the developer is kept and still length-checked.
	c := mustBuild(t, map[string]string{"APP_ENV": "development", "ADMIN_API_KEY": "short"})
	if got := c.FillDevelopmentDefaults(); got != "" || c.AdminAPIKey != "short" {
		t.Fatal("an explicit key must not be replaced")
	}
	if err := c.Validate(); err == nil {
		t.Fatal("a short explicit key must still be rejected in development")
	}
}

func TestTestEnvSkipsValidationAndDisablesLoginWithoutKey(t *testing.T) {
	cfg := mustBuild(t, map[string]string{"APP_ENV": "test"})
	cfg.FillDevelopmentDefaults()
	if cfg.AdminAPIKey != "" {
		t.Fatal("test env must not invent an admin key")
	}
	if cfg.SessionSecret == "" {
		t.Fatal("test env still needs a session secret")
	}
	if err := cfg.Validate(); err != nil {
		t.Fatalf("test env skips validation: %v", err)
	}
}

func TestDocumentedSettingsAreHonoured(t *testing.T) {
	cfg := mustBuild(t, map[string]string{
		"LOGIN_MAX_ATTEMPTS":         "3",
		"LOGIN_WINDOW_SECONDS":       "60",
		"SOURCE_STALE_AFTER_SECONDS": "120",
		"TIMEZONE":                   "UTC",
		"FEEDBACK_RATE_LIMIT":        "2",
		"MEDIA_MAX_BYTES":            "1024",
		"MEDIA_ALLOWED_HOSTS":        "Example.com, cdn.example.org",
		"SESSION_TTL_HOURS":          "2",
		"CRAWL_INTERVAL_SECONDS":     "30",
	})
	if cfg.LoginMaxAttempts != 3 || cfg.LoginWindow != time.Minute || cfg.SourceStaleAfterSeconds != 120 {
		t.Errorf("LOGIN_*/SOURCE_STALE_* ignored: %+v", cfg)
	}
	if cfg.Location.String() != "UTC" || cfg.FeedbackRateLimit != 2 || cfg.MediaMaxBytes != 1024 {
		t.Errorf("TIMEZONE/FEEDBACK/MEDIA settings ignored: %+v", cfg)
	}
	if len(cfg.MediaAllowedHosts) != 2 || cfg.MediaAllowedHosts[0] != "example.com" {
		t.Errorf("MEDIA_ALLOWED_HOSTS = %v", cfg.MediaAllowedHosts)
	}
	if cfg.SessionTTL != 2*time.Hour || cfg.CrawlInterval != 30*time.Second {
		t.Errorf("TTL/interval = %v / %v", cfg.SessionTTL, cfg.CrawlInterval)
	}

	bad := mustBuild(t, map[string]string{"LOGIN_MAX_ATTEMPTS": "-4", "LOGIN_WINDOW_SECONDS": "zero"})
	if bad.LoginMaxAttempts != 5 || bad.LoginWindow != 15*time.Minute {
		t.Errorf("invalid values should fall back to defaults: %+v", bad)
	}
	if def := mustBuild(t, nil); len(def.MediaAllowedHosts) == 0 || def.MediaMaxBytes != DefaultMediaMaxBytes {
		t.Errorf("media defaults missing: %v / %d", def.MediaAllowedHosts, def.MediaMaxBytes)
	}
}

func TestInvalidTimezoneFallsBackToUTCWithWarning(t *testing.T) {
	cfg := mustBuild(t, map[string]string{"TIMEZONE": "Mars/Olympus"})
	if cfg.Location != time.UTC || len(cfg.Warnings) == 0 {
		t.Fatalf("expected UTC fallback with a warning, got %v / %v", cfg.Location, cfg.Warnings)
	}
}

func TestParseEnvFileStripsQuotesAndComments(t *testing.T) {
	values := parseEnvFile(strings.NewReader(`
# comment
ADMIN_API_KEY="quoted-key-0123456789"
SESSION_SECRET='single-quoted-secret-0123456789abc'
export PORT=9000
EMPTY=
NOEQUALS
 SPACED = value with spaces
`))
	want := map[string]string{
		"ADMIN_API_KEY":  "quoted-key-0123456789",
		"SESSION_SECRET": "single-quoted-secret-0123456789abc",
		"PORT":           "9000",
		"EMPTY":          "",
		"SPACED":         "value with spaces",
	}
	for k, v := range want {
		if got, ok := values[k]; !ok || got != v {
			t.Errorf("%s = %q (present=%v), want %q", k, got, ok, v)
		}
	}
	if _, ok := values["NOEQUALS"]; ok {
		t.Error("lines without '=' must be ignored")
	}
}

func TestParseTrustedProxies(t *testing.T) {
	def, err := ParseTrustedProxies("")
	if err != nil || len(def) == 0 {
		t.Fatalf("default should trust private ranges: %v %v", def, err)
	}
	contains := func(ps []netip.Prefix, ip string) bool {
		a := netip.MustParseAddr(ip)
		for _, p := range ps {
			if p.Contains(a) {
				return true
			}
		}
		return false
	}
	for _, ip := range []string{"127.0.0.1", "::1", "10.1.2.3", "172.18.0.1", "192.168.1.5"} {
		if !contains(def, ip) {
			t.Errorf("%s should be trusted by default", ip)
		}
	}
	for _, ip := range []string{"8.8.8.8", "203.0.113.9", "2001:db8::1"} {
		if contains(def, ip) {
			t.Errorf("%s must not be trusted by default", ip)
		}
	}
	if none, err := ParseTrustedProxies("none"); err != nil || len(none) != 0 {
		t.Errorf("none = %v, %v", none, err)
	}
	custom, err := ParseTrustedProxies("203.0.113.0/24, 198.51.100.7")
	if err != nil || !contains(custom, "203.0.113.50") || !contains(custom, "198.51.100.7") || contains(custom, "127.0.0.1") {
		t.Errorf("custom = %v, %v", custom, err)
	}
	for _, bad := range []string{"not-an-ip", "10.0.0.0/99", "1.2.3"} {
		if _, err := ParseTrustedProxies(bad); err == nil {
			t.Errorf("ParseTrustedProxies(%q) should fail", bad)
		}
	}
}

func TestParseGroupsMatchesDocumentedShape(t *testing.T) {
	text := `groups:
  - source: "https://t.me/zaihuapd"
    name: "zaihuapd"   # trailing comment

  - source: "https://t.me/s/tnews365"
    name: "竹新社"

  # Bot API source example
  - chat_id: -1001234567890
    name: "Example Telegram Group"
`
	groups, err := parseGroups(bufio.NewScanner(strings.NewReader(text)))
	if err != nil {
		t.Fatal(err)
	}
	if len(groups) != 3 {
		t.Fatalf("got %d groups: %+v", len(groups), groups)
	}
	if groups[0].Source != "https://t.me/zaihuapd" || groups[0].Name != "zaihuapd" || groups[0].SourceType != "telegram_public" {
		t.Errorf("group 0 = %+v", groups[0])
	}
	if groups[1].Name != "竹新社" {
		t.Errorf("group 1 = %+v", groups[1])
	}
	if groups[2].SourceType != "telegram_bot" || groups[2].ChatID == nil || *groups[2].ChatID != -1001234567890 {
		t.Errorf("group 2 = %+v", groups[2])
	}
}
