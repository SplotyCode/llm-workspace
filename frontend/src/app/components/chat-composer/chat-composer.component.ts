import { CommonModule } from '@angular/common';
import { Component, EventEmitter, Input, Output } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ContextLimitItem } from '../../models/chat.models';
import { ContextIndicatorComponent } from '../context-indicator/context-indicator.component';

@Component({
  selector: 'app-chat-composer',
  standalone: true,
  imports: [CommonModule, FormsModule, ContextIndicatorComponent],
  templateUrl: './chat-composer.component.html'
})
export class ChatComposerComponent {
  @Input() prompt = '';
  @Input() isStreaming = false;
  @Input() error = '';
  @Input() selectedTargetsSize = 0;
  @Input() isContextLoading = false;
  @Input() minContextItem: ContextLimitItem | null = null;
  @Input() contextItems: ContextLimitItem[] = [];
  @Input() contextLoadError = '';

  @Output() promptChange = new EventEmitter<string>();
  @Output() promptChanged = new EventEmitter<void>();
  @Output() submit = new EventEmitter<void>();
  @Output() cancel = new EventEmitter<void>();

  onPromptInput(value: string): void {
    this.promptChange.emit(value);
    this.promptChanged.emit();
  }
}
