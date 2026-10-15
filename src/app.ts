import express, { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import userRoutes from './modules/user/user.route';
import addressRoutes from './modules/address/address.route';
import productRoutes from './modules/product/product.route';
import authRouter from './modules/auth/auth.route'
import priceRouter from './modules/price-recommendation/priceRecommendation.route';
import salesRouter from './modules/sales/sales.route';
import cartRouter from './modules/cart/cart.route';
import contractRouter from './modules/contract/contract.route';
import checkoutRouter from './modules/contract/checkout.route';
import sellinUnitProductRoute from './modules/product/sellinUnitProduct.route';
import sellingUnitRoute from './modules/product/sellingUnit.route';
import swaggerUi from 'swagger-ui-express';
import swaggerSpec from './swagger';
import uploadS3Router from './modules/upload-S3/uploadS3.route';
import transportTypesRoutes from './modules/transport-types/transport-types.route';
import paymentMethodsRoutes from './modules/payment-methods/payment-methods.route';
import paymentRoutes from './modules/payment/payment.route';
import { PaymentService } from './modules/payment/payment.service';
import dashboardRoutes from './modules/dashboard/dashboard.route';
import notificationRoutes from './modules/notification/notification.route';

import 'dotenv/config';

const app = express();

app.use(cors({
  origin: `${process.env.URL_FRONTEND}`,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  credentials: true
}));

app.use(express.json());
app.use('/user', userRoutes);
app.use('/auth', authRouter);
app.use('/address', addressRoutes);
app.use('/products', productRoutes);
app.use('/selling-units-product', sellinUnitProductRoute);
app.use('/selling-units', sellingUnitRoute);
app.use('/price-recommendations', priceRouter);
app.use('/sales', salesRouter);
app.use('/sales', checkoutRouter);
app.use('/cart', cartRouter);
app.use('/contract', contractRouter);
app.use('/transport-types', transportTypesRoutes);
app.use('/payment-methods', paymentMethodsRoutes);
app.use('/payment', paymentRoutes);
app.use('/dashboard', dashboardRoutes);
app.use('/notifications', notificationRoutes);
app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(swaggerSpec));
app.use('/upload-s3', uploadS3Router);

app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
  console.error('[Global Error Handler]', err);
  res.status(err.status || 500).json({
    error: err.message || 'Erro interno do servidor'
  });
});

// Polling de boletos pendentes — roda a cada 5 minutos para compensar atrasos bancários
const paymentService = new PaymentService();
const BOLETO_POLL_INTERVAL_MS = 5 * 60 * 1000;
const boletoPoller = setInterval(async () => {
  try {
    const result = await paymentService.syncPendingOrderPayments();
    if (result.confirmed > 0) {
      console.info(`[BoletoPoller] ${result.confirmed} pagamento(s) confirmado(s) automaticamente.`);
    }
  } catch (err: any) {
    console.error('[BoletoPoller] Erro no ciclo de polling:', err.message);
  }
}, BOLETO_POLL_INTERVAL_MS);
boletoPoller.unref(); // não impede o processo de finalizar em testes/CLI

export default app;
