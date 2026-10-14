package hasher

import "testing"

func TestHashAndCheckPassword(t *testing.T) {
	password := "SecretP@ssw0rd!"

	hash, err := HashPassword(password)
	if err != nil {
		t.Fatalf("expected no error hashing password, got %v", err)
	}

	if hash == password {
		t.Fatalf("hash should not match plaintext password")
	}

	if !CheckPassword(password, hash) {
		t.Fatalf("expected password to match hash")
	}

	if CheckPassword("WrongPassword123", hash) {
		t.Fatalf("expected wrong password to fail check")
	}
}
