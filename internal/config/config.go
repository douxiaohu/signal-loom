package config

import (
	"bufio"
	"crypto/rand"
	"encoding/base64"
	"errors"
	"fmt"
	"hash/crc32"
	"io"
	"net/netip"
	"net/url"
	"os"
	"regexp"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"
)

var (
	telegramSourceRegex   = regexp.MustCompile(`^(?:https?://)?(?:www\.)?t\.me/(?:s/)?([A-Za-z0-9_]+)/?$`)
	telegramUsernameRegex = regexp.MustCompile(`^[A-Za-z0-9_]+$`)
)

// Canonical APP_ENV values. Anything else is rejected at startup so that a typo
// can never silently select a weaker mode.
const (
	EnvProduction  = "production"
	EnvStaging     = "staging"
	EnvDevelopment = "development"
	EnvTest        = "test"
)

const (
	// MinAdminKeyLength and MinSessionSecretBytes match the checks the Python
	// service performed in validate_security_config.
	MinAdminKeyLength     = 16
	MinSessionSecretBytes = 32

	DefaultMediaMaxBytes = 96 << 20
)

// DefaultMediaHosts are the CDN domains (and their subdomains) the media cache
// is allowed to download from. Override with MEDIA_ALLOWED_HOSTS.
var DefaultMediaHosts = []string{"telesco.pe", "cdn-telegram.org"}

// privateRanges is what TRUSTED_PROXIES=private expands to.
var privateRanges = []string{
	"127.0.0.0/8", "::1/128",
	"10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16",
	"169.254.0.0/16", "fc00::/7", "fe80::/10",
}

// Config holds every runtime setting of the service.
type Config struct {
	SiteName           string
	SiteDescription    string
	PublicBaseURL      string
	MediaCacheMaxBytes int64
	MediaCacheMaxAge   time.Duration

	TelegramBotToken string // not used by the Go service; kept so old .env files still load
	DatabasePath     string
	Timezone         string
	Location         *time.Location
	CrawlInterval    time.Duration
	GroupsConfigPath string

	AdminAPIKey         string
	SessionSecret       string
	SessionTTL          time.Duration
	SessionCookieSecure bool
	AppEnv              string

	Host string
	Port string

	LoginMaxAttempts   int
	LoginWindow        time.Duration
	FeedbackRateLimit  int
	FeedbackRateWindow time.Duration

	// TrustedProxies lists the peers whose X-Forwarded-For / X-Real-IP headers
	// are believed. Everyone else is identified by their TCP address.
	TrustedProxies []netip.Prefix

	SourceStaleAfterSeconds int

	MediaCacheDir     string
	MediaAllowedHosts []string
	MediaMaxBytes     int64

	// Warnings collects non-fatal problems found while loading (for example an
	// unknown TIMEZONE) so the caller can log them.
	Warnings []string
}

// NormalizeTelegramPublicSource 提取 Telegram 频道用户名
// 比如 "https://t.me/s/tnews365" -> "tnews365"
func NormalizeTelegramPublicSource(source string) string {
	val := strings.TrimSpace(source)
	if match := telegramSourceRegex.FindStringSubmatch(val); len(match) > 1 {
		return match[1]
	}
	return strings.TrimPrefix(val, "@")
}

// PublicSourceChatID 根据频道用户名生成负数 ChatID（与 Python 原算法 100% 保持一致）
func PublicSourceChatID(source string) int64 {
	username := strings.ToLower(NormalizeTelegramPublicSource(source))
	checksum := crc32.ChecksumIEEE([]byte(username)) & 0x7FFFFFFF
	return -900000000000 - int64(checksum)
}

// IsValidTelegramUsername reports whether name is usable in a t.me URL.
func IsValidTelegramUsername(name string) bool {
	return name != "" && telegramUsernameRegex.MatchString(name)
}

// CanonicalTelegramPublicURL 规范化为 https://t.me/{username}
func CanonicalTelegramPublicURL(source string) (string, error) {
	username := NormalizeTelegramPublicSource(source)
	if !IsValidTelegramUsername(username) {
		return "", os.ErrInvalid
	}
	return "https://t.me/" + username, nil
}

// NormalizeEnv maps an APP_ENV value to one of the canonical environments.
func NormalizeEnv(raw string) (string, error) {
	switch strings.ToLower(strings.TrimSpace(raw)) {
	case "", "production", "prod":
		return EnvProduction, nil
	case "staging", "stage":
		return EnvStaging, nil
	case "development", "dev", "local":
		return EnvDevelopment, nil
	case "test", "testing":
		return EnvTest, nil
	}
	return "", fmt.Errorf("unknown APP_ENV %q (use production, staging, development or test)", raw)
}

// IsDevLike reports whether the relaxed development/test rules apply.
func (c *Config) IsDevLike() bool {
	return c.AppEnv == EnvDevelopment || c.AppEnv == EnvTest
}

// LoadConfig reads settings from the process environment and, as a fallback,
// from a dotenv file. It does not enforce the security rules; call Validate.
func LoadConfig(envPath string) (*Config, error) {
	fileValues := map[string]string{}
	if envPath != "" {
		if f, err := os.Open(envPath); err == nil {
			fileValues = parseEnvFile(f)
			_ = f.Close()
		}
	}
	return buildConfig(func(key string) (string, bool) {
		if v, ok := os.LookupEnv(key); ok && strings.TrimSpace(v) != "" {
			return strings.TrimSpace(v), true
		}
		if v, ok := fileValues[key]; ok && v != "" {
			return v, true
		}
		return "", false
	})
}

func buildConfig(lookup func(string) (string, bool)) (*Config, error) {
	get := func(key, def string) string {
		if v, ok := lookup(key); ok {
			return v
		}
		return def
	}

	appEnv, err := NormalizeEnv(get("APP_ENV", EnvProduction))
	if err != nil {
		return nil, err
	}

	dbURL := get("DATABASE_URL", "sqlite:///./data/telegram_forwarder.db")
	dbPath := strings.TrimPrefix(dbURL, "sqlite:///")

	trusted, err := ParseTrustedProxies(get("TRUSTED_PROXIES", "private"))
	if err != nil {
		return nil, fmt.Errorf("TRUSTED_PROXIES: %w", err)
	}

	cfg := &Config{
		SiteName:                get("SITE_NAME", "拾讯"),
		SiteDescription:         get("SITE_DESCRIPTION", "拾起消息，织成日常。"),
		PublicBaseURL:           strings.TrimRight(get("PUBLIC_BASE_URL", ""), "/"),
		MediaCacheMaxBytes:      int64(parsePositiveInt(get("MEDIA_CACHE_MAX_BYTES", ""), 5<<30)),
		MediaCacheMaxAge:        time.Duration(parsePositiveInt(get("MEDIA_CACHE_MAX_AGE_DAYS", ""), 30)) * 24 * time.Hour,
		TelegramBotToken:        get("TELEGRAM_BOT_TOKEN", ""),
		DatabasePath:            dbPath,
		Timezone:                get("TIMEZONE", "Asia/Shanghai"),
		CrawlInterval:           time.Duration(parsePositiveInt(get("CRAWL_INTERVAL_SECONDS", ""), 300)) * time.Second,
		GroupsConfigPath:        get("GROUPS_CONFIG_PATH", "config/groups.yaml"),
		AdminAPIKey:             get("ADMIN_API_KEY", ""),
		SessionSecret:           get("SESSION_SECRET", ""),
		SessionTTL:              time.Duration(parsePositiveInt(get("SESSION_TTL_HOURS", ""), 12)) * time.Hour,
		SessionCookieSecure:     ParseBool(get("SESSION_COOKIE_SECURE", ""), true),
		AppEnv:                  appEnv,
		Host:                    get("HOST", ""),
		Port:                    get("PORT", "8000"),
		LoginMaxAttempts:        parsePositiveInt(get("LOGIN_MAX_ATTEMPTS", ""), 5),
		LoginWindow:             time.Duration(parsePositiveInt(get("LOGIN_WINDOW_SECONDS", ""), 900)) * time.Second,
		FeedbackRateLimit:       parsePositiveInt(get("FEEDBACK_RATE_LIMIT", ""), 5),
		FeedbackRateWindow:      time.Duration(parsePositiveInt(get("FEEDBACK_RATE_WINDOW_SECONDS", ""), 60)) * time.Second,
		TrustedProxies:          trusted,
		SourceStaleAfterSeconds: parsePositiveInt(get("SOURCE_STALE_AFTER_SECONDS", ""), 900),
		MediaCacheDir:           get("MEDIA_CACHE_DIR", "./data/media-cache"),
		MediaAllowedHosts:       parseCSV(get("MEDIA_ALLOWED_HOSTS", ""), DefaultMediaHosts),
		MediaMaxBytes:           int64(parsePositiveInt(get("MEDIA_MAX_BYTES", ""), DefaultMediaMaxBytes)),
	}

	if err := cfg.ValidatePublicSettings(); err != nil {
		return nil, err
	}
	loc, err := time.LoadLocation(cfg.Timezone)
	if err != nil {
		cfg.Warnings = append(cfg.Warnings, fmt.Sprintf("invalid TIMEZONE %q, falling back to UTC", cfg.Timezone))
		loc = time.UTC
	}
	cfg.Location = loc
	return cfg, nil
}

// FillDevelopmentDefaults replaces missing credentials with random throw-away
// values, but only in development and test. There is deliberately no fixed
// default key: production-like environments must always be configured.
// It returns the generated admin key (empty when none was generated).
func (c *Config) FillDevelopmentDefaults() (generatedAdminKey string) {
	if !c.IsDevLike() {
		return ""
	}
	if c.SessionSecret == "" {
		c.SessionSecret = randomToken(32)
	}
	if c.AdminAPIKey == "" && c.AppEnv == EnvDevelopment {
		c.AdminAPIKey = randomToken(24)
		return c.AdminAPIKey
	}
	return ""
}

// Validate enforces the security rules. Only APP_ENV=test skips them.
func (c *Config) Validate() error {
	if c.AppEnv == EnvTest {
		return nil
	}
	var problems []string
	switch {
	case c.AdminAPIKey == "":
		problems = append(problems, "ADMIN_API_KEY is required")
	case utf8.RuneCountInString(c.AdminAPIKey) < MinAdminKeyLength:
		problems = append(problems, fmt.Sprintf("ADMIN_API_KEY must be at least %d characters", MinAdminKeyLength))
	}
	switch {
	case c.SessionSecret == "":
		problems = append(problems, "SESSION_SECRET is required")
	case len([]byte(c.SessionSecret)) < MinSessionSecretBytes:
		problems = append(problems, fmt.Sprintf("SESSION_SECRET must be at least %d bytes", MinSessionSecretBytes))
	}
	if c.AppEnv == EnvProduction && !c.SessionCookieSecure {
		problems = append(problems, "SESSION_COOKIE_SECURE must be true when APP_ENV=production")
	}
	if len(problems) > 0 {
		return errors.New("insecure configuration: " + strings.Join(problems, "; "))
	}
	return nil
}

// ParseBool accepts the same spellings as the Python service. Unrecognised
// input yields def.
func ParseBool(value string, def bool) bool {
	switch strings.ToLower(strings.TrimSpace(value)) {
	case "1", "true", "yes", "y", "on":
		return true
	case "0", "false", "no", "n", "off":
		return false
	}
	return def
}

func parsePositiveInt(value string, def int) int {
	n, err := strconv.Atoi(strings.TrimSpace(value))
	if err != nil || n <= 0 {
		return def
	}
	return n
}

func parseCSV(value string, def []string) []string {
	var out []string
	seen := map[string]bool{}
	for _, part := range strings.Split(value, ",") {
		part = strings.ToLower(strings.TrimSpace(part))
		if part == "" || seen[part] {
			continue
		}
		seen[part] = true
		out = append(out, part)
	}
	if len(out) == 0 {
		return append([]string(nil), def...)
	}
	return out
}

// ParseTrustedProxies turns a TRUSTED_PROXIES value into prefixes. Tokens are
// comma separated: "private" (loopback + private + link-local ranges, the
// default), "loopback", "none", or any IP / CIDR.
func ParseTrustedProxies(spec string) ([]netip.Prefix, error) {
	if strings.TrimSpace(spec) == "" {
		spec = "private"
	}
	var out []netip.Prefix
	add := func(text string) error {
		if strings.Contains(text, "/") {
			p, err := netip.ParsePrefix(text)
			if err != nil {
				return fmt.Errorf("invalid CIDR %q", text)
			}
			out = append(out, p.Masked())
			return nil
		}
		a, err := netip.ParseAddr(text)
		if err != nil {
			return fmt.Errorf("invalid IP %q", text)
		}
		out = append(out, netip.PrefixFrom(a.Unmap(), a.Unmap().BitLen()))
		return nil
	}
	for _, token := range strings.Split(spec, ",") {
		token = strings.ToLower(strings.TrimSpace(token))
		switch token {
		case "", "none":
		case "private":
			for _, r := range privateRanges {
				if err := add(r); err != nil {
					return nil, err
				}
			}
		case "loopback":
			for _, r := range privateRanges[:2] {
				if err := add(r); err != nil {
					return nil, err
				}
			}
		default:
			if err := add(token); err != nil {
				return nil, err
			}
		}
	}
	return out, nil
}

func parseEnvFile(r io.Reader) map[string]string {
	values := map[string]string{}
	scanner := bufio.NewScanner(r)
	scanner.Buffer(make([]byte, 0, 64*1024), 1024*1024)
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		line = strings.TrimSpace(strings.TrimPrefix(line, "export "))
		key, value, ok := strings.Cut(line, "=")
		key = strings.TrimSpace(key)
		if !ok || key == "" {
			continue
		}
		values[key] = stripQuotes(strings.TrimSpace(value))
	}
	return values
}

func stripQuotes(v string) string {
	if len(v) >= 2 && v[0] == v[len(v)-1] && (v[0] == '"' || v[0] == '\'') {
		return v[1 : len(v)-1]
	}
	return v
}

func randomToken(n int) string {
	b := make([]byte, n)
	if _, err := rand.Read(b); err != nil {
		panic("crypto/rand unavailable: " + err.Error())
	}
	return base64.RawURLEncoding.EncodeToString(b)
}

// ValidatePublicSettings validates deployment-owned metadata, never a request Host.
func (c *Config) ValidatePublicSettings() error {
	if utf8.RuneCountInString(c.SiteName) > 60 || utf8.RuneCountInString(c.SiteDescription) > 300 {
		return errors.New("site name or description is too long")
	}
	if c.PublicBaseURL == "" {
		return nil
	}
	u, err := url.Parse(c.PublicBaseURL)
	if err != nil || u.Hostname() == "" || (u.Scheme != "https" && u.Scheme != "http") || u.User != nil || u.RawQuery != "" || u.Fragment != "" || u.Path != "" {
		return errors.New("PUBLIC_BASE_URL must be an http(s) origin without credentials, path, query or fragment")
	}
	return nil
}
