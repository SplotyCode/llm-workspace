import { CommonModule } from '@angular/common';
import { Component } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ChatRequest, ProviderRuntimeConfig, StreamEvent, TargetResponse } from './models/chat.models';
import { ChatService } from './services/chat.service';

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './app.component.html',
  styleUrl: './app.component.css'
})
export class AppComponent {
  prompt = '';
  isStreaming = false;
  error = '';
  showSettings = false;

  responses = new Map<string, TargetResponse>();
  responseOrder: string[] = [];
  private abortController?: AbortController;

  config: ProviderRuntimeConfig = {
    openrouter: {
      apiKey: '',
      baseUrl: 'https://openrouter.ai/api/v1',
      models: ['openai/gpt-4o-mini', 'anthropic/claude-3.5-sonnet']
    },
    ollama: {
      baseUrl: 'http://localhost:11434',
      models: ['llama3.2:latest', 'qwen2.5']
    }
  };

  selectedTargets = new Set<string>();

  constructor(private readonly chatService: ChatService) {}

  get quickTargets(): Array<{ id: string; provider: string; model: string }> {
    return [
      ...this.config.openrouter.models.map((model) => ({ id: `openrouter:${model}`, provider: 'openrouter', model })),
      ...this.config.ollama.models.map((model) => ({ id: `ollama:${model}`, provider: 'ollama', model }))
    ];
  }

  get selectedTargetLabels(): string[] {
    return this.quickTargets.filter((t) => this.selectedTargets.has(t.id)).map((t) => `${t.provider} · ${t.model}`);
  }

  toggleTarget(targetId: string): void {
    if (this.selectedTargets.has(targetId)) {
      this.selectedTargets.delete(targetId);
    } else {
      this.selectedTargets.add(targetId);
    }
  }

  isTargetSelected(targetId: string): boolean {
    return this.selectedTargets.has(targetId);
  }

  providerIcon(provider: string): string {
    if (provider === 'openrouter') {
      return 'OR';
    }
    if (provider === 'ollama') {
      return 'OL';
    }
    return 'LLM';
  }

  async submit(): Promise<void> {
    this.error = '';
    const targets = this.buildTargets();

    if (!this.prompt.trim()) {
      this.error = 'Enter a prompt.';
      return;
    }
    if (targets.length === 0) {
      this.error = 'Choose at least one LLM in Quick Selector or Settings.';
      return;
    }

    this.responses.clear();
    this.responseOrder = [];
    this.isStreaming = true;
    this.abortController = new AbortController();

    const request: ChatRequest = {
      prompt: this.prompt.trim(),
      targets,
      config: {
        openrouter: {
          apiKey: this.config.openrouter.apiKey.trim(),
          baseUrl: this.config.openrouter.baseUrl.trim()
        },
        ollama: {
          baseUrl: this.config.ollama.baseUrl.trim()
        }
      }
    };

    try {
      await this.chatService.streamChat(
        request,
        {
          onEvent: (event) => this.handleEvent(event),
          onError: (err) => {
            this.error = err.message;
            this.isStreaming = false;
          },
          onComplete: () => {
            this.isStreaming = false;
          }
        },
        this.abortController.signal
      );
    } catch (err) {
      this.error = (err as Error).message;
      this.isStreaming = false;
    }
  }

  cancel(): void {
    this.abortController?.abort();
    this.isStreaming = false;
  }

  openSettings(): void {
    this.showSettings = true;
  }

  closeSettings(): void {
    this.showSettings = false;
  }

  parseModels(value: string): string[] {
    return value
      .split(',')
      .map((v) => v.trim())
      .filter(Boolean);
  }

  modelsToInput(models: string[]): string {
    return models.join(', ');
  }

  updateOpenRouterModels(input: string): void {
    this.config.openrouter.models = this.parseModels(input);
    this.cleanupSelectedTargets();
  }

  updateOllamaModels(input: string): void {
    this.config.ollama.models = this.parseModels(input);
    this.cleanupSelectedTargets();
  }

  get responseCards(): TargetResponse[] {
    return this.responseOrder
      .map((id) => this.responses.get(id))
      .filter((value): value is TargetResponse => Boolean(value));
  }

  private cleanupSelectedTargets(): void {
    const valid = new Set(this.quickTargets.map((t) => t.id));
    this.selectedTargets.forEach((id) => {
      if (!valid.has(id)) {
        this.selectedTargets.delete(id);
      }
    });
  }

  private buildTargets() {
    const targets: Array<{ provider: string; model: string }> = [];
    for (const targetId of this.selectedTargets) {
      const [provider, ...modelParts] = targetId.split(':');
      const model = modelParts.join(':').trim();
      if (!provider || !model) {
        continue;
      }
      targets.push({ provider, model });
    }
    return targets;
  }

  private handleEvent(event: StreamEvent): void {
    if (event.event === 'done') {
      this.isStreaming = false;
      return;
    }

    const id = event.targetId;
    let current = this.responses.get(id);
    if (!current) {
      current = {
        targetId: id,
        provider: event.provider,
        model: event.model,
        text: '',
        status: 'queued'
      };
      this.responses.set(id, current);
      this.responseOrder.push(id);
    }

    if (event.event === 'start') {
      current.status = 'streaming';
      current.startedAt = Date.now();
      return;
    }

    if (event.event === 'chunk') {
      current.status = 'streaming';
      current.text += event.content ?? '';
      return;
    }

    if (event.event === 'error') {
      current.status = 'error';
      current.error = event.error ?? 'unknown error';
      return;
    }

    if (event.event === 'end' && current.status !== 'error') {
      current.status = 'done';
    }
  }
}
