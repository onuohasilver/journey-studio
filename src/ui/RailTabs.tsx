import {useStudio, type Rail} from '../state/store';

/**
 * The panels, as a strip down the side of the rail.
 *
 * They were eight buttons in the top bar, which is the wrong place for them
 * twice over: they are all the same kind of thing — a panel on the right — and
 * they compete for attention with the two controls that act on the whole app,
 * Import and Run. Attaching them to the rail they open puts the choice next to
 * its result, and leaves the top bar with only what belongs there.
 *
 * Grouped rather than listed: what you are building, what you are running it
 * against, and what came back. Eight undifferentiated icons is a lookup; three
 * groups of two or three is a glance.
 */

type Icon = (props: {className?: string}) => JSX.Element;

const stroke = {
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.6,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
};

const StepIcon: Icon = () => (
  <svg viewBox="0 0 20 20" width="17" height="17" {...stroke}>
    <rect x="2.5" y="6" width="6" height="8" rx="2" />
    <rect x="11.5" y="6" width="6" height="8" rx="2" />
    <path d="M8.5 10h3" />
  </svg>
);

const AiIcon: Icon = () => (
  <svg viewBox="0 0 20 20" width="17" height="17" {...stroke}>
    <path d="M10 2.6v14.8M2.6 10h14.8M5 5l10 10M15 5L5 15" />
  </svg>
);

const ExplainIcon: Icon = () => (
  <svg viewBox="0 0 20 20" width="17" height="17" {...stroke}>
    <path d="M4 4.5h12M4 8h12M4 11.5h8M4 15h5" />
  </svg>
);

const CasesIcon: Icon = () => (
  <svg viewBox="0 0 20 20" width="17" height="17" {...stroke}>
    <rect x="2.5" y="3.5" width="15" height="13" rx="2" />
    <path d="M2.5 7.5h15M7.5 7.5v9M12.5 7.5v9" />
  </svg>
);

const JourneysIcon: Icon = () => (
  <svg viewBox="0 0 20 20" width="17" height="17" {...stroke}>
    <path d="M5 2.5h10a1 1 0 0 1 1 1v14l-6-3.5-6 3.5v-14a1 1 0 0 1 1-1Z" />
  </svg>
);

const InboxIcon: Icon = () => (
  <svg viewBox="0 0 20 20" width="17" height="17" {...stroke}>
    <path d="M2.5 12h4l1.2 2h4.6l1.2-2h4" />
    <path d="M4.4 4h11.2l1.9 8v4a1 1 0 0 1-1 1H3.5a1 1 0 0 1-1-1v-4Z" />
  </svg>
);

const ReportIcon: Icon = () => (
  <svg viewBox="0 0 20 20" width="17" height="17" {...stroke}>
    <path d="M4 16V9M8 16V4M12 16v-5M16 16v-9" />
  </svg>
);

const FilesIcon: Icon = () => (
  <svg viewBox="0 0 20 20" width="17" height="17" {...stroke}>
    <rect x="2.5" y="3.5" width="15" height="13" rx="2" />
    <circle cx="7" cy="7.5" r="1.4" />
    <path d="M2.5 13l4-3.5 3.5 3 3-2.5 4 3.5" />
  </svg>
);

const DocsIcon: Icon = () => (
  <svg viewBox="0 0 20 20" width="17" height="17" {...stroke}>
    <path d="M3.5 4.5A1.5 1.5 0 0 1 5 3h4v14H5a1.5 1.5 0 0 1-1.5-1.5Z" />
    <path d="M16.5 4.5A1.5 1.5 0 0 0 15 3h-4v14h4a1.5 1.5 0 0 0 1.5-1.5Z" />
  </svg>
);

interface Tab {
  rail: Rail;
  label: string;
  icon: Icon;
  title: string;
}

/** Three groups: what you are building, what you run it against, what came back. */
const GROUPS: Tab[][] = [
  [
    {rail: 'inspector', label: 'Step', icon: StepIcon, title: 'The selected step'},
    {rail: 'ai', label: 'AI', icon: AiIcon, title: 'Build or change the journey by describing it'},
    {rail: 'explain', label: 'Explain', icon: ExplainIcon, title: 'What this journey does, in plain English'},
  ],
  [
    {rail: 'data', label: 'Cases', icon: CasesIcon, title: 'Rows of inputs to run the journey against'},
    {rail: 'saved', label: 'Journeys', icon: JourneysIcon, title: 'Journeys saved to disk'},
    {rail: 'gallery', label: 'Files', icon: FilesIcon, title: 'Images and documents a step can upload'},
    {rail: 'packs', label: 'Docs', icon: DocsIcon, title: 'Imported documents and the nodes they gave'},
  ],
  [
    {rail: 'inbox', label: 'Inbox', icon: InboxIcon, title: 'Webhooks the studio has received'},
    {rail: 'report', label: 'Report', icon: ReportIcon, title: 'The QA report for the last run'},
  ],
];

export function RailTabs() {
  const rail = useStudio((s) => s.rail);
  const setRail = useStudio((s) => s.setRail);
  const hooks = useStudio((s) => s.hooks);
  const report = useStudio((s) => s.report);
  const running = useStudio((s) => s.running);

  // A count only where it means something has arrived for you. A badge on every
  // tab is a badge on none of them.
  const badgeFor = (tab: Tab): string | undefined => {
    if (tab.rail === 'inbox' && hooks.length) return String(hooks.length);
    if (tab.rail === 'report' && report && !running) return report.status === 'passed' ? '✓' : '!';
    return undefined;
  };

  return (
    <nav className="railtabs" aria-label="Panels">
      {GROUPS.map((group, i) => (
        <div className="railtab-group" key={i}>
          {group.map((tab) => {
            const badge = badgeFor(tab);
            const active = rail === tab.rail;
            return (
              <button
                key={tab.rail}
                className="railtab"
                aria-pressed={active}
                aria-label={tab.title}
                title={tab.title}
                onClick={() => setRail(tab.rail)}
              >
                <tab.icon />
                <span>{tab.label}</span>
                {badge && (
                  <i className={`railtab-badge ${badge === '!' ? 'bad' : badge === '✓' ? 'ok' : ''}`}>{badge}</i>
                )}
              </button>
            );
          })}
        </div>
      ))}
    </nav>
  );
}
