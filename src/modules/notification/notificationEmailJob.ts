import cron from 'node-cron';
import { NotificationService } from './notification.service';
import { isMailConfigured } from '../../config/mail.config';
import { logger } from '../../lib/logger';

const service = new NotificationService();
let running = false;

export async function dispatchNotificationEmailsOnce() {
  // Um ciclo lento (SMTP) não pode se sobrepor ao próximo.
  if (running) return;
  running = true;
  try {
    const count = await service.dispatchPendingEmails();
    if (count > 0) logger.info(`[Notifications] ${count} e-mail(s) de notificação enviado(s)`);
  } catch (err: unknown) {
    logger.error('[Notifications] erro ao enviar e-mails de notificação:', err instanceof Error ? err.message : err);
  } finally {
    running = false;
  }
}

if (isMailConfigured()) {
  // A cada minuto: o e-mail chega logo após a notificação e só depois do commit da transação que a criou.
  cron.schedule('* * * * *', dispatchNotificationEmailsOnce);
} else if (process.env.NODE_ENV === 'production') {
  logger.error('[Notifications] variáveis de e-mail ausentes: e-mails de notificação DESATIVADOS');
} else {
  logger.warn('[Notifications] e-mail não configurado: envio de e-mails de notificação desativado');
}
