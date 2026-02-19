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

type OllamaAdapter struct {
	http *http.Client
}

func NewOllamaAdapter() *OllamaAdapter {
	return &OllamaAdapter{
		http: &http.Client{
			Timeout: 120 * time.Second,
		},
	}
}

func (a *OllamaAdapter) Name() string { return "ollama" }

func (a *OllamaAdapter) Stream(ctx context.Context, req StreamRequest, emit func(StreamEvent) error) error {
	baseURL := strings.TrimSpace(req.Config.Ollama.BaseURL)
	if baseURL == "" {
		baseURL = "http://localhost:11434"
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
		body["options"] = map[string]any{"temperature": *req.Target.Temperature}
	}

	payload, err := json.Marshal(body)
	if err != nil {
		return err
	}

	httpReq, err := http.NewRequestWithContext(ctx, http.MethodPost, baseURL+"/api/chat", bytes.NewReader(payload))
	if err != nil {
		return err
	}
	httpReq.Header.Set("Content-Type", "application/json")

	resp, err := a.http.Do(httpReq)
	if err != nil {
		return err
	}
	defer resp.Body.Close()

	if resp.StatusCode >= 300 {
		b, _ := io.ReadAll(io.LimitReader(resp.Body, 4096))
		return fmt.Errorf("ollama error (%d): %s", resp.StatusCode, strings.TrimSpace(string(b)))
	}

	reader := bufio.NewScanner(resp.Body)
	reader.Buffer(make([]byte, 0, 64*1024), 2*1024*1024)

	for reader.Scan() {
		line := strings.TrimSpace(reader.Text())
		if line == "" {
			continue
		}

		var chunk struct {
			Done    bool `json:"done"`
			Message struct {
				Content string `json:"content"`
			} `json:"message"`
		}
		if err := json.Unmarshal([]byte(line), &chunk); err != nil {
			continue
		}
		if chunk.Done {
			break
		}
		if chunk.Message.Content == "" {
			continue
		}

		if err := emit(StreamEvent{
			TargetID: targetID,
			Provider: req.Target.Provider,
			Model:    req.Target.Model,
			Event:    "chunk",
			Content:  chunk.Message.Content,
		}); err != nil {
			return err
		}
	}

	return reader.Err()
}
