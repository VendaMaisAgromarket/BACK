import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";
import { isCPF, formatToCPF } from "brazilian-values";

const prisma = new PrismaClient();

/**
 * Proteção de ambiente: exige NODE_ENV != production E o opt-in explícito ALLOW_DEV_SEED=true.
 * As duas travas juntas evitam que isso rode sozinho num .env de produção copiado por engano
 * (NODE_ENV pega isso) ou numa base compartilhada sem intenção clara (ALLOW_DEV_SEED pega isso).
 */
function assertDevEnvironment(): void {
  if (process.env.NODE_ENV === "production") {
    throw new Error("Recusado: NODE_ENV=production. Este script só roda em ambiente de desenvolvimento.");
  }
  if (process.env.ALLOW_DEV_SEED !== "true") {
    throw new Error(
      "Recusado: defina ALLOW_DEV_SEED=true no seu .env local para confirmar que este é um banco de desenvolvimento descartável."
    );
  }
}

interface TestUserSpec {
  cpfEnvVar: string;
  passEnvVar: string;
  role: "admin" | "buyer";
  label: string;
  /** Identidade estável do registro de teste — NÃO o CPF, que vem do .env e pode mudar entre execuções. */
  email: string;
}

async function upsertTestUser(spec: TestUserSpec): Promise<void> {
  const rawCpf = process.env[spec.cpfEnvVar];
  const rawPass = process.env[spec.passEnvVar];

  if (!rawCpf || !rawPass) {
    if (spec.role === "admin") {
      throw new Error(`Defina ${spec.cpfEnvVar} e ${spec.passEnvVar} no .env antes de rodar este script.`);
    }
    // Usuário padrão (não-admin) é opcional — pula em silêncio se não configurado.
    return;
  }

  if (!isCPF(rawCpf)) {
    throw new Error(`${spec.cpfEnvVar} não é um CPF válido.`);
  }

  const cpf = formatToCPF(rawCpf);
  const hashedPassword = await bcrypt.hash(rawPass, 10);

  /**
   * Upsert pela identidade ESTÁVEL (email fixo por papel), não pelo CPF vindo do .env: se o CPF for
   * trocado entre execuções, chavear por cpf faria o create() colidir no email único (que não mudou) —
   * e pior, se o CPF informado já pertencesse a outro usuário real, o update() reatribuiria role/senha
   * da conta de outra pessoa. Chaveando por email, uma troca de CPF só atualiza o cpf deste mesmo
   * registro de teste; se esse CPF já pertencer a outro usuário, o unique constraint falha alto (correto).
   */
  const user = await prisma.user.upsert({
    where: { email: spec.email },
    update: { role: spec.role, valid: true, password: hashedPassword, cpf },
    create: {
      name: spec.label,
      phone_number: "11999999999",
      email: spec.email,
      password: hashedPassword,
      cpf,
      role: spec.role,
      valid: true,
    },
  });

  // Nunca logar a senha — só confirma que o upsert aconteceu.
  console.log(`✅ ${spec.label} pronto (role: ${spec.role}) — id: ${user.id}, cpf: ${cpf}`);
}

async function main() {
  assertDevEnvironment();

  await upsertTestUser({
    cpfEnvVar: "ADM_USER",
    passEnvVar: "ADM_PASS",
    role: "admin",
    label: "Admin Teste",
    email: "admin.teste@vendamais.local",
  });
  await upsertTestUser({
    cpfEnvVar: "STANDARD_USER",
    passEnvVar: "STANDARD_PASS",
    role: "buyer",
    label: "Usuário Teste",
    email: "usuario.teste@vendamais.local",
  });
}

main()
  .then(async () => {
    await prisma.$disconnect();
  })
  .catch(async (e) => {
    console.error("❌", e instanceof Error ? e.message : e);
    await prisma.$disconnect();
    process.exit(1);
  });
