import { Prisma, PrismaClient } from "@prisma/client";
import { UploadS3Service } from "../upload-S3/uploadS3.service";
import { logger } from "../../lib/logger";
import { startOfTodayInBrasilia } from "../../lib/brasiliaTime";
import { ProductError, ProductRequester } from "./product.errors";

export type ProductStatusFilter = "active" | "inactive" | "all";

export const PRODUCT_STATUS_FILTERS: readonly ProductStatusFilter[] = ["active", "inactive", "all"];

// Produto ativo = status true e colheita até hoje, no fuso de Brasília: ele vale até
// 23:59:59 do dia da colheita. O filtro por data cobre o intervalo até o job
// `deactivateExpiredProducts` gravar status = false.
export function productStatusWhere(
  filter: ProductStatusFilter,
  now: Date = new Date()
): Prisma.ProductWhereInput {
  const startOfToday = startOfTodayInBrasilia(now);
  if (filter === "active") return { status: true, harvestAt: { gte: startOfToday } };
  if (filter === "inactive") return { OR: [{ status: false }, { harvestAt: { lt: startOfToday } }] };
  return {};
}

// Status implícito pela colheita, usado quando o cliente não manda `status` explicitamente.
function isHarvestDayPending(harvestAt: Date, now: Date = new Date()): boolean {
  return harvestAt >= startOfTodayInBrasilia(now);
}

export class ProductService {
  private readonly prisma: PrismaClient;
  private readonly uploadService: UploadS3Service;

  constructor(prisma?: PrismaClient) {
    this.prisma = prisma ?? new PrismaClient();
    this.uploadService = new UploadS3Service(this.prisma);
  }

  async create(data: any, files?: Express.Multer.File[]) {
    try {
      let imageUrls: string[] = [];

      if (files && files.length > 0) {
        const uploadPromises = files.map(async (file) => {
          const { publicUrl } = await this.uploadService.upload(file);
          return publicUrl;
        });
        imageUrls = await Promise.all(uploadPromises);
      }

      const productData: any = {
        sellerId: data.sellerId,
        name: data.name,
        category: data.category,
        variety: data.variety,
        stock: parseInt(data.stock),
        description: data.description,
        images_Path: imageUrls,
        harvestAt: new Date(data.harvestAt),
        productRating: parseFloat(data.productRating ?? 0),
        amountSold: parseInt(data.amountSold ?? 0),
        isNegotiable: data.isNegotiable === true || data.isNegotiable === "true",
        ratingAmount: parseInt(data.ratingAmount ?? 0),
        ratingStarAmount: data.ratingStarAmount ?? [],
        createdAt: new Date(),
        status:
          data.status !== undefined
            ? data.status === true || data.status === "true"
            : isHarvestDayPending(new Date(data.harvestAt)),
      };

      const product = await this.prisma.product.create({
        data: productData,
        include: {
          seller: { select: { id: true, name: true, email: true } },
        },
      });

      if (data.sellingUnitProduct && data.sellingUnitProduct.length > 0) {
        const sellingUnitsData = data.sellingUnitProduct.map((unit: any) => {
          if (!unit.unitId) {
            throw new Error(`unitId é obrigatório para cada unidade de venda`);
          }
          if (!unit.minPrice && unit.minPrice !== 0) {
            throw new Error(`minPrice é obrigatório para cada unidade de venda`);
          }

          return {
            productId: product.id,
            unitId: unit.unitId,
            minPrice: parseFloat(unit.minPrice),
          };
        });

        await this.prisma.sellingUnitProduct.createMany({
          data: sellingUnitsData,
        });

        const productWithUnits = await this.prisma.product.findUnique({
          where: { id: product.id },
          include: {
            seller: { select: { id: true, name: true, email: true } },
            sellingUnitProduct: { include: { unit: true } },
          },
        });

        return productWithUnits;
      }

      return product;
    } catch (error) {
      console.error("Erro ao criar produto:", error);
      throw error;
    }
  }

  async getAll(name?: string, category?: string, statusFilter: ProductStatusFilter = "active") {
    const where: any = productStatusWhere(statusFilter);
    if (name) where.name = { contains: name, mode: "insensitive" };
    if (category) where.category = { equals: category, mode: "insensitive" };

    return this.prisma.product.findMany({
      where,
      include: {
        sellingUnitProduct: { include: { unit: true } },
        boughtProducts: true,
        questions: true,
        seller: { select: { id: true, name: true, phone_number: true, email: true } },
      },
    });
  }

  // Produtos mais vendidos do market, por número de vendas efetivadas (pedidos distintos).
  // Só produtos ativos e de outros vendedores.
  async getBestSellers(requesterId: string, limit: number) {

    // Uma linha por (produto, venda): um pedido com várias unidades do mesmo produto conta uma vez.
    const productSales = await this.prisma.boughtProduct.groupBy({
      by: ["productId", "saleDataId"],
      where: {
        saleData: {
          status: { notIn: ["Cancelado", "Recusado pelo vendedor"] },
          OR: [{ downPaymentCompleted: true }, { paymentCompleted: true }],
        },
        product: { sellerId: { not: requesterId }, ...productStatusWhere("active") },
      },
    });

    const salesCount = new Map<string, number>();
    for (const { productId } of productSales) {
      salesCount.set(productId, (salesCount.get(productId) ?? 0) + 1);
    }
    const topIds = [...salesCount.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, limit)
      .map(([productId]) => productId);

    if (topIds.length === 0) return [];

    const products = await this.prisma.product.findMany({
      where: { id: { in: topIds } },
      include: {
        sellingUnitProduct: { include: { unit: true } },
        seller: { select: { id: true, name: true } },
      },
    });
    const byId = new Map(products.map((p) => [p.id, p]));

    return topIds
      .filter((id) => byId.has(id))
      .map((id) => ({ ...byId.get(id)!, salesCount: salesCount.get(id)! }));
  }

  async getAllByUser(
    sellerId: string,
    name?: string,
    category?: string,
    statusFilter: ProductStatusFilter = "active"
  ) {
    const where: any = { sellerId, ...productStatusWhere(statusFilter) };
    if (name) where.name = { contains: name, mode: "insensitive" };
    if (category) where.category = { contains: category, mode: "insensitive" };

    return this.prisma.product.findMany({
      where,
      include: {
        sellingUnitProduct: { include: { unit: true } },
        boughtProducts: true,
        questions: true,
        seller: { select: { id: true, name: true, phone_number: true, email: true } },
      },
    });
  }

  async getById(id: string, statusFilter: ProductStatusFilter = "active") {
    return this.prisma.product.findFirst({
      where: { id, ...productStatusWhere(statusFilter) },
      include: {
        sellingUnitProduct: { include: { unit: true } },
        boughtProducts: true,
        questions: true,
        seller: { select: { id: true, name: true, phone_number: true, email: true } },
      },
    });
  }

  async update(
    id: string,
    requester: ProductRequester,
    data: any,
    files?: Express.Multer.File[]
  ) {
    const existingProduct = await this.prisma.product.findUnique({
      where: { id },
      select: { images_Path: true, sellerId: true },
    });

    if (!existingProduct) {
      throw new ProductError(404, "Produto não encontrado");
    }
    this.assertCanManage(existingProduct.sellerId, requester);

    const processedUnits = this.parseSellingUnits(data.sellingUnitProduct);

    let existingFromClient: string[] = [];
    if (Array.isArray(data.existingImages)) {
      existingFromClient = data.existingImages.filter(
        (u: any) => typeof u === "string" && u.trim() !== ""
      );
    }

    const baseExisting = existingFromClient.length > 0
      ? existingFromClient
      : (existingProduct.images_Path || []);

    const removedImages = (existingProduct.images_Path || []).filter(
      (oldUrl: string) => !baseExisting.includes(oldUrl)
    );

    let newImageUrls: string[] = [];
    if (files && files.length > 0) {
      const uploads = await Promise.allSettled(
        files.map((file) => this.uploadService.upload(file))
      );
      let uploadError: unknown = null;
      for (const r of uploads) {
        if (r.status === "fulfilled") newImageUrls.push(r.value.publicUrl);
        else uploadError ??= r.reason;
      }
      // Se algum upload falhar, descarta os que subiram para não deixar órfãos no S3.
      if (uploadError) {
        await this.deleteImages(newImageUrls);
        throw uploadError;
      }
    }

    const seen = new Set<string>();
    const finalImageUrls = [...baseExisting, ...newImageUrls].filter((u) => {
      const key = String(u).trim();
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    const updateData: any = { images_Path: finalImageUrls };

    if (data.name !== undefined) updateData.name = data.name;
    if (data.category !== undefined) updateData.category = data.category;
    if (data.variety !== undefined) updateData.variety = data.variety;
    if (data.stock !== undefined) updateData.stock = parseInt(data.stock);
    if (data.description !== undefined) updateData.description = data.description;
    if (data.harvestAt !== undefined) updateData.harvestAt = new Date(data.harvestAt);
    if (data.productRating !== undefined) updateData.productRating = parseFloat(data.productRating);
    if (data.amountSold !== undefined) updateData.amountSold = parseInt(data.amountSold);
    if (data.ratingAmount !== undefined) updateData.ratingAmount = parseInt(data.ratingAmount);
    if (data.ratingStarAmount !== undefined) updateData.ratingStarAmount = data.ratingStarAmount;

    if (data.isNegotiable !== undefined) {
      updateData.isNegotiable = data.isNegotiable === "true" || data.isNegotiable === true;
    }
    if (data.status !== undefined) {
      updateData.status = data.status === "true" || data.status === true;
    } else if (updateData.harvestAt) {
      // Trocar a data de colheita reativa (ou desativa) o produto conforme a nova data.
      updateData.status = isHarvestDayPending(updateData.harvestAt);
    }

    let updatedProduct;
    try {
      // Produto e unidades são atualizados juntos para não deixar o produto
      // parcialmente salvo se a troca de unidades falhar.
      updatedProduct = await this.prisma.$transaction(async (tx) => {
        await tx.product.update({ where: { id }, data: updateData });

        if (processedUnits) {
          await this.syncSellingUnits(tx, id, processedUnits);
        }

        return tx.product.findUnique({
          where: { id },
          include: {
            seller: { select: { id: true, name: true, email: true } },
            sellingUnitProduct: { include: { unit: true } },
          },
        });
      });
    } catch (error) {
      // Nada foi salvo no banco: descarta as imagens novas que ficariam órfãs no S3.
      await this.deleteImages(newImageUrls);
      throw error;
    }

    // Só apaga do S3 depois do commit, para o banco nunca apontar para imagem inexistente.
    await this.deleteImages(removedImages);

    return updatedProduct;
  }

  private parseSellingUnits(raw: unknown): { unitId: string; minPrice: number }[] | null {
    if (!Array.isArray(raw)) return null;

    const units = raw.map((unit: any) => {
      const unitId = unit?.unitId ?? unit?.id;
      const minPrice =
        unit?.minPrice !== undefined
          ? parseFloat(unit.minPrice)
          : unit?.price !== undefined
            ? parseFloat(unit.price)
            : NaN;

      if (typeof unitId !== "string" || unitId.trim() === "" || isNaN(minPrice)) {
        throw new ProductError(
          400,
          "Unidades de venda inválidas. Cada unidade deve ter unitId e minPrice válidos."
        );
      }
      return { unitId, minPrice };
    });

    if (new Set(units.map((u) => u.unitId)).size !== units.length) {
      throw new ProductError(400, "A mesma unidade de venda foi informada mais de uma vez.");
    }

    return units;
  }

  // Unidades já vendidas/no carrinho são referenciadas por BoughtProduct e CartItem
  // (ON DELETE RESTRICT), então não podem ser apagadas e recriadas: atualiza no lugar.
  private async syncSellingUnits(
    tx: Prisma.TransactionClient,
    productId: string,
    units: { unitId: string; minPrice: number }[]
  ) {
    const currentUnits = await tx.sellingUnitProduct.findMany({
      where: { productId },
      include: { unit: true, _count: { select: { boughtProducts: true } } },
    });
    const currentUnitIds = new Set(currentUnits.map((c) => c.unitId));
    const requestedUnitIds = new Set(units.map((u) => u.unitId));

    const removedUnits = currentUnits.filter((c) => !requestedUnitIds.has(c.unitId));
    const soldUnit = removedUnits.find((c) => c._count.boughtProducts > 0);
    if (soldUnit) {
      throw new ProductError(
        400,
        `A unidade de venda "${soldUnit.unit.title}" já possui vendas e não pode ser removida.`
      );
    }

    const newUnitIds = units.filter((u) => !currentUnitIds.has(u.unitId)).map((u) => u.unitId);
    if (newUnitIds.length > 0) {
      const found = await tx.sellingUnit.count({ where: { id: { in: newUnitIds } } });
      if (found !== newUnitIds.length) {
        throw new ProductError(400, "Unidade de venda não encontrada.");
      }
    }

    for (const u of units) {
      if (currentUnitIds.has(u.unitId)) {
        // updateMany cobre registros duplicados que já existam para a mesma unidade.
        await tx.sellingUnitProduct.updateMany({
          where: { productId, unitId: u.unitId },
          data: { minPrice: u.minPrice },
        });
      } else {
        await tx.sellingUnitProduct.create({
          data: { productId, unitId: u.unitId, minPrice: u.minPrice },
        });
      }
    }

    if (removedUnits.length > 0) {
      const removedIds = removedUnits.map((c) => c.id);
      await tx.cartItem.deleteMany({ where: { sellingUnitProductId: { in: removedIds } } });
      await tx.sellingUnitProduct.deleteMany({ where: { id: { in: removedIds } } });
    }
  }

  private assertCanManage(sellerId: string, requester: ProductRequester) {
    if (requester.role !== "admin" && requester.userId !== sellerId) {
      throw new ProductError(403, "Você não tem permissão para alterar este produto.");
    }
  }

  private async deleteImages(urls: string[]) {
    await Promise.allSettled(
      urls.map(async (url) => {
        try {
          const key = this.extractKeyFromUrl(url);
          if (key) {
            await this.uploadService.delete(key);
          }
        } catch (error) {
          logger.error(`Erro ao deletar imagem ${url}:`, error);
        }
      })
    );
  }

  private extractKeyFromUrl(url: string): string | null {
    try {
      const urlObj = new URL(url);
      return decodeURIComponent(urlObj.pathname.substring(1));
    } catch (error) {
      logger.error("Erro ao extrair key da URL:", url, error);
      return null;
    }
  }

  async delete(id: string, requester: ProductRequester) {
    const product = await this.prisma.product.findUnique({
      where: { id },
      select: { images_Path: true, sellerId: true },
    });
    if (!product) throw new ProductError(404, "Produto não encontrado");
    this.assertCanManage(product.sellerId, requester);

    await this.prisma.$transaction([
      this.prisma.boughtProduct.deleteMany({ where: { productId: id } }),
      this.prisma.cartItem.deleteMany({ where: { productId: id } }),
      this.prisma.sellingUnitProduct.deleteMany({ where: { productId: id } }),
      this.prisma.question.deleteMany({ where: { productId: id } }),
      this.prisma.product.delete({ where: { id } }),
    ]);

    // Só apaga do S3 depois do commit, para o banco nunca apontar para imagem inexistente.
    await this.deleteImages(product.images_Path || []);

    return { message: "Produto deletado com sucesso" };
  }

  // Desativa os produtos cujo dia de colheita (Brasília) já terminou.
  async deactivateExpiredProducts(now: Date = new Date()) {
    const { count } = await this.prisma.product.updateMany({
      where: { status: true, harvestAt: { lt: startOfTodayInBrasilia(now) } },
      data: { status: false },
    });
    return count;
  }

  async getSellingUnits() {
    return this.prisma.sellingUnit.findMany({ orderBy: { title: "asc" } });
  }
}
