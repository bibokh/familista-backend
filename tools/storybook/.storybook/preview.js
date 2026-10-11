// The real production stylesheets, as raw text, in the same order public/index.html
// links them. Raw import means no rewriting: the CSS Storybook shows is the CSS
// production serves. (None of these files has an @import or a non-data url().)
import appCss from '../../../public/app.css?raw';
import systemCss from '../../../public/system/system.css?raw';
import dataVaultCss from '../../../public/data-vault/data-vault.css?raw';
import infraCss from '../../../public/infrastructure-city/infrastructure-city.css?raw';
import sourceCoreCss from '../../../public/source-core/source-core.css?raw';
import visionCss from '../../../public/familista-vision/familista-vision.css?raw';
import cyberCss from '../../../public/cybersecurity/cybersecurity.css?raw';
import algorithmsCss from '../../../public/algorithms/algorithms.css?raw';
import overridesCss from './storybook-overrides.css?raw';
// The Familista Design Core tokens, generated from tools/tokens/familista.tokens.json.
// Storybook only consumes them; the token source does not know Storybook exists.
// Loaded first — the order Stage 2b would link them in production — and, because
// the file declares only --fam-* custom properties, it cannot change any rule
// above (the Stage 1 stories are snapshot-checked against exactly that).
import tokensCss from '../../tokens/dist/familista-tokens.css?raw';
import foundationsCss from './foundations.css?raw';

const SHEETS = [
  ['familista-tokens.css (Design Core; not linked in production)', tokensCss],
  ['app.css', appCss], ['system.css', systemCss], ['data-vault.css', dataVaultCss],
  ['infrastructure-city.css', infraCss], ['source-core.css', sourceCoreCss],
  ['familista-vision.css', visionCss], ['cybersecurity.css', cyberCss],
  ['algorithms.css', algorithmsCss], ['storybook-overrides.css (Storybook only)', overridesCss],
  ['foundations.css (Storybook only; reads --fam-* tokens)', foundationsCss],
];
for (const [name, css] of SHEETS) {
  if (document.querySelector(`style[data-familista-css="${name}"]`)) continue;
  const el = document.createElement('style');
  el.setAttribute('data-familista-css', name);
  el.textContent = css;
  document.head.appendChild(el);
}

export const VIEWPORTS = {
  desktop: { name: 'Desktop 1440', styles: { width: '1440px', height: '900px' }, type: 'desktop' },
  laptop: { name: 'Laptop 1280', styles: { width: '1280px', height: '800px' }, type: 'desktop' },
  tablet: { name: 'Tablet 834', styles: { width: '834px', height: '1112px' }, type: 'tablet' },
  mobile: { name: 'Mobile 390', styles: { width: '390px', height: '844px' }, type: 'mobile' },
};

// Production applies bar widths after render, because its security policy forbids
// inline styles. This is the same line as public/app.js (guarded by a golden test).
function applyBarWidths(scope) {
  scope.querySelectorAll('[data-mc-width]').forEach((el) => {
    el.style.setProperty('width', el.getAttribute('data-mc-width'));
  });
}

// Stories return the primitive's HTML string, exactly as production builds it.
const stage = (story, context) => {
  const out = story();
  const host = document.createElement('div');
  const layout = context.parameters.layout;
  host.className = 'fam-sb-stage' + (layout === 'fullscreen' ? ' fam-sb-stage--full' : '');
  if (typeof out === 'string') host.innerHTML = out; else host.appendChild(out);
  applyBarWidths(host);
  return host;
};

// Direction is a toolbar switch. Production sets <html dir> the same way (i18n.js).
const direction = (story, context) => {
  const dir = context.globals.direction || 'ltr';
  document.documentElement.setAttribute('dir', dir);
  document.documentElement.setAttribute('lang', dir === 'rtl' ? 'ar' : 'en');
  return story();
};

// Theme is <html data-theme>, exactly as production's toggleTheme() sets it.
// Dark is production's default. "Light" shows production's own partial legacy
// light override; the Design Core's light and high-contrast layers are reserved.
const theme = (story, context) => {
  document.documentElement.setAttribute('data-theme', context.globals.theme || 'dark');
  return story();
};

// Workspace context for the Design Core tokens. Club is the default and adds
// nothing to the markup, so Stage 1 stories render byte-for-byte as before.
const workspace = (story, context) => {
  const host = story();
  const ctx = context.globals.context || 'club';
  if (host && host.setAttribute) {
    if (ctx === 'club') host.removeAttribute('data-fam-context');
    else host.setAttribute('data-fam-context', ctx);
  }
  return host;
};

export default {
  decorators: [stage, workspace, direction, theme], // first = innermost: stage builds the host, workspace marks it
  parameters: {
    layout: 'padded',
    backgrounds: { options: { familista: { name: 'Familista', value: '#09090B' } } },
    viewport: { options: VIEWPORTS },
    a11y: { test: 'todo' },
    controls: { expanded: true },
  },
  initialGlobals: { direction: 'ltr', theme: 'dark', context: 'club', backgrounds: { value: 'familista' } },
  globalTypes: {
    direction: {
      description: 'Text direction',
      toolbar: { title: 'Direction', icon: 'transfer', dynamicTitle: true,
        items: [{ value: 'ltr', title: 'Left-to-right' }, { value: 'rtl', title: 'Right-to-left (Arabic)' }] },
    },
    context: {
      description: 'Familista Design Core workspace context',
      toolbar: { title: 'Context', icon: 'globe', dynamicTitle: true,
        items: [{ value: 'club', title: 'Club Workspace (default)' }, { value: 'owner', title: 'Owner / Global' }] },
    },
    theme: {
      description: 'Theme (html[data-theme])',
      toolbar: { title: 'Theme', icon: 'contrast', dynamicTitle: true,
        items: [{ value: 'dark', title: 'Dark (production default)' },
          { value: 'light', title: 'Light — production legacy toggle only; Design Core layer reserved' },
          { value: 'high-contrast', title: 'High contrast — reserved, no tokens yet' }] },
    },
  },
};
