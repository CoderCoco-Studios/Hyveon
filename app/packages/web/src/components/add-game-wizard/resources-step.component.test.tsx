import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import {
  getFargateCpuOptions,
  getFargateMemoryOptions,
  estimateFargateHourlyCost,
} from '@hyveon/shared/gameServerValidator';
import { ResourcesStep } from './resources-step.component.js';

describe('ResourcesStep', () => {
  it('should render the vCPU slider with one snap point per Fargate cpu tier', () => {
    render(<ResourcesStep cpu={null} memory={null} onChange={() => undefined} issues={[]} />);

    const cpuSlider = screen.getByLabelText('vCPU') as HTMLInputElement;
    expect(cpuSlider.min).toBe('0');
    expect(cpuSlider.max).toBe(String(getFargateCpuOptions().length - 1));
  });

  it('should only offer Fargate-valid memory pairings for the selected cpu (256 -> 512/1024/2048 MiB)', () => {
    render(<ResourcesStep cpu={256} memory={null} onChange={() => undefined} issues={[]} />);

    const memorySlider = screen.getByLabelText('Memory') as HTMLInputElement;
    expect(memorySlider.max).toBe('2'); // 3 values: indices 0, 1, 2
    expect(memorySlider.disabled).toBe(false);
  });

  it('should disable the memory slider when no cpu is selected', () => {
    render(<ResourcesStep cpu={null} memory={null} onChange={() => undefined} issues={[]} />);

    const memorySlider = screen.getByLabelText('Memory') as HTMLInputElement;
    expect(memorySlider.disabled).toBe(true);
  });

  it('should call onChange with the cpu unit at the dragged vCPU index', () => {
    const onChange = vi.fn();
    render(<ResourcesStep cpu={null} memory={null} onChange={onChange} issues={[]} />);

    // 256 is cpuOptions[0], the same index the slider already renders while
    // unset — a plain `change` event is a same-value no-op here (nothing
    // about the string value differs), so this exercises the onPointerUp
    // commit-on-interaction handler instead, the same way a real drag that
    // lands back on the rendered fallback position would.
    const cpuOptions = getFargateCpuOptions();
    const cpuSlider = screen.getByLabelText('vCPU');
    fireEvent.pointerUp(cpuSlider, { target: { value: String(cpuOptions.indexOf(256)) } });

    expect(onChange).toHaveBeenCalledWith({ cpu: 256, memory: null });
  });

  it('should reset memory to unset when a cpu change makes the current memory value invalid', () => {
    const onChange = vi.fn();
    // cpu=256/memory=512 is a valid pairing; cpu=512 does not accept 512 MiB.
    render(<ResourcesStep cpu={256} memory={512} onChange={onChange} issues={[]} />);

    const cpuOptions = getFargateCpuOptions();
    const cpuSlider = screen.getByLabelText('vCPU');
    fireEvent.change(cpuSlider, { target: { value: String(cpuOptions.indexOf(512)) } });

    expect(onChange).toHaveBeenCalledWith({ cpu: 512, memory: null });
  });

  it('should keep the current memory value when a cpu change still supports it', () => {
    const onChange = vi.fn();
    // cpu=512/memory=2048 is valid; cpu=1024 also accepts 2048.
    render(<ResourcesStep cpu={512} memory={2048} onChange={onChange} issues={[]} />);

    const cpuOptions = getFargateCpuOptions();
    const cpuSlider = screen.getByLabelText('vCPU');
    fireEvent.change(cpuSlider, { target: { value: String(cpuOptions.indexOf(1024)) } });

    expect(onChange).toHaveBeenCalledWith({ cpu: 1024, memory: 2048 });
  });

  it('should call onChange with the memory value at the dragged memory index', () => {
    const onChange = vi.fn();
    render(<ResourcesStep cpu={256} memory={null} onChange={onChange} issues={[]} />);

    const memoryOptions = getFargateMemoryOptions(256);
    const memorySlider = screen.getByLabelText('Memory');
    fireEvent.change(memorySlider, { target: { value: String(memoryOptions.indexOf(1024)) } });

    expect(onChange).toHaveBeenCalledWith({ cpu: 256, memory: 1024 });
  });

  it('should handle the 0.25 vCPU tier fixed 3-value memory list including the 0.5 GiB option', () => {
    render(<ResourcesStep cpu={256} memory={512} onChange={() => undefined} issues={[]} />);

    // "0.5 GiB" appears twice here: once as the memory slider's min-endpoint
    // label and once as the selected-value readout, since 512 MiB is both
    // the lowest option for the 256-cpu tier and the currently-selected one.
    expect(screen.getAllByText('0.5 GiB').length).toBeGreaterThan(0);
  });

  it('should handle the 16 vCPU tier 8 GiB memory step', () => {
    const onChange = vi.fn();
    render(<ResourcesStep cpu={16384} memory={32768} onChange={onChange} issues={[]} />);

    const memoryOptions = getFargateMemoryOptions(16384);
    expect(memoryOptions[1] - memoryOptions[0]).toBe(8192); // 8 GiB in MiB
    const memorySlider = screen.getByLabelText('Memory');
    fireEvent.change(memorySlider, { target: { value: '1' } });
    expect(onChange).toHaveBeenCalledWith({ cpu: 16384, memory: memoryOptions[1] });
  });

  it('should show a live hourly cost estimate matching estimateFargateHourlyCost', () => {
    render(<ResourcesStep cpu={1024} memory={2048} onChange={() => undefined} issues={[]} />);

    const expected = estimateFargateHourlyCost(1024, 2048);
    expect(screen.getByText(`$${expected.toFixed(4)}/hr while running`)).toBeInTheDocument();
  });

  it('should prompt for a selection instead of showing a cost when cpu or memory is unset', () => {
    render(<ResourcesStep cpu={null} memory={null} onChange={() => undefined} issues={[]} />);

    expect(screen.getByText('Select vCPU and memory to see cost')).toBeInTheDocument();
  });

  it('should surface a cpu validation issue beneath the vCPU slider', () => {
    render(
      <ResourcesStep
        cpu={100}
        memory={512}
        onChange={() => undefined}
        issues={[{ path: 'cpu', message: 'cpu must be one of the supported Fargate CPU units.' }]}
      />,
    );

    expect(screen.getByText('cpu must be one of the supported Fargate CPU units.')).toBeInTheDocument();
  });

  it('should surface a memory validation issue beneath the memory slider', () => {
    render(
      <ResourcesStep
        cpu={256}
        memory={1536}
        onChange={() => undefined}
        issues={[{ path: 'memory', message: 'memory 1536 MiB is not a valid Fargate pairing for cpu=256.' }]}
      />,
    );

    expect(
      screen.getByText('memory 1536 MiB is not a valid Fargate pairing for cpu=256.'),
    ).toBeInTheDocument();
  });
});
