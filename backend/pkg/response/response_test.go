package response_test

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/adiputera/airrest-backend/pkg/response"
)

type sampleStruct struct {
	ID   string `json:"id"`
	Name string `json:"name"`
}

func TestJSON_NormalizesNilSliceToEmptyArray(t *testing.T) {
	w := httptest.NewRecorder()
	var nilSlice []*sampleStruct

	response.JSON(w, http.StatusOK, nilSlice)

	if w.Code != http.StatusOK {
		t.Fatalf("expected status 200, got %d", w.Code)
	}

	var res map[string]any
	if err := json.Unmarshal(w.Body.Bytes(), &res); err != nil {
		t.Fatalf("failed to parse json response: %v", err)
	}

	if res["success"] != true {
		t.Fatalf("expected success true, got %v", res["success"])
	}

	dataVal, exists := res["data"]
	if !exists {
		t.Fatalf("expected data field to exist in JSON response")
	}

	sliceVal, ok := dataVal.([]any)
	if !ok {
		t.Fatalf("expected data field to be a JSON array, got %T: %v", dataVal, dataVal)
	}

	if len(sliceVal) != 0 {
		t.Fatalf("expected data array to be empty, got length %d", len(sliceVal))
	}
}

func TestJSON_PreservesNonEmptySlice(t *testing.T) {
	w := httptest.NewRecorder()
	items := []*sampleStruct{
		{ID: "1", Name: "Item 1"},
	}

	response.JSON(w, http.StatusOK, items)

	var res map[string]any
	if err := json.Unmarshal(w.Body.Bytes(), &res); err != nil {
		t.Fatalf("failed to parse json response: %v", err)
	}

	dataVal, ok := res["data"].([]any)
	if !ok || len(dataVal) != 1 {
		t.Fatalf("expected data array of length 1, got %v", res["data"])
	}
}

func TestJSON_HandlesUntypedNil(t *testing.T) {
	w := httptest.NewRecorder()
	response.JSON(w, http.StatusOK, nil)

	var res map[string]any
	if err := json.Unmarshal(w.Body.Bytes(), &res); err != nil {
		t.Fatalf("failed to parse json response: %v", err)
	}

	if res["success"] != true {
		t.Fatalf("expected success true, got %v", res["success"])
	}
}

