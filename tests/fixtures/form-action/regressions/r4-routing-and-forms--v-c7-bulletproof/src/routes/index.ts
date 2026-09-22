import { Router } from 'express';
import billing from './billing.js';
export default () => {
  const app = Router();
  billing(app);
  return app;
};
