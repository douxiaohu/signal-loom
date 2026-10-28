package middleware

import (
	"encoding/json"
	"net/http"
)

// writeJSONError answers in the same {"detail": "..."} shape the API handlers
// use, so clients can parse every error the same way.
func writeJSONError(w http.ResponseWriter, status int, detail string) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(map[string]string{"detail": detail})
}
