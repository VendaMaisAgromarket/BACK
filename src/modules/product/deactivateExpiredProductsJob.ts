import cron from 'node-cron';
import { ProductService } from './product.service';
import { BRASILIA_TIME_ZONE } from '../../lib/brasiliaTime';
import { logger } from '../../lib/logger';

const service = new ProductService();

export async function deactivateExpiredProductsOnce() {
  try {
    const count = await service.deactivateExpiredProducts();
    logger.info(`[Products] ${count} produto(s) com colheita encerrada desativado(s)`);
  } catch (err: any) {
    logger.error('[Products] erro ao desativar produtos com colheita encerrada:', err?.message || err);
  }
}

// À 00:00 de Brasília, logo após o 23:59:59 do dia da colheita.
cron.schedule('0 0 * * *', deactivateExpiredProductsOnce, { timezone: BRASILIA_TIME_ZONE });

// Cobre o caso de o servidor estar fora do ar à meia-noite.
deactivateExpiredProductsOnce();
