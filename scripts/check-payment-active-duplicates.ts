import { PrismaClient } from '@prisma/client';

/**
 * Checagem PRÉ-DEPLOY (somente leitura) das migrations do índice único de tentativa ativa:
 * - 20261001105754_fix_payment_active_attempt_unique_index: UNIQUE (saleId, phase) para status pending/completed;
 * - 20261006110000_payment_active_attempt_index_filtered: mesmo índice, só para billingType NOT NULL.
 *
 * Se o banco tiver mais de uma cobrança ativa para a mesma venda+fase (ex.: um PIX e um BOLETO pendentes,
 * permitidos pelo índice antigo que incluía billingType na chave), o CREATE UNIQUE INDEX falha e o
 * `prisma migrate deploy` para no meio. Este script lista esses grupos ANTES do deploy.
 *
 * Não corrige nada sozinho de propósito: duas linhas 'completed' significam pagamento em dobro (estorno),
 * e uma 'pending' pode ser uma cobrança ainda viva no Asaas (cancelar só aqui deixaria o boleto pagável).
 * Cada grupo precisa ser resolvido manualmente — cancelar a cobrança no Asaas e marcar a linha como 'cancelled'.
 *
 * Uso: DATABASE_URL=<banco alvo> npx ts-node scripts/check-payment-active-duplicates.ts
 * Sai com código 1 se houver conflito (dá para usar como trava no deploy).
 */

const prisma = new PrismaClient();

interface DuplicateGroup {
  saleId: string;
  phase: string;
  total: number;
  nonNullBillingType: number;
  rows: { id: string; status: string; billingType: string | null; asaas_payment_id: string | null; createdAt: Date }[];
}

async function main() {
  const groups = await prisma.$queryRaw<{ saleId: string; phase: string; total: bigint; non_null: bigint }[]>`
    SELECT "saleId", "phase",
           COUNT(*) AS total,
           COUNT(*) FILTER (WHERE "billingType" IS NOT NULL) AS non_null
    FROM "Payment"
    WHERE "status" IN ('pending', 'completed')
    GROUP BY "saleId", "phase"
    HAVING COUNT(*) > 1
  `;

  if (groups.length === 0) {
    console.log('OK — nenhuma venda/fase com mais de uma cobrança ativa. As migrations do índice podem ser aplicadas.');
    return 0;
  }

  const detailed: DuplicateGroup[] = [];
  for (const g of groups) {
    const rows = await prisma.payment.findMany({
      where: { saleId: g.saleId, phase: g.phase, status: { in: ['pending', 'completed'] } },
      select: { id: true, status: true, billingType: true, asaas_payment_id: true, createdAt: true },
      orderBy: { createdAt: 'asc' },
    });
    detailed.push({ saleId: g.saleId, phase: g.phase, total: Number(g.total), nonNullBillingType: Number(g.non_null), rows });
  }

  console.log(`CONFLITO — ${detailed.length} venda(s)/fase(s) com mais de uma cobrança ativa:\n`);
  for (const g of detailed) {
    // 105754 indexa todas as linhas; 20261006 só as com billingType (legado Mercado Pago fica de fora).
    const blocks = g.nonNullBillingType > 1 ? 'bloqueia 105754 e 20261006' : 'bloqueia 105754 (20261006 sozinha passaria)';
    console.log(`venda ${g.saleId} | fase ${g.phase} | ${g.total} ativas | ${blocks}`);
    for (const r of g.rows) {
      console.log(`   - ${r.id} | ${r.status} | ${r.billingType ?? 'legado MP'} | asaas=${r.asaas_payment_id ?? '-'} | ${r.createdAt.toISOString()}`);
    }
  }
  console.log('\nResolva cada grupo manualmente antes de rodar `prisma migrate deploy` (ver comentário no topo do script).');
  return 1;
}

main()
  .then((code) => prisma.$disconnect().then(() => process.exit(code)))
  .catch(async (error) => {
    console.error(error);
    await prisma.$disconnect();
    process.exit(2);
  });
