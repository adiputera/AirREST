package middleware

import (
	"bytes"
	"compress/gzip"
	"errors"
	"log/slog"
	"net/http"
	"strconv"
	"strings"

	"github.com/adiputera/airrest-backend/pkg/response"
)

const (
	MaxGzipResponseBytes     int64 = 3_000_000
	MaxIdentityResponseBytes int64 = 4 << 20
	MaxDecodedResponseBytes  int64 = 16 << 20
)

var errResponseTooLarge = errors.New("response body exceeds limit")

// GzipJSONResponse buffers a JSON response so it can fail safely before any
// bytes or success status are sent when neither representation fits its limit.
func GzipJSONResponse(maxCompressedBytes, maxIdentityBytes int64) func(http.Handler) http.Handler {
	return gzipJSONResponse(maxCompressedBytes, maxIdentityBytes, MaxDecodedResponseBytes)
}

func gzipJSONResponse(maxCompressedBytes, maxIdentityBytes, maxDecodedBytes int64) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			buffered := newBufferedResponseWriter(w.Header(), maxDecodedBytes)
			next.ServeHTTP(buffered, r)
			buffered.Header().Set("Cache-Control", "private, no-store")
			buffered.Header().Set("Vary", appendVary(buffered.Header().Get("Vary"), "Accept-Encoding"))

			if buffered.exceeded {
				writeTransferError(w, buffered, http.StatusRequestEntityTooLarge, "response body exceeds transfer limit", "RESPONSE_PAYLOAD_TOO_LARGE")
				return
			}

			body := buffered.body.Bytes()
			isSuccessJSON := buffered.status >= http.StatusOK && buffered.status < http.StatusMultipleChoices && strings.HasPrefix(buffered.Header().Get("Content-Type"), "application/json")
			if !isSuccessJSON {
				writeBuffered(w, buffered, body)
				return
			}

			gzipQuality := encodingQuality(r.Header.Get("Accept-Encoding"), "gzip")
			identityQuality := encodingQuality(r.Header.Get("Accept-Encoding"), "identity")
			if gzipQuality == 0 && identityQuality == 0 {
				writeTransferError(w, buffered, http.StatusNotAcceptable, "no acceptable response encoding", "NOT_ACCEPTABLE")
				return
			}
			if identityQuality > gzipQuality && int64(len(body)) <= maxIdentityBytes {
				writeBuffered(w, buffered, body)
				return
			}
			if gzipQuality > 0 {
				compressed, err := gzipBytes(body, maxCompressedBytes)
				if err == nil {
					buffered.Header().Set("Content-Encoding", "gzip")
					writeBuffered(w, buffered, compressed)
					return
				}
				if !errors.Is(err, errResponseTooLarge) {
					slog.Error("failed to gzip response", "error", err)
					writeTransferError(w, buffered, http.StatusInternalServerError, "unable to encode response", "SERVER_ERROR")
					return
				}
			}
			if identityQuality > 0 && int64(len(body)) <= maxIdentityBytes {
				writeBuffered(w, buffered, body)
				return
			}
			writeTransferError(w, buffered, http.StatusRequestEntityTooLarge, "response body exceeds transfer limit", "RESPONSE_PAYLOAD_TOO_LARGE")
		})
	}
}

type bufferedResponseWriter struct {
	header      http.Header
	body        bytes.Buffer
	maxBody     int64
	exceeded    bool
	status      int
	wroteHeader bool
}

func newBufferedResponseWriter(initial http.Header, maxBody int64) *bufferedResponseWriter {
	header := make(http.Header, len(initial))
	for key, values := range initial {
		header[key] = append([]string(nil), values...)
	}
	return &bufferedResponseWriter{header: header, maxBody: maxBody, status: http.StatusOK}
}

func (w *bufferedResponseWriter) Header() http.Header { return w.header }

func (w *bufferedResponseWriter) WriteHeader(status int) {
	if w.wroteHeader {
		return
	}
	w.status = status
	w.wroteHeader = true
}

func (w *bufferedResponseWriter) Write(data []byte) (int, error) {
	if w.exceeded || int64(len(data)) > w.maxBody-int64(w.body.Len()) {
		w.exceeded = true
		return 0, errResponseTooLarge
	}
	return w.body.Write(data)
}

func gzipBytes(data []byte, maxBytes int64) ([]byte, error) {
	compressed := limitedBuffer{maxBytes: maxBytes}
	writer, err := gzip.NewWriterLevel(&compressed, gzip.BestSpeed)
	if err != nil {
		return nil, err
	}
	if _, err := writer.Write(data); err != nil {
		return nil, err
	}
	if err := writer.Close(); err != nil {
		return nil, err
	}
	return compressed.Bytes(), nil
}

func writeBuffered(w http.ResponseWriter, buffered *bufferedResponseWriter, body []byte) {
	for key, values := range buffered.Header() {
		w.Header()[key] = append([]string(nil), values...)
	}
	w.Header().Set("Content-Length", strconv.Itoa(len(body)))
	w.WriteHeader(buffered.status)
	if _, err := w.Write(body); err != nil {
		slog.Error("failed to write buffered response", "error", err)
	}
}

func writeTransferError(w http.ResponseWriter, buffered *bufferedResponseWriter, status int, message, code string) {
	for key, values := range buffered.Header() {
		w.Header()[key] = append([]string(nil), values...)
	}
	w.Header().Del("Content-Encoding")
	w.Header().Del("Content-Length")
	response.Error(w, status, message, code)
}

type limitedBuffer struct {
	bytes.Buffer
	maxBytes int64
}

func (b *limitedBuffer) Write(data []byte) (int, error) {
	if int64(len(data)) > b.maxBytes-int64(b.Len()) {
		return 0, errResponseTooLarge
	}
	return b.Buffer.Write(data)
}

func encodingQuality(header, encoding string) float64 {
	if strings.TrimSpace(header) == "" {
		if strings.EqualFold(encoding, "identity") {
			return 1
		}
		return 0
	}

	var exact *float64
	var wildcard *float64
	for _, part := range strings.Split(header, ",") {
		fields := strings.Split(strings.TrimSpace(part), ";")
		if len(fields) == 0 {
			continue
		}
		quality := 1.0
		for _, parameter := range fields[1:] {
			key, value, found := strings.Cut(strings.TrimSpace(parameter), "=")
			if !found || !strings.EqualFold(strings.TrimSpace(key), "q") {
				continue
			}
			parsed, err := strconv.ParseFloat(strings.TrimSpace(value), 64)
			if err != nil || parsed < 0 || parsed > 1 {
				quality = 0
			} else {
				quality = parsed
			}
		}
		coding := strings.ToLower(strings.TrimSpace(fields[0]))
		if coding == strings.ToLower(encoding) {
			value := quality
			exact = &value
		} else if coding == "*" {
			value := quality
			wildcard = &value
		}
	}
	if exact != nil {
		return *exact
	}
	if strings.EqualFold(encoding, "identity") {
		if wildcard != nil && *wildcard == 0 {
			return 0
		}
		return 1
	}
	if wildcard != nil {
		return *wildcard
	}
	return 0
}

func appendVary(existing, value string) string {
	for _, item := range strings.Split(existing, ",") {
		if strings.EqualFold(strings.TrimSpace(item), value) {
			return existing
		}
	}
	if existing == "" {
		return value
	}
	return existing + ", " + value
}
