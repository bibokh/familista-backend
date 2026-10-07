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

const SHEETS = [
  ['app.css', appCss], ['system.css', systemCss], ['data-vault.css', dataVaultCss],
  ['infrastructure-city.css', infraCss], ['source-core.css', sourceCoreCss],
  ['familista-vision.css', visionCss], ['cybersecurity.css', cyberCss],
  ['algorithms.css', algorithmsCss], ['storybook-overrides.css (Storybook only)', overridesCss],
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

export default {
  decorators: [stage, direction],
  parameters: {
    layout: 'padded',
    backgrounds: { options: { familista: { name: 'Familista', value: '#09090B' } } },
    viewport: { options: VIEWPORTS },
    a11y: { test: 'todo' },
    controls: { expanded: true },
  },
  initialGlobals: { direction: 'ltr', backgrounds: { value: 'familista' } },
  globalTypes: {
    direction: {
      description: 'Text direction',
      toolbar: { title: 'Direction', icon: 'transfer', dynamicTitle: true,
        items: [{ value: 'ltr', title: 'Left-to-right' }, { value: 'rtl', title: 'Right-to-left (Arabic)' }] },
    },
  },
};
