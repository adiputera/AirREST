package middleware

import (
	"bytes"
	"errors"
	"io"
	"net/http"
	"strconv"
	"time"

	"github.com/adiputera/airrest-backend/pkg/response"
)

const (
	MaxRequestBytes       int64 = 4 << 20
	MaxConcurrentRequests       = 16
	RequestTimeout              = 30 * time.Second
)

// RequestLimits bounds memory, concurrent work, body reads, and database contexts.
// Slots remain occupied until the handler actually exits, even after timeout.
func RequestLimits(maxBytes int64, concurrency int, timeout time.Duration) func(http.Handler) http.Handler {
	slots := make(chan struct{}, concurrency)
	return func(next http.Handler) http.Handler {
		bounded := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			select {
			case slots <- struct{}{}:
				defer func() { <-slots }()
			default:
				w.Header().Set("Retry-After", "1")
				response.Error(w, http.StatusServiceUnavailable, "server is busy; retry later", "SERVER_BUSY")
				return
			}
			if r.ContentLength > maxBytes {
				response.Error(w, http.StatusRequestEntityTooLarge, "request body exceeds "+strconv.FormatInt(maxBytes, 10)+" bytes", "PAYLOAD_TOO_LARGE")
				return
			}
			if r.Body != nil {
				limited := http.MaxBytesReader(w, r.Body, maxBytes)
				defer limited.Close()
				body, err := io.ReadAll(limited)
				if err != nil {
					var tooLarge *http.MaxBytesError
					if errors.As(err, &tooLarge) {
						response.Error(w, http.StatusRequestEntityTooLarge, "request body exceeds limit", "PAYLOAD_TOO_LARGE")
					} else {
						response.Error(w, http.StatusBadRequest, "unable to read request body", "BAD_REQUEST")
					}
					return
				}
				r.Body = io.NopCloser(bytes.NewReader(body))
			}
			next.ServeHTTP(w, r)
		})
		timed := http.TimeoutHandler(bounded, timeout, `{"success":false,"error":"request deadline exceeded","code":"REQUEST_TIMEOUT"}`)
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			w.Header().Set("Content-Type", "application/json")
			// Apply on the original writer: TimeoutHandler does not expose ResponseController.
			controller := http.NewResponseController(w)
			_ = controller.SetReadDeadline(time.Now().Add(timeout))
			defer controller.SetReadDeadline(time.Time{})
			timed.ServeHTTP(w, r)
		})
	}
}
