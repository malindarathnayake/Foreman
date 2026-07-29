import type { Config } from '@docusaurus/types';
import type * as Preset from '@docusaurus/preset-classic';
import { themes as prismThemes } from 'prism-react-renderer';

const config: Config = {
  title: 'Foreman',
  tagline: 'A spec-to-code harness for AI-assisted software development',
  favicon: 'img/favicon.ico',

  url: 'https://malindarathnayake.github.io',
  baseUrl: '/Foreman/',

  organizationName: 'malindarathnayake',
  projectName: 'Foreman',
  trailingSlash: false,

  onBrokenLinks: 'throw',
  onBrokenAnchors: 'throw',

  markdown: {
    hooks: {
      onBrokenMarkdownLinks: 'throw',
    },
  },

  i18n: {
    defaultLocale: 'en',
    locales: ['en'],
  },

  presets: [
    [
      'classic',
      {
        docs: {
          routeBasePath: '/',
          sidebarPath: './sidebars.ts',
          editUrl:
            'https://github.com/malindarathnayake/Foreman/edit/main/documentation/',
        },
        blog: false,
        theme: {
          customCss: './src/css/custom.css',
        },
      } satisfies Preset.Options,
    ],
  ],

  themeConfig: {
    image: 'img/social-card.jpg',
    colorMode: {
      respectPrefersColorScheme: true,
    },
    navbar: {
      title: 'Foreman',
      logo: {
        alt: 'Foreman',
        src: 'img/logo.png',
      },
      items: [
        {
          type: 'docSidebar',
          sidebarId: 'docsSidebar',
          position: 'left',
          label: 'Docs',
        },
        {
          to: '/getting-started/installation',
          position: 'left',
          label: 'Install',
        },
        {
          to: '/reference/tool-surface',
          position: 'left',
          label: 'Tool surface',
        },
        {
          href: 'https://github.com/malindarathnayake/Foreman',
          label: 'GitHub',
          position: 'right',
        },
      ],
    },
    footer: {
      style: 'dark',
      links: [
        {
          title: 'Get started',
          items: [
            { label: 'What Foreman is', to: '/' },
            { label: 'Install', to: '/getting-started/installation' },
            { label: 'Configure a host', to: '/getting-started/configure-mcp-host' },
            { label: 'Start a project', to: '/getting-started/start-a-project' },
          ],
        },
        {
          title: 'Understand it',
          items: [
            { label: 'Not another agent framework', to: '/concepts/not-another-agent-framework' },
            { label: 'The lifecycle', to: '/concepts/lifecycle' },
            { label: 'What Foreman enforces', to: '/enforcement/what-foreman-enforces' },
            { label: 'Advisor seats', to: '/execution/advisor-seats' },
          ],
        },
        {
          title: 'Project',
          items: [
            { label: 'GitHub', href: 'https://github.com/malindarathnayake/Foreman' },
            { label: 'Releases', href: 'https://github.com/malindarathnayake/Foreman/releases' },
            { label: 'Changelog', href: 'https://github.com/malindarathnayake/Foreman/blob/main/CHANGELOG.md' },
            { label: 'Security policy', href: 'https://github.com/malindarathnayake/Foreman/blob/main/SECURITY.md' },
          ],
        },
      ],
      copyright: `Apache-2.0 &copy; ${new Date().getFullYear()} Malinda Rathnayake`,
    },
    prism: {
      theme: prismThemes.github,
      darkTheme: prismThemes.dracula,
      additionalLanguages: ['bash', 'json', 'toml'],
    },
  } satisfies Preset.ThemeConfig,
};

export default config;
