import cron from 'node-cron';
import { FarmCertificationService } from './farmCertification.service';
import { BRASILIA_TIME_ZONE } from '../../lib/brasiliaTime';
import { logger } from '../../lib/logger';

const service = new FarmCertificationService();

export async function expireFarmCertificationsOnce() {
  try {
    const count = await service.expireOverdue();
    logger.info(`[FarmCertification] ${count} certificação(ões) marcada(s) como vencida(s)`);
  } catch (err: unknown) {
    logger.error('[FarmCertification] erro ao expirar certificações:', err instanceof Error ? err.message : err);
  }
}

export async function sendFarmCertificationRemindersOnce() {
  try {
    const count = await service.sendExpiringReminders();
    logger.info(`[FarmCertification] ${count} aviso(s) de vencimento processado(s)`);
  } catch (err: unknown) {
    logger.error('[FarmCertification] erro ao avisar vencimentos:', err instanceof Error ? err.message : err);
  }
}

// O selo já some na leitura à meia-noite (filtro por validade); o job só registra o EXPIRED e avisa.
cron.schedule('5 0 * * *', expireFarmCertificationsOnce, { timezone: BRASILIA_TIME_ZONE });
cron.schedule('0 8 * * *', sendFarmCertificationRemindersOnce, { timezone: BRASILIA_TIME_ZONE });

// Cobre o servidor fora do ar no horário do job (CAS no status e dedupeKey evitam duplicatas).
expireFarmCertificationsOnce();
sendFarmCertificationRemindersOnce();
