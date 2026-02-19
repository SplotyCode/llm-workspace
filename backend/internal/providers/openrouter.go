package providers

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"
)

type OpenRouterAdapter struct {
	http *http.Client
}

func NewOpenRouterAdapter() *OpenRouterAdapter {
	return &OpenRouterAdapter{
		http: &http.Client{
			Timeout: 120 * time.Second,
		},
	}
}

func (a *OpenRouterAdapter) Name() string { return "openrouter" }

func (a *OpenRouterAdapter) Stream(ctx context.Context, req StreamRequest, emit func(StreamEvent) error) error {
	apiKey := strings.TrimSpace(req.Config.OpenRouter.APIKey)
	if apiKey == "" {
		return fmt.Errorf("openrouter.apiKey is required")
	}

	baseURL := strings.TrimSpace(req.Config.OpenRouter.BaseURL)
	if baseURL == "" {
		baseURL = "https://openrouter.ai/api/v1"
	}
	baseURL = strings.TrimSuffix(baseURL, "/")

	targetID := req.Target.Provider + ":" + req.Target.Model
	messages := []map[string]string{}
	if req.Target.SystemPrompt != "" {
		messages = append(messages, map[string]string{"role": "system", "content": req.Target.SystemPrompt})
	}
	messages = append(messages, map[string]string{"role": "user", "content": req.Prompt})

	body := map[string]any{
		"model":    req.Target.Model,
		"messages": messages,
		"stream":   true,
	}
	if req.Target.Temperature != nil {
		body["temperature"] = *req.Target.Temperature
	}

	payload, err := json.Marshal(body)
	if err != nil {
		return err
	}

	httpReq, err := http.NewRequestWithContext(ctx, http.MethodPost, baseURL+"/chat/completions", bytes.NewReader(payload))
	if err != nil {
		return err
	}
	httpReq.Header.Set("Authorization", "Bearer "+apiKey)
	httpReq.Header.Set("Content-Type", "application/json")
	httpReq.Header.Set("Accept", "text/event-stream")

	resp, err := a.http.Do(httpReq)
	if err != nil {
		return err
	}
	defer resp.Body.Close()

	if resp.StatusCode >= 300 {
		b, _ := io.ReadAll(io.LimitReader(resp.Body, 4096))
		return fmt.Errorf("openrouter error (%d): %s", resp.StatusCode, strings.TrimSpace(string(b)))
	}

	reader := bufio.NewScanner(resp.Body)
	reader.Buffer(make([]byte, 0, 64*1024), 2*1024*1024)

	for reader.Scan() {
		line := strings.TrimSpace(reader.Text())
		if !strings.HasPrefix(line, "data:") {
			continue
		}
		data := strings.TrimSpace(strings.TrimPrefix(line, "data:"))
		if data == "[DONE]" {
			break
		}
		if data == "" {
			continue
		}

		var chunk struct {
			Choices []struct {
				Delta struct {
					Content string `json:"content"`
				} `json:"delta"`
			} `json:"choices"`
		}
		if err := json.Unmarshal([]byte(data), &chunk); err != nil {
			continue
		}
		if len(chunk.Choices) == 0 || chunk.Choices[0].Delta.Content == "" {
			continue
		}

		if err := emit(StreamEvent{
			TargetID: targetID,
			Provider: req.Target.Provider,
			Model:    req.Target.Model,
			Event:    "chunk",
			Content:  chunk.Choices[0].Delta.Content,
		}); err != nil {
			return err
		}
	}

	return reader.Err()
}
