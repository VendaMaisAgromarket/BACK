import cron from 'node-cron';
import { NotificationService } from './notification.service';
import { BRASILIA_TIME_ZONE } from '../../lib/brasiliaTime';
import { logger } from '../../lib/logger';

const service = new NotificationService();

export async function sendHarvestRemindersOnce() {
  try {
    const count = await service.sendProductHarvestReminders();
    logger.info(`[Notifications] ${count} lembrete(s) de colheita de anúncio enviado(s)`);
  } catch (err: unknown) {
    logger.error('[Notifications] erro ao enviar lembretes de colheita:', err instanceof Error ? err.message : err);
  }
}

// Todo dia às 08:00 de Brasília, para o vendedor ver o lembrete no início do dia.
cron.schedule('0 8 * * *', sendHarvestRemindersOnce, { timezone: BRASILIA_TIME_ZONE });

// Cobre o caso de o servidor estar fora do ar no horário do job (dedupeKey evita duplicatas).
sendHarvestRemindersOnce();
