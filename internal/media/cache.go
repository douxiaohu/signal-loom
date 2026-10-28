// Package media downloads, stores and thumbnails the images and videos that
// crawled posts point to.
//
// The cache fetches URLs that came out of scraped HTML, so it treats them as
// untrusted input: only https URLs on an allow-listed set of Telegram CDN hosts
// are fetched, redirects are re-checked, connections to loopback/private
// addresses are refused, the content type must be an image or video, and the
// size is capped. Concurrent requests for the same file share a single
// download that is written to a private temp file and renamed into place, so
// nobody ever sees a half-written file.
package media

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"image"
	"image/color"
	_ "image/gif" // decoder for GIF thumbnails
	"image/jpeg"
	_ "image/png" // decoder for PNG thumbnails
	"io"
	"io/fs"
	"log"
	"net"
	"net/http"
	"net/netip"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/disintegration/imaging"

	"telegram-radar/internal/config"
)

var (
	ErrNotFound        = errors.New("media not found")
	ErrURLRejected     = errors.New("media URL is not allowed")
	ErrUnsupportedType = errors.New("unsupported media type")
	ErrTooLarge        = errors.New("media file is too large")
	ErrFetch           = errors.New("failed to fetch media")

	errNotDecodable  = errors.New("not a decodable image")
	errTooManyPixels = errors.New("image has too many pixels to thumbnail")
)

const (
	downloadTimeout  = 45 * time.Second
	maxRedirects     = 3
	thumbSize        = 480
	jpegQuality      = 82
	maxThumbPixels   = 40_000_000 // ~160 MB as RGBA; larger images are served as they are
	maxParallelFetch = 6
	maxParallelThumb = 4
)

// typeToExt lists what may be stored. The extension always comes from the
// validated Content-Type, never from the URL.
var typeToExt = map[string]string{
	"image/jpeg":      ".jpg",
	"image/png":       ".png",
	"image/webp":      ".webp",
	"image/gif":       ".gif",
	"video/mp4":       ".mp4",
	"video/webm":      ".webm",
	"video/quicktime": ".mov",
	"video/x-m4v":     ".m4v",
}

var extToType = func() map[string]string {
	m := make(map[string]string, len(typeToExt))
	for t, e := range typeToExt {
		m[e] = t
	}
	return m
}()

// knownExts is the order in which cached originals are looked up.
var knownExts = []string{".jpg", ".png", ".webp", ".gif", ".mp4", ".webm", ".mov", ".m4v"}

var cgnat = netip.MustParsePrefix("100.64.0.0/10")

// Ref identifies one media item of one stored message.
type Ref struct {
	ChatID    int64  // source chat id (cache sub-directory)
	MessageID int64  // database id of the message
	Index     int    // position inside the message's media items
	URL       string // upstream URL taken from raw_json
}

// Result is a file on disk together with the content type to serve it as.
type Result struct {
	Path        string
	ContentType string
}

// Options configures a Cache. The zero value gives the production policy.
type Options struct {
	AllowedHosts []string // hostnames (and their subdomains); default config.DefaultMediaHosts
	MaxBytes     int64    // per-file cap; default config.DefaultMediaMaxBytes
	// Proxied disables the dial-time private-address check, because with an
	// HTTP proxy the dialed address is the proxy's, not the target's. The host
	// allow-list still applies. Set it when HTTPS_PROXY / HTTP_PROXY is in use.
	Proxied bool

	// Test hooks.
	Client   *http.Client
	AllowURL func(*url.URL) bool
}

// Cache is safe for concurrent use.
type Cache struct {
	baseDir  string
	hosts    []string
	maxBytes int64
	client   *http.Client
	allowURL func(*url.URL) bool

	flight   flightGroup
	fetchSem chan struct{}
	thumbSem chan struct{}
}

// New creates a cache rooted at baseDir.
func New(baseDir string, opts Options) *Cache {
	if err := os.MkdirAll(baseDir, 0o755); err != nil {
		log.Printf("[media] cannot create cache directory %s: %v", baseDir, err)
	}
	c := &Cache{
		baseDir:  baseDir,
		hosts:    opts.AllowedHosts,
		maxBytes: opts.MaxBytes,
		allowURL: opts.AllowURL,
		fetchSem: make(chan struct{}, maxParallelFetch),
		thumbSem: make(chan struct{}, maxParallelThumb),
	}
	if len(c.hosts) == 0 {
		c.hosts = config.DefaultMediaHosts
	}
	if c.maxBytes <= 0 {
		c.maxBytes = config.DefaultMediaMaxBytes
	}
	c.client = opts.Client
	if c.client == nil {
		c.client = newClient(c.urlAllowed, opts.Proxied)
	}
	return c
}

// urlAllowed is the fetch policy: https on port 443 to an allow-listed host,
// no credentials in the URL.
func (c *Cache) urlAllowed(u *url.URL) bool {
	if c.allowURL != nil {
		return c.allowURL(u)
	}
	if u == nil || u.Scheme != "https" || u.User != nil {
		return false
	}
	if port := u.Port(); port != "" && port != "443" {
		return false
	}
	return hostAllowed(u.Hostname(), c.hosts)
}

func hostAllowed(host string, allowed []string) bool {
	host = strings.ToLower(strings.TrimSuffix(host, "."))
	if host == "" {
		return false
	}
	for _, a := range allowed {
		if host == a || strings.HasSuffix(host, "."+a) {
			return true
		}
	}
	return false
}

func newClient(allow func(*url.URL) bool, proxied bool) *http.Client {
	tr := http.DefaultTransport.(*http.Transport).Clone()
	if !proxied {
		tr.DialContext = (&net.Dialer{
			Timeout:   10 * time.Second,
			KeepAlive: 30 * time.Second,
			Control:   publicAddrOnly,
		}).DialContext
	}
	return &http.Client{
		Timeout:   downloadTimeout,
		Transport: tr,
		CheckRedirect: func(req *http.Request, via []*http.Request) error {
			if len(via) > maxRedirects {
				return fmt.Errorf("%w: too many redirects", ErrFetch)
			}
			if !allow(req.URL) {
				return fmt.Errorf("%w: redirect to %s", ErrURLRejected, req.URL.Host)
			}
			return nil
		},
	}
}

// publicAddrOnly runs after name resolution, for every connection attempt, so
// a hostname that resolves to an internal address (DNS rebinding included) is
// refused.
func publicAddrOnly(_, address string, _ syscall.RawConn) error {
	host, _, err := net.SplitHostPort(address)
	if err != nil {
		return err
	}
	ip, err := netip.ParseAddr(host)
	if err != nil {
		return fmt.Errorf("%w: %q is not an IP address", ErrURLRejected, host)
	}
	if !isPublicIP(ip) {
		return fmt.Errorf("%w: refusing to connect to %s", ErrURLRejected, ip)
	}
	return nil
}

func isPublicIP(ip netip.Addr) bool {
	ip = ip.Unmap()
	if !ip.IsValid() || ip.IsLoopback() || ip.IsPrivate() || ip.IsLinkLocalUnicast() ||
		ip.IsLinkLocalMulticast() || ip.IsInterfaceLocalMulticast() || ip.IsMulticast() || ip.IsUnspecified() {
		return false
	}
	return !cgnat.Contains(ip)
}

// basePath is the cache key of one media item. The upstream URL is part of
// it, so a message whose media was edited does not keep serving the old file.
func (c *Cache) basePath(ref Ref) string {
	sum := sha256.Sum256([]byte(fmt.Sprintf("%d:%d:%s", ref.MessageID, ref.Index, ref.URL)))
	digest := hex.EncodeToString(sum[:])[:32]
	chat := strings.ReplaceAll(strconv.FormatInt(ref.ChatID, 10), "-", "n")
	return filepath.Join(c.baseDir, chat, fmt.Sprintf("%d_%d_%s", ref.MessageID, ref.Index, digest))
}

// Get returns the cached file for ref, downloading it first when needed. With
// thumbnail set, images are returned as a small JPEG; anything that cannot be
// thumbnailed (videos, undecodable or huge images) falls back to the original.
func (c *Cache) Get(ctx context.Context, ref Ref, thumbnail bool) (Result, error) {
	if ref.URL == "" {
		return Result{}, ErrNotFound
	}
	u, err := url.Parse(ref.URL)
	if err != nil || !c.urlAllowed(u) {
		return Result{}, ErrURLRejected
	}
	if err := ctx.Err(); err != nil {
		return Result{}, err
	}

	base := c.basePath(ref)
	orig, err := c.flight.do("o:"+base, func() (Result, error) { return c.fetchOriginal(u, base) })
	if err != nil {
		return Result{}, err
	}
	if !thumbnail || !strings.HasPrefix(orig.ContentType, "image/") {
		return orig, nil
	}
	thumb, err := c.flight.do("t:"+base, func() (Result, error) { return c.makeThumbnail(orig, base) })
	if err != nil {
		return orig, nil
	}
	return thumb, nil
}

func (c *Cache) findOriginal(base string) (Result, bool) {
	for _, ext := range knownExts {
		if fi, err := os.Stat(base + ext); err == nil && fi.Mode().IsRegular() && fi.Size() > 0 {
			return Result{Path: base + ext, ContentType: extToType[ext]}, true
		}
	}
	return Result{}, false
}

func (c *Cache) fetchOriginal(u *url.URL, base string) (Result, error) {
	if res, ok := c.findOriginal(base); ok {
		return res, nil
	}
	c.fetchSem <- struct{}{}
	defer func() { <-c.fetchSem }()
	if res, ok := c.findOriginal(base); ok { // finished while we waited for a slot
		return res, nil
	}
	return c.download(u, base)
}

func (c *Cache) download(u *url.URL, base string) (Result, error) {
	ctx, cancel := context.WithTimeout(context.Background(), downloadTimeout)
	defer cancel()

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u.String(), nil)
	if err != nil {
		return Result{}, ErrURLRejected
	}
	req.Header.Set("User-Agent", "Mozilla/5.0 (compatible; TelegramRadar/1.0)")

	resp, err := c.client.Do(req)
	if err != nil {
		if errors.Is(err, ErrURLRejected) {
			return Result{}, ErrURLRejected
		}
		return Result{}, fmt.Errorf("%w: %v", ErrFetch, err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return Result{}, fmt.Errorf("%w: upstream status %d", ErrFetch, resp.StatusCode)
	}
	ctype := normalizeContentType(resp.Header.Get("Content-Type"))
	ext, ok := typeToExt[ctype]
	if !ok {
		return Result{}, fmt.Errorf("%w: %q", ErrUnsupportedType, ctype)
	}
	if resp.ContentLength > c.maxBytes {
		return Result{}, ErrTooLarge
	}

	dir := filepath.Dir(base)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return Result{}, fmt.Errorf("%w: %v", ErrFetch, err)
	}
	tmp, err := os.CreateTemp(dir, ".dl-*.tmp")
	if err != nil {
		return Result{}, fmt.Errorf("%w: %v", ErrFetch, err)
	}
	tmpName := tmp.Name()
	cleanup := func() { _ = os.Remove(tmpName) }

	n, err := io.Copy(tmp, io.LimitReader(resp.Body, c.maxBytes+1))
	if cerr := tmp.Close(); err == nil {
		err = cerr
	}
	if err != nil {
		cleanup()
		return Result{}, fmt.Errorf("%w: %v", ErrFetch, err)
	}
	if n > c.maxBytes {
		cleanup()
		return Result{}, ErrTooLarge
	}
	if n == 0 {
		cleanup()
		return Result{}, fmt.Errorf("%w: empty response", ErrFetch)
	}
	if err := os.Chmod(tmpName, 0o644); err != nil {
		cleanup()
		return Result{}, fmt.Errorf("%w: %v", ErrFetch, err)
	}
	final := base + ext
	if err := os.Rename(tmpName, final); err != nil {
		cleanup()
		return Result{}, fmt.Errorf("%w: %v", ErrFetch, err)
	}
	return Result{Path: final, ContentType: ctype}, nil
}

func normalizeContentType(v string) string {
	if i := strings.IndexByte(v, ';'); i >= 0 {
		v = v[:i]
	}
	return strings.ToLower(strings.TrimSpace(v))
}

// sniffImage recognises the formats the thumbnailer is willing to decode by
// their magic bytes. Anything else (BMP, TIFF, ...) is never handed to a
// decoder, whatever the Content-Type claimed.
func sniffImage(head []byte) string {
	switch {
	case bytes.HasPrefix(head, []byte{0xFF, 0xD8, 0xFF}):
		return "jpeg"
	case bytes.HasPrefix(head, []byte("\x89PNG\r\n\x1a\n")):
		return "png"
	case bytes.HasPrefix(head, []byte("GIF87a")), bytes.HasPrefix(head, []byte("GIF89a")):
		return "gif"
	case len(head) >= 12 && string(head[0:4]) == "RIFF" && string(head[8:12]) == "WEBP":
		return "webp"
	}
	return ""
}

func (c *Cache) makeThumbnail(orig Result, base string) (Result, error) {
	path := base + ".thumb.jpg"
	if fi, err := os.Stat(path); err == nil && fi.Mode().IsRegular() && fi.Size() > 0 {
		return Result{Path: path, ContentType: "image/jpeg"}, nil
	}

	c.thumbSem <- struct{}{}
	defer func() { <-c.thumbSem }()
	if fi, err := os.Stat(path); err == nil && fi.Mode().IsRegular() && fi.Size() > 0 {
		return Result{Path: path, ContentType: "image/jpeg"}, nil
	}

	f, err := os.Open(orig.Path)
	if err != nil {
		return Result{}, err
	}
	defer f.Close()

	head := make([]byte, 16)
	n, _ := io.ReadFull(f, head)
	if sniffImage(head[:n]) == "" {
		return Result{}, errNotDecodable
	}
	if _, err := f.Seek(0, io.SeekStart); err != nil {
		return Result{}, err
	}
	cfg, _, err := image.DecodeConfig(f)
	if err != nil {
		return Result{}, errNotDecodable
	}
	if cfg.Width <= 0 || cfg.Height <= 0 || int64(cfg.Width)*int64(cfg.Height) > maxThumbPixels {
		return Result{}, errTooManyPixels
	}
	if _, err := f.Seek(0, io.SeekStart); err != nil {
		return Result{}, err
	}
	img, err := imaging.Decode(f)
	if err != nil {
		return Result{}, errNotDecodable
	}

	thumb := imaging.Fit(img, thumbSize, thumbSize, imaging.Lanczos)
	// JPEG has no alpha channel: composite on white instead of letting
	// transparent areas turn black.
	flat := imaging.Overlay(imaging.New(thumb.Bounds().Dx(), thumb.Bounds().Dy(), color.White), thumb, image.Pt(0, 0), 1.0)

	tmp, err := os.CreateTemp(filepath.Dir(path), ".thumb-*.tmp")
	if err != nil {
		return Result{}, err
	}
	tmpName := tmp.Name()
	if err := jpeg.Encode(tmp, flat, &jpeg.Options{Quality: jpegQuality}); err != nil {
		_ = tmp.Close()
		_ = os.Remove(tmpName)
		return Result{}, err
	}
	if err := tmp.Close(); err != nil {
		_ = os.Remove(tmpName)
		return Result{}, err
	}
	if err := os.Chmod(tmpName, 0o644); err != nil {
		_ = os.Remove(tmpName)
		return Result{}, err
	}
	if err := os.Rename(tmpName, path); err != nil {
		_ = os.Remove(tmpName)
		return Result{}, err
	}
	return Result{Path: path, ContentType: "image/jpeg"}, nil
}

// CleanTemp removes temp files left behind by a crash. It returns how many
// files were deleted.
func (c *Cache) CleanTemp(olderThan time.Duration) int {
	cutoff := time.Now().Add(-olderThan)
	removed := 0
	_ = filepath.WalkDir(c.baseDir, func(path string, d fs.DirEntry, err error) error {
		if err != nil || d.IsDir() {
			return nil
		}
		name := d.Name()
		if strings.HasPrefix(name, ".") && strings.HasSuffix(name, ".tmp") {
			if info, err := d.Info(); err == nil && info.ModTime().Before(cutoff) && os.Remove(path) == nil {
				removed++
			}
		}
		return nil
	})
	return removed
}

// flightGroup collapses concurrent calls with the same key into one execution;
// every caller receives the shared result.
type flightGroup struct {
	mu    sync.Mutex
	calls map[string]*flightCall
}

type flightCall struct {
	done chan struct{}
	res  Result
	err  error
}

func (g *flightGroup) do(key string, fn func() (Result, error)) (res Result, err error) {
	g.mu.Lock()
	if g.calls == nil {
		g.calls = make(map[string]*flightCall)
	}
	if call, ok := g.calls[key]; ok {
		g.mu.Unlock()
		<-call.done
		return call.res, call.err
	}
	call := &flightCall{done: make(chan struct{})}
	g.calls[key] = call
	g.mu.Unlock()

	// Whatever happens in fn (including a panic), waiting callers must be
	// released and the key freed, or later requests would block forever.
	defer func() {
		if rec := recover(); rec != nil {
			res, err = Result{}, fmt.Errorf("media: panic: %v", rec)
		}
		call.res, call.err = res, err
		g.mu.Lock()
		delete(g.calls, key)
		g.mu.Unlock()
		close(call.done)
	}()
	return fn()
}
