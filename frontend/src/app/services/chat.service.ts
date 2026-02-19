import { Injectable } from '@angular/core';
import { ChatRequest, StreamEvent } from '../models/chat.models';

interface StreamCallbacks {
  onEvent: (event: StreamEvent) => void;
  onError: (error: Error) => void;
  onComplete: () => void;
}

@Injectable({ providedIn: 'root' })
export class ChatService {
  private readonly baseUrl = 'http://localhost:8080';

  async streamChat(request: ChatRequest, callbacks: StreamCallbacks, signal?: AbortSignal): Promise<void> {
    const res = await fetch(`${this.baseUrl}/api/chat/stream`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(request),
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
