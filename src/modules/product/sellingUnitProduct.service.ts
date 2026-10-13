import { PrismaClient } from "@prisma/client";
import { ProductError, ProductRequester } from "./product.errors";

const prisma = new PrismaClient({
  log: ['query', 'info', 'warn', 'error'],
});

export interface CreateSellingUnitProductDto {
  unitId: string;
  minPrice: number;
  productId: string;
}

export interface UpdateSellingUnitProductDto {
  unitId?: string;
  minPrice?: number;
}

export class SellingUnitProductService {

  // Só o vendedor dono do produto (ou um admin) pode mexer nas unidades de venda dele.
  private assertCanManage(sellerId: string, requester: ProductRequester) {
    if (requester.role !== "admin" && requester.userId !== sellerId) {
      throw new ProductError(403, "Você não tem permissão para alterar este produto.");
    }
  }

  async create(data: CreateSellingUnitProductDto, requester: ProductRequester) {
    try {
      const product = await prisma.product.findUnique({
        where: { id: data.productId },
      });

      if (!product) {
        throw new Error(`Produto com ID ${data.productId} não encontrado`);
      }
      this.assertCanManage(product.sellerId, requester);

      const unit = await prisma.sellingUnit.findUnique({
        where: { id: data.unitId },
      });

      if (!unit) {
        throw new Error(`Unidade de venda com ID ${data.unitId} não encontrada`);
      }

      const existing = await prisma.sellingUnitProduct.findFirst({
        where: {
          productId: data.productId,
          unitId: data.unitId,
        },
      });

      if (existing) {
        throw new Error(`Já existe uma unidade de venda com ID ${data.unitId} para o produto ${data.productId}`);
      }

      return await prisma.sellingUnitProduct.create({
        data: {
          unitId: data.unitId,
          minPrice: data.minPrice,
          productId: data.productId,
        },
        include: {
          unit: true,
          product: {
            select: {
              id: true,
              name: true,
            },
          },
        },
      });
    } catch (error) {
      console.error('Erro ao criar unidade de venda do produto:', error);
      throw error;
    }
  }

  async getAll() {
    return prisma.sellingUnitProduct.findMany({
      include: {
        unit: true,
        product: {
          select: {
            id: true,
            name: true,
            category: true,
          },
        },
      },
      orderBy: [
        { product: { name: 'asc' } },
        { unit: { title: 'asc' } },
      ],
    });
  }

  async getByProductId(productId: string) {
    const product = await prisma.product.findUnique({
      where: { id: productId },
    });

    if (!product) {
      throw new Error(`Produto com ID ${productId} não encontrado`);
    }

    return prisma.sellingUnitProduct.findMany({
      where: { productId },
      include: {
        unit: true,
        product: {
          select: {
            id: true,
            name: true,
            category: true,
          },
        },
      },
      orderBy: {
        unit: { title: 'asc' },
      },
    });
  }

  async getById(id: string) {
    return prisma.sellingUnitProduct.findUnique({
      where: { id },
      include: {
        unit: true,
        product: {
          select: {
            id: true,
            name: true,
            category: true,
            seller: {
              select: {
                id: true,
                name: true,
              },
            },
          },
        },
      },
    });
  }

  async update(id: string, data: UpdateSellingUnitProductDto, requester: ProductRequester) {
    try {
      const existing = await this.getById(id);
      if (!existing) {
        throw new Error(`Unidade de venda do produto com ID ${id} não encontrada`);
      }
      this.assertCanManage(existing.product.seller.id, requester);

      if (data.unitId && data.unitId !== existing.unitId) {
        const unit = await prisma.sellingUnit.findUnique({
          where: { id: data.unitId },
        });

        if (!unit) {
          throw new Error(`Unidade de venda com ID ${data.unitId} não encontrada`);
        }

        const duplicate = await prisma.sellingUnitProduct.findFirst({
          where: {
            productId: existing.productId,
            unitId: data.unitId,
            id: { not: id },
          },
        });

        if (duplicate) {
          throw new Error(`Já existe uma unidade de venda com ID ${data.unitId} para este produto`);
        }
      }

      return await prisma.sellingUnitProduct.update({
        where: { id },
        data: {
          ...(data.unitId && { unitId: data.unitId }),
          ...(data.minPrice !== undefined && { minPrice: data.minPrice }),
        },
        include: {
          unit: true,
          product: {
            select: {
              id: true,
              name: true,
              category: true,
            },
          },
        },
      });
    } catch (error) {
      console.error('Erro ao atualizar unidade de venda do produto:', error);
      throw error;
    }
  }

  async delete(id: string, requester: ProductRequester) {
    try {
      const existing = await prisma.sellingUnitProduct.findUnique({
        where: { id },
        include: {
          boughtProducts: true,
          CartItem: true,
          product: { select: { sellerId: true } },
        },
      });

      if (!existing) {
        throw new Error(`Unidade de venda do produto com ID ${id} não encontrada`);
      }
      this.assertCanManage(existing.product.sellerId, requester);

      if (existing.boughtProducts.length > 0) {
        throw new Error('Não é possível deletar esta unidade de venda pois existem produtos comprados relacionados');
      }

      if (existing.CartItem.length > 0) {
        throw new Error('Não é possível deletar esta unidade de venda pois existem itens no carrinho relacionados');
      }

      return await prisma.sellingUnitProduct.delete({
        where: { id },
      });
    } catch (error) {
      console.error('Erro ao deletar unidade de venda do produto:', error);
      throw error;
    }
  }

  async getAllSellingUnits() {
    return prisma.sellingUnit.findMany({ orderBy: { title: 'asc' } });
  }

  async createSellingUnit(data: { unit: string; title: string }) {
    if (typeof data.unit !== 'string' || typeof data.title !== 'string') {
      throw new Error('unit e title devem ser strings');
    }

    const unit = data.unit.trim().toLowerCase();
    const title = data.title.trim();

    if (!unit || !title) {
      throw new Error('unit e title são obrigatórios');
    }

    // Checagem rápida para UX; a garantia real contra concorrência é a constraint
    // única de banco (SellingUnit.unit @unique) — o P2002 abaixo cobre a corrida.
    const existing = await prisma.sellingUnit.findFirst({ where: { unit } });
    if (existing) {
      throw new Error(`Já existe uma unidade de medida com o código "${unit}"`);
    }

    try {
      return await prisma.sellingUnit.create({ data: { unit, title } });
    } catch (error: any) {
      if (error.code === 'P2002') {
        throw new Error(`Já existe uma unidade de medida com o código "${unit}"`);
      }
      throw error;
    }
  }

  async updateSellingUnit(id: string, data: { unit?: string; title?: string }) {
    const existing = await prisma.sellingUnit.findUnique({ where: { id } });
    if (!existing) {
      throw new Error(`Unidade de medida com ID ${id} não encontrada`);
    }

    if (data.unit !== undefined && typeof data.unit !== 'string') {
      throw new Error('unit deve ser uma string');
    }
    if (data.title !== undefined && typeof data.title !== 'string') {
      throw new Error('title deve ser uma string');
    }

    const unit = data.unit !== undefined ? data.unit.trim().toLowerCase() : undefined;
    const title = data.title !== undefined ? data.title.trim() : undefined;

    if (unit !== undefined && !unit) {
      throw new Error('unit não pode ser vazio');
    }
    if (title !== undefined && !title) {
      throw new Error('title não pode ser vazio');
    }

    if (unit !== undefined && unit !== existing.unit) {
      // Checagem rápida para UX; a garantia real contra concorrência é a constraint
      // única de banco (SellingUnit.unit @unique) — o P2002 abaixo cobre a corrida.
      const duplicate = await prisma.sellingUnit.findFirst({ where: { unit, id: { not: id } } });
      if (duplicate) {
        throw new Error(`Já existe uma unidade de medida com o código "${unit}"`);
      }
    }

    try {
      return await prisma.sellingUnit.update({
        where: { id },
        data: {
          ...(unit !== undefined && { unit }),
          ...(title !== undefined && { title }),
        },
      });
    } catch (error: any) {
      if (error.code === 'P2002') {
        throw new Error(`Já existe uma unidade de medida com o código "${unit}"`);
      }
      throw error;
    }
  }

  async deleteSellingUnit(id: string) {
    const existing = await prisma.sellingUnit.findUnique({
      where: { id },
      include: { sellingUnitProduct: true },
    });
    if (!existing) {
      throw new Error(`Unidade de medida com ID ${id} não encontrada`);
    }

    if (existing.sellingUnitProduct.length > 0) {
      throw new Error('Não é possível deletar esta unidade de medida pois existem produtos que a utilizam');
    }

    return prisma.sellingUnit.delete({ where: { id } });
  }

  async deleteByProductId(productId: string, requester: ProductRequester) {
    try {
      const product = await prisma.product.findUnique({
        where: { id: productId },
      });

      if (!product) {
        throw new Error(`Produto com ID ${productId} não encontrado`);
      }
      this.assertCanManage(product.sellerId, requester);

      const sellingUnits = await prisma.sellingUnitProduct.findMany({
        where: { productId },
        include: {
          boughtProducts: true,
          CartItem: true,
        },
      });

      for (const unit of sellingUnits) {
        if (unit.boughtProducts.length > 0 || unit.CartItem.length > 0) {
          throw new Error(`Não é possível deletar as unidades de venda pois existem registros relacionados`);
        }
      }

      return await prisma.sellingUnitProduct.deleteMany({
        where: { productId },
      });
    } catch (error) {
      console.error('Erro ao deletar unidades de venda do produto:', error);
      throw error;
    }
  }
}