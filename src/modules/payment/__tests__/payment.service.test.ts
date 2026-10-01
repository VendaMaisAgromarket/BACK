import { PrismaClient, Payment, SaleData, User } from '@prisma/client';
import { mockDeep, DeepMockProxy } from 'jest-mock-extended';

const mockAsaasPost = jest.fn();
const mockAsaasGet = jest.fn();

jest.mock('axios', () => ({
  __esModule: true,
  default: {
    create: jest.fn(() => ({ post: mockAsaasPost, get: mockAsaasGet })),
  },
}));

process.env.ASAAS_WEBHOOK_TOKEN = 'webhook-secret-token';
process.env.URL_BACKEND = 'https://api.vendamaisagro.com.br';

// Importado depois do jest.mock('axios', ...) e do setup de env vars,
// pois o cliente Asaas é instanciado no topo do módulo.
import { PaymentService } from '../payment.service';

function buildPayment(overrides: Partial<Payment> = {}): Payment {
  return {
    id: 'payment-1',
    saleId: 'sale-1',
    paymentMethodId: 'pm-1',
    amount: 100,
    status: 'pending',
    phase: 'full',
    mp_preference_id: null,
    mp_payment_id: null,
    mp_order_id: null,
    billingType: 'PIX',
    asaas_customer_id: 'cus_1',
    asaas_payment_id: 'pay_1',
    asaas_checkout_id: null,
    createdAt: new Date('2026-01-01'),
    updatedAt: new Date('2026-01-01'),
    ...overrides,
  };
}

function buildSale(overrides: Partial<SaleData> = {}): SaleData {
  return {
    id: 'sale-1',
    orderNumber: 1,
    transportTypeId: 'tt-1',
    createdAt: new Date('2026-01-01'),
    updatedAt: new Date('2026-01-01'),
    shippedAt: null,
    arrivedAt: null,
    transportValue: 10,
    productRating: 0,
    sellerRating: 0,
    status: 'Pedido realizado!',
    statusChangedAt: null,
    addressId: null,
    paymentMethodId: 'pm-1',
    buyerId: 'buyer-1',
    paymentCompleted: false,
    sellerApproved: null,
    cargoWeightKg: null,
    sellerProfile: null,
    packagingType: null,
    paymentType: null,
    paymentTermDays: null,
    downPaymentPercent: null,
    plannedHarvestDate: null,
    plannedPickupDate: null,
    plannedDeliveryDate: null,
    originalPlannedHarvestDate: null,
    originalPlannedPickupDate: null,
    originalPlannedDeliveryDate: null,
    actualDeliveryDate: null,
    technicalSpec: null,
    certifierRequired: null,
    downPaymentCompleted: false,
    weightDocumentId: null,
    adjustedContractTotal: null,
    penaltyApplied: false,
    penaltyAmount: null,
    penaltyReason: null,
    ...overrides,
  } as SaleData;
}

function buildUser(overrides: Partial<User> = {}): User {
  return {
    id: 'buyer-1',
    name: 'Comprador Teste',
    phone_number: '11999999999',
    email: 'comprador@teste.com',
    password: 'hash',
    cnpj: null,
    cpf: '12345678900',
    ccir: null,
    role: 'buyer',
    img: null,
    valid: true,
    asaas_customer_id: null,
    ...overrides,
  } as User;
}

describe('PaymentService', () => {
  let prisma: DeepMockProxy<PrismaClient>;
  let service: PaymentService;

  beforeEach(() => {
    prisma = mockDeep<PrismaClient>();
    prisma.$transaction.mockImplementation((cb: any) => cb(prisma));
    service = new PaymentService(prisma);
  });

  describe('ensureAsaasCustomer (via createPixPayment)', () => {
    it('cria um cliente no Asaas quando o comprador ainda não possui asaas_customer_id', async () => {
      prisma.saleData.findUnique.mockResolvedValue(buildSale());
      prisma.user.findUnique.mockResolvedValue({ ...buildUser(), addresses: [] } as any);
      mockAsaasPost.mockResolvedValueOnce({ data: { id: 'cus_new' } }); // /customers
      mockAsaasPost.mockResolvedValueOnce({ data: { id: 'pay_new', status: 'PENDING' } }); // /payments
      mockAsaasGet.mockResolvedValueOnce({ data: { payload: 'copia-e-cola', encodedImage: 'base64img', expirationDate: '2026-01-02' } });
      prisma.user.updateMany.mockResolvedValue({ count: 1 });
      prisma.payment.create.mockResolvedValue(buildPayment({ status: 'pending', asaas_payment_id: 'pay_new' }));

      await service.createPixPayment({
        saleId: 'sale-1',
        paymentMethodId: 'pm-1',
        amount: 100,
        email: 'comprador@teste.com',
      });

      expect(mockAsaasPost).toHaveBeenNthCalledWith(1, '/customers', expect.objectContaining({ cpfCnpj: '12345678900' }));
      // Não deve enviar `province` a partir do alias do endereço (bug de dado corrigido no review).
      expect(mockAsaasPost.mock.calls[0][1]).not.toHaveProperty('province');
      expect(prisma.user.updateMany).toHaveBeenCalledWith({
        where: { id: 'buyer-1', asaas_customer_id: null },
        data: { asaas_customer_id: 'cus_new' },
      });
    });

    it('reaproveita o asaas_customer_id existente sem criar um novo cliente', async () => {
      prisma.saleData.findUnique.mockResolvedValue(buildSale());
      prisma.user.findUnique.mockResolvedValue({ ...buildUser({ asaas_customer_id: 'cus_existing' }), addresses: [] } as any);
      mockAsaasPost.mockResolvedValueOnce({ data: { id: 'pay_new', status: 'PENDING' } }); // /payments
      mockAsaasGet.mockResolvedValueOnce({ data: { payload: 'x', encodedImage: 'y', expirationDate: '2026-01-02' } });
      prisma.payment.create.mockResolvedValue(buildPayment());

      await service.createPixPayment({
        saleId: 'sale-1',
        paymentMethodId: 'pm-1',
        amount: 100,
        email: 'comprador@teste.com',
      });

      expect(mockAsaasPost).toHaveBeenCalledTimes(1); // só o /payments, sem /customers
      expect(mockAsaasPost).toHaveBeenCalledWith('/payments', expect.objectContaining({ customer: 'cus_existing', billingType: 'PIX' }));
      expect(prisma.user.updateMany).not.toHaveBeenCalled();
    });

    it('não sobrescreve o asaas_customer_id quando uma requisição concorrente já cadastrou o cliente primeiro (race condition)', async () => {
      prisma.saleData.findUnique.mockResolvedValue(buildSale());
      prisma.user.findUnique
        .mockResolvedValueOnce({ ...buildUser(), addresses: [] } as any) // ensureAsaasCustomer: comprador ainda sem id
        .mockResolvedValueOnce(buildUser({ asaas_customer_id: 'cus_winner' })); // re-leitura após perder a corrida
      mockAsaasPost.mockResolvedValueOnce({ data: { id: 'cus_loser' } }); // /customers (criado, mas perde a corrida)
      mockAsaasPost.mockResolvedValueOnce({ data: { id: 'pay_new', status: 'PENDING' } }); // /payments
      mockAsaasGet.mockResolvedValueOnce({ data: { payload: 'x', encodedImage: 'y', expirationDate: '2026-01-02' } });
      prisma.user.updateMany.mockResolvedValue({ count: 0 }); // outra requisição já preencheu o campo primeiro
      prisma.payment.create.mockResolvedValue(buildPayment());

      await service.createPixPayment({
        saleId: 'sale-1',
        paymentMethodId: 'pm-1',
        amount: 100,
        email: 'comprador@teste.com',
      });

      // Usa o customerId do vencedor da corrida (cus_winner), não o criado por esta chamada (cus_loser).
      const paymentsCall = mockAsaasPost.mock.calls.find(([url]) => url === '/payments');
      expect(paymentsCall?.[1]).toMatchObject({ customer: 'cus_winner' });
    });
  });

  describe('createPixPayment — regra de negócio da entrada (30%)', () => {
    it('recalcula o valor server-side quando phase = down_payment, ignorando o amount enviado pelo cliente', async () => {
      const sale = buildSale({
        downPaymentPercent: null, // usa o default de 30%
      });
      prisma.saleData.findUnique
        .mockResolvedValueOnce({ ...sale, boughtProducts: [{ value: 1000 }] } as any) // calculateDownPaymentAmount
        .mockResolvedValueOnce(sale as any); // busca da venda para pegar buyerId
      prisma.user.findUnique.mockResolvedValue({ ...buildUser({ asaas_customer_id: 'cus_1' }), addresses: [] } as any);
      mockAsaasPost.mockResolvedValueOnce({ data: { id: 'pay_dp', status: 'PENDING' } });
      mockAsaasGet.mockResolvedValueOnce({ data: { payload: 'x', encodedImage: 'y', expirationDate: '2026-01-02' } });
      prisma.payment.create.mockResolvedValue(buildPayment({ amount: 303 })); // (1000 + 10 transporte) * 30% = 303

      await service.createPixPayment({
        saleId: 'sale-1',
        paymentMethodId: 'pm-1',
        amount: 999999, // valor arbitrário enviado pelo cliente — deve ser ignorado
        email: 'comprador@teste.com',
        phase: 'down_payment',
      });

      const paymentsCall = mockAsaasPost.mock.calls.find(([url]) => url === '/payments');
      expect(paymentsCall?.[1]).toMatchObject({ value: 303 });
      expect(prisma.payment.create).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ amount: 303, phase: 'down_payment' }) })
      );
    });
  });

  describe('createBoletoPayment', () => {
    it('usa expirationDays informado para calcular o dueDate e mapeia bankSlipUrl/invoiceUrl', async () => {
      prisma.saleData.findUnique.mockResolvedValue(buildSale());
      prisma.user.findUnique.mockResolvedValue({ ...buildUser({ asaas_customer_id: 'cus_1' }), addresses: [] } as any);
      mockAsaasPost.mockResolvedValueOnce({
        data: { id: 'pay_boleto', status: 'PENDING', bankSlipUrl: 'https://asaas.com/boleto/1', invoiceUrl: 'https://asaas.com/i/1' },
      });
      prisma.payment.create.mockResolvedValue(buildPayment({ billingType: 'BOLETO' }));

      const result = await service.createBoletoPayment({
        saleId: 'sale-1',
        paymentMethodId: 'pm-1',
        amount: 500,
        expirationDays: 5,
      });

      expect(mockAsaasPost).toHaveBeenCalledWith('/payments', expect.objectContaining({ billingType: 'BOLETO', value: 500 }));
      expect(result.payment.ticket_url).toBe('https://asaas.com/boleto/1');
      expect(result.payment.invoice_url).toBe('https://asaas.com/i/1');
    });
  });

  describe('createCreditCardPayment', () => {
    it('envia installmentCount/installmentValue apenas quando parcelado', async () => {
      prisma.saleData.findUnique.mockResolvedValue(buildSale());
      prisma.user.findUnique.mockResolvedValue({ ...buildUser({ asaas_customer_id: 'cus_1' }), addresses: [] } as any);
      mockAsaasPost.mockResolvedValueOnce({ data: { id: 'pay_cc', status: 'CONFIRMED', creditCard: { creditCardBrand: 'VISA', creditCardNumber: '1234' } } });
      prisma.payment.create.mockResolvedValue(buildPayment({ billingType: 'CREDIT_CARD', status: 'completed' }));

      await service.createCreditCardPayment({
        saleId: 'sale-1',
        paymentMethodId: 'pm-1',
        amount: 300,
        remoteIp: '127.0.0.1',
        installmentCount: 3,
        creditCard: { holderName: 'Fulano', number: '4111111111111111', expiryMonth: '12', expiryYear: '2030', ccv: '123' },
        creditCardHolderInfo: { name: 'Fulano', email: 'f@f.com', cpfCnpj: '12345678900', postalCode: '00000000', addressNumber: '10', phone: '11999999999' },
      });

      expect(mockAsaasPost).toHaveBeenCalledWith('/payments', expect.objectContaining({
        installmentCount: 3,
        installmentValue: 100,
      }));
    });

    it('não envia installmentCount quando o pagamento é em parcela única', async () => {
      prisma.saleData.findUnique.mockResolvedValue(buildSale());
      prisma.user.findUnique.mockResolvedValue({ ...buildUser({ asaas_customer_id: 'cus_1' }), addresses: [] } as any);
      mockAsaasPost.mockResolvedValueOnce({ data: { id: 'pay_cc2', status: 'CONFIRMED' } });
      prisma.payment.create.mockResolvedValue(buildPayment({ billingType: 'CREDIT_CARD', status: 'completed' }));

      await service.createCreditCardPayment({
        saleId: 'sale-1',
        paymentMethodId: 'pm-1',
        amount: 300,
        remoteIp: '127.0.0.1',
        creditCard: { holderName: 'Fulano', number: '4111111111111111', expiryMonth: '12', expiryYear: '2030', ccv: '123' },
        creditCardHolderInfo: { name: 'Fulano', email: 'f@f.com', cpfCnpj: '12345678900', postalCode: '00000000', addressNumber: '10', phone: '11999999999' },
      });

      const [, body] = mockAsaasPost.mock.calls[0];
      expect(body).not.toHaveProperty('installmentCount');
    });

    it('bloqueia phase=final_payment quando a entrada de 30% ainda não foi confirmada', async () => {
      prisma.saleData.findUnique.mockResolvedValue({
        ...buildSale({ downPaymentCompleted: false }),
        Payment: [],
      } as any);

      await expect(
        service.createCreditCardPayment({
          saleId: 'sale-1',
          paymentMethodId: 'pm-1',
          amount: 700,
          remoteIp: '127.0.0.1',
          phase: 'final_payment',
          creditCard: { holderName: 'Fulano', number: '4111111111111111', expiryMonth: '12', expiryYear: '2030', ccv: '123' },
          creditCardHolderInfo: { name: 'Fulano', email: 'f@f.com', cpfCnpj: '12345678900', postalCode: '00000000', addressNumber: '10', phone: '11999999999' },
        })
      ).rejects.toThrow('FINAL_PAYMENT_BLOCKED:A entrada de 30% ainda não foi confirmada');

      expect(mockAsaasPost).not.toHaveBeenCalled();
    });

    it('permite phase=final_payment quando a entrada já foi confirmada', async () => {
      prisma.saleData.findUnique.mockResolvedValue({
        ...buildSale({ downPaymentCompleted: true, paymentCompleted: false }),
        Payment: [],
      } as any);
      prisma.user.findUnique.mockResolvedValue({ ...buildUser({ asaas_customer_id: 'cus_1' }), addresses: [] } as any);
      mockAsaasPost.mockResolvedValueOnce({ data: { id: 'pay_final', status: 'CONFIRMED' } });
      prisma.payment.create.mockResolvedValue(buildPayment({ phase: 'final_payment', status: 'completed' }));

      await service.createCreditCardPayment({
        saleId: 'sale-1',
        paymentMethodId: 'pm-1',
        amount: 700,
        remoteIp: '127.0.0.1',
        phase: 'final_payment',
        creditCard: { holderName: 'Fulano', number: '4111111111111111', expiryMonth: '12', expiryYear: '2030', ccv: '123' },
        creditCardHolderInfo: { name: 'Fulano', email: 'f@f.com', cpfCnpj: '12345678900', postalCode: '00000000', addressNumber: '10', phone: '11999999999' },
      });

      expect(mockAsaasPost).toHaveBeenCalledWith('/payments', expect.objectContaining({ billingType: 'CREDIT_CARD' }));
    });
  });

  describe('getPaymentMethods', () => {
    it('retorna o paymentMethodId real (FK) da tabela local, não o billingType do Asaas', async () => {
      prisma.paymentMethod.findMany.mockResolvedValue([
        { id: 'uuid-pix', method: 'PIX' },
        { id: 'uuid-boleto', method: 'Boleto' },
        { id: 'uuid-debito', method: 'Cartão de Débito' },
      ] as any);

      const result = await service.getPaymentMethods();

      expect(result).toEqual([
        { id: 'uuid-pix', method: 'PIX', billingType: 'PIX' },
        { id: 'uuid-boleto', method: 'Boleto', billingType: 'BOLETO' },
        { id: 'uuid-debito', method: 'Cartão de Débito', billingType: 'UNDEFINED' },
      ]);
    });
  });

  describe('processWebhook', () => {
    it('rejeita (sem tocar no banco) quando o header asaas-access-token não corresponde ao configurado', async () => {
      await expect(
        service.processWebhook({ event: 'PAYMENT_RECEIVED', payment: { id: 'pay_1' } }, 'token-errado')
      ).rejects.toThrow('WEBHOOK_UNAUTHORIZED:Token de webhook inválido');

      expect(prisma.payment.findFirst).not.toHaveBeenCalled();
    });

    it('rejeita (fail-closed) quando ASAAS_WEBHOOK_TOKEN não está configurado no ambiente', async () => {
      const original = process.env.ASAAS_WEBHOOK_TOKEN;
      delete process.env.ASAAS_WEBHOOK_TOKEN;

      await expect(
        service.processWebhook({ event: 'PAYMENT_RECEIVED', payment: { id: 'pay_1' } }, 'qualquer-coisa')
      ).rejects.toThrow('WEBHOOK_UNAUTHORIZED:');

      process.env.ASAAS_WEBHOOK_TOKEN = original;
    });

    it('rejeita payload malformado (sem event ou payment.id)', async () => {
      await expect(
        service.processWebhook({ payment: { id: 'pay_1' } }, 'webhook-secret-token')
      ).rejects.toThrow('WEBHOOK_INVALID_PAYLOAD:');
    });

    it('confirma a entrada (down_payment) e marca downPaymentCompleted quando o evento é PAYMENT_RECEIVED', async () => {
      const payment = buildPayment({ phase: 'down_payment', status: 'pending', asaas_payment_id: 'pay_1' });
      prisma.payment.findFirst.mockResolvedValue(payment);

      const result = await service.processWebhook(
        { event: 'PAYMENT_RECEIVED', payment: { id: 'pay_1', status: 'RECEIVED', externalReference: 'sale-1' } },
        'webhook-secret-token'
      );

      expect(result).toMatchObject({ success: true, status: 'completed' });
      expect(prisma.payment.update).toHaveBeenCalledWith(expect.objectContaining({
        where: { id: 'payment-1' },
        data: expect.objectContaining({ status: 'completed' }),
      }));
      expect(prisma.saleData.update).toHaveBeenCalledWith({
        where: { id: 'sale-1' },
        data: expect.objectContaining({ downPaymentCompleted: true, status: 'Entrada confirmada' }),
      });
    });

    it('confirma pagamento full e marca downPaymentCompleted + paymentCompleted', async () => {
      const payment = buildPayment({ phase: 'full', status: 'pending' });
      prisma.payment.findFirst.mockResolvedValue(payment);

      await service.processWebhook(
        { event: 'PAYMENT_CONFIRMED', payment: { id: 'pay_1', status: 'CONFIRMED', externalReference: 'sale-1' } },
        'webhook-secret-token'
      );

      expect(prisma.saleData.update).toHaveBeenCalledWith({
        where: { id: 'sale-1' },
        data: expect.objectContaining({ downPaymentCompleted: true, paymentCompleted: true, status: 'Concluído' }),
      });
    });

    it('confirma parcela final (final_payment) marcando apenas paymentCompleted', async () => {
      const payment = buildPayment({ phase: 'final_payment', status: 'pending' });
      prisma.payment.findFirst.mockResolvedValue(payment);

      await service.processWebhook(
        { event: 'PAYMENT_RECEIVED', payment: { id: 'pay_1', status: 'RECEIVED', externalReference: 'sale-1' } },
        'webhook-secret-token'
      );

      expect(prisma.saleData.update).toHaveBeenCalledWith({
        where: { id: 'sale-1' },
        data: expect.objectContaining({ paymentCompleted: true, status: 'Concluído' }),
      });
    });

    it('mapeia uma cobrança excluída (status DELETED) para cancelled, não pending', async () => {
      const payment = buildPayment({ phase: 'full', status: 'pending' });
      prisma.payment.findFirst.mockResolvedValue(payment);

      const result = await service.processWebhook(
        { event: 'PAYMENT_DELETED', payment: { id: 'pay_1', status: 'DELETED', externalReference: 'sale-1' } },
        'webhook-secret-token'
      );

      expect(result).toMatchObject({ status: 'cancelled' });
      expect(prisma.payment.update).toHaveBeenCalledWith(expect.objectContaining({
        data: expect.objectContaining({ status: 'cancelled' }),
      }));
    });

    it('não toca no banco quando o status do Asaas não muda o status interno já armazenado', async () => {
      const payment = buildPayment({ phase: 'full', status: 'pending' });
      prisma.payment.findFirst.mockResolvedValue(payment);

      await service.processWebhook(
        { event: 'PAYMENT_CREATED', payment: { id: 'pay_1', status: 'PENDING', externalReference: 'sale-1' } },
        'webhook-secret-token'
      );

      expect(prisma.payment.update).not.toHaveBeenCalled();
      expect(prisma.saleData.update).not.toHaveBeenCalled();
    });

    it('retorna erro (200, sem lançar) quando o pagamento não é encontrado no banco local', async () => {
      prisma.payment.findFirst.mockResolvedValue(null);

      const result = await service.processWebhook(
        { event: 'PAYMENT_RECEIVED', payment: { id: 'pay_desconhecido', status: 'RECEIVED', externalReference: 'sale-x' } },
        'webhook-secret-token'
      );

      expect(result).toEqual({ error: 'Pagamento não encontrado no banco de dados' });
    });
  });

  describe('getFinalInstallmentAmount — regra 30/70', () => {
    it('bloqueia o cálculo enquanto a entrada não foi confirmada', async () => {
      prisma.saleData.findUnique.mockResolvedValue({
        ...buildSale({ downPaymentCompleted: false }),
        boughtProducts: [{ value: 1000 }],
        Payment: [],
      } as any);

      await expect(service.getFinalInstallmentAmount('sale-1')).rejects.toThrow('FINAL_INSTALLMENT_NOT_AVAILABLE:');
    });

    it('calcula 70% restante usando o total ajustado pelo peso real quando disponível', async () => {
      prisma.saleData.findUnique.mockResolvedValue({
        ...buildSale({ downPaymentCompleted: true, adjustedContractTotal: 900, transportValue: 0 }),
        boughtProducts: [{ value: 1000 }],
        Payment: [buildPayment({ phase: 'down_payment', status: 'completed', amount: 300 })],
      } as any);

      const result = await service.getFinalInstallmentAmount('sale-1');

      expect(result.contractTotal).toBe(900);
      expect(result.adjustedByWeight).toBe(true);
      expect(result.totalDownPaid).toBe(300);
      expect(result.finalAmount).toBe(600);
    });
  });

  describe('createFinalBoleto — bloqueios de negócio', () => {
    it('bloqueia quando já existe um boleto final pendente', async () => {
      prisma.saleData.findUnique.mockResolvedValue({
        ...buildSale({ downPaymentCompleted: true, paymentCompleted: false }),
        boughtProducts: [{ value: 1000 }],
        Payment: [buildPayment({ phase: 'final_payment', status: 'pending' })],
      } as any);

      await expect(
        service.createFinalBoleto({ saleId: 'sale-1', paymentMethodId: 'pm-1' })
      ).rejects.toThrow('FINAL_BOLETO_BLOCKED:Já existe um boleto final pendente para esta venda');
    });

    it('bloqueia quando o pagamento final já foi concluído', async () => {
      prisma.saleData.findUnique.mockResolvedValue({
        ...buildSale({ downPaymentCompleted: true, paymentCompleted: true }),
        boughtProducts: [{ value: 1000 }],
        Payment: [],
      } as any);

      await expect(
        service.createFinalBoleto({ saleId: 'sale-1', paymentMethodId: 'pm-1' })
      ).rejects.toThrow('FINAL_BOLETO_BLOCKED:O pagamento final já foi concluído');
    });
  });

  describe('syncPendingOrderPayments', () => {
    it('confirma apenas os pagamentos com status RECEIVED/CONFIRMED no Asaas e ignora os demais', async () => {
      const pending = [
        buildPayment({ id: 'p1', asaas_payment_id: 'pay_1' }),
        buildPayment({ id: 'p2', asaas_payment_id: 'pay_2' }),
      ];
      prisma.payment.findMany.mockResolvedValue(pending);
      mockAsaasGet
        .mockResolvedValueOnce({ data: { id: 'pay_1', status: 'RECEIVED' } })
        .mockResolvedValueOnce({ data: { id: 'pay_2', status: 'PENDING' } });

      const result = await service.syncPendingOrderPayments();

      expect(result).toEqual({ checked: 2, confirmed: 1, errors: 0 });
    });

    it('conta como erro quando a consulta ao Asaas falha, sem interromper o loop', async () => {
      const pending = [buildPayment({ id: 'p1', asaas_payment_id: 'pay_1' })];
      prisma.payment.findMany.mockResolvedValue(pending);
      mockAsaasGet.mockRejectedValueOnce(new Error('timeout'));

      const result = await service.syncPendingOrderPayments();

      expect(result).toEqual({ checked: 1, confirmed: 0, errors: 1 });
    });
  });

  describe('cancelPendingPaymentsBySale', () => {
    it('cancela todos os pagamentos pendentes da venda', async () => {
      prisma.payment.updateMany.mockResolvedValue({ count: 2 });

      const count = await service.cancelPendingPaymentsBySale('sale-1');

      expect(count).toBe(2);
      expect(prisma.payment.updateMany).toHaveBeenCalledWith({
        where: { saleId: 'sale-1', status: 'pending' },
        data: expect.objectContaining({ status: 'cancelled' }),
      });
    });
  });

  describe('cancelPixPayment', () => {
    it('não permite cancelar um pagamento que não está mais pendente', async () => {
      prisma.payment.findUnique.mockResolvedValue(buildPayment({ status: 'completed' }));

      const result = await service.cancelPixPayment('payment-1');

      expect(result).toEqual({ success: false, error: 'Pagamento não pode ser cancelado. Status atual: completed' });
      expect(prisma.payment.update).not.toHaveBeenCalled();
    });
  });
});
