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
            ...(address && {
                postalCode: address.cep,
                address: address.street,
                addressNumber: address.number,
                province: address.alias
            })
        });

        await this.prisma.user.update({
            where: { id: buyer.id },
            data: { asaas_customer_id: data.id }
        });

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
            'DUNNING_RECEIVED': 'pending'
        };
        return statusMap[asaasStatus] || 'pending';
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

            let amount = params.amount;
            if (phase === 'down_payment') {
                const calc = await this.calculateDownPaymentAmount(params.saleId);
                amount = calc.amount;
                console.info(`[createPreference] Valor da entrada calculado: ${calc.percent}% de R$${calc.contractTotal} = R$${amount}`);
            }

            const sale = await this.prisma.saleData.findUnique({ where: { id: params.saleId } });
            if (!sale) throw new Error(`Venda não encontrada: ${params.saleId}`);

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

            const payment = await this.prisma.payment.create({
                data: {
                    saleId: params.saleId,
                    paymentMethodId: params.paymentMethodId,
                    amount,
                    status: this.mapAsaasStatus(asaasPayment.status),
                    phase,
                    billingType: 'UNDEFINED',
                    asaas_customer_id: customerId,
                    asaas_payment_id: asaasPayment.id
                }
            });

            console.info(`[createPreference] Fatura criada com sucesso - PaymentId: ${payment.id}, Asaas PaymentId: ${asaasPayment.id}`);

            return {
                paymentId: payment.id,
                asaas_payment_id: asaasPayment.id,
                init_point: asaasPayment.invoiceUrl
            };
        } catch (error: any) {
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

    /** O Asaas não possui endpoint de listagem de métodos — retorna a lista estática suportada pelo sistema. */
    async getPaymentMethods() {
        return [
            { id: 'PIX', name: 'Pix', description: 'Pagamento instantâneo via QR Code ou copia e cola' },
            { id: 'BOLETO', name: 'Boleto bancário', description: 'Vencimento configurável, compensação em até 2 dias úteis' },
            { id: 'CREDIT_CARD', name: 'Cartão de crédito', description: 'Captura imediata via API, com opção de parcelamento' },
            { id: 'UNDEFINED', name: 'Fatura Asaas', description: 'Página hospedada pelo Asaas onde o comprador escolhe Pix, boleto ou cartão — único caminho para débito' },
        ];
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

            let amount = params.amount;
            if (phase === 'down_payment') {
                const calc = await this.calculateDownPaymentAmount(params.saleId);
                amount = calc.amount;
                console.info(`[createPixPayment] Valor da entrada calculado: ${calc.percent}% de R$${calc.contractTotal} = R$${amount}`);
            }

            const sale = await this.prisma.saleData.findUnique({ where: { id: params.saleId } });
            if (!sale) throw new Error(`Venda não encontrada: ${params.saleId}`);

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

            const payment = await this.prisma.payment.create({
                data: {
                    saleId: params.saleId,
                    paymentMethodId: params.paymentMethodId,
                    amount,
                    status: this.mapAsaasStatus(asaasPayment.status),
                    phase,
                    billingType: 'PIX',
                    asaas_customer_id: customerId,
                    asaas_payment_id: asaasPayment.id
                }
            });

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
        } catch (error: any) {
            const message = extractAsaasErrorMessage(error, 'Erro ao criar pagamento PIX');
            console.error(`[createPixPayment] Erro ao criar pagamento PIX para venda ${params.saleId}:`, message);
            throw new Error(message);
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

            let amount = params.amount;
            if (phase === 'down_payment') {
                const calc = await this.calculateDownPaymentAmount(params.saleId);
                amount = calc.amount;
                console.info(`[createBoletoPayment] Valor da entrada calculado: ${calc.percent}% de R$${calc.contractTotal} = R$${amount}`);
            }

            const sale = await this.prisma.saleData.findUnique({ where: { id: params.saleId } });
            if (!sale) throw new Error(`Venda não encontrada: ${params.saleId}`);

            const customerId = await this.ensureAsaasCustomer(sale.buyerId);

            const expirationDays = params.expirationDays || 3;
            const dueDateObj = new Date();
            dueDateObj.setDate(dueDateObj.getDate() + expirationDays);
            const dueDate = dueDateObj.toISOString().split('T')[0];

            const { data: asaasPayment } = await asaasClient.post('/payments', {
                customer: customerId,
                billingType: 'BOLETO',
                value: amount,
                dueDate,
                externalReference: params.saleId,
                description: this.buildPaymentDescription(sale.orderNumber, phase)
            });

            const payment = await this.prisma.payment.create({
                data: {
                    saleId: params.saleId,
                    paymentMethodId: params.paymentMethodId,
                    amount,
                    status: this.mapAsaasStatus(asaasPayment.status),
                    phase,
                    billingType: 'BOLETO',
                    asaas_customer_id: customerId,
                    asaas_payment_id: asaasPayment.id
                }
            });

            console.info(`[createBoletoPayment] Boleto criado com sucesso - PaymentId: ${payment.id}, Asaas PaymentId: ${asaasPayment.id}`);

            return {
                paymentId: payment.id,
                asaas_payment_id: asaasPayment.id,
                status: payment.status,
                phase,
                payment: {
                    id: asaasPayment.id,
                    status: asaasPayment.status,
                    ticket_url: asaasPayment.bankSlipUrl,
                    invoice_url: asaasPayment.invoiceUrl,
                    expiration_date: dueDate
                }
            };
        } catch (error: any) {
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

            let amount = params.amount;
            if (phase === 'down_payment') {
                const calc = await this.calculateDownPaymentAmount(params.saleId);
                amount = calc.amount;
                console.info(`[createCreditCardPayment] Valor da entrada calculado: ${calc.percent}% de R$${calc.contractTotal} = R$${amount}`);
            }

            const sale = await this.prisma.saleData.findUnique({ where: { id: params.saleId } });
            if (!sale) throw new Error(`Venda não encontrada: ${params.saleId}`);

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

            const payment = await this.prisma.payment.create({
                data: {
                    saleId: params.saleId,
                    paymentMethodId: params.paymentMethodId,
                    amount,
                    status: this.mapAsaasStatus(asaasPayment.status),
                    phase,
                    billingType: 'CREDIT_CARD',
                    asaas_customer_id: customerId,
                    asaas_payment_id: asaasPayment.id
                }
            });

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
        } catch (error: any) {
            const message = extractAsaasErrorMessage(error, 'Erro ao processar pagamento com cartão de crédito');
            console.error(`[createCreditCardPayment] Erro ao criar pagamento em cartão para venda ${params.saleId}:`, message);
            throw new Error(message);
        }
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
     * Se amount for informado explicitamente (ajuste por peso real), esse valor é usado.
     * Caso contrário, calcula automaticamente como contractTotal - downPaymentPaid.
     */
    async createFinalBoleto(params: {
        saleId: string;
        paymentMethodId: string;
        amount?: number;
        expirationDays?: number;
    }) {
        const sale = await this.prisma.saleData.findUnique({
            where: { id: params.saleId },
            include: { boughtProducts: true, Payment: true },
        });

        if (!sale) throw new Error(`Venda (id=${params.saleId}) não encontrada`);
        if (!sale.downPaymentCompleted) throw new Error('FINAL_BOLETO_BLOCKED:A entrada de 30% ainda não foi confirmada');
        if (sale.paymentCompleted) throw new Error('FINAL_BOLETO_BLOCKED:O pagamento final já foi concluído');

        const alreadyHasPendingFinal = sale.Payment.some(
            p => p.phase === 'final_payment' && p.status === 'pending'
        );
        if (alreadyHasPendingFinal) {
            throw new Error('FINAL_BOLETO_BLOCKED:Já existe um boleto final pendente para esta venda');
        }

        let amount = params.amount;
        if (amount === undefined) {
            // Prefere o total ajustado pela pesagem; caso contrário usa o total original
            const originalTotal = sale.boughtProducts.reduce((sum, bp) => sum + bp.value, 0) + Number(sale.transportValue);
            const adjustedContractTotal = sale.adjustedContractTotal !== null
                ? Number(sale.adjustedContractTotal)
                : null;
            const contractTotal = adjustedContractTotal ?? originalTotal;
            const totalDownPaid = sale.Payment
                .filter(p => p.phase === 'down_payment' && p.status === 'completed')
                .reduce((sum, p) => sum + p.amount, 0);
            amount = Math.max(0, contractTotal - totalDownPaid);
        }

        if (amount <= 0) throw new Error('FINAL_BOLETO_BLOCKED:Valor calculado para o boleto final é zero ou negativo');

        return this.createBoletoPayment({
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
        }
    }

    /**
     * Processa notificações de webhook do Asaas. O payload já vem com o objeto `payment`
     * completo (id, status, externalReference), sem necessidade de consulta adicional.
     * `receivedToken` é o header `asaas-access-token`, validado contra ASAAS_WEBHOOK_TOKEN.
     */
    async processWebhook(payload: any, receivedToken?: string) {
        try {
            const expectedToken = process.env.ASAAS_WEBHOOK_TOKEN;
            if (expectedToken && receivedToken !== expectedToken) {
                console.warn('[Webhook] Token de autenticação (asaas-access-token) inválido ou ausente');
                return { error: 'Token de webhook inválido' };
            }

            const event = payload?.event;
            const paymentPayload = payload?.payment;
            const asaasPaymentId = paymentPayload?.id;

            console.info(`[Webhook] Recebido evento ${event} - Asaas PaymentId: ${asaasPaymentId}`);

            if (!event || !asaasPaymentId) {
                console.warn('[Webhook] Payload sem event/payment.id válido');
                return { error: 'Webhook sem dados de pagamento válidos' };
            }

            let paymentRecord = await this.prisma.payment.findFirst({
                where: { asaas_payment_id: asaasPaymentId },
                orderBy: { createdAt: 'desc' },
            });

            if (!paymentRecord && paymentPayload.externalReference) {
                paymentRecord = await this.prisma.payment.findFirst({
                    where: { saleId: paymentPayload.externalReference },
                    orderBy: { createdAt: 'desc' },
                });
            }

            if (!paymentRecord) {
                console.error(`[Webhook] Payment não encontrado para Asaas paymentId ${asaasPaymentId}`);
                return { error: 'Pagamento não encontrado no banco de dados' };
            }

            const newStatus = this.mapAsaasStatus(paymentPayload.status);

            if (paymentRecord.status !== newStatus) {
                console.info(`[Webhook] Atualizando pagamento ${paymentRecord.id}: ${paymentRecord.status} -> ${newStatus}`);
                await this.prisma.$transaction(async (tx) => {
                    await this.applyPaymentCompletion(tx, paymentRecord!, newStatus, asaasPaymentId);
                });
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
                asaas_status: paymentPayload.status,
            };
        } catch (error: any) {
            console.error('Erro crítico no webhook:', error.message);
            console.error('Stack:', error.stack);
            return { error: 'Erro ao processar webhook', message: error.message };
        }
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
