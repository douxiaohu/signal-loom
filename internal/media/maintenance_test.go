package media

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestCachePruneHonorsQuotaAgeAndFileBoundary(t *testing.T) {
	cache := New(t.TempDir(), Options{})
	old := filepath.Join(cache.baseDir, "1_0_"+strings.Repeat("a", 32)+".jpg")
	fresh := filepath.Join(cache.baseDir, "2_0_"+strings.Repeat("b", 32)+".thumb.jpg")
	sentinel := filepath.Join(cache.baseDir, "important.jpg")
	for _, path := range []string{old, fresh, sentinel} {
		if err := os.WriteFile(path, []byte("1234567890"), 0600); err != nil {
			t.Fatal(err)
		}
	}
	ancient := time.Now().Add(-48 * time.Hour)
	_ = os.Chtimes(old, ancient, ancient)
	usage, err := cache.Prune(100, 24*time.Hour)
	if err != nil || usage.Removed != 1 || usage.Bytes != 10 {
		t.Fatalf("age pruning: %+v %v", usage, err)
	}
	if _, err = os.Stat(sentinel); err != nil {
		t.Fatal("Unrelated cache-directory file was deleted")
	}
	usage, err = cache.Prune(5, 24*time.Hour)
	if err != nil || usage.Removed != 1 || usage.Bytes != 0 {
		t.Fatalf("quota pruning: %+v %v", usage, err)
	}
}
func TestOpenMediaSurvivesEvictionAndCanRedownload(t *testing.T) {
	data := pngBytes(t, 30, 20, 255)
	hits := 0
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits++
		w.Header().Set("Content-Type", "image/png")
		_, _ = w.Write(data)
	}))
	defer upstream.Close()
	cache := testCache(t, upstream, 1<<20)
	ref := refFor(upstream.URL, "/photo", 1)
	file, _, err := cache.Open(context.Background(), ref, false)
	if err != nil {
		t.Fatal(err)
	}
	defer file.Close()
	if _, err = cache.Prune(1, 0); err != nil {
		t.Fatal(err)
	}
	got, err := io.ReadAll(file)
	if err != nil || len(got) != len(data) {
		t.Fatal("Eviction interrupted an open transfer")
	}
	if _, err = cache.Get(context.Background(), ref, false); err != nil {
		t.Fatal(err)
	}
	if hits != 2 {
		t.Fatalf("Expected cache miss after eviction; got %d downloads", hits)
	}
}

func TestRetentionAdoptionGrantsLegacyFilesOneWindow(t *testing.T) {
	cache := New(t.TempDir(), Options{})
	path := filepath.Join(cache.baseDir, "1_0_"+strings.Repeat("c", 32)+".jpg")
	if err := os.WriteFile(path, []byte("legacy"), 0600); err != nil {
		t.Fatal(err)
	}
	old := time.Now().Add(-90 * 24 * time.Hour)
	_ = os.Chtimes(path, old, old)
	count, err := cache.InitializeRetention(30 * 24 * time.Hour)
	if err != nil || count != 1 {
		t.Fatalf("adopt: %d %v", count, err)
	}
	usage, err := cache.Prune(1024, 30*24*time.Hour)
	if err != nil || usage.Removed != 0 {
		t.Fatal("First rollout deleted a legacy file")
	}
	_ = os.Chtimes(path, old, old)
	count, err = cache.InitializeRetention(30 * 24 * time.Hour)
	if err != nil || count != 0 {
		t.Fatal("Adoption must be one-time")
	}
	usage, err = cache.Prune(1024, 30*24*time.Hour)
	if err != nil || usage.Removed != 1 {
		t.Fatal("Established policy did not expire an old file")
	}
}
