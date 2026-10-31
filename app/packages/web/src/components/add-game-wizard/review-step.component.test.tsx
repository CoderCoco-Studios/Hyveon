import { describe, it, expect } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { createEmptyWizardDraft, type WizardDraft } from './wizard-form.utils.js';
import { ReviewStep } from './review-step.component.js';

/** Builds a fully-populated draft covering every field, including the optional ones; override per test. */
function makeFullDraft(overrides: Partial<WizardDraft> = {}): WizardDraft {
  return {
    ...createEmptyWizardDraft(),
    name: 'minecraft',
    image: 'itzg/minecraft-server',
    connect_message: 'Connect at {hostname}',
    cpu: 1024,
    memory: 2048,
    ports: [{ container: 25565, protocol: 'tcp', visibility: 'public' }],
    volumes: [{ name: 'data', container_path: '/data' }],
    file_seeds: [{ path: '/data/server.properties', content: 'foo=bar', content_base64: '', mode: '' }],
    environment: [{ name: 'EULA', value: 'true' }],
    ...overrides,
  };
}

/** Builds a minimal draft for the Review step; override per test. */
function makeDraft(overrides: Partial<WizardDraft> = {}): WizardDraft {
  return {
    ...createEmptyWizardDraft(),
    name: 'minecraft',
    image: 'itzg/minecraft-server',
    cpu: 1024,
    memory: 2048,
    ...overrides,
  };
}

describe('ReviewStep — fully-populated draft', () => {
  it('should render every field of a fully-populated draft, including optional sections', () => {
    render(<ReviewStep draft={makeFullDraft()} />);

    expect(screen.getByText('minecraft')).toBeInTheDocument();
    expect(screen.getByText('itzg/minecraft-server')).toBeInTheDocument();
    expect(screen.getByText('Connect at {hostname}')).toBeInTheDocument();
    expect(screen.getByText('1024')).toBeInTheDocument();
    expect(screen.getByText('2048')).toBeInTheDocument();
    expect(screen.getByText('25565')).toBeInTheDocument();
    expect(screen.getByText('tcp')).toBeInTheDocument();
    expect(screen.getByText('data')).toBeInTheDocument();
    expect(screen.getByText('/data')).toBeInTheDocument();
    expect(screen.getByText('File seeds')).toBeInTheDocument();
    expect(screen.getByText('/data/server.properties')).toBeInTheDocument();
  });
});

describe('ReviewStep — empty optional sections', () => {
  it('should not render a Connect message row when connect_message is blank', () => {
    render(<ReviewStep draft={makeFullDraft({ connect_message: '' })} />);

    expect(screen.queryByText('Connect message')).not.toBeInTheDocument();
  });

  it('should not render a Connect message row when connect_message is only whitespace', () => {
    render(<ReviewStep draft={makeFullDraft({ connect_message: '   ' })} />);

    expect(screen.queryByText('Connect message')).not.toBeInTheDocument();
  });

  it('should not render the File seeds section when file_seeds is empty', () => {
    render(<ReviewStep draft={makeFullDraft({ file_seeds: [] })} />);

    expect(screen.queryByText('File seeds')).not.toBeInTheDocument();
  });

  it('should render environment variable rows when present', () => {
    render(
      <ReviewStep draft={makeDraft({ environment: [{ name: 'EULA', value: 'TRUE' }] })} />,
    );

    expect(screen.getByText('Environment variables')).toBeInTheDocument();
    expect(screen.getByText('EULA')).toBeInTheDocument();
    expect(screen.getByText('TRUE')).toBeInTheDocument();
  });

  it('should keep a long unbroken env value shrinkable and breakable inside its row', () => {
    const value = 'x'.repeat(64);
    render(<ReviewStep draft={makeDraft({ environment: [{ name: 'FOUNDRY_PASSWORD', value }] })} />);

    const valueEl = screen.getByText(value);
    expect(valueEl).toHaveClass('min-w-0', 'break-all');
    expect(screen.getByText('FOUNDRY_PASSWORD')).toHaveClass('shrink-0');
  });

  it('should omit the environment variables section when there are none', () => {
    render(<ReviewStep draft={makeDraft({ environment: [] })} />);

    expect(screen.queryByText('Environment variables')).not.toBeInTheDocument();
  });

  // @spec GAME-HOST-015
  it('should list the pinned hostname when set', () => {
    render(<ReviewStep draft={makeDraft({ pinnedHostname: 'foundry' })} />);

    expect(screen.getByText('Pinned hostname')).toBeInTheDocument();
    expect(screen.getByText('foundry')).toBeInTheDocument();
  });

  it('should omit the pinned hostname row when undefined', () => {
    render(<ReviewStep draft={makeDraft({ pinnedHostname: undefined })} />);

    expect(screen.queryByText('Pinned hostname')).not.toBeInTheDocument();
  });

  it('should show a "no ports configured" placeholder when ports is empty', () => {
    render(<ReviewStep draft={makeFullDraft({ ports: [] })} />);

    expect(screen.getByText('No ports configured.')).toBeInTheDocument();
  });

  it('should show "VPC-only" for an internal-visibility port', () => {
    render(
      <ReviewStep
        draft={makeFullDraft({ ports: [{ container: 25565, protocol: 'tcp', visibility: 'internal' }] })}
      />,
    );

    expect(screen.getByText('VPC-only')).toBeInTheDocument();
  });

  it('should show "Public" for a public-visibility port', () => {
    render(
      <ReviewStep
        draft={makeFullDraft({ ports: [{ container: 25565, protocol: 'tcp', visibility: 'public' }] })}
      />,
    );

    expect(screen.getByText('Public')).toBeInTheDocument();
  });

  it('should show a "no volumes configured" placeholder when volumes is empty', () => {
    render(<ReviewStep draft={makeFullDraft({ volumes: [] })} />);

    expect(screen.getByText('No volumes configured.')).toBeInTheDocument();
  });
});

describe('ReviewStep — HTTPS summary', () => {
  it('should show HTTPS as Enabled when the draft has https: true', () => {
    render(<ReviewStep draft={makeFullDraft({ https: true })} />);

    expect(screen.getByText('HTTPS')).toBeInTheDocument();
    expect(screen.getByText('Enabled')).toBeInTheDocument();
  });

  it('should show HTTPS as Disabled when the draft has https: false', () => {
    render(<ReviewStep draft={makeFullDraft({ https: false })} />);

    expect(screen.getByText('HTTPS')).toBeInTheDocument();
    expect(screen.getByText('Disabled')).toBeInTheDocument();
  });
});

describe('ReviewStep — outstanding validation issues', () => {
  it('should not render an issues alert when issues is empty or omitted', () => {
    render(<ReviewStep draft={makeFullDraft()} />);
    expect(screen.queryByText('Fix the following before submitting:')).not.toBeInTheDocument();
  });

  it('should list every outstanding issue so a disabled Submit has a visible reason', () => {
    render(
      <ReviewStep
        draft={makeFullDraft()}
        issues={[
          { path: 'ports[0]', message: 'The first port entry of an https = true game server must use protocol "tcp" (exact, lowercase).' },
          { path: 'memory', message: 'memory 100 MiB is not a valid Fargate pairing for cpu=1024.' },
        ]}
      />,
    );

    expect(screen.getByText('Fix the following before submitting:')).toBeInTheDocument();
    expect(
      screen.getByText('The first port entry of an https = true game server must use protocol "tcp" (exact, lowercase).'),
    ).toBeInTheDocument();
    expect(screen.getByText('memory 100 MiB is not a valid Fargate pairing for cpu=1024.')).toBeInTheDocument();
  });
});

describe('ReviewStep — submit errors', () => {
  it('should not render an alert when submitError is not provided', () => {
    render(<ReviewStep draft={makeFullDraft()} />);

    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('should display the provided submit error message', () => {
    const message = 'A game named "minecraft" already exists.';
    render(<ReviewStep draft={makeFullDraft()} submitError={message} />);

    expect(screen.getByRole('alert')).toHaveTextContent(message);
  });
});

describe('ReviewStep — https web port', () => {
  it('should show the web port apart from the additional ports when https is on', () => {
    render(
      <ReviewStep
        draft={makeDraft({
          https: true,
          webPort: 30000,
          ports: [{ container: 30001, protocol: 'udp', visibility: 'public' }],
        })}
      />,
    );

    expect(screen.getByText('Web port')).toBeInTheDocument();
    expect(screen.getByText('30000')).toBeInTheDocument();
    const extras = screen.getByRole('list', { name: 'Additional ports' });
    expect(within(extras).getByText('30001')).toBeInTheDocument();
    expect(within(extras).queryByText('30000')).not.toBeInTheDocument();
  });

  it('should say there are no additional ports for an https draft with an empty list', () => {
    render(<ReviewStep draft={makeDraft({ https: true, webPort: 30000, ports: [] })} />);

    expect(screen.getByText('No additional ports.')).toBeInTheDocument();
  });

  it('should not render a Web port row when https is off', () => {
    render(<ReviewStep draft={makeDraft({ https: false, webPort: 30000 })} />);

    expect(screen.queryByText('Web port')).not.toBeInTheDocument();
  });
});
