import { CommonModule } from '@angular/common';
import { Component, Input } from '@angular/core';
import { ContextLimitItem } from '../../models/chat.models';

@Component({
  selector: 'app-context-indicator',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './context-indicator.component.html'
})
export class ContextIndicatorComponent {
  @Input() isLoading = false;
  @Input() minItem: ContextLimitItem | null = null;
  @Input() items: ContextLimitItem[] = [];
  @Input() error = '';
}
