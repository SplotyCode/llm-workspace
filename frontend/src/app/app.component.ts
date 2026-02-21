import { CommonModule } from '@angular/common';
import { Component, ElementRef, OnInit, QueryList, ViewChildren } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ChatDetail, ChatRequest, ChatSummary, Folder, Message, ProviderRuntimeConfig, StreamEvent } from './models/chat.models';
import { ChatService } from './services/chat.service';

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './app.component.html',
  styleUrl: './app.component.css'
})
export class AppComponent implements OnInit {
  @ViewChildren('chatRenameInput') private chatRenameInputs!: QueryList<ElementRef<HTMLInputElement>>;
  prompt = '';
  isStreaming = false;
  error = '';

  showSettings = false;
  showFolderSettings = false;

  folders: Folder[] = [];
  chats: ChatSummary[] = [];
  selectedFolderId = '';
  selectedChatId = '';
  selectedChat: ChatDetail | null = null;

  newFolderName = '';

  folderSettingsFolderId = '';
  folderSettingsName = '';
  folderSettingsPrompt = '';
  folderSettingsTemperature = '';

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
  private liveAssistantIndexByTarget = new Map<string, number>();
  private abortController?: AbortController;
  openMessageMenuId = '';
  regeneratingMessageId = '';
  showEditMessageModal = false;
  editingUserMessageId = '';
  editingUserMessageContent = '';
  editingUserMessageMode: 'inplace' | 'fork' = 'inplace';
  draggingChatId = '';
  dropFolderId = '';
  editingChatId = '';
  editingChatTitle = '';

  constructor(private readonly chatService: ChatService) {}

  async ngOnInit(): Promise<void> {
    try {
      this.config = await this.chatService.getConfig();
      await this.reloadFolders();
    } catch (err) {
      this.error = (err as Error).message;
    }
  }

  get quickTargets(): Array<{ id: string; provider: string; model: string }> {
    return [
      ...this.config.openrouter.models.map((model) => ({ id: `openrouter:${model}`, provider: 'openrouter', model })),
      ...this.config.ollama.models.map((model) => ({ id: `ollama:${model}`, provider: 'ollama', model }))
    ];
  }

  providerIcon(provider: string): string {
    if (provider === 'openrouter') return 'OR';
    if (provider === 'ollama') return 'OL';
    return 'LLM';
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

  async createFolder(): Promise<void> {
    const name = this.newFolderName.trim();
    if (!name) return;
    try {
      const folder = await this.chatService.createFolder(name, '', undefined);
      this.newFolderName = '';
      await this.reloadFolders(folder.id);
    } catch (err) {
      this.error = (err as Error).message;
    }
  }

  async selectFolder(folderId: string): Promise<void> {
    this.selectedFolderId = folderId;
    await this.reloadChats();
  }

  openFolderSettings(folder: Folder, event?: MouseEvent): void {
    event?.stopPropagation();
    this.folderSettingsFolderId = folder.id;
    this.folderSettingsName = folder.name;
    this.folderSettingsPrompt = folder.systemPrompt;
    this.folderSettingsTemperature = folder.temperature == null ? '' : String(folder.temperature);
    this.showFolderSettings = true;
  }

  closeFolderSettings(): void {
    this.showFolderSettings = false;
    this.folderSettingsFolderId = '';
    this.folderSettingsName = '';
    this.folderSettingsPrompt = '';
    this.folderSettingsTemperature = '';
  }

  async saveFolderSettings(): Promise<void> {
    if (!this.folderSettingsFolderId) return;

    const parsed = this.parseTemperature(this.folderSettingsTemperature);
    if (parsed === null) {
      this.error = 'Temperature must be a number between 0 and 2.';
      return;
    }

    try {
      await this.chatService.updateFolder(
        this.folderSettingsFolderId,
        this.folderSettingsName,
        this.folderSettingsPrompt,
        parsed
      );
      await this.reloadFolders(this.folderSettingsFolderId);
      this.closeFolderSettings();
    } catch (err) {
      this.error = (err as Error).message;
    }
  }

  async createChat(): Promise<void> {
    if (!this.selectedFolderId) return;
    try {
      const chat = await this.chatService.createChat(this.selectedFolderId, 'New Chat');
      await this.reloadChats(chat.id);
    } catch (err) {
      this.error = (err as Error).message;
    }
  }

  async selectChat(chatId: string): Promise<void> {
    this.selectedChatId = chatId;
    try {
      this.selectedChat = await this.chatService.getChat(chatId);
    } catch (err) {
      this.error = (err as Error).message;
    }
  }

  startChatDrag(chatId: string): void {
    this.draggingChatId = chatId;
  }

  endChatDrag(): void {
    this.draggingChatId = '';
    this.dropFolderId = '';
  }

  onFolderDragOver(folderId: string, event: DragEvent): void {
    if (!this.draggingChatId) return;
    event.preventDefault();
    this.dropFolderId = folderId;
  }

  async onChatDropOnFolder(folderId: string, event: DragEvent): Promise<void> {
    event.preventDefault();
    if (!this.draggingChatId) return;

    const chatId = this.draggingChatId;
    this.endChatDrag();
    const chat = this.chats.find((c) => c.id === chatId);
    if (!chat) return;
    if (chat.folderId === folderId && this.selectedFolderId === folderId) return;

    try {
      await this.chatService.updateChat(chatId, { folderId });
      await this.reloadFolders(folderId);
      await this.reloadChats(chatId);
    } catch (err) {
      this.error = (err as Error).message;
    }
  }

  startRenameChat(chat: ChatSummary, event?: MouseEvent): void {
    event?.stopPropagation();
    this.editingChatId = chat.id;
    this.editingChatTitle = chat.title;
    setTimeout(() => this.focusRenameInput(), 0);
  }

  cancelRenameChat(): void {
    this.editingChatId = '';
    this.editingChatTitle = '';
  }

  async saveRenameChat(chatId: string): Promise<void> {
    const title = this.editingChatTitle.trim();
    if (!title) {
      this.cancelRenameChat();
      return;
    }
    try {
      await this.chatService.updateChat(chatId, { title });
      const keepFolderId = this.selectedFolderId;
      const keepChatId = this.selectedChatId === chatId ? chatId : this.selectedChatId;
      await this.reloadFolders(keepFolderId);
      await this.reloadChats(keepChatId);
      this.cancelRenameChat();
    } catch (err) {
      this.error = (err as Error).message;
    }
  }

  async submit(): Promise<void> {
    this.error = '';
    const targets = this.buildTargets();

    if (!this.prompt.trim()) {
      this.error = 'Enter a prompt.';
      return;
    }
    if (targets.length === 0) {
      this.error = 'Choose at least one LLM in Quick Selector.';
      return;
    }
    if (!this.selectedFolderId) {
      this.error = 'Choose a folder first.';
      return;
    }

    if (!this.selectedChatId) {
      await this.createChat();
      if (!this.selectedChatId) return;
    }

    const userPrompt = this.prompt.trim();
    this.prompt = '';
    this.isStreaming = true;
    this.liveAssistantIndexByTarget.clear();
    this.abortController = new AbortController();

    this.pushLocalMessage({
      id: `tmp_user_${Date.now()}`,
      role: 'user',
      content: userPrompt,
      inclusion: 'always',
      createdAt: new Date().toISOString()
    });

    const request: ChatRequest = {
      chatId: this.selectedChatId,
      prompt: userPrompt,
      targets,
      config: {
        openrouter: {
          apiKey: this.config.openrouter.apiKey.trim(),
          baseUrl: this.config.openrouter.baseUrl.trim(),
          models: this.config.openrouter.models
        },
        ollama: {
          baseUrl: this.config.ollama.baseUrl.trim(),
          models: this.config.ollama.models
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
            void this.refreshAfterStream();
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
    this.regeneratingMessageId = '';
  }

  openSettings(): void {
    this.showSettings = true;
  }

  closeSettings(): void {
    this.showSettings = false;
  }

  async saveSettings(): Promise<void> {
    try {
      await this.chatService.saveConfig(this.config);
      this.showSettings = false;
    } catch (err) {
      this.error = (err as Error).message;
    }
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

  async onMessageInclusionChange(message: Message, value: string): Promise<void> {
    const normalized = this.normalizeInclusion(value);
    if (!normalized) {
      return;
    }
    const allowed = this.normalizeInclusionForMessage(message, normalized);
    message.inclusion = allowed;
    if (allowed === 'model_only') {
      message.scopeId = message.targetId ?? message.scopeId ?? '';
    } else {
      message.scopeId = '';
    }

    if (!this.selectedChatId || message.id.startsWith('tmp_')) {
      return;
    }

    try {
      await this.chatService.updateMessageInclusion(this.selectedChatId, message.id, {
        inclusion: allowed,
        scopeId: message.scopeId
      });
    } catch (err) {
      this.error = (err as Error).message;
    }
  }

  messageInclusionOptions(message: Message): Array<{ value: 'dont_include' | 'model_only' | 'always'; label: string }> {
    if (message.role === 'user') {
      return [
        { value: 'always', label: 'always include' },
        { value: 'dont_include', label: "don't include" }
      ];
    }
    return [
      { value: 'model_only', label: 'this model' },
      { value: 'always', label: 'always include' },
      { value: 'dont_include', label: "don't include" }
    ];
  }

  messageInclusionValue(message: Message): 'dont_include' | 'model_only' | 'always' {
    const raw = this.normalizeInclusion(message.inclusion ?? '');
    return this.normalizeInclusionForMessage(message, raw || (message.role === 'assistant' ? 'model_only' : 'always'));
  }

  toggleMessageMenu(messageId: string, event?: MouseEvent): void {
    event?.stopPropagation();
    this.openMessageMenuId = this.openMessageMenuId === messageId ? '' : messageId;
  }

  closeMessageMenu(): void {
    this.openMessageMenuId = '';
  }

  async forkFromMessage(message: Message): Promise<void> {
    if (!this.selectedChatId) {
      return;
    }
    this.closeMessageMenu();
    try {
      const fork = await this.chatService.forkChat(this.selectedChatId, message.id);
      await this.reloadFolders(fork.folderId);
      await this.reloadChats(fork.id);
    } catch (err) {
      this.error = (err as Error).message;
    }
  }

  openEditUserMessage(message: Message): void {
    if (message.role !== 'user') {
      return;
    }
    this.closeMessageMenu();
    this.editingUserMessageId = message.id;
    this.editingUserMessageContent = message.content;
    this.editingUserMessageMode = 'inplace';
    this.showEditMessageModal = true;
  }

  closeEditUserMessageModal(): void {
    this.showEditMessageModal = false;
    this.editingUserMessageId = '';
    this.editingUserMessageContent = '';
    this.editingUserMessageMode = 'inplace';
  }

  async saveEditUserMessage(): Promise<void> {
    if (!this.selectedChatId || !this.editingUserMessageId) {
      return;
    }
    const content = this.editingUserMessageContent.trim();
    if (!content) {
      this.error = 'Edited message cannot be empty.';
      return;
    }

    try {
      if (this.editingUserMessageMode === 'inplace') {
        await this.chatService.editUserMessage(this.selectedChatId, this.editingUserMessageId, content);
        await this.reloadChats(this.selectedChatId);
        this.closeEditUserMessageModal();
        return;
      }

      const fork = await this.chatService.forkChat(this.selectedChatId, this.editingUserMessageId);
      await this.chatService.editUserMessage(fork.id, this.editingUserMessageId, content);
      await this.reloadFolders(fork.folderId);
      await this.reloadChats(fork.id);
      this.closeEditUserMessageModal();
    } catch (err) {
      this.error = (err as Error).message;
    }
  }

  async regenerateFromMessage(message: Message): Promise<void> {
    if (!this.selectedChatId || this.isStreaming) {
      return;
    }
    let targets = this.buildTargets();
    if (message.role === 'assistant' && message.provider && message.model) {
      targets = [{ provider: message.provider, model: message.model }];
      this.regeneratingMessageId = message.id;
    } else {
      this.regeneratingMessageId = '';
      if (targets.length === 0) {
        this.error = 'Choose at least one LLM in Quick Selector.';
        return;
      }
    }

    this.closeMessageMenu();
    this.isStreaming = true;
    this.liveAssistantIndexByTarget.clear();
    this.abortController = new AbortController();

    try {
      await this.chatService.regenerateFromMessage(
        this.selectedChatId,
        message.id,
        {
          targets,
          config: {
            openrouter: {
              apiKey: this.config.openrouter.apiKey.trim(),
              baseUrl: this.config.openrouter.baseUrl.trim(),
              models: this.config.openrouter.models
            },
            ollama: {
              baseUrl: this.config.ollama.baseUrl.trim(),
              models: this.config.ollama.models
            }
          }
        },
        {
          onEvent: (event) => this.handleEvent(event),
          onError: (err) => {
            this.error = err.message;
            this.isStreaming = false;
          },
          onComplete: () => {
            this.isStreaming = false;
            this.regeneratingMessageId = '';
            void this.refreshAfterStream();
          }
        },
        this.abortController.signal
      );
    } catch (err) {
      this.error = (err as Error).message;
      this.isStreaming = false;
      this.regeneratingMessageId = '';
    }
  }

  inclusionOptionTitle(value: 'dont_include' | 'model_only' | 'always'): string {
    if (value === 'dont_include') {
      return 'Exclude this message from future prompts.';
    }
    if (value === 'model_only') {
      return 'Include this message only when generating with this specific model.';
    }
    return 'Include this message for all models in future prompts.';
  }

  private async reloadFolders(preferredFolderId?: string): Promise<void> {
    this.folders = await this.chatService.getFolders();
    if (this.folders.length === 0) return;

    if (preferredFolderId && this.folders.some((f) => f.id === preferredFolderId)) {
      this.selectedFolderId = preferredFolderId;
    } else if (!this.selectedFolderId || !this.folders.some((f) => f.id === this.selectedFolderId)) {
      this.selectedFolderId = this.folders[0].id;
    }

    await this.reloadChats();
  }

  private async reloadChats(preferredChatId?: string): Promise<void> {
    if (!this.selectedFolderId) {
      this.chats = [];
      this.selectedChat = null;
      this.selectedChatId = '';
      return;
    }

    this.chats = await this.chatService.getChats(this.selectedFolderId);

    if (preferredChatId && this.chats.some((c) => c.id === preferredChatId)) {
      this.selectedChatId = preferredChatId;
    } else if (!this.selectedChatId || !this.chats.some((c) => c.id === this.selectedChatId)) {
      this.selectedChatId = this.chats[0]?.id ?? '';
    }

    if (this.selectedChatId) {
      await this.selectChat(this.selectedChatId);
    } else {
      this.selectedChat = null;
    }
  }

  private pushLocalMessage(message: Message): void {
    if (!this.selectedChat) {
      this.selectedChat = {
        id: this.selectedChatId,
        folderId: this.selectedFolderId,
        title: 'New Chat',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        messages: []
      };
    }
    this.selectedChat.messages = [...this.selectedChat.messages, message];
  }

  private async refreshAfterStream(): Promise<void> {
    await this.reloadChats(this.selectedChatId);
  }

  private cleanupSelectedTargets(): void {
    const valid = new Set(this.quickTargets.map((t) => t.id));
    this.selectedTargets.forEach((id) => {
      if (!valid.has(id)) this.selectedTargets.delete(id);
    });
  }

  private buildTargets() {
    const targets: Array<{ provider: string; model: string }> = [];
    for (const targetId of this.selectedTargets) {
      const [provider, ...modelParts] = targetId.split(':');
      const model = modelParts.join(':').trim();
      if (!provider || !model) continue;
      targets.push({ provider, model });
    }
    return targets;
  }

  private handleEvent(event: StreamEvent): void {
    if (event.event === 'done') {
      this.isStreaming = false;
      return;
    }

    if (!this.selectedChat) return;

    const idx = this.liveAssistantIndexByTarget.get(event.targetId);

    if (event.event === 'start') {
      if (this.regeneratingMessageId) {
        const replaceIdx = this.selectedChat.messages.findIndex((m) => m.id === this.regeneratingMessageId);
        if (replaceIdx >= 0) {
          const existing = this.selectedChat.messages[replaceIdx];
          existing.provider = event.provider;
          existing.model = event.model;
          existing.targetId = event.targetId;
          existing.inclusion = 'model_only';
          existing.scopeId = event.targetId;
          existing.status = 'streaming';
          existing.error = '';
          existing.content = '';
          this.selectedChat.messages = [...this.selectedChat.messages];
          this.liveAssistantIndexByTarget.set(event.targetId, replaceIdx);
          return;
        }
      }

      const message: Message = {
        id: `tmp_assistant_${event.targetId}_${Date.now()}`,
        role: 'assistant',
        content: '',
        provider: event.provider,
        model: event.model,
        targetId: event.targetId,
        inclusion: 'model_only',
        scopeId: event.targetId,
        status: 'streaming',
        createdAt: new Date().toISOString()
      };
      this.selectedChat.messages = [...this.selectedChat.messages, message];
      this.liveAssistantIndexByTarget.set(event.targetId, this.selectedChat.messages.length - 1);
      return;
    }

    if (idx == null || idx < 0 || idx >= this.selectedChat.messages.length) return;

    const msg = this.selectedChat.messages[idx];

    if (event.event === 'chunk') {
      msg.status = 'streaming';
      msg.content += event.content ?? '';
      this.selectedChat.messages = [...this.selectedChat.messages];
      return;
    }

    if (event.event === 'error') {
      msg.status = 'error';
      msg.error = event.error ?? 'unknown error';
      if (!msg.content.trim()) {
        msg.content = `Error: ${msg.error}`;
      }
      this.selectedChat.messages = [...this.selectedChat.messages];
      return;
    }

    if (event.event === 'end') {
      if (msg.status !== 'error') msg.status = 'done';
      this.selectedChat.messages = [...this.selectedChat.messages];
    }
  }

  private parseTemperature(input: string): number | undefined | null {
    const v = input.trim();
    if (!v) return undefined;
    const n = Number(v);
    if (!Number.isFinite(n) || n < 0 || n > 2) return null;
    return n;
  }

  private normalizeInclusion(value: string): 'dont_include' | 'model_only' | 'always' | '' {
    if (value === 'dont_include' || value === 'model_only' || value === 'always') {
      return value;
    }
    return '';
  }

  private normalizeInclusionForMessage(
    message: Message,
    value: 'dont_include' | 'model_only' | 'always'
  ): 'dont_include' | 'model_only' | 'always' {
    if (message.role === 'user' && value === 'model_only') {
      return 'always';
    }
    return value;
  }

  private focusRenameInput(): void {
    const input = this.chatRenameInputs?.first?.nativeElement;
    if (!input) return;
    input.focus();
    input.select();
  }
}
