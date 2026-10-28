package repository

import (
	"errors"
	"unicode/utf8"

	"modernc.org/sqlite"
)

var (
	// ErrNotFound is returned when a row addressed by id does not exist.
	ErrNotFound = errors.New("record not found")
	// ErrConflict is returned when a unique constraint rejects an insert.
	ErrConflict = errors.New("record already exists")
)

// sqliteConstraint is the primary result code SQLITE_CONSTRAINT; extended
// codes (UNIQUE, PRIMARYKEY, ...) carry it in their low byte.
const sqliteConstraint = 19

func isConstraintError(err error) bool {
	var se *sqlite.Error
	return errors.As(err, &se) && se.Code()&0xff == sqliteConstraint
}

// truncate shortens s to at most n bytes without splitting a UTF-8 sequence.
func truncate(s string, n int) string {
	if len(s) <= n {
		return s
	}
	cut := n
	for cut > 0 && !utf8.RuneStart(s[cut]) {
		cut--
	}
	return s[:cut]
}
