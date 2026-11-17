package config

import "testing"

func TestSiteConfigurationValidatesCanonicalOrigin(t *testing.T) {
	for _, raw := range []string{"https://reader.example", "http://localhost:8000", "https://reader.example/"} {
		cfg, err := buildConfig(func(key string) (string, bool) {
			if key == "PUBLIC_BASE_URL" {
				return raw, true
			}
			return "", false
		})
		if err != nil || cfg.PublicBaseURL == "" {
			t.Fatalf("Valid origin rejected: %q: %v", raw, err)
		}
	}
	for _, raw := range []string{"https://user:pass@reader.example", "javascript:alert(1)", "https://reader.example/path", "https://reader.example?secret=value", "https://reader.example/#x", "//reader.example"} {
		_, err := buildConfig(func(key string) (string, bool) {
			if key == "PUBLIC_BASE_URL" {
				return raw, true
			}
			return "", false
		})
		if err == nil {
			t.Fatalf("Unsafe/unsupported origin accepted: %q", raw)
		}
	}
}
