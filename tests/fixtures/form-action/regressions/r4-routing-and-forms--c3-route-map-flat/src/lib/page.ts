import { ROUTES } from './routes.js';
export const page = () => `<form action="${ROUTES.contact}" method="post"><textarea name="msg"></textarea><button>Send</button></form>`;
