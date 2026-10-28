package crawler

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/PuerkitoBio/goquery"

	"telegram-radar/internal/config"
	"telegram-radar/internal/model"
)

// maxPageBytes bounds how much of a channel page is read. A t.me preview page
// is a few hundred KB; anything near this limit is not a normal page.
const maxPageBytes = 8 << 20

var (
	bgImageRegex = regexp.MustCompile(`background-image:\s*url\(\s*['"]?([^'")]+)['"]?\s*\)`)

	// Media inside these containers (link previews, "not supported" stubs) is
	// not part of the post itself.
	ignoredMediaSelector = ".media_not_supported_cont, .message_media_not_supported_wrap, .tgme_widget_message_link_preview"

	defaultPageTemplates = []string{
		"https://t.me/s/%s",
		"https://telegram.me/s/%s",
	}
)

// TelegramCrawler 负责抓取并解析 Telegram 公开频道内容
type TelegramCrawler struct {
	client    *http.Client
	timeout   time.Duration
	templates []string
}

func NewTelegramCrawler(timeout time.Duration) *TelegramCrawler {
	if timeout <= 0 {
		timeout = 20 * time.Second
	}
	return &TelegramCrawler{
		client:    &http.Client{Timeout: timeout},
		timeout:   timeout,
		templates: defaultPageTemplates,
	}
}

// CrawlChannel 抓取指定来源并返回提取出的消息列表
func (c *TelegramCrawler) CrawlChannel(ctx context.Context, sourceURL string, chatID int64, channelTitle string) ([]model.StoredMessage, error) {
	username := config.NormalizeTelegramPublicSource(sourceURL)
	if !config.IsValidTelegramUsername(username) {
		return nil, fmt.Errorf("invalid channel username from %s", sourceURL)
	}

	var lastErr error
	for _, tmpl := range c.templates {
		page, err := c.fetch(ctx, fmt.Sprintf(tmpl, username))
		if err != nil {
			lastErr = err
			if ctx.Err() != nil {
				break
			}
			continue
		}
		return ParsePublicPosts(page, username, chatID, channelTitle)
	}
	return nil, fmt.Errorf("failed to fetch %s: %w", username, lastErr)
}

func (c *TelegramCrawler) fetch(ctx context.Context, pageURL string) (string, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, pageURL, nil)
	if err != nil {
		return "", err
	}
	req.Header.Set("User-Agent", "Mozilla/5.0 (compatible; TelegramRadar/1.0; +https://github.com/douxiaohu/telegram-github-radar)")

	resp, err := c.client.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("status %d from %s", resp.StatusCode, pageURL)
	}
	body, err := io.ReadAll(io.LimitReader(resp.Body, maxPageBytes+1))
	if err != nil {
		return "", err
	}
	if len(body) > maxPageBytes {
		return "", errors.New("page too large")
	}
	if len(body) == 0 {
		return "", errors.New("empty page")
	}
	return string(body), nil
}

// ParsePublicPosts 解析 Telegram 网页 HTML
func ParsePublicPosts(html, username string, chatID int64, chatTitle string) ([]model.StoredMessage, error) {
	doc, err := goquery.NewDocumentFromReader(strings.NewReader(html))
	if err != nil {
		return nil, err
	}
	title := chatTitle
	if title == "" {
		title = username
	}

	posts := make([]model.StoredMessage, 0)
	doc.Find("div.tgme_widget_message[data-post]").Each(func(_ int, s *goquery.Selection) {
		dataPost, _ := s.Attr("data-post")
		parts := strings.Split(dataPost, "/")
		if len(parts) != 2 {
			return
		}
		msgID, err := strconv.ParseInt(parts[1], 10, 64)
		if err != nil || msgID <= 0 {
			return
		}
		channel := parts[0]
		if !config.IsValidTelegramUsername(channel) {
			channel = username
		}

		timeStr, _ := s.Find("time[datetime]").First().Attr("datetime")
		if timeStr = strings.TrimSpace(timeStr); timeStr == "" {
			timeStr = time.Now().UTC().Format(time.RFC3339)
		}

		// 提取文本内容，并将 <br> 转换换行符 \n
		var text string
		textNode := s.Find("div.tgme_widget_message_text.js-message_text").
			FilterFunction(func(_ int, sel *goquery.Selection) bool { return !sel.HasClass("js-message_reply_text") }).
			First()
		if textNode.Length() > 0 {
			textNode.Find("br").ReplaceWithHtml("\n")
			text = normalizePostText(textNode.Text())
		}

		mediaItems, mediaType := extractMedia(s)
		mediaURLs := make([]string, 0, len(mediaItems))
		for _, it := range mediaItems {
			mediaURLs = append(mediaURLs, it.URL)
		}

		// A post needs text or media to be worth keeping.
		if text == "" && mediaType == nil && len(mediaURLs) == 0 {
			return
		}

		// 格式化展示文本（如 [photo] caption）
		displayContent := text
		if mediaType != nil && *mediaType != "" {
			prefix := fmt.Sprintf("[%s]", *mediaType)
			if !strings.HasPrefix(displayContent, prefix) {
				if displayContent != "" {
					displayContent = prefix + " " + displayContent
				} else {
					displayContent = prefix
				}
			}
		}

		rawObj := map[string]any{
			"source":       username,
			"data_post":    dataPost,
			"source_url":   fmt.Sprintf("https://t.me/%s/%d", channel, msgID),
			"media_urls":   mediaURLs,
			"media_items":  mediaItems,
			"message_id":   msgID,
			"chat_id":      chatID,
			"chat_title":   title,
			"message_time": timeStr,
		}
		rawBytes, _ := json.Marshal(rawObj)

		posts = append(posts, model.StoredMessage{
			ChatID:      chatID,
			ChatTitle:   title,
			MessageID:   msgID,
			SenderName:  title,
			MessageTime: timeStr,
			Content:     displayContent,
			MediaType:   mediaType,
			RawJSON:     string(rawBytes),
		})
	})
	return posts, nil
}

// extractMedia collects the media of one post and decides its media type: the
// first matching element in document order wins, as in the Python parser.
func extractMedia(post *goquery.Selection) ([]model.MediaItem, *string) {
	var items []model.MediaItem
	var mediaType *string
	setType := func(t string) {
		if mediaType == nil {
			mediaType = &t
		}
	}
	seen := map[string]bool{}
	add := func(rawURL, kind, role string) {
		u := normalizeMediaURL(rawURL)
		if u == "" || seen[u] || !isContentMediaURL(u) {
			return
		}
		seen[u] = true
		items = append(items, model.MediaItem{URL: u, Kind: kind, Role: role})
	}

	post.Find("*").Each(func(_ int, el *goquery.Selection) {
		if el.Closest(ignoredMediaSelector).Length() > 0 {
			return
		}
		classAttr, _ := el.Attr("class")
		classes := strings.Fields(classAttr)
		style, _ := el.Attr("style")
		src, _ := el.Attr("src")

		for _, class := range classes {
			switch {
			case class == "tgme_widget_message_photo_wrap":
				setType("photo")
				addStyleURLs(style, func(u string) { add(u, "image", "media") })
				add(src, "image", "media")
			case class == "tgme_widget_message_video_thumb":
				addStyleURLs(style, func(u string) { add(u, "image", "poster") })
				add(src, "image", "poster")
			case class == "tgme_widget_message_video_player":
				add(src, "video", "media")
			}
			if strings.Contains(class, "message_video") {
				setType("video")
			} else if strings.Contains(class, "message_document") || strings.Contains(class, "message_file") {
				setType("document")
			}
		}
	})
	if items == nil {
		items = []model.MediaItem{}
	}
	return items, mediaType
}

func addStyleURLs(style string, add func(string)) {
	for _, m := range bgImageRegex.FindAllStringSubmatch(style, -1) {
		add(m[1])
	}
}

func normalizeMediaURL(u string) string {
	u = strings.TrimSpace(u)
	if strings.HasPrefix(u, "//") {
		return "https:" + u
	}
	return u
}

// isContentMediaURL keeps real post media and drops UI chrome such as the
// Telegram emoji sprites. (Fetching is restricted much more strictly by the
// media cache; this is only about what counts as post content.)
func isContentMediaURL(u string) bool {
	if strings.Contains(u, "telegram.org/img/emoji") {
		return false
	}
	if !strings.HasPrefix(u, "https://") {
		return false
	}
	lower := strings.ToLower(u)
	return strings.Contains(u, "telesco.pe/") || strings.Contains(u, "cdn") ||
		strings.HasSuffix(lower, ".jpg") || strings.HasSuffix(lower, ".jpeg") ||
		strings.HasSuffix(lower, ".png") || strings.HasSuffix(lower, ".webp")
}

// normalizePostText collapses runs of whitespace inside each line and drops
// empty lines.
func normalizePostText(value string) string {
	lines := make([]string, 0)
	for _, line := range strings.Split(value, "\n") {
		if normalized := strings.Join(strings.Fields(line), " "); normalized != "" {
			lines = append(lines, normalized)
		}
	}
	return strings.Join(lines, "\n")
}
