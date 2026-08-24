import { describe, it, expect } from 'vitest';
import { createRef } from 'react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Textarea } from './textarea.component.js';

describe('Textarea', () => {
  it('should render a textarea and accept typed input', async () => {
    render(<Textarea aria-label="Notes" />);
    const textarea = screen.getByRole('textbox', { name: 'Notes' });
    await userEvent.type(textarea, 'hello');
    expect(textarea).toHaveValue('hello');
  });

  it('should forward a ref to the underlying textarea element', () => {
    const ref = createRef<HTMLTextAreaElement>();
    render(<Textarea aria-label="Notes" ref={ref} />);
    expect(ref.current).toBeInstanceOf(HTMLTextAreaElement);
  });

  it('should merge a custom className with the shared input styling', () => {
    render(<Textarea aria-label="Notes" className="custom-class" />);
    expect(screen.getByRole('textbox', { name: 'Notes' })).toHaveClass('custom-class');
  });
});
