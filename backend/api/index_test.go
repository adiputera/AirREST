package handler

import (
	"context"
	"encoding/json"
	"errors"
	"github.com/adiputera/airrest-backend/core/app"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func TestInitializationRetriesAndReusesSuccess(t *testing.T) {
	now := time.Unix(100, 0)
	calls := 0
	expected := &app.App{}
	s := &appInitializer{now: func() time.Time { return now }, initialize: func(context.Context) (*app.App, error) {
		calls++
		if calls == 1 {
			return nil, errors.New("temporary failure")
		}
		return expected, nil
	}}
	if _, err := s.get(context.Background()); err == nil {
		t.Fatal("expected first failure")
	}
	if _, err := s.get(context.Background()); err == nil || calls != 1 {
		t.Fatal("backoff did not prevent attempt")
	}
	now = now.Add(time.Second)
	for range 3 {
		a, err := s.get(context.Background())
		if err != nil || a != expected {
			t.Fatalf("retry/reuse failed: %v", err)
		}
	}
	if calls != 2 {
		t.Fatalf("got %d attempts", calls)
	}
}

func TestConcurrentInitializationRunsOnce(t *testing.T) {
	entered, release := make(chan struct{}), make(chan struct{})
	var calls atomic.Int32
	s := &appInitializer{now: time.Now, initialize: func(ctx context.Context) (*app.App, error) {
		calls.Add(1)
		close(entered)
		<-release
		return &app.App{}, nil
	}}
	done := make(chan struct{})
	go func() { defer close(done); _, _ = s.get(context.Background()) }()
	<-entered
	var wg sync.WaitGroup
	for range 20 {
		wg.Go(func() {
			if _, err := s.get(context.Background()); err == nil {
				t.Error("in-progress initialization must return unavailable")
			}
		})
	}
	wg.Wait()
	close(release)
	<-done
	if calls.Load() != 1 {
		t.Fatal("duplicate initialization")
	}
	if _, err := s.get(context.Background()); err != nil {
		t.Fatal(err)
	}
}

func TestInitErrorReasons(t *testing.T) {
	cases := []struct {
		err    error
		reason string
	}{
		{errInitializing, "INITIALIZING"},
		{&app.StartupError{Stage: app.StageConfig, Err: errors.New("raw-secret-jwt")}, "CONFIG_INVALID"},
		{&app.StartupError{Stage: app.StageDatabase, Err: errors.New("raw-secret-ping")}, "DATABASE_UNAVAILABLE"},
		{&app.StartupError{Stage: app.StageMigration, Err: errors.New("raw-secret-ddl")}, "MIGRATION_FAILED"},
		{&app.StartupError{Stage: app.StageBootstrap, Err: errors.New("raw-secret-admin")}, "BOOTSTRAP_FAILED"},
		{errors.New("raw-secret-unknown"), "INITIALIZATION_FAILED"},
	}
	for _, c := range cases {
		w := httptest.NewRecorder()
		writeInitError(w, c.err)
		if w.Code != http.StatusServiceUnavailable || w.Header().Get("Retry-After") != "1" {
			t.Fatalf("%s: unexpected status/header %d %q", c.reason, w.Code, w.Header().Get("Retry-After"))
		}
		var body struct {
			Success bool `json:"success"`
			Error   struct {
				Code    string `json:"code"`
				Reason  string `json:"reason"`
				Message string `json:"message"`
			} `json:"error"`
		}
		if err := json.Unmarshal(w.Body.Bytes(), &body); err != nil {
			t.Fatal(err)
		}
		if body.Success || body.Error.Code != "SERVICE_UNAVAILABLE" || body.Error.Reason != c.reason || body.Error.Message == "" {
			t.Fatalf("unexpected envelope for %s: %s", c.reason, w.Body.String())
		}
		if strings.Contains(w.Body.String(), c.err.Error()) && c.err != errInitializing {
			t.Fatalf("raw error leaked to client: %s", w.Body.String())
		}
	}
}

func TestBackoffKeepsLastFailureStage(t *testing.T) {
	now := time.Unix(100, 0)
	s := &appInitializer{now: func() time.Time { return now }, initialize: func(context.Context) (*app.App, error) {
		return nil, &app.StartupError{Stage: app.StageMigration, Err: errors.New("lock timeout")}
	}}
	if _, err := s.get(context.Background()); app.StageOf(err) != app.StageMigration {
		t.Fatalf("first failure lost stage: %v", err)
	}
	if _, err := s.get(context.Background()); app.StageOf(err) != app.StageMigration {
		t.Fatalf("backoff response lost stage: %v", err)
	}
}
