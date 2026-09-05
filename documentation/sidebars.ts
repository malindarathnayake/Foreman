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
      label: 'How it works',
      collapsed: false,
      items: [
        'how-it-works/protocols',
        'how-it-works/unit-life',
        'how-it-works/phase-gates',
        'enforcement/what-foreman-enforces',
        'how-it-works/ledger-files',
        'how-it-works/resuming',
      ],
    },
    {
      type: 'category',
      label: 'Reference',
      items: [
        'reference/tool-surface',
        'reference/host-compatibility',
        'reference/configuration',
        'reference/privacy-and-security',
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
