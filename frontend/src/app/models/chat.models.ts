export interface ProviderCatalog {
  id: string;
  name: string;
  models: string[];
}

export interface ChatTarget {
  provider: string;
  model: string;
  systemPrompt?: string;
  temperature?: number;
}

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

export interface ChatRequest {
  prompt: string;
  targets: ChatTarget[];
  config: {
    openrouter?: {
      apiKey?: string;
      baseUrl?: string;
    };
    ollama?: {
      baseUrl?: string;
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

export interface TargetResponse {
  targetId: string;
  provider: string;
  model: string;
  text: string;
  status: 'queued' | 'streaming' | 'done' | 'error';
  error?: string;
  startedAt?: number;
}
