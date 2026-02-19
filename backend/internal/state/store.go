package state

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"

	"llm-mux/backend/internal/providers"
)

type Folder struct {
	ID           string    `json:"id"`
	Name         string    `json:"name"`
	SystemPrompt string    `json:"systemPrompt"`
	Temperature  *float64  `json:"temperature,omitempty"`
	CreatedAt    time.Time `json:"createdAt"`
	UpdatedAt    time.Time `json:"updatedAt"`
}

type Message struct {
	ID        string    `json:"id"`
	Role      string    `json:"role"`
	Content   string    `json:"content"`
	Provider  string    `json:"provider,omitempty"`
	Model     string    `json:"model,omitempty"`
	TargetID  string    `json:"targetId,omitempty"`
	Inclusion string    `json:"inclusion,omitempty"`
	ScopeID   string    `json:"scopeId,omitempty"`
	CreatedAt time.Time `json:"createdAt"`
}

type Chat struct {
	ID        string    `json:"id"`
	FolderID  string    `json:"folderId"`
	Title     string    `json:"title"`
	Messages  []Message `json:"messages"`
	CreatedAt time.Time `json:"createdAt"`
	UpdatedAt time.Time `json:"updatedAt"`
}

type Data struct {
	Config  providers.ProviderConfig `json:"config"`
	Folders []Folder                 `json:"folders"`
	Chats   []Chat                   `json:"chats"`
}

type Store struct {
	mu   sync.RWMutex
	path string
	data Data
}

func New(path string) (*Store, error) {
	s := &Store{path: path}
	if err := s.load(); err != nil {
		return nil, err
	}
	return s, nil
}

func (s *Store) load() error {
	s.mu.Lock()
	defer s.mu.Unlock()

	if err := os.MkdirAll(filepath.Dir(s.path), 0o755); err != nil {
		return err
	}

	b, err := os.ReadFile(s.path)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			now := time.Now().UTC()
				s.data = Data{
					Config: providers.ProviderConfig{
						OpenRouter: providers.OpenRouterConfig{
							BaseURL: "https://openrouter.ai/api/v1",
							Models:  []string{"openai/gpt-4o-mini", "anthropic/claude-3.5-sonnet"},
						},
						Ollama: providers.OllamaConfig{
							BaseURL: "http://localhost:11434",
							Models:  []string{"llama3.2:latest", "qwen2.5"},
						},
					},
				Folders: []Folder{{
					ID:           newID("fld"),
					Name:         "General",
					SystemPrompt: "",
					CreatedAt:    now,
					UpdatedAt:    now,
				}},
				Chats: []Chat{},
			}
			return s.persistLocked()
		}
		return err
	}

	if len(b) == 0 {
		s.data = Data{}
		return nil
	}

	if err := json.Unmarshal(b, &s.data); err != nil {
		return fmt.Errorf("invalid state file: %w", err)
	}
	if len(s.data.Folders) == 0 {
		now := time.Now().UTC()
		s.data.Folders = []Folder{{ID: newID("fld"), Name: "General", CreatedAt: now, UpdatedAt: now}}
	}
	if strings.TrimSpace(s.data.Config.OpenRouter.BaseURL) == "" {
		s.data.Config.OpenRouter.BaseURL = "https://openrouter.ai/api/v1"
	}
	if strings.TrimSpace(s.data.Config.Ollama.BaseURL) == "" {
		s.data.Config.Ollama.BaseURL = "http://localhost:11434"
	}
	if len(s.data.Config.OpenRouter.Models) == 0 {
		s.data.Config.OpenRouter.Models = []string{"openai/gpt-4o-mini", "anthropic/claude-3.5-sonnet"}
	}
	if len(s.data.Config.Ollama.Models) == 0 {
		s.data.Config.Ollama.Models = []string{"llama3.2:latest", "qwen2.5"}
	}
	for i := range s.data.Chats {
		for j := range s.data.Chats[i].Messages {
			msg := &s.data.Chats[i].Messages[j]
			if strings.TrimSpace(msg.Inclusion) == "" {
				if msg.Role == "assistant" {
					msg.Inclusion = "model_only"
				} else {
					msg.Inclusion = "always"
				}
			}
			if msg.Inclusion == "model_only" && strings.TrimSpace(msg.ScopeID) == "" {
				msg.ScopeID = msg.TargetID
			}
		}
	}
	return nil
}

func (s *Store) persistLocked() error {
	payload, err := json.MarshalIndent(s.data, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(s.path, payload, 0o644)
}

func (s *Store) GetConfig() providers.ProviderConfig {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.data.Config
}

func (s *Store) SetConfig(cfg providers.ProviderConfig) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.data.Config = cfg
	return s.persistLocked()
}

func (s *Store) ListFolders() []Folder {
	s.mu.RLock()
	defer s.mu.RUnlock()
	folders := append([]Folder(nil), s.data.Folders...)
	sort.Slice(folders, func(i, j int) bool { return folders[i].UpdatedAt.After(folders[j].UpdatedAt) })
	return folders
}

func (s *Store) CreateFolder(name, systemPrompt string, temperature *float64) (Folder, error) {
	name = strings.TrimSpace(name)
	if name == "" {
		return Folder{}, errors.New("name is required")
	}
	now := time.Now().UTC()
	folder := Folder{ID: newID("fld"), Name: name, SystemPrompt: systemPrompt, Temperature: temperature, CreatedAt: now, UpdatedAt: now}

	s.mu.Lock()
	defer s.mu.Unlock()
	s.data.Folders = append(s.data.Folders, folder)
	if err := s.persistLocked(); err != nil {
		return Folder{}, err
	}
	return folder, nil
}

func (s *Store) UpdateFolder(id, name, systemPrompt string, temperature *float64) (Folder, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	for i := range s.data.Folders {
		if s.data.Folders[i].ID != id {
			continue
		}
			if strings.TrimSpace(name) != "" {
				s.data.Folders[i].Name = strings.TrimSpace(name)
			}
			s.data.Folders[i].SystemPrompt = systemPrompt
			s.data.Folders[i].Temperature = temperature
			s.data.Folders[i].UpdatedAt = time.Now().UTC()
		if err := s.persistLocked(); err != nil {
			return Folder{}, err
		}
		return s.data.Folders[i], nil
	}
	return Folder{}, errors.New("folder not found")
}

func (s *Store) FindFolder(id string) (Folder, bool) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	for _, f := range s.data.Folders {
		if f.ID == id {
			return f, true
		}
	}
	return Folder{}, false
}

func (s *Store) ListChats(folderID string) []Chat {
	s.mu.RLock()
	defer s.mu.RUnlock()
	chats := make([]Chat, 0)
	for _, c := range s.data.Chats {
		if folderID != "" && c.FolderID != folderID {
			continue
		}
		clone := c
		clone.Messages = nil
		chats = append(chats, clone)
	}
	sort.Slice(chats, func(i, j int) bool { return chats[i].UpdatedAt.After(chats[j].UpdatedAt) })
	return chats
}

func (s *Store) CreateChat(folderID, title string) (Chat, error) {
	title = strings.TrimSpace(title)
	if title == "" {
		title = "New Chat"
	}
	if _, ok := s.FindFolder(folderID); !ok {
		return Chat{}, errors.New("folder not found")
	}
	now := time.Now().UTC()
	chat := Chat{ID: newID("cht"), FolderID: folderID, Title: title, Messages: []Message{}, CreatedAt: now, UpdatedAt: now}

	s.mu.Lock()
	defer s.mu.Unlock()
	s.data.Chats = append(s.data.Chats, chat)
	if err := s.persistLocked(); err != nil {
		return Chat{}, err
	}
	return chat, nil
}

func (s *Store) GetChat(id string) (Chat, bool) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	for _, c := range s.data.Chats {
		if c.ID == id {
			return c, true
		}
	}
	return Chat{}, false
}

func (s *Store) UpdateChat(id, title, folderID string) (Chat, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	for i := range s.data.Chats {
		if s.data.Chats[i].ID != id {
			continue
		}

		oldFolderID := s.data.Chats[i].FolderID
		if strings.TrimSpace(folderID) != "" && folderID != s.data.Chats[i].FolderID {
			if !s.folderExistsLocked(folderID) {
				return Chat{}, errors.New("folder not found")
			}
			s.data.Chats[i].FolderID = folderID
		}

		if strings.TrimSpace(title) != "" {
			s.data.Chats[i].Title = strings.TrimSpace(title)
		}

		s.data.Chats[i].UpdatedAt = time.Now().UTC()
		if err := s.touchFolderLocked(s.data.Chats[i].FolderID); err != nil {
			return Chat{}, err
		}
		if oldFolderID != s.data.Chats[i].FolderID {
			if err := s.touchFolderLocked(oldFolderID); err != nil {
				return Chat{}, err
			}
		}
		if err := s.persistLocked(); err != nil {
			return Chat{}, err
		}
		return s.data.Chats[i], nil
	}
	return Chat{}, errors.New("chat not found")
}

func (s *Store) AppendUserPrompt(chatID, prompt string) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	for i := range s.data.Chats {
		if s.data.Chats[i].ID != chatID {
			continue
		}
		now := time.Now().UTC()
			s.data.Chats[i].Messages = append(s.data.Chats[i].Messages, Message{
				ID:        newID("msg"),
				Role:      "user",
				Content:   prompt,
				Inclusion: "always",
				CreatedAt: now,
			})
		if len(s.data.Chats[i].Messages) == 1 && strings.TrimSpace(s.data.Chats[i].Title) == "New Chat" {
			s.data.Chats[i].Title = trimTitle(prompt)
		}
		s.data.Chats[i].UpdatedAt = now
		if err := s.touchFolderLocked(s.data.Chats[i].FolderID); err != nil {
			return err
		}
		return s.persistLocked()
	}
	return errors.New("chat not found")
}

func (s *Store) AppendAssistantMessages(chatID string, outputs []Message) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	for i := range s.data.Chats {
		if s.data.Chats[i].ID != chatID {
			continue
		}
		now := time.Now().UTC()
			for _, out := range outputs {
				if strings.TrimSpace(out.Content) == "" {
					continue
				}
				out.ID = newID("msg")
				out.Role = "assistant"
				if strings.TrimSpace(out.Inclusion) == "" {
					out.Inclusion = "model_only"
				}
				if out.Inclusion == "model_only" && strings.TrimSpace(out.ScopeID) == "" {
					out.ScopeID = out.TargetID
				}
				out.CreatedAt = now
				s.data.Chats[i].Messages = append(s.data.Chats[i].Messages, out)
			}
		s.data.Chats[i].UpdatedAt = now
		if err := s.touchFolderLocked(s.data.Chats[i].FolderID); err != nil {
			return err
		}
		return s.persistLocked()
	}
	return errors.New("chat not found")
}

func (s *Store) UpdateMessageInclusion(chatID, messageID, inclusion, scopeID string) (Message, error) {
	inclusion = normalizeInclusion(inclusion)
	if inclusion == "" {
		return Message{}, errors.New("invalid inclusion")
	}

	s.mu.Lock()
	defer s.mu.Unlock()

	for i := range s.data.Chats {
		if s.data.Chats[i].ID != chatID {
			continue
		}
		for j := range s.data.Chats[i].Messages {
			msg := &s.data.Chats[i].Messages[j]
			if msg.ID != messageID {
				continue
			}
			msg.Inclusion = inclusion
			if msg.Inclusion == "model_only" {
				if strings.TrimSpace(scopeID) != "" {
					msg.ScopeID = scopeID
				} else {
					msg.ScopeID = msg.TargetID
				}
			} else {
				msg.ScopeID = ""
			}
			s.data.Chats[i].UpdatedAt = time.Now().UTC()
			if err := s.persistLocked(); err != nil {
				return Message{}, err
			}
			return *msg, nil
		}
		return Message{}, errors.New("message not found")
	}
	return Message{}, errors.New("chat not found")
}

func normalizeInclusion(v string) string {
	switch strings.TrimSpace(strings.ToLower(v)) {
	case "dont_include", "model_only", "always":
		return strings.TrimSpace(strings.ToLower(v))
	default:
		return ""
	}
}

func (s *Store) touchFolderLocked(folderID string) error {
	for i := range s.data.Folders {
		if s.data.Folders[i].ID == folderID {
			s.data.Folders[i].UpdatedAt = time.Now().UTC()
			return nil
		}
	}
	return errors.New("folder not found")
}

func (s *Store) folderExistsLocked(folderID string) bool {
	for i := range s.data.Folders {
		if s.data.Folders[i].ID == folderID {
			return true
		}
	}
	return false
}

func trimTitle(prompt string) string {
	prompt = strings.TrimSpace(prompt)
	if prompt == "" {
		return "New Chat"
	}
	runes := []rune(prompt)
	if len(runes) > 40 {
		return string(runes[:40]) + "..."
	}
	return prompt
}

func newID(prefix string) string {
	return fmt.Sprintf("%s_%d", prefix, time.Now().UnixNano())
}
