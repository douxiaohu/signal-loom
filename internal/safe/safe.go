// Package safe runs background work without letting a panic take the whole
// process down. net/http recovers panics for request goroutines (chi's
// Recoverer does the logging), but goroutines started by hand are not covered:
// an unrecovered panic in any of them terminates the server.
package safe

import (
	"log"
	"runtime/debug"
)

// Run executes fn on the calling goroutine and converts a panic into a log
// entry. It reports whether fn panicked.
func Run(name string, fn func()) (panicked bool) {
	defer func() {
		if rec := recover(); rec != nil {
			panicked = true
			log.Printf("[panic] %s: %v\n%s", name, rec, debug.Stack())
		}
	}()
	fn()
	return false
}

// Go starts fn on a new goroutine that cannot crash the process.
func Go(name string, fn func()) {
	go Run(name, fn)
}
