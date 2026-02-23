import { CommonModule } from '@angular/common';
import { Component, EventEmitter, Input, Output } from '@angular/core';

export interface QuickTargetView {
  id: string;
  provider: string;
  model: string;
}

@Component({
  selector: 'app-quick-selector',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './quick-selector.component.html'
})
export class QuickSelectorComponent {
  @Input() targets: QuickTargetView[] = [];
  @Input() selectedTargetIds: Set<string> = new Set<string>();
  @Output() toggle = new EventEmitter<string>();

  providerIcon(provider: string): string {
    if (provider === 'openrouter') return 'OR';
    if (provider === 'ollama') return 'OL';
    return 'LLM';
  }

  isSelected(targetId: string): boolean {
    return this.selectedTargetIds.has(targetId);
  }
}
