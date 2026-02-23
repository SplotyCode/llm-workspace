import { CommonModule } from '@angular/common';
import { Component, EventEmitter, Input, Output } from '@angular/core';
import { FormsModule } from '@angular/forms';

@Component({
  selector: 'app-folder-settings-modal',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './folder-settings-modal.component.html'
})
export class FolderSettingsModalComponent {
  @Input() show = false;
  @Input() name = '';
  @Input() prompt = '';
  @Input() temperature = '';

  @Output() close = new EventEmitter<void>();
  @Output() save = new EventEmitter<void>();
  @Output() nameChange = new EventEmitter<string>();
  @Output() promptChange = new EventEmitter<string>();
  @Output() temperatureChange = new EventEmitter<string>();
}
