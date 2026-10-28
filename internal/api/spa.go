package api

import (
	"bytes"
	"io"
	"io/fs"
	"net/http"
	"path"
	"strings"

	"github.com/go-chi/chi/v5"
)

const (
	immutableCache = "public, max-age=31536000, immutable"
	maxSPAFileSize = 32 << 20
)

// MountSPA serves the built frontend.
//
//   - A request for a file that exists is served as that file. Files under
//     /assets/ carry a content hash in their name, so only they (and only when
//     they really exist) get a one-year "immutable" cache header.
//   - HTML is always revalidated (no-cache) so a new deploy is picked up.
//   - A directory is answered with its index.html, never with a listing.
//   - A path without a file extension that matches nothing is a client-side
//     route: it gets the app shell (admin/index.html below /admin, index.html
//     elsewhere) with status 200 and no redirects.
//   - A missing asset (anything with an extension, or under /assets/) is a
//     plain 404 that caches nowhere. Answering it with index.html, or with a
//     long-lived redirect, would leave browsers holding a poisoned copy of a
//     script URL for a year.
func MountSPA(r chi.Router, fsys fs.FS) {
	h := &spaHandler{fsys: fsys}
	r.Get("/*", h.serve)
}

type spaHandler struct{ fsys fs.FS }

func (h *spaHandler) serve(w http.ResponseWriter, r *http.Request) {
	if r.URL.Path == "/api" || strings.HasPrefix(r.URL.Path, "/api/") {
		notFound(w, "application/json; charset=utf-8", `{"detail":"Not Found"}`)
		return
	}

	// Rooting the path before cleaning resolves any ".." against "/", so the
	// result can never point outside the served directory.
	rel := strings.TrimPrefix(path.Clean("/"+r.URL.Path), "/")
	if rel == "" {
		rel = "."
	}

	if h.tryServe(w, r, rel) {
		return
	}
	if rel == "assets" || strings.HasPrefix(rel, "assets/") || path.Ext(rel) != "" {
		notFound(w, "text/plain; charset=utf-8", "404 page not found\n")
		return
	}
	if rel == "admin" || strings.HasPrefix(rel, "admin/") {
		if h.tryServe(w, r, "admin/index.html") {
			return
		}
	}
	if !h.tryServe(w, r, "index.html") {
		notFound(w, "text/plain; charset=utf-8", "404 page not found\n")
	}
}

// tryServe serves name when it is a file, or a directory containing an
// index.html. It reports whether it wrote a response.
func (h *spaHandler) tryServe(w http.ResponseWriter, r *http.Request, name string) bool {
	f, err := h.fsys.Open(name)
	if err != nil {
		return false
	}
	info, err := f.Stat()
	if err != nil {
		_ = f.Close()
		return false
	}
	if info.IsDir() {
		_ = f.Close()
		if name == "." {
			return h.tryServe(w, r, "index.html")
		}
		return h.tryServe(w, r, path.Join(name, "index.html"))
	}
	defer f.Close()

	rs, ok := f.(io.ReadSeeker)
	if !ok { // file systems whose files cannot seek (rare): buffer it
		data, err := io.ReadAll(io.LimitReader(f, maxSPAFileSize))
		if err != nil {
			return false
		}
		rs = bytes.NewReader(data)
	}

	switch {
	case path.Ext(name) == ".html":
		w.Header().Set("Cache-Control", "no-cache")
	case strings.HasPrefix(name, "assets/"):
		w.Header().Set("Cache-Control", immutableCache)
	default:
		w.Header().Set("Cache-Control", "no-cache")
	}
	http.ServeContent(w, r, info.Name(), info.ModTime(), rs)
	return true
}

func notFound(w http.ResponseWriter, contentType, body string) {
	w.Header().Set("Content-Type", contentType)
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(http.StatusNotFound)
	_, _ = io.WriteString(w, body)
}
