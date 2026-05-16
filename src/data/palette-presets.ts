// Familista — Super Admin White-label Control Panel
// File location: src/data/palette-presets.ts
//
// System palettes seeded on first boot (or by the seed script).
// Each preset is upserted by slug; admins cannot delete `isSystem` palettes.

export type PaletteTokens = {
  primary: string;
  secondary: string;
  accent: string;
  background: string;
  surface: string;
  text: string;
  mutedText: string;
  border: string;
  error: string;
  success: string;
  warning: string;
};

export type PaletteSeed = {
  slug: string;
  name: string;
  description: string;
  category: 'system' | 'league' | 'club' | 'custom';
  tokens: PaletteTokens;
};

export const SYSTEM_PALETTES: ReadonlyArray<PaletteSeed> = [
  {
    slug: 'familista-default',
    name: 'Familista Default',
    description: 'The standard Familista brand palette.',
    category: 'system',
    tokens: {
      primary: '#0f172a',
      secondary: '#64748b',
      accent: '#22c55e',
      background: '#ffffff',
      surface: '#f8fafc',
      text: '#0f172a',
      mutedText: '#64748b',
      border: '#e2e8f0',
      error: '#ef4444',
      success: '#22c55e',
      warning: '#f59e0b',
    },
  },
  {
    slug: 'familista-dark',
    name: 'Familista Dark',
    description: 'Dark mode of the Familista brand palette.',
    category: 'system',
    tokens: {
      primary: '#22c55e',
      secondary: '#94a3b8',
      accent: '#22c55e',
      background: '#0b1220',
      surface: '#0f172a',
      text: '#f8fafc',
      mutedText: '#94a3b8',
      border: '#1e293b',
      error: '#f87171',
      success: '#4ade80',
      warning: '#fbbf24',
    },
  },
  {
    slug: 'bundesliga-red',
    name: 'Bundesliga Red',
    description: 'Bold red palette inspired by classic Bundesliga branding.',
    category: 'league',
    tokens: {
      primary: '#d20515',
      secondary: '#1a1a1a',
      accent: '#ffd200',
      background: '#ffffff',
      surface: '#fafafa',
      text: '#111111',
      mutedText: '#555555',
      border: '#e5e5e5',
      error: '#b91c1c',
      success: '#15803d',
      warning: '#f59e0b',
    },
  },
  {
    slug: 'premier-blue',
    name: 'Premier Blue',
    description: 'Deep blue inspired by Premier League aesthetics.',
    category: 'league',
    tokens: {
      primary: '#37003c',
      secondary: '#04f5ff',
      accent: '#e90052',
      background: '#ffffff',
      surface: '#f5f3f7',
      text: '#1a1a1a',
      mutedText: '#5f5f5f',
      border: '#e6e3ec',
      error: '#e90052',
      success: '#00ff85',
      warning: '#f59e0b',
    },
  },
  {
    slug: 'la-liga-crimson',
    name: 'La Liga Crimson',
    description: 'Warm crimson and ivory palette.',
    category: 'league',
    tokens: {
      primary: '#ee2a4a',
      secondary: '#102e44',
      accent: '#ffce00',
      background: '#fffaf3',
      surface: '#fff4e1',
      text: '#102e44',
      mutedText: '#6b6356',
      border: '#f3e5c8',
      error: '#c0392b',
      success: '#27ae60',
      warning: '#f39c12',
    },
  },
  {
    slug: 'mls-cyan',
    name: 'MLS Cyan',
    description: 'High-energy modern cyan/black palette.',
    category: 'league',
    tokens: {
      primary: '#001226',
      secondary: '#00b4ff',
      accent: '#ff3c14',
      background: '#ffffff',
      surface: '#f3f6f9',
      text: '#001226',
      mutedText: '#4a5b6c',
      border: '#dce5ed',
      error: '#ff3c14',
      success: '#00d68f',
      warning: '#ffaa00',
    },
  },
  {
    slug: 'forest',
    name: 'Forest',
    description: 'Earthy greens for academies and youth clubs.',
    category: 'system',
    tokens: {
      primary: '#14532d',
      secondary: '#475569',
      accent: '#84cc16',
      background: '#fdfcfa',
      surface: '#f4f1ec',
      text: '#1a2e1d',
      mutedText: '#5e6f5e',
      border: '#dcd6cb',
      error: '#b91c1c',
      success: '#15803d',
      warning: '#d97706',
    },
  },
  {
    slug: 'ocean',
    name: 'Ocean',
    description: 'Cool blue spectrum.',
    category: 'system',
    tokens: {
      primary: '#0c4a6e',
      secondary: '#0ea5e9',
      accent: '#06b6d4',
      background: '#f0f9ff',
      surface: '#e0f2fe',
      text: '#0c4a6e',
      mutedText: '#475569',
      border: '#bae6fd',
      error: '#dc2626',
      success: '#0d9488',
      warning: '#ea580c',
    },
  },
  {
    slug: 'sunset',
    name: 'Sunset',
    description: 'Warm sunset gradient base.',
    category: 'system',
    tokens: {
      primary: '#7c2d12',
      secondary: '#b45309',
      accent: '#f97316',
      background: '#fffbeb',
      surface: '#fef3c7',
      text: '#431407',
      mutedText: '#78350f',
      border: '#fde68a',
      error: '#b91c1c',
      success: '#65a30d',
      warning: '#d97706',
    },
  },
  {
    slug: 'monochrome',
    name: 'Monochrome',
    description: 'Neutral palette for premium / minimalist branding.',
    category: 'system',
    tokens: {
      primary: '#111111',
      secondary: '#525252',
      accent: '#262626',
      background: '#ffffff',
      surface: '#fafafa',
      text: '#0a0a0a',
      mutedText: '#737373',
      border: '#e5e5e5',
      error: '#dc2626',
      success: '#16a34a',
      warning: '#f59e0b',
    },
  },
];

export function findPresetBySlug(slug: string): PaletteSeed | undefined {
  return SYSTEM_PALETTES.find((p) => p.slug === slug);
}
