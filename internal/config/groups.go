package config

import (
	"bufio"
	"fmt"
	"os"
	"strconv"
	"strings"
)

// Group is one entry of config/groups.yaml. Only the keys the service uses are
// kept; unknown keys (webhook_url, screenshot_enabled, ...) are ignored.
type Group struct {
	Source     string
	Name       string
	ChatID     *int64
	SourceType string
}

// LoadGroups reads the legacy groups file. A missing file is not an error.
func LoadGroups(path string) ([]Group, error) {
	if path == "" {
		return nil, nil
	}
	f, err := os.Open(path)
	if err != nil {
		if os.IsNotExist(err) {
			return nil, nil
		}
		return nil, err
	}
	defer f.Close()
	return parseGroups(bufio.NewScanner(f))
}

// parseGroups understands the narrow YAML shape documented in
// config/groups.example.yaml: a "groups:" list of flat key/value mappings.
func parseGroups(sc *bufio.Scanner) ([]Group, error) {
	var groups []Group
	var current map[string]string
	flush := func() error {
		if current == nil {
			return nil
		}
		g := Group{
			Source:     current["source"],
			Name:       current["name"],
			SourceType: current["source_type"],
		}
		if raw, ok := current["chat_id"]; ok && raw != "" {
			id, err := strconv.ParseInt(raw, 10, 64)
			if err != nil {
				return fmt.Errorf("groups: invalid chat_id %q", raw)
			}
			g.ChatID = &id
		}
		if g.SourceType == "" {
			if g.Source != "" {
				g.SourceType = "telegram_public"
			} else {
				g.SourceType = "telegram_bot"
			}
		}
		if g.Name == "" {
			g.Name = g.Source
		}
		groups = append(groups, g)
		current = nil
		return nil
	}

	for sc.Scan() {
		line := strings.TrimRight(stripYAMLComment(sc.Text()), " \t\r")
		trimmed := strings.TrimSpace(line)
		if trimmed == "" || trimmed == "groups:" {
			continue
		}
		if trimmed == "-" || strings.HasPrefix(trimmed, "- ") {
			if err := flush(); err != nil {
				return nil, err
			}
			current = map[string]string{}
			trimmed = strings.TrimSpace(strings.TrimPrefix(trimmed, "-"))
			if trimmed == "" {
				continue
			}
		}
		if current == nil {
			continue
		}
		key, value, ok := strings.Cut(trimmed, ":")
		if !ok {
			return nil, fmt.Errorf("groups: unsupported line %q", trimmed)
		}
		current[strings.TrimSpace(key)] = stripQuotes(strings.TrimSpace(value))
	}
	if err := sc.Err(); err != nil {
		return nil, err
	}
	if err := flush(); err != nil {
		return nil, err
	}
	return groups, nil
}

// stripYAMLComment removes a trailing "# ..." comment that is outside quotes.
func stripYAMLComment(line string) string {
	var quote byte
	for i := 0; i < len(line); i++ {
		c := line[i]
		switch {
		case quote != 0:
			if c == quote {
				quote = 0
			}
		case c == '"' || c == '\'':
			quote = c
		case c == '#' && (i == 0 || line[i-1] == ' ' || line[i-1] == '\t'):
			return line[:i]
		}
	}
	return line
}
