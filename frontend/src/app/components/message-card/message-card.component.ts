import { CommonModule } from '@angular/common';
import { Component, EventEmitter, Input, Output } from '@angular/core';
import { Message } from '../../models/chat.models';

@Component({
  selector: 'app-message-card',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './message-card.component.html'
})
export class MessageCardComponent {
  @Input({ required: true }) message!: Message;
  @Input() roleLabel: 'user' | 'assistant' = 'assistant';
  @Input() showProvider = false;
  @Input() showSummaryBadge = false;
  @Input() showEditAction = false;
  @Input() canMoveHistory = false;
  @Input() historyPosition = '1/1';
  @Input() historyAtStart = true;
  @Input() historyAtEnd = true;
  @Input() inclusionMenuOpen = false;
  @Input() messageMenuOpen = false;
  @Input() inclusionValue: 'dont_include' | 'model_only' | 'always' = 'always';
  @Input() inclusionDisplayLabel = 'always include';
  @Input() inclusionOptions: Array<{ value: 'dont_include' | 'model_only' | 'always'; label: string }> = [];
  @Input() inclusionOptionTitle: (value: 'dont_include' | 'model_only' | 'always') => string = () => '';

  @Output() moveHistory = new EventEmitter<-1 | 1>();
  @Output() toggleInclusion = new EventEmitter<MouseEvent>();
  @Output() selectInclusion = new EventEmitter<'dont_include' | 'model_only' | 'always'>();
  @Output() toggleMenu = new EventEmitter<MouseEvent>();
  @Output() regenerate = new EventEmitter<void>();
  @Output() fork = new EventEmitter<void>();
  @Output() edit = new EventEmitter<void>();
}
