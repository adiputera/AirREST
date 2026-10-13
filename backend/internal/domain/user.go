package domain

import (
	"time"

	"github.com/google/uuid"
)

type SystemRole string

const (
	RoleSuperadmin SystemRole = "superadmin"
	RoleUser       SystemRole = "user"
)

type User struct {
	ID           uuid.UUID  `json:"id"`
	Email        string     `json:"email"`
	PasswordHash string     `json:"-"`
	Name         string     `json:"name"`
	AvatarURL    *string    `json:"avatar_url,omitempty"`
	Role         SystemRole `json:"role"`
	CreatedAt    time.Time  `json:"created_at"`
	UpdatedAt    time.Time  `json:"updated_at"`
}

func (u *User) IsSuperadmin() bool {
	return u.Role == RoleSuperadmin
}
