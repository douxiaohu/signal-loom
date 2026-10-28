package api

import (
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"testing/fstest"
	"time"
)

var spaModTime = time.Date(2026, 10, 27, 18, 14, 0, 0, time.UTC)

func spaFS() fstest.MapFS {
	file := func(body string) *fstest.MapFile { return &fstest.MapFile{Data: []byte(body), ModTime: spaModTime} }
	return fstest.MapFS{
		"index.html":                    file("<html>PUBLIC-SHELL</html>"),
		"admin/index.html":              file("<html>ADMIN-SHELL</html>"),
		"assets/public-AbC123.js":       file("console.log('public')"),
		"assets/styles-XyZ789.css":      file("body{margin:0}"),
		"assets/geist-latin-Qw12.woff2": file("wOF2....."),
		"favicon.svg":                   file("<svg xmlns='http://www.w3.org/2000/svg'/>"),
	}
}

func TestSPAServesTheAppShellWithRevalidatingCaching(t *testing.T) {
	h := newHarnessWithStatic(t, spaFS())

	for _, path := range []string{"/", "/index.html"} {
		rec := h.do("GET", path, nil)
		if rec.Code != 200 || !strings.Contains(rec.Body.String(), "PUBLIC-SHELL") {
			t.Errorf("GET %s = %d %q", path, rec.Code, rec.Body.String())
		}
		if rec.Header().Get("Cache-Control") != "no-cache" || !strings.HasPrefix(rec.Header().Get("Content-Type"), "text/html") {
			t.Errorf("GET %s headers: %v", path, rec.Header())
		}
		if rec.Header().Get("Location") != "" {
			t.Errorf("GET %s redirected to %q", path, rec.Header().Get("Location"))
		}
		if !strings.Contains(rec.Header().Get("Content-Security-Policy"), "script-src 'self'") {
			t.Errorf("GET %s has no CSP", path)
		}
	}
	head := h.do("HEAD", "/", nil)
	if head.Code != 200 || head.Body.Len() != 0 {
		t.Errorf("HEAD / = %d with %d body bytes", head.Code, head.Body.Len())
	}

	// Conditional requests work, so the revalidation stays cheap.
	rec := h.do("GET", "/", nil, withHeader("If-Modified-Since", spaModTime.Add(time.Hour).Format(http.TimeFormat)))
	if rec.Code != 304 {
		t.Errorf("If-Modified-Since: status %d, want 304", rec.Code)
	}
}

func TestOnlyRealHashedAssetsGetImmutableCaching(t *testing.T) {
	h := newHarnessWithStatic(t, spaFS())

	for path, wantType := range map[string]string{
		"/assets/public-AbC123.js":       "javascript",
		"/assets/styles-XyZ789.css":      "text/css",
		"/assets/geist-latin-Qw12.woff2": "",
	} {
		rec := h.do("GET", path, nil)
		if rec.Code != 200 || rec.Header().Get("Cache-Control") != "public, max-age=31536000, immutable" {
			t.Errorf("GET %s = %d, Cache-Control %q", path, rec.Code, rec.Header().Get("Cache-Control"))
		}
		if wantType != "" && !strings.Contains(rec.Header().Get("Content-Type"), wantType) {
			t.Errorf("GET %s Content-Type = %q", path, rec.Header().Get("Content-Type"))
		}
	}
	if rec := h.do("GET", "/favicon.svg", nil); rec.Code != 200 || rec.Header().Get("Cache-Control") != "no-cache" ||
		rec.Header().Get("Content-Type") != "image/svg+xml" {
		t.Errorf("favicon: %d %v", rec.Code, rec.Header())
	}

	// Range requests (media players, resumed downloads) work.
	rec := h.do("GET", "/assets/public-AbC123.js", nil, withHeader("Range", "bytes=0-6"))
	if rec.Code != 206 || rec.Body.String() != "console" {
		t.Errorf("Range: %d %q", rec.Code, rec.Body.String())
	}
}

func TestMissingAssetsAreRealNotFoundsNeverCachedAndNeverRedirected(t *testing.T) {
	// Regression: a stale bundle name after a deploy used to get a one-year
	// "immutable" 301 (to the directory listing of /assets/), which browsers
	// then kept.
	h := newHarnessWithStatic(t, spaFS())
	for _, path := range []string{
		"/assets/index-OLDHASH.js", "/assets/missing.css", "/assets/nested/dir/file.js",
		"/missing.png", "/robots.txt", "/sourcemap.js.map", "/assets", "/assets/",
	} {
		rec := h.do("GET", path, nil)
		if rec.Code != 404 {
			t.Errorf("GET %s = %d, want 404", path, rec.Code)
		}
		if rec.Header().Get("Location") != "" {
			t.Errorf("GET %s redirects to %q", path, rec.Header().Get("Location"))
		}
		if cc := rec.Header().Get("Cache-Control"); cc != "no-store" {
			t.Errorf("GET %s Cache-Control = %q, a 404 must not be cacheable", path, cc)
		}
		if strings.Contains(rec.Body.String(), "SHELL") {
			t.Errorf("GET %s answered with an HTML shell, which would be cached as a script", path)
		}
	}
}

func TestDirectoriesAreNeverListed(t *testing.T) {
	h := newHarnessWithStatic(t, spaFS())
	for _, path := range []string{"/assets/", "/assets", "/admin/../assets/"} {
		rec := h.do("GET", path, nil)
		body := rec.Body.String()
		if strings.Contains(body, "public-AbC123.js") || strings.Contains(body, "<a href=") {
			t.Errorf("GET %s lists the directory: %s", path, body)
		}
	}
}

func TestClientSideRoutesGetTheShellWithoutRedirects(t *testing.T) {
	h := newHarnessWithStatic(t, spaFS())
	cases := map[string]string{
		"/sources":             "PUBLIC-SHELL",
		"/feed/some/deep/link": "PUBLIC-SHELL", // used to loop through 301s
		"/feed/":               "PUBLIC-SHELL",
		"/administrator":       "PUBLIC-SHELL", // not under /admin
		"/admin":               "ADMIN-SHELL",
		"/admin/":              "ADMIN-SHELL",
		"/admin/alerts":        "ADMIN-SHELL",
		"/admin/a/b/c":         "ADMIN-SHELL",
		"/admin/index.html":    "ADMIN-SHELL",
	}
	for path, want := range cases {
		rec := h.do("GET", path, nil)
		if rec.Code != 200 || !strings.Contains(rec.Body.String(), want) || rec.Header().Get("Location") != "" {
			t.Errorf("GET %s = %d (Location %q), body %q; want 200 %s", path, rec.Code, rec.Header().Get("Location"), rec.Body.String(), want)
		}
		if rec.Header().Get("Cache-Control") != "no-cache" {
			t.Errorf("GET %s Cache-Control = %q", path, rec.Header().Get("Cache-Control"))
		}
	}

	// Without an admin build the admin routes fall back to the public shell.
	fsys := spaFS()
	delete(fsys, "admin/index.html")
	noAdmin := newHarnessWithStatic(t, fsys)
	if rec := noAdmin.do("GET", "/admin/x", nil); rec.Code != 200 || !strings.Contains(rec.Body.String(), "PUBLIC-SHELL") {
		t.Errorf("admin fallback: %d %q", rec.Code, rec.Body.String())
	}
}

func TestAPIPathsAreNeverShadowedByTheShell(t *testing.T) {
	h := newHarnessWithStatic(t, spaFS())
	for _, path := range []string{"/api", "/api/", "/api/nope", "/api/admin/nope", "/api/public/nope/deeper"} {
		rec := h.do("GET", path, nil)
		if rec.Code != 404 || strings.Contains(rec.Body.String(), "SHELL") || detailOf(t, rec) == "" {
			t.Errorf("GET %s = %d %q, want a JSON 404", path, rec.Code, rec.Body.String())
		}
	}
	if rec := h.do("POST", "/definitely/not/here", map[string]any{}); rec.Code != 404 && rec.Code != 405 {
		t.Errorf("POST to a static path = %d", rec.Code)
	}
}

func TestStaticServerCannotEscapeItsRoot(t *testing.T) {
	root := t.TempDir()
	dist := filepath.Join(root, "dist")
	if err := os.MkdirAll(filepath.Join(dist, "assets"), 0o755); err != nil {
		t.Fatal(err)
	}
	must := func(path, body string) {
		if err := os.WriteFile(path, []byte(body), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	must(filepath.Join(dist, "index.html"), "<html>SHELL</html>")
	must(filepath.Join(root, "secret.txt"), "TOP-SECRET-OUTSIDE-DIST")
	must(filepath.Join(root, "secret"), "TOP-SECRET-OUTSIDE-DIST")
	must(filepath.Join(dist, "assets", "app-1.js"), "ok")

	h := newHarnessWithStatic(t, os.DirFS(dist))
	for _, path := range []string{
		"/../secret.txt", "/../../secret.txt", "/assets/../../secret.txt", "/%2e%2e/secret.txt",
		"/..%2fsecret.txt", "/assets/%2e%2e/%2e%2e/secret", "/....//secret.txt", "/assets/..\\..\\secret.txt",
		"/..;/secret.txt", "//secret.txt", "/./../secret",
	} {
		rec := h.do("GET", path, nil)
		if strings.Contains(rec.Body.String(), "TOP-SECRET") {
			t.Errorf("GET %s leaked a file outside the static root", path)
		}
	}
	if rec := h.do("GET", "/assets/app-1.js", nil); rec.Code != 200 || rec.Body.String() != "ok" {
		t.Errorf("legitimate asset: %d %q", rec.Code, rec.Body.String())
	}
}
