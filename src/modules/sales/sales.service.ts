import { Prisma, PrismaClient } from "@prisma/client";
import { CreateSaleDataDto, SellerDecisionDto, UpdateSaleDataDto } from "./dto/create-sales.dto";
import { addBusinessDays, isWithinBusinessDays, lessThanHoursRemaining } from "../../lib/businessDays";
import { calculatePipelineStage, PipelineStageResult } from "../../lib/pipelineStage";
import { NotificationService } from "../notification/notification.service";

/** P2025: o update com filtro além do id (compare-and-set) não encontrou a linha no estado esperado. */
function isRecordNotFound(error: unknown): boolean {
  return (error as { code?: string } | null)?.code === "P2025";
}

export class SaleService {
  private readonly prisma: PrismaClient;
  private readonly notifications: NotificationService;

  constructor(prisma?: PrismaClient) {
    this.prisma = prisma || new PrismaClient();
    this.notifications = new NotificationService(this.prisma);
  }

  /**
   * Transição de status condicionada a uma regra de negócio avaliada NO MOMENTO DA ESCRITA (`guard`,
   * ex.: "ainda sem entrega registrada"), com incremento atômico de statusVersion. Devolve a versão
   * gravada por esta transição, ou null se o guard não casou (outra requisição chegou antes).
   * Precisa rodar numa transação: o UPDATE mantém o lock da linha até o commit, então a leitura logo
   * em seguida devolve exatamente a versão escrita aqui.
   */
  private async transitionStatus(
    tx: Prisma.TransactionClient,
    saleId: string,
    guard: Prisma.SaleDataWhereInput,
    data: Prisma.SaleDataUpdateManyMutationInput
  ): Promise<number | null> {
    const { count } = await tx.saleData.updateMany({
      where: { id: saleId, ...guard },
      data: { ...data, statusVersion: { increment: 1 } },
    });
    if (count === 0) return null;
    const row = await tx.saleData.findUnique({ where: { id: saleId }, select: { statusVersion: true } });
    return row!.statusVersion;
  }

  async create(data: CreateSaleDataDto) {
    try {
      const buyer = await this.prisma.user.findUnique({ where: { id: data.buyerId } });
      if (!buyer) throw new Error(`Usuário comprador (buyerId=${data.buyerId}) não encontrado`);

      if (data.addressId) {
        const address = await this.prisma.address.findUnique({ where: { id: data.addressId } });
        if (!address) throw new Error(`Endereço (addressId=${data.addressId}) não encontrado`);
      }

      const paymentMethod = await this.prisma.paymentMethod.findUnique({ where: { id: data.paymentMethodId } });
      if (!paymentMethod) throw new Error(`Método de pagamento (paymentMethodId=${data.paymentMethodId}) não encontrado`);

      const transportType = await this.prisma.transportTypes.findUnique({ where: { id: data.transportTypeId } });
      if (!transportType) throw new Error(`Tipo de transporte (transportTypeId=${data.transportTypeId}) não encontrado`);

      if (!data.boughtProducts || data.boughtProducts.length === 0) {
        throw new Error("É necessário informar pelo menos um produto para comprar");
      }

      const boughtProductsWithCalculatedValue = await Promise.all(
        data.boughtProducts.map(async (boughtProduct) => {
          const product = await this.prisma.product.findUnique({
            where: { id: boughtProduct.productId },
            select: { id: true, name: true, stock: true, status: true },
          });
          if (!product) throw new Error(`Produto (productId=${boughtProduct.productId}) não encontrado`);
          if (!product.status) throw new Error(`Produto "${product.name}" não está ativo`);

          const sellingUnitProduct = await this.prisma.sellingUnitProduct.findUnique({
            where: { id: boughtProduct.sellingUnitProductId },
            include: {
              unit: { select: { unit: true, title: true } },
              product: { select: { id: true, name: true } }
            },
          });

          if (!sellingUnitProduct) {
            throw new Error(
              `Unidade de venda (sellingUnitProductId=${boughtProduct.sellingUnitProductId}) não encontrada`
            );
          }

          if (sellingUnitProduct.productId !== boughtProduct.productId) {
            throw new Error(
              `A unidade de venda ${boughtProduct.sellingUnitProductId} não pertence ao produto ${boughtProduct.productId}`
            );
          }

          const calculatedValue = sellingUnitProduct.minPrice * boughtProduct.amount;
          return {
            productId: boughtProduct.productId,
            sellingUnitProductId: sellingUnitProduct.id,
            value: calculatedValue,
            amount: boughtProduct.amount,
          };
        })
      );

      const sale = await this.prisma.saleData.create({
        data: {
          transportTypeId: data.transportTypeId,
          createdAt: data.createdAt ?? new Date(),
          shippedAt: data.shippedAt,
          arrivedAt: data.arrivedAt,
          transportValue: data.transportValue,
          cargoWeightKg: data.cargoWeightKg,
          productRating: data.productRating ?? 0,
          sellerRating: data.sellerRating ?? 0,
          status: data.status ?? "Pedido realizado!",
          statusChangedAt: data.createdAt ?? new Date(),
          sellerApproved: data.sellerApproved ?? null,
          addressId: data.addressId ?? null,
          paymentMethodId: data.paymentMethodId,
          buyerId: data.buyerId,
          paymentCompleted: data.paymentCompleted ?? false,
          sellerProfile: data.sellerProfile,
          packagingType: data.packagingType,
          paymentType: data.paymentType,
          paymentTermDays: data.paymentTermDays,
          downPaymentPercent: data.downPaymentPercent,
          plannedHarvestDate: data.plannedHarvestDate,
          plannedPickupDate: data.plannedPickupDate,
          plannedDeliveryDate: data.plannedDeliveryDate,
          technicalSpec: data.technicalSpec,
          certifierRequired: data.certifierRequired,
          boughtProducts: { create: boughtProductsWithCalculatedValue },
        },
        include: {
          boughtProducts: {
            include: {
              product: { select: { id: true, name: true, category: true, variety: true, sellerId: true } },
              sellingUnitProduct: { include: { unit: { select: { unit: true, title: true } } } },
            },
          },
          buyer: { select: { id: true, name: true, email: true } },
          shippingAddress: true,
          paymentMethod: true,
          transportType: true,
        },
      });

      await this.notifications.notifyNewOrder(sale.id);
      return sale;
    } catch (error) {
      console.error("Erro ao criar venda:", error);
      throw error;
    }
  }

  /** Retorna comprador e vendedores envolvidos numa venda, para checagem de autorização. */
  async getSaleParties(saleId: string): Promise<{ buyerId: string; sellerIds: string[] } | null> {
    const sale = await this.prisma.saleData.findUnique({
      where: { id: saleId },
      select: {
        buyerId: true,
        boughtProducts: { select: { product: { select: { sellerId: true } } } },
      },
    });
    if (!sale) return null;

    return {
      buyerId: sale.buyerId,
      sellerIds: sale.boughtProducts.map((bp) => bp.product.sellerId),
    };
  }

  async getAll() {
    return this.prisma.saleData.findMany({
      include: { boughtProducts: true },
    });
  }

  private computePaymentStatus(sale: {
    downPaymentCompleted: boolean;
    paymentCompleted: boolean;
    Payment?: { phase: string; status: string }[];
  }) {
    const payments = sale.Payment ?? [];
    return {
      firstInstallmentPaid:
        sale.downPaymentCompleted ||
        payments.some(p => (p.phase === 'down_payment' || p.phase === 'full') && p.status === 'completed'),
      finalPaymentPaid:
        sale.paymentCompleted ||
        payments.some(p => (p.phase === 'final_payment' || p.phase === 'full') && p.status === 'completed'),
    };
  }

  async getById(id: string) {
    return await this.prisma.$transaction(async (tx) => {
      const sale = await tx.saleData.findUnique({
        where: { id },
        include: {
          boughtProducts: { include: { product: { select: { sellerId: true } } } },
          Payment: true,
        },
      });

      if (!sale) return null;
      return { ...sale, ...this.computePaymentStatus(sale) };
    });
  }

  async getSalesForProducer(userId: string) {
    try {
      const sales = await this.prisma.saleData.findMany({
        where: { boughtProducts: { some: { product: { sellerId: userId } } } },
        include: {
          buyer: true,
          boughtProducts: { include: { product: { include: { seller: true } }, sellingUnitProduct: { include: { unit: true } } } },
          shippingAddress: true,
          paymentMethod: true,
          transportType: true,
          Payment: true,
        },
        orderBy: { createdAt: "desc" },
      });

      return sales.map((sale) => ({
        ...sale,
        buyer: {
          id: sale.buyer.id,
          name: sale.buyer.name,
          email: sale.buyer.email,
          phone_number: sale.buyer.phone_number,
          cpf: sale.buyer.cpf,
        },
        boughtProducts: sale.boughtProducts.map((bp) => ({
          ...bp,
          product: {
            id: bp.product.id,
            name: bp.product.name,
            category: bp.product.category,
            variety: bp.product.variety,
            description: bp.product.description,
            images_Path: bp.product.images_Path,
            productRating: bp.product.productRating,
            sellerId: bp.product.sellerId,
            seller: {
              id: bp.product.seller.id,
              name: bp.product.seller.name,
              email: bp.product.seller.email,
              phone_number: bp.product.seller.phone_number,
            },
          },
          sellingUnitProduct: {
            id: bp.sellingUnitProduct.id,
            minPrice: bp.sellingUnitProduct.minPrice,
            unitId: bp.sellingUnitProduct.unitId,
            unit: {
              id: bp.sellingUnitProduct.unit.id,
              unit: bp.sellingUnitProduct.unit.unit,
              title: bp.sellingUnitProduct.unit.title,
            },
          },
        })),
        shippingAddress: sale.shippingAddress
          ? {
            id: sale.shippingAddress.id,
            addressee: sale.shippingAddress.addressee,
            phone_number_addressee: sale.shippingAddress.phone_number_addressee,
            street: sale.shippingAddress.street,
            number: sale.shippingAddress.number,
            complement: sale.shippingAddress.complement,
            city: sale.shippingAddress.city,
            uf: sale.shippingAddress.uf,
            cep: sale.shippingAddress.cep,
          }
          : null,
        paymentMethod: sale.paymentMethod ? { id: sale.paymentMethod.id, method: sale.paymentMethod.method } : null,
        transportType: sale.transportType
          ? { id: sale.transportType.id, type: sale.transportType.type, valueFreight: sale.transportType.valueFreight }
          : null,
        ...this.computePaymentStatus(sale),
      }));
    } catch (error) {
      console.error("Erro ao buscar vendas do produtor:", error);
      throw error;
    }
  }

  async getPurchasesForBuyer(userId: string) {
    try {
      const user = await this.prisma.user.findUnique({
        where: { id: userId },
        select: { id: true, name: true, email: true, phone_number: true },
      });

      if (!user) throw new Error(`Usuário (userId=${userId}) não encontrado`);

      const purchases = await this.prisma.saleData.findMany({
        where: { buyerId: userId },
        include: {
          buyer: true,
          boughtProducts: { include: { product: { include: { seller: true } }, sellingUnitProduct: { include: { unit: true } } } },
          shippingAddress: true,
          paymentMethod: true,
          transportType: true,
          Payment: true,
        },
        orderBy: { createdAt: "desc" },
      });

      return purchases.map((purchase) => ({
        ...purchase,
        buyer: {
          id: purchase.buyer.id,
          name: purchase.buyer.name,
          email: purchase.buyer.email,
          phone_number: purchase.buyer.phone_number,
          cpf: purchase.buyer.cpf,
        },
        boughtProducts: purchase.boughtProducts.map((bp) => ({
          ...bp,
          product: {
            id: bp.product.id,
            name: bp.product.name,
            category: bp.product.category,
            variety: bp.product.variety,
            images_Path: bp.product.images_Path,
            description: bp.product.description,
            productRating: bp.product.productRating,
            sellerId: bp.product.sellerId,
            harvestAt: bp.product.harvestAt,
            stock: bp.product.stock,
            seller: {
              id: bp.product.seller.id,
              name: bp.product.seller.name,
              email: bp.product.seller.email,
              phone_number: bp.product.seller.phone_number,
            },
          },
          sellingUnitProduct: {
            id: bp.sellingUnitProduct.id,
            minPrice: bp.sellingUnitProduct.minPrice,
            unitId: bp.sellingUnitProduct.unitId,
            unit: {
              id: bp.sellingUnitProduct.unit.id,
              unit: bp.sellingUnitProduct.unit.unit,
              title: bp.sellingUnitProduct.unit.title,
            },
          },
        })),
        shippingAddress: purchase.shippingAddress
          ? {
            id: purchase.shippingAddress.id,
            addressee: purchase.shippingAddress.addressee,
            phone_number_addressee: purchase.shippingAddress.phone_number_addressee,
            street: purchase.shippingAddress.street,
            number: purchase.shippingAddress.number,
            complement: purchase.shippingAddress.complement,
            city: purchase.shippingAddress.city,
            uf: purchase.shippingAddress.uf,
            cep: purchase.shippingAddress.cep,
          }
          : null,
        paymentMethod: purchase.paymentMethod ? { id: purchase.paymentMethod.id, method: purchase.paymentMethod.method } : null,
        transportType: purchase.transportType
          ? { id: purchase.transportType.id, type: purchase.transportType.type, valueFreight: purchase.transportType.valueFreight }
          : null,
        ...this.computePaymentStatus(purchase),
      }));
    } catch (error) {
      console.error("Erro ao buscar compras do usuário:", error);
      throw error;
    }
  }

  async update(id: string, data: UpdateSaleDataDto) {
    // Guard: não permite trocar o método de pagamento após a entrada ser confirmada
    if (data.paymentMethodId !== undefined) {
      const current = await this.prisma.saleData.findUnique({
        where: { id },
        select: { downPaymentCompleted: true, paymentCompleted: true },
      });
      if (!current) throw new Error(`Venda (id=${id}) não encontrada`);
      if (current.paymentCompleted) throw new Error('PAYMENT_ALREADY_COMPLETED');
      if (current.downPaymentCompleted) throw new Error('DOWN_PAYMENT_ALREADY_COMPLETED');
    }

    const isReschedulingDates =
      data.plannedHarvestDate !== undefined ||
      data.plannedPickupDate !== undefined ||
      data.plannedDeliveryDate !== undefined;

    if (isReschedulingDates) {
      const current = await this.prisma.saleData.findUnique({
        where: { id },
        select: {
          plannedHarvestDate: true,
          plannedPickupDate: true,
          plannedDeliveryDate: true,
          originalPlannedHarvestDate: true,
          originalPlannedPickupDate: true,
          originalPlannedDeliveryDate: true,
        },
      });
      if (!current) throw new Error(`Venda (id=${id}) não encontrada`);

      // Trava de 24h (Cláusulas 7 e 9): bloqueia se restar < 24h para a execução atual
      const dateChecks: Array<{ current: Date | null; label: string }> = [
        { current: current.plannedHarvestDate, label: "colheita/disponibilização" },
        { current: current.plannedPickupDate, label: "retirada/embarque" },
        { current: current.plannedDeliveryDate, label: "entrega no destino" },
      ];
      for (const { current: existingDate, label } of dateChecks) {
        if (existingDate && lessThanHoursRemaining(existingDate, 24)) {
          throw new Error(`RESCHEDULE_BLOCKED_24H:${label}`);
        }
      }

      // Limite de 3 dias úteis da data original (Cláusula 9)
      const rescheduleChecks: Array<{
        newDate: Date | undefined;
        original: Date | null;
        label: string;
      }> = [
        {
          newDate: data.plannedHarvestDate,
          original: current.originalPlannedHarvestDate,
          label: "colheita/disponibilização",
        },
        {
          newDate: data.plannedPickupDate,
          original: current.originalPlannedPickupDate,
          label: "retirada/embarque",
        },
        {
          newDate: data.plannedDeliveryDate,
          original: current.originalPlannedDeliveryDate,
          label: "entrega no destino",
        },
      ];
      for (const { newDate, original, label } of rescheduleChecks) {
        if (newDate && original && !isWithinBusinessDays(original, newDate, 3)) {
          throw new Error(`RESCHEDULE_EXCEEDS_MAX_DAYS:${label}`);
        }
      }
    }

    // statusChangedAt só deve mudar quando o status efetivamente muda (evita resetar "dias na
    // etapa" em updates que reenviam o mesmo status já vigente).
    const needsStatusCheck = data.status !== undefined || data.sellerApproved !== undefined;
    const current = needsStatusCheck
      ? await this.prisma.saleData.findUnique({ where: { id }, select: { status: true, statusVersion: true } })
      : null;
    const currentStatus = current?.status;

    const updateData: any = {
      ...(data.transportTypeId !== undefined && { transportTypeId: data.transportTypeId }),
      ...(data.createdAt && { createdAt: data.createdAt }),
      ...(data.shippedAt && { shippedAt: data.shippedAt }),
      ...(data.arrivedAt && { arrivedAt: data.arrivedAt }),
      ...(data.transportValue !== undefined && { transportValue: data.transportValue }),
      ...(data.cargoWeightKg !== undefined && { cargoWeightKg: data.cargoWeightKg }),
      ...(data.productRating !== undefined && { productRating: data.productRating }),
      ...(data.sellerRating !== undefined && { sellerRating: data.sellerRating }),
      ...(data.sellerApproved !== undefined && { sellerApproved: data.sellerApproved }),
      ...(data.status !== undefined && { status: data.status }),
      ...(data.addressId !== undefined && { addressId: data.addressId }),
      ...(data.paymentMethodId !== undefined && { paymentMethodId: data.paymentMethodId }),
      ...(data.paymentCompleted !== undefined && { paymentCompleted: data.paymentCompleted }),
      ...(data.buyerId !== undefined && { buyerId: data.buyerId }),
      ...(data.sellerProfile !== undefined && { sellerProfile: data.sellerProfile }),
      ...(data.packagingType !== undefined && { packagingType: data.packagingType }),
      ...(data.paymentType !== undefined && { paymentType: data.paymentType }),
      ...(data.paymentTermDays !== undefined && { paymentTermDays: data.paymentTermDays }),
      ...(data.downPaymentPercent !== undefined && { downPaymentPercent: data.downPaymentPercent }),
      ...(data.plannedHarvestDate !== undefined && { plannedHarvestDate: data.plannedHarvestDate }),
      ...(data.plannedPickupDate !== undefined && { plannedPickupDate: data.plannedPickupDate }),
      ...(data.plannedDeliveryDate !== undefined && { plannedDeliveryDate: data.plannedDeliveryDate }),
      ...(data.actualDeliveryDate !== undefined && { actualDeliveryDate: data.actualDeliveryDate }),
      ...(data.technicalSpec !== undefined && { technicalSpec: data.technicalSpec }),
      ...(data.certifierRequired !== undefined && { certifierRequired: data.certifierRequired }),
    };

    // Sincronizar status quando sellerApproved vier no update
    if (data.sellerApproved === true) updateData.status = "Aprovado pelo vendedor";
    if (data.sellerApproved === false) updateData.status = "Recusado pelo vendedor";

    if (needsStatusCheck && !current) throw new Error(`Venda (id=${id}) não encontrada`);
    const readVersion = current?.statusVersion;
    // Escrita de status (mesmo repetindo o valor lido) sempre passa pelo compare-and-set; só a
    // transição real incrementa a versão e reseta statusChangedAt.
    const writesStatus = needsStatusCheck && updateData.status !== undefined;
    const isStatusTransition = writesStatus && updateData.status !== currentStatus;
    if (isStatusTransition) {
      updateData.statusChangedAt = new Date();
      updateData.statusVersion = readVersion! + 1;
    }

    if (data.boughtProducts) {
      const boughtProductsWithCalculatedValue = await Promise.all(
        data.boughtProducts.map(async (boughtProduct) => {
          const sellingUnitProduct = await this.prisma.sellingUnitProduct.findUnique({
            where: { id: boughtProduct.sellingUnitProductId },
          });
          if (!sellingUnitProduct) {
            throw new Error(`Unidade de venda (sellingUnitProductId=${boughtProduct.sellingUnitProductId}) não encontrada`);
          }
          const calculatedValue = sellingUnitProduct.minPrice * boughtProduct.amount;
          return {
            productId: boughtProduct.productId,
            sellingUnitProductId: boughtProduct.sellingUnitProductId,
            value: calculatedValue,
            amount: boughtProduct.amount,
          };
        })
      );

      updateData.boughtProducts = {
        deleteMany: {},
        create: boughtProductsWithCalculatedValue,
      };
    }

    // Escrita de status = compare-and-set na VERSÃO lida (não no valor do status): qualquer escrita
    // de status no meio do caminho — inclusive A→B→A — muda a versão e faz esta requisição obsoleta
    // receber SALE_STATUS_CONFLICT. Vale também quando o valor enviado é igual ao lido: sem o CAS,
    // "ler A, outro muda para B, eu gravo A" sobrescreveria B silenciosamente. A versão nova
    // (lida + 1) é a identidade da transição.
    let updated;
    try {
      updated = await this.prisma.saleData.update({
        where: writesStatus ? { id, statusVersion: readVersion } : { id },
        data: updateData,
        include: { boughtProducts: true },
      });
    } catch (error) {
      if (writesStatus && isRecordNotFound(error)) throw new Error("SALE_STATUS_CONFLICT");
      throw error;
    }

    if (isStatusTransition) {
      if (data.sellerApproved !== undefined && data.sellerApproved !== null) {
        await this.notifications.notifySellerDecision(id, data.sellerApproved, updated.status, updated.statusVersion);
      } else {
        await this.notifications.notifyStatusChanged(id, updated.status, updated.statusVersion);
      }
    }

    return updated;
  }

  async delete(id: string) {
    // Usa transação para garantir atomicidade: se qualquer operação falhar, todas são revertidas
    return await this.prisma.$transaction(async (tx) => {
      // Primeiro, deletar os produtos comprados associados à venda
      await tx.boughtProduct.deleteMany({
        where: { saleDataId: id }
      });

      // Depois, deletar os pagamentos associados à venda
      await tx.payment.deleteMany({
        where: { saleId: id }
      });

      // Deletar as aceitações de contrato associadas à venda
      await tx.contractAcceptance.deleteMany({
        where: { saleId: id }
      });

      // Filhos com FK restritiva criados ao longo da operação: termo aditivo e ticket de balança
      // nascem juntos na pesagem (registerManualWeight), então os dois precisam sair — remover só o
      // aditivo ainda deixaria a exclusão falhando pelo OperationDocument. Os arquivos no S3 não são apagados.
      await tx.saleAddendum.deleteMany({
        where: { saleId: id }
      });
      await tx.operationDocument.deleteMany({
        where: { saleId: id }
      });
      await tx.conformityCertifier.deleteMany({
        where: { saleId: id }
      });

      // Por fim, deletar a venda
      return tx.saleData.delete({ where: { id } });
    });
  }

  async calculateFreight(saleDataId: string, distanceKm: number, pricePerKm: number) {
    const sale = await this.prisma.saleData.findUnique({
      where: { id: saleDataId },
      include: { boughtProducts: true, transportType: true, shippingAddress: true },
    });

    if (!sale) throw new Error(`Venda (saleDataId=${saleDataId}) não encontrada`);

    const baseFreight = sale.transportType.valueFreight;
    const variableFreight = distanceKm * pricePerKm;
    const finalFreight = baseFreight + variableFreight;

    await this.prisma.saleData.update({
      where: { id: saleDataId },
      data: { transportValue: finalFreight },
    });

    return { saleDataId, baseFreight, distanceKm, pricePerKm, variableFreight, transportValue: finalFreight };
  }

  async setSellerDecision(saleId: string, dto: SellerDecisionDto) {
    const sale = await this.prisma.saleData.findUnique({ where: { id: saleId } });
    if (!sale) throw new Error(`Venda (saleDataId=${saleId}) não encontrada`);

    const newStatus = dto.approved ? "Aprovado pelo vendedor" : "Recusado pelo vendedor";

    const dateFields = dto.approved
      ? {
          ...(dto.plannedHarvestDate && { plannedHarvestDate: dto.plannedHarvestDate }),
          ...(dto.plannedPickupDate && { plannedPickupDate: dto.plannedPickupDate }),
          ...(dto.plannedDeliveryDate && { plannedDeliveryDate: dto.plannedDeliveryDate }),
          // Cada original é gravado de forma independente, apenas na primeira vez que a data é fornecida
          ...(!sale.originalPlannedHarvestDate && dto.plannedHarvestDate && {
            originalPlannedHarvestDate: dto.plannedHarvestDate,
          }),
          ...(!sale.originalPlannedPickupDate && dto.plannedPickupDate && {
            originalPlannedPickupDate: dto.plannedPickupDate,
          }),
          ...(!sale.originalPlannedDeliveryDate && dto.plannedDeliveryDate && {
            originalPlannedDeliveryDate: dto.plannedDeliveryDate,
          }),
        }
      : {};

    // Reenviar a mesma decisão (ex.: só para preencher datas) não é uma transição: não reseta
    // statusChangedAt nem notifica o comprador de novo.
    const isTransition = sale.status !== newStatus;
    const newVersion = sale.statusVersion + 1;

    // Compare-and-set na VERSÃO lida acima (não no valor do status, que sofre ABA): se qualquer
    // escrita de status aconteceu desde a leitura, esta decisão está obsoleta e recebe
    // SELLER_DECISION_CONFLICT. A versão nova é a identidade da transição na notificação.
    const { count } = await this.prisma.saleData.updateMany({
      where: { id: saleId, statusVersion: sale.statusVersion },
      data: {
        sellerApproved: dto.approved,
        status: newStatus,
        ...(isTransition && { statusChangedAt: new Date(), statusVersion: newVersion }),
        ...dateFields,
      },
    });
    if (count === 0) throw new Error("SELLER_DECISION_CONFLICT");

    if (isTransition) {
      await this.notifications.notifySellerDecision(saleId, dto.approved, newStatus, newVersion);
    }

    return this.prisma.saleData.findUnique({ where: { id: saleId }, include: { boughtProducts: true } });
  }

  /**
   * Registra um documento operacional (pesagem, NF, canhoto, etc.).
   * Se docType === 'canhoto_nf', preenche actualDeliveryDate automaticamente (Cláusula 5).
   * Documento e atualização da venda são atômicos (mesma transação).
   */
  async uploadOperationDocument(params: {
    saleId: string;
    uploadedById: string;
    docType: string;
    fileUrl: string;
  }) {
    const sale = await this.prisma.saleData.findUnique({
      where: { id: params.saleId },
      select: { id: true, plannedDeliveryDate: true, actualDeliveryDate: true },
    });
    if (!sale) throw new Error(`Venda (id=${params.saleId}) não encontrada`);

    let deliveredVersion: number | null = null;
    const doc = await this.prisma.$transaction(async (tx) => {
      const doc = await tx.operationDocument.create({
        data: {
          saleId: params.saleId,
          uploadedById: params.uploadedById,
          docType: params.docType,
          fileUrl: params.fileUrl,
        },
      });

      // Cláusula 5: canhoto confirma entrega se a venda ainda não tem actualDeliveryDate
      // e o upload ocorre a partir da plannedDeliveryDate (não antes).
      if (params.docType === 'canhoto_nf' && !sale.actualDeliveryDate) {
        const now = new Date();
        const afterDeliveryDate = !sale.plannedDeliveryDate || now >= sale.plannedDeliveryDate;

        if (afterDeliveryDate) {
          // Guard avaliado na escrita ("ainda sem entrega"): dois canhotos simultâneos não registram
          // (nem notificam) a entrega duas vezes — só o primeiro efetiva a transição.
          deliveredVersion = await this.transitionStatus(tx, params.saleId, { actualDeliveryDate: null }, {
            actualDeliveryDate: now,
            status: 'Entregue',
            statusChangedAt: now,
          });
        }
      }

      return doc;
    });

    if (deliveredVersion !== null) await this.notifications.notifyStatusChanged(params.saleId, 'Entregue', deliveredVersion);
    return doc;
  }

  /**
   * Verifica e aplica aceite tácito para uma venda (Cláusula 5):
   * Se plannedDeliveryDate + 1 dia útil já passou e não há actualDeliveryDate,
   * considera entrega realizada e atualiza o status para "Concluída".
   */
  async processTacitAcceptance(saleId: string) {
    const sale = await this.prisma.saleData.findUnique({
      where: { id: saleId },
      select: {
        id: true,
        status: true,
        plannedDeliveryDate: true,
        actualDeliveryDate: true,
      },
    });
    if (!sale) throw new Error(`Venda (id=${saleId}) não encontrada`);

    if (sale.actualDeliveryDate) {
      return { applied: false, reason: 'Entrega já registrada' };
    }
    if (!sale.plannedDeliveryDate) {
      return { applied: false, reason: 'Sem data de entrega prevista' };
    }

    const tacitDeadline = addBusinessDays(sale.plannedDeliveryDate, 1);
    if (new Date() < tacitDeadline) {
      return { applied: false, reason: 'Prazo de aceite tácito ainda não venceu' };
    }

    // Guard avaliado na escrita ("ainda sem entrega"): duas execuções simultâneas (endpoint manual +
    // lote) leem a venda sem entrega, mas só uma aplica o aceite tácito e notifica.
    const version = await this.prisma.$transaction((tx) =>
      this.transitionStatus(tx, saleId, { actualDeliveryDate: null }, {
        actualDeliveryDate: tacitDeadline,
        status: 'Concluído',
        statusChangedAt: tacitDeadline,
      })
    );
    if (version === null) return { applied: false, reason: 'Entrega já registrada' };

    if (sale.status !== 'Concluído') await this.notifications.notifyStatusChanged(saleId, 'Concluído', version);
    return { applied: true, actualDeliveryDate: tacitDeadline };
  }

  /**
   * Autoriza colheita para uma venda.
   * Requer que o pagamento da entrada (30%) já esteja confirmado.
   */
  async authorizeHarvest(saleId: string) {
    const sale = await this.prisma.saleData.findUnique({
      where: { id: saleId },
      select: { id: true, status: true, statusVersion: true, downPaymentCompleted: true, sellerApproved: true },
    });
    if (!sale) throw new Error(`Venda (id=${saleId}) não encontrada`);

    if (!sale.downPaymentCompleted) throw new Error('HARVEST_BLOCKED_NO_DOWN_PAYMENT');
    if (!sale.sellerApproved) throw new Error('HARVEST_BLOCKED_SELLER_NOT_APPROVED');

    // Já autorizada: idempotente — não é uma nova transição (não reseta statusChangedAt nem notifica).
    if (sale.status === 'Colheita autorizada') {
      return this.prisma.saleData.findUnique({ where: { id: saleId }, include: { boughtProducts: true } });
    }

    // Compare-and-set na VERSÃO lida: as pré-condições acima (entrada paga, vendedor aprovou) foram
    // checadas nessa leitura; qualquer escrita de status desde então (inclusive A→B→A, ou um
    // estorno seguido de nova confirmação) torna esta autorização obsoleta.
    const newVersion = sale.statusVersion + 1;
    let updated;
    try {
      updated = await this.prisma.saleData.update({
        where: { id: saleId, statusVersion: sale.statusVersion },
        data: { status: 'Colheita autorizada', statusChangedAt: new Date(), statusVersion: newVersion },
        include: { boughtProducts: true },
      });
    } catch (error) {
      if (isRecordNotFound(error)) throw new Error('SALE_STATUS_CONFLICT');
      throw error;
    }

    await this.notifications.notifyStatusChanged(saleId, 'Colheita autorizada', newVersion);
    return updated;
  }

  /**
   * Altera o método de pagamento da primeira parcela de uma venda.
   * Cancela todos os pagamentos pendentes no banco antes de atualizar.
   * Bloqueado se a entrada ou o pagamento final já foram confirmados.
   */
  async changePaymentMethod(saleId: string, newPaymentMethodId: string) {
    const sale = await this.prisma.saleData.findUnique({
      where: { id: saleId },
      select: { id: true, downPaymentCompleted: true, paymentCompleted: true },
    });
    if (!sale) throw new Error(`Venda (id=${saleId}) não encontrada`);
    if (sale.paymentCompleted) throw new Error('PAYMENT_ALREADY_COMPLETED');
    if (sale.downPaymentCompleted) throw new Error('DOWN_PAYMENT_ALREADY_COMPLETED');

    const paymentMethod = await this.prisma.paymentMethod.findUnique({ where: { id: newPaymentMethodId } });
    if (!paymentMethod) throw new Error(`Método de pagamento (id=${newPaymentMethodId}) não encontrado`);

    return this.prisma.$transaction(async (tx) => {
      // Cancela pagamentos pendentes para liberar o novo fluxo de pagamento
      await tx.payment.updateMany({
        where: { saleId, status: 'pending' },
        data: { status: 'cancelled', updatedAt: new Date() },
      });

      return tx.saleData.update({
        where: { id: saleId },
        data: { paymentMethodId: newPaymentMethodId },
        include: { paymentMethod: true },
      });
    });
  }

  /**
   * Registra o peso manual da carga com comprovante (ticket de balança).
   * Recalcula o total do contrato com base no peso real e na unidade de venda do produto.
   * Atualiza status para "Aguardando pagamento final" e persiste adjustedContractTotal.
   * Operação atômica: documento + peso + status em uma única transação.
   */
  async registerManualWeight(params: {
    saleId: string;
    uploadedById: string;
    weightKg: number;
    fileUrl: string;
  }) {
    const sale = await this.prisma.saleData.findUnique({
      where: { id: params.saleId },
      select: {
        id: true,
        status: true,
        statusVersion: true,
        weightDocumentId: true,
        sellerApproved: true,
        transportValue: true,
        downPaymentCompleted: true,
      },
    });
    if (!sale) throw new Error(`Venda (id=${params.saleId}) não encontrada`);
    if (!sale.sellerApproved) throw new Error('WEIGHT_BLOCKED_SELLER_NOT_APPROVED');
    if (!sale.downPaymentCompleted) throw new Error('WEIGHT_BLOCKED_NO_DOWN_PAYMENT');
    if (sale.weightDocumentId) throw new Error('WEIGHT_ALREADY_REGISTERED');
    if (params.weightKg <= 0) throw new Error('Peso deve ser maior que zero');

    const boughtProducts = await this.prisma.boughtProduct.findMany({
      where: { saleDataId: params.saleId },
      include: { sellingUnitProduct: { include: { unit: true } } },
    });

    const adjustedProductsTotal = this.calculateWeightBasedTotal(boughtProducts, params.weightKg);
    const adjustedContractTotal = adjustedProductsTotal !== null
      ? parseFloat((adjustedProductsTotal + Number(sale.transportValue)).toFixed(2))
      : null;
    // Capturado ANTES da transação: logo abaixo BoughtProduct.value é sobrescrito com o valor pesado,
    // e esse total original só sobrevive no termo aditivo.
    const originalContractTotal = parseFloat(
      (boughtProducts.reduce((sum, bp) => sum + bp.value, 0) + Number(sale.transportValue)).toFixed(2)
    );

    const result = await this.prisma.$transaction(async (tx) => {
      const doc = await tx.operationDocument.create({
        data: {
          saleId: params.saleId,
          uploadedById: params.uploadedById,
          docType: 'ticket_balanca',
          fileUrl: params.fileUrl,
        },
      });

      // Compare-and-set na VERSÃO lida: as pré-condições acima (vendedor aprovou, entrada paga, sem
      // pesagem) foram checadas nessa leitura; se o status mudou desde então (ex.: estorno da entrada,
      // cancelamento), esta pesagem está obsoleta e a transação inteira (documento incluso) é desfeita.
      const updatedSale = await tx.saleData.update({
        where: { id: params.saleId, statusVersion: sale.statusVersion, weightDocumentId: null },
        data: {
          cargoWeightKg: params.weightKg,
          weightDocumentId: doc.id,
          status: 'Aguardando pagamento final',
          statusChangedAt: new Date(),
          statusVersion: sale.statusVersion + 1,
          ...(adjustedContractTotal !== null && { adjustedContractTotal }),
        },
        include: { boughtProducts: true },
      });

      // Termo aditivo automático: diferença com sinal (+ acréscimo / - redução). Só quando o peso
      // gerou um novo total — unidade que não é de peso não recalcula o contrato, então não há aditivo.
      const addendum = adjustedContractTotal !== null
        ? await tx.saleAddendum.create({
            data: {
              saleId: params.saleId,
              kind: 'weight_adjustment',
              originalTotal: originalContractTotal,
              adjustedTotal: adjustedContractTotal,
              difference: parseFloat((adjustedContractTotal - originalContractTotal).toFixed(2)),
              weightKg: params.weightKg,
              weightDocumentId: doc.id,
            },
          })
        : null;

      // Atualiza BoughtProduct.value usando a mesma fórmula de calculateWeightBasedTotal (peso × preço/unidade)
      if (adjustedProductsTotal !== null && boughtProducts.length > 0) {
        if (boughtProducts.length === 1) {
          await tx.boughtProduct.update({
            where: { id: boughtProducts[0].id },
            data: { value: adjustedProductsTotal },
          });
        } else {
          const originalTotal = boughtProducts.reduce((sum, bp) => sum + bp.value, 0);
          if (originalTotal > 0) {
            for (const bp of boughtProducts) {
              const kgPerUnit = this.getKgPerUnit(bp.sellingUnitProduct.unit.unit);
              if (kgPerUnit === null) continue;
              const proportion = bp.value / originalTotal;
              const productWeightKg = params.weightKg * proportion;
              const newValue = parseFloat(((productWeightKg / kgPerUnit) * bp.sellingUnitProduct.minPrice).toFixed(2));
              await tx.boughtProduct.update({
                where: { id: bp.id },
                data: { value: newValue },
              });
            }
          }
        }
      }

      return {
        document: doc,
        sale: updatedSale,
        adjustedContractTotal,
        weightCalculated: adjustedContractTotal !== null,
        addendum,
      };
    }).catch(async (error: unknown) => {
      if (!isRecordNotFound(error)) throw error;
      const latest = await this.prisma.saleData.findUnique({ where: { id: params.saleId }, select: { weightDocumentId: true } });
      throw new Error(latest?.weightDocumentId ? 'WEIGHT_ALREADY_REGISTERED' : 'SALE_STATUS_CONFLICT');
    });

    await this.notifications.notifyWeightRegistered(params.saleId, {
      weightKg: params.weightKg,
      adjustedContractTotal,
      status: result.sale.status,
    });
    return result;
  }

  /**
   * Converte kg para a unidade de venda e multiplica pelo preço.
   * Retorna null se alguma unidade não for reconhecida como peso.
   */
  private calculateWeightBasedTotal(
    boughtProducts: Array<{
      value: number;
      amount: number;
      sellingUnitProduct: { minPrice: number; unit: { unit: string } };
    }>,
    totalWeightKg: number
  ): number | null {
    if (boughtProducts.length === 0) return null;

    if (boughtProducts.length === 1) {
      const bp = boughtProducts[0];
      const kgPerUnit = this.getKgPerUnit(bp.sellingUnitProduct.unit.unit);
      if (kgPerUnit === null) return null;
      return parseFloat(((totalWeightKg / kgPerUnit) * bp.sellingUnitProduct.minPrice).toFixed(2));
    }

    // Múltiplos produtos: distribui o peso proporcionalmente pelo valor original
    const originalTotal = boughtProducts.reduce((sum, bp) => sum + bp.value, 0);
    if (originalTotal === 0) return null;

    let newTotal = 0;
    for (const bp of boughtProducts) {
      const kgPerUnit = this.getKgPerUnit(bp.sellingUnitProduct.unit.unit);
      if (kgPerUnit === null) return null;
      const proportion = bp.value / originalTotal;
      const productWeightKg = totalWeightKg * proportion;
      newTotal += (productWeightKg / kgPerUnit) * bp.sellingUnitProduct.minPrice;
    }
    return parseFloat(newTotal.toFixed(2));
  }

  /** Retorna quantos kg equivalem a 1 unidade de venda, ou null se desconhecida. */
  private getKgPerUnit(unit: string): number | null {
    const u = unit.toLowerCase().trim();
    if (['kg', 'quilograma', 'quilogramas', 'kilo', 'kilos'].includes(u)) return 1;
    if (['ton', 't', 'tonelada', 'toneladas'].includes(u)) return 1000;
    if (['saca', 'sc', 'sacas', 'saco', 'sacos'].includes(u)) return 60;
    if (['arroba', 'arrobas', '@'].includes(u)) return 15;
    if (['g', 'grama', 'gramas'].includes(u)) return 0.001;
    return null;
  }

  /**
   * Aplica multa por inadimplência da parcela final e cancela a venda.
   */
  async applyPenalty(saleId: string, params: { penaltyAmount?: number; reason: string }) {
    const sale = await this.prisma.saleData.findUnique({
      where: { id: saleId },
      select: { id: true, status: true, paymentCompleted: true, penaltyApplied: true },
    });
    if (!sale) throw new Error(`Venda (id=${saleId}) não encontrada`);
    if (sale.paymentCompleted) throw new Error('PENALTY_BLOCKED:Pagamento final já confirmado, multa não aplicável');
    if (sale.penaltyApplied) throw new Error('PENALTY_ALREADY_APPLIED');

    // Guard avaliado na escrita: multa ainda não aplicada E pagamento final ainda não confirmado
    // (um pagamento confirmado entre a leitura e a escrita não pode ser seguido de cancelamento).
    const version = await this.prisma.$transaction((tx) =>
      this.transitionStatus(tx, saleId, { penaltyApplied: false, paymentCompleted: false }, {
        penaltyApplied: true,
        penaltyAmount: params.penaltyAmount ?? null,
        penaltyReason: params.reason,
        status: 'Cancelado',
        statusChangedAt: new Date(),
      })
    );
    if (version === null) {
      const latest = await this.prisma.saleData.findUnique({ where: { id: saleId }, select: { paymentCompleted: true } });
      if (latest?.paymentCompleted) throw new Error('PENALTY_BLOCKED:Pagamento final já confirmado, multa não aplicável');
      throw new Error('PENALTY_ALREADY_APPLIED');
    }

    if (sale.status !== 'Cancelado') await this.notifications.notifyStatusChanged(saleId, 'Cancelado', version);
    return this.prisma.saleData.findUnique({ where: { id: saleId }, include: { boughtProducts: true } });
  }

  /**
   * Calcula a etapa atual do pipeline de uma venda e há quantos dias ela está nessa etapa.
   * Ver src/lib/pipelineStage.ts para a lógica de inferência a partir dos campos existentes.
   */
  async getPipelineStage(saleId: string): Promise<PipelineStageResult> {
    const sale = await this.prisma.saleData.findUnique({
      where: { id: saleId },
      select: {
        status: true,
        createdAt: true,
        statusChangedAt: true,
        downPaymentCompleted: true,
        paymentCompleted: true,
        shippedAt: true,
        arrivedAt: true,
        actualDeliveryDate: true,
        weightDocumentId: true,
        Payment: { where: { status: "completed" }, select: { phase: true, status: true, updatedAt: true } },
      },
    });
    if (!sale) throw new Error(`Venda (id=${saleId}) não encontrada`);

    return calculatePipelineStage(sale);
  }

  /**
   * Processa aceite tácito para todas as vendas elegíveis (para uso em cron job).
   */
  async processBatchTacitAcceptances() {
    const now = new Date();

    // Vendas com data de entrega prevista no passado (+ 1 dia útil), sem entrega registrada
    const candidates = await this.prisma.saleData.findMany({
      where: {
        actualDeliveryDate: null,
        plannedDeliveryDate: { lt: now },
        status: { notIn: ['Concluído', 'Concluída', 'Recusado pelo vendedor', 'Cancelado'] },
      },
      select: { id: true, plannedDeliveryDate: true },
    });

    const results: Array<{ saleId: string; applied: boolean; reason?: string }> = [];
    for (const sale of candidates) {
      const tacitDeadline = addBusinessDays(sale.plannedDeliveryDate!, 1);
      if (now >= tacitDeadline) {
        const result = await this.processTacitAcceptance(sale.id);
        results.push({ saleId: sale.id, ...result });
      }
    }

    return { processed: results.length, results };
  }
}
