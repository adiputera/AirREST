package service

import "errors"

const (
	MaxSyncMutations     = 500
	MaxImportCollections = 100
	MaxImportItems       = 5000
	MaxImportDepth       = 32
)

var (
	ErrInvalidScope   = errors.New("exactly one of workspace_id or project_id is required")
	ErrBatchLimit     = errors.New("batch exceeds mutation, collection, item, or nesting limit")
	ErrImportConflict = errors.New("import changed concurrently; retry the complete import")
)

func validateImport(collections []ImportCollectionRequest) error {
	if len(collections) > MaxImportCollections {
		return ErrBatchLimit
	}
	total := 0
	var walk func([]ImportItemRequest, int) error
	walk = func(items []ImportItemRequest, depth int) error {
		if len(items) == 0 {
			return nil
		}
		if depth > MaxImportDepth {
			return ErrBatchLimit
		}
		total += len(items)
		if total > MaxImportItems {
			return ErrBatchLimit
		}
		for _, item := range items {
			if err := walk(item.Items, depth+1); err != nil {
				return err
			}
		}
		return nil
	}
	for _, col := range collections {
		if err := walk(col.Items, 1); err != nil {
			return err
		}
	}
	return nil
}
