import cron from 'node-cron';
import { HarvestCertificationService } from './harvestCertification.service';
import { BRASILIA_TIME_ZONE } from '../../lib/brasiliaTime';
import { logger } from '../../lib/logger';

const service = new HarvestCertificationService();

export async function expireHarvestCertificationsOnce() {
  try {
    const count = await service.expireOverdue();
    logger.info(`[HarvestCertification] ${count} certificação(ões) de safra marcada(s) como vencida(s)`);
  } catch (err: unknown) {
    logger.error('[HarvestCertification] erro ao expirar certificações:', err instanceof Error ? err.message : err);
  }
}

export async function sendHarvestCertificationRemindersOnce() {
  try {
    const count = await service.sendExpiringReminders();
    logger.info(`[HarvestCertification] ${count} aviso(s) de vencimento processado(s)`);
  } catch (err: unknown) {
    logger.error('[HarvestCertification] erro ao avisar vencimentos:', err instanceof Error ? err.message : err);
  }
}

// O selo já some na leitura à meia-noite (filtro por validade); o job só registra o EXPIRED e avisa.
cron.schedule('10 0 * * *', expireHarvestCertificationsOnce, { timezone: BRASILIA_TIME_ZONE });
cron.schedule('5 8 * * *', sendHarvestCertificationRemindersOnce, { timezone: BRASILIA_TIME_ZONE });

// Cobre o servidor fora do ar no horário do job (CAS no status e dedupeKey evitam duplicatas).
expireHarvestCertificationsOnce();
sendHarvestCertificationRemindersOnce();
