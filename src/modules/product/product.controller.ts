import { Request, Response } from "express";
import { PRODUCT_STATUS_FILTERS, ProductService, ProductStatusFilter } from "./product.service";
import { ProductError } from "./product.errors";
import { logger } from "../../lib/logger";

const service = new ProductService();

// ?status=active (padrão) | inactive | all
function parseStatusFilter(raw: unknown): ProductStatusFilter | null {
  if (raw === undefined) return "active";
  return PRODUCT_STATUS_FILTERS.includes(raw as ProductStatusFilter) ? (raw as ProductStatusFilter) : null;
}

const INVALID_STATUS_FILTER = { error: "Filtro de status inválido. Use active, inactive ou all." };

export class ProductController {
  async create(req: Request, res: Response) {
    try {
      if (typeof req.body.sellingUnitProduct === "string") {
        req.body.sellingUnitProduct = JSON.parse(req.body.sellingUnitProduct);
      }
      if (typeof req.body.ratingStarAmount === "string") {
        req.body.ratingStarAmount = JSON.parse(req.body.ratingStarAmount);
      }

      if (req.body.stock !== undefined) req.body.stock = parseInt(req.body.stock);
      if (req.body.productRating !== undefined) req.body.productRating = parseFloat(req.body.productRating);
      if (req.body.amountSold !== undefined) req.body.amountSold = parseInt(req.body.amountSold);
      if (req.body.ratingAmount !== undefined) req.body.ratingAmount = parseInt(req.body.ratingAmount);
      if (req.body.isNegotiable !== undefined) req.body.isNegotiable = req.body.isNegotiable === "true" || req.body.isNegotiable === true;

      const result = await service.create(req.body, req.files as Express.Multer.File[]);
      res.status(201).json(result);
    } catch (error: any) {
      console.error("Erro ao criar produto:", error);

      if (error?.message?.includes("não encontrado")) {
        return res.status(400).json({ error: error.message });
      }
      if (error?.code === "P2003") {
        return res.status(400).json({
          error: "Erro de referência: verifique se o vendedor e as unidades de venda existem",
        });
      }
      if (error?.message?.includes("Arquivo não enviado")) {
        return res.status(400).json({ error: error.message });
      }

      res.status(500).json({ error: "Failed to create product" });
    }
  }

  async getAll(req: Request, res: Response) {
    try {
      const name = req.query.name as string | undefined;
      const category = req.query.category as string | undefined;
      const statusFilter = parseStatusFilter(req.query.status);
      if (!statusFilter) return res.status(400).json(INVALID_STATUS_FILTER);

      const result = await service.getAll(name, category, statusFilter);
      res.json(result);
    } catch (error: any) {
      console.error(error);
      res.status(500).json({ error: "Failed to fetch products" });
    }
  }

  async getBestSellers(req: Request, res: Response) {
    try {
      const rawLimit = parseInt(String(req.query.limit ?? "20"), 10);
      const limit = Number.isNaN(rawLimit) ? 20 : Math.min(Math.max(rawLimit, 1), 100);

      const result = await service.getBestSellers(req.user!.userId, limit);
      res.json(result);
    } catch (error: any) {
      logger.error("Erro ao buscar mais vendidos:", error);
      res.status(500).json({ error: "Failed to fetch best sellers" });
    }
  }

  async getAllByUser(req: Request, res: Response) {
    try {
      const { userId } = req.params;
      const name = req.query.name as string | undefined;
      const category = req.query.category as string | undefined;

      const statusFilter = parseStatusFilter(req.query.status);
      if (!statusFilter) return res.status(400).json(INVALID_STATUS_FILTER);

      const result = await service.getAllByUser(userId, name, category, statusFilter);
      res.json(result);
    } catch (error: any) {
      console.error(error);
      res.status(500).json({ error: "Failed to fetch products by user" });
    }
  }

  public getById = async (req: Request, res: Response) => {
    try {
      const id = req.params.id;
      const statusFilter = parseStatusFilter(req.query.status);
      if (!statusFilter) return res.status(400).json(INVALID_STATUS_FILTER);

      const result = await service.getById(id, statusFilter);
      if (!result) return res.status(404).json({ error: "Product not found" });
      res.json(result);
    } catch (error: any) {
      console.error(error);
      res.status(500).json({ error: "Failed to fetch product" });
    }
  };

  async update(req: Request, res: Response) {
    try {
      const id = req.params.id;

      if (typeof req.body.sellingUnitProduct === "string") {
        req.body.sellingUnitProduct = JSON.parse(req.body.sellingUnitProduct);
      }
      if (typeof req.body.ratingStarAmount === "string") {
        req.body.ratingStarAmount = JSON.parse(req.body.ratingStarAmount);
      }

      if (typeof req.body.existingImages === "string") {
        try {
          req.body.existingImages = JSON.parse(req.body.existingImages);
        } catch {
          req.body.existingImages = undefined;
        }
      }

      const result = await service.update(
        id,
        { userId: req.user!.userId, role: req.user!.role },
        req.body,
        req.files as Express.Multer.File[]
      );
      res.json(result);
    } catch (error: any) {
      if (error instanceof ProductError) {
        return res.status(error.status).json({ error: error.message });
      }
      if (error instanceof SyntaxError) {
        return res.status(400).json({ error: "Dados do produto em formato inválido." });
      }

      logger.error("Erro ao atualizar produto:", error);
      res.status(500).json({ error: "Failed to update product" });
    }
  }

  async delete(req: Request, res: Response) {
    try {
      const id = req.params.id;
      await service.delete(id, { userId: req.user!.userId, role: req.user!.role });
      res.status(204).send();
    } catch (error: any) {
      if (error instanceof ProductError) {
        return res.status(error.status).json({ error: error.message });
      }

      logger.error("Erro ao deletar produto:", error);
      if (error?.code === "P2003") {
        return res.status(400).json({
          error: "Não é possível deletar este produto pois ele possui registros relacionados",
        });
      }

      res.status(500).json({ error: "Failed to delete product" });
    }
  }

  async getSellingUnits(req: Request, res: Response) {
    try {
      const result = await service.getSellingUnits();
      res.json(result);
    } catch (error: any) {
      console.error(error);
      res.status(500).json({ error: "Failed to fetch selling units" });
    }
  }
}
