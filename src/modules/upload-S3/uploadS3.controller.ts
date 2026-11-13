import { Request, Response, RequestHandler } from "express";
import { PrismaClient } from "@prisma/client";
import { UploadS3Error, UploadS3Service } from "./uploadS3.service";

const prisma = new PrismaClient();
const service = new UploadS3Service(prisma);

export class UploadS3Controller {
  public uploadHandler: RequestHandler = async (
    req: Request,
    res: Response
  ): Promise<void> => {
    try {
      const file = req.file;
      if (!file) {
        res.status(400).json({ error: "Nenhum arquivo enviado" });
        return;
      }

      const result = await service.upload(file);
      res.status(201).json(result);
    } catch (error: any) {
      console.error(error);
      res
        .status(500)
        .json({ error: "Failed to upload file", details: error.message });
    }
  };

  public getUrlHandler: RequestHandler = async (
    req: Request,
    res: Response
  ): Promise<void> => {
    try {
      const { key } = req.query;
      if (!key || typeof key !== "string") {
        res.status(400).json({ error: "Key é obrigatória" });
        return;
      }

      const result = await service.getPublicUrl(key);
      res.status(200).json(result);
    } catch (error: any) {
      console.error(error);
      res
        .status(500)
        .json({ error: "Failed to get file URL", details: error.message });
    }
  };

  public deleteHandler: RequestHandler = async (
    req: Request,
    res: Response
  ): Promise<void> => {
    try {
      const { key } = req.query;
      if (!key || typeof key !== "string") {
        res.status(400).json({ error: "Key é obrigatória" });
        return;
      }

      const result = await service.deleteUnprotected(key);
      res.status(200).json(result);
    } catch (error: any) {
      if (error instanceof UploadS3Error) {
        res.status(error.status).json({ error: error.message });
        return;
      }
      console.error(error);
      res
        .status(500)
        .json({ error: "Failed to delete file", details: error.message });
    }
  };
}
