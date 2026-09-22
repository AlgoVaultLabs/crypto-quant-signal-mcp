import { postButton } from './html.js';
export function accountPage(active: boolean): string {
  return `<main><h1>Account</h1>${active ? postButton('/account/cancel', 'Cancel plan') : postButton('/account/resume', 'Resume plan')}</main>`;
}
