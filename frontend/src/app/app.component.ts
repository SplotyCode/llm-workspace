import { CommonModule } from '@angular/common';
import { Component, ElementRef, QueryList, ViewChildren, ViewEncapsulation } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { AppWorkspace } from './app.workspace';
import { ChatComposerComponent } from './components/chat-composer/chat-composer.component';
import { ContextIndicatorComponent } from './components/context-indicator/context-indicator.component';
import { MessageCardComponent } from './components/message-card/message-card.component';
import { QuickSelectorComponent } from './components/quick-selector/quick-selector.component';
import { EditUserMessageModalComponent } from './components/modals/edit-user-message-modal/edit-user-message-modal.component';
import { FolderSettingsModalComponent } from './components/modals/folder-settings-modal/folder-settings-modal.component';
import { LlmSettingsModalComponent } from './components/modals/llm-settings-modal/llm-settings-modal.component';
import { ChatService } from './services/chat.service';

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [
    CommonModule,
    FormsModule,
    QuickSelectorComponent,
    MessageCardComponent,
    ContextIndicatorComponent,
    ChatComposerComponent,
    LlmSettingsModalComponent,
    EditUserMessageModalComponent,
    FolderSettingsModalComponent
  ],
  templateUrl: './app.component.html',
  styleUrl: './app.component.css',
  encapsulation: ViewEncapsulation.None
})
export class AppComponent extends AppWorkspace {
  @ViewChildren('chatRenameInput') private chatRenameInputs!: QueryList<ElementRef<HTMLInputElement>>;

  constructor(chatService: ChatService) {
    super(chatService);
  }

  protected override focusRenameInput(): void {
    const input = this.chatRenameInputs?.first?.nativeElement;
    if (!input) return;
    input.focus();
    input.select();
  }
}
