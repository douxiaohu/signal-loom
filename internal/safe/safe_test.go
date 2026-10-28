package safe

import (
	"sync"
	"testing"
)

func TestRunRecoversPanic(t *testing.T) {
	if !Run("boom", func() { panic("kaboom") }) {
		t.Fatal("Run should report that fn panicked")
	}
	if Run("fine", func() {}) {
		t.Fatal("Run should not report a panic for a well-behaved fn")
	}
}

func TestErrorTextRedactsPathsButKeepsURLs(t *testing.T) {
	cases := map[string]string{
		"":              "",
		"plain message": "plain message",
		"open /app/data/media-cache/n1/x.jpg: permission denied":      "open [redacted path]: permission denied",
		"Get \"https://t.me/s/foo/bar\": context deadline exceeded":   "Get \"https://t.me/s/foo/bar\": context deadline exceeded",
		"failed to read ./data/telegram_forwarder.db":                 "failed to read [redacted path]",
		"cannot write C:\\srv\\app\\x.db now":                         "cannot write [redacted path] now",
		"status 404 from https://t.me/s/chan, cached at /var/cache/x": "status 404 from https://t.me/s/chan, cached at [redacted path]",
		"dial tcp 203.0.113.9:443: connect: connection refused":       "dial tcp 203.0.113.9:443: connect: connection refused",
	}
	for in, want := range cases {
		if got := ErrorText(in); got != want {
			t.Errorf("ErrorText(%q)\n got  %q\n want %q", in, got, want)
		}
	}
}

func TestGoSurvivesPanic(t *testing.T) {
	var wg sync.WaitGroup
	wg.Add(1)
	Go("boom", func() {
		defer wg.Done()
		panic("kaboom")
	})
	wg.Wait() // the test binary is still alive, so the panic was contained
}
