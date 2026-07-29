import type { SidebarsConfig } from '@docusaurus/plugin-content-docs';

const sidebars: SidebarsConfig = {
  docsSidebar: [
    'intro',
    {
      type: 'category',
      label: 'Getting started',
      collapsed: false,
      items: [
        'getting-started/installation',
        'getting-started/configure-mcp-host',
        'getting-started/start-a-project',
      ],
    },
    {
      type: 'category',
      label: 'Concepts',
      collapsed: false,
      items: [
        'concepts/not-another-agent-framework',
        'concepts/coding-harness',
        'concepts/lifecycle',
        'concepts/protocols',
        'concepts/when-to-use-it',
      ],
    },
    {
      type: 'category',
      label: 'Enforcement',
      items: [
        'enforcement/what-foreman-enforces',
        'enforcement/engineering-ethos',
        'enforcement/state-and-recovery',
      ],
    },
    {
      type: 'category',
      label: 'Execution',
      items: ['execution/worker-backends', 'execution/advisor-seats'],
    },
    {
      type: 'category',
      label: 'Reference',
      items: [
        'reference/tool-surface',
        'reference/host-compatibility',
        'reference/architecture',
        'reference/privacy-and-security',
        'reference/mission-boundary',
      ],
    },
    {
      type: 'category',
      label: 'Contributing',
      items: ['contributing/development', 'contributing/upgrading'],
    },
  ],
};

export default sidebars;
