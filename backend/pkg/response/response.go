package response

import (
	"encoding/json"
	"net/http"
	"reflect"
)

type Envelope struct {
	Success bool   `json:"success"`
	Data    any    `json:"data,omitempty"`
	Error   string `json:"error,omitempty"`
	Code    string `json:"code,omitempty"`
}

// JSON sends a standard successful JSON response
func JSON(w http.ResponseWriter, status int, data any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)

	// If data is a nil slice, normalize to empty slice so JSON serialization produces [] instead of null
	if data != nil {
		v := reflect.ValueOf(data)
		if v.Kind() == reflect.Slice && v.IsNil() {
			data = []any{}
		}
	}

	_ = json.NewEncoder(w).Encode(Envelope{
		Success: true,
		Data:    data,
	})
}

// Error sends a standard error JSON response
func Error(w http.ResponseWriter, status int, message string, code ...string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	errCode := "ERROR"
	if len(code) > 0 {
		errCode = code[0]
	}
	_ = json.NewEncoder(w).Encode(Envelope{
		Success: false,
		Error:   message,
		Code:    errCode,
	})
}

// Conflict sends a standard 409 Conflict JSON response with the remote conflicting object
func Conflict(w http.ResponseWriter, message string, remoteData any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusConflict)
	_ = json.NewEncoder(w).Encode(Envelope{
		Success: false,
		Error:   message,
		Code:    "CONFLICT",
		Data:    remoteData,
	})
}
