import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { familistaLg } from './lg-plugin.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..', '..', '..');

export default {
  framework: { name: '@storybook/html-vite', options: {} },
  stories: ['../stories/**/*.stories.js'],
  addons: ['@storybook/addon-a11y'],
  core: { disableTelemetry: true },
  viteFinal(config) {
    config.plugins = [...(config.plugins || []), familistaLg()];
    // The real CSS and app.js live outside this folder; allow reading (never writing) them.
    config.server = config.server || {};
    config.server.fs = { ...(config.server.fs || {}), allow: [REPO_ROOT] };
    return config;
  },
};
