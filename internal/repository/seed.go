package repository

import (
	"fmt"
	"strings"

	"telegram-radar/internal/config"
	"telegram-radar/internal/model"
)

// SeedSourcesFromGroups imports config/groups.yaml once, and only while the
// sources table is empty (the behaviour the README documents). Bot-API groups
// need the Telegram bot adapter, which this service does not have, so they are
// reported back as skipped instead of creating sources that could never be
// crawled.
func SeedSourcesFromGroups(repo *SourceRepository, groups []config.Group) (created int, skipped []string, err error) {
	count, err := repo.SourceCount()
	if err != nil || count > 0 {
		return 0, nil, err
	}
	for _, g := range groups {
		if g.SourceType != "telegram_public" || strings.TrimSpace(g.Source) == "" {
			skipped = append(skipped, fmt.Sprintf("%s (%s)", g.Name, g.SourceType))
			continue
		}
		canonical, cerr := config.CanonicalTelegramPublicURL(g.Source)
		if cerr != nil {
			skipped = append(skipped, fmt.Sprintf("%s (invalid source %q)", g.Name, g.Source))
			continue
		}
		name := strings.TrimSpace(g.Name)
		if name == "" {
			name = config.NormalizeTelegramPublicSource(g.Source)
		}
		src := &model.Source{
			ChatID:        config.PublicSourceChatID(canonical),
			Name:          truncate(name, 80),
			SourceURL:     canonical,
			SourceType:    "telegram_public",
			Adapter:       "telegram_public",
			Locator:       canonical,
			Enabled:       true,
			PublicVisible: true, // same as the Python seeding
		}
		switch cerr := repo.CreateSource(src); cerr {
		case nil:
			created++
		case ErrConflict:
			skipped = append(skipped, fmt.Sprintf("%s (duplicate)", g.Name))
		default:
			return created, skipped, cerr
		}
	}
	return created, skipped, nil
}
