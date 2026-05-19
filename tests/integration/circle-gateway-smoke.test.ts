/**
 * Circle Gateway Nanopayments — testnet smoke test.
 *
 * Verifies the @circle-fin/x402-batching middleware loads, mounts on Express,
 * and emits the canonical x402 protocol response on an unpaid request.
 *
 * Gated behind `INTEGRATION=1` (network access to gateway-api-testnet.circle.com
 * required to enumerate supported networks). Default `npm test` SKIPS this file.
 *
 * Production migration is the separate CIRCLE-GATEWAY-MIGRATE-W1 wave.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createGatewayMiddleware } from '@circle-fin/x402-batching/server';
import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

describe.skipIf(!process.env.INTEGRATION)(
  'CIRCLE-AGENT-MARKETPLACE-SUBMIT-W1 R3 — Circle Gateway testnet smoke',
  () => {
    let server: Server;
    let baseUrl: string;

    beforeAll(async () => {
      const sellerAddress =
        process.env.X402_WALLET_ADDRESS ||
        '0x0000000000000000000000000000000000000000';

      const gateway = createGatewayMiddleware({
        sellerAddress,
        facilitatorUrl: 'https://gateway-api-testnet.circle.com',
      });

      const app = express();
      app.get('/smoke-test', gateway.require('$0.01'), (_req, res) => {
        res.json({ ok: true });
      });

      await new Promise<void>((resolve) => {
        server = app.listen(0, () => resolve());
      });
      const port = (server.address() as AddressInfo).port;
      baseUrl = `http://127.0.0.1:${port}`;
    }, 30_000);

    afterAll(async () => {
      if (server) {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    });

    it('responds 402 + PAYMENT-REQUIRED header with base64 x402 v2 payload on unpaid GET', async () => {
      const response = await fetch(`${baseUrl}/smoke-test`);

      if (response.status === 503) {
        const body = await response.json().catch(() => ({}));
        throw new Error(
          `Circle Gateway testnet returned no supported networks (HTTP 503). ` +
            `Likely unreachable from this network. Body: ${JSON.stringify(body)}`,
        );
      }

      expect(response.status).toBe(402);

      const header =
        response.headers.get('PAYMENT-REQUIRED') ||
        response.headers.get('payment-required');
      expect(header).toBeTruthy();

      const decoded = JSON.parse(
        Buffer.from(header as string, 'base64').toString('utf-8'),
      );

      expect(decoded).toMatchObject({
        x402Version: 2,
        resource: {
          url: expect.any(String),
          description: expect.any(String),
          mimeType: 'application/json',
        },
        accepts: expect.any(Array),
      });
      expect(Array.isArray(decoded.accepts)).toBe(true);
      expect(decoded.accepts.length).toBeGreaterThan(0);
    }, 30_000);
  },
);
