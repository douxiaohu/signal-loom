package crawler

import (
	"encoding/json"
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

var (
	bgImageRegex = regexp.MustCompile(`background-image:url\('([^']+)'\)`)
)

// TelegramCrawler 负责抓取并解析 Telegram 公开频道内容
type TelegramCrawler struct {
	client  *http.Client
	timeout time.Duration
}

func NewTelegramCrawler(timeout time.Duration) *TelegramCrawler {
	if timeout <= 0 {
		timeout = 20 * time.Second
	}
	return &TelegramCrawler{
		client: &http.Client{
			Timeout: timeout,
		},
		timeout: timeout,
	}
}

// CrawlChannel 抓取指定来源并返回提取出的消息列表
func (c *TelegramCrawler) CrawlChannel(sourceURL string, chatID int64, channelTitle string) ([]model.StoredMessage, error) {
	username := config.NormalizeTelegramPublicSource(sourceURL)
	if username == "" {
		return nil, fmt.Errorf("invalid channel username from %s", sourceURL)
	}

	urls := []string{
		fmt.Sprintf("https://t.me/s/%s", username),
		fmt.Sprintf("https://telegram.me/s/%s", username),
	}

	var lastErr error
	var htmlContent string

	for _, url := range urls {
		req, err := http.NewRequest(http.MethodGet, url, nil)
		if err != nil {
			lastErr = err
			continue
		}
		req.Header.Set("User-Agent", "Mozilla/5.0 (compatible; TelegramRadar/1.0; +https://github.com/douxiaohu/telegram-github-radar)")

		resp, err := c.client.Do(req)
		if err != nil {
			lastErr = err
			continue
		}

		if resp.StatusCode != http.StatusOK {
			resp.Body.Close()
			lastErr = fmt.Errorf("status %d from %s", resp.StatusCode, url)
			continue
		}

		bodyBytes, err := io.ReadAll(resp.Body)
		resp.Body.Close()
		if err != nil {
			lastErr = err
			continue
		}

		htmlContent = string(bodyBytes)
		break
	}

	if htmlContent == "" {
		return nil, fmt.Errorf("failed to fetch %s: %w", username, lastErr)
	}

	return ParsePublicPosts(htmlContent, username, chatID, channelTitle)
}

// ParsePublicPosts 解析 Telegram 网页 HTML
func ParsePublicPosts(html, username string, chatID int64, chatTitle string) ([]model.StoredMessage, error) {
	doc, err := goquery.NewDocumentFromReader(strings.NewReader(html))
	if err != nil {
		return nil, err
	}

	var posts []model.StoredMessage

	doc.Find("div.tgme_widget_message[data-post]").Each(func(i int, s *goquery.Selection) {
		dataPost, _ := s.Attr("data-post")
		parts := strings.Split(dataPost, "/")
		if len(parts) != 2 {
			return
		}
		msgID, err := strconv.ParseInt(parts[1], 10, 64)
		if err != nil {
			return
		}

		timeStr, _ := s.Find("time[datetime]").First().Attr("datetime")
		if timeStr == "" {
			return
		}

		// 提取文本内容，并将 <br> 转换换行符 \n
		var text string
		textNode := s.Find("div.tgme_widget_message_text.js-message_text").FilterFunction(func(idx int, sel *goquery.Selection) bool {
			return !sel.HasClass("js-message_reply_text")
		}).First()

		if textNode.Length() > 0 {
			textNode.Find("br").ReplaceWithHtml("\n")
			text = strings.TrimSpace(textNode.Text())
		}

		// 提取媒体
		var mediaItems []model.MediaItem
		var mediaURLs []string
		var mediaType *string

		// 过滤掉不支持的媒体占位符
		if s.Find(".media_not_supported_cont, .message_media_not_supported_wrap").Length() == 0 {
			// 图片
			s.Find("a.tgme_widget_message_photo_wrap").Each(func(idx int, photoSel *goquery.Selection) {
				style, _ := photoSel.Attr("style")
				if match := bgImageRegex.FindStringSubmatch(style); len(match) > 1 {
					url := match[1]
					mediaURLs = append(mediaURLs, url)
					mediaItems = append(mediaItems, model.MediaItem{
						URL:  url,
						Kind: "image",
						Role: "media",
					})
					mt := "photo"
					mediaType = &mt
				}
			})

			// 视频缩略图 & 视频原文件
			s.Find("i.tgme_widget_message_video_thumb").Each(func(idx int, thumbSel *goquery.Selection) {
				style, _ := thumbSel.Attr("style")
				if match := bgImageRegex.FindStringSubmatch(style); len(match) > 1 {
					url := match[1]
					mediaURLs = append(mediaURLs, url)
					mediaItems = append(mediaItems, model.MediaItem{
						URL:  url,
						Kind: "image",
						Role: "poster",
					})
				}
			})

			s.Find("video.tgme_widget_message_video_player").Each(func(idx int, videoSel *goquery.Selection) {
				src, _ := videoSel.Attr("src")
				if src != "" {
					mediaURLs = append(mediaURLs, src)
					mediaItems = append(mediaItems, model.MediaItem{
						URL:  src,
						Kind: "video",
						Role: "media",
					})
					mt := "video"
					mediaType = &mt
				}
			})
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
			"source_url":   fmt.Sprintf("https://t.me/%s/%d", parts[0], msgID),
			"media_urls":   mediaURLs,
			"media_items":  mediaItems,
			"message_id":   msgID,
			"chat_id":      chatID,
			"chat_title":   chatTitle,
			"message_time": timeStr,
		}
		rawBytes, _ := json.Marshal(rawObj)

		senderName := chatTitle
		if senderName == "" {
			senderName = username
		}

		posts = append(posts, model.StoredMessage{
			ChatID:      chatID,
			ChatTitle:   chatTitle,
			MessageID:   msgID,
			SenderName:  senderName,
			MessageTime: timeStr,
			Content:     displayContent,
			MediaType:   mediaType,
			RawJSON:     string(rawBytes),
		})
	})

	return posts, nil
}
