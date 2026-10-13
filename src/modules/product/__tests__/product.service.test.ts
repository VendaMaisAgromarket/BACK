import { PrismaClient } from '@prisma/client';
import { mockDeep, DeepMockProxy } from 'jest-mock-extended';

const mockUpload = jest.fn();
const mockDeleteImage = jest.fn();

jest.mock('../../upload-S3/uploadS3.service', () => ({
  UploadS3Service: jest.fn().mockImplementation(() => ({
    upload: mockUpload,
    delete: mockDeleteImage,
  })),
}));

import { ProductService, productStatusWhere } from '../product.service';
import { ProductError } from '../product.errors';

const PRODUCT_ID = 'product-1';
const SELLER = { userId: 'seller-1' };
const OLD_IMAGE = 'https://bucket.s3.amazonaws.com/old.jpg';

function currentUnit(unitId: string, sold = 0) {
  return {
    id: `sup-${unitId}`,
    unitId,
    productId: PRODUCT_ID,
    minPrice: 10,
    unit: { id: unitId, unit: unitId, title: `Unidade ${unitId}` },
    _count: { boughtProducts: sold },
  };
}

describe('ProductService.update', () => {
  let prisma: DeepMockProxy<PrismaClient>;
  let service: ProductService;

  beforeEach(() => {
    mockUpload.mockReset();
    mockDeleteImage.mockReset().mockResolvedValue({ deleted: true });
    prisma = mockDeep<PrismaClient>();
    // A transação interativa roda o callback com o próprio mock como `tx`.
    prisma.$transaction.mockImplementation(((cb: (tx: unknown) => unknown) => cb(prisma)) as never);
    prisma.product.findUnique.mockResolvedValue({
      images_Path: [OLD_IMAGE],
      sellerId: SELLER.userId,
    } as never);
    service = new ProductService(prisma as unknown as PrismaClient);
  });

  it('atualiza o preço da unidade existente no lugar, sem apagar e recriar', async () => {
    prisma.sellingUnitProduct.findMany.mockResolvedValue([currentUnit('kg', 3)] as never);

    await service.update(PRODUCT_ID, SELLER, {
      sellingUnitProduct: [{ unitId: 'kg', minPrice: 13.6 }],
    });

    expect(prisma.sellingUnitProduct.updateMany).toHaveBeenCalledWith({
      where: { productId: PRODUCT_ID, unitId: 'kg' },
      data: { minPrice: 13.6 },
    });
    expect(prisma.sellingUnitProduct.create).not.toHaveBeenCalled();
    expect(prisma.sellingUnitProduct.deleteMany).not.toHaveBeenCalled();
  });

  it('recusa com 403 quando o usuário não é o dono do produto', async () => {
    await expect(
      service.update(PRODUCT_ID, { userId: 'outro-usuario' }, { name: 'x' })
    ).rejects.toMatchObject({ status: 403 });
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('permite que um admin edite produto de outro vendedor', async () => {
    await service.update(PRODUCT_ID, { userId: 'admin-1', role: 'admin' }, { name: 'x' });
    expect(prisma.product.update).toHaveBeenCalled();
  });

  it('retorna 404 para produto inexistente', async () => {
    prisma.product.findUnique.mockResolvedValueOnce(null);
    await expect(service.update(PRODUCT_ID, SELLER, {})).rejects.toMatchObject({ status: 404 });
  });

  it('recusa unidade repetida no payload', async () => {
    await expect(
      service.update(PRODUCT_ID, SELLER, {
        sellingUnitProduct: [
          { unitId: 'kg', minPrice: 1 },
          { unitId: 'kg', minPrice: 2 },
        ],
      })
    ).rejects.toMatchObject({ status: 400 });
  });

  it('recusa remover unidade que já tem vendas', async () => {
    prisma.sellingUnitProduct.findMany.mockResolvedValue([
      currentUnit('kg'),
      currentUnit('cx', 1),
    ] as never);

    const result = service.update(PRODUCT_ID, SELLER, {
      sellingUnitProduct: [{ unitId: 'kg', minPrice: 5 }],
    });

    await expect(result).rejects.toBeInstanceOf(ProductError);
    await expect(result).rejects.toMatchObject({ status: 400 });
  });

  it('remove unidade que só está em carrinhos, limpando os itens do carrinho', async () => {
    prisma.sellingUnitProduct.findMany.mockResolvedValue([
      currentUnit('kg'),
      currentUnit('cx'),
    ] as never);

    await service.update(PRODUCT_ID, SELLER, {
      sellingUnitProduct: [{ unitId: 'kg', minPrice: 5 }],
    });

    expect(prisma.cartItem.deleteMany).toHaveBeenCalledWith({
      where: { sellingUnitProductId: { in: ['sup-cx'] } },
    });
    expect(prisma.sellingUnitProduct.deleteMany).toHaveBeenCalledWith({
      where: { id: { in: ['sup-cx'] } },
    });
  });

  it('recusa unidade nova que não existe', async () => {
    prisma.sellingUnitProduct.findMany.mockResolvedValue([] as never);
    prisma.sellingUnit.count.mockResolvedValue(0);

    await expect(
      service.update(PRODUCT_ID, SELLER, {
        sellingUnitProduct: [{ unitId: 'inexistente', minPrice: 5 }],
      })
    ).rejects.toMatchObject({ status: 400 });
    expect(prisma.sellingUnitProduct.create).not.toHaveBeenCalled();
  });

  it('só apaga imagens removidas do S3 depois que a transação confirma', async () => {
    await service.update(PRODUCT_ID, SELLER, { existingImages: ['https://bucket.s3.amazonaws.com/keep.jpg'] });
    expect(mockDeleteImage).toHaveBeenCalledWith('old.jpg');
  });

  it('não apaga imagens antigas e descarta as novas se a transação falhar', async () => {
    mockUpload.mockResolvedValue({ publicUrl: 'https://bucket.s3.amazonaws.com/new.jpg' });
    prisma.$transaction.mockRejectedValueOnce(new Error('falha no banco'));

    await expect(
      service.update(
        PRODUCT_ID,
        SELLER,
        { existingImages: ['https://bucket.s3.amazonaws.com/keep.jpg'] },
        [{} as Express.Multer.File]
      )
    ).rejects.toThrow('falha no banco');

    expect(mockDeleteImage).toHaveBeenCalledWith('new.jpg');
    expect(mockDeleteImage).not.toHaveBeenCalledWith('old.jpg');
  });
});

describe('ProductService.delete', () => {
  it('recusa com 403 quando o usuário não é o dono do produto', async () => {
    const prisma = mockDeep<PrismaClient>();
    prisma.product.findUnique.mockResolvedValue({ images_Path: [], sellerId: 'seller-1' } as never);
    const service = new ProductService(prisma as unknown as PrismaClient);

    await expect(service.delete(PRODUCT_ID, { userId: 'outro-usuario' })).rejects.toMatchObject({
      status: 403,
    });
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });
});

describe('ProductService.getAll', () => {
  it('filtra categoria por igualdade (sem casar "Subtropical" ao buscar "Tropical")', async () => {
    const prisma = mockDeep<PrismaClient>();
    prisma.product.findMany.mockResolvedValue([]);
    const service = new ProductService(prisma as unknown as PrismaClient);

    await service.getAll(undefined, 'Tropical');

    expect(prisma.product.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ category: { equals: 'Tropical', mode: 'insensitive' } }),
      })
    );
  });
});

describe('ProductService.getBestSellers', () => {
  let prisma: DeepMockProxy<PrismaClient>;
  let service: ProductService;

  beforeEach(() => {
    prisma = mockDeep<PrismaClient>();
    service = new ProductService(prisma as unknown as PrismaClient);
  });

  it('ordena por pedidos distintos e respeita o limite', async () => {
    prisma.boughtProduct.groupBy.mockResolvedValue([
      { productId: 'a', saleDataId: 's1' },
      { productId: 'b', saleDataId: 's1' },
      { productId: 'b', saleDataId: 's2' },
      { productId: 'b', saleDataId: 's3' },
      { productId: 'c', saleDataId: 's2' },
      { productId: 'c', saleDataId: 's4' },
    ] as never);
    prisma.product.findMany.mockResolvedValue([{ id: 'c' }, { id: 'b' }] as never);

    const result = await service.getBestSellers('user-1', 2);

    expect(prisma.product.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: { in: ['b', 'c'] } } })
    );
    expect(result).toEqual([
      { id: 'b', salesCount: 3 },
      { id: 'c', salesCount: 2 },
    ]);
  });

  it('conta só vendas efetivadas, de produtos ativos e de outros vendedores', async () => {
    prisma.boughtProduct.groupBy.mockResolvedValue([] as never);

    const result = await service.getBestSellers('user-1', 20);

    expect(result).toEqual([]);
    expect(prisma.product.findMany).not.toHaveBeenCalled();
    const args = prisma.boughtProduct.groupBy.mock.calls[0][0] as unknown as {
      where: { saleData: unknown; product: { sellerId: unknown; status: boolean; harvestAt: { gte: Date } } };
    };
    expect(args.where.saleData).toEqual({
      status: { notIn: ['Cancelado', 'Recusado pelo vendedor'] },
      OR: [{ downPaymentCompleted: true }, { paymentCompleted: true }],
    });
    expect(args.where.product.sellerId).toEqual({ not: 'user-1' });
    expect(args.where.product.status).toBe(true);
    expect(args.where.product.harvestAt.gte).toBeInstanceOf(Date);
  });
});

describe('productStatusWhere', () => {
  // 23:59:59 de 13/10 em Brasília
  const now = new Date('2026-10-14T02:59:59Z');
  const startOf13 = new Date('2026-10-13T03:00:00Z');

  it('active: status true e colheita a partir do início de hoje em Brasília', () => {
    expect(productStatusWhere('active', now)).toEqual({ status: true, harvestAt: { gte: startOf13 } });
  });

  it('inactive: desativado ou com colheita antes de hoje', () => {
    expect(productStatusWhere('inactive', now)).toEqual({
      OR: [{ status: false }, { harvestAt: { lt: startOf13 } }],
    });
  });

  it('all: sem filtro', () => {
    expect(productStatusWhere('all', now)).toEqual({});
  });
});

describe('ProductService — status por colheita', () => {
  let prisma: DeepMockProxy<PrismaClient>;
  let service: ProductService;

  beforeEach(() => {
    prisma = mockDeep<PrismaClient>();
    prisma.$transaction.mockImplementation(((cb: (tx: unknown) => unknown) => cb(prisma)) as never);
    prisma.product.findUnique.mockResolvedValue({ images_Path: [], sellerId: SELLER.userId } as never);
    service = new ProductService(prisma as unknown as PrismaClient);
  });

  it('desativa só produtos ativos com colheita antes de hoje (Brasília)', async () => {
    prisma.product.updateMany.mockResolvedValue({ count: 2 });

    // 00:00:00 de 14/10 em Brasília: o dia 13 acabou
    const count = await service.deactivateExpiredProducts(new Date('2026-10-14T03:00:00Z'));

    expect(count).toBe(2);
    expect(prisma.product.updateMany).toHaveBeenCalledWith({
      where: { status: true, harvestAt: { lt: new Date('2026-10-14T03:00:00Z') } },
      data: { status: false },
    });
  });

  it('getById sem filtro só encontra produto ativo', async () => {
    prisma.product.findFirst.mockResolvedValue(null);
    await service.getById(PRODUCT_ID);
    const args = prisma.product.findFirst.mock.calls[0][0] as unknown as { where: Record<string, unknown> };
    expect(args.where).toMatchObject({ id: PRODUCT_ID, status: true });
  });

  it('nova data de colheita futura reativa o produto', async () => {
    await service.update(PRODUCT_ID, SELLER, { harvestAt: '2099-01-01T03:00:00Z' });
    expect(prisma.product.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: true }) })
    );
  });

  it('nova data de colheita passada desativa o produto', async () => {
    await service.update(PRODUCT_ID, SELLER, { harvestAt: '2020-01-01T03:00:00Z' });
    expect(prisma.product.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: false }) })
    );
  });

  it('status explícito tem prioridade sobre a data de colheita', async () => {
    await service.update(PRODUCT_ID, SELLER, { harvestAt: '2099-01-01T03:00:00Z', status: 'false' });
    expect(prisma.product.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: false }) })
    );
  });
});
