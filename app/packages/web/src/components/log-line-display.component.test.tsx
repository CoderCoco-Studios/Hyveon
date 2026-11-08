import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { HighlightedLine, LogLineList } from './log-line-display.component.js';

describe('HighlightedLine', () => {
  it('should render plain text unchanged when there is no query and no ANSI codes', () => {
    render(<HighlightedLine text="Connection refused from 10.0.0.5" query="" />);
    expect(screen.getByText('Connection refused from 10.0.0.5')).toBeInTheDocument();
  });

  // @spec APP-LOGS-RENDER-002
  it('should render an SGR-colored run as styled text with no raw escape bytes visible', () => {
    render(<HighlightedLine text={'\x1b[1;36m****EXECUTING USERMOD****\x1b[0m'} query="" />);
    const el = screen.getByText('****EXECUTING USERMOD****');
    expect(el.className).toContain('text-[var(--color-cyan)]');
    expect(el.className).toContain('font-bold');
    expect(document.body.textContent).not.toContain('\x1b');
  });

  // @spec APP-LOGS-RENDER-002
  it('should discard a non-SGR CSI sequence and show none of its bytes', () => {
    render(<HighlightedLine text={'\x1b[2Kusermod: no changes'} query="" />);
    expect(screen.getByText('usermod: no changes')).toBeInTheDocument();
    expect(document.body.textContent).not.toContain('\x1b');
  });

  // @spec APP-LOGS-RENDER-001
  it('should highlight a search match inside plain text with <mark>', () => {
    const { container } = render(<HighlightedLine text="Connection refused from 10.0.0.5" query="refused" />);
    const marks = container.querySelectorAll('mark');
    expect(marks).toHaveLength(1);
    expect(marks[0]).toHaveTextContent('refused');
  });

  // @spec APP-LOGS-RENDER-001
  it('should highlight a search match inside an SGR-colored run, keeping the color on the rest', () => {
    const { container } = render(<HighlightedLine text={'\x1b[31merror: disk full\x1b[0m'} query="disk" />);
    const marks = container.querySelectorAll('mark');
    expect(marks).toHaveLength(1);
    expect(marks[0]).toHaveTextContent('disk');
    const coloredSpan = container.querySelector('.text-\\[var\\(--color-red\\)\\]');
    expect(coloredSpan).not.toBeNull();
    expect(coloredSpan).toHaveTextContent('error: disk full');
  });

  // @spec APP-LOGS-RENDER-001
  it('should highlight a search match spanning a non-SGR sequence that split two identically-styled segments', () => {
    const { container } = render(<HighlightedLine text={'abc\x1b[2Kdef'} query="abcdef" />);
    const marks = container.querySelectorAll('mark');
    expect(marks).toHaveLength(1);
    expect(marks[0]).toHaveTextContent('abcdef');
  });

  // @spec APP-LOGS-RENDER-001
  it('should highlight a search match spanning two differently-styled SGR segments', () => {
    const { container } = render(<HighlightedLine text={'\x1b[31mERROR\x1b[0m: disk full'} query="ERROR: disk" />);
    const marks = container.querySelectorAll('mark');
    expect(marks).toHaveLength(2);
    expect(marks[0]).toHaveTextContent('ERROR');
    expect(marks[1]).toHaveTextContent(': disk');
  });
});

describe('LogLineList', () => {
  // @spec APP-LOGS-RENDER-003
  it('should keep the same DOM row for an existing line when older lines are prepended', () => {
    const lines = [{ id: 2, text: 'second' }, { id: 3, text: 'third' }];
    const { rerender } = render(<LogLineList lines={lines} search="" emptyMessage="none" />);
    const rowBefore = screen.getByText('third').closest('div');

    rerender(<LogLineList lines={[{ id: 1, text: 'first' }, ...lines]} search="" emptyMessage="none" />);

    expect(screen.getByText('third').closest('div')).toBe(rowBefore);
  });

  it('should render plain string lines for callers without row identity', () => {
    render(<LogLineList lines={['a', 'b']} search="" emptyMessage="none" />);
    expect(screen.getByText('a')).toBeInTheDocument();
    expect(screen.getByText('b')).toBeInTheDocument();
  });
});
