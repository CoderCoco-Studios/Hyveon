import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { GameStatusBadges } from './game-status-badges.component.js';

describe('GameStatusBadges', () => {
  it('should render an "In sync" success chip when the game is declared and deployed', () => {
    render(<GameStatusBadges declared deployed />);

    const chip = screen.getByText('In sync');
    expect(chip).toBeInTheDocument();
    expect(chip).toHaveClass('bg-[var(--color-green)]');
  });

  it('should render a "Pending deploy" warning chip when the game is declared but not deployed', () => {
    render(<GameStatusBadges declared deployed={false} />);

    const chip = screen.getByText('Pending deploy');
    expect(chip).toBeInTheDocument();
    expect(chip).toHaveClass('bg-[var(--color-amber)]');
  });

  it('should render an "Undeclared" destructive chip when the game is deployed but not declared', () => {
    render(<GameStatusBadges declared={false} deployed />);

    const chip = screen.getByText('Undeclared');
    expect(chip).toBeInTheDocument();
    expect(chip).toHaveClass('bg-[var(--color-red)]');
  });

  it('should render a "Config drift" warning chip when declared and deployed but the config has drifted', () => {
    render(<GameStatusBadges declared deployed drift={{ kind: 'config_drift', changedFields: ['image'] }} />);

    const chip = screen.getByText('Config drift');
    expect(chip).toBeInTheDocument();
    expect(chip).toHaveClass('bg-[var(--color-amber)]');
  });

  it('should show the changed fields as a tooltip on the "Config drift" chip', () => {
    render(<GameStatusBadges declared deployed drift={{ kind: 'config_drift', changedFields: ['image', 'cpu'] }} />);

    expect(screen.getByText('Config drift')).toHaveAttribute('title', 'image, cpu');
  });

  it('should still render "In sync" when declared and deployed with a pending_create/pending_delete drift kind', () => {
    render(<GameStatusBadges declared deployed drift={{ kind: 'pending_create' }} />);

    const chip = screen.getByText('In sync');
    expect(chip).toBeInTheDocument();
    expect(chip).toHaveClass('bg-[var(--color-green)]');
  });
});
