import { CommonModule } from '@angular/common';
import { Component, EventEmitter, Input, Output } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ProviderRuntimeConfig } from '../../../models/chat.models';

@Component({
  selector: 'app-llm-settings-modal',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './llm-settings-modal.component.html'
})
export class LlmSettingsModalComponent {
  @Input() show = false;
  @Input({ required: true }) config!: ProviderRuntimeConfig;
  @Input() openRouterModelsInput = '';
  @Input() ollamaModelsInput = '';

  @Output() close = new EventEmitter<void>();
  @Output() save = new EventEmitter<void>();
  @Output() openRouterModelsInputChange = new EventEmitter<string>();
  @Output() ollamaModelsInputChange = new EventEmitter<string>();
}
