package service

import (
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"testing"

	"github.com/adiputera/airrest-backend/core/domain"
)

func TestClassifyExampleMime(t *testing.T) {
	cases := []struct {
		name        string
		contentType string
		wantLang    string
		wantStrict  bool
		wantOK      bool
	}{
		{"application json", "application/json; charset=utf-8", "json", false, true},
		{"problem json", "application/problem+json", "json", false, true},
		{"structured custom json", "application/vnd.acme.v1+json", "json", false, true},
		{"application xml", "application/xml", "xml", false, true},
		{"text xml", "text/xml; charset=utf-8", "xml", false, true},
		{"xhtml", "application/xhtml+xml", "html", true, true},
		{"html", "text/html; charset=UTF-8", "html", false, true},
		{"comma joined consistent json", "application/json; charset=utf-8, application/problem+json; charset=utf-8", "json", false, true},
		{"comma joined quoted param", `application/json; profile="a,b", application/json`, "json", false, true},
		{"reject conflicting comma joined types", "application/json, text/html", "", false, false},
		{"reject disallowed plus consistent entry", "text/plain, application/json", "", false, false},
		{"reject conflicting charsets", "application/json; charset=utf-8, application/json; charset=iso-8859-1", "", false, false},
		{"reject model+json", "model/gltf+json", "", false, false},
		{"reject svg mime", "image/svg+xml", "", false, false},
		{"reject plain text", "text/plain", "", false, false},
		{"reject csv", "text/csv", "", false, false},
		{"reject octet-stream", "application/octet-stream", "", false, false},
		{"reject empty", "", "", false, false},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			lang, strict, ok := ClassifyExampleMime(tc.contentType)
			if lang != tc.wantLang || strict != tc.wantStrict || ok != tc.wantOK {
				t.Fatalf("got (%q, %v, %v), want (%q, %v, %v)", lang, strict, ok, tc.wantLang, tc.wantStrict, tc.wantOK)
			}
		})
	}
}

func TestValidateSingleSavedExample_FormatsAndSanitization(t *testing.T) {
	makeEx := func(name, ct, body string) domain.SavedExample {
		return domain.SavedExample{
			ID:       "ex-1",
			Revision: 1,
			Name:     name,
			Status:   "OK",
			Code:     200,
			Header:   []domain.SavedExampleHeader{{Key: "Content-Type", Value: ct}},
			Body:     body,
		}
	}

	t.Run("accepts JSON object, array, and scalars", func(t *testing.T) {
		for _, body := range []string{`{"ok":true}`, `[1,2,3]`, `"scalar"`, `42`, `true`, `null`} {
			seen := map[string]struct{}{}
			res, err := ValidateSingleSavedExample(makeEx("JSON test", "application/json", body), seen)
			if err != nil {
				t.Fatalf("expected valid JSON %q, got error: %v", body, err)
			}
			if res.PreviewLanguage == nil || *res.PreviewLanguage != "json" {
				t.Fatalf("expected json preview language, got %v", res.PreviewLanguage)
			}
		}
	})

	t.Run("accepts well-formed XML, textual SVG under application/xml, and XML prolog encoding", func(t *testing.T) {
		validXMLs := []string{
			`<root><item id="1">ok</item></root>`,
			`<svg xmlns="http://www.w3.org/2000/svg"><circle r="5"/></svg>`,
			`<?xml version="1.0" encoding="ISO-8859-1"?><note>hello</note>`,
		}
		for _, body := range validXMLs {
			res, err := ValidateSingleSavedExample(makeEx("XML test", "application/xml", body), nil)
			if err != nil {
				t.Fatalf("expected valid XML %q, got error: %v", body, err)
			}
			if res.PreviewLanguage == nil || *res.PreviewLanguage != "xml" {
				t.Fatalf("expected xml preview language, got %v", res.PreviewLanguage)
			}
		}
	})

	t.Run("accepts HTML and strict XHTML", func(t *testing.T) {
		if _, err := ValidateSingleSavedExample(makeEx("HTML", "text/html", `<!doctype html><html><body>hi</body></html>`), nil); err != nil {
			t.Fatalf("expected valid html, got %v", err)
		}
		if _, err := ValidateSingleSavedExample(makeEx("XHTML", "application/xhtml+xml", `<html xmlns="http://www.w3.org/1999/xhtml"><body/></html>`), nil); err != nil {
			t.Fatalf("expected valid strict xhtml, got %v", err)
		}
		if _, err := ValidateSingleSavedExample(makeEx("Bad XHTML", "application/xhtml+xml", `<html><body><br></body></html>`), nil); err == nil {
			t.Fatal("expected malformed XHTML without closing tags to fail")
		}
	})

	t.Run("rejects malformed content without leaking payload secrets", func(t *testing.T) {
		secret := "SUPER_SECRET_TOKEN_XYZ"
		badCases := []domain.SavedExample{
			makeEx("Bad JSON", "application/json", `not json `+secret),
			makeEx("Bad XML", "application/xml", `<root>`+secret),
			makeEx("Plain text as HTML", "text/html", `plain text `+secret),
			makeEx("SVG image MIME", "image/svg+xml", `<svg>`+secret+`</svg>`),
			makeEx("NUL byte", "application/json", "\"abc\u0000"+secret+"\""),
			makeEx("BOM-only body", "application/json", "\uFEFF   "),
		}
		missingMime := domain.SavedExample{
			ID:       "ex-no-mime",
			Revision: 1,
			Name:     "Missing MIME",
			Status:   "OK",
			Code:     200,
			Header:   []domain.SavedExampleHeader{},
			Body:     `{"secret":"` + secret + `"}`,
		}
		jsonLang := "json"
		missingMime.PreviewLanguage = &jsonLang
		badCases = append(badCases, missingMime)
		for _, ex := range badCases {
			_, err := ValidateSingleSavedExample(ex, nil)
			if err == nil {
				t.Fatalf("expected validation failure for %s", ex.Name)
			}
			if strings.Contains(err.Error(), secret) {
				t.Fatalf("validation error leaked body secret: %v", err)
			}
		}
	})

	t.Run("rejects >150 rune name, invalid code, duplicate id, and >512 KiB size", func(t *testing.T) {
		tooLong := strings.Repeat("a", 151)
		if _, err := ValidateSingleSavedExample(makeEx(tooLong, "application/json", `{}`), nil); !errors.Is(err, ErrInvalidItemPayload) {
			t.Fatalf("expected ErrInvalidItemPayload for long name, got %v", err)
		}

		badCode := makeEx("Bad code", "application/json", `{}`)
		badCode.Code = 99
		if _, err := ValidateSingleSavedExample(badCode, nil); !errors.Is(err, ErrInvalidItemPayload) {
			t.Fatalf("expected ErrInvalidItemPayload for status 99, got %v", err)
		}

		seen := map[string]struct{}{"dup-1": {}}
		dupEx := makeEx("Dup", "application/json", `{}`)
		dupEx.ID = "dup-1"
		if _, err := ValidateSingleSavedExample(dupEx, seen); !errors.Is(err, ErrInvalidItemPayload) {
			t.Fatalf("expected ErrInvalidItemPayload for duplicate id, got %v", err)
		}

		oversized := makeEx("Too big", "application/json", `"`+strings.Repeat("x", MaxSavedExampleBytes)+`"`)
		if _, err := ValidateSingleSavedExample(oversized, nil); !errors.Is(err, ErrExampleLimitExceeded) {
			t.Fatalf("expected ErrExampleLimitExceeded, got %v", err)
		}
	})
}

func TestValidateAndNormalizeExamples_LimitsAndNullSemantics(t *testing.T) {
	if raw, err := ValidateAndNormalizeExamples(domain.OptionalRawJSON{}, domain.ItemTypeRequest); err != nil || raw != nil {
		t.Fatalf("omitted OptionalRawJSON should return nil, nil; got (%s, %v)", string(raw), err)
	}

	var nullOpt domain.OptionalRawJSON
	if err := json.Unmarshal([]byte("null"), &nullOpt); err != nil {
		t.Fatal(err)
	}
	if !nullOpt.Present || !nullOpt.IsNull {
		t.Fatalf("expected Present=true IsNull=true for explicit null")
	}
	if _, err := ValidateAndNormalizeExamples(nullOpt, domain.ItemTypeRequest); !errors.Is(err, ErrInvalidItemPayload) {
		t.Fatalf("expected ErrInvalidItemPayload for null examples, got %v", err)
	}

	nonEmpty := domain.NewOptionalRawJSON([]byte(`[{"id":"1","revision":1,"name":"ok","status":"OK","code":200,"header":[{"key":"Content-Type","value":"application/json"}],"body":"{}"}]`))
	if _, err := ValidateAndNormalizeExamples(nonEmpty, domain.ItemTypeFolder); !errors.Is(err, ErrInvalidItemPayload) {
		t.Fatalf("expected folder with examples to fail, got %v", err)
	}

	many := make([]domain.SavedExample, MaxSavedExamplesPerItem+1)
	for i := range many {
		many[i] = domain.SavedExample{
			ID:     fmt.Sprintf("ex-%d", i),
			Name:   fmt.Sprintf("Example %d", i),
			Status: "OK",
			Code:   200,
			Header: []domain.SavedExampleHeader{{Key: "Content-Type", Value: "application/json"}},
			Body:   `{}`,
		}
	}
	manyRaw, _ := json.Marshal(many)
	if _, err := ValidateAndNormalizeExamples(domain.NewOptionalRawJSON(manyRaw), domain.ItemTypeRequest); !errors.Is(err, ErrExampleLimitExceeded) {
		t.Fatalf("expected ErrExampleLimitExceeded for >%d examples, got %v", MaxSavedExamplesPerItem, err)
	}
}

func TestApplySummaryModeToItems_BudgetAndProjection(t *testing.T) {
	largeName := strings.Repeat("n", 140)
	var examples []domain.SavedExample
	for i := range 25 {
		examples = append(examples, domain.SavedExample{
			ID:     fmt.Sprintf("id-%d", i),
			Revision: 1,
			Name:   fmt.Sprintf("%s-%d", largeName, i),
			Status: "OK",
			Code:   200,
			Header: []domain.SavedExampleHeader{{Key: "Content-Type", Value: "application/json"}},
			Body:   `{"big":true}`,
		})
	}
	exRaw, _ := json.Marshal(examples)

	// Build enough items so total summary JSON exceeds MaxSummaryResponseBudgetBytes.
	var items []*domain.CollectionItem
	for range 600 {
		items = append(items, &domain.CollectionItem{
			Type:     domain.ItemTypeRequest,
			Name:     "Req",
			Examples: domain.NewOptionalRawJSON(exRaw),
		})
	}

	ApplySummaryModeToItems(items)

	if items[0].Examples.Present {
		t.Fatal("summary mode must clear full Examples payload")
	}
	if items[0].ExampleCount == nil || *items[0].ExampleCount != 25 {
		t.Fatalf("expected example_count=25, got %v", items[0].ExampleCount)
	}
	if items[0].ExamplesLoaded == nil || *items[0].ExamplesLoaded {
		t.Fatal("expected examples_loaded=false")
	}
	if len(items[0].ExampleSummaries) != 25 {
		t.Fatalf("expected first item summaries preserved, got %d", len(items[0].ExampleSummaries))
	}

	truncatedFound := false
	for _, it := range items {
		if it.ExampleSummariesTruncated != nil && *it.ExampleSummariesTruncated {
			truncatedFound = true
			if it.ExampleSummaries != nil {
				t.Fatal("truncated item must omit example_summaries")
			}
		}
	}
	if !truncatedFound {
		t.Fatal("expected later items to mark example_summaries_truncated=true once budget exhausted")
	}
}
