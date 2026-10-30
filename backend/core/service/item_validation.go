package service

import (
	"encoding/json"
	"errors"
	"fmt"
	"strings"

	"github.com/adiputera/airrest-backend/core/domain"
)

var (
	ErrInvalidItemPayload = errors.New("invalid item payload")
)

type ItemValidationError struct {
	Field   string
	Message string
}

func (e *ItemValidationError) Error() string {
	if e.Field != "" {
		return fmt.Sprintf("invalid %s: %s", e.Field, e.Message)
	}
	return e.Message
}

func (e *ItemValidationError) Unwrap() error {
	return ErrInvalidItemPayload
}

func newValidationError(field, message string) error {
	return &ItemValidationError{
		Field:   field,
		Message: message,
	}
}

func validateName(name string) error {
	trimmed := strings.TrimSpace(name)
	if trimmed == "" {
		return newValidationError("name", "name is required")
	}
	if len(trimmed) > 150 {
		return newValidationError("name", "name exceeds maximum length of 150 characters")
	}
	return nil
}

func validateType(itemType domain.ItemType) error {
	switch itemType {
	case domain.ItemTypeFolder, domain.ItemTypeRequest:
		return nil
	default:
		return newValidationError("type", "must be 'folder' or 'request'")
	}
}

func validateMethod(method *string, itemType domain.ItemType) error {
	if itemType == domain.ItemTypeFolder {
		return nil
	}
	if method == nil || strings.TrimSpace(*method) == "" {
		return nil
	}
	m := strings.ToUpper(strings.TrimSpace(*method))
	switch m {
	case "GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS":
		return nil
	default:
		return newValidationError("method", "unsupported HTTP method")
	}
}

func validateBodyType(bodyType *string) error {
	if bodyType == nil || strings.TrimSpace(*bodyType) == "" {
		return nil
	}
	bt := strings.TrimSpace(*bodyType)
	switch bt {
	case "none", "json", "xml", "raw", "x-www-form-urlencoded", "form-data", "binary", "graphql":
		return nil
	default:
		return newValidationError("body_type", "unsupported body type")
	}
}

func validateRawType(rawType *string) error {
	if rawType == nil || strings.TrimSpace(*rawType) == "" {
		return nil
	}
	rt := strings.TrimSpace(*rawType)
	switch rt {
	case "text", "json", "xml", "html":
		return nil
	default:
		return newValidationError("raw_type", "unsupported raw type")
	}
}

func validateKeyValueArray(raw *json.RawMessage, fieldName string) error {
	if raw == nil {
		return nil
	}
	trimmed := strings.TrimSpace(string(*raw))
	if trimmed == "" || trimmed == "null" {
		return nil
	}

	var rawItems []json.RawMessage
	if err := json.Unmarshal([]byte(trimmed), &rawItems); err != nil {
		return newValidationError(fieldName, "must be a JSON array")
	}

	for i, elem := range rawItems {
		elemTrimmed := strings.TrimSpace(string(elem))
		if elemTrimmed == "" || elemTrimmed == "null" {
			return newValidationError(fmt.Sprintf("%s[%d]", fieldName, i), "item cannot be null")
		}

		var itemMap map[string]any
		if err := json.Unmarshal([]byte(elemTrimmed), &itemMap); err != nil {
			return newValidationError(fmt.Sprintf("%s[%d]", fieldName, i), "item must be a key-value object")
		}

		if idVal, exists := itemMap["id"]; exists && idVal != nil {
			if _, ok := idVal.(string); !ok {
				return newValidationError(fmt.Sprintf("%s[%d].id", fieldName, i), "must be a string")
			}
		}

		if keyVal, exists := itemMap["key"]; exists && keyVal != nil {
			if _, ok := keyVal.(string); !ok {
				return newValidationError(fmt.Sprintf("%s[%d].key", fieldName, i), "must be a string")
			}
		}

		if valVal, exists := itemMap["value"]; exists && valVal != nil {
			if _, ok := valVal.(string); !ok {
				return newValidationError(fmt.Sprintf("%s[%d].value", fieldName, i), "must be a string")
			}
		}

		if enabledVal, exists := itemMap["enabled"]; exists && enabledVal != nil {
			if _, ok := enabledVal.(bool); !ok {
				return newValidationError(fmt.Sprintf("%s[%d].enabled", fieldName, i), "must be a boolean")
			}
		}

		if descVal, exists := itemMap["description"]; exists && descVal != nil {
			if _, ok := descVal.(string); !ok {
				return newValidationError(fmt.Sprintf("%s[%d].description", fieldName, i), "must be a string")
			}
		}
	}

	return nil
}

func validateAuthConfig(raw *json.RawMessage) error {
	if raw == nil {
		return nil
	}
	trimmed := strings.TrimSpace(string(*raw))
	if trimmed == "" || trimmed == "null" {
		return nil
	}

	var authMap map[string]any
	if err := json.Unmarshal([]byte(trimmed), &authMap); err != nil {
		return newValidationError("auth", "must be a JSON object")
	}

	typeVal, exists := authMap["type"]
	if !exists || typeVal == nil {
		return newValidationError("auth.type", "type is required")
	}
	typeStr, ok := typeVal.(string)
	if !ok {
		return newValidationError("auth.type", "type must be a string")
	}

	switch typeStr {
	case "none", "bearer", "basic", "apikey":
		// valid
	default:
		return newValidationError("auth.type", "unsupported auth type")
	}

	for _, stringField := range []string{"bearerToken", "basicUsername", "basicPassword", "apiKeyKey", "apiKeyValue"} {
		if val, exists := authMap[stringField]; exists && val != nil {
			if _, ok := val.(string); !ok {
				return newValidationError("auth."+stringField, "must be a string")
			}
		}
	}

	if inVal, exists := authMap["apiKeyIn"]; exists && inVal != nil {
		inStr, ok := inVal.(string)
		if !ok || (inStr != "header" && inStr != "query") {
			return newValidationError("auth.apiKeyIn", "must be 'header' or 'query'")
		}
	}

	return nil
}

func validateFormDataArray(raw *json.RawMessage) error {
	if raw == nil {
		return nil
	}
	trimmed := strings.TrimSpace(string(*raw))
	if trimmed == "" || trimmed == "null" {
		return nil
	}

	var rawItems []json.RawMessage
	if err := json.Unmarshal([]byte(trimmed), &rawItems); err != nil {
		return newValidationError("body_form_data", "must be a JSON array")
	}

	for i, elem := range rawItems {
		elemTrimmed := strings.TrimSpace(string(elem))
		if elemTrimmed == "" || elemTrimmed == "null" {
			return newValidationError(fmt.Sprintf("body_form_data[%d]", i), "item cannot be null")
		}

		var itemMap map[string]any
		if err := json.Unmarshal([]byte(elemTrimmed), &itemMap); err != nil {
			return newValidationError(fmt.Sprintf("body_form_data[%d]", i), "item must be an object")
		}

		if keyVal, exists := itemMap["key"]; exists && keyVal != nil {
			if _, ok := keyVal.(string); !ok {
				return newValidationError(fmt.Sprintf("body_form_data[%d].key", i), "must be a string")
			}
		}

		if typeVal, exists := itemMap["type"]; exists && typeVal != nil {
			if tStr, ok := typeVal.(string); !ok || (tStr != "text" && tStr != "file") {
				return newValidationError(fmt.Sprintf("body_form_data[%d].type", i), "type must be 'text' or 'file'")
			}
		}

		if enabledVal, exists := itemMap["enabled"]; exists && enabledVal != nil {
			if _, ok := enabledVal.(bool); !ok {
				return newValidationError(fmt.Sprintf("body_form_data[%d].enabled", i), "must be a boolean")
			}
		}
	}

	return nil
}

func ValidateCollectionItem(item *domain.CollectionItem) error {
	if item == nil {
		return newValidationError("item", "item cannot be nil")
	}
	if err := validateName(item.Name); err != nil {
		return err
	}
	if err := validateType(item.Type); err != nil {
		return err
	}
	if err := validateMethod(item.Method, item.Type); err != nil {
		return err
	}
	if err := validateBodyType(item.BodyType); err != nil {
		return err
	}
	if err := validateRawType(item.RawType); err != nil {
		return err
	}
	if err := validateKeyValueArray(item.Params, "params"); err != nil {
		return err
	}
	if err := validateKeyValueArray(item.PathVariables, "path_variables"); err != nil {
		return err
	}
	if err := validateKeyValueArray(item.Headers, "headers"); err != nil {
		return err
	}
	if err := validateAuthConfig(item.Auth); err != nil {
		return err
	}
	if err := validateFormDataArray(item.BodyFormData); err != nil {
		return err
	}
	return nil
}

func ValidateImportItem(item *ImportItemRequest) error {
	if item == nil {
		return newValidationError("item", "item cannot be nil")
	}
	if err := validateName(item.Name); err != nil {
		return err
	}
	itemType := domain.ItemType(item.Type)
	if item.Type == "" {
		itemType = domain.ItemTypeRequest
	}
	if err := validateType(itemType); err != nil {
		return err
	}
	if err := validateMethod(item.Method, itemType); err != nil {
		return err
	}
	if err := validateBodyType(item.BodyType); err != nil {
		return err
	}
	if err := validateRawType(item.RawType); err != nil {
		return err
	}
	if err := validateKeyValueArray(item.Params, "params"); err != nil {
		return err
	}
	if err := validateKeyValueArray(item.PathVariables, "path_variables"); err != nil {
		return err
	}
	if err := validateKeyValueArray(item.Headers, "headers"); err != nil {
		return err
	}
	if err := validateAuthConfig(item.Auth); err != nil {
		return err
	}
	if err := validateFormDataArray(item.BodyFormData); err != nil {
		return err
	}
	return nil
}
