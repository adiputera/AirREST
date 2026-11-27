package service

import (
	"encoding/json"
	"errors"
	"strings"
	"testing"

	"github.com/adiputera/airrest-backend/core/domain"
	"github.com/google/uuid"
)

func rawJSON(s string) *json.RawMessage {
	rm := json.RawMessage(s)
	return &rm
}

func strPtr(s string) *string {
	return &s
}

func TestValidateCollectionItem(t *testing.T) {
	validReq := &domain.CollectionItem{
		ID:           uuid.New(),
		CollectionID: uuid.New(),
		Type:         domain.ItemTypeRequest,
		Name:         "Get Users",
		Method:       strPtr("GET"),
		BodyType:     strPtr("none"),
		RawType:      strPtr("text"),
		Params:       rawJSON(`[{"id":"p1","key":"limit","value":"10","enabled":true}]`),
		Headers:      rawJSON(`[{"id":"h1","key":"Accept","value":"application/json","enabled":true}]`),
		Auth:         rawJSON(`{"type":"bearer","bearerToken":"secret_token_123"}`),
	}

	if err := ValidateCollectionItem(validReq); err != nil {
		t.Fatalf("expected valid item to pass, got error: %v", err)
	}

	// 1. Nil item
	if err := ValidateCollectionItem(nil); !errors.Is(err, ErrInvalidItemPayload) {
		t.Errorf("expected ErrInvalidItemPayload for nil item, got: %v", err)
	}

	// 2. Name validation
	blankName := *validReq
	blankName.Name = "   "
	if err := ValidateCollectionItem(&blankName); !errors.Is(err, ErrInvalidItemPayload) {
		t.Errorf("expected ErrInvalidItemPayload for blank name, got: %v", err)
	}

	longName := *validReq
	longName.Name = strings.Repeat("a", 151)
	if err := ValidateCollectionItem(&longName); !errors.Is(err, ErrInvalidItemPayload) {
		t.Errorf("expected ErrInvalidItemPayload for overly long name, got: %v", err)
	}

	// Unicode rune boundary: 40 emojis (160 UTF-8 bytes, 40 runes) and 150 runes must pass; 151 runes must fail.
	emoji40 := *validReq
	emoji40.Name = strings.Repeat("🚀", 40)
	if err := ValidateCollectionItem(&emoji40); err != nil {
		t.Errorf("expected 40-emoji (160-byte, 40-rune) name to pass, got: %v", err)
	}

	rune150 := *validReq
	rune150.Name = strings.Repeat("あ", 150)
	if err := ValidateCollectionItem(&rune150); err != nil {
		t.Errorf("expected 150-rune name to pass, got: %v", err)
	}

	rune151 := *validReq
	rune151.Name = strings.Repeat("あ", 151)
	if err := ValidateCollectionItem(&rune151); !errors.Is(err, ErrInvalidItemPayload) {
		t.Errorf("expected ErrInvalidItemPayload for 151-rune name, got: %v", err)
	}

	invalidUTF8 := *validReq
	invalidUTF8.Name = string([]byte{0xff, 0xfe, 'a'})
	if err := ValidateCollectionItem(&invalidUTF8); !errors.Is(err, ErrInvalidItemPayload) {
		t.Errorf("expected ErrInvalidItemPayload for invalid UTF-8 name, got: %v", err)
	}

	// 3. Type validation
	invalidType := *validReq
	invalidType.Type = "unknown"
	if err := ValidateCollectionItem(&invalidType); !errors.Is(err, ErrInvalidItemPayload) {
		t.Errorf("expected ErrInvalidItemPayload for invalid type, got: %v", err)
	}

	// 4. Method validation
	invalidMethod := *validReq
	invalidMethod.Method = strPtr("INVALID_METHOD")
	if err := ValidateCollectionItem(&invalidMethod); !errors.Is(err, ErrInvalidItemPayload) {
		t.Errorf("expected ErrInvalidItemPayload for invalid method, got: %v", err)
	}

	// Folder item should allow nil method
	folderItem := &domain.CollectionItem{
		ID:           uuid.New(),
		CollectionID: uuid.New(),
		Type:         domain.ItemTypeFolder,
		Name:         "Auth Folder",
	}
	if err := ValidateCollectionItem(folderItem); err != nil {
		t.Errorf("expected folder item to be valid, got: %v", err)
	}

	// 5. BodyType & RawType
	invalidBodyType := *validReq
	invalidBodyType.BodyType = strPtr("unsupported_body")
	if err := ValidateCollectionItem(&invalidBodyType); !errors.Is(err, ErrInvalidItemPayload) {
		t.Errorf("expected ErrInvalidItemPayload for invalid body_type, got: %v", err)
	}

	invalidRawType := *validReq
	invalidRawType.RawType = strPtr("unsupported_raw")
	if err := ValidateCollectionItem(&invalidRawType); !errors.Is(err, ErrInvalidItemPayload) {
		t.Errorf("expected ErrInvalidItemPayload for invalid raw_type, got: %v", err)
	}

	// 6. Params validation
	objectParams := *validReq
	objectParams.Params = rawJSON(`{}`)
	if err := ValidateCollectionItem(&objectParams); !errors.Is(err, ErrInvalidItemPayload) {
		t.Errorf("expected ErrInvalidItemPayload for params as object, got: %v", err)
	}

	nullElemParams := *validReq
	nullElemParams.Params = rawJSON(`[null]`)
	if err := ValidateCollectionItem(&nullElemParams); !errors.Is(err, ErrInvalidItemPayload) {
		t.Errorf("expected ErrInvalidItemPayload for params with null element, got: %v", err)
	}

	wrongKeyTypeParams := *validReq
	wrongKeyTypeParams.Params = rawJSON(`[{"key": 123}]`)
	if err := ValidateCollectionItem(&wrongKeyTypeParams); !errors.Is(err, ErrInvalidItemPayload) {
		t.Errorf("expected ErrInvalidItemPayload for params with non-string key, got: %v", err)
	}

	// 7. Headers validation
	objectHeaders := *validReq
	objectHeaders.Headers = rawJSON(`{}`)
	if err := ValidateCollectionItem(&objectHeaders); !errors.Is(err, ErrInvalidItemPayload) {
		t.Errorf("expected ErrInvalidItemPayload for headers as object, got: %v", err)
	}

	nullElemHeaders := *validReq
	nullElemHeaders.Headers = rawJSON(`[null]`)
	if err := ValidateCollectionItem(&nullElemHeaders); !errors.Is(err, ErrInvalidItemPayload) {
		t.Errorf("expected ErrInvalidItemPayload for headers with null element, got: %v", err)
	}

	// 8. Auth validation
	arrayAuth := *validReq
	arrayAuth.Auth = rawJSON(`[]`)
	if err := ValidateCollectionItem(&arrayAuth); !errors.Is(err, ErrInvalidItemPayload) {
		t.Errorf("expected ErrInvalidItemPayload for auth as array, got: %v", err)
	}

	missingTypeAuth := *validReq
	missingTypeAuth.Auth = rawJSON(`{}`)
	if err := ValidateCollectionItem(&missingTypeAuth); !errors.Is(err, ErrInvalidItemPayload) {
		t.Errorf("expected ErrInvalidItemPayload for auth missing type, got: %v", err)
	}

	invalidTypeAuth := *validReq
	invalidTypeAuth.Auth = rawJSON(`{"type":"custom_jwt"}`)
	if err := ValidateCollectionItem(&invalidTypeAuth); !errors.Is(err, ErrInvalidItemPayload) {
		t.Errorf("expected ErrInvalidItemPayload for auth with invalid type, got: %v", err)
	}

	invalidApiKeyInAuth := *validReq
	invalidApiKeyInAuth.Auth = rawJSON(`{"type":"apikey","apiKeyIn":"payload"}`)
	if err := ValidateCollectionItem(&invalidApiKeyInAuth); !errors.Is(err, ErrInvalidItemPayload) {
		t.Errorf("expected ErrInvalidItemPayload for auth with invalid apiKeyIn, got: %v", err)
	}

	// Ensure sensitive values are NOT leaked in error messages
	leakCheckAuth := *validReq
	secretPass := "mySuperSecretPassword123"
	leakCheckAuth.Auth = rawJSON(`{"type":"basic","basicPassword":12345}`)
	err := ValidateCollectionItem(&leakCheckAuth)
	if err == nil {
		t.Fatalf("expected error for non-string basicPassword")
	}
	if strings.Contains(err.Error(), secretPass) {
		t.Fatalf("error message must never leak passwords/tokens, got: %s", err.Error())
	}
}

func TestValidateImportItem(t *testing.T) {
	validImport := &ImportItemRequest{
		ID:        uuid.New().String(),
		Type:      "request",
		Name:      "Imported API",
		Method:    strPtr("POST"),
		Params:    rawJSON(`[]`),
		Headers:   rawJSON(`[]`),
		Auth:      rawJSON(`{"type":"none"}`),
		SortOrder: 0,
	}

	if err := ValidateImportItem(validImport); err != nil {
		t.Fatalf("expected valid import item to pass, got: %v", err)
	}

	// Empty type should default to request and pass
	defaultTypeImport := *validImport
	defaultTypeImport.Type = ""
	if err := ValidateImportItem(&defaultTypeImport); err != nil {
		t.Fatalf("expected empty type in import item to default to request and pass, got: %v", err)
	}

	// Malformed headers in import
	invalidHeadersImport := *validImport
	invalidHeadersImport.Headers = rawJSON(`{}`)
	if err := ValidateImportItem(&invalidHeadersImport); !errors.Is(err, ErrInvalidItemPayload) {
		t.Fatalf("expected ErrInvalidItemPayload for import with object headers, got: %v", err)
	}

	// Valid path variables in import
	validPathVarsImport := *validImport
	validPathVarsImport.PathVariables = rawJSON(`[{"id":"pv1","key":"id","value":"550e8400","enabled":true,"description":"Rule ID"}]`)
	if err := ValidateImportItem(&validPathVarsImport); err != nil {
		t.Fatalf("expected valid path variables to pass, got: %v", err)
	}

	// Invalid path variables in import (not an array)
	invalidPathVarsImport := *validImport
	invalidPathVarsImport.PathVariables = rawJSON(`{"id":"not-an-array"}`)
	if err := ValidateImportItem(&invalidPathVarsImport); !errors.Is(err, ErrInvalidItemPayload) {
		t.Fatalf("expected ErrInvalidItemPayload for non-array path variables, got: %v", err)
	}

	// Valid form-data attachment metadata in import
	validFormMetaImport := *validImport
	validFormMetaImport.BodyType = strPtr("form-data")
	validFormMetaImport.BodyFormData = rawJSON(`[{"id":"fd1","key":"file","type":"file","value":"doc.pdf","fileName":"doc.pdf","fileSize":2048,"fileType":"application/pdf","needsReselection":true,"enabled":true}]`)
	if err := ValidateImportItem(&validFormMetaImport); err != nil {
		t.Fatalf("expected valid form-data metadata in import to pass, got: %v", err)
	}

	// Invalid form-data attachment metadata types
	invalidFormMetaImport := *validImport
	invalidFormMetaImport.BodyType = strPtr("form-data")
	invalidFormMetaImport.BodyFormData = rawJSON(`[{"id":"fd1","key":"file","type":"file","fileSize":"bad","needsReselection":"nope"}]`)
	if err := ValidateImportItem(&invalidFormMetaImport); !errors.Is(err, ErrInvalidItemPayload) {
		t.Fatalf("expected ErrInvalidItemPayload for invalid form-data metadata in import, got: %v", err)
	}

	// Non-folder item with nested child items must be rejected (BKD-08)
	nonFolderWithChildren := *validImport
	nonFolderWithChildren.Items = []ImportItemRequest{{Name: "Child", Type: "request"}}
	if err := ValidateImportItem(&nonFolderWithChildren); !errors.Is(err, ErrInvalidItemPayload) {
		t.Fatalf("expected ErrInvalidItemPayload when request item contains nested items, got: %v", err)
	}
}

func TestEnvironmentValidationHelpers(t *testing.T) {
	if err := validateEnvironmentMinRole("super_invalid"); !errors.Is(err, ErrInvalidItemPayload) {
		t.Fatalf("expected ErrInvalidItemPayload for invalid environment min_role, got: %v", err)
	}
	if err := validateEnvironmentMinRole(domain.ProjectRoleMaintainer); err != nil {
		t.Fatalf("expected valid environment min_role to pass, got: %v", err)
	}

	if err := validateEnvironmentVariables(rawJSON(`["not-an-object"]`)); !errors.Is(err, ErrInvalidItemPayload) {
		t.Fatalf("expected ErrInvalidItemPayload for string element in variables, got: %v", err)
	}
	if err := validateEnvironmentVariables(rawJSON(`null`)); !errors.Is(err, ErrInvalidItemPayload) {
		t.Fatalf("expected ErrInvalidItemPayload for null variables, got: %v", err)
	}
	if err := validateEnvironmentVariables(rawJSON(`[{"id":"v1","key":"host","value":"example.com","enabled":true}]`)); err != nil {
		t.Fatalf("expected valid variables array of objects to pass, got: %v", err)
	}
}
