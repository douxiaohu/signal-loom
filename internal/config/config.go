package config

import (
	"bufio"
	"hash/crc32"
	"os"
	"regexp"
	"strconv"
	"strings"
	"time"
)

var (
	telegramSourceRegex   = regexp.MustCompile(`^(?:https?://)?(?:www\.)?t\.me/(?:s/)?([A-Za-z0-9_]+)/?$`)
	telegramUsernameRegex = regexp.MustCompile(`^[A-Za-z0-9_]+$`)
)

// Config 对应系统的全部配置参数
// 在 Java 中相当于 @ConfigurationProperties(prefix = "app") AppProperties
type Config struct {
	TelegramBotToken        string
	DatabasePath            string
	Timezone                string
	CrawlInterval           time.Duration
	AdminAPIKey             string
	MediaCacheDir           string
	SessionSecret           string
	SessionTTL              time.Duration
	SessionCookieSecure     bool
	AppEnv                  string
	Port                    string
	LoginMaxAttempts        int
	LoginWindowSeconds      int
	SourceStaleAfterSeconds int
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

// CanonicalTelegramPublicURL 规范化为 https://t.me/{username}
func CanonicalTelegramPublicURL(source string) (string, error) {
	username := NormalizeTelegramPublicSource(source)
	if username == "" || !telegramUsernameRegex.MatchString(username) {
		return "", os.ErrInvalid
	}
	return "https://t.me/" + username, nil
}

// LoadConfig 从 .env 文件和环境变量中加载配置
func LoadConfig(envPath string) (*Config, error) {
	envMap := make(map[string]string)
	if envPath != "" {
		if file, err := os.Open(envPath); err == nil {
			defer file.Close()
			scanner := bufio.NewScanner(file)
			for scanner.Scan() {
				line := strings.TrimSpace(scanner.Text())
				if line == "" || strings.HasPrefix(line, "#") {
					continue
				}
				parts := strings.SplitN(line, "=", 2)
				if len(parts) == 2 {
					envMap[strings.TrimSpace(parts[0])] = strings.TrimSpace(parts[1])
				}
			}
		}
	}

	getEnv := func(key, defaultVal string) string {
		if val, exists := os.LookupEnv(key); exists && val != "" {
			return val
		}
		if val, exists := envMap[key]; exists && val != "" {
			return val
		}
		return defaultVal
	}

	dbURL := getEnv("DATABASE_URL", "sqlite:///./data/telegram_forwarder.db")
	dbPath := strings.TrimPrefix(dbURL, "sqlite:///")

	crawlSec, _ := strconv.Atoi(getEnv("CRAWL_INTERVAL_SECONDS", "300"))
	if crawlSec <= 0 {
		crawlSec = 300
	}

	sessionTTLHours, _ := strconv.Atoi(getEnv("SESSION_TTL_HOURS", "12"))
	if sessionTTLHours <= 0 {
		sessionTTLHours = 12
	}

	cookieSecure := getEnv("SESSION_COOKIE_SECURE", "true") == "true"
	port := getEnv("PORT", "8000")

	cfg := &Config{
		TelegramBotToken:        getEnv("TELEGRAM_BOT_TOKEN", ""),
		DatabasePath:            dbPath,
		Timezone:                getEnv("TIMEZONE", "Asia/Shanghai"),
		CrawlInterval:           time.Duration(crawlSec) * time.Second,
		AdminAPIKey:             getEnv("ADMIN_API_KEY", ""),
		MediaCacheDir:           getEnv("MEDIA_CACHE_DIR", "./data/media-cache"),
		SessionSecret:           getEnv("SESSION_SECRET", ""),
		SessionTTL:              time.Duration(sessionTTLHours) * time.Hour,
		SessionCookieSecure:     cookieSecure,
		AppEnv:                  getEnv("APP_ENV", "production"),
		Port:                    port,
		LoginMaxAttempts:        5,
		LoginWindowSeconds:      900,
		SourceStaleAfterSeconds: 900,
	}

	return cfg, nil
}
