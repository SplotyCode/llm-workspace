package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net/http"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"llm-mux/backend/internal/providers"
	"llm-mux/backend/internal/state"
)

type chatRequest struct {
	ChatID  string                   `json:"chatId"`
	Prompt  string                   `json:"prompt"`
	Targets []providers.Target       `json:"targets"`
	Config  providers.ProviderConfig `json:"config"`
}

type createFolderRequest struct {
	Name         string `json:"name"`
	SystemPrompt string `json:"systemPrompt"`
	Temperature  *float64 `json:"temperature,omitempty"`
}

type updateFolderRequest struct {
	Name         string `json:"name"`
	SystemPrompt string `json:"systemPrompt"`
	Temperature  *float64 `json:"temperature,omitempty"`
}

type createChatRequest struct {
	FolderID string `json:"folderId"`
	Title    string `json:"title"`
}

type updateChatRequest struct {
	FolderID string `json:"folderId"`
	Title    string `json:"title"`
}

type updateMessageRequest struct {
	Inclusion string `json:"inclusion"`
	ScopeID   string `json:"scopeId,omitempty"`
}

type providerInfo struct {
	ID     string   `json:"id"`
	Name   string   `json:"name"`
	Models []string `json:"models"`
}

func main() {
	store, err := state.New(filepath.Join("data", "state.json"))
	if err != nil {
		log.Fatal(err)
	}

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

	mux.HandleFunc("/api/config", func(w http.ResponseWriter, r *http.Request) {
		switch r.Method {
		case http.MethodGet:
			writeJSON(w, http.StatusOK, store.GetConfig())
		case http.MethodPut:
			var cfg providers.ProviderConfig
			if err := json.NewDecoder(r.Body).Decode(&cfg); err != nil {
				writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid JSON body"})
				return
			}
			if err := store.SetConfig(cfg); err != nil {
				writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
				return
			}
			writeJSON(w, http.StatusOK, cfg)
		default:
			w.WriteHeader(http.StatusMethodNotAllowed)
		}
	})

	mux.HandleFunc("/api/folders", func(w http.ResponseWriter, r *http.Request) {
		switch r.Method {
		case http.MethodGet:
			writeJSON(w, http.StatusOK, map[string]any{"folders": store.ListFolders()})
		case http.MethodPost:
			var req createFolderRequest
			if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
				writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid JSON body"})
				return
			}
				folder, err := store.CreateFolder(req.Name, req.SystemPrompt, req.Temperature)
			if err != nil {
				writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
				return
			}
			writeJSON(w, http.StatusCreated, folder)
		default:
			w.WriteHeader(http.StatusMethodNotAllowed)
		}
	})

	mux.HandleFunc("/api/folders/", func(w http.ResponseWriter, r *http.Request) {
		id := strings.TrimPrefix(r.URL.Path, "/api/folders/")
		if id == "" {
			w.WriteHeader(http.StatusNotFound)
			return
		}
		if r.Method != http.MethodPatch {
			w.WriteHeader(http.StatusMethodNotAllowed)
			return
		}

		var req updateFolderRequest
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid JSON body"})
			return
		}

			folder, err := store.UpdateFolder(id, req.Name, req.SystemPrompt, req.Temperature)
		if err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
			return
		}
		writeJSON(w, http.StatusOK, folder)
	})

	mux.HandleFunc("/api/chats", func(w http.ResponseWriter, r *http.Request) {
		switch r.Method {
		case http.MethodGet:
			folderID := strings.TrimSpace(r.URL.Query().Get("folderId"))
			writeJSON(w, http.StatusOK, map[string]any{"chats": store.ListChats(folderID)})
		case http.MethodPost:
			var req createChatRequest
			if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
				writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid JSON body"})
				return
			}
			chat, err := store.CreateChat(req.FolderID, req.Title)
			if err != nil {
				writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
				return
			}
			writeJSON(w, http.StatusCreated, chat)
		default:
			w.WriteHeader(http.StatusMethodNotAllowed)
		}
	})

	mux.HandleFunc("/api/chats/", func(w http.ResponseWriter, r *http.Request) {
		rest := strings.Trim(strings.TrimPrefix(r.URL.Path, "/api/chats/"), "/")
		if rest == "" {
			w.WriteHeader(http.StatusNotFound)
			return
		}

		parts := strings.Split(rest, "/")
		if len(parts) == 3 && parts[1] == "messages" {
			if r.Method != http.MethodPatch {
				w.WriteHeader(http.StatusMethodNotAllowed)
				return
			}
			var req updateMessageRequest
			if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
				writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid JSON body"})
				return
			}
			updated, err := store.UpdateMessageInclusion(parts[0], parts[2], req.Inclusion, req.ScopeID)
			if err != nil {
				writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
				return
			}
			writeJSON(w, http.StatusOK, updated)
			return
		}

		if len(parts) != 1 {
			w.WriteHeader(http.StatusNotFound)
			return
		}
		id := parts[0]

		switch r.Method {
		case http.MethodGet:
			chat, ok := store.GetChat(id)
			if !ok {
				writeJSON(w, http.StatusNotFound, map[string]string{"error": "chat not found"})
				return
			}
			writeJSON(w, http.StatusOK, chat)
		case http.MethodPatch:
			var req updateChatRequest
			if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
				writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid JSON body"})
				return
			}
			chat, err := store.UpdateChat(id, req.Title, req.FolderID)
			if err != nil {
				writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
				return
			}
			writeJSON(w, http.StatusOK, chat)
		default:
			w.WriteHeader(http.StatusMethodNotAllowed)
		}
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

		req.ChatID = strings.TrimSpace(req.ChatID)
		req.Prompt = strings.TrimSpace(req.Prompt)
		if req.ChatID == "" {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "chatId is required"})
			return
		}
		if req.Prompt == "" {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "prompt is required"})
			return
		}
		if len(req.Targets) == 0 {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "at least one target is required"})
			return
		}

		chat, ok := store.GetChat(req.ChatID)
		if !ok {
			writeJSON(w, http.StatusNotFound, map[string]string{"error": "chat not found"})
			return
		}
		folder, _ := store.FindFolder(chat.FolderID)

		effectiveConfig := mergeConfig(store.GetConfig(), req.Config)

		for i := range req.Targets {
			req.Targets[i].Provider = strings.ToLower(strings.TrimSpace(req.Targets[i].Provider))
			req.Targets[i].Model = strings.TrimSpace(req.Targets[i].Model)
			if req.Targets[i].Provider == "" || req.Targets[i].Model == "" {
				writeJSON(w, http.StatusBadRequest, map[string]string{"error": "each target needs provider and model"})
				return
			}
				if strings.TrimSpace(req.Targets[i].SystemPrompt) == "" {
					req.Targets[i].SystemPrompt = strings.TrimSpace(folder.SystemPrompt)
				}
				if req.Targets[i].Temperature == nil && folder.Temperature != nil {
					t := *folder.Temperature
					req.Targets[i].Temperature = &t
				}
			}

		if err := store.AppendUserPrompt(req.ChatID, req.Prompt); err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
			return
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
					history := buildTargetHistory(chat.Messages, targetID)

					_ = emit(providers.StreamEvent{TargetID: targetID, Provider: t.Provider, Model: t.Model, Event: "start"})
					err := a.Stream(ctx, providers.StreamRequest{Prompt: req.Prompt, Target: t, Config: effectiveConfig, History: history}, emit)
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

		outputs := map[string]state.Message{}
		enc := json.NewEncoder(w)
			for ev := range events {
				if ev.Event == "chunk" {
					out := outputs[ev.TargetID]
					out.TargetID = ev.TargetID
					out.Provider = ev.Provider
					out.Model = ev.Model
					out.Inclusion = "model_only"
					out.ScopeID = ev.TargetID
					out.Content += ev.Content
					outputs[ev.TargetID] = out
				}

			_, _ = fmt.Fprint(w, "event: message\n")
			_, _ = fmt.Fprint(w, "data: ")
			if err := enc.Encode(ev); err != nil {
				return
			}
			_, _ = fmt.Fprint(w, "\n")
			flusher.Flush()
		}

		assistantMessages := make([]state.Message, 0, len(outputs))
		for _, out := range outputs {
			assistantMessages = append(assistantMessages, out)
		}
		if err := store.AppendAssistantMessages(req.ChatID, assistantMessages); err != nil {
			log.Printf("persist assistant messages failed: %v", err)
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
		{ID: "openrouter", Name: "OpenRouter", Models: []string{"openai/gpt-4o-mini", "anthropic/claude-3.5-sonnet", "meta-llama/llama-3.1-70b-instruct"}},
		{ID: "ollama", Name: "Ollama", Models: []string{"llama3.2:latest", "qwen2.5", "mistral"}},
	}
}

func mergeConfig(base, override providers.ProviderConfig) providers.ProviderConfig {
	merged := base
	if strings.TrimSpace(override.OpenRouter.APIKey) != "" {
		merged.OpenRouter.APIKey = strings.TrimSpace(override.OpenRouter.APIKey)
	}
	if strings.TrimSpace(override.OpenRouter.BaseURL) != "" {
		merged.OpenRouter.BaseURL = strings.TrimSpace(override.OpenRouter.BaseURL)
	}
	if strings.TrimSpace(override.Ollama.BaseURL) != "" {
		merged.Ollama.BaseURL = strings.TrimSpace(override.Ollama.BaseURL)
	}
	if len(override.OpenRouter.Models) > 0 {
		merged.OpenRouter.Models = override.OpenRouter.Models
	}
	if len(override.Ollama.Models) > 0 {
		merged.Ollama.Models = override.Ollama.Models
	}
	return merged
}

func buildTargetHistory(messages []state.Message, targetID string) []providers.HistoryMessage {
	history := make([]providers.HistoryMessage, 0, len(messages))
	for _, msg := range messages {
		if strings.TrimSpace(msg.Content) == "" || strings.TrimSpace(msg.Role) == "" {
			continue
		}
		if !messageIncludedForTarget(msg, targetID) {
			continue
		}
		history = append(history, providers.HistoryMessage{
			Role:    msg.Role,
			Content: msg.Content,
		})
	}
	return history
}

func messageIncludedForTarget(msg state.Message, targetID string) bool {
	switch strings.TrimSpace(strings.ToLower(msg.Inclusion)) {
	case "dont_include":
		return false
	case "always":
		return true
	case "model_only":
		scope := strings.TrimSpace(msg.ScopeID)
		if scope == "" {
			scope = strings.TrimSpace(msg.TargetID)
		}
		if scope == "" {
			return true
		}
		return scope == targetID
	default:
		if msg.Role == "assistant" {
			scope := strings.TrimSpace(msg.TargetID)
			if scope == "" {
				return false
			}
			return scope == targetID
		}
		return true
	}
}

func withCORS(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Access-Control-Allow-Origin", "*")
		w.Header().Set("Access-Control-Allow-Methods", "GET,POST,PUT,PATCH,OPTIONS")
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
