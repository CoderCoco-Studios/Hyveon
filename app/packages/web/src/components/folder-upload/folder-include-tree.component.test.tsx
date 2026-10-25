import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { FolderIncludeTree } from './folder-include-tree.component.js';
import { makeScan } from './folder-upload.test-utils.js';

const TREE = makeScan().tree;

describe('FolderIncludeTree', () => {
  it('should show every top-level entry checked with its size when all are included', () => {
    render(<FolderIncludeTree tree={TREE} include={['Config', 'Data']} onChange={vi.fn()} />);
    expect(screen.getByRole('checkbox', { name: 'Include Config' })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: 'Include Data' })).toBeChecked();
    expect(screen.getByText('30 B')).toBeInTheDocument();
    expect(screen.getByText('1000 B')).toBeInTheDocument();
  });

  it('should show a parent as mixed when only some children are included', () => {
    render(<FolderIncludeTree tree={TREE} include={['Config/a.json']} onChange={vi.fn()} />);
    const config = screen.getByRole('checkbox', { name: 'Include Config' }) as HTMLInputElement;
    expect(config).toHaveAttribute('aria-checked', 'mixed');
    expect(config.indeterminate).toBe(true);
    expect(screen.getByRole('checkbox', { name: 'Include Data' })).not.toBeChecked();
  });

  it('should clear all descendants when a checked parent is toggled', async () => {
    const onChange = vi.fn();
    render(<FolderIncludeTree tree={TREE} include={['Config', 'Data']} onChange={onChange} />);
    await userEvent.click(screen.getByRole('checkbox', { name: 'Include Config' }));
    expect(onChange).toHaveBeenCalledWith(['Data']);
  });

  it('should include all descendants when a mixed parent is toggled', async () => {
    const onChange = vi.fn();
    render(<FolderIncludeTree tree={TREE} include={['Config/a.json']} onChange={onChange} />);
    await userEvent.click(screen.getByRole('checkbox', { name: 'Include Config' }));
    expect(onChange).toHaveBeenCalledWith(['Config']);
  });

  it('should reveal children on expand and toggle a single child', async () => {
    const onChange = vi.fn();
    render(<FolderIncludeTree tree={TREE} include={['Config', 'Data']} onChange={onChange} />);
    expect(screen.queryByRole('checkbox', { name: 'Include Config/a.json' })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Expand Config' }));
    await userEvent.click(screen.getByRole('checkbox', { name: 'Include Config/a.json' }));
    expect(onChange).toHaveBeenCalledWith(['Config/b.json', 'Data']);
  });

  it('should disable every checkbox when disabled', () => {
    render(<FolderIncludeTree tree={TREE} include={[]} onChange={vi.fn()} disabled />);
    expect(screen.getByRole('checkbox', { name: 'Include Config' })).toBeDisabled();
  });
});
