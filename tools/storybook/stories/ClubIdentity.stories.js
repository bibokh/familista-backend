import { lg, rtl, tablet, mobile } from './_support.js';

export default {
  title: 'Familista/clubIdentityHtml',
  parameters: { docs: { description: { component: 'Real `clubIdentityHtml(clubId, opts)`: crest and name as one thing, with an optional caller-supplied second line. The name is marked data-user-content and is never translated. Exported on window; public/app.js has no caller for it today.' } } },
  args: { clubId: 'riverside', sub: 'Familista League · 3rd', size: 'md', showLogo: true, showName: true },
  argTypes: {
    clubId: { control: 'select', options: ['riverside', 'northgate', 'nobody'] },
    size: { control: 'select', options: ['xs', 'sm', 'md', 'lg', 'xl'] },
  },
  render: (a) => lg.clubIdentityHtml(a.clubId, { sub: a.sub, size: a.size, showLogo: a.showLogo, showName: a.showName }),
};

export const CrestNameAndSub = {};
export const NoSubLine = { args: { sub: '' } };
export const WithoutCrest = { args: { clubId: 'northgate', sub: 'Away' } };
export const UnknownClubFallsBackToClub = { args: { clubId: 'nobody', sub: '' } };
export const LogoOnly = { args: { showName: false } };
export const NameOnly = { args: { showLogo: false } };
export const RTL = { ...CrestNameAndSub, ...rtl };
export const Tablet = { ...CrestNameAndSub, ...tablet };
export const Mobile = { ...CrestNameAndSub, ...mobile };
