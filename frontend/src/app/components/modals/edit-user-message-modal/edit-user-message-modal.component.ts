import { CommonModule } from '@angular/common';
import { Component, EventEmitter, Input, Output } from '@angular/core';
import { FormsModule } from '@angular/forms';

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

  @Output() close = new EventEmitter<void>();
  @Output() apply = new EventEmitter<void>();
  @Output() contentChange = new EventEmitter<string>();
  @Output() modeChange = new EventEmitter<'inplace' | 'fork'>();
}
