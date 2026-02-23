export interface ProviderRuntimeConfig {
  openrouter: {
    apiKey: string;
    baseUrl: string;
    models: string[];
  };
  ollama: {
    baseUrl: string;
    models: string[];
  };
}

export interface ChatTarget {
  provider: string;
  model: string;
  systemPrompt?: string;
  temperature?: number;
}

export interface ChatRequest {
  chatId: string;
  prompt: string;
  targets: ChatTarget[];
  config: {
    openrouter?: {
      apiKey?: string;
      baseUrl?: string;
      models?: string[];
    };
    ollama?: {
      baseUrl?: string;
      models?: string[];
    };
  };
}

export interface StreamEvent {
  targetId: string;
  provider: string;
  model: string;
  event: 'start' | 'chunk' | 'error' | 'end' | 'done';
  content?: string;
  error?: string;
}

export interface Folder {
  id: string;
  name: string;
  systemPrompt: string;
  temperature?: number;
  createdAt: string;
  updatedAt: string;
}

export interface ChatSummary {
  id: string;
  folderId: string;
  title: string;
  createdAt: string;
  updatedAt: string;
}

export interface Message {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  provider?: string;
  model?: string;
  targetId?: string;
  isSummary?: boolean;
  inclusion?: 'dont_include' | 'model_only' | 'always';
  scopeId?: string;
  history?: MessageVersion[];
  historyIndex?: number;
  status?: 'streaming' | 'done' | 'error';
  error?: string;
  createdAt: string;
}

export interface MessageVersion {
  content: string;
  provider?: string;
  model?: string;
  targetId?: string;
  createdAt: string;
}

export interface ChatDetail extends ChatSummary {
  messages: Message[];
}

export interface ContextLimitItem {
  targetId: string;
  provider: string;
  model: string;
  maxContextTokens?: number;
  estimatedTokens?: number;
  remainingTokens?: number;
  usedPercent?: number;
  error?: string;
}
