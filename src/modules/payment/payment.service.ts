import { Payment, PrismaClient } from '@prisma/client';
import axios, { AxiosInstance } from 'axios';
import 'dotenv/config';

type PaymentPhase = 'down_payment' | 'final_payment' | 'full';

const asaasClient: AxiosInstance = axios.create({
    baseURL: process.env.ASAAS_BASE_URL || 'https://api-sandbox.asaas.com/v3',
    headers: {
        'Content-Type': 'application/json',
        access_token: process.env.ASAAS_API_KEY || ''
    }
});

/** Extrai a mensagem de erro da resposta da API do Asaas, com fallback para o erro genérico. */
function extractAsaasErrorMessage(error: any, fallback: string): string {
    return error?.response?.data?.errors?.[0]?.description || error?.message || fallback;
}

/**
 * Prefixos de erros de negócio que o controller converte em 409 (handleKnownPaymentErrors).
 * Os métodos de criação precisam relançá-los intactos no catch externo — senão caem no tratamento
 * de erro do gateway (extractAsaasErrorMessage + log de falha) junto com erros reais do Asaas.
 * Lista única para o service e o controller não divergirem quando surgir um prefixo novo.
 */
export const KNOWN_PAYMENT_ERROR_PREFIXES = [
    'FINAL_PAYMENT_BLOCKED:',
    'FINAL_BOLETO_BLOCKED:',
    'DUPLICATE_PAYMENT_ATTEMPT:',
    'PAYMENT_ALREADY_COMPLETED:',
] as const;

export function findKnownPaymentErrorPrefix(error: unknown): string | undefined {
    const message = error instanceof Error ? error.message : undefined;
    return KNOWN_PAYMENT_ERROR_PREFIXES.find(prefix => message?.startsWith(prefix));
}

/** Código de erro do Prisma para violação de constraint única (corrida concorrente detectada no banco). */
const PRISMA_UNIQUE_VIOLATION = 'P2002';

/** Status que, uma vez alcançados, nunca devem regredir para 'pending' por um evento atrasado/fora de ordem. */
const TERMINAL_STATUSES = ['completed', 'refunded', 'cancelled'];

/** Status que, ao sair de 'completed', exigem recalcular os sinalizadores de pagamento da venda. */
const REVERSAL_STATUSES = ['refunded', 'cancelled'];

export class PaymentService {
    private readonly prisma: PrismaClient;
    constructor(prisma?: PrismaClient) {
        this.prisma = prisma || new PrismaClient();
    }

    /**
     * Garante que o comprador possua um cliente cadastrado no Asaas, criando-o na primeira
     * cobrança e reaproveitando o id nas cobranças seguintes.
     */
    private async ensureAsaasCustomer(buyerId: string): Promise<string> {
        const buyer = await this.prisma.user.findUnique({
            where: { id: buyerId },
            include: { addresses: true }
        });
        if (!buyer) throw new Error('Comprador não encontrado');
        if (buyer.asaas_customer_id) return buyer.asaas_customer_id;

        const cpfCnpj = (buyer.cpf || buyer.cnpj)?.replace(/[.\-/]/g, '');
        if (!cpfCnpj) throw new Error('Comprador não possui CPF ou CNPJ cadastrado');

        const address = buyer.addresses.find(a => a.default) ?? buyer.addresses[0];

        const { data } = await asaasClient.post('/customers', {
            name: buyer.name,
            cpfCnpj,
            email: buyer.email,
            mobilePhone: buyer.phone_number,
            externalReference: buyer.id,
            // Sem campo de bairro no nosso modelo de Address — "alias" é um rótulo do
            // próprio usuário (ex. "Casa"), não um bairro/província; não mapear para `province`.
            // Asaas resolve cidade/UF a partir do CEP automaticamente.
            ...(address && {
                postalCode: address.cep,
                address: address.street,
                addressNumber: address.number
            })
        });

        // Grava o id só se ninguém venceu a corrida antes (evita sobrescrever um
        // asaas_customer_id já persistido por uma requisição concorrente para o mesmo comprador).
        const updateResult = await this.prisma.user.updateMany({
            where: { id: buyer.id, asaas_customer_id: null },
            data: { asaas_customer_id: data.id }
        });

        if (updateResult.count === 0) {
            const current = await this.prisma.user.findUnique({ where: { id: buyer.id } });
            if (current?.asaas_customer_id) return current.asaas_customer_id;
        }

        return data.id as string;
    }

    /** Monta o texto exibido na fatura/cobrança do Asaas para o comprador. */
    private buildPaymentDescription(orderNumber: number, phase: PaymentPhase): string {
        const phaseLabel: Record<PaymentPhase, string> = {
            down_payment: 'primeira parcela (30%)',
            final_payment: 'parcela final (70%)',
            full: 'pagamento integral',
        };
        return `Pagamento referente à ${phaseLabel[phase]} referente ao pedido ${orderNumber}`;
    }

    /** Mapeia o status de cobrança do Asaas para o vocabulário interno do sistema. */
    private mapAsaasStatus(asaasStatus: string): string {
        const statusMap: Record<string, string> = {
            'PENDING': 'pending',
            'AWAITING_RISK_ANALYSIS': 'pending',
            'AUTHORIZED': 'pending',
            'CONFIRMED': 'completed',
            'RECEIVED': 'completed',
            'RECEIVED_IN_CASH': 'completed',
            'OVERDUE': 'pending',
            'REFUNDED': 'refunded',
            'REFUND_REQUESTED': 'refunded',
            'REFUND_IN_PROGRESS': 'refunded',
            'CHARGEBACK_REQUESTED': 'refunded',
            'CHARGEBACK_DISPUTE': 'refunded',
            'AWAITING_CHARGEBACK_REVERSAL': 'refunded',
            'DUNNING_REQUESTED': 'pending',
            'DUNNING_RECEIVED': 'pending',
            'DELETED': 'cancelled'
        };
        return statusMap[asaasStatus] || 'pending';
    }

    /**
     * Idempotência por tentativa: reaproveita uma cobrança pendente/concluída já existente
     * para a mesma venda+fase, em vez de criar uma nova no Asaas a cada reenvio (ex.: timeout
     * no cliente após o Asaas já ter aceitado a cobrança anterior). A invariante é "uma
     * tentativa ativa por venda+fase" — INDEPENDENTE do meio de pagamento: se já existe uma
     * cobrança pendente via PIX e o cliente chama o endpoint de boleto para a mesma fase, a
     * cobrança PIX existente é reaproveitada — não criamos uma segunda cobrança ativa
     * concorrente para a mesma parcela só porque o endpoint/meio de pagamento mudou.
     * Chamada SEMPRE antes de qualquer validação de fase, para que um retry de final_payment
     * reaproveite a cobrança pendente em vez de ser bloqueado por "já existe cobrança final".
     *
     * Se o registro encontrado ainda não tem `asaas_payment_id` (reserva de uma requisição
     * concorrente que ainda não terminou de falar com o Asaas), não há nada para reaproveitar
     * ainda — quem chamar deve tratar isso como "tente novamente", nunca tentar reusar.
     *
     * Linhas legadas do Mercado Pago (billingType nulo) seguem a mesma regra do índice único
     * parcial (migration payment_active_attempt_index_filtered, que só cobre billingType NOT NULL):
     * - legado 'pending' é ignorado: é uma tentativa abandonada que não tem como ser reaproveitada
     *   no Asaas, e não pode travar a criação de uma cobrança nova;
     * - legado 'completed' continua sendo encontrado: a parcela já foi paga, e ignorá-lo permitiria
     *   cobrar o comprador de novo (calculateDownPaymentAmount não checa downPaymentCompleted).
     *   reuseOrRetrySignal transforma isso em PAYMENT_ALREADY_COMPLETED.
     *
     * 'completed' tem prioridade sobre 'pending' (duas consultas, não um findFirst por createdAt):
     * como o índice ignora billingType nulo, um legado 'completed' pode coexistir com uma cobrança
     * Asaas 'pending' da mesma parcela — ex.: o legado estava 'pending' (ignorado), a cobrança Asaas
     * foi criada, e depois um admin marcou o legado como pago via PATCH /payment/:id. Ordenar só por
     * data reaproveitaria a cobrança pendente, mais nova, mantendo um segundo pagamento disponível.
     * A cobrança pendente que sobra no Asaas precisa ser cancelada manualmente — esse estado aparece
     * em scripts/check-payment-active-duplicates.ts.
     */
    private async findExistingAttempt(saleId: string, phase: PaymentPhase) {
        const completed = await this.prisma.payment.findFirst({
            where: { saleId, phase, status: 'completed' },
            orderBy: { createdAt: 'desc' },
        });
        if (completed) return completed;

        return this.prisma.payment.findFirst({
            where: { saleId, phase, status: 'pending', billingType: { not: null } },
            orderBy: { createdAt: 'desc' },
        });
    }

    /**
     * Resolve o que fazer com uma tentativa já existente encontrada por `findExistingAttempt`:
     * reaproveita a resposta se a cobrança já foi de fato criada no Asaas, ou sinaliza para
     * tentar novamente em breve se for apenas uma reserva em andamento de outra requisição.
     */
    private async reuseOrRetrySignal(existing: Payment, phase: PaymentPhase): Promise<any> {
        // Só um pagamento legado 'completed' chega aqui com billingType nulo (ver findExistingAttempt).
        if (existing.billingType === null) {
            throw new Error('PAYMENT_ALREADY_COMPLETED:Esta parcela já foi paga (pagamento anterior à migração para o Asaas).');
        }
        if (!existing.asaas_payment_id) {
            throw new Error('DUPLICATE_PAYMENT_ATTEMPT:Uma cobrança para esta venda/fase já está sendo criada. Tente novamente em alguns segundos.');
        }
        return this.buildReuseResponse(existing, phase);
    }

    /**
     * Monta a resposta de uma cobrança já existente (reaproveitada), buscando os dados
     * complementares específicos de cada meio de pagamento. Único ponto que sabe o formato
     * de resposta de cada billingType — evita duplicar essa lógica em cada método de criação.
     */
    private async buildReuseResponse(existing: Payment, phase: PaymentPhase): Promise<any> {
        if (existing.billingType === 'PIX') {
            const [paymentRes, qrRes] = await Promise.all([
                asaasClient.get(`/payments/${existing.asaas_payment_id}`),
                // Uma cobrança já liquidada pode não ter mais QR Code disponível no Asaas —
                // não vale a pena pedir (e não deve quebrar a resposta se falhar).
                existing.status === 'completed'
                    ? Promise.resolve(null)
                    : asaasClient.get(`/payments/${existing.asaas_payment_id}/pixQrCode`).catch(() => null)
            ]);
            const asaasPayment = paymentRes.data;
            const qrCode = qrRes?.data ?? null;
            return {
                paymentId: existing.id,
                asaas_payment_id: existing.asaas_payment_id,
                status: existing.status,
                phase,
                payment: {
                    id: asaasPayment.id,
                    status: asaasPayment.status,
                    qr_code: qrCode?.payload ?? null,
                    qr_code_base64: qrCode?.encodedImage ?? null,
                    expiration_date: qrCode?.expirationDate ?? null
                }
            };
        }

        if (existing.billingType === 'BOLETO') {
            const { data: asaasPayment } = await asaasClient.get(`/payments/${existing.asaas_payment_id}`);
            return {
                paymentId: existing.id,
                asaas_payment_id: existing.asaas_payment_id,
                status: existing.status,
                phase,
                payment: {
                    id: asaasPayment.id,
                    status: asaasPayment.status,
                    ticket_url: asaasPayment.bankSlipUrl,
                    invoice_url: asaasPayment.invoiceUrl,
                    expiration_date: asaasPayment.dueDate
                }
            };
        }

        if (existing.billingType === 'CREDIT_CARD') {
            const { data: asaasPayment } = await asaasClient.get(`/payments/${existing.asaas_payment_id}`);
            return {
                paymentId: existing.id,
                asaas_payment_id: existing.asaas_payment_id,
                status: existing.status,
                phase,
                payment: {
                    id: asaasPayment.id,
                    status: asaasPayment.status,
                    brand: asaasPayment.creditCard?.creditCardBrand,
                    lastDigits: asaasPayment.creditCard?.creditCardNumber
                }
            };
        }

        // UNDEFINED (fatura hospedada / createPreference)
        const { data: asaasPayment } = await asaasClient.get(`/payments/${existing.asaas_payment_id}`);
        return {
            paymentId: existing.id,
            asaas_payment_id: existing.asaas_payment_id,
            init_point: asaasPayment.invoiceUrl
        };
    }

    /**
     * Alguns meios de pagamento confirmam de forma síncrona (ex.: cartão de crédito aprovado
     * na hora da captura). Quando o Payment já nasce 'completed', aplica a mesma transição de
     * SaleData que o webhook aplicaria — sem isso, a venda fica com downPaymentCompleted/
     * paymentCompleted falsos mesmo com a cobrança já confirmada, e o webhook subsequente pula
     * a atualização por já achar o status igual.
     */
    private async applyCompletionIfAlreadySettled(payment: Payment): Promise<void> {
        if (payment.status !== 'completed') return;
        await this.prisma.$transaction(async (tx) => {
            await this.applyPaymentCompletion(tx, payment, payment.status);
        });
    }

    /**
     * Reserva localmente a tentativa de pagamento ANTES de chamar o Asaas. O índice único
     * parcial do banco (saleId+phase, para status pending/completed e billingType NOT NULL) garante que
     * só uma requisição concorrente consiga reservar a mesma combinação — a perdedora recebe
     * o erro aqui e NUNCA chega a criar uma cobrança remota, então não existe cenário de
     * cobrança órfã no Asaas por causa de uma corrida entre duas requisições.
     */
    private async reservePaymentAttempt(data: {
        saleId: string;
        paymentMethodId: string;
        amount: number;
        phase: PaymentPhase;
        billingType: string;
    }): Promise<Payment> {
        try {
            return await this.prisma.payment.create({
                data: { ...data, status: 'pending', asaas_customer_id: null, asaas_payment_id: null }
            });
        } catch (error: any) {
            if (error?.code === PRISMA_UNIQUE_VIOLATION) {
                throw new Error('DUPLICATE_PAYMENT_ATTEMPT:Já existe uma cobrança em andamento para esta venda/fase. Tente novamente em alguns segundos.');
            }
            throw error;
        }
    }

    /**
     * Libera uma reserva que não chegou a se tornar uma cobrança real no Asaas (ex.: a chamada
     * à API falhou após a reserva) — sem isso, a linha reservada ficaria 'pending' para sempre
     * e bloquearia qualquer nova tentativa para a mesma venda/fase/meio de pagamento.
     */
    private async releaseReservation(reservedId: string): Promise<void> {
        await this.prisma.payment.update({
            where: { id: reservedId },
            data: { status: 'cancelled', updatedAt: new Date() }
        }).catch(() => { /* melhor esforço — não deixa o erro de liberação mascarar o erro original */ });
    }

    /**
     * Cria uma fatura hospedada no Asaas (billingType UNDEFINED): o comprador é redirecionado
     * para a página do Asaas e escolhe PIX, boleto ou cartão. É o único caminho para oferecer
     * cartão de débito, já que a API do Asaas não aceita dados de débito diretamente.
     */
    async createPreference(params: {
        saleId: string;
        paymentMethodId: string;
        title: string;
        unit_price: number;
        quantity: number;
        amount: number;
        phase?: PaymentPhase;
    }) {
        try {
            const phase = params.phase ?? 'full';
            console.info(`[createPreference] Criando fatura Asaas para venda ${params.saleId} (fase: ${phase})`);

            const existing = await this.findExistingAttempt(params.saleId, phase);
            if (existing) {
                console.info(`[createPreference] Fatura já existente para venda ${params.saleId} (fase: ${phase}) — reaproveitando em vez de criar outra.`);
                return await this.reuseOrRetrySignal(existing, phase);
            }

            let amount = params.amount;
            if (phase === 'down_payment') {
                const calc = await this.calculateDownPaymentAmount(params.saleId);
                amount = calc.amount;
                console.info(`[createPreference] Valor da entrada calculado: ${calc.percent}% de R$${calc.contractTotal} = R$${amount}`);
            } else if (phase === 'final_payment') {
                amount = await this.prepareFinalPayment(params.saleId, 'FINAL_PAYMENT_BLOCKED');
            } else {
                // full — nunca confia no amount do cliente; usa o total do contrato
                amount = await this.calculateFullPaymentAmount(params.saleId);
            }

            const sale = await this.prisma.saleData.findUnique({ where: { id: params.saleId } });
            if (!sale) throw new Error(`Venda não encontrada: ${params.saleId}`);

            const reserved = await this.reservePaymentAttempt({
                saleId: params.saleId,
                paymentMethodId: params.paymentMethodId,
                amount,
                phase,
                billingType: 'UNDEFINED'
            });

            try {
                const customerId = await this.ensureAsaasCustomer(sale.buyerId);
                const dueDate = new Date().toISOString().split('T')[0];

                const { data: asaasPayment } = await asaasClient.post('/payments', {
                    customer: customerId,
                    billingType: 'UNDEFINED',
                    value: amount,
                    dueDate,
                    externalReference: params.saleId,
                    description: params.title
                });

                const payment = await this.prisma.payment.update({
                    where: { id: reserved.id },
                    data: {
                        asaas_customer_id: customerId,
                        asaas_payment_id: asaasPayment.id,
                        status: this.mapAsaasStatus(asaasPayment.status)
                    }
                });

                await this.applyCompletionIfAlreadySettled(payment);

                console.info(`[createPreference] Fatura criada com sucesso - PaymentId: ${payment.id}, Asaas PaymentId: ${asaasPayment.id}`);

                return {
                    paymentId: payment.id,
                    asaas_payment_id: asaasPayment.id,
                    init_point: asaasPayment.invoiceUrl
                };
            } catch (innerError) {
                await this.releaseReservation(reserved.id);
                throw innerError;
            }
        } catch (error: any) {
            if (findKnownPaymentErrorPrefix(error)) throw error;
            const message = extractAsaasErrorMessage(error, 'Erro ao criar fatura do Asaas');
            console.error(`[createPreference] Erro ao criar fatura para venda ${params.saleId}:`, message);
            throw new Error(message);
        }
    }

    /**
     * Calcula o valor da entrada (down_payment) a partir do total da venda e do percentual configurado.
     * Usa downPaymentPercent da venda ou 30% como padrão.
     */
    private async calculateDownPaymentAmount(saleId: string): Promise<{ amount: number; contractTotal: number; percent: number }> {
        const sale = await this.prisma.saleData.findUnique({
            where: { id: saleId },
            include: { boughtProducts: true },
        });
        if (!sale) throw new Error(`Venda (id=${saleId}) não encontrada`);

        const contractTotal = sale.boughtProducts.reduce((sum, bp) => sum + bp.value, 0) + Number(sale.transportValue);
        const percent = sale.downPaymentPercent ?? 30;
        const amount = parseFloat((contractTotal * percent / 100).toFixed(2));

        return { amount, contractTotal, percent };
    }

    /**
     * Calcula o valor do pagamento integral (phase 'full'): o total do contrato, ajustado pelo
     * peso real quando disponível. Nunca confia no `amount` enviado pelo cliente — mesma
     * proteção já aplicada a down_payment e final_payment, para que um comprador não possa
     * liquidar a venda inteira com um valor simbólico.
     */
    private async calculateFullPaymentAmount(saleId: string): Promise<number> {
        const sale = await this.prisma.saleData.findUnique({
            where: { id: saleId },
            include: { boughtProducts: true },
        });
        if (!sale) throw new Error(`Venda (id=${saleId}) não encontrada`);

        const originalTotal = sale.boughtProducts.reduce((sum, bp) => sum + bp.value, 0) + Number(sale.transportValue);
        const adjustedContractTotal = sale.adjustedContractTotal !== null ? Number(sale.adjustedContractTotal) : null;

        return adjustedContractTotal ?? originalTotal;
    }

    async getById(paymentId: string): Promise<Payment | null> {
        return this.prisma.payment.findUnique({
            where: { id: paymentId }
        });
    }

    async getSaleIdForPayment(paymentId: string): Promise<string | null> {
        const payment = await this.prisma.payment.findUnique({
            where: { id: paymentId },
            select: { saleId: true },
        });
        return payment?.saleId ?? null;
    }

    /**
     * O Asaas não possui endpoint de listagem de métodos. Retorna os métodos cadastrados
     * localmente (tabela PaymentMethod) — o `id` retornado é o paymentMethodId real (FK),
     * utilizável diretamente nos demais endpoints de criação de pagamento.
     */
    async getPaymentMethods() {
        const billingTypeByMethod: Record<string, string> = {
            'PIX': 'PIX',
            'Boleto': 'BOLETO',
            'Cartão de Crédito': 'CREDIT_CARD',
            'Cartão de Débito': 'UNDEFINED', // Asaas não aceita débito direto — só via fatura hospedada (createPreference)
        };

        const methods = await this.prisma.paymentMethod.findMany();

        return methods.map(m => ({
            id: m.id,
            method: m.method,
            billingType: billingTypeByMethod[m.method] ?? null
        }));
    }

    async createPixPayment(params: {
        saleId: string;
        paymentMethodId: string;
        amount: number;
        email: string;
        expirationMinutes?: number;
        phase?: PaymentPhase;
    }) {
        try {
            const phase = params.phase ?? 'full';
            console.info(`[createPixPayment] Criando pagamento PIX para venda ${params.saleId} (fase: ${phase})`);

            const existing = await this.findExistingAttempt(params.saleId, phase);
            if (existing) {
                console.info(`[createPixPayment] PIX já existente para venda ${params.saleId} (fase: ${phase}) — reaproveitando em vez de criar outro.`);
                return await this.reuseOrRetrySignal(existing, phase);
            }

            let amount = params.amount;
            if (phase === 'down_payment') {
                const calc = await this.calculateDownPaymentAmount(params.saleId);
                amount = calc.amount;
                console.info(`[createPixPayment] Valor da entrada calculado: ${calc.percent}% de R$${calc.contractTotal} = R$${amount}`);
            } else if (phase === 'final_payment') {
                amount = await this.prepareFinalPayment(params.saleId, 'FINAL_PAYMENT_BLOCKED');
            } else {
                // full — nunca confia no amount do cliente; usa o total do contrato
                amount = await this.calculateFullPaymentAmount(params.saleId);
            }

            const sale = await this.prisma.saleData.findUnique({ where: { id: params.saleId } });
            if (!sale) throw new Error(`Venda não encontrada: ${params.saleId}`);

            const reserved = await this.reservePaymentAttempt({
                saleId: params.saleId,
                paymentMethodId: params.paymentMethodId,
                amount,
                phase,
                billingType: 'PIX'
            });

            try {
                const customerId = await this.ensureAsaasCustomer(sale.buyerId);

                // PIX é liquidado instantaneamente, mas o Asaas ainda exige um dueDate;
                // expirationMinutes (herdado da API antiga) é aproximado em dias corridos.
                const dueDateObj = new Date();
                if (params.expirationMinutes) dueDateObj.setMinutes(dueDateObj.getMinutes() + params.expirationMinutes);
                const dueDate = dueDateObj.toISOString().split('T')[0];

                const { data: asaasPayment } = await asaasClient.post('/payments', {
                    customer: customerId,
                    billingType: 'PIX',
                    value: amount,
                    dueDate,
                    externalReference: params.saleId,
                    description: this.buildPaymentDescription(sale.orderNumber, phase)
                });

                const { data: qrCode } = await asaasClient.get(`/payments/${asaasPayment.id}/pixQrCode`);

                const payment = await this.prisma.payment.update({
                    where: { id: reserved.id },
                    data: {
                        asaas_customer_id: customerId,
                        asaas_payment_id: asaasPayment.id,
                        status: this.mapAsaasStatus(asaasPayment.status)
                    }
                });

                await this.applyCompletionIfAlreadySettled(payment);

                console.info(`[createPixPayment] Pagamento PIX criado com sucesso - PaymentId: ${payment.id}, Asaas PaymentId: ${asaasPayment.id}`);

                return {
                    paymentId: payment.id,
                    asaas_payment_id: asaasPayment.id,
                    status: payment.status,
                    phase,
                    payment: {
                        id: asaasPayment.id,
                        status: asaasPayment.status,
                        qr_code: qrCode.payload,
                        qr_code_base64: qrCode.encodedImage,
                        expiration_date: qrCode.expirationDate
                    }
                };
            } catch (innerError) {
                await this.releaseReservation(reserved.id);
                throw innerError;
            }
        } catch (error: any) {
            if (findKnownPaymentErrorPrefix(error)) throw error;
            const message = extractAsaasErrorMessage(error, 'Erro ao criar pagamento PIX');
            console.error(`[createPixPayment] Erro ao criar pagamento PIX para venda ${params.saleId}:`, message);
            throw new Error(message);
        }
    }

    /**
     * Efetivamente cria a cobrança de boleto no Asaas (reservando a linha local antes de
     * chamar a API). Não valida fase nem recalcula valor — quem chama (`createBoletoPayment`
     * ou `createFinalBoleto`) já fez isso com a semântica correta para o seu caso (o
     * final-boleto admite ajuste manual pelo peso).
     */
    private async createBoletoCharge(params: {
        saleId: string;
        paymentMethodId: string;
        amount: number;
        expirationDays?: number;
        phase: PaymentPhase;
    }) {
        const sale = await this.prisma.saleData.findUnique({ where: { id: params.saleId } });
        if (!sale) throw new Error(`Venda não encontrada: ${params.saleId}`);

        const reserved = await this.reservePaymentAttempt({
            saleId: params.saleId,
            paymentMethodId: params.paymentMethodId,
            amount: params.amount,
            phase: params.phase,
            billingType: 'BOLETO'
        });

        try {
            const customerId = await this.ensureAsaasCustomer(sale.buyerId);

            // ?? (não ||): expirationDays: 0 é um valor explícito válido ("vence hoje"), não deve
            // cair no default de 3 dias.
            const expirationDays = params.expirationDays ?? 3;
            const dueDateObj = new Date();
            dueDateObj.setDate(dueDateObj.getDate() + expirationDays);
            const dueDate = dueDateObj.toISOString().split('T')[0];

            const { data: asaasPayment } = await asaasClient.post('/payments', {
                customer: customerId,
                billingType: 'BOLETO',
                value: params.amount,
                dueDate,
                externalReference: params.saleId,
                description: this.buildPaymentDescription(sale.orderNumber, params.phase)
            });

            const payment = await this.prisma.payment.update({
                where: { id: reserved.id },
                data: {
                    asaas_customer_id: customerId,
                    asaas_payment_id: asaasPayment.id,
                    status: this.mapAsaasStatus(asaasPayment.status)
                }
            });

            await this.applyCompletionIfAlreadySettled(payment);

            console.info(`[createBoletoCharge] Boleto criado com sucesso - PaymentId: ${payment.id}, Asaas PaymentId: ${asaasPayment.id}`);

            return {
                paymentId: payment.id,
                asaas_payment_id: asaasPayment.id,
                status: payment.status,
                phase: params.phase,
                payment: {
                    id: asaasPayment.id,
                    status: asaasPayment.status,
                    ticket_url: asaasPayment.bankSlipUrl,
                    invoice_url: asaasPayment.invoiceUrl,
                    expiration_date: dueDate
                }
            };
        } catch (innerError) {
            await this.releaseReservation(reserved.id);
            throw innerError;
        }
    }

    async createBoletoPayment(params: {
        saleId: string;
        paymentMethodId: string;
        amount: number;
        expirationDays?: number;
        phase?: PaymentPhase;
    }) {
        try {
            const phase = params.phase ?? 'full';
            console.info(`[createBoletoPayment] Criando pagamento com boleto para venda ${params.saleId} (fase: ${phase})`);

            const existing = await this.findExistingAttempt(params.saleId, phase);
            if (existing) {
                console.info(`[createBoletoPayment] Boleto já existente para venda ${params.saleId} (fase: ${phase}) — reaproveitando em vez de criar outro.`);
                return await this.reuseOrRetrySignal(existing, phase);
            }

            let amount = params.amount;
            if (phase === 'down_payment') {
                const calc = await this.calculateDownPaymentAmount(params.saleId);
                amount = calc.amount;
                console.info(`[createBoletoPayment] Valor da entrada calculado: ${calc.percent}% de R$${calc.contractTotal} = R$${amount}`);
            } else if (phase === 'final_payment') {
                amount = await this.prepareFinalPayment(params.saleId, 'FINAL_PAYMENT_BLOCKED');
            } else {
                // full — nunca confia no amount do cliente; usa o total do contrato
                amount = await this.calculateFullPaymentAmount(params.saleId);
            }

            return await this.createBoletoCharge({ ...params, amount, phase });
        } catch (error: any) {
            if (findKnownPaymentErrorPrefix(error)) throw error;
            const message = extractAsaasErrorMessage(error, 'Erro ao criar pagamento com boleto');
            console.error(`[createBoletoPayment] Erro ao criar boleto para venda ${params.saleId}:`, message);
            throw new Error(message);
        }
    }

    /**
     * Cria um pagamento com cartão de crédito (captura imediata via API do Asaas).
     * Cartão de débito não é suportado diretamente pela API do Asaas — para débito,
     * use `createPreference`, que gera uma fatura hospedada onde o comprador escolhe a forma de pagamento.
     */
    async createCreditCardPayment(params: {
        saleId: string;
        paymentMethodId: string;
        amount: number;
        remoteIp: string;
        phase?: PaymentPhase;
        installmentCount?: number;
        creditCard: {
            holderName: string;
            number: string;
            expiryMonth: string;
            expiryYear: string;
            ccv: string;
        };
        creditCardHolderInfo: {
            name: string;
            email: string;
            cpfCnpj: string;
            postalCode: string;
            addressNumber: string;
            phone: string;
        };
    }) {
        try {
            const phase = params.phase ?? 'full';
            console.info(`[createCreditCardPayment] Criando pagamento em cartão de crédito para venda ${params.saleId} (fase: ${phase})`);

            const existing = await this.findExistingAttempt(params.saleId, phase);
            if (existing) {
                console.info(`[createCreditCardPayment] Cobrança em cartão já existente para venda ${params.saleId} (fase: ${phase}) — reaproveitando em vez de criar outra.`);
                return await this.reuseOrRetrySignal(existing, phase);
            }

            let amount = params.amount;
            if (phase === 'down_payment') {
                const calc = await this.calculateDownPaymentAmount(params.saleId);
                amount = calc.amount;
                console.info(`[createCreditCardPayment] Valor da entrada calculado: ${calc.percent}% de R$${calc.contractTotal} = R$${amount}`);
            } else if (phase === 'final_payment') {
                amount = await this.prepareFinalPayment(params.saleId, 'FINAL_PAYMENT_BLOCKED');
            } else {
                // full — nunca confia no amount do cliente; usa o total do contrato
                amount = await this.calculateFullPaymentAmount(params.saleId);
            }

            const sale = await this.prisma.saleData.findUnique({ where: { id: params.saleId } });
            if (!sale) throw new Error(`Venda não encontrada: ${params.saleId}`);

            const reserved = await this.reservePaymentAttempt({
                saleId: params.saleId,
                paymentMethodId: params.paymentMethodId,
                amount,
                phase,
                billingType: 'CREDIT_CARD'
            });

            try {
                const customerId = await this.ensureAsaasCustomer(sale.buyerId);
                const dueDate = new Date().toISOString().split('T')[0]; // captura imediata; dueDate não agenda a cobrança

                const installmentCount = params.installmentCount && params.installmentCount > 1 ? params.installmentCount : undefined;

                const { data: asaasPayment } = await asaasClient.post('/payments', {
                    customer: customerId,
                    billingType: 'CREDIT_CARD',
                    value: amount,
                    dueDate,
                    externalReference: params.saleId,
                    description: this.buildPaymentDescription(sale.orderNumber, phase),
                    remoteIp: params.remoteIp,
                    creditCard: params.creditCard,
                    creditCardHolderInfo: params.creditCardHolderInfo,
                    ...(installmentCount && {
                        installmentCount,
                        installmentValue: parseFloat((amount / installmentCount).toFixed(2))
                    })
                });

                const payment = await this.prisma.payment.update({
                    where: { id: reserved.id },
                    data: {
                        asaas_customer_id: customerId,
                        asaas_payment_id: asaasPayment.id,
                        status: this.mapAsaasStatus(asaasPayment.status)
                    }
                });

                await this.applyCompletionIfAlreadySettled(payment);

                console.info(`[createCreditCardPayment] Pagamento em cartão criado - PaymentId: ${payment.id}, Asaas PaymentId: ${asaasPayment.id}, Status: ${asaasPayment.status}`);

                return {
                    paymentId: payment.id,
                    asaas_payment_id: asaasPayment.id,
                    status: payment.status,
                    phase,
                    payment: {
                        id: asaasPayment.id,
                        status: asaasPayment.status,
                        brand: asaasPayment.creditCard?.creditCardBrand,
                        lastDigits: asaasPayment.creditCard?.creditCardNumber
                    }
                };
            } catch (innerError) {
                await this.releaseReservation(reserved.id);
                throw innerError;
            }
        } catch (error: any) {
            if (findKnownPaymentErrorPrefix(error)) throw error;
            const message = extractAsaasErrorMessage(error, 'Erro ao processar pagamento com cartão de crédito');
            console.error(`[createCreditCardPayment] Erro ao criar pagamento em cartão para venda ${params.saleId}:`, message);
            throw new Error(message);
        }
    }

    /**
     * Valida a elegibilidade da parcela final (70%) — entrada já confirmada, pagamento final
     * ainda não concluído, sem outra cobrança final pendente — e já retorna o valor restante a
     * cobrar nessa mesma consulta. `errorPrefix` preserva o código de erro específico do
     * endpoint chamador (ex.: FINAL_BOLETO_BLOCKED vs FINAL_PAYMENT_BLOCKED).
     */
    private async prepareFinalPayment(saleId: string, errorPrefix: string): Promise<number> {
        const sale = await this.prisma.saleData.findUnique({
            where: { id: saleId },
            include: { boughtProducts: true, Payment: true },
        });
        if (!sale) throw new Error(`Venda (id=${saleId}) não encontrada`);
        if (!sale.downPaymentCompleted) throw new Error(`${errorPrefix}:A entrada de 30% ainda não foi confirmada`);
        if (sale.paymentCompleted) throw new Error(`${errorPrefix}:O pagamento final já foi concluído`);

        const alreadyHasPendingFinal = sale.Payment.some(p => p.phase === 'final_payment' && p.status === 'pending');
        if (alreadyHasPendingFinal) {
            throw new Error(`${errorPrefix}:Já existe uma cobrança final pendente para esta venda`);
        }

        const originalTotal = sale.boughtProducts.reduce((sum, bp) => sum + bp.value, 0) + Number(sale.transportValue);
        const adjustedContractTotal = sale.adjustedContractTotal !== null ? Number(sale.adjustedContractTotal) : null;
        const contractTotal = adjustedContractTotal ?? originalTotal;
        const totalDownPaid = sale.Payment
            .filter(p => p.phase === 'down_payment' && p.status === 'completed')
            .reduce((sum, p) => sum + p.amount, 0);

        return Math.max(0, contractTotal - totalDownPaid);
    }

    /**
     * Calcula o valor da segunda parcela com base no total contratado menos o que já foi pago como entrada.
     * O operador pode usar esse valor para decidir se ajusta manualmente antes de emitir o boleto final.
     */
    async getFinalInstallmentAmount(saleId: string) {
        const sale = await this.prisma.saleData.findUnique({
            where: { id: saleId },
            include: {
                boughtProducts: true,
                Payment: true,
            },
        });

        if (!sale) throw new Error(`Venda (id=${saleId}) não encontrada`);

        if (!sale.downPaymentCompleted) {
            throw new Error('FINAL_INSTALLMENT_NOT_AVAILABLE:A entrada de 30% ainda não foi confirmada');
        }

        // Usa o total ajustado pela pesagem se disponível; caso contrário usa o total original do contrato
        const originalTotal = sale.boughtProducts.reduce((sum, bp) => sum + bp.value, 0) + Number(sale.transportValue);
        const adjustedContractTotal = sale.adjustedContractTotal !== null
            ? Number(sale.adjustedContractTotal)
            : null;
        const contractTotal = adjustedContractTotal ?? originalTotal;

        const totalDownPaid = sale.Payment
            .filter(p => p.phase === 'down_payment' && p.status === 'completed')
            .reduce((sum, p) => sum + p.amount, 0);

        const finalAmount = Math.max(0, contractTotal - totalDownPaid);

        return {
            saleId,
            originalTotal,
            contractTotal,
            adjustedByWeight: adjustedContractTotal !== null,
            totalDownPaid,
            finalAmount,
            cargoWeightKg: sale.cargoWeightKg ? Number(sale.cargoWeightKg) : null,
            weightRegistered: !!sale.cargoWeightKg,
        };
    }

    /**
     * Cria o boleto da segunda parcela (70%).
     * A segunda parcela é SEMPRE boleto por definição de negócio.
     * `amount` explícito (ajuste manual pelo peso real da carga) só deve ser aceito pelo
     * controller quando o chamador for admin — aqui ele apenas substitui o valor calculado,
     * mas a elegibilidade (entrada confirmada, sem pendência) é sempre verificada.
     * Checa reaproveitamento ANTES da validação de elegibilidade — igual aos demais métodos
     * de criação — para que um retry de uma resposta perdida reutilize o boleto já emitido em
     * vez de ser bloqueado por "já existe cobrança final pendente".
     */
    async createFinalBoleto(params: {
        saleId: string;
        paymentMethodId: string;
        amount?: number;
        expirationDays?: number;
    }) {
        const existing = await this.findExistingAttempt(params.saleId, 'final_payment');
        if (existing) {
            console.info(`[createFinalBoleto] Boleto final já existente para venda ${params.saleId} — reaproveitando em vez de criar outro.`);
            return await this.reuseOrRetrySignal(existing, 'final_payment');
        }

        const computedAmount = await this.prepareFinalPayment(params.saleId, 'FINAL_BOLETO_BLOCKED');
        const amount = params.amount ?? computedAmount;

        if (amount <= 0) throw new Error('FINAL_BOLETO_BLOCKED:Valor calculado para o boleto final é zero ou negativo');

        return this.createBoletoCharge({
            saleId: params.saleId,
            paymentMethodId: params.paymentMethodId,
            amount,
            expirationDays: params.expirationDays,
            phase: 'final_payment',
        });
    }

    /**
     * Cancela todos os pagamentos pendentes de uma venda no banco de dados.
     * Usado ao trocar a forma de pagamento antes da entrada ser confirmada.
     */
    async cancelPendingPaymentsBySale(saleId: string): Promise<number> {
        const result = await this.prisma.payment.updateMany({
            where: { saleId, status: 'pending' },
            data: { status: 'cancelled', updatedAt: new Date() },
        });
        console.info(`[cancelPendingPaymentsBySale] ${result.count} pagamento(s) pendente(s) cancelado(s) para venda ${saleId}`);
        return result.count;
    }

    async updatePayment(paymentId: string, data: Partial<Payment>) {
        return this.prisma.payment.update({
            where: { id: paymentId },
            data
        });
    }

    /**
     * Aplica as atualizações atomicamente no Payment e SaleData após confirmação.
     * Respeita a fase: down_payment → downPaymentCompleted; final_payment/full → paymentCompleted.
     * Independente do gateway — recebe apenas o status já mapeado para o vocabulário interno.
     */
    private async applyPaymentCompletion(
        tx: Omit<PrismaClient, '$connect' | '$disconnect' | '$on' | '$transaction' | '$use' | '$extends'>,
        paymentRecord: Payment,
        newStatus: string,
        asaasPaymentId?: string
    ) {
        await tx.payment.update({
            where: { id: paymentRecord.id },
            data: {
                status: newStatus,
                ...(asaasPaymentId && { asaas_payment_id: asaasPaymentId }),
                updatedAt: new Date()
            }
        });

        if (newStatus === 'completed') {
            const statusChangedAt = new Date();
            if (paymentRecord.phase === 'down_payment') {
                console.info(`[applyPaymentCompletion] Entrada confirmada para venda ${paymentRecord.saleId}`);
                await tx.saleData.update({
                    where: { id: paymentRecord.saleId },
                    data: { downPaymentCompleted: true, status: 'Entrada confirmada', statusChangedAt },
                });
            } else if (paymentRecord.phase === 'full') {
                // Pagamento único: quita entrada e total ao mesmo tempo
                console.info(`[applyPaymentCompletion] Pagamento único (full) confirmado para venda ${paymentRecord.saleId}`);
                await tx.saleData.update({
                    where: { id: paymentRecord.saleId },
                    data: { downPaymentCompleted: true, paymentCompleted: true, status: 'Concluído', statusChangedAt },
                });
            } else {
                // final_payment
                console.info(`[applyPaymentCompletion] Pagamento final confirmado para venda ${paymentRecord.saleId}`);
                await tx.saleData.update({
                    where: { id: paymentRecord.saleId },
                    data: { paymentCompleted: true, status: 'Concluído', statusChangedAt },
                });
            }
        } else if (REVERSAL_STATUSES.includes(newStatus) && paymentRecord.status === 'completed') {
            // Reembolso/estorno de um pagamento que já estava confirmado: sem isso, a venda
            // continuaria marcada como paga mesmo com o dinheiro devolvido, e verificações de
            // negócio posteriores (liberação de colheita, conclusão de contrato) operariam
            // sobre um pagamento que não existe mais.
            console.info(`[applyPaymentCompletion] Pagamento ${paymentRecord.id} revertido (completed -> ${newStatus}) — recalculando status de pagamento da venda ${paymentRecord.saleId}`);
            await this.reverseSalePaymentFlags(tx, paymentRecord.saleId, paymentRecord.phase);
        }
    }

    /**
     * Recalcula downPaymentCompleted/paymentCompleted a partir dos pagamentos 'completed'
     * restantes da venda, após um reembolso/estorno desfazer um pagamento que estava
     * confirmado. Não toca no campo `status` (texto livre) — a venda pode já ter avançado
     * para outras etapas (envio, entrega) que um reembolso não deve reescrever automaticamente;
     * só os sinalizadores booleanos que o restante do sistema usa para liberar/bloquear ações
     * financeiras são corrigidos aqui.
     */
    private async reverseSalePaymentFlags(
        tx: Omit<PrismaClient, '$connect' | '$disconnect' | '$on' | '$transaction' | '$use' | '$extends'>,
        saleId: string,
        reversedPhase: string
    ): Promise<void> {
        if (reversedPhase === 'down_payment' || reversedPhase === 'full') {
            const stillCompleted = await tx.payment.findFirst({
                where: { saleId, status: 'completed', phase: { in: ['down_payment', 'full'] } },
            });
            if (!stillCompleted) {
                await tx.saleData.update({ where: { id: saleId }, data: { downPaymentCompleted: false } });
            }
        }
        if (reversedPhase === 'final_payment' || reversedPhase === 'full') {
            const stillCompleted = await tx.payment.findFirst({
                where: { saleId, status: 'completed', phase: { in: ['final_payment', 'full'] } },
            });
            if (!stillCompleted) {
                await tx.saleData.update({ where: { id: saleId }, data: { paymentCompleted: false } });
            }
        }
    }

    /**
     * Processa notificações de webhook do Asaas. O payload já vem com o objeto `payment`
     * completo (id, status, externalReference), sem necessidade de consulta adicional.
     * `receivedToken` é o header `asaas-access-token`, validado contra ASAAS_WEBHOOK_TOKEN.
     */
    async processWebhook(payload: any, receivedToken?: string) {
        // Falha fechada: sem token configurado no ambiente, nenhuma requisição é aceita como
        // autenticada (um deploy com segredo ausente não pode abrir a validação para todo mundo).
        const expectedToken = process.env.ASAAS_WEBHOOK_TOKEN;
        if (!expectedToken || receivedToken !== expectedToken) {
            console.warn('[Webhook] Token de autenticação (asaas-access-token) inválido ou ausente');
            throw new Error('WEBHOOK_UNAUTHORIZED:Token de webhook inválido');
        }

        const event = payload?.event;
        const paymentPayload = payload?.payment;
        const asaasPaymentId = paymentPayload?.id;
        const asaasStatus = paymentPayload?.status;

        console.info(`[Webhook] Recebido evento ${event} - Asaas PaymentId: ${asaasPaymentId}`);

        if (!event || !asaasPaymentId || !asaasStatus) {
            console.warn('[Webhook] Payload sem event/payment.id/payment.status válido');
            throw new Error('WEBHOOK_INVALID_PAYLOAD:Webhook sem dados de pagamento válidos');
        }

        // Fora do try/catch que antes mascarava tudo: uma falha de banco/infra aqui precisa
        // propagar como erro real (-> 5xx no controller) para que o Asaas tente novamente.
        // Engolir isso como um retorno normal fazia o controller responder 200 mesmo quando a
        // atualização local falhou, deixando o pagamento/venda com estado obsoleto para sempre.

        // Correlação SEMPRE pelo asaas_payment_id exato — nunca por saleId isolado: uma
        // venda pode ter várias tentativas/fases, e um webhook atrasado de uma cobrança
        // antiga poderia, por esse fallback, confirmar a tentativa mais recente errada.
        const paymentRecord = await this.prisma.payment.findFirst({
            where: { asaas_payment_id: asaasPaymentId },
            orderBy: { createdAt: 'desc' },
        });

        if (!paymentRecord) {
            // Pode ser uma corrida real: o Asaas notifica quase na hora em que cria a cobrança,
            // antes da nossa linha local ganhar o asaas_payment_id (o POST /payments responde,
            // mas o UPDATE local ainda não terminou — ou no caso do PIX, ainda falta buscar o
            // QR Code antes). Devolver 200 aqui faria o Asaas desistir e nunca mais tentar, e a
            // transição ficaria perdida até o poller alcançar (minutos depois, só se já tiver
            // asaas_payment_id). Sinaliza como falha retentável em vez de sucesso.
            console.warn(`[Webhook] Payment não encontrado para Asaas paymentId ${asaasPaymentId} (pode ser corrida com a criação local) — sinalizando para o Asaas tentar novamente`);
            throw new Error('WEBHOOK_PAYMENT_NOT_FOUND:Pagamento não encontrado no banco de dados');
        }

        const newStatus = this.mapAsaasStatus(asaasStatus);

        // Um evento atrasado/fora de ordem (ex.: PAYMENT_CREATED chegando depois de
        // PAYMENT_RECEIVED já ter sido processado) não pode regredir um status terminal de
        // volta para 'pending' — isso deixaria o Payment e a SaleData inconsistentes e faria
        // uma tentativa futura tratar a cobrança como se ainda estivesse ativa.
        if (TERMINAL_STATUSES.includes(paymentRecord.status) && newStatus === 'pending') {
            console.warn(`[Webhook] Ignorando transição regressiva ${paymentRecord.status} -> pending para o pagamento ${paymentRecord.id} (evento ${event} atrasado/fora de ordem)`);
            return {
                success: true,
                paymentId: paymentRecord.id,
                saleId: paymentRecord.saleId,
                phase: paymentRecord.phase,
                status: paymentRecord.status,
                ignored: true,
                reason: 'STALE_EVENT',
                asaas_payment_id: asaasPaymentId,
                asaas_event: event,
                asaas_status: asaasStatus,
            };
        }

        if (paymentRecord.status !== newStatus) {
            console.info(`[Webhook] Atualizando pagamento ${paymentRecord.id}: ${paymentRecord.status} -> ${newStatus}`);
            try {
                await this.prisma.$transaction(async (tx) => {
                    await this.applyPaymentCompletion(tx, paymentRecord, newStatus, asaasPaymentId);
                });
            } catch (error: any) {
                console.error(`[Webhook] Falha ao aplicar atualização do pagamento ${paymentRecord.id}:`, error.message);
                throw new Error(`WEBHOOK_PROCESSING_FAILED:${error.message}`);
            }
            console.info(`[Webhook] Pagamento ${paymentRecord.id} atualizado com sucesso`);
        } else {
            console.info(`[Webhook] Status do pagamento ${paymentRecord.id} não mudou (${paymentRecord.status}), nenhuma atualização necessária`);
        }

        return {
            success: true,
            paymentId: paymentRecord.id,
            saleId: paymentRecord.saleId,
            phase: paymentRecord.phase,
            status: newStatus,
            asaas_payment_id: asaasPaymentId,
            asaas_event: event,
            asaas_status: asaasStatus,
        };
    }

    async syncPaymentStatus(paymentId: string): Promise<{ success: boolean; error?: string; [key: string]: any }> {
        try {
            const paymentRecord = await this.prisma.payment.findUnique({ where: { id: paymentId } });

            if (!paymentRecord) {
                return { error: 'Payment não encontrado no banco', success: false };
            }

            if (!paymentRecord.asaas_payment_id) {
                return {
                    success: false,
                    message: 'Pagamento ainda não possui referência no Asaas',
                    current_status: paymentRecord.status,
                };
            }

            const { data: asaasPayment } = await asaasClient.get(`/payments/${paymentRecord.asaas_payment_id}`);
            const newStatus = this.mapAsaasStatus(asaasPayment.status);
            console.info(`[syncPaymentStatus] Sincronizando pagamento ${paymentRecord.id}: ${paymentRecord.status} -> ${newStatus}`);

            const updatedPayment = await this.prisma.$transaction(async (tx) => {
                await this.applyPaymentCompletion(tx, paymentRecord, newStatus, asaasPayment.id);
                return tx.payment.findUnique({ where: { id: paymentRecord.id } });
            });

            console.info(`[syncPaymentStatus] Pagamento ${paymentRecord.id} sincronizado com sucesso`);

            return {
                success: true,
                updated: true,
                payment: {
                    id: updatedPayment?.id,
                    status: updatedPayment?.status,
                    phase: updatedPayment?.phase,
                    asaas_payment_id: updatedPayment?.asaas_payment_id,
                },
                asaas: {
                    id: asaasPayment.id,
                    status: asaasPayment.status,
                    value: asaasPayment.value,
                    paymentDate: asaasPayment.paymentDate,
                    dueDate: asaasPayment.dueDate,
                }
            };
        } catch (error: any) {
            const message = extractAsaasErrorMessage(error, String(error));
            console.error('Erro ao sincronizar status:', message);
            return { success: false, error: message };
        }
    }

    /**
     * Verifica todos os pagamentos pendentes com referência no Asaas e confirma os que foram pagos.
     * Chamado periodicamente pelo scheduler para tratar boletos (compensação não imediata).
     */
    async syncPendingOrderPayments(): Promise<{ checked: number; confirmed: number; errors: number }> {
        const pending = await this.prisma.payment.findMany({
            where: {
                status: 'pending',
                asaas_payment_id: { not: null },
            },
        });

        let confirmed = 0;
        let errors = 0;

        for (const paymentRecord of pending) {
            try {
                const { data: asaasPayment } = await asaasClient.get(`/payments/${paymentRecord.asaas_payment_id}`);
                const newStatus = this.mapAsaasStatus(asaasPayment.status);
                if (newStatus !== 'completed') continue;

                await this.prisma.$transaction(async (tx) => {
                    await this.applyPaymentCompletion(tx, paymentRecord, newStatus, asaasPayment.id);
                });

                console.info(`[syncPendingOrderPayments] Pagamento ${paymentRecord.id} confirmado (Asaas: ${paymentRecord.asaas_payment_id})`);
                confirmed++;
            } catch (err: any) {
                console.warn(`[syncPendingOrderPayments] Erro ao verificar pagamento ${paymentRecord.id}: ${err.message}`);
                errors++;
            }
        }

        console.info(`[syncPendingOrderPayments] Verificados: ${pending.length} | Confirmados: ${confirmed} | Erros: ${errors}`);
        return { checked: pending.length, confirmed, errors };
    }

    async debugPayment(paymentId: string) {
        try {
            const paymentRecord = await this.prisma.payment.findUnique({
                where: { id: paymentId },
                include: { sale: true }
            });

            if (!paymentRecord) {
                return { error: 'Payment não encontrado no banco' };
            }

            let asaasData: any = null;
            if (paymentRecord.asaas_payment_id) {
                try {
                    const { data } = await asaasClient.get(`/payments/${paymentRecord.asaas_payment_id}`);
                    asaasData = data;
                } catch (err: any) {
                    console.warn(`[debugPayment] Pagamento não encontrado no Asaas pelo asaas_payment_id: ${paymentRecord.asaas_payment_id}`);
                }
            }

            return { paymentRecord, asaasData, canSync: !!asaasData };
        } catch (error: any) {
            console.error('Erro no debug:', error);
            return { error: error.message };
        }
    }

    async cancelPixPayment(paymentId: string) {
        try {
            const paymentRecord = await this.prisma.payment.findUnique({
                where: { id: paymentId }
            });

            if (!paymentRecord) {
                return { error: "Payment não encontrado no banco", success: false };
            }

            if (paymentRecord.status !== 'pending') {
                return {
                    error: `Pagamento não pode ser cancelado. Status atual: ${paymentRecord.status}`,
                    success: false
                };
            }

            console.info(`[cancelPixPayment] Cancelando pagamento PIX ${paymentId}`);

            const updatedPayment = await this.prisma.payment.update({
                where: { id: paymentId },
                data: { status: 'cancelled', updatedAt: new Date() }
            });

            console.info(`[cancelPixPayment] Pagamento ${paymentId} cancelado com sucesso`);

            return { success: true, paymentId: updatedPayment.id, status: updatedPayment.status };
        } catch (error: any) {
            console.error('[cancelPixPayment] Erro ao cancelar pagamento:', error.message);
            return { success: false, error: error.message };
        }
    }

    async configureWebhook() {
        try {
            const webhookUrl = `${process.env.URL_BACKEND}/payment/webhook`;

            const { data } = await asaasClient.post('/webhooks', {
                name: 'Venda+ Agromarket',
                url: webhookUrl,
                email: process.env.ASAAS_WEBHOOK_EMAIL,
                enabled: true,
                interrupted: false,
                apiVersion: 3,
                authToken: process.env.ASAAS_WEBHOOK_TOKEN,
                sendType: 'SEQUENTIALLY',
                events: [
                    'PAYMENT_CREATED',
                    'PAYMENT_CONFIRMED',
                    'PAYMENT_RECEIVED',
                    'PAYMENT_OVERDUE',
                    'PAYMENT_DELETED',
                    'PAYMENT_REFUNDED',
                    'PAYMENT_REFUND_IN_PROGRESS',
                    'PAYMENT_CHARGEBACK_REQUESTED',
                ]
            });

            return data;
        } catch (error: any) {
            const message = extractAsaasErrorMessage(error, 'Erro ao configurar webhook');
            console.error('Erro ao configurar webhook:', message);
            throw new Error(message);
        }
    }
}
