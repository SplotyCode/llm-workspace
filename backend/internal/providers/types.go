package providers

import "context"

type Target struct {
	Provider     string   `json:"provider"`
	Model        string   `json:"model"`
	SystemPrompt string   `json:"systemPrompt,omitempty"`
	Temperature  *float64 `json:"temperature,omitempty"`
}

type OpenRouterConfig struct {
	APIKey  string   `json:"apiKey,omitempty"`
	BaseURL string   `json:"baseUrl,omitempty"`
	Models  []string `json:"models,omitempty"`
}

type OllamaConfig struct {
	BaseURL string   `json:"baseUrl,omitempty"`
	Models  []string `json:"models,omitempty"`
}

type ProviderConfig struct {
	OpenRouter OpenRouterConfig `json:"openrouter,omitempty"`
	Ollama     OllamaConfig     `json:"ollama,omitempty"`
}

type StreamRequest struct {
	Prompt string
	Target Target
	Config ProviderConfig
	History []HistoryMessage
}

type HistoryMessage struct {
	Role    string
	Content string
}

type StreamEvent struct {
	TargetID string `json:"targetId"`
	Provider string `json:"provider"`
	Model    string `json:"model"`
	Event    string `json:"event"`
	Content  string `json:"content,omitempty"`
	Error    string `json:"error,omitempty"`
}

type Adapter interface {
	Name() string
	Stream(ctx context.Context, req StreamRequest, emit func(StreamEvent) error) error
}
