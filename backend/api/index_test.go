package handler

import (
	"context"
	"errors"
	"github.com/adiputera/airrest-backend/core/app"
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
