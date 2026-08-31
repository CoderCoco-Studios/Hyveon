import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { FormField } from './form-field.component.js';

describe('FormField', () => {
  it('should render the label and the render-prop children', () => {
    render(
      <FormField id="name" label="Name">
        {(fieldProps) => <input {...fieldProps} />}
      </FormField>,
    );
    expect(screen.getByText('Name')).toBeInTheDocument();
    expect(screen.getByRole('textbox')).toBeInTheDocument();
  });

  it('should wire aria-describedby to the error id when errors are present', () => {
    render(
      <FormField id="name" label="Name" errors="Name is required">
        {(fieldProps) => <input {...fieldProps} />}
      </FormField>,
    );
    const input = screen.getByRole('textbox');
    expect(input).toHaveAttribute('aria-describedby', 'name-error');
    expect(input).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByRole('alert')).toHaveAttribute('id', 'name-error');
    expect(screen.getByRole('alert')).toHaveTextContent('Name is required');
  });

  it('should omit aria-describedby and aria-invalid when there are no errors', () => {
    render(
      <FormField id="name" label="Name">
        {(fieldProps) => <input {...fieldProps} />}
      </FormField>,
    );
    const input = screen.getByRole('textbox');
    expect(input).not.toHaveAttribute('aria-describedby');
    expect(input).not.toHaveAttribute('aria-invalid');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('should render every message when errors is a non-empty array', () => {
    render(
      <FormField id="name" label="Name" errors={['Too short', 'Must be unique']}>
        {(fieldProps) => <input {...fieldProps} />}
      </FormField>,
    );
    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent('Too short');
    expect(alert).toHaveTextContent('Must be unique');
  });

  it('should not render an alert when errors is an empty array', () => {
    render(
      <FormField id="name" label="Name" errors={[]}>
        {(fieldProps) => <input {...fieldProps} />}
      </FormField>,
    );
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('should render the hint when provided', () => {
    render(
      <FormField id="name" label="Name" hint="Visible to players">
        {(fieldProps) => <input {...fieldProps} />}
      </FormField>,
    );
    expect(screen.getByText('Visible to players')).toBeInTheDocument();
  });
});
