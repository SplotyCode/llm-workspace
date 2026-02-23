import { CommonModule } from '@angular/common';
import { Component, EventEmitter, Input, Output } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { TextAttachment } from '../../../models/chat.models';

@Component({
  selector: 'app-edit-user-message-modal',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './edit-user-message-modal.component.html'
})
export class EditUserMessageModalComponent {
  @Input() show = false;
  @Input() content = '';
  @Input() mode: 'inplace' | 'fork' = 'inplace';
  @Input() attachments: TextAttachment[] = [];

  @Output() close = new EventEmitter<void>();
  @Output() apply = new EventEmitter<void>();
  @Output() contentChange = new EventEmitter<string>();
  @Output() modeChange = new EventEmitter<'inplace' | 'fork'>();
  @Output() filesSelected = new EventEmitter<FileList | null>();
  @Output() removeAttachment = new EventEmitter<number>();

  onFileChange(event: Event): void {
    const input = event.target as HTMLInputElement;
    this.filesSelected.emit(input.files);
    input.value = '';
  }
}
