package media

import (
	"bytes"
	"context"
	"encoding/binary"
	"errors"
	"hash/crc32"
	"image"
	"image/color"
	"image/jpeg"
	"image/png"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func mustParseURL(t *testing.T, raw string) *url.URL {
	t.Helper()
	u, err := url.Parse(raw)
	if err != nil {
		t.Fatal(err)
	}
	return u
}

// testCache trusts exactly one upstream: the given httptest server.
func testCache(t *testing.T, srv *httptest.Server, maxBytes int64) *Cache {
	t.Helper()
	host := mustParseURL(t, srv.URL).Host
	return New(t.TempDir(), Options{
		MaxBytes: maxBytes,
		Client:   srv.Client(),
		AllowURL: func(u *url.URL) bool { return u.Host == host },
	})
}

func refFor(srvURL, path string, id int64) Ref {
	return Ref{ChatID: -900000000001, MessageID: id, Index: 0, URL: srvURL + path}
}

func pngBytes(t *testing.T, w, h int, alpha uint8) []byte {
	t.Helper()
	img := image.NewNRGBA(image.Rect(0, 0, w, h))
	for y := 0; y < h; y++ {
		for x := 0; x < w; x++ {
			img.SetNRGBA(x, y, color.NRGBA{R: uint8(x % 255), G: uint8(y % 255), B: 120, A: alpha})
		}
	}
	var buf bytes.Buffer
	if err := png.Encode(&buf, img); err != nil {
		t.Fatal(err)
	}
	return buf.Bytes()
}

func hugePNGHeader(w, h uint32) []byte {
	var buf bytes.Buffer
	buf.WriteString("\x89PNG\r\n\x1a\n")
	ihdr := make([]byte, 13)
	binary.BigEndian.PutUint32(ihdr[0:], w)
	binary.BigEndian.PutUint32(ihdr[4:], h)
	ihdr[8], ihdr[9] = 8, 6
	chunk := func(typ string, data []byte) {
		_ = binary.Write(&buf, binary.BigEndian, uint32(len(data)))
		buf.WriteString(typ)
		buf.Write(data)
		crc := crc32.NewIEEE()
		crc.Write([]byte(typ))
		crc.Write(data)
		_ = binary.Write(&buf, binary.BigEndian, crc.Sum32())
	}
	chunk("IHDR", ihdr)
	chunk("IEND", nil)
	return buf.Bytes()
}

func serve(ctype string, body []byte, hits *atomic.Int32) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if hits != nil {
			hits.Add(1)
		}
		w.Header().Set("Content-Type", ctype)
		_, _ = w.Write(body)
	}
}

func noTempFiles(t *testing.T, root string) {
	t.Helper()
	_ = filepath.WalkDir(root, func(p string, d os.DirEntry, err error) error {
		if err == nil && !d.IsDir() && strings.HasSuffix(d.Name(), ".tmp") {
			t.Errorf("leftover temp file: %s", p)
		}
		return nil
	})
}

func TestURLPolicy(t *testing.T) {
	c := New(t.TempDir(), Options{})
	allowed := []string{
		"https://cdn1.telesco.pe/file/a.jpg",
		"https://telesco.pe/file/a.jpg",
		"https://CDN4.TELESCO.PE./file/a.jpg",
		"https://cdn5.cdn-telegram.org/file/a.jpg",
		"https://cdn1.telesco.pe:443/file/a.jpg",
	}
	rejected := []string{
		"http://cdn1.telesco.pe/file/a.jpg",        // not https
		"https://example.com/a.jpg",                // other host
		"https://telesco.pe.example.com/a.jpg",     // suffix trick
		"https://eviltelesco.pe/a.jpg",             // not a subdomain
		"https://telesco.pe@evil.example/a.jpg",    // credentials, real host is evil.example
		"https://user:pw@cdn1.telesco.pe/a.jpg",    // credentials are never needed
		"https://cdn1.telesco.pe:8443/a.jpg",       // odd port
		"https://127.0.0.1/a.jpg",                  // address literal
		"https://[::1]/a.jpg",                      // IPv6 literal
		"https://169.254.169.254/latest/meta-data", // cloud metadata
		"ftp://cdn1.telesco.pe/a.jpg",              // other scheme
		"file:///etc/passwd",                       // local file
		"//cdn1.telesco.pe/a.jpg",                  // scheme-relative
		"https:///a.jpg",                           // no host
		"https://localhost/a.jpg",                  // loopback name
		"javascript:alert(1)",                      // script URL
	}
	for _, raw := range allowed {
		if !c.urlAllowed(mustParseURL(t, raw)) {
			t.Errorf("%s should be allowed", raw)
		}
	}
	for _, raw := range rejected {
		if c.urlAllowed(mustParseURL(t, raw)) {
			t.Errorf("%s must be rejected", raw)
		}
	}

	custom := New(t.TempDir(), Options{AllowedHosts: []string{"media.example.org"}})
	if !custom.urlAllowed(mustParseURL(t, "https://a.media.example.org/x.jpg")) ||
		custom.urlAllowed(mustParseURL(t, "https://cdn1.telesco.pe/a.jpg")) {
		t.Error("MEDIA_ALLOWED_HOSTS override is not applied")
	}
}

func TestGetRejectsDisallowedURLsWithoutTouchingTheNetwork(t *testing.T) {
	var hits atomic.Int32
	srv := httptest.NewServer(serve("image/jpeg", []byte("x"), &hits))
	defer srv.Close()

	// Default production policy: the loopback test server must be refused.
	c := New(t.TempDir(), Options{})
	_, err := c.Get(context.Background(), Ref{ChatID: -1, MessageID: 1, URL: srv.URL + "/a.jpg"}, false)
	if !errors.Is(err, ErrURLRejected) {
		t.Fatalf("err = %v, want ErrURLRejected", err)
	}
	if hits.Load() != 0 {
		t.Fatal("a rejected URL was fetched anyway")
	}
	if _, err := c.Get(context.Background(), Ref{ChatID: -1, MessageID: 1}, false); !errors.Is(err, ErrNotFound) {
		t.Fatalf("empty URL: %v", err)
	}
	if _, err := c.Get(context.Background(), Ref{ChatID: -1, MessageID: 1, URL: "::not a url"}, false); !errors.Is(err, ErrURLRejected) {
		t.Fatalf("malformed URL: %v", err)
	}
}

func TestDownloadStoresByContentTypeAndReusesCache(t *testing.T) {
	var hits atomic.Int32
	body := pngBytes(t, 40, 30, 255)
	// The URL claims .html; the extension must still come from the content type.
	srv := httptest.NewServer(serve("image/png; charset=binary", body, &hits))
	defer srv.Close()
	c := testCache(t, srv, 0)

	res, err := c.Get(context.Background(), refFor(srv.URL, "/evil.html", 7), false)
	if err != nil {
		t.Fatal(err)
	}
	if res.ContentType != "image/png" || !strings.HasSuffix(res.Path, ".png") {
		t.Fatalf("result = %+v", res)
	}
	if got, _ := os.ReadFile(res.Path); !bytes.Equal(got, body) {
		t.Fatal("stored bytes differ from upstream")
	}
	if strings.Contains(res.Path, "..") || !strings.Contains(res.Path, "n900000000001") {
		t.Fatalf("unexpected cache path layout: %s", res.Path)
	}

	res2, err := c.Get(context.Background(), refFor(srv.URL, "/evil.html", 7), false)
	if err != nil || res2 != res {
		t.Fatalf("second get = %+v, %v", res2, err)
	}
	if hits.Load() != 1 {
		t.Fatalf("upstream hit %d times, want 1", hits.Load())
	}

	// An edited post (new URL) must not be served from the old cache entry.
	if _, err := c.Get(context.Background(), refFor(srv.URL, "/other.jpg", 7), false); err != nil {
		t.Fatal(err)
	}
	if hits.Load() != 2 {
		t.Fatalf("a new URL for the same message should re-download (hits=%d)", hits.Load())
	}
	noTempFiles(t, c.baseDir)
}

func TestDownloadRejectsBadResponses(t *testing.T) {
	cases := []struct {
		name    string
		handler http.HandlerFunc
		max     int64
		want    error
	}{
		{"html page", serve("text/html", []byte("<script>alert(1)</script>"), nil), 0, ErrUnsupportedType},
		{"svg", serve("image/svg+xml", []byte("<svg onload=alert(1)/>"), nil), 0, ErrUnsupportedType},
		{"no content type", func(w http.ResponseWriter, r *http.Request) {
			w.Header()["Content-Type"] = nil
			_, _ = w.Write([]byte{0xFF, 0xD8, 0xFF, 0xE0})
		}, 0, ErrUnsupportedType},
		{"declared too large", func(w http.ResponseWriter, r *http.Request) {
			w.Header().Set("Content-Type", "image/jpeg")
			w.Header().Set("Content-Length", "5000")
			_, _ = w.Write(make([]byte, 5000))
		}, 1000, ErrTooLarge},
		{"stream too large without length", func(w http.ResponseWriter, r *http.Request) {
			w.Header().Set("Content-Type", "video/mp4")
			f := w.(http.Flusher)
			for i := 0; i < 20; i++ {
				_, _ = w.Write(make([]byte, 500))
				f.Flush()
			}
		}, 1000, ErrTooLarge},
		{"upstream 404", func(w http.ResponseWriter, r *http.Request) { http.NotFound(w, r) }, 0, ErrFetch},
		{"upstream 500", func(w http.ResponseWriter, r *http.Request) { http.Error(w, "boom", 500) }, 0, ErrFetch},
		{"empty body", serve("image/jpeg", nil, nil), 0, ErrFetch},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			srv := httptest.NewServer(tc.handler)
			defer srv.Close()
			c := testCache(t, srv, tc.max)
			_, err := c.Get(context.Background(), refFor(srv.URL, "/x.jpg", 1), false)
			if !errors.Is(err, tc.want) {
				t.Fatalf("err = %v, want %v", err, tc.want)
			}
			noTempFiles(t, c.baseDir)
			if _, ok := c.findOriginal(c.basePath(refFor(srv.URL, "/x.jpg", 1))); ok {
				t.Fatal("a rejected response was cached")
			}
		})
	}
}

func TestFailedDownloadIsNotCachedAndCanRecover(t *testing.T) {
	var calls atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if calls.Add(1) == 1 {
			http.Error(w, "temporarily down", http.StatusBadGateway)
			return
		}
		w.Header().Set("Content-Type", "image/png")
		_, _ = w.Write(pngBytes(t, 10, 10, 255))
	}))
	defer srv.Close()
	c := testCache(t, srv, 0)
	ref := refFor(srv.URL, "/a.png", 3)

	if _, err := c.Get(context.Background(), ref, false); !errors.Is(err, ErrFetch) {
		t.Fatalf("first attempt: %v", err)
	}
	if _, err := c.Get(context.Background(), ref, false); err != nil {
		t.Fatalf("second attempt should succeed once upstream recovers: %v", err)
	}
}

func TestRedirectsAreRevalidated(t *testing.T) {
	var secretHits atomic.Int32
	secret := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		secretHits.Add(1)
		w.Header().Set("Content-Type", "image/png")
		_, _ = w.Write([]byte("internal"))
	}))
	defer secret.Close()
	front := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, secret.URL+"/internal.png", http.StatusFound)
	}))
	defer front.Close()

	frontHost := mustParseURL(t, front.URL).Host
	c := New(t.TempDir(), Options{
		Proxied:  true, // the dial-time check is covered separately; this isolates CheckRedirect
		AllowURL: func(u *url.URL) bool { return u.Host == frontHost },
	})
	_, err := c.Get(context.Background(), refFor(front.URL, "/a.png", 1), false)
	if !errors.Is(err, ErrURLRejected) {
		t.Fatalf("err = %v, want ErrURLRejected", err)
	}
	if secretHits.Load() != 0 {
		t.Fatal("the redirect target was contacted")
	}
}

func TestRedirectLoopIsBounded(t *testing.T) {
	var srv *httptest.Server
	srv = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, srv.URL+r.URL.Path+"x", http.StatusFound)
	}))
	defer srv.Close()
	host := mustParseURL(t, srv.URL).Host
	c := New(t.TempDir(), Options{Proxied: true, AllowURL: func(u *url.URL) bool { return u.Host == host }})
	if _, err := c.Get(context.Background(), refFor(srv.URL, "/a", 1), false); !errors.Is(err, ErrFetch) {
		t.Fatalf("err = %v, want ErrFetch", err)
	}
}

func TestDialerRefusesInternalAddresses(t *testing.T) {
	for _, addr := range []string{
		"127.0.0.1:80", "[::1]:443", "10.0.0.5:443", "172.16.0.1:443", "192.168.1.1:443",
		"169.254.169.254:80", "100.64.0.1:443", "[fc00::1]:443", "[fe80::1]:443",
		"0.0.0.0:80", "[::ffff:127.0.0.1]:80", "224.0.0.1:80",
	} {
		if err := publicAddrOnly("tcp", addr, nil); !errors.Is(err, ErrURLRejected) {
			t.Errorf("%s: err = %v, want ErrURLRejected", addr, err)
		}
	}
	for _, addr := range []string{"8.8.8.8:443", "[2606:4700:4700::1111]:443", "149.154.167.99:443"} {
		if err := publicAddrOnly("tcp", addr, nil); err != nil {
			t.Errorf("%s should be allowed: %v", addr, err)
		}
	}
	if err := publicAddrOnly("tcp", "not-an-address", nil); err == nil {
		t.Error("garbage address accepted")
	}
}

func TestDefaultClientCannotReachLoopbackEvenIfURLPolicyAllowsIt(t *testing.T) {
	var hits atomic.Int32
	srv := httptest.NewServer(serve("image/png", pngBytes(t, 4, 4, 255), &hits))
	defer srv.Close()

	// URL policy deliberately lets the loopback URL through: the connection
	// itself must still be refused (second line of defence against DNS tricks).
	c := New(t.TempDir(), Options{AllowURL: func(*url.URL) bool { return true }})
	_, err := c.Get(context.Background(), refFor(srv.URL, "/a.png", 1), false)
	if !errors.Is(err, ErrURLRejected) {
		t.Fatalf("err = %v, want ErrURLRejected", err)
	}
	if hits.Load() != 0 {
		t.Fatal("the loopback server was reached")
	}
}

func TestConcurrentFirstRequestsShareOneCompleteDownload(t *testing.T) {
	// Regression test: concurrent first requests used to share one ".tmp" file,
	// so one client got a corrupted body and the rest got errors.
	body := bytes.Repeat([]byte("0123456789abcdef"), 64*1024) // 1 MiB
	var hits atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits.Add(1)
		w.Header().Set("Content-Type", "video/mp4")
		w.Header().Set("Content-Length", "1048576")
		f := w.(http.Flusher)
		const step = 256 * 1024
		for i := 0; i < len(body); i += step {
			_, _ = w.Write(body[i : i+step])
			f.Flush()
			time.Sleep(60 * time.Millisecond)
		}
	}))
	defer srv.Close()
	c := testCache(t, srv, 0)

	const clients = 12
	var wg sync.WaitGroup
	start := make(chan struct{})
	errs := make(chan error, clients)
	paths := make(chan string, clients)
	for i := 0; i < clients; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			<-start
			time.Sleep(time.Duration(i) * 20 * time.Millisecond) // staggered, like real traffic
			res, err := c.Get(context.Background(), refFor(srv.URL, "/v.mp4", 9), false)
			if err != nil {
				errs <- err
				return
			}
			got, err := os.ReadFile(res.Path)
			if err != nil {
				errs <- err
				return
			}
			if !bytes.Equal(got, body) {
				errs <- errors.New("client received a corrupted or truncated file")
				return
			}
			paths <- res.Path
		}(i)
	}
	close(start)
	wg.Wait()
	close(errs)
	close(paths)

	for err := range errs {
		t.Error(err)
	}
	if hits.Load() != 1 {
		t.Errorf("upstream served %d downloads for one file, want 1", hits.Load())
	}
	distinct := map[string]bool{}
	for p := range paths {
		distinct[p] = true
	}
	if len(distinct) != 1 {
		t.Errorf("clients got %d different files", len(distinct))
	}
	noTempFiles(t, c.baseDir)
}

func TestConcurrentThumbnailRequestsAreConsistent(t *testing.T) {
	var hits atomic.Int32
	srv := httptest.NewServer(serve("image/png", pngBytes(t, 1600, 900, 255), &hits))
	defer srv.Close()
	c := testCache(t, srv, 0)

	var wg sync.WaitGroup
	results := make([]Result, 10)
	errs := make([]error, 10)
	for i := range results {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			results[i], errs[i] = c.Get(context.Background(), refFor(srv.URL, "/p.png", 5), true)
		}(i)
	}
	wg.Wait()
	for i := range results {
		if errs[i] != nil {
			t.Fatalf("client %d: %v", i, errs[i])
		}
		if results[i] != results[0] {
			t.Fatalf("clients got different results: %+v vs %+v", results[i], results[0])
		}
	}
	f, err := os.Open(results[0].Path)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	cfg, err := jpeg.DecodeConfig(f)
	if err != nil || cfg.Width != 480 || cfg.Height != 270 {
		t.Fatalf("thumbnail = %dx%d, %v; want 480x270 JPEG", cfg.Width, cfg.Height, err)
	}
	if hits.Load() != 1 {
		t.Fatalf("upstream hit %d times", hits.Load())
	}
	noTempFiles(t, c.baseDir)
}

func TestThumbnailBehaviour(t *testing.T) {
	t.Run("small images are not upscaled and keep their ratio", func(t *testing.T) {
		srv := httptest.NewServer(serve("image/png", pngBytes(t, 120, 60, 255), nil))
		defer srv.Close()
		c := testCache(t, srv, 0)
		res, err := c.Get(context.Background(), refFor(srv.URL, "/s.png", 1), true)
		if err != nil || res.ContentType != "image/jpeg" {
			t.Fatalf("%+v %v", res, err)
		}
		f, _ := os.Open(res.Path)
		defer f.Close()
		cfg, err := jpeg.DecodeConfig(f)
		if err != nil || cfg.Width != 120 || cfg.Height != 60 {
			t.Fatalf("thumbnail = %dx%d, %v", cfg.Width, cfg.Height, err)
		}
	})
	t.Run("transparency is flattened onto white", func(t *testing.T) {
		srv := httptest.NewServer(serve("image/png", pngBytes(t, 64, 64, 0), nil))
		defer srv.Close()
		c := testCache(t, srv, 0)
		res, err := c.Get(context.Background(), refFor(srv.URL, "/t.png", 2), true)
		if err != nil {
			t.Fatal(err)
		}
		f, _ := os.Open(res.Path)
		defer f.Close()
		img, err := jpeg.Decode(f)
		if err != nil {
			t.Fatal(err)
		}
		r, g, b, _ := img.At(10, 10).RGBA()
		if r>>8 < 240 || g>>8 < 240 || b>>8 < 240 {
			t.Fatalf("fully transparent pixel became (%d,%d,%d), want white", r>>8, g>>8, b>>8)
		}
	})
	t.Run("videos fall back to the original", func(t *testing.T) {
		srv := httptest.NewServer(serve("video/mp4", []byte("not really a video"), nil))
		defer srv.Close()
		c := testCache(t, srv, 0)
		res, err := c.Get(context.Background(), refFor(srv.URL, "/v.mp4", 3), true)
		if err != nil || res.ContentType != "video/mp4" {
			t.Fatalf("%+v %v", res, err)
		}
	})
	t.Run("an image that cannot be decoded falls back to the original", func(t *testing.T) {
		srv := httptest.NewServer(serve("image/jpeg", []byte("garbage that is not a jpeg"), nil))
		defer srv.Close()
		c := testCache(t, srv, 0)
		res, err := c.Get(context.Background(), refFor(srv.URL, "/g.jpg", 4), true)
		if err != nil || res.ContentType != "image/jpeg" || !strings.HasSuffix(res.Path, ".jpg") || strings.Contains(res.Path, "thumb") {
			t.Fatalf("%+v %v", res, err)
		}
	})
	t.Run("formats outside the allow-list never reach a decoder", func(t *testing.T) {
		// A BMP header served as image/jpeg: sniffing must refuse it.
		bmp := append([]byte("BM"), make([]byte, 64)...)
		srv := httptest.NewServer(serve("image/jpeg", bmp, nil))
		defer srv.Close()
		c := testCache(t, srv, 0)
		ref := refFor(srv.URL, "/b.jpg", 5)
		orig, err := c.Get(context.Background(), ref, false)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := c.makeThumbnail(orig, c.basePath(ref)); !errors.Is(err, errNotDecodable) {
			t.Fatalf("err = %v, want errNotDecodable", err)
		}
	})
	t.Run("decompression bombs are not decoded", func(t *testing.T) {
		srv := httptest.NewServer(serve("image/png", hugePNGHeader(60000, 60000), nil))
		defer srv.Close()
		c := testCache(t, srv, 0)
		ref := refFor(srv.URL, "/bomb.png", 6)
		orig, err := c.Get(context.Background(), ref, false)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := c.makeThumbnail(orig, c.basePath(ref)); !errors.Is(err, errTooManyPixels) {
			t.Fatalf("err = %v, want errTooManyPixels", err)
		}
		// Through the public API the request still succeeds, with the original.
		res, err := c.Get(context.Background(), ref, true)
		if err != nil || res.Path != orig.Path {
			t.Fatalf("%+v %v", res, err)
		}
	})
}

func TestSniffImage(t *testing.T) {
	for want, head := range map[string][]byte{
		"jpeg": {0xFF, 0xD8, 0xFF, 0xE0},
		"png":  []byte("\x89PNG\r\n\x1a\n...."),
		"gif":  []byte("GIF89a...."),
		"webp": []byte("RIFF\x00\x00\x00\x00WEBPVP8 "),
		"":     []byte("BM......"),
	} {
		if got := sniffImage(head); got != want {
			t.Errorf("sniffImage(%q) = %q, want %q", head, got, want)
		}
	}
	if sniffImage([]byte("II*\x00")) != "" || sniffImage(nil) != "" {
		t.Error("TIFF / empty input must not be recognised")
	}
}

func TestCancelledContextDoesNotStartWork(t *testing.T) {
	var hits atomic.Int32
	srv := httptest.NewServer(serve("image/png", pngBytes(t, 4, 4, 255), &hits))
	defer srv.Close()
	c := testCache(t, srv, 0)
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := c.Get(ctx, refFor(srv.URL, "/a.png", 1), false); !errors.Is(err, context.Canceled) {
		t.Fatalf("err = %v", err)
	}
	if hits.Load() != 0 {
		t.Fatal("work was started for a cancelled request")
	}
}

func TestFlightGroupSurvivesPanics(t *testing.T) {
	var g flightGroup
	if _, err := g.do("k", func() (Result, error) { panic("boom") }); err == nil {
		t.Fatal("a panic must surface as an error")
	}
	res, err := g.do("k", func() (Result, error) { return Result{Path: "ok"}, nil })
	if err != nil || res.Path != "ok" {
		t.Fatalf("the key stayed locked after a panic: %+v %v", res, err)
	}
}

func TestCleanTemp(t *testing.T) {
	c := New(t.TempDir(), Options{})
	dir := filepath.Join(c.baseDir, "n1")
	_ = os.MkdirAll(dir, 0o755)
	oldTmp := filepath.Join(dir, ".dl-old.tmp")
	newTmp := filepath.Join(dir, ".dl-new.tmp")
	keep := filepath.Join(dir, "1_0_abc.jpg")
	for _, p := range []string{oldTmp, newTmp, keep} {
		if err := os.WriteFile(p, []byte("x"), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	past := time.Now().Add(-3 * time.Hour)
	_ = os.Chtimes(oldTmp, past, past)
	_ = os.Chtimes(keep, past, past)

	if n := c.CleanTemp(time.Hour); n != 1 {
		t.Fatalf("removed %d files, want 1", n)
	}
	for p, wantExists := range map[string]bool{oldTmp: false, newTmp: true, keep: true} {
		if _, err := os.Stat(p); (err == nil) != wantExists {
			t.Errorf("%s exists=%v, want %v", filepath.Base(p), err == nil, wantExists)
		}
	}
}
