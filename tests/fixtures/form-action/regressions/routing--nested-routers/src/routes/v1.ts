import { Router } from 'express';
import { billing } from './billing.js';
export const v1 = Router();
v1.use('/billing', billing);
