import { ROUTES } from './routes.js';
export const page = () => `<form action="${ROUTES.account.cancel}" method="post"><button>Cancel plan</button></form>`;
