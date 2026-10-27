package api

import (
	"io/fs"
	"net/http"
	"path/filepath"
	"strings"

	"github.com/go-chi/chi/v5"
)

// MountSPA 将前端静态文件目录/嵌入文件系统挂载到 chi 路由上
func MountSPA(r chi.Router, fsys fs.FS) {
	fileServer := http.FileServer(http.FS(fsys))

	r.Get("/*", func(w http.ResponseWriter, r *http.Request) {
		path := r.URL.Path

		// 如果是 API 请求，不需要 SPA 兜底
		if strings.HasPrefix(path, "/api/") {
			http.NotFound(w, r)
			return
		}

		cleanPath := strings.TrimPrefix(filepath.Clean(path), "/")
		if cleanPath == "" || cleanPath == "." {
			cleanPath = "index.html"
		}

		// 检查文件在 fsys 中是否存在
		if file, err := fsys.Open(cleanPath); err == nil {
			_ = file.Close()
			fileServer.ServeHTTP(w, r)
			return
		}

		// SPA 回退机制：
		// 如果访问 /admin 或 /admin/xxx 回退到 admin/index.html
		if strings.HasPrefix(path, "/admin") {
			if adminIndex, err := fsys.Open("admin/index.html"); err == nil {
				_ = adminIndex.Close()
				r.URL.Path = "/admin/index.html"
				fileServer.ServeHTTP(w, r)
				return
			}
		}

		// 公共前台回退到 index.html
		r.URL.Path = "/index.html"
		fileServer.ServeHTTP(w, r)
	})
}
