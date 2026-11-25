package service

import (
	"bytes"
	"encoding/json"
	"encoding/xml"
	"errors"
	"fmt"
	"io"
	"mime"
	"regexp"
	"strings"
	"unicode/utf8"

	"github.com/adiputera/airrest-backend/core/domain"
)

const (
	MaxSavedExampleNameRunes         = 150
	MaxSavedExampleBytes             = 512 * 1024 // 512 KiB
	MaxSavedExamplesPerItem          = 50
	MaxSavedExamplesTotalBytesPerItm = 2 * 1024 * 1024 // 2 MiB
	MaxSummaryResponseBudgetBytes    = 2560 * 1024     // ~2.5 MiB safe identity budget before gzip
)

var (
	ErrExampleLimitExceeded = errors.New("saved examples limit exceeded")
	ErrExampleConflict      = errors.New("saved example conflict")
	ErrExampleNotFound      = errors.New("saved example not found")
	ErrExampleUnsupported   = errors.New("saved example content type or format is unsupported")
	htmlTagPattern          = regexp.MustCompile(`(?i)<(?:!doctype\s+html\b|!--[\s\S]*?--|[a-z][a-z0-9:-]*(?:\s[^<>]*)?\/?)>`)
)

func stripLeadingUTF8BOM(raw string) string {
	return strings.TrimPrefix(raw, "\uFEFF")
}

func hasDisallowedBinaryControlCharsGo(raw string) bool {
	for _, r := range raw {
		if r == '\u0000' {
			return true
		}
		if (r >= 0x01 && r <= 0x08) || r == 0x0B || r == 0x0C || (r >= 0x0E && r <= 0x1F) || r == 0x7F {
			return true
		}
	}
	return false
}

// ValidateSavedExampleName validates a saved example name against UTF-8, emptiness, and 150 runes.
func ValidateSavedExampleName(name string) (string, error) {
	if !utf8.ValidString(name) {
		return "", newValidationError("examples.name", "example name contains invalid UTF-8")
	}
	trimmed := strings.TrimSpace(name)
	if trimmed == "" {
		return "", newValidationError("examples.name", "example name cannot be empty")
	}
	if utf8.RuneCountInString(trimmed) > MaxSavedExampleNameRunes {
		return "", newValidationError("examples.name", fmt.Sprintf("example name cannot exceed %d characters", MaxSavedExampleNameRunes))
	}
	return trimmed, nil
}

func splitOutsideQuotesGo(input string, delimiter byte) []string {
	var parts []string
	var cur strings.Builder
	inQuotes := false
	escaped := false
	for i := 0; i < len(input); i++ {
		ch := input[i]
		if escaped {
			cur.WriteByte(ch)
			escaped = false
			continue
		}
		if ch == '\\' && inQuotes {
			cur.WriteByte(ch)
			escaped = true
			continue
		}
		if ch == '"' {
			inQuotes = !inQuotes
			cur.WriteByte(ch)
			continue
		}
		if ch == delimiter && !inQuotes {
			parts = append(parts, cur.String())
			cur.Reset()
			continue
		}
		cur.WriteByte(ch)
	}
	parts = append(parts, cur.String())
	return parts
}

func classifySingleMediaType(mt string) (lang string, strictXhtml bool, ok bool) {
	if !strings.HasPrefix(mt, "application/") && !strings.HasPrefix(mt, "text/") {
		return "", false, false
	}
	switch mt {
	case "application/json", "text/json", "application/problem+json", "application/vnd.api+json":
		return "json", false, true
	case "application/xml", "text/xml", "application/problem+xml":
		return "xml", false, true
	case "text/html":
		return "html", false, true
	case "application/xhtml+xml":
		return "html", true, true
	}
	if strings.HasPrefix(mt, "application/") && strings.HasSuffix(mt, "+json") {
		return "json", false, true
	}
	if strings.HasSuffix(mt, "+xml") {
		return "xml", false, true
	}
	return "", false, false
}

// ClassifyExampleMime maps a Content-Type header to json/xml/html + strict XHTML flag,
// splitting outside quotes and requiring every comma-joined entry and charset to be valid and consistent.
func ClassifyExampleMime(rawContentType string) (lang string, strictXhtml bool, ok bool) {
	trimmed := strings.TrimSpace(rawContentType)
	if trimmed == "" {
		return "", false, false
	}
	segments := splitOutsideQuotesGo(trimmed, ',')
	var resolvedLang string
	var resolvedCharset string
	seenValid := false
	for _, rawSeg := range segments {
		seg := strings.TrimSpace(rawSeg)
		if seg == "" {
			continue
		}
		mediaType, params, err := mime.ParseMediaType(seg)
		if err != nil {
			return "", false, false
		}
		mt := strings.ToLower(strings.TrimSpace(mediaType))
		segLang, segStrict, segOK := classifySingleMediaType(mt)
		if !segOK {
			return "", false, false
		}
		if !seenValid {
			resolvedLang = segLang
			seenValid = true
		} else if resolvedLang != segLang {
			return "", false, false
		}
		if segStrict {
			strictXhtml = true
		}
		if cs := strings.ToLower(strings.TrimSpace(params["charset"])); cs != "" {
			if resolvedCharset == "" {
				resolvedCharset = cs
			} else if resolvedCharset != cs {
				return "", false, false
			}
		}
	}
	if !seenValid {
		return "", false, false
	}
	return resolvedLang, strictXhtml, true
}

func isValidJSONExampleGo(body string) bool {
	if !utf8.ValidString(body) || strings.ContainsRune(body, '\u0000') {
		return false
	}
	withoutBOM := stripLeadingUTF8BOM(body)
	if strings.TrimSpace(withoutBOM) == "" {
		return false
	}
	dec := json.NewDecoder(strings.NewReader(withoutBOM))
	dec.UseNumber()
	var val any
	if err := dec.Decode(&val); err != nil {
		return false
	}
	var trailing any
	if err := dec.Decode(&trailing); err != io.EOF {
		return false
	}
	return true
}

func isValidXMLExampleGo(body string) bool {
	if !utf8.ValidString(body) || strings.ContainsRune(body, '\u0000') || hasDisallowedBinaryControlCharsGo(body) {
		return false
	}
	withoutBOM := stripLeadingUTF8BOM(body)
	if strings.TrimSpace(withoutBOM) == "" {
		return false
	}
	dec := xml.NewDecoder(strings.NewReader(withoutBOM))
	dec.Strict = true
	dec.Entity = xml.HTMLEntity
	dec.CharsetReader = func(charset string, input io.Reader) (io.Reader, error) {
		return input, nil
	}

	depth := 0
	sawRoot := false
	rootClosed := false
	for {
		tok, err := dec.Token()
		if err == io.EOF {
			return sawRoot && rootClosed && depth == 0
		}
		if err != nil {
			return false
		}
		switch t := tok.(type) {
		case xml.StartElement:
			if rootClosed {
				return false
			}
			sawRoot = true
			depth++
		case xml.EndElement:
			depth--
			if depth < 0 {
				return false
			}
			if depth == 0 {
				rootClosed = true
			}
		case xml.CharData:
			if depth == 0 && strings.TrimSpace(string(t)) != "" {
				return false
			}
		}
	}
}

func isValidHTMLExampleGo(body string, strictXhtml bool) bool {
	if !utf8.ValidString(body) || strings.ContainsRune(body, '\u0000') || hasDisallowedBinaryControlCharsGo(body) {
		return false
	}
	withoutBOM := stripLeadingUTF8BOM(body)
	if strings.TrimSpace(withoutBOM) == "" {
		return false
	}
	if strictXhtml {
		return isValidXMLExampleGo(body)
	}
	return htmlTagPattern.MatchString(withoutBOM)
}

func contentTypeFromExampleHeaders(headers []domain.SavedExampleHeader) string {
	var values []string
	for _, h := range headers {
		if h.Disabled {
			continue
		}
		if strings.EqualFold(strings.TrimSpace(h.Key), "content-type") && strings.TrimSpace(h.Value) != "" {
			values = append(values, strings.TrimSpace(h.Value))
		}
	}
	return strings.Join(values, ", ")
}

// ValidateSingleSavedExample validates one SavedExample and returns canonical normalized copy without leaking payload contents.
func ValidateSingleSavedExample(ex domain.SavedExample, seenIDs map[string]struct{}) (domain.SavedExample, error) {
	if strings.TrimSpace(ex.ID) == "" {
		return ex, newValidationError("examples.id", "example id is required")
	}
	if seenIDs != nil {
		if _, exists := seenIDs[ex.ID]; exists {
			return ex, newValidationError("examples.id", "duplicate example id within parent item")
		}
		seenIDs[ex.ID] = struct{}{}
	}
	if ex.Revision < 1 {
		ex.Revision = 1
	}
	trimmedName, err := ValidateSavedExampleName(ex.Name)
	if err != nil {
		return ex, err
	}
	ex.Name = trimmedName

	if ex.Code < 100 || ex.Code > 599 {
		return ex, newValidationError("examples.code", "example HTTP status code must be between 100 and 599")
	}
	if !utf8.ValidString(ex.Status) {
		return ex, newValidationError("examples.status", "example status contains invalid UTF-8")
	}
	if !utf8.ValidString(ex.Body) || strings.ContainsRune(ex.Body, '\u0000') {
		return ex, newValidationError("examples.body", "example response body contains invalid characters or NUL bytes")
	}
	if strings.TrimSpace(stripLeadingUTF8BOM(ex.Body)) == "" {
		return ex, newValidationError("examples.body", "example response body cannot be empty")
	}

	ctHeader := contentTypeFromExampleHeaders(ex.Header)
	lang, strictXhtml, mimeOK := ClassifyExampleMime(ctHeader)
	if !mimeOK {
		return ex, newValidationError("examples.header", "example Content-Type must be JSON, XML, or HTML")
	}

	switch lang {
	case "json":
		if !isValidJSONExampleGo(ex.Body) {
			return ex, newValidationError("examples.body", "example body does not contain valid JSON matching its declared format")
		}
	case "xml":
		if !isValidXMLExampleGo(ex.Body) {
			return ex, newValidationError("examples.body", "example body does not contain well-formed XML matching its declared format")
		}
	case "html":
		if !isValidHTMLExampleGo(ex.Body, strictXhtml) {
			return ex, newValidationError("examples.body", "example body does not contain valid HTML matching its declared format")
		}
	default:
		return ex, newValidationError("examples", "unsupported example format")
	}

	ex.PreviewLanguage = &lang
	if ex.Header == nil {
		ex.Header = []domain.SavedExampleHeader{}
	}
	if ex.Cookie == nil {
		ex.Cookie = []any{}
	}

	encoded, err := json.Marshal(ex)
	if err != nil {
		return ex, newValidationError("examples", "failed to serialize saved example")
	}
	if len(encoded) > MaxSavedExampleBytes {
		return ex, fmt.Errorf("%w: single saved example exceeds %d KiB limit", ErrExampleLimitExceeded, MaxSavedExampleBytes/1024)
	}

	return ex, nil
}

// ValidateAndNormalizeExamples parses, validates, and serializes a collection item's examples array.
func ValidateAndNormalizeExamples(raw domain.OptionalRawJSON, itemType domain.ItemType) (json.RawMessage, error) {
	if !raw.Present {
		return nil, nil
	}
	if raw.IsNull {
		return nil, newValidationError("examples", "examples cannot be null; omit to preserve or use [] to clear")
	}
	trimmed := bytes.TrimSpace(raw.Raw)
	if len(trimmed) == 0 {
		trimmed = []byte("[]")
	}

	var parsed []domain.SavedExample
	if err := json.Unmarshal(trimmed, &parsed); err != nil {
		return nil, newValidationError("examples", "examples must be a valid array")
	}
	if parsed == nil {
		return nil, newValidationError("examples", "examples cannot be null; use [] to clear")
	}

	if itemType == domain.ItemTypeFolder && len(parsed) > 0 {
		return nil, newValidationError("examples", "folders cannot contain saved examples")
	}
	if len(parsed) > MaxSavedExamplesPerItem {
		return nil, fmt.Errorf("%w: item cannot contain more than %d saved examples", ErrExampleLimitExceeded, MaxSavedExamplesPerItem)
	}

	normalized := make([]domain.SavedExample, 0, len(parsed))
	seenIDs := make(map[string]struct{}, len(parsed))
	for _, ex := range parsed {
		norm, err := ValidateSingleSavedExample(ex, seenIDs)
		if err != nil {
			return nil, err
		}
		normalized = append(normalized, norm)
	}

	canonicalBytes, err := json.Marshal(normalized)
	if err != nil {
		return nil, newValidationError("examples", "failed to encode normalized examples")
	}
	if len(canonicalBytes) > MaxSavedExamplesTotalBytesPerItm {
		return nil, fmt.Errorf("%w: total examples payload per item exceeds %d MiB limit", ErrExampleLimitExceeded, MaxSavedExamplesTotalBytesPerItm/(1024*1024))
	}

	return json.RawMessage(canonicalBytes), nil
}

// ParseStoredExamples decodes persisted examples bytes from PostgreSQL cleanly.
func ParseStoredExamples(raw domain.OptionalRawJSON) ([]domain.SavedExample, error) {
	if !raw.Present || raw.IsNull || len(bytes.TrimSpace(raw.Raw)) == 0 {
		return []domain.SavedExample{}, nil
	}
	var list []domain.SavedExample
	if err := json.Unmarshal(raw.Raw, &list); err != nil {
		return nil, err
	}
	if list == nil {
		return []domain.SavedExample{}, nil
	}
	return list, nil
}

// BuildExampleSummaries converts full SavedExample entries into lightweight summary metadata.
func BuildExampleSummaries(examples []domain.SavedExample) []domain.SavedExampleSummary {
	out := make([]domain.SavedExampleSummary, 0, len(examples))
	for _, ex := range examples {
		rev := ex.Revision
		if rev < 1 {
			rev = 1
		}
		out = append(out, domain.SavedExampleSummary{
			ID:              ex.ID,
			Revision:        rev,
			Name:            ex.Name,
			Code:            ex.Code,
			Status:          ex.Status,
			PreviewLanguage: ex.PreviewLanguage,
			BodySizeBytes:   len(ex.Body),
		})
	}
	return out
}

// ApplySummaryModeToItem strips body payloads from a CollectionItem for collection/delta/reorder views
// and enforces a safe response byte budget by setting example_summaries_truncated when needed.
func ApplySummaryModeToItem(item *domain.CollectionItem, budgetRemaining *int) {
	if item == nil {
		return
	}
	if item.Type == domain.ItemTypeFolder {
		item.Examples = domain.OptionalRawJSON{}
		item.ExampleSummaries = nil
		zero := 0
		loaded := true
		item.ExampleCount = &zero
		item.ExamplesLoaded = &loaded
		item.ExampleSummariesTruncated = nil
		return
	}

	examples, err := ParseStoredExamples(item.Examples)
	if err != nil {
		examples = []domain.SavedExample{}
	}
	count := len(examples)
	item.Examples = domain.OptionalRawJSON{}
	item.ExampleCount = &count

	if count == 0 {
		loaded := true
		item.ExamplesLoaded = &loaded
		item.ExampleSummaries = []domain.SavedExampleSummary{}
		item.ExampleSummariesTruncated = nil
		return
	}

	loaded := false
	item.ExamplesLoaded = &loaded
	summaries := BuildExampleSummaries(examples)

	if budgetRemaining == nil {
		item.ExampleSummaries = summaries
		return
	}

	encoded, err := json.Marshal(summaries)
	if err != nil || len(encoded) > *budgetRemaining {
		trunc := true
		item.ExampleSummaries = nil
		item.ExampleSummariesTruncated = &trunc
		return
	}
	*budgetRemaining -= len(encoded)
	item.ExampleSummaries = summaries
}

// ApplySummaryModeToItems projects summary metadata across a list/tree within a total JSON budget.
func ApplySummaryModeToItems(items []*domain.CollectionItem) {
	budget := MaxSummaryResponseBudgetBytes
	var walk func(list []*domain.CollectionItem)
	walk = func(list []*domain.CollectionItem) {
		for _, it := range list {
			if it == nil {
				continue
			}
			ApplySummaryModeToItem(it, &budget)
			if len(it.Items) > 0 {
				walk(it.Items)
			}
		}
	}
	walk(items)
}

// MarkItemFullExamples attaches metadata flags indicating full examples are loaded on the item.
func MarkItemFullExamples(item *domain.CollectionItem) {
	if item == nil {
		return
	}
	if item.Type == domain.ItemTypeFolder {
		zero := 0
		loaded := true
		item.ExampleCount = &zero
		item.ExamplesLoaded = &loaded
		item.Examples = domain.OptionalRawJSON{}
		return
	}
	examples, err := ParseStoredExamples(item.Examples)
	if err != nil {
		examples = []domain.SavedExample{}
	}
	count := len(examples)
	loaded := true
	canonical, _ := json.Marshal(examples)
	item.Examples = domain.NewOptionalRawJSON(canonical)
	item.ExampleCount = &count
	item.ExamplesLoaded = &loaded
	item.ExampleSummaries = BuildExampleSummaries(examples)
}
