package api

import (
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"unicode/utf8"
)

// Limits shared with the UI and with the Python service.
const (
	maxNameLen      = 80
	maxSourceURLLen = 300
	maxKeywordLen   = 200
	maxQueryLen     = 200
	maxCursorLen    = 500
	maxFeedbackLen  = 2000
	maxAPIKeyLen    = 256
	maxRuleSources  = 100
	maxCooldownMins = 1440
)

var clockPattern = regexp.MustCompile(`^([01]\d|2[0-3]):[0-5]\d$`)

// mediaFilters are the values of the "media" query parameter / rule media_type.
var mediaFilters = map[string]bool{
	"all": true, "text": true, "photo": true, "video": true, "document": true,
	"animation": true, "audio": true, "voice": true, "sticker": true,
}

func runeLen(s string) int { return utf8.RuneCountInString(s) }

// queryInt reads an integer parameter. Absent means def; a value that is not a
// number is an error; out-of-range values are clamped.
func queryInt(q url.Values, key string, def, min, max int) (int, *apiError) {
	raw := strings.TrimSpace(q.Get(key))
	if raw == "" {
		return def, nil
	}
	n, err := strconv.Atoi(raw)
	if err != nil {
		return 0, &apiError{400, "Invalid " + key}
	}
	if n < min {
		n = min
	}
	if n > max {
		n = max
	}
	return n, nil
}

// feedFilter holds the validated query parameters of the message list
// endpoints.
type feedFilter struct {
	ChatID *int64
	Query  string
	Media  string
	Cursor string
}

func parseFeedFilter(q url.Values) (feedFilter, *apiError) {
	var f feedFilter
	if raw := strings.TrimSpace(q.Get("chat_id")); raw != "" && raw != "all" {
		id, err := strconv.ParseInt(raw, 10, 64)
		if err != nil {
			return f, &apiError{400, "Invalid chat_id"}
		}
		f.ChatID = &id
	}
	f.Query = q.Get("query")
	if runeLen(f.Query) > maxQueryLen {
		return f, &apiError{400, "query is too long"}
	}
	f.Cursor = q.Get("cursor")
	if len(f.Cursor) > maxCursorLen {
		return f, &apiError{400, "cursor is too long"}
	}
	f.Media = q.Get("media")
	if f.Media == "" {
		f.Media = "all"
	}
	if !mediaFilters[f.Media] {
		return f, &apiError{400, "Invalid media filter"}
	}
	return f, nil
}

func firstNonEmpty(values ...string) string {
	for _, v := range values {
		if v != "" {
			return v
		}
	}
	return ""
}
