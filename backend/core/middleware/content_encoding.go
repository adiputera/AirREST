package middleware

import (
	"bytes"
	"compress/gzip"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strings"

	"github.com/adiputera/airrest-backend/pkg/response"
)

const (
	MaxGzipRequestBytes        int64 = 3_000_000
	MaxGzipDecodedRequestBytes int64 = 16 << 20
)

// DecodeGzipRequest accepts a single gzip member for routes that transfer
// collection data. The compressed and decoded forms have separate limits.
func DecodeGzipRequest(maxCompressedBytes, maxDecodedBytes int64) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			encoding := strings.ToLower(strings.TrimSpace(r.Header.Get("Content-Encoding")))
			if encoding == "" || encoding == "identity" {
				next.ServeHTTP(w, r)
				return
			}
			if encoding != "gzip" {
				response.Error(w, http.StatusUnsupportedMediaType, "unsupported content encoding", "UNSUPPORTED_CONTENT_ENCODING")
				return
			}
			if r.ContentLength > maxCompressedBytes {
				response.Error(w, http.StatusRequestEntityTooLarge, "compressed request body exceeds limit", "PAYLOAD_TOO_LARGE")
				return
			}

			compressed, err := readBounded(r.Body, maxCompressedBytes)
			if err != nil {
				if errors.Is(err, errBodyTooLarge) {
					response.Error(w, http.StatusRequestEntityTooLarge, "compressed request body exceeds limit", "PAYLOAD_TOO_LARGE")
				} else {
					response.Error(w, http.StatusBadRequest, "unable to read compressed request body", "BAD_REQUEST")
				}
				return
			}
			decompressed, err := decodeSingleGzip(compressed, maxDecodedBytes)
			if err != nil {
				if errors.Is(err, errBodyTooLarge) {
					response.Error(w, http.StatusRequestEntityTooLarge, "decompressed request body exceeds limit", "PAYLOAD_TOO_LARGE")
				} else {
					response.Error(w, http.StatusBadRequest, "invalid gzip request body", "BAD_REQUEST")
				}
				return
			}

			r.Body = io.NopCloser(bytes.NewReader(decompressed))
			r.ContentLength = int64(len(decompressed))
			r.Header.Del("Content-Encoding")
			next.ServeHTTP(w, r)
		})
	}
}

// RequireSingleJSONDocument rejects trailing JSON values or non-whitespace
// data before a handler can mutate state. The request body is restored for the
// handler after validation.
func RequireSingleJSONDocument(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, err := io.ReadAll(r.Body)
		if err != nil {
			response.Error(w, http.StatusBadRequest, "unable to read request body", "BAD_REQUEST")
			return
		}
		if !json.Valid(body) {
			response.Error(w, http.StatusBadRequest, "invalid request body", "BAD_REQUEST")
			return
		}
		r.Body = io.NopCloser(bytes.NewReader(body))
		r.ContentLength = int64(len(body))
		next.ServeHTTP(w, r)
	})
}

var errBodyTooLarge = errors.New("body exceeds limit")

func readBounded(body io.ReadCloser, maxBytes int64) ([]byte, error) {
	if body == nil {
		return nil, nil
	}
	data, err := io.ReadAll(io.LimitReader(body, maxBytes+1))
	if err != nil {
		if closeErr := body.Close(); closeErr != nil {
			return nil, closeErr
		}
		return nil, err
	}
	if err := body.Close(); err != nil {
		return nil, err
	}
	if int64(len(data)) > maxBytes {
		return nil, errBodyTooLarge
	}
	return data, nil
}

func decodeSingleGzip(compressed []byte, maxDecodedBytes int64) ([]byte, error) {
	input := bytes.NewReader(compressed)
	reader, err := gzip.NewReader(input)
	if err != nil {
		return nil, err
	}
	reader.Multistream(false)
	decompressed, err := io.ReadAll(io.LimitReader(reader, maxDecodedBytes+1))
	if closeErr := reader.Close(); err == nil {
		err = closeErr
	}
	if err != nil {
		return nil, err
	}
	if int64(len(decompressed)) > maxDecodedBytes {
		return nil, errBodyTooLarge
	}
	if input.Len() != 0 {
		return nil, errors.New("gzip request has trailing data")
	}
	return decompressed, nil
}
