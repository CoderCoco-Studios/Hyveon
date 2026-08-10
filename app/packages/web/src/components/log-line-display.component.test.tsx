import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { HighlightedLine } from './log-line-display.component.js';

describe('HighlightedLine', () => {
  it('should render plain text unchanged when there is no query and no ANSI codes', () => {
    render(<HighlightedLine text="Connection refused from 10.0.0.5" query="" />);
    expect(screen.getByText('Connection refused from 10.0.0.5')).toBeInTheDocument();
  });

  it('should render an SGR-colored run as styled text with no raw escape bytes visible', () => {
    render(<HighlightedLine text={'\x1b[1;36m****EXECUTING USERMOD****\x1b[0m'} query="" />);
    const el = screen.getByText('****EXECUTING USERMOD****');
    expect(el.className).toContain('text-[var(--color-cyan)]');
    expect(el.className).toContain('font-bold');
    expect(document.body.textContent).not.toContain('\x1b');
  });

  it('should discard a non-SGR CSI sequence and show none of its bytes', () => {
    render(<HighlightedLine text={'\x1b[2Kusermod: no changes'} query="" />);
    expect(screen.getByText('usermod: no changes')).toBeInTheDocument();
    expect(document.body.textContent).not.toContain('\x1b');
  });

  it('should highlight a search match inside plain text with <mark>', () => {
    const { container } = render(<HighlightedLine text="Connection refused from 10.0.0.5" query="refused" />);
    const marks = container.querySelectorAll('mark');
    expect(marks).toHaveLength(1);
    expect(marks[0]).toHaveTextContent('refused');
  });

  it('should highlight a search match inside an SGR-colored run, keeping the color on the rest', () => {
    const { container } = render(<HighlightedLine text={'\x1b[31merror: disk full\x1b[0m'} query="disk" />);
    const marks = container.querySelectorAll('mark');
    expect(marks).toHaveLength(1);
    expect(marks[0]).toHaveTextContent('disk');
    const coloredSpan = container.querySelector('.text-\\[var\\(--color-red\\)\\]');
    expect(coloredSpan).not.toBeNull();
    expect(coloredSpan).toHaveTextContent('error: disk full');
  });
});
