import express from 'express';
const app = express();
app.use((_req, res, next) => {
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'self'; " +
    "frame-ancestors 'none'; base-uri 'self'; form-action 'self'; object-src 'none'",
  );
  next();
});
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import helmet from 'helmet';
import cors from 'cors';
import compression from 'compression';
import cookieParser from 'cookie-parser';
import session from 'express-session';
import connectPgSimple from 'connect-pg-simple';
import csurf from 'csurf';
import morgan from 'morgan';
import rateLimit from 'express-rate-limit';
import passport from 'passport';
import { pool } from './db.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PgStore = connectPgSimple(session);
const isProd = process.env.NODE_ENV === 'production';

app.set('trust proxy', 1);
app.disable('x-powered-by');
app.use(helmet({ contentSecurityPolicy: false, crossOriginEmbedderPolicy: false }));
app.use(cors({ origin: ['https://algovault.com'], credentials: true }));
app.use(compression({ filter: (req, res) => (req.headers['x-no-compression'] ? false : compression.filter(req, res)) }));
app.use(morgan(isProd ? 'combined' : 'dev', { skip: (req, res) => res.statusCode < 400 }));
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: false }));
app.use(cookieParser());
app.use(session({
  store: new PgStore({ pool, tableName: 'session' }),
  secret: process.env.SESSION_SECRET ?? 'dev-secret',
  resave: false,
  saveUninitialized: false,
  cookie: { secure: isProd, httpOnly: true, sameSite: 'lax', maxAge: 30 * 24 * 60 * 60 * 1000 },
}));
app.use(passport.initialize());
app.use(passport.session());
app.use(express.static(path.join(__dirname, '..', 'public'), { maxAge: '1d' }));
const csrfProtection = csurf();
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res, next, options) => res.status(options.statusCode).send(options.message),
});
app.post('/contact', limiter, csrfProtection, (req, res) => { res.redirect(303, '/contact?sent=1'); });
app.get('/contact', csrfProtection, (req, res) => { res.status(200).send('contact'); });
app.use((err: any, req: express.Request, res: express.Response, next: express.NextFunction) => {
  if (err.code === 'EBADCSRFTOKEN') { res.status(403).send('form tampered with'); return; }
  console.error(err);
  res.status(err.status || 500).json({ error: 'internal' });
});
