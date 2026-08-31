import { describe, it, expect } from 'vitest';
import { createRef } from 'react';
import { render, screen } from '@testing-library/react';
import { NativeSelect } from './native-select.component.js';

describe('NativeSelect', () => {
  it('should render a select with its options', () => {
    render(
      <NativeSelect aria-label="Region">
        <option value="us">US</option>
        <option value="eu">EU</option>
      </NativeSelect>,
    );
    const select = screen.getByRole('combobox', { name: 'Region' });
    expect(select).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'US' })).toBeInTheDocument();
  });

  it('should forward a ref to the underlying select element', () => {
    const ref = createRef<HTMLSelectElement>();
    render(
      <NativeSelect aria-label="Region" ref={ref}>
        <option value="us">US</option>
      </NativeSelect>,
    );
    expect(ref.current).toBeInstanceOf(HTMLSelectElement);
  });

  it('should merge a custom className with the shared input styling', () => {
    render(
      <NativeSelect aria-label="Region" className="custom-class">
        <option value="us">US</option>
      </NativeSelect>,
    );
    expect(screen.getByRole('combobox', { name: 'Region' })).toHaveClass('custom-class');
  });
});
