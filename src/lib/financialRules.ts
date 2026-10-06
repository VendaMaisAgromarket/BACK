/**
 * Regras financeiras provisórias da plataforma — ponto único de alteração.
 *
 * O repasse ao vendedor ainda não é modelado de verdade (não há transferência Asaas nem tabela de
 * payout). Até essa definição, o "Valor Liberado" do Controle Financeiro é uma aproximação: o valor
 * recebido das vendas que já chegaram às etapas "Pagamento liberado"/"Operação finalizada" (9-10),
 * descontada a retenção da plataforma abaixo.
 */

/** Percentual retido pela plataforma sobre o valor liberado (o vendedor recebe 100 - este valor). */
export const PLATFORM_FEE_PERCENT = 5;

export function splitReleasedAmount(grossReleased: number): { sellerPayout: number; platformFee: number } {
  const platformFee = (grossReleased * PLATFORM_FEE_PERCENT) / 100;
  return { sellerPayout: grossReleased - platformFee, platformFee };
}
