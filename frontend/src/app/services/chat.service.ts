import { Injectable } from '@angular/core';
import { ChatDetail, ChatRequest, ChatSummary, ContextLimitItem, Folder, ProviderRuntimeConfig, StreamEvent, TextAttachment } from '../models/chat.models';

interface StreamCallbacks {
  onEvent: (event: StreamEvent) => void;
  onError: (error: Error) => void;
  onComplete: () => void;
}

@Injectable({ providedIn: 'root' })
export class ChatService {
  private readonly baseUrl = 'http://localhost:8080';

  async getConfig(): Promise<ProviderRuntimeConfig> {
    const res = await fetch(`${this.baseUrl}/api/config`);
    if (!res.ok) {
      throw new Error(`Failed to load config (${res.status})`);
    }
    const raw = await res.json();
    return {
      openrouter: {
        apiKey: raw.openrouter?.apiKey ?? '',
        baseUrl: raw.openrouter?.baseUrl ?? 'https://openrouter.ai/api/v1',
        models: raw.openrouter?.models ?? ['openai/gpt-4o-mini', 'anthropic/claude-3.5-sonnet']
      },
      ollama: {
        baseUrl: raw.ollama?.baseUrl ?? 'http://localhost:11434',
        models: raw.ollama?.models ?? ['llama3.2:latest', 'qwen2.5']
      }
    };
  }

  async saveConfig(config: ProviderRuntimeConfig): Promise<void> {
    const payload = {
      openrouter: {
        apiKey: config.openrouter.apiKey,
        baseUrl: config.openrouter.baseUrl,
        models: config.openrouter.models
      },
      ollama: {
        baseUrl: config.ollama.baseUrl,
        models: config.ollama.models
      }
    };
    const res = await fetch(`${this.baseUrl}/api/config`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(body || `Failed to save config (${res.status})`);
    }
  }

  async getFolders(): Promise<Folder[]> {
    const res = await fetch(`${this.baseUrl}/api/folders`);
    if (!res.ok) {
      throw new Error(`Failed to load folders (${res.status})`);
    }
    const data = await res.json();
    return data.folders ?? [];
  }

  async createFolder(name: string, systemPrompt: string, temperature?: number): Promise<Folder> {
    const res = await fetch(`${this.baseUrl}/api/folders`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, systemPrompt, temperature })
    });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(body || `Failed to create folder (${res.status})`);
    }
    return (await res.json()) as Folder;
  }

  async updateFolder(folderId: string, name: string, systemPrompt: string, temperature?: number): Promise<Folder> {
    const res = await fetch(`${this.baseUrl}/api/folders/${folderId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, systemPrompt, temperature })
    });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(body || `Failed to update folder (${res.status})`);
    }
    return (await res.json()) as Folder;
  }

  async getChats(folderId: string): Promise<ChatSummary[]> {
    const res = await fetch(`${this.baseUrl}/api/chats?folderId=${encodeURIComponent(folderId)}`);
    if (!res.ok) {
      throw new Error(`Failed to load chats (${res.status})`);
    }
    const data = await res.json();
    return data.chats ?? [];
  }

  async createChat(folderId: string, title = 'New Chat'): Promise<ChatSummary> {
    const res = await fetch(`${this.baseUrl}/api/chats`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ folderId, title })
    });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(body || `Failed to create chat (${res.status})`);
    }
    return (await res.json()) as ChatSummary;
  }

  async getChat(chatId: string): Promise<ChatDetail> {
    const res = await fetch(`${this.baseUrl}/api/chats/${chatId}`);
    if (!res.ok) {
      const body = await res.text();
      throw new Error(body || `Failed to load chat (${res.status})`);
    }
    return (await res.json()) as ChatDetail;
  }

  async updateChat(chatId: string, patch: { title?: string; folderId?: string }): Promise<ChatSummary> {
    const res = await fetch(`${this.baseUrl}/api/chats/${chatId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch)
    });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(body || `Failed to update chat (${res.status})`);
    }
    return (await res.json()) as ChatSummary;
  }

  async updateMessageInclusion(
    chatId: string,
    messageId: string,
    patch: { inclusion: 'dont_include' | 'model_only' | 'always'; scopeId?: string }
  ): Promise<void> {
    const res = await fetch(`${this.baseUrl}/api/chats/${chatId}/messages/${messageId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch)
    });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(body || `Failed to update message inclusion (${res.status})`);
    }
  }

  async forkChat(chatId: string, messageId: string, title = ''): Promise<ChatSummary> {
    const res = await fetch(`${this.baseUrl}/api/chats/${chatId}/fork`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messageId, title })
    });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(body || `Failed to fork chat (${res.status})`);
    }
    return (await res.json()) as ChatSummary;
  }

  async regenerateFromMessage(
    chatId: string,
    messageId: string,
    request: Omit<ChatRequest, 'chatId' | 'prompt'>,
    callbacks: StreamCallbacks,
    signal?: AbortSignal
  ): Promise<void> {
    await this.streamFromEndpoint(
      `${this.baseUrl}/api/chats/${chatId}/regenerate`,
      { messageId, targets: request.targets, config: request.config },
      callbacks,
      signal
    );
  }

  async editUserMessage(chatId: string, messageId: string, content: string, attachments: TextAttachment[]): Promise<void> {
    const res = await fetch(`${this.baseUrl}/api/chats/${chatId}/messages/${messageId}/edit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content, attachments })
    });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(body || `Failed to edit message (${res.status})`);
    }
  }

  async setMessageHistoryIndex(chatId: string, messageId: string, index: number): Promise<void> {
    const res = await fetch(`${this.baseUrl}/api/chats/${chatId}/messages/${messageId}/history`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ index })
    });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(body || `Failed to set message history index (${res.status})`);
    }
  }

  async summarizeFromUserMessage(
    chatId: string,
    userMessageId: string,
    target: { provider: string; model: string },
    config: ChatRequest['config'],
    callbacks: StreamCallbacks,
    signal?: AbortSignal
  ): Promise<void> {
    await this.streamFromEndpoint(
      `${this.baseUrl}/api/chats/${chatId}/summarize`,
      {
        userMessageId,
        target,
        config
      },
      callbacks,
      signal
    );
  }

  async streamChat(request: ChatRequest, callbacks: StreamCallbacks, signal?: AbortSignal): Promise<void> {
    await this.streamFromEndpoint(`${this.baseUrl}/api/chat/stream`, request, callbacks, signal);
  }

  async getContextLimits(
    targets: Array<{ provider: string; model: string }>,
    config: ChatRequest['config'],
    chatId?: string,
    prompt?: string,
    attachments?: TextAttachment[]
  ): Promise<ContextLimitItem[]> {
    const res = await fetch(`${this.baseUrl}/api/context-limits`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ targets, config, chatId, prompt, attachments })
    });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(body || `Failed to load context limits (${res.status})`);
    }
    const data = await res.json();
    return data.limits ?? [];
  }

  private async streamFromEndpoint(
    url: string,
    payload: unknown,
    callbacks: StreamCallbacks,
    signal?: AbortSignal
  ): Promise<void> {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal
    });

    if (!res.ok || !res.body) {
      const body = await res.text();
      throw new Error(body || `Streaming request failed (${res.status})`);
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) {
          break;
        }

        buffer += decoder.decode(value, { stream: true });
        const blocks = buffer.split('\n\n');
        buffer = blocks.pop() ?? '';

        for (const block of blocks) {
          const event = this.parseSseBlock(block);
          if (!event) {
            continue;
          }
          callbacks.onEvent(event);
          if (event.event === 'done') {
            callbacks.onComplete();
            return;
          }
        }
      }

      callbacks.onComplete();
    } catch (err) {
      if ((err as Error).name === 'AbortError') {
        callbacks.onComplete();
        return;
      }
      callbacks.onError(err as Error);
    } finally {
      reader.releaseLock();
    }
  }

  private parseSseBlock(block: string): StreamEvent | null {
    const lines = block
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);

    let data = '';
    for (const line of lines) {
      if (line.startsWith('data:')) {
        data += line.slice(5).trim();
      }
    }

    if (!data) {
      return null;
    }

    try {
      return JSON.parse(data) as StreamEvent;
    } catch {
      return null;
    }
  }
}
