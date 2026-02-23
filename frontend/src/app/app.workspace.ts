import { Directive } from '@angular/core';
import { ChatDetail, ChatRequest, ChatSummary, ContextLimitItem, Folder, Message, ProviderRuntimeConfig, StreamEvent } from './models/chat.models';
import { ChatService } from './services/chat.service';

interface MessageGroup {
  user: Message;
  assistants: Message[];
}

@Directive()
export class AppWorkspace {
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
  openInclusionMessageId = '';
  regeneratingMessageId = '';
  regeneratingUserReplaceByTarget = new Map<string, string>();
  showEditMessageModal = false;
  editingUserMessageId = '';
  editingUserMessageContent = '';
  editingUserMessageMode: 'inplace' | 'fork' = 'inplace';
  draggingChatId = '';
  dropFolderId = '';
  editingChatId = '';
  editingChatTitle = '';
  summaryTargetByUser = new Map<string, string>();
  pendingSummaries = new Set<string>();
  private isSummaryStream = false;
  contextLimitsByTarget = new Map<string, ContextLimitItem>();
  isContextLoading = false;
  contextLoadError = '';
  private contextRefreshTimer?: ReturnType<typeof setTimeout>;
  private quickTargetsCache: Array<{ id: string; provider: string; model: string }> = [];
  private quickTargetsKey = '';
  private messageGroupsCache: MessageGroup[] = [];
  private messageGroupsMessagesRef: Message[] | null = null;
  private messageGroupsChatId = '';

  constructor(protected readonly chatService: ChatService) {}

  async ngOnInit(): Promise<void> {
    try {
      this.config = await this.chatService.getConfig();
      await this.reloadFolders();
      await this.refreshContextLimits();
    } catch (err) {
      this.error = (err as Error).message;
    }
  }

  get quickTargets(): Array<{ id: string; provider: string; model: string }> {
    const key = `${this.config.openrouter.models.join('\u0001')}::${this.config.ollama.models.join('\u0001')}`;
    if (key === this.quickTargetsKey) {
      return this.quickTargetsCache;
    }
    this.quickTargetsKey = key;
    this.quickTargetsCache = [
      ...this.config.openrouter.models.map((model) => ({ id: `openrouter:${model}`, provider: 'openrouter', model })),
      ...this.config.ollama.models.map((model) => ({ id: `ollama:${model}`, provider: 'ollama', model }))
    ];
    return this.quickTargetsCache;
  }

  get summaryModelOptions(): Array<{ id: string; provider: string; model: string }> {
    return this.quickTargets;
  }

  get messageGroups(): MessageGroup[] {
    if (!this.selectedChat) {
      this.messageGroupsCache = [];
      this.messageGroupsMessagesRef = null;
      this.messageGroupsChatId = '';
      return this.messageGroupsCache;
    }
    if (
      this.messageGroupsChatId === this.selectedChat.id &&
      this.messageGroupsMessagesRef === this.selectedChat.messages
    ) {
      return this.messageGroupsCache;
    }

    const groups: MessageGroup[] = [];
    let current: MessageGroup | null = null;
    for (const msg of this.selectedChat.messages) {
      if (msg.role === 'user') {
        current = { user: msg, assistants: [] };
        groups.push(current);
        continue;
      }
      if (msg.role === 'assistant' && current) {
        current.assistants.push(msg);
      }
    }
    this.messageGroupsCache = groups;
    this.messageGroupsMessagesRef = this.selectedChat.messages;
    this.messageGroupsChatId = this.selectedChat.id;
    return this.messageGroupsCache;
  }

  trackById(_index: number, item: { id: string }): string {
    return item.id;
  }

  trackByGroup(_index: number, group: MessageGroup): string {
    return group.user.id;
  }

  trackByTargetId(_index: number, item: { targetId: string }): string {
    return item.targetId;
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
    void this.refreshContextLimits();
  }

  onPromptChanged(): void {
    if (this.contextRefreshTimer) {
      clearTimeout(this.contextRefreshTimer);
    }
    this.contextRefreshTimer = setTimeout(() => {
      void this.refreshContextLimits();
    }, 220);
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
      void this.refreshContextLimits();
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
    this.isSummaryStream = false;
    this.liveAssistantIndexByTarget.clear();
    this.regeneratingUserReplaceByTarget.clear();
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
            this.isSummaryStream = false;
            this.regeneratingUserReplaceByTarget.clear();
            void this.processPendingSummaries();
          },
          onComplete: () => {
            this.isStreaming = false;
            this.isSummaryStream = false;
            this.regeneratingUserReplaceByTarget.clear();
            void this.refreshAfterStream().then(() => this.processPendingSummaries());
          }
        },
        this.abortController.signal
      );
    } catch (err) {
      this.error = (err as Error).message;
      this.isStreaming = false;
      this.isSummaryStream = false;
      this.regeneratingUserReplaceByTarget.clear();
      void this.processPendingSummaries();
    }
  }

  cancel(): void {
    this.abortController?.abort();
    this.isStreaming = false;
    this.isSummaryStream = false;
    this.regeneratingMessageId = '';
    this.regeneratingUserReplaceByTarget.clear();
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
      await this.refreshContextLimits();
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
    void this.refreshContextLimits();
  }

  updateOllamaModels(input: string): void {
    this.config.ollama.models = this.parseModels(input);
    this.cleanupSelectedTargets();
    void this.refreshContextLimits();
  }

  get contextIndicatorItems(): ContextLimitItem[] {
    const baseItems: ContextLimitItem[] = [];
    const items: ContextLimitItem[] = [];
    for (const targetId of this.selectedTargets) {
      const [provider, ...modelParts] = targetId.split(':');
      const model = modelParts.join(':').trim();
      if (!provider || !model) {
        continue;
      }
      const existing = this.contextLimitsByTarget.get(targetId);
      if (existing) {
        baseItems.push(existing);
      } else {
        baseItems.push({ targetId, provider, model, error: 'loading...' });
      }
    }
    items.push(...baseItems);
    items.sort((a, b) => {
      const ar = a.remainingTokens ?? Number.MAX_SAFE_INTEGER;
      const br = b.remainingTokens ?? Number.MAX_SAFE_INTEGER;
      return ar - br;
    });
    return items;
  }

  get minContextItem(): ContextLimitItem | null {
    const items = this.contextIndicatorItems.filter(
      (item) => typeof item.maxContextTokens === 'number' && !item.error && typeof item.remainingTokens === 'number'
    );
    if (items.length === 0) {
      return null;
    }
    return items[0];
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
      void this.refreshContextLimits();
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

  toggleInclusionMenu(messageId: string, event?: MouseEvent): void {
    event?.stopPropagation();
    this.openInclusionMessageId = this.openInclusionMessageId === messageId ? '' : messageId;
  }

  closeInclusionMenu(): void {
    this.openInclusionMessageId = '';
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
    const editedMessageId = this.editingUserMessageId;
    const content = this.editingUserMessageContent.trim();
    if (!content) {
      this.error = 'Edited message cannot be empty.';
      return;
    }

    try {
      if (this.editingUserMessageMode === 'inplace') {
        await this.chatService.editUserMessage(this.selectedChatId, editedMessageId, content);
        await this.reloadChats(this.selectedChatId);
        this.closeEditUserMessageModal();
        const edited = this.selectedChat?.messages.find((m) => m.id === editedMessageId);
        if (edited) {
          await this.regenerateFromMessage(edited);
        }
        return;
      }

      const fork = await this.chatService.forkChat(this.selectedChatId, editedMessageId);
      await this.chatService.editUserMessage(fork.id, editedMessageId, content);
      await this.reloadFolders(fork.folderId);
      await this.reloadChats(fork.id);
      this.closeEditUserMessageModal();
      const edited = this.selectedChat?.messages.find((m) => m.id === editedMessageId);
      if (edited) {
        await this.regenerateFromMessage(edited);
      }
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
      this.regeneratingUserReplaceByTarget.clear();
    } else {
      this.regeneratingMessageId = '';
      this.regeneratingUserReplaceByTarget = this.findAssistantTargetsAfterUserMessage(message.id);
      if (targets.length === 0) {
        this.error = 'Choose at least one LLM in Quick Selector.';
        return;
      }
    }

    this.closeMessageMenu();
    this.isStreaming = true;
    this.isSummaryStream = false;
    this.liveAssistantIndexByTarget.clear();
    this.abortController = new AbortController();

    try {
      await this.chatService.regenerateFromMessage(
        this.selectedChatId,
        message.id,
        {
          targets,
          config: this.runtimeConfig()
        },
        {
          onEvent: (event) => this.handleEvent(event),
          onError: (err) => {
            this.error = err.message;
            this.isStreaming = false;
            this.isSummaryStream = false;
          },
          onComplete: () => {
            this.isStreaming = false;
            this.isSummaryStream = false;
            this.regeneratingMessageId = '';
            this.regeneratingUserReplaceByTarget.clear();
            void this.refreshAfterStream().then(() => this.processPendingSummaries());
          }
        },
        this.abortController.signal
      );
    } catch (err) {
      this.error = (err as Error).message;
      this.isStreaming = false;
      this.isSummaryStream = false;
      this.regeneratingMessageId = '';
      this.regeneratingUserReplaceByTarget.clear();
    }
  }

  canMoveMessageHistory(message: Message): boolean {
    return (message.history?.length ?? 0) > 1;
  }

  summaryTargetId(userMessageId: string): string {
    return this.summaryTargetByUser.get(userMessageId) ?? this.summaryModelOptions[0]?.id ?? '';
  }

  setSummaryTargetId(userMessageId: string, targetId: string): void {
    this.summaryTargetByUser.set(userMessageId, targetId);
  }

  isSummaryPending(userMessageId: string): boolean {
    return this.pendingSummaries.has(userMessageId);
  }

  async requestSummarize(userMessageId: string): Promise<void> {
    this.closeMessageMenu();
    this.closeInclusionMenu();

    if (this.isStreaming || this.groupHasStreaming(userMessageId)) {
      this.pendingSummaries.add(userMessageId);
      return;
    }
    await this.runSummarize(userMessageId);
  }

  messageHistoryPosition(message: Message): string {
    const total = message.history?.length ?? 0;
    if (total <= 1) {
      return '1/1';
    }
    const idx = message.historyIndex ?? total - 1;
    return `${idx + 1}/${total}`;
  }

  async moveMessageHistory(message: Message, delta: -1 | 1): Promise<void> {
    if (!this.selectedChatId || !this.canMoveMessageHistory(message)) {
      return;
    }
    const total = message.history?.length ?? 0;
    const current = message.historyIndex ?? total - 1;
    const next = current + delta;
    if (next < 0 || next >= total) {
      return;
    }

    message.historyIndex = next;
    const selected = message.history?.[next];
    if (selected) {
      message.content = selected.content;
      message.provider = selected.provider;
      message.model = selected.model;
      message.targetId = selected.targetId;
      if (message.inclusion === 'model_only') {
        message.scopeId = message.targetId ?? '';
      }
    }
    if (this.selectedChat) {
      this.selectedChat.messages = [...this.selectedChat.messages];
    }

    try {
      await this.chatService.setMessageHistoryIndex(this.selectedChatId, message.id, next);
    } catch (err) {
      this.error = (err as Error).message;
      await this.reloadChats(this.selectedChatId);
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

  inclusionDisplayLabel(message: Message): string {
    const v = this.messageInclusionValue(message);
    if (v === 'dont_include') return "don't include";
    if (v === 'always') return 'always include';
    return 'this model';
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

  private async processPendingSummaries(): Promise<void> {
    if (this.isStreaming || this.pendingSummaries.size === 0) {
      return;
    }
    const pending = [...this.pendingSummaries];
    for (const userId of pending) {
      if (this.isStreaming) {
        return;
      }
      if (this.groupHasStreaming(userId)) {
        continue;
      }
      this.pendingSummaries.delete(userId);
      await this.runSummarize(userId);
    }
  }

  private async runSummarize(userMessageId: string): Promise<void> {
    if (!this.selectedChatId) {
      return;
    }
    const targetId = this.summaryTargetId(userMessageId);
    const target = this.summaryModelOptions.find((t) => t.id === targetId);
    if (!target) {
      this.error = 'Choose a valid summary model.';
      return;
    }

    this.isStreaming = true;
    this.isSummaryStream = true;
    this.liveAssistantIndexByTarget.clear();
    this.abortController = new AbortController();

    try {
      await this.chatService.summarizeFromUserMessage(
        this.selectedChatId,
        userMessageId,
        { provider: target.provider, model: target.model },
        this.runtimeConfig(),
        {
          onEvent: (event) => this.handleEvent(event),
          onError: (err) => {
            this.error = err.message;
            this.isStreaming = false;
            this.isSummaryStream = false;
          },
          onComplete: () => {
            this.isStreaming = false;
            this.isSummaryStream = false;
            void this.refreshAfterStream().then(() => this.processPendingSummaries());
          }
        },
        this.abortController.signal
      );
    } catch (err) {
      this.error = (err as Error).message;
      this.isStreaming = false;
      this.isSummaryStream = false;
    }
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

  private findAssistantTargetsAfterUserMessage(messageId: string): Map<string, string> {
    const map = new Map<string, string>();
    if (!this.selectedChat) {
      return map;
    }

    const messages = this.selectedChat.messages;
    const startIdx = messages.findIndex((m) => m.id === messageId);
    if (startIdx < 0 || messages[startIdx].role !== 'user') {
      return map;
    }

    for (let i = startIdx + 1; i < messages.length; i++) {
      const msg = messages[i];
      if (msg.role === 'user') {
        break;
      }
      if (msg.role !== 'assistant') {
        continue;
      }
      if (msg.isSummary) {
        continue;
      }
      const targetId = (msg.targetId ?? '').trim();
      if (!targetId) {
        continue;
      }
      map.set(targetId, msg.id);
    }

    return map;
  }

  private groupHasStreaming(userMessageId: string): boolean {
    const group = this.messageGroups.find((g) => g.user.id === userMessageId);
    if (!group) {
      return false;
    }
    return group.assistants.some((m) => m.status === 'streaming');
  }

  private runtimeConfig(): ChatRequest['config'] {
    return {
      openrouter: {
        apiKey: this.config.openrouter.apiKey.trim(),
        baseUrl: this.config.openrouter.baseUrl.trim(),
        models: this.config.openrouter.models
      },
      ollama: {
        baseUrl: this.config.ollama.baseUrl.trim(),
        models: this.config.ollama.models
      }
    };
  }

  private async refreshContextLimits(): Promise<void> {
    this.contextLoadError = '';
    if (this.selectedTargets.size === 0) {
      this.contextLimitsByTarget = new Map<string, ContextLimitItem>();
      return;
    }

    const targets = this.buildTargets();
    if (targets.length === 0) {
      this.contextLimitsByTarget = new Map<string, ContextLimitItem>();
      return;
    }

    this.isContextLoading = true;
    try {
      const limits = await this.chatService.getContextLimits(
        targets,
        this.runtimeConfig(),
        this.selectedChatId || undefined,
        this.prompt
      );
      const next = new Map<string, ContextLimitItem>();
      for (const item of limits) {
        next.set(item.targetId, item);
      }
      this.contextLimitsByTarget = next;
    } catch (err) {
      this.contextLoadError = (err as Error).message;
    } finally {
      this.isContextLoading = false;
    }
  }

  private handleEvent(event: StreamEvent): void {
    if (event.event === 'done') {
      this.isStreaming = false;
      this.isSummaryStream = false;
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
          if (existing.isSummary) {
            existing.inclusion = 'always';
            existing.scopeId = '';
          } else {
            existing.inclusion = 'model_only';
            existing.scopeId = event.targetId;
          }
          existing.status = 'streaming';
          existing.error = '';
          existing.content = '';
          this.selectedChat.messages = [...this.selectedChat.messages];
          this.liveAssistantIndexByTarget.set(event.targetId, replaceIdx);
          return;
        }
      }
      if (this.regeneratingUserReplaceByTarget.has(event.targetId)) {
        const messageId = this.regeneratingUserReplaceByTarget.get(event.targetId) ?? '';
        const replaceIdx = this.selectedChat.messages.findIndex((m) => m.id === messageId);
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
        isSummary: this.isSummaryStream,
        inclusion: this.isSummaryStream ? 'always' : 'model_only',
        scopeId: this.isSummaryStream ? '' : event.targetId,
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

  protected focusRenameInput(): void {}
}
