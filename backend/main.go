package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net/http"
	"strings"
	"sync"
	"time"

	"llm-mux/backend/internal/providers"
)

type chatRequest struct {
	Prompt  string                   `json:"prompt"`
	Targets []providers.Target       `json:"targets"`
	Config  providers.ProviderConfig `json:"config"`
}

type providerInfo struct {
	ID     string   `json:"id"`
	Name   string   `json:"name"`
	Models []string `json:"models"`
}

func main() {
	mux := http.NewServeMux()
	registry := map[string]providers.Adapter{
		"openrouter": providers.NewOpenRouterAdapter(),
		"ollama":     providers.NewOllamaAdapter(),
	}

	mux.HandleFunc("/health", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(w, http.StatusOK, map[string]any{"ok": true})
	})

	mux.HandleFunc("/api/providers", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(w, http.StatusOK, map[string]any{"providers": providerCatalog()})
	})

	mux.HandleFunc("/api/chat/stream", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			w.WriteHeader(http.StatusMethodNotAllowed)
			return
		}

		var req chatRequest
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid JSON body"})
			return
		}

		req.Prompt = strings.TrimSpace(req.Prompt)
		if req.Prompt == "" {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "prompt is required"})
			return
		}
		if len(req.Targets) == 0 {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "at least one target is required"})
			return
		}

		for i := range req.Targets {
			req.Targets[i].Provider = strings.ToLower(strings.TrimSpace(req.Targets[i].Provider))
			req.Targets[i].Model = strings.TrimSpace(req.Targets[i].Model)
			if req.Targets[i].Provider == "" || req.Targets[i].Model == "" {
				writeJSON(w, http.StatusBadRequest, map[string]string{"error": "each target needs provider and model"})
				return
			}
		}

		flusher, ok := w.(http.Flusher)
		if !ok {
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "streaming unsupported"})
			return
		}

		w.Header().Set("Content-Type", "text/event-stream")
		w.Header().Set("Cache-Control", "no-cache")
		w.Header().Set("Connection", "keep-alive")
		w.Header().Set("X-Accel-Buffering", "no")

		ctx, cancel := context.WithCancel(r.Context())
		defer cancel()

		events := make(chan providers.StreamEvent, 256)
		var wg sync.WaitGroup

		emit := func(ev providers.StreamEvent) error {
			select {
			case <-ctx.Done():
				return ctx.Err()
			case events <- ev:
				return nil
			}
		}

		for _, target := range req.Targets {
			adapter, exists := registry[target.Provider]
			if !exists {
				_ = emit(providers.StreamEvent{
					TargetID: target.Provider + ":" + target.Model,
					Provider: target.Provider,
					Model:    target.Model,
					Event:    "error",
					Error:    "unsupported provider",
				})
				continue
			}

			wg.Add(1)
			go func(t providers.Target, a providers.Adapter) {
				defer wg.Done()
				targetID := t.Provider + ":" + t.Model

				_ = emit(providers.StreamEvent{TargetID: targetID, Provider: t.Provider, Model: t.Model, Event: "start"})
				err := a.Stream(ctx, providers.StreamRequest{Prompt: req.Prompt, Target: t, Config: req.Config}, emit)
				if err != nil && !errors.Is(err, context.Canceled) {
					_ = emit(providers.StreamEvent{
						TargetID: targetID,
						Provider: t.Provider,
						Model:    t.Model,
						Event:    "error",
						Error:    err.Error(),
					})
				}
				_ = emit(providers.StreamEvent{TargetID: targetID, Provider: t.Provider, Model: t.Model, Event: "end"})
			}(target, adapter)
		}

		go func() {
			wg.Wait()
			close(events)
		}()

		enc := json.NewEncoder(w)
		for ev := range events {
			_, _ = fmt.Fprint(w, "event: message\n")
			_, _ = fmt.Fprint(w, "data: ")
			if err := enc.Encode(ev); err != nil {
				return
			}
			_, _ = fmt.Fprint(w, "\n")
			flusher.Flush()
		}

		_, _ = fmt.Fprint(w, "event: done\n")
		_, _ = fmt.Fprint(w, "data: {\"event\":\"done\"}\n\n")
		flusher.Flush()
	})

	server := &http.Server{
		Addr:              ":8080",
		Handler:           withCORS(withRequestLog(mux)),
		ReadTimeout:       30 * time.Second,
		ReadHeaderTimeout: 10 * time.Second,
		WriteTimeout:      0,
		IdleTimeout:       120 * time.Second,
	}

	log.Printf("backend listening on http://localhost:8080")
	if err := server.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
		log.Fatal(err)
	}
}

func providerCatalog() []providerInfo {
	return []providerInfo{
		{
			ID:   "openrouter",
			Name: "OpenRouter",
			Models: []string{
				"openai/gpt-4o-mini",
				"anthropic/claude-3.5-sonnet",
				"meta-llama/llama-3.1-70b-instruct",
			},
		},
		{
			ID:   "ollama",
			Name: "Ollama",
			Models: []string{
				"llama3.2:latest",
				"qwen2.5",
				"mistral",
			},
		},
	}
}

func withCORS(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Access-Control-Allow-Origin", "*")
		w.Header().Set("Access-Control-Allow-Methods", "GET,POST,OPTIONS")
		w.Header().Set("Access-Control-Allow-Headers", "Content-Type,Authorization")
		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		next.ServeHTTP(w, r)
	})
}

func withRequestLog(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()
		next.ServeHTTP(w, r)
		log.Printf("%s %s %s", r.Method, r.URL.Path, time.Since(start).Round(time.Millisecond))
	})
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}
