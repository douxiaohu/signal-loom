package media

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"time"

	"github.com/disintegration/imaging"
)

var (
	ErrNotFound = errors.New("media not found")
)

// MediaCache 负责下载、磁盘持久化以及等比缩略图生成
type MediaCache struct {
	baseDir    string
	httpClient *http.Client
}

func NewMediaCache(baseDir string) *MediaCache {
	_ = os.MkdirAll(baseDir, 0755)
	return &MediaCache{
		baseDir: baseDir,
		httpClient: &http.Client{
			Timeout: 30 * time.Second,
		},
	}
}

// GetPath 获取媒体在本地磁盘的路径，如果本地没有则自动从 remoteURL 实时下载
func (m *MediaCache) GetPath(chatID, messageID int64, index int, remoteURL string, thumbnail bool) (string, error) {
	dir := filepath.Join(m.baseDir, fmt.Sprintf("%d", chatID))
	_ = os.MkdirAll(dir, 0755)

	ext := filepath.Ext(remoteURL)
	if ext == "" || len(ext) > 5 {
		ext = ".jpg"
	}

	origFileName := fmt.Sprintf("%d_%d%s", messageID, index, ext)
	origPath := filepath.Join(dir, origFileName)

	// 1. 如果本地原图不存在，从远程下载
	if _, err := os.Stat(origPath); os.IsNotExist(err) {
		if remoteURL == "" {
			return "", ErrNotFound
		}
		if err := m.download(remoteURL, origPath); err != nil {
			return "", fmt.Errorf("failed to download media: %w", err)
		}
	}

	// 2. 如果只需要原图，直接返回
	if !thumbnail {
		return origPath, nil
	}

	// 3. 如果需要缩略图，检查是否已有生成好的缩略图
	thumbFileName := fmt.Sprintf("%d_%d_thumb.jpg", messageID, index)
	thumbPath := filepath.Join(dir, thumbFileName)

	if _, err := os.Stat(thumbPath); err == nil {
		return thumbPath, nil
	}

	// 4. 生成等比缩略图（宽度最大 480，高度自适应）
	srcImg, err := imaging.Open(origPath)
	if err != nil {
		// 如果是非图片（比如 mp4 视频），直接回退到原文件
		return origPath, nil
	}

	thumbImg := imaging.Fit(srcImg, 480, 480, imaging.Lanczos)
	if err := imaging.Save(thumbImg, thumbPath); err != nil {
		return origPath, nil
	}

	return thumbPath, nil
}

func (m *MediaCache) download(url, destPath string) error {
	req, err := http.NewRequest(http.MethodGet, url, nil)
	if err != nil {
		return err
	}
	req.Header.Set("User-Agent", "Mozilla/5.0 (compatible; TelegramRadar/1.0)")

	resp, err := m.httpClient.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("bad status %d", resp.StatusCode)
	}

	tmpPath := destPath + ".tmp"
	file, err := os.Create(tmpPath)
	if err != nil {
		return err
	}

	_, err = io.Copy(file, resp.Body)
	file.Close()
	if err != nil {
		_ = os.Remove(tmpPath)
		return err
	}

	return os.Rename(tmpPath, destPath)
}

// MediaHash 生成 URL 的 sha256 唯一指纹
func MediaHash(url string) string {
	sum := sha256.Sum256([]byte(url))
	return hex.EncodeToString(sum[:16])
}

// EnsureDir 快速创建目录
func EnsureDir(path string) error {
	return os.MkdirAll(path, 0755)
}
