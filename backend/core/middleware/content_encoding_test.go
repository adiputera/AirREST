package middleware

import (
	"bytes"
	"compress/gzip"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestDecodeGzipRequest(t *testing.T) {
	payload := []byte(`{"collections":[]}`)
	compressed := gzipTestBytes(t, payload)
	calls := 0
	handler := DecodeGzipRequest(1024, 1024)(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls++
		if got := r.Header.Get("Content-Encoding"); got != "" {
			t.Fatalf("content encoding was not removed: %q", got)
		}
		var got map[string]any
		if err := json.NewDecoder(r.Body).Decode(&got); err != nil {
			t.Fatalf("decode request: %v", err)
		}
		w.WriteHeader(http.StatusNoContent)
	}))

	request := httptest.NewRequest(http.MethodPost, "/sync/import-batch", bytes.NewReader(compressed))
	request.Header.Set("Content-Encoding", "gzip")
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != http.StatusNoContent || calls != 1 {
		t.Fatalf("valid gzip: status=%d calls=%d", response.Code, calls)
	}

	for _, test := range []struct {
		name     string
		encoding string
		body     []byte
		status   int
	}{
		{"unsupported encoding", "br", compressed, http.StatusUnsupportedMediaType},
		{"invalid gzip", "gzip", []byte("not gzip"), http.StatusBadRequest},
		{"trailing data", "gzip", append(compressed, 'x'), http.StatusBadRequest},
	} {
		t.Run(test.name, func(t *testing.T) {
			request := httptest.NewRequest(http.MethodPost, "/sync/import-batch", bytes.NewReader(test.body))
			request.Header.Set("Content-Encoding", test.encoding)
			response := httptest.NewRecorder()
			handler.ServeHTTP(response, request)
			if response.Code != test.status || !json.Valid(response.Body.Bytes()) {
				t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
			}
		})
	}
}

func TestDecodeGzipRequestRejectsCompressedAndDecodedLimits(t *testing.T) {
	handler := DecodeGzipRequest(32, 64)(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		t.Fatal("handler should not be called")
	}))
	for _, payload := range [][]byte{
		gzipTestBytes(t, []byte(strings.Repeat("x", 256))),
		bytes.Repeat([]byte("x"), 33),
	} {
		request := httptest.NewRequest(http.MethodPost, "/sync/import-batch", bytes.NewReader(payload))
		request.Header.Set("Content-Encoding", "gzip")
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, request)
		if response.Code != http.StatusRequestEntityTooLarge {
			t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
		}
	}
}

func TestRequireSingleJSONDocumentRejectsTrailingJSON(t *testing.T) {
	calls := 0
	handler := RequireSingleJSONDocument(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls++
		w.WriteHeader(http.StatusNoContent)
	}))

	for _, tc := range []struct {
		name       string
		body       string
		wantStatus int
	}{
		{"one document", ` {"collections":[]} `, http.StatusNoContent},
		{"second document", `{"collections":[]} {"extra":true}`, http.StatusBadRequest},
		{"trailing garbage", `{"collections":[]} nope`, http.StatusBadRequest},
	} {
		t.Run(tc.name, func(t *testing.T) {
			response := httptest.NewRecorder()
			handler.ServeHTTP(response, httptest.NewRequest(http.MethodPost, "/sync/import-batch", strings.NewReader(tc.body)))
			if response.Code != tc.wantStatus {
				t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
			}
		})
	}
	if calls != 1 {
		t.Fatalf("handler calls=%d", calls)
	}
}

func gzipTestBytes(t *testing.T, payload []byte) []byte {
	t.Helper()
	var buffer bytes.Buffer
	writer := gzip.NewWriter(&buffer)
	if _, err := writer.Write(payload); err != nil {
		t.Fatalf("write gzip: %v", err)
	}
	if err := writer.Close(); err != nil {
		t.Fatalf("close gzip: %v", err)
	}
	return buffer.Bytes()
}
