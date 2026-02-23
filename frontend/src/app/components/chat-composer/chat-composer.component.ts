import { CommonModule } from '@angular/common';
import { Component, EventEmitter, Input, Output } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ContextLimitItem, TextAttachment } from '../../models/chat.models';
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
  @Input() attachments: TextAttachment[] = [];

  @Output() promptChange = new EventEmitter<string>();
  @Output() promptChanged = new EventEmitter<void>();
  @Output() submit = new EventEmitter<void>();
  @Output() cancel = new EventEmitter<void>();
  @Output() filesSelected = new EventEmitter<FileList | null>();
  @Output() removeAttachment = new EventEmitter<number>();

  onPromptInput(value: string): void {
    this.promptChange.emit(value);
    this.promptChanged.emit();
  }

  onFileChange(event: Event): void {
    const input = event.target as HTMLInputElement;
    this.filesSelected.emit(input.files);
    input.value = '';
  }
}
