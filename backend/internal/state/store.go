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
	History   []MessageVersion `json:"history,omitempty"`
	HistoryIndex int           `json:"historyIndex,omitempty"`
	CreatedAt time.Time `json:"createdAt"`
}

type MessageVersion struct {
	Content   string    `json:"content"`
	Provider  string    `json:"provider,omitempty"`
	Model     string    `json:"model,omitempty"`
	TargetID  string    `json:"targetId,omitempty"`
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
			ensureMessageHistory(msg)
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

func (s *Store) ForkChatFromMessage(chatID, messageID, title string) (Chat, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	sourceIdx := -1
	for i := range s.data.Chats {
		if s.data.Chats[i].ID == chatID {
			sourceIdx = i
			break
		}
	}
	if sourceIdx < 0 {
		return Chat{}, errors.New("chat not found")
	}

	msgIdx := indexOfMessage(s.data.Chats[sourceIdx].Messages, messageID)
	if msgIdx < 0 {
		return Chat{}, errors.New("message not found")
	}

	now := time.Now().UTC()
	if strings.TrimSpace(title) == "" {
		title = s.data.Chats[sourceIdx].Title + " (Fork)"
	}

	cloned := cloneMessages(s.data.Chats[sourceIdx].Messages[:msgIdx+1])
	chat := Chat{
		ID:        newID("cht"),
		FolderID:  s.data.Chats[sourceIdx].FolderID,
		Title:     strings.TrimSpace(title),
		Messages:  cloned,
		CreatedAt: now,
		UpdatedAt: now,
	}
	s.data.Chats = append(s.data.Chats, chat)
	if err := s.touchFolderLocked(chat.FolderID); err != nil {
		return Chat{}, err
	}
	if err := s.persistLocked(); err != nil {
		return Chat{}, err
	}
	return chat, nil
}

func (s *Store) PrepareRegenerate(chatID, messageID string) (chat Chat, prompt string, history []Message, err error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	chatIdx := -1
	for i := range s.data.Chats {
		if s.data.Chats[i].ID == chatID {
			chatIdx = i
			break
		}
	}
	if chatIdx < 0 {
		return Chat{}, "", nil, errors.New("chat not found")
	}

	msgIdx := indexOfMessage(s.data.Chats[chatIdx].Messages, messageID)
	if msgIdx < 0 {
		return Chat{}, "", nil, errors.New("message not found")
	}

	userIdx := -1
	if s.data.Chats[chatIdx].Messages[msgIdx].Role == "user" {
		userIdx = msgIdx
	} else {
		for i := msgIdx; i >= 0; i-- {
			if s.data.Chats[chatIdx].Messages[i].Role == "user" {
				userIdx = i
				break
			}
		}
	}
	if userIdx < 0 {
		return Chat{}, "", nil, errors.New("no user prompt found before message")
	}

	prompt = s.data.Chats[chatIdx].Messages[userIdx].Content
	history = cloneMessages(s.data.Chats[chatIdx].Messages[:userIdx])
	s.data.Chats[chatIdx].Messages = cloneMessages(s.data.Chats[chatIdx].Messages[:userIdx+1])
	s.data.Chats[chatIdx].UpdatedAt = time.Now().UTC()
	if err := s.touchFolderLocked(s.data.Chats[chatIdx].FolderID); err != nil {
		return Chat{}, "", nil, err
	}
	if err := s.persistLocked(); err != nil {
		return Chat{}, "", nil, err
	}
	return s.data.Chats[chatIdx], prompt, history, nil
}

func (s *Store) PrepareUserRegenerate(chatID, messageID string) (chat Chat, prompt string, history []Message, replaceByTarget map[string]string, err error) {
	s.mu.RLock()
	defer s.mu.RUnlock()

	chatIdx := -1
	for i := range s.data.Chats {
		if s.data.Chats[i].ID == chatID {
			chatIdx = i
			break
		}
	}
	if chatIdx < 0 {
		return Chat{}, "", nil, nil, errors.New("chat not found")
	}

	msgIdx := indexOfMessage(s.data.Chats[chatIdx].Messages, messageID)
	if msgIdx < 0 {
		return Chat{}, "", nil, nil, errors.New("message not found")
	}
	if s.data.Chats[chatIdx].Messages[msgIdx].Role != "user" {
		return Chat{}, "", nil, nil, errors.New("message is not user")
	}

	prompt = s.data.Chats[chatIdx].Messages[msgIdx].Content
	history = cloneMessages(s.data.Chats[chatIdx].Messages[:msgIdx])
	replaceByTarget = map[string]string{}

	for i := msgIdx + 1; i < len(s.data.Chats[chatIdx].Messages); i++ {
		msg := s.data.Chats[chatIdx].Messages[i]
		if msg.Role == "user" {
			break
		}
		if msg.Role != "assistant" {
			continue
		}
		targetID := strings.TrimSpace(msg.TargetID)
		if targetID == "" && strings.TrimSpace(msg.Provider) != "" && strings.TrimSpace(msg.Model) != "" {
			targetID = strings.ToLower(strings.TrimSpace(msg.Provider)) + ":" + strings.TrimSpace(msg.Model)
		}
		if targetID == "" {
			continue
		}
		replaceByTarget[targetID] = msg.ID
	}

	return s.data.Chats[chatIdx], prompt, history, replaceByTarget, nil
}

func (s *Store) PrepareAssistantRegenerate(chatID, messageID string) (chat Chat, prompt string, history []Message, target Message, err error) {
	s.mu.RLock()
	defer s.mu.RUnlock()

	chatIdx := -1
	for i := range s.data.Chats {
		if s.data.Chats[i].ID == chatID {
			chatIdx = i
			break
		}
	}
	if chatIdx < 0 {
		return Chat{}, "", nil, Message{}, errors.New("chat not found")
	}

	msgIdx := indexOfMessage(s.data.Chats[chatIdx].Messages, messageID)
	if msgIdx < 0 {
		return Chat{}, "", nil, Message{}, errors.New("message not found")
	}

	target = s.data.Chats[chatIdx].Messages[msgIdx]
	if target.Role != "assistant" {
		return Chat{}, "", nil, Message{}, errors.New("message is not assistant")
	}
	if strings.TrimSpace(target.Provider) == "" || strings.TrimSpace(target.Model) == "" {
		return Chat{}, "", nil, Message{}, errors.New("assistant message is missing provider/model")
	}

	userIdx := -1
	for i := msgIdx; i >= 0; i-- {
		if s.data.Chats[chatIdx].Messages[i].Role == "user" {
			userIdx = i
			break
		}
	}
	if userIdx < 0 {
		return Chat{}, "", nil, Message{}, errors.New("no user prompt found before message")
	}

	prompt = s.data.Chats[chatIdx].Messages[userIdx].Content
	history = cloneMessages(s.data.Chats[chatIdx].Messages[:userIdx])
	chat = s.data.Chats[chatIdx]
	return chat, prompt, history, target, nil
}

func (s *Store) ReplaceAssistantMessage(chatID, messageID string, replacement Message) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	for i := range s.data.Chats {
		if s.data.Chats[i].ID != chatID {
			continue
		}
        for j := range s.data.Chats[i].Messages {
            if s.data.Chats[i].Messages[j].ID != messageID {
                continue
            }
            orig := s.data.Chats[i].Messages[j]
            if orig.Role != "assistant" {
                return errors.New("target message is not assistant")
            }
            ensureMessageHistory(&orig)
            s.data.Chats[i].Messages[j].Role = "assistant"
            s.data.Chats[i].Messages[j].Content = replacement.Content
            s.data.Chats[i].Messages[j].Provider = replacement.Provider
			s.data.Chats[i].Messages[j].Model = replacement.Model
			s.data.Chats[i].Messages[j].TargetID = replacement.TargetID
			s.data.Chats[i].Messages[j].Inclusion = replacement.Inclusion
			s.data.Chats[i].Messages[j].ScopeID = replacement.ScopeID
			s.data.Chats[i].Messages[j].CreatedAt = time.Now().UTC()
			if s.data.Chats[i].Messages[j].Inclusion == "" {
				s.data.Chats[i].Messages[j].Inclusion = "model_only"
			}
            if s.data.Chats[i].Messages[j].ScopeID == "" {
                s.data.Chats[i].Messages[j].ScopeID = s.data.Chats[i].Messages[j].TargetID
            }
            s.data.Chats[i].Messages[j].History = append(orig.History, MessageVersion{
                Content:   replacement.Content,
                Provider:  replacement.Provider,
                Model:     replacement.Model,
                TargetID:  replacement.TargetID,
                CreatedAt: time.Now().UTC(),
            })
            s.data.Chats[i].Messages[j].HistoryIndex = len(s.data.Chats[i].Messages[j].History) - 1
            s.data.Chats[i].UpdatedAt = time.Now().UTC()
			if err := s.touchFolderLocked(s.data.Chats[i].FolderID); err != nil {
				return err
			}
			return s.persistLocked()
		}
		return errors.New("message not found")
	}
	return errors.New("chat not found")
}

func (s *Store) EditUserMessageInPlace(chatID, messageID, content string) (Chat, error) {
	content = strings.TrimSpace(content)
	if content == "" {
		return Chat{}, errors.New("content is required")
	}

	s.mu.Lock()
	defer s.mu.Unlock()

	for i := range s.data.Chats {
		if s.data.Chats[i].ID != chatID {
			continue
		}
		msgIdx := indexOfMessage(s.data.Chats[i].Messages, messageID)
		if msgIdx < 0 {
			return Chat{}, errors.New("message not found")
		}
			if s.data.Chats[i].Messages[msgIdx].Role != "user" {
				return Chat{}, errors.New("only user messages can be edited")
			}

			ensureMessageHistory(&s.data.Chats[i].Messages[msgIdx])
			s.data.Chats[i].Messages[msgIdx].History = append(s.data.Chats[i].Messages[msgIdx].History, MessageVersion{
				Content:   content,
				CreatedAt: time.Now().UTC(),
			})
			s.data.Chats[i].Messages[msgIdx].HistoryIndex = len(s.data.Chats[i].Messages[msgIdx].History) - 1
			s.data.Chats[i].Messages[msgIdx].Content = content
			s.data.Chats[i].Messages[msgIdx].Provider = ""
			s.data.Chats[i].Messages[msgIdx].Model = ""
			s.data.Chats[i].Messages[msgIdx].TargetID = ""
			s.data.Chats[i].Messages[msgIdx].CreatedAt = time.Now().UTC()
			s.data.Chats[i].Messages = cloneMessages(s.data.Chats[i].Messages[:msgIdx+1])
		s.data.Chats[i].UpdatedAt = time.Now().UTC()
		if err := s.touchFolderLocked(s.data.Chats[i].FolderID); err != nil {
			return Chat{}, err
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
					History: []MessageVersion{{
						Content:   prompt,
						CreatedAt: now,
					}},
					HistoryIndex: 0,
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
            out.History = []MessageVersion{{
                Content:   out.Content,
                Provider:  out.Provider,
                Model:     out.Model,
                TargetID:  out.TargetID,
                CreatedAt: now,
            }}
            out.HistoryIndex = 0
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

func (s *Store) SetMessageHistoryIndex(chatID, messageID string, index int) (Message, error) {
	if index < 0 {
		return Message{}, errors.New("invalid history index")
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
			ensureMessageHistory(msg)
			if index >= len(msg.History) {
				return Message{}, errors.New("history index out of range")
			}
			msg.HistoryIndex = index
			version := msg.History[index]
			msg.Content = version.Content
			msg.Provider = version.Provider
			msg.Model = version.Model
			msg.TargetID = version.TargetID
			if msg.Inclusion == "model_only" && msg.Role == "assistant" {
				msg.ScopeID = msg.TargetID
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

func indexOfMessage(messages []Message, messageID string) int {
	for i := range messages {
		if messages[i].ID == messageID {
			return i
		}
	}
	return -1
}

func cloneMessages(messages []Message) []Message {
	out := make([]Message, 0, len(messages))
	for _, m := range messages {
		out = append(out, m)
	}
	return out
}

func ensureMessageHistory(msg *Message) {
	if msg == nil {
		return
	}
	if len(msg.History) == 0 {
		msg.History = []MessageVersion{{
			Content:   msg.Content,
			Provider:  msg.Provider,
			Model:     msg.Model,
			TargetID:  msg.TargetID,
			CreatedAt: msg.CreatedAt,
		}}
		msg.HistoryIndex = 0
	}
	if msg.HistoryIndex < 0 || msg.HistoryIndex >= len(msg.History) {
		msg.HistoryIndex = len(msg.History) - 1
	}
	current := msg.History[msg.HistoryIndex]
	msg.Content = current.Content
	msg.Provider = current.Provider
	msg.Model = current.Model
	msg.TargetID = current.TargetID
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
