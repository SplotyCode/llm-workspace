package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"math"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"time"

	"llm-mux/backend/internal/providers"
	"llm-mux/backend/internal/state"
)

type contextLimitsRequest struct {
	Targets     []providers.Target       `json:"targets"`
	Config      providers.ProviderConfig `json:"config"`
	ChatID      string                   `json:"chatId,omitempty"`
	Prompt      string                   `json:"prompt,omitempty"`
	Attachments []textAttachment         `json:"attachments,omitempty"`
}

type contextLimitItem struct {
	TargetID         string `json:"targetId"`
	Provider         string `json:"provider"`
	Model            string `json:"model"`
	MaxContextTokens int    `json:"maxContextTokens,omitempty"`
	EstimatedTokens  int    `json:"estimatedTokens,omitempty"`
	RemainingTokens  *int   `json:"remainingTokens,omitempty"`
	UsedPercent      *int   `json:"usedPercent,omitempty"`
	Error            string `json:"error,omitempty"`
}

type contextLimitsResponse struct {
	Limits []contextLimitItem `json:"limits"`
}

func resolveContextLimits(req contextLimitsRequest, stored providers.ProviderConfig, baseHistory []state.Message) []contextLimitItem {
	effective := mergeConfig(stored, req.Config)
	out := make([]contextLimitItem, len(req.Targets))
	prompt := mergePromptAndAttachments(req.Prompt, req.Attachments)

	client := &http.Client{Timeout: 12 * time.Second}
	var wg sync.WaitGroup
	for i := range req.Targets {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			t := req.Targets[i]
			provider := strings.ToLower(strings.TrimSpace(t.Provider))
			model := strings.TrimSpace(t.Model)
			targetID := provider + ":" + model
			item := contextLimitItem{
				TargetID: targetID,
				Provider: provider,
				Model:    model,
			}
			if provider == "" || model == "" {
				item.Error = "missing provider/model"
				out[i] = item
				return
			}

			var (
				limit int
				err   error
			)
			switch provider {
			case "openrouter":
				limit, err = fetchOpenRouterContextLimit(client, effective.OpenRouter, model)
			case "ollama":
				limit, err = fetchOllamaContextLimit(client, effective.Ollama, model)
			default:
				err = fmt.Errorf("unsupported provider")
			}
			if err != nil {
				item.Error = err.Error()
			} else {
				item.MaxContextTokens = limit
			}
			item.EstimatedTokens = estimateContextTokens(baseHistory, targetID, prompt)
			if item.MaxContextTokens > 0 {
				remaining := item.MaxContextTokens - item.EstimatedTokens
				item.RemainingTokens = &remaining
				used := int(math.Round(float64(item.EstimatedTokens) * 100 / float64(item.MaxContextTokens)))
				if used < 0 {
					used = 0
				}
				item.UsedPercent = &used
			}
			out[i] = item
		}(i)
	}
	wg.Wait()
	return out
}

func estimateContextTokens(baseHistory []state.Message, targetID, prompt string) int {
	history := buildTargetHistory(baseHistory, targetID)
	chars := 0
	for _, m := range history {
		chars += len(m.Content)
	}
	chars += len(prompt)
	if chars <= 0 {
		return 1
	}
	return int(math.Ceil(float64(chars) / 4.0))
}

func fetchOpenRouterContextLimit(client *http.Client, cfg providers.OpenRouterConfig, model string) (int, error) {
	baseURL := strings.TrimSpace(cfg.BaseURL)
	if baseURL == "" {
		baseURL = "https://openrouter.ai/api/v1"
	}
	baseURL = strings.TrimSuffix(baseURL, "/")

	// Fast path: single model endpoint.
	httpReq, err := http.NewRequest(http.MethodGet, baseURL+"/models/"+url.PathEscape(model), nil)
	if err == nil {
		if strings.TrimSpace(cfg.APIKey) != "" {
			httpReq.Header.Set("Authorization", "Bearer "+strings.TrimSpace(cfg.APIKey))
		}
		resp, reqErr := client.Do(httpReq)
		if reqErr == nil {
			defer resp.Body.Close()
			if resp.StatusCode < 300 {
				var raw struct {
					Data struct {
						ContextLength any `json:"context_length"`
					} `json:"data"`
				}
				if decErr := json.NewDecoder(resp.Body).Decode(&raw); decErr == nil {
					if n, ok := toInt(raw.Data.ContextLength); ok && n > 0 {
						return n, nil
					}
				}
			}
		}
	}

	// Fallback: list endpoint.
	listReq, err := http.NewRequest(http.MethodGet, baseURL+"/models", nil)
	if err != nil {
		return 0, err
	}
	if strings.TrimSpace(cfg.APIKey) != "" {
		listReq.Header.Set("Authorization", "Bearer "+strings.TrimSpace(cfg.APIKey))
	}
	resp, err := client.Do(listReq)
	if err != nil {
		return 0, err
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 300 {
		b, _ := io.ReadAll(io.LimitReader(resp.Body, 512))
		return 0, fmt.Errorf("openrouter %d: %s", resp.StatusCode, strings.TrimSpace(string(b)))
	}

	var raw struct {
		Data []struct {
			ID            string `json:"id"`
			ContextLength any    `json:"context_length"`
		} `json:"data"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&raw); err != nil {
		return 0, err
	}
	want := strings.ToLower(strings.TrimSpace(model))
	for _, item := range raw.Data {
		if strings.ToLower(strings.TrimSpace(item.ID)) != want {
			continue
		}
		if n, ok := toInt(item.ContextLength); ok && n > 0 {
			return n, nil
		}
	}
	return 0, fmt.Errorf("context length unavailable")
}

func fetchOllamaContextLimit(client *http.Client, cfg providers.OllamaConfig, model string) (int, error) {
	baseURL := strings.TrimSpace(cfg.BaseURL)
	if baseURL == "" {
		baseURL = "http://localhost:11434"
	}
	baseURL = strings.TrimSuffix(baseURL, "/")

	body, _ := json.Marshal(map[string]string{"model": model})
	httpReq, err := http.NewRequest(http.MethodPost, baseURL+"/api/show", bytes.NewReader(body))
	if err != nil {
		return 0, err
	}
	httpReq.Header.Set("Content-Type", "application/json")

	resp, err := client.Do(httpReq)
	if err != nil {
		return 0, err
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 300 {
		b, _ := io.ReadAll(io.LimitReader(resp.Body, 512))
		return 0, fmt.Errorf("ollama %d: %s", resp.StatusCode, strings.TrimSpace(string(b)))
	}

	var raw struct {
		ModelInfo map[string]any `json:"model_info"`
		Details   map[string]any `json:"details"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&raw); err != nil {
		return 0, err
	}
	for k, v := range raw.ModelInfo {
		if strings.Contains(strings.ToLower(k), "context_length") {
			if n, ok := toInt(v); ok && n > 0 {
				return n, nil
			}
		}
	}
	for k, v := range raw.Details {
		if strings.Contains(strings.ToLower(k), "context") {
			if n, ok := toInt(v); ok && n > 0 {
				return n, nil
			}
		}
	}
	return 0, fmt.Errorf("context length unavailable")
}

func toInt(v any) (int, bool) {
	switch n := v.(type) {
	case float64:
		return int(n), true
	case float32:
		return int(n), true
	case int:
		return n, true
	case int64:
		return int(n), true
	case json.Number:
		i, err := n.Int64()
		if err != nil {
			return 0, false
		}
		return int(i), true
	case string:
		i, err := strconv.Atoi(strings.TrimSpace(n))
		if err != nil {
			return 0, false
		}
		return i, true
	default:
		return 0, false
	}
}
