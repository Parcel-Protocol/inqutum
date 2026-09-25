import express, { Application, Request, Response, NextFunction } from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import routes from './routes';
import { pool } from './config/database';
import { validateStellarConfig, SELLER_PUBLIC_KEY } from './config/stellar';
import paymentMonitorService from './services/payment-monitor.service';
import { configuredFrontendOrigins, corsOptions } from './config/runtime';
import postgresInvoiceStorage from './storage/postgres-invoice-storage';
import { correlationMiddleware } from './observability/telemetry';
import { buildUserSafeErrorResponse, classifyError } from './errors/error-taxonomy';

dotenv.config();

const app: Application = express();
const PORT = process.env.PORT || 3001;

// Correlation ID & Latency Tracking
app.use(correlationMiddleware());

app.use(cors(corsOptions()));

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use((req: Request, res: Response, next: NextFunction) => {
  console.log(`${new Date().toISOString()} [${req.correlationId}] - ${req.method} ${req.path}`);
  next();
});

app.use('/api', routes);

app.get('/', (req: Request, res: Response) => {
  res.json({
    name: 'Quittance API',
    version: '1.0.0',
    status: 'running',
    mode: postgresInvoiceStorage.mode,
    documentation: '/api/health',
  });
});

// User-Safe Error handling middleware with taxonomy and correlation tracking
app.use((err: Error, req: Request, res: Response, next: NextFunction) => {
  console.error('Unhandled error:', err);
  const classified = classifyError(err);
  const status = (err as any).code === 'CORS_ORIGIN_DENIED' ? 403 : classified.httpStatus || 500;
  const payload = buildUserSafeErrorResponse(err, req.correlationId);

  res.status(status).json(payload);
});

app.use((req: Request, res: Response) => {
  res.status(404).json({
    success: false,
    code: 'NOT_FOUND',
    error: 'Endpoint not found',
    correlationId: req.correlationId,
  });
});

async function initialize() {
  try {
    console.log('Starting server...');
    await pool.query('SELECT NOW()');
    console.log('Database connected');

    if (SELLER_PUBLIC_KEY) {
      validateStellarConfig();
      paymentMonitorService.start();
    } else {
      console.log('Wallet-scoped mode: no SELLER_PUBLIC_KEY, payment monitor disabled');
    }
  } catch (error) {
    console.error('Failed to initialize:', error);
    process.exit(1);
  }
}

export function startServer(port: number | string = PORT) {
  return app.listen(port, async () => {
    await initialize();
    console.log('\n🚀 Quittance Backend (Postgres Mode)');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log(`✅ Server running on port ${port}`);
    console.log(`📍 API: http://localhost:${port}/api`);
    console.log(`🏥 Health: http://localhost:${port}/api/health`);
    console.log(`💾 Storage: PostgreSQL`);
    console.log(`💰 Dynamic Seller: Each user uses their own wallet!`);
    console.log(`🌐 Frontends: ${configuredFrontendOrigins().join(', ') || 'not configured'}`);
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
  });
}

const entryPoint = process.argv[1] ?? '';
if (/server(\.[cm]?[jt]s)?$/.test(entryPoint)) {
  startServer();
}

process.on('SIGTERM', async () => {
  console.log('Shutting down...');
  paymentMonitorService.stop();
  await pool.end();
  process.exit(0);
});

process.on('SIGINT', async () => {
  console.log('Shutting down...');
  paymentMonitorService.stop();
  await pool.end();
  process.exit(0);
});

export default app;
