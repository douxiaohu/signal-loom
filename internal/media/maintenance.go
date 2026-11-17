package media

import (
	"context"
	"io/fs"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"time"
)

// Only files produced by basePath/makeThumbnail are eligible; never follow symlinks.
var cacheName = regexp.MustCompile(`^[0-9]+_[0-9]+_[a-f0-9]{32}(\.thumb)?\.(jpg|png|webp|gif|mp4|webm|mov|m4v)$`)

type Usage struct {
	Bytes      int64 `json:"bytes"`
	Files      int   `json:"files"`
	MaxBytes   int64 `json:"max_bytes"`
	MaxAgeDays int   `json:"max_age_days"`
	Removed    int   `json:"removed"`
}

type cachedFile struct {
	path     string
	size     int64
	modified time.Time
}

func touch(path string) {
	// Coarse access time avoids a metadata write on every request.
	if info, err := os.Stat(path); err == nil && time.Since(info.ModTime()) > time.Hour {
		now := time.Now()
		_ = os.Chtimes(path, now, now)
	}
}

// Open obtains an OS file handle before eviction can unlink its name.
func (c *Cache) Open(ctx context.Context, ref Ref, thumbnail bool) (*os.File, Result, error) {
	c.maintenance.RLock()
	defer c.maintenance.RUnlock()
	res, err := c.get(ctx, ref, thumbnail)
	if err != nil {
		return nil, res, err
	}
	touch(res.Path)
	f, err := os.Open(res.Path)
	return f, res, err
}

func (c *Cache) files() ([]cachedFile, error) {
	var files []cachedFile
	err := filepath.WalkDir(c.baseDir, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if d.IsDir() || !d.Type().IsRegular() || !cacheName.MatchString(d.Name()) {
			return nil
		}
		info, err := d.Info()
		if err != nil {
			return err
		}
		files = append(files, cachedFile{path, info.Size(), info.ModTime()})
		return nil
	})
	return files, err
}

func (c *Cache) Usage(maxBytes int64, maxAge time.Duration) (Usage, error) {
	c.maintenance.RLock()
	defer c.maintenance.RUnlock()
	files, err := c.files()
	u := Usage{Files: len(files), MaxBytes: maxBytes, MaxAgeDays: int(maxAge / (24 * time.Hour))}
	for _, f := range files {
		u.Bytes += f.size
	}
	return u, err
}

// Prune evicts least recently used files and expired entries; messages are untouched.
func (c *Cache) Prune(maxBytes int64, maxAge time.Duration) (Usage, error) {
	c.maintenance.Lock()
	defer c.maintenance.Unlock()
	files, err := c.files()
	if err != nil {
		return Usage{}, err
	}
	sort.Slice(files, func(i, j int) bool { return files[i].modified.Before(files[j].modified) })
	u := Usage{Files: len(files), MaxBytes: maxBytes, MaxAgeDays: int(maxAge / (24 * time.Hour))}
	for _, f := range files {
		u.Bytes += f.size
	}
	cutoff := time.Now().Add(-maxAge)
	for _, f := range files {
		if !(maxAge > 0 && f.modified.Before(cutoff)) && !(maxBytes > 0 && u.Bytes > maxBytes) {
			continue
		}
		if err := os.Remove(f.path); err != nil {
			if os.IsNotExist(err) {
				continue
			}
			return u, err
		}
		u.Bytes -= f.size
		u.Files--
		u.Removed++
	}
	return u, nil
}

// InitializeRetention gives legacy files a full retention window when the policy
// is first enabled. The marker is written only after every legacy timestamp is safe.
func (c *Cache) InitializeRetention(maxAge time.Duration) (int, error) {
	c.maintenance.Lock()
	defer c.maintenance.Unlock()
	marker := filepath.Join(c.baseDir, ".retention-policy-v1")
	if _, err := os.Lstat(marker); err == nil {
		return 0, nil
	} else if !os.IsNotExist(err) {
		return 0, err
	}
	files, err := c.files()
	if err != nil {
		return 0, err
	}
	now := time.Now()
	adopted := 0
	for _, file := range files {
		if maxAge > 0 && file.modified.Before(now.Add(-maxAge)) {
			if err := os.Chtimes(file.path, now, now); err != nil {
				return adopted, err
			}
			adopted++
		}
	}
	f, err := os.OpenFile(marker, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
	if err != nil {
		return adopted, err
	}
	_, err = f.WriteString(now.UTC().Format(time.RFC3339))
	closeErr := f.Close()
	if err != nil {
		return adopted, err
	}
	return adopted, closeErr
}
