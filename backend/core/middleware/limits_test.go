package middleware

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestRequestBodyLimits(t *testing.T) {
	calls := 0
	handler := RequestLimits(32, 1, time.Second)(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { calls++; w.WriteHeader(204) }))
	for _, length := range []int64{33, -1} {
		r := httptest.NewRequest("POST", "/auth/login", strings.NewReader(strings.Repeat("x", 33)))
		r.ContentLength = length
		if length == -1 {
			r.TransferEncoding = []string{"chunked"}
		}
		w := httptest.NewRecorder()
		handler.ServeHTTP(w, r)
		if w.Code != 413 || !json.Valid(w.Body.Bytes()) {
			t.Fatalf("oversize: %d %s", w.Code, w.Body)
		}
	}
	w := httptest.NewRecorder()
	handler.ServeHTTP(w, httptest.NewRequest("POST", "/", strings.NewReader(`{"ok":true}`)))
	if w.Code != 204 || calls != 1 {
		t.Fatalf("valid body: %d calls=%d", w.Code, calls)
	}
}

func TestDeadlineCancelsWorkAndReleasesSlot(t *testing.T) {
	entered, finished := make(chan struct{}), make(chan struct{})
	handler := RequestLimits(32, 1, 30*time.Millisecond)(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { close(entered); <-r.Context().Done(); close(finished) }))
	done := make(chan struct{})
	first := httptest.NewRecorder()
	go func() { defer close(done); handler.ServeHTTP(first, httptest.NewRequest("GET", "/", nil)) }()
	<-entered
	busy := httptest.NewRecorder()
	handler.ServeHTTP(busy, httptest.NewRequest("GET", "/", nil))
	if busy.Code != 503 || !strings.Contains(busy.Body.String(), "SERVER_BUSY") {
		t.Fatalf("overload: %d %s", busy.Code, busy.Body)
	}
	<-done
	<-finished
	if first.Code != 503 || !strings.Contains(first.Body.String(), "REQUEST_TIMEOUT") {
		t.Fatalf("timeout: %d %s", first.Code, first.Body)
	}
}
