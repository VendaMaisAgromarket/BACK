import { z } from "zod";

const mailEnvSchema = z.object({
  GOOGLE_CLIENT_ID: z.string().min(1),
  GOOGLE_CLIENT_SECRET: z.string().min(1),
  GOOGLE_REFRESH_TOKEN: z.string().min(1),
  SMTP_USER: z.email(),
  MAIL_FROM: z.string().min(1),
});

export type MailConfig = {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  user: string;
  from: string;
};

/** Permite que jobs fiquem desligados em ambientes sem e-mail configurado (dev, testes). */
export function isMailConfigured(): boolean {
  return mailEnvSchema.safeParse(process.env).success;
}

/**
 * Leitura preguiçosa: só valida quando o primeiro e-mail é enviado,
 * para não derrubar o servidor (nem os testes) em ambientes sem e-mail configurado.
 */
export function getMailConfig(): MailConfig {
  const parsed = mailEnvSchema.safeParse(process.env);

  if (!parsed.success) {
    const missing = parsed.error.issues.map((issue) => issue.path.join(".")).join(", ");
    throw new Error(`Configuração de e-mail inválida ou ausente: ${missing}`);
  }

  return {
    clientId: parsed.data.GOOGLE_CLIENT_ID,
    clientSecret: parsed.data.GOOGLE_CLIENT_SECRET,
    refreshToken: parsed.data.GOOGLE_REFRESH_TOKEN,
    user: parsed.data.SMTP_USER,
    from: parsed.data.MAIL_FROM,
  };
}
