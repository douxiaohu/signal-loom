package safe

import "regexp"

var (
	urlPattern = regexp.MustCompile(`(?i)\bhttps?://[^\s<>'"]+`)

	// RE2 has no look-behind, so the character before a path is captured and
	// put back: a path only starts after the beginning of the text or a
	// non-alphanumeric character.
	pathPattern = regexp.MustCompile(`(?i)(^|[^A-Za-z0-9])(` +
		`(?:/[^\s<>'":;,)\]}]+)+` +
		`|(?:\./)?(?:app|data|config|screenshots?|media(?:_cache)?|cache|logs?)/[^\s<>'":;,)\]}]+` +
		`|[A-Za-z]:\\[^\s<>'":;,)\]}]+` +
		`)`)
)

// ErrorText removes server file-system paths from an error message before it
// is stored or shown in the admin UI, while keeping URLs intact (they are what
// makes a crawl error actionable).
func ErrorText(text string) string {
	if text == "" {
		return text
	}
	out := make([]byte, 0, len(text))
	cursor := 0
	for _, loc := range urlPattern.FindAllStringIndex(text, -1) {
		out = append(out, pathPattern.ReplaceAllString(text[cursor:loc[0]], "${1}[redacted path]")...)
		out = append(out, text[loc[0]:loc[1]]...)
		cursor = loc[1]
	}
	out = append(out, pathPattern.ReplaceAllString(text[cursor:], "${1}[redacted path]")...)
	return string(out)
}
