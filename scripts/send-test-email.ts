import "dotenv/config";
import { EmailService } from "../src/modules/email/email.service";

/**
 * Envia um e-mail de teste usando as credenciais do .env.
 * Uso: npm run send-test-email -- destinatario@exemplo.com
 */
async function main() {
  const to = process.argv[2];
  if (!to) {
    throw new Error("Informe o destinatário: npm run send-test-email -- destinatario@exemplo.com");
  }

  const sentAt = new Date().toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo" });
  const result = await new EmailService().sendMail({
    to,
    subject: "Teste de envio — Venda+ Agromarket",
    html: `<p>Este é um e-mail de teste do backend do <strong>Venda+ Agromarket</strong>.</p><p>Enviado em ${sentAt} (horário de Brasília).</p>`,
    text: `Este é um e-mail de teste do backend do Venda+ Agromarket. Enviado em ${sentAt} (horário de Brasília).`,
  });

  console.log("✅ E-mail enviado", result);
}

main().catch((e) => {
  console.error("❌", e instanceof Error ? e.message : e);
  process.exit(1);
});
