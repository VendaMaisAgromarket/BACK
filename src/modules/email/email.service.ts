import nodemailer, { Transporter } from "nodemailer";
import { getMailConfig } from "../../config/mail.config";
import { logger } from "../../lib/logger";

export interface SendMailInput {
  to: string | string[];
  subject: string;
  /** Informe `html`, `text` ou ambos (texto puro melhora a entregabilidade e atende clientes sem HTML). */
  html?: string;
  text?: string;
  replyTo?: string;
}

export interface SendMailResult {
  messageId: string;
  accepted: string[];
  rejected: string[];
}

function createGmailTransporter(): Transporter {
  const config = getMailConfig();

  return nodemailer.createTransport({
    host: "smtp.gmail.com",
    port: 465,
    secure: true,
    auth: {
      type: "OAuth2",
      user: config.user,
      clientId: config.clientId,
      clientSecret: config.clientSecret,
      refreshToken: config.refreshToken,
    },
  });
}

function toAddressList(addresses: unknown): string[] {
  if (!Array.isArray(addresses)) return [];
  return addresses.map((address) =>
    typeof address === "string" ? address : (address as { address: string }).address
  );
}

export class EmailService {
  private transporter?: Transporter;
  private readonly from?: string;

  // Transporter e remetente injetáveis para testes; em produção são lidos do .env no primeiro envio.
  constructor(transporter?: Transporter, from?: string) {
    this.transporter = transporter;
    this.from = from;
  }

  public async sendMail(input: SendMailInput): Promise<SendMailResult> {
    if (!input.html && !input.text) {
      throw new Error("E-mail sem conteúdo: informe html ou text");
    }
    const transporter = this.getTransporter();
    const from = this.from ?? getMailConfig().from;

    try {
      const info = await transporter.sendMail({
        from,
        to: input.to,
        subject: input.subject,
        html: input.html,
        text: input.text,
        replyTo: input.replyTo,
      });

      return {
        messageId: info.messageId,
        accepted: toAddressList(info.accepted),
        rejected: toAddressList(info.rejected),
      };
    } catch (error) {
      if (isAuthError(error)) {
        // Refresh token revogado/expirado (troca de senha, revogação, 6 meses sem uso) — exige gerar um novo.
        logger.error(
          "[EmailService] Falha de autenticação no Gmail. Verifique GOOGLE_REFRESH_TOKEN / SMTP_USER.",
          error
        );
      } else {
        logger.error("[EmailService] Falha ao enviar e-mail", { subject: input.subject }, error);
      }
      throw error;
    }
  }

  private getTransporter(): Transporter {
    if (!this.transporter) {
      this.transporter = createGmailTransporter();
    }
    return this.transporter;
  }
}

function isAuthError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const { code, message } = error as { code?: unknown; message?: unknown };
  return code === "EAUTH" || (typeof message === "string" && message.includes("invalid_grant"));
}

export const emailService = new EmailService();
