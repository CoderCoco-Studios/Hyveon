import { Link } from 'react-router-dom';
import { cn } from '../lib/utils.utils.js';
import {
  LayoutDashboard,
  ScrollText,
  DollarSign,
  MessageSquare,
  Settings,
  Gamepad2,
  History,
  Cloud,
} from 'lucide-react';

interface NavItem {
  to: string;
  icon: typeof LayoutDashboard;
  label: string;
}

const monitoringItems: NavItem[] = [
  { to: '/', icon: LayoutDashboard, label: 'Dashboard' },
  { to: '/costs', icon: DollarSign, label: 'Costs' },
];

/**
 * A sidebar nav group — a non-interactive heading with a fixed, always-visible
 * set of child links. Unlike top-level {@link NavItem}s, a group has no `to`
 * of its own and never collapses; every child is rendered.
 */
interface NavGroup {
  label: string;
  icon: typeof ScrollText;
  children: NavItem[];
}

/**
 * The nested `Logs` sidebar entry — replaces the old flat `/logs` link with a
 * `Game Logs` (`/logs`) and `Infra Logs` (`/logs/infrastructure`) child pair,
 * both always visible under the `Monitoring` section. The child labels are
 * `Game Logs`/`Infra Logs` rather than plain `Games`/`Infrastructure` so they
 * don't collide in accessible name with the top-level Configuration links
 * `Games` (`/games`) and `Infrastructure` (`/iac`).
 */
const logsGroup: NavGroup = {
  label: 'Logs',
  icon: ScrollText,
  children: [
    { to: '/logs', icon: ScrollText, label: 'Game Logs' },
    { to: '/logs/infrastructure', icon: ScrollText, label: 'Infra Logs' },
  ],
};

const configItems: NavItem[] = [
  { to: '/games', icon: Gamepad2, label: 'Games' },
  { to: '/discord', icon: MessageSquare, label: 'Discord' },
  { to: '/iac', icon: Cloud, label: 'Infrastructure' },
  { to: '/audit', icon: History, label: 'Audit' },
  { to: '/settings', icon: Settings, label: 'Settings' },
];

/**
 * Shared nav sections used by both the desktop sidebar and the mobile drawer.
 * Accepts an optional `onNavigate` callback that fires when a nav link is clicked,
 * allowing the mobile drawer to close itself on navigation.
 *
 * `prefix` makes the section heading ids unique so that both the desktop sidebar
 * and the mobile drawer can coexist in the DOM without duplicate ids (an HTML
 * validity violation that also breaks `aria-labelledby`).
 */
export function NavSections({
  currentPath,
  onNavigate,
  prefix,
}: {
  currentPath: string;
  onNavigate?: () => void;
  prefix: string;
}) {
  return (
    <nav aria-label="Main navigation" className="flex-1 overflow-y-auto px-3 py-4 space-y-6">
      {/* Monitoring */}
      <div>
        <p id={`${prefix}-nav-monitoring`} className="px-3 mb-2 text-xs font-semibold text-muted-foreground uppercase tracking-wider">
          Monitoring
        </p>
        <ul aria-labelledby={`${prefix}-nav-monitoring`} className="space-y-1 list-none">
          <li key="dashboard">
            <NavLink
              item={monitoringItems[0]}
              active={currentPath === monitoringItems[0].to || currentPath.startsWith(`${monitoringItems[0].to}/`)}
              onNavigate={onNavigate}
            />
          </li>
          <li key="logs-group">
            <p className="px-3 pt-1 pb-1 text-sm font-medium text-muted-foreground flex items-center gap-3">
              <logsGroup.icon className="w-4 h-4" aria-hidden="true" />
              {logsGroup.label}
            </p>
            <ul className="ml-4 space-y-1 list-none border-l border-border pl-2">
              {logsGroup.children.map((item) => (
                <li key={item.to}>
                  <NavLink item={item} active={currentPath === item.to} onNavigate={onNavigate} />
                </li>
              ))}
            </ul>
          </li>
          <li key="costs">
            <NavLink
              item={monitoringItems[1]}
              active={currentPath === monitoringItems[1].to || currentPath.startsWith(`${monitoringItems[1].to}/`)}
              onNavigate={onNavigate}
            />
          </li>
        </ul>
      </div>

      {/* Configuration */}
      <div>
        <p id={`${prefix}-nav-configuration`} className="px-3 mb-2 text-xs font-semibold text-muted-foreground uppercase tracking-wider">
          Configuration
        </p>
        <ul aria-labelledby={`${prefix}-nav-configuration`} className="space-y-1 list-none">
          {configItems.map((item) => (
            <li key={item.to + item.label}>
              <NavLink item={item} active={currentPath === item.to || currentPath.startsWith(`${item.to}/`)} onNavigate={onNavigate} />
            </li>
          ))}
        </ul>
      </div>
    </nav>
  );
}

function NavLink({
  item,
  active,
  onNavigate,
}: {
  item: NavItem;
  active: boolean;
  onNavigate?: () => void;
}) {
  const Icon = item.icon;
  const className = cn(
    'relative flex items-center gap-3 px-3 py-2 rounded-md text-sm font-medium transition-colors',
    active && 'bg-gradient-to-r from-purple-500/10 to-transparent text-purple-400 before:absolute before:left-0 before:top-0 before:bottom-0 before:w-0.5 before:bg-purple-500 before:rounded-full',
    !active && 'text-muted-foreground hover:text-foreground hover:bg-accent',
  );
  return (
    <Link
      to={item.to}
      className={className}
      aria-current={active ? 'page' : undefined}
      onClick={onNavigate}
    >
      <Icon className="w-4 h-4" aria-hidden="true" />
      {item.label}
    </Link>
  );
}

export type { NavItem, NavGroup };
