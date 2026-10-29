package middleware

import (
	"bytes"
	"compress/gzip"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/adiputera/airrest-backend/pkg/response"
)

func TestGzipJSONResponse(t *testing.T) {
	handler := GzipJSONResponse(1024, 2048)(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		response.JSON(w, http.StatusCreated, map[string]string{"value": strings.Repeat("hello", 100)})
	}))
	request := httptest.NewRequest(http.MethodGet, "/collections/id", nil)
	request.Header.Set("Accept-Encoding", "gzip")
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, request)
	if recorder.Code != http.StatusCreated || recorder.Header().Get("Content-Encoding") != "gzip" || recorder.Header().Get("Vary") != "Accept-Encoding" {
		t.Fatalf("unexpected compressed response: status=%d headers=%v", recorder.Code, recorder.Header())
	}
	reader, err := gzip.NewReader(bytes.NewReader(recorder.Body.Bytes()))
	if err != nil {
		t.Fatalf("open gzip: %v", err)
	}
	decompressed, err := io.ReadAll(reader)
	if err != nil {
		t.Fatalf("read gzip: %v", err)
	}
	if err := reader.Close(); err != nil {
		t.Fatalf("close gzip: %v", err)
	}
	if !strings.Contains(string(decompressed), `"success":true`) {
		t.Fatalf("unexpected body: %s", decompressed)
	}
}

func TestGzipJSONResponseRespectsIdentityAndLimit(t *testing.T) {
	handler := GzipJSONResponse(32, 64)(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		response.JSON(w, http.StatusOK, map[string]string{"value": strings.Repeat("x", 100)})
	}))
	for _, acceptEncoding := range []string{"identity", "gzip;q=0"} {
		request := httptest.NewRequest(http.MethodGet, "/collections/id", nil)
		request.Header.Set("Accept-Encoding", acceptEncoding)
		recorder := httptest.NewRecorder()
		handler.ServeHTTP(recorder, request)
		if recorder.Code != http.StatusRequestEntityTooLarge || !strings.Contains(recorder.Body.String(), "RESPONSE_PAYLOAD_TOO_LARGE") {
			t.Fatalf("%s: status=%d body=%s", acceptEncoding, recorder.Code, recorder.Body.String())
		}
	}
}

func TestGzipJSONResponseRejectsDecodedOverflowBeforeCompression(t *testing.T) {
	handler := gzipJSONResponse(1024, 64, 128)(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(strings.Repeat("x", 129)))
	}))
	request := httptest.NewRequest(http.MethodGet, "/collections/id", nil)
	request.Header.Set("Accept-Encoding", "gzip")
	recorder := httptest.NewRecorder()

	handler.ServeHTTP(recorder, request)

	if recorder.Code != http.StatusRequestEntityTooLarge || !strings.Contains(recorder.Body.String(), "RESPONSE_PAYLOAD_TOO_LARGE") {
		t.Fatalf("status=%d body=%s", recorder.Code, recorder.Body.String())
	}
	if recorder.Header().Get("Content-Encoding") != "" || recorder.Header().Get("Cache-Control") != "private, no-store" || recorder.Header().Get("Vary") != "Accept-Encoding" {
		t.Fatalf("unexpected error headers: %v", recorder.Header())
	}
}

func TestGzipJSONResponseHonorsAcceptEncodingQuality(t *testing.T) {
	for _, tc := range []struct {
		name            string
		acceptEncoding  string
		wantStatus      int
		wantCompression bool
	}{
		{"q zero with three decimals", "gzip;q=0.000", http.StatusOK, false},
		{"explicit gzip excludes wildcard", "*;q=1, gzip;q=0", http.StatusOK, false},
		{"identity preferred over gzip", "gzip;q=0.1, identity;q=1", http.StatusOK, false},
		{"all representations excluded", "gzip;q=0, identity;q=0, *;q=0", http.StatusNotAcceptable, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			handler := gzipJSONResponse(1024, 2048, 4096)(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				response.JSON(w, http.StatusOK, map[string]string{"value": strings.Repeat("x", 100)})
			}))
			request := httptest.NewRequest(http.MethodGet, "/collections/id", nil)
			request.Header.Set("Accept-Encoding", tc.acceptEncoding)
			recorder := httptest.NewRecorder()

			handler.ServeHTTP(recorder, request)

			if recorder.Code != tc.wantStatus {
				t.Fatalf("status=%d body=%s", recorder.Code, recorder.Body.String())
			}
			if got := recorder.Header().Get("Content-Encoding") == "gzip"; got != tc.wantCompression {
				t.Fatalf("gzip=%v headers=%v", got, recorder.Header())
			}
		})
	}
}
